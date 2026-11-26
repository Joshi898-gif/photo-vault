/* 写真保管庫 — Google ドライブの写真・動画を撮影日順に、自分だけで見る PWA
 * 構成: 認証(OAuth 暗黙フロー, リダイレクト方式) / Drive API 直叩き / IndexedDB・Cache API でオフライン一覧
 * ?demo=1 を付けると Google なしの見本データで動く（画面の確認用）
 */
(() => {
'use strict';

// ---------- 基本 ----------
const CFG = Object.assign({ clientId: '', vaultPath: 'Gin/写真保管庫', appName: '写真保管庫', version: '1.4.0' }, window.VAULT_CONFIG || {});
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} }
};
const DEMO = new URLSearchParams(location.search).has('demo');
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const SCOPE = 'https://www.googleapis.com/auth/drive';
const FILE_FIELDS = 'id,name,mimeType,size,md5Checksum,createdTime,modifiedTime,parents,thumbnailLink,hasThumbnail,imageMediaMetadata(time,width,height),videoMediaMetadata(width,height,durationMillis),appProperties,starred,shared,webViewLink';
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent);
const STANDALONE = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

const state = {
  clientId: LS.get('vault_client_id', '') || CFG.clientId,
  folderPath: LS.get('vault_folder_path', '') || CFG.vaultPath,   // 例 Gin/写真保管庫（以前の vault_folder_name は使わない）
  folderName: '',
  token: null, tokenExp: 0,
  email: '', quota: null,
  vaultId: null, folders: new Map(), // id -> {id,name,parent}
  raw: [], items: [], index: null,
  filter: 'all', order: LS.get('vault_order', 'desc'),
  selecting: false, selected: new Set(),
  view: null, // ビューア状態
  loading: false,
  unlockUntil: 0,            // 削除ロックの一時解除期限（ms）
  trash: null, trashRaw: [], // Drive のゴミ箱（ゴミ箱タブを開いたときに読む）
  backup: null,              // PC が書く バックアップ状況.json
  thumbMap: null,            // PC が作った小さい画像: 元ファイルの MD5 -> Drive のファイル ID
  listFresh: 0               // 一覧を Google から取り直した時刻（小さい画像のリンクが新しいかの目安）
};

const fmtBytes = (n) => { n = +n || 0; if (n >= 1e12) return (n / 1e12).toFixed(2) + ' TB'; if (n >= 1e9) return (n / 1e9).toFixed(1) + ' GB'; if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB'; if (n >= 1e3) return (n / 1e3).toFixed(0) + ' KB'; return n + ' B'; };
const pad2 = (n) => String(n).padStart(2, '0');
const fmtDate = (ms) => { const d = new Date(ms); return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const fmtDur = (ms) => { const s = Math.round(ms / 1000); return s >= 3600 ? `${Math.floor(s / 3600)}:${pad2(Math.floor(s % 3600 / 60))}:${pad2(s % 60)}` : `${Math.floor(s / 60)}:${pad2(s % 60)}`; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let toastTimer = null;
function toast(msg, ms = 2600) {
  const root = $('#toastRoot'); root.innerHTML = `<div class="toast">${msg}</div>`;
  clearTimeout(toastTimer); if (ms > 0) toastTimer = setTimeout(() => { root.innerHTML = ''; }, ms);
}
const toastOff = () => { $('#toastRoot').innerHTML = ''; };

// ---------- IndexedDB（一覧キャッシュ） ----------
const idb = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('vault-db-2', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => { this.db = r.result; res(this.db); };
      r.onerror = () => rej(r.error);
    });
  },
  async get(k) { if (DEMO) return undefined; try { const db = await this.open(); return await new Promise((res, rej) => { const t = db.transaction('kv').objectStore('kv').get(k); t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error); }); } catch { return undefined; } },
  async set(k, v) { if (DEMO) return; try { // デモの見本データを本物の一覧キャッシュに混ぜない
    const db = await this.open(); await new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite').objectStore('kv').put(v, k); t.onsuccess = res; t.onerror = () => rej(t.error); }); } catch {} },
  async del(k) { try { const db = await this.open(); await new Promise((res) => { const t = db.transaction('kv', 'readwrite').objectStore('kv').delete(k); t.onsuccess = res; t.onerror = res; }); } catch {} }
};

// ---------- 認証（OAuth 2.0 暗黙フロー・リダイレクト） ----------
const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/, '');
function loadToken() { const t = LS.get('vault_token', null); if (t && t.exp > Date.now() + 30000) { state.token = t.t; state.tokenExp = t.exp; } }
function clearToken() { state.token = null; state.tokenExp = 0; LS.del('vault_token'); }
function authUrl(extra = {}) {
  const st = Math.random().toString(36).slice(2) + Date.now().toString(36);
  LS.set('vault_oauth_state', st);
  const p = new URLSearchParams({ client_id: state.clientId, redirect_uri: redirectUri(), response_type: 'token', scope: SCOPE, include_granted_scopes: 'true', state: st, ...extra });
  if (state.email) p.set('login_hint', state.email);
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + p.toString();
}
function parseHashToken(hash) {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  if (p.get('error')) return { error: p.get('error') };
  const t = p.get('access_token'); if (!t) return null;
  if (p.get('state') !== LS.get('vault_oauth_state', '')) return { error: 'state_mismatch' };
  return { t, exp: Date.now() + (Math.max(60, +p.get('expires_in') || 3600) - 60) * 1000 };
}
// iframe の中で開かれたとき（無音の更新）: 親にトークンを渡して終了
if (window.parent !== window && /access_token=|error=/.test(location.hash)) {
  try { window.parent.postMessage({ type: 'vault-auth', hash: location.hash }, location.origin); } catch {}
  return; // ここで止める（描画しない）
}
function handleRedirect() {
  if (!/access_token=|error=/.test(location.hash)) return null;
  const r = parseHashToken(location.hash);
  history.replaceState(null, '', redirectUri() + (DEMO ? '?demo=1' : ''));
  if (r && r.t) { state.token = r.t; state.tokenExp = r.exp; LS.set('vault_token', { t: r.t, exp: r.exp }); return 'ok'; }
  return r ? r.error : null;
}
function silentAuth() {
  return new Promise((resolve) => {
    let done = false;
    const ifr = document.createElement('iframe'); ifr.style.display = 'none';
    const finish = (v) => { if (done) return; done = true; window.removeEventListener('message', onMsg); ifr.remove(); resolve(v); };
    const onMsg = (e) => { if (e.origin !== location.origin || !e.data || e.data.type !== 'vault-auth') return; const r = parseHashToken(e.data.hash); if (r && r.t) { state.token = r.t; state.tokenExp = r.exp; LS.set('vault_token', { t: r.t, exp: r.exp }); finish(true); } else finish(false); };
    window.addEventListener('message', onMsg);
    ifr.src = authUrl({ prompt: 'none' }); document.body.appendChild(ifr);
    setTimeout(() => finish(false), 7000);
  });
}
async function ensureToken() {
  if (state.token && state.tokenExp > Date.now() + 30000) return true;
  if (await silentAuth()) return true;
  // アップロード中に画面ごと Google へ移ると、選んだ写真が消えてしまう。移動せずにエラーにする
  if (state.noRedirect) throw new Error('ログインの期限が切れました');
  // 画面ごと Google へ（戻ってくると続きから）
  LS.set('vault_resume', { y: window.scrollY, filter: state.filter });
  location.assign(authUrl());
  await sleep(60000); throw new Error('redirecting');
}

// ---------- Drive API ----------
async function gfetch(url, opts = {}, tries = 0) {
  await ensureToken();
  const headers = Object.assign({}, opts.headers || {}, { Authorization: 'Bearer ' + state.token });
  let res;
  try { res = await fetch(url, Object.assign({}, opts, { headers })); }
  catch (e) { if (tries < 2) { await sleep(800 * (tries + 1)); return gfetch(url, opts, tries + 1); } throw e; }
  if (res.status === 401) { clearToken(); if (tries < 1) return gfetch(url, opts, tries + 1); }
  if ((res.status === 429 || res.status >= 500) && tries < 3) { await sleep(1000 * Math.pow(2, tries)); return gfetch(url, opts, tries + 1); }
  if (!res.ok) { const t = await res.text().catch(() => ''); const err = new Error(`Drive API ${res.status}: ${t.slice(0, 300)}`); err.status = res.status; throw err; }
  return res;
}
const gjson = async (url, opts) => (await gfetch(url, opts)).json();
const q = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const patch = (id, body) => gjson(`${API}/files/${id}?fields=${encodeURIComponent(FILE_FIELDS)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function listAll(query, fields, extra = '') {
  const out = []; let pageToken = '';
  do {
    const u = `${API}/files?q=${encodeURIComponent(query)}&fields=${encodeURIComponent('nextPageToken,' + fields)}&pageSize=1000&spaces=drive${extra}${pageToken ? '&pageToken=' + pageToken : ''}`;
    const j = await gjson(u); out.push(...(j.files || [])); pageToken = j.nextPageToken || '';
  } while (pageToken);
  return out;
}
const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };

const realBackend = {
  async init() {
    const j = await gjson(`${API}/about?fields=user(emailAddress,displayName),storageQuota`);
    state.email = j.user && j.user.emailAddress || ''; LS.set('vault_email', state.email);
    state.quota = j.storageQuota || null;
  },
  async findVault(create) {
    // 「Gin/写真保管庫」のような場所を、マイドライブから順にたどる
    const parts = state.folderPath.split('/').map((x) => x.trim()).filter(Boolean);
    const folderQ = (name, parent) => listAll(`name='${q(name)}' and mimeType='application/vnd.google-apps.folder' and '${parent}' in parents and trashed=false`, 'files(id,name,createdTime)');
    let parent = 'root';
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i]; const last = i === parts.length - 1;
      let fs = await folderQ(name, parent);
      if (!fs.length) { await sleep(1500); fs = await folderQ(name, parent); } // 反映待ちで二重に作らないよう、もう一度だけ探す
      if (fs.length > 1) {
        // 同じ名前が複数あるときは、パソコンが管理ファイルを置いている方（＝同期している本物）を選ぶ
        const scored = [];
        for (const f of fs) {
          let n = 0;
          if (last) { try { n = (await listAll(`'${f.id}' in parents and trashed=false and (name='index.json' or name='このフォルダについて.txt' or name='バックアップ状況.json')`, 'files(id)')).length; } catch {} }
          scored.push({ f, n });
        }
        scored.sort((a, b) => (b.n - a.n) || (Date.parse(a.f.createdTime) - Date.parse(b.f.createdTime)));
        banner('dupvault', `Google ドライブに「${esc(name)}」フォルダが ${fs.length} 個あります。パソコンと同期している方を使っています。もう一方は空なら Drive で削除してかまいません。`);
        parent = scored[0].f.id; continue;
      }
      if (fs.length) { parent = fs[0].id; continue; }
      if (!create || !last) throw new Error(`Google ドライブに「${parts.slice(0, i + 1).join(' › ')}」が見つかりません。パソコンの Google ドライブが同期しているか確認してください。`);
      const j = await gjson(`${API}/files?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parent] }) });
      parent = j.id;
    }
    return parent;
  },
  async loadAll(onProgress) {
    if (!state.vaultId) state.vaultId = await this.findVault(true);
    // フォルダ階層（幅優先）
    const folders = new Map([[state.vaultId, { id: state.vaultId, name: state.folderName, parent: null }]]);
    const special = {}; // 「_thumbs」「_重複」など _ で始まるフォルダは管理用。写真の一覧には入れない
    let frontier = [state.vaultId];
    while (frontier.length) {
      const next = [];
      for (const ids of chunk(frontier, 30)) {
        const fs = await listAll(`mimeType='application/vnd.google-apps.folder' and trashed=false and (${ids.map((i) => `'${i}' in parents`).join(' or ')})`, 'files(id,name,parents,shared)');
        for (const f of fs) {
          if (f.name.startsWith('_')) { if (!special[f.name]) special[f.name] = f.id; continue; }
          if (!folders.has(f.id)) { folders.set(f.id, { id: f.id, name: f.name, parent: (f.parents || [])[0], shared: !!f.shared }); next.push(f.id); }
        }
      }
      frontier = next;
    }
    state.folders = folders;
    // 写真・動画
    const raw = []; const all = Array.from(folders.keys()); let done = 0;
    for (const ids of chunk(all, 25)) {
      const fs = await listAll(`trashed=false and (mimeType contains 'image/' or mimeType contains 'video/') and (${ids.map((i) => `'${i}' in parents`).join(' or ')})`, `files(${FILE_FIELDS})`);
      raw.push(...fs); done += ids.length; onProgress && onProgress(raw.length, done, all.length);
    }
    // PC が作った撮影日の索引 index.json
    let index = null;
    try {
      const ix = await listAll(`name='index.json' and '${state.vaultId}' in parents and trashed=false`, 'files(id,modifiedTime)');
      if (ix.length) index = await gjson(`${API}/files/${ix[0].id}?alt=media`);
    } catch (e) { console.warn('index.json 読めず', e); }
    // PC が書くバックアップ状況
    let backup = null;
    try {
      const bs = await listAll(`name='バックアップ状況.json' and '${state.vaultId}' in parents and trashed=false`, 'files(id)');
      if (bs.length) backup = await gjson(`${API}/files/${bs[0].id}?alt=media`);
    } catch (e) { console.warn('バックアップ状況 読めず', e); }
    return { raw, folders: Array.from(folders.values()), index, backup, thumbsFolder: special._thumbs || null };
  },
  // PC が作った小さい画像（_thumbs/<MD5>.jpg）の一覧。名前から Drive の ID を引けるようにする
  async loadThumbMap(folderId) {
    const map = {};
    for (const f of await listAll(`'${folderId}' in parents and trashed=false`, 'files(id,name)')) map[f.name.replace(/\.jpg$/i, '')] = f.id;
    return map;
  },
  async loadTrash() {
    // フォルダごと消された写真は、親フォルダが普通の一覧に無い。ゴミ箱の中のフォルダも調べて、保管庫の下にあったものを拾う
    const known = new Set(state.folders.keys()); const tf = new Map();
    try { for (const f of await listAll(`trashed=true and mimeType='application/vnd.google-apps.folder'`, 'files(id,name,parents)')) tf.set(f.id, { parent: (f.parents || [])[0], name: f.name }); } catch (e) { console.warn('ゴミ箱のフォルダ一覧に失敗', e); }
    const underVault = (id) => { let cur = id, g = 0; while (cur && g++ < 20) { if (known.has(cur)) return true; const f = tf.get(cur); if (!f || f.name.startsWith('_')) return false; cur = f.parent; } return false; };
    const parents = [...known, ...[...tf.keys()].filter(underVault)];
    const out = [];
    for (const ids of chunk(parents, 25)) {
      out.push(...await listAll(`trashed=true and (mimeType contains 'image/' or mimeType contains 'video/') and (${ids.map((i) => `'${i}' in parents`).join(' or ')})`, `files(${FILE_FIELDS},trashedTime)`));
    }
    return out;
  },
  async untrash(ids) {
    for (const id of ids) {
      const r = state.trashRaw.find((x) => x.id === id); const par = r && (r.parents || [])[0];
      if (par && !state.folders.has(par)) {
        // 元のフォルダがもう無い（ゴミ箱の中）: 保管庫の直下へ戻す。パソコンの整理が年月フォルダへ入れ直す
        await gjson(`${API}/files/${id}?addParents=${state.vaultId}&removeParents=${par}&fields=id,parents`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: false }) });
        r.parents = [state.vaultId];
      } else await patch(id, { trashed: false });
    }
  },
  async refreshThumbLink(item) { const j = await gjson(`${API}/files/${item.id}?fields=thumbnailLink,hasThumbnail`); item.thumb = j.thumbnailLink || ''; return item.thumb; },
  // 画像の取り方（上から順に試す）。戻り値 { blob, persist }。persist=false は iPhone に溜めない（原本そのもの）
  //  1) PC が作った小さい画像（_thumbs）… 確実で軽い
  //  2) Google の小さい画像のリンク … Web アプリから使えるかは環境しだい。3 回続けて失敗したら 7 日間は試さない
  //  3) 原本を取り、一覧用は iPhone の中で縮める
  async thumbBlob(item, size) {
    if (!state.token || state.tokenExp < Date.now()) throw new Error('ログインが必要です'); // 画像のために勝手に Google へ移動しない
    const small = size <= 400;
    if (small && item.md5) {
      await thumbs.mapReady;
      const tid = state.thumbMap && state.thumbMap[item.md5];
      if (tid) { try { const b = await (await gfetch(`${API}/files/${tid}?alt=media`)).blob(); tstat('pc'); return { blob: b, persist: true }; } catch (e) { tstat('pcErr', e); } }
    }
    if (item.thumb) {
      const u = /=s\d+(-[a-z]+)?$/.test(item.thumb) ? item.thumb.replace(/=s\d+(-[a-z]+)?$/, `=s${size}`) : item.thumb + `=s${size}`;
      for (const m of ['noauth', 'auth']) {
        if (!linkUsable(m)) continue;
        try {
          const r = await fetch(u, { mode: 'cors', credentials: 'omit', headers: m === 'auth' ? { Authorization: 'Bearer ' + state.token } : {} });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const b = await r.blob(); if (!b.size || (b.type && !b.type.startsWith('image/'))) throw new Error('画像ではない応答');
          linkResult(m, true); tstat(m === 'auth' ? 'linkAuth' : 'link'); return { blob: b, persist: true };
        } catch (e) { linkResult(m, false, e); }
      }
    }
    if (item.video) { tstat('noVideoThumb'); throw new Error('動画の画像はパソコンの整理のあとに出ます'); }
    if (item.size > 60e6) throw new Error('大きすぎて表示できません');
    let b = await (await gfetch(`${API}/files/${item.id}?alt=media`)).blob(); tstat(small ? 'orig' : 'origBig');
    if (small) { try { b = await shrink(b, 360); return { blob: b, persist: true }; } catch (e) { tstat('shrinkErr', e); } }
    return { blob: b, persist: false };
  },
  async downloadBlob(item) { const r = await gfetch(`${API}/files/${item.id}?alt=media`); return r.blob(); },
  async trash(ids) { for (const id of ids) await patch(id, { trashed: true }); },
  async setStar(ids, on) { for (const id of ids) await patch(id, { starred: !!on }); },
  async setCaptured(id, iso) { return patch(id, { modifiedTime: iso, appProperties: { captured: iso, src: 'manual' } }); },
  vaultLink() { return state.vaultId ? `https://drive.google.com/drive/folders/${state.vaultId}` : 'https://drive.google.com/'; },
  fileLink(item) { return item.link || `https://drive.google.com/file/d/${item.id}/view`; },
  previewUrl(item) { return `https://drive.google.com/file/d/${item.id}/preview`; },
  async checkSharing() {
    const res = { folderPerms: [], sharedItems: [] };
    const pj = await gjson(`${API}/files/${state.vaultId}/permissions?fields=permissions(id,type,role,emailAddress,displayName)`);
    res.folderPerms = (pj.permissions || []).filter((p) => p.role !== 'owner');
    res.sharedItems = state.items.filter((i) => i.shared);
    // サブフォルダの共有も確認
    for (const f of state.folders.values()) {
      if (f.id !== state.vaultId && f.shared) res.folderPerms.push({ id: '', type: 'folder', role: 'folder', displayName: `サブフォルダ「${f.name}」`, folderId: f.id });
    }
    return res;
  },
  async unshare(fileId) {
    const pj = await gjson(`${API}/files/${fileId}/permissions?fields=permissions(id,role)`);
    for (const p of (pj.permissions || [])) if (p.role !== 'owner') await gfetch(`${API}/files/${fileId}/permissions/${p.id}`, { method: 'DELETE' });
  },
  async ensureFolder(name, parentId) {
    for (const f of state.folders.values()) if (f.parent === parentId && f.name === name) return f.id;
    const fs = await listAll(`name='${q(name)}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`, 'files(id,name)');
    let id = fs.length ? fs[0].id : null;
    if (!id) { const j = await gjson(`${API}/files?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }) }); id = j.id; }
    state.folders.set(id, { id, name, parent: parentId }); return id;
  },
  async initUpload(file, meta) {
    // 受付（resumable セッション）を取る。受付 URL は 1 週間有効で、送信そのものにはログインが要らない
    const init = await gfetch(`${UPLOAD_API}?uploadType=resumable&fields=${encodeURIComponent(FILE_FIELDS)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': fileType(file), 'X-Upload-Content-Length': String(file.size) }, body: JSON.stringify(meta)
    });
    const loc = init.headers.get('Location'); if (!loc) throw new Error('アップロードの受付が取れませんでした');
    return loc;
  },
  uploadSession(loc, file, onProgress, ctl) { return putResumable(loc, file, onProgress, ctl); },
  async logout() {
    const t = state.token; clearToken(); LS.del('vault_email');
    if (t) { try { await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(t), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }); } catch {} }
  }
};

// ---------- デモ用バックエンド（Google なしで画面確認） ----------
const DEMO_FAIL = new URLSearchParams(location.search).get('fail') || '0';
const MOCK_UPLOAD = DEMO && /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
const demoPending = new Map();
function demoBackend() {
  const mk = (n) => {
    const out = []; const now = Date.now();
    for (let i = 0; i < n; i++) {
      const t = now - Math.floor(Math.pow(Math.random(), 1.4) * 730 * 86400000);
      const video = Math.random() < 0.18; const d = new Date(t);
      const exif = `${d.getFullYear()}:${pad2(d.getMonth() + 1)}:${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
      out.push({ id: 'demo' + i, name: (video ? 'IMG_' : 'IMG_') + String(1000 + i) + (video ? '.MOV' : (i % 3 ? '.HEIC' : '.JPG')), mimeType: video ? 'video/quicktime' : 'image/heic', size: video ? 40e6 + i * 1e5 : 2.5e6 + i * 1000,
        createdTime: new Date(now - i * 3600000).toISOString(), modifiedTime: new Date(video && i % 4 === 0 ? now - i * 3600000 : t).toISOString(), parents: ['demo-root'],
        thumbnailLink: '', hasThumbnail: true, imageMediaMetadata: video ? undefined : { time: i % 7 === 0 ? undefined : exif, width: 4032, height: 3024 },
        videoMediaMetadata: video ? { width: 1920, height: 1080, durationMillis: 5000 + i * 731 } : undefined, appProperties: {}, starred: i % 11 === 0, shared: i === 5, webViewLink: '#' , _hue: (i * 47) % 360 });
    }
    return out;
  };
  let raw = mk(140);
  let trashRaw = mk(4).map((r, i) => Object.assign(r, { id: 'trash' + i, trashedTime: new Date(Date.now() - i * 86400000 * 5).toISOString() }));
  const paint = (item, size) => new Promise((res) => {
    const c = document.createElement('canvas'); c.width = c.height = Math.min(size, 640); const g = c.getContext('2d');
    const h = item._hue || 0; const gr = g.createLinearGradient(0, 0, c.width, c.height); gr.addColorStop(0, `hsl(${h},55%,55%)`); gr.addColorStop(1, `hsl(${(h + 60) % 360},60%,35%)`); g.fillStyle = gr; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = 'rgba(255,255,255,.85)'; g.font = `${Math.round(c.width / 9)}px sans-serif`; g.textAlign = 'center'; g.fillText(item.video ? '▶ 動画' : '写真', c.width / 2, c.height / 2);
    g.font = `${Math.round(c.width / 16)}px sans-serif`; g.fillText(new Date(item.t).toLocaleDateString('ja-JP'), c.width / 2, c.height / 2 + c.width / 8);
    c.toBlob(res, 'image/jpeg', 0.8);
  });
  return {
    async init() { state.email = 'demo@example.com'; state.quota = { limit: String(15e9), usage: String(9.7e9), usageInDrive: String(8e9) }; },
    async loadAll(onProgress) { await sleep(400); onProgress && onProgress(raw.length, 1, 1); state.vaultId = 'demo-root'; return { raw: raw.slice(), folders: [{ id: 'demo-root', name: state.folderName, parent: null }, { id: 'demo-2025', name: '2025', parent: 'demo-root' }], index: null, backup: { time: new Date(Date.now() - 20 * 3600000).toISOString(), count: raw.length, bytes: 5.2e9, dests: [{ path: 'C:\\Users\\Owner\\Backup\\写真保管庫', files: raw.length, ok: true }] } }; },
    async loadTrash() { await sleep(300); return trashRaw.slice(); },
    async untrash(ids) { await sleep(300); const back = trashRaw.filter((r) => ids.includes(r.id)); trashRaw = trashRaw.filter((r) => !ids.includes(r.id)); back.forEach((r) => { delete r.trashedTime; delete r._trashed; raw.push(r); }); },
    async thumbBlob(item, size) { await sleep(60 + Math.random() * 120); return paint(item, size); },
    async downloadBlob(item) { return paint(item, 1200); },
    async trash(ids) { await sleep(300); const gone = raw.filter((r) => ids.includes(r.id)); raw = raw.filter((r) => !ids.includes(r.id)); gone.forEach((r) => { r.trashedTime = new Date().toISOString(); trashRaw.push(r); }); },
    async setStar(ids, on) { await sleep(200); raw.forEach((r) => { if (ids.includes(r.id)) r.starred = on; }); },
    async setCaptured(id, iso) { await sleep(200); const r = raw.find((x) => x.id === id); if (r) { r.modifiedTime = iso; r.appProperties = { captured: iso }; } return r; },
    vaultLink() { return 'https://drive.google.com/'; }, fileLink() { return 'https://drive.google.com/'; }, previewUrl() { return 'about:blank'; },
    async checkSharing() { await sleep(300); return { folderPerms: [], sharedItems: state.items.filter((i) => i.shared) }; },
    async unshare(id) { await sleep(200); raw.forEach((r) => { if (r.id === id) r.shared = false; }); },
    async ensureFolder() { return 'demo-root'; },
    async initUpload(file, meta) { await sleep(30); const id = 'up' + Date.now() + Math.random().toString(36).slice(2); demoPending.set(id, { file, meta }); return MOCK_UPLOAD ? `${location.origin}/__mock_upload/${id}?fail=${encodeURIComponent(DEMO_FAIL)}` : 'demo:' + id; },
    async uploadSession(loc, file, onProgress, ctl) {
      if (loc.startsWith('demo:')) { for (let p = 0; p <= file.size; p += Math.max(1, file.size / 10)) { if (ctl.cancelled) throw new Error('cancelled'); onProgress(Math.min(p, file.size)); await sleep(40); } }
      else { await putResumable(loc, file, onProgress, ctl); }
      const id = loc.split(/[:/?]/).filter(Boolean).find((x) => x.startsWith('up')); const { meta } = demoPending.get(id) || { meta: { name: file.name } }; demoPending.delete(id);
      const r = { id, name: meta.name, mimeType: file.type || 'image/jpeg', size: file.size, createdTime: new Date().toISOString(), modifiedTime: meta.modifiedTime, parents: ['demo-root'], hasThumbnail: true, appProperties: meta.appProperties, starred: false, shared: false, _hue: 200 }; raw.push(r); return r;
    },
    async logout() {}
  };
}
const drive = DEMO ? demoBackend() : realBackend;

// ---------- データ整形（撮影日の決定） ----------
function folderPath(parentId) {
  const parts = []; let cur = parentId; let guard = 0;
  while (cur && cur !== state.vaultId && guard++ < 20) { const f = state.folders.get(cur); if (!f) return null; parts.unshift(f.name); cur = f.parent; }
  return parts.join('/');
}
function parseExif(s) { // "YYYY:MM:DD HH:MM:SS"（カメラのローカル時刻）
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s || ''); if (!m) return NaN;
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime(); return (+m[1] < 1990) ? NaN : t;
}
function toItem(f) {
  const video = (f.mimeType || '').startsWith('video/'); const im = f.imageMediaMetadata || {}; const vm = f.videoMediaMetadata || {};
  const it = { id: f.id, name: f.name, mime: f.mimeType, size: +f.size || 0, md5: f.md5Checksum || '', created: f.createdTime, modified: f.modifiedTime, parent: (f.parents || [])[0] || state.vaultId,
    thumb: f.thumbnailLink || '', exif: im.time || '', w: im.width || vm.width || 0, h: im.height || vm.height || 0, dur: +vm.durationMillis || 0, app: f.appProperties || {}, starred: !!f.starred, shared: !!f.shared, link: f.webViewLink || '', video, _hue: f._hue, t: 0, src: '', trashed: !!f._trashed || !!f.trashedTime, trashedTime: f.trashedTime || '' };
  resolveDate(it); return it;
}
function resolveDate(it) {
  // 優先順: 手で直した日付 > PC が写真・動画から読んだ日付 > Google が読んだ EXIF > アップロード時に iPhone が持っていた日付 > 推定（更新日時・アップロード日）
  let t = NaN, src = '';
  const cap = it.app && it.app.captured ? Date.parse(it.app.captured) : NaN;
  if (!isNaN(cap) && it.app.src !== 'iphone-app') { t = cap; src = 'app'; }
  let e = null;
  if (state.index && state.index.files) {
    const dir = folderPath(it.parent); const key = dir === null ? null : (dir ? dir + '/' : '') + it.name;
    e = key != null ? state.index.files[key] : null;
    if (!e && state.index.byName) { const cands = state.index.byName[it.name]; if (cands) e = cands.find((c) => !it.size || !c.s || c.s === it.size) || null; }
    if (e) { if (e.w && !it.w) { it.w = e.w; it.h = e.h; } if (e.d && !it.dur) it.dur = e.d * 1000; }
  }
  if (isNaN(t) && e && e.t && e.src !== 'mtime') { t = Date.parse(e.t); src = 'index'; }
  if (isNaN(t) && it.exif) { t = parseExif(it.exif); src = 'exif'; }
  if (isNaN(t) && !isNaN(cap)) { t = cap; src = 'phone'; }
  if (isNaN(t) && e && e.t) { t = Date.parse(e.t); src = 'modified'; }
  if (isNaN(t)) { t = Date.parse(it.modified); src = 'modified'; }
  if (isNaN(t)) { t = Date.parse(it.created); src = 'created'; }
  it.t = t; it.src = src; it.estimated = (src === 'modified' || src === 'created');
}
function rebuildItems() {
  if (state.index && state.index.files && !state.index.byName) {
    const byName = {}; for (const [k, v] of Object.entries(state.index.files)) { const n = k.split('/').pop(); (byName[n] = byName[n] || []).push(v); } state.index.byName = byName;
  }
  state.items = state.raw.map(toItem);
  sortItems();
}
function sortItems() { const d = state.order === 'desc' ? -1 : 1; state.items.sort((a, b) => (a.t - b.t) * d || (a.name < b.name ? -1 : 1)); }

// ---------- サムネイル（Cache API + 同時数制限） ----------
// v2: 以前の版（v1）は原本をそのまま溜めていたことがあるので、名前を変えて古い分は起動時に消す
const thumbs = { cacheName: 'vault-thumbs-v2', queue: [], running: 0, MAX: 6, inflight: new Map(), count: null,
  mapReady: Promise.resolve(), mem: new Map(), stats: {}, errs: {}, logged: false,
  mode: LS.get('vault_thumb_mode', {}), fails: { noauth: 0, auth: 0 } };
function tstat(k, e) {
  thumbs.stats[k] = (thumbs.stats[k] || 0) + 1; if (e && !thumbs.errs[k]) thumbs.errs[k] = String(e.message || e).slice(0, 80);
  const n = Object.values(thumbs.stats).reduce((a, b) => a + b, 0);
  if (!thumbs.logged && n >= 24) { thumbs.logged = true; ulog('thumbs', { stats: Object.assign({}, thumbs.stats), errs: Object.assign({}, thumbs.errs), mode: thumbs.mode, map: state.thumbMap ? Object.keys(state.thumbMap).length : 0 }); saveUploadLog(); }
}
// Google の小さい画像のリンクが使えるか。'ng' は 7 日たったら試し直す
function linkUsable(m) { const v = thumbs.mode[m]; return !(v && v.ng && Date.now() - v.ng < 7 * 86400000); }
function linkResult(m, ok, e) {
  if (ok) { thumbs.fails[m] = 0; if (!thumbs.mode[m] || !thumbs.mode[m].ok) { thumbs.mode[m] = { ok: Date.now() }; LS.set('vault_thumb_mode', thumbs.mode); } return; }
  tstat(m === 'auth' ? 'linkAuthErr' : 'linkErr', e);
  if (Date.now() - state.listFresh > 2 * 3600000) return; // 古い一覧のリンクは期限切れかもしれないので、判定に使わない
  if (++thumbs.fails[m] >= 3 && !(thumbs.mode[m] && thumbs.mode[m].ok)) { thumbs.mode[m] = { ng: Date.now(), why: String(e && e.message || e).slice(0, 60) }; LS.set('vault_thumb_mode', thumbs.mode); }
}
// 原本を iPhone の中で小さくする（1 枚ずつ。まとめてやるとメモリが足りなくなる）
let shrinkChain = Promise.resolve();
function shrink(blob, short) {
  const run = () => new Promise((res, rej) => {
    const url = URL.createObjectURL(blob); const img = new Image();
    img.onload = () => {
      try {
        const k = Math.min(1, short / Math.max(1, Math.min(img.naturalWidth, img.naturalHeight)));
        const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        c.toBlob((b) => { c.width = c.height = 0; URL.revokeObjectURL(url); b ? res(b) : rej(new Error('縮小に失敗')); }, 'image/jpeg', 0.78);
      } catch (err) { URL.revokeObjectURL(url); rej(err); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('この形式は縮小できません')); };
    img.src = url;
  });
  const p = shrinkChain.then(run, run); shrinkChain = p.catch(() => {}); return p;
}
async function thumbCache() { if (DEMO) return null; try { return await caches.open(thumbs.cacheName); } catch { return null; } }
function thumbKey(id, size) { return `${location.origin}/__thumb/${encodeURIComponent(id)}/${size}`; }
function getThumbUrl(item, size) {
  const key = item.id + ':' + size;
  if (thumbs.inflight.has(key)) return thumbs.inflight.get(key);
  const p = new Promise((resolve, reject) => { thumbs.queue.push({ item, size, resolve, reject }); pumpThumbs(); }).finally(() => thumbs.inflight.delete(key));
  thumbs.inflight.set(key, p); return p;
}
async function pumpThumbs() {
  while (thumbs.running < thumbs.MAX && thumbs.queue.length) {
    const job = thumbs.queue.pop(); // 後入れ先出し（いま見えている物を優先）
    thumbs.running++;
    (async () => {
      try {
        const c = await thumbCache(); const k = thumbKey(job.item.id, job.size);
        let blob = thumbs.mem.get(k) || null;
        if (!blob && c) { const hit = await c.match(k); if (hit) blob = await hit.blob(); }
        if (!blob) {
          const r = await drive.thumbBlob(job.item, job.size);
          blob = r instanceof Blob ? r : r.blob;
          if (r instanceof Blob || r.persist) { if (c && blob && blob.size > 0) { c.put(k, new Response(blob, { headers: { 'Content-Type': blob.type || 'image/jpeg' } })).catch(() => {}); trimThumbCache(c); } }
          else { thumbs.mem.set(k, blob); while (thumbs.mem.size > 5) thumbs.mem.delete(thumbs.mem.keys().next().value); } // 原本は直近の数枚だけ覚えておく（iPhone には溜めない）
        }
        job.resolve(URL.createObjectURL(blob));
      } catch (e) { job.reject(e); }
      finally { thumbs.running--; pumpThumbs(); }
    })();
  }
}
let trimTick = 0;
async function trimThumbCache(c) { if (++trimTick % 200) return; try { const keys = await c.keys(); if (keys.length > 6000) { for (const k of keys.slice(0, 2000)) await c.delete(k); } } catch {} }

// ---------- 画面切替 ----------
function show(id) { for (const s of ['setup', 'login', 'app']) $('#' + s).classList.toggle('hidden', s !== id); }
function pathLabel() { return state.folderPath.split('/').filter(Boolean).join(' › '); }
function applyFolderName() { state.folderName = state.folderPath.split('/').filter(Boolean).pop() || '写真保管庫'; $$('.folderName').forEach((e) => e.textContent = state.folderName); $$('.folderPath').forEach((e) => e.textContent = pathLabel()); document.title = state.folderName; }

// ---------- タイムライン描画 ----------
const io = new IntersectionObserver((entries) => {
  for (const en of entries) {
    const tile = en.target; const img = tile.firstElementChild;
    if (en.isIntersecting) {
      if (img.dataset.loaded) continue; img.dataset.loaded = '1';
      const item = itemById(tile.dataset.id); if (!item) continue;
      getThumbUrl(item, 320).then((u) => { img.onload = () => img.classList.add('ready'); img.src = u; }).catch(() => { img.dataset.loaded = ''; tile.classList.add('err'); });
    } else if (img.dataset.loaded && img.src) {
      // 画面から離れたら解放（メモリ対策）。Cache API に残っているので戻れば即復帰
      const u = img.src; img.src = ''; img.classList.remove('ready'); img.dataset.loaded = ''; try { URL.revokeObjectURL(u); } catch {}
    }
  }
}, { rootMargin: '700px 0px' });
const itemMap = new Map();
const itemById = (id) => itemMap.get(id);

function visibleItems() {
  const f = state.filter;
  if (f === 'trash') return state.trash || [];
  return state.items.filter((i) => f === 'all' || (f === 'photo' && !i.video) || (f === 'video' && i.video) || (f === 'star' && i.starred) || (f === 'nodate' && i.estimated));
}
function render(keepScroll = true) {
  const y = window.scrollY;
  itemMap.clear(); for (const i of state.items) itemMap.set(i.id, i);
  const list = visibleItems(); const tl = $('#timeline'); io.disconnect();
  if (!list.length) {
    tl.innerHTML = state.filter === 'trash' ? '<div class="empty">ゴミ箱は空です</div>' : `<div class="empty">${state.items.length ? 'この条件の写真・動画はありません' : `まだ写真がありません。<br>iPhone の Google ドライブ アプリで「${esc(pathLabel())}」フォルダにアップロードするか、<br>右上の &#8679; からアップロードしてください。`}</div>`;
    $('#jump').innerHTML = ''; updateCount(list); return;
  }
  const groups = []; let cur = null;
  for (const it of list) { const d = new Date(it.t); const ym = isNaN(it.t) ? '0000-00' : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; if (!cur || cur.ym !== ym) { cur = { ym, items: [] }; groups.push(cur); } cur.items.push(it); }
  const html = groups.map((g) => {
    const [yy, mm] = g.ym.split('-'); const label = g.ym === '0000-00' ? '日付不明' : `${yy}年${+mm}月`;
    return `<section class="month" id="m-${g.ym}" data-ym="${g.ym}"><h2>${label}<small>${g.items.length} 件</small></h2><div class="grid">${g.items.map(tileHtml).join('')}</div></section>`;
  }).join('');
  tl.innerHTML = (state.filter === 'trash' ? '<div class="tlnote">Google ドライブのゴミ箱にある写真・動画です。<b>30 日たつと Google が完全に削除します。</b>戻したいものはタップ →「元に戻す」、まとめて戻すなら長押しで選択してください。パソコンのバックアップには残っています。</div>' : '') + html;
  $$('.tile', tl).forEach((t) => io.observe(t));
  const jump = $('#jump'); jump.innerHTML = groups.map((g) => { const [yy, mm] = g.ym.split('-'); return `<option value="${g.ym}">${g.ym === '0000-00' ? '日付不明' : `${yy}年${+mm}月`}（${g.items.length}）</option>`; }).join('');
  updateCount(list);
  if (keepScroll) window.scrollTo(0, y);
  const hh = $('header.top').offsetHeight; $$('.month').forEach((s) => s.style.scrollMarginTop = hh + 'px'); $$('.month h2').forEach((h) => h.style.top = hh + 'px');
}
function tileHtml(it) {
  return `<div class="tile${state.selected.has(it.id) ? ' selected' : ''}" data-id="${it.id}"><img alt="" decoding="async">${it.starred ? '<span class="star">&#9733;</span>' : ''}${it.shared ? '<span class="shared" title="共有されています">&#128279;</span>' : ''}${it.trashed ? '<span class="badge tb">ゴミ箱</span>' : ''}${it.video ? `<span class="badge">&#9654; ${it.dur ? fmtDur(it.dur) : '動画'}</span>` : (it.estimated ? '<span class="badge" title="撮影日は推定">?</span>' : '')}<span class="sel"></span></div>`;
}
function updateCount(list) { const n = list.length; const v = list.filter((i) => i.video).length; $('#countText').textContent = `${n.toLocaleString()} 件${v ? `（動画 ${v}）` : ''}`; }
function updateQuota() {
  const qq = state.quota; const el = $('#quotaText'); const bar = $('#quotaBar');
  if (!qq) { el.textContent = ''; return; }
  const used = +qq.usage || 0, limit = +qq.limit || 0;
  if (!limit) { el.textContent = `Drive 使用 ${fmtBytes(used)}（容量無制限）`; bar.style.width = '0'; return; }
  const pct = Math.min(100, used / limit * 100);
  el.textContent = `Drive 残り ${fmtBytes(Math.max(0, limit - used))} / ${fmtBytes(limit)}`;
  bar.style.width = pct.toFixed(1) + '%'; bar.className = pct >= 97 ? 'full' : pct >= 85 ? 'warn' : '';
  const over = used - limit;
  banner('quota', over > 0 ? `<b>Google の保存容量がいっぱいです</b>（${fmtBytes(over)} 超過）。このままでは写真をアップロードできません。Gmail・Google フォト・Drive の不要なものを消すか、Google One（100GB 月290円〜）を追加してください。` : pct >= 90 ? `Google ドライブの残りが ${fmtBytes(limit - used)} です。15GB を超える場合は Google One（100GB 月290円〜）の追加を検討してください。` : null, over > 0 ? '容量を確認' : undefined, over > 0 ? () => window.open('https://one.google.com/storage', '_blank') : undefined, over > 0);
}
function banner(key, html, btnLabel, onClick, red) {
  const root = $('#banners'); let el = root.querySelector(`[data-key="${key}"]`);
  if (!html) { if (el) el.remove(); return; }
  if (!el) { el = document.createElement('div'); el.dataset.key = key; root.appendChild(el); }
  el.className = 'banner' + (red ? ' red' : ''); el.innerHTML = `<span style="flex:1">${html}</span>${btnLabel ? `<button>${btnLabel}</button>` : ''}<button class="ghost" title="閉じる">&#10005;</button>`;
  const bs = el.querySelectorAll('button'); if (btnLabel) bs[0].onclick = onClick; bs[bs.length - 1].onclick = () => el.remove();
}

// ---------- 起動・読み込み ----------
async function boot() {
  applyFolderName();
  if ('serviceWorker' in navigator && !DEMO) navigator.serviceWorker.register('sw.js').catch(() => {});
  try { caches.delete('vault-thumbs-v1'); } catch {} // 旧版が溜めた画像（原本を含むことがある）を消して iPhone の容量を空ける
  if (!DEMO) { const tm = await idb.get('thumbmap'); if (tm && tm.map) state.thumbMap = tm.map; }
  if (!DEMO && !state.clientId) { show('setup'); return; }
  const r = DEMO ? null : handleRedirect();
  if (r && r !== 'ok') { show('login'); const m = $('#loginMsg'); m.classList.remove('hidden'); m.textContent = r === 'access_denied' ? 'Google でアクセスが許可されませんでした。もう一度お試しください。' : `ログインに失敗しました（${r}）。クライアント ID と、Google Cloud 側のリダイレクト URI（${redirectUri()}）を確認してください。`; return; }
  if (!DEMO) { loadToken(); state.email = LS.get('vault_email', ''); }
  if (!DEMO && !state.token) {
    // キャッシュがあればオフラインでも一覧を出す。なければログイン画面
    const cached = await idb.get('items');
    if (cached && cached.raw && cached.raw.length) { restoreCache(cached); show('app'); render(false); toast('前回の一覧を表示中。ログインすると最新になります', 3500); if (await silentAuth()) { await startLoad(); } else { banner('login', 'ログインすると最新の写真が読み込めます', 'ログイン', () => location.assign(authUrl()), false); } return; }
    show('login'); return;
  }
  show('app');
  const cached = await idb.get('items');
  if (cached && cached.raw && cached.raw.length) { restoreCache(cached); render(false); }
  await startLoad();
}
function restoreCache(c) { state.vaultId = c.vaultId; state.folders = new Map((c.folders || []).map((f) => [f.id, f])); state.raw = c.raw; state.index = c.index || null; state.quota = c.quota || state.quota; state.email = c.email || state.email; state.backup = c.backup || null; rebuildItems(); updateQuota(); }
async function startLoad() {
  if (state.loading) return; state.loading = true;
  toast('<span class="spin"></span> 読み込み中…', 0);
  try {
    await drive.init(); updateQuota();
    const res = await drive.loadAll((n) => toast(`<span class="spin"></span> ${n.toLocaleString()} 件 読み込み中…`, 0));
    state.raw = res.raw; state.folders = new Map(res.folders.map((f) => [f.id, f])); state.index = res.index; state.backup = res.backup || null; state.trash = null; state.listFresh = Date.now();
    if (res.thumbsFolder && drive.loadThumbMap) {
      // PC が作った小さい画像の一覧。前回の一覧があればすぐ使い、裏で取り直す。無ければ（最長 10 秒）待つ
      const load = drive.loadThumbMap(res.thumbsFolder).then((map) => { state.thumbMap = map; idb.set('thumbmap', { folder: res.thumbsFolder, ts: Date.now(), map }); }).catch((e) => { console.warn('小さい画像の一覧に失敗', e); tstat('mapErr', e); });
      if (!state.thumbMap) thumbs.mapReady = Promise.race([load, sleep(10000)]);
    } else if (!res.thumbsFolder) { state.thumbMap = null; }
    rebuildItems(); render(true); toastOff();
    idb.set('items', { vaultId: state.vaultId, folders: res.folders, raw: res.raw, index: res.index, backup: state.backup, quota: state.quota, email: state.email, ts: Date.now() });
    checkBackupBanner();
    const resume = LS.get('vault_resume', null); if (resume) { LS.del('vault_resume'); setFilter(resume.filter || 'all'); window.scrollTo(0, resume.y || 0); }
    checkSharingBanner();
    // ⇧ を押して写真を選んだのに、アプリに写真が届かなかった場合を記録する（iPhone の写真選択画面で止まったとき）
    const lastEv = upLog[upLog.length - 1];
    if (lastEv && lastEv.ev === 'open' && Date.now() - Date.parse(lastEv.t) > 60000) { ulog('nopick', { opened: lastEv.t }); saveUploadLog(); }
    const prevRun = LS.get(UPRUN_KEY, null);
    if (prevRun && !upState.running) {
      ulog('interrupted', { since: new Date(prevRun.t).toISOString(), n: prevRun.n }); LS.del(UPRUN_KEY);
      banner('upstop', `<b>前回のアップロードが途中で止まりました</b>（${new Date(prevRun.t).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} 開始・${prevRun.n} 件）。送り終わった写真は保管されています。同じ写真をもう一度まとめて選べば、まだの分だけ送ります。`, null, null, true);
      saveUploadLog();
    }
    if (IS_IOS && !STANDALONE && !LS.get('vault_a2hs_seen', false)) { banner('a2hs', 'Safari の共有ボタン →「ホーム画面に追加」で、アプリとして使えます。', '了解', () => { LS.set('vault_a2hs_seen', true); banner('a2hs', null); }); }
  } catch (e) {
    console.error(e); if (String(e.message).includes('redirecting')) return;
    toast('読み込みに失敗: ' + esc(e.message).slice(0, 160), 6000);
    if (e.status === 403 && /insufficient|scope|access/i.test(e.message)) { clearToken(); }
  } finally { state.loading = false; }
}
async function checkSharingBanner() {
  try {
    const r = await drive.checkSharing(); const n = r.folderPerms.length + r.sharedItems.length;
    if (!n) { banner('share', null); return; }
    const who = r.folderPerms.map((p) => p.displayName || p.emailAddress || p.type).slice(0, 3).join('、');
    banner('share', `<b>共有されている項目があります</b>：${r.folderPerms.length ? `フォルダ（${esc(who)}）` : ''}${r.folderPerms.length && r.sharedItems.length ? '、' : ''}${r.sharedItems.length ? `ファイル ${r.sharedItems.length} 件` : ''}。あなた以外も見られる状態です。`, '共有を解除', async () => {
      if (!confirm(`${n} 件の共有をすべて解除しますか？（あなた以外のアクセスがなくなります）`)) return;
      toast('<span class="spin"></span> 解除中…', 0);
      try { if (r.folderPerms.length) await drive.unshare(state.vaultId); for (const p of r.folderPerms) if (p.folderId) await drive.unshare(p.folderId); for (const it of r.sharedItems) { await drive.unshare(it.id); it.shared = false; } toast('共有を解除しました'); render(); checkSharingBanner(); }
      catch (e) { toast('解除に失敗: ' + esc(e.message), 5000); }
    }, true);
  } catch (e) { console.warn('共有チェック失敗', e); }
}

// ---------- 操作 ----------
async function setFilter(f) {
  state.filter = f; $$('#filters .chip').forEach((c) => c.classList.toggle('on', c.dataset.f === f));
  if (f === 'trash' && !state.trash) {
    toast('<span class="spin"></span> ゴミ箱を読み込み中…', 0);
    try { const raw = await drive.loadTrash(); raw.forEach((r) => r._trashed = true); state.trashRaw = raw; state.trash = raw.map(toItem); state.trash.sort((a, b) => Date.parse(b.trashedTime || 0) - Date.parse(a.trashedTime || 0)); }
    catch (e) { toast('ゴミ箱を読めません: ' + esc(e.message), 5000); state.trash = []; }
    toastOff();
  }
  if (state.selecting) endSelect();
  render(false); window.scrollTo(0, 0);
}
// 削除ロック: 普段は削除できない。メニューで 10 分だけ解除できる（誤タップ・誤操作からの保護）
function deleteAllowed() {
  if (state.unlockUntil > Date.now()) return true;
  alert('削除ロックが掛かっています。\n\n誤って消さないための保護です。どうしても削除するときは、右上の ⋮ メニュー →「削除ロックを一時解除」を押してください（10 分間だけ削除できます）。');
  return false;
}
let lockTimer = null;
function updateLockBanner() {
  const left = state.unlockUntil - Date.now();
  if (left <= 0) { banner('unlock', null); if (lockTimer) { clearInterval(lockTimer); lockTimer = null; } return; }
  banner('unlock', `&#128275; <b>削除ロック解除中</b>（あと ${Math.ceil(left / 60000)} 分で自動的にロック）`, 'ロックする', () => { state.unlockUntil = 0; updateLockBanner(); toast('削除ロックを掛けました'); }, true);
  if (!lockTimer) lockTimer = setInterval(updateLockBanner, 30000);
}
// バックアップ状況（PC の backup_photos.ps1 が書く）
function backupLine() {
  const b = state.backup; if (!b || !b.time) return 'まだ取られていません（PC が毎日 12:40 に取ります）';
  const ok = (b.dests || []).filter((d) => d.ok).map((d) => d.path).join('、');
  return `${fmtDate(Date.parse(b.time))}　${(+b.count || 0).toLocaleString()} 件（${fmtBytes(+b.bytes || 0)}）→ ${esc(ok || '-')}`;
}
function checkBackupBanner() {
  if (!state.items.length) { banner('backup', null); return; }
  const b = state.backup; const age = b && b.time ? (Date.now() - Date.parse(b.time)) / 86400000 : Infinity;
  const stopped = b && (b.dests || []).find((d) => d.ok === false && d.reason);
  if (stopped) { banner('backup', `<b>パソコンのバックアップが止まっています</b>：${esc(stopped.reason)}。写真を自分で消した覚えがなければ、Claude に相談してください。`, null, null, true); return; }
  if (age <= 3) { banner('backup', null); return; }
  banner('backup', b && b.time ? `パソコンのバックアップが <b>${Math.floor(age)} 日前</b>から更新されていません。パソコンを起動しておいてください（毎日 12:40 に自動）。` : 'パソコンのバックアップがまだ取られていません。パソコンを起動しておいてください（毎日 12:40 に自動で取られます）。');
}
async function restoreItems(ids) {
  if (!ids.length) return false;
  if (!confirm(`${ids.length} 件をゴミ箱から元に戻しますか？`)) return false;
  toast('<span class="spin"></span> 戻しています…', 0);
  try {
    await drive.untrash(ids); const set = new Set(ids);
    const back = state.trashRaw.filter((r) => set.has(r.id)); back.forEach((r) => { delete r._trashed; delete r.trashedTime; state.raw.push(r); });
    state.trashRaw = state.trashRaw.filter((r) => !set.has(r.id)); state.trash = (state.trash || []).filter((i) => !set.has(i.id));
    rebuildItems(); syncRawFlags(); render(); toast(`${ids.length} 件を元に戻しました`); return true;
  } catch (e) { toast('戻せませんでした: ' + esc(e.message), 5000); return false; }
}
$('#filters').addEventListener('click', (e) => { const c = e.target.closest('.chip'); if (c) setFilter(c.dataset.f); });
$('#jump').addEventListener('change', (e) => { const s = document.getElementById('m-' + e.target.value); if (s) s.scrollIntoView({ block: 'start' }); });
window.addEventListener('scroll', () => { // スクロール位置に合わせて年月セレクトを追従
  if (scrollTick) return; scrollTick = requestAnimationFrame(() => { scrollTick = 0; const hh = $('header.top').offsetHeight + 10; let cur = null; for (const s of $$('.month')) { if (s.getBoundingClientRect().top <= hh) cur = s; else break; } if (cur && $('#jump').value !== cur.dataset.ym) $('#jump').value = cur.dataset.ym; });
}, { passive: true });
let scrollTick = 0;

$('#timeline').addEventListener('click', (e) => {
  const tile = e.target.closest('.tile'); if (!tile) return;
  const id = tile.dataset.id;
  if (state.selecting) { if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id); tile.classList.toggle('selected', state.selected.has(id)); updateSelBar(); return; }
  const list = visibleItems(); const idx = list.findIndex((i) => i.id === id); if (idx >= 0) openViewer(list, idx);
});
// 長押しで選択モード
let pressTimer = null;
$('#timeline').addEventListener('touchstart', (e) => { const tile = e.target.closest('.tile'); if (!tile || state.selecting) return; pressTimer = setTimeout(() => { startSelect(); state.selected.add(tile.dataset.id); tile.classList.add('selected'); updateSelBar(); if (navigator.vibrate) navigator.vibrate(10); }, 550); }, { passive: true });
['touchend', 'touchmove', 'touchcancel'].forEach((ev) => $('#timeline').addEventListener(ev, () => clearTimeout(pressTimer), { passive: true }));

// 選択モード
function startSelect() { state.selecting = true; document.body.classList.add('selecting'); $('#selbar').classList.remove('hidden'); updateSelBar(); }
function endSelect() { state.selecting = false; state.selected.clear(); document.body.classList.remove('selecting'); $('#selbar').classList.add('hidden'); $$('.tile.selected').forEach((t) => t.classList.remove('selected')); }
function updateSelBar() { $('#selCount').textContent = `${state.selected.size} 件`; const dis = !state.selected.size; ['#selStar', '#selSave', '#selDelete'].forEach((s) => $(s).disabled = dis); const tr = state.filter === 'trash'; $('#selStar').classList.toggle('hidden', tr); $('#selDelete').textContent = tr ? '元に戻す' : '削除'; $('#selDelete').className = tr ? 'primary' : 'danger'; }
$('#selectBtn').onclick = () => state.selecting ? endSelect() : startSelect();
$('#selCancel').onclick = endSelect;
$('#selAll').onclick = () => { const vis = visibleItems(); const all = vis.every((i) => state.selected.has(i.id)); vis.forEach((i) => all ? state.selected.delete(i.id) : state.selected.add(i.id)); $$('.tile').forEach((t) => t.classList.toggle('selected', state.selected.has(t.dataset.id))); updateSelBar(); };
$('#selDelete').onclick = () => (state.filter === 'trash' ? restoreItems(Array.from(state.selected)) : deleteItems(Array.from(state.selected))).then((ok) => ok && endSelect());
$('#selStar').onclick = async () => { const ids = Array.from(state.selected); const items = ids.map(itemById).filter(Boolean); const on = !items.every((i) => i.starred); toast('<span class="spin"></span> 更新中…', 0); try { await drive.setStar(ids, on); items.forEach((i) => i.starred = on); syncRawFlags(); render(); toast(on ? '★ お気に入りに追加' : '★ を外しました'); } catch (e) { toast('失敗: ' + esc(e.message), 5000); } };
$('#selSave').onclick = () => saveItems(Array.from(state.selected).map(itemById).filter(Boolean));

function syncRawFlags() { const m = new Map(state.items.map((i) => [i.id, i])); for (const r of state.raw) { const i = m.get(r.id); if (i) { r.starred = i.starred; r.shared = i.shared; } } idb.set('items', { vaultId: state.vaultId, folders: Array.from(state.folders.values()), raw: state.raw, index: state.index, backup: state.backup, quota: state.quota, email: state.email, ts: Date.now() }); }

async function deleteItems(ids) {
  if (!ids.length) return false;
  if (!deleteAllowed()) return false;
  if (!confirm(`${ids.length} 件を Google ドライブのゴミ箱に移動しますか？\n（30 日以内なら Google ドライブのゴミ箱から元に戻せます。パソコンのバックアップには残ります）`)) return false;
  toast('<span class="spin"></span> 削除中…', 0);
  try {
    await drive.trash(ids); const set = new Set(ids);
    state.raw = state.raw.filter((r) => !set.has(r.id)); state.items = state.items.filter((i) => !set.has(i.id));
    state.trash = null; syncRawFlags(); render(); toast(`${ids.length} 件をゴミ箱に移動しました（上の「ゴミ箱」タブから 30 日以内なら戻せます）`, 4000); return true;
  } catch (e) { toast('削除に失敗: ' + esc(e.message), 5000); return false; }
}
async function saveItems(items) {
  if (!items.length) return;
  if (items.length > 10 && !confirm(`${items.length} 件をまとめてダウンロードします（通信量に注意）。続けますか？`)) return;
  toast('<span class="spin"></span> 原本を取得中…', 0);
  try {
    const files = [];
    for (let i = 0; i < items.length; i++) { toast(`<span class="spin"></span> 原本を取得中… ${i + 1}/${items.length}`, 0); const b = await drive.downloadBlob(items[i]); files.push(new File([b], items[i].name, { type: items[i].mime || b.type })); }
    toastOff();
    if (navigator.canShare && navigator.canShare({ files })) { await navigator.share({ files, title: state.folderName }); }
    else { for (const f of files) { const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; document.body.appendChild(a); a.click(); a.remove(); await sleep(400); } toast('ダウンロードしました'); }
  } catch (e) { if (/abort/i.test(e.name || '')) { toastOff(); return; } toast('保存に失敗: ' + esc(e.message), 5000); }
}

// ---------- メニュー ----------
function sheet(title, buttons, extraHtml = '') {
  const root = $('#sheetRoot');
  root.innerHTML = `<div class="sheet-bg"><div class="sheet"><h3>${title}</h3>${extraHtml}${buttons.map((b, i) => `<button data-i="${i}" class="${b.cls || ''}">${b.label}</button>`).join('')}<button data-i="-1">閉じる</button></div></div>`;
  const close = () => { root.innerHTML = ''; };
  root.querySelector('.sheet-bg').onclick = (e) => { if (e.target === e.currentTarget) close(); };
  root.querySelectorAll('button[data-i]').forEach((b) => b.onclick = () => { const i = +b.dataset.i; close(); if (i >= 0 && buttons[i].fn) buttons[i].fn(); });
}
$('#menuBtn').onclick = () => {
  const qq = state.quota || {}; const used = +qq.usage || 0, limit = +qq.limit || 0;
  const info = `<div class="kv">アカウント: ${esc(state.email || '-')}<br>フォルダ: ${esc(pathLabel())}（${state.items.length.toLocaleString()} 件 / 写真 ${state.items.filter((i) => !i.video).length.toLocaleString()}・動画 ${state.items.filter((i) => i.video).length.toLocaleString()}）<br>容量: ${limit ? `${fmtBytes(used)} 使用 / ${fmtBytes(limit)}（残り ${fmtBytes(limit - used)}）` : fmtBytes(used) + ' 使用'}<br>撮影日の索引: ${state.index && state.index.generated ? `PC 作成 ${esc(state.index.generated).slice(0, 16)}（${Object.keys(state.index.files || {}).length.toLocaleString()} 件）` : 'なし（PC の整理ツールが作ります）'}<br>日付が推定のもの: ${state.items.filter((i) => i.estimated).length.toLocaleString()} 件<br>PC のバックアップ: ${backupLine()}<br>削除ロック: ${state.unlockUntil > Date.now() ? '解除中' : '掛かっています'} ・ バージョン ${esc(CFG.version)}</div>`;
  sheet('メニュー', [
    { label: '&#8635; 最新の状態に更新', fn: () => startLoad() },
    { label: state.unlockUntil > Date.now() ? '&#128274; 削除ロックを掛ける' : '&#128275; 削除ロックを一時解除（10 分だけ削除できる）', fn: () => { if (state.unlockUntil > Date.now()) { state.unlockUntil = 0; updateLockBanner(); toast('削除ロックを掛けました'); return; } if (!confirm('10 分間だけ、写真をゴミ箱に移せるようになります。\n（ゴミ箱からは 30 日以内なら戻せます。パソコンのバックアップは消えません）\n解除しますか？')) return; state.unlockUntil = Date.now() + 10 * 60000; updateLockBanner(); toast('10 分間だけ削除できます'); } },
    { label: '&#128221; アップロードの記録を保存（不具合の調査用）', fn: async () => { toast('<span class="spin"></span> 保存中…', 0); const ok = await saveUploadLog(); toast(ok ? 'Drive の写真保管庫に「アップロード記録.json」を保存しました' : (DEMO ? 'デモでは保存しません' : '保存できませんでした（ログインし直してから試してください）'), 4000); } },
    { label: '&#128737; 共有チェック（私だけか確認）', fn: async () => { toast('<span class="spin"></span> 確認中…', 0); try { const r = await drive.checkSharing(); const n = r.folderPerms.length + r.sharedItems.length; toastOff(); if (!n) alert('共有はありません。あなただけがアクセスできる状態です。'); else { await checkSharingBanner(); window.scrollTo(0, 0); } } catch (e) { toast('確認に失敗: ' + esc(e.message), 5000); } } },
    { label: `&#8645; 並び順: ${state.order === 'desc' ? '新しい順 → 古い順にする' : '古い順 → 新しい順にする'}`, fn: () => { state.order = state.order === 'desc' ? 'asc' : 'desc'; LS.set('vault_order', state.order); sortItems(); render(false); window.scrollTo(0, 0); } },
    { label: '&#128193; Google ドライブでフォルダを開く', fn: () => window.open(drive.vaultLink(), '_blank') },
    { label: '&#129529; サムネイルのキャッシュを消す（表示がおかしいとき）', fn: async () => { try { await caches.delete(thumbs.cacheName); } catch {} await idb.del('items'); await idb.del('thumbmap'); thumbs.mem.clear(); thumbs.mode = {}; LS.del('vault_thumb_mode'); toast('キャッシュを消しました'); render(false); } },
    { label: '&#128682; ログアウト', cls: 'danger', fn: async () => { if (!confirm('ログアウトしますか？（iPhone 内の一覧キャッシュも消します）')) return; await drive.logout(); await idb.del('items'); try { await caches.delete(thumbs.cacheName); } catch {} location.replace(redirectUri()); } },
    { label: '&#9881; クライアント ID を設定し直す', fn: () => { if (confirm('クライアント ID の設定画面に戻りますか？')) { LS.del('vault_client_id'); clearToken(); location.replace(redirectUri()); } } }
  ], info);
};

// ---------- ビューア ----------
function openViewer(list, idx) {
  state.view = { list, idx, zoom: 1, tx: 0, ty: 0, url: null, bigUrl: null };
  const root = $('#viewerRoot');
  root.innerHTML = `<div class="viewer" id="viewer">
    <div class="vtop"><button class="iconbtn" id="vClose">&#10005;</button><div class="info"><b id="vDate"></b><span id="vName"></span></div><button class="iconbtn" id="vOpen" title="Google ドライブで開く">&#8599;</button></div>
    <div class="stage" id="vStage"></div>
    <div class="vbottom"><button id="vStar"><i>&#9734;</i>お気に入り</button><button id="vSave"><i>&#8681;</i>iPhone に保存</button><button id="vInfo"><i>&#8505;</i>情報</button><button id="vDel"><i>&#128465;</i>削除</button></div>
  </div>`;
  const v = $('#viewer');
  $('#vClose').onclick = closeViewer;
  $('#vOpen').onclick = () => window.open(drive.fileLink(curItem()), '_blank');
  $('#vStar').onclick = async () => { const it = curItem(); try { await drive.setStar([it.id], !it.starred); it.starred = !it.starred; syncRawFlags(); updateViewerChrome(); $$(`.tile[data-id="${it.id}"]`).forEach((t) => { t.outerHTML = tileHtml(it); }); $$(`.tile[data-id="${it.id}"]`).forEach((t) => io.observe(t)); toast(it.starred ? '★ お気に入りに追加' : '★ を外しました', 1500); } catch (e) { toast('失敗: ' + esc(e.message), 4000); } };
  $('#vSave').onclick = () => saveItems([curItem()]);
  $('#vDel').onclick = async () => { const it = curItem(); const ok = it.trashed ? await restoreItems([it.id]) : await deleteItems([it.id]); if (!ok) return; state.view.list = state.view.list.filter((i) => i.id !== it.id); if (!state.view.list.length) return closeViewer(); state.view.idx = Math.min(state.view.idx, state.view.list.length - 1); showCurrent(); };
  $('#vInfo').onclick = () => {
    const it = curItem(); const srcLabel = { app: '手で直した日付', phone: 'iPhone が持っていた日付', index: 'PC の索引（EXIF/動画の作成日時）', exif: '写真の EXIF', modified: '更新日時（推定）', created: 'アップロード日時（推定）' }[it.src] || it.src;
    sheet('情報', [
      { label: '&#128197; 撮影日時を直す', fn: () => fixDate(it) },
      { label: '&#8599; Google ドライブで開く', fn: () => window.open(drive.fileLink(it), '_blank') }
    ], `<div class="kv">ファイル名: ${esc(it.name)}<br>撮影日時: ${isNaN(it.t) ? '不明' : fmtDate(it.t)}（${srcLabel}）<br>種類: ${esc(it.mime)}${it.w ? `　${it.w}×${it.h}` : ''}${it.dur ? `　${fmtDur(it.dur)}` : ''}<br>サイズ: ${fmtBytes(it.size)}<br>フォルダ: ${esc(state.folderName)}/${esc(folderPath(it.parent) || '')}<br>アップロード: ${it.created ? fmtDate(Date.parse(it.created)) : '-'}${it.shared ? '<br><b style="color:#ffb3b6">⚠ 共有されています</b>' : ''}</div>`);
  };
  // ジェスチャー：左右スワイプ、タップで没入、ダブルタップ・ピンチで拡大
  const stage = $('#vStage'); let pts = new Map(); let startDist = 0, startZoom = 1, sx = 0, sy = 0, moved = false, lastTap = 0, startTx = 0, startTy = 0;
  stage.addEventListener('pointerdown', (e) => { if (e.target.tagName === 'IFRAME' || e.target.tagName === 'VIDEO') return; stage.setPointerCapture(e.pointerId); pts.set(e.pointerId, e); moved = false; if (pts.size === 1) { sx = e.clientX; sy = e.clientY; startTx = state.view.tx; startTy = state.view.ty; } if (pts.size === 2) { const [a, b] = Array.from(pts.values()); startDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); startZoom = state.view.zoom; } });
  stage.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, e);
    if (pts.size === 2) { const [a, b] = Array.from(pts.values()); const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); state.view.zoom = Math.min(6, Math.max(1, startZoom * d / (startDist || 1))); applyZoom(); moved = true; return; }
    const dx = e.clientX - sx, dy = e.clientY - sy; if (Math.abs(dx) + Math.abs(dy) > 8) moved = true;
    if (state.view.zoom > 1) { state.view.tx = startTx + dx; state.view.ty = startTy + dy; applyZoom(); }
    else if (Math.abs(dx) > Math.abs(dy)) { const img = stage.querySelector('img'); if (img) img.style.transform = `translateX(${dx}px)`; }
  });
  const up = (e) => {
    if (!pts.has(e.pointerId)) return; const dx = e.clientX - sx, dy = e.clientY - sy; pts.delete(e.pointerId);
    if (pts.size) return;
    if (!moved) { const now = Date.now(); if (now - lastTap < 300) { state.view.zoom = state.view.zoom > 1 ? 1 : 2.5; state.view.tx = state.view.ty = 0; applyZoom(); lastTap = 0; } else { lastTap = now; setTimeout(() => { if (lastTap === now) v.classList.toggle('immersive'); }, 300); } return; }
    if (state.view.zoom <= 1) { const img = stage.querySelector('img'); if (img) img.style.transform = ''; if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) { dx < 0 ? next(1) : next(-1); } else if (dy > 120 && Math.abs(dx) < 80) closeViewer(); }
  };
  stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
  document.addEventListener('keydown', keyNav);
  history.pushState({ viewer: 1 }, ''); // 戻るボタンで閉じる
  showCurrent();
}
function keyNav(e) { if (!state.view) return; if (e.key === 'ArrowRight') next(1); else if (e.key === 'ArrowLeft') next(-1); else if (e.key === 'Escape') closeViewer(); }
window.addEventListener('popstate', () => { if (state.view) closeViewer(false); });
const curItem = () => state.view.list[state.view.idx];
function applyZoom() { const img = $('#vStage img'); if (img) img.style.transform = `translate(${state.view.tx}px, ${state.view.ty}px) scale(${state.view.zoom})`; }
function next(d) { const v = state.view; const n = v.idx + d; if (n < 0 || n >= v.list.length) { toast(d > 0 ? '最後です' : '最初です', 900); return; } v.idx = n; v.zoom = 1; v.tx = v.ty = 0; showCurrent(); }
function closeViewer(pop = true) {
  if (!state.view) return; document.removeEventListener('keydown', keyNav);
  releaseViewerUrls(); state.view = null; $('#viewerRoot').innerHTML = '';
  if (pop && history.state && history.state.viewer) history.back();
}
function releaseViewerUrls() { const v = state.view; if (!v) return; for (const k of ['url', 'bigUrl', 'videoUrl']) if (v[k]) { try { URL.revokeObjectURL(v[k]); } catch {} v[k] = null; } }
function updateViewerChrome() { const it = curItem(); $('#vDate').textContent = isNaN(it.t) ? '日付不明' : fmtDate(it.t) + (it.estimated ? '（推定）' : ''); $('#vName').textContent = it.name + (it.dur ? `　${fmtDur(it.dur)}` : '') + `　${fmtBytes(it.size)}`; $('#vStar').innerHTML = `<i>${it.starred ? '&#9733;' : '&#9734;'}</i>お気に入り`; $('#vStar').disabled = !!it.trashed; $('#vDel').innerHTML = it.trashed ? '<i>&#8634;</i>元に戻す' : '<i>&#128465;</i>削除'; }
async function showCurrent() {
  const it = curItem(); const stage = $('#vStage'); const v = state.view; releaseViewerUrls(); updateViewerChrome();
  stage.innerHTML = `<div class="loading"><span class="spin"></span> 読み込み中…</div>`;
  const token = Symbol(); v.token = token;
  if (it.video) {
    if (DEMO) { stage.innerHTML = `<div class="loading">（デモでは動画は再生できません）</div>`; return; }
    stage.innerHTML = `<iframe allow="autoplay; fullscreen" allowfullscreen src="${drive.previewUrl(it)}"></iframe><div class="videohint">再生できないときは <button id="vAlt">ダウンロードして再生</button></div>`;
    $('#vAlt').onclick = async () => { if (it.size > 300e6 && !confirm(`${fmtBytes(it.size)} をダウンロードします。続けますか？`)) return; toast('<span class="spin"></span> 動画を取得中…', 0); try { const b = await drive.downloadBlob(it); if (v.token !== token) return; v.videoUrl = URL.createObjectURL(b); stage.innerHTML = `<video controls autoplay playsinline src="${v.videoUrl}"></video>`; toastOff(); } catch (e) { toast('取得に失敗: ' + esc(e.message), 5000); } };
    return;
  }
  const img = document.createElement('img'); img.alt = '';
  try {
    // まず一覧用の小さい画像を即表示 → 大きい画像に差し替え
    const small = await getThumbUrl(it, 320); if (v.token !== token) return; v.url = small; img.src = small; stage.innerHTML = ''; stage.appendChild(img);
    const big = await getThumbUrl(it, 2048); if (v.token !== token) return; v.bigUrl = big; img.onerror = () => { img.onerror = null; img.src = small; }; img.src = big;
  } catch (e) { if (v.token === token) stage.innerHTML = `<div class="loading">表示できませんでした<br><small>${esc(e.message)}</small></div>`; }
  // 隣の画像を先読み
  for (const d of [1, -1]) { const n = v.list[v.idx + d]; if (n && !n.video) getThumbUrl(n, 2048).then((u) => URL.revokeObjectURL(u)).catch(() => {}); }
}
async function fixDate(it) {
  const d = isNaN(it.t) ? new Date() : new Date(it.t);
  const def = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const s = prompt('撮影日時を入力（例 2024-05-03 14:20）', def); if (!s) return;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(s.trim()); if (!m) { alert('形式が違います。例: 2024-05-03 14:20'); return; }
  const nd = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 12), +(m[5] || 0)); const iso = nd.toISOString();
  toast('<span class="spin"></span> 保存中…', 0);
  try { await drive.setCaptured(it.id, iso); const r = state.raw.find((x) => x.id === it.id); if (r) { r.modifiedTime = iso; r.appProperties = Object.assign({}, r.appProperties, { captured: iso, src: 'manual' }); } it.app = Object.assign({}, it.app, { captured: iso, src: 'manual' }); it.modified = iso; resolveDate(it); sortItems(); syncRawFlags(); render(false); if (state.view) { state.view.list = visibleItems(); state.view.idx = Math.max(0, state.view.list.findIndex((x) => x.id === it.id)); updateViewerChrome(); } toast('撮影日時を直しました'); }
  catch (e) { toast('失敗: ' + esc(e.message), 5000); }
}

// ---------- アップロード（iPhone → Drive） ----------
// たくさん選んでも最後まで上がるように:
//  1) 先に全部の受付（resumable セッション）を取る … ここだけログインが要る。受付後はログインが切れても送れる
//  2) 3 件ずつ並行で送る。通信が切れたら、届いたところから自動で続きを送る
//  3) 送っている間は画面を暗くしない（Wake Lock）。失敗した分は最後に「もう一度」で送り直せる
const UP_CONCURRENCY = 3, PREP_CONCURRENCY = 4, CHUNK = 8 * 1024 * 1024; // CHUNK は 256KB の倍数
const upCtl = { cancelled: false, xhrs: new Set() };
const upState = { running: false, failed: [] };
// ---- アップロードの記録（不具合の調査用）: iPhone の中と、Drive の「アップロード記録.json」に残す ----
const UPLOG_KEY = DEMO ? 'demo_uplog' : 'vault_uplog', UPRUN_KEY = DEMO ? 'demo_uprun' : 'vault_uprun'; // デモは本物の記録と混ぜない
const upLog = LS.get(UPLOG_KEY, []);
function ulog(ev, data) {
  upLog.push(Object.assign({ t: new Date().toISOString(), ev }, data || {}));
  while (upLog.length > 600) upLog.shift();
  LS.set(UPLOG_KEY, upLog);
}
async function saveUploadLog() {
  if (DEMO || !state.vaultId || !state.token || state.tokenExp < Date.now() + 60000) return false;
  const prev = state.noRedirect; state.noRedirect = true;
  try {
    const body = JSON.stringify({ saved: new Date().toISOString(), version: CFG.version, ua: navigator.userAgent, standalone: STANDALONE, thumbs: { stats: thumbs.stats, errs: thumbs.errs, mode: thumbs.mode, map: state.thumbMap ? Object.keys(state.thumbMap).length : 0 }, log: upLog }, null, 1);
    const ex = await listAll(`name='アップロード記録.json' and '${state.vaultId}' in parents and trashed=false`, 'files(id)');
    if (ex.length) {
      await gfetch(`${UPLOAD_API}/${ex[0].id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });
    } else {
      const b = 'vaultlog' + Date.now();
      const meta = { name: 'アップロード記録.json', parents: [state.vaultId], mimeType: 'application/json' };
      const mp = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${b}--`;
      await gfetch(`${UPLOAD_API}?uploadType=multipart`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body: mp });
    }
    return true;
  } catch (e) { console.warn('記録の保存に失敗', e); return false; }
  finally { state.noRedirect = prev; }
}
window.addEventListener('error', (e) => { if (upState.running) ulog('jserror', { msg: String(e.message).slice(0, 200), at: `${e.lineno}:${e.colno}` }); });
window.addEventListener('unhandledrejection', (e) => { if (upState.running) ulog('rejection', { msg: String(e.reason && e.reason.message || e.reason).slice(0, 200) }); });
document.addEventListener('visibilitychange', () => { if (upState.running) ulog(document.hidden ? 'hidden' : 'visible'); });
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
    if (!on && wakeLock) { const w = wakeLock; wakeLock = null; await w.release(); }
  } catch {}
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && upState.running) keepAwake(true); });
window.addEventListener('beforeunload', (e) => { if (upState.running) { e.preventDefault(); e.returnValue = ''; } });

$('#uploadBtn').onclick = () => {
  if (upState.running) { toast('いまアップロード中です。終わってから追加してください'); return; }
  // 受付を取る間（最初の数十秒）だけログインが要る。残りが少なければ、写真を選ぶ前にログインし直してもらう
  if (!DEMO && (!state.token || state.tokenExp - Date.now() < 15 * 60000)) {
    if (confirm('ログインの有効時間が残り少ないため、先にログインし直します。\n戻ってきたら、もう一度 ⇧ を押して写真を選んでください。')) { LS.set('vault_resume', { y: window.scrollY, filter: state.filter }); location.assign(authUrl()); }
    return;
  }
  banner('pickwait', '<span class="spin"></span> 写真を選んで ✓（追加）を押すと、iPhone が写真の準備をします。<b>枚数が多いと時間がかかります</b>。✓ は 1 回だけ押して、そのまま待ってください。反応がないときは 50 枚くらいずつに分けてください。', null, null, false);
  ulog('open', { tokenMin: Math.round((state.tokenExp - Date.now()) / 60000) });
  $('#filePicker').click();
};
$('#filePicker').addEventListener('cancel', () => { banner('pickwait', null); ulog('cancel'); });
$('#filePicker').addEventListener('change', async (e) => { banner('pickwait', null); const files = Array.from(e.target.files || []); e.target.value = ''; ulog('pick', { n: files.length, mb: Math.round(files.reduce((a, f) => a + f.size, 0) / 1e6), types: [...new Set(files.map((f) => f.type || '?'))].slice(0, 5), exts: [...new Set(files.map((f) => (f.name.split('.').pop() || '').toLowerCase()))].slice(0, 6), tokenMin: Math.round((state.tokenExp - Date.now()) / 60000) }); if (files.length) await uploadFiles(files); else toast('写真を受け取れませんでした。枚数を減らしてもう一度お試しください'); });
$('#upCancel').onclick = () => { if (!confirm('アップロードを中止しますか？（送り終わった写真は残ります）')) return; upCtl.cancelled = true; for (const x of upCtl.xhrs) { try { x.abort(); } catch {} } };

const EXT_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', heif: 'image/heif', gif: 'image/gif', webp: 'image/webp', mov: 'video/quicktime', mp4: 'video/mp4', m4v: 'video/x-m4v' };
// Safari が種類を取り違えることがあるので、名前（拡張子）が分かればそれを優先する
function fileType(f) { const ext = (f.name.split('.').pop() || '').toLowerCase(); return EXT_TYPES[ext] || f.type || 'application/octet-stream'; }
function xhrPut(url, headers, body, onProgress, ctl) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest(); x.open('PUT', url); x.timeout = 180000;
    for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
    if (onProgress) x.upload.onprogress = (e) => onProgress(e.loaded);
    x.onload = () => resolve(x);
    x.onerror = () => reject(new Error('通信エラー'));
    x.ontimeout = () => reject(new Error('時間切れ'));
    x.onabort = () => reject(new Error(ctl.cancelled ? 'cancelled' : '通信が切れました'));
    x.onloadend = () => ctl.xhrs.delete(x);
    ctl.xhrs.add(x); x.send(body);
  });
}
const rangeEnd = (x) => { const m = /bytes=0-(\d+)/.exec(x.getResponseHeader('Range') || ''); return m ? +m[1] + 1 : 0; };
const waitOnline = () => (navigator.onLine === false ? new Promise((r) => window.addEventListener('online', r, { once: true })) : Promise.resolve());
const parseJSON = (t) => { try { return JSON.parse(t || '{}'); } catch { return {}; } };
// Google の resumable アップロード: 8MB ずつ送る。切れたら「どこまで届いたか」を聞いて続きから送る
async function putResumable(loc, file, onProgress, ctl) {
  let start = 0, fails = 0;
  const report = (n) => onProgress && onProgress(Math.min(file.size, n));
  for (;;) {
    if (ctl.cancelled) throw new Error('cancelled');
    const end = Math.min(file.size, start + CHUNK);
    let r = null;
    try {
      r = await xhrPut(loc, { 'Content-Range': file.size ? `bytes ${start}-${end - 1}/${file.size}` : 'bytes */0' }, file.size ? file.slice(start, end) : null, (n) => report(start + n), ctl);
    } catch (e) { if (e.message === 'cancelled') throw e; }
    if (r && r.status >= 200 && r.status < 300) { report(file.size); return parseJSON(r.responseText); }
    if (r && r.status === 308) { start = rangeEnd(r); fails = 0; continue; }
    if (r && (r.status === 404 || r.status === 410)) throw new Error('アップロードの受付が切れました');
    if (r && r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) throw new Error(`アップロード失敗 (${r.status})`);
    // 通信エラー・時間切れ・混雑（5xx/429）: 少し待って、届いた位置を聞いてから続ける
    ulog('retry', { name: file.name, status: r ? r.status : 0, at: start, fails: fails + 1, online: navigator.onLine, hidden: document.hidden });
    if (++fails > 10) throw new Error(r ? `アップロード失敗 (${r.status})` : '通信エラーが続きました');
    await waitOnline(); await sleep(Math.min(30000, 800 * 2 ** fails));
    try {
      const st = await xhrPut(loc, { 'Content-Range': `bytes */${file.size}` }, null, null, ctl);
      if (st.status >= 200 && st.status < 300) { report(file.size); return parseJSON(st.responseText); }
      if (st.status === 308) { const got = rangeEnd(st); if (got > start) fails = 0; start = got; } // 進んでいれば、失敗の数え直し（遅い回線で打ち切らない）
      else if (st.status === 404 || st.status === 410) throw new Error('アップロードの受付が切れました');
    } catch (e) { if (e.message === 'cancelled' || /受付が切れ/.test(e.message)) throw e; }
    report(start);
  }
}
// 同時に n 件ずつ処理する
async function runPool(items, n, fn) {
  let i = 0;
  const worker = async () => { while (i < items.length) { const it = items[i++]; await fn(it); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}
async function readExifDate(file) { // JPEG の DateTimeOriginal を読む（HEIC は iOS が JPEG に変換して渡してくることが多い）
  try {
    if (!/jpe?g/i.test(file.type) && !/\.jpe?g$/i.test(file.name)) return NaN;
    const buf = await file.slice(0, 256 * 1024).arrayBuffer(); const dv = new DataView(buf);
    if (dv.getUint16(0) !== 0xFFD8) return NaN; let off = 2;
    while (off + 4 < dv.byteLength) {
      const marker = dv.getUint16(off); const len = dv.getUint16(off + 2);
      if (marker === 0xFFE1 && dv.getUint32(off + 4) === 0x45786966) { // "Exif"
        const tiff = off + 10; const le = dv.getUint16(tiff) === 0x4949; const g16 = (p) => dv.getUint16(p, le), g32 = (p) => dv.getUint32(p, le);
        const ifd0 = tiff + g32(tiff + 4); const n = g16(ifd0); let exifIfd = 0, dt = 0;
        for (let i = 0; i < n; i++) { const p = ifd0 + 2 + i * 12; const tag = g16(p); if (tag === 0x8769) exifIfd = tiff + g32(p + 8); if (tag === 0x0132) dt = p; }
        const readAscii = (p) => { const cnt = g32(p + 4); const vp = cnt > 4 ? tiff + g32(p + 8) : p + 8; let s = ''; for (let k = 0; k < Math.min(cnt, 20); k++) s += String.fromCharCode(dv.getUint8(vp + k)); return s; };
        if (exifIfd) { const m = g16(exifIfd); for (let i = 0; i < m; i++) { const p = exifIfd + 2 + i * 12; if (g16(p) === 0x9003) return parseExif(readAscii(p)); } }
        if (dt) return parseExif(readAscii(dt));
        return NaN;
      }
      if ((marker & 0xFF00) !== 0xFF00 || marker === 0xFFDA) break; off += 2 + len;
    }
  } catch {}
  return NaN;
}
async function uploadFiles(files) {
  if (upState.running) { toast('いまアップロード中です。終わってから追加してください'); return; }
  if (state.loading) { toast('<span class="spin"></span> 一覧の読み込みが終わるのを待っています…', 0); while (state.loading) await sleep(300); toastOff(); }
  // 保管済み（同じ名前・同じ大きさ）と、同じ写真の二重選択は飛ばす
  const existing = new Set(state.items.map((i) => i.name.toLowerCase() + '|' + i.size)); const seen = new Set();
  const todo = files.filter((f) => { const k = f.name.toLowerCase() + '|' + f.size; if (existing.has(k) || seen.has(k)) return false; seen.add(k); return true; });
  const skipped = files.length - todo.length;
  if (!todo.length) { toast(`すべて保管済みでした（${skipped} 件をスキップ）`); return; }
  const jobs = todo.map((f) => ({ f, loc: null, sent: 0, status: 'wait', err: '' }));
  const total = todo.reduce((sum, f) => sum + f.size, 0) || 1; const t0 = Date.now();
  upState.running = true; upState.failed = []; upCtl.cancelled = false; upCtl.xhrs = new Set(); state.noRedirect = true;
  ulog('start', { n: jobs.length, skipped, mb: Math.round(total / 1e6), tokenMin: Math.round((state.tokenExp - Date.now()) / 60000), wake: 'wakeLock' in navigator });
  LS.set(UPRUN_KEY, { t: Date.now(), n: jobs.length });
  banner('upfail', null); keepAwake(true); $('#upbar').classList.remove('hidden'); $('#upProg').style.width = '0';
  const count = (st) => jobs.filter((j) => j.status === st).length;
  let lastPaint = 0;
  const paint = (force) => {
    const now = Date.now(); if (!force && now - lastPaint < 250) return; lastPaint = now;
    const sent = jobs.reduce((sum, j) => sum + j.sent, 0); const pct = sent / total * 100; const ok = count('ok'), ng = count('fail');
    const el = (now - t0) / 1000; const rest = pct > 3 && el > 5 ? Math.round(el * (100 - pct) / pct / 60) : null;
    $('#upText').textContent = `アップロード中 ${ok}/${jobs.length} 件${ng ? `・失敗 ${ng}` : ''}${rest !== null ? `（残り約 ${Math.max(1, rest)} 分）` : ''}　画面は開いたままにしてください`;
    $('#upProg').style.width = pct.toFixed(1) + '%';
  };
  // 1) 受付: 撮影日を読み、年・月のフォルダを用意し、受付 URL を取る
  const folderCache = new Map(); // 同じ月のフォルダを同時に二重で作らないよう、約束（Promise）を共有する
  const folderFor = (name, parent) => { const k = parent + '/' + name; if (!folderCache.has(k)) { const p = drive.ensureFolder(name, parent); folderCache.set(k, p); p.catch(() => folderCache.delete(k)); } return folderCache.get(k); };
  let prepared = 0;
  $('#upText').textContent = `準備中 0/${jobs.length} 件…`;
  await runPool(jobs, PREP_CONCURRENCY, async (j) => {
    if (upCtl.cancelled) return;
    try {
      let t = await readExifDate(j.f); if (isNaN(t)) t = j.f.lastModified || Date.now(); const d = new Date(t);
      const y = await folderFor(String(d.getFullYear()), state.vaultId); const mf = await folderFor(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}`, y);
      const meta = { name: j.f.name, mimeType: fileType(j.f), parents: [mf], modifiedTime: d.toISOString(), appProperties: { captured: d.toISOString(), src: 'iphone-app' } };
      j.loc = await drive.initUpload(j.f, meta);
    } catch (e) { j.status = 'fail'; j.err = e.message; }
    prepared++; $('#upText').textContent = `準備中 ${prepared}/${jobs.length} 件…`;
  });
  ulog('prepared', { ok: jobs.filter((j) => j.loc).length, fail: count('fail'), errs: [...new Set(jobs.filter((j) => j.err).map((j) => j.err))].slice(0, 3), sec: Math.round((Date.now() - t0) / 1000) });
  // 2) 送信: 3 件ずつ。通信が切れても自動で続きから
  await runPool(jobs.filter((j) => j.loc), UP_CONCURRENCY, async (j) => {
    if (upCtl.cancelled) return;
    j.status = 'send';
    try {
      const res = await drive.uploadSession(j.loc, j.f, (b) => { j.sent = b; paint(); }, upCtl);
      j.status = 'ok'; j.sent = j.f.size;
      if (res && res.id) { state.raw.push(res); state.items.push(toItem(res)); }
    } catch (e) { j.status = e.message === 'cancelled' ? 'cancel' : 'fail'; j.err = e.message; if (j.status === 'fail') ulog('fail', { name: j.f.name, size: j.f.size, err: e.message }); }
    if (j.status === 'ok' && count('ok') % 25 === 0) ulog('progress', { ok: count('ok'), of: jobs.length, sec: Math.round((Date.now() - t0) / 1000) });
    paint(true);
  });
  // 3) 後片付けと結果
  upState.running = false; state.noRedirect = false; keepAwake(false);
  ulog('end', { ok: count('ok'), fail: count('fail'), cancelled: upCtl.cancelled, sec: Math.round((Date.now() - t0) / 1000) }); LS.del(UPRUN_KEY);
  saveUploadLog();
  $('#upbar').classList.add('hidden'); $('#upProg').style.width = '0';
  sortItems(); syncRawFlags(); render(false);
  const ok = count('ok'); const failed = jobs.filter((j) => j.status === 'fail' || (upCtl.cancelled && j.status !== 'ok'));
  upState.failed = failed.map((j) => j.f);
  if (state.quota && ok) { try { await drive.init(); updateQuota(); } catch {} }
  toast(`${ok} 件をアップロードしました${skipped ? `（${skipped} 件は保管済み）` : ''}${upCtl.cancelled ? '（中止）' : ''}`, 5000);
  if (upState.failed.length) {
    const why = [...new Set(failed.map((j) => (j.err === 'cancelled' || (!j.err && upCtl.cancelled) ? '途中で中止しました' : j.err)).filter(Boolean))].slice(0, 2).join('、');
    banner('upfail', `<b>${upState.failed.length} 件がまだアップロードできていません</b>${why ? `（${esc(why)}）` : ''}。「もう一度」で残りだけ送ります。アプリを閉じてしまったときは、同じ写真をもう一度まとめて選べば、まだの分だけ送られます。`, 'もう一度', () => uploadFiles(upState.failed), true);
  }
}

// ---------- 初回設定・ログイン画面 ----------
$('#saveSetup').onclick = () => {
  const id = $('#clientIdInput').value.trim(); const fn = $('#folderNameInput').value.trim().replace(/\\/g, '/') || CFG.vaultPath;
  if (!/\.apps\.googleusercontent\.com$/.test(id)) { alert('クライアント ID は「…….apps.googleusercontent.com」の形です。もう一度確認してください。'); return; }
  LS.set('vault_client_id', id); LS.set('vault_folder_path', fn); state.clientId = id; state.folderPath = fn; applyFolderName(); show('login');
};
$('#loginBtn').onclick = () => { LS.del('vault_resume'); location.assign(authUrl()); };
$('#resetSetup').onclick = () => { LS.del('vault_client_id'); clearToken(); state.clientId = ''; $('#clientIdInput').value = ''; show('setup'); };
if (state.clientId) $('#clientIdInput').value = state.clientId; $('#folderNameInput').value = state.folderPath;

// 画面復帰時にトークン切れなら静かに更新
document.addEventListener('visibilitychange', () => { if (!document.hidden && !DEMO && state.token && state.tokenExp < Date.now() + 60000) silentAuth(); });

boot();
})();
