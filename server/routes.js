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

// ── Formatage universel des numéros de téléphone → « 09 67 66 51 29 » ──────
// Appliqué à l'enregistrement pour que toutes les bases stockent le même format.
function fmtTel(v) {
  if (v == null) return v;
  const raw = String(v).trim(); if (!raw) return raw;
  let d = raw.replace(/[^\d+]/g, ''); let plus = false;
  if (/^\+33/.test(d)) d = '0' + d.slice(3);
  else if (/^0033/.test(d)) d = '0' + d.slice(4);
  else if (d[0] === '+') { plus = true; d = d.slice(1); }
  d = d.replace(/\D/g, ''); if (!d) return raw;
  const pairs = d.match(/\d{1,2}/g) || [];
  return (plus ? '+' : '') + pairs.join(' ');
}

// ── Helpers de permission ──────────────────────────────────────────
// Détermine le module depuis le chemin de la route
function moduleFromPath(p) {
  if (p.startsWith('/carte'))                       return 'carte';
  if (p.startsWith('/clients'))                     return 'clients';
  if (p.startsWith('/fauteuils')||p.startsWith('/interventions')) return 'interventions';
  if (p.startsWith('/demandes-info'))               return 'demandes';
  if (p.startsWith('/prets'))                       return 'prets';
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
  const perms = user.permissions || {};
  // Fallback : la carte hérite de 'clients' si sa permission n'est pas définie
  // (utilisateurs créés avant l'ajout du module carte)
  let perm = perms[module];
  if (perm === undefined && module === 'carte') perm = perms['clients'];
  perm = perm || 'none';
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

// ── Journal d'activité : enregistre chaque écriture réussie (POST/PUT/PATCH/DELETE) ──
// Placé APRÈS le contrôle de permissions : on ne journalise que les actions autorisées.
const LOG_SKIP = ['/login', '/logout', '/me', '/setup', '/session', '/logs'];
router.use((req, res, next) => {
  const method = req.method;
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return next();
  const chemin = req.path;
  if (LOG_SKIP.some(s => chemin === s || chemin.startsWith(s + '/'))) return next();
  res.on('finish', () => {
    try {
      if (res.statusCode >= 400) return; // n'enregistre que les opérations réussies
      const user = res.locals.user || {};
      let module = moduleFromPath(chemin);
      if (!module) { const seg = chemin.split('/').filter(Boolean)[0]; module = seg || 'autre'; }
      const action = method === 'POST' ? 'Ajout' : method === 'DELETE' ? 'Suppression' : 'Modification';
      const m = chemin.match(/\/(\d+)(?:\/|$)/);
      const cible = m ? m[1] : null;
      db.run(
        `INSERT INTO activity_logs (user_id, user_nom, action, module, methode, chemin, cible_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [user.id || null, user.nom || user.email || '—', action, module, method, chemin, cible]
      ).catch(() => {});
    } catch (_) {}
  });
  next();
});

function requireRole(...roles) {
  return (req, res, next) => {
    const userRole = res.locals.user?.role;
    if (!res.locals.user) return res.status(403).json({ error: 'Non authentifié' });
    if (roles.length && !roles.includes(userRole)) return res.status(403).json({ error: 'Accès refusé pour ce rôle' });
    next();
  };
}
const requireAuth = requireRole();
const adminOnly = requireRole('admin');
const adminOrOp  = requireRole('admin', 'operateur');

// Écriture sur la carte : admin, ou permission 'carte'=write (repli 'clients').
// Permet aux utilisateurs "droits complets" d'utiliser les outils carte sous /admin.
const carteWrite = (req, res, next) => {
  const user = res.locals.user;
  if (!user) return res.status(403).json({ error: 'Non authentifié' });
  if (user.role === 'admin') return next();
  const perms = user.permissions || {};
  let perm = perms['carte'];
  if (perm === undefined) perm = perms['clients'];
  if (perm === 'write') return next();
  return res.status(403).json({ error: 'Accès en écriture refusé sur le module "carte".' });
};

// ── Journal d'activité (logs) — lecture accessible à tout utilisateur connecté ──
router.get('/logs', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 200, 500);
    const conds = [], p = []; let i = 0;
    if (req.query.module) { conds.push(`module=$${++i}`); p.push(req.query.module); }
    if (req.query.action) { conds.push(`action=$${++i}`); p.push(req.query.action); }
    if (req.query.user)   { conds.push(`user_nom ILIKE $${++i}`); p.push('%' + req.query.user + '%'); }
    if (req.query.q)      { conds.push(`(user_nom ILIKE $${++i} OR module ILIKE $${i} OR chemin ILIKE $${i})`); p.push('%' + req.query.q + '%'); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const rows = await db.all(`SELECT * FROM activity_logs ${where} ORDER BY created_at DESC LIMIT ${limit}`, p);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
// ── Migration ponctuelle : colonne entite_facturation_id sur clients ──
// À ouvrir UNE FOIS dans le navigateur (connecté en admin) après déploiement :
//   https://TON-APP.onrender.com/api/admin/migrer-entite-facturation
// Sans risque de la relancer plusieurs fois (IF NOT EXISTS) — tu peux laisser
// cette route en place, ou la retirer une fois la migration confirmée faite.
router.get('/admin/migrer-entite-facturation', adminOnly, async (req, res) => {
  try {
    await db.run('ALTER TABLE clients ADD COLUMN IF NOT EXISTS entite_facturation_id INTEGER REFERENCES clients(id)');
    res.send('<h2>✅ Migration effectuée</h2><p>La colonne entite_facturation_id existe désormais sur la table clients.</p>');
  } catch (e) {
    res.status(500).send(`<h2>❌ Erreur</h2><pre>${e.message}</pre>`);
  }
});

// ── Réparation : les points importés du KML n'ont jamais coché "sur_carte" sur la
//    fiche. Après rattachement des points aux fiches (client_id), on se retrouve avec
//    des fiches "sur la carte" mais case décochée → sauvegarder la fiche SUPPRIMERAIT
//    le point (syncClientCarte le retire quand sur_carte est faux). Cette route coche
//    sur_carte ET recopie les coordonnées du point sur la fiche (si absentes) pour
//    tous les clients ayant un point lié → cohérent et sûr. Idempotente.
router.get('/admin/sync-sur-carte', adminOnly, async (req, res) => {
  try {
    const c = await db.get(
      `SELECT COUNT(DISTINCT c.id)::int AS n
         FROM clients c JOIN distributeurs_carte dc ON dc.client_id = c.id
        WHERE c.sur_carte = FALSE`
    );
    await db.run(
      `UPDATE clients c
          SET sur_carte = TRUE,
              lat = COALESCE(c.lat, dc.lat),
              lng = COALESCE(c.lng, dc.lng),
              geocoded_at = COALESCE(c.geocoded_at, NOW()),
              updated_at = NOW()
         FROM distributeurs_carte dc
        WHERE dc.client_id = c.id AND c.sur_carte = FALSE`
    );
    res.json({ ok: true, fiches_corrigees: c ? c.n : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/clients', async (req, res) => {
  try {
    const q = `%${req.query.q || ''}%`;
    // Comptages via jointures groupées (bien plus rapide que 2 sous-requêtes corrélées par ligne)
    const rows = await db.all(
      `SELECT c.*,
        COALESCE(nf.n, 0) AS nb_fauteuils,
        COALESCE(ni.n, 0) AS nb_interventions,
        COALESCE(nc.n_fauteuils, 0) AS nb_fauteuils_vendus,
        nc.derniere_commande,
        COALESCE(nd.n, 0) AS nb_demandes_info
       FROM clients c
       LEFT JOIN (SELECT client_id, COUNT(*)::int AS n FROM fauteuils GROUP BY client_id) nf ON nf.client_id = c.id
       LEFT JOIN (SELECT client_id, COUNT(*)::int AS n FROM interventions GROUP BY client_id) ni ON ni.client_id = c.id
       LEFT JOIN (
         SELECT client_id,
                MAX(date_commande) AS derniere_commande,
                COUNT(*) FILTER (WHERE commande_type='fauteuil' OR type_fauteuil_neuf=TRUE OR type_fauteuil_demo=TRUE OR modele ILIKE '%eloflex%')::int AS n_fauteuils
         FROM commandes GROUP BY client_id
       ) nc ON nc.client_id = c.id
       LEFT JOIN (SELECT client_id, COUNT(*)::int AS n FROM demandes_info GROUP BY client_id) nd ON nd.client_id = c.id
       WHERE c.nom ILIKE $1 OR c.contact ILIKE $1 OR c.ville ILIKE $1
          OR c.adresse ILIKE $1 OR c.cp ILIKE $1 OR c.email ILIKE $1
       ORDER BY c.nom`,
      [q]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Liste les distributeurs dont l'adresse (rue) est absente, avec suggestion VosFactures.
// IMPORTANT : doit être déclarée AVANT /clients/:id sinon Express la capture comme un id.
// Renvoie le réseau (reseau_carte) d'un distributeur à partir de son nom, pour
// pré-remplir le "Groupe" d'une commande. Rapprochement exact puis par memeEntite.
// IMPORTANT : déclarée AVANT /clients/:id sinon Express la capture comme un id.
router.get('/clients/reseau-par-nom', requireAuth, async (req, res) => {
  try {
    const nom = (req.query.nom || '').trim();
    if (!nom) return res.json({ reseau: null });
    // 1) correspondance exacte (insensible à la casse)
    let cl = await db.get(
      `SELECT id, nom, reseau_carte FROM clients WHERE LOWER(nom)=LOWER($1) AND reseau_carte IS NOT NULL LIMIT 1`,
      [nom]
    );
    // 2) sinon rapprochement souple sur les distributeurs qui ont un réseau
    if (!cl) {
      const candidats = await db.all(
        `SELECT id, nom, reseau_carte FROM clients WHERE type <> 'Particulier' AND reseau_carte IS NOT NULL`
      );
      cl = candidats.find(c => memeEntite(nom, c.nom)) || null;
    }
    res.json({ reseau: cl ? cl.reseau_carte : null, nom: cl ? cl.nom : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/clients/adresses-incompletes', requireAuth, async (req, res) => {
  try {
    const locaux = await db.all(`
      SELECT id, nom, vf_id, adresse, adresse2, cp, ville, pays
      FROM clients
      WHERE type <> 'Particulier'
        AND (adresse IS NULL OR TRIM(adresse) = '')
      ORDER BY nom
    `);
    let contactsVF = [];
    if (process.env.VOSFACTURES_API_TOKEN && process.env.VOSFACTURES_ACCOUNT) {
      try { contactsVF = await _fetchTousContactsVF(); } catch (_) { contactsVF = []; }
    }
    const parVfId = {};
    for (const c of contactsVF) parVfId[c.id] = c;
    const parNom = {};
    for (const c of contactsVF) {
      const k = _normaliserNomVF(c.name);
      if (k && !parNom[k]) parNom[k] = c;
    }
    const lignes = locaux.map(cl => {
      let vf = (cl.vf_id && parVfId[cl.vf_id]) ? parVfId[cl.vf_id] : (parNom[_normaliserNomVF(cl.nom)] || null);
      return {
        id: cl.id, nom: cl.nom,
        ville: cl.ville || '', cp: cl.cp || '', pays: cl.pays || 'France',
        vf_street: vf ? (vf.street || '') : '',
        vf_post_code: vf ? (vf.post_code || '') : '',
        vf_city: vf ? (vf.city || '') : '',
        suggestion_dispo: !!(vf && vf.street)
      };
    });
    res.json({
      configured: contactsVF.length > 0,
      total: lignes.length,
      avec_suggestion: lignes.filter(l => l.suggestion_dispo).length,
      lignes
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/clients/:id', async (req, res) => {
  try {
    const cid = parseInt(req.params.id);
    if (!Number.isInteger(cid)) return res.status(404).json({ error: 'Client non rattaché (aucune fiche pour cette commande)' });
    const cl = await db.get('SELECT * FROM clients WHERE id=$1', [cid]);
    if (!cl) return res.status(404).json({ error: 'Introuvable' });
    if (cl.entite_facturation_id) {
      const ef = await db.get('SELECT id, nom FROM clients WHERE id=$1', [cl.entite_facturation_id]);
      cl.entite_facturation_nom = ef ? ef.nom : null;
    }
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
    const { nom, contact, email, tel, portable, ville, type, edi, sur_carte, reseau_carte,
            adresse, adresse2, cp, pays, entite_facturation_id, public_site, priorite, annotation } = req.body;
    if (!nom) return res.status(400).json({ error: 'Nom requis' });
    const token = crypto.randomBytes(20).toString('hex');
    const cl = await db.run(
      `INSERT INTO clients (nom,contact,email,tel,portable,ville,type,token_portail,edi,sur_carte,reseau_carte,
                            adresse,adresse2,cp,pays,entite_facturation_id,public_site,priorite,annotation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [nom, contact||null, email||null, fmtTel(tel)||null, fmtTel(portable)||null, ville||null, type||'Distributeur', token,
       !!edi, !!sur_carte, reseau_carte||null,
       adresse||null, adresse2||null, cp||null, pays||null, entite_facturation_id||null, !!public_site, priorite||null, annotation||null]
    );
    let carte = null;
    if (sur_carte) carte = await syncClientCarte(cl.id);
    res.status(201).json({ ...cl, carte });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/clients/:id', async (req, res) => {
  try {
    const { nom, contact, email, tel, portable, ville, type, edi, sur_carte, reseau_carte,
            adresse, adresse2, cp, pays, entite_facturation_id, public_site, priorite, annotation } = req.body;
    const avant = await db.get('SELECT ville, adresse, cp, lat, lng FROM clients WHERE id=$1', [req.params.id]);
    const cl = await db.run(
      `UPDATE clients SET nom=$1,contact=$2,email=$3,tel=$4,portable=$5,ville=$6,type=$7,
       edi=$8,sur_carte=$9,reseau_carte=$10,
       adresse=$11,adresse2=$12,cp=$13,pays=$14,entite_facturation_id=$15,public_site=$16,priorite=$17,
       annotation=COALESCE($18,annotation),updated_at=NOW() WHERE id=$19 RETURNING *`,
      [nom, contact, email, fmtTel(tel), fmtTel(portable)||null, ville, type, !!edi, !!sur_carte, reseau_carte||null,
       adresse||null, adresse2||null, cp||null, pays||null,
       (entite_facturation_id && parseInt(entite_facturation_id) !== parseInt(req.params.id)) ? entite_facturation_id : null,
       !!public_site, priorite||null,
       (annotation===undefined?null:annotation),
       req.params.id]
    );
    // Adresse modifiée : les anciennes coordonnées ne valent plus rien
    if (avant && (avant.ville !== ville || avant.adresse !== (adresse||null) || avant.cp !== (cp||null))) {
      await db.run('UPDATE clients SET lat=NULL, lng=NULL WHERE id=$1', [req.params.id]);
    }
    const carte = await syncClientCarte(req.params.id);
    res.json({ ...cl, carte });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Enregistre uniquement l'annotation (information spécifique) d'une fiche ──
router.put('/clients/:id/annotation', async (req, res) => {
  try {
    const annotation = (req.body && typeof req.body.annotation === 'string') ? req.body.annotation : '';
    const row = await db.run('UPDATE clients SET annotation=$1, updated_at=NOW() WHERE id=$2 RETURNING id, annotation',
      [annotation.trim() || null, req.params.id]);
    if (!row) return res.status(404).json({ error: 'Fiche introuvable' });
    res.json({ ok: true, annotation: row.annotation });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Poser / réparer le lien VosFactures (vf_id) d'une fiche ──────────
// Utilisé pour le rattrapage des liens manquants issus de la comparaison VF↔app.
router.post('/admin/client-set-vfid', adminOnly, async (req, res) => {
  try {
    const cid = parseInt(req.body.client_id);
    if (!Number.isInteger(cid)) return res.status(400).json({ error: 'client_id invalide' });
    const brut = req.body.vf_id;
    const vid = (brut === null || brut === '' || brut === undefined) ? null : parseInt(brut);
    if (vid !== null && !Number.isInteger(vid)) return res.status(400).json({ error: 'vf_id invalide' });
    const row = await db.run('UPDATE clients SET vf_id=$1, updated_at=NOW() WHERE id=$2 RETURNING id, nom, vf_id', [vid, cid]);
    if (!row) return res.status(404).json({ error: 'Fiche introuvable' });
    res.json({ ok: true, client: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Change UNIQUEMENT le Type d'une fiche (ex. passage rapide en "Particulier"
// depuis la carte), sans toucher aux autres champs. ─────────────────────────
router.post('/clients/:id/type', async (req, res) => {
  try {
    const type = (req.body && req.body.type) ? String(req.body.type).trim() : '';
    if (!type) return res.status(400).json({ error: 'type requis' });
    const row = await db.run('UPDATE clients SET type=$1, updated_at=NOW() WHERE id=$2 RETURNING id, nom, type', [type, req.params.id]);
    if (!row) return res.status(404).json({ error: 'Fiche introuvable' });
    res.json({ ok: true, client: row });
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
    const { client_id, modele, serie, annee, couleur, date_achat, num_facture, duree_garantie_mois, notes } = req.body;
    // Permet de changer le distributeur (client_id) uniquement s'il est fourni ;
    // COALESCE garde la valeur existante si client_id est absent/null.
    const f = await db.run(
      `UPDATE fauteuils SET client_id=COALESCE($1, client_id),
         modele=$2,serie=$3,annee=$4,couleur=$5,date_achat=$6,num_facture=$7,
         duree_garantie_mois=$8,notes=$9,updated_at=NOW() WHERE id=$10 RETURNING *`,
      [client_id || null, modele, serie, annee, couleur, date_achat, num_facture, duree_garantie_mois||24, notes, req.params.id]
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

// ── Bascule SAV → commande : crée une commande LIÉE (catégorie "SAV facturé"),
//    idempotente (si déjà liée, renvoie la commande existante). Sert au cas
//    "BL VosFactures d'un SAV hors garantie transformé en facture".
router.post('/interventions/:id/basculer-commande', async (req, res) => {
  try {
    const i = await db.get(
      `SELECT i.*, f.modele, f.serie, c.nom AS client_nom
         FROM interventions i JOIN fauteuils f ON f.id=i.fauteuil_id JOIN clients c ON c.id=i.client_id
        WHERE i.id=$1`, [req.params.id]);
    if (!i) return res.status(404).json({ error: 'Intervention introuvable' });
    if (i.commande_id) {
      const ex = await db.get('SELECT id FROM commandes WHERE id=$1', [i.commande_id]);
      if (ex) return res.json({ ok: true, commande_id: i.commande_id, existant: true });
    }
    const annee = i.date ? parseInt(String(i.date).slice(0, 4)) : new Date().getFullYear();
    const infos = 'SAV ' + (i.num_sav || ('#' + i.id)) + (i.description ? (' — ' + i.description) : '');
    // Suivi + date : on reprend l'expédition (Envoi) du SAV, sinon le Retour
    const suivi = i.envoi_numero || i.retour_numero || null;
    const transp = i.envoi_transporteur || i.retour_transporteur || null;
    const dateLivr = i.envoi_date || i.retour_date || null;
    const row = await db.run(
      `INSERT INTO commandes (client_id, fauteuil_id, annee_onglet, groupe, distributeur_nom, modele,
        bdc, date_commande, num_serie, num_facture, informations, statut, origine, intervention_id,
        num_suivi, transporteur, date_livraison)
       VALUES ($1,$2,$3,'SAV',$4,$5,$6,$7,$8,$9,$10,'Auto','sav',$11,$12,$13,$14) RETURNING id`,
      [i.client_id, i.fauteuil_id, annee, i.client_nom, i.modele || null,
       i.num_bordereau_vf || null, i.date || null, i.serie || null, i.num_facture || null, infos, i.id,
       suivi, transp, dateLivr]);
    await db.run('UPDATE interventions SET commande_id=$1, updated_at=NOW() WHERE id=$2', [row.id, i.id]);
    // Recopier les pièces du SAV comme lignes de la commande (contenu du bordereau)
    const prods = await db.all('SELECT ref, designation, qte FROM intervention_produits WHERE intervention_id=$1 ORDER BY id', [i.id]);
    let nbLignes = 0;
    for (let k = 0; k < prods.length; k++) {
      const pr = prods[k];
      if (!pr.designation) continue;
      await db.run(
        'INSERT INTO commandes_lignes (commande_id, designation, reference, quantite, ordre) VALUES ($1,$2,$3,$4,$5)',
        [row.id, pr.designation, pr.ref || null, parseInt(pr.qte) || 1, k]
      );
      nbLignes++;
    }
    res.json({ ok: true, commande_id: row.id, cree: true, lignes: nbLignes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Bascule commande → SAV : crée une intervention LIÉE (idempotente).
router.post('/commandes/:id/basculer-intervention', async (req, res) => {
  try {
    const cmd = await db.get('SELECT * FROM commandes WHERE id=$1', [req.params.id]);
    if (!cmd) return res.status(404).json({ error: 'Commande introuvable' });
    if (cmd.intervention_id) {
      const ex = await db.get('SELECT id FROM interventions WHERE id=$1', [cmd.intervention_id]);
      if (ex) return res.json({ ok: true, intervention_id: cmd.intervention_id, existant: true });
    }
    if (!cmd.client_id) return res.status(400).json({ error: "Commande non rattachée à une fiche client — impossible de créer un SAV." });
    let fid = cmd.fauteuil_id;
    if (!fid && cmd.num_serie) {
      const f = await db.get('SELECT id FROM fauteuils WHERE serie=$1', [cmd.num_serie]);
      if (f) fid = f.id;
    }
    if (!fid) return res.status(400).json({ error: "Aucun fauteuil (ni n° de série connu) sur cette commande — nécessaire pour créer un SAV." });
    const desc = 'Créé depuis la commande ' + (cmd.bdc || ('#' + cmd.id));
    const r = await db.run(
      `INSERT INTO interventions (fauteuil_id, client_id, date, type, garantie, statut, description, num_facture, commande_id)
       VALUES ($1,$2,$3,'Réparation',FALSE,'Ouvert',$4,$5,$6) RETURNING id`,
      [fid, cmd.client_id, cmd.date_commande || new Date().toISOString().slice(0, 10), desc, cmd.num_facture || null, cmd.id]);
    await db.run('UPDATE commandes SET intervention_id=$1, updated_at=NOW() WHERE id=$2', [r.id, cmd.id]);
    res.json({ ok: true, intervention_id: r.id, cree: true });
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
        `UPDATE interventions SET type=COALESCE($1,type),garantie=COALESCE($2,garantie),statut=COALESCE($3,statut),description=COALESCE($4,description),notes=COALESCE($5,notes),technicien=COALESCE($6,technicien),
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
      'INSERT INTO catalogue (ref,designation,fournisseur,ref_fournisseur,pxht,stock,stock_alerte,stock_actif,vf_product_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [ref, designation, fournisseur||null, ref_fournisseur||null, pxht||0, stock||0, stock_alerte||2, stock_actif!==false, vf_product_id||null]
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

// ── COMMANDES SUÈDE (réapprovisionnement stock pièces détachées) ───

// Migration ponctuelle — à ouvrir UNE FOIS dans le navigateur (admin) après déploiement :
//   https://sav-eloflex.onrender.com/api/admin/migrer-commande-suede
router.get('/admin/migrer-commande-suede', adminOnly, async (req, res) => {
  try {
    await db.run(`CREATE TABLE IF NOT EXISTS commandes_suede (
      id SERIAL PRIMARY KEY,
      numero_bc TEXT NOT NULL,
      vf_id INTEGER,
      fournisseur TEXT DEFAULT 'Eloflex AB',
      date_commande DATE,
      transporteur TEXT,
      num_suivi TEXT,
      date_livraison DATE,
      statut TEXT DEFAULT 'En cours',
      stock_integre BOOLEAN DEFAULT FALSE,
      integre_le TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`);
    await db.run(`CREATE TABLE IF NOT EXISTS commandes_suede_lignes (
      id SERIAL PRIMARY KEY,
      commande_id INTEGER REFERENCES commandes_suede(id) ON DELETE CASCADE,
      catalogue_id INTEGER REFERENCES catalogue(id),
      reference TEXT,
      designation TEXT,
      quantite_commandee INTEGER DEFAULT 1,
      quantite_recue INTEGER,
      reliquat INTEGER DEFAULT 0,
      ordre INTEGER DEFAULT 0
    )`);
    res.send('<h2>✅ Migration effectuée</h2><p>Tables commandes_suede et commandes_suede_lignes créées.</p>');
  } catch (e) {
    res.status(500).send(`<h2>❌ Erreur</h2><pre>${e.message}</pre>`);
  }
});

// Recherche un document de stock VosFactures par numéro et renvoie son contenu (aperçu, sans écriture en base)
router.get('/vosfactures/stock-lookup', async (req, res) => {
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
      params: { api_token: process.env.VOSFACTURES_API_TOKEN }
    });
    const normalise = s => String(s || '').toLowerCase().replace(/[\s\-\/\.]+/g, '');
    const numNorm = normalise(numero);
    let doc = null;
    let source = null; // 'warehouse' ou 'invoice'
    const debug = []; // journal des tentatives, retourné si rien n'est trouvé

    // 1. Documents d'entrepôt (PZ = réception externe fournisseur = notre cas d'usage), sans le paramètre "order" fautif
    for (const kind of ['pz', 'pw', 'mm', 'wz', 'rw', 'bt']) {
      if (doc) break;
      for (let page = 1; page <= 5; page++) {
        try {
          const { data } = await vfApi.get('/warehouse_documents.json', { params: { kind, per_page: 100, page } });
          if (!Array.isArray(data) || !data.length) break;
          if (page === 1) debug.push(`warehouse kind=${kind} page1 → ${data.length} doc(s), ex: ${data.slice(0, 3).map(d => d.number).join(', ')}`);
          doc = data.find(d => normalise(d.number) === numNorm) || data.find(d => normalise(d.number).includes(numNorm)) || null;
          if (doc) { source = 'warehouse'; break; }
          if (data.length < 100) break;
        } catch (e) { debug.push(`warehouse kind=${kind} page${page} → ERREUR ${e.response?.status || ''} ${e.message}`); break; }
      }
    }

    // 1bis. Toujours pas trouvé : peut-être un autre entrepôt que celui par défaut — on les liste et on les interroge chacun
    if (!doc) {
      try {
        const { data: entrepots } = await vfApi.get('/warehouses.json');
        if (Array.isArray(entrepots) && entrepots.length) {
          debug.push(`entrepôts trouvés : ${entrepots.map(w => `${w.name}(#${w.id})`).join(', ')}`);
          for (const w of entrepots) {
            if (doc) break;
            try {
              const { data } = await vfApi.get('/warehouse_documents.json', { params: { warehouse_id: w.id, per_page: 100, page: 1 } });
              if (Array.isArray(data) && data.length) {
                debug.push(`warehouse_id=${w.id} (${w.name}) → ${data.length} doc(s), ex: ${data.slice(0, 5).map(d => `${d.number}[${d.kind}]`).join(', ')}`);
                doc = data.find(d => normalise(d.number) === numNorm) || data.find(d => normalise(d.number).includes(numNorm)) || null;
                if (doc) source = 'warehouse';
              } else {
                debug.push(`warehouse_id=${w.id} (${w.name}) → aucun document`);
              }
            } catch (e) { debug.push(`warehouse_id=${w.id} → ERREUR ${e.response?.status || ''} ${e.message}`); }
          }
        } else {
          debug.push('GET /warehouses.json → aucun entrepôt distinct (compte à entrepôt unique)');
        }
      } catch (e) { debug.push(`GET /warehouses.json → ERREUR ${e.response?.status || ''} ${e.message}`); }
    }

    // 2. Repli : recherche large sur les factures classiques
    if (!doc) {
      try {
        const { data } = await vfApi.get('/invoices.json', { params: { search_text: numero, per_page: 25 } });
        debug.push(`search_text=${numero} → ${Array.isArray(data) ? data.length : -1} résultat(s)`);
        if (Array.isArray(data) && data.length) {
          doc = data.find(d => normalise(d.number) === numNorm) || data.find(d => normalise(d.number).includes(numNorm)) || null;
          if (doc) source = 'invoice';
        }
      } catch (e) { debug.push(`search_text=${numero} → ERREUR ${e.response?.status || ''} ${e.message}`); }
    }
    if (!doc) {
      for (let page = 1; page <= 10 && !doc; page++) {
        try {
          const { data } = await vfApi.get('/invoices.json', { params: { per_page: 100, page, order: 'issue_date.desc' } });
          if (!Array.isArray(data) || !data.length) break;
          doc = data.find(d => normalise(d.number) === numNorm) || data.find(d => normalise(d.number).includes(numNorm)) || null;
          if (doc) source = 'invoice';
          if (data.length < 100) break;
        } catch (e) { debug.push(`invoices page${page} → ERREUR ${e.response?.status || ''} ${e.message}`); break; }
      }
    }

    if (!doc) return res.json({ configured: true, found: false, debug });

    // Rapprochement avec le catalogue local : priorité au vf_product_id, sinon à la désignation
    const catalogue = await db.all('SELECT id, ref, designation, vf_product_id FROM catalogue');
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    function rapprocher(productId, texte) {
      let cat = null;
      if (productId) cat = catalogue.find(c => c.vf_product_id === productId);
      if (!cat) {
        const pn = norm(texte);
        cat = catalogue.find(c => norm(c.ref) === pn)
           || catalogue.find(c => pn.length > 3 && (norm(c.designation).includes(pn) || pn.includes(norm(c.ref))));
      }
      return cat;
    }

    let lignes, dateDoc, fournisseur;
    if (source === 'warehouse') {
      const { data: detail } = await vfApi.get(`/warehouse_documents/${doc.id}.json`);
      const actions = detail.warehouse_actions || [];
      lignes = actions.map(a => {
        const cat = rapprocher(a.product_id, a.product_name || a.name);
        return {
          reference: cat ? cat.ref : '',
          designation: a.product_name || a.name || '',
          quantite: parseInt(a.quantity) || 1,
          catalogue_id: cat ? cat.id : null,
          catalogue_ref: cat ? cat.ref : null,
          catalogue_designation: cat ? cat.designation : null
        };
      });
      dateDoc = detail.issue_date;
      fournisseur = detail.client_name || 'Eloflex AB';
    } else {
      const { data: detail } = await vfApi.get(`/invoices/${doc.id}.json`);
      const positions = detail.positions || detail.invoice_items || [];
      lignes = positions.map(p => {
        const cat = rapprocher(p.product_id, p.code || p.name);
        return {
          reference: p.code || (cat ? cat.ref : ''),
          designation: p.name || '',
          quantite: parseInt(p.quantity) || 1,
          catalogue_id: cat ? cat.id : null,
          catalogue_ref: cat ? cat.ref : null,
          catalogue_designation: cat ? cat.designation : null
        };
      });
      dateDoc = detail.issue_date || detail.sell_date;
      fournisseur = detail.seller_name || 'Eloflex AB';
    }

    res.json({
      configured: true, found: true, vf_id: doc.id, numero: doc.number, source,
      date: dateDoc, fournisseur, lignes
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Import direct d'un document entrepôt VosFactures par son ID (collé depuis l'URL)
// Même format de sortie que stock-lookup, pour rester cohérent côté front.
router.get('/vosfactures/stock-doc/:id', async (req, res) => {
  try {
    if (!process.env.VOSFACTURES_API_TOKEN || !process.env.VOSFACTURES_ACCOUNT) {
      return res.json({ configured: false });
    }
    const axios = require('axios');
    const vfApi = axios.create({
      baseURL: `https://${process.env.VOSFACTURES_ACCOUNT}.vosfactures.fr`,
      headers: { 'Accept': 'application/json' },
      params: { api_token: process.env.VOSFACTURES_API_TOKEN }
    });
    // On tente d'abord le document d'entrepôt (cas de l'URL warehouse_documents/xxxx),
    // puis la facture classique si le premier échoue.
    let detail = null, source = null;
    const estEntrepot = req.query.warehouse === '1';
    const essais = estEntrepot
      ? [['warehouse', `/warehouse_documents/${req.params.id}.json`], ['invoice', `/invoices/${req.params.id}.json`]]
      : [['invoice', `/invoices/${req.params.id}.json`], ['warehouse', `/warehouse_documents/${req.params.id}.json`]];
    for (const [src, url] of essais) {
      try {
        const { data } = await vfApi.get(url);
        if (data && data.id) { detail = data; source = src; break; }
      } catch (_) { /* on tente l'autre ressource */ }
    }
    if (!detail) return res.json({ configured: true, found: false });

    // Rapprochement catalogue — même logique que stock-lookup
    const catalogue = await db.all('SELECT id, ref, designation, vf_product_id FROM catalogue');
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    function rapprocher(productId, texte) {
      let cat = null;
      if (productId) cat = catalogue.find(c => c.vf_product_id === productId);
      if (!cat) {
        const pn = norm(texte);
        cat = catalogue.find(c => norm(c.ref) === pn)
           || catalogue.find(c => pn.length > 3 && (norm(c.designation).includes(pn) || pn.includes(norm(c.ref))));
      }
      return cat;
    }

    let lignes, dateDoc, fournisseur;
    if (source === 'warehouse') {
      const actions = detail.warehouse_actions || [];
      lignes = actions.map(a => {
        const cat = rapprocher(a.product_id, a.product_name || a.name);
        return {
          reference: cat ? cat.ref : '',
          designation: a.product_name || a.name || '',
          quantite: parseInt(a.quantity) || 1,
          catalogue_id: cat ? cat.id : null,
          catalogue_ref: cat ? cat.ref : null,
          catalogue_designation: cat ? cat.designation : null
        };
      });
      dateDoc = detail.issue_date;
      fournisseur = detail.client_name || 'Eloflex AB';
    } else {
      const positions = detail.positions || detail.invoice_items || [];
      lignes = positions.map(p => {
        const cat = rapprocher(p.product_id, p.code || p.name);
        return {
          reference: p.code || (cat ? cat.ref : ''),
          designation: p.name || '',
          quantite: parseInt(p.quantity) || 1,
          catalogue_id: cat ? cat.id : null,
          catalogue_ref: cat ? cat.ref : null,
          catalogue_designation: cat ? cat.designation : null
        };
      });
      dateDoc = detail.issue_date || detail.sell_date;
      fournisseur = detail.seller_name || 'Eloflex AB';
    }

    res.json({
      configured: true, found: true, vf_id: detail.id, numero: detail.number,
      date: dateDoc, fournisseur, lignes
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Formate les colonnes DATE (pg les renvoie comme objets Date) en 'YYYY-MM-DD'
function _fmtDateSuede(v) {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  try { return new Date(v).toISOString().slice(0, 10); } catch (_) { return null; }
}

router.get('/commandes-suede', async (req, res) => {
  try {
    const list = await db.all(`
      SELECT cs.*,
        (SELECT COUNT(*)::int FROM commandes_suede_lignes l WHERE l.commande_id=cs.id) AS nb_lignes,
        (SELECT COALESCE(SUM(reliquat),0)::int FROM commandes_suede_lignes l WHERE l.commande_id=cs.id) AS total_reliquat
      FROM commandes_suede cs ORDER BY cs.created_at DESC`);
    list.forEach(cs => {
      cs.date_commande  = _fmtDateSuede(cs.date_commande);
      cs.date_livraison = _fmtDateSuede(cs.date_livraison);
    });
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/commandes-suede/:id', async (req, res) => {
  try {
    const cs = await db.get('SELECT * FROM commandes_suede WHERE id=$1', [req.params.id]);
    if (!cs) return res.status(404).json({ error: 'Introuvable' });
    cs.date_commande  = _fmtDateSuede(cs.date_commande);
    cs.date_livraison = _fmtDateSuede(cs.date_livraison);
    cs.lignes = await db.all(`
      SELECT l.*, c.ref AS catalogue_ref_actuelle, c.designation AS catalogue_designation_actuelle, c.stock AS catalogue_stock_actuel
      FROM commandes_suede_lignes l LEFT JOIN catalogue c ON c.id=l.catalogue_id
      WHERE l.commande_id=$1 ORDER BY l.ordre, l.id`, [req.params.id]);
    res.json(cs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/commandes-suede', adminOrOp, async (req, res) => {
  const { numero_bc, vf_id, fournisseur, date_commande, transporteur, num_suivi, date_livraison, lignes } = req.body;
  if (!numero_bc) return res.status(400).json({ error: 'Numéro de bon de commande requis' });
  const pgClient = await db.pool.connect();
  try {
    await pgClient.query('BEGIN');
    const { rows: [cs] } = await pgClient.query(
      `INSERT INTO commandes_suede (numero_bc, vf_id, fournisseur, date_commande, transporteur, num_suivi, date_livraison, statut)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [numero_bc, vf_id || null, fournisseur || 'Eloflex AB', date_commande || null, transporteur || null, num_suivi || null,
       date_livraison || null, date_livraison ? 'Livrée' : (num_suivi ? 'En transit' : 'En cours')]
    );
    let ordre = 0;
    for (const l of (lignes || [])) {
      await pgClient.query(
        `INSERT INTO commandes_suede_lignes (commande_id, catalogue_id, reference, designation, quantite_commandee, ordre)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [cs.id, l.catalogue_id || null, l.reference || null, l.designation || null, parseInt(l.quantite) || 1, ordre++]
      );
    }
    await pgClient.query('COMMIT');
    res.status(201).json({ ok: true, id: cs.id });
  } catch (e) {
    await pgClient.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { pgClient.release(); }
});

router.put('/commandes-suede/:id', adminOrOp, async (req, res) => {
  try {
    const { numero_bc, fournisseur, date_commande, transporteur, num_suivi, date_livraison } = req.body;
    const existant = await db.get('SELECT stock_integre, statut FROM commandes_suede WHERE id=$1', [req.params.id]);
    if (!existant) return res.status(404).json({ error: 'Introuvable' });
    let statut = existant.statut;
    if (!existant.stock_integre) {
      statut = date_livraison ? 'Livrée' : (num_suivi ? 'En transit' : 'En cours');
    }
    const cs = await db.run(
      `UPDATE commandes_suede SET numero_bc=$1, fournisseur=$2, date_commande=$3, transporteur=$4, num_suivi=$5, date_livraison=$6, statut=$7, updated_at=NOW()
       WHERE id=$8 RETURNING *`,
      [numero_bc, fournisseur || null, date_commande || null, transporteur || null, num_suivi || null, date_livraison || null, statut, req.params.id]
    );
    res.json(cs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/commandes-suede/:id/lignes', adminOrOp, async (req, res) => {
  const lignes = Array.isArray(req.body) ? req.body : (req.body.lignes || []);
  const pgClient = await db.pool.connect();
  try {
    await pgClient.query('BEGIN');
    for (const l of lignes) {
      if (!l.id) continue;
      await pgClient.query(
        'UPDATE commandes_suede_lignes SET catalogue_id=$1, reference=$2, designation=$3, quantite_commandee=$4 WHERE id=$5 AND commande_id=$6',
        [l.catalogue_id || null, l.reference || null, l.designation || null, parseInt(l.quantite_commandee) || 1, l.id, req.params.id]
      );
    }
    await pgClient.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await pgClient.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { pgClient.release(); }
});

router.post('/commandes-suede/:id/integrer-stock', adminOrOp, async (req, res) => {
  const receptions = Array.isArray(req.body.lignes) ? req.body.lignes : [];
  const pgClient = await db.pool.connect();
  try {
    await pgClient.query('BEGIN');
    const { rows: [cs] } = await pgClient.query('SELECT * FROM commandes_suede WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!cs) { await pgClient.query('ROLLBACK'); return res.status(404).json({ error: 'Introuvable' }); }
    if (cs.stock_integre) { await pgClient.query('ROLLBACK'); return res.status(409).json({ error: 'Cette commande a déjà été intégrée au stock.' }); }
    if (!cs.date_livraison) { await pgClient.query('ROLLBACK'); return res.status(400).json({ error: "Renseigne d'abord la date de livraison." }); }

    const { rows: lignesDb } = await pgClient.query('SELECT * FROM commandes_suede_lignes WHERE commande_id=$1', [req.params.id]);
    let piecesMaj = 0, totalReliquat = 0;
    for (const ligne of lignesDb) {
      const saisie = receptions.find(r => r.id === ligne.id);
      const qteRecue = saisie ? Math.max(0, parseInt(saisie.quantite_recue) || 0) : ligne.quantite_commandee;
      const reliquat = Math.max(0, ligne.quantite_commandee - qteRecue);
      // Corrections éventuelles de la ligne au moment de la réception
      // (référence, désignation, rattachement catalogue). Absentes → valeurs d'origine.
      const ref = saisie && saisie.reference !== undefined ? (saisie.reference || null) : ligne.reference;
      const designation = saisie && saisie.designation ? saisie.designation : ligne.designation;
      const catalogueId = saisie && saisie.catalogue_id !== undefined ? (saisie.catalogue_id || null) : ligne.catalogue_id;
      await pgClient.query(
        'UPDATE commandes_suede_lignes SET reference=$1, designation=$2, catalogue_id=$3, quantite_recue=$4, reliquat=$5 WHERE id=$6',
        [ref, designation, catalogueId, qteRecue, reliquat, ligne.id]
      );
      if (catalogueId && qteRecue > 0) {
        await pgClient.query('UPDATE catalogue SET stock = stock + $1 WHERE id=$2', [qteRecue, catalogueId]);
        piecesMaj++;
      }
      totalReliquat += reliquat;
    }
    await pgClient.query(
      `UPDATE commandes_suede SET stock_integre=TRUE, statut=$1, integre_le=NOW(), updated_at=NOW() WHERE id=$2`,
      [totalReliquat > 0 ? 'Intégrée (reliquat)' : 'Intégrée', req.params.id]
    );
    await pgClient.query('COMMIT');
    res.json({ ok: true, pieces_maj: piecesMaj, total_reliquat: totalReliquat });
  } catch (e) {
    await pgClient.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { pgClient.release(); }
});

router.delete('/commandes-suede/:id', adminOnly, async (req, res) => {
  try {
    const cs = await db.get('SELECT stock_integre FROM commandes_suede WHERE id=$1', [req.params.id]);
    if (cs && cs.stock_integre) return res.status(409).json({ error: 'Impossible de supprimer : le stock a déjà été intégré pour cette commande.' });
    await db.run('DELETE FROM commandes_suede WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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

// ── DOUBLONS VOSFACTURES ────────────────────────────────────────────

function _normaliserNomVF(nom) {
  return (nom || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}
function _adresseCompleteVF(cl) { return !!(cl.street && cl.post_code && cl.city); }
function _scoreCompletudeVF(cl) {
  let s = 0;
  if (cl.street) s++; if (cl.post_code) s++; if (cl.city) s++;
  if (cl.email) s++; if (cl.phone) s++; if (cl.tax_no) s++;
  return s;
}
async function _fetchTousContactsVF() {
  const axios = require('axios');
  const vfApi = axios.create({
    baseURL: `https://${process.env.VOSFACTURES_ACCOUNT}.vosfactures.fr`,
    headers: { 'Accept': 'application/json' },
    params: { api_token: process.env.VOSFACTURES_API_TOKEN }
  });
  let page = 1, tous = [];
  while (true) {
    const { data } = await vfApi.get('/clients.json', { params: { per_page: 100, page } });
    if (!Array.isArray(data) || data.length === 0) break;
    tous = tous.concat(data);
    if (data.length < 100) break;
    page++;
  }
  return tous;
}

// Détecte les groupes de contacts en doublon (même nom) + adresses incomplètes
router.get('/doublons-vf/detecter', requireAuth, async (req, res) => {
  if (!process.env.VOSFACTURES_API_TOKEN || !process.env.VOSFACTURES_ACCOUNT) {
    return res.status(503).json({ error: 'VosFactures non configuré' });
  }
  try {
    const contacts = await _fetchTousContactsVF();

    const groupes = {};
    for (const c of contacts) {
      const cle = _normaliserNomVF(c.name);
      if (!cle) continue;
      (groupes[cle] = groupes[cle] || []).push(c);
    }

    const doublons = Object.values(groupes)
      .filter(g => g.length > 1)
      .map(g => {
        const trie = [...g].sort((a, b) => _scoreCompletudeVF(b) - _scoreCompletudeVF(a));
        return {
          nom: trie[0].name,
          principal_suggere: trie[0].id,
          contacts: trie.map(c => ({
            id: c.id, name: c.name, street: c.street, post_code: c.post_code,
            city: c.city, email: c.email, phone: c.phone, tax_no: c.tax_no,
            complet: _adresseCompleteVF(c)
          }))
        };
      })
      .sort((a, b) => b.contacts.length - a.contacts.length);

    const adressesIncompletes = contacts
      .filter(c => !_adresseCompleteVF(c))
      .map(c => ({
        id: c.id, name: c.name,
        street: c.street || '', post_code: c.post_code || '', city: c.city || '',
        email: c.email || '', phone: c.phone || ''
      }));

    res.json({
      total_contacts: contacts.length,
      nb_groupes_doublons: doublons.length,
      doublons,
      nb_adresses_incompletes: adressesIncompletes.length,
      adresses_incompletes: adressesIncompletes
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Fusionne un groupe de doublons dans VosFactures + réattribue les commandes locales
router.post('/doublons-vf/fusionner', adminOnly, async (req, res) => {
  const { principal_id, merge_ids } = req.body;
  if (!principal_id || !Array.isArray(merge_ids) || merge_ids.length === 0) {
    return res.status(400).json({ error: 'principal_id et merge_ids (tableau) requis' });
  }
  try {
    const axios = require('axios');
    const { data: vfData } = await axios.post(
      `https://${process.env.VOSFACTURES_ACCOUNT}.vosfactures.fr/clients/${principal_id}/merge.json`,
      { api_token: process.env.VOSFACTURES_API_TOKEN, merge_ids }
    );

    // Réattribution locale : les fiches "clients" locales sont liées à VosFactures
    // via la colonne vf_id ; les commandes pointent vers clients.id (pas vf_id).
    let reattribution = { commandes_reattribuees: 0 };
    try {
      const principalLocal = await db.get('SELECT id FROM clients WHERE vf_id=$1', [principal_id]);
      const dupLocaux = await db.all('SELECT id FROM clients WHERE vf_id = ANY($1::int[])', [merge_ids]);
      if (principalLocal && dupLocaux.length) {
        const idsLocaux = dupLocaux.map(r => r.id);
        const r = await db.run(
          'UPDATE commandes SET client_id=$1 WHERE client_id = ANY($2::int[])',
          [principalLocal.id, idsLocaux]
        );
        reattribution.commandes_reattribuees = r?.rowCount || 0;
      }
      reattribution.note = 'Pense à relancer une Sync VosFactures pour nettoyer les fiches locales en double.';
    } catch (dbErr) {
      console.warn('Réattribution locale doublons VF ignorée :', dbErr.message);
      reattribution.erreur = dbErr.message;
    }

    res.json({ ok: true, principal_id, fusionnes: merge_ids, vosfactures: vfData, reattribution });
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// Complète/corrige l'adresse d'un contact VosFactures
router.put('/doublons-vf/adresse/:id', adminOnly, async (req, res) => {
  const { street, post_code, city, country } = req.body;
  try {
    const axios = require('axios');
    const { data } = await axios.put(
      `https://${process.env.VOSFACTURES_ACCOUNT}.vosfactures.fr/clients/${req.params.id}.json`,
      { api_token: process.env.VOSFACTURES_API_TOKEN, client: { street, post_code, city, country: country || 'FR' } }
    );
    res.json({ ok: true, client: data });
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// ── COMPLÉTER LES ADRESSES DES DISTRIBUTEURS ──────────────────────
// Enregistre en masse les adresses complétées (tableau [{id, adresse, cp, ville}])
// Réutilise la logique de mise à jour + resync carte de chaque client.
router.post('/clients/adresses-completer', adminOnly, async (req, res) => {
  const lignes = Array.isArray(req.body.lignes) ? req.body.lignes : [];
  let maj = 0;
  const echecs = [];
  for (const l of lignes) {
    if (!l || !l.id) continue;
    try {
      // On ne touche qu'aux champs d'adresse fournis ; les autres restent inchangés
      const cl = await db.get('SELECT * FROM clients WHERE id=$1', [l.id]);
      if (!cl) { echecs.push({ id: l.id, raison: 'introuvable' }); continue; }
      const nouvAdresse = (l.adresse !== undefined && l.adresse !== null && String(l.adresse).trim() !== '') ? String(l.adresse).trim() : cl.adresse;
      const nouvCp      = (l.cp      !== undefined && String(l.cp).trim()      !== '') ? String(l.cp).trim()      : cl.cp;
      const nouvVille   = (l.ville   !== undefined && String(l.ville).trim()   !== '') ? String(l.ville).trim()   : cl.ville;
      // Si l'adresse change, on invalide les coordonnées (comme le PUT normal)
      const adresseChange = (nouvAdresse !== cl.adresse) || (nouvCp !== cl.cp) || (nouvVille !== cl.ville);
      await db.run(
        'UPDATE clients SET adresse=$1, cp=$2, ville=$3, updated_at=NOW() WHERE id=$4',
        [nouvAdresse || null, nouvCp || null, nouvVille || null, l.id]
      );
      if (adresseChange) {
        await db.run('UPDATE clients SET lat=NULL, lng=NULL WHERE id=$1', [l.id]);
        // Resync du point carte si ce client y figure (regéocodage avec la nouvelle adresse)
        if (cl.sur_carte) { try { await syncClientCarte(l.id); } catch (_) {} }
      }
      maj++;
    } catch (e) { echecs.push({ id: l.id, raison: e.message }); }
  }
  res.json({ ok: true, maj, echecs });
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

    // Rattacher toutes les commandes du client source vers le client cible
    const { rowCount: commandes } = await pgClient.query(
      'UPDATE commandes SET client_id=$1, updated_at=NOW() WHERE client_id=$2',
      [clientCibleId, clientSourceId]
    );

    // Rattacher le(s) point(s) de la carte distributeurs, s'il y en a
    const { rowCount: pointsCarte } = await pgClient.query(
      'UPDATE distributeurs_carte SET client_id=$1, updated_at=NOW() WHERE client_id=$2',
      [clientCibleId, clientSourceId]
    );

    // Si d'autres fiches pointaient le doublon comme "entité de facturation", les rebrancher sur la cible
    await pgClient.query(
      'UPDATE clients SET entite_facturation_id=$1 WHERE entite_facturation_id=$2',
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
    res.json({ ok: true, fauteuils_transferes: fauteuils, interventions_transferees: interventions,
      commandes_transferees: commandes, points_carte_transferes: pointsCarte });
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
      subject: `[Eloflex] ${i.num_sav||'Intervention #'+i.id} — ${i.statut}`,
      html: `<div style="font-family:sans-serif;max-width:520px">
        <h2 style="color:#1a3a5c">Eloflex — Mise à jour</h2>
        <p>Bonjour,</p>
        <p>Votre dossier SAV <strong>${i.num_sav||'#'+i.id}</strong> concernant le fauteuil 
        <strong>${i.modele} (${i.serie})</strong> a été mis à jour.</p>
        <table style="border-collapse:collapse;width:100%;font-size:13px">
          <tr><td style="padding:6px 10px;background:#f5f5f4;font-weight:600">Statut</td><td style="padding:6px 10px">${i.statut}</td></tr>
          <tr><td style="padding:6px 10px;background:#f5f5f4;font-weight:600">Type</td><td style="padding:6px 10px">${i.type}</td></tr>
          <tr><td style="padding:6px 10px;background:#f5f5f4;font-weight:600">Description</td><td style="padding:6px 10px">${i.description||'—'}</td></tr>
        </table>
        <p style="margin-top:16px;font-size:12px;color:#666">Eloflex France — Service Après-Vente</p>
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
  // Un avoir (annulation) est un choix manuel explicite : il prime sur tout, y compris le paiement.
  if (cmd.statut === 'Avoir') return 'Avoir';
  // Paiement VF prime sur tout (même sur statut manuel Facturé)
  const fp = cmd.facture_paiement_statut;
  if (fp === 'paye' || fp === 'payé' || fp === 'paid') return 'Payé';
  if (fp === 'impaye' || fp === 'impayé') return 'Impayé';
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
    const slim = req.query.slim === '1';
    const fields = slim
      ? `cmd.id, cmd.client_id, cmd.origine, cmd.intervention_id, cmd.bdc, cmd.distributeur_nom, cmd.modele, cmd.quantite, cmd.date_commande,
         cmd.statut, cmd.num_suivi, cmd.transporteur, cmd.date_livraison, cmd.num_serie,
         cmd.num_facture, cmd.num_commande_distrib, cmd.pays, cmd.client_final, cmd.client_final_type,
         cmd.facture_paiement_statut, cmd.facture_date_echeance, cmd.num_retour,
         cmd.reliquat, cmd.demo_origine_nom, cmd.modele_demo, cmd.annee_onglet, cmd.groupe,
         cmd.commande_type, cmd.type_fauteuil_neuf, cmd.type_fauteuil_demo, cmd.type_pieces,
         (cmd.informations ILIKE '%avoir%') AS est_avoir,
         c.nom AS client_nom, c.ville AS client_ville, c.edi AS client_edi,
         ROW_NUMBER() OVER (
           PARTITION BY EXTRACT(YEAR FROM cmd.date_commande::date)
           ORDER BY cmd.date_commande ASC NULLS LAST, cmd.id ASC
         ) AS num_annuel`
      : `cmd.*, c.nom AS client_nom, c.ville AS client_ville,
         c.edi AS client_edi, cmd.facture_paiement_statut, cmd.facture_date_echeance,
         ROW_NUMBER() OVER (
           PARTITION BY EXTRACT(YEAR FROM cmd.date_commande::date)
           ORDER BY cmd.date_commande ASC NULLS LAST, cmd.id ASC
         ) AS num_annuel`;
    let sql = `SELECT ${fields} FROM commandes cmd LEFT JOIN clients c ON c.id = cmd.client_id`;
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
    if (statut && statut !== 'Tous') {
      // Filtre sur statut calculé (miroir de statut_calc JS)
      const statutExpr = `CASE
        WHEN cmd.facture_paiement_statut IN ('paye','payé','paid') THEN 'Payé'
        WHEN cmd.facture_paiement_statut IN ('impaye','impayé') THEN 'Impayé'
        WHEN cmd.statut IS NOT NULL AND cmd.statut != 'Auto' THEN cmd.statut
        WHEN cmd.num_facture IS NOT NULL AND cmd.num_facture != '' THEN 'Facturé'
        WHEN cmd.date_livraison IS NOT NULL THEN 'Livré'
        WHEN cmd.num_suivi IS NOT NULL AND LENGTH(TRIM(cmd.num_suivi)) >= 8 THEN 'Expédié'
        ELSE 'En préparation'
      END`;
      conds.push(`(${statutExpr}) = $${++idx}`);
      p.push(statut);
    }
    if (q) {
      const qq = `%${q}%`;
      conds.push(`(cmd.distributeur_nom ILIKE $${++idx} OR cmd.bdc ILIKE $${idx} OR cmd.num_serie ILIKE $${idx} OR cmd.num_suivi ILIKE $${idx} OR cmd.client_final ILIKE $${idx} OR cmd.num_facture ILIKE $${idx} OR cmd.modele ILIKE $${idx} OR cmd.accessoire ILIKE $${idx})`);
      p.push(qq);
    }
    const mois = req.query.mois ? parseInt(req.query.mois) : null;
    if (mois) { conds.push(`EXTRACT(MONTH FROM cmd.date_commande::date)=$${++idx}`); p.push(mois); }
    // Filtre type d'affichage : fauteuils vs accessoires
    const FAUTEUIL_EXPR = `(cmd.commande_type='fauteuil' OR cmd.type_fauteuil_neuf=TRUE OR cmd.type_fauteuil_demo=TRUE OR cmd.modele ILIKE '%eloflex%')`;
    if (req.query.type === 'fauteuil') {
      conds.push(FAUTEUIL_EXPR);
    } else if (req.query.type === 'accessoire') {
      conds.push(`(NOT ${FAUTEUIL_EXPR})`);
    }
    if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
    sql += ' ORDER BY cmd.date_commande DESC NULLS LAST, cmd.id DESC';
    let rows = await db.all(sql, p);
    rows = rows.map(r => ({ ...r, statut_calc: statutCommande(r) }));
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
    // Les commandes issues d'un SAV facturé (origine='sav') sont INCLUSES dans les compteurs
    // de ventes et dans la numérotation annuelle (choix de Brice, 30/07).
    const anneeFilter = annee
      ? `(annee_onglet=$1 OR (annee_onglet IS NULL AND EXTRACT(YEAR FROM date_commande::date)=$1)) ${paysFilter}`
      : `TRUE ${paysFilter}`;
    const params = annee ? [annee] : [];

    // Calcul SQL du statut (miroir de la fonction JS statutCommande + isRealTracking)
    const statutExpr = `
      CASE
        WHEN facture_paiement_statut IN ('paye','payé','paid') THEN 'Payé'
        WHEN facture_paiement_statut IN ('impaye','impayé') THEN 'Impayé'
        WHEN statut IS NOT NULL AND statut != 'Auto' THEN statut
        WHEN num_facture IS NOT NULL AND num_facture != '' THEN 'Facturé'
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
        SUM(CASE WHEN (${statutExpr}) = 'Payé'           THEN 1 ELSE 0 END) AS paye,
        SUM(CASE WHEN (${statutExpr}) = 'Impayé'         THEN 1 ELSE 0 END) AS impaye,
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
      impaye:         parseInt(counts.impaye)          || 0,
      paye:           parseInt(counts.paye)            || 0,
      demo:           parseInt(counts.demo)            || 0,
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
    if (!(process.env.PENNYLANE_API_KEY || process.env.PENNYLANE_TOKEN)) return res.json({ configured: false });
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
    if (!(process.env.PENNYLANE_API_KEY || process.env.PENNYLANE_TOKEN)) return res.json({ configured: false });
    const numero = (req.query.numero || '').trim();
    if (!numero) return res.status(400).json({ error: 'numero requis' });
    const { lookupDocumentPennylane } = require('../scripts/sync-pennylane');
    const result = await lookupDocumentPennylane(numero);
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/pennylane/generer-facture/:cmdId', adminOrOp, async (req, res) => {
  try {
    if (!(process.env.PENNYLANE_API_KEY || process.env.PENNYLANE_TOKEN)) return res.json({ ok: false, reason: 'Pennylane non configuré' });
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
      sender: { name: 'Eloflex France', email: fromAddr },
      to: [{ email }],
      cc: [{ email: params.email_cc_relance || 'info@eloflex.fr' }],
      subject: `[Eloflex] Relance devis ${devis.numero}`,
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
          <div style="font-size:18px;font-weight:bold;color:#1F3A5F;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.3px;">ELOFLEX FRANCE</div>
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
    <div style="font-size:12px;color:#A8C4E0;">© Eloflex France &nbsp;·&nbsp; <a href="https://eloflex.fr" style="color:#A8C4E0;text-decoration:none;">eloflex.fr</a> &nbsp;·&nbsp; 09 67 66 51 29</div>
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


// ── Helper Brevo pour emails SAV ─────────────────────────────────
async function sendBrevoMail({ from, fromName, to, cc, bcc, subject, html, attachments }) {
  const axios = require('axios');
  const key = process.env.BREVO_API_KEY;
  if (!key) throw new Error('BREVO_API_KEY manquante');
  await axios.post('https://api.brevo.com/v3/smtp/email', {
    sender: { name: fromName||'Eloflex France', email: from||'sav@eloflex.fr' },
    to: [{ email: to }],
    ...(cc ? { cc: [{ email: cc }] } : {}),
    ...(bcc ? { bcc: [{ email: bcc }] } : {}),
    ...(attachments && attachments.length ? { attachment: attachments } : {}),
    subject, htmlContent: html
  }, { headers: { 'api-key': key, 'Content-Type': 'application/json' }, timeout: 60000 });
}

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
      `SELECT cmd.*, c.nom AS client_nom, c.ville AS client_ville, c.email AS client_email, c.tel AS client_tel,
              c.entite_facturation_id AS client_entite_id, ef.nom AS facturation_nom
       FROM commandes cmd
       LEFT JOIN clients c ON c.id = cmd.client_id
       LEFT JOIN clients ef ON ef.id = c.entite_facturation_id
       WHERE cmd.id=$1`, [req.params.id]
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

// ── Propriété fauteuil : bascule vers le magasin d'une commande de VENTE réelle ──
// Règle (validée) : le propriétaire d'un fauteuil = le magasin de sa DERNIÈRE vente
// facturée. On ignore les dépôts-vente/démos (sans facture) et les transferts SAV.
const EST_VENTE_SQL = "(facture_vf_id IS NOT NULL OR num_facture ~ '^[A-Za-z]?[0-9]{3,}')";
const SERIE_NORM_CMD = "UPPER(REGEXP_REPLACE(num_serie,'[^A-Za-z0-9]','','g'))";
const DATE_TRI = "(CASE WHEN date_commande ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN LEFT(date_commande,10)::date ELSE NULL END)";
async function majFauteuilVente(row) {
  try {
    if (!row || !row.num_serie || !row.client_id) return;
    if (row.origine === 'sav') return;
    const nf = String(row.num_facture || '').trim();
    if (!row.facture_vf_id && !/^[A-Za-z]?[0-9]{3,}/.test(nf)) return; // pas une vente
    const sn = String(row.num_serie).toUpperCase().replace(/[^A-Za-z0-9]/g, '');
    if (sn.length < 4) return;
    // ne bascule que si cette commande est la vente la plus récente pour cette série
    const last = await db.get(
      `SELECT id FROM commandes
       WHERE ${SERIE_NORM_CMD}=$1 AND (origine IS DISTINCT FROM 'sav') AND ${EST_VENTE_SQL}
       ORDER BY ${DATE_TRI} DESC NULLS LAST, id DESC LIMIT 1`, [sn]);
    if (last && parseInt(last.id) === parseInt(row.id)) {
      await db.run(
        `UPDATE fauteuils SET client_id=$1, updated_at=NOW()
         WHERE UPPER(REGEXP_REPLACE(serie,'[^A-Za-z0-9]','','g'))=$2`, [row.client_id, sn]);
    }
  } catch (_) { /* best-effort, ne bloque jamais la commande */ }
}

// ── Démo : au 1er marquage "fauteuil démo", programme un rappel à J+30 (date de livraison) ──
async function majRappelDemo(row) {
  try {
    if (!row) return;
    const estDemo = row.modele_demo === true || row.type_fauteuil_demo === true;
    if (!estDemo) return;
    if (row.demo_rappel_date || row.demo_suivi_resultat) return; // déjà suivi ou clôturé
    const iso = s => (/^[0-9]{4}-[0-9]{2}-[0-9]{2}/.test(String(s || '')) ? String(s).slice(0, 10) : null);
    const base = iso(row.date_livraison) || iso(row.date_commande) || new Date().toISOString().slice(0, 10);
    const d = new Date(base + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 30);
    const rappel = d.toISOString().slice(0, 10);
    await db.run('UPDATE commandes SET demo_rappel_date=$1 WHERE id=$2 AND demo_rappel_date IS NULL AND demo_suivi_resultat IS NULL', [rappel, row.id]);
  } catch (_) { /* best-effort */ }
}

// ── Origine démo : sur une revente (vente d'un fauteuil qui a été en démo ailleurs),
//    renseigne automatiquement le magasin d'où venait la démo, via le n° de série.
//    Ne remplit que si le champ est vide (respecte une saisie manuelle).
async function majOrigineDemo(row) {
  try {
    if (!row || !row.num_serie || !row.client_id) return;
    if (row.origine === 'sav') return;
    if (row.demo_origine_nom) return;                 // déjà renseigné → on n'écrase pas
    // La commande courante doit être une vente (la revente du fauteuil de démo)
    const nf = String(row.num_facture || '').trim();
    if (!row.facture_vf_id && !/^[A-Za-z]?[0-9]{3,}/.test(nf)) return;
    const sn = String(row.num_serie).toUpperCase().replace(/[^A-Za-z0-9]/g, '');
    if (sn.length < 4) return;
    // Cherche une commande DÉMO, même série, dans un AUTRE magasin
    const demo = await db.get(
      `SELECT distributeur_nom FROM commandes
       WHERE ${SERIE_NORM_CMD}=$1 AND modele_demo=true
         AND client_id IS DISTINCT FROM $2
         AND (origine IS DISTINCT FROM 'sav')
       ORDER BY ${DATE_TRI} DESC NULLS LAST, id DESC LIMIT 1`, [sn, row.client_id]);
    if (demo && demo.distributeur_nom) {
      await db.run(
        `UPDATE commandes SET demo_origine_nom=$1
         WHERE id=$2 AND (demo_origine_nom IS NULL OR demo_origine_nom='')`,
        [demo.distributeur_nom, row.id]);
    }
  } catch (_) { /* best-effort, ne bloque jamais la commande */ }
}

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
        bdc, date_commande, vf_order_id, client_final, client_final_type, cf_nom, cf_prenom, cf_adresse, cf_cp, cf_ville, cf_tel, cf_email, num_suivi, transporteur, date_livraison, num_serie, num_facture,
        invoice_se, informations, statut, num_bordereau, reliquat, reliquat_description, modele_demo,
        num_retour, transporteur_retour, date_retour, num_commande_distrib,
        commande_type, ref_suede, date_envoi_suede, confirmation_recue, date_confirmation,
        facture_vf_id, bdc_source, bdc_doc_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44) RETURNING *`,
      [clientId, d.fauteuil_id || null, d.annee_onglet || new Date().getFullYear(), d.groupe || null,
       d.distributeur_nom, d.modele || null, parseInt(d.quantite) || 1, d.accessoire || null, d.bdc || null, d.date_commande || null,
       d.vf_order_id || null, d.client_final || null, d.client_final_type || null, d.cf_nom||null, d.cf_prenom||null, d.cf_adresse||null, d.cf_cp||null, d.cf_ville||null, d.cf_tel||null, d.cf_email||null, d.num_suivi || null, d.transporteur || null, d.date_livraison || null,
       d.num_serie || null, d.num_facture || null, d.invoice_se || null, d.informations || null, d.statut || 'Auto',
       d.num_bordereau || null, d.reliquat ? true : false, d.reliquat_description || null, d.modele_demo ? true : false,
       d.num_retour || null, d.transporteur_retour || null, d.date_retour || null, d.num_commande_distrib || null,
       d.commande_type || null, d.ref_suede || null, d.date_envoi_suede || null,
       d.confirmation_recue ? true : false, d.date_confirmation || null,
       d.facture_vf_id || null, d.bdc_source || null, d.bdc_doc_id || null]
    );
    await majFauteuilVente(row);
    await majRappelDemo(row);
    await majOrigineDemo(row);
    res.status(201).json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/commandes/:id', async (req, res) => {
  try {
    const d = req.body;
    const champs = ['client_id', 'fauteuil_id', 'annee_onglet', 'groupe', 'distributeur_nom', 'modele', 'quantite', 'accessoire',
      'bdc', 'date_commande', 'vf_order_id', 'client_final', 'num_suivi', 'transporteur', 'date_livraison', 'num_serie',
      'client_final_type', 'cf_nom', 'cf_prenom', 'cf_adresse', 'cf_cp', 'cf_ville', 'cf_tel', 'cf_email',
      'demo_origine_nom', 'demo_localisation_actuelle',
      'num_facture', 'invoice_se', 'informations', 'statut', 'num_bordereau', 'reliquat', 'reliquat_description', 'modele_demo',
      'num_retour', 'transporteur_retour', 'date_retour', 'num_commande_distrib',
      'commande_type', 'type_fauteuil_neuf', 'type_fauteuil_demo', 'type_pieces', 'confirmation_mode',
      'ref_suede', 'date_envoi_suede', 'confirmation_recue', 'date_confirmation',
      'num_avoir', 'vf_avoir_id', 'num_facture_pennylane', 'facture_vf_id', 'bdc_source', 'bdc_doc_id', 'pays'];
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
    await majFauteuilVente(row);
    await majRappelDemo(row);
    await majOrigineDemo(row);
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Backfill "Origine démo" : remplit demo_origine_nom sur les reventes déjà en base ──
// Pour chaque vente (série connue) dont le fauteuil a été en démo dans un autre magasin,
// renseigne le magasin d'origine. N'écrase jamais une valeur existante. ?dry=1 = aperçu.
router.post('/admin/backfill-origine-demo', adminOnly, async (req, res) => {
  try {
    const dry = req.query.dry === '1';
    // Ventes candidates : série présente, pas SAV, pas encore d'origine démo
    const ventes = await db.all(
      `SELECT id, client_id, distributeur_nom, ${SERIE_NORM_CMD} AS sn
       FROM commandes
       WHERE num_serie IS NOT NULL AND ${SERIE_NORM_CMD} <> ''
         AND (origine IS DISTINCT FROM 'sav') AND ${EST_VENTE_SQL}
         AND (demo_origine_nom IS NULL OR demo_origine_nom='')`);
    const maj = [];
    for (const v of ventes) {
      if (!v.sn || v.sn.length < 4) continue;
      const demo = await db.get(
        `SELECT distributeur_nom FROM commandes
         WHERE ${SERIE_NORM_CMD}=$1 AND modele_demo=true
           AND client_id IS DISTINCT FROM $2 AND (origine IS DISTINCT FROM 'sav')
         ORDER BY ${DATE_TRI} DESC NULLS LAST, id DESC LIMIT 1`, [v.sn, v.client_id]);
      if (demo && demo.distributeur_nom && demo.distributeur_nom !== v.distributeur_nom) {
        maj.push({ cmd_id: v.id, magasin: v.distributeur_nom, origine: demo.distributeur_nom });
        if (!dry) await db.run('UPDATE commandes SET demo_origine_nom=$1 WHERE id=$2 AND (demo_origine_nom IS NULL OR demo_origine_nom=\'\')', [demo.distributeur_nom, v.id]);
      }
    }
    res.json({ ok: true, dry, total_candidats: ventes.length, renseignes: maj.length, details: maj.slice(0, 200) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Recalcul en masse : propriétaire de chaque fauteuil = magasin de sa dernière vente facturée ──
// Corrige d'un coup les fauteuils désynchronisés (réaffectations, reventes de démo).
// ?dry=1 pour un aperçu sans écrire.
router.post('/admin/fauteuils-resync', adminOnly, async (req, res) => {
  try {
    const dry = req.query.dry === '1';
    const rows = await db.all(
      `SELECT DISTINCT ON (sn) sn, client_id, id AS cmd_id, num_facture, date_commande
       FROM (
         SELECT ${SERIE_NORM_CMD} AS sn, client_id, id, num_facture, date_commande
         FROM commandes
         WHERE num_serie IS NOT NULL AND num_serie <> '' AND client_id IS NOT NULL
           AND (origine IS DISTINCT FROM 'sav') AND ${EST_VENTE_SQL}
       ) s
       ORDER BY sn, ${DATE_TRI} DESC NULLS LAST, id DESC`);
    const cible = {};
    for (const r of rows) cible[r.sn] = { client_id: r.client_id, cmd_id: r.cmd_id, facture: r.num_facture };
    const fauteuils = await db.all(
      `SELECT id, serie, client_id, UPPER(REGEXP_REPLACE(serie,'[^A-Za-z0-9]','','g')) AS sn
       FROM fauteuils WHERE serie IS NOT NULL AND serie <> ''`);
    const changes = []; let nomatch = 0;
    for (const f of fauteuils) {
      const t = cible[f.sn];
      if (!t) { nomatch++; continue; }
      if (parseInt(t.client_id) !== parseInt(f.client_id)) {
        changes.push({ fauteuil_id: f.id, serie: f.serie, from: f.client_id, to: t.client_id, via_cmd: t.cmd_id, facture: t.facture });
      }
    }
    if (!dry) {
      for (const c of changes) {
        await db.run('UPDATE fauteuils SET client_id=$1, updated_at=NOW() WHERE id=$2', [c.to, c.fauteuil_id]);
      }
    }
    res.json({ ok: true, dry, total_fauteuils: fauteuils.length, series_avec_vente: Object.keys(cible).length,
      a_corriger: changes.length, sans_vente_correspondante: nomatch, changements: changes.slice(0, 1000) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Suivi des fauteuils de démonstration (rappels J+30) ──────────────
// ── Parc démo : liste complète des fauteuils déclarés en démo (modele_demo),
// avec leurs infos de suivi. Non plafonné, toutes années confondues. ─────────
router.get('/demos/parc', async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT cmd.id, cmd.modele, cmd.num_serie, cmd.bdc, cmd.statut,
              cmd.distributeur_nom, cmd.client_id,
              c.nom AS client_nom, c.ville AS client_ville,
              cmd.date_commande, cmd.date_livraison,
              cmd.demo_origine_nom, cmd.demo_localisation_actuelle,
              cmd.demo_rappel_date, cmd.demo_suivi_resultat,
              cmd.num_facture, cmd.facture_paiement_statut,
              cmd.num_avoir,
              (((cmd.num_avoir IS NOT NULL AND cmd.num_avoir <> '')) OR (cmd.informations ILIKE '%avoir%')) AS a_avoir,
              (cmd.demo_rappel_date IS NOT NULL AND cmd.demo_rappel_date <= to_char(NOW(),'YYYY-MM-DD')) AS rappel_echu
       FROM commandes cmd LEFT JOIN clients c ON c.id = cmd.client_id
       WHERE cmd.modele_demo = TRUE
       ORDER BY (cmd.demo_suivi_resultat IS NOT NULL),
                cmd.demo_rappel_date ASC NULLS LAST,
                cmd.date_commande DESC NULLS LAST, cmd.id DESC`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/demos/suivi', async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT cmd.id, cmd.distributeur_nom, cmd.client_id, cmd.modele, cmd.num_serie, cmd.bdc,
              cmd.date_livraison, cmd.date_commande, cmd.demo_rappel_date,
              c.nom AS client_nom, c.ville AS client_ville,
              (cmd.demo_rappel_date <= to_char(NOW(),'YYYY-MM-DD')) AS du
       FROM commandes cmd LEFT JOIN clients c ON c.id=cmd.client_id
       WHERE cmd.demo_rappel_date IS NOT NULL AND cmd.demo_suivi_resultat IS NULL
       ORDER BY cmd.demo_rappel_date ASC, cmd.id ASC`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Prolonger le rappel d'une démo (choisir la prochaine date)
router.post('/commandes/:id/demo-prolonger', async (req, res) => {
  try {
    const date = String(req.body.date || '').slice(0, 10);
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)) return res.status(400).json({ error: 'Date invalide (AAAA-MM-JJ)' });
    const row = await db.run('UPDATE commandes SET demo_rappel_date=$1, demo_suivi_resultat=NULL, updated_at=NOW() WHERE id=$2 RETURNING id, demo_rappel_date', [date, req.params.id]);
    if (!row) return res.status(404).json({ error: 'Commande introuvable' });
    res.json({ ok: true, ...row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Clôturer le suivi démo : 'retour' (organisé) ou 'facture' (vendu/facturé)
router.post('/commandes/:id/demo-cloturer', async (req, res) => {
  try {
    const r = String(req.body.resultat || '').toLowerCase();
    if (!['retour', 'facture', 'avoir'].includes(r)) return res.status(400).json({ error: "resultat doit être 'retour', 'facture' ou 'avoir'" });
    // Clôture par avoir : on aligne aussi le statut de commande sur « Avoir » (les deux vues restent cohérentes).
    const row = r === 'avoir'
      ? await db.run("UPDATE commandes SET demo_rappel_date=NULL, demo_suivi_resultat='avoir', statut='Avoir', updated_at=NOW() WHERE id=$1 RETURNING id, demo_suivi_resultat", [req.params.id])
      : await db.run('UPDATE commandes SET demo_rappel_date=NULL, demo_suivi_resultat=$1, updated_at=NOW() WHERE id=$2 RETURNING id, demo_suivi_resultat', [r, req.params.id]);
    if (!row) return res.status(404).json({ error: 'Commande introuvable' });
    res.json({ ok: true, ...row });
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

// ── Suggestions de factures Pennylane à rattacher (complément de VosFactures) ──
router.get('/commandes/:id/factures-pennylane-suggestions', async (req, res) => {
  try {
    const cmd = await db.get(`SELECT * FROM commandes WHERE id=$1`, [req.params.id]);
    if (!cmd) return res.status(404).json({ error: 'Commande introuvable' });
    const numFact = req.query.num_facture || cmd.num_facture_pennylane || '';
    const { suggestFacturesPennylane } = require('../scripts/sync-pennylane');
    const r = await suggestFacturesPennylane(cmd.distributeur_nom || '', numFact);
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Helper partagé : recherche robuste d'un document VosFactures par numéro ──────
// Contourne les DEUX pièges confirmés de l'index /invoices.json :
//  1) filtre par PÉRIODE par défaut → un doc ancien (2021) n'est jamais renvoyé sans period=all ;
//  2) filtre `number` EXACT sur le slash (insensible à la casse) → anciens docs "D/0151"
//     vs récents "D0931" : on interroge donc plusieurs variantes de format.
// Retourne le document résumé (pas le détail) le mieux correspondant, ou null.
// prefKind (optionnel) privilégie un type parmi les correspondances (ex. 'vat' pour une facture).
async function vfLookupParNumero(vfApi, numero, prefKind) {
  const normalise = s => String(s||'').toLowerCase().replace(/[\s\-\/\.]+/g,'');
  const numNorm = normalise(numero);
  const brut = String(numero||'').trim();
  if (!brut) return null;
  const variantes = new Set([brut, brut.replace(/[\s\/]+/g,'')]);
  const mPref = brut.match(/^([A-Za-z]+)[\s\/]*(\d.*)$/);
  if (mPref) variantes.add(mPref[1] + '/' + mPref[2].replace(/[\s\/]+/g,''));
  const candidats = [];
  for (const v of variantes) {
    try { const { data } = await vfApi.get('/invoices.json', { params: { number: v, period: 'all', per_page: 20 } }); if (Array.isArray(data)) candidats.push(...data); } catch(_) {}
  }
  if (!candidats.some(d => normalise(d.number) === numNorm)) {
    try { const { data } = await vfApi.get('/invoices.json', { params: { search_text: brut, period: 'all', per_page: 50 } }); if (Array.isArray(data)) candidats.push(...data); } catch(_) {}
  }
  const exacts = candidats.filter(d => normalise(d.number) === numNorm);
  const pool = exacts.length
    ? exacts
    : (numNorm.length >= 4 ? candidats.filter(d => normalise(d.number).includes(numNorm)) : []);
  if (!pool.length) return null;
  if (prefKind) { const pk = pool.find(d => d.kind === prefKind); if (pk) return pk; }
  return pool[0];
}

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

    // Recherche robuste (period=all + variantes de slash), en privilégiant une facture (vat).
    const inv = await vfLookupParNumero(vfApi, numero, 'vat');
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
    const debug = req.query.debug === '1';
    let inv = null;
    const candidats = [];
    const pousser = (data) => { if (Array.isArray(data)) for (const d of data) candidats.push(d); };

    // IMPORTANT : deux pièges VosFactures confirmés empiriquement :
    //  1) l'index /invoices.json filtre par PÉRIODE par défaut (documents récents) → un
    //     document ancien (ex. 2021) n'est jamais renvoyé sans period=all.
    //  2) le filtre `number` est EXACT sur le slash (mais insensible à la casse) : les
    //     anciens BDC sont stockés "D/0151" alors que les récents sont "D0931". On teste
    //     donc les variantes de format (tel quel / sans slash / slash après le préfixe).
    const variantes = new Set();
    const brut = numero.trim();
    variantes.add(brut);
    variantes.add(brut.replace(/[\s\/]+/g, ''));               // sans slash : D0151
    const mPref = brut.match(/^([A-Za-z]+)[\s\/]*(\d.*)$/);     // slash après préfixe : D/0151
    if (mPref) variantes.add(mPref[1] + '/' + mPref[2].replace(/[\s\/]+/g, ''));
    for (const v of variantes) {
      try { const { data } = await vfApi.get('/invoices.json', { params: { number: v, period: 'all', per_page: 20 } }); pousser(data); } catch(_) {}
    }
    // Filet de sécurité : recherche texte large seulement si aucune variante n'a matché
    // exactement (la correspondance stricte plus bas évite les faux positifs).
    if (!candidats.some(d => normalise(d.number) === numNorm)) {
      try { const { data } = await vfApi.get('/invoices.json', { params: { search_text: brut, period: 'all', per_page: 50 } }); pousser(data); } catch(_) {}
    }

    // Correspondance STRICTE sur le numéro normalisé (évite les faux positifs type "0151").
    inv = candidats.find(d => normalise(d.number) === numNorm)
       || (numNorm.length >= 4 ? candidats.find(d => normalise(d.number).includes(numNorm)) : null)
       || null;

    if (debug) {
      let docParId = null;
      if (req.query.vfid) {
        try { const { data } = await vfApi.get(`/invoices/${req.query.vfid}.json`); docParId = { number: data.number, kind: data.kind, id: data.id, issue_date: data.issue_date }; }
        catch (e) { docParId = { erreur: e.response?.status || e.message }; }
      }
      return res.json({ configured: true, found: !!inv, numNorm, doc_par_id: docParId, nb_candidats: candidats.length, candidats: candidats.slice(0, 60).map(d => ({ number: d.number, kind: d.kind, id: d.id, date: d.issue_date })) });
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
    const prixLigne = (p) => parseFloat(p.total_price_net != null ? p.total_price_net : ((parseFloat(p.price_net || p.price || 0)) * (parseInt(p.quantity) || 1))) || 0;
    if (ligneFauteuil) {
      lignes.push({
        designation: ligneFauteuil.name?.trim() || '',
        reference: ligneFauteuil.product_code || ligneFauteuil.code || null,
        quantite: parseInt(ligneFauteuil.quantity) || 1,
        prix: prixLigne(ligneFauteuil),
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
        prix: prixLigne(p),
      });
    }
    const total_ht = parseFloat(detail.price_net != null ? detail.price_net : lignes.reduce((s, l) => s + (l.prix || 0), 0)) || 0;

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
      modele, quantite, lignes, total_ht,
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

    await sendBrevoMail({
      from: params.email_from || 'sav@eloflex.fr', to: cmd.client_email,
      cc: params.email_cc_sav || 'sav@eloflex.fr',
      subject: `[Eloflex] Confirmation de commande ${cmd.bdc || '#' + cmd.id}`,
      html: `<div style="font-family:sans-serif;max-width:580px;color:#222;margin:0 auto">
        <div style="background:#1a3a5c;padding:20px 24px;border-radius:8px 8px 0 0">
          <h2 style="color:#fff;margin:0;font-size:18px;font-weight:600">Eloflex France — Confirmation de commande</h2>
        </div>
        <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;padding:24px">
          <p style="margin:0 0 12px">Bonjour,</p>
          <p style="margin:0 0 16px">Nous avons bien reçu votre commande du <strong>${cmd.date_commande ? new Date(cmd.date_commande).toLocaleDateString('fr-FR') : '—'}</strong>.</p>
          <table style="border-collapse:collapse;width:100%;font-size:13px;margin:0 0 20px;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden">
            <tr style="background:#f8f9fa"><td style="padding:9px 14px;font-weight:600;color:#555;width:170px;border-bottom:1px solid #e5e7eb">Référence Eloflex</td><td style="padding:9px 14px;border-bottom:1px solid #e5e7eb"><strong>${cmd.bdc || '—'}</strong></td></tr>
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
          <p style="margin:20px 0 0;font-size:12px;color:#aaa;border-top:1px solid #f0f0f0;padding-top:16px">Eloflex France — Service commercial<br>Cet email a été envoyé automatiquement depuis le système de gestion SAV.</p>
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
        <p style="font-size:13px;color:#888;margin-top:20px">Équipe Eloflex France — nous allons procéder à la préparation.</p>
      </div></body></html>`);
  } catch(e) { res.status(500).send(`<h2>Erreur : ${e.message}</h2>`); }
});

// ── Génération d'une facture dans VosFactures ──────────────────────
router.post('/commandes/:id/generer-facture', adminOrOp, async (req, res) => {
  try {
    if (!process.env.VOSFACTURES_API_TOKEN || !process.env.VOSFACTURES_ACCOUNT)
      return res.json({ ok: false, reason: 'VosFactures non configuré' });
    const cmd = await db.get(`
      SELECT cmd.*, c.nom AS client_nom, c.vf_id AS client_vf_id,
             cf.id AS facturation_local_id, cf.nom AS facturation_nom, cf.vf_id AS facturation_vf_id
      FROM commandes cmd
      JOIN clients c ON c.id = cmd.client_id
      LEFT JOIN clients cf ON cf.id = c.entite_facturation_id
      WHERE cmd.id=$1`, [req.params.id]);
    if (!cmd) return res.status(404).json({ error: 'Commande introuvable' });
    const lignes = await db.all('SELECT * FROM commandes_lignes WHERE commande_id=$1 ORDER BY ordre, id', [req.params.id]);
    const axios = require('axios');
    const vfApi = axios.create({ baseURL: `https://${process.env.VOSFACTURES_ACCOUNT}.vosfactures.fr`,
      headers: { 'Accept': 'application/json' }, params: { api_token: process.env.VOSFACTURES_API_TOKEN } });

    // Si une entité de facturation est définie sur la fiche du distributeur,
    // c'est elle qui doit être facturée (acheteur légal) — pas le distributeur.
    const facturerEntite = !!cmd.facturation_local_id;
    const buyerVfId = facturerEntite ? cmd.facturation_vf_id : cmd.client_vf_id;
    const buyerName = facturerEntite ? cmd.facturation_nom : cmd.client_nom;

    let buyer = null;
    if (!buyerVfId) {
      // Pas de vf_id connu localement : on retombe sur la recherche par nom (comportement d'origine)
      const { data: buyers } = await vfApi.get('/clients.json', { params: { name: buyerName, per_page: 5 } });
      buyer = Array.isArray(buyers) ? buyers.find(b => b.name?.toLowerCase().includes(buyerName.toLowerCase().slice(0, 8))) : null;
    }

    const positions = (lignes.length ? lignes : [{ designation: cmd.modele || 'Commande', quantite: cmd.quantite || 1, reference: cmd.bdc }])
      .map(l => ({ name: l.designation, quantity: String(l.quantite || 1), price_net: '0.00', tax: '20' }));
    const today = new Date().toISOString().slice(0, 10);

    const descriptionParts = [];
    if (cmd.bdc) descriptionParts.push(`Commande ${cmd.bdc}${cmd.num_commande_distrib ? ' / ' + cmd.num_commande_distrib : ''}`);
    if (facturerEntite) descriptionParts.push(`Distributeur (livraison) : ${cmd.distributeur_nom}`);

    const payload = {
      invoice: {
        kind: 'vat', sell_date: cmd.date_livraison || today, issue_date: today,
        ...(buyerVfId ? { client_id: buyerVfId } : (buyer?.id ? { client_id: buyer.id } : { buyer_name: buyerName })),
        positions,
        ...(descriptionParts.length ? { description: descriptionParts.join(' — ') } : {})
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
    res.json({ ok: true, invoice_id: invData.id, numero: invData.number, facture_a: buyerName,
      url: `https://${process.env.VOSFACTURES_ACCOUNT}.vosfactures.fr/invoices/${invData.id}` });
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
      subject: `[Eloflex] Expédition de votre commande ${cmd.bdc||'#'+cmd.id}`,
      cc: 'sav@eloflex.fr',
      html: `<div style="font-family:sans-serif;max-width:580px;color:#222;margin:0 auto">
        <div style="background:#1a3a5c;padding:20px 24px;border-radius:8px 8px 0 0">
          <h2 style="color:#fff;margin:0;font-size:18px;font-weight:600">Eloflex France — Votre commande est en route !</h2>
        </div>
        <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;padding:24px">
          <table style="border-collapse:collapse;width:100%;font-size:13px;margin:0 0 20px;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden">
            <tr style="background:#f8f9fa"><td style="padding:9px 14px;font-weight:600;color:#555;width:170px;border-bottom:1px solid #e5e7eb">Distributeur</td><td style="padding:9px 14px;border-bottom:1px solid #e5e7eb">${cmd.distributeur_nom}</td></tr>
            ${cmd.groupe ? `<tr><td style="padding:9px 14px;font-weight:600;color:#555;border-bottom:1px solid #e5e7eb">Groupe</td><td style="padding:9px 14px;border-bottom:1px solid #e5e7eb">${cmd.groupe}</td></tr>` : ''}
            <tr style="background:#f8f9fa"><td style="padding:9px 14px;font-weight:600;color:#555;border-bottom:1px solid #e5e7eb">Référence Eloflex</td><td style="padding:9px 14px;border-bottom:1px solid #e5e7eb"><strong>${cmd.bdc||'—'}</strong></td></tr>
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
          <p style="margin:20px 0 0;font-size:12px;color:#aaa;border-top:1px solid #f0f0f0;padding-top:16px">Eloflex France — Service commercial<br>Pour toute question, répondez à cet email.</p>
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


// ── Sync paiement via URL navigateur (pas besoin d'UI) ──────────
router.get('/paiement-vf/sync', adminOnly, async (req, res) => {
  const numFacture = req.query.num;
  const vfIdDirect = req.query.vfid;
  if (!numFacture && !vfIdDirect) return res.json({ error: 'Paramètre ?num=NUMERO ou ?vfid=ID requis' });
  try {
    const axios = require('axios');
    const vfApi = axios.create({
      baseURL: `https://${process.env.VOSFACTURES_ACCOUNT}.vosfactures.fr`,
      headers: { 'Accept': 'application/json' },
      params: { api_token: process.env.VOSFACTURES_API_TOKEN }
    });
    let vfId = vfIdDirect ? parseInt(vfIdDirect) : null;
    let matchedNumber = numFacture;
    // Si pas d'ID direct, chercher par numéro
    if (!vfId && numFacture) {
      const norm = s => String(s||'').toLowerCase().replace(/[\s\-\/\.]+/g,'');
      const n = norm(numFacture);
      for (const kind of ['vat','receipt','proforma']) {
        try {
          const { data } = await vfApi.get('/invoices.json', { params: { number: numFacture, kind, per_page: 10 } });
          if (Array.isArray(data) && data.length) {
            const inv = data.find(d => norm(d.number) === n || norm(d.number).endsWith(n) || String(d.id) === numFacture);
            if (inv) { vfId = inv.id; matchedNumber = inv.number; break; }
          }
        } catch(_) {}
      }
      // Fallback search_text
      if (!vfId) {
        const { data } = await vfApi.get('/invoices.json', { params: { search_text: numFacture, per_page: 20 } });
        if (Array.isArray(data)) {
          const norm = s => String(s||'').toLowerCase().replace(/[\s\-\/\.]+/g,'');
          const n = norm(numFacture);
          const inv = data.find(d => norm(d.number) === n || norm(d.number).endsWith(n));
          if (inv) { vfId = inv.id; matchedNumber = inv.number; }
        }
      }
    }
    if (!vfId) return res.json({ ok: false, reason: `Facture "${numFacture}" introuvable`, tip: 'Essayez avec ?vfid=534309345' });
    // Récupérer le détail
    const { data: detail } = await vfApi.get(`/invoices/${vfId}.json`);
    const raw = {
      number: detail.number, payment_status: detail.payment_status,
      status: detail.status, paid_date: detail.paid_date,
      payment_to: detail.payment_to, paid_sum: detail.paid_sum, paid: detail.paid
    };
    const isPaid = detail.payment_status === 'paid' || !!detail.paid_date || detail.paid === true || detail.paid_sum >= detail.price_gross_total;
    const today = new Date().toISOString().slice(0,10);
    const paymentTo = (detail.payment_to||'').slice(0,10);
    const isOverdue = paymentTo && paymentTo < today && !isPaid;
    const statut = isPaid ? 'paye' : isOverdue ? 'impaye' : 'en_attente';
    // Mettre à jour toutes les commandes avec ce numéro de facture
    const updated = await db.run(
      'UPDATE commandes SET facture_paiement_statut=$1, facture_date_echeance=$2, facture_vf_id=$3 WHERE num_facture=$4 OR num_facture=$5',
      [statut, paymentTo||null, vfId, numFacture, matchedNumber]
    );
    res.json({ ok: true, vfId, matchedNumber, statut, isPaid, raw });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── Sync paiements GLOBALE via URL navigateur ────────────────────
router.get('/paiement-vf/sync-all', adminOnly, async (req, res) => {
  try {
    const axios = require('axios');
    const vfApi = axios.create({
      baseURL: `https://${process.env.VOSFACTURES_ACCOUNT}.vosfactures.fr`,
      headers: { 'Accept': 'application/json' },
      params: { api_token: process.env.VOSFACTURES_API_TOKEN }
    });
    const norm = s => String(s||'').toLowerCase().replace(/[\s\-\/\.]+/g,'');
    const commandes = await db.all(`
      SELECT id, num_facture, facture_vf_id
      FROM commandes
      WHERE num_facture IS NOT NULL AND num_facture != ''
      ORDER BY id DESC LIMIT 300
    `);
    let updated = 0, skipped = 0, errors = 0;
    const results = [];
    for (const cmd of commandes) {
      try {
        let vfId = cmd.facture_vf_id;
        if (!vfId) {
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
        }
        if (!vfId) { skipped++; continue; }
        const { data: detail } = await vfApi.get(`/invoices/${vfId}.json`);
        const isPaid = detail.payment_status === 'paid' || !!detail.paid_date || detail.paid === true;
        const today = new Date().toISOString().slice(0,10);
        const paymentTo = (detail.payment_to||'').slice(0,10);
        const isOverdue = paymentTo && paymentTo < today && !isPaid;
        const statut = isPaid ? 'paye' : isOverdue ? 'impaye' : 'en_attente';
        await db.run('UPDATE commandes SET facture_paiement_statut=$1, facture_date_echeance=$2, facture_vf_id=$3 WHERE id=$4',
          [statut, paymentTo||null, vfId, cmd.id]);
        results.push({ num: cmd.num_facture, statut });
        updated++;
        await new Promise(r => setTimeout(r, 150));
      } catch(e) { errors++; }
    }
    res.json({ ok: true, total: commandes.length, updated, skipped, errors, results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── Sync paiements automatique (appelée par cron 6h) ─────────────
async function syncPaiementsAuto() {
  try {
    if (!process.env.VOSFACTURES_API_TOKEN) return;
    const axios = require('axios');
    const vfApi = axios.create({
      baseURL: `https://${process.env.VOSFACTURES_ACCOUNT}.vosfactures.fr`,
      headers: { 'Accept': 'application/json' },
      params: { api_token: process.env.VOSFACTURES_API_TOKEN }
    });
    const norm = s => String(s||'').toLowerCase().replace(/[\s\-\/\.]+/g,'');
    const commandes = await db.all(`
      SELECT id, num_facture, facture_vf_id, facture_paiement_statut
      FROM commandes
      WHERE num_facture IS NOT NULL AND num_facture != ''
        AND (facture_paiement_statut IS NULL OR facture_paiement_statut NOT IN ('paye','payé','paid'))
      ORDER BY id DESC LIMIT 150
    `);
    let updated = 0;
    for (const cmd of commandes) {
      try {
        let vfId = cmd.facture_vf_id;
        if (!vfId) {
          const n = norm(cmd.num_facture);
          for (const kind of ['vat','receipt']) {
            try {
              const { data } = await vfApi.get('/invoices.json', { params: { number: cmd.num_facture, kind, per_page: 5 } });
              if (Array.isArray(data)) {
                const inv = data.find(d => norm(d.number) === n || norm(d.number).endsWith(n));
                if (inv) { vfId = inv.id; break; }
              }
            } catch(_) {}
          }
        }
        if (!vfId) continue;
        const { data: detail } = await vfApi.get(`/invoices/${vfId}.json`);
        const isPaid = detail.payment_status === 'paid' || !!detail.paid_date;
        const today = new Date().toISOString().slice(0,10);
        const paymentTo = (detail.payment_to||'').slice(0,10);
        const isOverdue = paymentTo && paymentTo < today && !isPaid;
        const statut = isPaid ? 'paye' : isOverdue ? 'impaye' : 'en_attente';
        await db.run('UPDATE commandes SET facture_paiement_statut=$1, facture_date_echeance=$2, facture_vf_id=$3 WHERE id=$4',
          [statut, paymentTo||null, vfId, cmd.id]);
        if (statut !== cmd.facture_paiement_statut) updated++;
        await new Promise(r => setTimeout(r, 200));
      } catch(_) {}
    }
    console.log(`[CRON PAIEMENTS] ${commandes.length} vérifiées, ${updated} mises à jour`);
  } catch(e) { console.error('[CRON PAIEMENTS ERR]', e.message); }
}

module.exports = router;

// ══════════════════════════════════════════════════════════════════
// ── NOTES INTERNES ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// GET notes d'une commande
router.get('/commandes/:id/notes', adminOrOp, async (req, res) => {
  try {
    const notes = await db.all(
      'SELECT * FROM commande_notes WHERE commande_id=$1 ORDER BY created_at ASC',
      [req.params.id]
    );
    res.json(notes);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST ajouter une note
router.post('/commandes/:id/notes', adminOrOp, async (req, res) => {
  try {
    const { texte } = req.body;
    if (!texte || !texte.trim()) return res.status(400).json({ error: 'Texte vide' });
    const user = res.locals.user;
    const note = await db.get(
      'INSERT INTO commande_notes (commande_id, user_id, user_nom, texte) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.params.id, user.id, user.nom || user.email, texte.trim()]
    );
    res.json(note);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE une note (auteur ou admin)
router.delete('/commandes/:id/notes/:noteId', adminOrOp, async (req, res) => {
  try {
    const user = res.locals.user;
    const note = await db.get('SELECT * FROM commande_notes WHERE id=$1', [req.params.noteId]);
    if (!note) return res.status(404).json({ error: 'Note introuvable' });
    if (note.user_id !== user.id && user.role !== 'admin')
      return res.status(403).json({ error: 'Non autorisé' });
    await db.run('DELETE FROM commande_notes WHERE id=$1', [req.params.noteId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET fil de discussions global (toutes commandes, récentes)
router.get('/notes/recent', adminOrOp, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit)||50;
    const notes = await db.all(`
      SELECT n.*, c.bdc, c.distributeur_nom, c.num_serie, c.statut,
             c.date_commande
      FROM commande_notes n
      LEFT JOIN commandes c ON c.id = n.commande_id
      ORDER BY n.created_at DESC
      LIMIT $1
    `, [limit]);
    res.json(notes);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Fil d'équipe (discussions / annonces internes) ─────────────────
async function _discOwnerOrAdmin(id, me) {
  const m = await db.get('SELECT user_id FROM discussion_messages WHERE id=$1', [id]);
  if (!m) return { err: 404 };
  if (m.user_id !== me.id && me.role !== 'admin') return { err: 403 };
  return { ok: true };
}

router.get('/discussions/fil', requireAuth, async (req, res) => {
  try {
    const archived = req.query.archived === '1';
    const me = req.session.user || {};
    const msgs = await db.all(
      'SELECT * FROM discussion_messages WHERE parent_id IS NULL AND archived=$1 ORDER BY pinned DESC, created_at DESC', [archived]
    );
    const replies = await db.all('SELECT * FROM discussion_messages WHERE parent_id IS NOT NULL ORDER BY created_at ASC');
    const reacts = await db.all('SELECT * FROM discussion_reactions');
    const byMsg = {};
    reacts.forEach(r => { (byMsg[r.message_id] = byMsg[r.message_id] || []).push(r); });
    const repByParent = {};
    replies.forEach(r => { (repByParent[r.parent_id] = repByParent[r.parent_id] || []).push({ ...r, can_edit: (r.user_id === me.id || me.role === 'admin') }); });
    const out = msgs.map(m => {
      const grouped = {};
      (byMsg[m.id] || []).forEach(r => { (grouped[r.emoji] = grouped[r.emoji] || []).push(r); });
      const reactions = Object.keys(grouped).map(emoji => ({
        emoji, count: grouped[emoji].length,
        users: grouped[emoji].map(x => x.user_nom),
        mine: grouped[emoji].some(x => x.user_id === me.id)
      }));
      return { ...m, reactions, replies: repByParent[m.id] || [], can_edit: (m.user_id === me.id || me.role === 'admin') };
    });
    res.json(out);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/discussions/fil', requireAuth, async (req, res) => {
  try {
    const me = req.session.user || {};
    const contenu = (req.body.contenu || '').trim();
    if (!contenu) return res.status(400).json({ error: 'Message vide' });
    let parentId = req.body.parent_id ? parseInt(req.body.parent_id) : null;
    if (parentId) {
      const parent = await db.get('SELECT id, parent_id FROM discussion_messages WHERE id=$1', [parentId]);
      if (!parent) return res.status(400).json({ error: 'Message parent introuvable' });
      if (parent.parent_id) parentId = parent.parent_id; // une seule profondeur : on rattache au message racine
    }
    const row = await db.get(
      'INSERT INTO discussion_messages (parent_id, user_id, user_nom, contenu) VALUES ($1,$2,$3,$4) RETURNING *',
      [parentId, me.id || null, me.nom || 'Utilisateur', contenu]
    );
    res.json({ ok: true, message: row });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/discussions/fil/:id', requireAuth, async (req, res) => {
  try {
    const me = req.session.user || {};
    const chk = await _discOwnerOrAdmin(req.params.id, me);
    if (chk.err) return res.status(chk.err).json({ error: chk.err === 404 ? 'Introuvable' : 'Non autorisé' });
    const contenu = (req.body.contenu || '').trim();
    if (!contenu) return res.status(400).json({ error: 'Message vide' });
    const row = await db.get('UPDATE discussion_messages SET contenu=$1, updated_at=NOW() WHERE id=$2 RETURNING *', [contenu, req.params.id]);
    res.json({ ok: true, message: row });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/discussions/fil/:id', requireAuth, async (req, res) => {
  try {
    const me = req.session.user || {};
    const chk = await _discOwnerOrAdmin(req.params.id, me);
    if (chk.err) return res.status(chk.err).json({ error: chk.err === 404 ? 'Introuvable' : 'Non autorisé' });
    // Supprime le message et ses éventuelles réponses
    await db.run('DELETE FROM discussion_messages WHERE id=$1 OR parent_id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/discussions/fil/:id/archive', requireAuth, async (req, res) => {
  try {
    const me = req.session.user || {};
    const chk = await _discOwnerOrAdmin(req.params.id, me);
    if (chk.err) return res.status(chk.err).json({ error: chk.err === 404 ? 'Introuvable' : 'Non autorisé' });
    await db.run('UPDATE discussion_messages SET archived=$1, updated_at=NOW() WHERE id=$2', [!!req.body.archived, req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/discussions/fil/:id/pin', requireAuth, async (req, res) => {
  try {
    const me = req.session.user || {};
    const chk = await _discOwnerOrAdmin(req.params.id, me);
    if (chk.err) return res.status(chk.err).json({ error: chk.err === 404 ? 'Introuvable' : 'Non autorisé' });
    await db.run('UPDATE discussion_messages SET pinned=$1, updated_at=NOW() WHERE id=$2', [!!req.body.pinned, req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Toggle réaction (tout utilisateur authentifié)
router.post('/discussions/fil/:id/reaction', requireAuth, async (req, res) => {
  try {
    const me = req.session.user || {};
    const emoji = (req.body.emoji || '').trim();
    if (!emoji) return res.status(400).json({ error: 'emoji requis' });
    const ex = await db.get('SELECT id FROM discussion_reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3', [req.params.id, me.id, emoji]);
    if (ex) await db.run('DELETE FROM discussion_reactions WHERE id=$1', [ex.id]);
    else await db.run('INSERT INTO discussion_reactions (message_id, user_id, user_nom, emoji) VALUES ($1,$2,$3,$4)', [req.params.id, me.id || null, me.nom || 'Utilisateur', emoji]);
    res.json({ ok: true, active: !ex });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET nombre de notes par commande (pour badges)
router.get('/notes/counts', adminOrOp, async (req, res) => {
  try {
    const rows = await db.all(
      'SELECT commande_id, COUNT(*) AS nb FROM commande_notes GROUP BY commande_id'
    );
    const map = {};
    rows.forEach(r => map[r.commande_id] = parseInt(r.nb));
    res.json(map);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Fin Notes ─────────────────────────────────────────────────────
module.exports.syncPaiementsAuto = syncPaiementsAuto;

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

// ── Rattrapage global VosFactures ────────────────────────────────
// Pour TOUTES les commandes ayant un n° BDC ou un n° de facture : retrouve le document
// VosFactures (recherche robuste period=all + variantes de slash), enregistre le LIEN,
// le STATUT DE PAIEMENT, complète les INFOS MANQUANTES (série/modèle/date), et liste les
// INTROUVABLES. Traite un LOT (offset/limit) pour rester sous le timeout Render → à appeler
// en boucle (offset += traite) jusqu'à done=true.
// Écritures SÛRES : liens + paiement toujours rafraîchis ; num_serie/modele/date_commande
// seulement s'ils sont vides ; correspondance EXACTE sur le numéro normalisé (jamais approximatif).
router.get('/admin/vf-rattrapage', adminOnly, async (req, res) => {
  try {
    if (!process.env.VOSFACTURES_API_TOKEN || !process.env.VOSFACTURES_ACCOUNT) {
      return res.json({ configured: false });
    }
    const axios = require('axios');
    const vfApi = axios.create({
      baseURL: `https://${process.env.VOSFACTURES_ACCOUNT}.vosfactures.fr`,
      headers: { 'Accept': 'application/json' },
      params: { api_token: process.env.VOSFACTURES_API_TOKEN }
    });
    const normalise = s => String(s||'').toLowerCase().replace(/[\s\-\/\.]+/g,'');
    const SERIE_RE = /\b(EL\d{6,}|A\d{2}L?\d{10,}|DE\d{2,}L?\d{10,}|T\d{2}\d{8,}|A\d{12,})\b/i;

    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    const limit  = Math.min(120, Math.max(1, parseInt(req.query.limit) || 50));

    const totalRow = await db.get(`SELECT COUNT(*)::int AS n FROM commandes
      WHERE (bdc IS NOT NULL AND bdc <> '') OR (num_facture IS NOT NULL AND num_facture <> '')`);
    const total = totalRow ? totalRow.n : 0;

    const lot = await db.all(`SELECT id, bdc, num_facture, vf_order_id, facture_vf_id,
        num_serie, modele, date_commande, distributeur_nom
      FROM commandes
      WHERE (bdc IS NOT NULL AND bdc <> '') OR (num_facture IS NOT NULL AND num_facture <> '')
      ORDER BY id ASC LIMIT $1 OFFSET $2`, [limit, offset]);

    let liens = 0, paiements = 0, infos = 0;
    const introuvables = [];

    const detailCache = {};
    async function getDetail(id) {
      if (detailCache[id] !== undefined) return detailCache[id];
      try { const { data } = await vfApi.get(`/invoices/${id}.json`); detailCache[id] = data; }
      catch(_) { detailCache[id] = null; }
      return detailCache[id];
    }

    for (const cmd of lot) {
      const maj = {};
      // ── Facture ──
      if (cmd.num_facture && cmd.num_facture.trim()) {
        let fid = cmd.facture_vf_id;
        if (!fid) {
          const inv = await vfLookupParNumero(vfApi, cmd.num_facture, 'vat');
          if (inv && normalise(inv.number) === normalise(cmd.num_facture)) {
            fid = inv.id; maj.facture_vf_id = fid; maj.vf_invoice_id = fid; liens++;
          } else {
            introuvables.push({ id: cmd.id, type: 'facture', numero: cmd.num_facture, distributeur: cmd.distributeur_nom });
          }
        }
        if (fid) {
          const d = await getDetail(fid);
          if (d) {
            const isPaid = d.payment_status === 'paid' || !!d.paid_date || d.paid === true;
            const today = new Date().toISOString().slice(0,10);
            const paymentTo = (d.payment_to||'').slice(0,10);
            const isOverdue = paymentTo && paymentTo < today && !isPaid;
            maj.facture_paiement_statut = isPaid ? 'paye' : isOverdue ? 'impaye' : 'en_attente';
            maj.facture_date_echeance = paymentTo || null;
            paiements++;
            const positions = d.positions || d.invoice_items || [];
            if (!cmd.num_serie) {
              const txt = [d.description||'', ...positions.map(p=>[p.name||'',p.description||''].join(' '))].join(' ');
              const m = txt.match(SERIE_RE); if (m) maj.num_serie = m[0].trim();
            }
            if (!cmd.date_commande && (d.issue_date || d.sell_date)) maj.date_commande = (d.issue_date||d.sell_date).slice(0,10);
          }
        }
      }
      // ── BDC ──
      if (cmd.bdc && cmd.bdc.trim() && !cmd.vf_order_id) {
        const inv = await vfLookupParNumero(vfApi, cmd.bdc);
        if (inv && normalise(inv.number) === normalise(cmd.bdc)) {
          maj.vf_order_id = String(inv.id); liens++;
          const besoinSerie  = !cmd.num_serie && !maj.num_serie;
          const besoinModele = !cmd.modele && !maj.modele;
          const besoinDate   = !cmd.date_commande && !maj.date_commande;
          if (besoinSerie || besoinModele || besoinDate) {
            const d = await getDetail(inv.id);
            if (d) {
              const positions = d.positions || d.invoice_items || [];
              if (besoinModele) { const lf = positions.find(p=>/eloflex/i.test(p.name||'')); if (lf && lf.name) maj.modele = lf.name.trim(); }
              if (besoinSerie)  { const txt=[d.description||'',...positions.map(p=>[p.name||'',p.description||''].join(' '))].join(' '); const m=txt.match(SERIE_RE); if(m) maj.num_serie=m[0].trim(); }
              if (besoinDate && (d.issue_date||d.sell_date)) maj.date_commande=(d.issue_date||d.sell_date).slice(0,10);
            }
          }
        } else {
          introuvables.push({ id: cmd.id, type: 'bdc', numero: cmd.bdc, distributeur: cmd.distributeur_nom });
        }
      }
      // ── Écriture ──
      const cols = Object.keys(maj);
      if (cols.length) {
        if (maj.num_serie || maj.modele || maj.date_commande) infos++;
        const sets = cols.map((c,i)=>`${c}=$${i+1}`).join(', ');
        await db.run(`UPDATE commandes SET ${sets}, updated_at=NOW() WHERE id=$${cols.length+1}`,
          [...cols.map(c=>maj[c]), cmd.id]);
      }
      await new Promise(r=>setTimeout(r,100));
    }

    const next = offset + lot.length;
    res.json({ configured:true, ok:true, total, offset, traite:lot.length, next_offset: next,
      done: next >= total || lot.length === 0, liens, paiements, infos, introuvables });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── CLIENTS FINAUX (autocomplete + historique) ────────────────────
router.get('/clients-finaux/suggest', requireAuth, async (req, res) => {
  try {
    const q = (req.query.q||'').trim();
    const type = req.query.type || '';
    if (q.length < 2) return res.json([]);
    const pattern = '%' + q + '%';
    const rows = await db.all(`
      SELECT id, type, nom, prenom, adresse, cp, ville, tel, email, nb_commandes
      FROM clients_finaux
      WHERE (nom ILIKE $1 OR prenom ILIKE $1 OR ville ILIKE $1 OR email ILIKE $1)
        ${type ? "AND type = '" + type.replace(/'/g,"''") + "'" : ''}
      ORDER BY nb_commandes DESC, derniere_commande DESC
      LIMIT 8
    `, [pattern]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Upsert client final dans l'historique
async function upsertClientFinal(data) {
  if (!data || !data.nom) return;
  try {
    const existing = await db.get(
      'SELECT id, nb_commandes FROM clients_finaux WHERE type=$1 AND nom=$2 AND (cp=$3 OR cp IS NULL)',
      [data.type||'', data.nom, data.cp||null]
    );
    if (existing) {
      await db.run('UPDATE clients_finaux SET nb_commandes=nb_commandes+1, derniere_commande=NOW(), prenom=$1, adresse=$2, cp=$3, ville=$4, tel=$5, email=$6 WHERE id=$7',
        [data.prenom||null, data.adresse||null, data.cp||null, data.ville||null, data.tel||null, data.email||null, existing.id]);
    } else {
      await db.run('INSERT INTO clients_finaux (type,nom,prenom,adresse,cp,ville,tel,email) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [data.type||'', data.nom||null, data.prenom||null, data.adresse||null, data.cp||null, data.ville||null, data.tel||null, data.email||null]);
    }
  } catch(e) { console.error('[CF UPSERT]', e.message); }
}


// ── Rapport mensuel (1er du mois) ────────────────────────────────
async function envoyerRapportMensuel() {
  try {
    const now = new Date();
    if (now.getDate() !== 1) return; // seulement le 1er du mois
    const moisPrec = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const moisPrecFin = new Date(now.getFullYear(), now.getMonth(), 0);
    const debut = moisPrec.toISOString().slice(0,10);
    const fin = moisPrecFin.toISOString().slice(0,10);
    const moisLabel = moisPrec.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });

    const stats = await db.get(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN statut='Livré' OR statut='Facturé' THEN 1 ELSE 0 END) AS livrees,
        SUM(CASE WHEN facture_paiement_statut IN ('impaye','impayé') THEN 1 ELSE 0 END) AS impayes,
        SUM(CASE WHEN statut='En préparation' OR statut='Auto' THEN 1 ELSE 0 END) AS en_cours
      FROM commandes WHERE date_commande >= $1 AND date_commande <= $2
    `, [debut, fin]);

    const impayesDetails = await db.all(`
      SELECT distributeur_nom, num_facture, facture_date_echeance
      FROM commandes
      WHERE facture_paiement_statut IN ('impaye','impayé')
      ORDER BY facture_date_echeance ASC LIMIT 20
    `);

    const devisOuverts = await db.get('SELECT COUNT(*) AS nb FROM devis WHERE statut=$1', ['ouvert']);

    const brevoKey = process.env.BREVO_API_KEY;
    if (!brevoKey) return;
    const axios = require('axios');
    await axios.post('https://api.brevo.com/v3/smtp/email', {
      sender: { name: 'Eloflex SAV', email: 'sav@eloflex.fr' },
      to: [{ email: 'info@eloflex.fr' }],
      subject: `[Eloflex] Rapport mensuel — ${moisLabel}`,
      htmlContent: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#1F3A5F;padding:20px 24px;border-radius:8px 8px 0 0">
          <h2 style="color:#fff;margin:0">Rapport mensuel Eloflex SAV</h2>
          <div style="color:#A8C4E0;font-size:13px">${moisLabel}</div>
        </div>
        <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;padding:24px">
          <h3 style="color:#1F3A5F;margin-top:0">Commandes du mois</h3>
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <tr style="background:#f8f9fa"><td style="padding:8px 12px;border:1px solid #e5e7eb">Total commandes</td><td style="padding:8px 12px;border:1px solid #e5e7eb;font-weight:bold">${stats.total}</td></tr>
            <tr><td style="padding:8px 12px;border:1px solid #e5e7eb">Livrées / Facturées</td><td style="padding:8px 12px;border:1px solid #e5e7eb">${stats.livrees}</td></tr>
            <tr style="background:#f8f9fa"><td style="padding:8px 12px;border:1px solid #e5e7eb">En cours</td><td style="padding:8px 12px;border:1px solid #e5e7eb">${stats.en_cours}</td></tr>
            <tr style="color:#dc2626"><td style="padding:8px 12px;border:1px solid #e5e7eb">⚠️ Impayées</td><td style="padding:8px 12px;border:1px solid #e5e7eb;font-weight:bold">${stats.impayes}</td></tr>
            <tr style="background:#f8f9fa"><td style="padding:8px 12px;border:1px solid #e5e7eb">Devis en attente</td><td style="padding:8px 12px;border:1px solid #e5e7eb">${devisOuverts.nb}</td></tr>
          </table>
          ${impayesDetails.length ? `
          <h3 style="color:#dc2626;margin-top:20px">Factures impayées</h3>
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <tr style="background:#fef2f2"><th style="padding:6px 10px;border:1px solid #fecaca;text-align:left">Distributeur</th><th style="padding:6px 10px;border:1px solid #fecaca">N° Facture</th><th style="padding:6px 10px;border:1px solid #fecaca">Échéance</th></tr>
            ${impayesDetails.map(i => `<tr><td style="padding:6px 10px;border:1px solid #e5e7eb">${i.distributeur_nom||'—'}</td><td style="padding:6px 10px;border:1px solid #e5e7eb;font-family:monospace">${i.num_facture||'—'}</td><td style="padding:6px 10px;border:1px solid #e5e7eb;color:#dc2626">${i.facture_date_echeance||'—'}</td></tr>`).join('')}
          </table>` : ''}
          <p style="margin-top:20px;font-size:12px;color:#aaa">Rapport automatique généré le ${new Date().toLocaleDateString('fr-FR')} — Eloflex SAV</p>
        </div>
      </div>`
    }, { headers: { 'api-key': brevoKey, 'Content-Type': 'application/json' }, timeout: 15000 });
    console.log('[RAPPORT MENSUEL] Envoyé pour', moisLabel);
  } catch(e) { console.error('[RAPPORT MENSUEL ERR]', e.message); }
}

// ── Alerte impayés automatique ────────────────────────────────────
async function alerterImpayes() {
  try {
    const brevoKey = process.env.BREVO_API_KEY;
    if (!brevoKey) return;
    const today = new Date().toISOString().slice(0,10);
    // Factures passées en impayé aujourd'hui (date_echeance = hier)
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0,10);
    const nouvellesImpayes = await db.all(`
      SELECT distributeur_nom, num_facture, facture_date_echeance, bdc, id
      FROM commandes
      WHERE facture_paiement_statut = 'impaye'
        AND facture_date_echeance = $1
      ORDER BY distributeur_nom
    `, [yesterday]);
    if (!nouvellesImpayes.length) return;
    const axios = require('axios');
    await axios.post('https://api.brevo.com/v3/smtp/email', {
      sender: { name: 'Eloflex SAV', email: 'sav@eloflex.fr' },
      to: [{ email: 'info@eloflex.fr' }],
      subject: `[Eloflex] ⚠️ ${nouvellesImpayes.length} facture(s) impayée(s) — échéance dépassée`,
      htmlContent: `<div style="font-family:Arial,sans-serif;max-width:580px">
        <div style="background:#dc2626;padding:16px 20px;border-radius:8px 8px 0 0">
          <h2 style="color:#fff;margin:0">⚠️ Factures impayées — échéance dépassée</h2>
          <div style="color:#fecaca;font-size:13px">${nouvellesImpayes.length} facture(s) dont l'échéance était le ${yesterday}</div>
        </div>
        <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;padding:20px">
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <tr style="background:#fef2f2"><th style="padding:8px;border:1px solid #fecaca;text-align:left">Distributeur</th><th style="padding:8px;border:1px solid #fecaca">BDC</th><th style="padding:8px;border:1px solid #fecaca">Facture</th><th style="padding:8px;border:1px solid #fecaca">Échéance</th></tr>
            ${nouvellesImpayes.map(i => `<tr><td style="padding:8px;border:1px solid #e5e7eb">${i.distributeur_nom||'—'}</td><td style="padding:8px;border:1px solid #e5e7eb;font-family:monospace">${i.bdc||'—'}</td><td style="padding:8px;border:1px solid #e5e7eb;font-family:monospace">${i.num_facture||'—'}</td><td style="padding:8px;border:1px solid #e5e7eb;color:#dc2626;font-weight:bold">${i.facture_date_echeance}</td></tr>`).join('')}
          </table>
          <p style="margin-top:16px;font-size:12px;color:#aaa">Alerte automatique Eloflex SAV — <a href="https://sav-eloflex.onrender.com" style="color:#2e7cf6">Accéder à l'application</a></p>
        </div>
      </div>`
    }, { headers: { 'api-key': brevoKey, 'Content-Type': 'application/json' }, timeout: 15000 });
    console.log('[ALERTE IMPAYES]', nouvellesImpayes.length, 'factures');
  } catch(e) { console.error('[ALERTE IMPAYES ERR]', e.message); }
}


// ── Import IDs produits VosFactures en masse ─────────────────────
router.post('/catalogue/import-vf-ids', adminOnly, async (req, res) => {
  try {
    if (!process.env.VOSFACTURES_API_TOKEN) return res.json({ ok: false, reason: 'VF non configuré' });
    const axios = require('axios');
    const vfApi = axios.create({
      baseURL: `https://${process.env.VOSFACTURES_ACCOUNT}.vosfactures.fr`,
      headers: { 'Accept': 'application/json' },
      params: { api_token: process.env.VOSFACTURES_API_TOKEN }
    });
    // Récupérer tous les produits VF
    let allProducts = [], page = 1;
    while (true) {
      const { data } = await vfApi.get('/products.json', { params: { per_page: 100, page } });
      if (!Array.isArray(data) || !data.length) break;
      allProducts = allProducts.concat(data);
      if (data.length < 100) break;
      page++;
      await new Promise(r => setTimeout(r, 300));
    }
    // Récupérer catalogue local
    const catalogue = await db.all('SELECT id, ref, designation FROM catalogue WHERE vf_product_id IS NULL');
    const norm = s => String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
    let matched = 0;
    for (const art of catalogue) {
      const artRef = norm(art.ref);
      const artDes = norm(art.designation);
      const match = allProducts.find(p =>
        norm(p.code) === artRef ||
        norm(p.name) === artDes ||
        (artRef.length > 3 && norm(p.code).includes(artRef)) ||
        (artDes.length > 5 && norm(p.name).includes(artDes))
      );
      if (match) {
        await db.run('UPDATE catalogue SET vf_product_id=$1 WHERE id=$2', [match.id, art.id]);
        matched++;
      }
    }
    res.json({ ok: true, vf_products: allProducts.length, catalogue: catalogue.length, matched });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ══════════════════════════════════════════════════════════════════
// ── CARTE DISTRIBUTEURS ──────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Géocodage d'un client via Nominatim (OpenStreetMap, gratuit)
async function geocoderClient(client) {
  try {
    const axios = require('axios');
    const cp = String(client.cp || '').trim();
    const ville = String(client.ville || '').trim();
    // 1) API du gouvernement (geo.api.gouv.fr) : fiable, sans limite de débit, centre de commune.
    //    Par code postal d'abord (robuste même si la ville est mal orthographiée), puis par nom.
    if (/^\d{5}$/.test(cp)) {
      try {
        const { data } = await axios.get('https://geo.api.gouv.fr/communes', { params: { codePostal: cp, fields: 'centre', format: 'json' }, timeout: 6000 });
        if (data && data.length && data[0].centre && data[0].centre.coordinates) return { lat: data[0].centre.coordinates[1], lng: data[0].centre.coordinates[0] };
      } catch (_) {}
    }
    if (ville) {
      try {
        const { data } = await axios.get('https://geo.api.gouv.fr/communes', { params: { nom: ville, fields: 'centre', boost: 'population', limit: 1 }, timeout: 6000 });
        if (data && data.length && data[0].centre && data[0].centre.coordinates) return { lat: data[0].centre.coordinates[1], lng: data[0].centre.coordinates[0] };
      } catch (_) {}
    }
    // 2) Repli Nominatim (adresse précise, ou pays étranger) — dernier recours.
    const headers = { 'User-Agent': 'EloflexSAV/1.0 (info@eloflex.fr)' };
    const tentatives = [];
    if (client.adresse && ville) tentatives.push([client.adresse, cp, ville].filter(Boolean).join(', ') + ', France');
    if (ville) tentatives.push(ville + ', France');
    for (const q of tentatives) {
      try {
        const { data } = await axios.get('https://nominatim.openstreetmap.org/search', {
          params: { q, format: 'json', limit: 1, countrycodes: 'fr' }, headers, timeout: 5000
        });
        if (data && data.length) return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
      } catch (_) {}
      await new Promise(r => setTimeout(r, 300));
    }
    return null;
  } catch(_) { return null; }
}

// Route: géocoder tous les clients sans coordonnées
router.post('/carte/geocoder', requireAuth, async (req, res) => {
  try {
    const clients = await db.all(
      'SELECT id, nom, adresse, cp, ville FROM clients WHERE lat IS NULL AND ville IS NOT NULL ORDER BY id LIMIT 50'
    );
    let done = 0, errors = 0;
    for (const cl of clients) {
      const coords = await geocoderClient(cl);
      if (coords) {
        await db.run('UPDATE clients SET lat=$1, lng=$2, geocoded_at=NOW() WHERE id=$3', [coords.lat, coords.lng, cl.id]);
        done++;
      } else errors++;
      await new Promise(r => setTimeout(r, 1100)); // Nominatim rate limit: 1 req/sec
    }
    const remaining = await db.get('SELECT COUNT(*) AS nb FROM clients WHERE lat IS NULL AND ville IS NOT NULL');
    res.json({ ok: true, done, errors, remaining: parseInt(remaining.nb) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Route: données carte (clients géocodés + stats commandes)
router.get('/carte/distributeurs', requireAuth, async (req, res) => {
  try {
    const annee = req.query.annee ? parseInt(req.query.annee) : new Date().getFullYear();
    const rows = await db.all(`
      SELECT
        c.id, c.nom, c.ville, c.cp, c.lat, c.lng, c.type, c.tel, c.email,
        COUNT(cmd.id) AS nb_commandes,
        SUM(CASE WHEN cmd.statut IS NULL OR cmd.statut='Auto' OR cmd.statut='En préparation' THEN 1 ELSE 0 END) AS en_cours,
        SUM(CASE WHEN cmd.facture_paiement_statut IN ('impaye','impayé') THEN 1 ELSE 0 END) AS impayes,
        MAX(cmd.date_commande) AS derniere_commande
      FROM clients c
      LEFT JOIN commandes cmd ON cmd.client_id = c.id
        AND EXTRACT(YEAR FROM cmd.date_commande::date) = $1
      WHERE c.lat IS NOT NULL AND c.type != 'patient'
      GROUP BY c.id, c.nom, c.ville, c.cp, c.lat, c.lng, c.type, c.tel, c.email
      ORDER BY nb_commandes DESC
    `, [annee]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Route: données pour KML export (pour importer depuis Google My Maps)
router.get('/carte/kml', requireAuth, async (req, res) => {
  try {
    const rows = await db.all('SELECT nom, ville, cp, lat, lng, type FROM clients WHERE lat IS NOT NULL ORDER BY nom');
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document><name>Distributeurs Eloflex</name>
  ${rows.map(r => `<Placemark><name>${r.nom}</name><description>${r.ville} ${r.cp||''}</description>
    <Point><coordinates>${r.lng},${r.lat},0</coordinates></Point></Placemark>`).join('\n  ')}
  </Document></kml>`;
    res.setHeader('Content-Type', 'application/vnd.google-earth.kml+xml');
    res.setHeader('Content-Disposition', 'attachment; filename="distributeurs-eloflex.kml"');
    res.send(kml);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Fin Carte ─────────────────────────────────────────────────────

// ══════════════════════════════════════════════════════════════════
// ── CARTE DISTRIBUTEURS (KML import) ─────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Parse KML content et extraire les placemarks
function parseKmlContent(kmlText, reseau) {
  const placemarks = [];
  // Extraction basique par regex (pas de lib XML nécessaire)
  const pmRegex = /<Placemark>([\s\S]*?)<\/Placemark>/g;
  let match;
  while ((match = pmRegex.exec(kmlText)) !== null) {
    const pm = match[1];
    const nameM = pm.match(/<name>([\s\S]*?)<\/name>/);
    const descM = pm.match(/<description>([\s\S]*?)<\/description>/);
    const coordM = pm.match(/<coordinates>([\s\S]*?)<\/coordinates>/);
    if (!coordM) continue;
    const name = nameM ? nameM[1].replace(/<!\[CDATA\[|\]\]>/g,'').trim() : '';
    let desc = descM ? descM[1].replace(/<!\[CDATA\[|\]\]>/g,'').trim() : '';
    // Ignorer les polygones (territoires), ne garder que les Points
    if (pm.includes('<Polygon>') || pm.includes('<LineString>')) continue;
    const coordText = coordM[1].trim();
    const coordPairs = coordText.split(/\s+/).map(c => {
      const [lng, lat] = c.split(',').map(Number);
      return { lat, lng };
    }).filter(p => !isNaN(p.lat) && !isNaN(p.lng));
    if (!coordPairs.length) continue;
    let lat, lng;
    if (coordPairs.length === 1) {
      lat = coordPairs[0].lat; lng = coordPairs[0].lng;
    } else {
      // Centroïde du polygone
      lat = coordPairs.reduce((s,p)=>s+p.lat,0)/coordPairs.length;
      lng = coordPairs.reduce((s,p)=>s+p.lng,0)/coordPairs.length;
    }
    // Parser l'adresse depuis la description (format: NOM<br>adresse<br>CP VILLE<br>tel<br>email)
    const parts = desc.replace(/<br\s*\/?>/gi, '\n').split('\n').map(s=>s.trim()).filter(Boolean);
    let adresse = '', cp = '', ville = '', tel = '', email = '';
    for (const p of parts) {
      const cpVille = p.match(/\b(\d{5})\s+([A-ZÀ-Ÿ][A-Za-zÀ-ÿ\s\-]+)/);
      const emailM = p.match(/[\w.\-]+@[\w.\-]+\.\w+/);
      const telM = p.match(/(?:0|\+33)[\s.]?[1-9](?:[\s.]?\d{2}){4}/);
      if (cpVille && !cp) { cp = cpVille[1]; ville = cpVille[2].trim(); }
      else if (emailM && !email) email = emailM[0];
      else if (telM && !tel) tel = telM[0].trim();
      else if (!adresse && p !== name && !cpVille && !emailM && !telM) adresse = p;
    }
    placemarks.push({ reseau, nom: name, description: desc, adresse, cp, ville, tel, email, lat, lng });
  }
  return placemarks;
}

// Route: import KML (remplace tous les points d'un réseau)
router.post('/carte/import-kml', requireAuth, async (req, res) => {
  try {
    const { reseau, kml } = req.body;
    if (!reseau || !kml) return res.status(400).json({ error: 'reseau et kml requis' });
    const points = parseKmlContent(kml, reseau);
    if (!points.length) return res.json({ ok: false, reason: 'Aucun point trouvé dans le KML' });
    // Supprimer les anciens points de ce réseau
    await db.run('DELETE FROM distributeurs_carte WHERE reseau=$1', [reseau]);
    // Insérer les nouveaux
    let inserted = 0;
    for (const p of points) {
      await db.run(
        `INSERT INTO distributeurs_carte (reseau, nom, description, adresse, cp, ville, tel, email, lat, lng, pays)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [p.reseau, p.nom, p.description, p.adresse||null, p.cp||null, p.ville||null, p.tel||null, p.email||null, p.lat, p.lng, 'France']
      );
      inserted++;
    }
    res.json({ ok: true, reseau, inserted });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Route: données carte (points + correspondance commandes)
// Normalisation robuste : accents convertis (é->e), ponctuation -> espaces
function normNom(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
const MOTS_VIDES = new Set(['sarl','sas','sasu','eurl','sa','snc','sarlu','ets','etablissement',
  'etablissements','ste','societe','scop','sci','scm','selarl','et','de','du','des','la','le','les']);
function motsNom(s) {
  return normNom(s).split(' ').filter(w => w.length > 1 && !MOTS_VIDES.has(w));
}
// Mémoïsation : chaque nom n'est normalisé/tokenisé qu'UNE fois par process.
// Le rapprochement carte compare les mêmes noms des centaines de milliers de fois
// (points × commandes × clients priorisés) ; sans cache, GET /carte/points prenait ~6 s.
(function(){
  const _nc = new Map(), _mc = new Map();
  const _rawNorm = normNom, _rawMots = motsNom;
  normNom = function(s){ const k = String(s||''); let v = _nc.get(k); if (v === undefined){ v = _rawNorm(k); if (_nc.size < 50000) _nc.set(k, v); } return v; };
  motsNom = function(s){ const k = String(s||''); let v = _mc.get(k); if (v === undefined){ v = _rawMots(k); if (_mc.size < 50000) _mc.set(k, v); } return v; };
})();
// true si les deux noms désignent vraisemblablement la même entité
function memeEntite(a, b) {
  const na = normNom(a), nb = normNom(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ta = motsNom(a), tb = motsNom(b);
  if (!ta.length || !tb.length) return false;
  const [petit, grand] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  return petit.every(w => grand.includes(w)) && petit.some(w => w.length >= 4);
}

// Route: données carte (points + rattachement aux commandes)
router.get('/carte/points', requireAuth, async (req, res) => {
  try {
    const annee = req.query.annee ? parseInt(req.query.annee) : new Date().getFullYear();
    const points = await db.all('SELECT * FROM distributeurs_carte ORDER BY reseau, nom');
    // Priorité (T1/T2/T3) par client, pour l'afficher/filtrer sur la carte
    // On récupère aussi le nom pour pouvoir rattacher la priorité par NOM quand
    // le point n'a pas de client_id (la plupart des points importés du KML).
    const prioRows = await db.all(`SELECT id, nom, priorite FROM clients WHERE priorite IS NOT NULL`);
    const prioParClient = {};
    for (const r of prioRows) prioParClient[r.id] = r.priorite;
    // Priorité d'un point : d'abord par client_id, sinon par nom (exact puis rapprochement)
    const prioNorm = prioRows.map(r => ({ n: normNom(r.nom), priorite: r.priorite, nom: r.nom }));
    const prioritePour = (p) => {
      if (p.client_id && prioParClient[p.client_id]) return prioParClient[p.client_id];
      const np = normNom(p.nom);
      const exact = prioNorm.find(r => r.n === np);
      if (exact) return exact.priorite;
      const flou = prioNorm.find(r => memeEntite(p.nom, r.nom));
      return flou ? flou.priorite : null;
    };
    const stats = await db.all(`
      SELECT distributeur_nom, client_id,
        COUNT(*) AS nb_commandes,
        SUM(CASE WHEN facture_paiement_statut IN ('impaye','impayé') THEN 1 ELSE 0 END) AS impayes,
        SUM(CASE WHEN statut IS NULL OR statut='Auto' OR statut='En préparation' THEN 1 ELSE 0 END) AS en_cours
      FROM commandes
      WHERE EXTRACT(YEAR FROM date_commande::date) = $1
      GROUP BY distributeur_nom, client_id
    `, [annee]);

    // Année de la DERNIÈRE commande par distributeur (toutes années confondues),
    // pour filtrer l'affichage des points sur la carte selon leur activité récente.
    const dernieres = await db.all(`
      SELECT distributeur_nom, client_id,
        MAX(EXTRACT(YEAR FROM date_commande::date))::int AS derniere_annee
      FROM commandes
      WHERE date_commande IS NOT NULL
      GROUP BY distributeur_nom, client_id
    `);

    // Demandes "absence de retour" par distributeur (pour signaler les distributeurs peu réactifs sur la carte)
    const absRows = await db.all(`
      SELECT client_id, COALESCE(distributeur_nom,'') AS distributeur_nom, COUNT(*)::int AS n
      FROM demandes_info WHERE statut='absence_retour'
      GROUP BY client_id, COALESCE(distributeur_nom,'')`);
    const absRetourPour = (p) => {
      let cand = [];
      if (p.client_id) cand = absRows.filter(a => a.client_id === p.client_id);
      if (!cand.length) cand = absRows.filter(a => a.distributeur_nom && memeEntite(p.nom, a.distributeur_nom));
      return cand.reduce((s, a) => s + (a.n || 0), 0);
    };

    const cumul = (liste) => liste.reduce((a, s) => ({
      nb_commandes: a.nb_commandes + (parseInt(s.nb_commandes) || 0),
      impayes:      a.impayes      + (parseInt(s.impayes) || 0),
      en_cours:     a.en_cours     + (parseInt(s.en_cours) || 0)
    }), { nb_commandes: 0, impayes: 0, en_cours: 0 });

    // Dernière année d'un point : max sur les lignes rapprochées (par client_id sinon par nom)
    const derniereAnneePour = (p, trouves) => {
      let cand = [];
      if (p.client_id) cand = dernieres.filter(d => d.client_id === p.client_id);
      if (!cand.length) cand = dernieres.filter(d => memeEntite(p.nom, d.distributeur_nom));
      const annees = cand.map(d => d.derniere_annee).filter(Boolean);
      return annees.length ? Math.max(...annees) : null;
    };

    const enriched = points.map(p => {
      let trouves = [];
      let lien = 'aucun';
      // 1) Lien explicite via client_id : prioritaire et sans ambiguïté
      if (p.client_id) {
        trouves = stats.filter(s => s.client_id === p.client_id);
        if (trouves.length) lien = 'client';
      }
      // 2) Sinon rapprochement par nom (accents et mots gérés)
      if (!trouves.length) {
        trouves = stats.filter(s => memeEntite(p.nom, s.distributeur_nom));
        if (trouves.length) lien = 'nom';
      }
      return {
        ...p,
        ...cumul(trouves),
        lien_type: lien,
        derniere_annee: derniereAnneePour(p, trouves),
        priorite: prioritePour(p),
        abs_retour: absRetourPour(p),
        noms_rattaches: [...new Set(trouves.map(t => t.distributeur_nom).filter(Boolean))]
      };
    });
    res.json(enriched);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Route: sauvegarder note interne d'un point
router.put('/carte/points/:id/note', requireAuth, async (req, res) => {
  try {
    const { note } = req.body;
    await db.run('UPDATE distributeurs_carte SET note_interne=$1, updated_at=NOW() WHERE id=$2', [note||null, req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Route: sauvegarder la zone de chalandise (départements) + rayon de couverture d'un point
router.put('/carte/points/:id/zone', requireAuth, async (req, res) => {
  try {
    const { zone, rayon_km } = req.body;
    const rayon = (rayon_km === '' || rayon_km === null || rayon_km === undefined) ? null : parseFloat(rayon_km);
    await db.run('UPDATE distributeurs_carte SET zone_chalandise=$1, rayon_km=$2, updated_at=NOW() WHERE id=$3',
      [zone || null, (Number.isFinite(rayon) && rayon > 0) ? rayon : null, req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Route: modifier la priorité d'un point depuis la carte → écrit sur la fiche client
router.put('/carte/points/:id/priorite', requireAuth, async (req, res) => {
  try {
    const prio = req.body.priorite || null;
    if (prio && !['T1', 'T2', 'T3'].includes(prio)) return res.status(400).json({ error: 'Priorité invalide' });
    const pt = await db.get('SELECT id, client_id, nom FROM distributeurs_carte WHERE id=$1', [req.params.id]);
    if (!pt) return res.status(404).json({ error: 'Point introuvable' });
    let clientId = pt.client_id;
    if (!clientId) {
      const c = await db.get('SELECT id FROM clients WHERE LOWER(TRIM(nom))=LOWER(TRIM($1))', [pt.nom]);
      if (c) clientId = c.id;
    }
    if (!clientId) return res.status(400).json({ error: 'Point non relié à une fiche client — priorité non enregistrable. Reliez-le d\'abord via « Rattacher ».' });
    await db.run('UPDATE clients SET priorite=$1, updated_at=NOW() WHERE id=$2', [prio, clientId]);
    res.json({ ok: true, client_id: clientId, priorite: prio });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Route: distributeurs présents dans Clients/distributeurs mais PAS sur la carte
// (hors Particulier), qui possèdent des coordonnées. Sert au filtre "hors carte".
router.get('/carte/hors-carte', requireAuth, async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT id, nom, ville, cp, adresse, tel, email, lat, lng, priorite, reseau_carte
         FROM clients
        WHERE (sur_carte IS NOT TRUE) AND (type IS DISTINCT FROM 'Particulier')
          AND lat IS NOT NULL AND lng IS NOT NULL`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: copie l'adresse réelle (fiche client) sur les points de carte reliés à un client.
// Corrige les points dont l'adresse affichée = le nom. ?dry=1 pour aperçu.
router.post('/admin/carte-sync-adresses', adminOnly, async (req, res) => {
  try {
    const dry = req.query.dry === '1';
    const pts = await db.all(
      `SELECT dc.id, dc.nom, dc.adresse AS adr_actuelle, c.adresse AS adr_client, c.cp AS cp_client, c.ville AS ville_client
         FROM distributeurs_carte dc JOIN clients c ON c.id = dc.client_id
        WHERE c.adresse IS NOT NULL AND TRIM(c.adresse) <> ''
          AND LOWER(TRIM(COALESCE(dc.adresse,''))) IS DISTINCT FROM LOWER(TRIM(c.adresse))`
    );
    const maj = [];
    for (const p of pts) {
      // ne corriger que si l'adresse actuelle est vide ou = au nom, ou différente de la vraie
      const bogus = !p.adr_actuelle || p.adr_actuelle.trim().toLowerCase() === String(p.nom || '').trim().toLowerCase();
      const differente = String(p.adr_actuelle || '').trim().toLowerCase() !== String(p.adr_client || '').trim().toLowerCase();
      if (bogus || differente) {
        maj.push({ id: p.id, nom: p.nom, avant: p.adr_actuelle, apres: p.adr_client });
        if (!dry) await db.run('UPDATE distributeurs_carte SET adresse=$1, cp=COALESCE($2,cp), ville=COALESCE($3,ville), updated_at=NOW() WHERE id=$4',
          [p.adr_client, p.cp_client || null, p.ville_client || null, p.id]);
      }
    }
    res.json({ ok: true, dry, corrigees: maj.length, details: maj.slice(0, 200) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: géocode par lot les distributeurs hors carte (hors Particulier) sans coordonnées.
// ?limit=N (défaut 40). À lancer plusieurs fois pour tout couvrir.
router.post('/admin/geocoder-hors-carte', carteWrite, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 40, 100);
    // geocoded_at IS NULL = pas encore tenté (les échecs sont marqués pour ne pas les re-tenter en boucle)
    const rows = await db.all(
      `SELECT id, nom, adresse, cp, ville, pays FROM clients
        WHERE (sur_carte IS NOT TRUE) AND (type IS DISTINCT FROM 'Particulier')
          AND lat IS NULL AND geocoded_at IS NULL
          AND (COALESCE(ville,'')<>'' OR COALESCE(cp,'')<>'')
        ORDER BY id LIMIT $1`, [limit]);
    let ok = 0, ko = 0;
    for (const c of rows) {
      try {
        const geo = await geocoderClient(c);
        if (geo && geo.lat && geo.lng) {
          await db.run('UPDATE clients SET lat=$1, lng=$2, geocoded_at=NOW() WHERE id=$3', [geo.lat, geo.lng, c.id]);
          ok++;
        } else {
          await db.run('UPDATE clients SET geocoded_at=NOW() WHERE id=$1', [c.id]); // marque "tenté, échoué"
          ko++;
        }
      } catch (_) { ko++; }
      await new Promise(r => setTimeout(r, 1100)); // respect du débit Nominatim (~1/s)
    }
    const reste = await db.get(
      `SELECT COUNT(*)::int AS n FROM clients
        WHERE (sur_carte IS NOT TRUE) AND (type IS DISTINCT FROM 'Particulier')
          AND lat IS NULL AND geocoded_at IS NULL
          AND (COALESCE(ville,'')<>'' OR COALESCE(cp,'')<>'')`);
    res.json({ ok: true, geocodes: ok, echecs: ko, restants: reste ? reste.n : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: réarme le géocodage (geocoded_at=NULL) des distributeurs hors carte encore sans
// coordonnées mais qui ont au moins une ville/CP — pour re-tenter avec le repli commune.
router.post('/admin/reset-geocodage-hors-carte', adminOnly, async (req, res) => {
  try {
    const r = await db.run(
      `UPDATE clients SET geocoded_at=NULL
        WHERE (sur_carte IS NOT TRUE) AND (type IS DISTINCT FROM 'Particulier')
          AND lat IS NULL AND geocoded_at IS NOT NULL
          AND (COALESCE(ville,'')<>'' OR COALESCE(cp,'')<>'')`);
    const n = await db.get(
      `SELECT COUNT(*)::int AS n FROM clients
        WHERE (sur_carte IS NOT TRUE) AND (type IS DISTINCT FROM 'Particulier')
          AND lat IS NULL AND geocoded_at IS NULL
          AND (COALESCE(ville,'')<>'' OR COALESCE(cp,'')<>'')`);
    res.json({ ok: true, a_regeocoder: n ? n.n : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: enrichit l'adresse des distributeurs hors carte depuis VosFactures (via vf_id),
// quand l'adresse app est vide ou sans numéro de rue. Réarme le géocodage (geocoded_at=NULL).
// ?limit=N (défaut 40). À lancer avant le géocodage pour améliorer le taux de réussite.
router.post('/admin/enrichir-adresses-vf', carteWrite, async (req, res) => {
  try {
    if (!process.env.VOSFACTURES_API_TOKEN || !process.env.VOSFACTURES_ACCOUNT) return res.json({ ok: false, reason: 'VosFactures non configuré' });
    const axios = require('axios');
    const vfApi = axios.create({
      baseURL: `https://${process.env.VOSFACTURES_ACCOUNT}.vosfactures.fr`,
      timeout: 8000, params: { api_token: process.env.VOSFACTURES_API_TOKEN }
    });
    const limit = Math.min(parseInt(req.query.limit) || 40, 100);
    // hors carte, non particulier, vf_id présent, adresse vide ou sans chiffre (donc pas une vraie rue), pas encore enrichie
    const rows = await db.all(
      `SELECT id, nom, vf_id, adresse, cp, ville FROM clients
        WHERE (sur_carte IS NOT TRUE) AND (type IS DISTINCT FROM 'Particulier')
          AND vf_id IS NOT NULL AND lat IS NULL AND geocoded_at IS NULL
          AND (adresse IS NULL OR TRIM(adresse)='' OR adresse !~ '[0-9]')
        ORDER BY id LIMIT $1`, [limit]);
    let maj = 0, sansRue = 0, err = 0;
    for (const c of rows) {
      try {
        const { data } = await vfApi.get('/clients/' + c.vf_id + '.json');
        const street = String((data && data.street) || '').replace(/\r?\n/g, ' ').trim();
        if (street && /[0-9]/.test(street)) {
          await db.run(
            `UPDATE clients SET adresse=$1, cp=COALESCE(NULLIF($2,''),cp), ville=COALESCE(NULLIF($3,''),ville), geocoded_at=NULL WHERE id=$4`,
            [street, String((data.post_code || '')).trim(), String((data.city || '')).trim(), c.id]);
          maj++;
        } else {
          // pas d'adresse rue exploitable côté VF : on marque comme tenté pour ne pas boucler
          await db.run('UPDATE clients SET geocoded_at=COALESCE(geocoded_at, NOW()) WHERE id=$1', [c.id]);
          sansRue++;
        }
      } catch (_) { err++; }
      await new Promise(r => setTimeout(r, 130));
    }
    res.json({ ok: true, enrichis: maj, sans_rue_vf: sansRue, erreurs: err, traites: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bascule une liste de clients en "Particulier" (allège la liste des distributeurs hors carte)
router.post('/admin/passer-particulier', adminOnly, async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(function(x){ return parseInt(x); }).filter(function(x){ return Number.isInteger(x); }) : [];
    if (!ids.length) return res.status(400).json({ error: 'Aucun id fourni' });
    const r = await db.run(
      `UPDATE clients SET type='Particulier', sur_carte=false, updated_at=NOW() WHERE id = ANY($1::int[])`, [ids]);
    res.json({ ok: true, demandes: ids.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Corrige la ville d'un client (contrôle ville ↔ code postal depuis la carte)
router.put('/clients/:id/ville', requireAuth, async (req, res) => {
  try {
    const ville = String(req.body.ville || '').trim();
    if (!ville) return res.status(400).json({ error: 'Ville requise' });
    await db.run('UPDATE clients SET ville=$1, updated_at=NOW() WHERE id=$2', [ville, req.params.id]);
    res.json({ ok: true, ville });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Route: liste des clients pour rattachement manuel
router.get('/carte/clients-liste', requireAuth, async (req, res) => {
  try {
    const rows = await db.all(
      "SELECT id, nom, ville, sur_carte FROM clients WHERE type <> 'Particulier' ORDER BY nom"
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Route debug: lister tous les noms de distributeurs des commandes
router.get('/carte/debug-noms', requireAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').toLowerCase();
    const commandes = await db.all("SELECT DISTINCT distributeur_nom FROM commandes WHERE distributeur_nom IS NOT NULL ORDER BY distributeur_nom");
    const carte = await db.all("SELECT DISTINCT nom, reseau FROM distributeurs_carte ORDER BY nom");
    const cmdNoms = commandes.map(c => c.distributeur_nom).filter(n => !q || n.toLowerCase().includes(q));
    const carteNoms = carte.filter(c => !q || c.nom.toLowerCase().includes(q));
    res.json({ commandes: cmdNoms, carte: carteNoms });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Route: compteurs par réseau
router.get('/carte/reseaux', requireAuth, async (req, res) => {
  try {
    const rows = await db.all('SELECT reseau, COUNT(*) AS nb FROM distributeurs_carte GROUP BY reseau');
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Fin Carte ─────────────────────────────────────────────────────

// ── CRUD point carte (ajout/modif/suppression manuelle) ──────────
router.post('/carte/points', requireAuth, async (req, res) => {
  try {
    const { reseau, nom, adresse, cp, ville, tel, portable, email, lat, lng, client_id, pays } = req.body;
    if (!reseau || !nom || lat == null || lng == null)
      return res.status(400).json({ error: 'reseau, nom, lat, lng requis' });
    const row = await db.get(
      `INSERT INTO distributeurs_carte (reseau, nom, adresse, cp, ville, tel, portable, email, lat, lng, client_id, pays)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [reseau, nom, adresse||null, cp||null, ville||null, tel||null, portable||null, email||null,
       parseFloat(lat), parseFloat(lng), client_id || null, pays || 'France']
    );
    res.json({ ok: true, point: row });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/carte/points/:id', requireAuth, async (req, res) => {
  try {
    const { reseau, nom, adresse, cp, ville, tel, portable, email, lat, lng, client_id, pays } = req.body;
    const row = await db.get(
      `UPDATE distributeurs_carte SET
        reseau=COALESCE($1,reseau), nom=COALESCE($2,nom), adresse=$3, cp=$4, ville=$5,
        tel=$6, email=$7, lat=COALESCE($8,lat), lng=COALESCE($9,lng),
        client_id=$10, pays=COALESCE($11,pays), portable=$13, updated_at=NOW()
       WHERE id=$12 RETURNING *`,
      [reseau||null, nom||null, adresse||null, cp||null, ville||null, tel||null, email||null,
       lat!=null?parseFloat(lat):null, lng!=null?parseFloat(lng):null,
       client_id ? parseInt(client_id) : null, pays||null, req.params.id, portable||null]
    );
    if (!row) return res.status(404).json({ error: 'Point introuvable' });
    res.json({ ok: true, point: row });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/carte/points/:id', requireAuth, async (req, res) => {
  try {
    await db.run('DELETE FROM distributeurs_carte WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Géocodage d'une adresse (pour trouver lat/lng lors de l'ajout manuel)
router.get('/carte/geocode-adresse', requireAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ found: false });
    const pays = (req.query.pays || '').trim() || null;
    const trouve = await geocoderLibre(q, pays);
    if (trouve) res.json({ found: true, ...trouve });
    else res.json({ found: false });
  } catch(e) { res.status(500).json({ error: e.message }); }
});



// ── Géocodage multi-pays ──────────────────────────────────────────
const PAYS_ISO = {
  'France':'fr', 'Sweden':'se', 'UK':'gb', 'Germany':'de', 'Spain':'es', 'Italy':'it',
  'Belgium':'be', 'Switzerland':'ch', 'Netherlands':'nl', 'Luxembourg':'lu',
  'Portugal':'pt', 'Denmark':'dk', 'Norway':'no', 'Finland':'fi', 'Austria':'at', 'Ireland':'ie'
};

// Géocodage France via l'API du gouvernement (geo.api.gouv.fr) : fiable, sans
// limite de débit — contrairement à Nominatim qui bloque l'IP du serveur en usage
// intensif (d'où certains codes postaux "qui ne marchent pas" sur la carte).
async function geocoderGouvFr(requete) {
  const axios = require('axios');
  const s = String(requete || '');
  const cpM = s.match(/\b(\d{5})\b/);
  // 1) Par code postal : le plus robuste (marche même si la ville est mal orthographiée).
  if (cpM) {
    try {
      const { data } = await axios.get('https://geo.api.gouv.fr/communes', { params: { codePostal: cpM[1], fields: 'centre', format: 'json' }, timeout: 6000 });
      if (data && data.length && data[0].centre && data[0].centre.coordinates)
        return { lat: data[0].centre.coordinates[1], lng: data[0].centre.coordinates[0], display: data[0].nom || '' };
    } catch (_) {}
  }
  // 2) Par nom de commune : on isole le segment ville (après le CP, sinon dernier segment).
  let ville = '';
  if (cpM) ville = s.slice(s.indexOf(cpM[1]) + 5).replace(/^[\s,]+/, '').split(',')[0].trim();
  else { const parts = s.split(','); ville = (parts[parts.length - 1] || '').trim(); }
  ville = ville.replace(/\bfrance\b/ig, '').replace(/\d/g, '').trim();
  if (ville) {
    try {
      const { data } = await axios.get('https://geo.api.gouv.fr/communes', { params: { nom: ville, fields: 'centre', boost: 'population', limit: 1 }, timeout: 6000 });
      if (data && data.length && data[0].centre && data[0].centre.coordinates)
        return { lat: data[0].centre.coordinates[1], lng: data[0].centre.coordinates[0], display: data[0].nom || '' };
    } catch (_) {}
  }
  return null;
}

// Interroge Nominatim en ciblant le pays, puis sans restriction si rien n'est trouvé
async function geocoderLibre(requete, pays) {
  const axios = require('axios');
  // France : on privilégie l'API du gouvernement (fiable, sans limite) avant Nominatim.
  if (!pays || pays === 'France') {
    const gouv = await geocoderGouvFr(requete);
    if (gouv) return gouv;
  }
  const iso = PAYS_ISO[pays] || null;
  // Pays explicite : on cible ce pays, puis on élargit.
  // Pays non précisé : on privilégie la France, puis le monde entier.
  const essais = pays
    ? [ { q: requete + ', ' + pays, iso: iso },
        { q: requete + ', ' + pays, iso: null },
        { q: requete, iso: null } ]
    : [ { q: requete + ', France', iso: 'fr' },
        { q: requete, iso: null } ];
  for (const essai of essais) {
    try {
      const params = { q: essai.q, format: 'json', limit: 1 };
      if (essai.iso) params.countrycodes = essai.iso;
      const { data } = await axios.get('https://nominatim.openstreetmap.org/search', {
        params,
        headers: { 'User-Agent': 'EloflexSAV/1.0 (info@eloflex.fr)' },
        timeout: 8000
      });
      if (data && data.length) {
        return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), display: data[0].display_name };
      }
    } catch(e) { /* on passe à l'essai suivant */ }
    await new Promise(r => setTimeout(r, 1100)); // limite Nominatim : 1 requête/seconde
  }
  return null;
}

// ── Synchronisation client -> point sur la carte ─────────────────
// Crée, met à jour ou retire le point carte d'un client selon son flag sur_carte.
async function syncClientCarte(clientId) {
  const cl = await db.get('SELECT * FROM clients WHERE id=$1', [clientId]);
  if (!cl) return { ok: false, reason: 'client introuvable' };

  const existant = await db.get('SELECT * FROM distributeurs_carte WHERE client_id=$1', [clientId]);

  // Décoché : on retire le point créé depuis la fiche client
  if (!cl.sur_carte) {
    if (existant) await db.run('DELETE FROM distributeurs_carte WHERE id=$1', [existant.id]);
    return { ok: true, action: existant ? 'retire' : 'rien' };
  }

  const reseau = cl.reseau_carte || 'base';

  // Coordonnées : celles du client, sinon géocodage
  let lat = cl.lat, lng = cl.lng;
  let precision = 'existante';
  if (lat == null || lng == null) {
    if (!cl.ville && !cl.cp) return { ok: false, reason: 'ville ou code postal manquant — impossible de localiser ce client' };
    // On tente d'abord l'adresse complète (précise au numéro), puis on retombe sur CP + ville
    const tentatives = [];
    if (cl.adresse) tentatives.push({ q: [cl.adresse, cl.cp, cl.ville].filter(Boolean).join(', '), p: 'adresse' });
    if (cl.cp || cl.ville) tentatives.push({ q: [cl.cp, cl.ville].filter(Boolean).join(' '), p: 'ville' });
    for (const tent of tentatives) {
      const trouve = await geocoderLibre(tent.q, cl.pays);
      if (trouve) { lat = trouve.lat; lng = trouve.lng; precision = tent.p; break; }
    }
    if (lat == null || lng == null) {
      return { ok: false, reason: 'adresse introuvable' + (cl.pays && cl.pays !== 'France' ? ' en ' + cl.pays : '') + ' — positionnez le point manuellement depuis la carte' };
    }
    await db.run('UPDATE clients SET lat=$1, lng=$2, geocoded_at=NOW() WHERE id=$3', [lat, lng, clientId]);
  }

  const adrCarte = [cl.adresse, cl.adresse2].filter(Boolean).join(' — ') || null;

  if (existant) {
    await db.run(
      `UPDATE distributeurs_carte SET reseau=$1, nom=$2, adresse=$3, cp=$4, ville=$5,
       tel=$6, email=$7, lat=$8, lng=$9, pays=$10, updated_at=NOW() WHERE id=$11`,
      [reseau, cl.nom, adrCarte, cl.cp||null, cl.ville||null, cl.tel||null, cl.email||null,
       lat, lng, cl.pays||'France', existant.id]
    );
    return { ok: true, action: 'maj', lat, lng, precision };
  }
  await db.run(
    `INSERT INTO distributeurs_carte (reseau, nom, adresse, cp, ville, tel, email, lat, lng, pays, client_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [reseau, cl.nom, adrCarte, cl.cp||null, cl.ville||null, cl.tel||null, cl.email||null,
     lat, lng, cl.pays||'France', clientId]
  );
  return { ok: true, action: 'cree', lat, lng, precision };
}

// Resynchronise tous les clients marqués « sur la carte »
router.post('/carte/sync-clients', requireAuth, async (req, res) => {
  try {
    const clients = await db.all('SELECT id FROM clients WHERE sur_carte = TRUE');
    let ok = 0; const echecs = [];
    for (const c of clients) {
      const r = await syncClientCarte(c.id);
      if (r.ok) ok++; else echecs.push({ id: c.id, raison: r.reason });
      await new Promise(r => setTimeout(r, 1100)); // limite Nominatim
    }
    res.json({ ok: true, synchronises: ok, echecs });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ══════════════════════════════════════════════════════════════════
// ── SAUVEGARDE DE LA BASE ────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Toutes les tables métier. Les empreintes de mots de passe sont exclues :
// recréer quelques comptes est trivial, diffuser leurs empreintes ne l'est pas.
const TABLES_SAUVEGARDE = [
  'clients', 'commandes', 'commandes_lignes', 'commandes_retour_lignes',
  'fauteuils', 'interventions', 'intervention_produits', 'intervention_photos',
  'intervention_commentaires', 'intervention_historique',
  'catalogue', 'commande_notes', 'clients_finaux', 'distributeurs_carte',
  'devis', 'devis_relances', 'transferts_fauteuils', 'retours_suede',
  'alertes', 'parametres'
];

async function construireSauvegarde() {
  const donnees = {}, resume = {};
  for (const table of TABLES_SAUVEGARDE) {
    try {
      const lignes = await db.all(`SELECT * FROM ${table}`);
      donnees[table] = lignes; resume[table] = lignes.length;
    } catch (e) {
      donnees[table] = []; resume[table] = `erreur : ${e.message}`;
    }
  }
  try {
    const users = await db.all('SELECT id, email, nom, role, pays, permissions, created_at FROM users');
    donnees.users = users; resume.users = users.length;
  } catch (_) { donnees.users = []; resume.users = 'erreur'; }

  return {
    meta: {
      application: 'sav-eloflex',
      genere_le: new Date().toISOString(),
      mots_de_passe_exclus: true,
      resume
    },
    donnees
  };
}

router.get('/sauvegarde/export', adminOnly, async (req, res) => {
  try {
    const sauvegarde = await construireSauvegarde();
    const nom = `sauvegarde-sav-eloflex-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${nom}"`);
    res.send(JSON.stringify(sauvegarde, null, 2));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Restauration depuis un fichier de sauvegarde JSON (produit par /sauvegarde/export).
// Vide puis réinsère chaque table dans l'ordre parents→enfants, en transaction.
// Ordre des tables important pour respecter les clés étrangères.
const ORDRE_RESTAURATION = [
  'parametres', 'clients', 'clients_finaux', 'catalogue', 'distributeurs_carte',
  'fauteuils', 'commandes', 'commandes_lignes', 'commandes_retour_lignes',
  'commande_notes', 'interventions', 'intervention_produits', 'intervention_photos',
  'intervention_commentaires', 'intervention_historique',
  'devis', 'devis_relances', 'transferts_fauteuils', 'retours_suede', 'alertes'
];
router.post('/sauvegarde/restaurer', adminOnly, async (req, res) => {
  const sauvegarde = req.body;
  if (!sauvegarde || !sauvegarde.donnees) {
    return res.status(400).json({ error: 'Fichier de sauvegarde invalide (clé "donnees" absente)' });
  }
  const donnees = sauvegarde.donnees;
  const pgClient = await db.pool.connect();
  const rapport = {};
  try {
    await pgClient.query('BEGIN');
    // 1) Vider les tables dans l'ordre inverse (enfants→parents) pour ne pas violer les FK
    for (const table of [...ORDRE_RESTAURATION].reverse()) {
      try { await pgClient.query(`DELETE FROM ${table}`); } catch (_) {}
    }
    // 2) Réinsérer dans l'ordre parents→enfants
    for (const table of ORDRE_RESTAURATION) {
      const lignes = Array.isArray(donnees[table]) ? donnees[table] : [];
      if (!lignes.length) { rapport[table] = 0; continue; }
      let n = 0;
      for (const ligne of lignes) {
        const cols = Object.keys(ligne);
        if (!cols.length) continue;
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
        const valeurs = cols.map(c => {
          const v = ligne[c];
          // Réencoder les objets/tableaux (colonnes JSON) en chaîne JSON
          if (v !== null && typeof v === 'object') return JSON.stringify(v);
          return v;
        });
        try {
          await pgClient.query(
            `INSERT INTO ${table} (${cols.map(c => `"${c}"`).join(',')}) VALUES (${placeholders})`,
            valeurs
          );
          n++;
        } catch (e) { /* ligne ignorée si incompatible, on continue */ }
      }
      rapport[table] = n;
      // 3) Réajuster la séquence d'auto-increment sur id si présente
      if (cols_ont_id(lignes[0])) {
        try {
          await pgClient.query(
            `SELECT setval(pg_get_serial_sequence('${table}','id'), COALESCE((SELECT MAX(id) FROM ${table}),1), true)`
          );
        } catch (_) {}
      }
    }
    await pgClient.query('COMMIT');
    res.json({ ok: true, rapport });
  } catch (e) {
    await pgClient.query('ROLLBACK');
    res.status(500).json({ error: e.message, rapport });
  } finally {
    pgClient.release();
  }
});
function cols_ont_id(ligne) { return ligne && Object.prototype.hasOwnProperty.call(ligne, 'id'); }

router.get('/sauvegarde/resume', adminOnly, async (req, res) => {
  try {
    const tables = {}; let total = 0;
    for (const table of [...TABLES_SAUVEGARDE, 'users']) {
      try {
        const r = await db.get(`SELECT COUNT(*)::int AS nb FROM ${table}`);
        tables[table] = r.nb; total += r.nb;
      } catch (_) { tables[table] = null; }
    }
    const dernier = await db.get(
      "SELECT created_at FROM sync_log WHERE type='sauvegarde' AND status='ok' ORDER BY created_at DESC LIMIT 1"
    );
    res.json({ ok: true, tables, total_lignes: total, derniere_sauvegarde: dernier ? dernier.created_at : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function envoyerSauvegardeHebdo(forcer) {
  try {
    if (!forcer && new Date().getDay() !== 1) return { ignore: 'pas un lundi' };
    if (!process.env.BREVO_API_KEY) return { ignore: 'BREVO_API_KEY absente' };

    const sauvegarde = await construireSauvegarde();
    const zlib = require('zlib');
    const compresse = zlib.gzipSync(Buffer.from(JSON.stringify(sauvegarde), 'utf8'), { level: 9 });
    const base64 = compresse.toString('base64');
    const date = new Date().toISOString().slice(0, 10);
    const poids = (compresse.length / 1024 / 1024).toFixed(2);
    const tropLourd = base64.length > 6 * 1024 * 1024;

    const lignes = Object.entries(sauvegarde.meta.resume)
      .filter(([, v]) => typeof v === 'number' && v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `<tr><td style="padding:3px 10px;border:1px solid #e5e7eb">${t}</td>` +
                       `<td style="padding:3px 10px;border:1px solid #e5e7eb;text-align:right">${n}</td></tr>`).join('');

    await sendBrevoMail({
      from: 'sav@eloflex.fr', fromName: 'Eloflex SAV', to: 'info@eloflex.fr',
      subject: `[Eloflex] Sauvegarde de la base — ${date}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:560px">
        <div style="background:#1F3A5F;padding:18px 22px;border-radius:8px 8px 0 0">
          <h2 style="color:#fff;margin:0;font-size:17px">Sauvegarde hebdomadaire</h2>
          <div style="color:#A8C4E0;font-size:13px">${date}</div>
        </div>
        <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;padding:20px">
          ${tropLourd
            ? `<p style="color:#b45309"><strong>Sauvegarde trop volumineuse pour être jointe (${poids} Mo compressés).</strong><br>
                 Téléchargez-la depuis l'application : Paramètres → Sauvegarde.</p>`
            : `<p style="font-size:14px;margin-top:0">Sauvegarde complète en pièce jointe
                 (<strong>${poids} Mo</strong> compressés). Conservez-la hors de l'application.</p>`}
          <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:12px">
            <tr style="background:#f8f9fa"><th style="padding:5px 10px;border:1px solid #e5e7eb;text-align:left">Table</th>
            <th style="padding:5px 10px;border:1px solid #e5e7eb;text-align:right">Lignes</th></tr>${lignes}
          </table>
          <p style="font-size:11px;color:#999;margin-top:16px">Les empreintes de mots de passe ne sont pas incluses.</p>
        </div></div>`,
      attachments: tropLourd ? [] : [{ content: base64, name: `sauvegarde-sav-eloflex-${date}.json.gz` }]
    });
    return { ok: true, poids_mo: poids, joint: !tropLourd };
  } catch (e) {
    console.error('[SAUVEGARDE ERR]', e.message);
    return { ok: false, erreur: e.message };
  }
}

router.post('/sauvegarde/envoyer', adminOnly, async (req, res) => {
  res.json(await envoyerSauvegardeHebdo(true));
});

// ══════════════════════════════════════════════════════════════════
// ── TÂCHES PLANIFIÉES ────────────────────────────────────────────
// Le service redémarre souvent : on journalise chaque exécution pour
// qu'une tâche ne parte pas deux fois le même jour.
// ══════════════════════════════════════════════════════════════════

async function dejaFaitAujourdhui(tache) {
  try {
    const r = await db.get(
      "SELECT 1 AS ok FROM sync_log WHERE type=$1 AND status='ok' AND created_at::date = CURRENT_DATE LIMIT 1",
      [tache]
    );
    return !!r;
  } catch (_) { return false; }
}

async function journaliser(tache, statut, message) {
  try {
    await db.run('INSERT INTO sync_log (type, status, message) VALUES ($1,$2,$3)',
      [tache, statut, String(message || '').slice(0, 500)]);
  } catch (_) { /* la journalisation ne doit jamais bloquer */ }
}

async function executerTachesQuotidiennes(forcer) {
  const bilan = {};
  const taches = [
    ['alerte-impayes',   alerterImpayes],
    ['rapport-mensuel',  envoyerRapportMensuel],
    ['sauvegarde',       envoyerSauvegardeHebdo]
  ];
  for (const [nom, fn] of taches) {
    if (!forcer && await dejaFaitAujourdhui(nom)) { bilan[nom] = 'déjà exécutée aujourd\u2019hui'; continue; }
    try {
      const r = await fn();
      bilan[nom] = (r && r.ignore) ? r.ignore : 'exécutée';
      await journaliser(nom, 'ok', bilan[nom]);
    } catch (e) {
      bilan[nom] = 'erreur : ' + e.message;
      await journaliser(nom, 'erreur', e.message);
    }
  }
  return bilan;
}

router.post('/taches/quotidiennes', adminOnly, async (req, res) => {
  res.json({ ok: true, bilan: await executerTachesQuotidiennes(req.query.forcer === '1') });
});

// Déclenchement automatique : au démarrage puis toutes les six heures.
// Le garde-fou par journal évite les doublons lors des redémarrages.
if (!global.__tachesEloflexDemarrees) {
  global.__tachesEloflexDemarrees = true;
  setTimeout(() => executerTachesQuotidiennes().catch(() => {}), 3 * 60 * 1000);
  setInterval(() => executerTachesQuotidiennes().catch(() => {}), 6 * 60 * 60 * 1000);
}

// ── Fin Sauvegarde et tâches ──────────────────────────────────────


// ── Rattachement en masse des points de carte aux clients ─────────

// Termes de métier trop répandus pour prouver à eux seuls une identité :
// « Pharmacie Durand » et « Pharmacie Martin » sont deux maisons différentes.
const MOTS_GENERIQUES = new Set([
  'pharmacie', 'medical', 'medicale', 'medicaux', 'medic', 'sante', 'orthopedie', 'orthopedique',
  'ortho', 'materiel', 'materiels', 'service', 'services', 'confort', 'domicile', 'assistance',
  'sud', 'nord', 'est', 'ouest', 'centre', 'grand', 'petit', 'nouveau', 'nouvelle',
  'france', 'europe', 'group', 'groupe', 'distribution', 'distrib', 'diffusion', 'equipement',
  'equipements', 'mobilite', 'autonomie', 'handicap', 'pharma', 'clinic', 'clinique', 'sarl'
]);

// Score de ressemblance entre deux noms : 100 identique, 0 sans rapport
function scoreRessemblance(a, b) {
  const na = normNom(a), nb = normNom(b);
  if (!na || !nb) return 0;
  if (na === nb) return 100;
  const ta = motsNom(a), tb = motsNom(b);
  if (!ta.length || !tb.length) return 0;
  const communs = ta.filter(m => tb.includes(m));
  if (!communs.length) return 0;
  // Il faut au moins un mot distinctif en commun, pas seulement un terme de métier
  const solide = communs.some(m => m.length >= 4 && !MOTS_GENERIQUES.has(m));
  if (!solide) return 0;
  // Proportion de mots partagés, pondérée par le plus court des deux noms
  const base = Math.min(ta.length, tb.length);
  let score = Math.round((communs.length / base) * 90);
  if (na.includes(nb) || nb.includes(na)) score = Math.max(score, 85);
  return Math.min(score, 99);
}

// Liste les points non rattachés, avec les clients les plus ressemblants
router.get('/carte/rattachements', requireAuth, async (req, res) => {
  try {
    const points = await db.all(
      'SELECT id, nom, reseau, ville, cp, client_id FROM distributeurs_carte ORDER BY nom'
    );
    const clients = await db.all(
      "SELECT id, nom, ville, cp FROM clients WHERE type <> 'Particulier' ORDER BY nom"
    );
    const annee = new Date().getFullYear();
    const ventes = await db.all(`
      SELECT client_id, distributeur_nom, COUNT(*)::int AS nb
      FROM commandes
      WHERE EXTRACT(YEAR FROM date_commande::date) = $1
      GROUP BY client_id, distributeur_nom
    `, [annee]);

    const ventesParClient = {};
    ventes.forEach(v => {
      if (v.client_id) ventesParClient[v.client_id] = (ventesParClient[v.client_id] || 0) + v.nb;
    });

    const dejaPris = new Set(points.filter(p => p.client_id).map(p => p.client_id));

    const resultat = points.map(p => {
      if (p.client_id) {
        const cl = clients.find(c => c.id === p.client_id);
        return { ...p, etat: 'lie', client_nom: cl ? cl.nom : '(client supprimé)', suggestions: [] };
      }
      const suggestions = clients
        .map(c => ({
          id: c.id, nom: c.nom, ville: c.ville, cp: c.cp,
          score: scoreRessemblance(p.nom, c.nom),
          commandes: ventesParClient[c.id] || 0,
          deja_lie: dejaPris.has(c.id)
        }))
        .filter(c => c.score >= 40)
        .sort((a, b) => b.score - a.score || b.commandes - a.commandes)
        .slice(0, 4);
      return { ...p, etat: suggestions.length ? 'suggestion' : 'aucune', suggestions };
    });

    res.json({
      ok: true,
      total: points.length,
      lies: resultat.filter(p => p.etat === 'lie').length,
      avec_suggestion: resultat.filter(p => p.etat === 'suggestion').length,
      sans_suggestion: resultat.filter(p => p.etat === 'aucune').length,
      points: resultat
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Applique plusieurs rattachements d'un coup
router.post('/carte/rattachements', requireAuth, async (req, res) => {
  try {
    const liens = Array.isArray(req.body.liens) ? req.body.liens : [];
    let appliques = 0;
    for (const l of liens) {
      if (!l || !l.point_id) continue;
      await db.run('UPDATE distributeurs_carte SET client_id=$1, updated_at=NOW() WHERE id=$2',
        [l.client_id || null, l.point_id]);
      appliques++;
    }
    res.json({ ok: true, appliques });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════
// BONS DE PRÊT (offres de prêt / essai de fauteuils aux distributeurs)
// ══════════════════════════════════════════════════════════════════
const PRET_STATUTS = ['brouillon','envoye','signe','en_cours','retard','prolonge','cloture','rachete'];

// Signature e-mail Éloflex (Service Commercial) — ajoutée aux e-mails de demande de signature
const SIGNATURE_EMAIL_HTML = `
<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="border-collapse:collapse; font-family:Arial, Helvetica, sans-serif;">
  <tr><td style="padding-bottom:16px;">
    <table cellpadding="0" cellspacing="0" border="0" role="presentation" style="border-collapse:collapse;"><tr>
      <td valign="middle" style="padding-right:20px; border-right:2px solid #E1E6EB;">
        <img src="https://sensode.com/eloflex/wp-content/uploads/logo-signature.png" alt="Éloflex" width="185" style="display:block; border:0; outline:none;">
      </td>
      <td valign="middle" style="padding-left:20px; color:#333333;">
        <div style="font-size:17px; font-weight:bold; color:#1F3A5F; margin-bottom:2px;">Service Commercial</div>
        <div style="font-size:14px; font-weight:bold; color:#2B7DC7; line-height:19px; margin-bottom:8px;">Eloflex France</div>
        <div style="font-size:14px; color:#333333; line-height:22px;">
          <a href="mailto:info@eloflex.fr" style="color:#2B7DC7; text-decoration:none;">info@eloflex.fr</a>
          &nbsp;&nbsp;&#183;&nbsp;&nbsp;
          <a href="https://eloflex.fr" style="color:#2B7DC7; text-decoration:none;">eloflex.fr</a>
        </div>
        <div style="font-size:14px; color:#333333; line-height:22px;">Tél. : <span style="color:#2B7DC7;">09&nbsp;67&nbsp;66&nbsp;51&nbsp;29</span></div>
        <div style="font-size:14px; color:#333333; line-height:22px;">Mob : <span style="color:#2B7DC7;">06&nbsp;87&nbsp;04&nbsp;69&nbsp;19</span></div>
      </td>
    </tr></table>
  </td></tr>
  <tr><td>
    <table cellpadding="0" cellspacing="0" border="0" role="presentation" width="580" bgcolor="#FFF4C2" style="width:580px; border-collapse:collapse; border-left:4px solid #F2C200;"><tr><td style="padding:16px 22px;">
      <div style="font-size:15px; font-weight:bold; color:#1F5FA6; letter-spacing:0.3px; margin-bottom:3px;">INFORMATION IMPORTANTE &ndash; NOUVEAUX CODES LPP</div>
      <div style="font-size:13px; color:#555555; margin-bottom:14px;">Nos codes LPP fabricant ont &eacute;t&eacute; mis &agrave; jour.</div>
      <table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%" style="width:100%; border-collapse:collapse;">
        <tr>
          <td valign="top" style="padding:9px 0; border-top:1px solid #EAD98A; font-size:13px; color:#222222; line-height:17px;"><strong style="color:#111111;">Mod&egrave;les L &#183; F &#183; D2 &#183; P &#183; R</strong><br><span style="font-size:11px; color:#777777;">4545512 &ndash; VPH, achat neuf, FRE-B, modulaire &agrave; propulsion par moteur &eacute;lectrique &ndash; classe B</span></td>
          <td valign="top" align="right" style="padding:9px 0 9px 18px; border-top:1px solid #EAD98A; white-space:nowrap;"><span style="font-size:10px; color:#777777; text-transform:uppercase; letter-spacing:0.3px;">Nouveau LPPR</span><br><strong style="font-size:16px; color:#1F5FA6;">9570265</strong></td>
        </tr>
        <tr>
          <td valign="top" style="padding:9px 0; border-top:1px solid #EAD98A; font-size:13px; color:#222222; line-height:17px;"><strong style="color:#111111;">Coussins EASE ONE &#183; EASE WEDGE</strong><br><span style="font-size:11px; color:#777777;">4947601 &ndash; VPH, adjonction, PAP forfait B adjonctions membre inf&eacute;rieur</span></td>
          <td valign="top" align="right" style="padding:9px 0 9px 18px; border-top:1px solid #EAD98A; white-space:nowrap;"><span style="font-size:10px; color:#777777; text-transform:uppercase; letter-spacing:0.3px;">Nouveau LPPR</span><br><strong style="font-size:16px; color:#1F5FA6;">9903695</strong></td>
        </tr>
        <tr>
          <td valign="top" style="padding:9px 0; border-top:1px solid #EAD98A; font-size:13px; color:#222222; line-height:17px;"><strong style="color:#111111;">Commande tierce personne KIT A</strong><br><span style="font-size:11px; color:#777777;">4965183 &ndash; VPH, adjonction, bo&icirc;tier de commande personnalis&eacute; pour FRE, FREP et FREV</span></td>
          <td valign="top" align="right" style="padding:9px 0 9px 18px; border-top:1px solid #EAD98A; white-space:nowrap;"><span style="font-size:10px; color:#777777; text-transform:uppercase; letter-spacing:0.3px;">Nouveau LPPR</span><br><strong style="font-size:16px; color:#1F5FA6;">9948893</strong></td>
        </tr>
      </table>
    </td></tr></table>
  </td></tr>
</table>`;

// Envoi d'e-mail lié à un prêt — via l'API Brevo (le SMTP est bloqué par Render)
async function envoyerEmailPret({ to, cc, bcc, subject, html, attachments }) {
  const p = {}; const rows = await db.all('SELECT cle,valeur FROM parametres'); rows.forEach(r => p[r.cle] = r.valeur);
  const att = (attachments || []).map(a => ({
    name: a.filename || a.name || 'document.pdf',
    content: (a.content || '').replace(/^data:.*?;base64,/, '')
  }));
  await sendBrevoMail({
    from: p.email_from || 'sav@eloflex.fr', fromName: 'Eloflex France',
    to, cc: cc !== undefined ? cc : (p.email_cc_sav || 'sav@eloflex.fr'), bcc,
    subject, html, attachments: att
  });
}

// ── Automatisation : prêt + contrat-cadre signés → commande démo au Suivi ──
// Crée la commande "démo" liée au prêt (une seule fois), et la relie au BDC Pennylane.
async function creerCommandeDepuisPret(p) {
  if (!p || p.commande_id) return;
  let arts = p.articles;
  if (typeof arts === 'string') { try { arts = JSON.parse(arts); } catch(_) { arts = null; } }
  const a0 = (Array.isArray(arts) && arts[0]) ? arts[0] : null;
  const modele  = p.designation || (a0 && a0.designation) || '';
  const numSerie = p.num_serie || (a0 && a0.num_serie) || null;
  // Formatage robuste en 'YYYY-MM-DD' (date_remise peut être un objet Date renvoyé par pg)
  const _iso = (v) => {
    if (!v) return null;
    if (v instanceof Date) return isNaN(v) ? null : v.toISOString().slice(0,10);
    const s = String(v);
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0,10);
    const d = new Date(s); return isNaN(d) ? null : d.toISOString().slice(0,10);
  };
  const dateCmd = _iso(p.date_remise) || new Date().toISOString().slice(0,10);
  const annee = parseInt(dateCmd.slice(0,4)) || new Date().getFullYear();
  const vfId = p.bdc_vf_id || null;
  // Anti-doublon si une commande porte déjà ce doc Pennylane
  if (vfId) {
    const ex = await db.get('SELECT id FROM commandes WHERE vf_commande_id=$1', [vfId]);
    if (ex) { await db.run('UPDATE prets SET commande_id=$1 WHERE id=$2', [ex.id, p.id]); return ex.id; }
  }
  const row = await db.run(
    `INSERT INTO commandes (client_id, annee_onglet, distributeur_nom, modele, quantite,
        bdc, date_commande, num_serie, modele_demo, statut, informations, vf_commande_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,$9,$10,$11) RETURNING id`,
    [p.client_id || null, annee, p.distributeur_nom || null, modele, 1,
     p.bdc_vf || null, dateCmd, numSerie, 'En préparation',
     'Créée automatiquement depuis le bon de prêt signé (contrat-cadre + prêt signés).', vfId]);
  await db.run('UPDATE prets SET commande_id=$1, updated_at=NOW() WHERE id=$2', [row.id, p.id]);
  try { await addAlerte('pret_commande', p.id,
    `📦 Commande démo ajoutée au suivi : ${p.distributeur_nom || ''} — ${modele || ''} ${numSerie || ''} (prêt + contrat-cadre signés).`); } catch(_){}
  return row.id;
}

// Appelé quand un bon de prêt vient d'être signé : ajoute au Suivi si le contrat-cadre est signé
async function apresPretSigne(pretId) {
  try {
    const p = await db.get('SELECT * FROM prets WHERE id=$1', [pretId]);
    if (!p || p.commande_id || !p.client_id) return;
    const cc = await db.get('SELECT statut FROM contrats_cadre WHERE client_id=$1', [p.client_id]);
    if (cc && cc.statut === 'signe') await creerCommandeDepuisPret(p);
  } catch (e) { console.error('[PRET] apresPretSigne:', e.message); }
}

// Appelé quand un contrat-cadre vient d'être signé : ajoute au Suivi les prêts déjà signés du distributeur
async function apresContratSigne(clientId) {
  try {
    if (!clientId) return;
    const prets = await db.all(
      "SELECT * FROM prets WHERE client_id=$1 AND statut='signe' AND commande_id IS NULL", [clientId]);
    for (const p of prets) await creerCommandeDepuisPret(p);
  } catch (e) { console.error('[CONTRAT] apresContratSigne:', e.message); }
}

// Liste des prêts (avec nom distributeur à jour)
router.get('/prets', requireAuth, async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT p.*, c.nom AS client_nom_actuel, c.email AS client_email_actuel, u.nom AS signataire_eloflex
       FROM prets p LEFT JOIN clients c ON c.id = p.client_id LEFT JOIN users u ON u.id = p.cree_par
       ORDER BY p.created_at DESC`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/prets/:id', requireAuth, async (req, res) => {
  try {
    const p = await db.get(
      `SELECT p.*, c.nom AS client_nom_actuel, c.email AS client_email_actuel, u.nom AS signataire_eloflex
       FROM prets p LEFT JOIN clients c ON c.id = p.client_id LEFT JOIN users u ON u.id = p.cree_par WHERE p.id=$1`, [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Prêt introuvable' });
    res.json(p);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/prets', requireAuth, async (req, res) => {
  try {
    const d = req.body || {};
    const token = crypto.randomBytes(20).toString('hex');
    const row = await db.run(
      `INSERT INTO prets (client_id, distributeur_nom, contact, email, tel, adresse, formule,
        designation, num_serie, valeur_ht, bdc_vf, bdc_vf_id, articles,
        livraison_autre, livraison_client_id, livraison_nom, livraison_adresse,
        date_remise, date_retour_prevue, prorogation_date, observations, statut, token_signature, cree_par)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING *`,
      [d.client_id || null, d.distributeur_nom || null, d.contact || null, d.email || null, fmtTel(d.tel) || null,
       d.adresse || null, d.formule || 'essai_court', d.designation || null, d.num_serie || null,
       d.valeur_ht || null, d.bdc_vf || null, d.bdc_vf_id || null, d.articles ? JSON.stringify(d.articles) : null,
       !!d.livraison_autre, d.livraison_client_id || null, d.livraison_nom || null, d.livraison_adresse || null,
       d.date_remise || null, d.date_retour_prevue || null, d.prorogation_date || null,
       d.observations || null, d.statut || 'brouillon', token,
       (req.session.user && req.session.user.id) || null]);
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/prets/:id', requireAuth, async (req, res) => {
  try {
    const d = req.body || {};
    const row = await db.run(
      `UPDATE prets SET client_id=$1, distributeur_nom=$2, contact=$3, email=$4, tel=$5, adresse=$6,
        formule=$7, designation=$8, num_serie=$9, valeur_ht=$10, bdc_vf=$11, bdc_vf_id=$12, articles=$13,
        livraison_autre=$14, livraison_client_id=$15, livraison_nom=$16, livraison_adresse=$17,
        date_remise=$18, date_retour_prevue=$19, prorogation_date=$20, observations=$21, statut=$22,
        updated_at=NOW() WHERE id=$23 RETURNING *`,
      [d.client_id || null, d.distributeur_nom || null, d.contact || null, d.email || null, fmtTel(d.tel) || null,
       d.adresse || null, d.formule || 'essai_court', d.designation || null, d.num_serie || null,
       d.valeur_ht || null, d.bdc_vf || null, d.bdc_vf_id || null, d.articles ? JSON.stringify(d.articles) : null,
       !!d.livraison_autre, d.livraison_client_id || null, d.livraison_nom || null, d.livraison_adresse || null,
       d.date_remise || null, d.date_retour_prevue || null, d.prorogation_date || null,
       d.observations || null, d.statut || 'brouillon', req.params.id]);
    if (!row) return res.status(404).json({ error: 'Prêt introuvable' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Changer uniquement le statut (retour, prolongation, clôture, rachat…)
router.post('/prets/:id/statut', requireAuth, async (req, res) => {
  try {
    const statut = String((req.body && req.body.statut) || '').trim();
    if (!PRET_STATUTS.includes(statut)) return res.status(400).json({ error: 'Statut invalide' });
    const extra = (req.body && req.body.prorogation_date) ? req.body.prorogation_date : null;
    const row = extra
      ? await db.run('UPDATE prets SET statut=$1, prorogation_date=$2, updated_at=NOW() WHERE id=$3 RETURNING id, statut', [statut, extra, req.params.id])
      : await db.run('UPDATE prets SET statut=$1, updated_at=NOW() WHERE id=$2 RETURNING id, statut', [statut, req.params.id]);
    if (!row) return res.status(404).json({ error: 'Prêt introuvable' });
    res.json({ ok: true, pret: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Marquer une offre de prêt comme signée par e-mail (signature hors ligne) avec une date choisie
router.post('/prets/:id/signe-mail', requireAuth, async (req, res) => {
  try {
    const date = (req.body && req.body.date) ? String(req.body.date).slice(0, 10) : null;
    const row = await db.run(
      `UPDATE prets SET statut='signe',
         signed_at = COALESCE($1::date::timestamptz, NOW()),
         signataire_nom = COALESCE(NULLIF(signataire_nom, ''), 'Signé par e-mail'),
         updated_at = NOW()
       WHERE id=$2 RETURNING id, statut, signed_at`,
      [date, req.params.id]);
    if (!row) return res.status(404).json({ error: 'Prêt introuvable' });
    await apresPretSigne(req.params.id);
    res.json({ ok: true, pret: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/prets/:id', requireAuth, async (req, res) => {
  try {
    await db.run('DELETE FROM prets WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Envoyer au distributeur le lien de signature en ligne (statut → envoyé)
router.post('/prets/:id/envoyer', requireAuth, async (req, res) => {
  try {
    const p = await db.get('SELECT * FROM prets WHERE id=$1', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Prêt introuvable' });
    const dest = (req.body && req.body.email) || p.email;
    if (!dest) return res.status(400).json({ error: 'Aucune adresse e-mail pour ce distributeur' });
    const base = process.env.APP_URL || (req.protocol + '://' + req.get('host'));
    const lien = `${base}/pret/${p.token_signature}`;
    const pdfData = req.body && req.body.pdf_data;
    const attachments = pdfData
      ? [{ filename: `Bon_de_pret_${(p.distributeur_nom||'distributeur').replace(/[^\w-]+/g,'_')}.pdf`,
           content: String(pdfData).replace(/^data:application\/pdf;base64,/, '') }]
      : [];
    const blocManuel = pdfData
      ? `<div style="border:1px dashed #cbd5e1;border-radius:8px;padding:14px 16px;margin-top:16px;background:#f8fafc;font-size:13px;color:#334">
           <b>Vous préférez signer à la main ?</b><br>
           Vous pouvez télécharger le PDF ci-joint, le signer et le renvoyer scanné à l'adresse :
           <a href="mailto:info@eloflex.fr" style="color:#1F5C8C;font-weight:600">info@eloflex.fr</a>.
         </div>`
      : '';
    await envoyerEmailPret({
      to: dest,
      subject: `Bon de prêt Eloflex — à signer en ligne`,
      attachments,
      html: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#222">
        <div style="background:#1F5C8C;padding:18px 22px;border-radius:8px 8px 0 0"><h2 style="color:#fff;margin:0;font-size:17px">Eloflex — Bon de prêt à signer</h2></div>
        <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;padding:22px">
          <p>Bonjour,</p>
          <p>Vous trouverez ci-dessous votre bon de prêt de fauteuil roulant électrique. Merci de le relire et de le <b>signer en ligne</b> :</p>
          <p style="text-align:center;margin:22px 0"><a href="${lien}" style="background:#1F5C8C;color:#fff;text-decoration:none;padding:11px 22px;border-radius:6px;font-weight:600">Ouvrir et signer le bon de prêt</a></p>
          <p style="font-size:12px;color:#666">Si le bouton ne fonctionne pas, copiez ce lien : <br>${lien}</p>
          ${blocManuel}
        </div>
        <div style="margin-top:24px">${SIGNATURE_EMAIL_HTML}</div>
      </div>`
    });
    const updated = await db.run("UPDATE prets SET statut=CASE WHEN statut='brouillon' THEN 'envoye' ELSE statut END, updated_at=NOW() WHERE id=$1 RETURNING id, statut", [p.id]);
    res.json({ ok: true, to: dest, statut: updated.statut });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Public (sans authentification) : consultation + signature du bon ──
router.get('/pret-public/:token', async (req, res) => {
  try {
    const p = await db.get(
      `SELECT p.*, u.nom AS signataire_eloflex FROM prets p LEFT JOIN users u ON u.id=p.cree_par WHERE p.token_signature=$1`,
      [req.params.token]);
    if (!p) return res.status(404).json({ error: 'Lien invalide ou expiré' });
    // on n'expose pas les champs sensibles internes
    res.json({
      id: p.id, distributeur_nom: p.distributeur_nom, contact: p.contact, email: p.email, tel: p.tel,
      adresse: p.adresse, formule: p.formule, designation: p.designation, num_serie: p.num_serie,
      valeur_ht: p.valeur_ht, articles: p.articles,
      livraison_autre: p.livraison_autre, livraison_nom: p.livraison_nom, livraison_adresse: p.livraison_adresse,
      date_remise: p.date_remise, date_retour_prevue: p.date_retour_prevue,
      prorogation_date: p.prorogation_date, observations: p.observations, statut: p.statut,
      signataire_nom: p.signataire_nom, signed_at: p.signed_at,
      signataire_eloflex: p.signataire_eloflex || null, eloflex_date: p.created_at || null
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/pret-public/:token/signer', async (req, res) => {
  try {
    const p = await db.get('SELECT * FROM prets WHERE token_signature=$1', [req.params.token]);
    if (!p) return res.status(404).json({ error: 'Lien invalide ou expiré' });
    if (p.signed_at) return res.status(409).json({ error: 'Ce bon a déjà été signé.' });
    const d = req.body || {};
    if (!d.signataire_nom || !d.signature_data) return res.status(400).json({ error: 'Nom et signature requis' });
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
    const ua = (req.headers['user-agent'] || '').toString().slice(0, 250);
    await db.run(
      `UPDATE prets SET signataire_nom=$1, signature_data=$2, pdf_data=$3, sign_ip=$4, sign_ua=$5,
        signed_at=NOW(), statut='signe', updated_at=NOW() WHERE id=$6`,
      [String(d.signataire_nom).slice(0,120), d.signature_data, d.pdf_data || null, ip, ua, p.id]);
    // e-mail aux deux parties avec le PDF signé en pièce jointe (si fourni)
    try {
      const attachments = d.pdf_data
        ? [{ filename: `Bon_de_pret_${(p.distributeur_nom||'distributeur').replace(/[^\w-]+/g,'_')}.pdf`,
             content: d.pdf_data.replace(/^data:application\/pdf;base64,/, ''), encoding: 'base64' }]
        : [];
      await envoyerEmailPret({
        to: p.email || 'sav@eloflex.fr',
        cc: p.email ? 'sav@eloflex.fr' : undefined,
        subject: `Bon de prêt Eloflex — signé par ${d.signataire_nom}`,
        html: `<div style="font-family:sans-serif;max-width:560px;color:#222;margin:0 auto">
          <p>Le bon de prêt du fauteuil <b>${p.designation || ''} ${p.num_serie || ''}</b> a été signé en ligne par <b>${String(d.signataire_nom)}</b>.</p>
          ${attachments.length ? '<p>Le document signé est joint à cet e-mail (PDF).</p>' : ''}
          <p style="font-size:12px;color:#888">Eloflex France</p></div>`,
        attachments
      });
    } catch (mailErr) { console.error('[PRET] e-mail signature:', mailErr.message); }
    // Notification interne (centre d'alertes)
    try { await addAlerte('pret_signe', p.id, `✍️ Bon de prêt signé en ligne par ${d.signataire_nom} — ${p.distributeur_nom || ''} (${p.designation || ''} ${p.num_serie || ''}).`); } catch(_){}
    // Si le contrat-cadre du distributeur est aussi signé → ajout auto au Suivi commandes (démo)
    await apresPretSigne(p.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════
// ── CONTRAT-CADRE DE PRÊT (commodat) — signé une fois par distributeur ──
// ══════════════════════════════════════════════════════════════════

// Liste (statut par distributeur), sans les blobs
router.get('/contrats-cadre', requireAuth, async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT cc.id, cc.client_id, cc.distributeur_nom, cc.statut, cc.signataire_nom,
              cc.signed_at, cc.created_at, cc.updated_at,
              (cc.pdf_data IS NOT NULL) AS has_pdf,
              c.nom AS client_nom_actuel, c.email AS client_email_actuel
         FROM contrats_cadre cc LEFT JOIN clients c ON c.id = cc.client_id
        ORDER BY cc.updated_at DESC`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Statut du contrat-cadre pour un distributeur donné
router.get('/contrats-cadre/by-client/:clientId', requireAuth, async (req, res) => {
  try {
    const cc = await db.get(
      `SELECT id, client_id, distributeur_nom, statut, signataire_nom, signed_at,
              (pdf_data IS NOT NULL) AS has_pdf
         FROM contrats_cadre WHERE client_id=$1`, [req.params.clientId]);
    res.json(cc || { statut: 'aucun' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/contrats-cadre/:id', requireAuth, async (req, res) => {
  try {
    const cc = await db.get(
      `SELECT cc.*, c.nom AS client_nom_actuel, c.email AS client_email_actuel,
              c.siret AS client_siret, c.adresse AS client_adresse, c.cp AS client_cp, c.ville AS client_ville
         FROM contrats_cadre cc LEFT JOIN clients c ON c.id = cc.client_id WHERE cc.id=$1`, [req.params.id]);
    if (!cc) return res.status(404).json({ error: 'Contrat-cadre introuvable' });
    res.json(cc);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Crée (ou renvoie) le contrat-cadre d'un distributeur. Idempotent par client_id.
router.post('/contrats-cadre', requireAuth, async (req, res) => {
  try {
    const d = req.body || {};
    if (!d.client_id) return res.status(400).json({ error: 'client_id requis' });
    const existing = await db.get('SELECT * FROM contrats_cadre WHERE client_id=$1', [d.client_id]);
    if (existing) {
      const row = await db.run(
        `UPDATE contrats_cadre SET distributeur_nom=COALESCE($1,distributeur_nom), lieu=$2,
           representant_eloflex=$3, representant_distrib=$4, siret_distrib=$5, siege_distrib=$6, updated_at=NOW()
         WHERE id=$7 RETURNING *`,
        [d.distributeur_nom || null, d.lieu || null, d.representant_eloflex || null,
         d.representant_distrib || null, d.siret_distrib || null, d.siege_distrib || null, existing.id]);
      return res.json(row);
    }
    const token = crypto.randomBytes(20).toString('hex');
    const row = await db.run(
      `INSERT INTO contrats_cadre (client_id, distributeur_nom, lieu, representant_eloflex,
        representant_distrib, siret_distrib, siege_distrib, statut, token_signature, cree_par)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'brouillon',$8,$9) RETURNING *`,
      [d.client_id, d.distributeur_nom || null, d.lieu || null, d.representant_eloflex || null,
       d.representant_distrib || null, d.siret_distrib || null, d.siege_distrib || null,
       token, (req.session.user && req.session.user.id) || null]);
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/contrats-cadre/:id', requireAuth, async (req, res) => {
  try {
    const d = req.body || {};
    const row = await db.run(
      `UPDATE contrats_cadre SET lieu=$1, representant_eloflex=$2, representant_distrib=$3,
         siret_distrib=$4, siege_distrib=$5, updated_at=NOW() WHERE id=$6 RETURNING *`,
      [d.lieu || null, d.representant_eloflex || null, d.representant_distrib || null,
       d.siret_distrib || null, d.siege_distrib || null, req.params.id]);
    if (!row) return res.status(404).json({ error: 'Contrat-cadre introuvable' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/contrats-cadre/:id', requireAuth, async (req, res) => {
  try {
    await db.run('DELETE FROM contrats_cadre WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Marquer signé hors ligne (par e-mail), date choisie
router.post('/contrats-cadre/:id/signe-mail', requireAuth, async (req, res) => {
  try {
    const date = (req.body && req.body.date) ? String(req.body.date).slice(0, 10) : null;
    const row = await db.run(
      `UPDATE contrats_cadre SET statut='signe',
         signed_at = COALESCE($1::date::timestamptz, NOW()),
         signataire_nom = COALESCE(NULLIF(signataire_nom, ''), 'Signé par e-mail'),
         updated_at = NOW()
       WHERE id=$2 RETURNING id, statut, signed_at`,
      [date, req.params.id]);
    if (!row) return res.status(404).json({ error: 'Contrat-cadre introuvable' });
    try { const cc = await db.get('SELECT client_id FROM contrats_cadre WHERE id=$1', [req.params.id]); if (cc) await apresContratSigne(cc.client_id); } catch(_){}
    res.json({ ok: true, contrat: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Envoyer au distributeur le lien de signature en ligne du contrat-cadre
router.post('/contrats-cadre/:id/envoyer', requireAuth, async (req, res) => {
  try {
    const cc = await db.get('SELECT * FROM contrats_cadre WHERE id=$1', [req.params.id]);
    if (!cc) return res.status(404).json({ error: 'Contrat-cadre introuvable' });
    const dest = (req.body && req.body.email) || null;
    if (!dest) return res.status(400).json({ error: 'Aucune adresse e-mail fournie' });
    const base = process.env.APP_URL || (req.protocol + '://' + req.get('host'));
    const lien = `${base}/contrat/${cc.token_signature}`;
    const pdfData = req.body && req.body.pdf_data;
    const attachments = pdfData
      ? [{ filename: `Contrat_cadre_pret_${(cc.distributeur_nom||'distributeur').replace(/[^\w-]+/g,'_')}.pdf`,
           content: String(pdfData).replace(/^data:application\/pdf;base64,/, '') }]
      : [];
    const blocManuel = pdfData
      ? `<div style="border:1px dashed #cbd5e1;border-radius:8px;padding:14px 16px;margin-top:16px;background:#f8fafc;font-size:13px;color:#334">
           <b>Vous préférez signer à la main ?</b><br>
           Vous pouvez télécharger le PDF ci-joint, le signer et le renvoyer scanné à l'adresse :
           <a href="mailto:info@eloflex.fr" style="color:#1F5C8C;font-weight:600">info@eloflex.fr</a>.
         </div>`
      : '';
    await envoyerEmailPret({
      to: dest,
      subject: `Contrat-cadre de prêt Eloflex — à signer en ligne`,
      attachments,
      html: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#222">
        <div style="background:#1F5C8C;padding:18px 22px;border-radius:8px 8px 0 0"><h2 style="color:#fff;margin:0;font-size:17px">Eloflex — Contrat-cadre de prêt à signer</h2></div>
        <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;padding:22px">
          <p>Bonjour,</p>
          <p>Dans le cadre de la mise à disposition de fauteuils Eloflex en prêt/essai, nous vous invitons à prendre connaissance du <b>contrat-cadre de prêt</b> et à le <b>signer en ligne</b>. Ce contrat n'est à signer qu'une seule fois ; chaque prêt fera ensuite l'objet d'un bon de prêt distinct.</p>
          <p style="text-align:center;margin:22px 0"><a href="${lien}" style="background:#1F5C8C;color:#fff;text-decoration:none;padding:11px 22px;border-radius:6px;font-weight:600">Ouvrir et signer le contrat-cadre</a></p>
          <p style="font-size:12px;color:#666">Si le bouton ne fonctionne pas, copiez ce lien : <br>${lien}</p>
          ${blocManuel}
        </div>
        <div style="margin-top:24px">${SIGNATURE_EMAIL_HTML}</div>
      </div>`
    });
    const updated = await db.run("UPDATE contrats_cadre SET statut=CASE WHEN statut='brouillon' THEN 'envoye' ELSE statut END, updated_at=NOW() WHERE id=$1 RETURNING id, statut", [cc.id]);
    res.json({ ok: true, to: dest, statut: updated.statut });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Public (sans authentification) : consultation + signature du contrat-cadre ──
router.get('/contrat-public/:token', async (req, res) => {
  try {
    const cc = await db.get('SELECT * FROM contrats_cadre WHERE token_signature=$1', [req.params.token]);
    if (!cc) return res.status(404).json({ error: 'Lien invalide ou expiré' });
    res.json({
      id: cc.id, distributeur_nom: cc.distributeur_nom, lieu: cc.lieu,
      representant_eloflex: cc.representant_eloflex, representant_distrib: cc.representant_distrib,
      siret_distrib: cc.siret_distrib, siege_distrib: cc.siege_distrib,
      statut: cc.statut, signataire_nom: cc.signataire_nom, signed_at: cc.signed_at,
      eloflex_date: cc.created_at || null
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/contrat-public/:token/signer', async (req, res) => {
  try {
    const cc = await db.get('SELECT * FROM contrats_cadre WHERE token_signature=$1', [req.params.token]);
    if (!cc) return res.status(404).json({ error: 'Lien invalide ou expiré' });
    if (cc.signed_at) return res.status(409).json({ error: 'Ce contrat a déjà été signé.' });
    const d = req.body || {};
    if (!d.signataire_nom || !d.signature_data) return res.status(400).json({ error: 'Nom et signature requis' });
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
    const ua = (req.headers['user-agent'] || '').toString().slice(0, 250);
    await db.run(
      `UPDATE contrats_cadre SET signataire_nom=$1, signature_data=$2, pdf_data=$3, sign_ip=$4, sign_ua=$5,
        signed_at=NOW(), statut='signe', updated_at=NOW() WHERE id=$6`,
      [String(d.signataire_nom).slice(0,120), d.signature_data, d.pdf_data || null, ip, ua, cc.id]);
    try {
      const attachments = d.pdf_data
        ? [{ filename: `Contrat_cadre_pret_${(cc.distributeur_nom||'distributeur').replace(/[^\w-]+/g,'_')}.pdf`,
             content: d.pdf_data.replace(/^data:application\/pdf;base64,/, ''), encoding: 'base64' }]
        : [];
      await envoyerEmailPret({
        to: 'sav@eloflex.fr',
        subject: `Contrat-cadre de prêt Eloflex — signé par ${d.signataire_nom} (${cc.distributeur_nom || ''})`,
        html: `<div style="font-family:sans-serif;max-width:560px;color:#222;margin:0 auto">
          <p>Le contrat-cadre de prêt du distributeur <b>${cc.distributeur_nom || ''}</b> a été signé en ligne par <b>${String(d.signataire_nom)}</b>.</p>
          ${attachments.length ? '<p>Le document signé est joint à cet e-mail (PDF).</p>' : ''}
          <p style="font-size:12px;color:#888">Eloflex France</p></div>`,
        attachments
      });
    } catch (mailErr) { console.error('[CONTRAT] e-mail signature:', mailErr.message); }
    // Notification interne (centre d'alertes)
    try { await addAlerte('contrat_signe', cc.id, `✍️ Contrat-cadre de prêt signé en ligne par ${d.signataire_nom} — ${cc.distributeur_nom || ''}.`); } catch(_){}
    // Prêts déjà signés de ce distributeur → ajout auto au Suivi commandes (démo)
    await apresContratSigne(cc.client_id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════
// ── DEMANDES D'INFORMATIONS transmises aux distributeurs (leads) ──
// ══════════════════════════════════════════════════════════════════
const DI_STATUTS = ['transmise','relance','retour_recu','essai','vente','sans_suite','absence_retour'];
const DI_NON_TRAITEES = ['transmise','relance'];

// Liste avec filtres (client_id, statut, non_traitees, q)
router.get('/demandes-info', requireAuth, async (req, res) => {
  try {
    const conds = [], p = []; let i = 0;
    if (req.query.client_id) { conds.push(`d.client_id = $${++i}`); p.push(req.query.client_id); }
    if (req.query.statut)    { conds.push(`d.statut = $${++i}`); p.push(req.query.statut); }
    if (req.query.non_traitees === '1') conds.push(`d.statut = ANY('{transmise,relance}')`);
    if (req.query.q) { conds.push(`(d.nom ILIKE $${++i} OR d.ville ILIKE $${i} OR d.telephone ILIKE $${i} OR d.annotation ILIKE $${i} OR COALESCE(c.nom,d.distributeur_nom) ILIKE $${i})`); p.push('%'+req.query.q+'%'); }
    const where = conds.length ? 'WHERE '+conds.join(' AND ') : '';
    const rows = await db.all(
      `SELECT d.*, c.nom AS client_nom_actuel, c.email AS client_email_actuel
       FROM demandes_info d LEFT JOIN clients c ON c.id = d.client_id
       ${where} ORDER BY d.date_transmission DESC NULLS LAST, d.id DESC
       LIMIT ${Math.min(parseInt(req.query.limit)||2000, 5000)}`, p);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Compteurs (global ou pour un distributeur)
router.get('/demandes-info/stats', requireAuth, async (req, res) => {
  try {
    const p = []; let where = '';
    if (req.query.client_id) { where = 'WHERE client_id = $1'; p.push(req.query.client_id); }
    const rows = await db.all(`SELECT statut, COUNT(*)::int AS n FROM demandes_info ${where} GROUP BY statut`, p);
    const par = {}; let total = 0, nonTraitees = 0;
    for (const r of rows) { par[r.statut] = r.n; total += r.n; if (DI_NON_TRAITEES.includes(r.statut)) nonTraitees += r.n; }
    // Relances à faire : mail (Transmise, pas de mail, ≥7j) + téléphone (Relancé mail, pas de tél., ≥7j après le mail)
    const rel = await db.get(`SELECT
        COUNT(*) FILTER (WHERE statut='transmise' AND relance_mail_date IS NULL AND date_transmission <= CURRENT_DATE - INTERVAL '7 days')::int AS mail,
        COUNT(*) FILTER (WHERE statut='relance' AND relance_mail_date IS NOT NULL AND relance_tel_date IS NULL AND relance_mail_date <= CURRENT_DATE - INTERVAL '7 days')::int AS tel
      FROM demandes_info ${where}`, p);
    const relMail = (rel && rel.mail) || 0, relTel = (rel && rel.tel) || 0;
    res.json({ total, non_traitees: nonTraitees, par_statut: par, relances_mail: relMail, relances_tel: relTel, relances_a_faire: relMail + relTel });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Récapitulatif agrégé par distributeur (pour le traitement / relance)
router.get('/demandes-info/par-distributeur', requireAuth, async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT COALESCE(c.nom, d.distributeur_nom) AS distributeur,
             MAX(d.client_id) AS client_id,
             MAX(c.email) AS email,
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE d.statut = ANY('{transmise,relance}'))::int AS non_traitees,
             COUNT(*) FILTER (WHERE d.statut = 'vente')::int AS ventes,
             COUNT(*) FILTER (WHERE d.statut = 'essai')::int AS essais,
             COUNT(*) FILTER (WHERE d.statut = 'retour_recu')::int AS retours,
             COUNT(*) FILTER (WHERE d.statut = 'sans_suite')::int AS sans_suite,
             MAX(d.date_transmission) AS derniere_date,
             BOOL_OR(d.relance_envoyee) AS relance_envoyee
      FROM demandes_info d LEFT JOIN clients c ON c.id = d.client_id
      GROUP BY COALESCE(c.nom, d.distributeur_nom)
      ORDER BY non_traitees DESC, total DESC`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/demandes-info', requireAuth, async (req, res) => {
  try {
    const d = req.body || {};
    const statut = DI_STATUTS.includes(d.statut) ? d.statut : 'transmise';
    const row = await db.run(
      `INSERT INTO demandes_info (client_id, distributeur_nom, nom, ville, cp, telephone, email, annotation, statut, date_transmission, date_retour, cree_par, demande_client, relance_mail_date, relance_tel_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [d.client_id||null, d.distributeur_nom||null, d.nom||null, d.ville||null, d.cp||null, fmtTel(d.telephone)||null,
       d.email||null, d.annotation||null, statut, d.date_transmission||new Date().toISOString().slice(0,10),
       d.date_retour||null, (req.session.user && req.session.user.id)||null,
       d.demande_client||null, d.relance_mail_date||null, d.relance_tel_date||null]);
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/demandes-info/:id', requireAuth, async (req, res) => {
  try {
    const d = req.body || {};
    const statut = DI_STATUTS.includes(d.statut) ? d.statut : 'transmise';
    const row = await db.run(
      `UPDATE demandes_info SET nom=$1, ville=$2, cp=$3, telephone=$4, email=$5, annotation=$6,
        statut=$7, date_transmission=$8, date_retour=COALESCE($9::date, date_retour), demande_client=$10,
        relance_mail_date=$11, relance_tel_date=$12, updated_at=NOW() WHERE id=$13 RETURNING *`,
      [d.nom||null, d.ville||null, d.cp||null, fmtTel(d.telephone)||null, d.email||null, d.annotation||null,
       statut, d.date_transmission||null, d.date_retour||null, d.demande_client||null,
       d.relance_mail_date||null, d.relance_tel_date||null, req.params.id]);
    if (!row) return res.status(404).json({ error: 'Demande introuvable' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/demandes-info/:id/statut', requireAuth, async (req, res) => {
  try {
    const statut = String((req.body && req.body.statut)||'').trim();
    if (!DI_STATUTS.includes(statut)) return res.status(400).json({ error: 'Statut invalide' });
    const dateStatut = (req.body && req.body.date_statut) ? String(req.body.date_statut).slice(0,10) : null;
    const dateRetour = (req.body && req.body.date_retour) ? String(req.body.date_retour).slice(0,10) : null;
    const setRetour = (!DI_NON_TRAITEES.includes(statut)); // statut "terminé" (hors attente) → date de retour
    const u = (req.session && req.session.user) || {};
    const par = u.nom || u.prenom || u.email || u.login || null;
    // On lit l'historique existant pour y ajouter l'entrée
    const cur = await db.get('SELECT historique FROM demandes_info WHERE id=$1', [req.params.id]);
    if (!cur) return res.status(404).json({ error: 'Demande introuvable' });
    let hist = [];
    try { hist = Array.isArray(cur.historique) ? cur.historique : JSON.parse(cur.historique || '[]'); } catch(_) { hist = []; }
    const entree = { statut, date: dateStatut || new Date().toISOString().slice(0,10), par };
    hist.push(entree);
    const appelEmis = (statut === 'retour_recu'); // "Appel émis" = appel passé au distributeur → date de relance téléphonique
    const row = await db.run(
      `UPDATE demandes_info SET statut=$1,
         statut_date = $2::date,
         historique = $3::jsonb,
         date_retour = CASE WHEN $4::text IS NOT NULL THEN $4::date
                            WHEN $5 THEN COALESCE($2::date, CURRENT_DATE)
                            ELSE date_retour END,
         relance_tel_date = CASE WHEN $6 THEN COALESCE($2::date, CURRENT_DATE) ELSE relance_tel_date END,
         updated_at=NOW() WHERE id=$7 RETURNING *`,
      [statut, entree.date, JSON.stringify(hist), dateRetour, setRetour, appelEmis, req.params.id]);
    res.json({ ok: true, demande: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/demandes-info/:id', requireAuth, async (req, res) => {
  try { await db.run('DELETE FROM demandes_info WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Import de l'historique Excel (fichier "contacts distributeurs")
router.post('/demandes-info/import-excel', requireAuth, uploadExcel.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier' });
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const ws = wb.Sheets['CONTACTS'] || wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false, dateNF: 'yyyy-mm-dd' });
    const norm = s => String(s == null ? '' : s).toLowerCase();
    // Détection ligne d'en-tête + colonnes
    let hdr = -1, col = {};
    for (let r = 0; r < Math.min(rows.length, 10); r++) {
      const line = (rows[r] || []).map(norm);
      if (line.some(c => c.includes('distributeur')) && line.some(c => c.includes('contact') || c.includes('patient'))) {
        hdr = r;
        line.forEach((c, idx) => {
          if (c.includes('coordonn')) col.coord = idx;
          else if (c.includes('distributeur') && col.distrib === undefined) col.distrib = idx;
          else if (c.includes('contact') || c.includes('patient')) col.contact = idx;
          else if (c.includes('date') && col.date === undefined) col.date = idx;
          else if (c.includes('retour') || c.includes('action')) col.annot = idx;
          else if (c.includes('essai')) col.essai = idx;
          else if (c.includes('vente')) col.vente = idx;
        });
        break;
      }
    }
    if (hdr < 0) return res.status(400).json({ error: 'En-têtes non reconnus (attendu : Distributeurs / Patients contacts / Date / Retours actions).' });
    if (col.distrib === undefined) col.distrib = 0;
    if (col.contact === undefined) col.contact = 2;

    // Index des fiches clients par nom normalisé
    const clients = await db.all('SELECT id, nom FROM clients');
    const nk = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
    const cidx = {};
    for (const c of clients) cidx[nk(c.nom)] = c.id;

    const reEmail = /[\w.+-]+@[\w-]+\.[\w.-]+/;
    const rePhone = /(?:\+33|0)\s*[1-9](?:[\s.\-]*\d{2}){4}/;
    const statutDe = (txt) => {
      const t = norm(txt);
      if (!t) return 'transmise';
      if (/vendu|command|achat|achet|factur/.test(t)) return 'vente';
      if (/essai/.test(t)) return 'essai';
      if (/plus.*int[ée]ress|pas.*int[ée]ress|arr[êe]t|sans suite|abandon|refus|d[ée]c[ée]d|ne (souhaite|veut)|non renouvel|trop cher/.test(t)) return 'sans_suite';
      if (/relanc|pas de retour|message|r[ée]pondeur|[àa] appeler|pas r[ée]pondu|sans r[ée]ponse|attente|renvoi|renvoy/.test(t)) return 'relance';
      if (/\bok\b|re[çc]u|rendez|\brdv\b|contact pris|pris contact|s.en occupe|programm/.test(t)) return 'retour_recu';
      return 'transmise';
    };
    const parseContact = (contact) => {
      const email = (contact.match(reEmail) || [null])[0];
      const telM = (contact.match(rePhone) || [null])[0];
      const tel = telM ? telM.replace(/[\s.\-]/g, '') : null;
      const cpM = contact.match(/\b(\d{5})\b/);
      const cp = cpM ? cpM[1] : null;
      const segs = contact.split(/\s[-–]\s/).map(s => s.trim()).filter(Boolean);
      const nom = segs[0] || contact;
      let ville = null;
      for (let k = 1; k < segs.length; k++) {
        let s = segs[k];
        if (reEmail.test(s) || rePhone.test(s)) continue;
        s = s.replace(/\b\d{5}\b/g, ' ').replace(/[\d.\-/]{5,}/g, ' ').replace(/\s+/g, ' ').trim();
        if (s && s.length >= 2 && !/^\d+$/.test(s)) { ville = s; break; }
      }
      return { nom, email, tel, cp, ville };
    };
    const toIso = (v) => {
      if (v instanceof Date) return isNaN(v) ? null : v.toISOString().slice(0, 10);
      if (!v) return null;
      const s = String(v).trim();
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
      const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
      if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`; }
      const d = new Date(s); return isNaN(d) ? null : d.toISOString().slice(0, 10);
    };

    const uid = (req.session.user && req.session.user.id) || null;
    const data = [];
    let skipped = 0;
    for (let r = hdr + 1; r < rows.length; r++) {
      const line = rows[r] || [];
      const distrib = (line[col.distrib] || '').toString().trim();
      const contact = (line[col.contact] || '').toString().trim();
      if (!distrib || !contact) { skipped++; continue; }        // lignes de sous-total / vides
      const pc = parseContact(contact);
      const annot0 = col.annot !== undefined ? String(line[col.annot] || '').trim() : '';
      const essai = col.essai !== undefined ? String(line[col.essai] || '').trim() : '';
      const vente = col.vente !== undefined ? String(line[col.vente] || '').trim() : '';
      let statut = statutDe(annot0);
      if (vente) statut = 'vente'; else if (essai && statut === 'transmise') statut = 'essai';
      let annotation = annot0;
      const extra = [];
      if (essai && statut !== 'essai') extra.push('Essai : ' + essai);
      if (vente && statut !== 'vente') extra.push('Vente : ' + vente);
      if (extra.length) annotation = (annotation ? annotation + ' · ' : '') + extra.join(' · ');
      const date = toIso(col.date !== undefined ? line[col.date] : null);
      const clientId = cidx[nk(distrib)] || null;
      data.push([clientId, distrib, pc.nom || contact, pc.ville, pc.cp, pc.tel, pc.email, annotation || null, statut, date, uid]);
    }

    // Option : remplacer l'historique existant avant import
    if (req.query.remplacer === '1' || (req.body && req.body.remplacer)) {
      await db.run('DELETE FROM demandes_info');
    }

    // Insertion par lots (rapide) avec repli ligne-par-ligne si un lot échoue (isolation des erreurs)
    const COLS = '(client_id, distributeur_nom, nom, ville, cp, telephone, email, annotation, statut, date_transmission, cree_par)';
    let inserted = 0, errors = 0, lies = 0, errSample = null;
    const CHUNK = 200;
    for (let i = 0; i < data.length; i += CHUNK) {
      const chunk = data.slice(i, i + CHUNK);
      const ph = [], vals = [];
      chunk.forEach((row, ri) => { const b = ri * 11; ph.push('(' + Array.from({ length: 11 }, (_, k) => '$' + (b + k + 1)).join(',') + ')'); vals.push(...row); });
      try {
        await db.run(`INSERT INTO demandes_info ${COLS} VALUES ${ph.join(',')}`, vals);
        inserted += chunk.length;
      } catch (e) {
        for (const row of chunk) {
          try { await db.run(`INSERT INTO demandes_info ${COLS} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, row); inserted++; }
          catch (e2) { errors++; if (!errSample) errSample = e2.message; }
        }
      }
    }
    lies = data.filter(row => row[0]).length;
    res.json({ ok: true, inserted, skipped, errors, lies_distributeur: lies, erreur_exemple: errSample });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Envoyer un e-mail de relance au distributeur (liste des demandes non traitées)
router.post('/demandes-info/relance', requireAuth, async (req, res) => {
  try {
    const clientId = req.body && req.body.client_id;
    const dest = (req.body && req.body.email) || null;
    if (!clientId) return res.status(400).json({ error: 'client_id requis' });
    if (!dest) return res.status(400).json({ error: 'Aucune adresse e-mail' });
    const cli = await db.get('SELECT nom FROM clients WHERE id=$1', [clientId]);
    const dmd = await db.all(
      `SELECT * FROM demandes_info WHERE client_id=$1 AND statut = ANY('{transmise,relance}') ORDER BY date_transmission ASC`, [clientId]);
    if (!dmd.length) return res.status(400).json({ error: 'Aucune demande en attente pour ce distributeur' });
    const lignes = dmd.map(d => `<tr>
        <td style="border:1px solid #e5e7eb;padding:6px 9px">${d.date_transmission || ''}</td>
        <td style="border:1px solid #e5e7eb;padding:6px 9px">${(d.nom||'')}${d.ville?(' — '+d.ville):''}${d.telephone?(' — '+fmtTel(d.telephone)):''}</td>
        <td style="border:1px solid #e5e7eb;padding:6px 9px">${d.annotation || ''}</td></tr>`).join('');
    await envoyerEmailPret({
      to: dest,
      subject: `Eloflex — Suivi des demandes patients transmises`,
      html: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;color:#222">
        <div style="background:#1F5C8C;padding:16px 20px;border-radius:8px 8px 0 0"><h2 style="color:#fff;margin:0;font-size:16px">Suivi des demandes patients</h2></div>
        <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;padding:20px">
          <p>Bonjour,</p>
          <p>Nous vous avons transmis les demandes patients ci-dessous. Pourriez-vous nous indiquer où en sont ces contacts (rendez-vous, essai, vente, sans suite) ?</p>
          <table style="width:100%;border-collapse:collapse;font-size:13px;margin:10px 0">
            <tr style="background:#F2F5F8"><th style="border:1px solid #e5e7eb;padding:6px 9px;text-align:left">Date</th><th style="border:1px solid #e5e7eb;padding:6px 9px;text-align:left">Contact</th><th style="border:1px solid #e5e7eb;padding:6px 9px;text-align:left">Note</th></tr>
            ${lignes}
          </table>
          <p>Merci d'avance pour votre retour.</p>
        </div>
        <div style="margin-top:22px">${SIGNATURE_EMAIL_HTML}</div>
      </div>`
    });
    await db.run(`UPDATE demandes_info SET relance_envoyee=TRUE, statut=CASE WHEN statut='transmise' THEN 'relance' ELSE statut END, updated_at=NOW()
      WHERE client_id=$1 AND statut = ANY('{transmise,relance}')`, [clientId]);
    res.json({ ok: true, to: dest, count: dmd.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Relance pour UN contact précis (bouton sur chaque ligne)
router.post('/demandes-info/:id/relance', requireAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const d = await db.get(
      `SELECT di.*, c.nom AS client_nom, c.email AS client_email FROM demandes_info di LEFT JOIN clients c ON c.id = di.client_id WHERE di.id = $1`, [id]);
    if (!d) return res.status(404).json({ error: 'Demande introuvable' });
    // Destinataire = le distributeur (fiche client). On peut forcer une adresse via le corps.
    const dest = ((req.body && req.body.email) || d.client_email || '').trim();
    if (!dest) return res.status(400).json({ error: "Aucune adresse e-mail pour ce distributeur (fiche client). Renseignez-la ou saisissez-en une." });
    // Date d'enregistrement du contact au format FR
    const frDate = (v) => {
      if (!v) return '';
      let s;
      if (v instanceof Date) { if (isNaN(v)) return ''; s = v.toISOString().slice(0,10); }
      else s = String(v).slice(0,10);
      const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
    };
    const villeCp = [d.ville, d.cp].filter(Boolean).join(' ');
    const ligne = (v) => v ? `<div style="font-style:italic;font-weight:bold">${String(v)}</div>` : '';
    await envoyerEmailPret({
      to: dest,
      bcc: 'info@eloflex.fr',
      subject: `Eloflex — Suivi du contact ${d.nom || ''}`,
      html: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;color:#222;font-size:14px;line-height:1.5">
        <p>Bonjour</p>
        <p>Nous vous avons transmis les coordonnées d'un contact potentiel le ${frDate(d.date_transmission)} dont voici les coordonnées :</p>
        <div style="margin:10px 0 14px;padding-left:2px">
          ${ligne(d.nom)}
          ${ligne(fmtTel(d.telephone))}
          ${ligne(d.email)}
          ${ligne(villeCp)}
          ${ligne(d.demande_client)}
        </div>
        <p>L'avez-vous contacté suite à cette demande de notre part ?</p>
        <p>A défaut de réponse, nous vous contacterons sous peu par téléphone afin d'avoir un suivi</p>
        <p>Nous restons bien entendu à votre disposition si vous avez besoin d'éléments complémentaires.</p>
        <p>Bien cordialement</p>
        <div style="margin-top:22px">${SIGNATURE_EMAIL_HTML}</div>
      </div>`
    });
    const u = (req.session && req.session.user) || {};
    const par = u.nom || u.prenom || u.email || u.login || null;
    let hist = []; try { hist = Array.isArray(d.historique) ? d.historique : JSON.parse(d.historique || '[]'); } catch(_) { hist = []; }
    hist.push({ statut: 'relance', date: new Date().toISOString().slice(0,10), par });
    await db.run(`UPDATE demandes_info SET relance_envoyee=TRUE, relance_mail_date=CURRENT_DATE,
      statut='relance', statut_date=CURRENT_DATE, historique=$2::jsonb, updated_at=NOW() WHERE id=$1`, [id, JSON.stringify(hist)]);
    res.json({ ok: true, to: dest });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Relance TÉLÉPHONIQUE : enregistre la date (bouton téléphone sur la ligne)
router.post('/demandes-info/:id/relance-tel', requireAuth, async (req, res) => {
  try {
    const date = (req.body && req.body.date) ? String(req.body.date).slice(0,10) : new Date().toISOString().slice(0,10);
    const row = await db.run(`UPDATE demandes_info SET relance_tel_date=$1::date, updated_at=NOW() WHERE id=$2 RETURNING *`, [date, req.params.id]);
    if (!row) return res.status(404).json({ error: 'Demande introuvable' });
    res.json({ ok: true, demande: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Réaffecter un lot de demandes à un autre distributeur (déplacer / fusionner un groupe)
router.post('/demandes-info/reaffecter', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const nouveau = (b.nouveau_nom || '').trim();
    if (!nouveau) return res.status(400).json({ error: 'Nouveau nom de distributeur requis' });
    // Fiche client cible : soit celle explicitement choisie (client_id), soit rapprochée par nom exact
    let clientId = null;
    const cidRaw = b.client_id != null ? parseInt(b.client_id) : NaN;
    if (!isNaN(cidRaw)) {
      const c = await db.get('SELECT id, nom FROM clients WHERE id=$1', [cidRaw]);
      if (c) clientId = c.id;
    }
    if (!clientId) {
      const match = await db.get('SELECT id FROM clients WHERE LOWER(nom) = LOWER($1) LIMIT 1', [nouveau]);
      clientId = match ? match.id : null;
    }
    let ids = Array.isArray(b.ids) ? b.ids.map(x => parseInt(x)).filter(x => !isNaN(x)) : [];
    let moved = [];
    if (ids.length) {
      const ph = ids.map((_, i) => '$' + (i + 3)).join(',');
      moved = await db.all(
        `UPDATE demandes_info SET distributeur_nom=$1, client_id=$2, updated_at=NOW() WHERE id IN (${ph}) RETURNING id`,
        [nouveau, clientId, ...ids]);
    } else if (b.ancien_nom != null) {
      const anc = String(b.ancien_nom).trim();
      moved = await db.all(
        `UPDATE demandes_info SET distributeur_nom=$1, client_id=$2, updated_at=NOW()
         WHERE client_id IS NULL AND COALESCE(distributeur_nom,'') = $3 RETURNING id`, [nouveau, clientId, anc]);
    } else {
      return res.status(400).json({ error: 'ids ou ancien_nom requis' });
    }
    res.json({ ok: true, deplaces: moved.length, lie_client: clientId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Liste des noms de distributeurs déjà référencés dans les demandes (pour autocomplétion)
router.get('/demandes-info/distributeurs', requireAuth, async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT DISTINCT COALESCE(c.nom, d.distributeur_nom) AS nom
       FROM demandes_info d LEFT JOIN clients c ON c.id = d.client_id
       WHERE COALESCE(c.nom, d.distributeur_nom) IS NOT NULL AND TRIM(COALESCE(c.nom, d.distributeur_nom)) <> ''
       ORDER BY nom`);
    res.json(rows.map(r => r.nom));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.executerTachesQuotidiennes = executerTachesQuotidiennes;
module.exports.envoyerSauvegardeHebdo = envoyerSauvegardeHebdo;
