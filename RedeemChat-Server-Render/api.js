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
if (!store.portal) store.portal = { pin: null, pcUrl: '', androidUrl: '', pcFile: null, androidFile: null, requests: {} };
if (!('pcFile' in store.portal)) store.portal.pcFile = null;
if (!('androidFile' in store.portal)) store.portal.androidFile = null;
const PORTAL_DIR = process.env.RC_PORTAL_DIR || path.join(path.dirname(DATA_FILE), 'rc-portal');
try { fs.mkdirSync(PORTAL_DIR, { recursive: true }); } catch {}
const MAX_UPLOAD = 220 * 1024 * 1024;
const ENV_PIN = process.env.ADMIN_PIN || '';
function portalPinSet() { return !!(ENV_PIN || store.portal.pin); }
function portalPin() { return ENV_PIN || store.portal.pin || ''; }
function portalAdmin(body) { return str(body.id, 14).toUpperCase() === ADMIN_ID && portalPinSet() && str(body.pin, 40) === portalPin(); }
function portalAdminHdr(req) { return str(req.headers['x-admin-id'], 14).toUpperCase() === ADMIN_ID && portalPinSet() && str(req.headers['x-admin-pin'], 40) === portalPin(); }
function effDl(target) {
  const fl = store.portal[target + 'File'];
  if (fl && fl.path) { try { if (fs.existsSync(fl.path)) return '/portal/dl/' + target; } catch {} }
  return target === 'pc' ? store.portal.pcUrl : store.portal.androidUrl;
}
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

const PORTAL_HTML = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RedeemChat</title>
<style>
 :root{--bg:#0a0d13;--card:#121823;--line:rgba(255,255,255,.1);--fg:#e9eef6;--muted:#9aa7bd;--accent:#22d3aa;--accent-ink:#042b23;--bad:#ff6b6b}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--fg);font-family:"Segoe UI",system-ui,Arial,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
 .wrap{width:100%;max-width:440px}
 .brand{display:flex;align-items:center;gap:12px;justify-content:center;margin-bottom:22px}
 .mark{width:46px;height:46px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:1.5rem;color:var(--accent-ink);background:linear-gradient(145deg,var(--accent),#12b6d4)}
 .brand b{font-size:1.5rem;letter-spacing:-.02em}
 .card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:26px}
 h1{font-size:1.25rem;margin:0 0 6px;text-wrap:balance}
 h2.mini-h{font-size:1rem;margin:0 0 8px}
 p.sub{color:var(--muted);margin:0 0 18px;font-size:.95rem}
 label{display:block;font-size:.85rem;color:var(--muted);margin-bottom:6px}
 input{width:100%;padding:12px 14px;border-radius:11px;border:1px solid var(--line);background:#0e131c;color:var(--fg);font-size:1rem;font-family:inherit;letter-spacing:.04em}
 input:focus{outline:none;border-color:var(--accent)}
 input[type=file]{padding:9px 0;font-size:.85rem;color:var(--muted);letter-spacing:0}
 .chk{display:flex;align-items:center;gap:8px;margin-top:12px;font-size:.9rem;color:var(--muted);cursor:pointer}
 .chk input{width:auto;padding:0}
 .btn{display:block;width:100%;margin-top:14px;padding:13px;border:none;border-radius:11px;font-size:1rem;font-weight:700;cursor:pointer;font-family:inherit;background:linear-gradient(140deg,var(--accent),#14b7d2);color:var(--accent-ink)}
 .btn.ghost{background:#0e131c;color:var(--fg);border:1px solid var(--line)}
 .btn.dl{text-decoration:none;text-align:center}
 .btn.dis{opacity:.45;pointer-events:none}
 .msg{margin-top:12px;font-size:.9rem;min-height:18px}
 .msg.bad{color:var(--bad)} .msg.ok{color:var(--accent)}
 .spin{width:34px;height:34px;border:3px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:spin 1s linear infinite;margin:10px auto}
 @keyframes spin{to{transform:rotate(360deg)}}
 .center{text-align:center}
 .noapp{text-align:center;margin-top:16px}
 .noapp a{color:var(--accent);text-decoration:none;font-size:.92rem;border-bottom:1px dashed var(--accent);cursor:pointer}
 .dlbox{margin-top:6px}
 .dlset{border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:12px}
 .cur{font-size:.82rem;color:var(--muted);margin-bottom:8px}
 .cur span{color:var(--fg)}
 .prog{font-size:.82rem;color:var(--accent);min-height:16px;margin-top:4px}
 .req{display:flex;align-items:center;gap:8px;padding:10px 12px;border:1px solid var(--line);border-radius:11px;margin-bottom:8px}
 .req b{font-family:monospace;letter-spacing:.06em;font-size:.95rem}
 .req .st{margin-left:auto;font-size:.78rem;color:var(--muted)}
 .mini{padding:7px 11px;border-radius:9px;font-size:.82rem;font-weight:700;border:none;cursor:pointer;font-family:inherit}
 .mini.ok{background:var(--accent);color:var(--accent-ink)} .mini.no{background:#0e131c;color:var(--fg);border:1px solid var(--line)}
 .hint{color:var(--muted);font-size:.8rem;margin-top:10px}
 .hidden{display:none}
 .foot{text-align:center;color:var(--muted);font-size:.78rem;margin-top:18px}
</style>
</head>
<body>
<div class="wrap">
 <div class="brand"><span class="mark">R</span><b>RedeemChat</b></div>
 <div class="card">
  <div id="login">
   <h1>Вход по номеру аккаунта</h1>
   <p class="sub">Введи свой ID из RedeemChat (вид XXXX-XXXX-XXXX). Заявка уйдёт администратору - дождись одобрения.</p>
   <label>Номер аккаунта</label>
   <input id="accId" maxlength="14" placeholder="XXXX-XXXX-XXXX" autocomplete="off" spellcheck="false">
   <label class="chk"><input type="checkbox" id="rememberChk"> Сохранить выбор профиля</label>
   <button class="btn" id="loginBtn">Отправить заявку на вход</button>
   <div class="msg" id="loginMsg"></div>
   <div class="noapp"><a id="noAppLink">Нету приложения?</a></div>
   <div id="publicDl" class="hidden dlbox">
    <p class="sub" style="margin:14px 0 10px">Свежие версии RedeemChat:</p>
    <a class="btn dl" id="dlPcPub" href="#" download>Скачать на ПК</a>
    <a class="btn dl" id="dlAndroidPub" href="#" download style="margin-top:10px">Скачать на Android</a>
    <div class="hint" id="pubNote"></div>
   </div>
  </div>
  <div id="pending" class="hidden center">
   <div class="spin"></div>
   <h1>Заявка отправлена</h1>
   <p class="sub">Ждём, пока администратор одобрит вход. Окно обновится само.</p>
   <button class="btn ghost" id="pendBack">Назад</button>
  </div>
  <div id="approved" class="hidden center">
   <h1>Добро пожаловать!</h1>
   <p class="sub">Твой вход одобрен. Скачай RedeemChat:</p>
   <a class="btn dl" id="dlPc" href="#" download>Скачать на ПК</a>
   <a class="btn dl" id="dlAndroid" href="#" download style="margin-top:10px">Скачать на Android</a>
   <div class="hint" id="dlNote"></div>
  </div>
  <div id="adminPin" class="hidden">
   <h1 id="pinTitle">Вход администратора</h1>
   <p class="sub" id="pinSub">Введи PIN-код администратора.</p>
   <label>PIN-код</label>
   <input id="pinInput" type="password" maxlength="40" placeholder="PIN" autocomplete="off">
   <button class="btn" id="pinBtn">Войти</button>
   <button class="btn ghost" id="pinBack">Назад</button>
   <div class="msg" id="pinMsg"></div>
  </div>
  <div id="admin" class="hidden">
   <h1>Панель администратора</h1>
   <p class="sub">Загрузи файлы (тогда кнопки будут их скачивать) или вставь ссылки.</p>
   <div class="dlset">
    <h2 class="mini-h">Кнопка «Скачать на ПК»</h2>
    <div class="cur">Сейчас: <span id="pcCur">не задано</span></div>
    <input type="file" id="pcFileInput">
    <button class="btn" id="pcUploadBtn">Загрузить файл для ПК</button>
    <div class="prog" id="pcProg"></div>
    <label style="margin-top:10px">или ссылка</label>
    <input id="pcUrl" placeholder="https://..." autocomplete="off" spellcheck="false">
   </div>
   <div class="dlset">
    <h2 class="mini-h">Кнопка «Скачать на Android»</h2>
    <div class="cur">Сейчас: <span id="androidCur">не задано</span></div>
    <input type="file" id="androidFileInput">
    <button class="btn" id="androidUploadBtn">Загрузить файл для Android</button>
    <div class="prog" id="androidProg"></div>
    <label style="margin-top:10px">или ссылка</label>
    <input id="androidUrl" placeholder="https://..." autocomplete="off" spellcheck="false">
   </div>
   <button class="btn" id="saveLinks">Сохранить ссылки</button>
   <div class="msg" id="adminMsg"></div>
   <h2 class="mini-h" style="margin-top:20px">Заявки на вход</h2>
   <div id="reqList"></div>
   <button class="btn ghost" id="adminRefresh">Обновить список</button>
  </div>
 </div>
 <div class="foot">RedeemChat - P2P-мессенджер</div>
</div>
<script>
(function(){
 var pin='';
 var ADMIN='EXWQ-34D7-VMGT';
 function $(i){return document.getElementById(i)}
 function show(id){['login','pending','approved','adminPin','admin'].forEach(function(s){$(s).classList.toggle('hidden', s!==id)})}
 function api(path, body){
  return fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})}).then(function(r){return r.json().then(function(j){return {code:r.status,j:j}})}).catch(function(){return {code:0,j:{}}})
 }
 function norm(v){ var c=(v||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,12); var out=c.slice(0,4); if(c.length>4)out+='-'+c.slice(4,8); if(c.length>8)out+='-'+c.slice(8,12); return out; }
 $('accId').addEventListener('input',function(){this.value=norm(this.value)});
 try{ var sv=localStorage.getItem('rc_portal_acc'); if(sv){ $('accId').value=sv; $('rememberChk').checked=true; } }catch(e){}
 function saveRemember(){ try{ if($('rememberChk').checked) localStorage.setItem('rc_portal_acc',$('accId').value); else localStorage.removeItem('rc_portal_acc'); }catch(e){} }
 $('rememberChk').addEventListener('change', saveRemember);
 function getDownloads(cb){ fetch('/portal/downloads').then(function(r){return r.json()}).then(cb).catch(function(){cb({})}) }
 function setDl(pcBtn, anBtn, note, d){
  if(d.pc){pcBtn.href=d.pc;pcBtn.classList.remove('dis')}else{pcBtn.href='#';pcBtn.classList.add('dis')}
  if(d.android){anBtn.href=d.android;anBtn.classList.remove('dis')}else{anBtn.href='#';anBtn.classList.add('dis')}
  if(note) note.textContent=(!d.pc&&!d.android)?'Файлы ещё не добавлены администратором.':'';
 }
 $('noAppLink').addEventListener('click',function(e){ e.preventDefault(); var box=$('publicDl'); if(box.classList.contains('hidden')){ getDownloads(function(d){ setDl($('dlPcPub'),$('dlAndroidPub'),$('pubNote'),d) }); box.classList.remove('hidden'); } else box.classList.add('hidden'); });
 var pollTimer=null;
 function startPoll(id){ stopPoll(); pollTimer=setInterval(function(){ api('/portal/status',{id:id}).then(function(r){ if(r.j.status==='approved'){ stopPoll(); showApproved() } }) },4000) }
 function stopPoll(){ if(pollTimer){clearInterval(pollTimer);pollTimer=null} }
 function showApproved(){ getDownloads(function(d){ setDl($('dlPc'),$('dlAndroid'),$('dlNote'),d) }); show('approved') }
 $('loginBtn').onclick=function(){
  var id=norm($('accId').value); var m=$('loginMsg'); m.className='msg';
  if(!/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(id)){m.className='msg bad';m.textContent='Введи номер вида XXXX-XXXX-XXXX';return}
  saveRemember();
  m.textContent='Отправляем...';
  api('/portal/login',{id:id}).then(function(r){
   if(r.j.admin){ $('pinTitle').textContent=r.j.pinSet?'Вход администратора':'Создать PIN администратора'; $('pinSub').textContent=r.j.pinSet?'Введи PIN-код администратора.':'Задай PIN-код (минимум 4 символа). Запомни его - он защищает панель.'; $('pinBtn').textContent=r.j.pinSet?'Войти':'Создать PIN'; window._pinSet=r.j.pinSet; m.textContent=''; $('pinInput').value=''; show('adminPin'); return }
   if(r.j.status==='approved'){ m.textContent=''; showApproved(); return }
   if(r.j.status==='pending'){ m.textContent=''; show('pending'); startPoll(id); return }
   m.className='msg bad'; m.textContent='Не получилось. Попробуй ещё раз.';
  })
 };
 $('pendBack').onclick=function(){stopPoll();show('login')};
 $('pinBack').onclick=function(){show('login')};
 $('pinBtn').onclick=function(){
  var p=$('pinInput').value; var m=$('pinMsg'); m.className='msg';
  if(p.length<4){m.className='msg bad';m.textContent='PIN слишком короткий';return}
  if(!window._pinSet){ api('/portal/admin/setpin',{id:ADMIN,pin:p}).then(function(r){ if(r.j.ok){pin=p;loadAdmin(m)}else{m.className='msg bad';m.textContent='Не удалось задать PIN (возможно, уже задан).'} }) }
  else { pin=p; loadAdmin(m) }
 };
 function curText(name,url){ if(name) return 'файл: '+name; if(url) return 'ссылка'; return 'не задано'; }
 function loadAdmin(m){
  api('/portal/admin/data',{id:ADMIN,pin:pin}).then(function(r){
   if(!r.j.ok){ if(m){m.className='msg bad';m.textContent='Неверный PIN'} return }
   $('pcUrl').value=r.j.pcUrl||''; $('androidUrl').value=r.j.androidUrl||'';
   $('pcCur').textContent=curText(r.j.pcFile,r.j.pcUrl); $('androidCur').textContent=curText(r.j.androidFile,r.j.androidUrl);
   renderReqs(r.j.requests||[]); show('admin')
  })
 }
 function renderReqs(list){
  var box=$('reqList'); if(!list.length){box.innerHTML='<p class="sub">Заявок пока нет.</p>';return}
  box.innerHTML='';
  list.forEach(function(rq){
   var d=document.createElement('div'); d.className='req';
   var st=rq.status==='approved'?'одобрен':rq.status==='rejected'?'отклонён':'ожидает';
   var b=document.createElement('b'); b.textContent=rq.id;
   var sp=document.createElement('span'); sp.className='st'; sp.textContent=st;
   d.appendChild(b); d.appendChild(sp);
   var ok=document.createElement('button'); ok.className='mini ok'; ok.textContent=rq.status==='approved'?'OK':'Принять';
   ok.onclick=function(){ api('/portal/admin/approve',{id:ADMIN,pin:pin,target:rq.id}).then(function(){loadAdmin()}) };
   var no=document.createElement('button'); no.className='mini no'; no.textContent='X';
   no.onclick=function(){ api('/portal/admin/approve',{id:ADMIN,pin:pin,target:rq.id,reject:true,remove:true}).then(function(){loadAdmin()}) };
   d.appendChild(ok); d.appendChild(no); box.appendChild(d)
  })
 }
 $('adminRefresh').onclick=function(){loadAdmin()};
 $('saveLinks').onclick=function(){
  var m=$('adminMsg'); m.className='msg'; m.textContent='Сохраняем...';
  api('/portal/admin/links',{id:ADMIN,pin:pin,pcUrl:$('pcUrl').value.trim(),androidUrl:$('androidUrl').value.trim()}).then(function(r){
   if(r.j.ok){m.className='msg ok';m.textContent='Сохранено';loadAdmin()}else{m.className='msg bad';m.textContent='Ошибка (проверь PIN)'}
  })
 };
 function doUpload(target, fileInputId, progId){
  var inp=$(fileInputId); var fl=inp.files&&inp.files[0]; if(!fl){var pr0=$(progId);pr0.textContent='Сначала выбери файл';return}
  var pr=$(progId); pr.textContent='Загрузка 0%';
  var xhr=new XMLHttpRequest();
  xhr.open('POST','/portal/admin/upload?target='+target);
  xhr.setRequestHeader('x-admin-id',ADMIN);
  xhr.setRequestHeader('x-admin-pin',pin);
  xhr.setRequestHeader('x-filename',encodeURIComponent(fl.name));
  xhr.upload.onprogress=function(e){ if(e.lengthComputable){ pr.textContent='Загрузка '+Math.round(e.loaded/e.total*100)+'%'; } };
  xhr.onload=function(){ if(xhr.status===200){ pr.textContent='Файл загружен ✓'; inp.value=''; loadAdmin(); } else { pr.textContent='Ошибка загрузки ('+xhr.status+')'; } };
  xhr.onerror=function(){ pr.textContent='Ошибка сети при загрузке'; };
  xhr.send(fl);
 }
 $('pcUploadBtn').onclick=function(){ doUpload('pc','pcFileInput','pcProg') };
 $('androidUploadBtn').onclick=function(){ doUpload('android','androidFileInput','androidProg') };
})();
</script>
</body>
</html>`;
function sendHtml(res, html) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(html); }

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

  // ----- Портал загрузки (вход по номеру аккаунта, одобрение админом) -----
  if (p === '/portal/login' && req.method === 'POST') {
    const body = await readBody(req); if (!body) return send(res, 400, { error: 'bad' });
    const id = str(body.id, 14).toUpperCase();
    if (!ID_RE.test(id)) return send(res, 400, { error: 'bad id' });
    if (id === ADMIN_ID) return send(res, 200, { admin: true, pinSet: portalPinSet() });
    let r = store.portal.requests[id];
    if (!r) { r = store.portal.requests[id] = { id, status: 'pending', ts: Date.now() }; dirty = true; markUser(id); }
    if (r.status === 'approved') return send(res, 200, { status: 'approved', pc: store.portal.pcUrl, android: store.portal.androidUrl });
    return send(res, 200, { status: 'pending' });
  }
  if (p === '/portal/status' && req.method === 'POST') {
    const body = await readBody(req); if (!body) return send(res, 400, { error: 'bad' });
    const id = str(body.id, 14).toUpperCase();
    const r = store.portal.requests[id];
    if (r && r.status === 'approved') return send(res, 200, { status: 'approved', pc: store.portal.pcUrl, android: store.portal.androidUrl });
    return send(res, 200, { status: r ? r.status : 'none' });
  }
  if (p === '/portal/admin/setpin' && req.method === 'POST') {
    const body = await readBody(req); if (!body) return send(res, 400, { error: 'bad' });
    if (str(body.id, 14).toUpperCase() !== ADMIN_ID) return send(res, 403, { error: 'not admin' });
    if (ENV_PIN) return send(res, 400, { error: 'pin fixed' });
    if (store.portal.pin) return send(res, 400, { error: 'pin exists' });
    const pin = str(body.pin, 40);
    if (pin.length < 4) return send(res, 400, { error: 'short' });
    store.portal.pin = pin; dirty = true;
    return send(res, 200, { ok: true });
  }
  if (p === '/portal/admin/data' && req.method === 'POST') {
    const body = await readBody(req); if (!body) return send(res, 400, { error: 'bad' });
    if (!portalAdmin(body)) return send(res, 403, { error: 'auth' });
    const requests = Object.values(store.portal.requests).sort((a, b) => b.ts - a.ts);
    return send(res, 200, { ok: true, requests, pcUrl: store.portal.pcUrl, androidUrl: store.portal.androidUrl, pcFile: (store.portal.pcFile || {}).name || '', androidFile: (store.portal.androidFile || {}).name || '' });
  }
  if (p === '/portal/admin/approve' && req.method === 'POST') {
    const body = await readBody(req); if (!body) return send(res, 400, { error: 'bad' });
    if (!portalAdmin(body)) return send(res, 403, { error: 'auth' });
    const t = str(body.target, 14).toUpperCase(); const r = store.portal.requests[t];
    if (r) { if (body.remove) delete store.portal.requests[t]; else r.status = body.reject ? 'rejected' : 'approved'; dirty = true; }
    return send(res, 200, { ok: true });
  }
  if (p === '/portal/admin/links' && req.method === 'POST') {
    const body = await readBody(req); if (!body) return send(res, 400, { error: 'bad' });
    if (!portalAdmin(body)) return send(res, 403, { error: 'auth' });
    store.portal.pcUrl = /^https?:\/\//i.test(body.pcUrl || '') ? str(body.pcUrl, 500) : '';
    store.portal.androidUrl = /^https?:\/\//i.test(body.androidUrl || '') ? str(body.androidUrl, 500) : '';
    dirty = true;
    return send(res, 200, { ok: true, pcUrl: store.portal.pcUrl, androidUrl: store.portal.androidUrl });
  }
  // актуальные ссылки/файлы для кнопок (публично)
  if (p === '/portal/downloads' && req.method === 'GET') return send(res, 200, { pc: effDl('pc'), android: effDl('android'), pcName: (store.portal.pcFile || {}).name || '', androidName: (store.portal.androidFile || {}).name || '' });
  // загрузка файла админом (потоком на диск; авторизация в заголовках)
  if (p === '/portal/admin/upload' && req.method === 'POST') {
    if (!portalAdminHdr(req)) { res.writeHead(403, { 'Content-Type': 'application/json' }); return res.end('{"error":"auth"}'); }
    const target = u.searchParams.get('target') === 'android' ? 'android' : 'pc';
    let fname = 'file.bin';
    try { fname = decodeURIComponent(str(req.headers['x-filename'], 400)); } catch { fname = str(req.headers['x-filename'], 120); }
    fname = (fname || 'file.bin').replace(/[^\w.\- ]+/g, '_').slice(0, 120);
    const dest = path.join(PORTAL_DIR, target + '__' + Date.now() + '__' + fname);
    const ws = fs.createWriteStream(dest);
    let size = 0, aborted = false;
    req.on('data', c => { size += c.length; if (size > MAX_UPLOAD && !aborted) { aborted = true; try { ws.destroy(); } catch {} try { req.destroy(); } catch {} try { fs.unlinkSync(dest); } catch {} if (!res.headersSent) send(res, 413, { error: 'too big' }); } });
    req.pipe(ws);
    ws.on('finish', () => {
      if (aborted) return;
      const old = store.portal[target + 'File'];
      if (old && old.path && old.path !== dest) { try { fs.unlinkSync(old.path); } catch {} }
      store.portal[target + 'File'] = { name: fname, path: dest, size };
      store.portal[target === 'pc' ? 'pcUrl' : 'androidUrl'] = '';
      dirty = true;
      send(res, 200, { ok: true, name: fname, size });
    });
    ws.on('error', () => { if (!aborted && !res.headersSent) send(res, 500, { error: 'write' }); });
    req.on('error', () => { try { ws.destroy(); } catch {} });
    return;
  }
  // удалить загруженный файл
  if (p === '/portal/admin/delfile' && req.method === 'POST') {
    const body = await readBody(req); if (!body) return send(res, 400, { error: 'bad' });
    if (!portalAdmin(body)) return send(res, 403, { error: 'auth' });
    const target = body.target === 'android' ? 'android' : 'pc';
    const fl = store.portal[target + 'File'];
    if (fl && fl.path) { try { fs.unlinkSync(fl.path); } catch {} }
    store.portal[target + 'File'] = null; dirty = true;
    return send(res, 200, { ok: true });
  }
  // отдача файла (скачивание)
  if ((p === '/portal/dl/pc' || p === '/portal/dl/android') && req.method === 'GET') {
    const target = p === '/portal/dl/android' ? 'android' : 'pc';
    const fl = store.portal[target + 'File'];
    if (!fl || !fl.path) return send(res, 404, { error: 'no file' });
    let st; try { st = fs.statSync(fl.path); } catch { return send(res, 404, { error: 'gone' }); }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'Content-Disposition': 'attachment; filename="' + fl.name.replace(/["\r\n]/g, '') + '"', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    const rs = fs.createReadStream(fl.path); rs.on('error', () => { try { res.destroy(); } catch {} }); rs.pipe(res);
    return;
  }

  if (p === '/' && req.method === 'GET') return sendHtml(res, PORTAL_HTML);

  if (p === '/health') return send(res, 200, { ok: true, service: 'redeemchat-api' });
  return send(res, 404, { error: 'not found' });
});
server.listen(PORT, () => console.log(`RedeemChat API на порту ${PORT} (данные: ${DATA_FILE})`));
