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
    const key = 'cities_' + meta.year + '_' + pref.dir;
    const c = await cache.get(key);
    if (c) return c;
    const url = `${NTA}${meta.year}/${pref.bureau}/${pref.dir}/prices/city_frm.htm`;
    const html = await fetchSJIS(url);
    const cities = [];
    for (const m of html.matchAll(/href="([a-z]\d+fr\.htm)"[^>]*>\s*([^<]+)/g)) {
      const name = m[2].trim();
      if (name) cities.push({ page: m[1], name });
    }
    await cache.set(key, cities);
    return cities;
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
        const sheets = {};
        for (const a of m[2].matchAll(/coords="([\d,\s]+)"\s+href="\.\.\/html\/(\d+)f\.htm"/g)) {
          const nums = (a[1].match(/\d+/g) || []).map(Number);
          const xs = nums.filter((_, i) => i % 2 === 0);
          const ys = nums.filter((_, i) => i % 2 === 1);
          if (xs.length && ys.length) {
            sheets[a[2]] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
          }
        }
        if (Object.keys(sheets).length && imgByMap[m[1]]) {
          images.push({ gif: imgByMap[m[1]].gif, mp, w: imgByMap[m[1]].w, h: imgByMap[m[1]].h, sheets });
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

  async function calibrate(prefName, city, geoCityName, cityBase, cache, onProgress) {
    const code = city.page.match(/^([a-z]\d+)fr/)[1];
    // 年度付きキー: 新年度が出たら自動で作り直される
    // v2: 索引図間で縮尺を共有し、図郭の継ぎ目ずれ（港北区の新横浜〜菊名など）を解消
    const yr = (cityBase.match(/main_[rh]\d+/) || ['y'])[0];
    const key = 'calib_v2_' + yr + '_' + code;
    const c = await cache.get(key);
    // 全画像で枠が張れていない壊れたキャッシュは作り直す（自己修復）
    if (c && c.v === 2 && c.images && c.images.some(i => i.transform)) return c;
    if (onProgress) onProgress('索引図と町丁名索引を取得中…');
    const { towns, images } = await parseCityPages(cityBase, city.page);
    const geo = (await cache.get('geo_' + yr + '_' + code)) || {};

    const swOf = i => median(Object.values(i.sheets).map(r => r[2] - r[0]));
    const shOf = i => median(Object.values(i.sheets).map(r => r[3] - r[1]));

    // 制御点候補: 図郭数が少ない町丁を優先（位置が局所的で校正に有利）、画像ごとに最大40件
    const wanted = new Set();
    const cands = images.map(img => {
      const scored = [];
      for (const [name, sheets] of Object.entries(towns)) {
        const rects = sheets.filter(s => img.sheets[s]);
        if (rects.length !== sheets.length || !sheets.length) continue; // この索引図画像に完結しない町はスキップ
        scored.push({ name, n: sheets.length });
      }
      scored.sort((a, b) => a.n - b.n || a.name.localeCompare(b.name, 'ja'));
      const list = scored.slice(0, 40).map(x => x.name);
      for (const name of list) {
        if (!geo[name]) wanted.add(name); // 未取得または前回失敗(null)は再試行
      }
      return list;
    });
    const queue = [...wanted];
    const total = queue.length;
    let done = 0;
    await Promise.all(Array.from({ length: Math.min(4, queue.length || 1) }, async () => {
      while (queue.length) {
        const name = queue.shift();
        // 政令市の区はNTA上「中央区」等の裸の区名なので、ジオコーディングには正式名(geoCityName=「福岡市中央区」)を使う
        geo[name] = await geocode(prefName + geoCityName + normTown(name), geoCityName);
        done++;
        if (onProgress) onProgress('地図の枠を準備中… ' + done + '/' + total);
      }
    }));

    const ptsAll = [];
    for (let ii = 0; ii < images.length; ii++) {
      const img = images[ii];
      const pts = [];
      for (const name of cands[ii]) {
        const g = geo[name];
        if (!g) continue;
        const rects = towns[name].map(s => img.sheets[s]);
        const x1 = Math.min(...rects.map(r => r[0])), y1 = Math.min(...rects.map(r => r[1]));
        const x2 = Math.max(...rects.map(r => r[2])), y2 = Math.max(...rects.map(r => r[3]));
        pts.push([(x1 + x2) / 2, (y1 + y2) / 2, g.lon, g.lat, name, rects.length]);
      }
      ptsAll.push(pts);
      img.transform = null;
      img.quality = { hit: 0, n: 0 };
      if (pts.length < 5) continue;
      let t = fitAffine(pts);
      if (!t) continue;
      // ロバスト化: 残差が図郭1枚分を超える点を捨てて再フィット
      const sw = swOf(img), sh = shOf(img);
      const good = pts.filter(p =>
        Math.abs((p[2] - t[1]) / t[0] - p[0]) < sw && Math.abs((p[3] - t[3]) / t[2] - p[1]) < sh);
      if (good.length >= 5) {
        const t2 = fitAffine(good);
        if (t2) t = t2;
      }
      let hit = 0;
      const singles = pts.filter(p => p[5] === 1);
      for (const p of singles) {
        const px = (p[2] - t[1]) / t[0], py = (p[3] - t[3]) / t[2];
        const ok = towns[p[4]].some(s => {
          const r = img.sheets[s];
          return r && r[0] <= px && px <= r[2] && r[1] <= py && py <= r[3];
        });
        if (ok) hit++;
      }
      // 単独図郭の町が無い画像は、残差の小ささで暫定スコアを付ける（縮尺選定用）
      const res = pts.map(p => {
        const px = (p[2] - t[1]) / t[0], py = (p[3] - t[3]) / t[2];
        return Math.hypot(px - p[0], py - p[1]);
      });
      img.transform = t;
      img.quality = {
        hit,
        n: singles.length,
        medRes: median(res),
        nPts: pts.length
      };
    }

    // 索引図ごとに縮尺を独立推定すると、画像境界で図郭が100〜160mずれる。
    // 最も信頼できる画像の縮尺を全区で共有し、各画像は平行移動だけ合わせる。
    const qOf2 = i => {
      if (!i.quality) return -1;
      if (i.quality.n) return i.quality.hit / i.quality.n;
      // singlesが無い場合: 制御点が多く残差が小さいほど良い
      return (i.quality.nPts || 0) / 100 - (i.quality.medRes || 999) / 1000;
    };
    const bestImg = images.filter(i => i.transform).sort((a, b) => qOf2(b) - qOf2(a))[0];
    if (bestImg) {
      for (let ii = 0; ii < images.length; ii++) {
        const img = images[ii];
        const P = ptsAll[ii];
        if (!P.length) continue;
        const a = bestImg.transform[0] * swOf(bestImg) / swOf(img);
        const c = bestImg.transform[2] * shOf(bestImg) / shOf(img);
        let b = P.reduce((s, p) => s + (p[2] - a * p[0]), 0) / P.length;
        let d = P.reduce((s, p) => s + (p[3] - c * p[1]), 0) / P.length;
        const sw = swOf(img), sh = shOf(img);
        for (let iter = 0; iter < 2; iter++) {
          const good = P.filter(p => {
            const px = (p[2] - b) / a, py = (p[3] - d) / c;
            return Math.abs(px - p[0]) < sw * 0.6 && Math.abs(py - p[1]) < sh * 0.6;
          });
          if (good.length >= 3) {
            b = good.reduce((s, p) => s + (p[2] - a * p[0]), 0) / good.length;
            d = good.reduce((s, p) => s + (p[3] - c * p[1]), 0) / good.length;
          }
        }
        const t = [a, b, c, d];
        let hit = 0;
        const singles = P.filter(p => p[5] === 1);
        for (const p of singles) {
          const px = (p[2] - t[1]) / t[0], py = (p[3] - t[3]) / t[2];
          const ok = towns[p[4]].some(s => {
            const r = img.sheets[s];
            return r && r[0] <= px && px <= r[2] && r[1] <= py && py <= r[3];
          });
          if (ok) hit++;
        }
        img.transform = t;
        img.quality = { hit, n: singles.length };
      }
    }
    await cache.set('geo_' + yr + '_' + code, geo);
    const result = { v: 2, code, city: city.name, cityBase, frPage: city.page, towns, images };
    // 1画像も枠が張れなかった結果はキャッシュしない（次回の再挑戦を妨げないため）
    if (images.some(i => i.transform)) await cache.set(key, result);
    return result;
  }

  // ---------------- 検索 ----------------

  function rectToBbox(r, t) {
    const lons = [t[0] * r[0] + t[1], t[0] * r[2] + t[1]];
    const lats = [t[2] * r[1] + t[3], t[2] * r[3] + t[3]];
    return [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)];
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

  async function locate(meta, pref, city, geoCityName, lon, lat, rest, title, cache, onProgress) {
    const cityBase = `${NTA}${meta.year}/${pref.bureau}/${pref.dir}/prices/`;
    const calib = await calibrate(pref.name, city, geoCityName || city.name, cityBase, cache, onProgress);
    const townMatch = matchTown(calib.towns, rest);
    let best = null;
    for (const img of calib.images) {
      const t = img.transform;
      if (!t) continue;
      const px = (lon - t[1]) / t[0], py = (lat - t[3]) / t[2];
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
    const qOf = img => (img.quality && img.quality.n ? img.quality.hit / img.quality.n : 0);
    const gridMap = {};
    for (const img of calib.images.filter(i => i.transform).sort((a, b) => qOf(b) - qOf(a))) {
      for (const [s, r] of Object.entries(img.sheets)) {
        if (gridMap[s]) continue;
        gridMap[s] = {
          sheet: s,
          bbox: rectToBbox(r, img.transform),
          pdf: cityBase + 'pdf/' + s + '.pdf',
          page: cityBase + 'html/' + s + 'f.htm'
        };
      }
    }
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
    let city = cities.find(ct => ct.name === muni.city);
    if (!city) {
      const cands = cities.filter(ct => muni.city.includes(ct.name) || ct.name.includes(muni.city));
      city = cands.sort((a, b) => b.name.length - a.name.length)[0] || null;
    }
    if (!city) {
      return {
        error: title + ' の路線価図ページが見つかりません（路線価の無い評価倍率地域の可能性）',
        geocode: { lon, lat, title },
        ratioPage: `${NTA}${meta.year}/${pref.bureau}/${pref.dir}/ratios/city_frm.htm`
      };
    }

    // PDFの先出し: 町丁名索引の照合だけなら数秒で済むので、枠の計算を待たずに該当PDFを通知する
    // （校正済みキャッシュがある場合は本処理が即終わるのでスキップ）
    const cityBase = `${NTA}${meta.year}/${pref.bureau}/${pref.dir}/prices/`;
    const code = city.page.match(/^([a-z]\d+)fr/)[1];
    const cached = await cache.get('calib_v2_' + meta.year + '_' + code);
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
              pdf: cityBase + 'pdf/' + s + '.pdf',
              page: cityBase + 'html/' + s + 'f.htm'
            }))
          });
        }
      } catch (e) { /* 先出しは失敗しても本処理に影響させない */ }
    }

    const resp = await locate(meta, pref, city, muni.city, lon, lat, rest, title, cache, onProgress);
    resp.muniCd = String(r.muniCd);
    resp.muniCity = muni.city;
    resp.lv01Nm = rest;
    return resp;
  }

  root.RosenkaCore = {
    lookupAddress, lookupPoint, revGeocode, normTown,
    // 市区町村コード → { pref, city }（地点から都道府県・市区町村名を得る用）
    getMuni: cache => getMuniMap(cache),
    // 町丁名→図番号の索引だけ取得（年度切替の図番号照合用）
    getTowns: async (cityBase, frPage) => (await parseCityTowns(cityBase, frPage)).towns
  };
})(typeof self !== 'undefined' ? self : globalThis);
