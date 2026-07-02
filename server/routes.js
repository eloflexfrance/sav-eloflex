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
      permissions: user.permissions || {}, langue: user.langue || 'fr'
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

// ── Gestion des utilisateurs (admin only) ─────────────────────────
router.get('/users', adminOnly, async (req, res) => {
  try {
    const rows = await db.all('SELECT id, nom, email, role, permissions, langue, actif, last_login FROM users ORDER BY id');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/users', adminOnly, async (req, res) => {
  try {
    const { nom, email, mot_de_passe, admin: isAdmin, permissions = {}, langue = 'fr' } = req.body;
    if (!nom || !email || !mot_de_passe) return res.status(400).json({ error: 'Nom, email et mot de passe sont requis.' });
    if (mot_de_passe.length < 8) return res.status(400).json({ error: 'Mot de passe : minimum 8 caractères.' });
    const role = isAdmin ? 'admin' : 'utilisateur';
    const hash = await bcrypt.hash(mot_de_passe, 12);
    const user = await db.run(
      'INSERT INTO users (nom, email, password_hash, role, permissions, langue) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, nom, email, role, permissions, langue, actif',
      [nom.trim(), email.toLowerCase().trim(), hash, role, JSON.stringify(permissions), langue || 'fr']
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
    const { nom, email, admin: isAdmin, permissions, actif, langue } = req.body;
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
    if (!sets.length) return res.status(400).json({ error: 'Aucune modification.' });
    p.push(id);
    const user = await db.run(`UPDATE users SET ${sets.join(',')} WHERE id=$${++idx} RETURNING id, nom, email, role, permissions, langue, actif`, p);
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

    const fauteuils = await db.all(`
      SELECT DISTINCT f.*, c.nom AS client_nom, c.id AS client_id,
        (SELECT COUNT(*)::int FROM interventions i WHERE i.fauteuil_id=f.id) AS nb_interventions,
        (SELECT cmd.id FROM commandes cmd WHERE cmd.num_serie=f.serie LIMIT 1) AS commande_id
      FROM fauteuils f JOIN clients c ON c.id=f.client_id
      LEFT JOIN interventions iv ON iv.fauteuil_id=f.id
      WHERE f.serie ILIKE $1 OR f.modele ILIKE $1 OR c.nom ILIKE $1 OR iv.num_sav ILIKE $1
      ORDER BY c.nom, f.date_achat DESC LIMIT 50
    `, [`%${q}%`]);

    const clients = await db.all(`
      SELECT c.*, COUNT(f.id)::int AS nb_fauteuils
      FROM clients c LEFT JOIN fauteuils f ON f.client_id=c.id
      WHERE c.nom ILIKE $1
      GROUP BY c.id ORDER BY c.nom LIMIT 10
    `, [`%${q}%`]);

    // Toutes les commandes du distributeur + correspondances directes (BDC, facture, série)
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
      secure: false, auth: { user: params.email_smtp_user, pass: params.email_smtp_pass }
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
function statutCommande(cmd) {
  if (cmd.statut && cmd.statut !== 'Auto') return cmd.statut;
  if (cmd.date_livraison) return 'Livré';
  if (cmd.num_suivi) return 'Expédié';
  return 'En préparation';
}

router.get('/commandes', async (req, res) => {
  try {
    const { distributeur, client_id, statut, annee, groupe, q, date_from, date_to, page = 1, per_page = 100 } = req.query;
    let sql = `SELECT cmd.*, c.nom AS client_nom, c.ville AS client_ville
               FROM commandes cmd LEFT JOIN clients c ON c.id = cmd.client_id`;
    const conds = [], p = [];
    let idx = 0;
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
    if (statut) rows = rows.filter(r => r.statut_calc === statut);
    const total = rows.length;
    const pp = Math.min(parseInt(per_page) || 100, 500);
    const startIdx = (Math.max(parseInt(page) || 1, 1) - 1) * pp;
    res.json({ total, page: parseInt(page) || 1, per_page: pp, rows: rows.slice(startIdx, startIdx + pp) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/commandes/stats', async (req, res) => {
  try {
    const annee = req.query.annee ? parseInt(req.query.annee) : null;
    // Données filtrées pour les compteurs
    const rows = annee
      ? await db.all('SELECT * FROM commandes WHERE annee_onglet=$1 OR (annee_onglet IS NULL AND EXTRACT(YEAR FROM date_commande::date)=$1)', [annee])
      : await db.all('SELECT * FROM commandes');
    const calc = rows.map(statutCommande);
    // Toutes les années pour le menu déroulant (toujours non filtré)
    const allRows = annee ? await db.all('SELECT annee_onglet, date_commande FROM commandes') : rows;
    const parAnnee = {};
    allRows.forEach(r => {
      const a = r.annee_onglet || (r.date_commande ? new Date(r.date_commande).getFullYear() : null);
      if (a) parAnnee[a] = (parAnnee[a] || 0) + 1;
    });
    const parGroupe = {};
    rows.forEach(r => { if (r.groupe) parGroupe[r.groupe] = (parGroupe[r.groupe] || 0) + 1; });
    const topDistributeurs = {};
    rows.forEach(r => { topDistributeurs[r.distributeur_nom] = (topDistributeurs[r.distributeur_nom] || 0) + 1; });
    res.json({
      total: rows.length,
      en_preparation: calc.filter(s => s === 'En préparation').length,
      expedie: calc.filter(s => s === 'Expédié').length,
      livre: calc.filter(s => s === 'Livré').length,
      probleme: calc.filter(s => s === 'Problème').length,
      facture:  calc.filter(s => s === 'Facturé').length,
      demo:     rows.filter(r => r.modele_demo).length,
      fauteuils_serie: rows.filter(r => /eloflex/i.test(r.modele||'') && r.num_serie).length,
      par_annee: parAnnee,
      par_groupe: parGroupe,
      top_distributeurs: Object.entries(topDistributeurs).sort((a, b) => b[1] - a[1]).slice(0, 10),
      annee_filtre: annee
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    res.json({ ...row, statut_calc: statutCommande(row), lignes });
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
        invoice_se, informations, statut, num_bordereau, reliquat, reliquat_description, modele_demo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING *`,
      [clientId, d.fauteuil_id || null, d.annee_onglet || new Date().getFullYear(), d.groupe || null,
       d.distributeur_nom, d.modele || null, parseInt(d.quantite) || 1, d.accessoire || null, d.bdc || null, d.date_commande || null,
       d.vf_order_id || null, d.client_final || null, d.num_suivi || null, d.transporteur || null, d.date_livraison || null,
       d.num_serie || null, d.num_facture || null, d.invoice_se || null, d.informations || null, d.statut || 'Auto',
       d.num_bordereau || null, d.reliquat ? true : false, d.reliquat_description || null, d.modele_demo ? true : false]
    );
    res.status(201).json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/commandes/:id', async (req, res) => {
  try {
    const d = req.body;
    const champs = ['client_id', 'fauteuil_id', 'annee_onglet', 'groupe', 'distributeur_nom', 'modele', 'quantite', 'accessoire',
      'bdc', 'date_commande', 'vf_order_id', 'client_final', 'num_suivi', 'transporteur', 'date_livraison', 'num_serie',
      'num_facture', 'invoice_se', 'informations', 'statut', 'num_bordereau', 'reliquat', 'reliquat_description', 'modele_demo'];
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
      return res.json({ factures: [], configured: true, reason: 'Distributeur non lié à un client VosFactures' });
    }

    const axios = require('axios');
    const vfApi = axios.create({
      baseURL: `https://${process.env.VOSFACTURES_ACCOUNT}.vosfactures.fr`,
      headers: { 'Accept': 'application/json' },
      params:  { api_token: process.env.VOSFACTURES_API_TOKEN }
    });

    const { data } = await vfApi.get('/invoices.json', {
      params: { client_id: cmd.vf_id, kind: 'vat', per_page: 15, order: 'issue_date.desc' }
    });

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
    const row = await db.run(
      `UPDATE commandes SET preuve_livraison_filename=$1, preuve_livraison_url=$2, preuve_livraison_mime=$3,
        preuve_livraison_taille=$4, preuve_livraison_storage=$5, preuve_livraison_uploaded_at=NOW(), updated_at=NOW()
       WHERE id=$6 RETURNING *`,
      [saved.filename, saved.url, saved.mime, saved.taille, saved.storage, req.params.id]
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

    // Cherche dans tous types : BDC, stock, devis, facture, bordereau de livraison
    let inv = null;
    for (const kind of ['client_order', 'stock', 'estimate', 'vat', 'receipt']) {
      const { data } = await vfApi.get('/invoices.json', { params: { number: numero, kind, per_page: 5 } });
      inv = Array.isArray(data) ? data.find(d => String(d.number).trim() === numero) || null : null;
      if (inv) break;
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
      numero:        detail.number || inv.number,
      date_commande: (detail.issue_date || detail.sell_date || '').slice(0, 10) || null,
      distributeur:  detail.buyer_name || inv.buyer_name || null,
      modele, quantite, lignes,
      num_serie: mSerie ? mSerie[0].trim() : null,
      kind: detail.kind || inv.kind,
      modele_demo: modeleDemo,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
