// scripts/stock-bl-pennylane.js
// ─────────────────────────────────────────────────────────────────────────────
// Bons de livraison Pennylane → sortie de stock.
// Chaque nouveau BL émis dans Pennylane (depuis la date de démarrage) :
//   1. ses lignes sont rapprochées du catalogue pièces (référence EAN / produit Pennylane) ;
//   2. les fauteuils roulants / scooters sont EXCLUS (pas de gestion de stock pour eux) ;
//   3. un bon de sortie (wz) « PL-<n° BL> » est créé dans VosFactures, qui reste le stock de référence ;
//   4. le stock principal de l'appli est diminué tout de suite (sans attendre la synchro de nuit).
// Un BL n'est traité qu'une seule fois (table pl_bl_stock).
// Le stock SAV n'est jamais concerné.
// ─────────────────────────────────────────────────────────────────────────────
const db = require('../server/db');
const { plApi, fetchAllPages } = require('./sync-pennylane');

// Fauteuils roulants / scooters : jamais de mouvement de stock automatique
const REFS_FAUTEUILS = ['7350006080067', '7350006080531', '7350006080616', '7350006080623', '7350006080685',
  '7350006080852', '7350006084737', '7350006085994', '7350006086007', '7350006088162', '7350006082009'];
function estFauteuil(ref, designation) {
  const r = String(ref || '').trim();
  if (REFS_FAUTEUILS.some(x => r === x || r.startsWith(x + '-'))) return true;
  return /^\s*(fauteuils?|scooters?)\b/i.test(String(designation || ''));
}

function _estBL(x) {
  if (!x || typeof x !== 'object') return false;
  const t = String(x.type || x.document_type || x.kind || x.category || x.commercial_document_type || '').toLowerCase();
  const num = String(x.invoice_number || x.number || x.label || '');
  return /deliver|livr|shipping|dispatch/.test(t) || /^BL[\s\-_./]?\d/i.test(num);
}
const _date = d => String(d.date || d.issue_date || d.emitted_at || d.document_date || d.created_at || '').slice(0, 10);
const _norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

async function _param(cle) { const r = await db.get('SELECT valeur FROM parametres WHERE cle=$1', [cle]); return r ? r.valeur : null; }
async function _setParam(cle, v) {
  await db.run(`INSERT INTO parametres (cle, valeur) VALUES ($1,$2) ON CONFLICT (cle) DO UPDATE SET valeur=EXCLUDED.valeur`, [cle, v]);
}

async function ensureTable() {
  await db.run(`CREATE TABLE IF NOT EXISTS pl_bl_stock (
    id SERIAL PRIMARY KEY,
    pl_doc_id TEXT UNIQUE NOT NULL,
    numero TEXT, date_doc TEXT, client TEXT,
    statut TEXT,                -- 'sortie' | 'ignore' | 'erreur'
    lignes JSONB, vf_doc_id TEXT, message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW())`);
}

function vfApi() {
  if (!process.env.VOSFACTURES_API_TOKEN || !process.env.VOSFACTURES_ACCOUNT) return null;
  const axios = require('axios');
  return axios.create({ baseURL: `https://${process.env.VOSFACTURES_ACCOUNT}.vosfactures.fr`,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    params: { api_token: process.env.VOSFACTURES_API_TOKEN }, timeout: 60000 });
}

async function _lignesBL(api, doc) {
  let detail = doc;
  try {
    const { data } = await api.get(`/commercial_documents/${doc.id}`);
    const f = data.commercial_document || data;
    if (f && typeof f === 'object') detail = Object.assign({}, doc, f);
  } catch (_) {}
  let raw = detail.invoice_lines || detail.line_items || [];
  if (!raw.length) {
    try { const { data } = await api.get(`/commercial_documents/${doc.id}/invoice_lines`); raw = data.items || data.invoice_lines || []; } catch (_) {}
  }
  const out = [];
  for (const l of raw) {
    let ref = l.product_reference || l.reference || (l.product && (l.product.reference || l.product.external_reference || l.product.gtin)) || null;
    const pid = l.product_id || (l.product && l.product.id) || null;
    if (!ref && pid) {
      try { const { data } = await api.get(`/products/${pid}`); const p = data.product || data; ref = p.reference || p.external_reference || p.gtin || null; } catch (_) {}
    }
    const label = l.label || l.description || l.product_label || '';
    if (!ref) { const m = label.match(/\b7350\d{9}\b/); if (m) ref = m[0]; }
    out.push({ ref, pl_product_id: pid ? String(pid) : null, label, quantite: parseFloat(l.quantity) || 0 });
  }
  return { detail, lignes: out };
}

/**
 * @param {object} opt  { depuis: 'AAAA-MM-JJ' (optionnel, sinon paramètre pl_bl_stock_depuis), simulation: bool }
 */
async function syncStockBLPennylane(opt = {}) {
  await ensureTable();
  let depuis = opt.depuis || await _param('pl_bl_stock_depuis');
  if (!depuis) { depuis = new Date().toISOString().slice(0, 10); await _setParam('pl_bl_stock_depuis', depuis); }
  const api = plApi();
  const docs = (await fetchAllPages(api, '/commercial_documents', {})).filter(d => _estBL(d) && (!_date(d) || _date(d) >= depuis));
  const deja = new Set((await db.all('SELECT pl_doc_id FROM pl_bl_stock')).map(r => r.pl_doc_id));
  const cat = await db.all('SELECT id, ref, designation, stock, vf_product_id, pl_product_id FROM catalogue');
  const parRef = {}, parPl = {};
  cat.forEach(c => { parRef[_norm(c.ref)] = parRef[_norm(c.ref)] || c; if (c.pl_product_id) parPl[String(c.pl_product_id)] = c; });

  const vf = vfApi();
  let warehouseId = null;
  if (vf && !opt.simulation) { try { const { data } = await vf.get('/warehouses.json'); const w = (data || []).find(x => x.kind === 'main') || (data || [])[0]; warehouseId = w && w.id; } catch (_) {} }

  const bilan = { depuis, bl_trouves: docs.length, traites: 0, sorties: 0, ignores: 0, erreurs: 0, details: [] };
  for (const doc of docs) {
    const pid = String(doc.id);
    if (deja.has(pid)) continue;
    const numero = doc.invoice_number || doc.number || doc.label || pid;
    try {
      const { detail, lignes } = await _lignesBL(api, doc);
      const client = (detail.customer && (detail.customer.name || detail.customer.company_name)) || detail.customer_name || '';
      const mouvements = {}, horsCat = [], fauteuils = [];
      for (const l of lignes) {
        if (!(l.quantite > 0)) continue;
        const c = (l.pl_product_id && parPl[l.pl_product_id]) || (l.ref && parRef[_norm(l.ref)]) || null;
        if (!c) {
          if (estFauteuil(l.ref, l.label)) fauteuils.push(l.label);
          else if (!/\b(offre|essai gratuit|non valable|commentaire|frais|port|transport|livraison|exp[ée]dition|envoi|emballage|remise|forfait|main[- ]d.?(oe|œ)uvre|intervention)\b/i.test(l.label || '')) horsCat.push(l.label || l.ref);
          continue;
        }
        if (estFauteuil(c.ref, c.designation) || estFauteuil(l.ref, l.label)) { fauteuils.push(c.designation); continue; }
        const m = mouvements[c.id] || (mouvements[c.id] = { id: c.id, ref: c.ref, designation: c.designation, vf_product_id: c.vf_product_id, quantite: 0 });
        m.quantite += Math.round(l.quantite);
      }
      const mv = Object.values(mouvements);
      const info = { numero, client, mouvements: mv, fauteuils_exclus: fauteuils, hors_catalogue: horsCat };
      if (opt.simulation) { bilan.details.push(info); continue; }
      if (!mv.length) {
        await db.run(`INSERT INTO pl_bl_stock (pl_doc_id, numero, date_doc, client, statut, lignes, message) VALUES ($1,$2,$3,$4,'ignore',$5,$6)
                      ON CONFLICT (pl_doc_id) DO NOTHING`, [pid, numero, _date(detail), client, JSON.stringify(info), 'Aucune pièce détachée à sortir du stock']);
        bilan.ignores++; bilan.traites++; continue;
      }
      // 1) Bon de sortie dans VosFactures (stock de référence)
      let vfDocId = null, msg = '';
      const actions = mv.filter(m => m.vf_product_id).map(m => ({ product_id: Number(m.vf_product_id), quantity: m.quantite }));
      if (vf && warehouseId && actions.length) {
        try {
          const { data } = await vf.post('/warehouse_documents.json', { warehouse_document: {
            kind: 'wz', warehouse_id: warehouseId, issue_date: _date(detail) || new Date().toISOString().slice(0, 10),
            number: `PL-${numero}`, description: `Sortie de stock — BL Pennylane ${numero}${client ? ' — ' + client : ''}`,
            warehouse_actions: actions } });
          vfDocId = data && data.id ? String(data.id) : null;
        } catch (e) { msg = 'VosFactures : ' + ((e.response && JSON.stringify(e.response.data)) || e.message); }
      } else if (!vf) msg = 'VosFactures non configuré : stock de l\'appli seul mis à jour';
      // 2) Stock principal de l'appli tout de suite
      for (const m of mv) await db.run('UPDATE catalogue SET stock=GREATEST(0, stock-$1), updated_at=NOW() WHERE id=$2', [m.quantite, m.id]);
      await db.run(`INSERT INTO pl_bl_stock (pl_doc_id, numero, date_doc, client, statut, lignes, vf_doc_id, message) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                    ON CONFLICT (pl_doc_id) DO NOTHING`, [pid, numero, _date(detail), client, msg && !vfDocId ? 'erreur' : 'sortie', JSON.stringify(info), vfDocId, msg || null]);
      try {
        await db.run('INSERT INTO alertes (type, reference_id, message) VALUES ($1,$2,$3)', ['stock_bl_pennylane', null,
          `📦 BL Pennylane ${numero}${client ? ' (' + client + ')' : ''} : ${mv.reduce((s, m) => s + m.quantite, 0)} pièce(s) sorties du stock` +
          (fauteuils.length ? ` — fauteuil(s) exclu(s)` : '') + (horsCat.length ? ` — ${horsCat.length} ligne(s) hors catalogue` : '') + (msg ? ' — ⚠ ' + msg.slice(0, 120) : '')]);
      } catch (_) {}
      bilan.sorties++; bilan.traites++; if (msg && !vfDocId) bilan.erreurs++;
      bilan.details.push(info);
    } catch (e) {
      bilan.erreurs++;
      bilan.details.push({ numero, erreur: e.message });
    }
  }
  return bilan;
}

module.exports = { syncStockBLPennylane, estFauteuil, ensureTable };
