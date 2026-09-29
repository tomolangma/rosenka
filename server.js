'use strict';

/**
 * 路線価チェッくん — 依存パッケージなしの静的サーバー + API
 * Node.js 18+ のみで動作（express 不要）
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { URL } = require('url');
const { exec } = require('child_process');

const PORT = Number(process.env.PORT) || 5173;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const SETTINGS_PATH = path.join(ROOT, 'config', 'settings.json');
const PAST_CASES_PATH = path.join(ROOT, 'data', 'past-cases.json');
const ALLOWED_HOSTS = new Set([
  'www.rosenka.nta.go.jp',
  'rosenka.nta.go.jp',
  'maps.gsi.go.jp',
  'mreversegeocoder.gsi.go.jp',
  'msearch.gsi.go.jp',
  'cyberjapandata.gsi.go.jp',
  'nominatim.openstreetmap.org',
  'overpass-api.de',
  'zipcloud.ibsnet.co.jp'
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.map': 'application/json'
};

function openBrowser(url) {
  const cmd =
    process.platform === 'win32' ? `cmd /c start "" "${url}"` :
    process.platform === 'darwin' ? `open "${url}"` :
    `xdg-open "${url}"`;
  exec(cmd, () => {});
}

function send(res, status, body, headers) {
  const h = Object.assign({ 'Access-Control-Allow-Origin': '*' }, headers || {});
  res.writeHead(status, h);
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', c => {
      n += c.length;
      if (n > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function proxyFetch(targetUrl) {
  return new Promise((resolve, reject) => {
    const lib = targetUrl.protocol === 'http:' ? http : https;
    const req = lib.get(targetUrl, {
      headers: {
        'User-Agent': 'RosenkaCheckkun/1.0',
        Accept: '*/*'
      }
    }, up => {
      const chunks = [];
      up.on('data', c => chunks.push(c));
      up.on('end', () => resolve({
        status: up.statusCode || 502,
        contentType: up.headers['content-type'] || 'application/octet-stream',
        body: Buffer.concat(chunks)
      }));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => {
      req.destroy(new Error('timeout'));
    });
  });
}

function safeJoin(base, reqPath) {
  const decoded = decodeURIComponent(reqPath.split('?')[0]);
  const cleaned = path.normalize(decoded).replace(/^([/\\])+/, '');
  const full = path.join(base, cleaned);
  if (!full.startsWith(base)) return null;
  return full;
}

function cacheFor(filePath) {
  const base = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  if (base === 'settings.json' || base === 'past-cases.json' || ext === '.html') return 'no-cache';
  if (base === 'maps.json') return 'public, max-age=600';
  if (ext === '.json') return 'public, max-age=300';
  if (ext === '.js' || ext === '.css') return 'public, max-age=86400';
  if (ext === '.ico' || ext === '.png') return 'public, max-age=604800';
  return 'public, max-age=3600';
}

function serveFile(res, filePath, req) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      send(res, 404, 'not found', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const headers = {
      'Content-Type': type,
      'Cache-Control': cacheFor(filePath),
      'Access-Control-Allow-Origin': '*'
    };
    const ae = String((req && req.headers && req.headers['accept-encoding']) || '');
    const compressible =
      data.length > 1024 &&
      (ext === '.js' || ext === '.css' || ext === '.json' || ext === '.html' || ext === '.svg');
    if (compressible && /\bgzip\b/.test(ae)) {
      zlib.gzip(data, (zerr, buf) => {
        if (zerr || !buf) {
          res.writeHead(200, headers);
          res.end(data);
          return;
        }
        headers['Content-Encoding'] = 'gzip';
        headers['Vary'] = 'Accept-Encoding';
        res.writeHead(200, headers);
        res.end(buf);
      });
      return;
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

async function handleProxy(req, res, u) {
  if (!u) return send(res, 400, 'missing u', { 'Content-Type': 'text/plain' });
  let target;
  try {
    target = new URL(u);
  } catch {
    return send(res, 400, 'invalid url', { 'Content-Type': 'text/plain' });
  }
  if (target.protocol !== 'https:' || !ALLOWED_HOSTS.has(target.hostname)) {
    return send(res, 403, 'host not allowed', { 'Content-Type': 'text/plain' });
  }
  try {
    const up = await proxyFetch(target);
    send(res, up.status, up.body, {
      'Content-Type': up.contentType,
      'Cache-Control': 'public, max-age=3600'
    });
  } catch (err) {
    console.error('[proxy]', err.message);
    send(res, 502, 'upstream fetch failed', { 'Content-Type': 'text/plain' });
  }
}

function handleGetSettings(res) {
  fs.readFile(SETTINGS_PATH, 'utf8', (err, raw) => {
    if (err) return send(res, 500, JSON.stringify({ error: 'settings read failed' }), {
      'Content-Type': 'application/json; charset=utf-8'
    });
    send(res, 200, raw, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache'
    });
  });
}

async function handlePutSettings(req, res) {
  try {
    const raw = await readBody(req, 32 * 1024);
    const body = JSON.parse(raw.toString('utf8') || '{}');
    const map = body.map || {};
    const gmap = body.gmap || {};
    const gis = body.gis || {};
    const lat = Number(map.lat);
    const lon = Number(map.lon);
    const zoom = Number(map.zoom);
    const scale = Number(gmap.scale);
    const gisZoom = Number(gis.zoom);
    const mps = Number(gis.mps);
    if (![lat, lon, zoom, scale, gisZoom, mps].every(Number.isFinite)) {
      return send(res, 400, JSON.stringify({ error: 'invalid numbers' }), {
        'Content-Type': 'application/json; charset=utf-8'
      });
    }
    if (zoom < 1 || zoom > 18 || gisZoom < 1 || gisZoom > 20) {
      return send(res, 400, JSON.stringify({ error: 'zoom out of range' }), {
        'Content-Type': 'application/json; charset=utf-8'
      });
    }
    const next = {
      map: {
        lat,
        lon,
        zoom: Math.round(zoom),
        label: String(map.label == null ? '' : map.label).slice(0, 80)
      },
      gmap: { scale: Math.round(scale), labels: !!gmap.labels },
      gis: {
        zoom: Math.round(gisZoom),
        mps: Math.round(mps),
        copyAddrOnOpen: !!gis.copyAddrOnOpen
      }
    };
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
    send(res, 200, JSON.stringify(next), {
      'Content-Type': 'application/json; charset=utf-8'
    });
  } catch (err) {
    console.error('[settings put]', err.message);
    send(res, 500, JSON.stringify({ error: 'settings write failed' }), {
      'Content-Type': 'application/json; charset=utf-8'
    });
  }
}

function emptyPastCases() {
  return { version: 1, updated: null, items: [] };
}

function readPastCases() {
  try {
    const raw = fs.readFileSync(PAST_CASES_PATH, 'utf8');
    const j = JSON.parse(raw || '{}');
    if (!Array.isArray(j.items)) j.items = [];
    if (!j.version) j.version = 1;
    return j;
  } catch (err) {
    if (err && err.code === 'ENOENT') return emptyPastCases();
    throw err;
  }
}

function writePastCases(data) {
  const dir = path.dirname(PAST_CASES_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PAST_CASES_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function handleGetPastCases(res) {
  try {
    const data = readPastCases();
    send(res, 200, JSON.stringify(data), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache'
    });
  } catch (err) {
    console.error('[past-cases get]', err.message);
    send(res, 500, JSON.stringify({ error: 'past-cases read failed' }), {
      'Content-Type': 'application/json; charset=utf-8'
    });
  }
}

async function handlePostPastCases(req, res) {
  try {
    const raw = await readBody(req, 64 * 1024);
    const body = JSON.parse(raw.toString('utf8') || '{}');
    const name = String(body.name == null ? '' : body.name).trim();
    const kintoneUrl = String(body.kintoneUrl == null ? '' : body.kintoneUrl).trim();
    const address = String(body.address == null ? '' : body.address).trim().slice(0, 200);
    const building = String(body.building == null ? '' : body.building).trim().slice(0, 120);
    const memo = String(body.memo == null ? '' : body.memo).trim().slice(0, 500);
    const lat = Number(body.lat);
    const lon = Number(body.lon);
    if (!name) {
      return send(res, 400, JSON.stringify({ error: '被相続人名が必要です' }), {
        'Content-Type': 'application/json; charset=utf-8'
      });
    }
    if (!kintoneUrl || !/^https?:\/\//i.test(kintoneUrl)) {
      return send(res, 400, JSON.stringify({ error: '有効な kintone URL が必要です' }), {
        'Content-Type': 'application/json; charset=utf-8'
      });
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 20 || lat > 46 || lon < 122 || lon > 154) {
      return send(res, 400, JSON.stringify({ error: '緯度経度が不正です' }), {
        'Content-Type': 'application/json; charset=utf-8'
      });
    }
    const data = readPastCases();
    const item = {
      id: 'pc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      lat,
      lon,
      name: name.slice(0, 80),
      building,
      kintoneUrl: kintoneUrl.slice(0, 500),
      address,
      memo,
      createdAt: new Date().toISOString()
    };
    data.items.push(item);
    data.updated = item.createdAt;
    writePastCases(data);
    send(res, 200, JSON.stringify({ item, items: data.items, updated: data.updated }), {
      'Content-Type': 'application/json; charset=utf-8'
    });
  } catch (err) {
    console.error('[past-cases post]', err.message);
    send(res, 500, JSON.stringify({ error: 'past-cases write failed' }), {
      'Content-Type': 'application/json; charset=utf-8'
    });
  }
}

const server = http.createServer(async (req, res) => {
  const host = req.headers.host || `localhost:${PORT}`;
  const url = new URL(req.url || '/', `http://${host}`);
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    return send(res, 204, '', {
      'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
  }

  if (p === '/api/rosenka-proxy' && req.method === 'GET') {
    return handleProxy(req, res, url.searchParams.get('u'));
  }
  if (p === '/api/settings' && req.method === 'GET') {
    return handleGetSettings(res);
  }
  if (p === '/api/settings' && req.method === 'PUT') {
    return handlePutSettings(req, res);
  }
  if (p === '/api/past-cases' && req.method === 'GET') {
    return handleGetPastCases(res);
  }
  if (p === '/api/past-cases' && req.method === 'POST') {
    return handlePostPastCases(req, res);
  }

  // 静的ファイル
  let filePath = null;
  if (p === '/' || p === '') {
    filePath = path.join(PUBLIC, 'index.html');
  } else if (p.startsWith('/icon/')) {
    filePath = safeJoin(path.join(ROOT, 'icon'), p.slice('/icon/'.length));
  } else if (p.startsWith('/config/')) {
    filePath = safeJoin(path.join(ROOT, 'config'), p.slice('/config/'.length));
  } else if (p.startsWith('/data/')) {
    filePath = safeJoin(path.join(ROOT, 'data'), p.slice('/data/'.length));
  } else {
    filePath = safeJoin(PUBLIC, p);
  }

  if (!filePath) {
    return send(res, 403, 'forbidden', { 'Content-Type': 'text/plain' });
  }

  // ディレクトリなら index は不要（公開はファイルのみ）
  fs.stat(filePath, (err, st) => {
    if (!err && st.isDirectory()) {
      return send(res, 404, 'not found', { 'Content-Type': 'text/plain' });
    }
    if (err || !st.isFile()) {
      return send(res, 404, 'not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    serveFile(res, filePath, req);
  });
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`路線価チェッくん ${url}`);
  if (process.env.OPEN_BROWSER === '1') openBrowser(url);
});

server.on('error', err => {
  if (err && err.code === 'EADDRINUSE') {
    const url = `http://localhost:${PORT}`;
    console.error(`ポート ${PORT} は既に使用中です。既存のサーバーを開きます: ${url}`);
    if (process.env.OPEN_BROWSER === '1') {
      openBrowser(url);
      setTimeout(() => process.exit(0), 400);
      return;
    }
  }
  console.error(err);
  process.exit(1);
});
