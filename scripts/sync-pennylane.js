/**
 * sync-pennylane.js
 * Synchronisation des commandes/devis/BDC depuis l'API Pennylane V2
 * Miroir fonctionnel de sync-vosfactures.js
 *
 * Variables d'environnement :
 *   PENNYLANE_API_KEY   — Bearer token généré dans Pennylane > Paramètres > API
 *                         (PENNYLANE_TOKEN accepté en repli pour compatibilité)
 *   PENNYLANE_BASE_URL  — optionnel, défaut : https://app.pennylane.com/api/external/v2
 *
 * Réf. API : pagination par curseur { items, has_more, next_cursor } ;
 *            filtres = tableau JSON [{field, operator, value}] ;
 *            opérateurs : eq, not_eq, lt, lteq, gt, gteq, in, not_in, start_with.
 */

const axios = require('axios');
const db    = require('../server/db');

const BASE_URL = process.env.PENNYLANE_BASE_URL || 'https://app.pennylane.com/api/external/v2';

// ── Client axios authentifié ────────────────────────────────────────────────
function plApi() {
  const token = process.env.PENNYLANE_API_KEY || process.env.PENNYLANE_TOKEN;
  if (!token) throw new Error('PENNYLANE_API_KEY non défini');
  return axios.create({
    baseURL: BASE_URL,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    timeout: 20000,
  });
}

// ── Helpers numéro de document ──────────────────────────────────────────────
// Normalisation simple (casse + espaces)
function _norm(s) { return String(s == null ? '' : s).toUpperCase().replace(/\s+/g, '').trim(); }

// Forme canonique tolérante : majuscules, chaque groupe de chiffres est débarrassé
// de ses zéros de tête, séparateurs supprimés. Ainsi "D-2026-08-7" == "D-2026-08-07".
function _canon(s) {
  return _norm(s)
    .split(/[^A-Z0-9]+/)
    .map(tok => /^[0-9]+$/.test(tok) ? String(parseInt(tok, 10)) : tok)
    .join('');
}

// Tous les champs où Pennylane peut ranger le numéro selon le type de document.
function docNumberCandidates(d) {
  if (!d) return [];
  const fields = [
    d.invoice_number, d.number, d.document_number, d.label, d.reference,
    d.external_reference, d.name, d.title, d.quote_number, d.pdf_invoice_number,
  ];
  return fields.filter(v => v != null && v !== '');
}

// Le document d correspond-il au numéro recherché ?
function docMatchesNumber(d, numero) {
  const cibleN = _norm(numero), cibleC = _canon(numero);
  return docNumberCandidates(d).some(v => {
    const n = _norm(v), c = _canon(v);
    return n === cibleN || c === cibleC;
  });
}

// ── Pagination ──────────────────────────────────────────────────────────────
async function fetchAllPages(api, endpoint, params = {}, limit = 100, maxPages = 200) {
  const results = [];
  let cursor = null, hasMore = true, pages = 0;
  while (hasMore && pages < maxPages) {
    pages++;
    // filter/sort doivent être renvoyés à chaque page (exigence v2)
    const p = { ...params, limit, ...(cursor ? { cursor } : {}) };
    const { data } = await api.get(endpoint, { params: p });
    const items = data.items || data.quotes || data.commercial_documents || data.customer_invoices || [];
    results.push(...items);
    hasMore = data.has_more || false;
    cursor  = data.next_cursor || null;
    if (!cursor) hasMore = false;
  }
  return results;
}

// Résout le nom d'un client (l'objet customer d'une liste ne contient parfois que l'id)
const _plCustomerCache = {};
async function resolvePennylaneCustomerName(api, customer) {
  if (!customer) return '';
  const direct = customer.name || customer.company_name || customer.label || '';
  if (direct) return direct;
  const id = customer.id;
  if (!id) return '';
  if (_plCustomerCache[id] !== undefined) return _plCustomerCache[id];
  try {
    const { data } = await api.get(`/customers/${id}`);
    const c = data.customer || data || {};
    _plCustomerCache[id] = c.name || c.company_name || c.label || '';
  } catch (_) { _plCustomerCache[id] = ''; }
  return _plCustomerCache[id];
}

// ── Vérification du token ───────────────────────────────────────────────────
async function checkStatus() {
  const api = plApi();
  const { data } = await api.get('/customer_invoices', { params: { limit: 1 } });
  const ex = (data.items || [])[0] || null;
  return { ok: true, account: { verifie: true, exemple_numero: ex ? (ex.invoice_number || ex.number || null) : null } };
}

// ── Synchronisation en masse ────────────────────────────────────────────────
async function syncCommandesPennylane(fullHistory = false) {
  const api = plApi();
  const client = await db.pool.connect();
  let created = 0, updated = 0, skipped = 0;

  try {
    const dateFilter = fullHistory ? null : (() => {
      const d = new Date(); d.setDate(d.getDate() - 90);
      return d.toISOString().slice(0, 10);
    })();

    const buildFilter = (extra = []) => {
      const filters = [...extra];
      if (dateFilter) filters.push({ field: 'date', operator: 'gteq', value: dateFilter });
      return filters.length ? JSON.stringify(filters) : undefined;
    };

    const quotes = await fetchAllPages(api, '/quotes', { filter: buildFilter() });

    let commercialDocs = [];
    try {
      const docs = await fetchAllPages(api, '/commercial_documents', { filter: buildFilter() });
      commercialDocs = docs.filter(d => {
        const t = String(d.type || d.document_type || d.kind || '').toLowerCase();
        return !t || /order|commande|purchase/.test(t);
      });
    } catch (e) { console.warn('  ⚠️ commercial_documents non disponible:', e.message); }

    const allDocs = [
      ...quotes.map(d => ({ ...d, _ep: '/quotes' })),
      ...commercialDocs.map(d => ({ ...d, _ep: '/commercial_documents' })),
    ];
    console.log(`  📄 ${allDocs.length} document(s) récupéré(s) depuis Pennylane`);

    const counters = { created: 0, updated: 0, skipped: 0 };
    for (const doc of allDocs) {
      try { await traiterDocumentPennylane(client, api, doc, counters); }
      catch (e) { console.warn(`  ⚠️ Doc Pennylane #${doc.id} : ${e.message}`); counters.skipped++; }
    }
    return `Pennylane sync: ${counters.created} créées, ${counters.updated} mises à jour, ${counters.skipped} ignorées`;
  } finally {
    client.release();
  }
}

async function traiterDocumentPennylane(client, api, doc, counters) {
  const ep = doc._ep || '/quotes';
  let detail = doc;
  if (!doc.invoice_lines && doc.id) {
    try {
      const { data } = await api.get(`${ep}/${doc.id}`);
      detail = data.quote || data.commercial_document || data;
    } catch (_) { detail = doc; }
  }
  if (!(detail.invoice_lines || detail.line_items || []).length && doc.id) {
    try {
      const { data: dl } = await api.get(`${ep}/${doc.id}/invoice_lines`);
      detail = { ...detail, invoice_lines: dl.items || dl.invoice_lines || [] };
    } catch (_) {}
  }

  const numero     = detail.invoice_number || detail.number || detail.label || String(detail.id);
  const nomDistrib = detail.customer?.name || detail.customer_name || await resolvePennylaneCustomerName(api, detail.customer);
  if (!nomDistrib) { counters.skipped++; return; }

  const dateCommande = (detail.date || detail.created_at || '').slice(0, 10) || null;
  const annee = dateCommande ? parseInt(dateCommande.slice(0, 4)) : new Date().getFullYear();

  const lignes = (detail.invoice_lines || detail.line_items || []).map(l => ({
    designation: l.label || l.description || l.product_name || '',
    reference:   l.product?.reference || l.reference || null,
    quantite:    parseInt(l.quantity) || 1,
  })).filter(l => l.designation);

  const ligneFauteuil = lignes.find(l => /eloflex/i.test(l.designation)) || lignes[0];
  const modele   = ligneFauteuil?.designation || '';
  const quantite = ligneFauteuil?.quantite || 1;

  const texte  = lignes.map(l => l.designation).join(' ');
  const mSerie = texte.match(/\b(EL\d{6,}|A\d{2}L?\d{10,}|DE\d{2,}L?\d{10,}|T\d{2}\d{8,}|A\d{12,})\b/i);
  const numSerie = mSerie ? mSerie[0] : null;

  const nomNorm = nomDistrib.toLowerCase().trim();
  let clientRow = await client.query('SELECT id FROM clients WHERE LOWER(TRIM(nom)) = $1 LIMIT 1', [nomNorm]);
  let clientId;
  if (clientRow.rows.length) {
    clientId = clientRow.rows[0].id;
  } else {
    const email = detail.customer?.billing_email || detail.customer?.email || null;
    const ins = await client.query(
      `INSERT INTO clients (nom, email, type, token_portail)
       VALUES ($1, $2, 'Distributeur', md5(random()::text)) RETURNING id`,
      [nomDistrib, email]
    );
    clientId = ins.rows[0].id;
  }

  let fauteuilId = null;
  if (numSerie) {
    const fr = await client.query('SELECT id FROM fauteuils WHERE serie = $1', [numSerie]);
    if (fr.rows.length) fauteuilId = fr.rows[0].id;
  }

  const pennylaneId = detail.id;

  if (numero) {
    const ex = await client.query(
      `SELECT id FROM commandes WHERE vf_commande_id IS NULL AND bdc = $1 AND LOWER(distributeur_nom) = LOWER($2) LIMIT 1`,
      [numero, nomDistrib]
    );
    if (ex.rows.length) {
      await client.query(
        `UPDATE commandes SET vf_commande_id = $1, fauteuil_id = COALESCE(fauteuil_id, $2),
          num_serie = COALESCE(num_serie, $3), modele = COALESCE(NULLIF(modele,''), $4), updated_at = NOW()
         WHERE id = $5`,
        [pennylaneId, fauteuilId, numSerie, modele, ex.rows[0].id]
      );
      counters.updated++;
      return;
    }
  }

  const r = await client.query(
    `INSERT INTO commandes (
      client_id, fauteuil_id, annee_onglet, distributeur_nom, modele, quantite,
      bdc, date_commande, num_serie, vf_commande_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (vf_commande_id) DO UPDATE SET
      distributeur_nom = EXCLUDED.distributeur_nom,
      modele           = COALESCE(NULLIF(commandes.modele,''), EXCLUDED.modele),
      quantite         = COALESCE(commandes.quantite,          EXCLUDED.quantite),
      bdc              = COALESCE(NULLIF(commandes.bdc,''),    EXCLUDED.bdc),
      date_commande    = COALESCE(commandes.date_commande,     EXCLUDED.date_commande),
      num_serie        = COALESCE(commandes.num_serie,         EXCLUDED.num_serie),
      fauteuil_id      = COALESCE(commandes.fauteuil_id,      EXCLUDED.fauteuil_id),
      updated_at       = NOW()
    RETURNING (xmax = 0) AS inserted`,
    [clientId, fauteuilId, annee, nomDistrib, modele, quantite, numero, dateCommande, numSerie, pennylaneId]
  );

  if (r.rows[0].inserted && lignes.length) {
    const cmdRow = await client.query('SELECT id FROM commandes WHERE vf_commande_id = $1', [pennylaneId]);
    if (cmdRow.rows.length) {
      const cmdId = cmdRow.rows[0].id;
      await client.query('DELETE FROM commandes_lignes WHERE commande_id = $1', [cmdId]);
      for (let i = 0; i < lignes.length; i++) {
        const l = lignes[i];
        if (!l.designation) continue;
        await client.query(
          'INSERT INTO commandes_lignes (commande_id, designation, reference, quantite, ordre) VALUES ($1,$2,$3,$4,$5)',
          [cmdId, l.designation, l.reference, l.quantite, i]
        );
      }
    }
    counters.created++;
  } else {
    counters.updated++;
  }
}

// ── Recherche d'un document par numéro (bdc-lookup) ─────────────────────────
async function lookupDocumentPennylane(numero) {
  const api = plApi();
  const debug = [];   // trace de diagnostic renvoyée au client (visible dans la réponse JSON)

  for (const endpoint of ['/quotes', '/commercial_documents', '/customer_invoices']) {
    const dbg = { endpoint, scanned: 0, filter_error: null, echantillon: [] };
    try {
      // 1) Tentative filtrée par numéro (rapide si le champ est indexé)
      let items = [];
      try {
        const { data } = await api.get(endpoint, {
          params: { filter: JSON.stringify([{ field: 'invoice_number', operator: 'eq', value: numero }]), limit: 5 }
        });
        items = data.items || data.quotes || data.customer_invoices || data.commercial_documents || [];
      } catch (e) { dbg.filter_error = (e.response && e.response.status) ? `HTTP ${e.response.status}` : e.message; }

      let doc = items.find(d => docMatchesNumber(d, numero));

      // 2) Repli : balayer les documents récents (jusqu'à 10 pages = 1000 docs)
      if (!doc) {
        let cursor = null;
        for (let pg = 0; pg < 10 && !doc; pg++) {
          const { data: d } = await api.get(endpoint, { params: { limit: 100, ...(cursor ? { cursor } : {}) } });
          const recents = d.items || d.quotes || d.customer_invoices || d.commercial_documents || [];
          dbg.scanned += recents.length;
          if (dbg.echantillon.length < 5) {
            for (const rd of recents.slice(0, 5)) dbg.echantillon.push(docNumberCandidates(rd).map(_norm).join(' | ') || `#${rd.id}`);
          }
          doc = recents.find(rd => docMatchesNumber(rd, numero));
          cursor = d.next_cursor || null;
          if (!cursor) break;
        }
      }

      if (doc) {
        let detail = doc;
        try {
          const { data: d2 } = await api.get(`${endpoint}/${doc.id}`);
          detail = d2.quote || d2.customer_invoice || d2.commercial_document || d2 || doc;
        } catch (_) {}

        let rawLignes = detail.invoice_lines || detail.line_items || [];
        if (!rawLignes.length && doc.id) {
          try {
            const { data: dl } = await api.get(`${endpoint}/${doc.id}/invoice_lines`);
            rawLignes = dl.items || dl.invoice_lines || [];
          } catch (_) {}
        }
        const lignes = rawLignes.filter(l => l.label || l.description).map(l => ({
          designation:    l.label || l.description || '',
          designation_en: l.product?.reference || l.label || '',
          reference:      l.product?.reference || null,
          quantite:       parseInt(l.quantity) || 1,
        }));

        const ligneFauteuil = lignes.find(l => /eloflex/i.test(l.designation)) || lignes[0];
        const modele   = ligneFauteuil?.designation || '';
        const quantite = ligneFauteuil?.quantite || 1;
        const texte    = lignes.map(l => l.designation).join(' ');
        const mSerie   = texte.match(/\b(EL\d{6,}|A\d{2}L?\d{10,}|DE\d{2,}L?\d{10,}|T\d{2}\d{8,}|A\d{12,})\b/i);

        return {
          configured: true, found: true, source: 'pennylane',
          vf_id: doc.id,
          numero: detail.invoice_number || detail.number || detail.label || numero,
          date_commande: (detail.date || detail.created_at || '').slice(0, 10) || null,
          distributeur: (detail.customer?.name || detail.customer_name || await resolvePennylaneCustomerName(api, detail.customer)) || null,
          modele, quantite, lignes,
          num_serie: mSerie ? mSerie[0] : null,
          kind: endpoint.replace('/', ''),
          modele_demo: /essai|demo|d[ée]mo|pr[eê]t/i.test(texte),
        };
      }
    } catch (e) {
      dbg.error = (e.response && e.response.status) ? `HTTP ${e.response.status}` : e.message;
    }
    debug.push(dbg);
  }

  return { configured: true, found: false, numero, debug };
}

// ── Génération d'une facture (brouillon) ────────────────────────────────────
async function genererFacturePennylane(cmd, lignes) {
  const api = plApi();

  let customerId = null;
  const cible = (cmd.distributeur_nom || '').toLowerCase().trim();
  const corr = c => {
    const n = (c.name || c.company_name || c.label || '').toLowerCase();
    return n && (n === cible || n.includes(cible.slice(0, 8)) || cible.includes(n.slice(0, 8)));
  };
  try {
    const { data } = await api.get('/customers', {
      params: { filter: JSON.stringify([{ field: 'name', operator: 'start_with', value: (cmd.distributeur_nom || '').slice(0, 6) }]), limit: 20 }
    });
    const match = (data.items || []).find(corr);
    if (match) customerId = match.id;
  } catch (_) {}
  if (!customerId) {
    try {
      let cursor = null;
      for (let pg = 0; pg < 3 && !customerId; pg++) {
        const { data: d } = await api.get('/customers', { params: { limit: 100, ...(cursor ? { cursor } : {}) } });
        const match = (d.items || []).find(corr);
        if (match) customerId = match.id;
        cursor = d.next_cursor || null;
        if (!cursor) break;
      }
    } catch (_) {}
  }

  const today = new Date().toISOString().slice(0, 10);
  const payload = {
    customer_id: customerId,
    date: cmd.date_livraison || today,
    deadline: (() => { const d = new Date(); d.setDate(d.getDate() + 30); return d.toISOString().slice(0, 10); })(),
    draft: true,
    external_reference: cmd.bdc || `SAV-${cmd.id}`,
    invoice_lines: (lignes.length ? lignes : [{ designation: cmd.modele || 'Commande Éloflex', quantite: cmd.quantite || 1 }]).map(l => ({
      label: l.designation || l.label || 'Article',
      quantity: String(l.quantite || 1),
      raw_currency_unit_price: '0.00',
      vat_rate: 'FR_200',
    })),
  };

  const { data } = await api.post('/customer_invoices', payload);
  return data;
}

module.exports = {
  checkStatus,
  syncCommandesPennylane,
  lookupDocumentPennylane,
  genererFacturePennylane,
};
