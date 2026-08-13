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
       AND i.updated_at IS NOT NULL
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
         AND i.envoi_date ~ '^\d{4}-\d{2}-\d{2}$'
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
         AND f.date_achat ~ '^\d{4}-\d{2}-\d{2}$'
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

    // 5. Fauteuils de démonstration arrivés à échéance de rappel (J+30, dépôt-vente)
    const demosDues = await db.all(
      `SELECT cmd.id, cmd.distributeur_nom, cmd.modele, cmd.num_serie, cmd.demo_rappel_date,
              c.nom AS client_nom
       FROM commandes cmd LEFT JOIN clients c ON c.id=cmd.client_id
       WHERE cmd.demo_rappel_date IS NOT NULL AND cmd.demo_suivi_resultat IS NULL
         AND cmd.demo_rappel_date <= to_char(NOW(),'YYYY-MM-DD')`
    );
    for (const d of demosDues) {
      await addAlerte('demo_rappel', d.id,
        `🔄 Démo à suivre : ${d.client_nom || d.distributeur_nom} — ${d.modele || ''} ${d.num_serie || ''} (rappel du ${d.demo_rappel_date}). Organiser le retour, prolonger ou facturer.`);
    }
    if (demosDues.length) await envoyerEmailDemos(demosDues);

    // 6. Bons de prêt : relance automatique 3 semaines (21 j) après la date de remise
    let pretsDus = [];
    try {
      pretsDus = await db.all(
        `SELECT p.id, p.distributeur_nom, p.email, p.designation, p.num_serie, p.date_remise,
                p.date_retour_prevue, c.nom AS client_nom, c.email AS client_email
         FROM prets p LEFT JOIN clients c ON c.id=p.client_id
         WHERE p.date_remise IS NOT NULL AND p.rappel_envoye = FALSE
           AND p.statut IN ('envoye','signe','en_cours','prolonge','retard')
           AND p.date_remise + INTERVAL '21 days' <= NOW()`
      );
      for (const p of pretsDus) {
        await addAlerte('pret_rappel', p.id,
          `📄 Prêt à relancer : ${p.client_nom || p.distributeur_nom} — ${p.designation || ''} ${p.num_serie || ''} (remis le ${p.date_remise}). 3 semaines écoulées : relancer le distributeur.`);
        await db.run("UPDATE prets SET rappel_envoye=TRUE, statut=CASE WHEN statut='signe' THEN 'en_cours' ELSE statut END, updated_at=NOW() WHERE id=$1", [p.id]);
      }
      if (pretsDus.length) await envoyerEmailPretsRappel(pretsDus);
    } catch (e) { console.error('[CRON] prêts :', e.message); }

    if (enAttente.length + expSansRetour.length + expirent.length + demosDues.length + pretsDus.length > 0)
      console.log(`[CRON] ${new Date().toISOString()} — ${enAttente.length} relance(s), ${expSansRetour.length} retour(s) manquant(s), ${expirent.length} garantie(s), ${demosDues.length} démo(s), ${pretsDus.length} prêt(s)`);

  } catch(e) { console.error('[CRON] Erreur :', e.message); }
}

// Email de relance des bons de prêt (au distributeur + copie interne)
async function envoyerEmailPretsRappel(prets) {
  try {
    const p = {}; const rows = await db.all('SELECT cle,valeur FROM parametres'); rows.forEach(r => p[r.cle] = r.valeur);
    if (p.email_notifications !== '1') return;
    const key = process.env.BREVO_API_KEY;
    if (!key) { console.warn('[CRON] BREVO_API_KEY manquante — relance prêts non envoyée'); return; }
    const axios = require('axios');
    for (const pr of prets) {
      const dest = pr.email || pr.client_email;
      if (!dest) continue;
      await axios.post('https://api.brevo.com/v3/smtp/email', {
        sender: { name: 'Eloflex France', email: p.email_from || 'sav@eloflex.fr' },
        to: [{ email: dest }], cc: [{ email: p.email_cc_sav || 'sav@eloflex.fr' }],
        subject: `Eloflex — Suivi de votre prêt de fauteuil (${pr.designation || ''} ${pr.num_serie || ''})`,
        htmlContent: `<div style="font-family:sans-serif;max-width:560px;color:#222;margin:0 auto">
          <p>Bonjour,</p>
          <p>Votre prêt du fauteuil <b>${pr.designation || ''} ${pr.num_serie || ''}</b> (remis le ${pr.date_remise}) arrive à 3 semaines.</p>
          <p>Pourriez-vous nous indiquer où en est l'essai${pr.date_retour_prevue ? ` (retour prévu le ${pr.date_retour_prevue})` : ''} : retour à organiser, prolongation souhaitée, ou rachat ?</p>
          <p style="font-size:12px;color:#888">Eloflex France</p></div>`
      }, { headers: { 'api-key': key, 'Content-Type': 'application/json' }, timeout: 60000 });
    }
    console.log(`[CRON] Email relance prêts (Brevo) envoyé (${prets.length})`);
  } catch (e) { console.error('[CRON] Email prêts err:', e.message); }
}

// Email de rappel des démos à suivre (si notifications email activées)
async function envoyerEmailDemos(demos) {
  try {
    const p = {}; const rows = await db.all('SELECT cle,valeur FROM parametres'); rows.forEach(r => p[r.cle] = r.valeur);
    if (p.email_notifications !== '1') return;
    if (!p.email_smtp_host || !p.email_smtp_user || !p.email_smtp_pass) return;
    const dest = p.email_cc_relance || p.email_from || p.email_smtp_user;
    if (!dest) return;
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: p.email_smtp_host, port: parseInt(p.email_smtp_port) || 587, secure: false,
      auth: { user: p.email_smtp_user, pass: p.email_smtp_pass }
    });
    const lignes = demos.map(d => `<li>${d.client_nom || d.distributeur_nom} — ${d.modele || ''} ${d.num_serie || ''} (rappel du ${d.demo_rappel_date})</li>`).join('');
    const url = process.env.APP_URL || '';
    await transporter.sendMail({
      from: p.email_from || p.email_smtp_user, to: dest,
      subject: `🔄 ${demos.length} fauteuil(s) de démo à suivre`,
      html: `<p>${demos.length} fauteuil(s) de démonstration arrivent à échéance de rappel (J+30) :</p><ul>${lignes}</ul>
             <p>Pour chacun : <b>organiser le retour</b>, <b>prolonger</b> le rappel, ou <b>facturer</b>.</p>
             ${url ? `<p><a href="${url}">Ouvrir l'application → Alertes</a></p>` : ''}`
    });
    console.log(`[CRON] Email démos envoyé (${demos.length})`);
  } catch (e) { console.error('[CRON] Email démos err:', e.message); }
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
