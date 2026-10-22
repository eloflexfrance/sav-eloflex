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
}

// Fiches distributeur dont le champ e-mail contient cette adresse (le champ peut en lister plusieurs)
async function clientsParEmail(db, email) {
  return db.all(`SELECT c.id, c.nom, c.email, c.tel, c.portable, c.adresse, c.cp, c.ville
    FROM clients c
    WHERE EXISTS (SELECT 1 FROM regexp_split_to_table(LOWER(COALESCE(c.email,'')), '[,;[:space:]]+') e WHERE e = LOWER($1))
    ORDER BY (SELECT COUNT(*) FROM commandes cmd WHERE cmd.client_id=c.id) DESC, c.id`, [String(email).trim()]);
}

// Session « distributeur » : jamais d'id utilisateur, seulement le module Éclatés en lecture
function sessionDistributeur(c, email) {
  return {
    id: null, role: 'distributeur', nom: c.nom, email, langue: 'fr', pays: null,
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
      req.session.user = sessionDistributeur({ id: l.client_id, nom: l.nom }, l.email);
      req.session.save(() => res.redirect('/'));
    } catch (e) { res.redirect('/espace?erreur=serveur'); }
  });
}

// Routes /api/espace/*
function monterApi(router, deps) {
  const { db, sendBrevoMail, mailCharte, mailRecap, signatureSav, addAlerte, requireAuth } = deps;

  async function envoyerLien(c, email, base, ip) {
    await ensureTables(db);
    const token = crypto.randomBytes(24).toString('hex');
    await db.run(`INSERT INTO espace_liens (token, client_id, email, expires_at, ip) VALUES ($1,$2,$3,NOW() + INTERVAL '${VALIDITE_LIEN_H} hours',$4)`,
      [token, c.id, email.toLowerCase(), ip || null]);
    const lien = `${base}/espace/connexion/${token}`;
    await sendBrevoMail({
      from: 'sav@eloflex.fr', fromName: 'Eloflex France', to: email,
      subject: 'Eloflex — Votre accès à l’espace distributeur',
      html: mailCharte({
        titre: 'Eloflex — Espace distributeur',
        corps: `<p>Bonjour,</p>
          <p>Voici votre lien d'accès personnel à l'<b>espace distributeur Eloflex</b> (${escH(c.nom)}) : vous y retrouvez les <b>éclatés</b> de nos fauteuils avec les références des pièces détachées, et vous pouvez préparer votre <b>demande de devis</b> de pièces en quelques clics.</p>
          <p style="text-align:center;margin:22px 0"><a href="${lien}" style="background:#1F5C8C;color:#fff;text-decoration:none;padding:11px 22px;border-radius:6px;font-weight:600">Accéder à l'espace distributeur</a></p>
          <p style="font-size:12px;color:#666">Ce lien est personnel et valable ${VALIDITE_LIEN_H} heures ; votre connexion reste ensuite active 7 jours sur cet appareil. Si le bouton ne fonctionne pas, copiez ce lien :<br>${lien}</p>
          <p style="font-size:12px;color:#666">Vous n'êtes pas à l'origine de cette demande ? Ignorez simplement cet e-mail.</p>
          <p>Restant à votre disposition.<br>Bien cordialement</p>`,
        signature: signatureSav(),
      }),
    });
  }

  // Demande de lien (publique) : réponse identique que l'adresse soit connue ou non
  router.post('/espace/lien', async (req, res) => {
    try {
      const email = String((req.body && req.body.email) || '').trim().toLowerCase();
      if (!emailOk(email)) return res.status(400).json({ error: 'Adresse e-mail invalide' });
      const actif = await db.get("SELECT valeur FROM parametres WHERE cle='espace_distributeurs_actif'");
      if (actif && actif.valeur === '0') return res.status(403).json({ error: 'L’espace distributeur est momentanément fermé.' });
      await ensureTables(db);
      const recents = await db.get(`SELECT COUNT(*)::int AS n FROM espace_liens WHERE email=$1 AND created_at > NOW() - INTERVAL '1 hour'`, [email]);
      if (recents.n >= 5) return res.json({ ok: true });   // anti-abus silencieux
      const cls = await clientsParEmail(db, email);
      if (cls.length) {
        const base = process.env.APP_URL || (req.protocol + '://' + req.get('host'));
        const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
        await envoyerLien(cls[0], email, base, ip);
      }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Envoi impossible pour le moment, réessayez plus tard.' }); }
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
      await envoyerLien(c, email, base, null);
      res.json({ ok: true, email });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Coordonnées du distributeur connecté (pré-remplissage de la demande de devis)
  router.get('/espace/moi', async (req, res) => {
    try {
      const u = res.locals.user || {};
      if (u.role !== 'distributeur') return res.json({ interne: true });
      const c = await db.get('SELECT id, nom, email, tel, portable, adresse, adresse2, cp, ville FROM clients WHERE id=$1', [u.distributeur.client_id]);
      res.json({ client: c, email: u.email });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Envoi d'une demande de devis : e-mail à sav@ + info@ (copie au distributeur) avec le PDF
  router.post('/espace/bon-commande', async (req, res) => {
    try {
      const u = res.locals.user || {};
      if (u.role !== 'distributeur') return res.status(403).json({ error: 'Réservé aux distributeurs connectés' });
      const b = req.body || {};
      const lignes = (Array.isArray(b.lignes) ? b.lignes : []).map(l => ({
        ref: String(l.ref || '').slice(0, 60), designation: String(l.designation || '').slice(0, 250), modele: String(l.modele || '').slice(0, 80),
        qte: Math.max(1, Math.min(999, parseInt(l.qte) || 1)), pu: l.pu == null || l.pu === '' ? null : Math.round(parseFloat(l.pu) * 100) / 100,
      })).filter(l => l.ref || l.designation);
      if (!lignes.length && !String(b.commentaire || '').trim()) return res.status(400).json({ error: 'La demande de devis est vide' });
      if (!b.pdf || !b.pdf.data) return res.status(400).json({ error: 'PDF manquant' });
      await ensureTables(db);
      const c = await db.get('SELECT id, nom, email FROM clients WHERE id=$1', [u.distributeur.client_id]);
      const totalHT = lignes.reduce((s, l) => s + (l.pu != null ? l.pu * l.qte : 0), 0);
      const numero = String(b.numero || '').slice(0, 40) || ('DDV-WEB-' + Date.now());
      const rec = await db.run(`INSERT INTO espace_commandes (client_id, email, numero, reference, adresse_livraison, commentaire, lignes, total_ht)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [c.id, u.email, numero, String(b.reference || '').slice(0, 80) || null, String(b.adresse || '').slice(0, 500) || null,
         String(b.commentaire || '').slice(0, 2000) || null, JSON.stringify(lignes), totalHT]);
      const tableau = `<table role="presentation" style="width:100%;border-collapse:collapse;margin:8px 0 16px;font-size:13px">
        <tr style="background:#f1f5f9"><th style="padding:6px 8px;border:1px solid #e5e7eb;text-align:left">Réf.</th><th style="padding:6px 8px;border:1px solid #e5e7eb;text-align:left">Désignation</th><th style="padding:6px 8px;border:1px solid #e5e7eb">Qté</th><th style="padding:6px 8px;border:1px solid #e5e7eb;text-align:right">Total HT</th></tr>
        ${lignes.length ? '' : '<tr><td colspan="4" style="padding:8px;border:1px solid #e5e7eb;font-style:italic;color:#666">Aucune pièce sélectionnée : voir les informations complémentaires.</td></tr>'}${lignes.map(l => `<tr><td style="padding:6px 8px;border:1px solid #e5e7eb;font-family:monospace">${escH(l.ref)}</td><td style="padding:6px 8px;border:1px solid #e5e7eb">${escH(l.designation)}${l.modele ? `<br><span style="color:#888;font-size:11px">${escH(l.modele)}</span>` : ''}</td><td style="padding:6px 8px;border:1px solid #e5e7eb;text-align:center">${l.qte}</td><td style="padding:6px 8px;border:1px solid #e5e7eb;text-align:right;white-space:nowrap">${l.pu != null ? eur(l.pu * l.qte) : 'sur devis'}</td></tr>`).join('')}
        <tr><td colspan="3" style="padding:6px 8px;border:1px solid #e5e7eb;text-align:right;font-weight:700">Total HT indicatif (hors port)</td><td style="padding:6px 8px;border:1px solid #e5e7eb;text-align:right;font-weight:700;white-space:nowrap">${eur(totalHT)}</td></tr></table>`;
      const recap = mailRecap([
        ['N° de demande', `<b>${escH(numero)}</b>`],
        ['Distributeur', `<b>${escH(c.nom)}</b>`],
        ['Votre référence', escH(b.reference || '')],
        ['Adresse de livraison', escH(b.adresse || '').replace(/\n/g, '<br>')],
        ['Informations complémentaires', `<b>${escH(b.commentaire || '').replace(/\n/g, '<br>')}</b>`],
      ]);
      const ccDistrib = emailOk(u.email) ? u.email : null;
      await sendBrevoMail({
        from: 'sav@eloflex.fr', fromName: 'Eloflex France — SAV',
        to: DEST_INTERNES, cc: ccDistrib || undefined,
        subject: `Demande de devis pièces détachées ${numero} — ${c.nom}`,
        html: mailCharte({
          titre: 'Eloflex — Demande de devis pièces détachées',
          corps: `<p>Bonjour,</p>
            <p>Une demande de devis de pièces détachées vient d'être transmise depuis l'<b>espace distributeur</b>. Le PDF est joint à cet e-mail.</p>
            ${recap}${tableau}
            <p style="font-size:13px;color:#555">${ccDistrib ? `Le distributeur est en copie (${escH(ccDistrib)}). ` : ''}Eloflex établit le devis définitif (frais de port et délai compris).</p>
            <p>Bien cordialement</p>`,
          signature: signatureSav(),
        }),
        attachments: [{ name: String(b.pdf.nom || numero + '.pdf').replace(/[^\w.\-]+/g, '_'), content: String(b.pdf.data).replace(/^data:[^,]+,/, '') }],
      });
      try { await addAlerte('bdc_espace', rec.id, `🧾 Demande de devis pièces ${numero} reçue de ${c.nom} via l'espace distributeur (${lignes.length} ligne(s), ${eur(totalHT)} HT indicatif) : devis à établir.`); } catch (_) {}
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
