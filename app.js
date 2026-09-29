"use strict";

// ================= settings =================
const CFG = window.APP_CONFIG || {};
const KEY_LS = "machi-techo:gmaps-key";
const GENRES = ["定食","カフェ","ラーメン","そば・うどん","居酒屋","パン","カレー","中華","その他"];
const PHOTO_LABELS = ["入口","出口","外観","店内","料理","メニュー","その他"];
const MAX_PHOTOS = 8;
const SPOTS = {
  tenjin: { lat: 33.5913, lng: 130.3990, zoom: 16 },
  hakata: { lat: 33.5897, lng: 130.4207, zoom: 16 },
  nakasu: { lat: 33.5935, lng: 130.4045, zoom: 16 },
};
const HOME = { lat: 33.5905, lng: 130.4105, zoom: 15 };   // 天神〜博多の間

function apiKey(){
  const fromCfg = (CFG.GOOGLE_MAPS_API_KEY || "").trim();
  if(fromCfg) return fromCfg;
  try{ return localStorage.getItem(KEY_LS) || ""; }catch{ return ""; }
}

// ================= helpers =================
const $ = s => document.querySelector(s);
function el(tag, attrs = {}, ...kids){
  const n = document.createElement(tag);
  for(const [k, v] of Object.entries(attrs)){
    if(v === false || v == null) continue;
    if(k === "class") n.className = v;
    else if(k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for(const c of kids.flat()) if(c != null && c !== false) n.append(c.nodeType ? c : String(c));
  return n;
}
let toastT;
function toast(msg){
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  // An open <dialog> sits above everything else, so show the message inside it.
  const d = $("#formDlg");
  (d && d.open ? d : document.body).append(t);
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 2600);
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
function starsEl(n){
  const w = el("span", { class: "rate", "aria-label": `おすすめ度 ${n} / 5` });
  w.append("★".repeat(n), el("span", { class: "off" }, "★".repeat(5 - n)));
  return w;
}
function fmtDist(m){ return m < 1000 ? `${Math.round(m / 10) * 10}m` : `${(m / 1000).toFixed(1)}km`; }
function fmtMin(sec){
  const m = Math.max(1, Math.round(sec / 60));
  return m < 60 ? `${m}分` : `${Math.floor(m / 60)}時間${m % 60 ? (m % 60) + "分" : ""}`;
}
const secs = d => parseInt(String(d || "0").replace("s", ""), 10) || 0;
function haversine(a, b){
  const R = 6371000, toR = x => x * Math.PI / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const hasLoc = s => Number.isFinite(s?.lat) && Number.isFinite(s?.lng);
function mapsUrl(s){
  if(s.mapsUrl) return s.mapsUrl;
  const q = hasLoc(s) ? `${s.lat},${s.lng}` : [s.name, s.area].filter(Boolean).join(" ");
  return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(q);
}
function dirUrl(s, mode){
  const p = new URLSearchParams({ api: "1", travelmode: mode === "WALK" ? "walking" : "transit" });
  p.set("destination", hasLoc(s) ? `${s.lat},${s.lng}` : s.name);
  if(s.placeId) p.set("destination_place_id", s.placeId);
  return "https://www.google.com/maps/dir/?" + p;
}

// ================= storage (IndexedDB, on this device) =================
const dbp = new Promise((res, rej) => {
  const r = indexedDB.open("machi-techo", 1);
  r.onupgradeneeded = () => {
    r.result.createObjectStore("shops", { keyPath: "id" });
    r.result.createObjectStore("photos");
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
function tx(store, mode, fn){
  return dbp.then(db => new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req ? req.result : undefined);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  }));
}
const store = {
  all: () => tx("shops", "readonly", s => s.getAll()),
  put: shop => tx("shops", "readwrite", s => s.put(shop)),
  del: id => tx("shops", "readwrite", s => s.delete(id)),
  putPhoto: (id, blob) => tx("photos", "readwrite", s => s.put(blob, id)),
  getPhoto: id => tx("photos", "readonly", s => s.get(id)),
  delPhoto: id => tx("photos", "readwrite", s => s.delete(id)),
};
const photoUrls = new Map();
async function photoUrl(id){
  if(photoUrls.has(id)) return photoUrls.get(id);
  const blob = await store.getPhoto(id).catch(() => null);
  const url = blob ? URL.createObjectURL(blob) : "";
  photoUrls.set(id, url);
  return url;
}
function photoImg(id, attrs = {}){
  const img = el("img", { alt: "", ...attrs });
  photoUrl(id).then(u => { if(u) img.src = u; });
  return img;
}
function dropPhotos(ids){
  for(const id of ids){
    store.delPhoto(id).catch(() => {});
    const u = photoUrls.get(id); if(u) URL.revokeObjectURL(u);
    photoUrls.delete(id);
  }
}

// ================= state =================
let shops = [];
let view = { area: "all", genre: "", q: "" };
let panel = { mode: "list", id: null, routeMode: "TRANSIT" };   // list | detail | route
let me = null;           // { lat, lng } current position
let G = null;            // loaded Google libraries
let map = null, meMarker = null, markers = new Map(), routeLines = [];

// ================= Google Maps loading =================
function loadGoogle(key){
  return new Promise((res, rej) => {
    window.__gmReady = res;
    window.gm_authFailure = () => showSetup("APIキーが使えませんでした。キーの値と、有効にしたAPI・ウェブサイトの制限を確認してください。");
    const s = document.createElement("script");
    s.src = "https://maps.googleapis.com/maps/api/js?" + new URLSearchParams({
      key, v: "weekly", language: "ja", region: "JP", loading: "async", callback: "__gmReady",
    });
    s.async = true;
    s.onerror = () => rej(new Error("Google Maps を読み込めませんでした"));
    document.head.append(s);
  });
}
async function initMap(){
  const key = apiKey();
  if(!key){ showSetup(); return; }
  try{
    await loadGoogle(key);
    const [maps, marker, places, geometry] = await Promise.all(
      ["maps", "marker", "places", "geometry"].map(n => google.maps.importLibrary(n)));
    G = { maps, marker, places, geometry };
  }catch(e){
    showSetup("Google Maps を読み込めませんでした。通信状況とAPIキーを確認してください。");
    return;
  }
  map = new G.maps.Map($("#map"), {
    center: { lat: HOME.lat, lng: HOME.lng }, zoom: HOME.zoom,
    mapId: CFG.MAP_ID || "DEMO_MAP_ID",
    disableDefaultUI: true, zoomControl: false, gestureHandling: "greedy",
    clickableIcons: false,
  });
  renderMarkers();
  autoLocateMissing();
}

// ================= automatic placement =================
// Find a shop on Google Maps from its name (and area), biased to central Fukuoka.
async function lookupPlace(name, area){
  if(!G) return null;
  for(const textQuery of [[name, area].filter(Boolean).join(" "), name]){
    try{
      const p = (await textSearch(textQuery))[0];
      if(p?.location) return {
        placeId: p.id, lat: p.location.lat(), lng: p.location.lng(),
        address: cleanAddr(p.formattedAddress),
        mapsUrl: p.googleMapsURI || "", area: areaFromComponents(p.addressComponents),
      };
    }catch(e){ console.error(e); /* try the next query */ }
    if(!area) break;
  }
  return null;
}
// Place shops that were saved without a location (e.g. typed name only) on the map.
async function autoLocateMissing(){
  const todo = shops.filter(s => !hasLoc(s) && !s.locateTried);
  if(!todo.length) return;
  let found = 0;
  for(const s of todo){
    const p = await lookupPlace(s.name, s.area);
    const next = p
      ? { ...s, lat: p.lat, lng: p.lng, placeId: p.placeId, address: p.address, mapsUrl: p.mapsUrl, area: s.area || p.area, locateTried: false }
      : { ...s, locateTried: true };
    if(p) found++;
    try{ await store.put(next); }catch{}
    shops = shops.map(x => x.id === s.id ? next : x);
  }
  renderMarkers(); renderPanel();
  if(found) toast(`${found}軒のお店を地図に表示しました`);
}
function showSetup(msg){
  $("#setup").hidden = false;
  $("#setupErr").hidden = !msg;
  $("#setupErr").textContent = msg || "";
  $("#keyInput").value = apiKey();
}
$("#setupForm").addEventListener("submit", e => {
  e.preventDefault();
  const v = $("#keyInput").value.trim();
  if(!v){ $("#keyInput").focus(); return; }
  try{ localStorage.setItem(KEY_LS, v); }catch{}
  location.reload();
});

// ================= current location =================
function getPosition(){
  return new Promise((res, rej) => {
    if(!navigator.geolocation){ rej(new Error("この端末では現在地を使えません")); return; }
    navigator.geolocation.getCurrentPosition(p => {
      me = { lat: p.coords.latitude, lng: p.coords.longitude };
      showMe();
      res(me);
    }, err => {
      rej(new Error(err.code === 1
        ? "位置情報の利用が許可されていません。ブラウザの設定で許可してください。"
        : "現在地を取得できませんでした。電波の良い場所でもう一度お試しください。"));
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
  });
}
function showMe(){
  if(!map || !me) return;
  if(!meMarker){
    meMarker = new G.marker.AdvancedMarkerElement({ map, position: me, content: el("div", { class: "me" }), title: "現在地", zIndex: 1000 });
  }else meMarker.position = me;
  if(panel.mode === "list") renderResults();
}
$("#locateBtn").addEventListener("click", async () => {
  try{ await getPosition(); map?.panTo(me); map?.setZoom(16); }
  catch(e){ toast(e.message); }
});
document.querySelectorAll("[data-jump]").forEach(b => b.addEventListener("click", () => {
  const s = SPOTS[b.dataset.jump]; if(!map) return;
  map.panTo(s); map.setZoom(s.zoom);
}));

// ================= markers =================
function filtered(){
  const q = view.q.toLowerCase();
  return shops.filter(s =>
    (view.area === "all" || areaOf(s) === view.area) &&
    (!view.genre || s.genre === view.genre) &&
    (!q || [s.name, s.memo, s.area, s.address].join(" ").toLowerCase().includes(q)));
}
function renderMarkers(){
  if(!map) return;
  for(const m of markers.values()) m.map = null;
  markers.clear();
  for(const s of filtered().filter(hasLoc)){
    const sel = panel.id === s.id;
    const content = el("div", { class: "pin" + (sel ? " sel" : "") }, el("b", {}, s.name), el("i"));
    const m = new G.marker.AdvancedMarkerElement({
      map, position: { lat: s.lat, lng: s.lng }, content, title: s.name, zIndex: sel ? 999 : 1, gmpClickable: true,
    });
    m.addListener("click", () => openDetail(s.id, true));
    markers.set(s.id, m);
  }
}
function clearRoute(){ for(const l of routeLines) l.setMap(null); routeLines = []; }

// ================= bottom sheet =================
const SHEET = { peek: "132px", half: "48vh", full: "86vh" };
function setSheet(size){
  $("#sheet").dataset.size = size;
  document.documentElement.style.setProperty("--sheet-h", SHEET[size]);
}
const SIZES = ["peek", "half", "full"];
const sheetPx = size => SHEET[size].endsWith("vh") ? innerHeight * parseFloat(SHEET[size]) / 100 : parseFloat(SHEET[size]);
let sheetDragged = false;
$("#handle").addEventListener("click", () => {
  if(sheetDragged){ sheetDragged = false; return; }   // the tap was the end of a swipe
  const cur = $("#sheet").dataset.size;
  setSheet(cur === "peek" ? "half" : cur === "half" ? "full" : "peek");
});

// Swipe the sheet up/down by its handle or title row; it follows the finger, then snaps to the nearest size.
(function sheetSwipe(){
  const sheet = $("#sheet"), app = $("#app");
  let drag = null;
  sheet.addEventListener("pointerdown", e => {
    if(!e.target.closest("#handle, .sheet-head")) return;
    drag = { y0: e.clientY, h0: sheet.getBoundingClientRect().height, y: e.clientY, t: e.timeStamp, v: 0, moved: false, id: e.pointerId };
  });
  sheet.addEventListener("pointermove", e => {
    if(!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y0;
    if(!drag.moved){
      if(Math.abs(dy) < 6) return;
      drag.moved = true;
      app.classList.add("sheet-dragging");
      try{ sheet.setPointerCapture(e.pointerId); }catch{}
    }
    const h = Math.min(sheetPx("full"), Math.max(sheetPx("peek") * 0.75, drag.h0 - dy));
    document.documentElement.style.setProperty("--sheet-h", h + "px");
    const dt = e.timeStamp - drag.t;
    if(dt > 0) drag.v = (e.clientY - drag.y) / dt;    // px per ms, positive = moving down
    drag.y = e.clientY; drag.t = e.timeStamp;
  });
  const end = e => {
    if(!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    if(!d.moved) return;
    sheetDragged = true;
    setTimeout(() => { sheetDragged = false; }, 350);
    app.classList.remove("sheet-dragging");
    const h = sheet.getBoundingClientRect().height;
    let i = SIZES.reduce((best, s, k) => Math.abs(sheetPx(s) - h) < Math.abs(sheetPx(SIZES[best]) - h) ? k : best, 0);
    // A quick flick moves one step in its direction from where the swipe started.
    if(Math.abs(d.v) > 0.5){
      const start = SIZES.indexOf(sheet.dataset.size);
      i = Math.max(0, Math.min(SIZES.length - 1, start + (d.v < 0 ? 1 : -1)));
    }
    setSheet(SIZES[i]);
  };
  sheet.addEventListener("pointerup", end);
  sheet.addEventListener("pointercancel", end);
})();

const areaOf = s => (s.area || "").trim() || "エリア未設定";
function areas(){
  const m = new Map();
  for(const s of shops) m.set(areaOf(s), (m.get(areaOf(s)) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function renderPanel(){
  const body = $("#sheetBody");
  body.replaceChildren();
  if(panel.mode === "detail") body.append(detailView());
  else if(panel.mode === "route") body.append(routeView());
  else body.append(listView());
}

function sortedItems(){
  const items = filtered(), origin = me;
  items.sort((a, b) => origin && hasLoc(a) && hasLoc(b)
    ? haversine(origin, a) - haversine(origin, b)
    : (b.rating || 0) - (a.rating || 0) || (b.createdAt || 0) - (a.createdAt || 0));
  return items;
}

// The list is built once as a shell (title, filters, search box); typing only swaps the results below,
// so the search box is never recreated mid-typing (keeps Japanese input and held backspace working).
function listView(){
  const wrap = el("div", { class: "stack" });
  wrap.append(el("div", { class: "sheet-head" }, el("h2", {}, "記録したお店"), el("span", { class: "count", id: "listCount" })));

  if(shops.length){
    const f = el("div", { class: "filters" });
    const q = el("input", { type: "search", placeholder: "店名・メモで検索", value: view.q, id: "listQ", enterkeyhint: "search" });
    let markerTimer = null;
    q.addEventListener("input", e => {
      view.q = e.target.value;
      renderResults();
      clearTimeout(markerTimer);
      markerTimer = setTimeout(renderMarkers, 300);
    });
    const tabs = el("div", { class: "row", role: "group", "aria-label": "エリア" });
    for(const [key, label] of [["all", "すべて"], ...areas().map(([a]) => [a, a])]){
      tabs.append(el("button", { type: "button", class: "tab", "aria-pressed": String(view.area === key),
        onclick: () => { view.area = key; refresh(); } }, label));
    }
    const used = GENRES.filter(g => shops.some(s => s.genre === g));
    const gs = el("div", { class: "row" });
    if(used.length > 1) for(const g of used){
      gs.append(el("button", { type: "button", class: "chip", "aria-pressed": String(view.genre === g),
        onclick: () => { view.genre = view.genre === g ? "" : g; refresh(); } }, g));
    }
    f.append(tabs, gs, q);
    wrap.append(f);
  }
  wrap.append(el("div", { id: "listResults" }));
  queueMicrotask(renderResults);
  return wrap;
}

function renderResults(){
  const box = $("#listResults");
  if(!box) return;
  const items = sortedItems(), origin = me;
  const count = $("#listCount");
  if(count) count.textContent = `${items.length} / ${shops.length}軒` + (origin ? "・近い順" : "");
  box.replaceChildren();
  if(!items.length){
    box.append(el("p", { class: "empty" }, shops.length
      ? "条件に合うお店がありません。"
      : "まだ記録がありません。「＋ 記録する」から、よく行くお店を追加しましょう。"));
    return;
  }
  const ul = el("ul", { class: "items" });
  for(const s of items){
    const thumb = s.photos?.length ? photoImg(s.photos[0].id, { class: "thumb" }) : el("span", { class: "thumb" }, s.genre || "店");
    ul.append(el("li", {}, el("button", { type: "button", class: "item", onclick: () => openDetail(s.id, true) },
      thumb,
      el("span", { class: "nm" }, s.name),
      el("span", { class: "dist" }, origin && hasLoc(s) ? fmtDist(haversine(origin, s)) : hasLoc(s) ? "" : "位置なし"),
      el("span", { class: "meta" }, s.genre ? el("span", { class: "genre" }, s.genre) : null, areaOf(s), starsEl(s.rating || 0)))));
  }
  box.append(ul);
}

// Refresh list + markers (used by the area/genre buttons).
function refresh(){
  renderPanel(); renderMarkers();
}

let pendingDelete = null;
function openDetail(id, pan){
  panel = { ...panel, mode: "detail", id };
  pendingDelete = null;
  clearRoute();
  const s = shops.find(x => x.id === id);
  if(pan && s && hasLoc(s) && map){ map.panTo({ lat: s.lat, lng: s.lng }); if(map.getZoom() < 16) map.setZoom(16); }
  if($("#sheet").dataset.size === "peek") setSheet("half");
  renderPanel(); renderMarkers();
}
function backToList(){
  panel = { ...panel, mode: "list", id: null };
  clearRoute(); renderPanel(); renderMarkers();
}

function detailView(){
  const s = shops.find(x => x.id === panel.id);
  if(!s){ panel.mode = "list"; return listView(); }
  const w = el("div", { class: "detail" });
  w.append(el("button", { type: "button", class: "ghost back", onclick: backToList }, "← 一覧に戻る"));
  w.append(el("div", { class: "d-title" }, el("h2", {}, s.name), s.genre ? el("span", { class: "genre" }, s.genre) : null, starsEl(s.rating || 0)));
  w.append(el("p", { class: "d-addr" }, [areaOf(s), s.address].filter(Boolean).join("　")));
  if(s.photos?.length){
    w.append(el("div", { class: "thumbs" }, s.photos.map((p, i) =>
      el("button", { type: "button", "aria-label": `${p.label}の写真を見る`, onclick: () => openViewer(s.photos, i) },
        photoImg(p.id), el("span", {}, p.label)))));
  }
  if(s.memo) w.append(el("p", { class: "d-memo" }, s.memo));
  if(hasLoc(s)){
    w.append(el("div", { class: "go" },
      el("button", { type: "button", class: "walk", onclick: () => startRoute(s, "WALK") }, "歩いて行く"),
      el("button", { type: "button", class: "transit", onclick: () => startRoute(s, "TRANSIT") }, "電車・バスで行く")));
  }else{
    w.append(el("p", { class: "hint" }, "このお店は位置が登録されていません。「編集」からお店を検索すると地図に表示され、行き方も調べられます。"));
  }
  const confirming = pendingDelete === s.id;
  w.append(el("div", { class: "ops" },
    el("button", { type: "button", onclick: () => shareShop(s) }, "友達に共有"),
    el("a", { href: mapsUrl(s), target: "_blank", rel: "noopener" }, "Googleマップで開く"),
    el("button", { type: "button", onclick: () => openForm(s) }, "編集"),
    confirming
      ? [el("button", { type: "button", class: "danger", onclick: () => deleteShop(s) }, "本当に削除"),
         el("button", { type: "button", onclick: () => { pendingDelete = null; renderPanel(); } }, "やめる")]
      : el("button", { type: "button", class: "danger", onclick: () => { pendingDelete = s.id; renderPanel(); } }, "削除")));
  return w;
}

async function deleteShop(s){
  try{
    await store.del(s.id);
    dropPhotos((s.photos || []).map(p => p.id));
    shops = shops.filter(x => x.id !== s.id);
    toast("削除しました");
    backToList();
  }catch{ toast("削除できませんでした"); }
}

// ================= routes (Routes API) =================
let routeState = null;   // { shop, mode, loading, error, route }
async function startRoute(s, mode){
  panel = { ...panel, mode: "route", id: s.id, routeMode: mode };
  routeState = { shop: s, mode, loading: true };
  setSheet("half");
  renderPanel();
  try{
    const origin = await getPosition();
    const route = await computeRoute(origin, s, mode);
    if(panel.mode !== "route" || panel.id !== s.id || panel.routeMode !== mode) return;   // user moved on
    routeState = { shop: s, mode, route };
    drawRoute(route, origin, s);
  }catch(e){
    if(panel.mode !== "route") return;
    routeState = { shop: s, mode, error: e.message || "ルートを調べられませんでした" };
  }
  renderPanel();
}
async function computeRoute(origin, s, mode){
  const body = {
    origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
    destination: s.placeId ? { placeId: s.placeId } : { location: { latLng: { latitude: s.lat, longitude: s.lng } } },
    travelMode: mode, languageCode: "ja", units: "METRIC",
  };
  const fields = [
    "routes.duration", "routes.distanceMeters", "routes.polyline.encodedPolyline", "routes.localizedValues",
    "routes.legs.steps.travelMode", "routes.legs.steps.distanceMeters", "routes.legs.steps.staticDuration",
    "routes.legs.steps.polyline.encodedPolyline", "routes.legs.steps.transitDetails",
    "routes.legs.steps.navigationInstruction",
  ].join(",");
  let r;
  try{
    r = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey(), "X-Goog-FieldMask": fields },
      body: JSON.stringify(body),
    });
  }catch{ throw new Error("通信できませんでした。電波の状態を確認してください。"); }
  const j = await r.json().catch(() => ({}));
  if(!r.ok){
    const status = j?.error?.status;
    throw new Error(status === "PERMISSION_DENIED"
      ? "ルート検索が許可されていません。Google Cloud で「Routes API」を有効にし、APIキーの制限に追加してください。"
      : "ルートを調べられませんでした。少し時間をおいてお試しください。");
  }
  const route = j.routes?.[0];
  if(!route) throw new Error(mode === "TRANSIT"
    ? "電車・バスのルートが見つかりませんでした。近い場合は「歩いて行く」を試してください。"
    : "徒歩ルートが見つかりませんでした。");
  return route;
}
function drawRoute(route, origin, s){
  clearRoute();
  if(!map) return;
  const decode = p => G.geometry.encoding.decodePath(p);
  const bounds = new google.maps.LatLngBounds();
  bounds.extend(origin); bounds.extend({ lat: s.lat, lng: s.lng });
  const steps = route.legs?.flatMap(l => l.steps || []) || [];
  const walkStyle = color => ({
    strokeOpacity: 0,
    icons: [{ icon: { path: google.maps.SymbolPath.CIRCLE, fillOpacity: 1, fillColor: color, strokeOpacity: 0, scale: 3 }, offset: "0", repeat: "10px" }],
  });
  const add = (path, opts) => {
    path.forEach(p => bounds.extend(p));
    routeLines.push(new google.maps.Polyline({ map, path, zIndex: 50, ...opts }));
  };
  if(steps.length){
    for(const st of steps){
      if(!st.polyline?.encodedPolyline) continue;
      const path = decode(st.polyline.encodedPolyline);
      if(st.travelMode === "TRANSIT"){
        const c = st.transitDetails?.transitLine?.color || "#23466E";
        add(path, { strokeColor: "#ffffff", strokeWeight: 9, strokeOpacity: .9, zIndex: 49 });
        add(path, { strokeColor: c, strokeWeight: 6, strokeOpacity: 1 });
      }else add(path, walkStyle("#1A73E8"));
    }
  }else if(route.polyline?.encodedPolyline){
    add(decode(route.polyline.encodedPolyline), walkStyle("#1A73E8"));
  }
  const pad = { top: 80, left: 40, right: 90, bottom: Math.round(innerHeight * 0.5) + 20 };
  map.fitBounds(bounds, pad);
}

function routeView(){
  const st = routeState, s = st.shop;
  const w = el("div", { class: "detail" });
  w.append(el("button", { type: "button", class: "ghost back", onclick: () => openDetail(s.id, false) }, `← ${s.name}に戻る`));
  w.append(el("div", { class: "tabs2", role: "group", "aria-label": "移動手段" },
    el("button", { type: "button", "aria-pressed": String(st.mode === "WALK"), onclick: () => startRoute(s, "WALK") }, "徒歩"),
    el("button", { type: "button", "aria-pressed": String(st.mode === "TRANSIT"), onclick: () => startRoute(s, "TRANSIT") }, "電車・バス")));
  const nav = el("a", { class: "navlink", href: dirUrl(s, st.mode), target: "_blank", rel: "noopener" }, "Googleマップアプリでナビを開始");

  if(st.loading){ w.append(el("p", { class: "hint" }, "現在地からのルートを調べています…")); return w; }
  if(st.error){ w.append(el("p", { class: "err" }, st.error), nav); return w; }

  const r = st.route;
  const total = secs(r.duration);
  const now = new Date(), arrive = new Date(now.getTime() + total * 1000);
  const hhmm = d => `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  w.append(el("div", { class: "route-sum" },
    el("strong", {}, r.localizedValues?.duration?.text || fmtMin(total)),
    el("span", {}, [r.localizedValues?.distance?.text || fmtDist(r.distanceMeters || 0), `${hhmm(arrive)}ごろ到着`].join("・"))));

  const steps = r.legs?.flatMap(l => l.steps || []) || [];
  const ol = el("ol", { class: "steps" });
  if(st.mode === "TRANSIT"){
    // Merge consecutive walking steps into one "徒歩 N分" row.
    let walk = null;
    const flush = () => {
      if(walk && walk.sec > 0) ol.append(el("li", { class: "step walk" }, el("span", { class: "kind" }, "徒歩"),
        el("div", { class: "body" }, el("span", {}, `${fmtMin(walk.sec)}（${fmtDist(walk.m)}）`))));
      walk = null;
    };
    for(const x of steps){
      if(x.travelMode !== "TRANSIT"){
        walk = walk || { sec: 0, m: 0 };
        walk.sec += secs(x.staticDuration); walk.m += x.distanceMeters || 0;
        continue;
      }
      flush();
      const t = x.transitDetails || {}, line = t.transitLine || {};
      const vehicle = line.vehicle?.name?.text || "電車";
      const color = line.color || "#23466E";
      const dep = t.localizedValues?.departureTime?.time?.text || "";
      const arr = t.localizedValues?.arrivalTime?.time?.text || "";
      ol.append(el("li", { class: "step transit" },
        el("span", { class: "kind", style: `background:${color};color:${line.textColor || "#fff"}` }, vehicle),
        el("div", { class: "body" },
          el("span", { class: "line" }, line.nameShort || line.name || vehicle, t.headsign ? `（${t.headsign}行き）` : ""),
          el("span", {}, `${dep} ${t.stopDetails?.departureStop?.name || ""} 発`),
          el("span", {}, `${arr} ${t.stopDetails?.arrivalStop?.name || ""} 着`),
          el("small", {}, [t.stopCount ? `${t.stopCount}駅` : "", fmtMin(secs(x.staticDuration))].filter(Boolean).join("・")))));
    }
    flush();
  }else{
    for(const x of steps){
      const ins = x.navigationInstruction?.instructions;
      if(!ins) continue;
      ol.append(el("li", { class: "step walk" }, el("span", { class: "kind" }, fmtDist(x.distanceMeters || 0)),
        el("div", { class: "body" }, el("span", {}, ins))));
    }
  }
  w.append(ol, nav);
  return w;
}

// ================= share =================
function shareText(s){
  const lines = [`${s.name}${s.area ? `（${s.area}）` : ""}`];
  const sub = [s.genre, s.rating ? "★".repeat(s.rating) : ""].filter(Boolean).join(" ");
  if(sub) lines.push(sub);
  if(s.memo) lines.push(s.memo);
  return lines.join("\n");
}
async function shareShop(s){
  const text = shareText(s), url = mapsUrl(s);
  if(navigator.share){
    try{ await navigator.share({ title: s.name, text, url }); return; }
    catch(e){ if(e?.name === "AbortError") return; }
  }
  try{ await navigator.clipboard.writeText(text + "\n" + url); toast("紹介文とリンクをコピーしました"); }
  catch{ toast("共有できませんでした"); }
}

// ================= photo viewer =================
function openViewer(photos, start){
  let i = start;
  const root = $("#viewer");
  const close = () => root.replaceChildren();
  const show = () => {
    const p = photos[i];
    root.replaceChildren(el("div", { class: "viewer", role: "dialog", "aria-modal": "true", "aria-label": "写真",
      onclick: e => { if(e.target.classList.contains("viewer")) close(); } },
      photoImg(p.id, { alt: p.label }),
      el("div", { class: "cap" }, `${p.label}　${i + 1} / ${photos.length}`),
      el("div", { class: "nav" },
        photos.length > 1 ? el("button", { type: "button", onclick: () => { i = (i - 1 + photos.length) % photos.length; show(); } }, "前へ") : null,
        el("button", { type: "button", onclick: close }, "閉じる"),
        photos.length > 1 ? el("button", { type: "button", onclick: () => { i = (i + 1) % photos.length; show(); } }, "次へ") : null)));
  };
  show();
}
document.addEventListener("keydown", e => { if(e.key === "Escape") $("#viewer").replaceChildren(); });

// ================= form =================
let editingId = null;
let draft = null;
const dlg = $("#formDlg");

function openForm(shop){
  editingId = shop ? shop.id : null;
  $("#formTitle").textContent = shop ? "お店を編集" : "お店を記録";
  $("#f-name").value = shop?.name || "";
  $("#f-area").value = shop?.area || "";
  $("#f-memo").value = shop?.memo || "";
  $("#placeQ").value = "";
  $("#cands").replaceChildren();
  draft = {
    genre: shop?.genre || "", rating: shop?.rating || 0,
    photos: (shop?.photos || []).map(p => ({ ...p })), newPhotos: [], uploading: 0,
    place: shop && (hasLoc(shop) || shop.placeId) ? {
      placeId: shop.placeId || "", lat: shop.lat, lng: shop.lng, address: shop.address || "", mapsUrl: shop.mapsUrl || "", label: shop.address || "登録済みの位置",
    } : null,
  };
  renderChips(); renderPhotos(); renderPicked();
  dlg.showModal();
  if(!shop) $("#placeQ").focus();
}
function closeForm(saved){
  if(!saved && draft) dropPhotos(draft.newPhotos);   // photos added but never saved
  draft = null; editingId = null;
  if(dlg.open) dlg.close();
}
$("#addBtn").addEventListener("click", () => openForm(null));
$("#formClose").addEventListener("click", () => closeForm(false));
$("#formCancel").addEventListener("click", () => closeForm(false));
dlg.addEventListener("cancel", e => { e.preventDefault(); closeForm(false); });

function renderChips(){
  const ac = $("#areaChips"); ac.replaceChildren();
  for(const [a] of areas()){
    if(a === "エリア未設定") continue;
    ac.append(el("button", { type: "button", class: "chip", "aria-pressed": String($("#f-area").value === a),
      onclick: () => { $("#f-area").value = a; renderChips(); } }, a));
  }
  const gc = $("#genreChips"); gc.replaceChildren();
  for(const g of GENRES){
    gc.append(el("button", { type: "button", class: "chip", "aria-pressed": String(draft.genre === g),
      onclick: () => { draft.genre = draft.genre === g ? "" : g; renderChips(); } }, g));
  }
  const st = $("#stars"); st.replaceChildren();
  for(let i = 1; i <= 5; i++){
    st.append(el("button", { type: "button", class: i <= draft.rating ? "on" : "", "aria-label": `${i}つ星`,
      onclick: () => { draft.rating = draft.rating === i ? 0 : i; renderChips(); } }, "★"));
  }
}
$("#f-area").addEventListener("input", renderChips);

// --- place search (Places API) ---
function areaFromComponents(comps){
  const find = t => comps?.find(c => c.types?.includes(t))?.longText || "";
  // 福岡市の住所は「中央区 → 天神」の順。町名（天神・大名・博多駅前など）を優先します。
  return (find("sublocality_level_2") || find("sublocality_level_1") || find("locality")).replace(/[0-9０-９一二三四五六七八九十]+丁目$/, "");
}
const PLACE_FIELDS = ["id", "displayName", "formattedAddress", "location", "googleMapsURI", "addressComponents"];
const cleanAddr = a => (a || "").replace(/^日本、?\s*(〒\d{3}-\d{4}\s*)?/, "");
function searchBias(){
  const center = map ? map.getCenter().toJSON() : { lat: HOME.lat, lng: HOME.lng };
  return { center, radius: 20000 };
}
// Explain a Places failure in words the user can act on (the raw reason is kept for troubleshooting).
function placesErrorText(e){
  const raw = String(e?.message || e || "");
  if(/not.*(enabled|activated|been used)|API_NOT_ACTIVATED|SERVICE_DISABLED/i.test(raw))
    return "Google Cloud で「Places API (New)」が有効になっていません。APIライブラリで有効にしてください。";
  if(/referer|referrer|PERMISSION|denied|not authorized|blocked/i.test(raw))
    return "APIキーの制限で検索が止められています。キーの「ウェブサイトの制限」と「APIの制限」を確認してください。（詳細：" + raw.slice(0, 160) + "）";
  return "お店を検索できませんでした。（詳細：" + (raw.slice(0, 120) || "不明なエラー") + "）";
}
function candMsg(text, isErr){
  $("#cands").replaceChildren(el("li", {}, el("p", { class: isErr ? "cand-msg err" : "cand-msg" }, text)));
}
// Text search with a fallback to a minimal request, in case an option is rejected by the API version.
async function textSearch(textQuery){
  try{
    const { places } = await G.places.Place.searchByText({ textQuery, fields: PLACE_FIELDS, language: "ja", region: "jp", locationBias: searchBias() });
    return places || [];
  }catch(e){
    const { places } = await G.places.Place.searchByText({ textQuery, fields: PLACE_FIELDS, language: "ja" });
    return places || [];
  }
}
function showPlaces(places){
  const list = $("#cands");
  list.replaceChildren();
  if(!places.length){ candMsg("見つかりませんでした。「天神 〇〇」のように地名を足して試してください。"); return; }
  for(const p of places.slice(0, 6)){
    const name = p.displayName || "", addr = cleanAddr(p.formattedAddress);
    list.append(el("li", {}, el("button", { type: "button", onclick: () => pickPlace(p, name, addr) },
      el("span", {}, name), el("small", {}, addr))));
  }
}
async function searchPlaces(){
  const q = $("#placeQ").value.trim();
  if(!q){ $("#placeQ").focus(); return; }
  if(!G){ candMsg("地図の読み込みが終わっていません。少し待ってからもう一度押してください。", true); return; }
  acSeq++;   // cancel pending suggestions
  candMsg("検索中…");
  try{ showPlaces(await textSearch(q)); }
  catch(e){ console.error(e); candMsg(placesErrorText(e), true); }
}

// Suggestions while typing (Places Autocomplete).
let acSeq = 0, acTimer = null, acToken = null;
async function suggest(){
  const q = $("#placeQ").value.trim();
  const seq = ++acSeq;
  if(q.length < 2 || !G){ if(!q) $("#cands").replaceChildren(); return; }
  try{
    acToken = acToken || new G.places.AutocompleteSessionToken();
    const { suggestions } = await G.places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
      input: q, sessionToken: acToken, language: "ja", region: "jp", locationBias: searchBias(),
    });
    if(seq !== acSeq) return;
    const preds = (suggestions || []).map(s => s.placePrediction).filter(Boolean).slice(0, 6);
    const list = $("#cands"); list.replaceChildren();
    if(!preds.length){ candMsg("候補がありません。「検索」を押すと詳しく探します。"); return; }
    for(const pr of preds){
      const main = pr.mainText?.text || pr.text?.text || "", sub = cleanAddr(pr.secondaryText?.text);
      list.append(el("li", {}, el("button", { type: "button", onclick: async () => {
        candMsg("読み込み中…");
        try{
          const place = pr.toPlace();
          await place.fetchFields({ fields: PLACE_FIELDS });
          acToken = null;
          pickPlace(place, place.displayName || main, cleanAddr(place.formattedAddress) || sub);
        }catch(e){ console.error(e); candMsg(placesErrorText(e), true); }
      } }, el("span", {}, main), el("small", {}, sub))));
    }
  }catch(e){
    // Autocomplete unavailable: stay quiet here; the 検索 button reports the reason.
    console.error(e);
  }
}
function pickPlace(p, name, addr){
  const loc = p.location;
  draft.noAutoLoc = false;
  draft.place = { placeId: p.id, lat: loc.lat(), lng: loc.lng(), address: addr, mapsUrl: p.googleMapsURI || "", label: addr };
  if(!$("#f-name").value.trim() || editingId == null) $("#f-name").value = name;
  const area = areaFromComponents(p.addressComponents);
  if(area && !$("#f-area").value.trim()) $("#f-area").value = area;
  $("#cands").replaceChildren();
  renderChips(); renderPicked();
}
function renderPicked(){
  const box = $("#picked");
  if(!draft.place){ box.hidden = true; box.replaceChildren(); return; }
  box.hidden = false;
  box.replaceChildren(el("span", {}, "地図の位置：", draft.place.label || "設定済み"),
    el("button", { type: "button", class: "ghost small danger", onclick: () => { draft.place = null; draft.noAutoLoc = true; renderPicked(); } }, "外す"));
}
$("#placeSearch").addEventListener("click", searchPlaces);
$("#placeQ").addEventListener("keydown", e => { if(e.key === "Enter" && !e.isComposing && e.keyCode !== 229){ e.preventDefault(); searchPlaces(); } });
$("#placeQ").addEventListener("input", () => { clearTimeout(acTimer); acTimer = setTimeout(suggest, 300); });
$("#useHere").addEventListener("click", async () => {
  try{
    const p = await getPosition();
    draft.place = { placeId: "", lat: p.lat, lng: p.lng, address: "", mapsUrl: "", label: "今いる場所" };
    renderPicked();
    toast("今いる場所を登録します");
  }catch(e){ toast(e.message); }
});

// --- photos ---
async function shrink(file){
  try{
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise(r => c.toBlob(b => r(b || file), "image/jpeg", 0.85));
  }catch{ return file; }
}
async function addPhotos(files){
  const room = MAX_PHOTOS - draft.photos.length - draft.uploading;
  const list = [...files].slice(0, Math.max(0, room));
  if(files.length > list.length) toast(`写真は1軒につき${MAX_PHOTOS}枚までです`);
  for(const f of list){
    const d = draft;
    d.uploading++; renderPhotos();
    try{
      const blob = await shrink(f);
      const id = "p" + uid();
      await store.putPhoto(id, blob);
      d.newPhotos.push(id);
      d.photos.push({ id, label: d.photos.length === 0 ? "入口" : "その他" });
    }catch{ toast("写真を追加できませんでした"); }
    finally{ d.uploading--; if(draft === d) renderPhotos(); }
  }
}
function renderPhotos(){
  const g = $("#photoGrid"); g.replaceChildren();
  draft.photos.forEach((p, i) => {
    const sel = el("select", { "aria-label": "写真の種類", onchange: e => { p.label = e.target.value; } },
      PHOTO_LABELS.map(l => { const o = el("option", { value: l }, l); o.selected = l === p.label; return o; }));
    g.append(el("div", { class: "ph" }, photoImg(p.id, { alt: p.label }),
      el("button", { type: "button", class: "x", "aria-label": "この写真を外す", onclick: () => { draft.photos.splice(i, 1); renderPhotos(); } }, "×"),
      sel));
  });
  for(let i = 0; i < draft.uploading; i++) g.append(el("div", { class: "ph" }, el("div", { class: "wait" }, "追加中…")));
  if(draft.photos.length + draft.uploading < MAX_PHOTOS){
    const input = el("input", { type: "file", accept: "image/*", multiple: "", onchange: e => { addPhotos(e.target.files); e.target.value = ""; } });
    g.append(el("label", { class: "add-photo" }, el("b", {}, "＋"), "写真を追加", input));
  }
  $("#saveBtn").disabled = draft.uploading > 0;
}

// --- save ---
$("#shopForm").addEventListener("submit", async e => {
  e.preventDefault();
  const name = $("#f-name").value.trim();
  if(!name){ $("#f-name").focus(); return; }
  if(draft.uploading){ toast("写真の追加が終わるまでお待ちください"); return; }
  const prev = shops.find(s => s.id === editingId);
  let pl = draft.place;
  $("#saveBtn").disabled = true;
  if(!pl && !draft.noAutoLoc && G){
    // No place was picked from the search results: look the shop up by name so it still gets a pin.
    toast("地図上の場所を探しています…");
    pl = await lookupPlace(name, $("#f-area").value.trim());
    if(pl && !$("#f-area").value.trim() && pl.area) $("#f-area").value = pl.area;
  }
  const shop = {
    id: editingId || "s" + uid(),
    name, area: $("#f-area").value.trim(), genre: draft.genre, rating: draft.rating,
    memo: $("#f-memo").value.trim(),
    lat: pl && Number.isFinite(pl.lat) ? pl.lat : null, lng: pl && Number.isFinite(pl.lng) ? pl.lng : null,
    placeId: pl?.placeId || "", address: pl?.address || "", mapsUrl: pl?.mapsUrl || "",
    photos: draft.photos.map(p => ({ id: p.id, label: p.label })),
    createdAt: prev?.createdAt || Date.now(), updatedAt: Date.now(),
    locateTried: !pl,
  };
  try{
    await store.put(shop);
    const kept = new Set(shop.photos.map(p => p.id));
    dropPhotos([...(prev?.photos || []).map(p => p.id), ...draft.newPhotos].filter(id => !kept.has(id)));
    draft.newPhotos = [];
    shops = prev ? shops.map(s => s.id === shop.id ? shop : s) : [...shops, shop];
    toast((prev ? "更新しました" : "記録しました") + (hasLoc(shop) ? "" : "（地図上の場所は見つかりませんでした。「編集」でお店を検索して選んでください）"));
    closeForm(true);
    openDetail(shop.id, true);
  }catch{
    toast("保存できませんでした。端末の空き容量を確認してください。");
  }finally{ $("#saveBtn").disabled = false; }
});

// ================= menu: backup / key =================
const menu = $("#menu");
$("#menuBtn").addEventListener("click", () => {
  menu.hidden = !menu.hidden;
  $("#menuBtn").setAttribute("aria-expanded", String(!menu.hidden));
});
document.addEventListener("click", e => {
  if(!menu.hidden && !e.target.closest(".menu") && !e.target.closest("#menuBtn")){ menu.hidden = true; $("#menuBtn").setAttribute("aria-expanded", "false"); }
});
const blobToDataUrl = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });
$("#exportBtn").addEventListener("click", async () => {
  menu.hidden = true;
  toast("バックアップを作成しています…");
  const photos = {};
  for(const s of shops) for(const p of s.photos || []){
    const b = await store.getPhoto(p.id).catch(() => null);
    if(b) photos[p.id] = await blobToDataUrl(b);
  }
  const data = JSON.stringify({ app: "machi-techo", version: 1, exportedAt: new Date().toISOString(), shops, photos });
  const a = el("a", { href: URL.createObjectURL(new Blob([data], { type: "application/json" })), download: `machi-techo-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});
$("#importInput").addEventListener("change", async e => {
  const f = e.target.files[0]; e.target.value = ""; menu.hidden = true;
  if(!f) return;
  try{
    const j = JSON.parse(await f.text());
    if(j.app !== "machi-techo" || !Array.isArray(j.shops)) throw new Error();
    for(const [id, url] of Object.entries(j.photos || {})){
      await store.putPhoto(id, await (await fetch(url)).blob());
    }
    // Same id = same shop: the backup's version replaces this device's.
    for(const s of j.shops) if(s && s.id && s.name) await store.put(s);
    shops = await store.all();
    toast(`${j.shops.length}軒を読み込みました`);
    backToList();
  }catch{ toast("このファイルは読み込めませんでした"); }
});
$("#keyBtn").addEventListener("click", () => { menu.hidden = true; showSetup(); });

// ================= start =================
(async function start(){
  setSheet("peek");
  try{ shops = await store.all(); }catch{ shops = []; toast("端末に保存できない状態です（プライベートブラウズでは使えません）"); }
  renderPanel();
  initMap();
})();
