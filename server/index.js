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

app.use(express.static(path.join(__dirname, '..', 'public')));

try {
  const { UPLOAD_DIR, THUMB_DIR } = require('./uploads');
  app.use('/uploads',        express.static(path.resolve(UPLOAD_DIR)));
  app.use('/uploads/thumbs', express.static(path.resolve(THUMB_DIR)));
} catch(e) {
  console.warn('⚠️  uploads :', e.message);
}

app.use('/api', require('./routes'));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
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

  // Init base de données
  try {
    const { initDB } = require('../scripts/init-db');
    await initDB();
  } catch (e) {
    console.error('❌ Erreur init-db :', e.message);
    console.error(e.stack);
    // On continue — les tables existent peut-être déjà
  }

  // Tâches cron
  try {
    const { startCron } = require('./cron');
    startCron();
  } catch(e) {
    console.warn('⚠️  Cron :', e.message);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 SAV Éloflex v2 démarré sur le port ${PORT}`);
  });
}

start().catch(e => {
  console.error('❌ Erreur fatale :', e.message);
  console.error(e.stack);
  process.exit(1);
});
