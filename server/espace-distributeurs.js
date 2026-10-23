// server/espace-distributeurs.js
// ─────────────────────────────────────────────────────────────────────────────
// Espace distributeurs : accès aux éclatés par lien magique envoyé par e-mail
// (adresse présente dans une fiche distributeur), avec demande de devis de pièces
// détachées (PDF généré dans le navigateur, envoyé à sav@ et info@, copie au distributeur).
//
// Un distributeur connecté reçoit une session « distributeur » : il ne voit QUE les éclatés
// (liste blanche stricte des routes dans routes.js), avec les prix distributeur HT.
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const path = require('path');

const VALIDITE_LIEN_H = 48;
const DEST_INTERNES = 'sav@eloflex.fr, info@eloflex.fr';
const emailOk = v => /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(String(v || '').trim());
const escH = x => String(x == null ? '' : x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const eur = v => (Math.round((parseFloat(v) || 0) * 100) / 100).toFixed(2).replace('.', ',') + ' €';

async function ensureTables(db) {
  await db.run(`CREATE TABLE IF NOT EXISTS espace_liens (
    token TEXT PRIMARY KEY, client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE, email TEXT,
    expires_at TIMESTAMPTZ, used_at TIMESTAMPTZ, ip TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await db.run(`CREATE TABLE IF NOT EXISTS espace_commandes (
    id SERIAL PRIMARY KEY, client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL, email TEXT,
    numero TEXT, reference TEXT, adresse_livraison TEXT, commentaire TEXT, lignes JSONB,
    total_ht NUMERIC, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await db.run(`ALTER TABLE espace_liens ADD COLUMN IF NOT EXISTS langue TEXT`);
  await db.run(`CREATE TABLE IF NOT EXISTS espace_demandes (
    id SERIAL PRIMARY KEY, email TEXT, societe TEXT, nom TEXT, tel TEXT, langue TEXT,
    client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL, statut TEXT DEFAULT 'attente',
    ip TEXT, nb INTEGER DEFAULT 1, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
    traite_at TIMESTAMPTZ, traite_par TEXT)`);
}

const LANGUES = ['fr', 'en', 'sv'];
const lgOk = v => LANGUES.includes(String(v || '').toLowerCase()) ? String(v).toLowerCase() : 'fr';
const LG_NOM = { fr: 'Français', en: 'Anglais', sv: 'Suédois' };
// Textes du mail « lien de connexion » envoyé au distributeur, dans sa langue
const MAIL_LIEN = {
  fr: { sujet: 'Eloflex — Votre accès à l’espace distributeur', titre: 'Eloflex — Espace distributeur', bonjour: 'Bonjour,',
    intro: n => `Voici votre lien d'accès personnel à l'<b>espace distributeur Eloflex</b> (${n}) : vous y retrouvez les <b>éclatés</b> de nos fauteuils avec les références des pièces détachées, et vous pouvez préparer votre <b>demande de devis</b> de pièces en quelques clics.`,
    bouton: 'Accéder à l’espace distributeur',
    validite: (h, l) => `Ce lien est personnel et valable ${h} heures ; votre connexion reste ensuite active 7 jours sur cet appareil. Si le bouton ne fonctionne pas, copiez ce lien :<br>${l}`,
    pasVous: 'Vous n’êtes pas à l’origine de cette demande ? Ignorez simplement cet e-mail.', fin: 'Restant à votre disposition.<br>Bien cordialement' },
  en: { sujet: 'Eloflex — Your access to the dealer area', titre: 'Eloflex — Dealer area', bonjour: 'Hello,',
    intro: n => `Here is your personal access link to the <b>Eloflex dealer area</b> (${n}): you will find the <b>exploded views</b> of our wheelchairs with the spare part numbers, and you can prepare your spare parts <b>quote request</b> in a few clicks.`,
    bouton: 'Open the dealer area',
    validite: (h, l) => `This link is personal and valid for ${h} hours; you then stay signed in for 7 days on this device. If the button does not work, copy this link:<br>${l}`,
    pasVous: 'Did not request this? Simply ignore this e-mail.', fin: 'Kind regards' },
  sv: { sujet: 'Eloflex — Din åtkomst till återförsäljarportalen', titre: 'Eloflex — Återförsäljarportal', bonjour: 'Hej,',
    intro: n => `Här är din personliga länk till <b>Eloflex återförsäljarportal</b> (${n}): där hittar du <b>sprängskisserna</b> för våra rullstolar med reservdelarnas artikelnummer, och du kan skapa din <b>offertförfrågan</b> på reservdelar med några klick.`,
    bouton: 'Öppna återförsäljarportalen',
    validite: (h, l) => `Länken är personlig och giltig i ${h} timmar; därefter förblir du inloggad i 7 dagar på den här enheten. Om knappen inte fungerar, kopiera den här länken:<br>${l}`,
    pasVous: 'Har du inte begärt detta? Ignorera bara det här e-postmeddelandet.', fin: 'Med vänliga hälsningar' },
};

// Fiches distributeur dont le champ e-mail contient cette adresse (le champ peut en lister plusieurs)
async function clientsParEmail(db, email) {
  return db.all(`SELECT c.id, c.nom, c.email, c.tel, c.portable, c.adresse, c.cp, c.ville
    FROM clients c
    WHERE EXISTS (SELECT 1 FROM regexp_split_to_table(LOWER(COALESCE(c.email,'')), '[,;[:space:]]+') e WHERE e = LOWER($1))
    ORDER BY (SELECT COUNT(*) FROM commandes cmd WHERE cmd.client_id=c.id) DESC, c.id`, [String(email).trim()]);
}

// Session « distributeur » : jamais d'id utilisateur, seulement le module Éclatés en lecture
function sessionDistributeur(c, email, langue) {
  const lg = lgOk(langue);
  return {
    id: null, role: 'distributeur', nom: c.nom, email, langue: lg === 'fr' ? 'fr' : 'en', langue_eclates: lg, pays: null,
    permissions: { eclates: 'read' },
    distributeur: { client_id: c.id, nom: c.nom },
  };
}

// Routes de l'application (hors /api) : page de connexion et consommation du lien magique
function monterPages(app, db) {
  app.get('/espace', (req, res) => {
    if (req.session && req.session.user && req.session.user.role === 'distributeur') return res.redirect('/');
    res.sendFile(path.join(__dirname, '..', 'public', 'espace.html'));
  });
  app.get('/espace/connexion/:token', async (req, res) => {
    try {
      await ensureTables(db);
      const l = await db.get(`SELECT l.*, c.nom FROM espace_liens l JOIN clients c ON c.id=l.client_id
        WHERE l.token=$1 AND l.expires_at > NOW()`, [String(req.params.token)]);
      if (!l) return res.redirect('/espace?erreur=lien');
      await db.run('UPDATE espace_liens SET used_at=COALESCE(used_at, NOW()) WHERE token=$1', [l.token]);
      req.session.user = sessionDistributeur({ id: l.client_id, nom: l.nom }, l.email, l.langue);
      req.session.save(() => res.redirect('/'));
    } catch (e) { res.redirect('/espace?erreur=serveur'); }
  });
}

// Routes /api/espace/*
function monterApi(router, deps) {
  const { db, sendBrevoMail, mailCharte, mailRecap, signatureSav, addAlerte, requireAuth } = deps;

  async function envoyerLien(c, email, base, ip, langue, opts = {}) {
    await ensureTables(db);
    const lg = lgOk(langue), M = MAIL_LIEN[lg];
    const token = crypto.randomBytes(24).toString('hex');
    await db.run(`INSERT INTO espace_liens (token, client_id, email, expires_at, ip, langue) VALUES ($1,$2,$3,NOW() + INTERVAL '${VALIDITE_LIEN_H} hours',$4,$5)`,
      [token, c.id, email.toLowerCase(), ip || null, lg]);
    const lien = `${base}/espace/connexion/${token}`;
    if (opts.sansMail) return lien;   // lien à transmettre à la main (mail bloqué chez le destinataire)
    await sendBrevoMail({
      from: 'sav@eloflex.fr', fromName: 'Eloflex France', to: email,
      subject: M.sujet,
      html: mailCharte({
        titre: M.titre,
        corps: `<p>${M.bonjour}</p>
          <p>${M.intro(escH(c.nom))}</p>
          <p style="text-align:center;margin:22px 0"><a href="${lien}" style="background:#1F5C8C;color:#fff;text-decoration:none;padding:11px 22px;border-radius:6px;font-weight:600">${M.bouton}</a></p>
          <p style="font-size:12px;color:#666">${M.validite(VALIDITE_LIEN_H, lien)}</p>
          <p style="font-size:12px;color:#666">${M.pasVous}</p>
          <p>${M.fin}</p>`,
        signature: signatureSav(),
      }),
    });
    return lien;
  }

  const baseUrl = req => process.env.APP_URL || (req.protocol + '://' + req.get('host'));
  const ipDe = req => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  const interneOk = u => u && u.role !== 'distributeur' && (u.role === 'admin' || ['write'].includes((u.permissions || {}).clients) || ['write'].includes((u.permissions || {}).commandes));

  // Mail à sav@ à chaque demande d'accès (adresse connue ou non)
  async function notifierSav(d, fiche, auto, base) {
    const lienValider = `${base}/?espace_demande=${d.id}`;
    const recap = mailRecap([
      ['Adresse e-mail', `<b>${escH(d.email)}</b>`],
      ['Société indiquée', escH(d.societe || '—')],
      ['Nom indiqué', escH(d.nom || '—')],
      ['Téléphone', escH(d.tel || '—')],
      ['Langue choisie', LG_NOM[lgOk(d.langue)]],
      ['Fiche distributeur', fiche ? `<b>${escH(fiche.nom)}</b> (adresse présente dans la fiche)` : '<span style="color:#b45309"><b>Aucune fiche</b> ne contient cette adresse</span>'],
    ]);
    const corps = auto
      ? `<p>Bonjour,</p><p>Une demande d'accès à l'<b>espace distributeur</b> vient d'être faite. L'adresse est enregistrée dans la fiche <b>${escH(fiche.nom)}</b> : <b>le lien de connexion lui a été envoyé automatiquement</b>.</p>${recap}
         <p style="font-size:13px;color:#555">Si le distributeur ne reçoit pas l'e-mail (courrier indésirable, quarantaine de sa messagerie), <a href="${lienValider}">ouvrez la demande dans l'application</a> → « Obtenir un lien à transmettre », et envoyez-lui ce lien vous-même.</p>
         <p style="font-size:13px;color:#555">Si cette personne ne doit pas avoir accès, retirez son adresse de la fiche distributeur : elle ne pourra plus recevoir de lien.</p>`
      : `<p>Bonjour,</p><p>Une demande d'accès à l'<b>espace distributeur</b> est <b>en attente de validation</b>.</p>${recap}
         <p>Pour valider, rattachez l'adresse à la bonne fiche distributeur : le lien de connexion lui sera alors envoyé dans sa langue.</p>
         <p style="text-align:center;margin:22px 0"><a href="${lienValider}" style="background:#1F5C8C;color:#fff;text-decoration:none;padding:11px 22px;border-radius:6px;font-weight:600">Valider ou refuser l'accès</a></p>
         <p style="font-size:12px;color:#666">La demande est aussi visible dans l'application : Clients / Distributeurs → « Demandes d'accès ».</p>`;
    await sendBrevoMail({
      from: 'sav@eloflex.fr', fromName: 'Eloflex — Espace distributeur', to: 'sav@eloflex.fr',
      subject: `Espace distributeur — demande d'accès ${auto ? '(lien envoyé)' : 'à valider'} : ${d.societe || (fiche && fiche.nom) || d.email}`,
      html: mailCharte({ titre: 'Eloflex — Demande d’accès espace distributeur', corps: corps + '<p>Bien cordialement</p>', signature: signatureSav() }),
    });
  }

  // Demande de lien (publique) : réponse identique que l'adresse soit connue ou non
  router.post('/espace/lien', async (req, res) => {
    try {
      const body = req.body || {};
      const email = String(body.email || '').trim().toLowerCase();
      if (!emailOk(email)) return res.status(400).json({ error: 'email' });
      const actif = await db.get("SELECT valeur FROM parametres WHERE cle='espace_distributeurs_actif'");
      if (actif && actif.valeur === '0') return res.status(403).json({ error: 'ferme' });
      await ensureTables(db);
      const recents = await db.get(`SELECT COUNT(*)::int AS n FROM espace_liens WHERE email=$1 AND created_at > NOW() - INTERVAL '1 hour'`, [email]);
      const recentsD = await db.get(`SELECT COALESCE(SUM(nb),0)::int AS n FROM espace_demandes WHERE email=$1 AND updated_at > NOW() - INTERVAL '1 hour'`, [email]);
      if (recents.n >= 5 || recentsD.n >= 5) return res.json({ ok: true });   // anti-abus silencieux
      const langue = lgOk(body.langue);
      const champ = (k, n) => String(body[k] || '').trim().slice(0, n) || null;
      const societe = champ('societe', 120), nom = champ('nom', 120), tel = champ('tel', 40);
      const base = baseUrl(req), ip = ipDe(req);
      const cls = await clientsParEmail(db, email);
      const pAuto = await db.get("SELECT valeur FROM parametres WHERE cle='espace_lien_auto'");
      const auto = cls.length > 0 && !(pAuto && pAuto.valeur === '0');
      if (auto) await envoyerLien(cls[0], email, base, ip, langue);
      // Une demande « en cours » par adresse : regroupée sur 24 h pour ne pas inonder sav@
      const statut = auto ? 'auto' : 'attente';
      const prec = await db.get(`SELECT * FROM espace_demandes WHERE email=$1 AND statut=$2 AND created_at > NOW() - INTERVAL '24 hours' ORDER BY id DESC LIMIT 1`, [email, statut]);
      let d;
      if (prec) {
        d = (await db.run(`UPDATE espace_demandes SET societe=COALESCE($2,societe), nom=COALESCE($3,nom), tel=COALESCE($4,tel), langue=$5, nb=nb+1, updated_at=NOW() WHERE id=$1 RETURNING *`,
          [prec.id, societe, nom, tel, langue]));
      } else {
        d = (await db.run(`INSERT INTO espace_demandes (email, societe, nom, tel, langue, client_id, statut, ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [email, societe, nom, tel, langue, cls[0] ? cls[0].id : null, statut, ip || null]));
        try { await notifierSav(d, cls[0] || null, auto, base); } catch (e) { console.error('[espace] mail sav@', e.message); }
        if (!auto) { try { await addAlerte('espace_acces', d.id, `🔑 Demande d'accès à l'espace distributeur : ${d.societe || d.email} (${d.email}) — à valider dans Clients / Distributeurs.`); } catch (_) {} }
      }
      res.json({ ok: true });
    } catch (e) { console.error('[espace] lien', e.message); res.status(500).json({ error: 'serveur' }); }
  });

  // ── Demandes d'accès : liste, validation (rattachement à une fiche + envoi du lien), refus ──
  router.get('/espace/demandes', requireAuth, async (req, res) => {
    try {
      const u = res.locals.user || {};
      if (u.role === 'distributeur') return res.status(403).json({ error: 'Accès refusé' });
      await ensureTables(db);
      const st = String(req.query.statut || 'attente');
      const rows = await db.all(`SELECT d.*, c.nom AS client_nom FROM espace_demandes d LEFT JOIN clients c ON c.id=d.client_id
        ${st === 'tous' ? '' : 'WHERE d.statut=$1'} ORDER BY d.created_at DESC LIMIT 200`, st === 'tous' ? [] : [st]);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  router.get('/espace/demandes/:id', requireAuth, async (req, res) => {
    try {
      const u = res.locals.user || {};
      if (u.role === 'distributeur') return res.status(403).json({ error: 'Accès refusé' });
      await ensureTables(db);
      const d = await db.get(`SELECT d.*, c.nom AS client_nom FROM espace_demandes d LEFT JOIN clients c ON c.id=d.client_id WHERE d.id=$1`, [req.params.id]);
      if (!d) return res.status(404).json({ error: 'Demande introuvable' });
      res.json(d);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  router.post('/espace/demandes/:id/valider', requireAuth, async (req, res) => {
    try {
      const u = res.locals.user || {};
      if (!interneOk(u)) return res.status(403).json({ error: 'Droits insuffisants (écriture sur Clients requise)' });
      await ensureTables(db);
      const d = await db.get('SELECT * FROM espace_demandes WHERE id=$1', [req.params.id]);
      if (!d) return res.status(404).json({ error: 'Demande introuvable' });
      const c = await db.get('SELECT id, nom, email FROM clients WHERE id=$1', [parseInt((req.body || {}).client_id)]);
      if (!c) return res.status(400).json({ error: 'Choisissez la fiche distributeur à laquelle rattacher cette adresse' });
      const dejaLa = (await clientsParEmail(db, d.email)).some(x => x.id === c.id);
      if (!dejaLa) await db.run(`UPDATE clients SET email = CASE WHEN COALESCE(TRIM(email),'')='' THEN $2 ELSE TRIM(email) || ', ' || $2 END WHERE id=$1`, [c.id, d.email]);
      const lien = await envoyerLien(c, d.email, baseUrl(req), null, d.langue);
      const ids = (await db.all(`UPDATE espace_demandes SET statut='validee', client_id=$2, traite_at=NOW(), traite_par=$3
        WHERE id=$1 OR (email=$4 AND statut='attente') RETURNING id`, [d.id, c.id, u.nom || u.email || null, d.email])).map(x => x.id);
      try { await db.run(`UPDATE alertes SET lue=TRUE WHERE type='espace_acces' AND reference_id = ANY($1::int[])`, [ids]); } catch (_) {}
      res.json({ ok: true, email: d.email, client: c.nom, ajoute: !dejaLa, lien, validite_h: VALIDITE_LIEN_H });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Nouveau lien de connexion SANS e-mail (à transmettre soi-même si le mail n'arrive pas)
  router.post('/espace/demandes/:id/lien', requireAuth, async (req, res) => {
    try {
      const u = res.locals.user || {};
      if (!interneOk(u)) return res.status(403).json({ error: 'Droits insuffisants (écriture sur Clients requise)' });
      await ensureTables(db);
      const d = await db.get('SELECT * FROM espace_demandes WHERE id=$1', [req.params.id]);
      if (!d) return res.status(404).json({ error: 'Demande introuvable' });
      const c = (await clientsParEmail(db, d.email))[0];
      if (!c) return res.status(400).json({ error: 'Cette adresse ne figure plus dans aucune fiche distributeur : validez d’abord la demande.' });
      const lien = await envoyerLien(c, d.email, baseUrl(req), null, d.langue, { sansMail: true });
      res.json({ ok: true, email: d.email, client: c.nom, lien, validite_h: VALIDITE_LIEN_H });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  router.post('/espace/demandes/:id/refuser', requireAuth, async (req, res) => {
    try {
      const u = res.locals.user || {};
      if (!interneOk(u)) return res.status(403).json({ error: 'Droits insuffisants (écriture sur Clients requise)' });
      await ensureTables(db);
      const d = await db.get('SELECT * FROM espace_demandes WHERE id=$1', [req.params.id]);
      if (!d) return res.status(404).json({ error: 'Demande introuvable' });
      const ids = (await db.all(`UPDATE espace_demandes SET statut='refusee', traite_at=NOW(), traite_par=$2
        WHERE email=$1 AND statut='attente' RETURNING id`, [d.email, u.nom || u.email || null])).map(x => x.id);
      try { await db.run(`UPDATE alertes SET lue=TRUE WHERE type='espace_acces' AND reference_id = ANY($1::int[])`, [ids]); } catch (_) {}
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Invitation envoyée depuis l'appli (fiche distributeur)
  router.post('/espace/inviter/:clientId', requireAuth, async (req, res) => {
    try {
      const u = res.locals.user || {};
      if (u.role === 'distributeur') return res.status(403).json({ error: 'Accès refusé' });
      const c = await db.get('SELECT id, nom, email FROM clients WHERE id=$1', [req.params.clientId]);
      if (!c) return res.status(404).json({ error: 'Fiche introuvable' });
      const email = String((req.body && req.body.email) || '').trim().toLowerCase();
      if (!emailOk(email)) return res.status(400).json({ error: 'Adresse e-mail invalide' });
      const dansFiche = (await clientsParEmail(db, email)).some(x => x.id === c.id);
      if (!dansFiche) return res.status(400).json({ error: 'Cette adresse ne figure pas dans la fiche distributeur : ajoutez-la d’abord dans la fiche.' });
      const base = process.env.APP_URL || (req.protocol + '://' + req.get('host'));
      const lien = await envoyerLien(c, email, base, null, (req.body || {}).langue);
      res.json({ ok: true, email, lien, validite_h: VALIDITE_LIEN_H });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Coordonnées du distributeur connecté (pré-remplissage de la demande de devis)
  router.get('/espace/moi', async (req, res) => {
    try {
      const u = res.locals.user || {};
      if (u.role !== 'distributeur') return res.json({ interne: true, email: u.email || null, nom: u.nom || null });
      const c = await db.get('SELECT id, nom, email, tel, portable, adresse, adresse2, cp, ville FROM clients WHERE id=$1', [u.distributeur.client_id]);
      res.json({ client: c, email: u.email });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Envoi d'une demande de devis : e-mail à sav@ + info@ (copie au distributeur) avec le PDF
  router.post('/espace/bon-commande', async (req, res) => {
    try {
      const u = res.locals.user || {};
      // Distributeur connecté, ou utilisateur de l'appli (ex. compte en anglais « éclatés uniquement ») : demande pour son compte
      const interne = u.role !== 'distributeur';
      const b = req.body || {};
      const lignes = (Array.isArray(b.lignes) ? b.lignes : []).map(l => ({
        ref: String(l.ref || '').slice(0, 60), designation: String(l.designation || '').slice(0, 250), modele: String(l.modele || '').slice(0, 80),
        qte: Math.max(1, Math.min(999, parseInt(l.qte) || 1)), pu: l.pu == null || l.pu === '' ? null : Math.round(parseFloat(l.pu) * 100) / 100,
      })).filter(l => l.ref || l.designation);
      // Photos jointes (JPEG réduits dans le navigateur) : 8 max, ~8 Mo au total
      let totalPh = 0;
      const photos = (Array.isArray(b.photos) ? b.photos : []).slice(0, 8)
        .map((ph, i) => ({ name: `${String(b.numero || 'demande').replace(/[^\w\-]+/g, '_')}_photo${i + 1}.jpg`, content: String((ph && ph.data) || '').replace(/^data:[^,]+,/, '') }))
        .filter(ph => /^[A-Za-z0-9+/=\s]+$/.test(ph.content) && ph.content.length > 100)
        .filter(ph => (totalPh += ph.content.length) <= 11 * 1024 * 1024);
      if (!lignes.length && !String(b.commentaire || '').trim() && !photos.length) return res.status(400).json({ error: 'La demande de devis est vide' });
      if (!b.pdf || !b.pdf.data) return res.status(400).json({ error: 'PDF manquant' });
      await ensureTables(db);
      const c = interne
        ? { id: null, nom: String(b.distributeur || '').trim().slice(0, 120) || u.nom || u.email || 'Utilisateur', email: u.email }
        : await db.get('SELECT id, nom, email FROM clients WHERE id=$1', [u.distributeur.client_id]);
      const totalHT = lignes.reduce((s, l) => s + (l.pu != null ? l.pu * l.qte : 0), 0);
      const numero = String(b.numero || '').slice(0, 40) || ('DDV-WEB-' + Date.now());
      const rec = await db.run(`INSERT INTO espace_commandes (client_id, email, numero, reference, adresse_livraison, commentaire, lignes, total_ht)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [c.id, u.email, numero, String(b.reference || '').slice(0, 80) || null, String(b.adresse || '').slice(0, 500) || null,
         String(b.commentaire || '').slice(0, 2000) || null, JSON.stringify(lignes), totalHT]);
      const tableau = `<table role="presentation" style="width:100%;border-collapse:collapse;margin:8px 0 16px;font-size:13px">
        <tr style="background:#f1f5f9"><th style="padding:6px 8px;border:1px solid #e5e7eb;text-align:left">Réf.</th><th style="padding:6px 8px;border:1px solid #e5e7eb;text-align:left">Désignation</th><th style="padding:6px 8px;border:1px solid #e5e7eb">Qté</th><th style="padding:6px 8px;border:1px solid #e5e7eb;text-align:right">Total HT</th></tr>
        ${lignes.length ? '' : '<tr><td colspan="4" style="padding:8px;border:1px solid #e5e7eb;font-style:italic;color:#666">Aucune pièce sélectionnée : voir les informations complémentaires.</td></tr>'}${lignes.map(l => `<tr><td style="padding:6px 8px;border:1px solid #e5e7eb;font-family:monospace">${escH(l.ref)}</td><td style="padding:6px 8px;border:1px solid #e5e7eb">${escH(l.designation)}${l.modele ? `<br><span style="color:#888;font-size:11px">${escH(l.modele)}</span>` : ''}</td><td style="padding:6px 8px;border:1px solid #e5e7eb;text-align:center">${l.qte}</td><td style="padding:6px 8px;border:1px solid #e5e7eb;text-align:right;white-space:nowrap">${l.pu != null ? eur(l.pu * l.qte) : 'sur devis'}</td></tr>`).join('')}
        ${lignes.some(l => l.pu != null) ? `<tr><td colspan="3" style="padding:6px 8px;border:1px solid #e5e7eb;text-align:right;font-weight:700">Total HT indicatif (hors port)</td><td style="padding:6px 8px;border:1px solid #e5e7eb;text-align:right;font-weight:700;white-space:nowrap">${eur(totalHT)}</td></tr>` : ''}</table>`;
      const recap = mailRecap([
        ['N° de demande', `<b>${escH(numero)}</b>`],
        [interne ? 'Demandeur' : 'Distributeur', `<b>${escH(c.nom)}</b>${interne ? ` <span style="color:#888">(compte ${escH(u.nom || '')} — ${escH(u.email || '')})</span>` : ''}`],
        ['Votre référence', escH(b.reference || '')],
        ['Adresse de livraison', escH(b.adresse || '').replace(/\n/g, '<br>')],
        ['Informations complémentaires', `<b>${escH(b.commentaire || '').replace(/\n/g, '<br>')}</b>`],
        ...(photos.length ? [['Photos jointes', `<b>${photos.length}</b> photo(s) en pièce jointe (et dans le PDF)`]] : []),
      ]);
      const ccDistrib = emailOk(u.email) ? u.email : null;
      await sendBrevoMail({
        from: 'sav@eloflex.fr', fromName: 'Eloflex France — SAV',
        to: DEST_INTERNES, cc: ccDistrib || undefined,
        subject: `Demande de devis pièces détachées ${numero} — ${c.nom}`,
        html: mailCharte({
          titre: 'Eloflex — Demande de devis pièces détachées',
          corps: `<p>Bonjour,</p>
            <p>Une demande de devis de pièces détachées vient d'être transmise depuis ${interne ? 'la page <b>Éclatés</b> de l’application' : 'l’<b>espace distributeur</b>'}. Le PDF est joint à cet e-mail.</p>
            ${recap}${tableau}
            <p style="font-size:13px;color:#555">${ccDistrib ? `Le distributeur est en copie (${escH(ccDistrib)}). ` : ''}Eloflex établit le devis définitif (frais de port et délai compris).</p>
            <p>Bien cordialement</p>`,
          signature: signatureSav(),
        }),
        attachments: [{ name: String(b.pdf.nom || numero + '.pdf').replace(/[^\w.\-]+/g, '_'), content: String(b.pdf.data).replace(/^data:[^,]+,/, '') }, ...photos],
      });
      try { await addAlerte('bdc_espace', rec.id, `🧾 Demande de devis pièces ${numero} reçue de ${c.nom} via ${interne ? 'les éclatés' : "l'espace distributeur"} (${lignes.length} ligne(s)${photos.length ? `, ${photos.length} photo(s)` : ''}, ${eur(totalHT)} HT indicatif) : devis à établir.`); } catch (_) {}
      res.json({ ok: true, numero, id: rec.id });
    } catch (e) {
      const msg = (e.response && e.response.data && (e.response.data.message || JSON.stringify(e.response.data))) || e.message;
      res.status(500).json({ error: msg });
    }
  });
}

// Liste blanche des routes /api accessibles à une session « distributeur »
function routeAutoriseeDistributeur(method, p) {
  if (method === 'GET') {
    return /^\/eclates(\/\d+(\/photo|\/pages\/\d+)?|\/par-ref\/[^/]+)?$/.test(p) || p === '/espace/moi' || p === '/auth/me';
  }
  if (method === 'POST') return p === '/espace/bon-commande' || p === '/auth/logout';
  return false;
}

module.exports = { monterPages, monterApi, routeAutoriseeDistributeur, ensureTables, clientsParEmail };
