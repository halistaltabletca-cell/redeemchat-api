/* RedeemChat — серверный API: счётчик пользователей + каталог публичных групп (+ стикерпаки позже).
   Лёгкий HTTP-сервис без зависимостей. Работает рядом с сигнальным сервером PeerJS.
   Запуск: node api.js [порт] [файл-данных]   (по умолчанию порт 9100) */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2]) || Number(process.env.RC_API_PORT) || Number(process.env.PORT) || 9100;
const DATA_FILE = process.argv[3] || process.env.RC_API_DATA || path.join(__dirname, 'rc-api-data.json');
const USER_TTL = 90 * 1000;        // пользователь «в сети», если был на связи за последние 90 с
const GROUP_TTL = 120 * 1000;      // публичная группа в каталоге, пока владелец обновляет её раз в ~минуту
const MAX_AVATAR = 70000;          // ограничение на аватарку группы (data-URI), чтобы каталог не раздувался
const MAX_COVER = 90000;           // обложка стикерпака
const MAX_STICKER = 160000;        // один стикер в паке (data-URI webp)
const MAX_PACK_STICKERS = 150;     // максимум стикеров в паке
const MAX_PACKS_PER_OWNER = 60;    // сколько паков может опубликовать один пользователь
const PACKS_DIR = process.env.RC_PACKS_DIR || path.join(path.dirname(DATA_FILE), 'rc-packs');
const CONFIGS_DIR = process.env.RC_CONFIGS_DIR || path.join(path.dirname(DATA_FILE), 'rc-configs');
try { fs.mkdirSync(PACKS_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(CONFIGS_DIR, { recursive: true }); } catch {}
const MAX_CONFIG_BG = 650000;      // фон конфигурации (data-URI картинки)
const MAX_CONFIGS_PER_OWNER = 60;
const ADMIN_ID = 'EXWQ-34D7-VMGT'; // только этот ID может публиковать обновление
const ID_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const GID_RE = /^[a-z0-9]{6,40}$/;

// Всё «вечное» (список когда-либо виденных пользователей) храним на диске; онлайн и группы — в памяти.
let store = { users: {}, packs: {}, configs: {}, update: null };   // users: id->ts; packs/configs: метаданные; update: {url,ts}
try { store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch {}
if (!store.users) store.users = {}; if (!store.packs) store.packs = {}; if (!store.configs) store.configs = {};
let dirty = false;
function markUser(id) { if (!store.users[id]) dirty = true; store.users[id] = Date.now(); }
setInterval(() => { if (!dirty) return; dirty = false; try { fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(store)); fs.renameSync(DATA_FILE + '.tmp', DATA_FILE); } catch (e) { console.warn('save', e.message); } }, 10000);

const online = new Map();          // userId -> lastPingTs
const groups = new Map();          // gid -> {gid,name,avatar,ownerId,members,kind,token,ts}
function onlineCount() { const now = Date.now(); let n = 0; for (const [, t] of online) if (now - t < USER_TTL) n++; return n; }
function totalUsers() { return Object.keys(store.users).length; }
setInterval(() => {
  const now = Date.now();
  for (const [id, t] of online) if (now - t > USER_TTL) online.delete(id);
  for (const [gid, g] of groups) if (now - g.ts > GROUP_TTL) groups.delete(gid);
}, 15000);

const str = (v, max) => (typeof v === 'string' ? v : '').slice(0, max || 200);
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise(resolve => {
    let b = ''; let over = false;
    req.on('data', c => { b += c; if (b.length > 900000) { over = true; req.destroy(); } });
    req.on('end', () => { if (over) return resolve(null); try { resolve(JSON.parse(b || '{}')); } catch { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}

function packFile(id) { return path.join(PACKS_DIR, id + '.json'); }
function loadStickers(id) { try { return JSON.parse(fs.readFileSync(packFile(id), 'utf8')).stickers || []; } catch { return []; } }
function saveStickers(id, arr) { try { fs.writeFileSync(packFile(id) + '.tmp', JSON.stringify({ stickers: arr })); fs.renameSync(packFile(id) + '.tmp', packFile(id)); return true; } catch (e) { console.warn('pack save', e.message); return false; } }
function dataUri(v, max) { v = str(v, max); return /^data:image\/(webp|png|jpeg|gif);base64,/.test(v) ? v : ''; }
function ownsPack(p, ownerId, token) { return p && p.ownerId === ownerId && (!p.token || p.token === token); }
// три режима сортировки каталогов: по популярности / по новизне / самые первые
function sortList(arr, sort, popKey) {
  const s = sort === 'new' ? 'new' : sort === 'old' ? 'old' : 'pop';
  return arr.sort((a, b) =>
    s === 'new' ? ((b.first || b.ts || 0) - (a.first || a.ts || 0)) :
    s === 'old' ? ((a.first || a.ts || 0) - (b.first || b.ts || 0)) :
    (((b[popKey] || 0) - (a[popKey] || 0)) || ((b.first || 0) - (a.first || 0))));
}
function cfgFile(id) { return path.join(CONFIGS_DIR, id + '.json'); }
function loadConfig(id) { try { return JSON.parse(fs.readFileSync(cfgFile(id), 'utf8')); } catch { return null; } }
function saveConfig(id, obj) { try { fs.writeFileSync(cfgFile(id) + '.tmp', JSON.stringify(obj)); fs.renameSync(cfgFile(id) + '.tmp', cfgFile(id)); return true; } catch (e) { console.warn('cfg save', e.message); return false; } }
const hex = v => /^#[0-9a-fA-F]{3,8}$/.test(String(v || '')) ? String(v) : '';

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname.replace(/\/+$/, '') || '/';
  if (req.method === 'OPTIONS') return send(res, 204, {});

  // Сердцебиение присутствия: клиент шлёт сюда свой id раз в ~минуту
  if (p === '/presence' && req.method === 'POST') {
    const body = await readBody(req); if (!body) return send(res, 400, { error: 'bad' });
    const id = str(body.id, 14);
    if (ID_RE.test(id)) { online.set(id, Date.now()); markUser(id); }
    return send(res, 200, { online: onlineCount(), total: totalUsers() });
  }
  if (p === '/stats' && req.method === 'GET') return send(res, 200, { online: onlineCount(), total: totalUsers(), groups: groups.size });

  // Публикация публичной группы в каталог (владелец обновляет регулярно). Дружеские группы сюда НЕ шлются.
  if (p === '/group' && req.method === 'POST') {
    const body = await readBody(req); if (!body) return send(res, 400, { error: 'bad' });
    const gid = str(body.gid, 40), ownerId = str(body.ownerId, 14);
    if (!GID_RE.test(gid) || !ID_RE.test(ownerId)) return send(res, 400, { error: 'bad id' });
    const avatar = str(body.avatar, MAX_AVATAR);
    const prevG = groups.get(gid);
    groups.set(gid, {
      gid, ownerId, token: str(body.token, 40),
      name: str(body.name, 60) || 'Группа',
      avatar: /^data:image\//.test(avatar) ? avatar : '',
      members: Math.max(1, Math.min(10000000, Number(body.members) | 0)),
      kind: body.kind === 'community' ? 'community' : 'friends',
      first: (prevG && prevG.first) || Date.now(),
      ts: Date.now()
    });
    if (ID_RE.test(ownerId)) { online.set(ownerId, Date.now()); markUser(ownerId); }
    return send(res, 200, { ok: true });
  }
  if (p === '/group/remove' && req.method === 'POST') {
    const body = await readBody(req); if (!body) return send(res, 400, { error: 'bad' });
    const g = groups.get(str(body.gid, 40));
    if (g && g.ownerId === str(body.ownerId, 14)) groups.delete(g.gid);
    return send(res, 200, { ok: true });
  }
  // Каталог популярных публичных групп (по числу участников). Поиск по названию через ?q=
  if (p === '/groups' && req.method === 'GET') {
    const q = (u.searchParams.get('q') || '').trim().toLowerCase();
    const sort = u.searchParams.get('sort') || 'pop';
    const limit = Math.max(1, Math.min(100, Number(u.searchParams.get('limit')) || 60));
    const now = Date.now();
    const list = sortList([...groups.values()].filter(g => now - g.ts < GROUP_TTL && (!q || g.name.toLowerCase().includes(q))), sort, 'members')
      .slice(0, limit)
      .map(g => ({ gid: g.gid, name: g.name, avatar: g.avatar, members: g.members, kind: g.kind, ownerId: g.ownerId, token: g.token, online: online.has(g.ownerId) && now - online.get(g.ownerId) < USER_TTL }));
    return send(res, 200, { groups: list });
  }

  // ----- Стикерпаки -----
  // создать/обновить метаданные пака (владелец шлёт при создании и переименовании)
  if (p === '/pack' && req.method === 'POST') {
    const body = await readBody(req); if (!body) return send(res, 400, { error: 'bad' });
    const id = str(body.id, 40), ownerId = str(body.ownerId, 14), token = str(body.token, 40);
    if (!GID_RE.test(id) || !ID_RE.test(ownerId)) return send(res, 400, { error: 'bad id' });
    const exist = store.packs[id];
    if (exist && !ownsPack(exist, ownerId, token)) return send(res, 403, { error: 'not owner' });
    if (!exist) {
      const mine = Object.values(store.packs).filter(p2 => p2.ownerId === ownerId).length;
      if (mine >= MAX_PACKS_PER_OWNER) return send(res, 429, { error: 'too many packs' });
    }
    store.packs[id] = Object.assign({ id, ownerId, token, count: 0, downloads: 0, pub: false, first: Date.now(), ts: Date.now() }, exist || {}, {
      name: str(body.name, 60) || (exist && exist.name) || 'Стикерпак',
      cover: dataUri(body.cover, MAX_COVER) || (exist && exist.cover) || '',
      ts: Date.now()
    });
    if (!exist) saveStickers(id, []);
    dirty = true; markUser(ownerId);
    return send(res, 200, { ok: true, id });
  }
  // добавить один стикер в пак
  if (p === '/pack/sticker' && req.method === 'POST') {
    const body = await readBody(req); if (!body) return send(res, 400, { error: 'bad' });
    const id = str(body.id, 40), ownerId = str(body.ownerId, 14), token = str(body.token, 40);
    const pk = store.packs[id];
    if (!pk) return send(res, 404, { error: 'no pack' });
    if (!ownsPack(pk, ownerId, token)) return send(res, 403, { error: 'not owner' });
    const img = dataUri(body.sticker, MAX_STICKER);
    if (!img) return send(res, 400, { error: 'bad sticker' });
    const arr = loadStickers(id);
    if (arr.length >= MAX_PACK_STICKERS) return send(res, 429, { error: 'pack full' });
    arr.push(img); saveStickers(id, arr);
    pk.count = arr.length; pk.ts = Date.now(); dirty = true;
    return send(res, 200, { ok: true, count: pk.count });
  }
  // опубликовать / снять с публикации
  if (p === '/pack/publish' && req.method === 'POST') {
    const body = await readBody(req); if (!body) return send(res, 400, { error: 'bad' });
    const pk = store.packs[str(body.id, 40)];
    if (!pk) return send(res, 404, { error: 'no pack' });
    if (!ownsPack(pk, str(body.ownerId, 14), str(body.token, 40))) return send(res, 403, { error: 'not owner' });
    pk.pub = body.pub !== false && pk.count > 0; pk.ts = Date.now(); dirty = true;
    return send(res, 200, { ok: true, pub: pk.pub });
  }
  // удалить пак
  if (p === '/pack/remove' && req.method === 'POST') {
    const body = await readBody(req); if (!body) return send(res, 400, { error: 'bad' });
    const id = str(body.id, 40), pk = store.packs[id];
    if (pk && ownsPack(pk, str(body.ownerId, 14), str(body.token, 40))) { delete store.packs[id]; dirty = true; try { fs.unlinkSync(packFile(id)); } catch {} }
    return send(res, 200, { ok: true });
  }
  // каталог опубликованных паков — по числу скачиваний
  if (p === '/packs' && req.method === 'GET') {
    const q = (u.searchParams.get('q') || '').trim().toLowerCase();
    const sort = u.searchParams.get('sort') || 'pop';
    const limit = Math.max(1, Math.min(100, Number(u.searchParams.get('limit')) || 60));
    const list = sortList(Object.values(store.packs).filter(pk => pk.pub && pk.count > 0 && (!q || pk.name.toLowerCase().includes(q))), sort, 'downloads')
      .slice(0, limit)
      .map(pk => ({ id: pk.id, name: pk.name, cover: pk.cover, count: pk.count, downloads: pk.downloads, ownerId: pk.ownerId }));
    return send(res, 200, { packs: list });
  }
  // полный пак (для установки/просмотра)
  if (p === '/pack' && req.method === 'GET') {
    const pk = store.packs[str(u.searchParams.get('id'), 40)];
    if (!pk) return send(res, 404, { error: 'no pack' });
    return send(res, 200, { id: pk.id, name: pk.name, ownerId: pk.ownerId, count: pk.count, downloads: pk.downloads, stickers: loadStickers(pk.id) });
  }
  // отметить установку (счётчик скачиваний)
  if (p === '/pack/install' && req.method === 'POST') {
    const body = await readBody(req); if (!body) return send(res, 400, { error: 'bad' });
    const pk = store.packs[str(body.id, 40)];
    if (!pk) return send(res, 404, { error: 'no pack' });
    pk.downloads = (pk.downloads | 0) + 1; dirty = true;
    return send(res, 200, { ok: true, downloads: pk.downloads });
  }

  // ----- Конфигурации тем -----
  if (p === '/config' && req.method === 'POST') {
    const body = await readBody(req); if (!body) return send(res, 400, { error: 'bad' });
    const id = str(body.id, 40), ownerId = str(body.ownerId, 14), token = str(body.token, 40);
    if (!GID_RE.test(id) || !ID_RE.test(ownerId)) return send(res, 400, { error: 'bad id' });
    const exist = store.configs[id];
    if (exist && !ownsPack(exist, ownerId, token)) return send(res, 403, { error: 'not owner' });
    if (!exist) {
      const mine = Object.values(store.configs).filter(c => c.ownerId === ownerId).length;
      if (mine >= MAX_CONFIGS_PER_OWNER) return send(res, 429, { error: 'too many' });
    }
    const bg = dataUri(body.bg, MAX_CONFIG_BG);
    const payload = { bg, bgColor: hex(body.bgColor), font: str(body.font, 60), btnColor: hex(body.btnColor), textColor: hex(body.textColor) };
    saveConfig(id, payload);
    store.configs[id] = Object.assign({ id, ownerId, token, downloads: 0, pub: false, first: Date.now() }, exist || {}, {
      name: str(body.name, 60) || (exist && exist.name) || 'Конфигурация',
      font: payload.font, btnColor: payload.btnColor, hasBg: !!(bg || payload.bgColor),
      pub: body.pub === true, ts: Date.now()
    });
    dirty = true; markUser(ownerId);
    return send(res, 200, { ok: true, id, pub: store.configs[id].pub });
  }
  if (p === '/config/remove' && req.method === 'POST') {
    const body = await readBody(req); if (!body) return send(res, 400, { error: 'bad' });
    const id = str(body.id, 40), c = store.configs[id];
    if (c && ownsPack(c, str(body.ownerId, 14), str(body.token, 40))) { delete store.configs[id]; dirty = true; try { fs.unlinkSync(cfgFile(id)); } catch {} }
    return send(res, 200, { ok: true });
  }
  if (p === '/configs' && req.method === 'GET') {
    const q = (u.searchParams.get('q') || '').trim().toLowerCase();
    const sort = u.searchParams.get('sort') || 'pop';
    const limit = Math.max(1, Math.min(100, Number(u.searchParams.get('limit')) || 60));
    const list = sortList(Object.values(store.configs).filter(c => c.pub && (!q || c.name.toLowerCase().includes(q))), sort, 'downloads')
      .slice(0, limit)
      .map(c => ({ id: c.id, name: c.name, font: c.font, btnColor: c.btnColor, hasBg: c.hasBg, downloads: c.downloads, ownerId: c.ownerId }));
    return send(res, 200, { configs: list });
  }
  if (p === '/config' && req.method === 'GET') {
    const c = store.configs[str(u.searchParams.get('id'), 40)];
    if (!c) return send(res, 404, { error: 'no config' });
    const payload = loadConfig(c.id) || {};
    return send(res, 200, { id: c.id, name: c.name, ownerId: c.ownerId, downloads: c.downloads, config: payload });
  }
  if (p === '/config/install' && req.method === 'POST') {
    const body = await readBody(req); if (!body) return send(res, 400, { error: 'bad' });
    const c = store.configs[str(body.id, 40)];
    if (!c) return send(res, 404, { error: 'no config' });
    c.downloads = (c.downloads | 0) + 1; dirty = true;
    return send(res, 200, { ok: true, downloads: c.downloads });
  }

  // ----- Проверка обновления ----- (публикует только админ командой update "URL")
  if (p === '/update' && req.method === 'GET') {
    return send(res, 200, store.update && store.update.url ? { url: store.update.url, ts: store.update.ts } : {});
  }
  if (p === '/update' && req.method === 'POST') {
    const body = await readBody(req); if (!body) return send(res, 400, { error: 'bad' });
    if (str(body.ownerId, 14) !== ADMIN_ID) return send(res, 403, { error: 'not admin' });
    const url = str(body.url, 500);
    if (body.clear || !url) { store.update = null; dirty = true; return send(res, 200, { ok: true, cleared: true }); }
    if (!/^https?:\/\//i.test(url)) return send(res, 400, { error: 'bad url' });
    store.update = { url, ts: Date.now() }; dirty = true;
    return send(res, 200, { ok: true, url });
  }

  if (p === '/' || p === '/health') return send(res, 200, { ok: true, service: 'redeemchat-api' });
  return send(res, 404, { error: 'not found' });
});
server.listen(PORT, () => console.log(`RedeemChat API на порту ${PORT} (данные: ${DATA_FILE})`));
