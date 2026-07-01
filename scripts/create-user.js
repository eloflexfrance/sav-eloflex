// scripts/create-user.js — Gestion des utilisateurs SAV Éloflex
// Usage :
//   Créer    : node scripts/create-user.js create "Prénom Nom" email@exemple.fr motdepasse role
//   Lister   : node scripts/create-user.js list
//   Modifier : node scripts/create-user.js reset-password email@exemple.fr nouveaumotdepasse
//   Désactiver : node scripts/create-user.js disable email@exemple.fr
//   Activer    : node scripts/create-user.js enable  email@exemple.fr
//
//   Rôles disponibles : admin | operateur | consultation
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('../server/db');

const VALID_ROLES = ['admin', 'operateur', 'consultation'];

async function main() {
  const [,, cmd, ...args] = process.argv;

  if (!cmd) {
    console.log(`
Usage :
  node scripts/create-user.js create "Nom"  email  motdepasse  role
  node scripts/create-user.js list
  node scripts/create-user.js reset-password  email  nouveaumotdepasse
  node scripts/create-user.js disable  email
  node scripts/create-user.js enable   email

Rôles : admin | operateur | consultation
    `);
    process.exit(0);
  }

  const db = await pool.connect();
  try {
    switch (cmd) {
      case 'create': {
        const [nom, email, motdepasse, role] = args;
        if (!nom || !email || !motdepasse || !role) {
          console.error('❌ Usage : create "Nom" email motdepasse role'); process.exit(1);
        }
        if (!VALID_ROLES.includes(role)) {
          console.error(`❌ Rôle invalide. Valeurs possibles : ${VALID_ROLES.join(', ')}`); process.exit(1);
        }
        if (motdepasse.length < 8) {
          console.error('❌ Le mot de passe doit contenir au moins 8 caractères.'); process.exit(1);
        }
        const hash = await bcrypt.hash(motdepasse, 12);
        const r = await db.query(
          'INSERT INTO users (nom, email, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id, nom, email, role',
          [nom.trim(), email.toLowerCase().trim(), hash, role]
        );
        console.log(`✅ Utilisateur créé :`);
        console.table(r.rows);
        break;
      }

      case 'list': {
        const r = await db.query('SELECT id, nom, email, role, actif, last_login FROM users ORDER BY id');
        if (!r.rows.length) { console.log('Aucun utilisateur.'); break; }
        console.log('\nUtilisateurs SAV Éloflex :');
        console.table(r.rows.map(u => ({
          id: u.id, nom: u.nom, email: u.email, role: u.role,
          actif: u.actif ? '✅' : '🚫',
          dernière_connexion: u.last_login ? new Date(u.last_login).toLocaleString('fr-FR') : '—'
        })));
        break;
      }

      case 'reset-password': {
        const [email, nouveauMdp] = args;
        if (!email || !nouveauMdp) { console.error('❌ Usage : reset-password email nouveaumotdepasse'); process.exit(1); }
        if (nouveauMdp.length < 8) { console.error('❌ Le mot de passe doit contenir au moins 8 caractères.'); process.exit(1); }
        const hash = await bcrypt.hash(nouveauMdp, 12);
        const r = await db.query('UPDATE users SET password_hash=$1 WHERE email=$2 RETURNING nom, email', [hash, email.toLowerCase().trim()]);
        if (!r.rows.length) { console.error('❌ Utilisateur introuvable.'); process.exit(1); }
        console.log(`✅ Mot de passe mis à jour pour ${r.rows[0].nom} (${r.rows[0].email})`);
        break;
      }

      case 'disable': {
        const [email] = args;
        if (!email) { console.error('❌ Usage : disable email'); process.exit(1); }
        const r = await db.query("UPDATE users SET actif=FALSE WHERE email=$1 RETURNING nom, email", [email.toLowerCase().trim()]);
        if (!r.rows.length) { console.error('❌ Utilisateur introuvable.'); process.exit(1); }
        console.log(`✅ Compte désactivé : ${r.rows[0].nom} (${r.rows[0].email})`);
        break;
      }

      case 'enable': {
        const [email] = args;
        if (!email) { console.error('❌ Usage : enable email'); process.exit(1); }
        const r = await db.query("UPDATE users SET actif=TRUE WHERE email=$1 RETURNING nom, email", [email.toLowerCase().trim()]);
        if (!r.rows.length) { console.error('❌ Utilisateur introuvable.'); process.exit(1); }
        console.log(`✅ Compte activé : ${r.rows[0].nom} (${r.rows[0].email})`);
        break;
      }

      default:
        console.error(`❌ Commande inconnue : ${cmd}`);
        process.exit(1);
    }
  } finally {
    db.release();
    await pool.end();
  }
}

main().catch(e => { console.error('❌ Erreur :', e.message); process.exit(1); });
