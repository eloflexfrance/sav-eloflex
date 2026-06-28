// server/cron.js — tâches automatiques (PostgreSQL)
const cron = require('node-cron');
const db   = require('./db');

async function param(cle) {
  const r = await db.get('SELECT valeur FROM parametres WHERE cle=$1', [cle]);
  return r ? r.valeur : null;
}

async function addAlerte(type, refId, message) {
  const exist = await db.get('SELECT id FROM alertes WHERE type=$1 AND reference_id=$2 AND lue=false', [type, refId]);
  if (!exist) await db.run('INSERT INTO alertes (type,reference_id,message) VALUES ($1,$2,$3)', [type, refId, message]);
}

// ── Sync VosFactures automatique ──────────────────────────────────
async function runVfSync() {
  if (!process.env.VOSFACTURES_API_TOKEN || !process.env.VOSFACTURES_ACCOUNT) return;
  try {
    console.log('[CRON] Sync VosFactures automatique...');
    const { syncClients, syncProducts, syncInvoices } = require('../scripts/sync-vosfactures');
    const [c, p, i] = await Promise.allSettled([syncClients(), syncProducts(), syncInvoices()]);
    console.log(`[CRON] VF sync — clients: ${c.value||c.reason?.message}, produits: ${p.value||p.reason?.message}, factures: ${i.value||i.reason?.message}`);
  } catch(e) {
    console.error('[CRON] Erreur sync VF :', e.message);
  }
}

// ── Vérifications quotidiennes ────────────────────────────────────
async function runDailyChecks() {
  try {
    const relanceJours = parseInt(await param('relance_jours') || '7');
    const now = new Date();

    // 1. Relances
    const enAttente = await db.all(
      `SELECT i.*,c.nom AS client_nom,f.modele FROM interventions i
       JOIN fauteuils f ON f.id=i.fauteuil_id JOIN clients c ON c.id=i.client_id
       WHERE i.statut IN ('Ouvert','En attente') AND i.relance_envoyee=false
       AND NOW()-i.updated_at >= ($1 || ' days')::INTERVAL`, [relanceJours]
    );
    for (const i of enAttente) {
      const j = Math.floor((now - new Date(i.updated_at)) / 86400000);
      await addAlerte('relance', i.id, `⏰ Intervention #${i.id} (${i.client_nom} — ${i.modele}) sans mise à jour depuis ${j} jours`);
      await db.run('UPDATE interventions SET relance_envoyee=true,updated_at=NOW() WHERE id=$1', [i.id]);
    }

    // 2. Expéditions sans retour depuis 14+ jours
    const expSansRetour = await db.all(
      `SELECT i.*,c.nom AS client_nom,f.modele FROM interventions i
       JOIN fauteuils f ON f.id=i.fauteuil_id JOIN clients c ON c.id=i.client_id
       WHERE i.envoi_numero IS NOT NULL AND i.envoi_numero!=''
         AND (i.retour_numero IS NULL OR i.retour_numero='')
         AND i.statut!='Fermé' AND i.envoi_date IS NOT NULL
         AND NOW()-i.envoi_date::date >= INTERVAL '14 days'`
    );
    for (const i of expSansRetour) {
      const j = Math.floor((now - new Date(i.envoi_date)) / 86400000);
      await addAlerte('retour_manquant', i.id, `📦 Aucun retour pour l'intervention #${i.id} (${i.client_nom}) — envoyé il y a ${j} jours`);
    }

    // 3. Garanties expirant dans 30 jours
    const expirent = await db.all(
      `SELECT f.*,c.nom AS client_nom FROM fauteuils f JOIN clients c ON c.id=f.client_id
       WHERE f.date_achat IS NOT NULL AND f.duree_garantie_mois IS NOT NULL
         AND (f.date_achat::date + (f.duree_garantie_mois || ' months')::INTERVAL)
             BETWEEN NOW() AND NOW()+INTERVAL '30 days'`
    );
    for (const f of expirent) {
      const exp = new Date(f.date_achat); exp.setMonth(exp.getMonth() + f.duree_garantie_mois);
      const j = Math.ceil((exp - now) / 86400000);
      await addAlerte('garantie_expire', f.id, `🔔 Garantie ${f.modele} (${f.serie}) — ${f.client_nom} expire dans ${j} jour${j>1?'s':''}`);
    }

    // 4. Stocks
    const stockFaible = await db.all('SELECT * FROM catalogue WHERE stock<=stock_alerte AND stock>0 AND stock_actif=true');
    for (const p of stockFaible)
      await addAlerte('stock_faible', p.id, `⚠️ Stock faible : ${p.designation} (${p.stock} restant${p.stock!==1?'s':''} / seuil ${p.stock_alerte})`);
    const stockZero = await db.all('SELECT * FROM catalogue WHERE stock=0 AND stock_actif=true AND ref NOT LIKE \'VF-%\'');
    for (const p of stockZero)
      await addAlerte('stock_zero', p.id, `🔴 Rupture de stock : ${p.designation} (${p.ref})`);

    if (enAttente.length + expSansRetour.length + expirent.length > 0)
      console.log(`[CRON] ${new Date().toISOString()} — ${enAttente.length} relance(s), ${expSansRetour.length} retour(s) manquant(s), ${expirent.length} garantie(s)`);

  } catch(e) { console.error('[CRON] Erreur :', e.message); }
}

// ── Ping anti-veille Render ───────────────────────────────────────
async function pingKeepAlive() {
  const url = process.env.APP_URL;
  if (!url) return;
  try {
    const https = require('https');
    https.get(`${url}/api/stats`, res => {
      console.log(`[PING] Keep-alive → ${res.statusCode}`);
    }).on('error', ()=>{});
  } catch(e){}
}

function startCron() {
  // Vérifications quotidiennes à 8h
  setTimeout(runDailyChecks, 5000);
  cron.schedule('0 8 * * *', runDailyChecks, { timezone: 'Europe/Paris' });

  // Sync VosFactures quotidienne à 6h
  cron.schedule('0 6 * * *', runVfSync, { timezone: 'Europe/Paris' });

  // Ping anti-veille toutes les 10 minutes
  cron.schedule('*/10 * * * *', pingKeepAlive);

  console.log('⏰ Tâches automatiques activées (8h checks, 6h VF sync, ping /10min)');
}

module.exports = { startCron, runDailyChecks, runVfSync };
