// scripts/sync-vosfactures.js
// Lance avec : node scripts/sync-vosfactures.js
// Ou depuis l'API : POST /api/vosfactures/sync
require('dotenv').config();
const axios = require('axios');
const Database = require('better-sqlite3');
const path = require('path');

const VF_TOKEN = process.env.VOSFACTURES_API_TOKEN;
const VF_ACCOUNT = process.env.VOSFACTURES_ACCOUNT;
const DB_PATH = process.env.DB_PATH || './data/sav_eloflex.db';

if (!VF_TOKEN || !VF_ACCOUNT) {
  console.error('❌ VOSFACTURES_API_TOKEN et VOSFACTURES_ACCOUNT requis dans .env');
  process.exit(1);
}

const BASE_URL = `https://${VF_ACCOUNT}.vosfactures.fr`;
const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

const vfApi = axios.create({
  baseURL: BASE_URL,
  headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
  params: { api_token: VF_TOKEN }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(type, status, message, records = 0) {
  db.prepare('INSERT INTO sync_log (type, status, message, records) VALUES (?, ?, ?, ?)').run(type, status, message, records);
  const icon = status === 'ok' ? '✅' : '❌';
  console.log(`${icon} [${type}] ${message} (${records} enregistrements)`);
}

async function fetchAllPages(endpoint, params = {}) {
  const results = [];
  let page = 1;
  while (true) {
    const res = await vfApi.get(endpoint, { params: { ...params, page, per_page: 100 } });
    const data = res.data;
    if (!Array.isArray(data) || data.length === 0) break;
    results.push(...data);
    if (data.length < 100) break;
    page++;
  }
  return results;
}

// ── Sync Clients ─────────────────────────────────────────────────────────────

async function syncClients() {
  console.log('\n📋 Synchronisation des clients VosFactures...');
  try {
    const contacts = await fetchAllPages('/clients.json');
    const upsert = db.prepare(`
      INSERT INTO clients (nom, contact, email, tel, ville, type, vf_id)
      VALUES (@nom, @contact, @email, @tel, @ville, @type, @vf_id)
      ON CONFLICT(vf_id) DO UPDATE SET
        nom     = excluded.nom,
        contact = excluded.contact,
        email   = excluded.email,
        tel     = excluded.tel,
        ville   = excluded.ville,
        updated_at = datetime('now')
    `);
    const insertMany = db.transaction((rows) => rows.forEach(r => upsert.run(r)));
    const rows = contacts.map(c => ({
      nom:     c.name || c.company || 'Sans nom',
      contact: [c.first_name, c.last_name].filter(Boolean).join(' ') || null,
      email:   c.email || null,
      tel:     c.phone || c.mobile || null,
      ville:   c.city  || null,
      type:    'Distributeur',
      vf_id:   c.id
    }));
    insertMany(rows);
    log('clients', 'ok', `${rows.length} clients synchronisés depuis VosFactures`, rows.length);
    return rows.length;
  } catch (err) {
    log('clients', 'error', err.message, 0);
    throw err;
  }
}

// ── Sync Produits / Catalogue ─────────────────────────────────────────────────

async function syncProducts() {
  console.log('\n📦 Synchronisation des produits VosFactures...');
  try {
    const products = await fetchAllPages('/products.json');
    const upsert = db.prepare(`
      INSERT INTO catalogue (ref, designation, fournisseur, ref_fournisseur, pxht, stock, vf_product_id)
      VALUES (@ref, @designation, @fournisseur, @ref_fournisseur, @pxht, @stock, @vf_product_id)
      ON CONFLICT(vf_product_id) DO UPDATE SET
        ref         = excluded.ref,
        designation = excluded.designation,
        pxht        = excluded.pxht,
        stock       = excluded.stock,
        updated_at  = datetime('now')
      ON CONFLICT(ref) DO UPDATE SET
        designation = excluded.designation,
        pxht        = excluded.pxht,
        stock       = excluded.stock,
        vf_product_id = excluded.vf_product_id,
        updated_at  = datetime('now')
    `);
    const insertMany = db.transaction((rows) => rows.forEach(r => upsert.run(r)));
    const rows = products.map(p => ({
      ref:             p.code || `VF-${p.id}`,
      designation:     p.name,
      fournisseur:     null,
      ref_fournisseur: null,
      pxht:            parseFloat(p.price_net || p.price || 0),
      stock:           parseInt(p.quantity || 0, 10),
      vf_product_id:   p.id
    }));
    insertMany(rows);
    log('products', 'ok', `${rows.length} produits synchronisés depuis VosFactures`, rows.length);
    return rows.length;
  } catch (err) {
    log('products', 'error', err.message, 0);
    throw err;
  }
}

// ── Sync Factures → numéros sur fauteuils ────────────────────────────────────

async function syncInvoices() {
  console.log('\n🧾 Synchronisation des factures VosFactures...');
  try {
    // On récupère les factures des 2 dernières années
    const since = new Date();
    since.setFullYear(since.getFullYear() - 2);
    const dateFrom = since.toISOString().split('T')[0];
    const invoices = await fetchAllPages('/invoices.json', { period: 'more', date_from: dateFrom });
    const updateFauteuil = db.prepare(`
      UPDATE fauteuils SET vf_facture_id = @vf_id, updated_at = datetime('now')
      WHERE num_facture = @num
    `);
    let matched = 0;
    const doUpdate = db.transaction((invs) => {
      invs.forEach(inv => {
        const result = updateFauteuil.run({ vf_id: inv.id, num: inv.number });
        if (result.changes > 0) matched++;
      });
    });
    doUpdate(invoices);
    log('invoices', 'ok', `${invoices.length} factures récupérées, ${matched} liées à des fauteuils`, invoices.length);
    return invoices.length;
  } catch (err) {
    log('invoices', 'error', err.message, 0);
    throw err;
  }
}

// ── Point d'entrée ────────────────────────────────────────────────────────────

async function syncAll() {
  console.log(`\n🔄 Synchronisation VosFactures — ${BASE_URL}\n${'─'.repeat(50)}`);
  const results = {};
  try { results.clients = await syncClients(); } catch (e) { results.clients = `Erreur: ${e.message}`; }
  try { results.products = await syncProducts(); } catch (e) { results.products = `Erreur: ${e.message}`; }
  try { results.invoices = await syncInvoices(); } catch (e) { results.invoices = `Erreur: ${e.message}`; }
  console.log('\n📊 Résumé de la synchronisation :');
  Object.entries(results).forEach(([k, v]) => console.log(`  • ${k}: ${v}`));
  db.close();
  return results;
}

syncAll().catch(err => {
  console.error('Erreur fatale :', err.message);
  process.exit(1);
});

module.exports = { syncClients, syncProducts, syncInvoices, syncAll };
