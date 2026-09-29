/* rosenka-core.js — 国税庁 路線価図の図郭特定ロジック（ブラウザ版）
 *
 * 仕組み:
 *  1. 国税庁サイトの索引図(HTMLイメージマップ)から図郭ごとのピクセル矩形を取得
 *  2. 町丁名索引(町丁名→図番号)をGSIジオコーダで座標化し、最小二乗で
 *     ピクセル格子⇔緯度経度のアフィン変換を自己校正（市区町村ごとに1回・キャッシュ）
 *  3. 地点→該当図郭・PDF URL・グリッド全体のbboxを返す
 *
 * CORSの都合: 国税庁・maps.gsi.go.jp・逆ジオコーダは /api/rosenka-proxy 経由、
 * 住所検索(msearch.gsi.go.jp)はCORS開放済みなので直接fetch。
 * cache 引数: { get(key)->Promise<obj|null>, set(key,obj)->Promise } を注入する。
 */
(function (root) {
  'use strict';

  const NTA = 'https://www.rosenka.nta.go.jp/';
  const PROXY = u => '/api/rosenka-proxy?u=' + encodeURIComponent(u);

  async function fetchSJIS(url) {
    const res = await fetch(PROXY(url));
    if (!res.ok) throw new Error('fetch ' + res.status + ': ' + url);
    const buf = await res.arrayBuffer();
    return new TextDecoder('shift_jis').decode(buf);
  }

  async function fetchJSON(url, viaProxy) {
    const res = await fetch(viaProxy ? PROXY(url) : url);
    if (!res.ok) throw new Error('fetch ' + res.status + ': ' + url);
    return res.json();
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---------------- NTAサイト構造 ----------------

  async function getPrefs(cache) {
    // 年度判定は24時間だけキャッシュ（毎年7月の新年度公開を自動で拾うため）
    const c = await cache.get('prefs');
    if (c && c.ts && Date.now() - c.ts < 86400000) return c;
    const html = await fetchSJIS(NTA);
    const hits = [];
    for (const tag of html.match(/<a(?:rea)?\s[^>]*pref_frm\.htm[^>]*>/g) || []) {
      const m = tag.match(/href="(main_[rh]\d+)\/([a-z_0-9]+)\/([a-z_0-9]+)\/pref_frm\.htm"/);
      const t = tag.match(/title="([^"]+?)へ移動します"/);
      if (m && t) hits.push({ year: m[1], bureau: m[2], dir: m[3], name: t[1] });
    }
    if (!hits.length) throw new Error('国税庁トップページの解析に失敗しました');
    const year = hits.map(h => h.year).sort().pop();
    const seen = new Set();
    const prefs = [];
    for (const h of hits) {
      if (h.year !== year || seen.has(h.dir)) continue;
      seen.add(h.dir);
      // 正式名称化（「東京都」に「京都」が部分一致する事故を防ぐ）
      let full = h.name;
      if (h.name === '東京') full += '都';
      else if (h.name === '大阪' || h.name === '京都') full += '府';
      else if (h.name !== '北海道') full += '県';
      prefs.push({ bureau: h.bureau, dir: h.dir, name: full });
    }
    const obj = { year, prefs, ts: Date.now() };
    await cache.set('prefs', obj);
    return obj;
  }

  async function getCities(meta, pref, cache) {
    // v2: 政令市の同名区（横浜市緑区／相模原市緑区など）は title 属性の正式名で区別する
    const key = 'cities_v2_' + meta.year + '_' + pref.dir;
    const c = await cache.get(key);
    if (c) return c;
    const url = `${NTA}${meta.year}/${pref.bureau}/${pref.dir}/prices/city_frm.htm`;
    const html = await fetchSJIS(url);
    const cities = [];
    for (const m of html.matchAll(/href="([a-z]\d+fr\.htm)"([^>]*)>\s*([^<]+)/g)) {
      const short = m[3].trim();
      if (!short) continue;
      const titleM = m[2].match(/title="([^"]+)"/);
      // title は「横浜市緑区」など市区付き。無い場合はリンク文言（緑区）を使う
      const name = (titleM && titleM[1].trim()) || short;
      cities.push({ page: m[1], name, short });
    }
    await cache.set(key, cities);
    return cities;
  }

  /* GSI市区町村名（例: 横浜市緑区）→ 国税庁の市区町村ページを一意に選ぶ
   * 注意: 「横浜市港南区」は「南区」を部分文字列に含むため、includes 照合は使わない。
   * 区名は末尾一致＋最長一致で選ぶ（港南区 > 南区）。 */
  function resolveCity(cities, muniCity) {
    if (!muniCity) return null;
    const exact = cities.find(ct => ct.name === muniCity);
    if (exact) return exact;

    const shortOf = ct => ct.short || ct.name;

    // short の完全一致は、同名が複数あると危険なので一意なときだけ
    const byShortExact = cities.filter(ct => shortOf(ct) === muniCity);
    if (byShortExact.length === 1) return byShortExact[0];
    if (byShortExact.length > 1) {
      // 「緑区」など同名区: 市区付き正式名が無いと区別不能
      const full = byShortExact.filter(ct => ct.name !== shortOf(ct));
      if (full.length === 1) return full[0];
      return null;
    }

    // 正式名の末尾一致（横浜市港南区 ends with 港南区 / name ends with muniCity）
    const byNameSuffix = cities.filter(ct =>
      muniCity.endsWith(ct.name) || ct.name.endsWith(muniCity)
    );
    if (byNameSuffix.length === 1) return byNameSuffix[0];
    if (byNameSuffix.length > 1) {
      byNameSuffix.sort((a, b) => b.name.length - a.name.length);
      if (byNameSuffix[0].name.length > byNameSuffix[1].name.length) return byNameSuffix[0];
    }

    // 区名 short の末尾一致。最長を優先（港南区 > 南区）
    const byShortSuffix = cities.filter(ct => muniCity.endsWith(shortOf(ct)));
    if (!byShortSuffix.length) return null;
    byShortSuffix.sort((a, b) => {
      const ds = shortOf(b).length - shortOf(a).length;
      if (ds) return ds;
      return b.name.length - a.name.length;
    });
    const bestShort = shortOf(byShortSuffix[0]);
    const topShort = byShortSuffix.filter(ct => shortOf(ct) === bestShort);
    if (topShort.length === 1) return topShort[0];

    // 同名 short が複数（横浜市緑区 / 相模原市緑区）: 正式名が muniCity と一致 or 末尾一致するもの
    const named = topShort.filter(ct =>
      ct.name === muniCity || muniCity.endsWith(ct.name) || ct.name.endsWith(muniCity)
    );
    if (named.length === 1) return named[0];
    if (named.length > 1) {
      named.sort((a, b) => b.name.length - a.name.length);
      if (named[0].name.length > named[1].name.length) return named[0];
    }
    // 市区付き正式名が取れない同名区は曖昧
    return null;
  }

  // ---------------- ジオコーダ ----------------

  const KAN = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '七', 8: '八', 9: '九' };

  function normTown(t) {
    t = t.replace(/（[^）]*）/g, '').trim();
    const m = t.match(/^(.+?)([０-９0-9]+)$/);
    if (m) {
      const d = m[2].replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
      const n = parseInt(d, 10);
      if (n >= 1 && n <= 9) return m[1] + KAN[n] + '丁目';
      if (n >= 10 && n <= 19) return m[1] + '十' + (n % 10 ? KAN[n % 10] : '') + '丁目';
    }
    return t;
  }

  async function geocode(query, mustContain) {
    const url = 'https://msearch.gsi.go.jp/address-search/AddressSearch?q=' + encodeURIComponent(query);
    let j;
    try { j = await fetchJSON(url, false); } catch (e) { return null; }
    for (const cand of j || []) {
      const title = (cand.properties && cand.properties.title) || '';
      // 政令市の同名区は「緑区」だけでは区別できないので、必ず市区付き（横浜市緑区等）で絞り込む
      if (mustContain && !title.includes(mustContain)) continue;
      return { lon: cand.geometry.coordinates[0], lat: cand.geometry.coordinates[1], title };
    }
    return null;
  }

  async function revGeocode(lat, lon) {
    const url = `https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}`;
    try {
      const j = await fetchJSON(url, true);
      return (j && j.results) || null;
    } catch (e) { return null; }
  }

  async function getMuniMap(cache) {
    const c = await cache.get('muni');
    if (c) return c;
    const res = await fetch(PROXY('https://maps.gsi.go.jp/js/muni.js'));
    const buf = await res.arrayBuffer();
    let txt = '';
    for (const enc of ['utf-8', 'shift_jis', 'euc-jp']) {
      try {
        const t = new TextDecoder(enc, { fatal: false }).decode(buf);
        if (t.includes('北海道')) { txt = t; break; }
      } catch (e) { /* 次のエンコーディングへ */ }
    }
    const muni = {};
    for (const m of txt.matchAll(/MUNI_ARRAY\["\d+"\]\s*=\s*'([^']+)'/g)) {
      const parts = m[1].split(',');
      if (parts.length >= 4) {
        muni[String(parseInt(parts[2], 10))] = {
          pref: parts[1].trim(),
          city: parts[3].replace(/　/g, '').trim()
        };
      }
    }
    if (!Object.keys(muni).length) throw new Error('muni.jsの解析に失敗しました');
    await cache.set('muni', muni);
    return muni;
  }

  // ---------------- 校正 ----------------

  function parseTownsInto(h, towns) {
    for (const m of h.matchAll(/<th>([^<]+)<\/th>((?:\s*<td[^>]*>\s*<a href="html\/\d+f\.htm">\d+<\/a>\s*<\/td>)+)/g)) {
      const name = m[1].trim();
      if (!name) continue;
      if (!towns[name]) towns[name] = [];
      for (const s of m[2].matchAll(/>(\d+)</g)) {
        if (!towns[name].includes(s[1])) towns[name].push(s[1]);
      }
    }
  }

  // 町丁名索引（町丁名→図番号）だけを取る。年度切替の図番号照合にも使うため単独関数
  async function parseCityTowns(cityBase, frPage) {
    const html = await fetchSJIS(cityBase + frPage);
    const stem = frPage.match(/^([a-z]\d+)fr/)[1];
    const frPages = new Set([frPage]);
    for (const m of html.matchAll(new RegExp('href="(' + stem + 'fr\\d*\\.htm)"', 'g'))) frPages.add(m[1]);
    const towns = {};
    const htmls = { [frPage]: html };
    for (const p of [...frPages].sort()) {
      const h = htmls[p] || await fetchSJIS(cityBase + p);
      parseTownsInto(h, towns);
    }
    return { towns, html };
  }

  async function parseCityPages(cityBase, frPage) {
    const { towns, html } = await parseCityTowns(cityBase, frPage);
    const mpPages = new Set();
    for (const m of html.matchAll(/href="(map\/[a-z]\d+mp\d*\.htm)"/g)) mpPages.add(m[1]);
    const images = [];
    for (const mp of [...mpPages].sort()) {
      const h = await fetchSJIS(cityBase + mp);
      const imgByMap = {};
      for (const m of h.matchAll(/<img src="([a-z][\d_]+\.gif)"\s+usemap="#(\w+)"[^>]*width="(\d+)"\s+height="(\d+)"/g)) {
        imgByMap[m[2]] = { gif: m[1], w: +m[3], h: +m[4] };
      }
      for (const m of h.matchAll(/<map\s+(?:name|id)="(\w+)"[^>]*>([\s\S]*?)<\/map>/g)) {
        const items = [];
        for (const a of m[2].matchAll(/coords="([\d,\s]+)"\s+href="\.\.\/html\/(\d+)f\.htm"/g)) {
          const nums = (a[1].match(/\d+/g) || []).map(Number);
          const xs = nums.filter((_, i) => i % 2 === 0);
          const ys = nums.filter((_, i) => i % 2 === 1);
          if (xs.length && ys.length) {
            items.push({
              id: a[2],
              rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
            });
          }
        }
        if (items.length && imgByMap[m[1]]) {
          images.push({ gif: imgByMap[m[1]].gif, mp, w: imgByMap[m[1]].w, h: imgByMap[m[1]].h, items });
        }
      }
    }
    return { towns, images };
  }

  // lon = a*px + b, lat = c*py + d（回転なし・北上仮定）
  function fitAffine(P) {
    const n = P.length;
    let sx = 0, sy = 0, slon = 0, slat = 0, sxx = 0, syy = 0, sxlon = 0, sylat = 0;
    for (const p of P) {
      sx += p[0]; sy += p[1]; slon += p[2]; slat += p[3];
      sxx += p[0] * p[0]; syy += p[1] * p[1];
      sxlon += p[0] * p[2]; sylat += p[1] * p[3];
    }
    const dx = n * sxx - sx * sx, dy = n * syy - sy * sy;
    if (Math.abs(dx) < 1e-9 || Math.abs(dy) < 1e-9) return null;
    const a = (n * sxlon - sx * slon) / dx;
    const b = (slon - a * sx) / n;
    const c = (n * sylat - sy * slat) / dy;
    const d = (slat - c * sy) / n;
    if (Math.abs(a) < 1e-12 || Math.abs(c) < 1e-12) return null;
    return [a, b, c, d];
  }

  const median = arr => arr.slice().sort((x, y) => x - y)[Math.floor(arr.length / 2)];

  const PRE_GRID = 'https://dead-or-alive.pages.dev/rosenka-walker/layers/rosenka_grid/';
  const swOf = img => median(Object.values(img.sheets || {}).map(r => r[2] - r[0]));
  const shOf = img => median(Object.values(img.sheets || {}).map(r => r[3] - r[1]));

  function parseConnect(html) {
    const m = html.match(/<table[^>]*tbl_connectmap[^>]*>([\s\S]*?)<\/table>/);
    if (!m) return null;
    const rows = [...m[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(tr =>
      [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(td => {
        const d = td[1].match(/\d{5}/);
        return d ? d[0] : null;
      }));
    if (rows.length !== 3 || rows.some(r => r.length !== 3)) return null;
    return { n: rows[0][1], s: rows[2][1], w: rows[1][0], e: rows[1][2] };
  }

  function edgeSheets(img) {
    const S = img.sheets, out = { n: [], s: [], e: [], w: [] };
    for (const [sid, r] of Object.entries(S)) {
      const w = r[2] - r[0], h = r[3] - r[1];
      const has = (dx, dy) => {
        const cx = (r[0] + r[2]) / 2 + dx * w, cy = (r[1] + r[3]) / 2 + dy * h;
        return Object.values(S).some(q => q[0] <= cx && cx <= q[2] && q[1] <= cy && cy <= q[3]);
      };
      if (!has(1, 0)) out.e.push(sid);
      if (!has(-1, 0)) out.w.push(sid);
      if (!has(0, -1)) out.n.push(sid);
      if (!has(0, 1)) out.s.push(sid);
    }
    return out;
  }

  async function stitchImages(cityBase, images, onProgress) {
    const n = images.length, conn = {};
    if (n < 2) return { offs: images.map(() => [0, 0]), comp: images.map(() => 0), conn };
    const SW = images.map(swOf), SH = images.map(shOf);
    const where = {};
    images.forEach((img, i) => { for (const sid in img.sheets) where[sid] = i; });
    const groups = [];
    images.forEach((img, i) => {
      const E = edgeSheets(img);
      for (const d of ['n', 's', 'e', 'w']) {
        const lst = E[d].map(sid => {
          const r = img.sheets[sid];
          const dist = d === 'e' ? img.w - r[2] : d === 'w' ? r[0] : d === 'n' ? r[1] : img.h - r[3];
          return [dist, sid];
        }).sort((a, b) => a[0] - b[0]);
        if (lst.length) groups.push({ i, d, lst, dead: 0 });
      }
    });
    groups.sort((a, b) => a.lst[0][0] - b.lst[0][0]);
    const jobs = [];
    for (let k = 0; groups.some(g => g.lst.length); k++) {
      const g = groups[k % groups.length];
      if (g.lst.length) jobs.push([g, g.lst.shift()[1]]);
    }
    const TOL = 0.25, BUDGET = 24, pairs = {};
    const cluster = v => {
      let best = [];
      for (const o of v) {
        const c = v.filter(p => Math.abs(p[0] - o[0]) <= TOL && Math.abs(p[1] - o[1]) <= TOL);
        if (c.length > best.length) best = c;
      }
      return best;
    };
    const strongEdges = () => Object.entries(pairs).filter(([, v]) => cluster(v).length >= 2).map(([k]) => k.split(',').map(Number));
    const connected = () => {
      const adj = images.map(() => []);
      for (const [i, j] of strongEdges()) { adj[i].push(j); adj[j].push(i); }
      const seen = new Set([0]), st = [0];
      while (st.length) {
        const x = st.pop();
        for (const y of adj[x]) if (!seen.has(y)) { seen.add(y); st.push(y); }
      }
      return seen.size === n;
    };
    let fetched = 0, p = 0;
    while (p < jobs.length && fetched < BUDGET && !connected()) {
      const batch = [];
      while (batch.length < 4 && p < jobs.length && fetched + batch.length < BUDGET) {
        const jb = jobs[p++];
        if (jb[0].dead >= 2) continue;
        batch.push(jb);
      }
      if (!batch.length) break;
      fetched += batch.length;
      await Promise.all(batch.map(async ([g, sid]) => {
        let c = null;
        try { c = parseConnect(await fetchSJIS(cityBase + 'html/' + sid + 'f.htm')); } catch (e) { /* empty */ }
        if (c) conn[sid] = c;
        const t = c && c[g.d];
        const j = t ? where[t] : undefined;
        if (j === undefined || j === g.i) { g.dead++; return; }
        g.dead = 0;
        const ra = images[g.i].sheets[sid], rb = images[j].sheets[t];
        const ua = ra[0] / SW[g.i], va = ra[1] / SH[g.i], ub = rb[0] / SW[j], vb = rb[1] / SH[j];
        const exp = { e: [ua + 1, va], w: [ua - 1, va], n: [ua, va - 1], s: [ua, va + 1] }[g.d];
        const off = [exp[0] - ub, exp[1] - vb];
        const key = g.i < j ? g.i + ',' + j : j + ',' + g.i;
        (pairs[key] = pairs[key] || []).push(g.i < j ? off : [-off[0], -off[1]]);
      }));
      if (onProgress) onProgress('索引図をつなぎ合わせ中… ' + fetched);
    }
    const edges = Object.entries(pairs).map(([k, v]) => {
      const c = cluster(v);
      return { ij: k.split(',').map(Number), n: c.length, o: [median(c.map(x => x[0])), median(c.map(x => x[1]))] };
    }).sort((a, b) => b.n - a.n);
    const offs = images.map(() => null), comp = images.map(() => null);
    let cid = 0;
    for (let r = 0; r < n; r++) {
      if (offs[r]) continue;
      offs[r] = [0, 0]; comp[r] = cid;
      const st = [r];
      while (st.length) {
        const x = st.pop();
        for (const e of edges) {
          const [i, j] = e.ij;
          if (i === x && !offs[j]) { offs[j] = [offs[i][0] + e.o[0], offs[i][1] + e.o[1]]; comp[j] = cid; st.push(j); }
          else if (j === x && !offs[i]) { offs[i] = [offs[j][0] - e.o[0], offs[j][1] - e.o[1]]; comp[i] = cid; st.push(i); }
        }
      }
      cid++;
    }
    return { offs, comp, conn, fetched };
  }

  function fitShared(P) {
    const byc = {};
    for (const p of P) (byc[p[7]] = byc[p[7]] || []).push(p);
    let na = 0, da = 0, nc = 0, dc = 0;
    const means = {};
    for (const [c, L] of Object.entries(byc)) {
      const mu = L.reduce((sum, p) => sum + p[0], 0) / L.length;
      const mv = L.reduce((sum, p) => sum + p[1], 0) / L.length;
      const ml = L.reduce((sum, p) => sum + p[2], 0) / L.length;
      const mt = L.reduce((sum, p) => sum + p[3], 0) / L.length;
      means[c] = [mu, mv, ml, mt];
      for (const p of L) {
        na += (p[0] - mu) * (p[2] - ml); da += (p[0] - mu) * (p[0] - mu);
        nc += (p[1] - mv) * (p[3] - mt); dc += (p[1] - mv) * (p[1] - mv);
      }
    }
    if (da < 1e-9 || dc < 1e-9) return null;
    const A = na / da, C = nc / dc;
    if (Math.abs(A) < 1e-12 || Math.abs(C) < 1e-12) return null;
    const T = {};
    for (const [c, [mu, mv, ml, mt]] of Object.entries(means)) T[c] = [A, ml - A * mu, C, mt - C * mv];
    return T;
  }


  // 路線価図の紙面はほぼ横長（縦1 : 横1.4 ≒ A判）。大きく外れたときだけ直す
  const SHEET_ASPECT_WH = 1.4;
  const SHEET_ASPECT_MIN = 1.12;
  const SHEET_ASPECT_MAX = 1.75;
  // 大磯・二宮は海岸沿い図郭の南北が短く出やすいので、縦を広めに取る
  const COASTAL_GRID_CITIES = new Set(['大磯町', '二宮町']);
  const SHEET_ASPECT_COASTAL_WH = 1.05;
  const SHEET_ASPECT_COASTAL_MIN = 0.9;
  const SHEET_ASPECT_COASTAL_MAX = 1.25;
  const COASTAL_HEIGHT_BOOST = 1.28;

  function isCoastalGridCity(name) {
    return !!(name && COASTAL_GRID_CITIES.has(name));
  }

  function sheetAspectParams(geoCity) {
    if (isCoastalGridCity(geoCity)) {
      return {
        target: SHEET_ASPECT_COASTAL_WH,
        min: SHEET_ASPECT_COASTAL_MIN,
        max: SHEET_ASPECT_COASTAL_MAX
      };
    }
    return { target: SHEET_ASPECT_WH, min: SHEET_ASPECT_MIN, max: SHEET_ASPECT_MAX };
  }

  function metersPerDeg(lat) {
    const phi = (Number(lat) || 35) * Math.PI / 180;
    return { lat: 110574, lon: 111320 * Math.max(0.2, Math.cos(phi)) };
  }

  function sheetPixelSize(img) {
    const rects = Object.values(img.sheets || {});
    if (!rects.length) return { sw: 1, sh: 1 };
    return {
      sw: median(rects.map(r => r[2] - r[0])),
      sh: median(rects.map(r => r[3] - r[1]))
    };
  }

  function transformSheetAspectWH(t, img, lat0) {
    const { sw, sh } = sheetPixelSize(img);
    const m = metersPerDeg(lat0);
    const w = Math.abs(t[0]) * sw * m.lon;
    const h = Math.abs(t[2]) * sh * m.lat;
    return { wh: h > 1e-12 ? w / h : 0, sw, sh, m };
  }

  /* 図郭の地上縦横比が目標から大きく外れたら、広がりの大きい軸を残して組み直す */
  function constrainTransformAspect(t, img, pts, lat0, geoCity) {
    if (!t) return t;
    const asp = sheetAspectParams(geoCity);
    const lat = lat0 != null ? lat0 : (pts && pts.length ? median(pts.map(p => p[3])) : 35);
    const info = transformSheetAspectWH(t, img, lat);
    if (info.wh >= asp.min && info.wh <= asp.max) return t;
    const { sw, sh, m } = info;
    let pxSpan = 0, pySpan = 0;
    if (pts && pts.length) {
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      pxSpan = Math.max(...xs) - Math.min(...xs);
      pySpan = Math.max(...ys) - Math.min(...ys);
    }
    let a = t[0], c = t[2];
    if (pySpan >= pxSpan) {
      a = Math.sign(a || 1) * asp.target * Math.abs(c) * sh * m.lat / (sw * m.lon);
    } else {
      c = Math.sign(c || -1) * Math.abs(a) * sw * m.lon / (asp.target * sh * m.lat);
    }
    let b = t[1], d = t[3];
    if (pts && pts.length) {
      b = pts.reduce((s, p) => s + (p[2] - a * p[0]), 0) / pts.length;
      d = pts.reduce((s, p) => s + (p[3] - c * p[1]), 0) / pts.length;
    }
    return [a, b, c, d];
  }

  /* 海岸沿い図郭の南北方向だけ、図郭中心を保ったまま広げる */
  function boostCoastalSheetHeight(t, img, geoCity) {
    if (!t || !isCoastalGridCity(geoCity)) return t;
    if (img && img._coastBoosted) return t;
    const rects = Object.values(img.sheets || {});
    if (!rects.length) return t;
    const cy = median(rects.map(r => (r[1] + r[3]) / 2));
    const c2 = t[2] * COASTAL_HEIGHT_BOOST;
    const d2 = t[3] + t[2] * (1 - COASTAL_HEIGHT_BOOST) * cy;
    if (img) img._coastBoosted = true;
    return [t[0], t[1], c2, d2];
  }

  /* 同一GIF上の離れた切り抜き（大磯が上・二宮が下の別地図など）を塊に分ける */
  function clusterSheetItems(items) {
    if (!items.length) return [{}];
    if (items.length === 1) {
      const sh = {};
      sh[items[0].id] = items[0].rect;
      return [sh];
    }
    const n = items.length;
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const unite = (i, j) => {
      i = find(i); j = find(j);
      if (i !== j) parent[j] = i;
    };
    const gap = Math.max(
      8,
      median(items.map(it => it.rect[2] - it.rect[0])) * 0.55,
      median(items.map(it => it.rect[3] - it.rect[1])) * 0.55
    );
    for (let i = 0; i < n; i++) {
      const a = items[i].rect;
      for (let j = i + 1; j < n; j++) {
        const b = items[j].rect;
        const gx = Math.max(0, a[0] - b[2], b[0] - a[2]);
        const gy = Math.max(0, a[1] - b[3], b[1] - a[3]);
        if (gx <= gap && gy <= gap) unite(i, j);
      }
    }
    const groups = new Map();
    for (let i = 0; i < n; i++) {
      const r = find(i);
      if (!groups.has(r)) groups.set(r, {});
      groups.get(r)[items[i].id] = items[i].rect;
    }
    return [...groups.values()];
  }

  function clusterSheetGroups(sheets) {
    return clusterSheetItems(Object.entries(sheets).map(([id, rect]) => ({ id, rect })));
  }

  function splitImagesByClusters(images, citySheets) {
    const out = [];
    for (const img of images) {
      const groups = (img.items && img.items.length)
        ? clusterSheetItems(img.items)
        : clusterSheetGroups(img.sheets || {});
      const scored = groups.map(sh => {
        const ids = Object.keys(sh);
        const hit = citySheets && citySheets.size
          ? ids.filter(s => citySheets.has(s)).length
          : ids.length;
        return { sh, hit, ratio: hit / Math.max(1, ids.length) };
      }).sort((a, b) => b.ratio - a.ratio || b.hit - a.hit);
      const kept = scored.filter(g => g.ratio >= 0.45 && g.hit >= 2);
      for (const g of (kept.length ? kept : scored.slice(0, 1))) {
        const next = Object.assign({}, img, { sheets: g.sh });
        delete next.items;
        out.push(next);
      }
    }
    return out;
  }

  /* 隣接市区で同じ図番号の路線価図を共有する組。表示時は両方の枠を重ねる */
  const GRID_PARTNERS = {
    '葉山町': ['逗子市'],
    '逗子市': ['葉山町'],
    '大磯町': ['二宮町'],
    '二宮町': ['大磯町']
  };
  /* 例外組: 索引を南北/東西に張り合わせたうえで事前校正を当てる */
  const GRID_PAIR = {
    '葉山町': { partner: '逗子市', axis: 'ns' },
    '逗子市': { partner: '葉山町', axis: 'ns' },
    '大磯町': { partner: '二宮町', axis: 'ew' },
    '二宮町': { partner: '大磯町', axis: 'ew' }
  };

  function partnerNames(cityName) {
    return GRID_PARTNERS[cityName] || [];
  }

  async function fetchPreGrid(yr, code) {
    try {
      const r = await fetch(PRE_GRID + yr + '/' + code + '.json', { cache: 'no-cache' });
      if (!r.ok) return null;
      const ct = r.headers.get('content-type') || '';
      if (ct.includes('json') || ct.includes('text/plain')) return await r.json();
      const txt = await r.text();
      return txt.trim().startsWith('{') ? JSON.parse(txt) : null;
    } catch (e) {
      return null;
    }
  }

  function clearImageTransforms(images) {
    for (const img of images || []) {
      if (img.extra) continue;
      img.transform = null;
      img.quality = { hit: 0, n: 0 };
      delete img.anchored;
    }
  }

  /* 事前校正JSONを索引画像へ適用。健全でなければ破棄して false */
  function applyPreToImages(images, pre) {
    if (!pre) return false;
    const byGif = {};
    for (const pi of (pre.images || [])) byGif[pi.gif] = pi;
    if (!images.length || !images.every(img => byGif[img.gif] && byGif[img.gif].transform)) return false;
    for (const img of images) {
      const pi = byGif[img.gif];
      img.transform = pi.t6 || pi.transform;
      img.quality = pi.quality || { hit: 0, n: 0 };
      img.anchored = !!pi.anchored;
    }
    if (!preTransformsOk(images)) {
      clearImageTransforms(images);
      return false;
    }
    return true;
  }

  function addPreExtra(images, pre) {
    if (!pre || !pre.extra || !Object.keys(pre.extra).length) return;
    for (let i = images.length - 1; i >= 0; i--) {
      if (images[i].extra) images.splice(i, 1);
    }
    const sheets = {};
    for (const [sid, b] of Object.entries(pre.extra)) sheets[sid] = [b[1], b[0], b[3], b[2]];
    const est = {};
    for (const sid of (pre.extra_est || [])) est[sid] = true;
    images.push({
      gif: '_extra', mp: '', w: 0, h: 0, sheets,
      transform: [1, 0, 1, 0], quality: { hit: 1, n: 1 },
      anchored: true, extra: true, est
    });
  }

  /* 共有図番号の経緯度枠に合わせ、未校正側を隣市へ張り付ける（隣が t6 でも可） */
  function attachImagesToNeighbor(images, neighborImages, geoCity) {
    const nSheet = {};
    for (const img of neighborImages || []) {
      if (!img.transform || img.extra) continue;
      for (const [s, r] of Object.entries(img.sheets || {})) {
        if (!nSheet[s]) nSheet[s] = rectToBbox(r, img.transform);
      }
    }
    if (!Object.keys(nSheet).length) return false;
    let any = false;
    for (const img of images) {
      if (img.extra) continue;
      if (img.transform && preTransformsOk([img])) continue;
      const pts = [];
      for (const [s, r] of Object.entries(img.sheets || {})) {
        const b = nSheet[s];
        if (!b) continue;
        // b = [latS, lonW, latN, lonE] — 画像上は上が北（y小）
        pts.push([r[0], r[1], b[1], b[2]]);
        pts.push([r[2], r[1], b[3], b[2]]);
        pts.push([r[0], r[3], b[1], b[0]]);
        pts.push([r[2], r[3], b[3], b[0]]);
      }
      img.transform = null;
      img.quality = { hit: 0, n: 0 };
      delete img.anchored;
      if (pts.length < 4) continue;
      const lat0 = median(pts.map(p => p[3]));
      let t = fitAffine(pts);
      if (!t) continue;
      /* 隣市の経緯度枠に合わせるので、海岸用の縦長寄りの縦横比制約は使わない */
      t = constrainTransformAspect(t, img, pts, lat0, null) || t;
      if (isBadTransform(t) || !preTransformsOk([{ sheets: img.sheets, transform: t, extra: false }])) continue;
      img.transform = t;
      img.quality = { hit: pts.length / 4, n: pts.length / 4, nPts: pts.length / 4, medRes: 0 };
      img.anchored = true;
      any = true;
    }
    return any;
  }

  /* 共有図郭の中心が重なるよう、弱い側を軸に沿って平行移動で合わせる */
  function shiftImageTransforms(images, db, dd) {
    if (!Number.isFinite(db)) db = 0;
    if (!Number.isFinite(dd)) dd = 0;
    if (Math.abs(db) < 1e-9 && Math.abs(dd) < 1e-9) return;
    for (const img of images || []) {
      if (!img.transform || img.extra) continue;
      if (img.transform.length === 4) {
        img.transform[1] += db;
        img.transform[3] += dd;
      } else if (img.transform.length === 6) {
        img.transform[2] += db;
        img.transform[5] += dd;
      }
    }
  }

  function sharedSheetDeltas(ownImages, partnerImages) {
    const srcSheet = {};
    for (const img of partnerImages || []) {
      if (!img.transform || img.extra) continue;
      for (const [s, r] of Object.entries(img.sheets || {})) {
        if (!srcSheet[s]) srcSheet[s] = rectToBbox(r, img.transform);
      }
    }
    const dLon = [], dLat = [];
    for (const img of ownImages || []) {
      if (!img.transform || img.extra) continue;
      for (const [s, r] of Object.entries(img.sheets || {})) {
        const b0 = srcSheet[s];
        if (!b0) continue;
        const b1 = rectToBbox(r, img.transform);
        dLon.push(((b0[1] + b0[3]) - (b1[1] + b1[3])) / 2);
        dLat.push(((b0[0] + b0[2]) - (b1[0] + b1[2])) / 2);
      }
    }
    if (!dLon.length) return null;
    return { db: median(dLon), dd: median(dLat) };
  }

  /* 隣市を基準に自市を平行移動（張り付け後の位置合わせ） */
  function snapPairAlongAxis(ownImages, partnerImages, axis) {
    const d = sharedSheetDeltas(ownImages, partnerImages);
    if (!d) return;
    void axis;
    shiftImageTransforms(ownImages, d.db, d.dd);
  }

  async function nominatimPoi(query, geoCity, ok) {
    const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=jp&limit=8&q=' +
      encodeURIComponent(query);
    try {
      const j = await fetchJSON(url, true);
      for (const o of j || []) {
        const disp = o.display_name || '';
        if (!disp.includes(geoCity)) continue;
        if (ok && !ok(o)) continue;
        return { lon: +o.lon, lat: +o.lat, title: disp };
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  /* 索引図の西端列を海岸の目印に、南北は緯度で対応させて枠を置く */
  async function alignByCoastAndHall(images, prefName, geoCity) {
    const host = images.filter(i => i.transform && i.transform.length === 4).sort((a, b) =>
      Object.keys(b.sheets).length - Object.keys(a.sheets).length)[0];
    if (!host) return;
    const [marina, beach, hall] = await Promise.all([
      nominatimPoi(geoCity + 'マリーナ', geoCity, o => o.type === 'marina' || o.type === 'yes' || o.class === 'leisure'),
      nominatimPoi(geoCity + '海岸', geoCity, null),
      nominatimPoi(geoCity + '役場', geoCity, o => o.type === 'townhall' || o.addresstype === 'amenity')
    ]);
    const coastal = [marina, beach].filter(Boolean).sort((a, b) => b.lat - a.lat);
    if (!coastal.length && !hall) return;
    const minX = Math.min(...Object.values(host.sheets).map(r => r[0]));
    const west = Object.entries(host.sheets)
      .filter(([, r]) => r[0] <= minX + 8)
      .sort((a, b) => a[1][1] - b[1][1]);
    if (!west.length) return;
    const pts = [];
    coastal.forEach((poi, i) => {
      const t = coastal.length === 1 ? 0 : i / (coastal.length - 1);
      const [, r] = west[Math.round(t * (west.length - 1))];
      const px = r[0] + 0.22 * (r[2] - r[0]);
      const py = r[3] - 0.5 * (r[3] - r[1]);
      pts.push([px, py, poi.lon, poi.lat]);
    });
    if (hall && host.transform) {
      const pyHall = (hall.lat - host.transform[3]) / host.transform[2];
      const row = Object.values(host.sheets).reduce((best, r) => {
        const cy = (r[1] + r[3]) / 2;
        return Math.abs(cy - pyHall) < Math.abs((best[1] + best[3]) / 2 - pyHall) ? r : best;
      });
      const px = (row[0] + row[2]) / 2;
      const py = (row[1] + row[3]) / 2;
      pts.push([px, py, hall.lon, hall.lat]);
    }
    if (pts.length < 2) return;
    let t = fitAffine(pts);
    if (!t) return;
    t = constrainTransformAspect(t, host, pts, median(pts.map(p => p[3])), geoCity);
    const old = host.transform;
    host.transform = t;
    const hostSz = sheetPixelSize(host);
    for (const img of images) {
      if (img === host || !img.transform || img.transform.length !== 4) continue;
      const sz = sheetPixelSize(img);
      img.transform[0] = t[0] * hostSz.sw / sz.sw;
      img.transform[2] = t[2] * hostSz.sh / sz.sh;
      img.transform[1] += t[1] - old[1];
      img.transform[3] += t[3] - old[3];
    }
    host.quality = Object.assign({}, host.quality, { nPts: 60, medRes: 0 });
  }

  function isBadTransform(t) {
    if (!t || !t.length) return true;
    if (!t.every(Number.isFinite)) return true;
    if (t.length === 6) {
      // t6: [a,b,c, d,e,f] — d,e は緯度側の係数で | | は通常 1 未満
      if (Math.abs(t[3]) > 1 || Math.abs(t[4]) > 1) return true;
      if (Math.abs(t[2]) < 100 || Math.abs(t[2]) > 180) return true; // lon オフセット
      if (Math.abs(t[5]) < 20 || Math.abs(t[5]) > 50) return true;  // lat オフセット
      return false;
    }
    if (t.length === 4) {
      if (Math.abs(t[1]) < 100 || Math.abs(t[1]) > 180) return true;
      if (Math.abs(t[3]) < 20 || Math.abs(t[3]) > 50) return true;
      return false;
    }
    return true;
  }

  function sheetLonSpan(img, t) {
    if (!t || !img || !img.sheets) return NaN;
    if (t.length === 6) {
      const spans = Object.values(img.sheets).map(r => {
        const b = rectToBbox(r, t);
        return Math.abs(b[3] - b[1]);
      });
      if (!spans.length) return NaN;
      return median(spans);
    }
    const spans = Object.values(img.sheets).map(r => Math.abs(t[0]) * (r[2] - r[0]));
    if (!spans.length) return NaN;
    return median(spans);
  }

  function sheetLatSpan(img, t) {
    if (!t || !img || !img.sheets) return NaN;
    if (t.length === 6) {
      const spans = Object.values(img.sheets).map(r => {
        const b = rectToBbox(r, t);
        return Math.abs(b[2] - b[0]);
      });
      if (!spans.length) return NaN;
      return median(spans);
    }
    if (t.length !== 4) return NaN;
    const spans = Object.values(img.sheets).map(r => Math.abs(t[2]) * (r[3] - r[1]));
    if (!spans.length) return NaN;
    return median(spans);
  }

  /* 事前校正の健全性: 図郭の東西幅は概ね 0.0065〜0.0125°（約600〜1100m）。
     南北も同程度必要（極端に東西だけ長い変換は棄却）。
     索引図1枚に縮尺の違う塊が混在する市区（鶴見区など）では、同一GIFに同じ変換を
     かけると一部クラスタだけ図郭が1.5〜2倍に膨らむ。ウォーカーも同じ事前校正を使うが、
     こちらはクラスタ分割後に検出し、壊れた事前校正は捨てて接続図校正へ落とす。 */
  function preTransformsOk(images) {
    const spans = [];
    for (const img of images) {
      if (!img || img.extra || !img.transform) continue;
      const lon = sheetLonSpan(img, img.transform);
      const lat = sheetLatSpan(img, img.transform);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
      if (lon < 0.0065 || lon > 0.0125) return false;
      /* 南北が極端に短いと東西に延びて見える（大磯の壊れた事前校正など） */
      if (lat < 0.0028 || lat > 0.010) return false;
      const wh = lon / lat;
      if (wh < 0.85 || wh > 2.5) return false;
      spans.push(lon);
    }
    if (spans.length >= 2) {
      const ratio = Math.max(...spans) / Math.min(...spans);
      if (ratio > 1.2) return false;
    }
    return spans.length > 0;
  }

  async function peekCalib(cache, yr, code, geoCity) {
    for (const ver of [25]) {
      const c = await cache.get('calib_v' + ver + '_' + yr + '_' + code);
      if (c && c.images && c.images.some(i => i.transform) &&
          (!geoCity || !c.geoCity || c.geoCity === geoCity)) {
        const bad = (c.images || []).some(img => !img.extra && isBadTransform(img.transform));
        if (bad) return null;
        if (c.pre && !preTransformsOk(c.images || [])) return null;
        return c;
      }
    }
    return null;
  }

  const calibInflight = new Map();
  async function calibrate(prefName, city, geoCityName, cityBase, cache, onProgress, cityList, onTowns) {
    const code = city.page.match(/^([a-z]\d+)fr/)[1];
    const yr = (cityBase.match(/main_[rh]\d+/) || ['y'])[0];
    const geoCity = geoCityName || city.name || '';
    const inflightKey = yr + '_' + code + '_' + geoCity;
    if (calibInflight.has(inflightKey)) return calibInflight.get(inflightKey);
    const job = calibrateRun(prefName, city, geoCity, cityBase, cache, onProgress, cityList, onTowns, code, yr);
    calibInflight.set(inflightKey, job);
    job.finally(() => {
      if (calibInflight.get(inflightKey) === job) calibInflight.delete(inflightKey);
    });
    return job;
  }

  async function calibrateRun(prefName, city, geoCity, cityBase, cache, onProgress, cityList, onTowns, code, yr) {
    const key = 'calib_v25_' + yr + '_' + code;
    const geoKey = 'geo_v25_' + yr + '_' + code + '_' + geoCity;
    const c = await peekCalib(cache, yr, code, geoCity);
    if (c) {
      if (onTowns && c.towns) onTowns(c.towns);
      return c;
    }
    if (onProgress) onProgress('索引図と町丁名索引を取得中…');
    const parsed = await parseCityPages(cityBase, city.page);
    const towns = parsed.towns;
    const citySheets = new Set();
    for (const sheets of Object.values(towns || {})) {
      for (const sid of sheets) citySheets.add(sid);
    }
    const images = splitImagesByClusters(parsed.images, citySheets);
    if (onTowns) onTowns(towns);

    const finish = async (result, extra) => {
      for (const img of result.images || []) {
        if (img.transform && img.transform.length === 4) {
          img.transform = boostCoastalSheetHeight(img.transform, img, geoCity);
        }
      }
      Object.assign(result, extra || {});
      result.v = 25;
      result.geoCity = geoCity;
      if (result.images.some(i => i.transform)) await cache.set(key, result);
      return result;
    };

    let cities = cityList;
    if (!cities || !cities.length) {
      const m = cityBase.match(/\/(main_[rh]\d+)\/([a-z_0-9]+)\/([a-z_0-9]+)\/prices/);
      if (m) cities = await getCities({ year: m[1] }, { bureau: m[2], dir: m[3] }, cache);
    }

    /* 例外: 葉山↔逗子（南北）・二宮↔大磯（東西）は二つに張り合わせたうえで事前校正 */
    const pair = GRID_PAIR[city.name] || GRID_PAIR[geoCity];
    if (pair) {
      const pc = cities && cities.length ? resolveCity(cities, pair.partner) : null;
      if (pc && pc.page !== city.page) {
        if (onProgress) onProgress(pair.partner + 'と張り合わせて事前校正中…');
        const pCode = pc.page.match(/^([a-z]\d+)fr/)[1];
        const pParsed = await parseCityPages(cityBase, pc.page);
        const pSheets = new Set();
        for (const ss of Object.values(pParsed.towns || {})) {
          for (const sid of ss) pSheets.add(sid);
        }
        const pImages = splitImagesByClusters(pParsed.images, pSheets);
        const [ownPre, partnerPre] = await Promise.all([
          fetchPreGrid(yr, code),
          fetchPreGrid(yr, pCode)
        ]);
        const ownOk = applyPreToImages(images, ownPre);
        const partnerOk = applyPreToImages(pImages, partnerPre);
        /* 基準側（隣市）を先に海岸補正し、張り付け先の最終サイズに合わせる */
        for (const img of pImages) {
          if (img.transform && img.transform.length === 4) {
            img.transform = boostCoastalSheetHeight(img.transform, img, pair.partner);
          }
        }
        let attached = false;
        if (!ownOk) {
          attached = attachImagesToNeighbor(images, pImages, geoCity);
          /* 隣の最終枠に合わせ済みなので、自市の海岸縦伸ばしはしない */
          if (attached) {
            for (const img of images) {
              if (img.transform) img._coastBoosted = true;
            }
          }
        } else {
          for (const img of images) {
            if (img.transform && img.transform.length === 4) {
              img.transform = boostCoastalSheetHeight(img.transform, img, geoCity);
            }
          }
        }
        if (attached && pImages.some(i => i.transform)) {
          snapPairAlongAxis(images, pImages, pair.axis);
        }
        if (images.some(i => i.transform) && (ownOk || partnerOk || preTransformsOk(images))) {
          if (ownOk) addPreExtra(images, ownPre);
          const preVer = (ownPre && ownOk)
            ? ((ownPre.built || '') + '/' + (ownPre.extra_v || 0))
            : ((partnerPre && partnerOk)
              ? ((partnerPre.built || '') + '/' + (partnerPre.extra_v || 0) + '+attach')
              : 'pair-attach');
          return finish({
            code, city: city.name, cityBase, frPage: city.page, towns, images,
            pre: { built: (ownOk ? ownPre : partnerPre)?.built || '', ver: preVer },
            pairAxis: pair.axis, pairWith: pair.partner
          });
        }
        clearImageTransforms(images);
      }
    }

    /* Walker v5: 事前校正（PDF道路アンカー）があれば優先 */
    let pre = await fetchPreGrid(yr, code);
    const preVer = pre ? (pre.built || '') + '/' + (pre.extra_v || 0) : '';
    try {
      if (pre && applyPreToImages(images, pre)) {
        addPreExtra(images, pre);
        /* 事前校正（t6含む）はウォーカー同様そのまま使う。
           4パラメータ用の snap / ランドマークを混ぜると枠が壊れる。 */
        return finish({
          code, city: city.name, cityBase, frPage: city.page, towns, images,
          pre: { built: pre.built, ver: preVer }
        });
      }
      clearImageTransforms(images);
      for (let i = images.length - 1; i >= 0; i--) {
        if (images[i].extra) images.splice(i, 1);
      }
    } catch (e) { /* v4 へ */ }

    /* Walker v4: 接続図でつなぎ → 共有縮尺フィット */
    const geo = (await cache.get(geoKey)) || (await cache.get('geo_v19_' + yr + '_' + code + '_' + geoCity)) || {};
    const wanted = new Set();
    const cands = images.map(img => {
      const elig = [];
      for (const [name, sheets] of Object.entries(towns)) {
        if (!sheets.length) continue;
        const inImg = sheets.filter(sid => img.sheets[sid]).length;
        if (!inImg) continue;
        elig.push([name, inImg, sheets.length - inImg]);
      }
      elig.sort((a, b) => (a[1] + a[2]) - (b[1] + b[2]) || a[2] - b[2] || a[1] - b[1]);
      const list = elig.slice(0, 25).map(e => e[0]);
      for (const name of list) if (!geo[name]) wanted.add(name);
      return list;
    });
    const stitchP = stitchImages(cityBase, images, onProgress).catch(() => null);
    const queue = [...wanted];
    const total = queue.length;
    let done = 0;
    await Promise.all(Array.from({ length: Math.min(4, queue.length || 1) }, async () => {
      while (queue.length) {
        const name = queue.shift();
        geo[name] = await geocode(prefName + geoCity + normTown(name), geoCity);
        done++;
        if (onProgress) onProgress('地図の枠を準備中… ' + done + '/' + total);
      }
    }));
    const st = (await stitchP) || { offs: images.map(() => [0, 0]), comp: images.map((_, i) => i), conn: {} };

    const ptsAll = [], P = [];
    images.forEach((img, ii) => {
      const pts = [];
      for (const name of cands[ii]) {
        const g = geo[name];
        if (!g) continue;
        const rects = (towns[name] || []).filter(sid => img.sheets[sid]).map(sid => img.sheets[sid]);
        if (!rects.length) continue;
        const x1 = Math.min(...rects.map(r => r[0])), y1 = Math.min(...rects.map(r => r[1]));
        const x2 = Math.max(...rects.map(r => r[2])), y2 = Math.max(...rects.map(r => r[3]));
        pts.push([(x1 + x2) / 2, (y1 + y2) / 2, g.lon, g.lat, name, rects.length]);
      }
      ptsAll.push(pts);
      img.transform = null;
      img.quality = { hit: 0, n: 0 };
      img.off = st.offs[ii];
      img.comp = st.comp[ii];
      const sw = swOf(img), sh = shOf(img);
      for (const p of pts) {
        P.push([p[0] / sw + img.off[0], p[1] / sh + img.off[1], p[2], p[3], p[4], p[5], ii, img.comp]);
      }
    });

    let T = P.length >= 5 ? fitShared(P) : null;
    if (T) {
      const good = P.filter(p => {
        const t = T[p[7]];
        return t && Math.abs((p[2] - t[1]) / t[0] - p[0]) < 1 && Math.abs((p[3] - t[3]) / t[2] - p[1]) < 1;
      });
      if (good.length >= 5) {
        const T2 = fitShared(good);
        if (T2) T = T2;
      }
    }
    images.forEach((img, ii) => {
      const t = T && T[img.comp];
      if (!t) return;
      const sw = swOf(img), sh = shOf(img);
      let tr = [t[0] / sw, t[0] * img.off[0] + t[1], t[2] / sh, t[2] * img.off[1] + t[3]];
      tr = constrainTransformAspect(tr, img, ptsAll[ii], median(ptsAll[ii].map(p => p[3])), geoCity);
      img.transform = tr;
      let hit = 0;
      const singles = ptsAll[ii].filter(p => p[5] === 1);
      for (const p of singles) {
        const px = (p[2] - img.transform[1]) / img.transform[0];
        const py = (p[3] - img.transform[3]) / img.transform[2];
        const ok = towns[p[4]].some(sid => {
          const r = img.sheets[sid];
          return r && r[0] <= px && px <= r[2] && r[1] <= py && py <= r[3];
        });
        if (ok) hit++;
      }
      img.quality = { hit, n: singles.length, nPts: ptsAll[ii].length };
    });

    const agg = {};
    for (const img of images) {
      if (!img.transform) continue;
      const a = agg[img.comp] = agg[img.comp] || { hit: 0, n: 0 };
      a.hit += img.quality.hit; a.n += img.quality.n;
    }
    for (const img of images) if (img.transform) img.quality = Object.assign({}, img.quality, agg[img.comp]);

    const qOf2 = i => (i.quality && i.quality.n ? i.quality.hit / i.quality.n : 0);
    const bestImg = images.filter(i => i.transform).sort((a, b) => qOf2(b) - qOf2(a))[0];
    if (bestImg) {
      for (let ii = 0; ii < images.length; ii++) {
        const img = images[ii];
        if (img.transform || !ptsAll[ii].length) continue;
        const a = bestImg.transform[0] * swOf(bestImg) / swOf(img);
        const c = bestImg.transform[2] * shOf(bestImg) / shOf(img);
        const Pb = ptsAll[ii];
        const b = Pb.reduce((sum, p) => sum + (p[2] - a * p[0]), 0) / Pb.length;
        const d = Pb.reduce((sum, p) => sum + (p[3] - c * p[1]), 0) / Pb.length;
        img.transform = constrainTransformAspect([a, b, c, d], img, Pb, median(Pb.map(p => p[3])), geoCity);
        img.quality = { hit: 0, n: 0, nPts: Pb.length };
      }
    }

    /* 例外後処理（従来どおり） */
    const qAbs = i => {
      if (!i.quality) return -1;
      const nPts = i.quality.nPts || 0;
      const hit = i.quality.n ? i.quality.hit / i.quality.n : 0;
      return nPts * 10 + hit;
    };
    snapCrossPageTransforms(images, qAbs);
    const fewTowns = Object.keys(towns).length <= 8;
    if (!fewTowns) alignAbsoluteTranslation(images, ptsAll);
    const pinned = await alignSheetLandmarks(images, geoCity, onProgress);
    if (fewTowns && !pinned) {
      if (onProgress) onProgress('海岸と役場で位置を合わせています…');
      try { await alignByCoastAndHall(images, prefName, geoCity); } catch (e) { /* ignore */ }
    }
    if (fewTowns || pinned) snapCrossPageTransforms(images, qAbs);

    await cache.set(geoKey, geo);
    return finish({ code, city: city.name, cityBase, frPage: city.page, towns, images, conn: st.conn });
  }

  // ---------------- 検索 ----------------

  function rectToBbox(r, t) {
    if (t.length === 6) {
      const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2;
      const lon = t[0] * cx + t[1] * cy + t[2], lat = t[3] * cx + t[4] * cy + t[5];
      const w = Math.abs(t[0]) * (r[2] - r[0]) / 2, h = Math.abs(t[4]) * (r[3] - r[1]) / 2;
      return [lat - h, lon - w, lat + h, lon + w];
    }
    const lons = [t[0] * r[0] + t[1], t[0] * r[2] + t[1]];
    const lats = [t[2] * r[1] + t[3], t[2] * r[3] + t[3]];
    return [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)];
  }

  function lonLatToPx(lon, lat, t) {
    if (t.length === 6) {
      const det = t[0] * t[4] - t[1] * t[3];
      if (!det) return [NaN, NaN];
      const dx = lon - t[2], dy = lat - t[5];
      return [(t[4] * dx - t[1] * dy) / det, (t[0] * dy - t[3] * dx) / det];
    }
    return [(lon - t[1]) / t[0], (lat - t[3]) / t[2]];
  }

  /* 全区の図郭相対関係を崩さず、制御点残差の中央値で平行移動だけ合わせる */
  function alignAbsoluteTranslation(images, ptsAll) {
    const dLons = [];
    const dLats = [];
    for (let ii = 0; ii < images.length; ii++) {
      const img = images[ii];
      const t = img.transform;
      const P = ptsAll[ii];
      if (!t || t.length !== 4 || !P || !P.length) continue;
      for (const p of P) {
        const predLon = t[0] * p[0] + t[1];
        const predLat = t[2] * p[1] + t[3];
        const w = p[5] === 1 ? 2 : 1;
        for (let k = 0; k < w; k++) {
          dLons.push(p[2] - predLon);
          dLats.push(p[3] - predLat);
        }
      }
    }
    if (dLons.length < 3) return;
    const db = median(dLons);
    const dd = median(dLats);
    if (Math.abs(db) < 1e-12 && Math.abs(dd) < 1e-12) return;
    for (const img of images) {
      if (!img.transform || img.transform.length !== 4) continue;
      img.transform[1] += db;
      img.transform[3] += dd;
    }
  }

  /* 路線価図PDF上の既知位置（図郭内の正規化座標 u=東方向, v=北方向）と
     実座標を対応させ、全区を同じ平行移動で合わせる。継ぎ目は維持される。
     u=v=0 が南西隅、u=v=1 が北東隅。右上四半分の中心は u=v=0.75。 */
  const SHEET_LANDMARKS = [
    // 横浜市緑区 69225: 中山駅は右上四半分の中心
    { geoCity: '横浜市緑区', sheet: '69225', query: '中山駅', u: 0.75, v: 0.75 }
  ];

  async function geocodeLandmark(query, geoCity) {
    const isStation = /駅/.test(query);
    const isHall = /役場|庁舎/.test(query);
    const base = query.replace(/駅$/, '');
    const tries = [
      query,
      query + ' ' + geoCity,
      geoCity + query,
      'JR' + query + ' ' + geoCity,
      base + ' Station ' + geoCity,
      base + ' Station Yokohama'
    ];
    for (const q of tries) {
      try {
        const j = await fetchJSON(
          'https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=jp&limit=8&q=' +
            encodeURIComponent(q),
          true
        );
        for (const o of j || []) {
          const disp = o.display_name || '';
          const name = (disp + ' ' + (o.name || '') + ' ' + (o.type || '')).toLowerCase();
          if (geoCity.includes('横浜') && disp.includes('相模原')) continue;
          if (geoCity.includes('相模原') && disp.includes('横浜')) continue;
          if (!disp.includes(geoCity) &&
              !disp.includes('横浜') &&
              !disp.includes('相模原')) continue;
          if (isStation) {
            const okType = o.type === 'station' || o.type === 'train_station' ||
              o.class === 'railway' || /station|驛/.test(name);
            if (!okType) continue;
          }
          if (isHall && o.type !== 'townhall' && o.addresstype !== 'amenity' && o.type !== 'yes') continue;
          return { lon: +o.lon, lat: +o.lat, title: disp };
        }
      } catch (e) { /* try next */ }
    }
    if (isStation) return geocode('神奈川県' + geoCity + query, geoCity);
    return null;
  }

  async function alignSheetLandmarks(images, geoCity, onProgress) {
    const marks = SHEET_LANDMARKS.filter(m =>
      m.geoCity === geoCity || geoCity.endsWith(m.geoCity) || m.geoCity.endsWith(geoCity));
    if (!marks.length) return false;
    const byImg = new Map();
    for (const m of marks) {
      const img = images.find(i => i.transform && i.sheets[m.sheet]);
      if (!img) continue;
      if (onProgress) onProgress('索引図の目印を地図に合わせています…');
      const g = await geocodeLandmark(m.query, geoCity);
      if (!g) continue;
      const r = img.sheets[m.sheet];
      const px = r[0] + m.u * (r[2] - r[0]);
      const py = r[3] - m.v * (r[3] - r[1]);
      if (!byImg.has(img)) byImg.set(img, []);
      byImg.get(img).push([px, py, g.lon, g.lat]);
    }
    let host = null, hostPts = [];
    for (const [img, pts] of byImg) {
      if (pts.length > hostPts.length) { host = img; hostPts = pts; }
    }
    if (!host) return false;
    if (host.transform && host.transform.length !== 4) return false;
    if (hostPts.length >= 2) {
      let t = fitAffine(hostPts);
      if (!t) return false;
      t = constrainTransformAspect(t, host, hostPts, median(hostPts.map(p => p[3])), geoCity);
      const old = host.transform;
      host.transform = t;
      const hostSz = sheetPixelSize(host);
      for (const img of images) {
        if (img === host || !img.transform || img.transform.length !== 4) continue;
        const sz = sheetPixelSize(img);
        img.transform[0] = t[0] * hostSz.sw / sz.sw;
        img.transform[2] = t[2] * hostSz.sh / sz.sh;
        img.transform[1] += t[1] - old[1];
        img.transform[3] += t[3] - old[3];
      }
      host.quality = Object.assign({}, host.quality, { nPts: 80, medRes: 0 });
      return true;
    }
    const img0 = images.find(i => i.transform && i.transform.length === 4 && byImg.has(i));
    if (!img0) return false;
    const p = hostPts[0];
    const t0 = img0.transform;
    const db = p[2] - (t0[0] * p[0] + t0[1]);
    const dd = p[3] - (t0[2] * p[1] + t0[3]);
    for (const img of images) {
      if (!img.transform || img.transform.length !== 4) continue;
      img.transform[1] += db;
      img.transform[3] += dd;
    }
    return true;
  }

  /* 東西南北に隣り合う図郭ペアを幾何的に検出する（表示用の辺補正向け）。
     戻り値: { west, east } または { south, north } */
  function findNeighborPair(A, B) {
    const [as, aw, an, ae] = A.bbox;
    const [bs, bw, bn, be] = B.bbox;
    const medH = ((an - as) + (bn - bs)) / 2;
    const medW = ((ae - aw) + (be - bw)) / 2;
    if (medH < 1e-12 || medW < 1e-12) return null;
    const cyA = (as + an) / 2, cxA = (aw + ae) / 2;
    const cyB = (bs + bn) / 2, cxB = (bw + be) / 2;
    const dLat = cyB - cyA, dLon = cxB - cxA;
    // 大きなページずれ（〜1図郭分の隙間）でも拾えるよう広め
    const ew = Math.abs(dLat) < medH * 0.7 && Math.abs(Math.abs(dLon) - medW) < medW * 1.15;
    const ns = Math.abs(dLon) < medW * 0.7 && Math.abs(Math.abs(dLat) - medH) < medH * 1.15;
    if (ew && (!ns || Math.abs(Math.abs(dLon) - medW) <= Math.abs(Math.abs(dLat) - medH))) {
      return dLon > 0 ? { west: A, east: B } : { west: B, east: A };
    }
    if (ns) return dLat > 0 ? { south: A, north: B } : { south: B, north: A };
    return null;
  }

  /* 索引図画像の東西南北端にある図郭（imagemap のピクセル端）を返す */
  function pixelFringe(img, side) {
    const ents = Object.entries(img.sheets).map(([s, r]) => ({
      sheet: s, r, cx: (r[0] + r[2]) / 2, cy: (r[1] + r[3]) / 2
    }));
    if (!ents.length) return [];
    const tol = 8;
    if (side === 'E') {
      const maxX = Math.max(...ents.map(e => e.r[2]));
      return ents.filter(e => e.r[2] >= maxX - tol);
    }
    if (side === 'W') {
      const minX = Math.min(...ents.map(e => e.r[0]));
      return ents.filter(e => e.r[0] <= minX + tol);
    }
    if (side === 'S') {
      // GIFは上が北想定で y 大が南
      const maxY = Math.max(...ents.map(e => e.r[3]));
      return ents.filter(e => e.r[3] >= maxY - tol);
    }
    const minY = Math.min(...ents.map(e => e.r[1]));
    return ents.filter(e => e.r[1] <= minY + tol);
  }

  function imgCentroid(img) {
    const boxes = Object.values(img.sheets).map(r => rectToBbox(r, img.transform));
    const cy = boxes.reduce((s, b) => s + (b[0] + b[2]) / 2, 0) / boxes.length;
    const cx = boxes.reduce((s, b) => s + (b[1] + b[3]) / 2, 0) / boxes.length;
    const medH = median(boxes.map(b => b[2] - b[0]));
    const medW = median(boxes.map(b => b[3] - b[1]));
    return { cy, cx, medH, medW };
  }

  /* ページ端の図郭同士を緯度/経度順で対応付け、隙間・沿線ずれの観測値を返す */
  function matchFringePairs(westImg, eastImg, axis) {
    // axis 'EW': westImg の東端 ↔ eastImg の西端
    // axis 'NS': southImg の北端 ↔ northImg の南端（呼び出し側で south/north を渡す）
    const aSide = axis === 'EW' ? 'E' : 'N';
    const bSide = axis === 'EW' ? 'W' : 'S';
    const A = pixelFringe(westImg, aSide).map(e => {
      const bbox = rectToBbox(e.r, westImg.transform);
      return {
        sheet: e.sheet, img: westImg, bbox,
        key: axis === 'EW' ? (bbox[0] + bbox[2]) / 2 : (bbox[1] + bbox[3]) / 2
      };
    });
    const B = pixelFringe(eastImg, bSide).map(e => {
      const bbox = rectToBbox(e.r, eastImg.transform);
      return {
        sheet: e.sheet, img: eastImg, bbox,
        key: axis === 'EW' ? (bbox[0] + bbox[2]) / 2 : (bbox[1] + bbox[3]) / 2
      };
    });
    A.sort((x, y) => x.key - y.key);
    B.sort((x, y) => x.key - y.key);
    const used = new Set();
    const pairs = [];
    for (const a of A) {
      let bestJ = -1, bestD = Infinity;
      for (let j = 0; j < B.length; j++) {
        if (used.has(j)) continue;
        const d = Math.abs(B[j].key - a.key);
        if (d < bestD) { bestD = d; bestJ = j; }
      }
      if (bestJ < 0) continue;
      const b = B[bestJ];
      const span = axis === 'EW'
        ? ((a.bbox[2] - a.bbox[0]) + (b.bbox[2] - b.bbox[0])) / 2
        : ((a.bbox[3] - a.bbox[1]) + (b.bbox[3] - b.bbox[1])) / 2;
      // 沿線方向に1図郭以上離れていたら別列
      if (bestD > span * 0.75) continue;
      used.add(bestJ);
      pairs.push({ a, b });
    }
    return pairs;
  }

  /* 索引図が複数ページに分かれる市区で、ページ端 fringe 同士を突き合わせて平行移動を合わせる。
     幾何的な「約1図郭隣」検出だと、0.8図郭分の隙間で検出漏れするため fringe 方式を使う。 */
  function snapCrossPageTransforms(images, qOf) {
    const active = images.filter(i => i.transform && i.transform.length === 4 && !i.extra);
    if (active.length < 2) return;
    const anchor = active.slice().sort((a, b) => qOf(b) - qOf(a))[0];
    const med0 = arr => (arr.length ? median(arr) : 0);
    const add = (corr, img, key, v) => {
      if (img !== anchor) corr.get(img)[key].push(v);
    };

    const collectConstraints = () => {
      const cents = new Map(active.map(img => [img, imgCentroid(img)]));
      const constraints = []; // { west, east, gapLon, dCy } or { south, north, gapLat, dCx }
      for (let i = 0; i < active.length; i++) {
        for (let j = i + 1; j < active.length; j++) {
          const A = active[i], B = active[j];
          const ca = cents.get(A), cb = cents.get(B);
          const dLat = cb.cy - ca.cy, dLon = cb.cx - ca.cx;
          const cell = (ca.medH + cb.medH + ca.medW + cb.medW) / 4;
          // 画像同士が東西に並んでいるか南北に並んでいるか
          if (Math.abs(dLon) > Math.abs(dLat) && Math.abs(dLon) > cell * 0.3) {
            const west = dLon > 0 ? A : B;
            const east = dLon > 0 ? B : A;
            for (const { a, b } of matchFringePairs(west, east, 'EW')) {
              const gapLon = b.bbox[1] - a.bbox[3];
              const dCy = ((b.bbox[0] + b.bbox[2]) - (a.bbox[0] + a.bbox[2])) / 2;
              constraints.push({ kind: 'EW', west, east, gapLon, dCy });
            }
          } else if (Math.abs(dLat) > cell * 0.3) {
            const south = dLat > 0 ? A : B;
            const north = dLat > 0 ? B : A;
            // south の北端 ↔ north の南端
            const pairs = matchFringePairs(south, north, 'NS');
            for (const { a, b } of pairs) {
              // a = south's north fringe, b = north's south fringe
              const gapLat = b.bbox[0] - a.bbox[2];
              const dCx = ((b.bbox[1] + b.bbox[3]) - (a.bbox[1] + a.bbox[3])) / 2;
              constraints.push({ kind: 'NS', south, north, gapLat, dCx });
            }
          }
        }
      }
      return constraints;
    };

    const runPass = (mode) => {
      for (let iter = 0; iter < 8; iter++) {
        const constraints = collectConstraints();
        if (!constraints.length) break;
        const corr = new Map(active.map(i => [i, { gapB: [], gapD: [], alignB: [], alignD: [] }]));
        for (const c of constraints) {
          if (c.kind === 'EW') {
            const { west: w, east: e, gapLon, dCy } = c;
            const apply = (img, gb, ad) => {
              if (mode === 'gap') add(corr, img, 'gapB', gb);
              else add(corr, img, 'alignD', ad);
            };
            if (w === anchor) apply(e, -gapLon, -dCy);
            else if (e === anchor) apply(w, gapLon, dCy);
            else {
              apply(w, gapLon / 2, dCy / 2);
              apply(e, -gapLon / 2, -dCy / 2);
            }
          } else {
            const { south: s, north: n, gapLat, dCx } = c;
            const apply = (img, gd, ab) => {
              if (mode === 'gap') add(corr, img, 'gapD', gd);
              else add(corr, img, 'alignB', ab);
            };
            if (s === anchor) apply(n, -gapLat, -dCx);
            else if (n === anchor) apply(s, gapLat, dCx);
            else {
              apply(s, gapLat / 2, dCx / 2);
              apply(n, -gapLat / 2, -dCx / 2);
            }
          }
        }
        let maxMove = 0;
        for (const img of active) {
          if (img === anchor) continue;
          const c = corr.get(img);
          const db = med0(c.gapB) + med0(c.alignB);
          const dd = med0(c.gapD) + med0(c.alignD);
          if (Math.abs(db) > 1e-15) {
            img.transform[1] += db;
            maxMove = Math.max(maxMove, Math.abs(db));
          }
          if (Math.abs(dd) > 1e-15) {
            img.transform[3] += dd;
            maxMove = Math.max(maxMove, Math.abs(dd));
          }
        }
        if (maxMove < 1e-5) break;
      }
    };

    runPass('gap');
    runPass('align');
    runPass('gap');
  }

  /* 変換スナップ後の残差を、fringe 対応ペアの共有辺中点合わせで潰す。 */
  function correctCrossPageEdges(entries, images) {
    if (!images || images.length < 2) {
      // 旧呼び出し互換: entries だけで幾何隣接を使う
      if (entries.length < 2) return;
      const imgSet = new Set(entries.map(e => e.imgIdx));
      if (imgSet.size < 2) return;
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          const A = entries[i], B = entries[j];
          if (A.imgIdx === B.imgIdx) continue;
          const pair = findNeighborPair(A, B);
          if (!pair) continue;
          if (pair.west) {
            const midLon = (pair.west.bbox[3] + pair.east.bbox[1]) / 2;
            pair.west.bbox[3] = midLon;
            pair.east.bbox[1] = midLon;
          } else {
            const midLat = (pair.south.bbox[2] + pair.north.bbox[0]) / 2;
            pair.south.bbox[2] = midLat;
            pair.north.bbox[0] = midLat;
          }
        }
      }
      return;
    }

    const bySheet = new Map(entries.map(e => [e.sheet, e]));
    const active = images.filter(i => i.transform && !i.extra);
    const cents = new Map(active.map(img => [img, imgCentroid(img)]));
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const A = active[i], B = active[j];
        const ca = cents.get(A), cb = cents.get(B);
        const dLat = cb.cy - ca.cy, dLon = cb.cx - ca.cx;
        const cell = (ca.medH + cb.medH + ca.medW + cb.medW) / 4;
        if (Math.abs(dLon) > Math.abs(dLat) && Math.abs(dLon) > cell * 0.3) {
          const west = dLon > 0 ? A : B;
          const east = dLon > 0 ? B : A;
          for (const { a, b } of matchFringePairs(west, east, 'EW')) {
            const ea = bySheet.get(a.sheet), eb = bySheet.get(b.sheet);
            if (!ea || !eb) continue;
            const midLon = (ea.bbox[3] + eb.bbox[1]) / 2;
            ea.bbox[3] = midLon;
            eb.bbox[1] = midLon;
          }
        } else if (Math.abs(dLat) > cell * 0.3) {
          const south = dLat > 0 ? A : B;
          const north = dLat > 0 ? B : A;
          for (const { a, b } of matchFringePairs(south, north, 'NS')) {
            const ea = bySheet.get(a.sheet), eb = bySheet.get(b.sheet);
            if (!ea || !eb) continue;
            const midLat = (ea.bbox[2] + eb.bbox[0]) / 2;
            ea.bbox[2] = midLat;
            eb.bbox[0] = midLat;
          }
        }
      }
    }
  }

  function matchTown(towns, rest) {
    let best = null;
    for (const [name, sheets] of Object.entries(towns)) {
      const base = name.replace(/（[^）]*）/g, '').trim();
      if (!base) continue;
      for (const cand of [normTown(base), base]) {
        if (cand && rest.startsWith(cand) && (!best || cand.length > best.len)) {
          best = { len: cand.length, name, sheets };
        }
      }
    }
    return best ? { name: best.name, sheets: best.sheets } : null;
  }

  async function locate(meta, pref, city, geoCityName, lon, lat, rest, title, cache, onProgress, cityList) {
    const cityBase = `${NTA}${meta.year}/${pref.bureau}/${pref.dir}/prices/`;
    const cities = cityList && cityList.length ? cityList : await getCities(meta, pref, cache);
    const calib = await calibrate(pref.name, city, geoCityName || city.name, cityBase, cache, onProgress, cities);
    const townMatch = matchTown(calib.towns, rest);
    let best = null;
    for (const img of calib.images) {
      const t = img.transform;
      if (!t) continue;
      const [px, py] = lonLatToPx(lon, lat, t);
      for (const [s, r] of Object.entries(img.sheets)) {
        if (r[0] <= px && px <= r[2] && r[1] <= py && py <= r[3]) {
          const q = img.quality.n ? img.quality.hit / img.quality.n : 0;
          if (!best || q > best.q) best = { img, sheet: s, q };
        }
      }
    }
    const resp = {
      geocode: { lon, lat, title },
      pref: pref.name, city: city.name, year: meta.year,
      cityPage: cityBase + city.page, townMatch
    };
    // 枠は市区町村の全索引図画像を合算（照合精度の高い画像を優先し、重複する図番号は除外）
    // ページまたぎでは共有辺を中点合わせして位置・サイズを補正する
    const qOf = img => (img.quality && img.quality.n ? img.quality.hit / img.quality.n : 0);
    const gridMap = {};
    const packs = [{ cal: calib, name: city.name, edges: true }];
    for (const pname of partnerNames(city.name)) {
      const pc = resolveCity(cities, pname);
      if (!pc || pc.page === city.page) continue;
      try {
        if (onProgress) onProgress(pname + 'の枠を重ねています…');
        const pCal = await calibrate(pref.name, pc, pc.name, cityBase, cache, null, cities);
        packs.push({ cal: pCal, name: pc.name, edges: false });
      } catch (e) { /* 隣接市の失敗は本結果を残す */ }
    }
    const unionSheets = new Set();
    const ownerOf = {};
    for (const p of packs) {
      for (const [town, ss] of Object.entries(p.cal.towns || {})) {
        for (const s of ss) {
          unionSheets.add(s);
          if (!ownerOf[s]) ownerOf[s] = p.name;
        }
      }
    }
    const addCalibGrid = (cal, fallbackName, intoEdges) => {
      const imgs = (cal.images || []).filter(i => i.transform).sort((a, b) => qOf(b) - qOf(a));
      const edgeEntries = [];
      imgs.forEach((img, imgIdx) => {
        for (const [s, r] of Object.entries(img.sheets)) {
          if (unionSheets.size && !unionSheets.has(s)) continue;
          if (gridMap[s]) continue;
          const bbox = rectToBbox(r, img.transform);
          const ward = ownerOf[s] || fallbackName;
          gridMap[s] = {
            sheet: s,
            ward,
            id: ward + ':' + s,
            bbox,
            pdf: cityBase + 'pdf/' + s + '.pdf',
            page: cityBase + 'html/' + s + 'f.htm'
          };
          if (img.extra) gridMap[s].extra = true;
          if (img.est && img.est[s]) gridMap[s].est = true;
          edgeEntries.push({ sheet: s, bbox, imgIdx });
        }
      });
      // 事前校正済みはウォーカー同様、継ぎ目補正しない。
      // 同一GIFのクラスタ分割があるときも、fringe 補正が図郭を潰すので行わない。
      // _extra（経緯度直置き）を混ぜると正規の枠が大きくずれる。
      if (intoEdges && !cal.pre) {
        const real = imgs.filter(i => !i.extra);
        const gifs = real.map(i => i.gif);
        const clustered = gifs.length !== new Set(gifs).size;
        if (!clustered) correctCrossPageEdges(edgeEntries, real);
      }
    };
    for (const p of packs) addCalibGrid(p.cal, p.name, p.edges);
    const grid = Object.values(gridMap);
    if (grid.length) resp.grid = grid;
    if (best) {
      resp.hit = best.sheet;
      resp.quality = best.img.quality;
      resp.indexAgree = townMatch ? townMatch.sheets.includes(best.sheet) : null;
      resp.pdf = cityBase + 'pdf/' + best.sheet + '.pdf';
      resp.sheetPage = cityBase + 'html/' + best.sheet + 'f.htm';
    } else if (!grid.length) {
      resp.error = '地図上の枠を計算できませんでした（町丁名索引の結果のみ表示します）';
    }
    return resp;
  }

  // 駅名・施設名っぽい検索語（住所ジオコーダでは誤爆するのでOSMを優先する）
  const POI_RE = /(駅|停留場|空港|役場|役所|庁舎|タワー|城|大学|高等学校|高校|中学校|小学校|病院|公園|温泉|球場|ドーム|競技場|神社|大社|八幡宮|寺|ホテル|インター|営業所|支店)$/;

  async function nominatim(q) {
    const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=jp&limit=1&q=' + encodeURIComponent(q);
    try {
      const j = await fetchJSON(url, true);
      if (j && j.length) return { lon: +j[0].lon, lat: +j[0].lat, title: '' };
    } catch (e) { /* fall through */ }
    return null;
  }

  async function zip2addr(q) {
    const m = q.replace(/[〒\s]/g, '').match(/^(\d{3})-?(\d{4})$/);
    if (!m) return null;
    try {
      const j = await fetchJSON('https://zipcloud.ibsnet.co.jp/api/search?zipcode=' + m[1] + m[2], true);
      const r = j && j.results && j.results[0];
      if (r) return (r.address1 || '') + (r.address2 || '') + (r.address3 || '');
    } catch (e) { /* fall through */ }
    return null;
  }

  async function lookupAddress(q, cache, onProgress, onEarly) {
    q = q.replace(/　/g, ' ').trim();
    if (onProgress) onProgress('場所を検索中…');
    // 郵便番号 → 住所に変換してから通常検索
    const za = await zip2addr(q);
    if (za) q = za;
    let g = null;
    if (POI_RE.test(q)) g = await nominatim(q);   // 駅・施設名はOSM優先
    if (!g) g = await geocode(q, null);           // 住所はGSI
    if (!g) g = await nominatim(q);               // 最後のフォールバック
    if (!g) return { error: '場所を特定できませんでした。「市区町村＋町名」の形で入力してください（例: 大分市府内町）' };
    return lookupPoint(g.lat, g.lon, cache, onProgress, g.title || null, onEarly);
  }

  const TOKYO_SPECIAL_WARDS = new Set([
    '千代田区', '中央区', '港区', '新宿区', '文京区', '台東区', '墨田区', '江東区',
    '品川区', '目黒区', '大田区', '世田谷区', '渋谷区', '中野区', '杉並区', '豊島区',
    '北区', '荒川区', '板橋区', '練馬区', '足立区', '葛飾区', '江戸川区'
  ]);

  function isTokyoSpecialWard(pref, city) {
    return pref === '東京都' && TOKYO_SPECIAL_WARDS.has(city);
  }

  function pointInBbox(lat, lon, bbox, pad) {
    pad = pad || 0;
    return bbox[0] - pad <= lat && lat <= bbox[2] + pad &&
      bbox[1] - pad <= lon && lon <= bbox[3] + pad;
  }

  /* クリック地点の周囲を逆ジオコードし、近傍の東京特別区を集める */
  async function nearbyTokyoWards(lat, lon, cities, cache) {
    const found = new Map();
    const dist = 0.005; // 約550m
    const offsets = [[0, 0]];
    for (let a = 0; a < 8; a++) {
      const rad = (a * Math.PI) / 4;
      offsets.push([Math.cos(rad) * dist, Math.sin(rad) * dist]);
      offsets.push([Math.cos(rad) * dist * 1.6, Math.sin(rad) * dist * 1.6]);
    }
    const muniMap = await getMuniMap(cache);
    await Promise.all(offsets.map(async ([dLat, dLon]) => {
      const r = await revGeocode(lat + dLat, lon + dLon);
      if (!r || !r.muniCd) return;
      const m = muniMap[String(parseInt(r.muniCd, 10))];
      if (!m || !isTokyoSpecialWard(m.pref, m.city)) return;
      const ct = resolveCity(cities, m.city);
      if (ct) found.set(m.city, { city: ct, muniCity: m.city });
    }));
    return [...found.values()];
  }

  function sheetsContaining(grid, lat, lon) {
    const pad = 0.00015; // 約15m（枠のわずかなずれ吸収）
    return (grid || []).filter(g => pointInBbox(lat, lon, g.bbox, pad));
  }

  async function lookupPoint(lat, lon, cache, onProgress, titleHint, onEarly) {
    if (onProgress) onProgress('市区町村を特定中…');
    const r = await revGeocode(lat, lon);
    if (!r || !r.muniCd) return { error: '地点の市区町村を特定できませんでした（海上・対象外地域の可能性）' };
    const muniCd = String(parseInt(r.muniCd, 10));
    const muni = (await getMuniMap(cache))[muniCd];
    if (!muni) return { error: '市区町村コード ' + r.muniCd + ' を解決できませんでした' };
    const rest = (r.lv01Nm || '').replace(/^[−ー\-\s]+$/, '');
    const title = titleHint || (muni.pref + muni.city + rest);
    const meta = await getPrefs(cache);
    const pref = meta.prefs.find(p => p.name === muni.pref);
    if (!pref) return { error: '都道府県を特定できませんでした: ' + title };
    const cities = await getCities(meta, pref, cache);
    const city = resolveCity(cities, muni.city);
    if (!city) {
      return {
        error: title + ' の路線価図ページが見つかりません（路線価の無い評価倍率地域の可能性）',
        geocode: { lon, lat, title },
        ratioPage: `${NTA}${meta.year}/${pref.bureau}/${pref.dir}/ratios/city_frm.htm`
      };
    }

    const cityBase = `${NTA}${meta.year}/${pref.bureau}/${pref.dir}/prices/`;
    const code = city.page.match(/^([a-z]\d+)fr/)[1];
    const cached = await peekCalib(cache, meta.year, code, muni.city);
    if (onEarly && !cached) {
      try {
        const towns = {};
        parseTownsInto(await fetchSJIS(cityBase + city.page), towns);
        const tm = matchTown(towns, rest);
        if (tm) {
          onEarly({
            townMatch: tm, pref: pref.name, city: city.name, year: meta.year,
            cityPage: cityBase + city.page,
            sheets: tm.sheets.map(s => ({
              sheet: s,
              ward: city.name,
              id: city.name + ':' + s,
              pdf: cityBase + 'pdf/' + s + '.pdf',
              page: cityBase + 'html/' + s + 'f.htm'
            }))
          });
        }
      } catch (e) { /* 先出しは失敗しても本処理に影響させない */ }
    }

    const resp = await locate(meta, pref, city, muni.city, lon, lat, rest, title, cache, onProgress, cities);
    resp.muniCd = String(r.muniCd);
    resp.muniCity = muni.city;
    resp.lv01Nm = rest;

    // 東京特別区: 境界付近では隣接区の路線価図も候補になることがある
    if (isTokyoSpecialWard(muni.pref, muni.city)) {
      if (onProgress) onProgress('周辺の特別区を確認中…');
      const nearby = await nearbyTokyoWards(lat, lon, cities, cache);
      const wardResults = [{
        city: city.name,
        muniCity: muni.city,
        cityPage: resp.cityPage,
        hit: resp.hit,
        grid: resp.grid || [],
        townMatch: resp.townMatch,
        quality: resp.quality,
        primary: true
      }];

      const others = nearby.filter(w => w.muniCity !== muni.city);
      let done = 0;
      const queue = others.slice();
      await Promise.all(Array.from({ length: Math.min(3, queue.length || 1) }, async () => {
        while (queue.length) {
          const w = queue.shift();
          try {
            if (onProgress) {
              onProgress('周辺の特別区を読み込み中… ' + (++done) + '/' + others.length + '（' + w.muniCity + '）');
            }
            const sub = await locate(meta, pref, w.city, w.muniCity, lon, lat, rest, title, cache, null, cities);
            const hits = sheetsContaining(sub.grid, lat, lon);
            if (hits.length) {
              wardResults.push({
                city: w.city.name,
                muniCity: w.muniCity,
                cityPage: sub.cityPage,
                hit: hits[0].sheet,
                grid: sub.grid || [],
                townMatch: sub.townMatch,
                quality: sub.quality,
                primary: false
              });
            }
          } catch (e) { /* 隣接区の失敗は無視 */ }
        }
      }));

      const candidates = [];
      const seen = new Set();
      for (const wr of wardResults) {
        const hits = sheetsContaining(wr.grid, lat, lon);
        for (const g of hits) {
          const id = (g.id || (wr.city + ':' + g.sheet));
          if (seen.has(id)) continue;
          seen.add(id);
          candidates.push({
            id,
            city: wr.city,
            muniCity: wr.muniCity,
            sheet: g.sheet,
            pdf: g.pdf,
            page: g.page,
            bbox: g.bbox,
            ward: wr.city,
            primary: wr.primary,
            cityPage: wr.cityPage
          });
        }
      }
      candidates.sort((a, b) => {
        if (a.primary !== b.primary) return a.primary ? -1 : 1;
        const da = Math.hypot((a.bbox[0] + a.bbox[2]) / 2 - lat, (a.bbox[1] + a.bbox[3]) / 2 - lon);
        const db = Math.hypot((b.bbox[0] + b.bbox[2]) / 2 - lat, (b.bbox[1] + b.bbox[3]) / 2 - lon);
        return da - db;
      });

      resp.tokyoWards = wardResults;
      resp.candidates = candidates;
      if (candidates.length > 1) {
        const merged = {};
        for (const wr of wardResults) {
          for (const g of wr.grid || []) {
            const id = g.id || (wr.city + ':' + g.sheet);
            if (!merged[id]) {
              merged[id] = Object.assign({}, g, {
                id, ward: wr.city, city: wr.city, cityPage: wr.cityPage
              });
            }
          }
        }
        resp.grid = Object.values(merged);
        // 既定表示は地点を含む先頭候補
        const top = candidates[0];
        if (top) {
          resp.hit = top.sheet;
          resp.city = top.city;
          resp.muniCity = top.muniCity;
          resp.cityPage = top.cityPage;
          resp.pdf = top.pdf;
          resp.sheetPage = top.page;
        }
      }
    }

    return resp;
  }

  root.RosenkaCore = {
    lookupAddress, lookupPoint, revGeocode, normTown,
    isTokyoSpecialWard, resolveCity,
    // 市区町村コード → { pref, city }（地点から都道府県・市区町村名を得る用）
    getMuni: cache => getMuniMap(cache),
    // 町丁名→図番号の索引だけ取得（年度切替の図番号照合用）
    getTowns: async (cityBase, frPage) => (await parseCityTowns(cityBase, frPage)).towns
  };
})(typeof self !== 'undefined' ? self : globalThis);
