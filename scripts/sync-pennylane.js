/**
 * sync-pennylane.js
 * Synchronisation des commandes/devis depuis l'API Pennylane V2
 * Miroir fonctionnel de sync-vosfactures.js
 * 
 * Variables d'environnement requises :
 *   PENNYLANE_API_KEY   — Bearer token généré dans Pennylane > Paramètres > API
 *                         (PENNYLANE_TOKEN accepté en repli pour compatibilité)
 *   PENNYLANE_BASE_URL  — optionnel, défaut : https://app.pennylane.com/api/external/v2
 */

const axios = require('axios');
const db    = require('../server/db');

const BASE_URL = process.env.PENNYLANE_BASE_URL || 'https://app.pennylane.com/api/external/v2';

/**
 * Crée un client axios authentifié pour Pennylane V2
 */
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
    timeout: 15000,
  });
}

/**
 * Vérifie que le token est valide.
 * L'API v2 n'expose pas d'endpoint /me fiable : on valide le token
 * en appelant une liste légère (une seule facture). Un 200 = token OK ;
 * un 401/403 lève une erreur (badge « Erreur » côté interface).
 */
async function checkStatus() {
  const api = plApi();
  const { data } = await api.get('/customer_invoices', { params: { limit: 1 } });
  const exemple = (data.items || [])[0] || null;
  return { ok: true, account: { verifie: true, exemple_numero: exemple ? (exemple.invoice_number || exemple.number || null) : null } };
}

/**
 * Récupère toutes les pages d'un endpoint paginé (cursor-based)
 */
async function fetchAllPages(api, endpoint, params = {}, limit = 100) {
  const results = [];
  let cursor = null;
  let hasMore = true;
  let pages = 0;

  while (hasMore && pages < 200) {
    pages++;
    // IMPORTANT (pagination v2) : filter/sort doivent être renvoyés à chaque page.
    const p = { ...params, limit, ...(cursor ? { cursor } : {}) };
    const { data } = await api.get(endpoint, { params: p });

    // Pennylane V2 retourne { items: [...], has_more: bool, next_cursor: "..." }
    const items = data.items || data.quotes || data.commercial_documents || data.customer_invoices || [];
    results.push(...items);

    hasMore = data.has_more || false;
    cursor  = data.next_cursor || null;
    if (!cursor) hasMore = false;
  }
  return results;
}

// Résout le nom d'un client Pennylane (l'objet customer d'une liste ne contient
// parfois que l'id). Cache local pour éviter les appels répétés.
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

/**
 * Synchronise les devis et bons de commande depuis Pennylane
 * Équivalent de syncCommandesVF() pour VosFactures
 * 
 * @param {boolean} fullHistory - si true, récupère tout l'historique ; sinon 90 derniers jours
 */
async function syncCommandesPennylane(fullHistory = false) {
  const api   = plApi();
  const client = await db.pool.connect();
  let created = 0, updated = 0, skipped = 0;

  try {
    const dateFilter = fullHistory ? null : (() => {
      const d = new Date();
      d.setDate(d.getDate() - 90);
      return d.toISOString().slice(0, 10);
    })();

    // Filtre v2 : tableau JSON [{field, operator, value}]. Opérateurs valides :
    // eq, not_eq, lt, lteq, gt, gteq, in, not_in, start_with.
    const buildFilter = (extra = []) => {
      const filters = [...extra];
      if (dateFilter) filters.push({ field: 'date', operator: 'gteq', value: dateFilter });
      return filters.length ? JSON.stringify(filters) : undefined;
    };

    // ─── 1. Devis (= BDC / Devis clients) ───────────────────────────────────
    const quotes = await fetchAllPages(api, '/quotes', { filter: buildFilter() });

    // ─── 2. Documents commerciaux (bons de commande) ─────────────────────────
    // On récupère par date puis on ne garde que les bons de commande côté client
    // (le champ/valeur exact du type varie selon le compte).
    let commercialDocs = [];
    try {
      const docs = await fetchAllPages(api, '/commercial_documents', { filter: buildFilter() });
      commercialDocs = docs.filter(d => {
        const t = String(d.type || d.document_type || d.kind || '').toLowerCase();
        return !t || /order|commande|purchase/.test(t);
      });
    } catch(e) {
      // L'endpoint peut ne pas exister selon la version — on continue sans
      console.warn('  ⚠️ commercial_documents non disponible:', e.message);
    }

    const allDocs = [
      ...quotes.map(d => ({ ...d, _ep: '/quotes' })),
      ...commercialDocs.map(d => ({ ...d, _ep: '/commercial_documents' })),
    ];
    console.log(`  📄 ${allDocs.length} document(s) récupéré(s) depuis Pennylane`);

    for (const doc of allDocs) {
      try {
        await traiterDocumentPennylane(client, api, doc, { created, updated, skipped });
      } catch (e) {
        console.warn(`  ⚠️ Doc Pennylane #${doc.id} : ${e.message}`);
        skipped++;
      }
    }

    return `Pennylane sync: ${created} créées, ${updated} mises à jour, ${skipped} ignorées`;
  } finally {
    client.release();
  }
}

/**
 * Traite un document Pennylane (devis ou bon de commande) et l'upsert en DB
 */
async function traiterDocumentPennylane(client, api, doc, counters) {
  // Récupérer les détails complets si nécessaire (lignes)
  const ep = doc._ep || '/quotes';
  let detail = doc;
  if (!doc.invoice_lines && doc.id) {
    try {
      const { data } = await api.get(`${ep}/${doc.id}`);
      detail = data.quote || data.commercial_document || data;
    } catch(_) { detail = doc; }
  }
  // Lignes via le sous-endpoint dédié si toujours absentes
  if (!(detail.invoice_lines || detail.line_items || []).length && doc.id) {
    try {
      const { data: dl } = await api.get(`${ep}/${doc.id}/invoice_lines`);
      detail = { ...detail, invoice_lines: dl.items || dl.invoice_lines || [] };
    } catch(_) {}
  }

  const numero       = detail.invoice_number || detail.number || String(detail.id);
  const nomDistrib   = detail.customer?.name || detail.customer_name || await resolvePennylaneCustomerName(api, detail.customer);
  if (!nomDistrib) { counters.skipped++; return; }

  const dateCommande = (detail.date || detail.created_at || '').slice(0, 10) || null;
  const annee        = dateCommande ? parseInt(dateCommande.slice(0, 4)) : new Date().getFullYear();

  // Lignes d'articles
  const lignes = (detail.invoice_lines || detail.line_items || []).map(l => ({
    designation: l.label || l.description || l.product_name || '',
    reference:   l.product?.reference || l.reference || null,
    quantite:    parseInt(l.quantity) || 1,
  })).filter(l => l.designation);

  // Modèle principal (première ligne Eloflex ou première ligne)
  const ligneFauteuil = lignes.find(l => /eloflex/i.test(l.designation)) || lignes[0];
  const modele        = ligneFauteuil?.designation || '';
  const quantite      = ligneFauteuil?.quantite || 1;

  // Détection numéro de série
  const texte   = lignes.map(l => l.designation).join(' ');
  const mSerie  = texte.match(/\b(EL\d{6,}|A\d{2}L?\d{10,}|DE\d{2,}L?\d{10,}|T\d{2}\d{8,}|A\d{12,})\b/i);
  const numSerie = mSerie ? mSerie[0] : null;

  // Trouver ou créer le client
  const nomNorm = nomDistrib.toLowerCase().trim();
  let clientRow = await client.query(
    'SELECT id FROM clients WHERE LOWER(TRIM(nom)) = $1 LIMIT 1', [nomNorm]
  );
  let clientId;
  if (clientRow.rows.length) {
    clientId = clientRow.rows[0].id;
  } else {
    const emails = detail.customer?.billing_email ? [detail.customer.billing_email] : [];
    const ins = await client.query(
      `INSERT INTO clients (nom, email, type, token_portail)
       VALUES ($1, $2, 'Distributeur', md5(random()::text)) RETURNING id`,
      [nomDistrib, emails[0] || null]
    );
    clientId = ins.rows[0].id;
  }

  // Chercher fauteuil lié par série
  let fauteuilId = null;
  if (numSerie) {
    const fr = await client.query('SELECT id FROM fauteuils WHERE serie = $1', [numSerie]);
    if (fr.rows.length) fauteuilId = fr.rows[0].id;
  }

  // pennylane_id stocké dans vf_commande_id (même colonne, intégration interchangeable)
  const pennylaneId = detail.id;

  // Anti-doublon par BDC + distributeur (commandes importées Excel sans pennylane_id)
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

  // Upsert standard
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
    [clientId, fauteuilId, annee, nomDistrib, modele, quantite,
     numero, dateCommande, numSerie, pennylaneId]
  );

  // Upsert des lignes si nouvelles
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

/**
 * Recherche un document Pennylane par numéro (devis, facture, bon de commande…)
 * Équivalent du bdc-lookup VosFactures
 */
async function lookupDocumentPennylane(numero) {
  const api = plApi();

  const numLow = numero.toLowerCase();
  const matchNum = d => String(d.invoice_number || d.number || '').toLowerCase() === numLow;

  // Essai dans quotes (devis), puis factures, puis documents commerciaux
  for (const endpoint of ['/quotes', '/customer_invoices', '/commercial_documents']) {
    try {
      // 1) Tentative filtrée par numéro (rapide si le champ est indexé)
      let items = [];
      try {
        const { data } = await api.get(endpoint, {
          params: {
            filter: JSON.stringify([{ field: 'invoice_number', operator: 'eq', value: numero }]),
            limit: 5,
          }
        });
        items = data.items || data.quotes || data.customer_invoices || data.commercial_documents || [];
      } catch (_) { items = []; }

      // 2) Repli : si le filtre ne renvoie rien, on balaie les documents récents
      //    (2 pages max = 200 documents) pour rester léger sur une recherche unitaire.
      let doc = items.find(matchNum);
      if (!doc) {
        try {
          let cursor = null;
          for (let pg = 0; pg < 2 && !doc; pg++) {
            const { data: d } = await api.get(endpoint, { params: { limit: 100, ...(cursor ? { cursor } : {}) } });
            const recents = d.items || d.quotes || d.customer_invoices || d.commercial_documents || [];
            doc = recents.find(matchNum);
            cursor = d.next_cursor || null;
            if (!cursor) break;
          }
        } catch (_) {}
      }
      if (doc) {
        // Charger les détails complets
        const baseType = endpoint.replace('/', '').replace('s', ''); // quotes→quote
        let detail = doc;
        try {
          const { data: d2 } = await api.get(`${endpoint}/${doc.id}`);
          detail = d2.quote || d2.customer_invoice || d2.commercial_document || d2 || doc;
        } catch(_) {}

        // Les lignes ne sont pas toujours incluses dans le détail :
        // repli sur le sous-endpoint dédié /…/{id}/invoice_lines.
        let rawLignes = detail.invoice_lines || detail.line_items || [];
        if (!rawLignes.length && doc.id) {
          try {
            const { data: dl } = await api.get(`${endpoint}/${doc.id}/invoice_lines`);
            rawLignes = dl.items || dl.invoice_lines || [];
          } catch(_) {}
        }
        const lignes = rawLignes
          .filter(l => l.label || l.description)
          .map(l => ({
            designation:    l.label || l.description || '',
            designation_en: l.product?.reference || l.label || '',
            reference:      l.product?.reference || null,
            quantite:       parseInt(l.quantity) || 1,
          }));

        const ligneFauteuil = lignes.find(l => /eloflex/i.test(l.designation)) || lignes[0];
        const modele   = ligneFauteuil?.designation || '';
        const quantite = ligneFauteuil?.quantite || 1;

        const texte  = lignes.map(l => l.designation).join(' ');
        const mSerie = texte.match(/\b(EL\d{6,}|A\d{2}L?\d{10,}|DE\d{2,}L?\d{10,}|T\d{2}\d{8,}|A\d{12,})\b/i);

        const modeleDemo = /essai|demo|d[ée]mo|pr[eê]t/i.test(texte);

        return {
          configured: true,
          found:      true,
          source:     'pennylane',
          vf_id:      doc.id,
          numero:     detail.invoice_number || numero,
          date_commande: (detail.date || detail.created_at || '').slice(0, 10) || null,
          distributeur:  (detail.customer?.name || detail.customer_name || await resolvePennylaneCustomerName(api, detail.customer)) || null,
          modele,
          quantite,
          lignes,
          num_serie:  mSerie ? mSerie[0] : null,
          kind:       endpoint.replace('/', ''),
          modele_demo: modeleDemo,
        };
      }
    } catch(e) {
      // endpoint non disponible, on essaie le suivant
    }
  }

  return { configured: true, found: false };
}

/**
 * Crée une facture client dans Pennylane depuis une commande
 */
async function genererFacturePennylane(cmd, lignes) {
  const api = plApi();

  // 1. Trouver le client dans Pennylane
  // (l'API v2 n'a pas d'opérateur "contains" ; on tente start_with puis on
  //  balaie quelques pages en repli, avec correspondance côté serveur.)
  let customerId = null;
  const cible = (cmd.distributeur_nom || '').toLowerCase().trim();
  const corr = c => {
    const n = (c.name || c.company_name || c.label || '').toLowerCase();
    return n && (n === cible || n.includes(cible.slice(0, 8)) || cible.includes(n.slice(0, 8)));
  };
  try {
    const { data } = await api.get('/customers', {
      params: {
        filter: JSON.stringify([{ field: 'name', operator: 'start_with', value: cmd.distributeur_nom.slice(0, 6) }]),
        limit: 20,
      }
    });
    const match = (data.items || []).find(corr);
    if (match) customerId = match.id;
  } catch(_) {}
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
    } catch(_) {}
  }

  const today = new Date().toISOString().slice(0, 10);

  // 2. Créer la facture (draft pour que tu puisses la vérifier avant envoi)
  const payload = {
    customer_id: customerId,
    date:        cmd.date_livraison || today,
    deadline:    (() => { const d = new Date(); d.setDate(d.getDate() + 30); return d.toISOString().slice(0, 10); })(),
    draft:       true, // brouillon — tu finalises dans Pennylane
    external_reference: cmd.bdc || `SAV-${cmd.id}`,
    invoice_lines: (lignes.length ? lignes : [{
      label: cmd.modele || 'Commande Éloflex',
      quantity: String(cmd.quantite || 1),
      raw_currency_unit_price: '0.00',
      vat_rate: 'FR_200',
    }]).map(l => ({
      label:    l.designation || l.label || 'Article',
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
