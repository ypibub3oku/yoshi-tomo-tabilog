/* ヨシトモの二人旅ログ — version 2
 * データはローカル保存。Firebase設定・共有コードを入力すると2人でリアルタイム同期。
 * Google Maps短縮URLの展開には同梱のVercel APIが必要です。
 */
'use strict';

const PREFECTURES = [
  '北海道','青森県','岩手県','宮城県','秋田県','山形県','福島県','茨城県','栃木県',
  '群馬県','埼玉県','千葉県','東京都','神奈川県','新潟県','富山県','石川県','福井県',
  '山梨県','長野県','岐阜県','静岡県','愛知県','三重県','滋賀県','京都府','大阪府',
  '兵庫県','奈良県','和歌山県','鳥取県','島根県','岡山県','広島県','山口県','徳島県',
  '香川県','愛媛県','高知県','福岡県','佐賀県','長崎県','熊本県','大分県','宮崎県',
  '鹿児島県','沖縄県'
];
const INITIAL_SAMPLES = [
  {id:'1',name:'東京タワー',lat:35.658581,lng:139.745433,date:'2025-10-14',rating:5,comment:'夜景がとっても綺麗だった！',color:'#ec4899',radius:1,prefecture:'東京都'},
  {id:'2',name:'伏見稲荷大社',lat:34.96714,lng:135.772671,date:'2026-03-20',rating:5,comment:'千本鳥居を最後まで登りきった！',color:'#f97316',radius:2,prefecture:'京都府'}
];
const LOCAL_KEY = 'pair_map_places';
const CONFIG_KEY = 'pair_map_firebase_config';
const ROOM_KEY = 'pair_map_room_v2';
const roomCacheKey = room => `pair_map_room_cache_${room}`;
const roomPendingKey = room => `pair_map_room_pending_${room}`;
const roomMigrationKey = room => `pair_map_room_migrated_${room}`;
const roomRegex = /^[a-f0-9]{48}$/;
// Optional: Firebaseの「ウェブアプリの設定」をここに設定すると、2台目で設定の入力が不要です。
// 例: const EMBEDDED_FIREBASE_CONFIG = { apiKey:'...', authDomain:'...', projectId:'...', appId:'...' };
const EMBEDDED_FIREBASE_CONFIG = null;

let map;
let visitedPlaces = [];
let mapMarkers = [];
let mapCircles = [];
let currentRating = 5;
let editingPlaceId = null;
let selectedPrefManually = false;
let geoSerial = Promise.resolve();
let lastGeoRequest = 0;
let geoRunId = 0;
let firebaseApp = null;
let auth = null;
let db = null;
let activeRoom = '';
let unsubCloud = null;
let remotePlaces = new Map();
let pendingOps = new Map();
let pendingInflight = new Set();
let cloudReady = false;
let syncSession = 0;
let lastSyncError = '';

const el = id => document.getElementById(id);
const safeParse = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };
const escapeHtml = val => String(val ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const nowLocalDate = () => { const d = new Date(); const l = new Date(d.getTime() - d.getTimezoneOffset()*60000); return l.toISOString().slice(0,10); };
const createId = () => (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const validCoord = (lat,lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat)<=90 && Math.abs(lng)<=180;

function sanitizePlace(value) {
  if (!value || typeof value !== 'object') return null;
  const lat = Number(value.lat), lng = Number(value.lng);
  const name = String(value.name ?? '').trim().slice(0,150);
  if (!name || !validCoord(lat,lng)) return null;
  const id = String(value.id ?? '');
  return {
    id: /^[a-zA-Z0-9_-]{1,100}$/.test(id) ? id : createId(),
    name, lat, lng,
    date: /^\d{4}-\d{2}-\d{2}$/.test(value.date ?? '') ? value.date : '',
    rating: Math.max(1, Math.min(5, Math.round(Number(value.rating)||5))),
    comment: String(value.comment ?? '').slice(0,3000),
    color: /^#[0-9a-fA-F]{6}$/.test(value.color ?? '') ? value.color : '#ec4899',
    radius: Math.max(1, Math.min(5, Math.round(Number(value.radius)||1))),
    prefecture: PREFECTURES.includes(value.prefecture) ? value.prefecture : '',
    updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : 0
  };
}
function normalizePlaces(data) {
  if (!Array.isArray(data)) return [];
  const items = new Map();
  for (const entry of data) { const p = sanitizePlace(entry); if (p) items.set(p.id, p); }
  return [...items.values()];
}
function sortPlaces(items) { return [...items].sort((a,b) => (b.updatedAt||0)-(a.updatedAt||0) || (b.date||'').localeCompare(a.date||'')); }
function localPlaces() {
  const value = localStorage.getItem(LOCAL_KEY);
  return value === null ? INITIAL_SAMPLES.map(sanitizePlace) : normalizePlaces(safeParse(value, []));
}
function setSyncStatus(message, type='local') {
  const node = el('sync-status');
  if (node) node.textContent = message;
  const dot = el('sync-dot');
  if (dot) dot.className = 'inline-block w-2.5 h-2.5 rounded-full ' + (type==='ok'?'bg-emerald-500':type==='error'?'bg-red-500':type==='busy'?'bg-amber-400':'bg-slate-400');
  const desc = el('cloud-state'); if (desc) desc.textContent = message;
}
function notify(message) { const n=el('app-notice'); if (!n) return; n.textContent=message; n.classList.remove('hidden'); setTimeout(()=>{ if(n.textContent===message) n.classList.add('hidden'); },6500); }

window.addEventListener('load', async () => {
  populatePrefectureSelect();
  initMap();
  visitedPlaces = localPlaces();
  setupEventListeners();
  updateUI();
  const cfg = getFirebaseConfig();
  el('input-firebase-config').value = cfg ? JSON.stringify(cfg,null,2) : '';
  const hashRoom = new URLSearchParams(location.hash.replace(/^#/, '')).get('room');
  const savedRoom = localStorage.getItem(ROOM_KEY);
  const room = roomRegex.test(hashRoom||'') ? hashRoom : savedRoom;
  if (roomRegex.test(room||'')) {
    el('input-room-code').value = room;
    await connectRoom(room);
  } else if (hashRoom) {
    notify('共有コードの形式が正しくありません。');
  }
});
function populatePrefectureSelect() {
  el('input-prefecture').innerHTML = '<option value="">自動判別（または選択）</option>' + PREFECTURES.map(p=>`<option value="${p}">${p}</option>`).join('');
}
function initMap() {
  map = L.map('map',{zoomControl:false}).setView([36.575,137.984],6);
  L.control.zoom({position:'topleft'}).addTo(map);
  L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', {
    maxZoom:18, attribution:'<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>'
  }).addTo(map);
  map.on('click', async e => {
    openAddModal();
    el('input-lat').value=e.latlng.lat.toFixed(6);
    el('input-lng').value=e.latlng.lng.toFixed(6);
    await detectPrefecture(e.latlng.lat,e.latlng.lng);
  });
}
function updateUI() { renderMapElements(); renderSpotsList(); renderPrefecturesTracker(); }
function saveLocalState() {
  localStorage.setItem(activeRoom ? roomCacheKey(activeRoom) : LOCAL_KEY, JSON.stringify(visitedPlaces));
  updateUI();
}
function renderMapElements() {
  mapMarkers.forEach(m=>map.removeLayer(m)); mapCircles.forEach(c=>map.removeLayer(c));
  mapMarkers=[]; mapCircles=[];
  visitedPlaces.forEach(p => {
    const circle = L.circle([p.lat,p.lng],{color:p.color,fillColor:p.color,fillOpacity:0.35,weight:1.5,radius:p.radius*1000}).addTo(map);
    mapCircles.push(circle);
    const marker = L.marker([p.lat,p.lng],{
      icon: L.divIcon({className:'custom-pin',html:`<div style="background-color:${p.color};" class="w-8 h-8 rounded-full flex items-center justify-center text-white shadow-lg border-2 border-white"><i class="fa-solid fa-heart text-xs"></i></div>`,iconSize:[32,32],iconAnchor:[16,16]})
    }).addTo(map);
    const mapsUrl=`https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`;
    const stars='★'.repeat(p.rating)+'☆'.repeat(5-p.rating);
    marker.bindPopup(`<div class="p-1 max-w-xs">
      <h3 class="font-bold text-slate-800 text-sm mb-1">${escapeHtml(p.name)}</h3>
      <div class="text-amber-500 text-xs mb-1">${stars}</div>
      <p class="text-xs text-slate-500 mb-1">${escapeHtml(p.date)}</p>
      ${p.comment?`<p class="text-xs text-slate-700 bg-slate-50 p-2 rounded mb-2">${escapeHtml(p.comment)}</p>`:''}
      <div class="flex gap-2 mt-2">
        <a href="${mapsUrl}" target="_blank" rel="noopener" class="flex-1 bg-rose-500 text-white text-[11px] py-1 px-2 rounded text-center">Googleマップ</a>
        <button onclick="openEditPlace('${p.id}')" class="text-slate-600 hover:text-rose-500 text-xs px-2" title="編集"><i class="fa-solid fa-pen"></i></button>
        <button onclick="deletePlace('${p.id}')" class="text-slate-400 hover:text-red-500 text-xs px-2" title="削除"><i class="fa-solid fa-trash"></i></button>
      </div></div>`);
    mapMarkers.push(marker);
  });
}
function renderSpotsList() {
  const container=el('spots-list-container');
  el('spots-empty-state').classList.toggle('hidden', visitedPlaces.length!==0);
  container.innerHTML = visitedPlaces.map(p=>{
    const stars='★'.repeat(p.rating)+'☆'.repeat(5-p.rating);
    const mapsUrl=`https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`;
    return `<div class="bg-white p-3.5 rounded-2xl border border-slate-100 shadow-sm">
      <div class="flex items-start justify-between gap-2 mb-1.5"><div class="flex items-center space-x-2 min-w-0">
        <span class="w-3 h-3 rounded-full flex-shrink-0" style="background-color:${p.color}"></span>
        <h4 class="font-bold text-slate-800 text-sm break-all">${escapeHtml(p.name)}</h4></div>
        <div class="flex gap-1"><button onclick="openEditPlace('${p.id}')" class="text-slate-500 hover:text-rose-500 text-xs p-1.5" title="編集"><i class="fa-solid fa-pen"></i></button>
        <button onclick="deletePlace('${p.id}')" class="text-slate-400 hover:text-rose-500 text-xs p-1.5" title="削除"><i class="fa-solid fa-trash"></i></button></div></div>
      <div class="flex items-center text-xs text-slate-400 gap-3 mb-2"><span>${escapeHtml(p.date)}</span><span class="text-amber-400 font-medium">${stars}</span></div>
      ${p.comment?`<p class="text-xs text-slate-600 bg-slate-50 p-2 rounded-xl mb-2 break-words">${escapeHtml(p.comment)}</p>`:''}
      <div class="flex gap-2"><button onclick="focusOnMap(${p.lat},${p.lng})" class="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-700 py-1.5 rounded-lg text-xs font-medium">地図で表示</button>
      <a href="${mapsUrl}" target="_blank" rel="noopener" class="flex-1 bg-rose-50 text-rose-600 py-1.5 rounded-lg text-xs font-medium text-center">Google Maps</a></div></div>`;
  }).join('');
}
function renderPrefecturesTracker() {
  const visited = new Set();
  visitedPlaces.forEach(p=>{
    if (PREFECTURES.includes(p.prefecture)) visited.add(p.prefecture);
    // 旧データ向けの補完。文字列内の都道府県名は従来通り参照。
    PREFECTURES.forEach(pref=>{ if(p.name.includes(pref) || p.comment.includes(pref)) visited.add(pref); });
  });
  el('prefectures-grid').innerHTML=PREFECTURES.map(pref=>{
    const yes=visited.has(pref);
    return `<div class="p-2 rounded-xl border ${yes?'bg-rose-500 text-white border-rose-500 font-bold':'bg-slate-50 text-slate-500 border-slate-200'} text-xs flex items-center justify-between"><span>${pref}</span><i class="fa-solid ${yes?'fa-circle-check text-white':'fa-circle text-slate-200'} text-xs"></i></div>`;
  }).join('');
  const ratio=Math.round(visited.size/PREFECTURES.length*100);
  el('pref-percentage').textContent=`${ratio}%`;
  el('pref-progress-bar').style.width=`${ratio}%`;
  el('stats-summary').textContent=`制覇都道府県: ${visited.size}/47 | スポット: ${visitedPlaces.length}件`;
}
function focusOnMap(lat,lng) {map.flyTo([lat,lng],12,{duration:1.2}); closePanel();}
function togglePanel() {el('sidebar').classList.toggle('translate-x-full');}
function closePanel() {el('sidebar').classList.add('translate-x-full');}
function openAddModal() {
  editingPlaceId=null;
  el('form-add-place').reset();
  selectedPrefManually=false;
  currentRating=5; updateStarRatingUI(5);
  el('modal-title').textContent='思い出の場所を登録';
  el('btn-submit-place').textContent='マップに登録する';
  el('input-date').value=nowLocalDate();
  el('radius-value-display').textContent='1 km';
  el('gmap-status').classList.add('hidden'); el('search-status').classList.add('hidden');
  el('pref-status').textContent='地図タップや位置取得で自動判定します';
  el('modal-add').classList.remove('hidden');
}
function openEditPlace(id) {
  const p=visitedPlaces.find(x=>x.id===id); if(!p) return;
  openAddModal(); editingPlaceId=id;
  el('modal-title').textContent='思い出の場所を編集';
  el('btn-submit-place').textContent='変更を保存する';
  el('input-name').value=p.name;
  el('input-prefecture').value=p.prefecture;
  el('input-lat').value=p.lat;
  el('input-lng').value=p.lng;
  el('input-date').value=p.date||'';
  el('input-comment').value=p.comment;
  el('input-color').value=p.color;
  el('input-radius').value=p.radius;
  el('radius-value-display').textContent=`${p.radius} km`;
  currentRating=p.rating; updateStarRatingUI(p.rating);
  selectedPrefManually=!!p.prefecture;
  if(p.prefecture) el('pref-status').textContent=`登録済み: ${p.prefecture}`;
  closePanel(); map.closePopup();
}
function closeAddModal() { el('modal-add').classList.add('hidden'); editingPlaceId=null; ++geoRunId; }
function updateStarRatingUI(rating) {
  currentRating=rating;
  document.querySelectorAll('.star-btn').forEach((s,i)=>{
    s.classList.toggle('fa-solid',i<rating);s.classList.toggle('fa-regular',i>=rating);
  });
}
function switchTab(tab) {
  ['spots','prefectures','settings'].forEach(t=>{
    const b=el(`tab-${t}`), content=el(`content-${t}`), on=t===tab;
    b.classList.toggle('text-rose-600',on); b.classList.toggle('border-b-2',on);
    b.classList.toggle('border-rose-500',on); b.classList.toggle('font-semibold',on);
    b.classList.toggle('text-slate-500',!on); b.classList.toggle('font-medium',!on);
    content.classList.toggle('hidden',!on);
  });
}
function queueGeo(url) {
  // Nominatimの公開API利用ポリシー (最大毎秒1リクエスト) を守る。
  const run=async()=>{
    const pause=Math.max(0,1100-(Date.now()-lastGeoRequest));
    if(pause) await new Promise(r=>setTimeout(r,pause));
    lastGeoRequest=Date.now();
    const response=await fetch(url,{headers:{'Accept':'application/json'}});
    if(!response.ok) throw new Error(`位置検索に失敗しました (${response.status})`);
    return response.json();
  };
  const p=geoSerial.then(run,run);
  geoSerial=p.catch(()=>{});
  return p;
}
function matchPrefecture(text) {
  const s=String(text||'');
  const match=PREFECTURES.find(p=>s.includes(p));
  if(match) return match;
  // 一部サービスの府県名の省略表記を補完
  for(const p of PREFECTURES) {
    if(p==='北海道' || p==='東京都' || p==='京都府' || p==='大阪府') continue;
    if(s.includes(p.slice(0,-1)) && s.length<18) return p;
  }
  if(s==='東京'||s==='Tokyo') return '東京都';
  return '';
}
async function reversePrefecture(lat,lng) {
  if(!validCoord(lat,lng)) return '';
  const params=new URLSearchParams({format:'jsonv2',lat:String(lat),lon:String(lng),zoom:'5',addressdetails:'1','accept-language':'ja'});
  const result=await queueGeo(`https://nominatim.openstreetmap.org/reverse?${params}`);
  const fields=result.address||{};
  return matchPrefecture(fields.province)||matchPrefecture(fields.state)||matchPrefecture(fields.region)||matchPrefecture(result.display_name);
}
async function detectPrefecture(lat,lng) {
  if(selectedPrefManually || !validCoord(Number(lat),Number(lng))) return;
  const id=++geoRunId;
  el('pref-status').textContent='都道府県を調べています…';
  try {
    const pref=await reversePrefecture(Number(lat),Number(lng));
    if(id!==geoRunId || selectedPrefManually || el('modal-add').classList.contains('hidden')) return;
    const currentLat=Number(el('input-lat').value),currentLng=Number(el('input-lng').value);
    if(Math.abs(Number(lat)-currentLat)>.0001 || Math.abs(Number(lng)-currentLng)>.0001) return;
    if(pref) { el('input-prefecture').value=pref;el('pref-status').textContent=`自動判定: ${pref}`; }
    else el('pref-status').textContent='自動判定できませんでした。都道府県を選択してください';
  } catch {
    if(id===geoRunId) el('pref-status').textContent='自動判定に失敗しました。手動で選択できます';
  }
}
async function searchLocation(query) {
  const params=new URLSearchParams({format:'jsonv2',q:query,limit:'1',addressdetails:'1','accept-language':'ja'});
  const result=await queueGeo(`https://nominatim.openstreetmap.org/search?${params}`);
  if(!Array.isArray(result)||!result.length) throw new Error('場所が見つかりませんでした');
  const first=result[0];
  return {lat:Number(first.lat),lng:Number(first.lon),pref:matchPrefecture(first.address?.state)||matchPrefecture(first.address?.province)||matchPrefecture(first.display_name)};
}
async function applyLocation(lat,lng,pref='') {
  if(!validCoord(Number(lat),Number(lng))) throw new Error('座標が無効です');
  // 場所の検索で座標を変更した場合は、以前の都道府県判定を引き継がない。
  selectedPrefManually=false;
  el('input-prefecture').value='';
  el('input-lat').value=Number(lat).toFixed(6);
  el('input-lng').value=Number(lng).toFixed(6);
  if(pref && !selectedPrefManually) {
    el('input-prefecture').value=pref;
    el('pref-status').textContent=`自動判定: ${pref}`;
  } else if(!selectedPrefManually) {
    await detectPrefecture(lat,lng);
  }
}
function parseGoogleMapUrl(url) {
  // !3d緯度!4d経度 / !2d経度!3d緯度 / @地図中心 / ?q=座標
  let match=url.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if(match) return {lat:Number(match[1]),lng:Number(match[2])};
  match=url.match(/!2d(-?\d+(?:\.\d+)?)!3d(-?\d+(?:\.\d+)?)/);
  if(match) return {lat:Number(match[2]),lng:Number(match[1])};
  match=url.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if(match) return {lat:Number(match[1]),lng:Number(match[2])};
  const u=new URL(url);
  for(const key of ['query','q','ll','center']) {
    const value=u.searchParams.get(key);
    if(value) {match=value.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
      if(match) return {lat:Number(match[1]),lng:Number(match[2])};
    }
  }
  return null;
}
function parseGooglePlaceName(url) {
  const u=new URL(url);
  const match=u.pathname.match(/\/place\/([^/@?#]+)/);
  if(match) {try { return decodeURIComponent(match[1].replace(/\+/g,' ')); } catch {return match[1];}}
  for(const key of ['query','q']) {
    const v=u.searchParams.get(key);
    if(v && !/^[-\d.,\s]+$/.test(v)) return v;
  }
  return '';
}
function isGoogleMapHost(host) {
  return /^(?:(?:www|maps)\.)?google\.(?:com|co\.jp|co\.uk|com\.au)$/.test(host) || host==='maps.app.goo.gl' || host==='goo.gl';
}
async function importMapUrl() {
  const status=el('gmap-status'); status.classList.remove('hidden');
  let input=el('input-gmap-url').value.trim();
  if(!input) {status.textContent='Googleマップの共有URLを貼り付けてください'; return;}
  status.textContent='URLから位置を確認しています…';
  try {
    const u=new URL(input);
    if(u.protocol!=='https:' || !isGoogleMapHost(u.hostname.toLowerCase())) throw new Error('GoogleマップのHTTPS URLを入力してください');
    if(/^(maps\.app\.goo\.gl|goo\.gl)$/.test(u.hostname.toLowerCase())) {
      if(location.protocol==='file:') throw new Error('短縮URLを読み込むにはVercelへの公開が必要です（README参照）');
      // リダイレクトをブラウザから直接取得するとCORS制限があるため、Vercel API経由で展開。
      const r=await fetch(`/api/resolve-map?url=${encodeURIComponent(input)}`);
      if(!r.ok) {
        let detail=''; try{detail=(await r.json()).error||'';}catch{}
        throw new Error(detail||'短縮URLを展開できませんでした（Vercelへの配置が必要です）');
      }
      const payload=await r.json();
      if(!payload.url) throw new Error('短縮URLの展開結果が空でした');
      input=payload.url;
    }
    const name=parseGooglePlaceName(input);
    if(name) el('input-name').value=name;
    const coords=parseGoogleMapUrl(input);
    if(coords && validCoord(coords.lat,coords.lng)) {
      await applyLocation(coords.lat,coords.lng);
      status.textContent='スポットの位置を取得しました'; return;
    }
    if(name) {
      const p=await searchLocation(name);
      await applyLocation(p.lat,p.lng,p.pref);
      status.textContent='スポット名から位置を取得しました'; return;
    }
    throw new Error('URLに座標がありません。施設名を入力して「位置を取得」を押してください');
  } catch(error) {status.textContent=error.message||'URLを読み込めませんでした';}
}

// ----- Firebase / 2人の同期 -----
function getFirebaseConfig() {
  return EMBEDDED_FIREBASE_CONFIG || safeParse(localStorage.getItem(CONFIG_KEY),null);
}
function parseFirebaseConfigInput(value) {
  const parsed=safeParse(value,null);
  if(validateConfig(parsed)) return parsed;
  // Firebase Consoleが表示する `const firebaseConfig = { apiKey: "...", ... };` も受け付ける。
  // evalやFunctionは使わず、安全に認識した文字列フィールドのみ抽出する。
  const obj={};
  for(const key of ['apiKey','authDomain','projectId','appId','storageBucket','messagingSenderId','measurementId','databaseURL']) {
    const pattern=new RegExp(`(?:["']?${key}["']?)\\s*:\\s*(["'])([^"']*)\\1`);
    const match=String(value).match(pattern);
    if(match)obj[key]=match[2];
  }
  return validateConfig(obj)?obj:null;
}
function validateConfig(cfg) {
  return cfg && typeof cfg==='object' && ['apiKey','authDomain','projectId','appId'].every(key => typeof cfg[key]==='string' && cfg[key].length>2);
}
function getCloudCollection(room=activeRoom) {return db.collection('journeys').doc(room).collection('places');}
function setRoomInURL(room) {
  const next=location.pathname+location.search+(room?`#room=${room}`:'');
  history.replaceState(null,'',next);
}
function genRoomCode() {
  if(!crypto?.getRandomValues) throw new Error('共有コードの生成にはHTTPS接続が必要です');
  const bytes=new Uint8Array(24);crypto.getRandomValues(bytes);
  return [...bytes].map(n=>n.toString(16).padStart(2,'0')).join('');
}
async function initFirebase() {
  const cfg=getFirebaseConfig();
  if(!validateConfig(cfg)) throw new Error('共有・設定タブでFirebase設定を登録してください');
  if(typeof firebase==='undefined') throw new Error('Firebaseライブラリを読み込めませんでした。ネット接続を確認してください');
  if(firebaseApp && firebaseApp.options.projectId!==cfg.projectId) {
    await firebaseApp.delete(); firebaseApp=null;auth=null;db=null;
  }
  if(!firebaseApp) {
    firebaseApp = firebase.initializeApp(cfg,'odekake-map');
    auth=firebaseApp.auth(); db=firebaseApp.firestore();
  }
  if(!auth.currentUser) await auth.signInAnonymously();
}
async function connectRoom(room) {
  if(!roomRegex.test(room||'')) {notify('共有コードは48文字の英数字です');return;}
  const cfg=getFirebaseConfig();
  if(!validateConfig(cfg)) {
    el('input-room-code').value=room;
    setSyncStatus('Firebase未設定：この端末のみ','local');
    notify('共有コードを開きました。共有・設定からFirebaseの設定を行ってください');
    return;
  }
  const session=++syncSession;
  stopCloudListener();
  setSyncStatus('クラウドへ接続しています…','busy');
  try {
    await initFirebase();
    if(session!==syncSession) return;
    activeRoom=room;
    cloudReady=false;lastSyncError='';
    localStorage.setItem(ROOM_KEY,room);
    setRoomInURL(room);
    el('input-room-code').value=room;
    remotePlaces=new Map();
    pendingOps=new Map(Object.entries(safeParse(localStorage.getItem(roomPendingKey(room)),'{}')||{}));
    visitedPlaces=normalizePlaces(safeParse(localStorage.getItem(roomCacheKey(room)),'[]'));
    updateUI();
    const collection=getCloudCollection(room);
    unsubCloud=collection.onSnapshot(snapshot=>{
      if(session!==syncSession || activeRoom!==room) return;
      // 起動直後のFirestore空メモリキャッシュで端末内の履歴を消さない。
      if(snapshot.metadata.fromCache && snapshot.empty && !cloudReady && visitedPlaces.length) {
        updateCloudStatus(); return;
      }
      remotePlaces=new Map(snapshot.docs.map(doc=>[doc.id,sanitizePlace({...doc.data(),id:doc.id})]).filter(item=>item[1]));
      cloudReady=!snapshot.metadata.fromCache;
      applyCloudView();
      updateCloudStatus();
    },error=>{
      if(session!==syncSession)return;
      lastSyncError=error.message||'不明な接続エラー';
      updateCloudStatus();
    });
    // 初回だけ、既存のローカル記録をIDベースで追加。既存のクラウドデータは消さない。
    if(!localStorage.getItem(roomMigrationKey(room))) {
      const old=localStorage.getItem(LOCAL_KEY);
      const localData=old===null ? [] : normalizePlaces(safeParse(old,[]));
      const remote=await collection.get({source:'server'});
      if(session!==syncSession)return;
      const knownIds=new Set(remote.docs.map(d=>d.id));
      for(const p of localData) {
        if(!knownIds.has(p.id) && !pendingOps.has(p.id)) {
          pendingOps.set(p.id,{kind:'set',place:p,revision:createId()});
        }
      }
      storePending();
      localStorage.setItem(roomMigrationKey(room),'1');
      applyCloudView();
    }
    flushPending(); updateCloudStatus();
  } catch(error) {
    if(session!==syncSession)return;
    lastSyncError=error.message||'接続に失敗しました';
    if(!activeRoom) visitedPlaces=localPlaces();
    updateUI();updateCloudStatus();
    notify('クラウド同期: '+lastSyncError);
  }
}
function storePending() {
  if(!activeRoom)return;
  localStorage.setItem(roomPendingKey(activeRoom),JSON.stringify(Object.fromEntries(pendingOps)));
}
function applyCloudView() {
  if(!activeRoom)return;
  const merged=new Map(remotePlaces);
  for(const [id,op] of pendingOps) {
    if(op.kind==='delete') merged.delete(id);
    else if(op.place) merged.set(id,op.place);
  }
  visitedPlaces=sortPlaces([...merged.values()]);
  localStorage.setItem(roomCacheKey(activeRoom),JSON.stringify(visitedPlaces));
  updateUI();
}
function updateCloudStatus() {
  if(!activeRoom){setSyncStatus('この端末に保存（未同期）');return;}
  if(lastSyncError){setSyncStatus('同期エラー: '+lastSyncError,'error');return;}
  if(!navigator.onLine){setSyncStatus('オフライン：再接続時に同期','busy');return;}
  if(!cloudReady){setSyncStatus('クラウドと接続中…','busy');return;}
  if(pendingOps.size){setSyncStatus(`同期待ち: ${pendingOps.size}件`,'busy');return;}
  setSyncStatus('2人のデータを同期中（最新）','ok');
}
function stopCloudListener() {
  if(unsubCloud){unsubCloud();unsubCloud=null;}
}
function disconnectRoom() {
  ++syncSession;stopCloudListener();
  activeRoom='';cloudReady=false;remotePlaces=new Map();pendingOps=new Map();pendingInflight=new Set();lastSyncError='';
  localStorage.removeItem(ROOM_KEY);setRoomInURL('');
  el('input-room-code').value='';
  visitedPlaces=localPlaces();updateUI(); updateCloudStatus();
  notify('共有ルームから切断しました。ローカル記録に戻りました');
}
function persistChange(kind, placeOrId) {
  if(!activeRoom)return;
  const id=kind==='delete' ? placeOrId : placeOrId.id;
  pendingOps.set(id,{kind,place:kind==='set'?placeOrId:undefined,revision:createId()});
  storePending();applyCloudView();flushPending();updateCloudStatus();
}
async function flushPending() {
  if(!activeRoom || !db || !auth?.currentUser || !navigator.onLine)return;
  const room=activeRoom;
  for(const [id,op] of pendingOps) {
    if(pendingInflight.has(id))continue;
    pendingInflight.add(id);
    (op.kind==='delete' ? getCloudCollection(room).doc(id).delete() : getCloudCollection(room).doc(id).set(op.place))
      .then(()=>{
        if(room!==activeRoom)return;
        const current=pendingOps.get(id);
        if(current?.revision===op.revision) {
          pendingOps.delete(id);storePending();
          if(op.kind==='delete')remotePlaces.delete(id);else remotePlaces.set(id,op.place);
          applyCloudView();
        }
      })
      .catch(error=>{
        if(room!==activeRoom)return;
        lastSyncError=error.message||'送信に失敗しました';
        updateCloudStatus();
      })
      .finally(()=>{
        pendingInflight.delete(id);
        if(room!==activeRoom)return;
        updateCloudStatus();
        // 続けて編集した場合、新しい版を再送
        if(pendingOps.get(id)?.revision!==op.revision && navigator.onLine) flushPending();
      });
  }
}
function addOrUpdatePlace(p) {
  if(activeRoom){persistChange('set',p);}else {
    const index=visitedPlaces.findIndex(x=>x.id===p.id);
    if(index<0) visitedPlaces.unshift(p); else visitedPlaces[index]=p;
    visitedPlaces=sortPlaces(visitedPlaces); saveLocalState();
  }
}
function deletePlace(id) {
  const target=visitedPlaces.find(p=>p.id===id);
  if(!target || !confirm(`「${target.name}」を削除しますか？`))return;
  if(activeRoom)persistChange('delete',id);
  else {visitedPlaces=visitedPlaces.filter(p=>p.id!==id);saveLocalState();}
}
async function importJsonFile(file) {
  const text=await file.text();
  const parsed=safeParse(text,null);
  if(!Array.isArray(parsed))throw new Error('スポット配列を含むJSONファイルではありません');
  const imported=normalizePlaces(parsed);
  if(!imported.length)throw new Error('有効なスポット情報が見つかりませんでした');
  const existing=new Map(visitedPlaces.map(p=>[p.id,p]));
  // ローカル保存未開始の場合、画面に仮表示していたサンプル2件は移行対象に含めない。
  if(!activeRoom && localStorage.getItem(LOCAL_KEY)===null) existing.clear();
  let changed=0;
  for(const p of imported) {
    if(existing.has(p.id)) continue; // 同じIDの記録は現在のデータを維持
    existing.set(p.id,p);changed++;
    if(activeRoom)persistChange('set',p);
  }
  if(!activeRoom){visitedPlaces=sortPlaces([...existing.values()]);saveLocalState();}
  notify(`${changed}件を追加しました（既存の記録は維持）`);
}
function setupEventListeners() {
  el('btn-hide-header').addEventListener('click',()=>{el('app-header').classList.add('hidden');el('btn-show-header').classList.remove('hidden');setTimeout(()=>map.invalidateSize(),200);});
  el('btn-show-header').addEventListener('click',()=>{el('app-header').classList.remove('hidden');el('btn-show-header').classList.add('hidden');setTimeout(()=>map.invalidateSize(),200);});
  el('btn-toggle-panel').addEventListener('click',togglePanel);
  el('btn-close-panel').addEventListener('click',closePanel);
  el('btn-add-place').addEventListener('click',openAddModal);
  el('btn-close-modal').addEventListener('click',closeAddModal);
  el('modal-add').addEventListener('click',e=>{if(e.target===el('modal-add'))closeAddModal();});
  ['spots','prefectures','settings'].forEach(t=>el(`tab-${t}`).addEventListener('click',()=>switchTab(t)));
  el('input-radius').addEventListener('input',e=>el('radius-value-display').textContent=`${e.target.value} km`);
  document.querySelectorAll('.star-btn').forEach(s=>s.addEventListener('click',()=>updateStarRatingUI(Number(s.dataset.value))));
  el('input-prefecture').addEventListener('change',()=>{
    selectedPrefManually=!!el('input-prefecture').value;
    el('pref-status').textContent=selectedPrefManually ? `手動選択: ${el('input-prefecture').value}` : '自動判別を使います';
  });
  ['input-lat','input-lng'].forEach(id=>el(id).addEventListener('change',()=>{
    selectedPrefManually=false;el('input-prefecture').value='';
    detectPrefecture(Number(el('input-lat').value),Number(el('input-lng').value));
  }));
  el('btn-parse-gmap').addEventListener('click',importMapUrl);
  el('btn-backfill-prefs').addEventListener('click',async()=>{
    const missing=visitedPlaces.filter(p=>!p.prefecture);
    const b=el('btn-backfill-prefs'), status=el('backfill-status');
    if(!missing.length){status.textContent='すべてのスポットに都道府県が設定されています';return;}
    b.disabled=true; let updated=0;
    try {
      for(let i=0;i<missing.length;i++) {
        const p=missing[i];status.textContent=`判定中 ${i+1}/${missing.length}件...`;
        try {
          const pref=await reversePrefecture(p.lat,p.lng);
          const latest=visitedPlaces.find(x=>x.id===p.id);
          if(pref && latest && !latest.prefecture) {
            addOrUpdatePlace({...latest,prefecture:pref,updatedAt:Date.now()});
            updated++;
          }
        }catch{}
      }
      status.textContent=`${updated}件の都道府県を補完しました。判定できない場所は手動で編集できます。`;
    } finally {b.disabled=false;}
  });
  el('btn-search-coords').addEventListener('click',async()=>{
    const name=el('input-name').value.trim(),status=el('search-status');
    status.classList.remove('hidden');
    if(!name){status.textContent='施設名を入力してください';return;}
    status.textContent='場所を検索しています…';
    try {const p=await searchLocation(name);await applyLocation(p.lat,p.lng,p.pref);status.textContent='位置を取得しました';}
    catch(error){status.textContent=error.message||'検索に失敗しました';}
  });
  el('form-add-place').addEventListener('submit',async e=>{
    e.preventDefault();
    const name=el('input-name').value.trim();
    const lat=Number(el('input-lat').value),lng=Number(el('input-lng').value);
    if(!name||!validCoord(lat,lng)){notify('場所の名前と正しい位置情報を入力してください');return;}
    const btn=el('btn-submit-place');btn.disabled=true;
    try {
      let pref=el('input-prefecture').value;
      if(!pref) {
        el('pref-status').textContent='保存前に都道府県を確認しています…';
        try{pref=await reversePrefecture(lat,lng);}catch{}
      }
      if(!pref) {notify('都道府県を判定できません。後から編集できます');}
      const p=sanitizePlace({
        id:editingPlaceId||createId(), name,lat,lng,
        date:el('input-date').value||nowLocalDate(),rating:currentRating,
        comment:el('input-comment').value.trim(),color:el('input-color').value,
        radius:el('input-radius').value,prefecture:pref,updatedAt:Date.now()
      });
      if(!p)throw new Error('記録内容に問題があります');
      addOrUpdatePlace(p);closeAddModal();focusOnMap(lat,lng);
    } catch(error){notify(error.message||'保存できませんでした');}
    finally {btn.disabled=false;}
  });
  el('btn-export-data').addEventListener('click',()=>{
    const blob=new Blob([JSON.stringify(visitedPlaces,null,2)],{type:'application/json;charset=utf-8'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=url;a.download='odekake-map-backup.json';document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),2000);
  });
  el('input-import-data').addEventListener('change',async e=>{
    const file=e.target.files?.[0];if(!file)return;
    try{await importJsonFile(file);}catch(error){notify('読み込みエラー: '+error.message);}finally{e.target.value='';}
  });
  el('btn-save-firebase').addEventListener('click',()=>{
    const cfg=parseFirebaseConfigInput(el('input-firebase-config').value);
    if(!validateConfig(cfg)){notify('Firebase設定JSONに apiKey / authDomain / projectId / appId が必要です');return;}
    if(EMBEDDED_FIREBASE_CONFIG){notify('埋め込みFirebase設定が優先されます');return;}
    localStorage.setItem(CONFIG_KEY,JSON.stringify(cfg));
    notify('Firebase設定を保存しました。共有ルームへの接続が可能です');
    const room=el('input-room-code').value.trim();if(roomRegex.test(room))connectRoom(room);
  });
  el('btn-create-room').addEventListener('click',()=>{
    try {const room=genRoomCode();el('input-room-code').value=room;connectRoom(room);}catch(error){notify(error.message);}
  });
  el('btn-join-room').addEventListener('click',()=>connectRoom(el('input-room-code').value.trim().toLowerCase()));
  el('btn-copy-room-link').addEventListener('click',async()=>{
    const room=el('input-room-code').value.trim();
    if(!roomRegex.test(room)){notify('先に共有ルームを作成・接続してください');return;}
    if(location.protocol==='file:'){notify('共有リンクを使うにはVercelなどのHTTPS公開が必要です');return;}
    const url=`${location.origin}${location.pathname}${location.search}#room=${room}`;
    try {await navigator.clipboard.writeText(url);notify('共有リンクをコピーしました');}
    catch {window.prompt('このリンクをコピーして相手に送ってください',url);}
  });
  el('btn-disconnect-room').addEventListener('click',disconnectRoom);
  window.addEventListener('online',()=>{
    lastSyncError='';
    if(activeRoom && !localStorage.getItem(roomMigrationKey(activeRoom))) connectRoom(activeRoom);
    else {flushPending();updateCloudStatus();}
  });
  window.addEventListener('offline',updateCloudStatus);
}
// 地図ポップアップと一覧内のonclickから参照する公開関数。
window.openEditPlace=openEditPlace;
window.deletePlace=deletePlace;
window.focusOnMap=focusOnMap;
