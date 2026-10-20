// server/commandes-tableur.js
// ─────────────────────────────────────────────────────────────────────────────
// « Test suivi commandes » : vue tableur (même principe que le fichier Excel de l'équipe).
// Lecture seule ici : les modifications passent par les routes existantes
// (POST /commandes, PUT /commandes/:id) pour garder tous les automatismes.
// ─────────────────────────────────────────────────────────────────────────────
module.exports = function monterCommandesTableur(router, { db, statutCommande }) {
  const CHAMPS = `cmd.id, cmd.client_id, cmd.annee_onglet, cmd.groupe, cmd.distributeur_nom, cmd.modele, cmd.accessoire,
    cmd.bdc, cmd.date_commande, cmd.vf_order_id, cmd.client_final, cmd.client_final_type, cmd.cf_adresse, cmd.cf_ville,
    cmd.num_suivi, cmd.transporteur, cmd.date_livraison, cmd.num_serie, cmd.docs_fre, cmd.num_facture, cmd.num_facture_pennylane,
    cmd.invoice_se, cmd.informations, cmd.statut, cmd.num_bordereau, cmd.facture_paiement_statut, cmd.proforma, cmd.proforma_payee,
    cmd.modele_demo, cmd.type_fauteuil_demo, cmd.num_commande_distrib, cmd.pays, cmd.updated_at,
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
};
