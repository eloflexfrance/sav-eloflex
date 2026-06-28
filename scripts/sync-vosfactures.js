// scripts/sync-vosfactures.js — PostgreSQL
require('dotenv').config();
const axios = require('axios');
const { pool } = require('../server/db');
 
// Pas de process.exit ici — les variables sont vérifiées dans chaque fonction
 
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
    const { data } = await vfApi.get('/clients.json');
    const clients = Array.isArray(data) ? data : [];
    let count = 0;
    for (const c of clients) {
      await client.query(`
        INSERT INTO clients (nom, email, tel, vf_id, token_portail)
        VALUES ($1,$2,$3,$4,md5(random()::text))
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
  const vfApi = getVfApi();
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
  const vfApi = getVfApi();
  const client = await pool.connect();
  try {
    const { data } = await vfApi.get('/invoices.json', { params: { period: 'last_12_months' } });
    const invoices = Array.isArray(data) ? data : [];
    let count = 0;
    for (const inv of invoices) {
      if (inv.client_id) {
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
