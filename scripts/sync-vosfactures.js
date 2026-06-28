// scripts/sync-vosfactures.js — PostgreSQL avec pagination
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

// Récupère toutes les pages d'un endpoint VosFactures
async function fetchAllPages(vfApi, endpoint, extraParams = {}) {
  const results = [];
  let page = 1;
  while (true) {
    const { data } = await vfApi.get(endpoint, {
      params: { page, per_page: 100, ...extraParams }
    });
    const items = Array.isArray(data) ? data : [];
    if (items.length === 0) break;
    results.push(...items);
    console.log(`  → Page ${page} : ${items.length} éléments récupérés`);
    if (items.length < 100) break; // dernière page
    page++;
  }
  return results;
}

async function log(type, status, message, records = 0) {
  try {
    const client = await pool.connect();
    await client.query(
      'INSERT INTO sync_log (type,status,message,records) VALUES ($1,$2,$3,$4)',
      [type, status, message, records]
    );
    client.release();
  } catch(e) { console.error('Erreur log sync:', e.message); }
}

async function syncClients() {
  const vfApi = getVfApi();
  const client = await pool.connect();
  try {
    console.log('⏳ Sync clients VosFactures...');
    const clients = await fetchAllPages(vfApi, '/clients.json');
    console.log(`  Total clients trouvés : ${clients.length}`);
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
      `, [
        nom,
        c.buyer_name || null,
        c.email || null,
        c.phone || c.mobile || null,
        c.city || null,
        'Distributeur',
        c.id
      ]);
      count++;
    }
    await log('clients', 'ok', `${count} clients synchronisés`, count);
    return `${count} clients synchronisés`;
  } catch(e) {
    await log('clients', 'error', e.message);
    throw e;
  } finally { client.release(); }
}

async function syncProducts() {
  const vfApi = getVfApi();
  const client = await pool.connect();
  try {
    console.log('⏳ Sync produits VosFactures...');
    const products = await fetchAllPages(vfApi, '/products.json');
    console.log(`  Total produits trouvés : ${products.length}`);
    let count = 0;
    for (const p of products) {
      const ref = p.code || p.name?.substring(0,20) || `VF-${p.id}`;
      await client.query(`
        INSERT INTO catalogue (ref, designation, pxht, vf_product_id)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (vf_product_id) DO UPDATE SET
          ref=EXCLUDED.ref, designation=EXCLUDED.designation,
          pxht=EXCLUDED.pxht, updated_at=NOW()
        ON CONFLICT (ref) DO UPDATE SET
          designation=EXCLUDED.designation,
          pxht=EXCLUDED.pxht,
          vf_product_id=EXCLUDED.vf_product_id,
          updated_at=NOW()
      `, [ref, p.name || '—', parseFloat(p.price_net || 0), p.id]);
      count++;
    }
    await log('products', 'ok', `${count} produits synchronisés`, count);
    return `${count} produits synchronisés`;
  } catch(e) {
    await log('products', 'error', e.message);
    throw e;
  } finally { client.release(); }
}

async function syncInvoices() {
  const vfApi = getVfApi();
  const client = await pool.connect();
  try {
    console.log('⏳ Sync factures VosFactures...');
    const invoices = await fetchAllPages(vfApi, '/invoices.json', { period: 'last_12_months' });
    console.log(`  Total factures trouvées : ${invoices.length}`);
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
  } catch(e) {
    await log('invoices', 'error', e.message);
    throw e;
  } finally { client.release(); }
}

module.exports = { syncClients, syncProducts, syncInvoices };
