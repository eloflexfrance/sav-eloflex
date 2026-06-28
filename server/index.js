// server/index.js
require('dotenv').config();
const express = require('express');
const helmet  = require('helmet');
const cors    = require('cors');
const morgan  = require('morgan');
const path    = require('path');
const rateLimit = require('express-rate-limit');

const db      = require('./db');
const routes  = require('./routes');
const { startCron } = require('./cron');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Sécurité ──────────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 500, standardHeaders: true }));

// ── Parsing & logs ────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ── Fichiers statiques (frontend) ─────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));
// Photos uploadées accessibles via /uploads/...
const { UPLOAD_DIR, THUMB_DIR } = require('./uploads');
app.use('/uploads', express.static(path.resolve(UPLOAD_DIR)));
app.use('/uploads/thumbs', express.static(path.resolve(THUMB_DIR)));

// ── API REST ──────────────────────────────────────────────────────────────────
app.use('/api', routes);

// ── SPA fallback ─────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ── Gestion d'erreurs ─────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({ error: err.message || 'Erreur serveur' });
});

// ── Démarrage ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 SAV Éloflex v2 démarré sur http://localhost:${PORT}`);
  console.log(`   Environnement : ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Base de données : ${process.env.DB_PATH || './data/sav_eloflex.db'}\n`);
  startCron();
});

module.exports = app;
