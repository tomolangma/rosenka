/* 過去案件（マンション・アパート・団地の評価実績）レイヤー
   地価公示と同様に circleMarker で点表示。データは data/past-cases.json。 */
(function () {
  'use strict';
  if (typeof rkMap === 'undefined' || typeof L === 'undefined') return;

  const API = '/api/past-cases';
  const LS_KEY = 'rk_lyr_past_cases';
  const COL = '#6a1b9a';
  const MIN_ZOOM = 12;
  const LABEL_ZOOM = 15;

  const esc = s => (typeof escHtml === 'function')
    ? escHtml(s)
    : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));

  let enabled = true;
  try { if (localStorage.getItem(LS_KEY) === '0') enabled = false; } catch (_) {}

  const state = {
    items: [],
    loaded: false,
    group: L.layerGroup(),
    markers: new Map()
  };

  function note(msg) {
    let el = document.getElementById('rkPastNote');
    if (!el) {
      el = document.createElement('div');
      el.id = 'rkPastNote';
      el.className = 'rk-lyr-note';
      const wrap = document.querySelector('.rk-mapwrap');
      if (wrap) wrap.appendChild(el);
    }
    if (!msg) {
      el.style.display = 'none';
      el.textContent = '';
      return;
    }
    el.style.display = '';
    el.textContent = msg;
  }

  async function load(force) {
    if (state.loaded && !force) return state.items;
    const r = await fetch(API, { cache: 'no-cache' });
    if (!r.ok) throw new Error('過去案件の読み込みに失敗しました');
    const j = await r.json();
    state.items = Array.isArray(j.items) ? j.items : [];
    state.loaded = true;
    return state.items;
  }

  function popupHtml(it) {
    const name = esc(it.name || '（無名）');
    const building = it.building ? '<div class="pc-building">' + esc(it.building) + '</div>' : '';
    const addr = it.address ? '<div class="pc-line">' + esc(it.address) + '</div>' : '';
    const memo = it.memo ? '<div class="pc-memo">' + esc(it.memo) + '</div>' : '';
    const url = String(it.kintoneUrl || '').trim();
    const link = url
      ? '<a class="pc-link" href="' + esc(url) + '" target="_blank" rel="noopener">kintoneを開く</a>'
      : '<span class="lyr-dim">kintone URL なし</span>';
    return '<div class="lyr-pop lyr-pop-pc">'
      + '<div class="pc-h"><span class="pc-kind">過去案件</span><b class="pc-name">' + name + '</b></div>'
      + building
      + addr
      + memo
      + '<div class="pc-actions">' + link + '</div>'
      + '</div>';
  }

  function redraw() {
    state.group.clearLayers();
    state.markers.clear();
    if (!enabled) {
      note('');
      return;
    }
    const z = rkMap.getZoom();
    if (z < MIN_ZOOM) {
      note('過去案件は地図を拡大すると表示（ズーム ' + MIN_ZOOM + ' 以上）');
      return;
    }
    note('');
    const b = rkMap.getBounds();
    const labels = z >= LABEL_ZOOM;
    const r = z >= 15 ? 8 : 6;
    for (const it of state.items) {
      const lat = Number(it.lat), lon = Number(it.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (lat < b.getSouth() || lat > b.getNorth() || lon < b.getWest() || lon > b.getEast()) continue;
      const m = L.circleMarker([lat, lon], {
        radius: r,
        color: '#fff',
        weight: 2,
        fillColor: COL,
        fillOpacity: 0.95,
        bubblingMouseEvents: false
      });
      const hit = L.circleMarker([lat, lon], {
        radius: Math.max(16, r + 9),
        stroke: false,
        fill: true,
        fillColor: '#000',
        fillOpacity: 0,
        bubblingMouseEvents: false,
        className: 'lyr-hit'
      });
      const grab = () => { m.setRadius(r + 4); m.setStyle({ color: '#b8952f', weight: 3.5 }); m.bringToFront(); };
      const release = () => { if (!m.isPopupOpen()) { m.setRadius(r); m.setStyle({ color: '#fff', weight: 2 }); } };
      hit.on('mouseover', grab).on('mouseout', release).on('click', () => m.openPopup());
      m.on('mouseover', grab).on('mouseout', release).on('popupclose', release);
      const tip = it.building || it.name || '過去案件';
      if (labels) {
        m.bindTooltip(esc(tip), {
          permanent: true, direction: 'right', offset: [6, 0],
          className: 'lyr-lab pc-lab', opacity: 1, interactive: true
        });
      } else {
        m.bindTooltip(esc(tip), { direction: 'top', offset: [0, -6], opacity: 0.9 });
      }
      m.bindPopup(popupHtml(it), { maxWidth: 320, autoPanPaddingTopLeft: [10, 60] });
      hit.addTo(state.group);
      m.addTo(state.group);
      if (it.id) state.markers.set(it.id, m);
    }
  }

  async function refresh(force) {
    try {
      await load(force);
      redraw();
    } catch (e) {
      note(e.message || String(e));
    }
  }

  function currentPoint() {
    if (rk && rk.point && Number.isFinite(rk.point.lat) && Number.isFinite(rk.point.lng)) {
      return { lat: rk.point.lat, lon: rk.point.lng };
    }
    if (typeof gmap !== 'undefined' && Number.isFinite(gmap.lat) && Number.isFinite(gmap.lon)) {
      return { lat: gmap.lat, lon: gmap.lon };
    }
    const c = rkMap.getCenter();
    return { lat: c.lat, lon: c.lng };
  }

  function currentAddress() {
    const el = document.getElementById('rkStatusAddr');
    const t = el ? (el.textContent || '').trim() : '';
    if (t && t !== '地点を選択すると住所を表示します' && t !== '住所を取得中…') return t;
    if (typeof gmap !== 'undefined' && gmap.label) return String(gmap.label);
    return '';
  }

  function openRegisterDialog(at) {
    const dlg = document.getElementById('rkPastDlg');
    const form = document.getElementById('rkPastForm');
    if (!dlg || !form) return;
    const pt = (at && Number.isFinite(at.lat) && Number.isFinite(at.lon))
      ? { lat: at.lat, lon: at.lon }
      : currentPoint();
    form.elements.namedItem('lat').value = String(pt.lat);
    form.elements.namedItem('lon').value = String(pt.lon);
    form.elements.namedItem('address').value = currentAddress();
    form.elements.namedItem('name').value = '';
    form.elements.namedItem('building').value = '';
    form.elements.namedItem('kintoneUrl').value = '';
    form.elements.namedItem('memo').value = '';
    const pos = document.getElementById('rkPastPos');
    if (pos) {
      pos.textContent = pt.lat.toFixed(6) + ', ' + pt.lon.toFixed(6)
        + (currentAddress() ? ' ／ ' + currentAddress() : '');
    }
    const st = document.getElementById('rkPastStatus');
    if (st) st.textContent = '';
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
    const nameEl = form.elements.namedItem('name');
    if (nameEl) setTimeout(() => nameEl.focus(), 30);
  }

  async function submitRegister(ev) {
    ev.preventDefault();
    const form = document.getElementById('rkPastForm');
    const st = document.getElementById('rkPastStatus');
    if (!form) return;
    const name = String(form.elements.namedItem('name').value || '').trim();
    const building = String(form.elements.namedItem('building').value || '').trim();
    const kintoneUrl = String(form.elements.namedItem('kintoneUrl').value || '').trim();
    const memo = String(form.elements.namedItem('memo').value || '').trim();
    const lat = Number(form.elements.namedItem('lat').value);
    const lon = Number(form.elements.namedItem('lon').value);
    const address = String(form.elements.namedItem('address').value || '').trim();
    if (!name) {
      if (st) st.textContent = '被相続人名を入力してください';
      return;
    }
    if (!kintoneUrl) {
      if (st) st.textContent = 'kintone URL を入力してください';
      return;
    }
    if (!/^https?:\/\//i.test(kintoneUrl)) {
      if (st) st.textContent = 'kintone URL は http(s):// で始めてください';
      return;
    }
    if (st) st.textContent = '保存中…';
    try {
      const r = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, building, kintoneUrl, memo, lat, lon, address })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('保存に失敗しました (' + r.status + ')'));
      state.items = Array.isArray(j.items) ? j.items : state.items;
      state.loaded = true;
      enabled = true;
      try { localStorage.setItem(LS_KEY, '1'); } catch (_) {}
      const chk = document.getElementById('lyrPastCases');
      if (chk) chk.checked = true;
      if (!rkMap.hasLayer(state.group)) state.group.addTo(rkMap);
      redraw();
      const dlg = document.getElementById('rkPastDlg');
      if (dlg && dlg.open) dlg.close();
      if (j.item && j.item.id && state.markers.has(j.item.id)) {
        const m = state.markers.get(j.item.id);
        rkMap.panTo(m.getLatLng());
        setTimeout(() => m.openPopup(), 80);
      }
    } catch (e) {
      if (st) st.textContent = e.message || String(e);
    }
  }

  /* 右クリックメニュー */
  let ctxMenu = null;
  let ctxLatLng = null;
  function hideCtxMenu() {
    if (ctxMenu) ctxMenu.style.display = 'none';
  }
  function ensureCtxMenu() {
    if (ctxMenu) return ctxMenu;
    ctxMenu = document.createElement('div');
    ctxMenu.id = 'rkPastCtx';
    ctxMenu.className = 'rk-past-ctx';
    ctxMenu.innerHTML = '<button type="button" data-act="register">過去案件を登録</button>';
    document.body.appendChild(ctxMenu);
    ctxMenu.addEventListener('click', e => {
      const b = e.target.closest('[data-act="register"]');
      if (!b || !ctxLatLng) return;
      hideCtxMenu();
      const ll = ctxLatLng;
      if (typeof rkMarker !== 'undefined') {
        if (rkMarker) rkMarker.remove();
        rkMarker = L.marker(ll).addTo(rkMap);
      }
      if (typeof rk !== 'undefined') rk.point = { lat: ll.lat, lng: ll.lng };
      if (typeof gmapSetFocus === 'function') gmapSetFocus(ll.lat, ll.lng);
      openRegisterDialog({ lat: ll.lat, lon: ll.lng });
    });
    return ctxMenu;
  }
  function showCtxMenu(e) {
    const menu = ensureCtxMenu();
    ctxLatLng = e.latlng;
    const pt = rkMap.latLngToContainerPoint(e.latlng);
    const rect = rkMap.getContainer().getBoundingClientRect();
    menu.style.display = 'block';
    menu.style.left = (rect.left + pt.x) + 'px';
    menu.style.top = (rect.top + pt.y) + 'px';
  }
  rkMap.on('contextmenu', e => {
    if (e.originalEvent) {
      e.originalEvent.preventDefault();
      e.originalEvent.stopPropagation();
    }
    showCtxMenu(e);
  });
  rkMap.getContainer().addEventListener('contextmenu', e => {
    e.preventDefault();
  });
  document.addEventListener('click', hideCtxMenu);
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape') hideCtxMenu(); });
  rkMap.on('movestart zoomstart', hideCtxMenu);

  /* 地図コントロール: 表示トグル */
  const Ctl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function () {
      const d = L.DomUtil.create('div', 'rk-lyr-chiban rk-lyr-past leaflet-bar');
      d.innerHTML = '<label title="過去に評価したマンション・アパート・団地">'
        + '<input type="checkbox" id="lyrPastCases"' + (enabled ? ' checked' : '') + '>'
        + '<span class="lyr-sw" style="background:' + COL + '"></span>過去案件</label>';
      L.DomEvent.disableClickPropagation(d);
      d.querySelector('input').addEventListener('change', e => {
        enabled = !!e.target.checked;
        try { localStorage.setItem(LS_KEY, enabled ? '1' : '0'); } catch (_) {}
        if (enabled) {
          if (!rkMap.hasLayer(state.group)) state.group.addTo(rkMap);
          refresh(false);
        } else {
          state.group.clearLayers();
          note('');
        }
      });
      return d;
    }
  });
  rkMap.addControl(new Ctl());

  if (enabled) state.group.addTo(rkMap);

  let t = null;
  const schedule = () => {
    clearTimeout(t);
    t = setTimeout(() => { if (enabled) refresh(false); }, 200);
  };
  rkMap.on('moveend zoomend', schedule);
  refresh(false);

  const form = document.getElementById('rkPastForm');
  if (form) form.addEventListener('submit', submitRegister);
  const cancelBtn = document.getElementById('rkPastCancel');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      const dlg = document.getElementById('rkPastDlg');
      if (dlg && dlg.open) dlg.close();
    });
  }

  window.rkPastCases = {
    refresh: () => refresh(true),
    openRegister: openRegisterDialog,
    getItems: () => state.items.slice()
  };
})();
