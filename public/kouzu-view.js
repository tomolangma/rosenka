/* 路線価ウォーカー 公図ビューア（任意座標系）（2026-09-13）
   ・入口は2つだけ：筆界が出ない所の案内「公図を見る」（layers.js）と、PDF上の「公図（全域）」（index.html）。
     押した地点から2.5km以内の町を近い順の候補チップにして、別窓でその地番区域の図面を描く（筆界・地番・図郭）。**地図には重ねない**。
   ・**地図上のピンは置かない（2026-09-13 一度出して同日撤去）**＝代表点のピンは「その地点を指す記号」に読まれ、住居表示と地番区域の
     範囲のずれで図面の外に立つことがある。ピンは同じ入口の二重化で地図も増量する（Claude×Codex 壁打ち _壁打ち/公図導線UX/ で一致）。
     戻すなら「ピンありで筆到達率が上がり、最初の町で筆を選ばず町を変える率が悪化しない」ことを実測してから。
   なぜ重ねないか: 任意座標の図面は地球上の座標を持たず、道路で位置合わせしても図面内部の歪み（旧土地台帳附属地図）や
     似た街区の取り違えは検出できない。筆界を地図に載せると隣地・接道の誤認を当社名義で配ることになる
     （Codex 壁打ち 2026-09-13 で確定＝_壁打ち/地番マップ/）。だから方位記号・縮尺・面積も出さない。
   データ: 所在索引＝/rosenka-walker/layers/kouzu/{index.json, {県2桁}.json}（Pages）
           図面＝/api/kouzu/{市区町村}/{地番区域}.json（R2・functions/api/kouzu/[[path]].js）
           生成＝walker-layers/build_kouzu_xml.py（法務省 地図XML原本）
   依存: rkMap・beacon()・escHtml()。layers.js・index.html が rkKouzu.openNear(lat,lng,src) を呼ぶ（false＝近くに任意座標の図面なし）。 */
(function () {
  'use strict';
  if (typeof rkMap === 'undefined') return;
  const DATA_ORIGIN = 'https://dead-or-alive.pages.dev';
  const beacon = (typeof window.beacon === 'function') ? window.beacon : function () {};
  const NEAR_M = 2500;          // 「公図ビューアで見る」で候補にする半径
  const COL = '#b45309';
  const FUDE = '#c2185b';       // 筆界レイヤーと同じ色＝出どころが同じ登記所備付地図
  const esc = s => (typeof escHtml === 'function') ? escHtml(s) : String(s == null ? '' : s);
  const bc = (e, x) => { try { beacon(e, x || ''); } catch (_) {} };
  const sent = {};
  const bcOnce = (e, x) => { if (!sent[e]) { sent[e] = 1; bc(e, x); } };

  /* ── CSS ── */
  const css = document.createElement('style');
  css.textContent = `
.kzv-ov{position:fixed;inset:0;background:rgba(26,42,58,.55);z-index:1250;display:none;align-items:center;justify-content:center;padding:12px}
.kzv-ov.on{display:flex}
.kzv-card{background:var(--surface,#fff);border-radius:var(--radius,10px);width:min(1100px,100%);height:min(860px,calc(100vh - 24px));
  display:flex;flex-direction:column;box-shadow:var(--shadow,0 8px 30px rgba(0,0,0,.3));overflow:hidden}
.kzv-hd{background:var(--header,#1a2a3a);border-bottom:3px solid var(--accent,#c9a227);padding:10px 14px 10px 18px;display:flex;align-items:center;gap:12px}
.kzv-hd h2{font-size:16px;color:var(--accent,#c9a227);font-weight:700;margin:0;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kzv-hd .kzv-badge{font-size:12px;color:#fff;background:${COL};border-radius:10px;padding:3px 9px;white-space:nowrap}
.kzv-x{background:none;border:none;color:var(--accent,#c9a227);font-size:28px;line-height:1;cursor:pointer;padding:0 6px;min-height:44px;min-width:44px;font-family:inherit}
.kzv-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 12px;border-bottom:1px solid var(--border,#ddd)}
.kzv-bar input{height:44px;font-size:16px;padding:0 12px;border:1.5px solid var(--border,#ccc);border-radius:var(--radius-sm,6px);width:14em;max-width:100%;font-family:inherit}
.kzv-bar input:focus{outline:none;border-color:var(--accent,#c9a227)}
.kzv-btn{height:44px;min-width:44px;padding:0 14px;font-size:16px;font-weight:700;font-family:inherit;cursor:pointer;
  border:1.5px solid var(--border,#ccc);border-radius:var(--radius-sm,6px);background:var(--surface,#fff);color:var(--text,#222)}
.kzv-btn:hover{border-color:var(--accent,#c9a227)}
.kzv-chips{display:flex;gap:6px;flex-wrap:wrap;padding:6px 12px;border-bottom:1px solid var(--border,#ddd)}
.kzv-chips:empty{display:none}
.kzv-chip{font-size:13px;padding:6px 11px;border-radius:14px;border:1.5px solid var(--border,#ccc);background:var(--surface,#fff);cursor:pointer;font-family:inherit;color:var(--text,#222)}
.kzv-chip.on{border-color:${COL};color:${COL};font-weight:700}
.kzv-cv{position:relative;flex:1;min-height:0;background:#fbfaf6;touch-action:none;cursor:grab}
.kzv-cv.drag{cursor:grabbing}
.kzv-cv canvas{position:absolute;inset:0;width:100%;height:100%}
.kzv-msg{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font-size:15px;color:var(--text-dim,#555);background:rgba(255,255,255,.9);padding:10px 16px;border-radius:8px}
.kzv-info{min-height:52px;padding:8px 14px;border-top:1px solid var(--border,#ddd);font-size:14px;line-height:1.6;color:var(--text,#222);display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.kzv-info b{font-size:16px}
.kzv-info .kzv-dim{color:var(--text-muted,#777);font-size:13px}
.kzv-zoom{position:absolute;right:10px;top:10px;display:flex;flex-direction:column;gap:6px}
@media(max-width:640px){.kzv-ov{padding:0}.kzv-card{height:100vh;border-radius:0}.kzv-bar{flex-wrap:nowrap}.kzv-bar input{flex:1;min-width:0;width:auto}#kzvHit{display:none}
  .kzv-chips{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none}.kzv-chip{flex:none}}
`;
  document.head.appendChild(css);

  /* ── モーダル ── */
  const ov = document.createElement('div');
  ov.className = 'kzv-ov';
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-modal', 'true');
  ov.innerHTML = `<div class="kzv-card">
  <div class="kzv-hd"><h2 id="kzvTitle">公図</h2><span class="kzv-badge">任意座標の図面</span>
    <button type="button" class="kzv-x" aria-label="閉じる">×</button></div>
  <div class="kzv-bar"><input type="search" id="kzvQ" placeholder="地番で探す（例 123-4）" inputmode="text" autocomplete="off">
    <button type="button" class="kzv-btn" id="kzvGo">探す</button><span class="kzv-dim" id="kzvHit" style="font-size:13px;color:var(--text-muted,#777)"></span></div>
  <div class="kzv-chips" id="kzvChips"></div>
  <div class="kzv-cv" id="kzvCv"><canvas></canvas>
    <div class="kzv-zoom"><button type="button" class="kzv-btn" data-z="1.6" aria-label="拡大">＋</button>
      <button type="button" class="kzv-btn" data-z="0.625" aria-label="縮小">－</button>
      <button type="button" class="kzv-btn" data-fit="1" aria-label="全体" style="font-size:13px">全体</button></div>
    <div class="kzv-msg" id="kzvMsg" style="display:none"></div></div>
  <div class="kzv-info" id="kzvInfo"><span class="kzv-dim">筆を押すと地番と図面の情報を表示します</span></div>
</div>`;
  document.body.appendChild(ov);
  const $ = sel => ov.querySelector(sel);
  const cvHost = $('#kzvCv'), canvas = cvHost.querySelector('canvas'), ctx = canvas.getContext('2d');
  const V = { doc: null, fude: [], sel: -1, hits: [], s: 1, tx: 0, ty: 0, gen: 0, key: '' };

  function close() { ov.classList.remove('on'); V.gen++; }
  $('.kzv-x').addEventListener('click', close);
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && ov.classList.contains('on')) close(); });
  function msg(t) { const m = $('#kzvMsg'); m.textContent = t || ''; m.style.display = t ? '' : 'none'; }

  /* ── データ ── */
  const P = { index: null, pref: {}, loading: {} };
  async function pIndex() {
    if (P.index) return P.index;
    try { P.index = await (await fetch(DATA_ORIGIN + '/rosenka-walker/layers/kouzu/index.json', { cache: 'no-cache' })).json(); }
    catch (_) { P.index = { pref: {}, n: {} }; }
    return P.index;
  }
  function ver() { return (P.index && P.index.v) ? '?v=' + P.index.v : ''; }
  async function pPref(pref) {
    if (P.pref[pref]) return P.pref[pref];
    if (!P.loading[pref]) {
      P.loading[pref] = fetch(DATA_ORIGIN + '/rosenka-walker/layers/kouzu/' + pref + '.json' + ver(), { cache: 'force-cache' })
        .then(r => r.ok ? r.json() : { p: [], u: [] }).catch(() => ({ p: [], u: [] }))
        .then(j => { P.pref[pref] = j; return j; });
    }
    return P.loading[pref];
  }
  function prefsIn(b) {
    const out = [];
    const pr = (P.index && P.index.pref) || {};
    for (const k in pr) {
      const bb = pr[k][1];
      if (!bb) continue;
      if (bb[2] < b.getWest() - .05 || bb[0] > b.getEast() + .05 || bb[3] < b.getSouth() - .05 || bb[1] > b.getNorth() + .05) continue;
      out.push(k);
    }
    return out;
  }

  /* ── 図面の読み込み ── */
  async function loadArea(city, area) {
    await pIndex();
    const r = await fetch(DATA_ORIGIN + '/api/kouzu/' + city + '/' + area + '.json' + ver(), { cache: 'force-cache' });
    if (!r.ok) throw new Error('図面を取得できませんでした（' + r.status + '）');
    return r.json();
  }
  function decodeRing(a) {
    const out = new Float64Array(a.length);
    let y = a[0], x = a[1];
    out[0] = y; out[1] = x;
    for (let i = 2; i < a.length; i += 2) { y += a[i]; x += a[i + 1]; out[i] = y; out[i + 1] = x; }
    return out;
  }
  const ROAD = /^(道|水|道路|水路|里道|無地番|長狭物)/;
  function prep(doc) {
    const fude = [];
    let X0 = 1e18, Y0 = 1e18, X1 = -1e18, Y1 = -1e18;
    doc.f.forEach((f, i) => {
      const polys = f[3].map(poly => poly.map(decodeRing));
      let x0 = 1e18, y0 = 1e18, x1 = -1e18, y1 = -1e18;
      const path = new Path2D();
      polys.forEach(poly => poly.forEach(r => {
        for (let j = 0; j < r.length; j += 2) {
          const yy = r[j], xx = r[j + 1];      // yy=東向き（画面x）・xx=北向き（画面 -y）
          if (yy < x0) x0 = yy; if (yy > x1) x1 = yy;
          if (xx < y0) y0 = xx; if (xx > y1) y1 = xx;
          if (j === 0) path.moveTo(yy, -xx); else path.lineTo(yy, -xx);
        }
        path.closePath();
      }));
      if (x0 < X0) X0 = x0; if (x1 > X1) X1 = x1; if (y0 < Y0) Y0 = y0; if (y1 > Y1) Y1 = y1;
      fude.push({ i: i, sheet: f[0], town: doc.o[f[1]] || '', chiban: f[2], polys: polys, path: path,
        bb: [x0, y0, x1, y1], rep: f[4], parts: f[5] || null, road: ROAD.test(f[2] || '') });
    });
    V.doc = doc; V.fude = fude; V.bbox = [X0, Y0, X1, Y1]; V.sel = -1; V.hits = [];
  }

  /* ── 描画 ── */
  function resize() {
    const r = cvHost.getBoundingClientRect(), d = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(r.width * d)); canvas.height = Math.max(1, Math.round(r.height * d));
    V.dpr = d; V.w = r.width; V.h = r.height;
  }
  function fit(bb) {
    bb = bb || V.bbox;
    if (!bb) return;
    const w = Math.max(bb[2] - bb[0], 500), h = Math.max(bb[3] - bb[1], 500);
    V.s = Math.min(V.w / w, V.h / h) * .92;
    V.tx = V.w / 2 - V.s * (bb[0] + bb[2]) / 2;
    V.ty = V.h / 2 + V.s * (bb[1] + bb[3]) / 2;
  }
  let raf = 0;
  /* rAF はタブが裏にあると止まる（Leaflet の canvas で既知）＝60ms で来なければ setTimeout で描く */
  function draw() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; paint(); });
    setTimeout(() => { if (raf) { cancelAnimationFrame(raf); raf = 0; paint(); } }, 60);
  }
  function paint() {
    const d = V.dpr || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!V.doc) return;
    const s = V.s;
    // 画面に入っている範囲（図面座標 cm）
    const vx0 = -V.tx / s, vx1 = (V.w - V.tx) / s, vy1 = V.ty / s, vy0 = (V.ty - V.h) / s;
    ctx.setTransform(d * s, 0, 0, d * s, d * V.tx, d * V.ty);
    ctx.lineJoin = 'round';
    // 図郭（図面1枚の枠）
    ctx.setLineDash([6 / s, 4 / s]); ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = 1.2 / s;
    (V.doc.z || []).forEach(z => {
      const c = z[3];
      if (!c) return;
      ctx.beginPath();
      ctx.moveTo(c[0], -c[1]); ctx.lineTo(c[2], -c[3]); ctx.lineTo(c[4], -c[5]); ctx.lineTo(c[6], -c[7]); ctx.closePath();
      ctx.stroke();
    });
    ctx.setLineDash([]);
    const vis = [];
    for (const f of V.fude) {
      const b = f.bb;
      if (b[2] < vx0 || b[0] > vx1 || b[3] < vy0 || b[1] > vy1) continue;
      vis.push(f);
      if (f.road) { ctx.fillStyle = 'rgba(46,125,50,.14)'; ctx.fill(f.path, 'evenodd'); }
    }
    V.hits.forEach(i => { if (i === V.sel) return; ctx.fillStyle = 'rgba(201,162,39,.35)'; ctx.fill(V.fude[i].path, 'evenodd'); });
    if (V.sel >= 0) { ctx.fillStyle = 'rgba(21,101,192,.28)'; ctx.fill(V.fude[V.sel].path, 'evenodd'); }
    ctx.strokeStyle = FUDE; ctx.lineWidth = 1 / s;
    vis.forEach(f => ctx.stroke(f.path));
    if (V.sel >= 0) { ctx.strokeStyle = '#1565c0'; ctx.lineWidth = 2.5 / s; ctx.stroke(V.fude[V.sel].path); }
    // 文字は画面座標で
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '600 12px "Noto Sans JP",sans-serif';
    let n = 0;
    for (const f of vis) {
      if (f.road || !f.chiban) continue;
      const pw = (f.bb[2] - f.bb[0]) * s, ph = (f.bb[3] - f.bb[1]) * s;
      if (pw < 34 || ph < 16) continue;
      if (++n > 1500) break;
      const x = V.tx + f.rep[0] * s, y = V.ty - f.rep[1] * s;
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(251,250,246,.9)'; ctx.strokeText(f.chiban, x, y);
      ctx.fillStyle = '#6d0f35'; ctx.fillText(f.chiban, x, y);
    }
    // 地図番号（図郭の中央）
    ctx.font = '700 13px "Noto Sans JP",sans-serif'; ctx.fillStyle = '#64748b';
    (V.doc.z || []).forEach(z => {
      const c = z[3];
      if (!c) return;
      const pw = Math.abs(c[4] - c[0]) * s;
      if (pw < 120) return;
      const x = V.tx + c[2] * s, y = V.ty - c[3] * s;   // 左上の角の内側に置く
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText('図面 ' + z[0], x + 6, y + 6);
    });
  }

  /* ── 操作（パン・ズーム・選択） ── */
  function zoomAt(k, px, py) {
    const ns = Math.min(Math.max(V.s * k, 1e-4), 20);
    k = ns / V.s;
    V.tx = px - (px - V.tx) * k; V.ty = py - (py - V.ty) * k; V.s = ns;
    draw();
  }
  cvHost.addEventListener('wheel', e => {
    e.preventDefault();
    const r = cvHost.getBoundingClientRect();
    zoomAt(Math.exp(-e.deltaY * .0016), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  const ptrs = new Map();
  let moved = 0, pinch = null;
  cvHost.addEventListener('pointerdown', e => {
    if (e.target.closest('.kzv-zoom')) return;
    cvHost.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = 0;
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) };
    }
    cvHost.classList.add('drag');
  });
  cvHost.addEventListener('pointermove', e => {
    if (!ptrs.has(e.pointerId)) return;
    const p = ptrs.get(e.pointerId);
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (ptrs.size === 2 && pinch) {
      const [a, b] = [...ptrs.values()];
      const dd = Math.hypot(a.x - b.x, a.y - b.y);
      const r = cvHost.getBoundingClientRect();
      zoomAt(dd / pinch.d, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
      pinch.d = dd; moved = 99;
      return;
    }
    moved += Math.abs(dx) + Math.abs(dy);
    V.tx += dx; V.ty += dy; draw();
  });
  function up(e) {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.delete(e.pointerId);
    if (ptrs.size < 2) pinch = null;
    if (!ptrs.size) cvHost.classList.remove('drag');
    if (moved < 6 && e.type === 'pointerup') {
      const r = cvHost.getBoundingClientRect();
      pick(e.clientX - r.left, e.clientY - r.top);
    }
  }
  cvHost.addEventListener('pointerup', up);
  cvHost.addEventListener('pointercancel', up);
  ov.querySelectorAll('[data-z]').forEach(b => b.addEventListener('click', () => zoomAt(+b.dataset.z, V.w / 2, V.h / 2)));
  ov.querySelector('[data-fit]').addEventListener('click', () => { fit(); draw(); });
  window.addEventListener('resize', () => { if (ov.classList.contains('on')) { resize(); draw(); } });

  function inRing(r, x, y) {
    let c = false;
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const yi = r[i + 1], yj = r[j + 1];
      if ((yi > y) !== (yj > y) && x < (r[j] - r[i]) * (y - yi) / (yj - yi) + r[i]) c = !c;
    }
    return c;
  }
  function pick(px, py) {
    const x = (px - V.tx) / V.s, y = (V.ty - py) / V.s;   // 図面座標（x=Y東, y=X北）
    let got = -1;
    for (let k = V.fude.length - 1; k >= 0; k--) {
      const f = V.fude[k], b = f.bb;
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
      let inside = false;
      for (const poly of f.polys) {
        if (!inRing(poly[0], x, y)) continue;
        let hole = false;
        for (let h = 1; h < poly.length; h++) if (inRing(poly[h], x, y)) { hole = true; break; }
        if (!hole) { inside = true; break; }
      }
      if (inside) { got = k; break; }
    }
    select(got);
    if (got >= 0) bcOnce('kouzu_view_fude');
  }
  function select(k) {
    V.sel = k;
    const el = $('#kzvInfo');
    if (k < 0) {
      el.innerHTML = '<span class="kzv-dim">筆を押すと地番と図面の情報を表示します</span>';
    } else {
      const f = V.fude[k], z = (V.doc.z || [])[f.sheet];
      const kind = z ? (V.doc.t || [])[z[2]] || '' : '';
      el.innerHTML = '<b>' + esc(f.town) + ' ' + esc(f.chiban || '（地番なし）') + '</b>'
        + (z ? '<span class="kzv-dim">図面 ' + esc(z[0]) + (z[1] ? '・縮尺 1/' + z[1] : '') + (kind ? '・' + esc(kind) : '') + '</span>' : '')
        + (f.parts ? '<span class="kzv-dim">筆界未定（' + esc(f.parts.join('、')) + '）</span>' : '')
        + (document.getElementById('askOpen') ? '<button type="button" class="kzv-btn kzv-ask" style="margin-left:auto;font-size:14px">この土地の評価を相談</button>' : '');
    }
    draw();
  }

  /* 選んだ筆から相談へ直行（登録を挟まない＝Codex 壁打ち r1/r2 一致）。本文に所在と地番を入れておく */
  $('#kzvInfo').addEventListener('click', e => {
    if (!e.target.closest('.kzv-ask') || V.sel < 0) return;
    const f = V.fude[V.sel];
    const muni = (P.index && P.index.n && V.doc && P.index.n[V.doc.c]) || '';
    close();
    bc('kouzu_view_ask');
    const open = document.getElementById('askOpen');
    if (open) open.click();
    const body = document.getElementById('askBody');
    if (body && !body.value) body.value = muni + ' ' + f.town + ' ' + f.chiban + ' について（公図から）\n';
  });

  /* ── 地番検索 ── */
  function normChiban(s) {
    return String(s || '').replace(/[０-９－ー―‐]/g, ch => ch === '－' || ch === 'ー' || ch === '―' || ch === '‐' ? '-' : String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .replace(/番地?の?/g, '-').replace(/[\s　]/g, '').replace(/-+$/, '');
  }
  function search() {
    const q = normChiban($('#kzvQ').value);
    V.hits = [];
    if (!q || !V.doc) { $('#kzvHit').textContent = ''; draw(); return; }
    V.fude.forEach((f, i) => {
      const c = normChiban(f.chiban);
      /* 末尾一致は「数字・ハイフンの切れ目」でだけ認める＝「9」で 19・29 を拾わない。町名つき（府内町2丁目9）も通す */
      const tail = s => { s = normChiban(s); return s === q || (s.endsWith(q) && !/[0-9-]/.test(s.charAt(s.length - q.length - 1))); };
      if (c === q || tail(f.town + f.chiban) || (f.parts && f.parts.some(tail))) V.hits.push(i);
    });
    bcOnce('kouzu_view_search');
    if (!V.hits.length) {
      /* 自治体地番図の表記を法務局の表記に読み替えて再検索（熊本市の実測: 'M864'＝'又864'・'71G-6'＝'71・72合併6'）。
         合併は相手の番号が分からないので「合併」を含み、本番と枝番の両方を含む筆を採る */
      let mg;
      if ((mg = /^M(\d+(?:-\d+)*)$/.exec(q))) {
        V.fude.forEach((f, i) => { if (normChiban(f.chiban) === '又' + mg[1]) V.hits.push(i); });
      } else if ((mg = /^(\d+)G(?:-(\d+))?$/.exec(q))) {
        V.fude.forEach((f, i) => {
          const c = normChiban(f.chiban);
          if (c.indexOf('合併') < 0) return;
          const nums = c.split('合併')[0].split(/[・,、]/), tail = c.split('合併')[1] || '';
          if (nums.indexOf(mg[1]) >= 0 && (!mg[2] || tail.replace(/^-/, '') === mg[2])) V.hits.push(i);
        });
      }
    }
    if (!V.hits.length) { $('#kzvHit').textContent = 'この図面には見つかりません'; select(-1); return false; }
    $('#kzvHit').textContent = V.hits.length > 1 ? V.hits.length + '筆が該当' : '';
    let bb = [1e18, 1e18, -1e18, -1e18];
    V.hits.forEach(i => { const b = V.fude[i].bb; bb = [Math.min(bb[0], b[0]), Math.min(bb[1], b[1]), Math.max(bb[2], b[2]), Math.max(bb[3], b[3])]; });
    const pad = 4000;   // 周りの筆が見えるように40m広げる
    fit([bb[0] - pad, bb[1] - pad, bb[2] + pad, bb[3] + pad]);
    select(V.hits.length === 1 ? V.hits[0] : -1);
    return true;
  }
  $('#kzvGo').addEventListener('click', search);
  $('#kzvQ').addEventListener('keydown', e => { if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); search(); } });
  $('#kzvQ').addEventListener('search', search);   // type=search の Enter／×クリア

  /* ── 開く ── */
  let list = [];
  async function show(i) {
    const it = list[i];
    const gen = ++V.gen;
    ov.querySelectorAll('.kzv-chip').forEach((c, k) => c.classList.toggle('on', k === i));
    const muni = (P.index && P.index.n && P.index.n[it.city]) || '';
    $('#kzvTitle').textContent = '公図　' + muni + ' ' + it.town;
    V.doc = null; V.fude = []; select(-1); $('#kzvHit').textContent = '';
    msg('図面を読み込み中…');
    try {
      const doc = await loadArea(it.city, it.area);
      if (gen !== V.gen) return;
      prep(doc);
      resize(); fit(); msg('');
      if ($('#kzvQ').value) {
        const ok = search();
        /* 自治体図の筆から来て、同じ町名の図面が複数ある（釜尾町＝2区域など）なら、見つかるまで次の同名候補を試す */
        if (!ok && it.nm && !it.tried) {
          it.tried = true;
          const nx = list.findIndex((o, k) => k > i && o.nm && !o.tried && o.town === it.town);
          if (nx >= 0) { show(nx); return; }
        }
      } else draw();
    } catch (e) {
      if (gen !== V.gen) return;
      msg(e.message || String(e));
    }
  }
  function openList(items, i, src, q) {
    list = items;
    const chips = $('#kzvChips');
    chips.innerHTML = items.length > 1 ? items.map((it, k) =>
      '<button type="button" class="kzv-chip" data-k="' + k + '">' + esc(it.town) + (it.d != null ? ' <span style="opacity:.6">' + (it.d < 1000 ? Math.round(it.d / 10) * 10 + 'm' : (it.d / 1000).toFixed(1) + 'km') + '</span>' : '')
        + ((it.fude != null && items.some((o, j) => j !== k && o.town === it.town)) ? ' <span style="opacity:.6">' + it.fude + '筆</span>' : '') + '</button>').join('') : '';
    chips.querySelectorAll('.kzv-chip').forEach(c => c.addEventListener('click', () => show(+c.dataset.k)));
    $('#kzvQ').value = q || '';   // 地番つきで開かれたら show() がその地番を検索した状態で描く（該当なし・複数該当はそのまま見せる）
    ov.classList.add('on');
    bc('kouzu_view_open', '&src=' + (src || ''));
    requestAnimationFrame(() => { resize(); show(i || 0); });
  }

  /* 地点から近い公図（任意座標）を探して開く。無ければ false（呼び出し側が従来の案内に落とす） */
  async function openNear(lat, lng, src, q, town, code) {
    await pIndex();
    const b = L.latLngBounds([lat - .03, lng - .04], [lat + .03, lng + .04]);
    const data = await Promise.all(prefsIn(b).map(pPref));
    const here = L.latLng(lat, lng);
    let items = [];
    data.forEach(d => (d.p || []).forEach(r => {
      const dist = here.distanceTo([r[3], r[4]]);
      if (dist <= NEAR_M) items.push({ city: r[0], area: r[1], town: r[2], fude: r[5], d: dist });
    }));
    /* 自治体図の筆（大字＋地番）から来たとき＝その町を含む地番区域を先頭に置く。
       ピンの名前は区域の最多の町だけなので、区域の全町名（{県}.json の t）も引く（京都市中京区＝1区域に20町・帯屋町は4番区域の3番目）。
       市区町村は自治体コードで絞る（政令市 26100 → 区 261xx）＝同名の町を別の市で拾わない */
    let keep = 10;   // チップに出す候補数。同名候補（自動試行の対象）は全部残す（Codex 指摘・2026-09-15）
    const t = String(town || '').replace(/[\s　]/g, '');
    const t2 = t.replace(/^.+?区/, '');                       // 「中京区帯屋町」→「帯屋町」
    const cc = String(code || '');
    const cityOk = c => !cc || (cc.slice(3) === '00' ? c.slice(0, 3) === cc.slice(0, 3) : c === cc);
    const nameHit = n => { const u = String(n || '').replace(/[\s　]/g, ''); const u2 = u.replace(/（.*）$/, ''); return u.length >= 2 && (u === t || u === t2 || u2 === t || u2 === t2); };
    if (t2.length >= 2) {
      const hits = [];
      data.forEach(d => {
        (d.p || []).forEach(r => { if (cityOk(r[0]) && nameHit(r[2])) hits.push({ city: r[0], area: r[1], town: r[2], fude: r[5], d: here.distanceTo([r[3], r[4]]), nm: true }); });
        (d.u || []).forEach(r => { if (cityOk(r[0]) && nameHit(r[2])) hits.push({ city: r[0], area: r[1], town: r[2], fude: r[3], d: null, nm: true }); });
        const tm = d.t || {};
        for (const k in tm) {
          const city = k.slice(0, 5), area = k.slice(6);
          if (!cityOk(city)) continue;
          const nm = tm[k].find(nameHit);
          if (!nm) continue;
          if (hits.some(h => h.city === city && h.area === area)) continue;
          const pr = (d.p || []).find(r => r[0] === city && r[1] === area);
          hits.push({ city: city, area: area, town: nm, fude: pr ? pr[5] : null, d: pr ? here.distanceTo([pr[3], pr[4]]) : null, nm: true });
        }
      });
      hits.sort((a, b) => (a.d == null) - (b.d == null) || (a.d || 0) - (b.d || 0));
      const key = h => h.city + '-' + h.area;
      const seen = new Set(hits.map(key));
      items.sort((a, b) => a.d - b.d);
      items = hits.concat(items.filter(it => !seen.has(key(it))));
      keep = Math.max(10, hits.length);
    } else {
      items.sort((a, b) => a.d - b.d);
    }
    if (!items.length) return false;
    openList(items.slice(0, keep), 0, src, q);
    return true;
  }

  window.rkKouzu = {
    openNear: openNear,
    open: function (city, area, town) { openList([{ city: String(city), area: String(area), town: town || '' }], 0, 'api'); }
  };
})();
