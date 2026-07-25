// Module "Doublons VosFactures" — détection, fusion et complétion d'adresse
// ---------------------------------------------------------------------------
// À MONTER dans server/routes.js (ou index.js), près des autres montages de routeur :
//
//   const doublonsVfRouter = require('./routes-doublons-vf');
//   app.use('/api/doublons-vf', doublonsVfRouter);
//
// PRÉREQUIS (déjà présents pour le module Devis VosFactures) :
//   - process.env.VOSFACTURES_API_TOKEN
//   - process.env.VOSFACTURES_ACCOUNT
//
// À ADAPTER SELON TON CODE EXISTANT (marqué ADAPTER ci-dessous) :
//   - le chemin d'import du pool PostgreSQL (ligne `const pool = require('../db')`)
//   - si tes routes utilisent un middleware d'auth/rôle (ex: requireRole('admin')),
//     ajoute-le sur les routes POST/PUT ci-dessous
//   - les noms de table/colonnes de réattribution locale dans /fusionner
//     (la route fonctionne même si cette section échoue : elle log un avertissement
//     et continue, donc aucun risque si le schéma ne correspond pas encore)
// ---------------------------------------------------------------------------

const express = require('express');
const router = express.Router();
const pool = require('../db'); // ADAPTER si le chemin diffère

const VF_BASE = `https://${process.env.VOSFACTURES_ACCOUNT}.vosfactures.fr`;
const VF_TOKEN = process.env.VOSFACTURES_API_TOKEN;

// --- Utilitaires ---

function normaliserNom(nom) {
  return (nom || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // retire les accents
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

function adresseComplete(client) {
  return !!(client.street && client.post_code && client.city);
}

function scoreCompletude(client) {
  let score = 0;
  if (client.street) score++;
  if (client.post_code) score++;
  if (client.city) score++;
  if (client.email) score++;
  if (client.phone) score++;
  if (client.tax_no) score++;
  return score;
}

// Récupère TOUS les contacts VosFactures (pagination automatique, 100/page)
async function fetchTousLesContacts() {
  let page = 1;
  let tous = [];
  while (true) {
    const url = `${VF_BASE}/clients.json?api_token=${VF_TOKEN}&per_page=100&page=${page}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`VosFactures clients.json (page ${page}) : HTTP ${r.status}`);
    const data = await r.json();
    if (!Array.isArray(data) || data.length === 0) break;
    tous = tous.concat(data);
    if (data.length < 100) break;
    page++;
  }
  return tous;
}

// ============================================================================
// GET /api/doublons-vf/detecter
// Détecte les groupes de contacts en doublon (même nom normalisé) ainsi que
// les fiches dont l'adresse (rue + CP + ville) est incomplète.
// ============================================================================
router.get('/detecter', async (req, res) => {
  try {
    const contacts = await fetchTousLesContacts();

    // Regroupement par nom normalisé (accents/casse/espaces ignorés)
    const groupes = {};
    for (const c of contacts) {
      const cle = normaliserNom(c.name);
      if (!cle) continue;
      if (!groupes[cle]) groupes[cle] = [];
      groupes[cle].push(c);
    }

    const doublons = Object.values(groupes)
      .filter(g => g.length > 1)
      .map(g => {
        // Fiche suggérée comme principale = la plus complète (score le plus haut)
        const trie = [...g].sort((a, b) => scoreCompletude(b) - scoreCompletude(a));
        return {
          nom: trie[0].name,
          principal_suggere: trie[0].id,
          contacts: trie.map(c => ({
            id: c.id,
            name: c.name,
            street: c.street,
            post_code: c.post_code,
            city: c.city,
            email: c.email,
            phone: c.phone,
            tax_no: c.tax_no,
            complet: adresseComplete(c),
            score: scoreCompletude(c)
          }))
        };
      })
      .sort((a, b) => b.contacts.length - a.contacts.length);

    // Fiches à l'adresse incomplète (hors doublons, ou en plus des doublons)
    const adressesIncompletes = contacts
      .filter(c => !adresseComplete(c))
      .map(c => ({
        id: c.id,
        name: c.name,
        street: c.street || '',
        post_code: c.post_code || '',
        city: c.city || '',
        email: c.email || '',
        phone: c.phone || ''
      }));

    res.json({
      total_contacts: contacts.length,
      nb_groupes_doublons: doublons.length,
      doublons,
      nb_adresses_incompletes: adressesIncompletes.length,
      adresses_incompletes: adressesIncompletes
    });
  } catch (err) {
    console.error('Erreur détection doublons VosFactures:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// POST /api/doublons-vf/fusionner
// body: { principal_id: 123, merge_ids: [456, 789] }
// Fusionne dans VosFactures, puis tente de réattribuer les données locales
// (commandes / clients) si l'app garde une référence à l'ID VosFactures.
// ============================================================================
router.post('/fusionner', async (req, res) => {
  const { principal_id, merge_ids } = req.body;
  if (!principal_id || !Array.isArray(merge_ids) || merge_ids.length === 0) {
    return res.status(400).json({ error: 'principal_id et merge_ids (tableau) sont requis' });
  }

  try {
    const url = `${VF_BASE}/clients/${principal_id}/merge.json`;
    const vfRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_token: VF_TOKEN, merge_ids })
    });
    const vfData = await vfRes.json().catch(() => ({}));
    if (!vfRes.ok) {
      return res.status(vfRes.status).json({ error: 'Erreur VosFactures', details: vfData });
    }

    // Réattribution locale — ADAPTER les noms de table/colonnes à ton schéma réel.
    // N'échoue jamais la requête globale : la fusion VosFactures est déjà faite.
    let reattribution_locale = 'non tentée (schéma à adapter)';
    try {
      const r1 = await pool.query(
        `UPDATE commandes SET client_id = $1 WHERE client_id = ANY($2::int[])`,
        [principal_id, merge_ids]
      );
      const r2 = await pool.query(
        `UPDATE clients SET vf_id = $1 WHERE vf_id = ANY($2::int[])`,
        [principal_id, merge_ids]
      );
      reattribution_locale = `${r1.rowCount || 0} commande(s), ${r2.rowCount || 0} fiche(s) client locale(s)`;
    } catch (dbErr) {
      console.warn('Réattribution locale ignorée (adapter le schéma dans routes-doublons-vf.js) :', dbErr.message);
      reattribution_locale = `ignorée : ${dbErr.message}`;
    }

    res.json({ ok: true, principal_id, fusionnes: merge_ids, vosfactures: vfData, reattribution_locale });
  } catch (err) {
    console.error('Erreur fusion doublons VosFactures:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// PUT /api/doublons-vf/adresse/:id
// Complète/corrige l'adresse d'un contact VosFactures existant.
// body: { street, post_code, city, country }
// ============================================================================
router.put('/adresse/:id', async (req, res) => {
  const { id } = req.params;
  const { street, post_code, city, country } = req.body;
  try {
    const url = `${VF_BASE}/clients/${id}.json`;
    const vfRes = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_token: VF_TOKEN,
        client: { street, post_code, city, country: country || 'FR' }
      })
    });
    const vfData = await vfRes.json().catch(() => ({}));
    if (!vfRes.ok) {
      return res.status(vfRes.status).json({ error: 'Erreur VosFactures', details: vfData });
    }
    res.json({ ok: true, client: vfData });
  } catch (err) {
    console.error('Erreur mise à jour adresse VosFactures:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
