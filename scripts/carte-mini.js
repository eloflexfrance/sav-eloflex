// scripts/carte-mini.js
// ─────────────────────────────────────────────────────────────────────────────
// Mini-carte PNG (tuiles OpenStreetMap + repère) pour les e-mails.
// L'image est générée une fois par distributeur et position, puis mise en cache en base.
// Elle est servie publiquement via /carte-mini/<id>/<signature>.png (signature HMAC :
// impossible de parcourir les fiches en changeant l'identifiant).
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const axios = require('axios');
const db = require('../server/db');

const W = 560, H = 240, Z = 14, TS = 256;
const UA = 'EloflexSAV/1.0 (sav@eloflex.fr)';

function signature(id) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET || 'sav-eloflex-dev-secret-CHANGEZ-EN-PROD')
    .update('carte-mini:' + id).digest('hex').slice(0, 20);
}

async function ensureTable() {
  await db.run(`CREATE TABLE IF NOT EXISTS carte_mini (
    client_id INTEGER PRIMARY KEY, lat NUMERIC(10,7), lng NUMERIC(10,7), png BYTEA, created_at TIMESTAMPTZ DEFAULT NOW())`);
}

function _tuile(lat, lng, z) {
  const n = Math.pow(2, z);
  const x = (lng + 180) / 360 * n;
  const r = lat * Math.PI / 180;
  const y = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n;
  return { x, y };
}

async function _getTuile(z, x, y) {
  const n = Math.pow(2, z); x = ((x % n) + n) % n;
  const { data } = await axios.get(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
    { responseType: 'arraybuffer', timeout: 10000, headers: { 'User-Agent': UA } });
  return Buffer.from(data);
}

/** Génère le PNG (W×H) centré sur lat/lng avec un repère. Lève une erreur si les tuiles sont inaccessibles. */
async function genererPng(lat, lng, opts = {}) {
  const sharp = require('sharp');
  const getTuile = opts.getTuile || _getTuile;
  const c = _tuile(lat, lng, Z);
  const px = c.x * TS, py = c.y * TS;            // position absolue du point en pixels
  const x0 = px - W / 2, y0 = py - H / 2;        // coin haut-gauche de l'image voulue
  const tx0 = Math.floor(x0 / TS), ty0 = Math.floor(y0 / TS);
  const tx1 = Math.floor((x0 + W - 1) / TS), ty1 = Math.floor((y0 + H - 1) / TS);
  const comps = [];
  for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) {
    comps.push({ input: await getTuile(Z, tx, ty), left: (tx - tx0) * TS, top: (ty - ty0) * TS });
  }
  const bw = (tx1 - tx0 + 1) * TS, bh = (ty1 - ty0 + 1) * TS;
  const fond = await sharp({ create: { width: bw, height: bh, channels: 3, background: '#e8eef3' } })
    .composite(comps).png().toBuffer();
  const ox = Math.round(x0 - tx0 * TS), oy = Math.round(y0 - ty0 * TS);
  const repere = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <g transform="translate(${W / 2},${H / 2})">
      <ellipse cx="0" cy="2" rx="9" ry="3" fill="rgba(0,0,0,.25)"/>
      <path d="M0,0 C-4,-10 -14,-16 -14,-27 A14,14 0 1 1 14,-27 C14,-16 4,-10 0,0 Z" fill="#E1442E" stroke="#fff" stroke-width="2"/>
      <circle cx="0" cy="-27" r="5.5" fill="#fff"/>
    </g>
    <rect x="${W - 150}" y="${H - 16}" width="150" height="16" fill="rgba(255,255,255,.75)"/>
    <text x="${W - 6}" y="${H - 4}" font-family="Arial, sans-serif" font-size="10" fill="#444" text-anchor="end">© contributeurs OpenStreetMap</text>
    <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" fill="none" stroke="#c9d3dc"/>
  </svg>`);
  return sharp(fond).extract({ left: ox, top: oy, width: W, height: H })
    .composite([{ input: repere, left: 0, top: 0 }]).png({ compressionLevel: 9 }).toBuffer();
}

/** PNG en cache pour un distributeur (régénéré si sa position a changé). null si impossible. */
async function pngClient(clientId, lat, lng) {
  await ensureTable();
  lat = Number(lat); lng = Number(lng);
  if (!isFinite(lat) || !isFinite(lng)) return null;
  const ex = await db.get('SELECT lat, lng, png FROM carte_mini WHERE client_id=$1', [clientId]);
  if (ex && ex.png && Math.abs(Number(ex.lat) - lat) < 1e-6 && Math.abs(Number(ex.lng) - lng) < 1e-6) return ex.png;
  const png = await genererPng(lat, lng);
  await db.run(`INSERT INTO carte_mini (client_id, lat, lng, png, created_at) VALUES ($1,$2,$3,$4,NOW())
    ON CONFLICT (client_id) DO UPDATE SET lat=EXCLUDED.lat, lng=EXCLUDED.lng, png=EXCLUDED.png, created_at=NOW()`, [clientId, lat, lng, png]);
  return png;
}

/** Route publique Express : /carte-mini/:id/:sig.png */
async function routePublique(req, res) {
  try {
    const id = parseInt(req.params.id);
    if (!id || req.params.sig !== signature(id)) return res.status(404).end();
    await ensureTable();
    const r = await db.get('SELECT png FROM carte_mini WHERE client_id=$1', [id]);
    if (!r || !r.png) return res.status(404).end();
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(r.png);
  } catch (e) { res.status(500).end(); }
}

module.exports = { signature, genererPng, pngClient, routePublique, ensureTable };
