// server/routes.js v2 — PostgreSQL
const express  = require('express');
const crypto   = require('crypto');
const XLSX     = require('xlsx');
const bcrypt   = require('bcryptjs');
const db       = require('./db');
const { upload, uploadExcel, uploadPreuveLivraison, makeThumb, deleteFiles, savePreuveLivraison, deletePreuveLivraisonFile } = require('./uploads');
const router   = express.Router();

// ── Auth : routes publiques (login/logout/me) ──────────────────────
router.post('/auth/login', async (req, res) => {
  try {
    const { email, mot_de_passe } = req.body;
    if (!email || !mot_de_passe) return res.status(400).json({ error: 'Email et mot de passe requis' });
    const user = await db.get(
      'SELECT * FROM users WHERE LOWER(email)=$1 AND actif=TRUE', [email.toLowerCase().trim()]
    );
    if (!user) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    const ok = await bcrypt.compare(mot_de_passe, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    await db.run('UPDATE users SET last_login=NOW() WHERE id=$1', [user.id]);
    req.session.user = {
      id: user.id, nom: user.nom, email: user.email, role: user.role,
      permissions: user.permissions || {}, langue: user.langue || 'fr',
      pays: user.pays || null
    };
    req.session.save(err => {
      if (err) return res.status(500).json({ error: 'Erreur session' });
      res.json({ ok: true, user: req.session.user });
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/auth/logout', (req, res) => {
  req.session.destroy(() => { res.clearCookie('sav.sid'); res.json({ ok: true }); });
});

router.get('/auth/me', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Non authentifié' });
  res.json(req.session.user);
});

router.get('/auth/setup-status', async (req, res) => {
  try {
    const r = await db.get('SELECT COUNT(*)::int AS n FROM users');
    res.json({ setup_needed: (r?.n || 0) === 0 });
  } catch (e) { res.json({ setup_needed: true }); }
});

router.post('/auth/setup', async (req, res) => {
  try {
    const count = await db.get('SELECT COUNT(*)::int AS n FROM users');
    if ((count?.n || 0) > 0) return res.status(403).json({ error: 'Un compte administrateur existe déjà.' });
    const { nom, email, mot_de_passe } = req.body;
    if (!nom || !email || !mot_de_passe) return res.status(400).json({ error: 'Tous les champs sont requis.' });
    if (mot_de_passe.length < 8) return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères.' });
    const hash = await bcrypt.hash(mot_de_passe, 12);
    const user = await db.run(
      "INSERT INTO users (nom, email, password_hash, role, permissions) VALUES ($1,$2,$3,'admin','{}') RETURNING id, nom, email, role",
      [nom.trim(), email.toLowerCase().trim(), hash]
    );
    req.session.user = { id: user.id, nom: user.nom, email: user.email, role: 'admin', permissions: {}, langue: 'fr' };
    req.session.save(() => res.json({ ok: true, message: `Compte admin créé pour ${user.nom}. Bienvenue !` }));
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Cet email est déjà utilisé.' });
    res.status(500).json({ error: e.message });
  }
});

// ── Middleware d'authentification ──────────────────────────────────
router.use((req, res, next) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Non authentifié', redirect: '/login' });
  res.locals.user = req.session.user;
  next();
});

// ── Helpers de permission ──────────────────────────────────────────
// Détermine le module depuis le chemin de la route
function moduleFromPath(p) {
  if (p.startsWith('/clients'))                     return 'clients';
  if (p.startsWith('/fauteuils')||p.startsWith('/interventions')) return 'interventions';
  if (p.startsWith('/expeditions'))                 return 'expeditions';
  if (p.startsWith('/commandes'))                   return 'commandes';
  if (p.startsWith('/produits')||p.startsWith('/catalogue')) return 'catalogue';
  if (p.startsWith('/rapports')||p.startsWith('/export')) return 'rapports';
  if (p.startsWith('/alertes'))                     return 'alertes';
  if (p.startsWith('/retours'))                     return 'retours_suede';
  if (p.startsWith('/transferts'))                  return 'transferts';
  if (p.startsWith('/parametres'))                  return 'parametres';
  return null;
}

// Middleware de protection en écriture par module (s'applique aux non-admins)
router.use((req, res, next) => {
  const user = res.locals.user;
  if (user.role === 'admin') return next(); // Admin : accès total
  const module = moduleFromPath(req.path);
  if (!module) return next(); // Route système (auth, VF sync...) : déjà protégée
  const perm = (user.permissions || {})[module] || 'none';
  // Méthodes en écriture : exiger 'write'
  if (['POST','PUT','DELETE','PATCH'].includes(req.method) && perm !== 'write') {
    return res.status(403).json({ error: `Accès en écriture refusé sur le module "${module}".` });
  }
  // Lecture : exiger au moins 'read' ou 'write'
  if (req.method === 'GET' && perm === 'none') {
    return res.status(403).json({ error: `Accès refusé sur le module "${module}".` });
  }
  next();
});

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(res.locals.user?.role)) return res.status(403).json({ error: 'Accès refusé pour ce rôle' });
    next();
  };
}
const adminOnly = requireRole('admin');
const adminOrOp  = requireRole('admin', 'operateur');

// ── Gestion des utilisateurs (admin only) ─────────────────────────
router.get('/users', adminOnly, async (req, res) => {
  try {
    const rows = await db.all('SELECT id, nom, email, role, permissions, langue, actif, last_login FROM users ORDER BY id');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/users', adminOnly, async (req, res) => {
  try {
    const { nom, email, mot_de_passe, admin: isAdmin, permissions = {}, langue = 'fr', pays = null } = req.body;
    if (!nom || !email || !mot_de_passe) return res.status(400).json({ error: 'Nom, email et mot de passe sont requis.' });
    if (mot_de_passe.length < 8) return res.status(400).json({ error: 'Mot de passe : minimum 8 caractères.' });
    const role = isAdmin ? 'admin' : 'utilisateur';
    const hash = await bcrypt.hash(mot_de_passe, 12);
    const user = await db.run(
      'INSERT INTO users (nom, email, password_hash, role, permissions, langue, pays) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, nom, email, role, permissions, langue, actif, pays',
      [nom.trim(), email.toLowerCase().trim(), hash, role, JSON.stringify(permissions), langue || 'fr', pays || null]
    );
    res.status(201).json(user);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Cet email est déjà utilisé.' });
    res.status(500).json({ error: e.message });
  }
});

router.put('/users/:id', adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { nom, email, admin: isAdmin, permissions, actif, langue, pays } = req.body;
    if (id === res.locals.user.id && isAdmin === false) {
      return res.status(400).json({ error: 'Vous ne pouvez pas retirer votre propre accès admin.' });
    }
    const sets = [], p = [];
    let idx = 0;
    if (nom !== undefined)   { sets.push(`nom=$${++idx}`);         p.push(nom.trim()); }
    if (email !== undefined) { sets.push(`email=$${++idx}`);       p.push(email.toLowerCase().trim()); }
    if (isAdmin !== undefined){ sets.push(`role=$${++idx}`);       p.push(isAdmin ? 'admin' : 'utilisateur'); }
    if (permissions !== undefined){ sets.push(`permissions=$${++idx}`); p.push(JSON.stringify(permissions)); }
    if (langue !== undefined)     { sets.push(`langue=$${++idx}`);      p.push(langue); }
    if (actif !== undefined)      { sets.push(`actif=$${++idx}`);       p.push(Boolean(actif)); }
    if (pays !== undefined)       { sets.push(`pays=$${++idx}`);        p.push(pays || null); }
    if (!sets.length) return res.status(400).json({ error: 'Aucune modification.' });
    p.push(id);
    const user = await db.run(`UPDATE users SET ${sets.join(',')} WHERE id=$${++idx} RETURNING id, nom, email, role, permissions, langue, actif, pays`, p);
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable.' });
    res.json(user);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Cet email est déjà utilisé.' });
    res.status(500).json({ error: e.message });
  }
});

router.post('/users/:id/reset-password', adminOnly, async (req, res) => {
  try {
    const { mot_de_passe } = req.body;
    if (!mot_de_passe || mot_de_passe.length < 8) return res.status(400).json({ error: 'Mot de passe : minimum 8 caractères.' });
    const hash = await bcrypt.hash(mot_de_passe, 12);
    const user = await db.run('UPDATE users SET password_hash=$1 WHERE id=$2 RETURNING nom, email', [hash, req.params.id]);
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable.' });
    res.json({ ok: true, message: `Mot de passe mis à jour pour ${user.nom}.` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/users/:id', adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (id === res.locals.user.id) return res.status(400).json({ error: 'Vous ne pouvez pas supprimer votre propre compte.' });
    await db.run('DELETE FROM users WHERE id=$1', [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
      envoi_transporteur, envoi_numero, envoi_date, retour_transporteur, retour_numero, retour_date, num_bordereau_vf, num_sav,
      mettre_a_jour_proprietaire,
      produits = [] } = req.body;
    if (!fauteuil_id || !date) return res.status(400).json({ error: 'fauteuil_id et date requis' });
    const faut = await db.get('SELECT client_id,date_achat,duree_garantie_mois FROM fauteuils WHERE id=$1', [fauteuil_id]);
    const cid  = client_id || faut?.client_id;
    const gaAuto = garantieActive(faut?.date_achat, faut?.duree_garantie_mois);

    const pgClient = await db.pool.connect();
    let id;
    try {
      await pgClient.query('BEGIN');

      // Mettre à jour le propriétaire du fauteuil si demandé ET si le client a changé
      if (mettre_a_jour_proprietaire && client_id && faut && client_id !== faut.client_id) {
        await pgClient.query(
          'UPDATE fauteuils SET client_id=$1, updated_at=NOW() WHERE id=$2',
          [client_id, fauteuil_id]
        );
      }

      const r = await pgClient.query(
        `INSERT INTO interventions (fauteuil_id,client_id,date,type,garantie,garantie_auto,statut,description,notes,technicien,
          envoi_transporteur,envoi_numero,envoi_date,retour_transporteur,retour_numero,retour_date,num_bordereau_vf,num_sav)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
        [fauteuil_id, cid, date, type||'Réparation', !!garantie, !!gaAuto,
         statut||'Ouvert', description||null, notes||null, technicien||null,
         envoi_transporteur||null, envoi_numero||null, envoi_date||null,
         retour_transporteur||null, retour_numero||null, retour_date||null, num_bordereau_vf||null, num_sav||null]
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
          if (piece && piece.stock_actif !== false && piece.stock <= piece.stock_alerte)
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
      envoi_transporteur, envoi_numero, envoi_date, retour_transporteur, retour_numero, retour_date, num_bordereau_vf, num_sav, num_facture, produits } = req.body;

    const pgClient = await db.pool.connect();
    try {
      await pgClient.query('BEGIN');
      await pgClient.query(
        `UPDATE interventions SET type=$1,garantie=$2,statut=$3,description=$4,notes=$5,technicien=$6,
          envoi_transporteur=$7,envoi_numero=$8,envoi_date=$9,retour_transporteur=$10,retour_numero=$11,retour_date=$12,
          num_bordereau_vf=$13,num_sav=$14,num_facture=COALESCE($15,num_facture),updated_at=NOW() WHERE id=$16`,
        [type, !!garantie, statut, description, notes, technicien,
         envoi_transporteur||null, envoi_numero||null, envoi_date||null,
         retour_transporteur||null, retour_numero||null, retour_date||null, num_bordereau_vf||null, num_sav||null, num_facture!==undefined?num_facture:undefined, req.params.id]
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
    const { ref, designation, fournisseur, ref_fournisseur, pxht, stock, stock_alerte, stock_actif } = req.body;
    if (!ref || !designation) return res.status(400).json({ error: 'ref et designation requis' });
    const r = await db.run(
      'INSERT INTO catalogue (ref,designation,fournisseur,ref_fournisseur,pxht,stock,stock_alerte,stock_actif) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [ref, designation, fournisseur||null, ref_fournisseur||null, pxht||0, stock||0, stock_alerte||2, stock_actif!==false]
    );
    res.status(201).json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/catalogue/:id', async (req, res) => {
  try {
    const { ref, designation, fournisseur, ref_fournisseur, pxht, stock, stock_alerte, stock_actif } = req.body;
    const r = await db.run(
      'UPDATE catalogue SET ref=$1,designation=$2,fournisseur=$3,ref_fournisseur=$4,pxht=$5,stock=$6,stock_alerte=$7,stock_actif=$8,updated_at=NOW() WHERE id=$9 RETURNING *',
      [ref, designation, fournisseur, ref_fournisseur, pxht, stock, stock_alerte||2, stock_actif!==false, req.params.id]
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
        (SELECT COUNT(*)::int FROM catalogue WHERE stock<=stock_alerte AND stock_actif=true) AS pieces_alerte,
        (SELECT COUNT(*)::int FROM interventions WHERE envoi_numero IS NOT NULL AND envoi_numero!='' AND (retour_numero IS NULL OR retour_numero='') AND statut!='Fermé') AS expeditions_cours
    `);
    const recentes = await db.all(
      `SELECT i.*,f.modele,f.serie,c.nom AS client_nom FROM interventions i
       JOIN fauteuils f ON f.id=i.fauteuil_id JOIN clients c ON c.id=i.client_id
       ORDER BY i.updated_at DESC LIMIT 8`
    );
    const par_mois = await db.all(
      `SELECT to_char(mois_serie,'YYYY-MM') AS mois,
        COALESCE(COUNT(i.id),0)::int AS total,
        COALESCE(SUM(CASE WHEN i.garantie THEN 1 ELSE 0 END),0)::int AS garantie,
        COALESCE(SUM(CASE WHEN i.garantie=false THEN 1 ELSE 0 END),0)::int AS hors_garantie
       FROM generate_series(
         date_trunc('month', NOW() - INTERVAL '11 months'),
         date_trunc('month', NOW()),
         INTERVAL '1 month'
       ) AS mois_serie
       LEFT JOIN interventions i
         ON to_char(i.date::date,'YYYY-MM') = to_char(mois_serie,'YYYY-MM')
       GROUP BY mois_serie ORDER BY mois_serie`
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
router.get('/export/excel', adminOnly, async (req, res) => {
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
    if (type === 'commandes' || type === 'complet') {
      const cmds = await db.all(`SELECT cmd.*, c.nom AS client_nom FROM commandes cmd LEFT JOIN clients c ON c.id=cmd.client_id ORDER BY cmd.date_commande DESC`);
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(cmds.map(cm => ({
        'Année': cm.annee_onglet, 'Groupe': cm.groupe || '', 'Distributeur': cm.distributeur_nom,
        'Modèle': cm.modele || '', 'Quantité': cm.quantite || 1, 'Accessoire': cm.accessoire || '', 'Bdc': cm.bdc || '',
        'Date commande': cm.date_commande || '', 'Client final': cm.client_final || '',
        'N° suivi': cm.num_suivi || '', 'Date livraison': cm.date_livraison || '',
        'N° série': cm.num_serie || '', 'Facture': cm.num_facture || '', 'Informations': cm.informations || ''
      }))), 'Commandes');
    }
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="sav_eloflex_${new Date().toISOString().slice(0,10)}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PARAMÈTRES ────────────────────────────────────────────────────

// Statut Cloudinary
router.get('/parametres/cloudinary-status', (req, res) => {
  const configured = !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
  res.json({ configured, cloud_name: process.env.CLOUDINARY_CLOUD_NAME || null });
});

router.get('/parametres', adminOnly, async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM parametres');
    const obj = {};
    rows.forEach(r => { if (r.cle !== 'smtp_pass') obj[r.cle] = r.valeur; });
    res.json(obj);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/parametres', adminOnly, async (req, res) => {
  try {
    const pgClient = await db.pool.connect();
    try {
      await pgClient.query('BEGIN');
      for (const [k, v] of Object.entries(req.body)) {
        const val = (v === null || v === undefined) ? '' : String(v);
        await pgClient.query('INSERT INTO parametres (cle,valeur) VALUES ($1,$2) ON CONFLICT (cle) DO UPDATE SET valeur=EXCLUDED.valeur', [k, val]);
      }
      await pgClient.query('COMMIT');
      // Log email relance fields for debug
      const relUser = req.body.email_smtp_user_relance;
      const relFrom = req.body.email_from_relance;
      if(relUser || relFrom) console.log('[PARAMS] Relance saved - user:', relUser||'vide', 'from:', relFrom||'vide');
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

// Sync historique complet VosFactures — tourne en arrière-plan
let SYNC_HISTORIQUE_STATUS = { running: false, progress: '', started_at: null, done: false, results: null, error: null };

router.post('/vosfactures/sync-historique', adminOnly, async (req, res) => {
  const token = process.env.VOSFACTURES_API_TOKEN, account = process.env.VOSFACTURES_ACCOUNT;
  if (!token || !account) return res.status(503).json({ error: 'VosFactures non configuré' });
  if (SYNC_HISTORIQUE_STATUS.running) return res.json({ ok: true, already_running: true, status: SYNC_HISTORIQUE_STATUS });

  // Répondre immédiatement — la sync tourne en arrière-plan
  SYNC_HISTORIQUE_STATUS = { running: true, progress: 'Démarrage…', started_at: new Date().toISOString(), done: false, results: null, error: null };
  res.json({ ok: true, background: true, status: SYNC_HISTORIQUE_STATUS });

  // Lancer en arrière-plan
  (async () => {
    try {
      const { syncClients, syncProducts, syncInvoicesHistorique, syncCommandesHistorique } = require('../scripts/sync-vosfactures');
      const results = {};
      SYNC_HISTORIQUE_STATUS.progress = 'Sync clients…';
      try { results.clients  = await syncClients();  } catch(e) { results.clients  = `Erreur: ${e.message}`; }
      SYNC_HISTORIQUE_STATUS.progress = 'Sync produits…';
      try { results.products = await syncProducts(); } catch(e) { results.products = `Erreur: ${e.message}`; }
      SYNC_HISTORIQUE_STATUS.progress = 'Analyse des factures (peut prendre 10-20 min)…';
      try { results.invoices = await syncInvoicesHistorique(); } catch(e) { results.invoices = `Erreur: ${e.message}`; }
      SYNC_HISTORIQUE_STATUS.progress = 'Analyse des bons de commande…';
      try { results.commandes = await syncCommandesHistorique(); } catch(e) { results.commandes = `Erreur: ${e.message}`; }
      SYNC_HISTORIQUE_STATUS = { running: false, done: true, progress: 'Terminé', results, started_at: SYNC_HISTORIQUE_STATUS.started_at, finished_at: new Date().toISOString(), error: null };
      console.log('[SYNC HISTORIQUE] Terminée :', JSON.stringify(results));
    } catch(e) {
      SYNC_HISTORIQUE_STATUS = { running: false, done: true, progress: 'Erreur', results: null, error: e.message, started_at: SYNC_HISTORIQUE_STATUS.started_at };
      console.error('[SYNC HISTORIQUE] Erreur :', e.message);
    }
  })();
});

// Statut de la sync historique
router.get('/vosfactures/sync-historique/status', (req, res) => {
  res.json(SYNC_HISTORIQUE_STATUS);
});

// Factures VosFactures liées à un fauteuil (via l'API VF en live)
router.get('/fauteuils/:id/factures-vf', async (req, res) => {
  try {
    const f = await db.get('SELECT serie, num_facture, vf_facture_id FROM fauteuils WHERE id=$1', [req.params.id]);
    if (!f) return res.status(404).json({ error: 'Fauteuil introuvable' });
    if (!process.env.VOSFACTURES_API_TOKEN) return res.json({ factures: [], configured: false });

    const axios = require('axios');
    const vfApi = axios.create({
      baseURL: `https://${process.env.VOSFACTURES_ACCOUNT}.vosfactures.fr`,
      headers: { 'Accept': 'application/json' },
      params:  { api_token: process.env.VOSFACTURES_API_TOKEN }
    });

    const SERIE_RE = new RegExp(
      '\\b(' + (f.serie || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')\\b', 'i'
    );

    const factures = [];

    // Stratégie 1 : si on a un numéro de facture direct, le récupérer
    if (f.num_facture) {
      try {
        const { data } = await vfApi.get('/invoices.json', {
          params: { number: f.num_facture, per_page: 5 }
        });
        if (Array.isArray(data)) {
          data.forEach(inv => {
            if (!factures.find(x => x.id === inv.id)) {
              factures.push({
                id: inv.id,
                numero: inv.number,
                date: inv.issue_date || inv.sell_date,
                client_nom: inv.buyer_name,
                montant_ttc: inv.price_gross,
                statut: inv.payment_status,
                url: `https://${process.env.VOSFACTURES_ACCOUNT}.vosfactures.fr/invoices/${inv.id}`,
                source: 'numero_direct'
              });
            }
          });
        }
      } catch(e) { console.warn('Facture par numéro :', e.message); }
    }

    // Stratégie 2 : recherche par numéro de série dans les descriptions
    if (f.serie && factures.length === 0) {
      try {
        // Chercher dans les descriptions de lignes (search_in=positions)
        const { data } = await vfApi.get('/invoices.json', {
          params: { search: f.serie, search_in: 'positions', per_page: 50 }
        });
        if (Array.isArray(data)) {
          for (const inv of data) {
            // Vérifier que la série est vraiment dans ce document (pas juste un faux positif)
            let confirmed = false;
            try {
              const { data: detail } = await vfApi.get(`/invoices/${inv.id}.json`);
              const positions = detail.positions || detail.invoice_items || [];
              const texte = [
                detail.description || '',
                ...positions.map(p => `${p.name || ''} ${p.description || ''}`)
              ].join(' ');
              confirmed = SERIE_RE.test(texte);
            } catch(e) { confirmed = true; } // En cas d'erreur, inclure quand même

            if (confirmed && !factures.find(x => x.id === inv.id)) {
              factures.push({
                id: inv.id,
                numero: inv.number,
                date: inv.issue_date || inv.sell_date,
                client_nom: inv.buyer_name,
                montant_ttc: inv.price_gross,
                statut: inv.payment_status,
                url: `https://${process.env.VOSFACTURES_ACCOUNT}.vosfactures.fr/invoices/${inv.id}`,
                source: 'recherche_serie'
              });
            }
          }
        }
      } catch(e) { console.warn('Recherche série dans factures :', e.message); }
    }

    // Trier par date décroissante
    factures.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    res.json({ factures, serie: f.serie, num_facture: f.num_facture, configured: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/vosfactures/sync', adminOnly, async (req, res) => {
  const token = process.env.VOSFACTURES_API_TOKEN, account = process.env.VOSFACTURES_ACCOUNT;
  if (!token || !account) return res.status(503).json({ error: 'VosFactures non configuré' });
  try {
    const { syncClients, syncProducts, syncInvoices, syncCommandesVF } = require('../scripts/sync-vosfactures');
    const results = {};
    try { results.clients  = await syncClients();  } catch(e) { results.clients  = `Erreur: ${e.message}`; }
    try { results.products = await syncProducts(); } catch(e) { results.products = `Erreur: ${e.message}`; }
    try { results.invoices = await syncInvoices(); } catch(e) { results.invoices = `Erreur: ${e.message}`; }
    try { results.commandes = await syncCommandesVF(); } catch(e) { results.commandes = `Erreur: ${e.message}`; }
    res.json({ ok: true, results, synced_at: new Date().toISOString() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Sync rapide des seuls bons de commande (depuis l'écran Suivi commandes)
router.post('/vosfactures/sync-commandes', async (req, res) => {
  const token = process.env.VOSFACTURES_API_TOKEN, account = process.env.VOSFACTURES_ACCOUNT;
  if (!token || !account) return res.status(503).json({ error: 'VosFactures non configuré' });
  try {
    const { syncCommandesVF } = require('../scripts/sync-vosfactures');
    const message = await syncCommandesVF(req.query.historique === '1');
    res.json({ ok: true, message, synced_at: new Date().toISOString() });
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





// ── FUSION DE CLIENTS ─────────────────────────────────────────────
// Fusionner client_source dans client_cible (rattacher fauteuils + interventions)
router.post('/clients/:id/fusionner', async (req, res) => {
  const { client_source_id, vf_ignore_source } = req.body;
  const clientCibleId  = parseInt(req.params.id);
  const clientSourceId = parseInt(client_source_id);
  if (!clientSourceId || clientSourceId === clientCibleId)
    return res.status(400).json({ error: 'IDs invalides' });

  const pgClient = await db.pool.connect();
  try {
    await pgClient.query('BEGIN');

    // Rattacher tous les fauteuils du client source vers le client cible
    const { rowCount: fauteuils } = await pgClient.query(
      'UPDATE fauteuils SET client_id=$1, updated_at=NOW() WHERE client_id=$2',
      [clientCibleId, clientSourceId]
    );

    // Rattacher toutes les interventions du client source vers le client cible
    const { rowCount: interventions } = await pgClient.query(
      'UPDATE interventions SET client_id=$1, updated_at=NOW() WHERE client_id=$2',
      [clientCibleId, clientSourceId]
    );

    // Marquer le client source comme ignoré par la sync VF (si demandé)
    if (vf_ignore_source) {
      await pgClient.query(
        'UPDATE clients SET vf_ignore=TRUE, updated_at=NOW() WHERE id=$1',
        [clientSourceId]
      );
    }

    // Supprimer le client source (maintenant vide)
    await pgClient.query('DELETE FROM clients WHERE id=$1', [clientSourceId]);

    await pgClient.query('COMMIT');
    res.json({ ok: true, fauteuils_transferes: fauteuils, interventions_transferees: interventions });
  } catch(e) {
    await pgClient.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { pgClient.release(); }
});

// Marquer un client comme ignoré par la sync VF (sans le supprimer)
router.post('/clients/:id/vf-ignore', async (req, res) => {
  try {
    const { ignore } = req.body;
    await db.run(
      'UPDATE clients SET vf_ignore=$1, updated_at=NOW() WHERE id=$2',
      [!!ignore, req.params.id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── RECHERCHE RAPIDE (dashboard) ──────────────────────────────────
router.get('/recherche', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.json({ fauteuils: [], clients: [], commandes: [] });

    // Vérifier d'abord si la saisie correspond exactement à un numéro de série
    const exactSerie = await db.get(`
      SELECT DISTINCT f.*, c.nom AS client_nom, c.id AS client_id,
        (SELECT COUNT(*)::int FROM interventions i WHERE i.fauteuil_id=f.id) AS nb_interventions,
        (SELECT cmd.id FROM commandes cmd WHERE cmd.num_serie=f.serie LIMIT 1) AS commande_id
      FROM fauteuils f JOIN clients c ON c.id=f.client_id
      WHERE LOWER(f.serie) = LOWER($1)
    `, [q]);

    const fauteuils = exactSerie
      ? [exactSerie]  // Correspondance exacte : on n'affiche que celle-là
      : await db.all(`
          SELECT DISTINCT f.*, c.nom AS client_nom, c.id AS client_id,
            (SELECT COUNT(*)::int FROM interventions i WHERE i.fauteuil_id=f.id) AS nb_interventions,
            (SELECT cmd.id FROM commandes cmd WHERE cmd.num_serie=f.serie LIMIT 1) AS commande_id
          FROM fauteuils f JOIN clients c ON c.id=f.client_id
          LEFT JOIN interventions iv ON iv.fauteuil_id=f.id
          WHERE f.modele ILIKE $1 OR c.nom ILIKE $1 OR iv.num_sav ILIKE $1
             OR f.serie ILIKE $1
          ORDER BY f.updated_at DESC LIMIT 50
        `, [`%${q}%`]);

    const clients = await db.all(`
      SELECT c.*, COUNT(f.id)::int AS nb_fauteuils
      FROM clients c LEFT JOIN fauteuils f ON f.client_id=c.id
      WHERE c.nom ILIKE $1
      GROUP BY c.id ORDER BY c.nom LIMIT 10
    `, [`%${q}%`]);

    const commandes = await db.all(`
      SELECT cmd.id, cmd.bdc, cmd.num_facture, cmd.num_serie, cmd.modele,
             cmd.distributeur_nom, cmd.date_commande, cmd.statut, cmd.modele_demo,
             cmd.num_suivi, cmd.date_livraison, cmd.reliquat
      FROM commandes cmd
      WHERE cmd.bdc ILIKE $1 OR cmd.num_facture ILIKE $1
         OR cmd.num_serie ILIKE $1 OR cmd.distributeur_nom ILIKE $1
         OR cmd.num_bordereau ILIKE $1
      ORDER BY cmd.date_commande DESC LIMIT 50
    `, [`%${q}%`]);

    res.json({ fauteuils, clients, commandes });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Import historique commandes depuis fichier Excel comptabilité (sans shell Render) ──
router.post('/import/commandes-excel', adminOnly, uploadExcel.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fichier requis' });
  try {
    const XLSX   = require('xlsx');
    const crypto = require('crypto');

    function normDate(raw) {
      if (!raw) return null;
      if (raw instanceof Date) { if (isNaN(raw.getTime())) return null; return raw.toISOString().substring(0,10); }
      const s = String(raw).trim(); if (!s||s==='-') return null;
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0,10);
      const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
      const d = new Date(s);
      if (!isNaN(d.getTime()) && d.getFullYear()>2009 && d.getFullYear()<2030) return d.toISOString().substring(0,10);
      return null;
    }
    const clean = v => { if (v==null) return null; const s=String(v).replace(/\xa0/g,' ').replace(/_x000D_/g,' ').trim(); return (!s||s==='-')?null:s; };
    const nomClean = raw => raw?String(raw).replace(/\s*\(essai\)|\s*\(P\)|\s*\(demo\)/gi,'').replace(/\xa0/g,' ').trim():null;
    function getColMap(header) {
      const h = header.map(v=>v?String(v).toLowerCase().trim():'');
      const find = (...keys) => { for (const k of keys) { const i=h.findIndex(v=>v.includes(k)); if (i>=0) return i; } return -1; };
      return { groupe:find('groupe'), distrib:find('distributeur'), email:find('email','mail'), tel:find('téléphone','telephone'),
        modele:find('modèle','modele'), accessoire:find('accessoire'), bdc:find('bdc'), date:find('date'),
        order:find('order'), client:find('client'), suivi:find('n° suivi','suivi'), livraison:find('livraison'),
        serie:find('n° de série','série','serie'), facture:find('facture'), invoicese:find('invoice se'), info:find('information') };
    }
    const importKey = (annee,bdc,distrib,serie,date) =>
      crypto.createHash('md5').update(`${annee}|${bdc||''}|${distrib||''}|${serie||''}|${date||''}`).digest('hex');

    const wb = XLSX.read(req.file.buffer, { type:'buffer', cellDates:true });
    const YEAR_SHEETS = wb.SheetNames.filter(s=>/^\d{4}$/.test(s)).sort();
    if (!YEAR_SHEETS.length) return res.status(400).json({ error: 'Aucun onglet année (2019, 2020, ...) trouvé dans le fichier.' });

    const stats = { lignes:0, inserees:0, maj:0, ignorees:0, clients_crees:0, erreurs:0, par_annee:{}, premiere_erreur:null };

    // Pré-charger les clients existants
    const existingClients = await db.all('SELECT id, LOWER(TRIM(nom)) AS nom_norm FROM clients');
    const clientCache = new Map();
    for (const r of existingClients) clientCache.set(r.nom_norm, r.id);

    for (const year of YEAR_SHEETS) {
      const ws = wb.Sheets[year];
      const rows = XLSX.utils.sheet_to_json(ws, { header:1, defval:null, raw:false, dateNF:'yyyy-mm-dd' });
      if (!rows.length) continue;
      const colMap = getColMap(rows[0]);
      let yearCount = 0;

      for (let i=1; i<rows.length; i++) {
        const row = rows[i]; if (!row||!row.some(v=>v)) continue;
        stats.lignes++;
        const get = idx => idx>=0?clean(row[idx]):null;
        const distribRaw = get(colMap.distrib);
        if (!distribRaw) { stats.ignorees++; continue; }
        const distribNom = nomClean(distribRaw);
        if (!distribNom) { stats.ignorees++; continue; }
        const nomNorm    = distribNom.toLowerCase();
        const groupe=get(colMap.groupe), modele=get(colMap.modele), accessoire=get(colMap.accessoire);
        const bdc=get(colMap.bdc), dateCmd=normDate(get(colMap.date)), vfOrderId=get(colMap.order);
        const clientFinal=get(colMap.client), numSuivi=get(colMap.suivi), dateLivr=normDate(get(colMap.livraison));
        const numSerie=get(colMap.serie), numFacture=get(colMap.facture), invoiceSe=get(colMap.invoicese), info=get(colMap.info);

        // Retrouver ou créer le client
        let clientId = clientCache.get(nomNorm);
        if (!clientId) {
          try {
            const r = await db.run(
              `INSERT INTO clients (nom,email,tel,type,token_portail) VALUES ($1,$2,$3,'Distributeur',md5(random()::text)) RETURNING id`,
              [distribNom, get(colMap.email), get(colMap.tel)]
            );
            clientId = r.id; clientCache.set(nomNorm, clientId); stats.clients_crees++;
          } catch(e) {
            // Si conflict sur nom, récupérer l'existant
            try { const ex = await db.get('SELECT id FROM clients WHERE LOWER(TRIM(nom))=$1',[nomNorm]); if (ex) { clientId=ex.id; clientCache.set(nomNorm,clientId); } } catch(_){}
            if (!clientId) { stats.erreurs++; if (!stats.premiere_erreur) stats.premiere_erreur=`Client "${distribNom}": ${e.message}`; continue; }
          }
        }

        // Chercher le fauteuil lié par série
        let fauteuilId = null;
        if (numSerie) {
          try { const f = await db.get('SELECT id FROM fauteuils WHERE serie=$1',[numSerie]); if (f) fauteuilId=f.id; } catch(_){}
        }

        const key = importKey(year,bdc,distribNom,numSerie,dateCmd);
        try {
          const r = await db.run(
            `INSERT INTO commandes (client_id,fauteuil_id,annee_onglet,groupe,distributeur_nom,modele,accessoire,
              bdc,date_commande,vf_order_id,client_final,num_suivi,date_livraison,num_serie,num_facture,invoice_se,informations,import_key)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
             ON CONFLICT (import_key) DO UPDATE SET
               num_suivi=EXCLUDED.num_suivi, date_livraison=EXCLUDED.date_livraison,
               num_facture=EXCLUDED.num_facture, informations=EXCLUDED.informations,
               fauteuil_id=COALESCE(commandes.fauteuil_id,EXCLUDED.fauteuil_id), updated_at=NOW()
             RETURNING id, (xmax=0) AS inserted`,
            [clientId,fauteuilId,parseInt(year),groupe,distribNom,modele,accessoire,
             bdc,dateCmd,vfOrderId,clientFinal,numSuivi,dateLivr,numSerie,numFacture,invoiceSe,info,key]
          );
          if (r && r.inserted) { stats.inserees++; yearCount++; } else { stats.maj++; }
        } catch(e) {
          stats.erreurs++;
          if (!stats.premiere_erreur) stats.premiere_erreur = `Ligne ${i+1} (${distribNom} / ${year}): ${e.message}`;
        }
      }
      stats.par_annee[year] = yearCount;
    }
    res.json({ ok:true, annees:YEAR_SHEETS, stats });
  } catch(e) {
    res.status(500).json({ error: e.message, stack: e.stack?.split('\n').slice(0,3).join(' | ') });
  }
});

// ── IMPORT EXCEL (upload depuis l'interface) ───────────────────────
router.post('/import/excel', uploadExcel.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fichier requis' });
  try {
    const XLSX = require('xlsx');
    // Lire depuis le buffer mémoire (memoryStorage)
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const YEAR_SHEETS = wb.SheetNames.filter(s => /^\d{4}$/.test(s)).sort();

    let stats = { clients: 0, fauteuils: 0, doublons: 0, ignores: 0, erreurs: 0 };
    const SERIE_RE = /\b(EL\d{6,}|A\d{2}L?\d{10,}|DE\d{2,}L?\d{10,}|T\d{10,}|A\d{12,}|\d{9,12}[A-Z]?)\b/gi;

    function normaliserModele(raw) {
      if (!raw) return null;
      const s = String(raw).replace(/\xa0/g,'').trim();
      if (!s || s==='-') return null;
      const MAP = {'L+':'Eloflex L+','L':'Eloflex L','F':'Eloflex F','D2':'Eloflex D2','X':'Eloflex X','P':'Eloflex P','H':'Eloflex H','C':'Eloflex C','C3':'Eloflex C3','K':'Eloflex K','R':'Eloflex R','S1':'Eloflex S1','M+':'Eloflex M+','W':'Eloflex W'};
      for (const [k,v] of Object.entries(MAP)) { if (s.toUpperCase().startsWith(k.toUpperCase())) return v; }
      return `Eloflex ${s.split(/[\s\-\/\(]/)[0]}`.substring(0,40);
    }

    function extraireSeries(raw) {
      if (!raw || String(raw).trim()==='-') return [];
      const s = String(raw).replace(/_x000D_/g,' ').replace(/\r?\n/g,' ').trim();
      if (!s||s==='-') return [];
      const found=[]; let m; const re = new RegExp(SERIE_RE.source, 'gi');
      while((m=re.exec(s))!==null){const sr=m[1].trim().replace(/[_\s]+$/,'');if(sr.length>=6&&!found.includes(sr))found.push(sr);}
      if(!found.length&&s.length>=6&&s!=='-'&&!/^\d{4,5}$/.test(s)){
        s.split(/\s+[-–]\s+|\s{2,}|,/).map(p=>p.trim()).filter(p=>p.length>=6&&p!=='-').forEach(p=>{if(!found.includes(p))found.push(p.substring(0,30));});
      }
      return found;
    }

    function getColMap(header) {
      const h = header.map(v=>v?String(v).toLowerCase().trim():'');
      const find=(...keys)=>{for(const k of keys){const i=h.findIndex(v=>v.includes(k));if(i>=0)return i;}return -1;};
      return {
        distrib:  find('distributeur'),
        email:    find('email','mail'),
        tel:      find('téléphone','telephone'),
        modele:   find('modèle','modele'),
        date_bdc: find('date'),         // Date du bon de commande
        livraison:find('livraison'),    // Date de livraison
        serie:    find('série','serie'),
        facture:  find('facture')
      };
    }

    // Convertir une date Excel (objet Date ou string ISO) en YYYY-MM-DD
    // Rejeter les dates antérieures à 2010 (numéros de BDC interprétés comme dates)
    function toISODate(val) {
      if (!val) return null;
      if (val instanceof Date) {
        const iso = val.toISOString().substring(0, 10);
        const year = parseInt(iso.substring(0, 4));
        // Rejeter les dates aberrantes (< 2010 ou > aujourd'hui + 2 ans)
        if (year < 2010 || year > new Date().getFullYear() + 2) return null;
        return iso;
      }
      const s = String(val).trim();
      // Format ISO déjà correct
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
        const year = parseInt(s.substring(0, 4));
        if (year < 2010 || year > new Date().getFullYear() + 2) return null;
        return s.substring(0, 10);
      }
      // Format DD-Mon ou DD-Mon-YY → ignorer (pas d'année fiable)
      return null;
    }

    const pgClient = await db.pool.connect();
    try {
      for (const year of YEAR_SHEETS) {
        const ws = wb.Sheets[year];
        const rows = XLSX.utils.sheet_to_json(ws, {header:1, defval:null, raw:true});
        if(!rows.length) continue;
        const colMap = getColMap(rows[0]);

        for (let i=1;i<rows.length;i++) {
          const row=rows[i];
          if(!row||!row.some(v=>v)) continue;
          const get=(idx)=>{
            if(idx<0||row[idx]===null||row[idx]===undefined) return null;
            if(row[idx] instanceof Date) return row[idx].toISOString().substring(0,10);
            return String(row[idx]).replace(/\xa0/g,'').trim()||null;
          };
          const distribNom=get(colMap.distrib); const serieRaw=get(colMap.serie);
          const modeleRaw=get(colMap.modele);
          const factureNum=get(colMap.facture); const email=get(colMap.email); const tel=get(colMap.tel);
          if(!distribNom||distribNom==='-'){stats.ignores++;continue;}
          const series=extraireSeries(serieRaw);
          if(!series.length){stats.ignores++;continue;}
          const modele=normaliserModele(modeleRaw);

          // Client
          let clientId;
          try {
            const nomClean=distribNom.replace(/\s*\(essai\)|\s*\(P\)|\s*\(demo\)/gi,'').trim();
            const ex=await pgClient.query('SELECT id FROM clients WHERE LOWER(TRIM(nom))=LOWER($1)',[nomClean]);
            if(ex.rows.length){
              clientId=ex.rows[0].id;
              if(email||tel) await pgClient.query('UPDATE clients SET email=COALESCE(NULLIF(email,\'\'),$1),tel=COALESCE(NULLIF(tel,\'\'),$2),updated_at=NOW() WHERE id=$3',[email,tel,clientId]);
            } else {
              const r=await pgClient.query('INSERT INTO clients (nom,email,tel,type,token_portail) VALUES ($1,$2,$3,$4,md5(random()::text)) RETURNING id',[nomClean,email||null,tel||null,'Distributeur']);
              clientId=r.rows[0].id; stats.clients++;
            }
          } catch(e){
            if(stats.erreurs < 3) console.error('[IMPORT EXCEL] Erreur client:', e.message);
            stats.erreurs++;continue;
          }

          // Fauteuils
          for(const serie of series){
            try {
              const sc=serie.replace(/[_\s]+$/,'').replace(/_x000D_.*$/,'').trim();
              if(sc.length<4) continue;
              // Date d'achat = date BDC (date de commande) en priorité, sinon livraison
              const dateBdc      = get(colMap.date_bdc);
              const dateLivraison= get(colMap.livraison);
              const dateSource   = dateBdc || dateLivraison;
              let dateAchat = toISODate(dateSource);
              // Si pas de date valide, construire une date approximative depuis l'année de l'onglet
              let annee = parseInt(year);
              if (dateAchat) {
                annee = parseInt(dateAchat.substring(0, 4));
              }
              const ex=await pgClient.query('SELECT id FROM fauteuils WHERE serie=$1',[sc]);
              if(ex.rows.length){
                await pgClient.query('UPDATE fauteuils SET client_id=COALESCE(client_id,$1),modele=COALESCE(NULLIF(modele,\'\'),$2),annee=COALESCE(annee,$3),date_achat=COALESCE(date_achat,$4),num_facture=COALESCE(NULLIF(num_facture,\'\'),$5),updated_at=NOW() WHERE serie=$6',[clientId,modele,annee,dateAchat,factureNum,sc]);
                stats.doublons++;
              } else {
                await pgClient.query('INSERT INTO fauteuils (client_id,modele,serie,annee,date_achat,num_facture,duree_garantie_mois) VALUES ($1,$2,$3,$4,$5,$6,24)',[clientId,modele||'Eloflex',sc,annee,dateAchat,factureNum]);
                stats.fauteuils++;
              }
            } catch(e){
              if(!e.message.includes('unique')){
                if(stats.erreurs < 5) console.error('[IMPORT EXCEL] Erreur fauteuil:', e.message);
                stats.erreurs++;
              } else { stats.doublons++; }
            }
          }
        }
      }
    } finally { pgClient.release(); }

    console.log('[IMPORT EXCEL] Résultat:', JSON.stringify(stats));
    res.json({ ok:true, stats, sheets: YEAR_SHEETS });
  } catch(e) { res.status(500).json({ error: e.message }); }
});



// ── RETOURS PIÈCES VERS SUÈDE ─────────────────────────────────────
router.get('/retours-suede', async (req, res) => {
  try {
    const list = await db.all('SELECT * FROM retours_suede ORDER BY created_at DESC');
    res.json(list);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/retours-suede', async (req, res) => {
  try {
    const { num_retour, date_envoi, description, statut, montant, notes, interventions_ids } = req.body;
    const r = await db.run(
      `INSERT INTO retours_suede (num_retour,date_envoi,description,statut,montant,notes,interventions_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [num_retour||null, date_envoi||null, description||null, statut||'En attente',
       parseFloat(montant)||0, notes||null, interventions_ids||null]
    );
    res.status(201).json(r);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/retours-suede/:id', async (req, res) => {
  try {
    const { num_retour, date_envoi, description, statut, montant, notes, interventions_ids } = req.body;
    const r = await db.run(
      `UPDATE retours_suede SET num_retour=$1,date_envoi=$2,description=$3,statut=$4,
       montant=$5,notes=$6,interventions_ids=$7,updated_at=NOW() WHERE id=$8 RETURNING *`,
      [num_retour||null, date_envoi||null, description||null, statut||'En attente',
       parseFloat(montant)||0, notes||null, interventions_ids||null, req.params.id]
    );
    res.json(r);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/retours-suede/:id', async (req, res) => {
  try {
    await db.run('DELETE FROM retours_suede WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── TRANSFERTS FAUTEUILS (modèles d'exposition) ───────────────────
router.get('/transferts', async (req, res) => {
  try {
    const list = await db.all(`
      SELECT tr.*, f.modele, f.serie,
        cd.nom AS client_depart_nom, ca.nom AS client_arrivee_nom
      FROM transferts_fauteuils tr
      LEFT JOIN fauteuils f ON f.id=tr.fauteuil_id
      LEFT JOIN clients cd ON cd.id=tr.client_depart_id
      LEFT JOIN clients ca ON ca.id=tr.client_arrivee_id
      ORDER BY tr.created_at DESC
    `);
    res.json(list);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/transferts/:id', async (req, res) => {
  try {
    const t = await db.get(`
      SELECT tr.*, f.modele, f.serie,
        cd.nom AS client_depart_nom, ca.nom AS client_arrivee_nom
      FROM transferts_fauteuils tr
      LEFT JOIN fauteuils f ON f.id=tr.fauteuil_id
      LEFT JOIN clients cd ON cd.id=tr.client_depart_id
      LEFT JOIN clients ca ON ca.id=tr.client_arrivee_id
      WHERE tr.id=$1
    `, [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Transfert introuvable' });
    res.json(t);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/transferts', async (req, res) => {
  try {
    const { fauteuil_id, client_depart_id, client_arrivee_id, date_depart, date_arrivee,
      transporteur, num_suivi, statut, notes } = req.body;
    if (!fauteuil_id || !client_depart_id || !client_arrivee_id)
      return res.status(400).json({ error: 'Fauteuil, distributeur départ et distributeur arrivée requis' });

    const r = await db.run(
      `INSERT INTO transferts_fauteuils
        (fauteuil_id,client_depart_id,client_arrivee_id,date_depart,date_arrivee,transporteur,num_suivi,statut,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [fauteuil_id, client_depart_id, client_arrivee_id, date_depart||null, date_arrivee||null,
       transporteur||null, num_suivi||null, statut||'En préparation', notes||null]
    );

    // Si le transfert est déjà marqué "Arrivé", mettre à jour le propriétaire du fauteuil
    if (statut === 'Arrivé') {
      await db.run('UPDATE fauteuils SET client_id=$1, updated_at=NOW() WHERE id=$2',
        [client_arrivee_id, fauteuil_id]);
    }

    res.status(201).json(r);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/transferts/:id', async (req, res) => {
  try {
    const { fauteuil_id, client_depart_id, client_arrivee_id, date_depart, date_arrivee,
      transporteur, num_suivi, statut, notes } = req.body;

    const before = await db.get('SELECT statut, fauteuil_id, client_arrivee_id FROM transferts_fauteuils WHERE id=$1', [req.params.id]);

    const r = await db.run(
      `UPDATE transferts_fauteuils SET
        fauteuil_id=$1,client_depart_id=$2,client_arrivee_id=$3,date_depart=$4,date_arrivee=$5,
        transporteur=$6,num_suivi=$7,statut=$8,notes=$9,updated_at=NOW()
       WHERE id=$10 RETURNING *`,
      [fauteuil_id, client_depart_id, client_arrivee_id, date_depart||null, date_arrivee||null,
       transporteur||null, num_suivi||null, statut||'En préparation', notes||null, req.params.id]
    );

    // Si le statut passe à "Arrivé" (transition), rattacher le fauteuil au nouveau distributeur
    if (statut === 'Arrivé' && before?.statut !== 'Arrivé') {
      await db.run('UPDATE fauteuils SET client_id=$1, updated_at=NOW() WHERE id=$2',
        [client_arrivee_id, fauteuil_id]);
    }

    res.json(r);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/transferts/:id', async (req, res) => {
  try {
    await db.run('DELETE FROM transferts_fauteuils WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ENVOI EMAIL NOTIFICATION ──────────────────────────────────────
router.post('/email/notification-intervention', async (req, res) => {
  try {
    const { intervention_id } = req.body;
    const params = {};
    const rows = await db.all('SELECT cle, valeur FROM parametres');
    rows.forEach(r => params[r.cle] = r.valeur);
    if (params.email_notifications !== '1') return res.json({ ok: false, reason: 'Notifications désactivées' });
    if (!params.email_smtp_host || !params.email_smtp_user) return res.json({ ok: false, reason: 'SMTP non configuré' });

    const i = await db.get(`
      SELECT iv.*, c.nom AS client_nom, c.email AS client_email, f.modele, f.serie
      FROM interventions iv
      JOIN clients c ON c.id=iv.client_id
      JOIN fauteuils f ON f.id=iv.fauteuil_id
      WHERE iv.id=$1`, [intervention_id]);
    if (!i || !i.client_email) return res.json({ ok: false, reason: "Pas d'email client" });

    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: params.email_smtp_host, port: parseInt(params.email_smtp_port)||587,
      secure: parseInt(params.email_smtp_port)===465, auth: { user: params.email_smtp_user, pass: params.email_smtp_pass }
    });

    await transporter.sendMail({
      from: params.email_from || params.email_smtp_user,
      to: i.client_email,
      subject: `[SAV Éloflex] ${i.num_sav||'Intervention #'+i.id} — ${i.statut}`,
      html: `<div style="font-family:sans-serif;max-width:520px">
        <h2 style="color:#1a3a5c">SAV Éloflex — Mise à jour</h2>
        <p>Bonjour,</p>
        <p>Votre dossier SAV <strong>${i.num_sav||'#'+i.id}</strong> concernant le fauteuil 
        <strong>${i.modele} (${i.serie})</strong> a été mis à jour.</p>
        <table style="border-collapse:collapse;width:100%;font-size:13px">
          <tr><td style="padding:6px 10px;background:#f5f5f4;font-weight:600">Statut</td><td style="padding:6px 10px">${i.statut}</td></tr>
          <tr><td style="padding:6px 10px;background:#f5f5f4;font-weight:600">Type</td><td style="padding:6px 10px">${i.type}</td></tr>
          <tr><td style="padding:6px 10px;background:#f5f5f4;font-weight:600">Description</td><td style="padding:6px 10px">${i.description||'—'}</td></tr>
        </table>
        <p style="margin-top:16px;font-size:12px;color:#666">Éloflex France — Service Après-Vente</p>
      </div>`
    });
    res.json({ ok: true, to: i.client_email });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── COMMANDES ─────────────────────────────────────────────────────
function isRealTracking(s) {
  if (!s) return false;
  const clean = s.trim().replace(/\s+/g, '');
  return clean.length >= 8 && /\d/.test(clean) && /^[A-Z0-9\-]+$/i.test(clean);
}

function statutCommande(cmd) {
  // Paiement VF prime sur tout (même sur statut manuel Facturé)
  if (cmd.facture_paiement_statut === 'payé') return 'Payé';
  if (cmd.facture_paiement_statut === 'impayé') return 'Impayé';
  // Statut manuel (sauf Auto)
  if (cmd.statut && cmd.statut !== 'Auto') return cmd.statut;
  // Priorité descendante : facture > livraison > expédition > préparation
  if (cmd.num_facture) return 'Facturé';
  if (cmd.date_livraison) return 'Livré';
  if (isRealTracking(cmd.num_suivi)) return 'Expédié';
  // Dès qu'un BDC est renseigné → En préparation (commande reçue)
  return 'En préparation';
}

router.get('/commandes', async (req, res) => {
  try {
    const { distributeur, client_id, statut, annee, groupe, q, date_from, date_to, page = 1, per_page = 100 } = req.query;
    let sql = `SELECT cmd.*, c.nom AS client_nom, c.ville AS client_ville,
               c.edi AS client_edi, cmd.facture_paiement_statut, cmd.facture_date_echeance,
               ROW_NUMBER() OVER (
                 PARTITION BY EXTRACT(YEAR FROM cmd.date_commande::date)
                 ORDER BY cmd.date_commande ASC NULLS LAST, cmd.id ASC
               ) AS num_annuel
               FROM commandes cmd LEFT JOIN clients c ON c.id = cmd.client_id`;
    const conds = [], p = [];
    let idx = 0;
    // Filtre pays : utilisateur avec pays défini → voit uniquement ses commandes
    // Admin global peut filtrer dynamiquement via le paramètre ?pays=
    const userPays = res.locals.user?.pays || req.query.pays || null;
    if (userPays) { conds.push(`(cmd.pays=$${++idx} OR cmd.pays IS NULL)`); p.push(userPays); }
    if (client_id)   { conds.push(`cmd.client_id=$${++idx}`); p.push(client_id); }
    if (distributeur){ conds.push(`cmd.distributeur_nom ILIKE $${++idx}`); p.push(`%${distributeur}%`); }
    if (annee)       { conds.push(`(cmd.annee_onglet=$${++idx} OR (cmd.annee_onglet IS NULL AND EXTRACT(YEAR FROM cmd.date_commande::date)=$${idx}))`); p.push(parseInt(annee)); }
    if (groupe)      { conds.push(`cmd.groupe=$${++idx}`); p.push(groupe); }
    if (date_from)   { conds.push(`cmd.date_commande>=$${++idx}`); p.push(date_from); }
    if (date_to)     { conds.push(`cmd.date_commande<=$${++idx}`); p.push(date_to); }
    if (q) {
      const qq = `%${q}%`;
      conds.push(`(cmd.distributeur_nom ILIKE $${++idx} OR cmd.bdc ILIKE $${idx} OR cmd.num_serie ILIKE $${idx} OR cmd.num_suivi ILIKE $${idx} OR cmd.client_final ILIKE $${idx} OR cmd.num_facture ILIKE $${idx} OR cmd.modele ILIKE $${idx} OR cmd.accessoire ILIKE $${idx})`);
      p.push(qq);
    }
    if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
    sql += ' ORDER BY cmd.date_commande DESC NULLS LAST, cmd.id DESC';
    let rows = await db.all(sql, p);
    rows = rows.map(r => ({ ...r, statut_calc: statutCommande(r) }));
    const mois = req.query.mois ? parseInt(req.query.mois) : null;
    if (mois) { conds.push(`EXTRACT(MONTH FROM cmd.date_commande::date)=$${++idx}`); p.push(mois); }
    const total = rows.length;
    const pp = Math.min(parseInt(per_page) || 100, 500);
    const startIdx = (Math.max(parseInt(page) || 1, 1) - 1) * pp;
    res.json({ total, page: parseInt(page) || 1, per_page: pp, rows: rows.slice(startIdx, startIdx + pp) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/commandes/stats', async (req, res) => {
  try {
    const annee = req.query.annee ? parseInt(req.query.annee) : null;
    const userPays = res.locals.user?.pays || req.query.pays || null;
    const paysFilter = userPays ? `AND (pays = '${userPays.replace(/'/g,"''")}' OR pays IS NULL)` : '';
    const anneeFilter = annee
      ? `(annee_onglet=$1 OR (annee_onglet IS NULL AND EXTRACT(YEAR FROM date_commande::date)=$1)) ${paysFilter}`
      : `TRUE ${paysFilter}`;
    const params = annee ? [annee] : [];

    // Calcul SQL du statut (miroir de la fonction JS statutCommande + isRealTracking)
    const statutExpr = `
      CASE
        WHEN statut IS NOT NULL AND statut != 'Auto' THEN statut
        WHEN date_livraison IS NOT NULL THEN 'Livré'
        WHEN num_suivi IS NOT NULL
          AND LENGTH(REGEXP_REPLACE(num_suivi, '\\s+', '', 'g')) >= 8
          AND REGEXP_REPLACE(num_suivi, '\\s+', '', 'g') ~ '^[A-Z0-9\\-]+$'
          AND REGEXP_REPLACE(num_suivi, '\\s+', '', 'g') ~ '[0-9]'
          THEN 'Expédié'
        ELSE 'En préparation'
      END`;

    // Compteurs filtrés par année
    const counts = await db.get(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN (${statutExpr}) = 'En préparation'          THEN 1 ELSE 0 END) AS en_preparation,
        SUM(CASE WHEN (${statutExpr}) = 'En attente confirmation' THEN 1 ELSE 0 END) AS en_attente,
        SUM(CASE WHEN (${statutExpr}) = 'Expédié'                 THEN 1 ELSE 0 END) AS expedie,
        SUM(CASE WHEN (${statutExpr}) = 'Livré'          THEN 1 ELSE 0 END) AS livre,
        SUM(CASE WHEN (${statutExpr}) = 'Problème'       THEN 1 ELSE 0 END) AS probleme,
        SUM(CASE WHEN (${statutExpr}) = 'Facturé'        THEN 1 ELSE 0 END) AS facture,
        SUM(CASE WHEN modele_demo = TRUE                 THEN 1 ELSE 0 END) AS demo,
        SUM(CASE WHEN modele ILIKE '%eloflex%' AND num_serie IS NOT NULL THEN 1 ELSE 0 END) AS fauteuils_serie
      FROM commandes WHERE ${anneeFilter}
    `, params);

    // Répartition par année (toujours sans filtre pour le menu déroulant)
    const anneeRows = await db.all(`
      SELECT COALESCE(annee_onglet::text, EXTRACT(YEAR FROM date_commande::date)::text) AS annee,
             COUNT(*)::int AS n
      FROM commandes
      WHERE annee_onglet IS NOT NULL OR date_commande IS NOT NULL
      GROUP BY 1 ORDER BY 1 DESC
    `);
    const parAnnee = {};
    anneeRows.forEach(r => { if (r.annee) parAnnee[r.annee] = r.n; });

    res.json({
      total:          parseInt(counts.total)          || 0,
      en_preparation: parseInt(counts.en_preparation) || 0,
      en_attente:     parseInt(counts.en_attente)     || 0,
      expedie:        parseInt(counts.expedie)        || 0,
      livre:          parseInt(counts.livre)          || 0,
      probleme:       parseInt(counts.probleme)       || 0,
      facture:        parseInt(counts.facture)        || 0,
      demo:           parseInt(counts.demo)           || 0,
      fauteuils_serie:parseInt(counts.fauteuils_serie)|| 0,
      par_annee: parAnnee,
      annee_filtre: annee
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/commandes/supprimer-doublons', adminOnly, async (req, res) => {
  try {
    // Trouver tous les groupes de doublons (même bdc + même distributeur)
    const groupes = await db.all(`
      SELECT cmd.bdc, cmd.distributeur_nom,
        array_agg(cmd.id ORDER BY cmd.created_at) AS ids
      FROM commandes cmd
      WHERE cmd.bdc IS NOT NULL AND TRIM(cmd.bdc) != ''
      GROUP BY cmd.bdc, cmd.distributeur_nom
      HAVING COUNT(*) > 1
    `);

    let supprimes = 0;
    for (const g of groupes) {
      const ids = Array.isArray(g.ids) ? g.ids : JSON.parse(g.ids);
      // Charger chaque commande pour scorer
      const rows = await db.all(
        `SELECT id, vf_commande_id, num_suivi, num_serie, date_livraison, num_facture,
                informations, statut, modele_demo, import_key
         FROM commandes WHERE id = ANY($1::int[])`, [ids]
      );

      // Score : retenir la plus complète
      const scored = rows.map(r => ({
        id: r.id,
        score:
          (r.vf_commande_id ? 10 : 0) +
          (r.num_suivi && /\d/.test(r.num_suivi) ? 4 : 0) +
          (r.num_serie ? 3 : 0) +
          (r.date_livraison ? 2 : 0) +
          (r.num_facture ? 2 : 0) +
          (r.informations ? 1 : 0) +
          (r.modele_demo ? 1 : 0) +
          (r.import_key ? 1 : 0)
      })).sort((a, b) => b.score - a.score || b.id - a.id);

      const garder = scored[0].id;
      const aSupprimer = scored.slice(1).map(s => s.id);
      for (const sid of aSupprimer) {
        await db.run('DELETE FROM commandes WHERE id=$1', [sid]);
        supprimes++;
      }
    }
    res.json({ ok: true, supprimes, groupes: groupes.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/commandes/doublons', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT cmd.bdc, cmd.distributeur_nom,
        COUNT(*)::int AS nb,
        array_agg(cmd.id ORDER BY cmd.created_at) AS ids,
        array_agg(cmd.date_commande ORDER BY cmd.created_at) AS dates,
        array_agg(cmd.modele ORDER BY cmd.created_at) AS modeles,
        array_agg(COALESCE(cmd.vf_commande_id::text,'–') ORDER BY cmd.created_at) AS sources
      FROM commandes cmd
      WHERE cmd.bdc IS NOT NULL AND TRIM(cmd.bdc) != ''
      GROUP BY cmd.bdc, cmd.distributeur_nom
      HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC, cmd.bdc
    `);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════
// ── PENNYLANE (intégration parallèle à VosFactures) ───────────────
// ══════════════════════════════════════════════════════════════════

router.get('/pennylane/status', async (req, res) => {
  try {
    if (!process.env.PENNYLANE_TOKEN) return res.json({ configured: false });
    const { checkStatus } = require('../scripts/sync-pennylane');
    const info = await checkStatus();
    res.json({ configured: true, account: info.account });
  } catch(e) { res.json({ configured: false, error: e.message }); }
});

router.post('/pennylane/sync-commandes', adminOnly, async (req, res) => {
  try {
    const { syncCommandesPennylane } = require('../scripts/sync-pennylane');
    const message = await syncCommandesPennylane(req.query.historique === '1');
    res.json({ ok: true, message });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/pennylane/bdc-lookup', async (req, res) => {
  try {
    if (!process.env.PENNYLANE_TOKEN) return res.json({ configured: false });
    const numero = (req.query.numero || '').trim();
    if (!numero) return res.status(400).json({ error: 'numero requis' });
    const { lookupDocumentPennylane } = require('../scripts/sync-pennylane');
    const result = await lookupDocumentPennylane(numero);
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/pennylane/generer-facture/:cmdId', adminOrOp, async (req, res) => {
  try {
    if (!process.env.PENNYLANE_TOKEN) return res.json({ ok: false, reason: 'Pennylane non configuré' });
    const cmd = await db.get(`SELECT cmd.*, c.nom AS client_nom FROM commandes cmd
      JOIN clients c ON c.id=cmd.client_id WHERE cmd.id=$1`, [req.params.cmdId]);
    if (!cmd) return res.status(404).json({ error: 'Commande introuvable' });
    const lignes = await db.all('SELECT * FROM commandes_lignes WHERE commande_id=$1 ORDER BY ordre', [req.params.cmdId]);
    const { genererFacturePennylane } = require('../scripts/sync-pennylane');
    const inv = await genererFacturePennylane(cmd, lignes);
    const numero = inv.invoice_number || String(inv.id);
    await db.run('UPDATE commandes SET num_facture=$1, updated_at=NOW() WHERE id=$2', [numero, req.params.cmdId]);
    const url = `https://app.pennylane.com/companies/invoices/${inv.id}`;
    res.json({ ok: true, invoice_id: inv.id, numero, url });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Fin Pennylane ──────────────────────────────────────────────

// ══════════════════════════════════════════════════════════════════
// ── DEVIS VosFactures ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

router.get('/devis', async (req, res) => {
  try {
    const statut = req.query.statut || 'ouvert';
    const rows = await db.all(
      `SELECT d.*, COUNT(dr.id)::int AS nb_relances_hist
       FROM devis d LEFT JOIN devis_relances dr ON dr.devis_id=d.id
       WHERE d.statut=$1 GROUP BY d.id ORDER BY d.date_devis DESC`,
      [statut]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/devis/sync-vf', adminOnly, async (req, res) => {
  try {
    if (!process.env.VOSFACTURES_API_TOKEN || !process.env.VOSFACTURES_ACCOUNT)
      return res.json({ ok: false, reason: 'VosFactures non configuré' });
    const axios = require('axios');
    const vfApi = axios.create({
      baseURL: `https://${process.env.VOSFACTURES_ACCOUNT}.vosfactures.fr`,
      headers: { 'Accept': 'application/json' },
      params: { api_token: process.env.VOSFACTURES_API_TOKEN }
    });
    const dateMin = new Date(); dateMin.setDate(dateMin.getDate() - 90);
    const dateStr = dateMin.toISOString().slice(0, 10);
    let page = 1, total = 0, created = 0, updated = 0;
    while(true) {
      const { data } = await vfApi.get('/invoices.json', {
        params: { kind: 'estimate', page, per_page: 50, date_from: dateStr, order: 'issue_date.desc' }
      });
      if (!Array.isArray(data) || !data.length) break;
      for (const inv of data) {
        // Toujours récupérer le détail complet pour avoir les montants et lignes
        let detail = inv;
        try {
          const { data: det } = await vfApi.get(`/invoices/${inv.id}.json`);
          if (det && det.id) detail = det;
        } catch(_) {}
        // Fusionner liste + détail (le détail prime)
        const inv2 = { ...inv, ...detail };
        // LOG temporaire pour diagnostic montants (premier devis seulement)
        if (total === 0) {
          console.log('[DEVIS DEBUG] Champs disponibles:', Object.keys(inv2).join(', '));
          console.log('[DEVIS DEBUG] Montants:', JSON.stringify({
            total_price_gross: inv2.total_price_gross,
            total_price_net:   inv2.total_price_net,
            price_gross:       inv2.price_gross,
            price_net:         inv2.price_net,
            total:             inv2.total,
            gross_price:       inv2.gross_price,
            net_price:         inv2.net_price,
            amount:            inv2.amount,
          }));
        }
        // Vérifier si déjà converti en BDC dans VF (statut accepted)
        const statutVF = inv2.status || inv2.payment_status || '';
        const estConverti = statutVF === 'accepted' || statutVF === 'paid';
        // Vérifier si un client_order existe pour ce devis dans nos commandes
        const deja = await db.get('SELECT id FROM commandes WHERE vf_commande_id=$1', [inv2.id]);
        const dejaConvertiLocal = !!deja;
        const statutFinal = estConverti || dejaConvertiLocal ? 'converti' : 'ouvert';
        const lignes = (inv2.positions || []).map(p => ({
          nom: p.name, qte: p.quantity, prix: p.price_net, total: p.total_price_gross
        }));
        await db.run(
          `INSERT INTO devis (vf_id, numero, distributeur_nom, client_email, date_devis, date_expiration,
             montant, devise, statut, vf_statut, lignes, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
           ON CONFLICT (vf_id) DO UPDATE SET
             statut=CASE WHEN devis.statut='ignoré' THEN 'ignoré'
                         WHEN $9='converti' THEN 'converti'
                         ELSE devis.statut END,
             vf_statut=$10, distributeur_nom=$3, client_email=$4,
             montant=$7, lignes=$11, updated_at=NOW()`,
          [inv2.id, inv2.number, inv2.buyer_name, inv2.buyer_email||null,
           (inv2.issue_date||'').slice(0,10), (inv2.payment_to||'').slice(0,10),
           (() => {
             // Champs confirmés par debug VosFactures : price_gross (TTC), price_net (HT)
             const vals = [inv2.price_gross, inv2.price_net, inv2.total_price_gross, inv2.total_price_net, inv2.total];
             for (const v of vals) {
               const n = parseFloat(v);
               if (n > 0) return n;
             }
             // Fallback : sommer les positions
             const pos = inv2.positions || [];
             if (pos.length) {
               const s = pos.reduce((acc, p) => {
                 const pv = [p.total_price_gross, p.price_gross, p.total_price_net, p.price_net];
                 for (const v of pv) { const n = parseFloat(v); if (n > 0) return acc + n; }
                 return acc;
               }, 0);
               if (s > 0) return s;
             }
             return 0;
           })(), inv2.currency||'EUR',
           statutFinal, statutVF, JSON.stringify(lignes)]
        );
        total++; if(dejaConvertiLocal || estConverti) updated++; else created++;
      }
      if (data.length < 50) break;
      page++;
    }
    res.json({ ok: true, total, created, updated });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/devis/:id/statut', adminOrOp, async (req, res) => {
  try {
    const { statut, notes } = req.body;
    await db.run('UPDATE devis SET statut=$1, notes=COALESCE($2,notes), updated_at=NOW() WHERE id=$3',
      [statut, notes||null, req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/devis/:id/relances', async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM devis_relances WHERE devis_id=$1 ORDER BY date_envoi DESC', [req.params.id]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/devis/:id/relance', adminOrOp, async (req, res) => {
  try {
    const params = {}; const prows = await db.all('SELECT cle, valeur FROM parametres');
    prows.forEach(p => params[p.cle] = p.valeur);
    if (!params.email_smtp_host) return res.json({ ok: false, reason: 'SMTP non configuré' });
    const devis = await db.get('SELECT * FROM devis WHERE id=$1', [req.params.id]);
    if (!devis) return res.status(404).json({ error: 'Devis introuvable' });
    const email = req.body.email || devis.client_email;
    if (!email) return res.json({ ok: false, reason: 'Pas d\'email pour ce distributeur' });
    // lignes est JSONB → déjà un objet JS, pas besoin de JSON.parse
    const lignes = Array.isArray(devis.lignes) ? devis.lignes
                 : (typeof devis.lignes === 'string' ? JSON.parse(devis.lignes || '[]') : []);
    const jours = Math.round((Date.now() - new Date(devis.date_devis).getTime()) / 86400000);
    const nodemailer = require('nodemailer');
    // Vérifier que tous les paramètres SMTP sont présents
    // Utiliser le compte relance dédié si configuré, sinon fallback sur le compte SAV
    // API Brevo HTTP (SMTP bloqué par Render)
    const axios = require('axios');
    const brevoKey = process.env.BREVO_API_KEY || params.brevo_api_key;
    const fromAddr = params.email_from_relance || params.email_from || 'info@eloflex.fr';
    console.log('[EMAIL RELANCE] Brevo API → to:', email, 'from:', fromAddr);
    if (!brevoKey) {
      return res.json({ ok: false, reason: 'Clé API Brevo manquante — ajoutez BREVO_API_KEY dans Render' });
    }
    // Récupérer le PDF du devis depuis VosFactures
    let pdfAttachment = null;
    if (process.env.VOSFACTURES_API_TOKEN && process.env.VOSFACTURES_ACCOUNT && devis.vf_id) {
      try {
        const pdfResp = await axios.get(
          `https://${process.env.VOSFACTURES_ACCOUNT}.vosfactures.fr/invoices/${devis.vf_id}.pdf`,
          { params: { api_token: process.env.VOSFACTURES_API_TOKEN }, responseType: 'arraybuffer', timeout: 10000 }
        );
        pdfAttachment = {
          name: `Devis-${devis.numero}.pdf`,
          content: Buffer.from(pdfResp.data).toString('base64')
        };
        console.log('[PDF] Devis PDF récupéré:', pdfAttachment.name);
      } catch(pdfErr) {
        console.warn('[PDF] Impossible de récupérer le PDF:', pdfErr.message);
      }
    }

    const vfUrl = `https://${process.env.VOSFACTURES_ACCOUNT}.vosfactures.fr/invoices/${devis.vf_id}`;

    await axios.post('https://api.brevo.com/v3/smtp/email', {
      sender: { name: 'Éloflex France', email: fromAddr },
      to: [{ email }],
      cc: [{ email: params.email_cc_relance || 'info@eloflex.fr' }],
      subject: `[Éloflex] Relance devis ${devis.numero}`,
      ...(pdfAttachment ? { attachment: [pdfAttachment] } : {}),
      htmlContent: `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#EEF2F7;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#EEF2F7;padding:32px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;border-radius:10px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.10);">

  <!-- HEADER -->
  <tr><td style="background:#1F3A5F;padding:28px 36px;">
    <img src="https://sensode.com/eloflex/wp-content/uploads/logo-signature.png" alt="Eloflex" width="160" style="display:block;border:0;margin-bottom:16px;">
    <div style="color:#ffffff;font-size:22px;font-weight:bold;">Relance devis</div>
    <div style="color:#A8C4E0;font-size:13px;margin-top:4px;">Devis n° ${devis.numero} — ${new Date(devis.date_devis).toLocaleDateString('fr-FR')}</div>
  </td></tr>

  <!-- BODY -->
  <tr><td style="background:#ffffff;padding:32px 36px;">
    <p style="margin:0 0 14px;font-size:15px;color:#222222;">Bonjour,</p>
    <p style="margin:0 0 14px;font-size:15px;color:#222222;line-height:1.6;">Nous revenons vers vous concernant notre devis <strong style="color:#1F3A5F;">${devis.numero}</strong> établi le <strong>${new Date(devis.date_devis).toLocaleDateString('fr-FR')}</strong> (il y a ${jours} jour${jours>1?'s':''}).</p>
    <p style="margin:0 0 8px;font-size:15px;color:#222222;">Ce devis n'a pas été validé ou signé.</p>
    <p style="margin:0 0 24px;font-size:15px;color:#222222;">L'avez-vous bien reçu, est-il toujours d'actualité ?</p>

    <!-- TABLEAU -->
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin-bottom:24px;border-radius:6px;overflow:hidden;">
      <tr style="background:#1F3A5F;"><td colspan="2" style="padding:10px 16px;font-size:11px;font-weight:bold;color:#fff;text-transform:uppercase;letter-spacing:0.5px;">Récapitulatif du devis</td></tr>
      <tr style="background:#F5F8FC;"><td style="padding:10px 16px;font-size:13px;font-weight:bold;color:#555;border-bottom:1px solid #E3EAF3;width:150px;">N° Devis</td><td style="padding:10px 16px;font-size:13px;color:#1F3A5F;font-weight:bold;border-bottom:1px solid #E3EAF3;">${devis.numero}</td></tr>
      <tr><td style="padding:10px 16px;font-size:13px;font-weight:bold;color:#555;border-bottom:1px solid #E3EAF3;">Date</td><td style="padding:10px 16px;font-size:13px;color:#333;border-bottom:1px solid #E3EAF3;">${new Date(devis.date_devis).toLocaleDateString('fr-FR')}</td></tr>
      ${devis.date_expiration?`<tr style="background:#F5F8FC;"><td style="padding:10px 16px;font-size:13px;font-weight:bold;color:#555;border-bottom:1px solid #E3EAF3;">Validité</td><td style="padding:10px 16px;font-size:13px;color:#333;border-bottom:1px solid #E3EAF3;">${new Date(devis.date_expiration).toLocaleDateString('fr-FR')}</td></tr>`:''}
      <tr style="background:#F5F8FC;"><td style="padding:10px 16px;font-size:13px;font-weight:bold;color:#555;border-bottom:1px solid #E3EAF3;">Articles</td><td style="padding:10px 16px;font-size:13px;color:#333;border-bottom:1px solid #E3EAF3;line-height:1.7;">${(Array.isArray(lignes)?lignes:[]).map(l=>`${l.nom||''} <strong style="color:#2B7DC7;">x${l.qte||1}</strong>`).join('<br>') || '—'}</td></tr>
      <tr style="background:#1F3A5F;"><td style="padding:12px 16px;font-size:13px;font-weight:bold;color:#A8C4E0;">Montant HT</td><td style="padding:12px 16px;font-size:17px;font-weight:bold;color:#ffffff;">${parseFloat(devis.montant||0).toLocaleString('fr-FR',{style:'currency',currency:devis.devise||'EUR'})}</td></tr>
    </table>

    <p style="margin:0 0 20px;font-size:14px;color:#333;line-height:1.6;">Vous trouverez ci-joint le devis. Vous pouvez également le consulter et le <strong>signer directement en ligne</strong> :</p>

    <!-- BOUTON -->
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;">
      <tr><td align="center">
        <a href="${vfUrl}" style="display:inline-block;background:#2B7DC7;color:#ffffff;text-decoration:none;padding:14px 36px;border-radius:6px;font-size:15px;font-weight:bold;">✍️ Signer le document</a>
      </td></tr>
    </table>

    <p style="margin:0 0 28px;font-size:14px;color:#555;line-height:1.6;">N'hésitez pas à nous contacter pour toute question au <strong style="color:#1F3A5F;">09 67 66 51 29</strong> ou par mail à <a href="mailto:info@eloflex.fr" style="color:#2B7DC7;text-decoration:none;">info@eloflex.fr</a></p>

    <!-- SEPARATEUR -->
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px;"><tr><td style="border-top:2px solid #E3EAF3;font-size:0;">&nbsp;</td></tr></table>

    <!-- SIGNATURE -->
    <table cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td valign="middle" width="160" style="padding-right:20px;border-right:2px solid #E3EAF3;">
          <img src="https://sensode.com/eloflex/wp-content/uploads/logo-signature.png" alt="Eloflex" width="145" style="display:block;border:0;">
        </td>
        <td valign="middle" style="padding-left:20px;">
          <div style="font-size:18px;font-weight:bold;color:#1F3A5F;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.3px;">ÉLOFLEX FRANCE</div>
          <div style="font-size:13px;color:#444444;line-height:22px;"><a href="mailto:info@eloflex.fr" style="color:#2B7DC7;text-decoration:none;">info@eloflex.fr</a> &nbsp;·&nbsp; <a href="https://eloflex.fr" style="color:#2B7DC7;text-decoration:none;">eloflex.fr</a></div>
          <div style="font-size:13px;color:#444444;">Tél. : <strong style="color:#2B7DC7;">09 67 66 51 29</strong> <span style="color:#888;font-size:12px;">(service commercial)</span></div>
          <div style="font-size:13px;color:#444444;">Mob. : <strong style="color:#2B7DC7;">07 54 37 47 40</strong> <span style="color:#888;font-size:12px;">(service technique)</span></div>
        </td>
      </tr>
    </table>
  </td></tr>

  <!-- BLOC LPP -->
  <tr><td style="background:#FFF8DC;border-top:4px solid #F2C200;padding:18px 36px;">
    <div style="font-size:13px;font-weight:bold;color:#1F5FA6;margin-bottom:3px;">INFORMATION IMPORTANTE – NOUVEAUX CODES LPP</div>
    <div style="font-size:12px;color:#666666;margin-bottom:12px;">Nos codes LPP fabricant ont été mis à jour.</div>
    <table width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr><td style="padding:7px 0;border-top:1px solid #EAD98A;font-size:12px;color:#222;line-height:16px;"><strong>Modèles L · F · D2 · P · R</strong><br><span style="font-size:11px;color:#777;">4545512 – VPH, achat neuf, FRE-B, classe B</span></td><td align="right" style="padding:7px 0 7px 10px;border-top:1px solid #EAD98A;white-space:nowrap;"><span style="font-size:10px;color:#777;display:block;">Nouveau LPPR</span><strong style="font-size:15px;color:#1F5FA6;">9570265</strong></td></tr>
      <tr><td style="padding:7px 0;border-top:1px solid #EAD98A;font-size:12px;color:#222;line-height:16px;"><strong>Coussins EASE ONE · EASE WEDGE</strong><br><span style="font-size:11px;color:#777;">4947601 – VPH, adjonction, PAP forfait B</span></td><td align="right" style="padding:7px 0 7px 10px;border-top:1px solid #EAD98A;white-space:nowrap;"><span style="font-size:10px;color:#777;display:block;">Nouveau LPPR</span><strong style="font-size:15px;color:#1F5FA6;">9903695</strong></td></tr>
      <tr><td style="padding:7px 0;border-top:1px solid #EAD98A;font-size:12px;color:#222;line-height:16px;"><strong>Commande tierce personne KIT A</strong><br><span style="font-size:11px;color:#777;">4965183 – VPH, adjonction, boîtier personnalisé</span></td><td align="right" style="padding:7px 0 7px 10px;border-top:1px solid #EAD98A;white-space:nowrap;"><span style="font-size:10px;color:#777;display:block;">Nouveau LPPR</span><strong style="font-size:15px;color:#1F5FA6;">9948893</strong></td></tr>
    </table>
  </td></tr>

  <!-- FOOTER -->
  <tr><td style="background:#1F3A5F;padding:14px 36px;text-align:center;">
    <div style="font-size:12px;color:#A8C4E0;">© Éloflex France &nbsp;·&nbsp; <a href="https://eloflex.fr" style="color:#A8C4E0;text-decoration:none;">eloflex.fr</a> &nbsp;·&nbsp; 09 67 66 51 29</div>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`
    }, { headers: { 'api-key': brevoKey, 'Content-Type': 'application/json' }, timeout: 15000 });
        console.log(`[EMAIL OK] Relance devis ${devis.numero} envoyée à ${email}`);
    // Enregistrer EN BASE avant de répondre
    await db.run(
      'INSERT INTO devis_relances (devis_id, email_dest, notes) VALUES ($1,$2,$3)',
      [devis.id, email, req.body.notes||null]
    );
    await db.run(
      'UPDATE devis SET nb_relances=nb_relances+1, derniere_relance=NOW(), updated_at=NOW() WHERE id=$1',
      [devis.id]
    );
    res.json({ ok: true, to: email });
  } catch(e) {
    console.error('[EMAIL ERR] Relance devis:', e?.message || String(e));
    if (!res.headersSent) res.status(500).json({ error: e?.message || String(e) });
  }
});


// ── DEBUG DEVIS (temporaire) ─────────────────────────────────────
router.get('/devis/debug-vf', adminOnly, async (req, res) => {
  try {
    if (!process.env.VOSFACTURES_API_TOKEN) return res.json({ error: 'Non configuré' });
    const axios = require('axios');
    const vfApi = axios.create({
      baseURL: `https://${process.env.VOSFACTURES_ACCOUNT}.vosfactures.fr`,
      headers: { 'Accept': 'application/json' },
      params: { api_token: process.env.VOSFACTURES_API_TOKEN }
    });
    // Récupérer 1 devis en liste
    const { data: list } = await vfApi.get('/invoices.json', {
      params: { kind: 'estimate', per_page: 1, page: 1 }
    });
    if (!Array.isArray(list) || !list.length) return res.json({ empty: true });
    const first = list[0];
    // Récupérer le détail complet du même devis
    const { data: detail } = await vfApi.get(`/invoices/${first.id}.json`);
    res.json({
      list_fields: Object.keys(first),
      list_amounts: {
        total_price_gross: first.total_price_gross,
        total_price_net:   first.total_price_net,
        price_gross:       first.price_gross,
        price_net:         first.price_net,
        total:             first.total,
      },
      detail_fields: Object.keys(detail),
      detail_amounts: {
        total_price_gross: detail.total_price_gross,
        total_price_net:   detail.total_price_net,
        price_gross:       detail.price_gross,
        price_net:         detail.price_net,
        total:             detail.total,
      },
      list_sample: first,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// ── Fin Devis ──────────────────────────────────────────────────────

// ══════════════════════════════════════════════════════════════════
// ── SUIVI TRANSPORTEURS (Colissimo + Chronopost) ─────────────────
// ══════════════════════════════════════════════════════════════════

// ── Détection automatique du transporteur ────────────────────────
function detecterTransporteur(numero) {
  if (!numero) return null;
  const n = numero.trim().replace(/\s+/g,'').toUpperCase();
  // Colissimo / La Poste
  if (/^(6[A-Z]|7[A-BD-HJ-NP-Z]|8F|4L|9L|CA|CB|CC|CY|EC|EE|EM|EN|EP|EQ|EV|EX|FA|FB|FI|FL|FX|LA|LB|LD|LO|LP|LT|LV|LX|LY|MH|MM|MT|MW|MY|PR|PW|PX|RA|RB|RE|RH|RM|RV|RW|RX|SD|SE|TH|TO|TP|TV|TW|TX|TY|UA|UB|UC|UE|UF|UG|UH|UI|UJ|UL|UM|UN|UO|UP|UQ|UR|US|UT|UU|UV|UW|UX|UY|UZ|VA|VB|VC|VD|VE|VF|VH|VI|VJ|VK|VL|VM|VN|VO|VP|VQ|VR|VS|VT|VU|VV|VW|VX|VY|VZ|XD|XF|YA|YB|YC|YD|YE|YF|YG|YH|YI|YJ|YK|YL|YM|YN|YO|YP|YQ|YR|YS|YT|YU|YV|YW|YX|YY|YZ)/i.test(n)) return 'colissimo';
  // Chronopost (8L, XC, XX, etc.)
  if (/^(8L|XC|XX|XD|XE|AR|AF|GR|LA|LB|LC|LD|LE|LF|LG|LH|LI|LJ|LK|LL|LM|LN|LO|LP|LQ|LR|LS|LT|LU|LV|LW|LX|LY|LZ)/i.test(n)) return 'chronopost';
  // Colissimo simple (13 chiffres commençant par 6 ou 9)
  if (/^[69]\d{12}$/.test(n)) return 'colissimo';
  // Chronopost (13 caractères commençant par 8)
  if (/^8\d{12}$/.test(n)) return 'chronopost';
  return null;
}

// ── Mapping statuts Colissimo → notre statut ─────────────────────
const COLISSIMO_LIVRES  = ['LIVCFM','LIVGAR','REMIEX','CFDOMA','CFBTE','LIVSIGNE','LIVDOMICILE'];
const COLISSIMO_PROBLEMES = ['COLFCR','COLPRE','COLRFI','COLRPT','NLIVEX1','NLIVEX2','NLIVEX3'];

function mapStatutColissimo(events) {
  if (!events || !events.length) return null;
  const last = events[0];
  const code = (last.code || last.type || '').toUpperCase();
  if (COLISSIMO_LIVRES.some(c => code.includes(c))) return 'Livré';
  if (COLISSIMO_PROBLEMES.some(c => code.includes(c))) return 'Problème';
  return 'Expédié';
}

// ── Mapping statuts Chronopost → notre statut ────────────────────
function mapStatutChronopost(events) {
  if (!events || !events.length) return null;
  const last = events[0];
  const code = (last.code || last.deliveryCode || last.type || '').toUpperCase();
  const label = (last.label || last.eventLabel || '').toLowerCase();
  if (code === 'D' || label.includes('livré') || label.includes('remis')) return 'Livré';
  if (code === 'I' || label.includes('incident') || label.includes('refus') || label.includes('retour')) return 'Problème';
  return 'Expédié';
}

// ── Appel API Colissimo ───────────────────────────────────────────
async function fetchColissimo(numero) {
  const key = process.env.LAPOSTE_API_KEY;
  if (!key) return null;
  const axios = require('axios');
  const { data } = await axios.get(
    `https://api.laposte.fr/suivi/v2/idships/${encodeURIComponent(numero)}?lang=fr_FR`,
    { headers: { 'X-Okapi-Key': key, 'Accept': 'application/json' }, timeout: 8000 }
  );
  const events = (data.shipment?.event || []).map(e => ({
    date:  e.date,
    label: e.label,
    code:  e.code,
    lieu:  e.location || '',
  }));
  return { events, statut: mapStatutColissimo(events), transporteur: 'Colissimo' };
}

// ── Chronopost : lien direct + 17track en fallback ───────────────
async function fetchChronopost(numero) {
  // Option 1 : API 17track (agrégateur multi-transporteurs, clé gratuite optionnelle)
  const key17 = process.env.TRACK17_API_KEY;
  if (key17) {
    try {
      const axios = require('axios');
      const { data } = await axios.post(
        'https://api.17track.net/track/v2.2/gettrackinfo',
        JSON.stringify([{ number: numero }]),
        { headers: { '17token': key17, 'Content-Type': 'application/json' }, timeout: 8000 }
      );
      const info = data?.data?.accepted?.[0]?.track;
      if (info) {
        const events = (info.tracking?.providers?.[0]?.events || []).map(e => ({
          date:  e.time_utc || e.time,
          label: e.description || e.description_translation || '',
          code:  e.code || '',
          lieu:  e.location || '',
        }));
        const lastStatus = info.latest_status?.status;
        const statut = lastStatus === 'Delivered' ? 'Livré' :
                       lastStatus === 'Exception'  ? 'Problème' : 'Expédié';
        return { events, statut, transporteur: 'Chronopost' };
      }
    } catch(_) {}
  }
  // Option 2 : lien direct vers suivi Chronopost (pas d'API requise)
  return {
    found: false,
    lien: `https://www.chronopost.fr/tracking-no-cms/suivi-page?listeNumerosLT=${encodeURIComponent(numero)}`,
    transporteur: 'Chronopost',
    message: 'Cliquer pour suivre sur chronopost.fr'
  };
}

// ── 17track : agrégateur universel (Chronopost, Colissimo, DPD...) ─
async function fetch17track(numeros) {
  const key = process.env.TRACK17_API_KEY;
  if (!key) return null;
  const axios = require('axios');
  const payload = Array.isArray(numeros) ? numeros.map(n => ({ number: n })) : [{ number: numeros }];
  const { data } = await axios.post(
    'https://api.17track.net/track/v2.2/gettrackinfo',
    JSON.stringify(payload),
    { headers: { '17token': key, 'Content-Type': 'application/json' }, timeout: 10000 }
  );
  const results = {};
  for (const item of (data?.data?.accepted || [])) {
    const track  = item.track || {};
    const events = (track.tracking?.providers?.[0]?.events || []).map(e => ({
      date:  (e.time_utc || e.time || '').slice(0, 16).replace('T', ' '),
      label: e.description_translation || e.description || '',
      code:  String(e.code || ''),
      lieu:  e.location || '',
    }));
    const tag   = track.latest_status?.status || '';
    const statut = tag === 'Delivered' ? 'Livré'
                 : tag === 'Exception' || tag === 'Undelivered' ? 'Problème'
                 : events.length ? 'Expédié' : null;
    const carrier = track.carrier_code
      ? (track.carrier_code.toString().includes('chronopost') ? 'Chronopost' : 
         track.carrier_code.toString().includes('laposte') || track.carrier_code.toString().includes('colissimo') ? 'Colissimo' :
         track.carrier_name || track.carrier_code)
      : null;
    results[item.number] = { found: true, events, statut, transporteur: carrier || detecterTransporteur(item.number) || '?' };
  }
  return results;
}

// ── Fonction centrale de suivi ────────────────────────────────────
async function fetchTracking(numero) {
  if (!numero || numero.length < 8) return null;
  const transporteur = detecterTransporteur(numero);
  try {
    // 1. Priorité : 17track (supporte tous les transporteurs)
    if (process.env.TRACK17_API_KEY) {
      const results = await fetch17track(numero);
      if (results?.[numero]) return results[numero];
    }
    // 2. Fallback : API La Poste directe (Colissimo)
    if (transporteur === 'colissimo') return await fetchColissimo(numero);
    // 3. Fallback Chronopost : lien direct
    if (transporteur === 'chronopost') return await fetchChronopost(numero);
  } catch(e) {
    console.error('[TRACKING] Erreur', numero, e.message);
  }
  // 4. Dernier recours : lien direct transporteur
  const liens = {
    chronopost: `https://www.chronopost.fr/tracking-no-cms/suivi-page?listeNumerosLT=${encodeURIComponent(numero)}`,
    colissimo:  `https://www.laposte.fr/outils/suivre-vos-envois?code=${encodeURIComponent(numero)}`,
  };
  return {
    found: false,
    lien: liens[transporteur] || `https://www.17track.net/fr/track#nums=${encodeURIComponent(numero)}`,
    transporteur: transporteur || 'Inconnu',
    message: 'Cliquer pour suivre en ligne'
  };
}

// ── Route : suivi en temps réel d'un numéro ──────────────────────
router.get('/tracking/:numero', async (req, res) => {
  try {
    const result = await fetchTracking(req.params.numero);
    if (!result) return res.json({ found: false, transporteur: detecterTransporteur(req.params.numero) });
    res.json({ found: true, ...result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Route : sync batch de toutes les commandes "Expédié" ─────────
router.post('/tracking/sync', adminOnly, async (req, res) => {
  try {
    const commandes = await db.all(`
      SELECT id, num_suivi, statut, transporteur
      FROM commandes
      WHERE num_suivi IS NOT NULL
        AND LENGTH(TRIM(num_suivi)) >= 8
        AND (statut IS NULL OR statut NOT IN ('Livré','Facturé','Annulé'))
        AND (tracking_derniere_verif IS NULL
             OR tracking_derniere_verif < NOW() - INTERVAL '2 hours')
      ORDER BY date_commande DESC
      LIMIT 100
    `);

    let updated = 0, errors = 0;
    // Utiliser 17track en bulk (jusqu'à 40 colis par appel = économise les quotas)
    const use17track = !!process.env.TRACK17_API_KEY;
    const CHUNK = 40;
    for (let i = 0; i < commandes.length; i += CHUNK) {
      const chunk = commandes.slice(i, i + CHUNK);
      let results17 = {};
      if (use17track) {
        try {
          results17 = await fetch17track(chunk.map(c => c.num_suivi)) || {};
        } catch(_) {}
      }
      for (const cmd of chunk) {
        try {
          const result = results17[cmd.num_suivi] || (!use17track ? await fetchTracking(cmd.num_suivi) : null);
          if (!result || !result.found) continue;
          const { events, statut, transporteur } = result;
          const nouveauStatut = (statut === 'Livré' || statut === 'Problème') ? statut : null;
          await db.run(`
            UPDATE commandes SET
              tracking_statut=$1,
              tracking_events=$2,
              tracking_derniere_verif=NOW(),
              tracking_transporter=$3
              ${nouveauStatut ? `,statut='${nouveauStatut}'` : ''}
              ${nouveauStatut === 'Livré' && !cmd.date_livraison ? `,date_livraison=CURRENT_DATE::text` : ''}
            WHERE id=$4
          `, [statut, JSON.stringify((events||[]).slice(0,10)), transporteur, cmd.id]);
          if (nouveauStatut) updated++;
        } catch(e) { errors++; }
      }
      if (i + CHUNK < commandes.length) await new Promise(r => setTimeout(r, 500));
    }
    res.json({ ok: true, checked: commandes.length, updated, errors });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Fin Tracking ──────────────────────────────────────────────────


// ── Alertes : non expédié 7j après saisie + non facturé 7j après expédition ──
router.get('/commandes/alertes-blocage', async (req, res) => {
  try {
    const jours = parseInt(req.query.jours)||7;
    const userPays = res.locals.user?.pays || req.query.pays || null;
    const paysFilter = userPays ? `AND (cmd.pays = '${userPays.replace(/'/g,"''")}' OR cmd.pays IS NULL)` : '';

    // Alerte 1 : non expédiée N jours après la date de commande
    const nonExpedies = await db.all(`
      SELECT cmd.id, cmd.distributeur_nom, cmd.bdc, cmd.modele, cmd.date_commande,
             cmd.num_suivi, cmd.statut, 'non_expedie' AS type_alerte,
             ROUND(DATE_PART('day', NOW() - cmd.date_commande::timestamp))::int AS jours_attente
      FROM commandes cmd
      WHERE cmd.date_commande IS NOT NULL
        AND (cmd.statut IS NULL OR cmd.statut IN ('Auto','En préparation','En attente confirmation'))
        AND cmd.date_livraison IS NULL
        AND (cmd.num_suivi IS NULL OR LENGTH(TRIM(cmd.num_suivi)) < 8)
        AND cmd.statut NOT IN ('Annulé','Problème')
        AND DATE_PART('day', NOW() - cmd.date_commande::timestamp) >= $1
        ${paysFilter}
      ORDER BY jours_attente DESC LIMIT 30
    `, [jours]);

    // Alerte 2 : non facturée N jours après expédition/livraison
    const nonFacturees = await db.all(`
      SELECT cmd.id, cmd.distributeur_nom, cmd.bdc, cmd.modele, cmd.date_livraison,
             cmd.num_suivi, cmd.statut, 'non_facturee' AS type_alerte,
             ROUND(DATE_PART('day', NOW() - COALESCE(cmd.date_livraison, cmd.date_commande)::timestamp))::int AS jours_attente
      FROM commandes cmd
      WHERE (cmd.num_facture IS NULL OR cmd.num_facture = '')
        AND (cmd.statut IN ('Livré','Expédié') OR (cmd.statut IN ('Auto') AND cmd.date_livraison IS NOT NULL))
        AND cmd.statut NOT IN ('Annulé','Facturé','Problème')
        AND COALESCE(cmd.date_livraison, cmd.date_commande) IS NOT NULL
        AND DATE_PART('day', NOW() - COALESCE(cmd.date_livraison, cmd.date_commande)::timestamp) >= $1
        ${paysFilter}
      ORDER BY jours_attente DESC LIMIT 30
    `, [jours]);

    res.json({ non_expedies: nonExpedies, non_facturees: nonFacturees });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/commandes/:id', async (req, res) => {
  try {
    const row = await db.get(
      `SELECT cmd.*, c.nom AS client_nom, c.ville AS client_ville, c.email AS client_email, c.tel AS client_tel
       FROM commandes cmd LEFT JOIN clients c ON c.id = cmd.client_id WHERE cmd.id=$1`, [req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Commande introuvable' });
    const lignes = await db.all(
      'SELECT * FROM commandes_lignes WHERE commande_id=$1 ORDER BY ordre, id', [req.params.id]
    );
    const retour_lignes = await db.all(
      'SELECT * FROM commandes_retour_lignes WHERE commande_id=$1 ORDER BY ordre, id', [req.params.id]
    );
    res.json({ ...row, statut_calc: statutCommande(row), lignes, retour_lignes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Lignes d'une commande (désignation / référence / quantité)
router.get('/commandes/:id/lignes', async (req, res) => {
  try {
    const lignes = await db.all('SELECT * FROM commandes_lignes WHERE commande_id=$1 ORDER BY ordre, id', [req.params.id]);
    res.json(lignes);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/commandes/:id/lignes', async (req, res) => {
  // Remplace toutes les lignes d'une commande (envoi du tableau complet)
  try {
    const lignes = req.body; // [{designation, reference, quantite, ordre}]
    if (!Array.isArray(lignes)) return res.status(400).json({ error: 'Tableau de lignes attendu' });
    await db.run('DELETE FROM commandes_lignes WHERE commande_id=$1', [req.params.id]);
    for (let i = 0; i < lignes.length; i++) {
      const l = lignes[i];
      if (!l.designation?.trim()) continue;
      await db.run(
        'INSERT INTO commandes_lignes (commande_id, designation, reference, quantite, ordre) VALUES ($1,$2,$3,$4,$5)',
        [req.params.id, l.designation.trim(), l.reference?.trim() || null, parseInt(l.quantite) || 1, i]
      );
    }
    const result = await db.all('SELECT * FROM commandes_lignes WHERE commande_id=$1 ORDER BY ordre, id', [req.params.id]);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/commandes/:id/retour-lignes', async (req, res) => {
  try {
    const lignes = req.body;
    if (!Array.isArray(lignes)) return res.status(400).json({ error: 'Tableau attendu' });
    await db.run('DELETE FROM commandes_retour_lignes WHERE commande_id=$1', [req.params.id]);
    for (let i = 0; i < lignes.length; i++) {
      const l = lignes[i];
      if (!l.designation?.trim()) continue;
      await db.run(
        'INSERT INTO commandes_retour_lignes (commande_id, designation, reference, quantite, ordre) VALUES ($1,$2,$3,$4,$5)',
        [req.params.id, l.designation.trim(), l.reference?.trim() || null, parseInt(l.quantite) || 1, i]
      );
    }
    const result = await db.all('SELECT * FROM commandes_retour_lignes WHERE commande_id=$1 ORDER BY ordre, id', [req.params.id]);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/commandes', async (req, res) => {
  try {
    const d = req.body;
    if (!d.distributeur_nom) return res.status(400).json({ error: 'distributeur_nom requis' });
    let clientId = d.client_id || null;
    if (!clientId) {
      const existing = await db.get('SELECT id FROM clients WHERE LOWER(TRIM(nom))=LOWER($1)', [d.distributeur_nom]);
      if (existing) clientId = existing.id;
      else {
        const c = await db.run(
          `INSERT INTO clients (nom, email, tel, type, token_portail) VALUES ($1,$2,$3,'Distributeur',md5(random()::text)) RETURNING id`,
          [d.distributeur_nom, d.email || null, d.tel || null]
        );
        clientId = c.id;
      }
    }
    const row = await db.run(
      `INSERT INTO commandes (client_id, fauteuil_id, annee_onglet, groupe, distributeur_nom, modele, quantite, accessoire,
        bdc, date_commande, vf_order_id, client_final, num_suivi, transporteur, date_livraison, num_serie, num_facture,
        invoice_se, informations, statut, num_bordereau, reliquat, reliquat_description, modele_demo,
        num_retour, transporteur_retour, date_retour, num_commande_distrib,
        commande_type, ref_suede, date_envoi_suede, confirmation_recue, date_confirmation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33) RETURNING *`,
      [clientId, d.fauteuil_id || null, d.annee_onglet || new Date().getFullYear(), d.groupe || null,
       d.distributeur_nom, d.modele || null, parseInt(d.quantite) || 1, d.accessoire || null, d.bdc || null, d.date_commande || null,
       d.vf_order_id || null, d.client_final || null, d.num_suivi || null, d.transporteur || null, d.date_livraison || null,
       d.num_serie || null, d.num_facture || null, d.invoice_se || null, d.informations || null, d.statut || 'Auto',
       d.num_bordereau || null, d.reliquat ? true : false, d.reliquat_description || null, d.modele_demo ? true : false,
       d.num_retour || null, d.transporteur_retour || null, d.date_retour || null, d.num_commande_distrib || null,
       d.commande_type || null, d.ref_suede || null, d.date_envoi_suede || null,
       d.confirmation_recue ? true : false, d.date_confirmation || null]
    );
    res.status(201).json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/commandes/:id', async (req, res) => {
  try {
    const d = req.body;
    const champs = ['client_id', 'fauteuil_id', 'annee_onglet', 'groupe', 'distributeur_nom', 'modele', 'quantite', 'accessoire',
      'bdc', 'date_commande', 'vf_order_id', 'client_final', 'num_suivi', 'transporteur', 'date_livraison', 'num_serie',
      'num_facture', 'invoice_se', 'informations', 'statut', 'num_bordereau', 'reliquat', 'reliquat_description', 'modele_demo',
      'num_retour', 'transporteur_retour', 'date_retour', 'num_commande_distrib',
      'commande_type', 'type_fauteuil_neuf', 'type_fauteuil_demo', 'type_pieces', 'confirmation_mode',
      'ref_suede', 'date_envoi_suede', 'confirmation_recue', 'date_confirmation',
      'num_avoir', 'vf_avoir_id', 'num_facture_pennylane', 'pays'];
    const sets = [], p = [];
    let idx = 0;
    for (const champ of champs) {
      if (d[champ] !== undefined) { sets.push(`${champ}=$${++idx}`); p.push(d[champ] === '' ? null : d[champ]); }
    }
    if (!sets.length) return res.status(400).json({ error: 'Aucun champ à mettre à jour' });
    sets.push(`updated_at=NOW()`);
    p.push(req.params.id);
    const row = await db.run(`UPDATE commandes SET ${sets.join(', ')} WHERE id=$${++idx} RETURNING *`, p);
    if (!row) return res.status(404).json({ error: 'Commande introuvable' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/commandes/:id', async (req, res) => {
  try {
    await db.run('DELETE FROM commandes WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Suggestions de factures VosFactures pour rattacher manuellement n° de série / facture
// (pas de lien fiable automatique bon de commande -> facture côté VosFactures : confirmation humaine requise)
router.get('/commandes/:id/factures-vf-suggestions', async (req, res) => {
  try {
    const cmd = await db.get(
      `SELECT cmd.*, c.vf_id FROM commandes cmd LEFT JOIN clients c ON c.id = cmd.client_id WHERE cmd.id=$1`,
      [req.params.id]
    );
    if (!cmd) return res.status(404).json({ error: 'Commande introuvable' });
    if (!process.env.VOSFACTURES_API_TOKEN || !process.env.VOSFACTURES_ACCOUNT) {
      return res.json({ factures: [], configured: false });
    }
    if (!cmd.vf_id) {
      // Pas de lien VF direct — recherche par numéro de facture ou nom distributeur
      if (!req.query.num_facture && !cmd.distributeur_nom) {
        return res.json({ factures: [], configured: true, reason: 'Aucun lien VosFactures disponible' });
      }
    }

    const axios = require('axios');
    const vfApi = axios.create({
      baseURL: `https://${process.env.VOSFACTURES_ACCOUNT}.vosfactures.fr`,
      headers: { 'Accept': 'application/json' },
      params:  { api_token: process.env.VOSFACTURES_API_TOKEN }
    });

    // Si on a un num_facture saisi, chercher directement
    let data;
    if (req.query.num_facture) {
      const r = await vfApi.get('/invoices.json', {
        params: { number: req.query.num_facture, kind: 'vat', per_page: 5 }
      });
      data = r.data;
    } else if (cmd.vf_id) {
      const r = await vfApi.get('/invoices.json', {
        params: { client_id: cmd.vf_id, kind: 'vat', per_page: 15, order: 'issue_date.desc' }
      });
      data = r.data;
    } else {
      // Pas de vf_id → recherche par nom distributeur
      const r = await vfApi.get('/invoices.json', {
        params: { buyer_name: cmd.distributeur_nom, kind: 'vat', per_page: 15, order: 'issue_date.desc' }
      });
      data = r.data;
    }

    const SERIE_RE = /\b(EL\d{6,}|A\d{2}L?\d{10,}|DE\d{2,}L?\d{10,}|T\d{2}\d{8,}|A\d{12,})\b/gi;
    const factures = (Array.isArray(data) ? data : []).slice(0, 10).map(inv => ({
      id: inv.id, numero: inv.number, date: inv.issue_date || inv.sell_date,
      montant_ttc: inv.price_gross,
      url: `https://${process.env.VOSFACTURES_ACCOUNT}.vosfactures.fr/invoices/${inv.id}`
    }));

    // Tente d'extraire un n° de série pour chaque facture candidate (détail)
    for (const f of factures) {
      try {
        const { data: detail } = await vfApi.get(`/invoices/${f.id}.json`);
        const positions = detail.positions || detail.invoice_items || [];
        const texte = [detail.description || '', ...positions.map(p => [p.name || '', p.description || ''].join(' '))].join(' ');
        const m = texte.match(SERIE_RE);
        f.num_serie = m ? m[0].trim() : null;
      } catch (e) { f.num_serie = null; }
    }

    res.json({ factures, configured: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Recherche directe d'une facture VosFactures par son numéro exact (saisi côté commande)
// — beaucoup plus fiable que les suggestions, puisque le n° de facture correspond 1:1
// au document VosFactures (confirmé par l'utilisateur).
router.get('/vosfactures/facture-lookup', async (req, res) => {
  try {
    const numero = (req.query.numero || '').trim();
    if (!numero) return res.status(400).json({ error: 'Paramètre numero requis' });
    if (!process.env.VOSFACTURES_API_TOKEN || !process.env.VOSFACTURES_ACCOUNT) {
      return res.json({ configured: false });
    }

    const axios = require('axios');
    const vfApi = axios.create({
      baseURL: `https://${process.env.VOSFACTURES_ACCOUNT}.vosfactures.fr`,
      headers: { 'Accept': 'application/json' },
      params:  { api_token: process.env.VOSFACTURES_API_TOKEN }
    });

    const { data } = await vfApi.get('/invoices.json', { params: { number: numero, per_page: 5 } });
    const inv = Array.isArray(data) ? data.find(d => String(d.number).trim() === numero) || data[0] : null;
    if (!inv) return res.json({ configured: true, found: false });

    const { data: detail } = await vfApi.get(`/invoices/${inv.id}.json`);
    const positions = detail.positions || detail.invoice_items || [];
    const texte = [detail.description || '', ...positions.map(p => [p.name || '', p.description || ''].join(' '))].join(' ');
    const SERIE_RE = /\b(EL\d{6,}|A\d{2}L?\d{10,}|DE\d{2,}L?\d{10,}|T\d{2}\d{8,}|A\d{12,})\b/gi;
    const m = texte.match(SERIE_RE);

    res.json({
      configured: true, found: true,
      numero: inv.number, date: inv.issue_date || inv.sell_date,
      num_serie: m ? m[0].trim() : null,
      buyer_name: inv.buyer_name,
      montant_ttc: inv.price_gross
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Preuve de livraison (PDF généralement, parfois photo du bon signé)
router.post('/commandes/:id/preuve-livraison', uploadPreuveLivraison.single('fichier'), async (req, res) => {
  try {
    const cmd = await db.get('SELECT * FROM commandes WHERE id=$1', [req.params.id]);
    if (!cmd) return res.status(404).json({ error: 'Commande introuvable' });
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });

    // Si une preuve existait déjà, on la remplace (supprime l'ancienne)
    if (cmd.preuve_livraison_filename) {
      deletePreuveLivraisonFile(cmd.preuve_livraison_filename, cmd.preuve_livraison_storage);
    }

    const saved = await savePreuveLivraison(req.file, req.params.id);
    // Toujours stocker en base64 dans la DB (survit aux redémarrages Render)
    const base64data = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    const row = await db.run(
      `UPDATE commandes SET preuve_livraison_filename=$1, preuve_livraison_url=$2, preuve_livraison_mime=$3,
        preuve_livraison_taille=$4, preuve_livraison_storage=$5, preuve_livraison_uploaded_at=NOW(),
        preuve_livraison_data=$6, updated_at=NOW()
       WHERE id=$7 RETURNING *`,
      [saved.filename, saved.url, saved.mime, saved.taille, saved.storage, base64data, req.params.id]
    );
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/commandes/:id/preuve-livraison', async (req, res) => {
  try {
    const cmd = await db.get('SELECT * FROM commandes WHERE id=$1', [req.params.id]);
    if (!cmd) return res.status(404).json({ error: 'Commande introuvable' });
    if (cmd.preuve_livraison_filename) {
      deletePreuveLivraisonFile(cmd.preuve_livraison_filename, cmd.preuve_livraison_storage);
    }
    const row = await db.run(
      `UPDATE commandes SET preuve_livraison_filename=NULL, preuve_livraison_url=NULL, preuve_livraison_mime=NULL,
        preuve_livraison_taille=NULL, preuve_livraison_storage=NULL, preuve_livraison_uploaded_at=NULL, updated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [req.params.id]
    );
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Lookup d'un bon de commande VosFactures par numéro (client_order ou stock)
// Retourne le détail complet : distributeur, modèle, accessoires catégorisés avec quantités,
// date, numéro, n° de série — prêt à pré-remplir la fiche commande.
router.get('/vosfactures/bdc-lookup', async (req, res) => {
  try {
    const numero = (req.query.numero || '').trim();
    if (!numero) return res.status(400).json({ error: 'Paramètre numero requis' });
    if (!process.env.VOSFACTURES_API_TOKEN || !process.env.VOSFACTURES_ACCOUNT) {
      return res.json({ configured: false });
    }
    const axios = require('axios');
    const vfApi = axios.create({
      baseURL: `https://${process.env.VOSFACTURES_ACCOUNT}.vosfactures.fr`,
      headers: { 'Accept': 'application/json' },
      params:  { api_token: process.env.VOSFACTURES_API_TOKEN }
    });

    // Normalisation souple (ignore espaces, tirets, points, slashes)
    const normalise = s => String(s||'').toLowerCase().replace(/[\s\-\/\.]+/g,'');
    const numNorm = normalise(numero);
    let inv = null;

    // Étape 1 : BL/WZ — VosFactures n'accepte pas ?number= avec kind=wz
    // On utilise search_text qui fonctionne pour ce type
    try {
      const { data } = await vfApi.get('/invoices.json', {
        params: { kind: 'wz', search_text: numero, per_page: 20 }
      });
      if (Array.isArray(data) && data.length) {
        inv = data.find(d => normalise(d.number) === numNorm)
           || data.find(d => normalise(d.number).includes(numNorm))
           || null;
      }
    } catch(_) {}

    // Étape 2 : Autres types (BDC, devis, facture, reçu) avec filtre number
    if (!inv) {
      for (const kind of ['client_order', 'estimate', 'vat', 'stock', 'receipt', 'other', 'proforma']) {
        try {
          const { data } = await vfApi.get('/invoices.json', {
            params: { kind, number: numero, per_page: 10 }
          });
          if (Array.isArray(data) && data.length) {
            const match = data.find(d => normalise(d.number) === numNorm);
            if (match) { inv = match; break; }
          }
        } catch(_) {}
      }
    }

    // Étape 3 : Fallback — récupérer les WZ récents et chercher par numéro côté serveur
    if (!inv) {
      try {
        const { data } = await vfApi.get('/invoices.json', {
          params: { kind: 'wz', per_page: 100, page: 1, order: 'id desc' }
        });
        if (Array.isArray(data) && data.length) {
          inv = data.find(d => normalise(d.number) === numNorm)
             || data.find(d => normalise(d.number).includes(numNorm))
             || null;
        }
      } catch(_) {}
    }

    if (!inv) return res.json({ configured: true, found: false });

    const { data: detail } = await vfApi.get(`/invoices/${inv.id}.json`);
    const positions = detail.positions || detail.invoice_items || [];

    // Règles d'exclusion : retirer les frais génériques, mais garder les deux exceptions explicites
    const GARDER_EXPLICITES = [
      /frais\s*d['']?envoi\s*et\s*retour\s*-\s*tests?\s*recharges?\s*2?\s*batteries?/i,
      /frais\s*d['']?envois?\s*-\s*transfert\s*transporteurs?/i,
    ];
    function estExclue(nom) {
      if (GARDER_EXPLICITES.some(re => re.test(nom))) return false;
      if (/frais\s*d['']?envoi/i.test(nom)) return true;
      if (/frais\s*d['']?exp[eé]dition/i.test(nom)) return true;
      return false;
    }

    const CATEGORIES_ACCESSOIRES = [
      { label: 'Frais & services',          re: /\bfrais|transport|\bport\b|\btest|retour\b|main[\s-]?d['']?œuvre|forfait/i },
      { label: 'Chargeurs',                 re: /\bchargeur/i },
      { label: 'Moteurs',                   re: /\bmoteur/i },
      { label: 'Supports',                  re: /\bsupport/i },
      { label: 'Roues & freins',            re: /\broue|pneu|frein/i },
      { label: 'Commande & électronique',   re: /\bmanette|joystick|boitier|bo[iî]tier|câble|carte\s*électronique|écran|module/i },
      { label: 'Confort & assise',          re: /\bcoussin|housse|dossier|accoudoir|assise|repose[-\s]?jambe|repose[-\s]?pied|repose[-\s]?t[êe]te/i },
      { label: 'Batteries',                 re: /\bbatterie/i },
    ];
    function categoriser(nom) {
      for (const c of CATEGORIES_ACCESSOIRES) if (c.re.test(nom)) return c.label;
      return 'Autres pièces';
    }

    const ligneFauteuil = positions.find(p => /eloflex/i.test(p.name || ''))
      || positions.find(p => !estExclue(p.name || '') && parseFloat(p.total_price_gross || p.price_net || p.price || 0) > 0)
      || null;

    const modele   = ligneFauteuil?.name?.trim() || null;
    const quantite = ligneFauteuil ? (parseInt(ligneFauteuil.quantity) || 1) : null;

    // Lignes structurées : chaque position = {designation, reference, quantite}
    const lignes = [];
    // Ligne fauteuil en premier si trouvée
    if (ligneFauteuil) {
      lignes.push({
        designation: ligneFauteuil.name?.trim() || '',
        reference: ligneFauteuil.product_code || ligneFauteuil.code || null,
        quantite: parseInt(ligneFauteuil.quantity) || 1,
      });
    }
    for (const p of positions) {
      if (p === ligneFauteuil) continue;
      const nom = (p.name || '').trim();
      if (!nom || estExclue(nom)) continue;
      lignes.push({
        designation: nom,
        designation_en: (p.supplier_code || '').trim() || nom, // Réf. fournisseur pour mode EN
        reference: p.product_code || p.code || null,
        quantite: parseInt(p.quantity) || 1,
      });
    }

    const texteComplet = [detail.description || '', ...positions.map(p => [p.name || '', p.description || ''].join(' '))].join(' ');
    const SERIE_RE = /\b(EL\d{6,}|A\d{2}L?\d{10,}|DE\d{2,}L?\d{10,}|T\d{2}\d{8,}|A\d{12,})\b/gi;
    const mSerie = texteComplet.match(SERIE_RE);

    // Détection automatique modèle de démo / prêt d'essai
    const modeleDemo = /offre\s*d['']?essai|pret\s*(long\s*terme|court)|pr[êe]t\s*(long|court|d['']?essai)|d[ée]mo(?:nstration)?|essai\s*\d+\s*jours/i.test(texteComplet);

    res.json({
      configured: true, found: true,
      vf_id:         inv.id,
      numero:        detail.number || inv.number,  // numéro exact tel que dans VosFactures
      date_commande: (detail.issue_date || detail.sell_date || '').slice(0, 10) || null,
      distributeur:  detail.buyer_name || inv.buyer_name || null,
      modele, quantite, lignes,
      num_serie: mSerie ? mSerie[0].trim() : null,
      kind: detail.kind || inv.kind,
      modele_demo: modeleDemo,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Email demande de confirmation BDC au distributeur ──────────────
router.post('/commandes/:id/email-confirmation', adminOrOp, async (req, res) => {
  try {
    const params = {}; const prows = await db.all('SELECT cle, valeur FROM parametres');
    prows.forEach(r => params[r.cle] = r.valeur);
    if (!params.email_smtp_host || !params.email_smtp_user) return res.json({ ok: false, reason: 'SMTP non configuré' });
    const cmd = await db.get(`SELECT cmd.*, c.nom AS client_nom, c.email AS client_email
      FROM commandes cmd JOIN clients c ON c.id=cmd.client_id WHERE cmd.id=$1`, [req.params.id]);
    if (!cmd) return res.status(404).json({ error: 'Commande introuvable' });
    if (!cmd.client_email) return res.json({ ok: false, reason: `Pas d'email pour ${cmd.distributeur_nom}` });

    // Token de confirmation (déterministe, pas de stockage)
    const crypto = require('crypto');
    const token = crypto.createHash('sha256').update(`${cmd.id}-eloflex-confirm-2026`).digest('hex').slice(0, 20);
    const baseUrl = process.env.APP_URL || 'https://sav-eloflex.onrender.com';
    const confirmUrl = `${baseUrl}/api/confirmer-commande/${cmd.id}/${token}`;

    // Type de commande
    const types = [cmd.type_fauteuil_neuf && '🆕 Fauteuil Neuf', cmd.type_fauteuil_demo && '🔄 Fauteuil Démo', cmd.type_pieces && '📦 Pièces détachées'].filter(Boolean).join(', ');

    const nodemailer = require('nodemailer');
    const tr = nodemailer.createTransport({ host: params.email_smtp_host, port: parseInt(params.email_smtp_port)||587,
      secure: parseInt(params.email_smtp_port)===465, auth: { user: params.email_smtp_user, pass: params.email_smtp_pass } });
    await tr.sendMail({
      from: params.email_from || params.email_smtp_user, to: cmd.client_email,
      subject: `[Éloflex] Confirmation de commande ${cmd.bdc || '#' + cmd.id}`,
      cc: 'sav@eloflex.fr',
      html: `<div style="font-family:sans-serif;max-width:580px;color:#222;margin:0 auto">
        <div style="background:#1a3a5c;padding:20px 24px;border-radius:8px 8px 0 0">
          <h2 style="color:#fff;margin:0;font-size:18px;font-weight:600">Éloflex France — Confirmation de commande</h2>
        </div>
        <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;padding:24px">
          <p style="margin:0 0 12px">Bonjour,</p>
          <p style="margin:0 0 16px">Nous avons bien reçu votre commande du <strong>${cmd.date_commande ? new Date(cmd.date_commande).toLocaleDateString('fr-FR') : '—'}</strong>.</p>
          <table style="border-collapse:collapse;width:100%;font-size:13px;margin:0 0 20px;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden">
            <tr style="background:#f8f9fa"><td style="padding:9px 14px;font-weight:600;color:#555;width:170px;border-bottom:1px solid #e5e7eb">Référence Éloflex</td><td style="padding:9px 14px;border-bottom:1px solid #e5e7eb"><strong>${cmd.bdc || '—'}</strong></td></tr>
            ${cmd.num_commande_distrib ? `<tr><td style="padding:9px 14px;font-weight:600;color:#555;border-bottom:1px solid #e5e7eb">Votre référence</td><td style="padding:9px 14px;border-bottom:1px solid #e5e7eb"><strong>${cmd.num_commande_distrib}</strong></td></tr>` : ''}
            ${types ? `<tr style="background:#f8f9fa"><td style="padding:9px 14px;font-weight:600;color:#555;border-bottom:1px solid #e5e7eb">Type</td><td style="padding:9px 14px;border-bottom:1px solid #e5e7eb">${types}</td></tr>` : ''}
            ${cmd.modele ? `<tr><td style="padding:9px 14px;font-weight:600;color:#555;border-bottom:1px solid #e5e7eb">Article(s)</td><td style="padding:9px 14px;border-bottom:1px solid #e5e7eb">${cmd.modele}</td></tr>` : ''}
            ${cmd.groupe ? `<tr style="background:#f8f9fa"><td style="padding:9px 14px;font-weight:600;color:#555">Groupe</td><td style="padding:9px 14px">${cmd.groupe}</td></tr>` : ''}
          </table>
          <p style="margin:0 0 20px">Pourriez-vous <strong>confirmer votre bon de commande</strong> afin que nous puissions procéder à la préparation ?</p>
          <div style="text-align:center;margin:24px 0">
            <a href="${confirmUrl}" style="display:inline-block;background:#1a3a5c;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-size:15px;font-weight:600">✓ Confirmer ma commande</a>
          </div>
          <p style="margin:0 0 4px;font-size:12px;color:#888">Ou confirmez par retour de mail à : <a href="mailto:${params.email_smtp_user}" style="color:#1a3a5c">${params.email_smtp_user}</a></p>
          <p style="margin:20px 0 0;font-size:12px;color:#aaa;border-top:1px solid #f0f0f0;padding-top:16px">Éloflex France — Service commercial<br>Cet email a été envoyé automatiquement depuis le système de gestion SAV.</p>
        </div>
      </div>`
    });
    await db.run(`UPDATE commandes SET statut='En attente confirmation', updated_at=NOW() WHERE id=$1`, [req.params.id]);
    res.json({ ok: true, to: cmd.client_email });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Lien de confirmation BDC par clic (depuis email distributeur) ──
router.get('/confirmer-commande/:id/:token', async (req, res) => {
  try {
    const crypto = require('crypto');
    const expected = crypto.createHash('sha256').update(`${req.params.id}-eloflex-confirm-2026`).digest('hex').slice(0, 20);
    if (req.params.token !== expected) return res.status(403).send('<h2>Lien invalide ou expiré.</h2>');
    const cmd = await db.get('SELECT id, bdc, distributeur_nom, confirmation_recue FROM commandes WHERE id=$1', [req.params.id]);
    if (!cmd) return res.status(404).send('<h2>Commande introuvable.</h2>');
    if (!cmd.confirmation_recue) {
      await db.run(`UPDATE commandes SET confirmation_recue=TRUE, confirmation_mode='mail', date_confirmation=$1, statut='En préparation', updated_at=NOW() WHERE id=$2`,
        [new Date().toISOString().slice(0,10), req.params.id]);
    }
    res.send(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>Commande confirmée</title>
      <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f7fa}
      .card{background:#fff;border-radius:12px;padding:40px 48px;text-align:center;max-width:480px;box-shadow:0 4px 24px rgba(0,0,0,.1)}
      h1{color:#1a3a5c;font-size:22px;margin:0 0 12px}.check{font-size:48px;margin-bottom:16px}p{color:#555;line-height:1.6}</style>
      </head><body><div class="card">
        <div class="check">✅</div>
        <h1>Commande confirmée !</h1>
        <p>Merci <strong>${cmd.distributeur_nom}</strong>, votre bon de commande <strong>${cmd.bdc || '#'+cmd.id}</strong> a bien été confirmé.</p>
        <p style="font-size:13px;color:#888;margin-top:20px">Équipe Éloflex France — nous allons procéder à la préparation.</p>
      </div></body></html>`);
  } catch(e) { res.status(500).send(`<h2>Erreur : ${e.message}</h2>`); }
});

// ── Génération d'une facture dans VosFactures ──────────────────────
router.post('/commandes/:id/generer-facture', adminOrOp, async (req, res) => {
  try {
    if (!process.env.VOSFACTURES_API_TOKEN || !process.env.VOSFACTURES_ACCOUNT)
      return res.json({ ok: false, reason: 'VosFactures non configuré' });
    const cmd = await db.get(`SELECT cmd.*, c.nom AS client_nom FROM commandes cmd
      JOIN clients c ON c.id=cmd.client_id WHERE cmd.id=$1`, [req.params.id]);
    if (!cmd) return res.status(404).json({ error: 'Commande introuvable' });
    const lignes = await db.all('SELECT * FROM commandes_lignes WHERE commande_id=$1 ORDER BY ordre, id', [req.params.id]);
    const axios = require('axios');
    const vfApi = axios.create({ baseURL: `https://${process.env.VOSFACTURES_ACCOUNT}.vosfactures.fr`,
      headers: { 'Accept': 'application/json' }, params: { api_token: process.env.VOSFACTURES_API_TOKEN } });
    // Chercher le client dans VF
    const { data: buyers } = await vfApi.get('/clients.json', { params: { name: cmd.distributeur_nom, per_page: 5 } });
    const buyer = Array.isArray(buyers) ? buyers.find(b => b.name?.toLowerCase().includes(cmd.distributeur_nom.toLowerCase().slice(0, 8))) : null;
    const positions = (lignes.length ? lignes : [{ designation: cmd.modele || 'Commande', quantite: cmd.quantite || 1, reference: cmd.bdc }])
      .map(l => ({ name: l.designation, quantity: String(l.quantite || 1), price_net: '0.00', tax: '20' }));
    const today = new Date().toISOString().slice(0, 10);
    const payload = {
      invoice: {
        kind: 'vat', sell_date: cmd.date_livraison || today, issue_date: today,
        buyer_name: cmd.distributeur_nom,
        positions,
        ...(cmd.bdc ? { description: `Commande ${cmd.bdc}${cmd.num_commande_distrib ? ' / ' + cmd.num_commande_distrib : ''}` } : {})
      }
    };
    let invData;
    try {
      const { data } = await vfApi.post('/invoices.json', payload);
      invData = data;
    } catch(vfErr) {
      const vfMsg = vfErr.response?.data
        ? (typeof vfErr.response.data === 'string' ? vfErr.response.data : JSON.stringify(vfErr.response.data))
        : vfErr.message;
      return res.status(422).json({ error: `VosFactures : ${vfMsg}` });
    }
    if (!invData?.id) return res.json({ ok: false, reason: 'VosFactures n\'a pas retourné d\'identifiant' });
    await db.run('UPDATE commandes SET vf_invoice_id=$1, num_facture=$2, statut=\'Facturé\', updated_at=NOW() WHERE id=$3',
      [invData.id, invData.number || String(invData.id), req.params.id]);
    res.json({ ok: true, invoice_id: invData.id, numero: invData.number, url: `https://${process.env.VOSFACTURES_ACCOUNT}.vosfactures.fr/invoices/${invData.id}` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Création d'un BL (bordereau de livraison) dans VosFactures ─────
router.post('/commandes/:id/creer-bl', adminOrOp, async (req, res) => {
  try {
    if (!process.env.VOSFACTURES_API_TOKEN || !process.env.VOSFACTURES_ACCOUNT)
      return res.json({ ok: false, reason: 'VosFactures non configuré' });
    const cmd = await db.get(`SELECT cmd.*, c.nom AS client_nom FROM commandes cmd
      JOIN clients c ON c.id=cmd.client_id WHERE cmd.id=$1`, [req.params.id]);
    if (!cmd) return res.status(404).json({ error: 'Commande introuvable' });
    const lignes = await db.all('SELECT * FROM commandes_lignes WHERE commande_id=$1 ORDER BY ordre, id', [req.params.id]);
    const axios = require('axios');
    const vfApi = axios.create({ baseURL: `https://${process.env.VOSFACTURES_ACCOUNT}.vosfactures.fr`,
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      params: { api_token: process.env.VOSFACTURES_API_TOKEN } });

    // Chercher le client dans VF
    const { data: buyers } = await vfApi.get('/clients.json', { params: { name: cmd.distributeur_nom, per_page: 5 } });
    const buyer = Array.isArray(buyers) && buyers.length ? buyers[0] : null;

    const positions = (lignes.length ? lignes : [{ designation: cmd.modele || 'Article', quantite: cmd.quantite || 1 }])
      .map(l => ({
        name: l.designation,
        quantity: String(parseInt(l.quantite) || 1),
        price_net: '0.00',
        price_gross: '0.00',
        total_price_net: '0.00',
        total_price_gross: '0.00',
        tax: 'disabled'
      }));

    const today = new Date().toISOString().slice(0, 10);
    const payload = {
      invoice: {
        kind: 'other',
        issue_date: today,
        sell_date: today,
        name: `Bon de livraison`,
        buyer_name: cmd.distributeur_nom,
        positions,
        description: `BDC : ${cmd.bdc || '#' + cmd.id}${cmd.num_commande_distrib ? ' / ' + cmd.num_commande_distrib : ''}`
      }
    };

    let blData;
    try {
      const { data } = await vfApi.post('/invoices.json', payload);
      blData = data;
    } catch(vfErr) {
      // Extraire le message d'erreur VosFactures pour le renvoyer clairement
      const vfMsg = vfErr.response?.data
        ? (typeof vfErr.response.data === 'string' ? vfErr.response.data : JSON.stringify(vfErr.response.data))
        : vfErr.message;
      return res.status(422).json({ error: `VosFactures : ${vfMsg}` });
    }

    if (!blData?.id) return res.json({ ok: false, reason: 'VosFactures n\'a pas retourné d\'identifiant' });
    await db.run('UPDATE commandes SET num_bordereau=$1, updated_at=NOW() WHERE id=$2',
      [blData.number || String(blData.id), req.params.id]);
    res.json({ ok: true, bl_id: blData.id, numero: blData.number, url: `https://${process.env.VOSFACTURES_ACCOUNT}.vosfactures.fr/invoices/${blData.id}` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Migration ponctuelle : commandes antérieures à juin 2026 → Facturé ──
router.post('/commandes/migration-facture-historique', adminOnly, async (req, res) => {
  try {
    const result = await db.run(`
      UPDATE commandes
      SET statut = 'Facturé', updated_at = NOW()
      WHERE statut NOT IN ('Annulé', 'Facturé')
        AND (
          (date_commande IS NOT NULL AND date_commande::date < '2026-06-01')
          OR (date_commande IS NULL AND annee_onglet IS NOT NULL AND annee_onglet < 2026)
        )
    `);
    const count = await db.get(`
      SELECT COUNT(*)::int AS n FROM commandes
      WHERE statut = 'Facturé'
        AND updated_at > NOW() - INTERVAL '10 seconds'
    `);
    res.json({ ok: true, mises_a_jour: count?.n || 0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Email confirmation expédition ──────────────────────────────────
router.post('/commandes/:id/email-expedition', adminOrOp, async (req, res) => {
  try {
    const params = {};
    const prows = await db.all('SELECT cle, valeur FROM parametres');
    prows.forEach(r => params[r.cle] = r.valeur);
    if (params.email_notifications !== '1') return res.json({ ok: false, reason: 'Notifications email désactivées dans Paramètres' });
    if (!params.email_smtp_host || !params.email_smtp_user) return res.json({ ok: false, reason: 'SMTP non configuré dans Paramètres' });
    const cmd = await db.get(`SELECT cmd.*, c.nom AS client_nom, c.email AS client_email
      FROM commandes cmd JOIN clients c ON c.id=cmd.client_id WHERE cmd.id=$1`, [req.params.id]);
    if (!cmd) return res.status(404).json({ error: 'Commande introuvable' });
    if (!cmd.client_email) return res.json({ ok: false, reason: `Pas d'adresse email pour ${cmd.distributeur_nom}` });
    if (!cmd.num_suivi) return res.json({ ok: false, reason: 'Numéro de suivi manquant' });

    const liens = { 'Chronopost':`https://www.chronopost.fr/tracking-no-cms/suivi-page?listeNumerosLT=${cmd.num_suivi}`,
      'Colissimo':`https://www.laposte.fr/outils/suivre-vos-envois?code=${cmd.num_suivi}`,
      'DB Schenker':`https://www.dbschenker.com/track/${cmd.num_suivi}`, 'UPS':`https://www.ups.com/track?tracknum=${cmd.num_suivi}` };
    const lienSuivi = liens[cmd.transporteur]||'';
    const articlesList = cmd.modele||(cmd.accessoire||'').split('\n').slice(0,3).join(', ');
    const types = [cmd.type_fauteuil_neuf && '🆕 Fauteuil Neuf', cmd.type_fauteuil_demo && '🔄 Fauteuil Démo', cmd.type_pieces && '📦 Pièces détachées'].filter(Boolean).join(', ');

    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({ host:params.email_smtp_host, port:parseInt(params.email_smtp_port)||587,
      secure:parseInt(params.email_smtp_port)===465, auth:{user:params.email_smtp_user, pass:params.email_smtp_pass} });
    await transporter.sendMail({
      from: params.email_from||params.email_smtp_user, to: cmd.client_email,
      subject: `[Éloflex] Expédition de votre commande ${cmd.bdc||'#'+cmd.id}`,
      cc: 'sav@eloflex.fr',
      html: `<div style="font-family:sans-serif;max-width:580px;color:#222;margin:0 auto">
        <div style="background:#1a3a5c;padding:20px 24px;border-radius:8px 8px 0 0">
          <h2 style="color:#fff;margin:0;font-size:18px;font-weight:600">Éloflex France — Votre commande est en route !</h2>
        </div>
        <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;padding:24px">
          <table style="border-collapse:collapse;width:100%;font-size:13px;margin:0 0 20px;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden">
            <tr style="background:#f8f9fa"><td style="padding:9px 14px;font-weight:600;color:#555;width:170px;border-bottom:1px solid #e5e7eb">Distributeur</td><td style="padding:9px 14px;border-bottom:1px solid #e5e7eb">${cmd.distributeur_nom}</td></tr>
            ${cmd.groupe ? `<tr><td style="padding:9px 14px;font-weight:600;color:#555;border-bottom:1px solid #e5e7eb">Groupe</td><td style="padding:9px 14px;border-bottom:1px solid #e5e7eb">${cmd.groupe}</td></tr>` : ''}
            <tr style="background:#f8f9fa"><td style="padding:9px 14px;font-weight:600;color:#555;border-bottom:1px solid #e5e7eb">Référence Éloflex</td><td style="padding:9px 14px;border-bottom:1px solid #e5e7eb"><strong>${cmd.bdc||'—'}</strong></td></tr>
            ${cmd.num_commande_distrib ? `<tr><td style="padding:9px 14px;font-weight:600;color:#555;border-bottom:1px solid #e5e7eb">Votre référence</td><td style="padding:9px 14px;border-bottom:1px solid #e5e7eb">${cmd.num_commande_distrib}</td></tr>` : ''}
            ${types ? `<tr style="background:#f8f9fa"><td style="padding:9px 14px;font-weight:600;color:#555;border-bottom:1px solid #e5e7eb">Type</td><td style="padding:9px 14px;border-bottom:1px solid #e5e7eb">${types}</td></tr>` : ''}
            ${articlesList ? `<tr><td style="padding:9px 14px;font-weight:600;color:#555;border-bottom:1px solid #e5e7eb">Article(s)</td><td style="padding:9px 14px;border-bottom:1px solid #e5e7eb">${articlesList}</td></tr>` : ''}
            ${cmd.num_serie ? `<tr style="background:#f8f9fa"><td style="padding:9px 14px;font-weight:600;color:#555;border-bottom:1px solid #e5e7eb">N° série</td><td style="padding:9px 14px;font-family:monospace;border-bottom:1px solid #e5e7eb"><strong>${cmd.num_serie}</strong></td></tr>` : ''}
            <tr${cmd.num_serie?'':' style="background:#f8f9fa"'}><td style="padding:9px 14px;font-weight:600;color:#555;border-bottom:1px solid #e5e7eb">Transporteur</td><td style="padding:9px 14px;border-bottom:1px solid #e5e7eb">${cmd.transporteur||'—'}</td></tr>
            <tr style="background:#f8f9fa"><td style="padding:9px 14px;font-weight:600;color:#555;border-bottom:1px solid #e5e7eb">N° suivi</td><td style="padding:9px 14px;font-family:monospace;border-bottom:1px solid #e5e7eb"><strong>${cmd.num_suivi}</strong></td></tr>
            ${cmd.num_bordereau ? `<tr><td style="padding:9px 14px;font-weight:600;color:#555">N° bordereau</td><td style="padding:9px 14px;font-family:monospace">${cmd.num_bordereau}</td></tr>` : ''}
          </table>
          ${lienSuivi ? `<div style="text-align:center;margin:24px 0"><a href="${lienSuivi}" style="display:inline-block;background:#1a3a5c;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-size:15px;font-weight:600">Suivre mon colis →</a></div>` : ''}
          ${cmd.client_final ? `<p style="margin:0 0 16px;font-size:13px;color:#555;background:#f8f9fa;padding:10px 14px;border-radius:6px;border-left:3px solid #1a3a5c"><strong>Client final :</strong> ${cmd.client_final}</p>` : ''}
          <p style="margin:20px 0 0;font-size:12px;color:#aaa;border-top:1px solid #f0f0f0;padding-top:16px">Éloflex France — Service commercial<br>Pour toute question, répondez à cet email.</p>
        </div>
      </div>`
    });
    res.json({ ok:true, to:cmd.client_email });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Migration N° suivi : déplace les valeurs texte vers informations/num_retour ──
router.post('/commandes/fix-suivi', adminOnly, async (req, res) => {
  try {
    const rows = await db.all(`SELECT id, num_suivi, num_retour, informations FROM commandes
      WHERE num_suivi IS NOT NULL
        AND (LENGTH(REGEXP_REPLACE(num_suivi,'\\s+','','g')) < 8
             OR NOT (REGEXP_REPLACE(num_suivi,'\\s+','','g') ~ '[0-9]'))`);
    let migres = 0;
    for (const r of rows) {
      const note = r.num_suivi.trim();
      const isRetour = /retour|suède|suede|sweden/i.test(note);
      if (isRetour && !r.num_retour) {
        await db.run('UPDATE commandes SET num_suivi=NULL, num_retour=$1 WHERE id=$2', [note, r.id]);
      } else {
        const info = r.informations ? `${r.informations}\n[suivi] ${note}` : `[suivi] ${note}`;
        await db.run('UPDATE commandes SET num_suivi=NULL, informations=$1 WHERE id=$2', [info, r.id]);
      }
      migres++;
    }
    res.json({ ok:true, migres, detail:`${migres} valeur(s) migrée(s)` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
// ── Sync paiement commande individuelle ──────────────────────────
router.post('/commandes/:id/sync-paiement', adminOrOp, async (req, res) => {
  try {
    const cmd = await db.get('SELECT id, num_facture, facture_vf_id FROM commandes WHERE id=$1', [req.params.id]);
    if (!cmd || !cmd.num_facture) return res.json({ ok: false, reason: 'Pas de numéro de facture' });
    if (!process.env.VOSFACTURES_API_TOKEN) return res.json({ ok: false, reason: 'VosFactures non configuré' });
    const axios = require('axios');
    const vfApi = axios.create({
      baseURL: `https://${process.env.VOSFACTURES_ACCOUNT}.vosfactures.fr`,
      headers: { 'Accept': 'application/json' },
      params: { api_token: process.env.VOSFACTURES_API_TOKEN }
    });
    let vfId = cmd.facture_vf_id;
    if (!vfId) {
      const norm = s => String(s||'').toLowerCase().replace(/[\s\-\/\.]+/g,'');
      const n = norm(cmd.num_facture);
      for (const kind of ['vat','receipt','proforma']) {
        try {
          const { data } = await vfApi.get('/invoices.json', { params: { number: cmd.num_facture, kind, per_page: 10 } });
          if (Array.isArray(data) && data.length) {
            const inv = data.find(d => norm(d.number) === n || norm(d.number).endsWith(n));
            if (inv) { vfId = inv.id; break; }
          }
        } catch(_) {}
      }
      if (!vfId) {
        try {
          const { data } = await vfApi.get('/invoices.json', { params: { search_text: cmd.num_facture, per_page: 20 } });
          if (Array.isArray(data)) {
            const norm = s => String(s||'').toLowerCase().replace(/[\s\-\/\.]+/g,'');
            const n = norm(cmd.num_facture);
            const inv = data.find(d => norm(d.number) === n || norm(d.number).endsWith(n));
            if (inv) vfId = inv.id;
          }
        } catch(_) {}
      }
    }
    if (!vfId) return res.json({ ok: false, reason: 'Facture "'+cmd.num_facture+'" introuvable dans VosFactures' });
    const { data: detail } = await vfApi.get('/invoices/'+vfId+'.json');
    const raw = { payment_status: detail.payment_status, status: detail.status, paid_date: detail.paid_date, payment_to: detail.payment_to, paid_sum: detail.paid_sum };
    const isPaid = detail.payment_status === 'paid' || !!detail.paid_date || detail.paid === true;
    const today = new Date().toISOString().slice(0,10);
    const paymentTo = (detail.payment_to||'').slice(0,10);
    const isOverdue = paymentTo && paymentTo < today && !isPaid;
    const statut = isPaid ? 'paye' : isOverdue ? 'impaye' : 'en_attente';
    await db.run('UPDATE commandes SET facture_paiement_statut=$1, facture_date_echeance=$2, facture_vf_id=$3 WHERE id=$4', [statut, paymentTo||null, vfId, cmd.id]);
    console.log('[PAIEMENT]', cmd.num_facture, 'vfId:', vfId, JSON.stringify(raw), '->', statut);
    res.json({ ok: true, vfId, statut, raw });
  } catch(e) { console.error('[PAIEMENT ERR]', e.message); res.status(500).json({ error: e.message }); }
});


