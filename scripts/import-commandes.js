// scripts/import-commandes.js — Import historique des commandes distributeurs (tous onglets années)
// Usage : node scripts/import-commandes.js <chemin_fichier.xlsx>
require('dotenv').config();
const XLSX   = require('xlsx');
const crypto = require('crypto');
const { pool } = require('../server/db');

// ── Normalisation date (gère Date JS, chaînes JJ/MM/AAAA, AAAA-MM-JJ) ──────
function normDate(raw) {
  if (!raw) return null;
  if (raw instanceof Date) {
    if (isNaN(raw.getTime())) return null;
    return raw.toISOString().substring(0, 10);
  }
  const s = String(raw).trim();
  if (!s || s === '-') return null;
  // AAAA-MM-JJ déjà bon
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 10);
  // JJ/MM/AAAA
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const d = new Date(s);
  if (!isNaN(d.getTime()) && d.getFullYear() > 2009 && d.getFullYear() < 2030) {
    return d.toISOString().substring(0, 10);
  }
  return null;
}

function clean(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\xa0/g, ' ').replace(/_x000D_/g, ' ').trim();
  return (!s || s === '-') ? null : s;
}

function nomDistributeurClean(raw) {
  if (!raw) return null;
  return String(raw).replace(/\s*\(essai\)|\s*\(P\)|\s*\(demo\)/gi, '').replace(/\xa0/g, ' ').trim();
}

// ── Mapping colonnes selon en-tête de l'onglet ─────────────────────
function getColMap(header) {
  const h = header.map(v => v ? String(v).toLowerCase().trim() : '');
  const find = (...keys) => { for (const k of keys) { const i = h.findIndex(v => v.includes(k)); if (i >= 0) return i; } return -1; };
  return {
    groupe:   find('groupe'),
    distrib:  find('distributeur'),
    adresse:  find('adresse'),
    tel:      find('téléphone', 'telephone'),
    email:    find('email', 'mail'),
    modele:   find('modèle', 'modele'),
    accessoire: find('accessoire'),
    bdc:      find('bdc'),
    date:     find('date'),
    order:    find('order'),
    client:   find('client'),
    suivi:    find('n° suivi', 'suivi'),
    livraison: find('livraison'),
    serie:    find('n° de série', 'série', 'serie'),
    facture:  find('facture'),
    invoicese: find('invoice se'),
    info:     find('information'),
  };
}

function importKey(annee, bdc, distrib, serie, date) {
  return crypto.createHash('md5').update(`${annee}|${bdc||''}|${distrib||''}|${serie||''}|${date||''}`).digest('hex');
}

async function importCommandes(filepath) {
  console.log(`\n📂 Lecture : ${filepath}`);
  const wb = XLSX.readFile(filepath, { cellDates: true });
  const YEAR_SHEETS = wb.SheetNames.filter(s => /^\d{4}$/.test(s)).sort();
  console.log(`📋 Onglets années détectés : ${YEAR_SHEETS.join(', ')}`);

  const dbClient = await pool.connect();
  let stats = { lignes: 0, inserees: 0, maj: 0, ignorees: 0, clients_crees: 0, erreurs: 0 };
  const clientCache = new Map(); // nom lower -> id

  try {
    // Pré-charger les clients existants pour limiter les requêtes
    const existingClients = await dbClient.query('SELECT id, LOWER(TRIM(nom)) AS nom_norm FROM clients');
    for (const r of existingClients.rows) clientCache.set(r.nom_norm, r.id);

    for (const year of YEAR_SHEETS) {
      const ws = wb.Sheets[year];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false, dateNF: 'yyyy-mm-dd' });
      if (!rows.length) continue;

      const header = rows[0];
      const colMap = getColMap(header);
      console.log(`\n📅 ${year} — ${rows.length - 1} lignes à traiter`);
      let yearCount = 0;

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || !row.some(v => v)) continue;
        stats.lignes++;

        const get = (idx) => idx >= 0 ? clean(row[idx]) : null;

        const distribRaw = get(colMap.distrib);
        if (!distribRaw) { stats.ignorees++; continue; }

        const groupe      = get(colMap.groupe);
        const modele      = get(colMap.modele);
        const accessoire  = get(colMap.accessoire);
        const bdc         = get(colMap.bdc);
        const dateCmd     = normDate(get(colMap.date));
        const vfOrderId   = get(colMap.order);
        const clientFinal = get(colMap.client);
        const numSuivi    = get(colMap.suivi);
        const dateLivr    = normDate(get(colMap.livraison));
        const numSerie    = get(colMap.serie);
        const numFacture  = get(colMap.facture);
        const invoiceSe   = get(colMap.invoicese);
        const info         = get(colMap.info);

        const distribNom = nomDistributeurClean(distribRaw);
        const nomNorm = distribNom.toLowerCase();

        // ── Client : réutiliser ou créer ──
        let clientId = clientCache.get(nomNorm);
        if (!clientId) {
          try {
            const r = await dbClient.query(
              `INSERT INTO clients (nom, email, tel, type, token_portail)
               VALUES ($1,$2,$3,'Distributeur',md5(random()::text)) RETURNING id`,
              [distribNom, get(colMap.email), get(colMap.tel)]
            );
            clientId = r.rows[0].id;
            clientCache.set(nomNorm, clientId);
            stats.clients_crees++;
          } catch (e) {
            console.error(`  ❌ Client "${distribNom}" : ${e.message}`);
            stats.erreurs++;
            continue;
          }
        }

        // ── Rattacher au fauteuil si la série existe déjà ──
        let fauteuilId = null;
        if (numSerie) {
          const f = await dbClient.query('SELECT id FROM fauteuils WHERE serie=$1', [numSerie]);
          if (f.rows.length) fauteuilId = f.rows[0].id;
        }

        const key = importKey(year, bdc, distribNom, numSerie, dateCmd);

        try {
          const res = await dbClient.query(
            `INSERT INTO commandes (
              client_id, fauteuil_id, annee_onglet, groupe, distributeur_nom, modele, accessoire,
              bdc, date_commande, vf_order_id, client_final, num_suivi, date_livraison,
              num_serie, num_facture, invoice_se, informations, import_key
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
            ON CONFLICT (import_key) DO UPDATE SET
              num_suivi=EXCLUDED.num_suivi, date_livraison=EXCLUDED.date_livraison,
              num_facture=EXCLUDED.num_facture, invoice_se=EXCLUDED.invoice_se,
              informations=EXCLUDED.informations, fauteuil_id=COALESCE(commandes.fauteuil_id,EXCLUDED.fauteuil_id),
              updated_at=NOW()
            RETURNING (xmax = 0) AS inserted`,
            [clientId, fauteuilId, parseInt(year), groupe, distribNom, modele, accessoire,
             bdc, dateCmd, vfOrderId, clientFinal, numSuivi, dateLivr,
             numSerie, numFacture, invoiceSe, info, key]
          );
          if (res.rows[0].inserted) { stats.inserees++; yearCount++; } else { stats.maj++; }
        } catch (e) {
          console.error(`  ❌ Ligne ${i + 1} (${distribNom}) : ${e.message}`);
          stats.erreurs++;
        }
      }
      console.log(`  ✅ ${yearCount} nouvelles commandes pour ${year}`);
    }
  } finally {
    dbClient.release();
    await pool.end();
  }

  console.log('\n📊 Résultat final :');
  console.log(`  Lignes traitées     : ${stats.lignes}`);
  console.log(`  Commandes créées    : ${stats.inserees}`);
  console.log(`  Commandes mises à jour : ${stats.maj}`);
  console.log(`  Lignes ignorées     : ${stats.ignorees} (sans distributeur)`);
  console.log(`  Nouveaux clients    : ${stats.clients_crees}`);
  console.log(`  Erreurs             : ${stats.erreurs}`);
}

const filepath = process.argv[2];
if (!filepath) {
  console.error('Usage: node scripts/import-commandes.js <fichier.xlsx>');
  process.exit(1);
}
importCommandes(filepath).catch(e => {
  console.error('❌ Erreur fatale :', e.message);
  process.exit(1);
});
