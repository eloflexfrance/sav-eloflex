// scripts/sync-vosfactures.js — PostgreSQL avec pagination complète
require('dotenv').config();
const axios = require('axios');
const { pool } = require('../server/db');

// ── Pattern numéros de série Éloflex ─────────────────────────────
const SERIE_RE = /\b(EL\d{6,}|A\d{2}L?\d{10,}|DE\d{2,}L?\d{10,}|T\d{2}\d{8,}|A\d{12,})\b/gi;

function extraireSeriesDeTexte(texte) {
  if (!texte) return [];
  const found = [], seen = new Set();
  let m;
  const re = new RegExp(SERIE_RE.source, 'gi');
  while ((m = re.exec(texte)) !== null) {
    const s = m[1].trim();
    if (s.length >= 6 && !seen.has(s)) { found.push(s); seen.add(s); }
  }
  return found;
}

function getVfApi() {
  const token   = process.env.VOSFACTURES_API_TOKEN;
  const account = process.env.VOSFACTURES_ACCOUNT;
  if (!token || !account) throw new Error('VOSFACTURES_API_TOKEN et VOSFACTURES_ACCOUNT non configurés');
  return axios.create({
    baseURL: `https://${account}.vosfactures.fr`,
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    params:  { api_token: token }
  });
}

async function fetchAllPages(vfApi, endpoint, extraParams = {}) {
  const results = [];
  let page = 1;
  while (true) {
    const { data } = await vfApi.get(endpoint, { params: { page, per_page: 100, ...extraParams } });
    const items = Array.isArray(data) ? data : [];
    if (items.length === 0) break;
    results.push(...items);
    console.log(`  Page ${page} : ${items.length} éléments`);
    if (items.length < 100) break;
    page++;
  }
  return results;
}

async function log(type, status, message, records = 0) {
  try {
    const client = await pool.connect();
    await client.query('INSERT INTO sync_log (type,status,message,records) VALUES ($1,$2,$3,$4)', [type, status, message, records]);
    client.release();
  } catch(e) { console.error('Erreur log:', e.message); }
}

// ── Sync clients ──────────────────────────────────────────────────
async function syncClients() {
  const vfApi = getVfApi();
  const client = await pool.connect();
  try {
    console.log('⏳ Sync clients...');
    const clients = await fetchAllPages(vfApi, '/clients.json');
    console.log(`  Total : ${clients.length} clients`);
    let count = 0;
    for (const c of clients) {
      const nom = c.name || c.shortcut || c.email || '—';
      await client.query(`
        INSERT INTO clients (nom, contact, email, tel, ville, type, vf_id, token_portail)
        VALUES ($1,$2,$3,$4,$5,$6,$7,md5(random()::text))
        ON CONFLICT (vf_id) DO UPDATE SET
          nom=EXCLUDED.nom, contact=EXCLUDED.contact,
          email=EXCLUDED.email, tel=EXCLUDED.tel,
          ville=EXCLUDED.ville, updated_at=NOW()
      `, [nom, c.buyer_name||null, c.email||null, c.phone||c.mobile||null, c.city||null, 'Distributeur', c.id]);
      count++;
    }
    await log('clients', 'ok', `${count} clients synchronisés`, count);
    return `${count} clients synchronisés`;
  } catch(e) { await log('clients', 'error', e.message); throw e; }
  finally { client.release(); }
}

// ── Sync produits ─────────────────────────────────────────────────
async function syncProducts() {
  const vfApi = getVfApi();
  const client = await pool.connect();
  try {
    console.log('⏳ Sync produits...');
    const products = await fetchAllPages(vfApi, '/products.json');
    console.log(`  Total : ${products.length} produits`);
    let count = 0, skipped = 0;
    for (const p of products) {
      const ref = (p.code && p.code.trim()) ? p.code.trim() : `VF-${p.id}`;
      const pxht = parseFloat(p.price_net || 0);
      const stock = parseFloat(p.warehouse_quantity || 0);
      try {
        await client.query(`
          INSERT INTO catalogue (ref, designation, fournisseur, ref_fournisseur, pxht, stock, vf_product_id)
          VALUES ($1, $2, 'Eloflex AB', $3, $4, $5, $6)
          ON CONFLICT (vf_product_id) DO UPDATE SET
            ref         = CASE WHEN catalogue.ref LIKE 'VF-%' THEN EXCLUDED.ref ELSE catalogue.ref END,
            designation = EXCLUDED.designation,
            pxht        = EXCLUDED.pxht,
            stock       = EXCLUDED.stock,
            updated_at  = NOW()
        `, [ref, p.name||'—', p.supplier_code||null, pxht, Math.max(0, Math.round(stock)), p.id]);
        count++;
      } catch(e) {
        try {
          await client.query(`
            INSERT INTO catalogue (ref, designation, fournisseur, ref_fournisseur, pxht, stock, vf_product_id)
            VALUES ($1, $2, 'Eloflex AB', $3, $4, $5, $6)
            ON CONFLICT (vf_product_id) DO UPDATE SET
              designation=EXCLUDED.designation, pxht=EXCLUDED.pxht, stock=EXCLUDED.stock, updated_at=NOW()
          `, [`VF-${p.id}`, p.name||'—', p.supplier_code||null, pxht, Math.max(0, Math.round(stock)), p.id]);
          count++;
        } catch(e2) { console.warn(`  ⚠️ Produit ignoré : ${p.name} (${e2.message})`); skipped++; }
      }
    }
    const msg = `${count} produits synchronisés${skipped ? `, ${skipped} ignorés` : ''}`;
    await log('products', 'ok', msg, count);
    return msg;
  } catch(e) { await log('products', 'error', e.message); throw e; }
  finally { client.release(); }
}

// ── Sync factures avec extraction des numéros de série ────────────
async function syncInvoices(fullHistory = false) {
  const vfApi  = getVfApi();
  const client = await pool.connect();
  try {
    console.log(`⏳ Sync factures (${fullHistory ? 'historique complet' : '12 derniers mois'})...`);

    const params = fullHistory ? {} : { period: 'last_12_months' };
    const invoices = await fetchAllPages(vfApi, '/invoices.json', params);
    console.log(`  Total : ${invoices.length} factures à analyser`);

    let countFactures = 0, countSeries = 0, countLiees = 0;

    for (const inv of invoices) {
      countFactures++;

      // 1. Récupérer le détail complet de la facture (avec positions/lignes)
      let detail = null;
      try {
        const { data } = await vfApi.get(`/invoices/${inv.id}.json`);
        detail = data;
      } catch(e) {
        console.warn(`  ⚠️ Facture ${inv.id} inaccessible : ${e.message}`);
        continue;
      }

      // 2. Construire le texte complet à analyser pour trouver les séries
      const positions = detail.positions || detail.invoice_items || [];
      const texteComplet = [
        detail.description || '',
        detail.buyer_name || '',
        ...positions.map(p => [p.name || '', p.description || ''].join(' '))
      ].join(' ');

      const series = extraireSeriesDeTexte(texteComplet);
      if (!series.length) continue;

      // 3. Pour chaque série trouvée, rattacher la facture au fauteuil
      for (const serie of series) {
        countSeries++;

        // Chercher le fauteuil par numéro de série
        const faut = await client.query(
          'SELECT id, client_id, num_facture FROM fauteuils WHERE serie=$1', [serie]
        );

        if (faut.rows.length) {
          const f = faut.rows[0];
          // Mettre à jour le fauteuil avec le numéro de facture si absent
          if (!f.num_facture) {
            await client.query(
              'UPDATE fauteuils SET num_facture=$1, vf_facture_id=$2, updated_at=NOW() WHERE id=$3',
              [inv.number, inv.id, f.id]
            );
          }

          // Rattacher le client VF au fauteuil si le client VF correspond
          if (inv.client_id) {
            const vfClient = await client.query(
              'SELECT id FROM clients WHERE vf_id=$1', [inv.client_id]
            );
            if (vfClient.rows.length && vfClient.rows[0].id !== f.client_id) {
              // Ne pas écraser un client existant — juste logger
              console.log(`  ℹ️  Série ${serie} : client VF differ (fauteuil:${f.client_id} vs VF:${vfClient.rows[0].id})`);
            }
          }
          countLiees++;
        } else {
          // Série pas encore en base — créer le fauteuil si on a le client
          if (inv.client_id) {
            const vfClient = await client.query(
              'SELECT id FROM clients WHERE vf_id=$1', [inv.client_id]
            );
            if (vfClient.rows.length) {
              const clientId = vfClient.rows[0].id;
              // Déduire le modèle depuis le nom du produit
              const modeleRaw = positions.find(p => extraireSeriesDeTexte([p.name||'',p.description||''].join(' ')).includes(serie))?.name || '';
              const modele = devinerModele(modeleRaw, texteComplet);
              try {
                await client.query(
                  `INSERT INTO fauteuils (client_id, modele, serie, num_facture, vf_facture_id, duree_garantie_mois)
                   VALUES ($1,$2,$3,$4,$5,24)`,
                  [clientId, modele, serie, inv.number, inv.id]
                );
                countSeries++;
                console.log(`  ✅ Nouveau fauteuil créé : ${serie} → ${modele} (${inv.number})`);
              } catch(e) {
                if (!e.message.includes('unique')) console.warn(`  ⚠️ Fauteuil ${serie} : ${e.message}`);
              }
            }
          }
        }
      }

      // Petit délai pour ne pas surcharger l'API VosFactures
      if (countFactures % 50 === 0) {
        console.log(`  ... ${countFactures}/${invoices.length} factures traitées, ${countLiees} séries liées`);
        await new Promise(r => setTimeout(r, 500));
      }
    }

    const msg = `${countFactures} factures, ${countSeries} séries trouvées, ${countLiees} fauteuils liés`;
    console.log(`  ✅ ${msg}`);
    await log('invoices', 'ok', msg, countFactures);
    return msg;
  } catch(e) { await log('invoices', 'error', e.message); throw e; }
  finally { client.release(); }
}

// ── Deviner le modèle depuis le texte d'une ligne de facture ──────
function devinerModele(nom, texte) {
  const MAP = {
    'Eloflex L': /\bL\+?\b|\beloflex l\b/i,
    'Eloflex F': /\bF\b|\beloflex f\b/i,
    'Eloflex D2': /\bD2\b|\beloflex d2\b/i,
    'Eloflex X': /\bX\b|\beloflex x\b/i,
    'Eloflex P': /\bP\b|\beloflex p\b/i,
    'Eloflex H': /\bH\b|\beloflex h\b/i,
    'Eloflex C': /\bmodèle C\b|\beloflex c\b/i,
    'Eloflex C3': /\bC3\b|\beloflex c3\b/i,
    'Eloflex K': /\bK\b|\beloflex k\b/i,
    'Eloflex R': /\bR\b|\beloflex r\b/i,
    'Eloflex S1': /\bS1\b|\beloflex s1\b/i,
    'Eloflex M+': /\bM\+|\beloflex m\+/i,
  };
  const cible = `${nom} ${texte}`;
  for (const [modele, re] of Object.entries(MAP)) {
    if (re.test(cible)) return modele;
  }
  return 'Eloflex';
}

// ── Sync historique complet (à déclencher une seule fois) ─────────
async function syncInvoicesHistorique() {
  return syncInvoices(true);
}

module.exports = { syncClients, syncProducts, syncInvoices, syncInvoicesHistorique };
