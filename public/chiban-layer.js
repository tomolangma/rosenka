/* 筆界・地番レイヤー（法務省 登記所備付地図データの公開座標分）
   データは路線価ウォーカー公開API（dead-or-alive.pages.dev）経由。
   ズーム16未満は被覆表示、16以上で筆界線、18以上で地番ラベル。 */
(function () {
  'use strict';
  if (typeof rkMap === 'undefined' || typeof L === 'undefined') return;

  const DATA = 'https://dead-or-alive.pages.dev';
  const MIN_ZOOM_CB = 16;
  const CB_LABEL_ZOOM = 18;
  const CB_LABEL_MAX = 400;
  const CB_COV_MIN = 10;
  const CB_COV_FINE = 13;
  const CB_COV_100M = 13;
  const CB_BANDS = [8000, 40000];
  const CB_COV_OP = [0.14, 0.26, 0.4];
  const CB_COL = '#c2185b';
  const CC_COL = '#ef6c00';
  const LS_KEY = 'rk_lyr_chiban';

  const esc = s => (typeof escHtml === 'function')
    ? escHtml(s)
    : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));

  let enabled = true;
  try { if (localStorage.getItem(LS_KEY) === '0') enabled = false; } catch (_) {}

  const cb = {
    gen: 0, err: 0, index: null, pri: {}, raw: {}, cache: {}, loading: {}, shown: {},
    group: L.layerGroup(), labels: L.layerGroup(), cov: L.layerGroup(),
    renderer: L.canvas({ padding: 0.3 }), covRenderer: L.canvas({ padding: 0.3 })
  };
  const cc = {
    index: null, pri: {}, raw: {}, cache: {}, loading: {}, shown: {},
    group: L.layerGroup(), renderer: L.canvas({ padding: 0.3 })
  };
  cb.renderer.on('add', function () { if (this._container) this._container.style.pointerEvents = 'none'; });
  cb.covRenderer.on('add', function () { if (this._container) this._container.style.pointerEvents = 'none'; });
  cc.renderer.on('add', function () { if (this._container) this._container.style.pointerEvents = 'none'; });

  /* ── UI ── */
  const Ctl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function () {
      const d = L.DomUtil.create('div', 'rk-lyr-chiban leaflet-bar');
      d.innerHTML = '<label title="登記所備付地図データ（公共座標）の筆界・地番">'
        + '<input type="checkbox" id="rkChibanToggle"' + (enabled ? ' checked' : '') + '>'
        + '<span>筆界・地番</span></label>'
        + '<div class="rk-lyr-note" id="rkChibanNote" style="display:none"></div>';
      L.DomEvent.disableClickPropagation(d);
      L.DomEvent.disableScrollPropagation(d);
      d.querySelector('input').addEventListener('change', e => {
        enabled = !!e.target.checked;
        try { localStorage.setItem(LS_KEY, enabled ? '1' : '0'); } catch (_) {}
        redraw();
      });
      return d;
    }
  });
  rkMap.addControl(new Ctl());

  function note(t) {
    const el = document.getElementById('rkChibanNote');
    if (!el) return;
    el.textContent = t || '';
    el.style.display = t ? '' : 'none';
  }

  function ensureOnMap() {
    if (!rkMap.hasLayer(cb.group)) cb.group.addTo(rkMap);
    if (!rkMap.hasLayer(cc.group)) cc.group.addTo(rkMap);
    if (!rkMap.hasLayer(cb.labels)) cb.labels.addTo(rkMap);
    if (!rkMap.hasLayer(cb.cov)) cb.cov.addTo(rkMap);
  }
  ensureOnMap();

  /* ── データ取得 ── */
  async function cbIndex() {
    if (cb.index) return cb.index;
    try {
      cb.index = await (await fetch(DATA + '/rosenka-walker/layers/chiban/index.json', { cache: 'no-cache' })).json();
    } catch (_) {
      cb.err = 1;
      return { pri: [], muni: {} };
    }
    return cb.index;
  }
  function cbVer() { return (cb.index && cb.index.v) ? ('?v=' + cb.index.v) : ''; }
  function cbR2() { return !!(cb.index && cb.index.src === 'r2'); }

  async function cbPri(p) {
    if (cb.pri[p]) return cb.pri[p];
    const u = cbR2()
      ? (DATA + '/api/chiban/idx/' + p + cbVer())
      : (DATA + '/rosenka-walker/layers/chiban/' + p + '/i.json' + cbVer());
    cb.pri[p] = fetch(u, { cache: 'force-cache' })
      .then(r => (r.ok ? r.json() : null))
      .then(a => {
        cb.raw[p] = (a && !Array.isArray(a)) ? a : null;
        return new Set(a ? (Array.isArray(a) ? a : Object.keys(a)) : []);
      })
      .catch(() => { cb.err = 1; delete cb.pri[p]; return new Set(); });
    return cb.pri[p];
  }

  function cbMeshes(b) {
    const pad = 0.001;
    const y0 = Math.floor((b.getSouth() - pad) * 120);
    const y1 = Math.floor((b.getNorth() + pad) * 120);
    const x0 = Math.floor((b.getWest() - pad) * 80);
    const x1 = Math.floor((b.getEast() + pad) * 80);
    const out = [];
    for (let y = y0; y <= y1; y++) {
      const p = Math.floor(y / 80);
      const q = Math.floor((y - p * 80) / 10);
      const r = (y - p * 80) % 10;
      for (let x = x0; x <= x1; x++) {
        const u = Math.floor(x / 80) - 100;
        const v = Math.floor((x - (u + 100) * 80) / 10);
        const w = (x - (u + 100) * 80) % 10;
        if (p < 0 || u < 0 || u > 99) continue;
        out.push(('0' + p).slice(-2) + ('0' + u).slice(-2) + q + v + r + w);
      }
    }
    return out;
  }

  function cbOrigin(m) {
    return [
      100 + (+m.slice(2, 4)) + (+m[5]) / 8 + (+m[7]) / 80,
      (+m.slice(0, 2)) / 1.5 + (+m[4]) / 12 + (+m[6]) / 120
    ];
  }

  function cbDecode(a, ox, oy) {
    const out = [];
    let x = a[0];
    let y = a[1];
    out.push([ox + x / 1e6, oy + y / 1e6]);
    for (let i = 2; i < a.length; i += 2) {
      x += a[i];
      y += a[i + 1];
      out.push([ox + x / 1e6, oy + y / 1e6]);
    }
    return out;
  }

  function cbCenter(rings) {
    const r = rings[0];
    let x = 0;
    let y = 0;
    for (let i = 0; i < r.length; i++) { x += r[i][0]; y += r[i][1]; }
    return [y / r.length, x / r.length];
  }

  async function cbLoad(m) {
    if (cb.cache[m]) return cb.cache[m];
    if (cb.loading[m]) return cb.loading[m];
    const u = cbR2()
      ? (DATA + '/api/chiban/' + m + '.json' + cbVer())
      : (DATA + '/rosenka-walker/layers/chiban/' + m.slice(0, 4) + '/' + m.slice(4) + '.json' + cbVer());
    cb.loading[m] = fetch(u, { cache: 'force-cache' })
      .then(r => r.json())
      .then(j => {
        const g = L.layerGroup();
        const items = [];
        const o = cbOrigin(m);
        (j.f || []).forEach(f => {
          const rings = f[4] = f[4].map(a => cbDecode(a, o[0], o[1]));
          const outer = rings[0];
          let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
          for (let i = 0; i < outer.length; i++) {
            const c = outer[i];
            if (c[0] < x0) x0 = c[0];
            if (c[0] > x1) x1 = c[0];
            if (c[1] < y0) y0 = c[1];
            if (c[1] > y1) y1 = c[1];
          }
          items.push({ f: f, bb: [x0, y0, x1, y1] });
          L.polygon(rings.map(r => r.map(c => [c[1], c[0]])), {
            renderer: cb.renderer, interactive: false, noClip: true, smoothFactor: 0,
            color: CB_COL, weight: 0.8, opacity: 0.8, fill: false
          }).addTo(g);
        });
        cb.cache[m] = { g: g, items: items };
        return cb.cache[m];
      })
      .catch(() => { cb.err = 1; delete cb.loading[m]; return { g: L.layerGroup(), items: [] }; });
    return cb.loading[m];
  }

  /* ── 自治体地番参考図（橙破線） ── */
  async function ccIndex() {
    if (cc.index) return cc.index;
    try {
      cc.index = await (await fetch(DATA + '/rosenka-walker/layers/chiban/city.json', { cache: 'no-cache' })).json();
    } catch (_) {
      return { pri: [], priSet: new Set() };
    }
    cc.index.priSet = new Set(cc.index.pri || []);
    return cc.index;
  }
  function ccVer() { return (cc.index && cc.index.v) ? ('?v=' + cc.index.v) : ''; }
  async function ccPri(p) {
    if (cc.pri[p]) return cc.pri[p];
    cc.pri[p] = fetch(DATA + '/api/chiban/c/idx/' + p + ccVer(), { cache: 'force-cache' })
      .then(r => (r.ok ? r.json() : {}))
      .then(a => {
        cc.raw[p] = (a && !Array.isArray(a)) ? a : null;
        return new Set(Object.keys(a || {}));
      })
      .catch(() => { delete cc.pri[p]; return new Set(); });
    return cc.pri[p];
  }
  async function ccLoad(m) {
    if (cc.cache[m]) return cc.cache[m];
    if (cc.loading[m]) return cc.loading[m];
    cc.loading[m] = fetch(DATA + '/api/chiban/c/' + m + '.json' + ccVer(), { cache: 'force-cache' })
      .then(r => r.json())
      .then(j => {
        const g = L.layerGroup();
        const items = [];
        const o = cbOrigin(m);
        (j.f || []).forEach(f => {
          const rings = f[3].map(a => cbDecode(a, o[0], o[1]));
          let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
          rings[0].forEach(c => {
            if (c[0] < x0) x0 = c[0];
            if (c[0] > x1) x1 = c[0];
            if (c[1] < y0) y0 = c[1];
            if (c[1] > y1) y1 = c[1];
          });
          items.push({ f: [f[0], f[1], f[2], null, rings], bb: [x0, y0, x1, y1] });
          L.polygon(rings.map(r => r.map(c => [c[1], c[0]])), {
            renderer: cc.renderer, interactive: false, noClip: true, smoothFactor: 0,
            color: CC_COL, weight: 1, opacity: 0.9, dashArray: '4,3', fill: false
          }).addTo(g);
        });
        cc.cache[m] = { g: g, items: items };
        return cc.cache[m];
      })
      .catch(() => { delete cc.loading[m]; return { g: L.layerGroup(), items: [] }; });
    return cc.loading[m];
  }
  async function ccRedraw(cand, gen) {
    const idx = await ccIndex();
    if (gen !== undefined && gen !== cb.gen) return;
    const pris = Array.from(new Set(cand.map(m => m.slice(0, 4)))).filter(p => idx.priSet.has(p));
    const sets = {};
    await Promise.all(pris.map(p => ccPri(p).then(st => { sets[p] = st; })));
    if (gen !== undefined && gen !== cb.gen) return;
    const want = cand.filter(m => sets[m.slice(0, 4)] && sets[m.slice(0, 4)].has(m.slice(4)));
    Object.keys(cc.shown).forEach(m => {
      if (want.indexOf(m) < 0) { cc.group.removeLayer(cc.shown[m]); delete cc.shown[m]; }
    });
    await Promise.all(want.map(ccLoad));
    if (gen !== undefined && gen !== cb.gen) return;
    if (!enabled || rkMap.getZoom() < MIN_ZOOM_CB) return;
    want.forEach(m => {
      if (!cc.shown[m] && cc.cache[m]) { cc.shown[m] = cc.cache[m].g; cc.group.addLayer(cc.cache[m].g); }
    });
  }

  function cbDrawLabels() {
    cb.labels.clearLayers();
    if (!enabled || rkMap.getZoom() < CB_LABEL_ZOOM) return;
    const b = rkMap.getBounds();
    let n = 0;
    const keys = Object.keys(cb.shown).map(k => [cb.cache[k], 'cb-lbl'])
      .concat(Object.keys(cc.shown).map(k => [cc.cache[k], 'cb-lbl cc-lbl']));
    for (let ki = 0; ki < keys.length && n < CB_LABEL_MAX; ki++) {
      const c = keys[ki][0];
      const cls = keys[ki][1];
      if (!c) continue;
      for (let i = 0; i < c.items.length && n < CB_LABEL_MAX; i++) {
        const it = c.items[i];
        const bb = it.bb;
        if (bb[2] < b.getWest() || bb[0] > b.getEast() || bb[3] < b.getSouth() || bb[1] > b.getNorth()) continue;
        let ll = cbCenter(it.f[4]);
        if (!b.contains(ll)) {
          ll = [
            (Math.max(bb[1], b.getSouth()) + Math.min(bb[3], b.getNorth())) / 2,
            (Math.max(bb[0], b.getWest()) + Math.min(bb[2], b.getEast())) / 2
          ];
        }
        L.marker(ll, {
          interactive: false, keyboard: false,
          icon: L.divIcon({ className: cls, html: esc(it.f[1]), iconSize: null })
        }).addTo(cb.labels);
        n++;
      }
    }
  }

  function cbClear() {
    Object.keys(cb.shown).forEach(m => { cb.group.removeLayer(cb.shown[m]); delete cb.shown[m]; });
    Object.keys(cc.shown).forEach(m => { cc.group.removeLayer(cc.shown[m]); delete cc.shown[m]; });
    cb.labels.clearLayers();
  }
  function cbCovClear() { cb.cov.clearLayers(); }

  function cbVisible(b) {
    const w = b.getWest(), e = b.getEast(), so = b.getSouth(), n = b.getNorth();
    const keys = Object.keys(cb.shown).map(k => cb.cache[k]).concat(Object.keys(cc.shown).map(k => cc.cache[k]));
    for (let ki = 0; ki < keys.length; ki++) {
      const c = keys[ki];
      if (!c) continue;
      for (let i = 0; i < c.items.length; i++) {
        const bb = c.items[i].bb;
        if (!(bb[2] < w || bb[0] > e || bb[3] < so || bb[1] > n)) return true;
      }
    }
    return false;
  }

  function cbBand(len) { return len < CB_BANDS[0] ? 0 : len < CB_BANDS[1] ? 1 : 2; }
  function cbOcc(ent) {
    if (!ent || ent.length < 3 || typeof ent[2] !== 'string') return null;
    try {
      const bin = atob(ent[2]);
      const bits = [];
      for (let i = 0; i < bin.length; i++) {
        const v = bin.charCodeAt(i);
        for (let b = 7; b >= 0; b--) if (v & (1 << b)) bits.push(i * 8 + (7 - b));
      }
      return bits.filter(x => x < 100);
    } catch (_) { return null; }
  }
  function cbRect(pri, cell, fine, op, col) {
    const o = cbOrigin(pri + (fine ? cell : (cell + '00')));
    const dy = fine ? 1 / 120 : 1 / 12;
    const dx = fine ? 1 / 80 : 1 / 8;
    return L.rectangle([[o[1], o[0]], [o[1] + dy, o[0] + dx]], {
      renderer: cb.covRenderer, interactive: false,
      color: col, weight: 0, fillColor: col, fillOpacity: op, fill: true
    });
  }
  function cbRect100(pri, cell, bit, op, col) {
    const o = cbOrigin(pri + cell);
    const row = Math.floor(bit / 10), coln = bit % 10;
    const dy = 1 / 1200, dx = 1 / 800;
    return L.rectangle(
      [[o[1] + row * dy, o[0] + coln * dx], [o[1] + (row + 1) * dy, o[0] + (coln + 1) * dx]],
      { renderer: cb.covRenderer, interactive: false, color: col, weight: 0, fillColor: col, fillOpacity: op, fill: true }
    );
  }
  function cbCellNear(pri, cell, b) {
    const o = cbOrigin(pri + cell);
    return !(o[0] + 1 / 80 < b.getWest() - 0.01 || o[0] > b.getEast() + 0.01
      || o[1] + 1 / 120 < b.getSouth() - 0.01 || o[1] > b.getNorth() + 0.01);
  }
  function cbCovDraw(raw, pri, col, fine, fine100) {
    const b2 = rkMap.getBounds().pad(0.05);
    if (fine) {
      for (const cell in raw) {
        const op = CB_COV_OP[cbBand(raw[cell][1])];
        const occ = fine100 ? cbOcc(raw[cell]) : null;
        if (occ && occ.length && occ.length < 100 && cbCellNear(pri, cell, b2)) {
          for (let i = 0; i < occ.length; i++) cbRect100(pri, cell, occ[i], op, col).addTo(cb.cov);
        } else {
          cbRect(pri, cell, true, op, col).addTo(cb.cov);
        }
      }
    } else {
      const agg = {};
      for (const cell in raw) {
        const k2 = cell.slice(0, 2);
        agg[k2] = (agg[k2] || 0) + raw[cell][1];
      }
      for (const k2 in agg) cbRect(pri, k2, false, CB_COV_OP[cbBand(agg[k2] / 40)], col).addTo(cb.cov);
    }
  }
  async function cbCovRedraw() {
    const z = rkMap.getZoom();
    if (!enabled || z >= MIN_ZOOM_CB || z < CB_COV_MIN) { cbCovClear(); return; }
    await cbIndex();
    const fine = z >= CB_COV_FINE;
    const fine100 = z >= CB_COV_100M;
    const b = rkMap.getBounds().pad(0.02);
    const cand = cbMeshes(b);
    const pris = Array.from(new Set(cand.map(m => m.slice(0, 4))));
    cbCovClear();
    await Promise.all(pris.map(async p => {
      await cbPri(p);
      if (cb.raw[p]) cbCovDraw(cb.raw[p], p, CB_COL, fine, fine100);
    }));
    const cidx = await ccIndex();
    await Promise.all(pris.filter(p => cidx.priSet.has(p)).map(async p => {
      await ccPri(p);
      if (cc.raw[p]) cbCovDraw(cc.raw[p], p, CC_COL, fine, fine100);
    }));
  }

  async function redraw() {
    if (!enabled) { cbClear(); cbCovClear(); note(''); return; }
    const z = rkMap.getZoom();
    if (z < MIN_ZOOM_CB) {
      cbClear();
      await cbCovRedraw();
      note(z < CB_COV_MIN ? ('筆界は地図を拡大すると表示（現在ズーム ' + z + '／' + MIN_ZOOM_CB + '以上）') : '');
      return;
    }
    cbCovClear();
    const gen = ++cb.gen;
    cb.err = 0;
    await cbIndex();
    if (gen !== cb.gen) return;
    const b = rkMap.getBounds();
    const cand = cbMeshes(b);
    const sets = {};
    await Promise.all(Array.from(new Set(cand.map(m => m.slice(0, 4)))).map(p => cbPri(p).then(s => { sets[p] = s; })));
    if (gen !== cb.gen) return;
    const want = cand.filter(m => sets[m.slice(0, 4)] && sets[m.slice(0, 4)].has(m.slice(4)));
    Object.keys(cb.shown).forEach(m => {
      if (want.indexOf(m) < 0) { cb.group.removeLayer(cb.shown[m]); delete cb.shown[m]; }
    });
    await ccRedraw(cand, gen);
    if (gen !== cb.gen) return;
    if (!enabled || rkMap.getZoom() < MIN_ZOOM_CB) return;
    if (cb.err) { cb.labels.clearLayers(); note('筆界を読み込めませんでした。地図を少し動かすと再試行します'); return; }
    if (!want.length && cbVisible(b)) { cbDrawLabels(); note(''); return; }
    if (!want.length) {
      cb.labels.clearLayers();
      note('この範囲は重ねられる地図データがありません（任意座標の公図のみの区域・未整備）');
      return;
    }
    if (want.some(m => !cb.cache[m])) note('筆界を読み込み中…');
    await Promise.all(want.map(cbLoad));
    if (gen !== cb.gen) return;
    if (!enabled || rkMap.getZoom() < MIN_ZOOM_CB) return;
    if (cb.err) { note('筆界を読み込めませんでした。地図を少し動かすと再試行します'); return; }
    want.forEach(m => {
      if (!cb.shown[m] && cb.cache[m]) { cb.shown[m] = cb.cache[m].g; cb.group.addLayer(cb.cache[m].g); }
    });
    cbDrawLabels();
    if (!cbVisible(b)) {
      note('この範囲は重ねられる地図データがありません（地籍調査が未了の区域）');
      return;
    }
    note('');
  }

  let timer = null;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(redraw, 150);
  }
  rkMap.on('moveend zoomend', schedule);
  if (enabled) redraw();

  /* ── 地番検索（上部バー用） ── */
  function normChiban(s) {
    return String(s || '')
      .replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .replace(/[－ー―‐−]/g, '-')
      .replace(/番地?の?/g, '-')
      .replace(/号/g, '')
      .replace(/[\s　]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  let hlLayer = null;
  function clearHighlight() {
    if (hlLayer) {
      try { rkMap.removeLayer(hlLayer); } catch (_) {}
      hlLayer = null;
    }
  }
  function highlightItem(it) {
    clearHighlight();
    if (!it || !it.f || !it.f[4]) return;
    const latlngs = it.f[4].map(r => r.map(c => [c[1], c[0]]));
    hlLayer = L.polygon(latlngs, {
      color: '#0d7377', weight: 2.5, opacity: 1,
      fillColor: '#0d7377', fillOpacity: 0.18, interactive: false
    }).addTo(rkMap);
  }

  async function ensureMeshesAround(lat, lng, padDeg) {
    await cbIndex();
    const pad = padDeg == null ? 0.0025 : padDeg;
    const b = L.latLngBounds([lat - pad, lng - pad], [lat + pad, lng + pad]);
    const cand = cbMeshes(b);
    const pris = Array.from(new Set(cand.map(m => m.slice(0, 4))));
    const sets = {};
    await Promise.all(pris.map(p => cbPri(p).then(st => { sets[p] = st; })));
    const want = cand.filter(m => sets[m.slice(0, 4)] && sets[m.slice(0, 4)].has(m.slice(4)));
    await Promise.all(want.map(cbLoad));
    return want;
  }

  function matchScore(label, q) {
    const c = normChiban(label);
    if (!c || !q) return -1;
    if (c === q) return 100;
    /* 末尾一致は数字境界のみ（「9」で「19」を拾わない） */
    if (c.endsWith(q) && !/[0-9-]/.test(c.charAt(c.length - q.length - 1))) return 80;
    if (c.replace(/-/g, '') === q.replace(/-/g, '')) return 70;
    return -1;
  }

  async function findNear(lat, lng, chibanQ, padDeg) {
    const q = normChiban(chibanQ);
    if (!q || !Number.isFinite(lat) || !Number.isFinite(lng)) return [];
    const want = await ensureMeshesAround(lat, lng, padDeg);
    const hits = [];
    for (const m of want) {
      const c = cb.cache[m];
      if (!c) continue;
      for (let i = 0; i < c.items.length; i++) {
        const it = c.items[i];
        const score = matchScore(it.f[1], q);
        if (score < 0) continue;
        const ll = cbCenter(it.f[4]);
        const d = Math.hypot((ll[0] - lat) * 110000, (ll[1] - lng) * 90000);
        hits.push({
          chiban: it.f[1],
          lat: ll[0],
          lng: ll[1],
          score,
          d,
          item: it,
          mesh: m
        });
      }
    }
    hits.sort((a, b) => b.score - a.score || a.d - b.d);
    return hits;
  }

  window.rkChibanLayer = {
    enabled: () => enabled,
    setEnabled: on => {
      enabled = !!on;
      try { localStorage.setItem(LS_KEY, enabled ? '1' : '0'); } catch (_) {}
      const inp = document.getElementById('rkChibanToggle');
      if (inp) inp.checked = enabled;
      redraw();
    },
    redraw: redraw,
    findNear: findNear,
    highlight: highlightItem,
    clearHighlight: clearHighlight,
    normChiban: normChiban
  };
})();
