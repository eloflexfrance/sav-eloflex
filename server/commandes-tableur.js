// server/commandes-tableur.js
// ─────────────────────────────────────────────────────────────────────────────
// « Test suivi commandes » : vue tableur (même principe que le fichier Excel de l'équipe).
// Lecture seule ici : les modifications passent par les routes existantes
// (POST /commandes, PUT /commandes/:id) pour garder tous les automatismes.
// ─────────────────────────────────────────────────────────────────────────────
module.exports = function monterCommandesTableur(router, { db, statutCommande, sendBrevoMail, mailCharte, signatureSav }) {
  const CHAMPS = `cmd.id, cmd.client_id, cmd.annee_onglet, cmd.groupe, cmd.distributeur_nom, cmd.modele, cmd.accessoire,
    cmd.bdc, cmd.date_commande, cmd.vf_order_id, cmd.client_final, cmd.client_final_type, cmd.cf_adresse, cmd.cf_ville,
    cmd.num_suivi, cmd.transporteur, cmd.date_livraison, cmd.num_serie, cmd.docs_fre, cmd.num_facture, cmd.num_facture_pennylane,
    cmd.invoice_se, cmd.informations, cmd.statut, cmd.num_bordereau, cmd.facture_paiement_statut, cmd.proforma, cmd.proforma_payee,
    cmd.modele_demo, cmd.type_fauteuil_demo, cmd.demo_duree_mois,
    (SELECT COUNT(*) FROM documents_signes ds WHERE ds.objet='commande' AND ds.objet_id=cmd.id)::int AS nb_confirmations, cmd.demo_rappel_date, cmd.demo_suivi_resultat, cmd.num_commande_distrib, cmd.pays, cmd.updated_at,
    c.nom AS client_nom, c.edi AS client_edi, c.tel AS client_tel, c.portable AS client_portable, c.email AS client_email,
    TRIM(CONCAT_WS(' - ', NULLIF(c.adresse,''), NULLIF(TRIM(CONCAT_WS(' ', c.cp, c.ville)),''))) AS client_adresse,
    (SELECT COUNT(*) FROM commande_notes n WHERE n.commande_id=cmd.id)::int AS notes_count`;

  const filtrePays = (res, conds, p) => {
    const userPays = (res.locals.user && res.locals.user.pays) || null;
    if (userPays) { p.push(userPays); conds.push(`(cmd.pays=$${p.length} OR cmd.pays IS NULL)`); }
  };
  const avecStatut = r => ({ ...r, statut_calc: statutCommande(r) });

  // Années disponibles (onglets en bas, comme les feuilles du fichier Excel)
  router.get('/commandes-tableur/annees', async (req, res) => {
    try {
      const conds = [], p = []; filtrePays(res, conds, p);
      const rows = await db.all(`SELECT COALESCE(cmd.annee_onglet, EXTRACT(YEAR FROM NULLIF(cmd.date_commande,'')::date)::int) AS annee, COUNT(*)::int AS n
        FROM commandes cmd ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''} GROUP BY 1 ORDER BY 1 DESC NULLS LAST`, p);
      res.json(rows.filter(r => r.annee));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Une ligne (après modification)
  router.get('/commandes-tableur/ligne/:id', async (req, res) => {
    try {
      const r = await db.get(`SELECT ${CHAMPS} FROM commandes cmd LEFT JOIN clients c ON c.id=cmd.client_id WHERE cmd.id=$1`, [req.params.id]);
      if (!r) return res.status(404).json({ error: 'Commande introuvable' });
      res.json(avecStatut(r));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Toutes les lignes d'une année (sans pagination), ou seulement celles modifiées depuis ?depuis=ISO
  router.get('/commandes-tableur', async (req, res) => {
    try {
      const conds = [], p = [];
      filtrePays(res, conds, p);
      const annee = parseInt(req.query.annee) || new Date().getFullYear();
      p.push(annee);
      conds.push(`(cmd.annee_onglet=$${p.length} OR (cmd.annee_onglet IS NULL AND EXTRACT(YEAR FROM NULLIF(cmd.date_commande,'')::date)=$${p.length}))`);
      if (req.query.depuis) { p.push(req.query.depuis); conds.push(`cmd.updated_at > $${p.length}::timestamptz`); }
      const rows = await db.all(`SELECT ${CHAMPS} FROM commandes cmd LEFT JOIN clients c ON c.id=cmd.client_id
        WHERE ${conds.join(' AND ')} ORDER BY NULLIF(cmd.date_commande,'') ASC NULLS LAST, cmd.id ASC`, p);
      const maintenant = (await db.get('SELECT NOW() AS t')).t;
      res.json({ annee, maintenant, rows: rows.map(avecStatut) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Bon de commande Pennylane → distributeur, coordonnées, modèle / accessoires ──
  // Modèle : uniquement le(s) fauteuil(s) (neuf ou démo) ; Accessoires : les autres pièces « désignation xN » (frais exclus).
  router.get('/commandes-tableur/bdc', async (req, res) => {
    try {
      const numero = String(req.query.numero || '').trim();
      if (!numero) return res.status(400).json({ error: 'numero requis' });
      if (!(process.env.PENNYLANE_API_KEY || process.env.PENNYLANE_TOKEN)) return res.json({ configured: false });
      const { lookupDocumentPennylane } = require('../scripts/sync-pennylane');
      const { estFauteuil } = require('../scripts/stock-bl-pennylane');
      const r = await lookupDocumentPennylane(numero);
      if (!r || !r.found) return res.json({ configured: true, found: false, suggestions: (r && r.suggestions) || [] });
      const FRAIS = /frais|\bport\b|livraison|exp[ée]dition|transport|shipping|\benvoi\b|colissimo|chronopost|remise|offert/i;
      const chaise = l => estFauteuil(l.reference, l.designation) || /^\s*(fauteuil|scooter)/i.test(l.designation || '')
        || /eloflex\s+mod[eè]le|^\s*mod[eè]le\s+[a-z0-9+]{1,3}\b/i.test(l.designation || '');
      const lignes = (r.lignes || []).filter(l => (l.designation || '').trim());
      const fauteuils = lignes.filter(chaise), autres = lignes.filter(l => !chaise(l) && !FRAIS.test(l.designation || ''));
      const qte = l => ` x${parseInt(l.quantite) || 1}`;
      const modele = fauteuils.map(l => (l.designation || '').trim() + ((parseInt(l.quantite) || 1) > 1 ? qte(l) : '')).join(' + ');
      const accessoire = autres.map(l => (l.designation || '').trim() + qte(l)).join(', ');
      // Fiche distributeur de l'appli : par client Pennylane, sinon par nom
      let fiche = null;
      if (r.pl_customer_id) fiche = await db.get('SELECT id, nom FROM clients WHERE pl_customer_id=$1 ORDER BY id LIMIT 1', [String(r.pl_customer_id)]);
      if (!fiche && r.distributeur) fiche = await db.get('SELECT id, nom FROM clients WHERE LOWER(TRIM(nom))=LOWER(TRIM($1)) ORDER BY id LIMIT 1', [r.distributeur]);
      res.json({ configured: true, found: true, numero: r.numero, distributeur: r.distributeur, pl_customer_id: r.pl_customer_id,
        client: r.client || null, fiche, modele, accessoire, demo: !!(r.est_pret || r.modele_demo) && fauteuils.length > 0,
        fauteuil: fauteuils.length > 0, nb_lignes: lignes.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Complète la fiche distributeur avec les coordonnées Pennylane (uniquement les champs vides)
  router.post('/commandes-tableur/completer-fiche/:clientId', async (req, res) => {
    try {
      const b = req.body || {};
      const c = await db.get('SELECT id, email, tel, adresse, cp, ville, pl_customer_id FROM clients WHERE id=$1', [req.params.clientId]);
      if (!c) return res.status(404).json({ error: 'Fiche introuvable' });
      const sets = [], vals = [], faits = [];
      for (const k of ['email', 'tel', 'adresse', 'cp', 'ville', 'pl_customer_id']) {
        const v = String(b[k] || '').trim();
        if (v && !String(c[k] || '').trim()) { vals.push(v); sets.push(`${k}=$${vals.length}`); faits.push(k); }
      }
      if (sets.length) { vals.push(c.id); await db.run(`UPDATE clients SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$${vals.length}`, vals); }
      res.json({ ok: true, completes: faits });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Documents à envoyer (Docs FR) : notice du modèle + documents pour le transport aérien ──
  const lireAerien = async () => { const p = await db.get("SELECT valeur FROM parametres WHERE cle='docs_transport_aerien'"); try { const l = JSON.parse((p && p.valeur) || '[]'); return Array.isArray(l) ? l : []; } catch (_) { return []; } };
  router.get('/commandes-docs', async (req, res) => {
    try {
      const modeles = await db.all(`SELECT id, nom, lien_notice FROM eclates_modeles WHERE COALESCE(lien_notice,'')<>'' ORDER BY nom`).catch(() => []);
      res.json({ modeles, aerien: await lireAerien() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  router.put('/commandes-docs/aerien', async (req, res) => {
    try {
      const u = res.locals.user || {};
      if (u.role !== 'admin' && (u.permissions || {}).commandes !== 'write') return res.status(403).json({ error: 'Droits insuffisants' });
      const l = (Array.isArray((req.body || {}).docs) ? req.body.docs : []).map(d => ({ nom: String(d.nom || '').trim().slice(0, 120), url: String(d.url || '').trim().slice(0, 600) }))
        .filter(d => d.nom && /^https?:\/\//i.test(d.url)).slice(0, 30);
      await db.run(`INSERT INTO parametres (cle, valeur) VALUES ('docs_transport_aerien', $1) ON CONFLICT (cle) DO UPDATE SET valeur=EXCLUDED.valeur`, [JSON.stringify(l)]);
      res.json({ ok: true, aerien: l });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  router.post('/commandes/:id/envoyer-docs', async (req, res) => {
    try {
      const u = res.locals.user || {};
      if (u.role !== 'admin' && (u.permissions || {}).commandes !== 'write') return res.status(403).json({ error: 'Droits insuffisants' });
      const b = req.body || {};
      const cmd = await db.get(`SELECT cmd.id, cmd.bdc, cmd.distributeur_nom, cmd.modele, c.email AS client_email FROM commandes cmd LEFT JOIN clients c ON c.id=cmd.client_id WHERE cmd.id=$1`, [req.params.id]);
      if (!cmd) return res.status(404).json({ error: 'Commande introuvable' });
      const dest = String(b.email || cmd.client_email || '').split(/[,;\s]+/).filter(x => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)).slice(0, 5);
      if (!dest.length) return res.status(400).json({ error: 'Adresse e-mail du destinataire manquante' });
      const docs = (Array.isArray(b.docs) ? b.docs : []).map(d => ({ nom: String(d.nom || '').slice(0, 160), url: String(d.url || '') })).filter(d => d.nom && /^https?:\/\//i.test(d.url));
      if (!docs.length) return res.status(400).json({ error: 'Aucun document sélectionné' });
      const esc = x => String(x == null ? '' : x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      const liste = docs.map(d => `<li style="margin:6px 0"><a href="${esc(d.url)}" style="color:#1F5C8C;font-weight:600">${esc(d.nom)}</a></li>`).join('');
      await sendBrevoMail({
        from: 'sav@eloflex.fr', fromName: 'Eloflex France — SAV', to: dest.join(','),
        subject: `Eloflex — Documents${b.modele_nom ? ' ' + b.modele_nom : ''}${cmd.bdc ? ' — commande ' + cmd.bdc : ''}`,
        html: mailCharte({ titre: 'Eloflex — Documents du fauteuil', signature: signatureSav(),
          corps: `<p>Bonjour,</p><p>Veuillez trouver ci-dessous les documents${b.modele_nom ? ' du <b>' + esc(b.modele_nom) + '</b>' : ''}${cmd.bdc ? ' (commande <b>' + esc(cmd.bdc) + '</b>)' : ''} : notice d'utilisation et documents nécessaires au transport aérien.</p>
            <ul style="padding-left:18px">${liste}</ul>
            <p style="font-size:13px;color:#555">Pour un voyage en avion, nous vous conseillons d'imprimer ces documents et de les présenter à la compagnie aérienne lors de la réservation et à l'enregistrement.</p>
            <p>Restant à votre disposition.<br>Bien cordialement</p>` }),
      });
      await db.run(`UPDATE commandes SET docs_fre='Oui', updated_at=NOW() WHERE id=$1`, [cmd.id]);
      try { await db.run('INSERT INTO commande_notes (commande_id, user_id, user_nom, texte) VALUES ($1,$2,$3,$4)',
        [cmd.id, u.id || null, u.nom || null, `📄 Documents envoyés à ${dest.join(', ')} : ${docs.map(d => d.nom).join(', ')}`]); } catch (_) {}
      res.json({ ok: true, envoye_a: dest });
    } catch (e) { res.status(500).json({ error: (e.response && e.response.data && e.response.data.message) || e.message }); }
  });
};
