'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5173;
const SETTINGS_PATH = path.join(__dirname, 'config', 'settings.json');

const ALLOWED_HOSTS = new Set([
  'www.rosenka.nta.go.jp',
  'rosenka.nta.go.jp',
  'maps.gsi.go.jp',
  'mreversegeocoder.gsi.go.jp',
  'msearch.gsi.go.jp',
  'cyberjapandata.gsi.go.jp',
  'nominatim.openstreetmap.org',
  'zipcloud.ibsnet.co.jp'
]);

app.use(express.json({ limit: '32kb' }));

app.get('/api/rosenka-proxy', async (req, res) => {
  const target = req.query.u;
  if (!target || typeof target !== 'string') {
    return res.status(400).send('missing u');
  }

  let url;
  try {
    url = new URL(target);
  } catch {
    return res.status(400).send('invalid url');
  }

  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
    return res.status(403).send('host not allowed');
  }

  try {
    const upstream = await fetch(url.href, {
      headers: {
        'User-Agent': 'RosenkaMap/1.0 (portfolio reproduction; educational)',
        Accept: '*/*'
      },
      redirect: 'follow'
    });

    const buf = Buffer.from(await upstream.arrayBuffer());
    const ct = upstream.headers.get('content-type') || 'application/octet-stream';
    res.status(upstream.status);
    res.set('Content-Type', ct);
    res.set('Cache-Control', 'public, max-age=3600');
    res.set('Access-Control-Allow-Origin', '*');
    res.send(buf);
  } catch (err) {
    console.error('[proxy]', err.message);
    res.status(502).send('upstream fetch failed');
  }
});

app.get('/api/settings', (req, res) => {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    res.type('json').send(raw);
  } catch (err) {
    console.error('[settings get]', err.message);
    res.status(500).json({ error: 'settings read failed' });
  }
});

app.put('/api/settings', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'invalid body' });
  }
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
    return res.status(400).json({ error: 'invalid numbers' });
  }
  if (zoom < 1 || zoom > 18 || gisZoom < 1 || gisZoom > 20) {
    return res.status(400).json({ error: 'zoom out of range' });
  }
  const next = {
    map: {
      lat,
      lon,
      zoom: Math.round(zoom),
      label: String(map.label == null ? '' : map.label).slice(0, 80)
    },
    gmap: {
      scale: Math.round(scale),
      labels: !!gmap.labels
    },
    gis: {
      zoom: Math.round(gisZoom),
      mps: Math.round(mps)
    }
  };
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
    res.json(next);
  } catch (err) {
    console.error('[settings put]', err.message);
    res.status(500).json({ error: 'settings write failed' });
  }
});

app.use('/icon', express.static(path.join(__dirname, 'icon'), {
  maxAge: 0,
  etag: false,
  lastModified: false,
  setHeaders(res) {
    res.set('Cache-Control', 'no-store');
  }
}));
app.use('/config', express.static(path.join(__dirname, 'config'), {
  maxAge: 0,
  etag: false,
  lastModified: false,
  setHeaders(res) {
    res.set('Cache-Control', 'no-store');
  }
}));
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`土地マップ http://localhost:${PORT}`);
});
