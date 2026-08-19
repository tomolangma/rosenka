'use strict';

/* localStorage キャッシュ（容量超過時は古い校正キャッシュを半分捨てて再試行） */
const rkCache = {
  get: async k => {
    try {
      const v = localStorage.getItem('rk_' + k);
      return v ? JSON.parse(v) : null;
    } catch (e) {
      return null;
    }
  },
  set: async (k, v) => {
    const s = JSON.stringify(v);
    try {
      localStorage.setItem('rk_' + k, s);
    } catch (e) {
      const keys = Object.keys(localStorage).filter(
        x => x.startsWith('rk_geo_') || x.startsWith('rk_calib_') || x.startsWith('rk_towns_')
      );
      keys.slice(0, Math.ceil(keys.length / 2)).forEach(x => localStorage.removeItem(x));
      try {
        localStorage.setItem('rk_' + k, s);
      } catch (e2) { /* ignore */ }
    }
  }
};

/* 旧校正キャッシュを破棄（初回のみ） */
try {
  if (!localStorage.getItem('rk_purged_calib_v18')) {
    Object.keys(localStorage)
      .filter(k =>
        /^rk_calib_main_/.test(k) ||
        /^rk_calib_v(?:[2-9]|1[0-7])_/.test(k) ||
        /^rk_geo_main_/.test(k) ||
        /^rk_geo_v(?:[2-9]|1[0-7])_/.test(k) ||
        /^rk_cities_main_/.test(k)
      )
      .forEach(k => localStorage.removeItem(k));
    localStorage.setItem('rk_purged_calib_v18', '1');
  }
} catch (_) { /* ignore */ }

const DEFAULT_MAP = { lat: 35.50715, lon: 139.61745, zoom: 15, label: '新横浜駅' };

const rkMap = L.map('rkmap').setView([DEFAULT_MAP.lat, DEFAULT_MAP.lon], DEFAULT_MAP.zoom);
L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', {
  maxZoom: 18,
  attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>'
}).addTo(rkMap);
L.control.scale({ imperial: false }).addTo(rkMap);
setTimeout(() => rkMap.invalidateSize(), 0);

const rkGrid = L.layerGroup().addTo(rkMap);
let rkMarker = null;
const rk = { grid: [], meta: null, current: null, busy: false, year: null, yearBusy: false, baseStatus: '', candidates: [], tokyoWards: null, point: null };

function rkIsTokyoContext() {
  if (rk.tokyoWards && rk.tokyoWards.length) return true;
  if (!rk.meta) return false;
  const city = rk.meta.muniCity || rk.meta.city;
  return !!(RosenkaCore.isTokyoSpecialWard && RosenkaCore.isTokyoSpecialWard(rk.meta.pref, city));
}

function rkPointInBbox(lat, lon, bbox, pad) {
  pad = pad || 0;
  return bbox[0] - pad <= lat && lat <= bbox[2] + pad &&
    bbox[1] - pad <= lon && lon <= bbox[3] + pad;
}

/** 保存中の調査地点を含む、指定区の図郭を返す */
function rkSheetAtPointForWard(wardName) {
  if (!rk.point || !wardName) return null;
  const { lat, lng } = rk.point;
  const pad = 0.00015;
  const wr = (rk.tokyoWards || []).find(w => w.city === wardName || w.muniCity === wardName);
  const pool = (wr && wr.grid && wr.grid.length)
    ? wr.grid.map(g => Object.assign({}, g, { ward: wr.city, city: wr.city, cityPage: wr.cityPage, id: g.id || (wr.city + ':' + g.sheet) }))
    : rk.grid.filter(g => (g.ward || g.city) === wardName);
  const hits = pool.filter(g => rkPointInBbox(lat, lng, g.bbox, pad));
  if (!hits.length) return null;
  hits.sort((a, b) => {
    const da = Math.hypot((a.bbox[0] + a.bbox[2]) / 2 - lat, (a.bbox[1] + a.bbox[3]) / 2 - lng);
    const db = Math.hypot((b.bbox[0] + b.bbox[2]) / 2 - lat, (b.bbox[1] + b.bbox[3]) / 2 - lng);
    return da - db;
  });
  return hits[0];
}

/* Googleマップ（約1/500）
   埋め込みは maps.google.com の t= で切替: h=航空+ラベル / k=航空のみ */
const gmap = {
  lat: DEFAULT_MAP.lat,
  lon: DEFAULT_MAP.lon,
  label: DEFAULT_MAP.label,
  targetScale: 500,
  labels: true,
  lastSrc: ''
};

function gmapType() {
  return gmap.labels ? 'h' : 'k';
}

function gmapZoomForScale(lat, scale) {
  // 画面96dpi想定: 1px の紙上長さ = 0.0254/96 m
  // 縮尺 1:S ⇒ 1px が表す地上距離 = S * 0.0254/96 m
  const mPerPx = (scale || 500) * 0.0254 / 96;
  const cos = Math.cos((lat * Math.PI) / 180);
  const z = Math.log2((156543.03392 * Math.max(0.2, cos)) / mPerPx);
  return Math.min(21, Math.max(1, Math.round(z)));
}

function gmapApproxScale(lat, zoom) {
  const mPerPx = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
  return Math.round(mPerPx * 96 / 0.0254);
}

function gmapSetFocus(lat, lon, label) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  gmap.lat = lat;
  gmap.lon = lon;
  if (label) gmap.label = label;
  const pane = $id('tab-gmap');
  if (pane && pane.classList.contains('on')) gmapRefresh(false);
  else gmapUpdateLabels();
}

function gmapUpdateLabels() {
  const z = gmapZoomForScale(gmap.lat, gmap.targetScale);
  const approx = gmapApproxScale(gmap.lat, z);
  const scaleEl = $id('gmapScaleLabel');
  const posEl = $id('gmapPosLabel');
  const openEl = $id('gmapOpen');
  if (scaleEl) scaleEl.textContent = '縮尺 約 1/' + approx;
  if (posEl) {
    posEl.textContent = (gmap.label ? gmap.label + ' ｜ ' : '') +
      gmap.lat.toFixed(5) + ', ' + gmap.lon.toFixed(5);
  }
  if (openEl) {
    openEl.href = 'https://www.google.com/maps?q=' + gmap.lat + ',' + gmap.lon +
      '&z=' + z + '&t=' + gmapType() + '&hl=ja';
  }
}

function gmapEmbedSrc(z) {
  // maps.google.com のレガシー埋め込みが t=k / t=h を確実に解釈する
  return 'https://maps.google.com/maps?ll=' + gmap.lat + ',' + gmap.lon +
    '&q=' + gmap.lat + ',' + gmap.lon +
    '&z=' + z +
    '&t=' + gmapType() +
    '&hl=ja&output=embed';
}

function gmapRefresh(force) {
  const z = gmapZoomForScale(gmap.lat, gmap.targetScale);
  const src = gmapEmbedSrc(z);
  gmapUpdateLabels();
  const frame = $id('gmapFrame');
  if (!frame) return;
  if (!force && gmap.lastSrc === src) return;
  // 地図種別の変更を確実に反映するため iframe を作り直す
  const neu = frame.cloneNode(false);
  neu.id = 'gmapFrame';
  neu.title = 'Googleマップ';
  neu.allowFullscreen = true;
  neu.setAttribute('loading', 'lazy');
  neu.setAttribute('referrerpolicy', 'no-referrer-when-downgrade');
  neu.src = src;
  frame.parentNode.replaceChild(neu, frame);
  gmap.lastSrc = src;
}

/* ===== 道路種別 / 用途地域 / 土砂災害マップ（関連マップタブ）
   config/maps.json の登録簿から、地点の市区町村 → 都道府県 → 全国 の順に地図を選ぶ。
   市区町村を優先するのは maps.json の muniFirstPrefs に挙げた都道府県のみ。 */
const GIS_TYPES = { road: '道路種別', zoning: '用途地域', sediment: '土砂災害マップ' };
const GIS_SEARCH = {
  road: '建築基準法 道路種別 指定道路図',
  zoning: '用途地域 都市計画情報 地図',
  sediment: '土砂災害警戒区域 ハザードマップ'
};
const GIS_LEVEL_LABEL = { muni: '市区町村', pref: '都道府県', national: '全国' };
const GIS_TYPE_ORDER = ['road', 'zoning', 'sediment'];

const gis = {
  reg: null,
  lat: DEFAULT_MAP.lat,
  lon: DEFAULT_MAP.lon,
  pref: '',
  city: '',
  zoom: 16,
  mps: 2500
};

function gisEnsureWorldGeodetic(url) {
  // わが街ガイド系は gprj 未指定だと日本測地系扱いになり、
  // 世界測地系（左地図・Googleと同じ）の緯度経度を渡すと北西へ約450mずれる。
  // 公式の「リンクを作成」は gprj=3（世界測地系）を付ける。
  let u = String(url || '');
  if (!u || /[?&]gprj=/i.test(u)) return u;
  if (!/(?:wagmap\.jp|city\.yokohama\.lg\.jp\/[^?]*\/Map)/i.test(u)) return u;
  if (!/[?&]mp[xy]=/i.test(u)) return u;
  return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'gprj=3';
}

function gisFill(url) {
  const lat = Number(gis.lat);
  const lon = Number(gis.lon);
  const latS = Number.isFinite(lat) ? String(lat) : '';
  const lonS = Number.isFinite(lon) ? String(lon) : '';
  let u = gisEnsureWorldGeodetic(url);
  return u
    .replace(/\{lat\}/g, latS)
    .replace(/\{lon\}/g, lonS)
    .replace(/\{lng\}/g, lonS)
    .replace(/\{z\}/g, gis.zoom)
    .replace(/\{mps\}/g, gis.mps);
}

function gisHasLocation(url) {
  return /\{lat\}|\{lon\}|\{lng\}|\{z\}|\{mps\}/.test(String(url || ''));
}

function gisPick(map) {
  if (!map || !gis.city) return null;
  if (map[gis.city]) return map[gis.city];
  // maps.json は「横浜市」単位、GSIは「横浜市緑区」など区付きで来るため
  // 前方一致（市区）と末尾一致（区名）の両方を許し、最長キーを優先する。
  // includes は使わない（港南区⊃南区 のような誤爆を避ける）。
  const keys = Object.keys(map)
    .filter(k => {
      if (!k) return false;
      if (gis.city === k) return true;
      if (gis.city.startsWith(k)) return true; // 横浜市緑区 → 横浜市
      if (gis.city.endsWith(k)) return true;   // …区 キー向け
      if (k.endsWith(gis.city)) return true;
      return false;
    })
    .sort((a, b) => b.length - a.length);
  return keys.length ? map[keys[0]] : null;
}

/* 優先度順（市区町村 → 都道府県 → 全国） */
function gisEntries(type) {
  const r = gis.reg;
  if (!r) return [];
  const out = [];
  const muniFirst = (r.muniFirstPrefs || []).includes(gis.pref);
  if (muniFirst) {
    const e = gisPick(r.muni && r.muni[gis.pref]);
    if (e && e[type]) out.push(Object.assign({ level: 'muni', area: gis.city }, e[type]));
  }
  const p = r.pref && r.pref[gis.pref];
  if (p && p[type]) out.push(Object.assign({ level: 'pref', area: gis.pref }, p[type]));
  const n = r.national && r.national[type];
  if (n) out.push(Object.assign({ level: 'national', area: '全国' }, n));
  return out;
}

function gisSearchUrl(type) {
  const q = (gis.pref + gis.city + ' ' + GIS_SEARCH[type]).trim();
  return 'https://www.google.com/search?q=' + encodeURIComponent(q);
}

function gisRenderHub() {
  const whereEl = $id('mapsHubWhere');
  const coordEl = $id('mapsHubCoord');
  const listEl = $id('mapsHubList');
  if (!listEl) return;
  const where = (gis.pref + gis.city) || '現在地';
  if (whereEl) whereEl.textContent = where;
  if (coordEl) {
    coordEl.textContent = Number.isFinite(gis.lat) && Number.isFinite(gis.lon)
      ? gis.lat.toFixed(5) + ', ' + gis.lon.toFixed(5)
      : '';
  }

  listEl.innerHTML = GIS_TYPE_ORDER.map(type => {
    const list = gisEntries(type);
    const title = GIS_TYPES[type];
    if (!list.length) {
      return (
        '<section class="maps-card">' +
        '<h3>' + escHtml(title) + '</h3>' +
        '<p class="maps-card-note">' + escHtml(where) + ' の登録がありません。</p>' +
        '<div class="maps-card-actions">' +
        '<a class="maps-btn maps-btn-ghost" href="' + gisSearchUrl(type) +
        '" target="_blank" rel="noopener">公開先を検索 ↗</a>' +
        '</div></section>'
      );
    }
    const buttons = list.map(e => {
      const loc = gisHasLocation(e.url);
      const level = GIS_LEVEL_LABEL[e.level] || e.level;
      const area = e.level === 'muni' && e.area ? '（' + e.area + '）' : '';
      const badge = loc
        ? '<span class="maps-badge on">位置送信可</span>'
        : '<span class="maps-badge">位置固定なし</span>';
      const kind = e.pdf ? 'PDF' : '地図';
      // href はクリック時に現在地点で組み立てる（描画時点の古い座標を送らない）
      return (
        '<a class="maps-btn" href="' + escHtml(gisFill(e.url)) + '" target="_blank" rel="noopener" data-maps-tpl="' +
        escHtml(e.url) + '" title="' +
        escHtml(e.name) + '">' +
        '<span class="maps-btn-main">' + escHtml(level + area) + 'を開く ↗</span>' +
        '<span class="maps-btn-sub">' + escHtml(e.name) +
        (e.pdf ? '（PDF）' : '') + '</span>' +
        badge +
        '<span class="maps-btn-kind">' + kind + '</span>' +
        '</a>'
      );
    }).join('');
    return (
      '<section class="maps-card">' +
      '<h3>' + escHtml(title) + '</h3>' +
      '<div class="maps-card-actions">' + buttons + '</div>' +
      '</section>'
    );
  }).join('');
}

/* 地点の都道府県・市区町村を解決（路線価の結果があればそれを流用） */
function gisSyncFromLeftMap() {
  // 左地図のマーカー／中心を優先（Googleは別系統のまま触らない）
  try {
    if (rkMarker && rkMarker.getLatLng) {
      const ll = rkMarker.getLatLng();
      if (Number.isFinite(ll.lat) && Number.isFinite(ll.lng)) {
        gis.lat = Number(ll.lat.toFixed(6));
        gis.lon = Number(ll.lng.toFixed(6));
        return;
      }
    }
    if (rkMap && rkMap.getCenter) {
      const c = rkMap.getCenter();
      if (Number.isFinite(c.lat) && Number.isFinite(c.lng)) {
        gis.lat = Number(c.lat.toFixed(6));
        gis.lon = Number(c.lng.toFixed(6));
      }
    }
  } catch (_) { /* ignore */ }
}

async function gisSetFocus(lat, lon, pref, city, opts) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  gis.lat = Number(lat.toFixed(6));
  gis.lon = Number(lon.toFixed(6));
  if (pref) gis.pref = pref;
  if (city) gis.city = city;
  gisRenderHub();
  if (pref && city) return;
  if (opts && opts.skipRev) return; // 起動時は通信しない
  try {
    const r = await RosenkaCore.revGeocode(gis.lat, gis.lon);
    if (!r || !r.muniCd) return;
    const m = (await RosenkaCore.getMuni(rkCache))[String(parseInt(r.muniCd, 10))];
    if (!m) return;
    gis.pref = m.pref;
    gis.city = m.city;
    gisRenderHub();
  } catch (_) { /* 解決できなければ全国版のまま */ }
}

function settingsReadForm() {
  const f = $id('settingsForm');
  if (!f) return null;
  return {
    map: {
      lat: Number(f.mapLat.value),
      lon: Number(f.mapLon.value),
      zoom: Number(f.mapZoom.value),
      label: String(f.mapLabel.value || '').trim()
    },
    gmap: {
      scale: Number(f.gmapScale.value),
      labels: !!f.gmapLabels.checked
    },
    gis: {
      zoom: Number(f.gisZoom.value),
      mps: Number(f.gisMps.value)
    }
  };
}

function settingsFillForm(s) {
  const f = $id('settingsForm');
  if (!f || !s) return;
  const m = s.map || {};
  const g = s.gmap || {};
  const gi = s.gis || {};
  if (Number.isFinite(Number(m.lat))) f.mapLat.value = Number(m.lat);
  if (Number.isFinite(Number(m.lon))) f.mapLon.value = Number(m.lon);
  if (Number.isFinite(Number(m.zoom))) f.mapZoom.value = Number(m.zoom);
  f.mapLabel.value = m.label != null ? String(m.label) : '';
  if (Number.isFinite(Number(g.scale))) f.gmapScale.value = Number(g.scale);
  f.gmapLabels.checked = g.labels !== false;
  if (Number.isFinite(Number(gi.zoom))) f.gisZoom.value = Number(gi.zoom);
  if (Number.isFinite(Number(gi.mps))) f.gisMps.value = Number(gi.mps);
}

function settingsApply(s) {
  if (!s) return;
  const m = s.map || {};
  const g = s.gmap || {};
  const gi = s.gis || {};
  const lat = Number(m.lat);
  const lon = Number(m.lon);
  const zoom = Number(m.zoom);
  if (Number.isFinite(Number(g.scale))) gmap.targetScale = Number(g.scale);
  if (typeof g.labels === 'boolean') gmap.labels = g.labels;
  if (Number.isFinite(Number(gi.zoom))) gis.zoom = Number(gi.zoom);
  if (Number.isFinite(Number(gi.mps))) gis.mps = Number(gi.mps);
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    const z = Number.isFinite(zoom) ? zoom : DEFAULT_MAP.zoom;
    rkMap.setView([lat, lon], z);
    if (rkMarker) rkMarker.remove();
    rkMarker = L.marker([lat, lon]).addTo(rkMap);
    if (m.label) rkMarker.bindPopup(String(m.label)).openPopup();
    gmapSetFocus(lat, lon, m.label || DEFAULT_MAP.label);
    gisSetFocus(lat, lon, null, null, { skipRev: true });
  } else {
    gmapUpdateLabels();
    gisRenderHub();
  }
}

function settingsStatus(msg, ok) {
  const el = $id('settingsStatus');
  if (!el) return;
  el.textContent = msg || '';
  el.dataset.ok = ok ? '1' : '0';
}

let gisRegPromise = null;
function gisEnsureReg() {
  if (gis.reg) return Promise.resolve(gis.reg);
  if (!gisRegPromise) {
    gisRegPromise = fetch('/config/maps.json')
      .then(r => r.json())
      .then(j => {
        gis.reg = j;
        return j;
      })
      .catch(() => {
        gisRegPromise = null;
        return null;
      });
  }
  return gisRegPromise;
}

(async () => {
  try {
    const s = await (await fetch('/config/settings.json')).json();
    settingsFillForm(s);
    settingsApply(s);
  } catch (_) {
    settingsFillForm({
      map: DEFAULT_MAP,
      gmap: { scale: gmap.targetScale, labels: gmap.labels },
      gis: { zoom: gis.zoom, mps: gis.mps }
    });
    gmapSetFocus(DEFAULT_MAP.lat, DEFAULT_MAP.lon, DEFAULT_MAP.label);
    gisSetFocus(DEFAULT_MAP.lat, DEFAULT_MAP.lon, null, null, { skipRev: true });
  }
})();

const $id = x => document.getElementById(x);
function rkStatus(_html) {
  /* 左地図上部のステータスバーは廃止 */
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

/* ── PDFビューア（pdf.js） ── */
const pv = {
  gen: 0, url: null, page: null, w: 0, h: 0,
  fit: 1, scale: 1, tx: 0, ty: 0,
  rscale: 0, rendering: false, pending: false,
  fallback: false
};
let pvLibP = null;

function pvLib() {
  if (!pvLibP) {
    pvLibP = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
      s.onload = () => {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
          'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        res(window.pdfjsLib);
      };
      s.onerror = () => rej(new Error('pdf.js load failed'));
      document.head.appendChild(s);
    });
  }
  return pvLibP;
}

function pvUseFrame(proxied) {
  $id('pvWrap').style.display = 'none';
  $id('pvZoom').style.display = 'none';
  const f = $id('pvFrame');
  if (!f.src.endsWith(proxied)) f.src = proxied;
  f.style.display = '';
}

function pvApply() {
  if (!pv.rscale) return;
  $id('pvWrap').style.transform =
    'translate(' + pv.tx + 'px,' + pv.ty + 'px) scale(' + (pv.scale / pv.rscale) + ')';
}

function pvFit() {
  const el = $id('rkpdf');
  const cw = el.clientWidth, ch = el.clientHeight;
  pv.fit = Math.min((cw - 20) / pv.w, (ch - 20) / pv.h);
  pv.scale = pv.fit;
  pv.tx = (cw - pv.w * pv.scale) / 2;
  pv.ty = (ch - pv.h * pv.scale) / 2;
}

async function pvRender() {
  if (!pv.page) return;
  if (pv.rendering) {
    pv.pending = true;
    return;
  }
  // 画面表示は軽め（PDF出力時は別途高解像度で描画）
  const dpr = Math.min(window.devicePixelRatio || 1, 1.25);
  const want = Math.min(pv.scale * dpr, Math.sqrt(3.5e6 / (pv.w * pv.h)));
  if (pv.rscale && Math.abs(want / pv.rscale - 1) < 0.2) return;
  pv.rendering = true;
  const gen = pv.gen;
  try {
    const off = document.createElement('canvas');
    off.width = Math.round(pv.w * want);
    off.height = Math.round(pv.h * want);
    await pv.page.render({
      canvasContext: off.getContext('2d'),
      viewport: pv.page.getViewport({ scale: want }),
      intent: 'display'
    }).promise;
    if (gen !== pv.gen) return;
    const c = $id('pvCanvas');
    c.width = off.width;
    c.height = off.height;
    c.getContext('2d').drawImage(off, 0, 0);
    pv.rscale = want;
    pvApply();
  } catch (_) { /* keep current */ }
  finally {
    pv.rendering = false;
    if (pv.pending) {
      pv.pending = false;
      pvRender();
    }
  }
}

let pvRenderTimer = null;
function pvRenderSoon() {
  clearTimeout(pvRenderTimer);
  pvRenderTimer = setTimeout(pvRender, 250);
}

function pvZoomAt(px, py, factor) {
  const s2 = Math.min(Math.max(pv.scale * factor, pv.fit * 0.5), pv.fit * 12);
  if (s2 === pv.scale) return;
  pv.tx = px - (px - pv.tx) * (s2 / pv.scale);
  pv.ty = py - (py - pv.ty) * (s2 / pv.scale);
  pv.scale = s2;
  pvApply();
  pvRenderSoon();
}

async function rkLoadPdf(url) {
  if (pv.url === url) return;
  pv.url = url;
  const gen = ++pv.gen;
  const proxied = '/api/rosenka-proxy?u=' + encodeURIComponent(url);
  if (pv.fallback) {
    pvUseFrame(proxied);
    return;
  }
  $id('pvLoad').style.display = '';
  try {
    const lib = await pvLib();
    const r = await fetch(proxied);
    if (!r.ok) throw new Error('fetch ' + r.status);
    const buf = await r.arrayBuffer();
    if (gen !== pv.gen) return;
    const doc = await lib.getDocument({ data: buf }).promise;
    if (gen !== pv.gen) return;
    if (doc.numPages > 1) {
      pvUseFrame(proxied);
      return;
    }
    const page = await doc.getPage(1);
    if (gen !== pv.gen) return;
    const vp = page.getViewport({ scale: 1 });
    pv.page = page;
    pv.w = vp.width;
    pv.h = vp.height;
    pv.rscale = 0;
    $id('pvFrame').style.display = 'none';
    $id('pvWrap').style.display = '';
    $id('pvZoom').style.display = '';
    pvFit();
    await pvRender();
  } catch (e) {
    if (gen !== pv.gen) return;
    if (!window.pdfjsLib) pv.fallback = true;
    pvUseFrame(proxied);
  } finally {
    if (gen === pv.gen) $id('pvLoad').style.display = 'none';
  }
}

(function () {
  const el = $id('rkpdf');
  const pointers = new Map();
  let drag = null, pinch = null, moved = 0;
  const pos = e => {
    const b = el.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  };

  el.addEventListener('pointerdown', e => {
    if (e.target.closest('.pv-controls') || $id('pvFrame').style.display !== 'none') return;
    try { el.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    pointers.set(e.pointerId, pos(e));
    moved = 0;
    if (pointers.size === 1) {
      drag = { x: e.clientX, y: e.clientY, tx: pv.tx, ty: pv.ty };
      pinch = null;
      el.classList.add('dragging');
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        scale: pv.scale, tx: pv.tx, ty: pv.ty,
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      };
      drag = null;
    }
  });

  el.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, pos(e));
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const s2 = Math.min(Math.max(pinch.scale * dist / pinch.dist, pv.fit * 0.5), pv.fit * 12);
      pv.tx = mid.x - (pinch.mid.x - pinch.tx) * (s2 / pinch.scale);
      pv.ty = mid.y - (pinch.mid.y - pinch.ty) * (s2 / pinch.scale);
      pv.scale = s2;
      pvApply();
      pvRenderSoon();
    } else if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
      pv.tx = drag.tx + dx;
      pv.ty = drag.ty + dy;
      pvApply();
    }
  });

  const up = e => {
    pointers.delete(e.pointerId);
    if (pointers.size === 1) {
      const p = [...pointers.values()][0];
      drag = {
        x: p.x + el.getBoundingClientRect().left,
        y: p.y + el.getBoundingClientRect().top,
        tx: pv.tx, ty: pv.ty
      };
      pinch = null;
    } else if (!pointers.size) {
      drag = null;
      pinch = null;
      el.classList.remove('dragging');
    }
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);

  el.addEventListener('wheel', e => {
    if ($id('pvFrame').style.display !== 'none') return;
    e.preventDefault();
    const p = pos(e);
    pvZoomAt(p.x, p.y, e.deltaY < 0 ? 1.18 : 1 / 1.18);
  }, { passive: false });

  el.addEventListener('dblclick', e => {
    if (e.target.closest('.pv-controls') || $id('pvFrame').style.display !== 'none') return;
    const p = pos(e);
    if (pv.scale > pv.fit * 1.5) {
      pvFit();
      pvApply();
      pvRenderSoon();
    } else {
      pvZoomAt(p.x, p.y, (pv.fit * 2.5) / pv.scale);
    }
  });

  $id('pvZin').onclick = () => pvZoomAt(el.clientWidth / 2, el.clientHeight / 2, 1.4);
  $id('pvZout').onclick = () => pvZoomAt(el.clientWidth / 2, el.clientHeight / 2, 1 / 1.4);
  $id('pvFitBtn').onclick = () => {
    if (pv.page) {
      pvFit();
      pvApply();
      pvRenderSoon();
    }
  };

  window.addEventListener('resize', () => {
    if (!pv.page || $id('rkpdf').style.display === 'none') return;
    const wasFit = Math.abs(pv.scale / pv.fit - 1) < 0.01;
    const el2 = $id('rkpdf');
    const oldFit = pv.fit;
    pv.fit = Math.min((el2.clientWidth - 20) / pv.w, (el2.clientHeight - 20) / pv.h);
    if (wasFit) {
      pvFit();
      pvApply();
      pvRenderSoon();
    } else if (oldFit) {
      pvApply();
    }
  });
})();

function rkSetPdfPane(item) {
  $id('rkpdf').style.display = '';
  $id('rkempty').style.display = 'none';
  rkLoadPdf(item.pdf);
  $id('rkPdfNew').style.display = '';
  rkUpdatePdfButton();
  $id('rkNta').href = item.page;
  $id('rkNta').style.display = '';
}

function rkShowPdf(item) {
  rk.current = item;
  rkApplyYear(item);
  $id('rkYearToggle').style.display = '';
  $id('rkDirpad').style.display = '';
  rkDrawGrid();
  rkUpdatePdfButton();
  rkSyncWardPick(item);
}

const rkWareki = y =>
  y.replace('main_r', '令和').replace(/^令和0/, '令和').replace('main_h', '平成');

function rkYearChain() {
  const y = rk.meta && rk.meta.year;
  const m = y && y.match(/^main_r(\d+)$/);
  if (!m) return y ? [y] : [];
  const list = [];
  for (let n = parseInt(m[1], 10); n >= 1; n--) list.push('main_r' + String(n).padStart(2, '0'));
  list.push('main_h30');
  return list;
}

function rkYearInfo(item, y) {
  const cur = rk.meta.year;
  return {
    pdf: item.pdf.replace('/' + cur + '/', '/' + y + '/'),
    page: item.page.replace('/' + cur + '/', '/' + y + '/'),
    cityPage: rk.meta.cityPage.replace('/' + cur + '/', '/' + y + '/'),
    wareki: rkWareki(y)
  };
}

async function rkGetTowns(y, cityBase, frPage, code) {
  const key = 'towns_' + y + '_' + code;
  const c = await rkCache.get(key);
  if (c) return c;
  const t = await RosenkaCore.getTowns(cityBase, frPage);
  await rkCache.set(key, t);
  return t;
}

async function rkYearIndexCheck(y, sheet) {
  const m = rk.meta.cityPage.match(/^(.*\/)(([a-z]\d+)fr\.htm)$/);
  if (!m) return 'unknown';
  const curBase = m[1], frPage = m[2], code = m[3];
  const namesOf = (towns, s) => Object.keys(towns || {}).filter(n => (towns[n] || []).includes(s));
  let curTowns = null;
  const calib = await rkCache.get('calib_v3_' + rk.meta.year + '_' + code);
  if (calib && calib.towns) curTowns = calib.towns;
  if (!curTowns) curTowns = await rkGetTowns(rk.meta.year, curBase, frPage, code);
  const oldTowns = await rkGetTowns(y, curBase.replace('/' + rk.meta.year + '/', '/' + y + '/'), frPage, code);
  const cur = namesOf(curTowns, sheet), old = namesOf(oldTowns, sheet);
  if (!cur.length || !old.length) return 'unknown';
  return old.some(n => cur.includes(n)) ? 'ok' : 'mismatch';
}

async function rkApplyYear(item) {
  const chain = rkYearChain();
  const refreshZosei = () => {
    if (!rk.meta) return;
    rkResolveZosei(rk.meta).then(u => {
      if (u) { $id('rkZosei').href = u; $id('rkZosei').style.display = ''; }
    }).catch(() => {});
  };
  if (!rk.year || rk.year === chain[0] || !chain.includes(rk.year)) {
    rk.year = null;
    rkSetPdfPane(item);
    rkYearUI();
    if (rk.baseStatus) rkStatus(rk.baseStatus);
    refreshZosei();
    return;
  }
  const y = rk.year;
  const p = rkYearInfo(item, y);
  let ok = false, check = 'unknown';
  try {
    const [r, chk] = await Promise.all([
      fetch('/api/rosenka-proxy?u=' + encodeURIComponent(p.pdf)),
      rkYearIndexCheck(y, item.sheet).catch(() => 'unknown')
    ]);
    ok = r.ok && (r.headers.get('content-type') || '').includes('pdf');
    check = chk;
  } catch (_) { /* fallback below */ }

  const idxLink =
    '<a href="' + p.cityPage + '" target="_blank" rel="noopener">' +
    escHtml(p.wareki) + '年分の町丁名索引 ↗</a>';

  if (ok && check !== 'mismatch') {
    $id('rkpdf').style.display = '';
    $id('rkempty').style.display = 'none';
    rkLoadPdf(p.pdf);
    $id('rkPdfNew').style.display = '';
    rkUpdatePdfButton();
    $id('rkNta').href = p.page;
    rkYearUI();
    rkStatus(
      check === 'ok'
        ? '<span class="badge ok">' + escHtml(p.wareki) + '年分を表示中 ✓</span> 図番号の対応が当時の索引と一致しています。 ' + idxLink
        : '<span class="badge warn">' + escHtml(p.wareki) + '年分を表示中（対応未確認）</span> 場所はPDF記載の地名でご確認ください。 ' + idxLink
    );
    refreshZosei();
    return;
  }

  rk.year = null;
  rkSetPdfPane(item);
  rkYearUI();
  const reason =
    check === 'mismatch'
      ? escHtml(p.wareki) + '年は図の割り方が異なります（同じ図番号が別の場所を指すため表示しません）'
      : 'この図の' + escHtml(p.wareki) + '年分が見つかりません';
  rkStatus('<span class="badge warn">' + reason + '</span> 最新分を表示しています。' + idxLink);
  refreshZosei();
}

function rkYearUI() {
  const chain = rkYearChain();
  const list = $id('rkYearList');
  if (!chain.length || !list) return;
  const cur = rk.year && chain.includes(rk.year) ? rk.year : chain[0];
  if (list.dataset.chain !== chain.join(',')) {
    list.innerHTML = '';
    chain.forEach(y => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.year = y;
      b.textContent = rkWareki(y) + '年分';
      b.onclick = () => rkSelectYear(y);
      list.appendChild(b);
    });
    list.dataset.chain = chain.join(',');
  }
  [...list.querySelectorAll('button')].forEach(b => {
    b.textContent = rkWareki(b.dataset.year) + '年分';
    b.classList.toggle('on', b.dataset.year === cur);
    b.disabled = !!rk.yearBusy;
  });
}

async function rkSelectYear(y) {
  if (!rk.current || rk.yearBusy) return;
  const chain = rkYearChain();
  if (!chain.includes(y)) return;
  rk.year = y === chain[0] ? null : y;
  rk.yearBusy = true;
  rkYearUI();
  try {
    await rkApplyYear(rk.current);
  } finally {
    rk.yearBusy = false;
    rkYearUI();
  }
}

function rkProgress(t) {
  if (t && String(t).indexOf('市区町村を特定中') === 0) {
    t = '市区町村を特定中… アクセスが多い時は時間がかかる時があります';
  }
  rkStatus((rk.earlyBadge ? rk.earlyBadge + ' ' : '') + '<span class="spinner"></span> ' + escHtml(t));
}

function rkOnEarly(e) {
  const first = e.sheets && e.sheets[0];
  if (!first) return;
  rkSetPdfPane(first);
  rk.earlyBadge =
    '<span class="badge ok">PDFを先に表示中</span> ' +
    escHtml(e.townMatch.name) + ' → ' + e.townMatch.sheets.join('・') + ' ｜';
  rkProgress('地図の枠を準備中…');
}

function rkSheetId(g) {
  if (!g) return '';
  return g.id || ((g.ward || g.city || '') + ':' + g.sheet);
}

function rkDrawGrid() {
  rkGrid.clearLayers();
  const curId = rkSheetId(rk.current);
  const candIds = new Set((rk.candidates || []).map(rkSheetId));
  for (const g of rk.grid) {
    const b = [[g.bbox[0], g.bbox[1]], [g.bbox[2], g.bbox[3]]];
    const id = rkSheetId(g);
    const isCur = curId && id === curId;
    const isCand = candIds.has(id);
    const rect = L.rectangle(b, {
      color: isCur ? '#095c5f' : isCand ? '#b45309' : '#6a7a84',
      weight: isCur ? 3 : isCand ? 2 : 1,
      fillColor: isCur ? '#0d7377' : isCand ? '#d97706' : '#6a7a84',
      fillOpacity: isCur ? 0.14 : isCand ? 0.08 : 0.03
    }).addTo(rkGrid);
    const label = (g.ward || g.city) ? (g.ward || g.city) + ' ' + g.sheet : g.sheet;
    rect.bindTooltip(label, { direction: 'center' });
    if (isCand || isCur) {
      rect.on('click', ev => {
        if (rkIsTokyoContext()) {
          // 特別区は地図クリック側で地点を毎回再調査する（図郭クリックでは切替えない）
          return;
        }
        if (ev && ev.originalEvent) L.DomEvent.stopPropagation(ev);
        const hit = rk.grid.find(x => rkSheetId(x) === id);
        if (hit) {
          rkShowPdf(hit);
          rkSyncWardPick(hit);
        }
      });
    }
  }
}

function rkFillWardPick(candidates, selected) {
  const wrap = $id('rkWardPickWrap');
  const sel = $id('rkWardPick');
  if (!wrap || !sel) return;
  if (!candidates || candidates.length < 2) {
    wrap.style.display = 'none';
    sel.innerHTML = '';
    return;
  }
  sel.innerHTML = candidates.map(c => {
    const id = rkSheetId(c);
    const mark = c.primary ? '★' : '';
    const label = mark + (c.muniCity || c.city || '') + ' ' + c.sheet;
    return '<option value="' + escHtml(id) + '"' +
      (selected && rkSheetId(selected) === id ? ' selected' : '') + '>' +
      escHtml(label) + '</option>';
  }).join('');
  wrap.style.display = '';
}

function rkSyncWardPick(item) {
  const sel = $id('rkWardPick');
  if (!sel || sel.style.display === 'none' && (!$id('rkWardPickWrap') || $id('rkWardPickWrap').style.display === 'none')) return;
  const id = rkSheetId(item);
  if (sel.value !== id && [...sel.options].some(o => o.value === id)) sel.value = id;
}

function rkOnWardPickChange() {
  const sel = $id('rkWardPick');
  if (!sel || !sel.value) return;
  const id = sel.value;
  const wardFromId = id.includes(':') ? id.split(':')[0] : '';
  // 特別区切替時は、常に同じ調査地点を含む図を選ぶ
  let hit = wardFromId ? rkSheetAtPointForWard(wardFromId) : null;
  if (!hit) hit = rk.grid.find(g => rkSheetId(g) === id);
  if (!hit && rk.candidates) hit = rk.candidates.find(g => rkSheetId(g) === id);
  if (!hit) return;
  if (rk.tokyoWards && hit.ward) {
    const wr = rk.tokyoWards.find(w => w.city === hit.ward || w.muniCity === hit.ward);
    if (wr && wr.grid && wr.grid.length) {
      const mergedExtra = (rk.candidates || []).filter(c => c.ward !== hit.ward);
      const byId = {};
      for (const g of wr.grid) {
        byId[rkSheetId(g) || (wr.city + ':' + g.sheet)] = Object.assign({}, g, {
          ward: wr.city, city: wr.city, cityPage: wr.cityPage
        });
      }
      for (const g of mergedExtra) byId[rkSheetId(g)] = g;
      rk.grid = Object.values(byId);
    }
    if (rk.meta) {
      rk.meta.city = wr ? wr.city : hit.ward;
      rk.meta.muniCity = wr ? wr.muniCity : (hit.muniCity || hit.ward);
      if (wr && wr.cityPage) rk.meta.cityPage = wr.cityPage;
      else if (hit.cityPage) rk.meta.cityPage = hit.cityPage;
      if (wr && wr.townMatch) rk.meta.townMatch = wr.townMatch;
      rk.meta.hit = hit.sheet;
    }
  }
  rkShowPdf(hit);
  rkSyncWardPick(hit);
}

const rkWardPickEl = $id('rkWardPick');
if (rkWardPickEl) rkWardPickEl.addEventListener('change', rkOnWardPickChange);

const rkCenter = g => [(g.bbox[0] + g.bbox[2]) / 2, (g.bbox[1] + g.bbox[3]) / 2];

function rkMoveDir(dir) {
  if (!rk.current) return;
  const curId = rkSheetId(rk.current);
  const curWard = rk.current.ward || rk.current.city || '';
  const c = rkCenter(rk.current);
  const h = rk.current.bbox[2] - rk.current.bbox[0];
  const w = rk.current.bbox[3] - rk.current.bbox[1];
  const target = {
    n: [c[0] + h, c[1]],
    s: [c[0] - h, c[1]],
    e: [c[0], c[1] + w],
    w: [c[0], c[1] - w]
  }[dir];
  let best = null, bestD = Infinity;
  // 同一区内を優先（東京で複数区の図郭が重なっているとき）
  const pool = rk.grid.filter(g => !curWard || (g.ward || g.city) === curWard);
  const search = pool.length > 1 ? pool : rk.grid;
  for (const g of search) {
    if (rkSheetId(g) === curId) continue;
    const gc = rkCenter(g);
    const d = Math.hypot((gc[0] - target[0]) / h, (gc[1] - target[1]) / w);
    if (d < bestD) {
      bestD = d;
      best = g;
    }
  }
  if (best && bestD < 0.6) {
    rkShowPdf(best);
    rkMap.panTo(rkCenter(best));
  }
}
document.querySelectorAll('#rkDirpad button').forEach(b => {
  b.onclick = () => rkMoveDir(b.dataset.dir);
});

/* ── 隣接PDFの切り貼り（ユーザーが方向を選択）
   ヘッダ（凡例・図番号）を除いた地図部分だけを結合し、元の1枚と同じ用紙サイズで出力する。 */
function rkSheetAt(lat, lng, excludeId) {
  const curWard = rk.current && (rk.current.ward || rk.current.city);
  let best = null, bestD = Infinity;
  for (const g of rk.grid) {
    if (excludeId && rkSheetId(g) === excludeId) continue;
    if (curWard && (g.ward || g.city) && (g.ward || g.city) !== curWard) continue;
    const [s, w, n, e] = g.bbox;
    if (lat >= s && lat <= n && lng >= w && lng <= e) return g;
    const cy = (s + n) / 2, cx = (w + e) / 2;
    const d = Math.hypot((lat - cy) / Math.max(1e-9, n - s), (lng - cx) / Math.max(1e-9, e - w));
    if (d < bestD) { bestD = d; best = g; }
  }
  return bestD < 0.75 ? best : null;
}

function rkNeighbor(sheet, dLat, dLng) {
  if (!sheet) return null;
  const [s, w, n, e] = sheet.bbox;
  const h = Math.max(1e-9, n - s);
  const ww = Math.max(1e-9, e - w);
  const lat = dLat > 0 ? n + h * 0.05 : dLat < 0 ? s - h * 0.05 : (s + n) / 2;
  const lng = dLng > 0 ? e + ww * 0.05 : dLng < 0 ? w - ww * 0.05 : (w + e) / 2;
  return rkSheetAt(lat, lng, rkSheetId(sheet));
}

function rkActivePdfUrl(g) {
  if (!g) return '#';
  if (rk.year && rk.meta && rk.year !== rk.meta.year) {
    return g.pdf.replace('/' + rk.meta.year + '/', '/' + rk.year + '/');
  }
  return g.pdf;
}

/** dir: '' | n/s/e/w | ne/nw/se/sw */
function rkStitchPlan(dir) {
  const cur = rk.current;
  if (!cur) return null;
  if (!dir) {
    return { sheets: [cur], cols: 1, rows: 1, mode: 'single', label: 'この図のみ' };
  }
  const dLat = dir.includes('n') ? 1 : dir.includes('s') ? -1 : 0;
  const dLng = dir.includes('e') ? 1 : dir.includes('w') ? -1 : 0;
  if (dLat && dLng) {
    const b = rkNeighbor(cur, 0, dLng);
    const c = rkNeighbor(cur, dLat, 0);
    const d = rkNeighbor(cur, dLat, dLng);
    if (!b || !c || !d) return null;
    const south = dLat > 0 ? [cur, b] : [c, d];
    const north = dLat > 0 ? [c, d] : [cur, b];
    const ord = row => (dLng > 0 ? row : row.slice().reverse());
    const names = { ne: '北東', nw: '北西', se: '南東', sw: '南西' };
    return {
      sheets: [...ord(south), ...ord(north)],
      cols: 2, rows: 2, mode: 'quad',
      label: names[dir] + '（4枚結合）'
    };
  }
  if (dLat) {
    const nb = rkNeighbor(cur, dLat, 0);
    if (!nb) return null;
    return {
      sheets: dLat > 0 ? [cur, nb] : [nb, cur],
      cols: 1, rows: 2, mode: 'v',
      label: (dLat > 0 ? '北' : '南') + '（2枚結合）'
    };
  }
  if (dLng) {
    const nb = rkNeighbor(cur, 0, dLng);
    if (!nb) return null;
    return {
      sheets: dLng > 0 ? [cur, nb] : [nb, cur],
      cols: 2, rows: 1, mode: 'h',
      label: (dLng > 0 ? '東' : '西') + '（2枚結合）'
    };
  }
  return null;
}

function rkNeighborAvailability() {
  const cur = rk.current;
  if (!cur) return {};
  const n = !!rkNeighbor(cur, 1, 0);
  const s = !!rkNeighbor(cur, -1, 0);
  const e = !!rkNeighbor(cur, 0, 1);
  const w = !!rkNeighbor(cur, 0, -1);
  return {
    n, s, e, w,
    ne: n && e && !!rkNeighbor(cur, 1, 1),
    nw: n && w && !!rkNeighbor(cur, 1, -1),
    se: s && e && !!rkNeighbor(cur, -1, 1),
    sw: s && w && !!rkNeighbor(cur, -1, -1)
  };
}

function rkUpdatePdfButton() {
  const btn = $id('rkPdfNew');
  if (!btn || !rk.current) return;
  btn.textContent = 'PDF';
  btn.title = 'PDFを開く／隣接図と切り貼り';
  btn.href = '#';
  btn.removeAttribute('target');
}

function rkOpenStitchDialog() {
  const dlg = $id('rkStitchDlg');
  if (!dlg || !rk.current) return;
  const avail = rkNeighborAvailability();
  dlg.querySelectorAll('.rk-stitch-pad button[data-need]').forEach(b => {
    const need = b.dataset.need;
    b.disabled = !avail[need];
  });
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
}

async function rkRenderPdfPage(url, scale) {
  const lib = await pvLib();
  const r = await fetch('/api/rosenka-proxy?u=' + encodeURIComponent(url));
  if (!r.ok) throw new Error('PDF取得失敗 ' + r.status);
  const buf = await r.arrayBuffer();
  const doc = await lib.getDocument({ data: buf }).promise;
  const page = await doc.getPage(1);
  const vp1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: scale || 1.5 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, intent: 'print' }).promise;
  return { canvas, pageW: vp1.width, pageH: vp1.height };
}

/** 地図部分の上下位置（ヘッダとの境界線・下枠線）を検出する */
function rkMapBand(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const data = ctx.getImageData(0, 0, w, h).data;
  const darkFrac = y => {
    let dark = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if ((data[i] + data[i + 1] + data[i + 2]) / 3 < 80) dark++;
    }
    return dark / w;
  };
  let top = Math.round(h * 0.136);
  for (let y = Math.floor(h * 0.05); y < h * 0.35; y++) {
    if (darkFrac(y) > 0.5) {
      top = y + 1;
      break;
    }
  }
  let bottom = h;
  for (let y = h - 1; y > h * 0.7; y--) {
    if (darkFrac(y) > 0.5) {
      bottom = y;
      break;
    }
  }
  return { top, bottom, height: Math.max(1, bottom - top) };
}

function rkLoadJsPdf() {
  if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
    s.onload = () => res(window.jspdf.jsPDF);
    s.onerror = () => rej(new Error('jsPDF load failed'));
    document.head.appendChild(s);
  });
}

async function rkDownloadStitchedPdf(plan) {
  const loadEl = $id('pvLoad');
  const prev = loadEl ? loadEl.style.display : 'none';
  if (loadEl) {
    loadEl.style.display = '';
    loadEl.innerHTML = '<span class="spinner"></span> 地図を切り貼り中…';
  }
  try {
    const rendered = [];
    for (const g of plan.sheets) {
      rendered.push(await rkRenderPdfPage(rkActivePdfUrl(g), 4));
    }
    const pageW = rendered[0].pageW;
    const pageH = rendered[0].pageH;
    const cols = plan.cols || 1;
    const rows = plan.rows || 1;
    const curIdx = Math.max(0, plan.sheets.findIndex(g => rk.current && g.sheet === rk.current.sheet));
    const base = rendered[curIdx];
    const bands = rendered.map(r => rkMapBand(r.canvas));
    const band = bands[curIdx];
    // 各図の地図帯の左右余白を削ってから結合（左 1px / 右 px）
    const trimL = 1;
    const trimR = 5;
    const cellW = Math.max(1, base.canvas.width - trimL - trimR);
    const cellH = band.height;
    // 上下の継ぎ目だけわずかに詰める
    const overlapX = 0;
    const overlapY = rows > 1 ? 1 : 0;

    const stitched = document.createElement('canvas');
    stitched.width = cellW * cols - overlapX * (cols - 1);
    stitched.height = cellH * rows - overlapY * (rows - 1);
    const sctx = stitched.getContext('2d');
    sctx.fillStyle = '#fff';
    sctx.fillRect(0, 0, stitched.width, stitched.height);
    rendered.forEach((r, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const dx = col * (cellW - overlapX);
      // sheets は南→北。キャンバスは上が北なので行を反転
      const dy = (rows - 1 - row) * (cellH - overlapY);
      const srcW = Math.max(1, r.canvas.width - trimL - trimR);
      sctx.drawImage(
        r.canvas,
        trimL, bands[i].top, srcW, bands[i].height,
        dx, dy, cellW, cellH
      );
    });

    // 縮小せず等倍のまま、結合箇所（結合画像の中心）を中央にして1枚分だけ切り出す。
    // ヘッダ・フッタは元の版のまま。地図帯は左右余白を残した位置に戻す。
    const out = document.createElement('canvas');
    out.width = base.canvas.width;
    out.height = base.canvas.height;
    const octx = out.getContext('2d');
    octx.fillStyle = '#fff';
    octx.fillRect(0, 0, out.width, out.height);
    octx.drawImage(base.canvas, 0, 0);
    octx.drawImage(
      stitched,
      Math.round((stitched.width - cellW) / 2),
      Math.round((stitched.height - cellH) / 2),
      cellW, cellH,
      trimL, band.top, cellW, cellH
    );

    const jsPDF = await rkLoadJsPdf();
    const pdf = new jsPDF({
      orientation: pageW >= pageH ? 'landscape' : 'portrait',
      unit: 'pt',
      format: [pageW, pageH],
      compress: true
    });
    pdf.addImage(out.toDataURL('image/jpeg', 0.97), 'JPEG', 0, 0, pageW, pageH);
    const names = plan.sheets.map(g => g.sheet).join('_');
    pdf.save('rosenka_' + names + '.pdf');
  } finally {
    if (loadEl) {
      loadEl.style.display = prev;
      loadEl.innerHTML = '<span class="spinner"></span> PDFを読み込み中…';
    }
  }
}

$id('rkPdfNew').addEventListener('click', e => {
  e.preventDefault();
  if (!rk.current) return;
  rkOpenStitchDialog();
});

$id('rkStitchForm').addEventListener('submit', async e => {
  const submitter = e.submitter;
  const dir = submitter ? submitter.value : '';
  if (dir === '__cancel__') return;
  e.preventDefault();
  const dlg = $id('rkStitchDlg');
  if (dlg && dlg.open) dlg.close();

  // この図のみ → 元の路線価PDFを別タブで開く
  if (!dir) {
    window.open(rkActivePdfUrl(rk.current), '_blank', 'noopener');
    return;
  }

  const plan = rkStitchPlan(dir);
  if (!plan) {
    alert('選択した方向に隣接する路線価図が見つかりません。');
    return;
  }
  try {
    await rkDownloadStitchedPdf(plan);
  } catch (err) {
    alert('PDFの作成に失敗しました: ' + (err.message || err));
  }
});

async function rkResolveRatio(j) {
  const m = (j.cityPage || '').match(/^(.*\/)prices\/[a-z]\d+fr\.htm$/);
  if (!m) return null;
  const base = m[1] + 'ratios/';
  const key = 'ratios_' + j.year + '_' + j.pref;
  let list = await rkCache.get(key);
  if (!list) {
    const r = await fetch('/api/rosenka-proxy?u=' + encodeURIComponent(base + 'city_frm.htm'));
    if (!r.ok) return null;
    const html = new TextDecoder('shift_jis').decode(await r.arrayBuffer());
    list = [];
    for (const mm of html.matchAll(/href="(html\/[a-z]\d+rf\.htm)"[^>]*>\s*([^<]+)/g)) {
      list.push({ page: mm[1], name: mm[2].trim() });
    }
    if (list.length) await rkCache.set(key, list);
  }
  const hit =
    list.find(c => c.name === j.city) ||
    list
      .filter(c => j.city.includes(c.name) || c.name.includes(j.city))
      .sort((a, b) => b.name.length - a.name.length)[0];
  return hit ? base + hit.page : base + 'city_frm.htm';
}

/* 都道府県の「宅地造成費の金額表」リンク（pref_frm.htm から機械解決） */
async function rkResolveZosei(j) {
  const m = (j.cityPage || '').match(/^(https:\/\/www\.rosenka\.nta\.go\.jp\/)(main_[rh]\d+)\/([^/]+\/[^/]+\/)prices\/[a-z]\d+fr\.htm$/);
  if (!m) return null;
  const chain = rkYearChain();
  const yearDir = (rk.year && chain.includes(rk.year)) ? rk.year : (j.year || chain[0]);
  const prefRoot = m[1] + yearDir + '/' + m[3]; // .../main_rXX/bureau/pref/
  const key = 'zosei_' + yearDir + '_' + j.pref;
  let page = await rkCache.get(key);
  if (!page) {
    const r = await fetch('/api/rosenka-proxy?u=' + encodeURIComponent(prefRoot + 'pref_frm.htm'));
    if (!r.ok) return null;
    const html = new TextDecoder('shift_jis').decode(await r.arrayBuffer());
    for (const mm of html.matchAll(/href="(others\/[^"]+\.htm)"[^>]*>([^<]+)/g)) {
      if (mm[2].includes('宅地造成費')) {
        page = mm[1];
        break;
      }
    }
    if (!page) return null;
    await rkCache.set(key, page);
  }
  return prefRoot + page;
}

function rkRender(j, opts) {
  opts = opts || {};
  $id('rkRatio').style.display = 'none';
  $id('rkZosei').style.display = 'none';
  if (j.error && !j.grid) {
    let msg = '<span class="badge ng">エラー</span> ' + escHtml(j.error);
    if (j.townMatch) {
      msg += ' ｜ 町丁名索引: ' + escHtml(j.townMatch.name) + ' → ' + j.townMatch.sheets.join('・');
    }
    if (j.ratioPage) {
      msg +=
        ' <a href="' + j.ratioPage + '" target="_blank" rel="noopener">評価倍率表を開く ↗</a>';
    }
    rk.candidates = [];
    rk.tokyoWards = null;
    rkFillWardPick([]);
    rkStatus(msg);
    if (j.geocode) {
      if (rkMarker) rkMarker.remove();
      const pos = opts.latlng || [j.geocode.lat, j.geocode.lon];
      rkMarker = L.marker(pos).addTo(rkMap).bindPopup(escHtml(j.geocode.title || ''));
      if (opts.fit) rkMap.setView(pos, 15);
      const la = (opts.latlng && opts.latlng.lat != null) ? opts.latlng.lat : j.geocode.lat;
      const lo = (opts.latlng && opts.latlng.lng != null) ? opts.latlng.lng : j.geocode.lon;
      gmapSetFocus(la, lo, j.geocode.title);
      gisSetFocus(la, lo);
    }
    return;
  }

  rk.meta = j;
  rk.grid = j.grid || [];
  rk.candidates = j.candidates || [];
  rk.tokyoWards = j.tokyoWards || null;
  rk.current = null;
  if (j.geocode || opts.latlng) {
    const la = (opts.latlng && opts.latlng.lat != null) ? opts.latlng.lat : j.geocode.lat;
    const lo = (opts.latlng && opts.latlng.lng != null) ? opts.latlng.lng : j.geocode.lon;
    if (Number.isFinite(la) && Number.isFinite(lo)) rk.point = { lat: la, lng: lo };
  }
  if (rkMarker) rkMarker.remove();
  const pos = opts.latlng || [j.geocode.lat, j.geocode.lon];
  rkMarker = L.marker(pos).addTo(rkMap).bindPopup(escHtml(j.geocode.title || ''));
  const focusLat = (opts.latlng && opts.latlng.lat) || j.geocode.lat;
  const focusLon = (opts.latlng && opts.latlng.lng) || j.geocode.lon;
  gmapSetFocus(focusLat, focusLon, j.geocode && j.geocode.title);
  gisSetFocus(focusLat, focusLon, j.pref, j.muniCity || j.city);

  let dispSheet = j.hit;
  let dispId = null;
  if (j.candidates && j.candidates.length) {
    dispId = rkSheetId(j.candidates[0]);
    dispSheet = j.candidates[0].sheet;
  }
  if (j.townMatch && j.indexAgree === false && rk.grid.length) {
    const cand = rk.grid.filter(g => j.townMatch.sheets.includes(g.sheet));
    if (cand.length) {
      const inBox = cand.find(
        g =>
          g.bbox[0] <= pos[0] &&
          pos[0] <= g.bbox[2] &&
          g.bbox[1] <= pos[1] &&
          pos[1] <= g.bbox[3]
      );
      const pick =
        inBox ||
        cand
          .map(g => ({
            g,
            d:
              Math.pow((g.bbox[0] + g.bbox[2]) / 2 - pos[0], 2) +
              Math.pow((g.bbox[1] + g.bbox[3]) / 2 - pos[1], 2)
          }))
          .sort((a, b) => a.d - b.d)[0].g;
      if (pick && pick.sheet !== j.hit) {
        dispSheet = pick.sheet;
        dispId = rkSheetId(pick);
        j.indexCorrected = true;
      }
    }
  }

  const hit = dispId
    ? (rk.grid.find(g => rkSheetId(g) === dispId) || rk.grid.find(g => g.sheet === dispSheet))
    : rk.grid.find(g => g.sheet === dispSheet);
  rkFillWardPick(rk.candidates, hit);
  if (hit) {
    rkShowPdf(hit);
    if (opts.fit) {
      rkMap.fitBounds(
        [
          [hit.bbox[0], hit.bbox[1]],
          [hit.bbox[2], hit.bbox[3]]
        ],
        { padding: [40, 40] }
      );
    }
  } else {
    rkDrawGrid();
    if (opts.fit) rkMap.setView(pos, 16);
  }

  const parts = [];
  const pct = j.quality && j.quality.n ? Math.round((100 * j.quality.hit) / j.quality.n) : null;
  const healthy =
    (pct === null || pct >= 85) &&
    (!j.townMatch || j.indexAgree || j.indexCorrected) &&
    !j.error;
  const wareki = j.year.replace('main_r', '令和').replace(/^令和0/, '令和');
  if (j.pref) {
    const label = healthy
      ? '<span class="badge ok">表示中 ✓</span>'
      : '<span class="badge warn">表示中（位置は目安）</span>';
    parts.push(
      `${label} ${escHtml(j.pref + (j.muniCity || j.city))}${
        j.townMatch ? ' ' + escHtml(j.townMatch.name) : ''
      }（${escHtml(wareki)}年分・最新）`
    );
  }
  if (rk.candidates && rk.candidates.length > 1) {
    const names = [...new Set(rk.candidates.map(c => c.muniCity || c.city))];
    parts.push(
      '<span class="badge warn">複数候補</span> ' +
      escHtml(names.join('・')) +
      ' の図があります（「区・図」から選択）'
    );
  }
  if (j.error) parts.push('<span class="badge warn">注意</span> ' + escHtml(j.error));
  rk.baseStatus = parts.join(' ');
  rkStatus(rk.baseStatus);

  try {
    Object.keys(localStorage)
      .filter(k => {
        if (/^rk_calib_main_/.test(k)) return true;
        return /^rk_(calib_v2_|calib_v3_|geo_|geo_v3_|cities_|cities_v2_|ratios_|zosei_)/.test(k) && !k.includes(j.year);
      })
      .forEach(k => localStorage.removeItem(k));
  } catch (_) { /* ignore */ }

  rkResolveRatio(j)
    .then(u => {
      if (u && rk.meta === j) {
        $id('rkRatio').href = u;
        $id('rkRatio').style.display = '';
      }
    })
    .catch(() => {});

  rkResolveZosei(j)
    .then(u => {
      if (u && rk.meta === j) {
        $id('rkZosei').href = u;
        $id('rkZosei').style.display = '';
      }
    })
    .catch(() => {});
}

async function rkGo() {
  const q = $id('rkAddr').value.trim();
  if (!q || rk.busy) return;
  rk.busy = true;
  rk.earlyBadge = null;
  $id('rkGo').disabled = true;
  try {
    const j = await RosenkaCore.lookupAddress(q, rkCache, rkProgress, rkOnEarly);
    rk.earlyBadge = null;
    rkRender(j, { fit: true });
  } catch (e) {
    rkStatus('<span class="badge ng">エラー</span> ' + escHtml(e.message || String(e)));
  } finally {
    rk.busy = false;
    $id('rkGo').disabled = false;
  }
}

$id('rkGo').onclick = rkGo;
$id('rkAddr').addEventListener('keydown', e => {
  if (e.key === 'Enter') rkGo();
});

rkMap.on('click', async e => {
  const latlng = e.latlng;
  // 東京特別区は、図郭内でも毎回その地点で近隣区込みの路線価図を調べる
  const tokyoMode = rkIsTokyoContext();
  if (!tokyoMode) {
    const matches = rk.grid.filter(
      g =>
        latlng.lat >= g.bbox[0] &&
        latlng.lat <= g.bbox[2] &&
        latlng.lng >= g.bbox[1] &&
        latlng.lng <= g.bbox[3]
    );
    let g = null;
    if (matches.length) {
      const curWard = rk.current && (rk.current.ward || rk.current.city);
      const curId = rkSheetId(rk.current);
      g =
        matches.find(x => rkSheetId(x) === curId) ||
        (curWard && matches.find(x => (x.ward || x.city) === curWard)) ||
        (rk.candidates || []).map(c => matches.find(x => rkSheetId(x) === rkSheetId(c))).find(Boolean) ||
        matches[0];
    }
    if (g) {
      if (rkMarker) rkMarker.remove();
      rkMarker = L.marker(latlng).addTo(rkMap);
      rk.point = { lat: latlng.lat, lng: latlng.lng };
      gmapSetFocus(latlng.lat, latlng.lng);
      gisSetFocus(latlng.lat, latlng.lng);
      rkUpdatePdfButton();
      if (!rk.current || rkSheetId(rk.current) !== rkSheetId(g)) rkShowPdf(g);
      return;
    }
  }
  if (rk.busy) return;
  rk.busy = true;
  rk.earlyBadge = null;
  rk.point = { lat: latlng.lat, lng: latlng.lng };
  try {
    const j = await RosenkaCore.lookupPoint(latlng.lat, latlng.lng, rkCache, rkProgress, null, rkOnEarly);
    rk.earlyBadge = null;
    rkRender(j, { latlng });
  } catch (err) {
    rkStatus('<span class="badge ng">エラー</span> ' + escHtml(err.message || String(err)));
  } finally {
    rk.busy = false;
  }
});

/* 右ペインのタブ切替 */
document.querySelectorAll('.rk-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const id = btn.dataset.tab;
    document.querySelectorAll('.rk-tab').forEach(b => b.classList.toggle('on', b === btn));
    document.querySelectorAll('.rk-tabpane').forEach(p => {
      p.classList.toggle('on', p.dataset.tabpane === id);
    });
    if (id === 'rosenka') setTimeout(() => { try { rkMap.invalidateSize(); } catch (_) {} }, 0);
    if (id === 'gmap') gmapRefresh(true);
    if (id === 'maps') {
      gisSyncFromLeftMap();
      gisEnsureReg().then(() => {
        // 登録簿が揃ってから、必要なら市区町村も解決
        const needRev = !(gis.pref && gis.city);
        if (needRev) gisSetFocus(gis.lat, gis.lon);
        else gisRenderHub();
      });
    }
  });
});

/* 関連マップ: クリック直前に左地図の座標で URL を組み立てる */
document.addEventListener('click', e => {
  const a = e.target && e.target.closest && e.target.closest('a.maps-btn[data-maps-tpl]');
  if (!a) return;
  const tpl = a.getAttribute('data-maps-tpl');
  if (!tpl) return;
  gisSyncFromLeftMap();
  a.href = gisFill(tpl);
}, true);

$id('settingsUseCurrent').addEventListener('click', () => {
  const f = $id('settingsForm');
  if (!f) return;
  const c = rkMap.getCenter();
  f.mapLat.value = Number(c.lat.toFixed(6));
  f.mapLon.value = Number(c.lng.toFixed(6));
  f.mapZoom.value = rkMap.getZoom();
  if (gmap.label) f.mapLabel.value = gmap.label;
  settingsStatus('現在位置をフォームに入れました', true);
});

$id('settingsForm').addEventListener('submit', async e => {
  e.preventDefault();
  const payload = settingsReadForm();
  if (!payload) return;
  settingsStatus('保存中…', true);
  try {
    const r = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!r.ok) throw new Error('保存に失敗しました (' + r.status + ')');
    const saved = await r.json();
    settingsFillForm(saved);
    settingsApply(saved);
    settingsStatus('settings.json に保存し、反映しました', true);
  } catch (err) {
    settingsStatus(err.message || String(err), false);
  }
});

// 初期フォーカス（設定読み込み前の既定）
gmapUpdateLabels();
