// server/index.js
require('dotenv').config();
const express   = require('express');
const helmet    = require('helmet');
const cors      = require('cors');
const morgan    = require('morgan');
const path      = require('path');
const rateLimit = require('express-rate-limit');
const session   = require('express-session');

const app  = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1); // Render est derrière un reverse proxy
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 500, standardHeaders: true }));
app.use(express.json({ limit: '50mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ── Sessions PostgreSQL persistantes ────────────────────────────────
// La connexion pool est disponible après init-db, on initialise en lazy
let sessionMiddleware = null;
function getSessionMiddleware() {
  if (sessionMiddleware) return sessionMiddleware;
  try {
    const PgSession = require('connect-pg-simple')(session);
    const { pool } = require('./db');
    sessionMiddleware = session({
      store: new PgSession({ pool, tableName: 'user_sessions', pruneSessionInterval: 3600 }),
      secret: process.env.SESSION_SECRET || 'sav-eloflex-dev-secret-CHANGEZ-EN-PROD',
      name: 'sav.sid',
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production', // HTTPS only en prod (Render)
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 jours
        sameSite: 'lax'
      }
    });
  } catch(e) {
    console.warn('⚠️  Sessions :', e.message);
    sessionMiddleware = (req, res, next) => next(); // Fallback sans session
  }
  return sessionMiddleware;
}
app.use((req, res, next) => getSessionMiddleware()(req, res, next));

// ── Fichiers statiques (CSS, JS, images — accessibles sans auth) ────
app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));

try {
  const { UPLOAD_DIR, THUMB_DIR } = require('./uploads');
  app.use('/uploads',        express.static(path.resolve(UPLOAD_DIR)));
  app.use('/uploads/thumbs', express.static(path.resolve(THUMB_DIR)));
} catch(e) {
  console.warn('⚠️  uploads :', e.message);
}

// ── Page de login (sans auth) ────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session?.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});

// ── Page de setup (premier lancement — sans auth, désactivée dès qu'un user existe) ──
app.get('/setup', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'setup.html'));
});

// ── Espace distributeurs : page de connexion par e-mail + lien magique ──
require('./espace-distributeurs').monterPages(app, require('./db'));

// ── Page publique de signature d'un bon de prêt (sans auth) ──────────
app.get('/pret/:token', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'pret.html'));
});

// ── Page publique de signature du contrat-cadre de prêt (sans auth) ──
app.get('/contrat/:token', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'contrat.html'));
});

// ── Page publique de signature d'un devis / bon de commande (sans auth) ──
app.get('/devis-sign/:token', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'devis-sign.html'));
});

// ── Mini-carte publique des e-mails (distributeur le plus proche) ─────
app.get('/carte-mini/:id/:sig.png', (req, res) => require('../scripts/carte-mini').routePublique(req, res));

// ── Routes API ───────────────────────────────────────────────────────
app.use('/api', require('./routes'));

// ── App principale (protégée) ────────────────────────────────────────
// Les scripts et feuilles de style reçoivent un numéro de version (date de démarrage du serveur) :
// après chaque déploiement, le navigateur recharge forcément les nouveaux fichiers (plus de vieux app.js en cache).
const VERSION_FICHIERS = Date.now().toString(36);
let _indexHtml = null;
app.get('*', (req, res) => {
  if (!req.session?.user) {
    // Lien « Valider l'accès » (mail sav@) : on retrouve la demande après la connexion
    const dm = /^\d+$/.test(String(req.query.espace_demande || '')) ? '?espace_demande=' + req.query.espace_demande : '';
    return res.redirect('/login' + dm);
  }
  try {
    if (!_indexHtml) {
      _indexHtml = require('fs').readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8')
        .replace(/((?:src|href)="\/(?:js|css)\/[^"?]+\.(?:js|css))"/g, `$1?v=${VERSION_FICHIERS}"`);
    }
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(_indexHtml);
  } catch (e) {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  }
});

app.use((err, req, res, next) => {
  console.error('❌ Erreur :', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Erreur serveur' });
});

async function start() {
  // Vérification DATABASE_URL
  if (!process.env.DATABASE_URL) {
    console.error('❌ FATAL : DATABASE_URL non définie !');
    process.exit(1);
  }
  console.log('✅ DATABASE_URL définie');

  // Le port est ouvert AVANT les migrations : sur Render, l'ancienne instance n'est arrêtée qu'une fois
  // le port de la nouvelle ouvert. Si elle tenait un verrou, attendre la fin des migrations pour ouvrir
  // le port bloquait tout (échec « No open ports detected »).
  await new Promise(ok => app.listen(PORT, '0.0.0.0', () => { console.log(`🚀 SAV Éloflex v2 démarré sur le port ${PORT}`); ok(); }));

  // Init base de données
  try {
    const { initDB } = require('../scripts/init-db');
    await initDB();
  } catch (e) {
    console.error('❌ Erreur init-db :', e.message);
    console.error(e.stack);
    // On continue — les tables existent peut-être déjà
  }
  // Éclatés livrés avec l'application (scripts/eclates/*.json) : importés s'ils ne sont pas encore en base
  try { await require('./eclates-import').importerEclatesLivres(require('./db').pool); }
  catch (e) { console.error('❌ Import éclatés livrés :', e.message); }

  // Récupérer APP_URL depuis la DB si pas dans les variables d'env
  if (!process.env.APP_URL) {
    try {
      const { get } = require('./db');
      const r = await get("SELECT valeur FROM parametres WHERE cle='app_url'");
      if (r && r.valeur) { process.env.APP_URL = r.valeur; console.log('🔗 APP_URL :', r.valeur); }
    } catch(e) {}
  }

  // Tâches cron
  try {
    const { startCron } = require('./cron');
    startCron();
  } catch(e) {
    console.warn('⚠️  Cron :', e.message);
  }

  console.log('✅ Initialisation terminée');
}

start().catch(e => {
  console.error('❌ Erreur fatale :', e.message);
  console.error(e.stack);
  process.exit(1);
});
