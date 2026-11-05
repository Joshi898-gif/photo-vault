/* 写真保管庫 — Google ドライブの写真・動画を撮影日順に、自分だけで見る PWA
 * 構成: 認証(OAuth 暗黙フロー, リダイレクト方式) / Drive API 直叩き / IndexedDB・Cache API でオフライン一覧
 * ?demo=1 を付けると Google なしの見本データで動く（画面の確認用）
 */
(() => {
'use strict';

// ---------- 基本 ----------
const CFG = Object.assign({ clientId: '', vaultFolderName: '写真保管庫', appName: '写真保管庫', version: '1.0.0' }, window.VAULT_CONFIG || {});
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
  folderName: LS.get('vault_folder_name', '') || CFG.vaultFolderName,
  token: null, tokenExp: 0,
  email: '', quota: null,
  vaultId: null, folders: new Map(), // id -> {id,name,parent}
  raw: [], items: [], index: null,
  filter: 'all', order: LS.get('vault_order', 'desc'),
  selecting: false, selected: new Set(),
  view: null, // ビューア状態
  loading: false
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
      const r = indexedDB.open('vault-db', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => { this.db = r.result; res(this.db); };
      r.onerror = () => rej(r.error);
    });
  },
  async get(k) { try { const db = await this.open(); return await new Promise((res, rej) => { const t = db.transaction('kv').objectStore('kv').get(k); t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error); }); } catch { return undefined; } },
  async set(k, v) { try { const db = await this.open(); await new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite').objectStore('kv').put(v, k); t.onsuccess = res; t.onerror = () => rej(t.error); }); } catch {} },
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
  throw new Error('auth-iframe'); // ここで止める（描画しない）
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
    const name = state.folderName;
    const fs = await listAll(`name='${q(name)}' and mimeType='application/vnd.google-apps.folder' and 'root' in parents and trashed=false`, 'files(id,name)');
    if (fs.length) return fs[0].id;
    if (!create) return null;
    const j = await gjson(`${API}/files?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: ['root'] }) });
    return j.id;
  },
  async loadAll(onProgress) {
    if (!state.vaultId) state.vaultId = await this.findVault(true);
    // フォルダ階層（幅優先）
    const folders = new Map([[state.vaultId, { id: state.vaultId, name: state.folderName, parent: null }]]);
    let frontier = [state.vaultId];
    while (frontier.length) {
      const next = [];
      for (const ids of chunk(frontier, 30)) {
        const fs = await listAll(`mimeType='application/vnd.google-apps.folder' and trashed=false and (${ids.map((i) => `'${i}' in parents`).join(' or ')})`, 'files(id,name,parents)');
        for (const f of fs) { if (!folders.has(f.id)) { folders.set(f.id, { id: f.id, name: f.name, parent: (f.parents || [])[0] }); next.push(f.id); } }
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
    return { raw, folders: Array.from(folders.values()), index };
  },
  async refreshThumbLink(item) { const j = await gjson(`${API}/files/${item.id}?fields=thumbnailLink,hasThumbnail`); item.thumb = j.thumbnailLink || ''; return item.thumb; },
  async thumbBlob(item, size) {
    const tryLink = async (link) => {
      if (!link) throw new Error('no-thumb');
      const u = /=s\d+(-[a-z]+)?$/.test(link) ? link.replace(/=s\d+(-[a-z]+)?$/, `=s${size}`) : link + `=s${size}`;
      const r = await gfetch(u, { mode: 'cors' }); return r.blob();
    };
    try { return await tryLink(item.thumb); }
    catch (e) {
      if (e && (e.status === 403 || e.status === 404 || e.message === 'no-thumb')) { try { return await tryLink(await this.refreshThumbLink(item)); } catch {} }
      if (!item.video && item.size && item.size < 8e6) { const r = await gfetch(`${API}/files/${item.id}?alt=media`); return r.blob(); }
      throw e;
    }
  },
  async downloadBlob(item) { const r = await gfetch(`${API}/files/${item.id}?alt=media`); return r.blob(); },
  async trash(ids) { for (const id of ids) await patch(id, { trashed: true }); },
  async setStar(ids, on) { for (const id of ids) await patch(id, { starred: !!on }); },
  async setCaptured(id, iso) { return patch(id, { modifiedTime: iso, appProperties: { captured: iso } }); },
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
      if (f.id === state.vaultId) continue;
      try { const j = await gjson(`${API}/files/${f.id}?fields=shared,name`); if (j.shared) res.folderPerms.push({ id: '', type: 'folder', role: 'folder', displayName: `サブフォルダ「${j.name}」`, folderId: f.id }); } catch {}
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
  async upload(file, meta, onProgress, ctl) {
    await ensureToken();
    const init = await gfetch(`${UPLOAD_API}?uploadType=resumable&fields=${encodeURIComponent(FILE_FIELDS)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': file.type || 'application/octet-stream', 'X-Upload-Content-Length': String(file.size) }, body: JSON.stringify(meta)
    });
    const loc = init.headers.get('Location'); if (!loc) throw new Error('アップロード URL が取れませんでした');
    const CH = 16 * 1024 * 1024; let start = 0; let result = null;
    while (start < file.size || file.size === 0) {
      if (ctl.cancelled) throw new Error('cancelled');
      const end = Math.min(file.size, start + CH);
      const r = await new Promise((resolve, reject) => {
        const x = new XMLHttpRequest(); x.open('PUT', loc);
        x.setRequestHeader('Content-Range', file.size ? `bytes ${start}-${end - 1}/${file.size}` : `bytes */0`);
        x.upload.onprogress = (e) => onProgress && onProgress(start + e.loaded);
        x.onload = () => resolve(x); x.onerror = () => reject(new Error('通信エラー')); x.onabort = () => reject(new Error('cancelled'));
        ctl.xhr = x; x.send(file.size ? file.slice(start, end) : null);
      });
      if (r.status === 308) { const m = /bytes=0-(\d+)/.exec(r.getResponseHeader('Range') || ''); start = m ? +m[1] + 1 : end; continue; }
      if (r.status >= 200 && r.status < 300) { result = JSON.parse(r.responseText); break; }
      throw new Error(`アップロード失敗 (${r.status})`);
    }
    return result;
  },
  async logout() {
    const t = state.token; clearToken(); LS.del('vault_email');
    if (t) { try { await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(t), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }); } catch {} }
  }
};

// ---------- デモ用バックエンド（Google なしで画面確認） ----------
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
  const paint = (item, size) => new Promise((res) => {
    const c = document.createElement('canvas'); c.width = c.height = Math.min(size, 640); const g = c.getContext('2d');
    const h = item._hue || 0; const gr = g.createLinearGradient(0, 0, c.width, c.height); gr.addColorStop(0, `hsl(${h},55%,55%)`); gr.addColorStop(1, `hsl(${(h + 60) % 360},60%,35%)`); g.fillStyle = gr; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = 'rgba(255,255,255,.85)'; g.font = `${Math.round(c.width / 9)}px sans-serif`; g.textAlign = 'center'; g.fillText(item.video ? '▶ 動画' : '写真', c.width / 2, c.height / 2);
    g.font = `${Math.round(c.width / 16)}px sans-serif`; g.fillText(new Date(item.t).toLocaleDateString('ja-JP'), c.width / 2, c.height / 2 + c.width / 8);
    c.toBlob(res, 'image/jpeg', 0.8);
  });
  return {
    async init() { state.email = 'demo@example.com'; state.quota = { limit: String(15e9), usage: String(9.7e9), usageInDrive: String(8e9) }; },
    async loadAll(onProgress) { await sleep(400); onProgress && onProgress(raw.length, 1, 1); state.vaultId = 'demo-root'; return { raw, folders: [{ id: 'demo-root', name: state.folderName, parent: null }, { id: 'demo-2025', name: '2025', parent: 'demo-root' }], index: null }; },
    async thumbBlob(item, size) { await sleep(60 + Math.random() * 120); return paint(item, size); },
    async downloadBlob(item) { return paint(item, 1200); },
    async trash(ids) { await sleep(300); raw = raw.filter((r) => !ids.includes(r.id)); },
    async setStar(ids, on) { await sleep(200); raw.forEach((r) => { if (ids.includes(r.id)) r.starred = on; }); },
    async setCaptured(id, iso) { await sleep(200); const r = raw.find((x) => x.id === id); if (r) { r.modifiedTime = iso; r.appProperties = { captured: iso }; } return r; },
    vaultLink() { return 'https://drive.google.com/'; }, fileLink() { return 'https://drive.google.com/'; }, previewUrl() { return 'about:blank'; },
    async checkSharing() { await sleep(300); return { folderPerms: [], sharedItems: state.items.filter((i) => i.shared) }; },
    async unshare(id) { await sleep(200); raw.forEach((r) => { if (r.id === id) r.shared = false; }); },
    async ensureFolder() { return 'demo-root'; },
    async upload(file, meta, onProgress, ctl) { for (let p = 0; p <= file.size; p += Math.max(1, file.size / 20)) { if (ctl.cancelled) throw new Error('cancelled'); onProgress(Math.min(p, file.size)); await sleep(80); } const r = { id: 'up' + Date.now() + Math.random(), name: meta.name, mimeType: file.type || 'image/jpeg', size: file.size, createdTime: new Date().toISOString(), modifiedTime: meta.modifiedTime, parents: ['demo-root'], hasThumbnail: true, appProperties: meta.appProperties, starred: false, shared: false, _hue: 200 }; raw.push(r); return r; },
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
    thumb: f.thumbnailLink || '', exif: im.time || '', w: im.width || vm.width || 0, h: im.height || vm.height || 0, dur: +vm.durationMillis || 0, app: f.appProperties || {}, starred: !!f.starred, shared: !!f.shared, link: f.webViewLink || '', video, _hue: f._hue, t: 0, src: '' };
  resolveDate(it); return it;
}
function resolveDate(it) {
  let t = NaN, src = '';
  if (it.app && it.app.captured) { t = Date.parse(it.app.captured); src = 'app'; }
  if (isNaN(t) && state.index && state.index.files) {
    const dir = folderPath(it.parent); const key = dir === null ? null : (dir ? dir + '/' : '') + it.name;
    let e = key != null ? state.index.files[key] : null;
    if (!e && state.index.byName) { const cands = state.index.byName[it.name]; if (cands) e = cands.find((c) => !it.size || !c.s || c.s === it.size) || null; }
    if (e && e.t) { t = Date.parse(e.t); src = 'index'; if (e.w && !it.w) { it.w = e.w; it.h = e.h; } if (e.d && !it.dur) it.dur = e.d * 1000; }
  }
  if (isNaN(t) && it.exif) { t = parseExif(it.exif); src = 'exif'; }
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
const thumbs = { cacheName: 'vault-thumbs-v1', queue: [], running: 0, MAX: 6, inflight: new Map(), count: null };
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
        let blob = null;
        if (c) { const hit = await c.match(k); if (hit) blob = await hit.blob(); }
        if (!blob) {
          blob = await drive.thumbBlob(job.item, job.size);
          if (c && blob && blob.size > 0) { c.put(k, new Response(blob, { headers: { 'Content-Type': blob.type || 'image/jpeg' } })).catch(() => {}); trimThumbCache(c); }
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
function applyFolderName() { $$('.folderName').forEach((e) => e.textContent = state.folderName); document.title = state.folderName; }

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
  return state.items.filter((i) => f === 'all' || (f === 'photo' && !i.video) || (f === 'video' && i.video) || (f === 'star' && i.starred) || (f === 'nodate' && i.estimated));
}
function render(keepScroll = true) {
  const y = window.scrollY;
  itemMap.clear(); for (const i of state.items) itemMap.set(i.id, i);
  const list = visibleItems(); const tl = $('#timeline'); io.disconnect();
  if (!list.length) {
    tl.innerHTML = `<div class="empty">${state.items.length ? 'この条件の写真・動画はありません' : `まだ写真がありません。<br>iPhone の Google ドライブ アプリで「${esc(state.folderName)}」フォルダにアップロードするか、<br>右上の &#8679; からアップロードしてください。`}</div>`;
    $('#jump').innerHTML = ''; updateCount(list); return;
  }
  const groups = []; let cur = null;
  for (const it of list) { const d = new Date(it.t); const ym = isNaN(it.t) ? '0000-00' : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; if (!cur || cur.ym !== ym) { cur = { ym, items: [] }; groups.push(cur); } cur.items.push(it); }
  const html = groups.map((g) => {
    const [yy, mm] = g.ym.split('-'); const label = g.ym === '0000-00' ? '日付不明' : `${yy}年${+mm}月`;
    return `<section class="month" id="m-${g.ym}" data-ym="${g.ym}"><h2>${label}<small>${g.items.length} 件</small></h2><div class="grid">${g.items.map(tileHtml).join('')}</div></section>`;
  }).join('');
  tl.innerHTML = html;
  $$('.tile', tl).forEach((t) => io.observe(t));
  const jump = $('#jump'); jump.innerHTML = groups.map((g) => { const [yy, mm] = g.ym.split('-'); return `<option value="${g.ym}">${g.ym === '0000-00' ? '日付不明' : `${yy}年${+mm}月`}（${g.items.length}）</option>`; }).join('');
  updateCount(list);
  if (keepScroll) window.scrollTo(0, y);
  const hh = $('header.top').offsetHeight; $$('.month').forEach((s) => s.style.scrollMarginTop = hh + 'px'); $$('.month h2').forEach((h) => h.style.top = hh + 'px');
}
function tileHtml(it) {
  return `<div class="tile${state.selected.has(it.id) ? ' selected' : ''}" data-id="${it.id}"><img alt="" decoding="async">${it.starred ? '<span class="star">&#9733;</span>' : ''}${it.shared ? '<span class="shared" title="共有されています">&#128279;</span>' : ''}${it.video ? `<span class="badge">&#9654; ${it.dur ? fmtDur(it.dur) : '動画'}</span>` : (it.estimated ? '<span class="badge" title="撮影日は推定">?</span>' : '')}<span class="sel"></span></div>`;
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
  banner('quota', over > 0 ? `<b>Google の保存容量がいっぱいです</b>（${fmtBytes(over)} 超過）。このままでは写真をアップロードできません。Gmail・Google フォト・Drive の不要なものを消すか、Google One（100GB 月250円〜）を追加してください。` : pct >= 90 ? `Google ドライブの残りが ${fmtBytes(limit - used)} です。15GB を超える場合は Google One（100GB 月250円〜）の追加を検討してください。` : null, over > 0 ? '容量を確認' : undefined, over > 0 ? () => window.open('https://one.google.com/storage', '_blank') : undefined, over > 0);
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
function restoreCache(c) { state.vaultId = c.vaultId; state.folders = new Map((c.folders || []).map((f) => [f.id, f])); state.raw = c.raw; state.index = c.index || null; state.quota = c.quota || state.quota; state.email = c.email || state.email; rebuildItems(); updateQuota(); }
async function startLoad() {
  if (state.loading) return; state.loading = true;
  toast('<span class="spin"></span> 読み込み中…', 0);
  try {
    await drive.init(); updateQuota();
    const res = await drive.loadAll((n) => toast(`<span class="spin"></span> ${n.toLocaleString()} 件 読み込み中…`, 0));
    state.raw = res.raw; state.folders = new Map(res.folders.map((f) => [f.id, f])); state.index = res.index;
    rebuildItems(); render(true); toastOff();
    idb.set('items', { vaultId: state.vaultId, folders: res.folders, raw: res.raw, index: res.index, quota: state.quota, email: state.email, ts: Date.now() });
    const resume = LS.get('vault_resume', null); if (resume) { LS.del('vault_resume'); setFilter(resume.filter || 'all'); window.scrollTo(0, resume.y || 0); }
    checkSharingBanner();
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
function setFilter(f) { state.filter = f; $$('#filters .chip').forEach((c) => c.classList.toggle('on', c.dataset.f === f)); render(false); window.scrollTo(0, 0); }
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
function updateSelBar() { $('#selCount').textContent = `${state.selected.size} 件`; const dis = !state.selected.size; ['#selStar', '#selSave', '#selDelete'].forEach((s) => $(s).disabled = dis); }
$('#selectBtn').onclick = () => state.selecting ? endSelect() : startSelect();
$('#selCancel').onclick = endSelect;
$('#selAll').onclick = () => { const vis = visibleItems(); const all = vis.every((i) => state.selected.has(i.id)); vis.forEach((i) => all ? state.selected.delete(i.id) : state.selected.add(i.id)); $$('.tile').forEach((t) => t.classList.toggle('selected', state.selected.has(t.dataset.id))); updateSelBar(); };
$('#selDelete').onclick = () => deleteItems(Array.from(state.selected)).then((ok) => ok && endSelect());
$('#selStar').onclick = async () => { const ids = Array.from(state.selected); const items = ids.map(itemById).filter(Boolean); const on = !items.every((i) => i.starred); toast('<span class="spin"></span> 更新中…', 0); try { await drive.setStar(ids, on); items.forEach((i) => i.starred = on); syncRawFlags(); render(); toast(on ? '★ お気に入りに追加' : '★ を外しました'); } catch (e) { toast('失敗: ' + esc(e.message), 5000); } };
$('#selSave').onclick = () => saveItems(Array.from(state.selected).map(itemById).filter(Boolean));

function syncRawFlags() { const m = new Map(state.items.map((i) => [i.id, i])); for (const r of state.raw) { const i = m.get(r.id); if (i) { r.starred = i.starred; r.shared = i.shared; } } idb.set('items', { vaultId: state.vaultId, folders: Array.from(state.folders.values()), raw: state.raw, index: state.index, quota: state.quota, email: state.email, ts: Date.now() }); }

async function deleteItems(ids) {
  if (!ids.length) return false;
  if (!confirm(`${ids.length} 件を Google ドライブのゴミ箱に移動しますか？\n（30 日以内なら Google ドライブのゴミ箱から元に戻せます。パソコンのバックアップには残ります）`)) return false;
  toast('<span class="spin"></span> 削除中…', 0);
  try {
    await drive.trash(ids); const set = new Set(ids);
    state.raw = state.raw.filter((r) => !set.has(r.id)); state.items = state.items.filter((i) => !set.has(i.id));
    syncRawFlags(); render(); toast(`${ids.length} 件をゴミ箱に移動しました`); return true;
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
  const info = `<div class="kv">アカウント: ${esc(state.email || '-')}<br>フォルダ: ${esc(state.folderName)}（${state.items.length.toLocaleString()} 件 / 写真 ${state.items.filter((i) => !i.video).length.toLocaleString()}・動画 ${state.items.filter((i) => i.video).length.toLocaleString()}）<br>容量: ${limit ? `${fmtBytes(used)} 使用 / ${fmtBytes(limit)}（残り ${fmtBytes(limit - used)}）` : fmtBytes(used) + ' 使用'}<br>撮影日の索引: ${state.index && state.index.generated ? `PC 作成 ${esc(state.index.generated).slice(0, 16)}（${Object.keys(state.index.files || {}).length.toLocaleString()} 件）` : 'なし（PC の整理ツールが作ります）'}<br>日付が推定のもの: ${state.items.filter((i) => i.estimated).length.toLocaleString()} 件 ・ バージョン ${esc(CFG.version)}</div>`;
  sheet('メニュー', [
    { label: '&#8635; 最新の状態に更新', fn: () => startLoad() },
    { label: '&#128737; 共有チェック（私だけか確認）', fn: async () => { toast('<span class="spin"></span> 確認中…', 0); try { const r = await drive.checkSharing(); const n = r.folderPerms.length + r.sharedItems.length; toastOff(); if (!n) alert('共有はありません。あなただけがアクセスできる状態です。'); else { await checkSharingBanner(); window.scrollTo(0, 0); } } catch (e) { toast('確認に失敗: ' + esc(e.message), 5000); } } },
    { label: `&#8645; 並び順: ${state.order === 'desc' ? '新しい順 → 古い順にする' : '古い順 → 新しい順にする'}`, fn: () => { state.order = state.order === 'desc' ? 'asc' : 'desc'; LS.set('vault_order', state.order); sortItems(); render(false); window.scrollTo(0, 0); } },
    { label: '&#128193; Google ドライブでフォルダを開く', fn: () => window.open(drive.vaultLink(), '_blank') },
    { label: '&#129529; サムネイルのキャッシュを消す（表示がおかしいとき）', fn: async () => { try { await caches.delete(thumbs.cacheName); } catch {} await idb.del('items'); toast('キャッシュを消しました'); render(false); } },
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
  $('#vDel').onclick = async () => { const it = curItem(); const ok = await deleteItems([it.id]); if (!ok) return; state.view.list = state.view.list.filter((i) => i.id !== it.id); if (!state.view.list.length) return closeViewer(); state.view.idx = Math.min(state.view.idx, state.view.list.length - 1); showCurrent(); };
  $('#vInfo').onclick = () => {
    const it = curItem(); const srcLabel = { app: 'アプリで設定', index: 'PC の索引（EXIF/動画の作成日時）', exif: '写真の EXIF', modified: '更新日時（推定）', created: 'アップロード日時（推定）' }[it.src] || it.src;
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
function updateViewerChrome() { const it = curItem(); $('#vDate').textContent = isNaN(it.t) ? '日付不明' : fmtDate(it.t) + (it.estimated ? '（推定）' : ''); $('#vName').textContent = it.name + (it.dur ? `　${fmtDur(it.dur)}` : '') + `　${fmtBytes(it.size)}`; $('#vStar').innerHTML = `<i>${it.starred ? '&#9733;' : '&#9734;'}</i>お気に入り`; }
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
    const big = await getThumbUrl(it, 2048); if (v.token !== token) return; v.bigUrl = big; img.src = big;
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
  try { await drive.setCaptured(it.id, iso); const r = state.raw.find((x) => x.id === it.id); if (r) { r.modifiedTime = iso; r.appProperties = Object.assign({}, r.appProperties, { captured: iso }); } it.app = Object.assign({}, it.app, { captured: iso }); it.modified = iso; resolveDate(it); sortItems(); syncRawFlags(); render(false); if (state.view) { state.view.list = visibleItems(); state.view.idx = Math.max(0, state.view.list.findIndex((x) => x.id === it.id)); updateViewerChrome(); } toast('撮影日時を直しました'); }
  catch (e) { toast('失敗: ' + esc(e.message), 5000); }
}

// ---------- アップロード（iPhone → Drive） ----------
$('#uploadBtn').onclick = () => $('#filePicker').click();
$('#filePicker').addEventListener('change', async (e) => { const files = Array.from(e.target.files || []); e.target.value = ''; if (files.length) await uploadFiles(files); });
const upCtl = { cancelled: false, xhr: null };
$('#upCancel').onclick = () => { upCtl.cancelled = true; if (upCtl.xhr) try { upCtl.xhr.abort(); } catch {} };
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
  if (state.loading) { toast('読み込みが終わってからアップロードしてください'); return; }
  const existing = new Set(state.items.map((i) => i.name.toLowerCase() + '|' + i.size));
  const todo = files.filter((f) => !existing.has(f.name.toLowerCase() + '|' + f.size)); const skipped = files.length - todo.length;
  if (!todo.length) { toast(`すべて保管済みでした（${skipped} 件をスキップ）`); return; }
  const total = todo.reduce((s, f) => s + f.size, 0); let doneBytes = 0, ok = 0; const errors = [];
  upCtl.cancelled = false; $('#upbar').classList.remove('hidden');
  for (let i = 0; i < todo.length; i++) {
    const f = todo[i]; if (upCtl.cancelled) break;
    $('#upText').textContent = `アップロード中 ${i + 1}/${todo.length}：${f.name}（${fmtBytes(f.size)}）`;
    try {
      let t = await readExifDate(f); if (isNaN(t)) t = f.lastModified || Date.now(); const d = new Date(t);
      const yFolder = await drive.ensureFolder(String(d.getFullYear()), state.vaultId); const mFolder = await drive.ensureFolder(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}`, yFolder);
      const meta = { name: f.name, parents: [mFolder], modifiedTime: d.toISOString(), appProperties: { captured: d.toISOString(), src: 'iphone-app' } };
      const res = await drive.upload(f, meta, (b) => { $('#upProg').style.width = ((doneBytes + b) / total * 100).toFixed(1) + '%'; }, upCtl);
      doneBytes += f.size; ok++; if (res) { state.raw.push(res); const it = toItem(res); state.items.push(it); }
    } catch (e) { if (e.message === 'cancelled') break; errors.push(`${f.name}: ${e.message}`); console.error(e); }
  }
  $('#upbar').classList.add('hidden'); $('#upProg').style.width = '0';
  sortItems(); syncRawFlags(); render(false);
  if (state.quota && ok) { try { await drive.init(); updateQuota(); } catch {} }
  toast(`${ok} 件をアップロードしました${skipped ? `（${skipped} 件は保管済み）` : ''}${errors.length ? `／失敗 ${errors.length} 件` : ''}${upCtl.cancelled ? '（中止）' : ''}`, 5000);
  if (errors.length) alert('失敗したファイル:\n' + errors.slice(0, 10).join('\n'));
}

// ---------- 初回設定・ログイン画面 ----------
$('#saveSetup').onclick = () => {
  const id = $('#clientIdInput').value.trim(); const fn = $('#folderNameInput').value.trim() || CFG.vaultFolderName;
  if (!/\.apps\.googleusercontent\.com$/.test(id)) { alert('クライアント ID は「…….apps.googleusercontent.com」の形です。もう一度確認してください。'); return; }
  LS.set('vault_client_id', id); LS.set('vault_folder_name', fn); state.clientId = id; state.folderName = fn; applyFolderName(); show('login');
};
$('#loginBtn').onclick = () => { LS.del('vault_resume'); location.assign(authUrl()); };
$('#resetSetup').onclick = () => { LS.del('vault_client_id'); clearToken(); state.clientId = ''; $('#clientIdInput').value = ''; show('setup'); };
if (state.clientId) $('#clientIdInput').value = state.clientId; $('#folderNameInput').value = state.folderName;

// 画面復帰時にトークン切れなら静かに更新
document.addEventListener('visibilitychange', () => { if (!document.hidden && !DEMO && state.token && state.tokenExp < Date.now() + 60000) silentAuth(); });

boot();
})();
