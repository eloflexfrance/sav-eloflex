// server/stock-transferts.js
// ─────────────────────────────────────────────────────────────────────────────
// Transferts de stock Lagord → Paris : bon de transfert imprimable + mise à jour du stock Paris.
//
// Rappel du modèle de stock (voir server/inventaires.js) :
//   catalogue.stock = total VosFactures (Lagord + Paris) ; Paris = catalogue_emplacements ;
//   Lagord = total − Paris. Un transfert ne change donc rien dans VosFactures (entrepôt unique) :
//   seule la quantité Paris de l'appli augmente.
//
// Cycle : création (= envoi) → la quantité envoyée passe à Paris ;
//         réception à Paris → on saisit les quantités reçues, l'écart est corrigé
//         (un manquant repasse dans Lagord ; s'il est perdu, l'inventaire de Lagord le régularisera) ;
//         suppression d'un transfert non réceptionné → la quantité revient à Lagord.
// ─────────────────────────────────────────────────────────────────────────────
const { ensureTables } = require('./inventaires');

const ADR_LAGORD = 'Éloflex France\n41 rue des Maraichers\n17140 LAGORD';
let _ok = false;
async function assurer(db) {
  await ensureTables(db);
  if (_ok) return;
  await db.run(`CREATE TABLE IF NOT EXISTS stock_transferts (
    id SERIAL PRIMARY KEY, numero TEXT UNIQUE, origine TEXT NOT NULL DEFAULT 'lagord', destination TEXT NOT NULL DEFAULT 'paris',
    date_envoi TEXT, transporteur TEXT, num_suivi TEXT, nb_colis INTEGER, notes TEXT,
    adresse_origine TEXT, adresse_destination TEXT, contact_destination TEXT,
    statut TEXT NOT NULL DEFAULT 'envoye', cree_par TEXT, created_at TIMESTAMPTZ DEFAULT NOW(),
    recu_le TEXT, recu_par TEXT, observations TEXT)`);
  await db.run(`CREATE TABLE IF NOT EXISTS stock_transferts_lignes (
    id SERIAL PRIMARY KEY, transfert_id INTEGER REFERENCES stock_transferts(id) ON DELETE CASCADE,
    catalogue_id INTEGER, ref TEXT, designation TEXT, qte_envoyee INTEGER NOT NULL, qte_recue INTEGER, colis TEXT, pu NUMERIC)`);
  _ok = true;
}

async function param(db, cle, defaut) {
  const r = await db.get('SELECT valeur FROM parametres WHERE cle=$1', [cle]);
  return (r && r.valeur != null && String(r.valeur).trim() !== '') ? r.valeur : defaut;
}
async function setParam(db, cle, valeur) {
  if (valeur == null) return;
  const ex = await db.get('SELECT cle FROM parametres WHERE cle=$1', [cle]);
  if (ex) await db.run('UPDATE parametres SET valeur=$1 WHERE cle=$2', [valeur, cle]);
  else await db.run('INSERT INTO parametres (cle, valeur) VALUES ($1,$2)', [cle, valeur]);
}
const ajouterParis = (pg, cid, delta) => pg.query(
  `INSERT INTO catalogue_emplacements (catalogue_id, emplacement, quantite) VALUES ($1,'paris',GREATEST(0,$2::int))
   ON CONFLICT (catalogue_id, emplacement) DO UPDATE SET quantite=GREATEST(0, catalogue_emplacements.quantite + $2::int), updated_at=NOW()`, [cid, delta]);

module.exports = function monterTransferts(router, { db }) {
  const nomU = u => (u && (u.nom || u.email)) || null;

  // Liste + adresses mémorisées
  router.get('/inventaires-transferts', async (req, res) => {
    try {
      await assurer(db);
      const rows = await db.all(`SELECT t.*, (SELECT COUNT(*)::int FROM stock_transferts_lignes l WHERE l.transfert_id=t.id) AS nb_refs,
          (SELECT COALESCE(SUM(qte_envoyee),0)::int FROM stock_transferts_lignes l WHERE l.transfert_id=t.id) AS nb_pieces,
          (SELECT COUNT(*)::int FROM stock_transferts_lignes l WHERE l.transfert_id=t.id AND l.qte_recue IS NOT NULL AND l.qte_recue<>l.qte_envoyee) AS nb_ecarts
        FROM stock_transferts t ORDER BY t.created_at DESC, t.id DESC LIMIT 300`);
      res.json({ transferts: rows, adresses: {
        lagord: await param(db, 'transfert_adresse_lagord', ADR_LAGORD),
        paris: await param(db, 'transfert_adresse_paris', 'Éloflex France — Paris\n'),
        contact_paris: await param(db, 'transfert_contact_paris', ''),
      } });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Pièces transférables : stock Lagord / Paris de chaque pièce suivie en stock
  router.get('/inventaires-transferts-pieces', async (req, res) => {
    try {
      await assurer(db);
      const rows = await db.all(`SELECT c.id, c.ref, c.designation, c.prix_achat_suede AS pu, COALESCE(c.stock,0)::int AS total,
          COALESCE((SELECT quantite FROM catalogue_emplacements e WHERE e.catalogue_id=c.id AND e.emplacement='paris'),0)::int AS paris
        FROM catalogue c WHERE COALESCE(c.stock_actif, TRUE) AND NOT COALESCE(c.en_sommeil, FALSE)
        ORDER BY c.ref`);
      res.json(rows.map(r => ({ ...r, lagord: r.total - r.paris })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/inventaires-transferts/:id', async (req, res) => {
    try {
      await assurer(db);
      const t = await db.get('SELECT * FROM stock_transferts WHERE id=$1', [req.params.id]);
      if (!t) return res.status(404).json({ error: 'Transfert introuvable' });
      t.lignes = await db.all('SELECT * FROM stock_transferts_lignes WHERE transfert_id=$1 ORDER BY id', [t.id]);
      res.json(t);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Création = envoi : les quantités passent de Lagord à Paris dans l'appli
  router.post('/inventaires-transferts', async (req, res) => {
    const b = req.body || {};
    try {
      await assurer(db);
      const brutes = (Array.isArray(b.lignes) ? b.lignes : []).map(l => ({ cid: parseInt(l.catalogue_id), qte: parseInt(l.qte), colis: String(l.colis || '').trim() || null }))
        .filter(l => l.cid && l.qte > 0);
      if (!brutes.length) return res.status(400).json({ error: 'Aucune pièce à transférer' });
      // Regroupe une même pièce saisie deux fois
      const parId = new Map();
      brutes.forEach(l => { const x = parId.get(l.cid); if (x) x.qte += l.qte; else parId.set(l.cid, { ...l }); });
      const lignes = [...parId.values()];
      const pieces = await db.all(`SELECT c.id, c.ref, c.designation, c.prix_achat_suede AS pu, COALESCE(c.stock,0)::int AS total,
          COALESCE((SELECT quantite FROM catalogue_emplacements e WHERE e.catalogue_id=c.id AND e.emplacement='paris'),0)::int AS paris
        FROM catalogue c WHERE c.id = ANY($1::int[])`, [lignes.map(l => l.cid)]);
      const P = new Map(pieces.map(p => [p.id, p]));
      const trop = lignes.filter(l => !P.has(l.cid) || l.qte > (P.get(l.cid).total - P.get(l.cid).paris));
      if (trop.length && !b.forcer) {
        return res.status(409).json({ error: 'Quantité supérieure au stock Lagord pour : ' + trop.map(l => {
          const p = P.get(l.cid); return p ? `${p.ref} (demandé ${l.qte}, Lagord ${p.total - p.paris})` : `#${l.cid}`; }).join(', '), trop: true });
      }
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(b.date_envoi || '')) ? b.date_envoi : new Date().toISOString().slice(0, 10);
      const pref = `BT-${date.slice(0, 7)}-`;
      const pg = await db.pool.connect();
      try {
        await pg.query('BEGIN');
        await pg.query('LOCK TABLE stock_transferts IN SHARE ROW EXCLUSIVE MODE');
        const { rows: [n] } = await pg.query(`SELECT COALESCE(MAX(NULLIF(regexp_replace(numero, '^.*-', ''), '')::int), 0) + 1 AS n FROM stock_transferts WHERE numero LIKE $1`, [pref + '%']);
        const numero = pref + String(n.n).padStart(2, '0');
        const { rows: [t] } = await pg.query(`INSERT INTO stock_transferts (numero, date_envoi, transporteur, num_suivi, nb_colis, notes, adresse_origine, adresse_destination, contact_destination, cree_par)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [numero, date, String(b.transporteur || '').trim() || null, String(b.num_suivi || '').trim() || null, parseInt(b.nb_colis) || null,
           String(b.notes || '').trim() || null, String(b.adresse_origine || '').trim() || ADR_LAGORD, String(b.adresse_destination || '').trim() || null,
           String(b.contact_destination || '').trim() || null, nomU(res.locals.user)]);
        for (const l of lignes) {
          const p = P.get(l.cid); if (!p) continue;
          await pg.query(`INSERT INTO stock_transferts_lignes (transfert_id, catalogue_id, ref, designation, qte_envoyee, colis, pu) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [t.id, l.cid, p.ref, p.designation, l.qte, l.colis, p.pu]);
          await ajouterParis(pg, l.cid, l.qte);
        }
        await pg.query('COMMIT');
        // Adresses mémorisées pour les prochains bons
        await setParam(db, 'transfert_adresse_lagord', String(b.adresse_origine || '').trim() || null);
        await setParam(db, 'transfert_adresse_paris', String(b.adresse_destination || '').trim() || null);
        await setParam(db, 'transfert_contact_paris', b.contact_destination != null ? String(b.contact_destination).trim() : null);
        res.json({ ok: true, id: t.id, numero });
      } catch (e) { await pg.query('ROLLBACK').catch(() => {}); throw e; }
      finally { pg.release(); }
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Mise à jour des infos d'en-tête (transport, suivi, notes) sans toucher au stock
  router.put('/inventaires-transferts/:id', async (req, res) => {
    try {
      await assurer(db);
      const b = req.body || {};
      const r = await db.run(`UPDATE stock_transferts SET transporteur=$1, num_suivi=$2, nb_colis=$3, notes=$4, contact_destination=$5 WHERE id=$6 RETURNING id`,
        [String(b.transporteur || '').trim() || null, String(b.num_suivi || '').trim() || null, parseInt(b.nb_colis) || null,
         String(b.notes || '').trim() || null, String(b.contact_destination || '').trim() || null, req.params.id]);
      if (!r) return res.status(404).json({ error: 'Transfert introuvable' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Réception à Paris : quantités réellement reçues → correction de l'écart
  router.post('/inventaires-transferts/:id/reception', async (req, res) => {
    try {
      await assurer(db);
      const t = await db.get('SELECT * FROM stock_transferts WHERE id=$1', [req.params.id]);
      if (!t) return res.status(404).json({ error: 'Transfert introuvable' });
      if (t.statut === 'recu') return res.status(409).json({ error: 'Ce transfert est déjà réceptionné' });
      const recu = new Map((req.body.lignes || []).map(l => [parseInt(l.id), parseInt(l.qte_recue)]));
      const lignes = await db.all('SELECT * FROM stock_transferts_lignes WHERE transfert_id=$1', [t.id]);
      const pg = await db.pool.connect();
      let ecarts = 0;
      try {
        await pg.query('BEGIN');
        for (const l of lignes) {
          let q = recu.has(l.id) ? recu.get(l.id) : l.qte_envoyee;
          if (!(q >= 0)) q = l.qte_envoyee;
          const diff = q - l.qte_envoyee;
          if (diff) { ecarts++; if (l.catalogue_id) await ajouterParis(pg, l.catalogue_id, diff); }
          await pg.query('UPDATE stock_transferts_lignes SET qte_recue=$1 WHERE id=$2', [q, l.id]);
        }
        const jour = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.date || '')) ? req.body.date : new Date().toISOString().slice(0, 10);
        await pg.query(`UPDATE stock_transferts SET statut='recu', recu_le=$1, recu_par=$2, observations=$3 WHERE id=$4`,
          [jour, nomU(res.locals.user), String(req.body.observations || '').trim() || null, t.id]);
        await pg.query('COMMIT');
      } catch (e) { await pg.query('ROLLBACK').catch(() => {}); throw e; }
      finally { pg.release(); }
      res.json({ ok: true, ecarts });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Suppression d'un transfert non réceptionné : les quantités reviennent à Lagord
  router.delete('/inventaires-transferts/:id', async (req, res) => {
    try {
      await assurer(db);
      const t = await db.get('SELECT * FROM stock_transferts WHERE id=$1', [req.params.id]);
      if (!t) return res.status(404).json({ error: 'Transfert introuvable' });
      if (t.statut === 'recu') return res.status(409).json({ error: 'Transfert déjà réceptionné : il ne peut plus être supprimé (faites un inventaire de Paris pour corriger).' });
      const lignes = await db.all('SELECT * FROM stock_transferts_lignes WHERE transfert_id=$1', [t.id]);
      const pg = await db.pool.connect();
      try {
        await pg.query('BEGIN');
        for (const l of lignes) if (l.catalogue_id) await ajouterParis(pg, l.catalogue_id, -l.qte_envoyee);
        await pg.query('DELETE FROM stock_transferts WHERE id=$1', [t.id]);
        await pg.query('COMMIT');
      } catch (e) { await pg.query('ROLLBACK').catch(() => {}); throw e; }
      finally { pg.release(); }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
