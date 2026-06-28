// server/routes.js v2 — PostgreSQL
const express  = require('express');
const crypto   = require('crypto');
const XLSX     = require('xlsx');
const db       = require('./db');
const { upload, makeThumb, deleteFiles } = require('./uploads');
const router   = express.Router();

// ── Helpers ────────────────────────────────────────────────────────
async function param(cle) {
  const r = await db.get('SELECT valeur FROM parametres WHERE cle=$1', [cle]);
  return r ? r.valeur : null;
}

function garantieActive(dateAchat, dureeMois) {
  if (!dateAchat || !dureeMois) return null;
  const exp = new Date(dateAchat);
  exp.setMonth(exp.getMonth() + dureeMois);
  return new Date() <= exp;
}

async function logHistorique(id, auteur, champ, anc, nouv) {
  if (String(anc) === String(nouv)) return;
  await db.run(
    'INSERT INTO intervention_historique (intervention_id,auteur,champ,ancienne_valeur,nouvelle_valeur) VALUES ($1,$2,$3,$4,$5)',
    [id, auteur || 'Système', champ, String(anc ?? ''), String(nouv ?? '')]
  );
}

async function addAlerte(type, refId, message) {
  await db.run('INSERT INTO alertes (type,reference_id,message) VALUES ($1,$2,$3)', [type, refId, message]);
}

// Renumérotation des placeholders $1,$2... selon offset
function renum(sql, offset = 0) {
  let i = offset;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function getInterventions(f = {}) {
  let sql = `SELECT i.*, f.modele, f.serie, f.num_facture, f.date_achat, f.duree_garantie_mois, c.nom AS client_nom,
    (SELECT COUNT(*) FROM intervention_photos p WHERE p.intervention_id=i.id)::int AS nb_photos,
    (SELECT COUNT(*) FROM intervention_commentaires cm WHERE cm.intervention_id=i.id)::int AS nb_commentaires
    FROM interventions i
    JOIN fauteuils f ON f.id=i.fauteuil_id
    JOIN clients c ON c.id=i.client_id`;
  const conds = [], p = [];
  let idx = 0;
  if (f.fauteuil_id) { conds.push(`i.fauteuil_id=$${++idx}`); p.push(f.fauteuil_id); }
  if (f.client_id)   { conds.push(`i.client_id=$${++idx}`);   p.push(f.client_id); }
  if (f.statut)      { conds.push(`i.statut=$${++idx}`);       p.push(f.statut); }
  if (f.technicien)  { conds.push(`i.technicien=$${++idx}`);   p.push(f.technicien); }
  if (f.date_from)   { conds.push(`i.date>=$${++idx}`);        p.push(f.date_from); }
  if (f.date_to)     { conds.push(`i.date<=$${++idx}`);        p.push(f.date_to); }
  if (f.garantie !== undefined) { conds.push(`i.garantie=$${++idx}`); p.push(f.garantie); }
  if (f.q) {
    const q = `%${f.q}%`;
    conds.push(`(i.description ILIKE $${++idx} OR f.modele ILIKE $${++idx} OR f.serie ILIKE $${++idx} OR c.nom ILIKE $${++idx} OR i.envoi_numero ILIKE $${++idx} OR i.retour_numero ILIKE $${++idx})`);
    p.push(q, q, q, q, q, q);
  }
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  sql += ' ORDER BY i.date DESC, i.id DESC';
  const rows = await db.all(sql, p);
  for (const row of rows) {
    row.produits = await db.all('SELECT * FROM intervention_produits WHERE intervention_id=$1', [row.id]);
  }
  return rows;
}

// ── CLIENTS ───────────────────────────────────────────────────────
router.get('/clients', async (req, res) => {
  try {
    const q = `%${req.query.q || ''}%`;
    const rows = await db.all(
      `SELECT c.*,
        (SELECT COUNT(*)::int FROM fauteuils f WHERE f.client_id=c.id) AS nb_fauteuils,
        (SELECT COUNT(*)::int FROM interventions i WHERE i.client_id=c.id) AS nb_interventions
       FROM clients c WHERE c.nom ILIKE $1 OR c.contact ILIKE $1 OR c.ville ILIKE $1 ORDER BY c.nom`,
      [q]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/clients/:id', async (req, res) => {
  try {
    const cl = await db.get('SELECT * FROM clients WHERE id=$1', [req.params.id]);
    if (!cl) return res.status(404).json({ error: 'Introuvable' });
    const fauts = await db.all(
      `SELECT f.*,
        (SELECT COUNT(*)::int FROM interventions i WHERE i.fauteuil_id=f.id) AS nb_interventions,
        (SELECT COUNT(*)::int FROM interventions i WHERE i.fauteuil_id=f.id AND i.garantie=true) AS nb_garantie
       FROM fauteuils f WHERE f.client_id=$1 ORDER BY f.annee DESC`,
      [cl.id]
    );
    cl.fauteuils = fauts.map(f => ({ ...f, garantie_active: garantieActive(f.date_achat, f.duree_garantie_mois) }));
    cl.stats = await db.get(
      `SELECT COUNT(*)::int AS total,
        SUM(CASE WHEN garantie THEN 1 ELSE 0 END)::int AS garantie,
        SUM(CASE WHEN NOT garantie THEN 1 ELSE 0 END)::int AS hors_garantie,
        SUM(CASE WHEN statut='Ouvert' THEN 1 ELSE 0 END)::int AS ouvert
       FROM interventions WHERE client_id=$1`,
      [cl.id]
    );
    res.json(cl);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/clients', async (req, res) => {
  try {
    const { nom, contact, email, tel, ville, type } = req.body;
    if (!nom) return res.status(400).json({ error: 'Nom requis' });
    const token = crypto.randomBytes(20).toString('hex');
    const cl = await db.run(
      'INSERT INTO clients (nom,contact,email,tel,ville,type,token_portail) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [nom, contact||null, email||null, tel||null, ville||null, type||'Distributeur', token]
    );
    res.status(201).json(cl);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/clients/:id', async (req, res) => {
  try {
    const { nom, contact, email, tel, ville, type } = req.body;
    const cl = await db.run(
      'UPDATE clients SET nom=$1,contact=$2,email=$3,tel=$4,ville=$5,type=$6,updated_at=NOW() WHERE id=$7 RETURNING *',
      [nom, contact, email, tel, ville, type, req.params.id]
    );
    res.json(cl);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/clients/:id/regenerer-token', async (req, res) => {
  try {
    const token = crypto.randomBytes(20).toString('hex');
    await db.run('UPDATE clients SET token_portail=$1 WHERE id=$2', [token, req.params.id]);
    res.json({ token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/clients/:id', async (req, res) => {
  try { await db.run('DELETE FROM clients WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── FAUTEUILS ─────────────────────────────────────────────────────
router.get('/fauteuils', async (req, res) => {
  try {
    const cid = req.query.client_id;
    let sql = 'SELECT f.*, c.nom AS client_nom FROM fauteuils f JOIN clients c ON c.id=f.client_id';
    const p = [];
    if (cid) { sql += ' WHERE f.client_id=$1'; p.push(cid); }
    sql += ' ORDER BY f.annee DESC, f.modele';
    const rows = await db.all(sql, p);
    res.json(rows.map(f => ({ ...f, garantie_active: garantieActive(f.date_achat, f.duree_garantie_mois) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/fauteuils/:id', async (req, res) => {
  try {
    const f = await db.get('SELECT f.*,c.nom AS client_nom FROM fauteuils f JOIN clients c ON c.id=f.client_id WHERE f.id=$1', [req.params.id]);
    if (!f) return res.status(404).json({ error: 'Introuvable' });
    f.garantie_active = garantieActive(f.date_achat, f.duree_garantie_mois);
    f.interventions = await getInterventions({ fauteuil_id: req.params.id });
    res.json(f);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/fauteuils', async (req, res) => {
  try {
    const { client_id, modele, serie, annee, couleur, date_achat, num_facture, duree_garantie_mois, notes } = req.body;
    if (!client_id || !modele || !serie) return res.status(400).json({ error: 'client_id, modele et serie requis' });
    const f = await db.run(
      'INSERT INTO fauteuils (client_id,modele,serie,annee,couleur,date_achat,num_facture,duree_garantie_mois,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [client_id, modele, serie, annee||null, couleur||null, date_achat||null, num_facture||null, duree_garantie_mois||24, notes||null]
    );
    res.status(201).json(f);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/fauteuils/:id', async (req, res) => {
  try {
    const { modele, serie, annee, couleur, date_achat, num_facture, duree_garantie_mois, notes } = req.body;
    const f = await db.run(
      'UPDATE fauteuils SET modele=$1,serie=$2,annee=$3,couleur=$4,date_achat=$5,num_facture=$6,duree_garantie_mois=$7,notes=$8,updated_at=NOW() WHERE id=$9 RETURNING *',
      [modele, serie, annee, couleur, date_achat, num_facture, duree_garantie_mois||24, notes, req.params.id]
    );
    res.json(f);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/fauteuils/:id', async (req, res) => {
  try { await db.run('DELETE FROM fauteuils WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── INTERVENTIONS ─────────────────────────────────────────────────
router.get('/interventions', async (req, res) => {
  try {
    const q = req.query;
    res.json(await getInterventions({
      fauteuil_id: q.fauteuil_id, client_id: q.client_id, statut: q.statut,
      q: q.q, technicien: q.technicien, date_from: q.date_from, date_to: q.date_to,
      garantie: q.garantie !== undefined ? q.garantie === '1' : undefined
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/interventions/:id', async (req, res) => {
  try {
    const i = await db.get(
      `SELECT i.*,f.modele,f.serie,f.num_facture,f.date_achat,f.duree_garantie_mois,c.nom AS client_nom
       FROM interventions i JOIN fauteuils f ON f.id=i.fauteuil_id JOIN clients c ON c.id=i.client_id
       WHERE i.id=$1`,
      [req.params.id]
    );
    if (!i) return res.status(404).json({ error: 'Introuvable' });
    i.garantie_active = garantieActive(i.date_achat, i.duree_garantie_mois);
    i.produits      = await db.all('SELECT * FROM intervention_produits WHERE intervention_id=$1', [i.id]);
    i.commentaires  = await db.all('SELECT * FROM intervention_commentaires WHERE intervention_id=$1 ORDER BY created_at', [i.id]);
    i.historique    = await db.all('SELECT * FROM intervention_historique WHERE intervention_id=$1 ORDER BY created_at DESC', [i.id]);
    res.json(i);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/interventions', async (req, res) => {
  try {
    const { fauteuil_id, client_id, date, type, garantie, statut, description, notes, technicien,
      envoi_transporteur, envoi_numero, envoi_date, retour_transporteur, retour_numero, retour_date, produits = [] } = req.body;
    if (!fauteuil_id || !date) return res.status(400).json({ error: 'fauteuil_id et date requis' });
    const faut = await db.get('SELECT client_id,date_achat,duree_garantie_mois FROM fauteuils WHERE id=$1', [fauteuil_id]);
    const cid  = client_id || faut?.client_id;
    const gaAuto = garantieActive(faut?.date_achat, faut?.duree_garantie_mois);

    const pgClient = await db.pool.connect();
    let id;
    try {
      await pgClient.query('BEGIN');
      const r = await pgClient.query(
        `INSERT INTO interventions (fauteuil_id,client_id,date,type,garantie,garantie_auto,statut,description,notes,technicien,
          envoi_transporteur,envoi_numero,envoi_date,retour_transporteur,retour_numero,retour_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
        [fauteuil_id, cid, date, type||'Réparation', !!garantie, !!gaAuto,
         statut||'Ouvert', description||null, notes||null, technicien||null,
         envoi_transporteur||null, envoi_numero||null, envoi_date||null,
         retour_transporteur||null, retour_numero||null, retour_date||null]
      );
      id = r.rows[0].id;
      for (const p of produits) {
        await pgClient.query(
          'INSERT INTO intervention_produits (intervention_id,ref,designation,qte,pxht) VALUES ($1,$2,$3,$4,$5)',
          [id, p.ref||null, p.designation, p.qte||1, p.pxht||0]
        );
        if (p.ref) {
          await pgClient.query('UPDATE catalogue SET stock=GREATEST(0,stock-$1),updated_at=NOW() WHERE ref=$2', [p.qte||1, p.ref]);
          const piece = (await pgClient.query('SELECT * FROM catalogue WHERE ref=$1', [p.ref])).rows[0];
          if (piece && piece.stock <= piece.stock_alerte)
            await pgClient.query('INSERT INTO alertes (type,reference_id,message) VALUES ($1,$2,$3)',
              ['stock_faible', piece.id, `Stock faible : ${piece.designation} (${piece.stock} restant${piece.stock!==1?'s':''})`]);
        }
      }
      await pgClient.query(
        'INSERT INTO intervention_historique (intervention_id,auteur,champ,ancienne_valeur,nouvelle_valeur) VALUES ($1,$2,$3,$4,$5)',
        [id, technicien||'Système', 'création', '', `Créée — ${type} — ${statut}`]
      );
      await pgClient.query('COMMIT');
    } catch (e) { await pgClient.query('ROLLBACK'); throw e; }
    finally { pgClient.release(); }

    res.status(201).json(await db.get('SELECT * FROM interventions WHERE id=$1', [id]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/interventions/:id', async (req, res) => {
  try {
    const old = await db.get('SELECT * FROM interventions WHERE id=$1', [req.params.id]);
    if (!old) return res.status(404).json({ error: 'Introuvable' });
    const { type, garantie, statut, description, notes, technicien,
      envoi_transporteur, envoi_numero, envoi_date, retour_transporteur, retour_numero, retour_date, produits } = req.body;

    const pgClient = await db.pool.connect();
    try {
      await pgClient.query('BEGIN');
      await pgClient.query(
        `UPDATE interventions SET type=$1,garantie=$2,statut=$3,description=$4,notes=$5,technicien=$6,
          envoi_transporteur=$7,envoi_numero=$8,envoi_date=$9,retour_transporteur=$10,retour_numero=$11,retour_date=$12,
          updated_at=NOW() WHERE id=$13`,
        [type, !!garantie, statut, description, notes, technicien,
         envoi_transporteur||null, envoi_numero||null, envoi_date||null,
         retour_transporteur||null, retour_numero||null, retour_date||null, req.params.id]
      );
      for (const [champ, anc, nouv] of [
        ['statut', old.statut, statut],
        ['garantie', old.garantie?'Oui':'Non', garantie?'Oui':'Non'],
        ['technicien', old.technicien, technicien],
        ['envoi_numero', old.envoi_numero, envoi_numero],
        ['retour_numero', old.retour_numero, retour_numero],
      ]) {
        if (String(anc) !== String(nouv))
          await pgClient.query('INSERT INTO intervention_historique (intervention_id,auteur,champ,ancienne_valeur,nouvelle_valeur) VALUES ($1,$2,$3,$4,$5)',
            [req.params.id, technicien||'Système', champ, String(anc??''), String(nouv??'')]);
      }
      if (Array.isArray(produits)) {
        await pgClient.query('DELETE FROM intervention_produits WHERE intervention_id=$1', [req.params.id]);
        for (const p of produits)
          await pgClient.query('INSERT INTO intervention_produits (intervention_id,ref,designation,qte,pxht) VALUES ($1,$2,$3,$4,$5)',
            [req.params.id, p.ref||null, p.designation, p.qte||1, p.pxht||0]);
      }
      if (statut === 'Fermé' && old.statut !== 'Fermé')
        await pgClient.query('INSERT INTO alertes (type,reference_id,message) VALUES ($1,$2,$3)',
          ['intervention_fermee', parseInt(req.params.id), `Intervention #${req.params.id} clôturée`]);
      await pgClient.query('COMMIT');
    } catch (e) { await pgClient.query('ROLLBACK'); throw e; }
    finally { pgClient.release(); }

    res.json(await db.get('SELECT * FROM interventions WHERE id=$1', [req.params.id]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/interventions/:id', async (req, res) => {
  try { await db.run('DELETE FROM interventions WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── COMMENTAIRES ──────────────────────────────────────────────────
router.get('/interventions/:id/commentaires', async (req, res) => {
  try { res.json(await db.all('SELECT * FROM intervention_commentaires WHERE intervention_id=$1 ORDER BY created_at', [req.params.id])); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/interventions/:id/commentaires', async (req, res) => {
  try {
    const { auteur, texte } = req.body;
    if (!texte) return res.status(400).json({ error: 'Texte requis' });
    const r = await db.run('INSERT INTO intervention_commentaires (intervention_id,auteur,texte) VALUES ($1,$2,$3) RETURNING *',
      [req.params.id, auteur||'Équipe SAV', texte]);
    res.status(201).json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/interventions/:id/commentaires/:cid', async (req, res) => {
  try { await db.run('DELETE FROM intervention_commentaires WHERE id=$1 AND intervention_id=$2', [req.params.cid, req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── HISTORIQUE ────────────────────────────────────────────────────
router.get('/interventions/:id/historique', async (req, res) => {
  try { res.json(await db.all('SELECT * FROM intervention_historique WHERE intervention_id=$1 ORDER BY created_at DESC', [req.params.id])); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PHOTOS ────────────────────────────────────────────────────────
router.get('/interventions/:id/photos', async (req, res) => {
  try { res.json(await db.all('SELECT * FROM intervention_photos WHERE intervention_id=$1 ORDER BY created_at', [req.params.id])); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/interventions/:id/photos', upload.array('photos', 20), async (req, res) => {
  try {
    const interId = parseInt(req.params.id);
    if (!await db.get('SELECT id FROM interventions WHERE id=$1', [interId])) return res.status(404).json({ error: 'Introuvable' });
    if (!req.files?.length) return res.status(400).json({ error: 'Aucun fichier' });
    const results = [];
    for (const file of req.files) {
      const thumb = await makeThumb(file.filename);
      const r = await db.run('INSERT INTO intervention_photos (intervention_id,filename,filename_thumb,legende,taille,mime) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
        [interId, file.filename, thumb, req.body.legende||null, file.size, file.mimetype]);
      results.push(r);
    }
    await logHistorique(interId, 'Système', 'photos', '', `${req.files.length} photo(s) ajoutée(s)`);
    res.status(201).json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.patch('/interventions/:id/photos/:pid', async (req, res) => {
  try {
    const r = await db.run('UPDATE intervention_photos SET legende=$1 WHERE id=$2 AND intervention_id=$3 RETURNING *',
      [req.body.legende||null, req.params.pid, req.params.id]);
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/interventions/:id/photos/:pid', async (req, res) => {
  try {
    const p = await db.get('SELECT * FROM intervention_photos WHERE id=$1 AND intervention_id=$2', [req.params.pid, req.params.id]);
    if (!p) return res.status(404).json({ error: 'Introuvable' });
    deleteFiles(p.filename, p.filename_thumb);
    await db.run('DELETE FROM intervention_photos WHERE id=$1', [req.params.pid]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── EXPÉDITIONS ───────────────────────────────────────────────────
router.get('/expeditions', async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT i.*,f.modele,f.serie,c.nom AS client_nom FROM interventions i
       JOIN fauteuils f ON f.id=i.fauteuil_id JOIN clients c ON c.id=i.client_id
       WHERE i.envoi_numero IS NOT NULL AND i.envoi_numero!=''
         AND (i.retour_numero IS NULL OR i.retour_numero='')
         AND i.statut!='Fermé' ORDER BY i.envoi_date ASC`
    );
    res.json(rows.map(r => ({ ...r,
      jours_attente: r.envoi_date ? Math.floor((Date.now()-new Date(r.envoi_date))/86400000) : null
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CATALOGUE ─────────────────────────────────────────────────────
router.get('/catalogue', async (req, res) => {
  try {
    const q = `%${req.query.q || ''}%`;
    let sql = 'SELECT * FROM catalogue WHERE (ref ILIKE $1 OR designation ILIKE $1 OR fournisseur ILIKE $1)';
    if (req.query.alerte === '1') sql += ' AND stock<=stock_alerte';
    sql += ' ORDER BY ref';
    res.json(await db.all(sql, [q]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/catalogue', async (req, res) => {
  try {
    const { ref, designation, fournisseur, ref_fournisseur, pxht, stock, stock_alerte } = req.body;
    if (!ref || !designation) return res.status(400).json({ error: 'ref et designation requis' });
    const r = await db.run(
      'INSERT INTO catalogue (ref,designation,fournisseur,ref_fournisseur,pxht,stock,stock_alerte) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [ref, designation, fournisseur||null, ref_fournisseur||null, pxht||0, stock||0, stock_alerte||2]
    );
    res.status(201).json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/catalogue/:id', async (req, res) => {
  try {
    const { ref, designation, fournisseur, ref_fournisseur, pxht, stock, stock_alerte } = req.body;
    const r = await db.run(
      'UPDATE catalogue SET ref=$1,designation=$2,fournisseur=$3,ref_fournisseur=$4,pxht=$5,stock=$6,stock_alerte=$7,updated_at=NOW() WHERE id=$8 RETURNING *',
      [ref, designation, fournisseur, ref_fournisseur, pxht, stock, stock_alerte||2, req.params.id]
    );
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/catalogue/:id', async (req, res) => {
  try { await db.run('DELETE FROM catalogue WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ALERTES ───────────────────────────────────────────────────────
router.get('/alertes', async (req, res) => {
  try { res.json(await db.all('SELECT * FROM alertes WHERE lue=false ORDER BY created_at DESC LIMIT 50')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.patch('/alertes/:id/lue', async (req, res) => {
  try { await db.run('UPDATE alertes SET lue=true WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.patch('/alertes/lire-toutes', async (req, res) => {
  try { await db.run('UPDATE alertes SET lue=true'); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── STATS ─────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const stats = await db.get(`
      SELECT
        (SELECT COUNT(*)::int FROM clients) AS nb_clients,
        (SELECT COUNT(*)::int FROM fauteuils) AS nb_fauteuils,
        (SELECT COUNT(*)::int FROM interventions) AS nb_interventions,
        (SELECT COUNT(*)::int FROM interventions WHERE statut='Ouvert') AS ouvert,
        (SELECT COUNT(*)::int FROM interventions WHERE statut='En attente') AS attente,
        (SELECT COUNT(*)::int FROM interventions WHERE statut='Fermé') AS ferme,
        (SELECT COUNT(*)::int FROM interventions WHERE garantie=true) AS garantie,
        (SELECT COUNT(*)::int FROM interventions WHERE garantie=false) AS hors_garantie,
        (SELECT COUNT(*)::int FROM alertes WHERE lue=false) AS alertes_non_lues,
        (SELECT COUNT(*)::int FROM catalogue WHERE stock<=stock_alerte) AS pieces_alerte,
        (SELECT COUNT(*)::int FROM interventions WHERE envoi_numero IS NOT NULL AND envoi_numero!='' AND (retour_numero IS NULL OR retour_numero='') AND statut!='Fermé') AS expeditions_cours
    `);
    const recentes = await db.all(
      `SELECT i.*,f.modele,f.serie,c.nom AS client_nom FROM interventions i
       JOIN fauteuils f ON f.id=i.fauteuil_id JOIN clients c ON c.id=i.client_id
       ORDER BY i.updated_at DESC LIMIT 8`
    );
    const par_mois = await db.all(
      `SELECT to_char(date::date,'YYYY-MM') AS mois, COUNT(*)::int AS total,
        SUM(CASE WHEN garantie THEN 1 ELSE 0 END)::int AS garantie,
        SUM(CASE WHEN NOT garantie THEN 1 ELSE 0 END)::int AS hors_garantie
       FROM interventions WHERE date::date >= NOW()-INTERVAL '12 months'
       GROUP BY mois ORDER BY mois`
    );
    const pieces_top = await db.all(
      `SELECT ip.ref,ip.designation,SUM(ip.qte)::int AS total_utilise
       FROM intervention_produits ip JOIN interventions i ON i.id=ip.intervention_id
       WHERE i.date::date >= NOW()-INTERVAL '6 months'
       GROUP BY ip.ref,ip.designation ORDER BY total_utilise DESC LIMIT 5`
    );
    const par_technicien = await db.all(
      'SELECT technicien,COUNT(*)::int AS total FROM interventions WHERE technicien IS NOT NULL GROUP BY technicien ORDER BY total DESC'
    );
    res.json({ stats, recentes, par_mois, pieces_top, par_technicien });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── EXPORT EXCEL ──────────────────────────────────────────────────
router.get('/export/excel', async (req, res) => {
  try {
    const { type = 'interventions', date_from, date_to, client_id } = req.query;
    const wb = XLSX.utils.book_new();
    if (type === 'interventions' || type === 'complet') {
      const inters = await getInterventions({ date_from, date_to, client_id });
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(inters.map(i => ({
        'N°': i.id, 'Date': i.date, 'Client': i.client_nom, 'Modèle': i.modele,
        'N° série': i.serie, 'Facture VF': i.num_facture||'', 'Type': i.type,
        'Garantie': i.garantie?'Oui':'Non', 'Statut': i.statut, 'Technicien': i.technicien||'',
        'Description': i.description||'',
        'Pièces': i.produits.map(p=>`${p.designation} x${p.qte}`).join(' | '),
        'Total HT €': i.produits.reduce((s,p)=>s+parseFloat(p.pxht)*p.qte,0).toFixed(2),
        'Envoi': i.envoi_transporteur||'', 'N° envoi': i.envoi_numero||'', 'Date envoi': i.envoi_date||'',
        'Retour': i.retour_transporteur||'', 'N° retour': i.retour_numero||'', 'Date retour': i.retour_date||''
      }))), 'Interventions');
    }
    if (type === 'catalogue' || type === 'complet') {
      const cat = await db.all('SELECT * FROM catalogue ORDER BY ref');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(cat.map(p => ({
        'Référence': p.ref, 'Désignation': p.designation, 'Fournisseur': p.fournisseur||'',
        'Réf fournisseur': p.ref_fournisseur||'', 'Prix HT': parseFloat(p.pxht||0), 'Stock': p.stock, 'Seuil alerte': p.stock_alerte
      }))), 'Catalogue');
    }
    if (type === 'expeditions' || type === 'complet') {
      const exp = await db.all(`SELECT i.*,f.modele,f.serie,c.nom AS client_nom FROM interventions i JOIN fauteuils f ON f.id=i.fauteuil_id JOIN clients c ON c.id=i.client_id WHERE i.envoi_numero IS NOT NULL AND i.envoi_numero!='' ORDER BY i.envoi_date DESC`);
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(exp.map(i => ({
        'N° inter': i.id, 'Client': i.client_nom, 'Modèle': i.modele, 'Série': i.serie,
        'Transporteur envoi': i.envoi_transporteur||'', 'N° suivi envoi': i.envoi_numero||'', 'Date envoi': i.envoi_date||'',
        'Transporteur retour': i.retour_transporteur||'', 'N° suivi retour': i.retour_numero||'', 'Date retour': i.retour_date||'',
        'Statut': i.statut
      }))), 'Expéditions');
    }
    if (type === 'clients' || type === 'complet') {
      const cls = await db.all('SELECT * FROM clients ORDER BY nom');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(cls.map(c => ({
        'Nom': c.nom, 'Contact': c.contact||'', 'Email': c.email||'', 'Téléphone': c.tel||'', 'Ville': c.ville||'', 'Type': c.type
      }))), 'Clients');
    }
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="sav_eloflex_${new Date().toISOString().slice(0,10)}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PARAMÈTRES ────────────────────────────────────────────────────
router.get('/parametres', async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM parametres');
    const obj = {};
    rows.forEach(r => { if (r.cle !== 'smtp_pass') obj[r.cle] = r.valeur; });
    res.json(obj);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/parametres', async (req, res) => {
  try {
    const pgClient = await db.pool.connect();
    try {
      await pgClient.query('BEGIN');
      for (const [k, v] of Object.entries(req.body))
        await pgClient.query('INSERT INTO parametres (cle,valeur) VALUES ($1,$2) ON CONFLICT (cle) DO UPDATE SET valeur=EXCLUDED.valeur', [k, String(v)]);
      await pgClient.query('COMMIT');
    } catch (e) { await pgClient.query('ROLLBACK'); throw e; }
    finally { pgClient.release(); }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PORTAIL CLIENT ────────────────────────────────────────────────
router.get('/portail/:token', async (req, res) => {
  try {
    if (await param('portail_actif') !== '1') return res.status(403).json({ error: 'Portail désactivé' });
    const cl = await db.get('SELECT * FROM clients WHERE token_portail=$1', [req.params.token]);
    if (!cl) return res.status(404).json({ error: 'Lien invalide' });
    const fauts = await db.all('SELECT * FROM fauteuils WHERE client_id=$1', [cl.id]);
    const inters = (await getInterventions({ client_id: cl.id })).map(i => ({
      id: i.id, date: i.date, type: i.type, statut: i.statut, garantie: i.garantie,
      description: i.description, modele: i.modele, serie: i.serie,
      envoi_transporteur: i.envoi_transporteur, envoi_numero: i.envoi_numero, envoi_date: i.envoi_date,
      retour_transporteur: i.retour_transporteur, retour_numero: i.retour_numero, retour_date: i.retour_date,
    }));
    res.json({ client: { nom: cl.nom, ville: cl.ville }, fauteuils: fauts, interventions: inters });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── VOSFACTURES ───────────────────────────────────────────────────
router.post('/vosfactures/sync', async (req, res) => {
  const token = process.env.VOSFACTURES_API_TOKEN, account = process.env.VOSFACTURES_ACCOUNT;
  if (!token || !account) return res.status(503).json({ error: 'VosFactures non configuré' });
  try {
    const { syncClients, syncProducts, syncInvoices } = require('../scripts/sync-vosfactures');
    const results = {};
    try { results.clients  = await syncClients();  } catch(e) { results.clients  = `Erreur: ${e.message}`; }
    try { results.products = await syncProducts(); } catch(e) { results.products = `Erreur: ${e.message}`; }
    try { results.invoices = await syncInvoices(); } catch(e) { results.invoices = `Erreur: ${e.message}`; }
    res.json({ ok: true, results, synced_at: new Date().toISOString() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.get('/vosfactures/logs', async (req, res) => {
  try { res.json(await db.all('SELECT * FROM sync_log ORDER BY created_at DESC LIMIT 50')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/vosfactures/status', async (req, res) => {
  try {
    const configured = !!(process.env.VOSFACTURES_API_TOKEN && process.env.VOSFACTURES_ACCOUNT);
    const lastSync = await db.get("SELECT * FROM sync_log WHERE status='ok' ORDER BY created_at DESC LIMIT 1");
    res.json({ configured, account: process.env.VOSFACTURES_ACCOUNT||null, last_sync: lastSync||null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
