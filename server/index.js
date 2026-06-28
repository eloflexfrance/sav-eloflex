// server/index.js
require('dotenv').config();
const express   = require('express');
const helmet    = require('helmet');
const cors      = require('cors');
const morgan    = require('morgan');
const path      = require('path');
const rateLimit = require('express-rate-limit');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 500, standardHeaders: true }));
app.use(express.json({ limit: '2mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Fichiers statiques
app.use(express.static(path.join(__dirname, '..', 'public')));

// Uploads (dossiers créés par uploads.js au require)
try {
  const { UPLOAD_DIR, THUMB_DIR } = require('./uploads');
  app.use('/uploads',        express.static(path.resolve(UPLOAD_DIR)));
  app.use('/uploads/thumbs', express.static(path.resolve(THUMB_DIR)));
} catch(e) {
  console.warn('⚠️  uploads non disponibles :', e.message);
}

// Routes API
app.use('/api', require('./routes'));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Gestionnaire d'erreurs global
app.use((err, req, res, next) => {
  console.error('❌ Erreur serveur :', err.stack);
  res.status(err.status || 500).json({ error: err.message || 'Erreur serveur' });
});

async function start() {
  // Vérification DATABASE_URL
  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL non définie ! Ajoutez-la dans les variables d\'environnement Render.');
    process.exit(1);
  }

  // Initialisation base de données
  try {
    console.log('⏳ Initialisation de la base de données...');
    const { initDB } = require('../scripts/init-db');
    await initDB();
    console.log('✅ Base de données prête');
  } catch (e) {
    console.error('❌ Erreur init-db :', e.message);
    console.error(e.stack);
    // On continue — les tables existent peut-être déjà
  }

  // Tâches automatiques
  try {
    const { startCron } = require('./cron');
    startCron();
  } catch(e) {
    console.warn('⚠️  Cron non démarré :', e.message);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 SAV Éloflex v2 démarré sur le port ${PORT}`);
    console.log(`   NODE_ENV : ${process.env.NODE_ENV || 'development'}`);
    console.log(`   DATABASE_URL : ${process.env.DATABASE_URL ? '✓ définie' : '✗ manquante'}\n`);
  });
}

start().catch(e => {
  console.error('❌ Erreur fatale au démarrage :', e.message);
  console.error(e.stack);
  process.exit(1);
});

module.exports = app;
