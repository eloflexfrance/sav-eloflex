// scripts/sync-vosfactures.js — PostgreSQL
require('dotenv').config();
const axios = require('axios');
const { pool } = require('../server/db');

const VF_TOKEN   = process.env.VOSFACTURES_API_TOKEN;
const VF_ACCOUNT = process.env.VOSFACTURES_ACCOUNT;

if (!VF_TOKEN || !VF_ACCOUNT) {
  console.error('❌ VOSFACTURES_API_TOKEN et VOSFACTURES_ACCOUNT requis dans .env');
  process.exit(1);
}

const vfApi = axios.create({
  baseURL: `https://${VF_ACCOUNT}.vosfactures.fr`,
  headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
  params:  { api_token: VF_TOKEN }
});

async function log(type, status, message, records = 0) {
  try {
    const client = await pool.connect();
    await client.query(
      'INSERT INTO sync_log (type,status,message,records) VALUES ($1,$2,$3,$4)',
      [type, status, message, records]
    );
    client.release();
  } catch(e) { console.error('Erreur log:', e.message); }
}

async function syncClients() {
  const client = await pool.connect();
  try {
    const { data } = await vfApi.get('/clients.json');
    const clients = Array.isArray(data) ? data : [];
    let count = 0;
    for (const c of clients) {
      await client.query(`
        INSERT INTO clients (nom, email, tel, vf_id)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (vf_id) DO UPDATE SET nom=EXCLUDED.nom, email=EXCLUDED.email, tel=EXCLUDED.tel, updated_at=NOW()
      `, [c.name||c.shortcut||'—', c.email||null, c.phone||null, c.id]);
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
  const client = await pool.connect();
  try {
    const { data } = await vfApi.get('/products.json');
    const products = Array.isArray(data) ? data : [];
    let count = 0;
    for (const p of products) {
      await client.query(`
        INSERT INTO catalogue (ref, designation, pxht, vf_product_id)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (vf_product_id) DO UPDATE SET ref=EXCLUDED.ref, designation=EXCLUDED.designation, pxht=EXCLUDED.pxht, updated_at=NOW()
      `, [p.code||`VF-${p.id}`, p.name||'—', parseFloat(p.price_net||0), p.id]);
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
  const client = await pool.connect();
  try {
    const { data } = await vfApi.get('/invoices.json', { params: { period: 'last_12_months' } });
    const invoices = Array.isArray(data) ? data : [];
    let count = 0;
    for (const inv of invoices) {
      // Mettre à jour le num_facture sur le fauteuil si le numéro de série correspond
      if (inv.buyer_name) {
        await client.query(`
          UPDATE fauteuils SET num_facture=$1, vf_facture_id=$2, updated_at=NOW()
          WHERE num_facture IS NULL AND vf_facture_id IS NULL
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
