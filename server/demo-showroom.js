// ── Parc de démo : unités « Showroom » (Paris) + dates de prêt souhaitées par modèle ──
// Showroom : démos présentes à Paris, non destinées au départ aux distributeurs
// (on garde la possibilité de les prêter) ; elles peuvent aussi être vendues.
// Prêt souhaité : date à laquelle un modèle est demandé, avec mail de rappel
// (sav@eloflex.fr par défaut, adresse modifiable).
let DEPS = null;
let _pret = null;

const EMAIL_DEFAUT = 'sav@eloflex.fr';
const esc = x => String(x == null ? '' : x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const fr = iso => iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '';
const emailsOk = s => String(s || '').split(/[,;\s]+/).filter(Boolean).every(e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));

async function assurerSchema(db) {
  if (!_pret) _pret = (async () => {
    await db.run(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS demo_showroom BOOLEAN DEFAULT FALSE`);
    await db.run(`CREATE TABLE IF NOT EXISTS demo_prets_souhaites (
      id SERIAL PRIMARY KEY,
      modele TEXT NOT NULL,
      date_souhaitee TEXT NOT NULL,
      date_rappel TEXT,
      pour_qui TEXT,
      note TEXT,
      email TEXT,
      rappel_envoye_at TIMESTAMPTZ,
      cree_par TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW())`);
  })().catch(e => { _pret = null; throw e; });
  return _pret;
}

async function emailDefaut(db) {
  const r = await db.get("SELECT valeur FROM parametres WHERE cle='email_pret_souhaite'");
  return (r && String(r.valeur || '').trim()) || EMAIL_DEFAUT;
}

module.exports = function monter(router, deps) {
  DEPS = deps;
  const { db } = deps;
  assurerSchema(db).catch(e => console.error('[SHOWROOM] schéma :', e.message));

  // Mettre / retirer une unité de démo du showroom de Paris
  router.post('/commandes/:id/demo-showroom', async (req, res) => {
    try {
      await assurerSchema(db);
      const on = !!req.body.showroom;
      // Au showroom = l'unité est chez Éloflex France (Paris) : on la considère revenue.
      const row = on
        ? await db.run(`UPDATE commandes SET demo_showroom=TRUE, demo_rappel_date=NULL,
              demo_suivi_resultat=CASE WHEN demo_suivi_resultat IS NULL THEN 'retour' ELSE demo_suivi_resultat END,
              demo_retour_date=COALESCE(demo_retour_date, CASE WHEN demo_suivi_resultat IS NULL THEN to_char(NOW(),'YYYY-MM-DD') END),
              updated_at=NOW() WHERE id=$1 AND modele_demo=TRUE RETURNING id, demo_showroom, demo_suivi_resultat`, [req.params.id])
        : await db.run(`UPDATE commandes SET demo_showroom=FALSE, updated_at=NOW() WHERE id=$1 RETURNING id, demo_showroom`, [req.params.id]);
      if (!row) return res.status(404).json({ error: 'Démo introuvable' });
      res.json({ ok: true, ...row });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Dates de prêt souhaitées
  router.get('/commandes-demo-souhaits', async (req, res) => {
    try {
      await assurerSchema(db);
      const rows = await db.all(`SELECT * FROM demo_prets_souhaites ORDER BY date_souhaitee ASC, id ASC`);
      res.json({ souhaits: rows, email_defaut: await emailDefaut(db) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  const lire = (b) => {
    const modele = String(b.modele || '').trim();
    const date = String(b.date_souhaitee || '').slice(0, 10);
    let rappel = String(b.date_rappel || '').slice(0, 10);
    const email = String(b.email || '').trim();
    if (!modele) throw new Error('Modèle manquant');
    if (!ISO.test(date)) throw new Error('Date de prêt souhaitée invalide');
    if (rappel && !ISO.test(rappel)) throw new Error('Date de rappel invalide');
    if (!rappel) rappel = date;
    if (rappel > date) throw new Error('Le rappel doit être avant (ou le jour de) la date souhaitée');
    if (!email || !emailsOk(email)) throw new Error('Adresse e-mail de rappel invalide');
    return { modele, date, rappel, email, pour: String(b.pour_qui || '').trim() || null, note: String(b.note || '').trim() || null };
  };
  const majDefaut = async (b, email) => {
    if (!b.email_par_defaut) return;
    const ex = await db.get("SELECT cle FROM parametres WHERE cle='email_pret_souhaite'");
    if (ex) await db.run("UPDATE parametres SET valeur=$1 WHERE cle='email_pret_souhaite'", [email]);
    else await db.run("INSERT INTO parametres (cle, valeur) VALUES ('email_pret_souhaite', $1)", [email]);
  };

  router.post('/commandes-demo-souhaits', async (req, res) => {
    try {
      await assurerSchema(db);
      const v = lire(req.body || {});
      const u = res.locals.user || {};
      const row = await db.run(`INSERT INTO demo_prets_souhaites (modele, date_souhaitee, date_rappel, pour_qui, note, email, cree_par)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [v.modele, v.date, v.rappel, v.pour, v.note, v.email, u.nom || u.email || null]);
      await majDefaut(req.body, v.email);
      res.json({ ok: true, souhait: row });
    } catch (e) { res.status(/invalide|manquant|avant/i.test(e.message) ? 400 : 500).json({ error: e.message }); }
  });

  router.put('/commandes-demo-souhaits/:id', async (req, res) => {
    try {
      await assurerSchema(db);
      const v = lire(req.body || {});
      const ex = await db.get('SELECT * FROM demo_prets_souhaites WHERE id=$1', [req.params.id]);
      if (!ex) return res.status(404).json({ error: 'Introuvable' });
      // Date de rappel modifiée → le rappel repart (sera renvoyé à la nouvelle date)
      const relance = ex.date_rappel !== v.rappel || ex.email !== v.email;
      const row = await db.run(`UPDATE demo_prets_souhaites SET modele=$1, date_souhaitee=$2, date_rappel=$3, pour_qui=$4, note=$5, email=$6,
          rappel_envoye_at=CASE WHEN $7 THEN NULL ELSE rappel_envoye_at END, updated_at=NOW() WHERE id=$8 RETURNING *`,
        [v.modele, v.date, v.rappel, v.pour, v.note, v.email, relance, req.params.id]);
      await majDefaut(req.body, v.email);
      res.json({ ok: true, souhait: row });
    } catch (e) { res.status(/invalide|manquant|avant/i.test(e.message) ? 400 : 500).json({ error: e.message }); }
  });

  router.delete('/commandes-demo-souhaits/:id', async (req, res) => {
    try {
      await assurerSchema(db);
      await db.run('DELETE FROM demo_prets_souhaites WHERE id=$1', [req.params.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};

// Rappels à envoyer (appelé par le cron) : date de rappel atteinte, pas encore envoyé.
module.exports.envoyerRappelsPretsSouhaites = async function () {
  if (!DEPS) return { envoyes: 0 };
  const { db, sendBrevoMail, mailCharte, signatureSav } = DEPS;
  await assurerSchema(db);
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
  const rows = await db.all(`SELECT * FROM demo_prets_souhaites WHERE rappel_envoye_at IS NULL AND date_rappel <= $1 ORDER BY date_souhaitee`, [today]);
  if (!rows.length || !process.env.BREVO_API_KEY) return { envoyes: 0 };
  const p = await db.get("SELECT valeur FROM parametres WHERE cle='app_url'");
  const url = ((p && p.valeur) || process.env.APP_URL || '').replace(/\/$/, '');
  let envoyes = 0;
  for (const s of rows) {
    try {
      const jours = Math.round((new Date(s.date_souhaitee + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000);
      const quand = jours > 1 ? `dans ${jours} jours` : jours === 1 ? 'demain' : jours === 0 ? "aujourd'hui" : `il y a ${-jours} jour(s)`;
      await sendBrevoMail({
        from: 'sav@eloflex.fr', fromName: 'Eloflex France — SAV', to: s.email || EMAIL_DEFAUT,
        subject: `Rappel prêt démo — ${s.modele} souhaité le ${fr(s.date_souhaitee)}${s.pour_qui ? ' (' + s.pour_qui + ')' : ''}`,
        html: mailCharte({ titre: 'Rappel — prêt de démonstration', signature: signatureSav(),
          corps: `<p>Bonjour,</p>
            <p>Un prêt de démonstration du <b>${esc(s.modele)}</b> est souhaité le <b>${fr(s.date_souhaitee)}</b> (${quand})${s.pour_qui ? ' pour <b>' + esc(s.pour_qui) + '</b>' : ''}.</p>
            ${s.note ? `<p style="background:#f5f7fa;border-left:3px solid #1F5C8C;padding:8px 12px">${esc(s.note).replace(/\n/g, '<br>')}</p>` : ''}
            <p>Pensez à vérifier la disponibilité d'une unité (Disponibles ou Showroom) et à organiser l'envoi.</p>
            ${url ? `<p><a href="${url}/#parc-demo" style="color:#1F5C8C;font-weight:600">Ouvrir le Parc de démo</a></p>` : ''}` }),
      });
      await db.run('UPDATE demo_prets_souhaites SET rappel_envoye_at=NOW() WHERE id=$1', [s.id]);
      envoyes++;
    } catch (e) { console.error('[PRÊT SOUHAITÉ] rappel #' + s.id + ' :', e.message); }
  }
  return { envoyes };
};
