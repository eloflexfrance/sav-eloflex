// server/cron.js — tâches automatiques quotidiennes (PostgreSQL)
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

async function runDailyChecks() {
  try {
    const relanceJours = parseInt(await param('relance_jours') || '7');
    const now = new Date();

    // 1. Relances interventions sans mise à jour
    const enAttente = await db.all(
      `SELECT i.*,c.nom AS client_nom,f.modele,f.serie FROM interventions i
       JOIN fauteuils f ON f.id=i.fauteuil_id JOIN clients c ON c.id=i.client_id
       WHERE i.statut IN ('Ouvert','En attente') AND i.relance_envoyee=false
       AND NOW()-i.updated_at >= ($1 || ' days')::INTERVAL`,
      [relanceJours]
    );
    for (const i of enAttente) {
      const jours = Math.floor((now - new Date(i.updated_at)) / 86400000);
      await addAlerte('relance', i.id, `⏰ Intervention #${i.id} (${i.client_nom} — ${i.modele}) sans mise à jour depuis ${jours} jours`);
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
      await addAlerte('garantie_expire', f.id, `🔔 Garantie du fauteuil ${f.modele} (${f.serie}) — ${f.client_nom} expire dans ${j} jour${j>1?'s':''}`);
    }

    // 4. Stock faible / rupture
    const stockFaible = await db.all('SELECT * FROM catalogue WHERE stock<=stock_alerte AND stock>0');
    for (const p of stockFaible)
      await addAlerte('stock_faible', p.id, `⚠️ Stock faible : ${p.designation} (${p.stock} restant${p.stock!==1?'s':''} / seuil ${p.stock_alerte})`);

    const stockZero = await db.all('SELECT * FROM catalogue WHERE stock=0');
    for (const p of stockZero)
      await addAlerte('stock_zero', p.id, `🔴 Rupture de stock : ${p.designation} (${p.ref})`);

    if (enAttente.length + expSansRetour.length + expirent.length > 0)
      console.log(`[CRON] ${new Date().toISOString()} — ${enAttente.length} relance(s), ${expSansRetour.length} retour(s) manquant(s), ${expirent.length} garantie(s) expirant bientôt`);

  } catch (e) {
    console.error('[CRON] Erreur :', e.message);
  }
}

function startCron() {
  setTimeout(runDailyChecks, 5000);
  cron.schedule('0 8 * * *', runDailyChecks, { timezone: 'Europe/Paris' });
  console.log('⏰ Tâches automatiques activées (8h Paris)');
}

module.exports = { startCron, runDailyChecks };
