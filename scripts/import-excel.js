// scripts/import-excel.js — Import historique Excel ventes Éloflex
// Usage : node scripts/import-excel.js <chemin_fichier.xlsx>
require('dotenv').config();
const XLSX   = require('xlsx');
const crypto = require('crypto');
const { pool } = require('../server/db');

// ── Normalisation modèle ──────────────────────────────────────────
function normaliserModele(raw) {
  if (!raw) return null;
  const s = String(raw).trim().replace(/\s+/g, ' ').replace(/\xa0/g, '').trim();
  if (!s || s === '-') return null;
  // Extraire le modèle de base (premier mot/token)
  const map = {
    'L+': 'Eloflex L+', '2L+': 'Eloflex L+',
    'L': 'Eloflex L', '2L': 'Eloflex L',
    'F': 'Eloflex F', '2F': 'Eloflex F', '3F': 'Eloflex F',
    'D2': 'Eloflex D2', '2D2': 'Eloflex D2', '3D2': 'Eloflex D2',
    'X': 'Eloflex X', '2X': 'Eloflex X', '3X': 'Eloflex X',
    'P': 'Eloflex P', '2P': 'Eloflex P', '3P': 'Eloflex P',
    'H': 'Eloflex H',
    'C': 'Eloflex C', '2C': 'Eloflex C',
    'C3': 'Eloflex C3',
    'K': 'Eloflex K',
    'R': 'Eloflex R',
    'S1': 'Eloflex S1',
    'M+': 'Eloflex M+',
    'W': 'Eloflex W',
  };
  // Chercher le modèle de base dans la chaîne
  const token = s.split(/[\s\-\+\/\(]/)[0].toUpperCase().replace(/\+$/, '+');
  for (const [k, v] of Object.entries(map)) {
    if (s.toUpperCase().startsWith(k.toUpperCase())) return v;
  }
  // Sinon retourner nettoyé
  return `Eloflex ${s.split(/[\s\-\/\(]/)[0]}`.substring(0, 40);
}

// ── Extraction numéros de série ───────────────────────────────────
function extraireSeries(raw) {
  if (!raw || String(raw).trim() === '-') return [];
  const s = String(raw)
    .replace(/_x000D_/g, ' ')
    .replace(/\r\n|\n|\r/g, ' ')
    .trim();
  if (!s || s === '-' || s === '') return [];

  // Pattern : séries commençant par les préfixes connus
  const SERIE_RE = /\b(EL\d{6,}|A\d{2}L?\d{10,}|DE\d{2,}L?\d{10,}|T\d{10,}|A\d{12,}|DE\d{14,}|\d{9,12}[A-Z]?)\b/gi;
  const found = [];
  let m;
  while ((m = SERIE_RE.exec(s)) !== null) {
    const serie = m[1].trim().replace(/[_\s]+$/, '');
    if (serie.length >= 6 && !found.includes(serie)) {
      found.push(serie);
    }
  }
  // Si aucun pattern détecté mais la valeur ressemble à une série
  if (!found.length && s.length >= 6 && s !== '-' && !/^\d{4,5}$/.test(s)) {
    // Découper par séparateurs
    const parts = s.split(/\s+[-–]\s+|\s{2,}|,/).map(p => p.trim()).filter(p => p.length >= 6 && p !== '-');
    parts.forEach(p => { if (!found.includes(p)) found.push(p.substring(0, 30)); });
  }
  return found;
}

// ── Mapping colonnes selon onglet ─────────────────────────────────
function getColMap(header) {
  const h = header.map(v => v ? String(v).toLowerCase().trim() : '');
  const find = (...keys) => { for (const k of keys) { const i = h.findIndex(v => v.includes(k)); if (i >= 0) return i; } return -1; };
  return {
    groupe:    find('groupe'),
    distrib:   find('distributeur'),
    adresse:   find('adresse'),
    tel:       find('téléphone', 'telephone'),
    email:     find('email', 'mail'),
    modele:    find('modèle', 'modele'),
    bdc:       find('bdc'),
    date:      find('livraison'),
    serie:     find('série', 'serie'),
    facture:   find('facture'),
    client:    find('client'),
    info:      find('informations', 'information', 'note'),
  };
}

// ── Import principal ──────────────────────────────────────────────
async function importExcel(filepath) {
  console.log(`\n📂 Lecture : ${filepath}`);
  const wb = XLSX.readFile(filepath);
  const YEAR_SHEETS = wb.SheetNames.filter(s => /^\d{4}$/.test(s)).sort();
  console.log(`📋 Onglets années : ${YEAR_SHEETS.join(', ')}`);

  const dbClient = await pool.connect();
  let stats = { clients: 0, fauteuils: 0, doublons: 0, ignores: 0, erreurs: 0 };

  try {
    for (const year of YEAR_SHEETS) {
      const ws = wb.Sheets[year];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });
      if (!rows.length) continue;

      const header = rows[0];
      const colMap = getColMap(header);
      console.log(`\n📅 ${year} — ${rows.length - 1} lignes`);

      let yearFauteuils = 0;

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || !row.some(v => v)) continue;

        const get = (idx) => idx >= 0 && row[idx] ? String(row[idx]).replace(/\xa0/g, '').trim() : null;

        const distribNom = get(colMap.distrib);
        const serieRaw   = get(colMap.serie);
        const modeleRaw  = get(colMap.modele);
        const livraison  = get(colMap.date);
        const factureNum = get(colMap.facture);
        const email      = get(colMap.email);
        const tel        = get(colMap.tel);
        const adresse    = get(colMap.adresse);

        // Ignorer les lignes sans distributeur ni série
        if (!distribNom || distribNom === '-') { stats.ignores++; continue; }

        const series  = extraireSeries(serieRaw);
        const modele  = normaliserModele(modeleRaw);

        // Ignorer les lignes sans série et sans modèle (accessoires purs)
        if (!series.length && !modele) { stats.ignores++; continue; }
        // Ignorer les lignes sans série (accessoires uniquement)
        if (!series.length) { stats.ignores++; continue; }

        // ── Upsert client ────────────────────────────────────────
        let clientId;
        try {
          const nomClean = distribNom.replace(/\s*\(essai\)|\s*\(P\)|\s*\(demo\)/gi, '').trim();
          const existing = await dbClient.query(
            'SELECT id FROM clients WHERE LOWER(TRIM(nom)) = LOWER($1)', [nomClean]
          );
          if (existing.rows.length) {
            clientId = existing.rows[0].id;
            // Mettre à jour email/tel si manquants
            if (email || tel) {
              await dbClient.query(
                'UPDATE clients SET email=COALESCE(NULLIF(email,\'\'),$1), tel=COALESCE(NULLIF(tel,\'\'),$2), updated_at=NOW() WHERE id=$3',
                [email, tel, clientId]
              );
            }
          } else {
            const r = await dbClient.query(
              `INSERT INTO clients (nom, email, tel, ville, type, token_portail)
               VALUES ($1,$2,$3,$4,$5,md5(random()::text)) RETURNING id`,
              [nomClean, email || null, tel || null, null, 'Distributeur']
            );
            clientId = r.rows[0].id;
            stats.clients++;
          }
        } catch(e) {
          console.error(`  ❌ Client "${distribNom}" : ${e.message}`);
          stats.erreurs++;
          continue;
        }

        // ── Upsert fauteuils (un par série) ─────────────────────
        for (const serie of series) {
          try {
            // Nettoyer la série
            const serieClean = serie.replace(/[_\s]+$/, '').replace(/_x000D_.*$/, '').trim();
            if (serieClean.length < 4) continue;

            const annee = livraison ? parseInt(livraison.substring(0, 4)) : parseInt(year);

            // Calculer date achat à partir de la livraison
            const dateAchat = livraison ? livraison.substring(0, 10) : null;

            const existing = await dbClient.query(
              'SELECT id, client_id FROM fauteuils WHERE serie=$1', [serieClean]
            );

            if (existing.rows.length) {
              // Mettre à jour seulement si les infos sont meilleures
              await dbClient.query(
                `UPDATE fauteuils SET
                  client_id=COALESCE(client_id, $1),
                  modele=COALESCE(NULLIF(modele,''),$2),
                  annee=COALESCE(annee,$3),
                  date_achat=COALESCE(date_achat,$4),
                  num_facture=COALESCE(NULLIF(num_facture,''),$5),
                  updated_at=NOW()
                 WHERE serie=$6`,
                [clientId, modele, annee, dateAchat, factureNum, serieClean]
              );
              stats.doublons++;
            } else {
              await dbClient.query(
                `INSERT INTO fauteuils (client_id, modele, serie, annee, date_achat, num_facture, duree_garantie_mois)
                 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
                [clientId, modele || 'Eloflex', serieClean, annee, dateAchat, factureNum, 24]
              );
              stats.fauteuils++;
              yearFauteuils++;
            }
          } catch(e) {
            if (e.message.includes('unique')) { stats.doublons++; }
            else { console.error(`  ❌ Série "${serie}" : ${e.message}`); stats.erreurs++; }
          }
        }
      }
      console.log(`  ✅ ${yearFauteuils} fauteuils importés`);
    }
  } finally {
    dbClient.release();
    await pool.end();
  }

  console.log('\n📊 Résultat final :');
  console.log(`  Nouveaux clients   : ${stats.clients}`);
  console.log(`  Nouveaux fauteuils : ${stats.fauteuils}`);
  console.log(`  Doublons mis à jour: ${stats.doublons}`);
  console.log(`  Lignes ignorées    : ${stats.ignores} (accessoires sans série)`);
  console.log(`  Erreurs            : ${stats.erreurs}`);
}

// ── Point d'entrée ────────────────────────────────────────────────
const filepath = process.argv[2];
if (!filepath) {
  console.error('Usage: node scripts/import-excel.js <fichier.xlsx>');
  process.exit(1);
}
importExcel(filepath).catch(e => {
  console.error('❌ Erreur fatale :', e.message);
  process.exit(1);
});
