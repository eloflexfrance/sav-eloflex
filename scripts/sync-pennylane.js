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
function _norm(s) { return String(s == null ? '' : s).toUpperCase().replace(/\s+/g, '').trim(); }

// Forme canonique tolérante : chaque groupe de chiffres perd ses zéros de tête,
// séparateurs supprimés. Ainsi "D-2026-08-7" == "D-2026-08-07".
function _canon(s) {
  return _norm(s)
    .split(/[^A-Z0-9]+/)
    .map(tok => /^[0-9]+$/.test(tok) ? String(parseInt(tok, 10)) : tok)
    .join('');
}

function docNumberCandidates(d) {
  if (!d) return [];
  const fields = [
    d.invoice_number, d.number, d.document_number, d.label, d.reference,
    d.external_reference, d.name, d.title, d.quote_number, d.pdf_invoice_number,
  ];
  return fields.filter(v => v != null && v !== '');
}

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
  const direct = customer.name || customer.company_name || customer.label
              || [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim();
  if (direct) return direct;
  const id = customer.id || customer.source_id;
  if (!id) return '';
  if (_plCustomerCache[id] !== undefined) return _plCustomerCache[id];
  try {
    const { data } = await api.get(`/customers/${id}`);
    const c = data.customer || data || {};
    _plCustomerCache[id] = c.name || c.company_name || c.label
      || [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || '';
  } catch (_) { _plCustomerCache[id] = ''; }
  return _plCustomerCache[id];
}

// Résout un produit Pennylane (pour récupérer la référence quand la ligne ne porte
// qu'un product_id). Cache local.
const _plProductCache = {};
async function resolvePennylaneProduct(api, id) {
  if (!id) return null;
  if (_plProductCache[id] !== undefined) return _plProductCache[id];
  try { const { data } = await api.get(`/products/${id}`); _plProductCache[id] = data.product || data || null; }
  catch (_) { _plProductCache[id] = null; }
  return _plProductCache[id];
}
function _plNum(v) { if (v == null || v === '') return null; const n = parseFloat(String(v).replace(',', '.')); return isNaN(n) ? null : n; }

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
  // On FUSIONNE le détail dans l'élément de liste : le détail /{id} de Pennylane
  // peut ne renvoyer que { id, url } et écraserait sinon le client/numéro déjà présents.
  let detail = doc;
  if (!doc.invoice_lines && doc.id) {
    try {
      const { data } = await api.get(`${ep}/${doc.id}`);
      const full = data.quote || data.commercial_document || data.customer_invoice || data;
      if (full && typeof full === 'object') detail = Object.assign({}, doc, full);
    } catch (_) { detail = doc; }
  }
  if (!(detail.invoice_lines || detail.line_items || []).length && doc.id) {
    try {
      const { data: dl } = await api.get(`${ep}/${doc.id}/invoice_lines`);
      detail = { ...detail, invoice_lines: dl.items || dl.invoice_lines || [] };
    } catch (_) {}
  }

  const numero = detail.invoice_number || detail.number || detail.label || String(detail.id);
  let nomDistrib = detail.customer?.name || detail.customer?.company_name || detail.customer_name
                || detail.client?.name || '';
  if (!nomDistrib) nomDistrib = await resolvePennylaneCustomerName(api, detail.customer || detail.client || (detail.customer_id ? { id: detail.customer_id } : null));
  if (!nomDistrib) { counters.skipped++; return; }

  const dateCommande = (detail.date || detail.issue_date || detail.emitted_at || detail.document_date || detail.created_at || '').slice(0, 10) || null;
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
  const debug = [];
  // Suggestions : documents dont le numéro commence par le numéro cherché (Pennylane ajoute un suffixe -1/-2/-3)
  const cibleN = _norm(numero);
  const suggestions = [];
  const seenSug = new Set();
  function collectSuggestion(rd, kind) {
    if (!rd || cibleN.length < 3) return;
    const cands = docNumberCandidates(rd);
    const hit = cands.find(c => { const cn = _norm(c); return cn && cn !== cibleN && cn.startsWith(cibleN); });
    if (!hit) return;
    const key = String(rd.id);
    if (seenSug.has(key)) return;
    seenSug.add(key);
    const distrib = (rd.customer && (rd.customer.name || rd.customer.company_name || rd.customer.label))
                 || rd.customer_name || (rd.client && rd.client.name) || null;
    suggestions.push({ numero: hit, id: rd.id, kind, distributeur: distrib });
  }

  for (const endpoint of ['/quotes', '/commercial_documents', '/customer_invoices']) {
    const dbg = { endpoint, scanned: 0, filter_error: null, echantillon: [] };
    try {
      let items = [];
      try {
        const { data } = await api.get(endpoint, {
          params: { filter: JSON.stringify([{ field: 'invoice_number', operator: 'eq', value: numero }]), limit: 5 }
        });
        items = data.items || data.quotes || data.customer_invoices || data.commercial_documents || [];
      } catch (e) { dbg.filter_error = (e.response && e.response.status) ? `HTTP ${e.response.status}` : e.message; }

      const kind = endpoint.replace('/', '');
      for (const it of items) collectSuggestion(it, kind);
      let doc = items.find(d => docMatchesNumber(d, numero));

      if (!doc) {
        let cursor = null;
        for (let pg = 0; pg < 10 && !doc; pg++) {
          const { data: d } = await api.get(endpoint, { params: { limit: 100, ...(cursor ? { cursor } : {}) } });
          const recents = d.items || d.quotes || d.customer_invoices || d.commercial_documents || [];
          dbg.scanned += recents.length;
          if (dbg.echantillon.length < 5) {
            for (const rd of recents.slice(0, 5)) dbg.echantillon.push(docNumberCandidates(rd).map(_norm).join(' | ') || `#${rd.id}`);
          }
          for (const rd of recents) collectSuggestion(rd, kind);
          doc = recents.find(rd => docMatchesNumber(rd, numero));
          cursor = d.next_cursor || null;
          if (!cursor) break;
        }
      }

      if (doc) {
        // Le détail /{id} peut ne renvoyer que { id, url } : on FUSIONNE dans l'élément de liste
        // pour ne pas perdre le client / le numéro / la date déjà présents.
        let detail = doc;
        try {
          const { data: d2 } = await api.get(`${endpoint}/${doc.id}`);
          const full = d2.quote || d2.customer_invoice || d2.commercial_document || d2;
          if (full && typeof full === 'object') detail = Object.assign({}, doc, full);
        } catch (_) {}

        let rawLignes = detail.invoice_lines || detail.line_items || [];
        if (!rawLignes.length && doc.id) {
          try {
            const { data: dl } = await api.get(`${endpoint}/${doc.id}/invoice_lines`);
            rawLignes = dl.items || dl.invoice_lines || [];
          } catch (_) {}
        }
        const lignes = [];
        for (const l of rawLignes) {
          if (!(l.label || l.description || l.product_label)) continue;
          let reference = l.product_reference || l.reference
            || (l.product && (l.product.reference || l.product.external_reference || l.product.gtin)) || null;
          const pid = l.product_id || (l.product && l.product.id);
          if (!reference && pid) {
            const pr = await resolvePennylaneProduct(api, pid);
            if (pr) reference = pr.reference || pr.external_reference || pr.gtin || pr.product_reference || null;
          }
          const prix = _plNum(l.raw_currency_unit_price != null ? l.raw_currency_unit_price
                       : (l.currency_unit_price != null ? l.currency_unit_price
                       : (l.unit_price != null ? l.unit_price : l.unit_amount)));
          lignes.push({
            designation:    l.label || l.description || l.product_label || '',
            designation_en: reference || l.label || '',
            reference:      reference || null,
            num_serie:      l.serial_number || l.num_serie || '',
            quantite:       parseInt(l.quantity) || 1,
            prix:           prix,
          });
        }

        const ligneFauteuil = lignes.find(l => /eloflex/i.test(l.designation)) || lignes[0];
        const modele   = ligneFauteuil?.designation || '';
        const quantite = ligneFauteuil?.quantite || 1;
        const texte    = lignes.map(l => l.designation + ' ' + (l.reference || '')).join(' ');
        const mSerie   = texte.match(/\b(EL\d{6,}|A\d{2}L?\d{10,}|DE\d{2,}L?\d{10,}|T\d{2}\d{8,}|A\d{12,})\b/i);
        const titreDoc = [detail.label, detail.title, detail.object, detail.name,
                          detail.pdf_invoice_subject, detail.pdf_description, detail.pdf_invoice_free_text,
                          detail.special_mention].filter(Boolean).join(' ');

        const dateCmd = (detail.date || detail.issue_date || detail.emitted_at || detail.document_date
                         || detail.created_at || doc.date || doc.created_at || '');
        let distrib = detail.customer?.name || detail.customer?.company_name || detail.customer?.label
                    || detail.customer_name || detail.client?.name || detail.client?.company_name || '';
        if (!distrib) {
          const custObj = detail.customer || detail.client
                        || (detail.customer_id ? { id: detail.customer_id } : null);
          distrib = await resolvePennylaneCustomerName(api, custObj);
        }

        const estPret = /essai|demo|d[ée]mo|pr[eê]t|gratuit|loan/i.test(texte + ' ' + titreDoc);
        return {
          configured: true, found: true, source: 'pennylane',
          vf_id: doc.id,
          numero: detail.invoice_number || detail.number || detail.label || numero,
          date_commande: dateCmd ? String(dateCmd).slice(0, 10) : null,
          distributeur: distrib || null,
          modele, quantite, lignes,
          num_serie: mSerie ? mSerie[0] : (lignes.find(l => l.num_serie) ? lignes.find(l => l.num_serie).num_serie : null),
          total_ht: lignes.reduce((s, l) => s + (l.prix || 0) * (l.quantite || 1), 0) || null,
          kind: endpoint.replace('/', ''),
          // Lien de consultation direct du document (public, sans connexion API)
          url_doc: detail.public_file_url || detail.file_url || detail.pdf_url || null,
          modele_demo: estPret,
          est_pret: estPret,
          // Formule déduite du sujet du document : "long terme" → long_terme, sinon essai_court
          formule: /long\s*terme/i.test(titreDoc + ' ' + texte) ? 'long_terme' : 'essai_court',
        };
      }
    } catch (e) {
      dbg.error = (e.response && e.response.status) ? `HTTP ${e.response.status}` : e.message;
    }
    debug.push(dbg);
  }

  suggestions.sort((a, b) => String(a.numero).localeCompare(String(b.numero)));
  return { configured: true, found: false, numero, suggestions: suggestions.slice(0, 10), debug };
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

// ── Suggestions de factures Pennylane à rattacher à une commande ────────────
// Renvoie les factures récentes du distributeur (ou correspondant au n° saisi),
// pour rattachement MANUEL (aucun lien automatique). Format aligné sur les
// suggestions VosFactures : { configured, factures:[{id,numero,date,montant_ttc,distributeur,num_serie}] }.
async function suggestFacturesPennylane(distributeurNom, numFacture) {
  const token = process.env.PENNYLANE_API_KEY || process.env.PENNYLANE_TOKEN;
  if (!token) return { configured: false, factures: [] };
  const api = plApi();
  const SERIE_RE = /\b(EL\d{6,}|A\d{2}L?\d{10,}|DE\d{2,}L?\d{10,}|T\d{2}\d{8,}|A\d{12,})\b/i;
  const mapDoc = (d) => {
    const cands = docNumberCandidates(d);
    const distrib = (d.customer && (d.customer.name || d.customer.company_name || d.customer.label))
                 || d.customer_name || (d.client && d.client.name) || null;
    return {
      id: d.id,
      numero: d.invoice_number || d.number || d.label || cands[0] || ('#' + d.id),
      date: (d.date || d.issue_date || d.emitted_at || d.created_at || '') ? String(d.date || d.issue_date || d.emitted_at || d.created_at).slice(0, 10) : null,
      montant_ttc: _plNum(d.currency_amount != null ? d.currency_amount : (d.amount != null ? d.amount : d.total_amount)),
      distributeur: distrib,
      num_serie: null,
    };
  };
  let docs = [];
  try {
    // 1) Recherche directe par numéro saisi (exact ou préfixe suffixé -1/-2/-3)
    if (numFacture) {
      const cibleN = _norm(numFacture);
      try {
        const { data } = await api.get('/customer_invoices', {
          params: { filter: JSON.stringify([{ field: 'invoice_number', operator: 'eq', value: numFacture }]), limit: 5 }
        });
        docs.push(...(data.items || data.customer_invoices || []));
      } catch (_) {}
      // Balayage limité pour capter les variantes de numéro
      if (!docs.length && cibleN.length >= 3) {
        let cursor = null;
        for (let pg = 0; pg < 3; pg++) {
          const { data: d } = await api.get('/customer_invoices', { params: { limit: 100, ...(cursor ? { cursor } : {}) } });
          const recents = d.items || d.customer_invoices || [];
          for (const rd of recents) {
            if (docNumberCandidates(rd).some(c => { const cn = _norm(c); return cn && cn.startsWith(cibleN); })) docs.push(rd);
          }
          cursor = d.next_cursor || null;
          if (!cursor || docs.length >= 10) break;
        }
      }
    }
    // 2) Sinon (ou en complément) : factures récentes du distributeur
    if (!docs.length && distributeurNom) {
      const cible = distributeurNom.toLowerCase().trim();
      const corr = c => {
        const n = (c.name || c.company_name || c.label || '').toLowerCase();
        return n && (n === cible || n.includes(cible.slice(0, 8)) || cible.includes(n.slice(0, 8)));
      };
      let customerId = null;
      try {
        const { data } = await api.get('/customers', {
          params: { filter: JSON.stringify([{ field: 'name', operator: 'start_with', value: distributeurNom.slice(0, 6) }]), limit: 20 }
        });
        const match = (data.items || []).find(corr);
        if (match) customerId = match.id;
      } catch (_) {}
      if (customerId) {
        try {
          const { data } = await api.get('/customer_invoices', {
            params: { filter: JSON.stringify([{ field: 'customer_id', operator: 'eq', value: customerId }]), limit: 15 }
          });
          docs.push(...(data.items || data.customer_invoices || []));
        } catch (_) {}
      }
    }
  } catch (e) {
    return { configured: true, factures: [], reason: (e.response && e.response.status) ? `HTTP ${e.response.status}` : e.message };
  }
  // Dédoublonne par id, limite à 10
  const seen = new Set();
  const factures = [];
  for (const d of docs) {
    if (seen.has(String(d.id))) continue;
    seen.add(String(d.id));
    factures.push(mapDoc(d));
    if (factures.length >= 10) break;
  }
  // Tente d'extraire un n° de série depuis les lignes de chaque facture
  for (const f of factures) {
    try {
      const { data: dl } = await api.get(`/customer_invoices/${f.id}/invoice_lines`);
      const lignes = dl.items || dl.invoice_lines || [];
      const texte = lignes.map(l => [l.label || '', l.description || '', l.serial_number || ''].join(' ')).join(' ');
      const m = texte.match(SERIE_RE);
      f.num_serie = m ? m[0].trim() : (lignes.find(l => l.serial_number) ? lignes.find(l => l.serial_number).serial_number : null);
    } catch (_) { f.num_serie = null; }
  }
  return { configured: true, factures };
}

// ── Synchro des DEVIS et BONS DE COMMANDE Pennylane vers la table `devis` ──────
// Miroir de la synchro VosFactures : mêmes fonctions ensuite (signature, relance,
// converti/ignoré). Les documents Pennylane sont dédupliqués sur `pennylane_id`.
async function upsertDevisPennylane(api, doc) {
  const ep = doc._ep || '/quotes';
  let detail = doc;
  if (!doc.invoice_lines && doc.id) {
    try {
      const { data } = await api.get(`${ep}/${doc.id}`);
      const full = data.quote || data.commercial_document || data.customer_invoice || data;
      if (full && typeof full === 'object') detail = Object.assign({}, doc, full);
    } catch (_) {}
  }
  if (!(detail.invoice_lines || detail.line_items || []).length && doc.id) {
    try { const { data: dl } = await api.get(`${ep}/${doc.id}/invoice_lines`); detail = { ...detail, invoice_lines: dl.items || dl.invoice_lines || [] }; } catch (_) {}
  }
  const numero = detail.invoice_number || detail.number || detail.label || String(detail.id);
  let nom = detail.customer?.name || detail.customer?.company_name || detail.customer_name || detail.client?.name || '';
  if (!nom) nom = await resolvePennylaneCustomerName(api, detail.customer || detail.client || (detail.customer_id ? { id: detail.customer_id } : null));
  const email = detail.customer?.billing_email || detail.customer?.email || detail.client?.email || null;
  const date = (detail.date || detail.issue_date || detail.emitted_at || detail.document_date || detail.created_at || '').slice(0, 10) || null;
  const dateExp = (detail.deadline || detail.expiry_date || detail.valid_until || detail.due_date || '').slice(0, 10) || null;
  const montant = _plNum(detail.currency_amount != null ? detail.currency_amount
                  : (detail.amount != null ? detail.amount
                  : (detail.total_amount != null ? detail.total_amount : detail.total))) || 0;
  const lignes = (detail.invoice_lines || detail.line_items || []).map(l => {
    const qte = parseInt(l.quantity) || 1;
    const prix = _plNum(l.raw_currency_unit_price != null ? l.raw_currency_unit_price
                 : (l.currency_price != null ? l.currency_price
                 : (l.unit_price != null ? l.unit_price : l.unit_amount)));
    const tot = _plNum(l.currency_amount != null ? l.currency_amount
                : (l.amount != null ? l.amount : (prix != null ? prix * qte : null)));
    return { nom: l.label || l.description || l.product_name || '', qte, prix, total: tot };
  }).filter(l => l.nom);
  const st = String(detail.status || detail.state || '').toLowerCase();
  const statut = /accept|validat|signed|paid|complet|convert/.test(st) ? 'converti'
               : /refus|reject|cancel|expir/.test(st) ? 'ignoré' : 'ouvert';
  const docType = doc._doc === 'bdc' ? 'bdc' : 'devis';
  const docUrl = detail.public_file_url || detail.file_url || detail.pdf_url || null;
  const plid = detail.id;

  const ex = await db.get('SELECT id FROM devis WHERE pennylane_id=$1', [plid]);
  if (ex) {
    await db.run(
      `UPDATE devis SET statut=CASE WHEN statut='ignoré' THEN 'ignoré' WHEN $1='converti' THEN 'converti' ELSE statut END,
        numero=$2, distributeur_nom=$3, client_email=$4, date_devis=$5, date_expiration=$6, montant=$7, devise=$8,
        lignes=$9, doc_type=$10, vf_statut=$11, doc_url=COALESCE($12, doc_url), updated_at=NOW() WHERE id=$13`,
      [statut, numero, nom, email, date, dateExp, montant, detail.currency || 'EUR', JSON.stringify(lignes), docType, st, docUrl, ex.id]);
    return 'updated';
  }
  await db.run(
    `INSERT INTO devis (source, pennylane_id, numero, distributeur_nom, client_email, date_devis, date_expiration,
       montant, devise, statut, vf_statut, lignes, doc_type, doc_url, updated_at)
     VALUES ('pennylane',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())`,
    [plid, numero, nom, email, date, dateExp, montant, detail.currency || 'EUR', statut, st, JSON.stringify(lignes), docType, docUrl]);
  return 'created';
}

// Récupère toutes les pages d'un endpoint SANS filtre serveur (le filtre V2 est
// peu fiable et renvoie souvent une liste vide) ; le filtrage par date se fait ensuite en JS.
async function _fetchNoFilter(api, endpoint) {
  try { return await fetchAllPages(api, endpoint, {}); }
  catch (e) { console.warn('  ⚠️ Pennylane ' + endpoint + ' indisponible: ' + ((e.response && e.response.status) ? 'HTTP ' + e.response.status : e.message)); return []; }
}
function _docDate(d) { return (d.date || d.issue_date || d.emitted_at || d.document_date || d.created_at || '').slice(0, 10); }

async function syncDevisPennylane(fullHistory = false) {
  const api = plApi();
  const cutoff = fullHistory ? null : (() => { const d = new Date(); d.setDate(d.getDate() - 120); return d.toISOString().slice(0, 10); })();
  const dateOK = d => { if (!cutoff) return true; const dd = _docDate(d); return !dd || dd >= cutoff; };

  const quotes = (await _fetchNoFilter(api, '/quotes')).filter(dateOK);
  let orders = (await _fetchNoFilter(api, '/commercial_documents')).filter(d =>
    dateOK(d) && (() => { const t = String(d.type || d.document_type || d.kind || '').toLowerCase(); return !t || /order|commande|purchase|bon/.test(t); })());

  const all = [
    ...quotes.map(d => ({ ...d, _ep: '/quotes', _doc: 'devis' })),
    ...orders.map(d => ({ ...d, _ep: '/commercial_documents', _doc: 'bdc' })),
  ];
  console.log(`  📄 Pennylane devis/BDC : ${quotes.length} devis + ${orders.length} BDC = ${all.length} document(s)`);
  let created = 0, updated = 0, skipped = 0;
  for (const doc of all) {
    try { const r = await upsertDevisPennylane(api, doc); if (r === 'created') created++; else if (r === 'updated') updated++; else skipped++; }
    catch (e) { console.warn('  ⚠️ Devis PL #' + doc.id + ' : ' + e.message); skipped++; }
  }
  return { ok: true, total: all.length, created, updated, skipped };
}

// Diagnostic : que renvoie réellement Pennylane sur chaque endpoint ?
async function debugDevisPennylane() {
  const api = plApi();
  const out = { base_url: BASE_URL };
  for (const ep of ['/quotes', '/commercial_documents', '/customer_invoices']) {
    const r = { ok: false };
    try {
      const { data } = await api.get(ep, { params: { limit: 5 } });
      const items = data.items || data.quotes || data.commercial_documents || data.customer_invoices || (Array.isArray(data) ? data : []);
      r.ok = true; r.count_page = items.length; r.has_more = data.has_more || false;
      r.top_keys = items[0] ? Object.keys(items[0]).slice(0, 40) : [];
      r.sample = items.slice(0, 3).map(x => ({
        id: x.id, number: x.invoice_number || x.number || x.label,
        status: x.status || x.state, date: _docDate(x),
        type: x.type || x.document_type || x.kind,
        amount: x.currency_amount || x.amount || x.total_amount,
        customer: (x.customer && (x.customer.name || x.customer.company_name)) || x.customer_name || null
      }));
    } catch (e) {
      r.error = (e.response && e.response.status)
        ? ('HTTP ' + e.response.status + ' — ' + JSON.stringify(e.response.data || '').slice(0, 300))
        : e.message;
    }
    out[ep] = r;
  }
  return out;
}

// Convertit le taux de TVA Pennylane (« FR_200 », « FR_55 », « 20.0 », « exempt »…) en nombre (%).
function _plVatToNumber(v) {
  if (v == null) return null;
  const s = String(v).trim().toUpperCase();
  if (!s) return null;
  if (/EXEMPT|EXO|NON_?APPLIC|ZERO/.test(s)) return 0;
  const m = s.match(/(\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  if (/^[A-Z]{2,}_?\d+$/.test(s)) return parseInt(m[1], 10) / 10;  // FR_200 → 20.0 ; FR_55 → 5.5
  return parseFloat(m[1].replace(',', '.'));
}

// ── Rapprochement du catalogue local avec les produits Pennylane (par référence) ──
// Remplit pl_product_id ; complète taux_tva et prix_ttc_public depuis Pennylane s'ils sont vides.
async function syncProduitsPennylane() {
  const api = plApi();
  const prods = await _fetchNoFilter(api, '/products');
  const byRef = new Map();
  const add = (k, p) => { const n = _norm(k); if (n && !byRef.has(n)) byRef.set(n, p); };
  for (const p of prods) { add(p.reference, p); add(p.external_reference, p); }
  const cat = await db.all('SELECT id, ref, ref_fournisseur, taux_tva, prix_ttc_public FROM catalogue');
  let matched = 0, tvaMaj = 0, ttcMaj = 0;
  for (const c of cat) {
    const p = byRef.get(_norm(c.ref)) || byRef.get(_norm(c.ref_fournisseur));
    if (!p) continue;
    matched++;
    const tva = _plVatToNumber(p.vat_rate);
    const ttc = _plNum(p.price);
    const sets = ['pl_product_id=$1'], vals = [p.id];
    if ((c.taux_tva == null || c.taux_tva === '') && tva != null) { vals.push(tva); sets.push(`taux_tva=$${vals.length}`); tvaMaj++; }
    if ((c.prix_ttc_public == null || c.prix_ttc_public === '') && ttc != null) { vals.push(ttc); sets.push(`prix_ttc_public=$${vals.length}`); ttcMaj++; }
    vals.push(c.id);
    await db.run(`UPDATE catalogue SET ${sets.join(',')}, updated_at=NOW() WHERE id=$${vals.length}`, vals);
  }
  console.log(`[PENNYLANE] produits : ${prods.length} côté Pennylane, ${matched} article(s) rapproché(s), TVA:${tvaMaj}, TTC:${ttcMaj}`);
  return { ok: true, produits_pennylane: prods.length, rapproches: matched, tva_maj: tvaMaj, ttc_maj: ttcMaj };
}

// Met à jour le statut d'un devis Pennylane (pending | accepted | denied | invoiced | expired).
async function setQuoteStatusPennylane(quoteId, status) {
  if (!quoteId) return { ok: false, reason: 'id manquant' };
  const api = plApi();
  const { data } = await api.put(`/quotes/${quoteId}/update_status`, { status }, { validateStatus: () => true });
  return { ok: true, data };
}

module.exports = {
  checkStatus,
  setQuoteStatusPennylane,
  syncCommandesPennylane,
  syncDevisPennylane,
  debugDevisPennylane,
  lookupDocumentPennylane,
  genererFacturePennylane,
  suggestFacturesPennylane,
  syncProduitsPennylane,
  plApi,
  BASE_URL,
};
