// server/index.js
require('dotenv').config();
const express   = require('express');
const helmet    = require('helmet');
const cors      = require('cors');
const morgan    = require('morgan');
const path      = require('path');
const rateLimit = require('express-rate-limit');

const routes        = require('./routes');
const { startCron } = require('./cron');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 500, standardHeaders: true }));
app.use(express.json({ limit: '2mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

app.use(express.static(path.join(__dirname, '..', 'public')));
const { UPLOAD_DIR, THUMB_DIR } = require('./uploads');
const expressStatic = require('express').static;
app.use('/uploads',        expressStatic(path.resolve(UPLOAD_DIR)));
app.use('/uploads/thumbs', expressStatic(path.resolve(THUMB_DIR)));

app.use('/api', routes);

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({ error: err.message || 'Erreur serveur' });
});

// Initialisation de la base PUIS démarrage
async function start() {
  try {
    const { initDB } = require('../scripts/init-db');
    await initDB();
    console.log('✅ Base de données prête');
  } catch (e) {
    console.error('⚠️  init-db :', e.message);
    // On continue même si l'init échoue (tables déjà existantes)
  }

  app.listen(PORT, () => {
    console.log(`\n🚀 SAV Éloflex v2 démarré sur http://localhost:${PORT}`);
    console.log(`   Environnement : ${process.env.NODE_ENV || 'development'}\n`);
    startCron();
  });
}

start();
module.exports = app;
