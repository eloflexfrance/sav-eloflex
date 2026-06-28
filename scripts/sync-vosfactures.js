// scripts/sync-vosfactures.js — PostgreSQL avec pagination complète
require('dotenv').config();
const axios = require('axios');
const { pool } = require('../server/db');

function getVfApi() {
  const token   = process.env.VOSFACTURES_API_TOKEN;
  const account = process.env.VOSFACTURES_ACCOUNT;
  if (!token || !account) throw new Error('VOSFACTURES_API_TOKEN et VOSFACTURES_ACCOUNT non configurés');
  return axios.create({
    baseURL: `https://${account}.vosfactures.fr`,
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    params:  { api_token: token }
  });
}

async function fetchAllPages(vfApi, endpoint, extraParams = {}) {
  const results = [];
  let page = 1;
  while (true) {
    const { data } = await vfApi.get(endpoint, { params: { page, per_page: 100, ...extraParams } });
    const items = Array.isArray(data) ? data : [];
    if (items.length === 0) break;
    results.push(...items);
    console.log(`  Page ${page} : ${items.length} éléments`);
    if (items.length < 100) break;
    page++;
  }
  return results;
}

async function log(type, status, message, records = 0) {
  try {
    const client = await pool.connect();
    await client.query('INSERT INTO sync_log (type,status,message,records) VALUES ($1,$2,$3,$4)', [type, status, message, records]);
    client.release();
  } catch(e) { console.error('Erreur log:', e.message); }
}

async function syncClients() {
  const vfApi = getVfApi();
  const client = await pool.connect();
  try {
    console.log('⏳ Sync clients...');
    const clients = await fetchAllPages(vfApi, '/clients.json');
    console.log(`  Total : ${clients.length} clients`);
    let count = 0;
    for (const c of clients) {
      const nom = c.name || c.shortcut || c.email || '—';
      await client.query(`
        INSERT INTO clients (nom, contact, email, tel, ville, type, vf_id, token_portail)
        VALUES ($1,$2,$3,$4,$5,$6,$7,md5(random()::text))
        ON CONFLICT (vf_id) DO UPDATE SET
          nom=EXCLUDED.nom, contact=EXCLUDED.contact,
          email=EXCLUDED.email, tel=EXCLUDED.tel,
          ville=EXCLUDED.ville, updated_at=NOW()
      `, [nom, c.buyer_name||null, c.email||null, c.phone||c.mobile||null, c.city||null, 'Distributeur', c.id]);
      count++;
    }
    await log('clients', 'ok', `${count} clients synchronisés`, count);
    return `${count} clients synchronisés`;
  } catch(e) { await log('clients', 'error', e.message); throw e; }
  finally { client.release(); }
}

async function syncProducts() {
  const vfApi = getVfApi();
  const client = await pool.connect();
  try {
    console.log('⏳ Sync produits...');
    const products = await fetchAllPages(vfApi, '/products.json');
    console.log(`  Total : ${products.length} produits`);
    let count = 0, skipped = 0;

    for (const p of products) {
      // Référence : code EAN si dispo, sinon VF-{id}
      const ref = (p.code && p.code.trim()) ? p.code.trim() : `VF-${p.id}`;
      const designation = p.name || '—';
      const pxht = parseFloat(p.price_net || 0);
      const stock = parseFloat(p.warehouse_quantity || 0);

      try {
        // Upsert par vf_product_id (clé unique stable)
        await client.query(`
          INSERT INTO catalogue (ref, designation, fournisseur, ref_fournisseur, pxht, stock, vf_product_id)
          VALUES ($1, $2, 'Eloflex AB', $3, $4, $5, $6)
          ON CONFLICT (vf_product_id) DO UPDATE SET
            ref        = CASE WHEN catalogue.ref LIKE 'VF-%' THEN EXCLUDED.ref ELSE catalogue.ref END,
            designation = EXCLUDED.designation,
            pxht       = EXCLUDED.pxht,
            stock      = EXCLUDED.stock,
            updated_at = NOW()
        `, [ref, designation, p.supplier_code||null, pxht, Math.max(0, Math.round(stock)), p.id]);
        count++;
      } catch(e) {
        // Conflit sur ref (deux produits VF avec même code) → on suffixe
        try {
          await client.query(`
            INSERT INTO catalogue (ref, designation, fournisseur, ref_fournisseur, pxht, stock, vf_product_id)
            VALUES ($1, $2, 'Eloflex AB', $3, $4, $5, $6)
            ON CONFLICT (vf_product_id) DO UPDATE SET
              designation = EXCLUDED.designation, pxht = EXCLUDED.pxht, stock = EXCLUDED.stock, updated_at = NOW()
          `, [`VF-${p.id}`, designation, p.supplier_code||null, pxht, Math.max(0, Math.round(stock)), p.id]);
          count++;
        } catch(e2) {
          console.warn(`  ⚠️ Produit ignoré : ${p.name} (${e2.message})`);
          skipped++;
        }
      }
    }
    const msg = `${count} produits synchronisés${skipped ? `, ${skipped} ignorés` : ''}`;
    await log('products', 'ok', msg, count);
    return msg;
  } catch(e) { await log('products', 'error', e.message); throw e; }
  finally { client.release(); }
}

async function syncInvoices() {
  const vfApi = getVfApi();
  const client = await pool.connect();
  try {
    console.log('⏳ Sync factures...');
    const invoices = await fetchAllPages(vfApi, '/invoices.json', { period: 'last_12_months' });
    console.log(`  Total : ${invoices.length} factures`);
    let count = 0;
    for (const inv of invoices) {
      if (inv.client_id) {
        await client.query(`
          UPDATE fauteuils SET num_facture=$1, vf_facture_id=$2, updated_at=NOW()
          WHERE vf_facture_id IS NULL
            AND client_id IN (SELECT id FROM clients WHERE vf_id=$3)
        `, [inv.number, inv.id, inv.client_id]);
      }
      count++;
    }
    await log('invoices', 'ok', `${count} factures traitées`, count);
    return `${count} factures traitées`;
  } catch(e) { await log('invoices', 'error', e.message); throw e; }
  finally { client.release(); }
}

module.exports = { syncClients, syncProducts, syncInvoices };
