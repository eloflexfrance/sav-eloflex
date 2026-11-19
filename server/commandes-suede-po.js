// server/commandes-suede-po.js
// ─────────────────────────────────────────────────────────────────────────────
// Bons de commande (Purchase Orders) vers Eloflex AB — créés dans l'appli, sans VosFactures.
//  Cycle : brouillon → validée (Brice, Lyes, Frédéric ou Olivier) → envoyée (PDF par e-mail à
//          order@eloflex.se, copie sav@eloflex.fr) → expédiée (date d'envoi + suivi UPS / DSV
//          confirmés par la Suède) → livrée → réceptionnée (intégration au stock, route existante).
//  Traçabilité : créé par, validé par / le, envoyé par / le / à, historique JSON.
//  Options : référence commande client (n° imposé par un distributeur), adresse de livraison
//            complète (téléphone + e-mail), affichage ou non des prix (EUR) sur le PDF.
//  Les anciennes commandes importées de VosFactures (etape NULL) restent gérées comme avant.
// ─────────────────────────────────────────────────────────────────────────────
const TO_SUEDE = 'order@eloflex.se';
const CC_SAV = 'sav@eloflex.fr';
const VALIDATEURS_DEFAUT = 'brice, lyes, frederic, olivier';
const ACCES_ECLATES_DEFAUT = 'brice, frederic, lyes, linnea, olivier';
const ADR_LAGORD = 'Éloflex France\n41 rue des Maraichers\n17140 LAGORD';
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const esc = x => String(x == null ? '' : x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const isoJ = d => !d ? null : (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
const txt = (v, n = 500) => { const s = String(v == null ? '' : v).trim(); return s ? s.slice(0, n) : null; };
const nomU = u => (u && (u.nom || u.email)) || null;

let _ok = false;
async function assurer(db) {
  if (_ok) return;
  for (const c of ['etape TEXT', 'reference_client TEXT', 'client_id INTEGER', 'livraison_type TEXT', 'livraison_nom TEXT',
    'livraison_contact TEXT', 'livraison_adresse TEXT', 'livraison_pays TEXT', 'livraison_tel TEXT', 'livraison_email TEXT',
    'afficher_prix BOOLEAN DEFAULT FALSE', 'notes TEXT', 'cree_par TEXT', 'valide_par TEXT', 'valide_le TIMESTAMPTZ',
    'envoye_par TEXT', 'envoye_le TIMESTAMPTZ', 'envoye_a TEXT', 'date_expedition DATE', 'historique JSONB', 'devis_pennylane TEXT'])
    await db.run(`ALTER TABLE commandes_suede ADD COLUMN IF NOT EXISTS ${c}`);
  for (const c of ['prix_unitaire NUMERIC(12,2)', 'ref_fournisseur TEXT', 'note TEXT'])
    await db.run(`ALTER TABLE commandes_suede_lignes ADD COLUMN IF NOT EXISTS ${c}`);
  // Éclatés : article commandé par « Commander ce fauteuil » (réglé par l'administrateur)
  for (const c of ['cmd_catalogue_id INTEGER', 'cmd_reference TEXT', 'cmd_designation TEXT', 'cmd_note TEXT'])
    await db.run(`ALTER TABLE eclates_modeles ADD COLUMN IF NOT EXISTS ${c}`).catch(() => {});
  await db.run(`CREATE TABLE IF NOT EXISTS documents_signes (
    id SERIAL PRIMARY KEY, objet TEXT NOT NULL, objet_id INTEGER NOT NULL,
    nom TEXT, mime TEXT, taille INTEGER, data TEXT NOT NULL, ajoute_par INTEGER, created_at TIMESTAMPTZ DEFAULT NOW())`);
  _ok = true;
}
async function param(db, cle, defaut) {
  const r = await db.get('SELECT valeur FROM parametres WHERE cle=$1', [cle]).catch(() => null);
  return r && r.valeur != null && String(r.valeur).trim() !== '' ? r.valeur : defaut;
}
async function setParam(db, cle, valeur) {
  const ex = await db.get('SELECT cle FROM parametres WHERE cle=$1', [cle]);
  if (ex) await db.run('UPDATE parametres SET valeur=$1 WHERE cle=$2', [valeur, cle]);
  else await db.run('INSERT INTO parametres (cle, valeur) VALUES ($1,$2)', [cle, valeur]);
}

// Validateurs : prénoms (ou e-mails) de la liste « validateurs_commande_suede » (paramètre modifiable).
// Un utilisateur est reconnu par un mot de son nom ou par le début de son e-mail (accents ignorés).
async function listeValidateurs(db) {
  return String(await param(db, 'validateurs_commande_suede', VALIDATEURS_DEFAUT)).split(/[,;\n]+/).map(norm).filter(Boolean);
}
function estValidateur(user, liste) {
  if (!user) return false;
  const mots = norm(user.nom).split(/[\s.\-_']+/).filter(Boolean);
  const mail = norm(user.email), local = mail.split('@')[0];
  return liste.some(v => v.includes('@') ? v === mail : (mots.includes(v) || local === v || local.split(/[.\-_]/)[0] === v));
}

async function prochainNumero(db) {
  const an = new Date().getFullYear(), pre = `PO-FR-${an}-`;
  const r = await db.get(`SELECT MAX(NULLIF(regexp_replace(substr(numero_bc, $2), '\\D', '', 'g'), '')::int) AS n
    FROM commandes_suede WHERE numero_bc LIKE $1`, [pre + '%', pre.length + 1]);
  return pre + String(((r && r.n) || 0) + 1).padStart(3, '0');
}

async function lire(db, id) {
  const cs = await db.get('SELECT * FROM commandes_suede WHERE id=$1', [id]);
  if (!cs) return null;
  for (const k of ['date_commande', 'date_livraison', 'date_expedition']) cs[k] = isoJ(cs[k]);
  cs.lignes = await db.all(`SELECT l.*, c.ref AS catalogue_ref_actuelle, c.designation AS catalogue_designation_actuelle, c.stock AS catalogue_stock_actuel
    FROM commandes_suede_lignes l LEFT JOIN catalogue c ON c.id=l.catalogue_id WHERE l.commande_id=$1 ORDER BY l.ordre, l.id`, [id]);
  return cs;
}

// Ce qui manque pour valider / envoyer
function manques(cs) {
  const m = [];
  if (!cs.lignes || !cs.lignes.length) m.push('au moins une ligne');
  if (!cs.livraison_nom) m.push('le nom du destinataire');
  if (!cs.livraison_adresse) m.push("l'adresse de livraison");
  if (!cs.livraison_tel) m.push('le téléphone de livraison');
  if (!cs.livraison_email) m.push("l'e-mail de livraison");
  return m;
}

module.exports = function monterPO(router, { db, adminOrOp, envoyerEmailPret, SIGNATURE_EMAIL_HTML }) {
  assurer(db).catch(e => console.error('[COMMANDE SUEDE PO]', e.message));
  const histo = async (id, user, action, detail) => {
    const h = JSON.stringify([{ date: new Date().toISOString(), par: nomU(user), action, ...(detail ? { detail } : {}) }]);
    await db.run(`UPDATE commandes_suede SET historique=COALESCE(historique,'[]'::jsonb) || $2::jsonb WHERE id=$1`, [id, h]);
  };

  // En-tête + lignes envoyés par le formulaire (création et modification)
  async function ecrire(pg, id, b) {
    await pg.query(`UPDATE commandes_suede SET reference_client=$2, client_id=$3, livraison_type=$4, livraison_nom=$5, livraison_contact=$6,
        livraison_adresse=$7, livraison_pays=$8, livraison_tel=$9, livraison_email=$10, afficher_prix=$11, notes=$12,
        date_commande=COALESCE($13::date, date_commande), updated_at=NOW() WHERE id=$1`,
      [id, txt(b.reference_client, 120), parseInt(b.client_id) || null, txt(b.livraison_type, 20), txt(b.livraison_nom, 200), txt(b.livraison_contact, 200),
        txt(b.livraison_adresse, 600), txt(b.livraison_pays, 80) || 'France', txt(b.livraison_tel, 60), txt(b.livraison_email, 200),
        !!b.afficher_prix, txt(b.notes, 3000), ISO.test(String(b.date_commande || '')) ? b.date_commande : null]);
    await pg.query('DELETE FROM commandes_suede_lignes WHERE commande_id=$1', [id]);
    let ordre = 0;
    for (const l of (Array.isArray(b.lignes) ? b.lignes : [])) {
      const q = parseInt(l.quantite) || 0;
      if (q <= 0 || !(txt(l.designation) || txt(l.reference))) continue;
      const px = l.prix_unitaire === '' || l.prix_unitaire == null ? null : Number(String(l.prix_unitaire).replace(',', '.'));
      await pg.query(`INSERT INTO commandes_suede_lignes (commande_id, catalogue_id, reference, ref_fournisseur, designation, note, quantite_commandee, prix_unitaire, ordre)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, parseInt(l.catalogue_id) || null, txt(l.reference, 80), txt(l.ref_fournisseur, 80), txt(l.designation, 300) || txt(l.reference, 80),
          txt(l.note, 600), q, isFinite(px) ? px : null, ordre++]);
    }
  }
  // Mémorise les coordonnées de livraison Lagord / Paris pour les prochaines commandes
  async function memoriser(b) {
    if (!['lagord', 'paris'].includes(b.livraison_type)) return;
    await setParam(db, 'po_suede_livraison_' + b.livraison_type, JSON.stringify({
      nom: txt(b.livraison_nom, 200), contact: txt(b.livraison_contact, 200), adresse: txt(b.livraison_adresse, 600),
      pays: txt(b.livraison_pays, 80), tel: txt(b.livraison_tel, 60), email: txt(b.livraison_email, 200) }));
  }

  router.get('/commandes-suede-po/config', async (req, res) => {
    try {
      await assurer(db);
      const liste = await listeValidateurs(db);
      const users = await db.all(`SELECT nom, email FROM users WHERE actif IS NOT FALSE ORDER BY nom`);
      const preset = async (type, adrDefaut) => {
        let p = {}; try { p = JSON.parse(await param(db, 'po_suede_livraison_' + type, '{}')) || {}; } catch (_) { p = {}; }
        const adr = p.adresse || adrDefaut || '';
        const lignes = adr.split('\n'), nom = p.nom || lignes[0] || '';
        return { nom, contact: p.contact || '', adresse: p.adresse || lignes.slice(1).join('\n'), pays: p.pays || 'France', tel: p.tel || '', email: p.email || CC_SAV };
      };
      res.json({
        to: TO_SUEDE, cc: CC_SAV,
        peut_valider: estValidateur(res.locals.user, liste),
        validateurs: users.filter(u => estValidateur(u, liste)).map(u => u.nom),
        validateurs_liste: liste,
        prochain_numero: await prochainNumero(db),
        presets: {
          lagord: await preset('lagord', await param(db, 'transfert_adresse_lagord', ADR_LAGORD)),
          paris: await preset('paris', await param(db, 'transfert_adresse_paris', 'Éloflex France — Paris\n')),
        },
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Depuis les éclatés : ajouter un fauteuil ou une pièce à un bon de commande Suède ──
  // Réservé aux personnes de la liste « acces_bc_eclates » (Brice, Frédéric, Lyes, Linnea, Olivier par défaut).
  const listeEclates = async () => String(await param(db, 'acces_bc_eclates', ACCES_ECLATES_DEFAUT)).split(/[,;\n]+/).map(norm).filter(Boolean);
  router.get('/eclates-bc-suede', async (req, res) => {
    try {
      await assurer(db);
      if (!estValidateur(res.locals.user, await listeEclates())) return res.json({ autorise: false });
      const en_attente = await db.all(`SELECT cs.id, cs.numero_bc, cs.etape, cs.reference_client, cs.livraison_nom, cs.cree_par, cs.created_at,
          (SELECT COUNT(*)::int FROM commandes_suede_lignes l WHERE l.commande_id=cs.id) AS nb_lignes,
          (SELECT COALESCE(SUM(quantite_commandee),0)::int FROM commandes_suede_lignes l WHERE l.commande_id=cs.id) AS nb_articles
        FROM commandes_suede cs WHERE cs.etape IN ('brouillon','validee') ORDER BY cs.updated_at DESC NULLS LAST, cs.id DESC LIMIT 15`);
      const modeles = {};
      try {
        for (const m of await db.all(`SELECT m.id, m.cmd_catalogue_id, m.cmd_reference, m.cmd_designation, m.cmd_note, c.ref AS cat_ref, c.designation AS cat_designation
            FROM eclates_modeles m LEFT JOIN catalogue c ON c.id=m.cmd_catalogue_id
            WHERE m.cmd_catalogue_id IS NOT NULL OR COALESCE(m.cmd_reference,'')<>'' OR COALESCE(m.cmd_designation,'')<>'' OR COALESCE(m.cmd_note,'')<>''`))
          modeles[m.id] = { catalogue_id: m.cmd_catalogue_id, reference: m.cmd_reference || m.cat_ref || '', designation: m.cmd_designation || m.cat_designation || '', note: m.cmd_note || '' };
      } catch (_) {}
      res.json({ autorise: true, admin: (res.locals.user || {}).role === 'admin', modeles, en_attente, prochain_numero: await prochainNumero(db) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Article commandé par « Commander ce fauteuil » pour un modèle d'éclaté — administrateur uniquement
  router.put('/eclates-bc-suede/modele/:id', async (req, res) => {
    try {
      await assurer(db);
      if ((res.locals.user || {}).role !== 'admin') return res.status(403).json({ error: 'Réservé à l’administrateur' });
      const b = req.body || {};
      const r = await db.get(`UPDATE eclates_modeles SET cmd_catalogue_id=$2, cmd_reference=$3, cmd_designation=$4, cmd_note=$5, updated_at=NOW() WHERE id=$1 RETURNING id`,
        [req.params.id, parseInt(b.catalogue_id) || null, txt(b.reference, 80), txt(b.designation, 300), txt(b.note, 600)]);
      if (!r) return res.status(404).json({ error: 'Modèle introuvable' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // { commande_id (vide = nouveau bon), lignes:[{ catalogue_id, reference, designation, note, quantite }] }
  router.post('/eclates-bc-suede/ajouter', async (req, res) => {
    await assurer(db);
    const u = res.locals.user, b = req.body || {};
    if (!estValidateur(u, await listeEclates())) return res.status(403).json({ error: 'Réservé à Brice, Frédéric, Lyes, Linnea et Olivier.' });
    const lignes = (Array.isArray(b.lignes) ? b.lignes : []).filter(l => (parseInt(l.quantite) || 0) > 0 && (txt(l.designation) || txt(l.reference)));
    if (!lignes.length) return res.status(400).json({ error: 'Rien à ajouter' });
    const pg = await db.pool.connect();
    try {
      await pg.query('BEGIN');
      let id = parseInt(b.commande_id) || null, numero, nouveau = false, revalider = false;
      if (id) {
        const { rows: [cs] } = await pg.query('SELECT id, numero_bc, etape FROM commandes_suede WHERE id=$1 FOR UPDATE', [id]);
        if (!cs) { await pg.query('ROLLBACK'); return res.status(404).json({ error: 'Bon de commande introuvable' }); }
        if (!['brouillon', 'validee'].includes(cs.etape)) { await pg.query('ROLLBACK'); return res.status(409).json({ error: `Le bon ${cs.numero_bc} est déjà envoyé : choisissez-en un autre ou créez-en un nouveau.` }); }
        numero = cs.numero_bc;
        if (cs.etape === 'validee') { revalider = true; await pg.query(`UPDATE commandes_suede SET etape='brouillon', valide_par=NULL, valide_le=NULL WHERE id=$1`, [id]); }
      } else {
        numero = await prochainNumero(db); nouveau = true;
        let p = {}; try { p = JSON.parse(await param(db, 'po_suede_livraison_lagord', '{}')) || {}; } catch (_) { p = {}; }
        const adr = String(p.adresse ? (p.nom || '') + '\n' + p.adresse : await param(db, 'transfert_adresse_lagord', ADR_LAGORD)).split('\n');
        const { rows: [cs] } = await pg.query(`INSERT INTO commandes_suede (numero_bc, fournisseur, statut, etape, cree_par, date_commande, livraison_type,
            livraison_nom, livraison_contact, livraison_adresse, livraison_pays, livraison_tel, livraison_email)
          VALUES ($1,'Eloflex AB','En cours','brouillon',$2,CURRENT_DATE,'lagord',$3,$4,$5,$6,$7,$8) RETURNING id`,
          [numero, nomU(u), adr[0] || 'Éloflex France', p.contact || null, adr.slice(1).join('\n') || null, p.pays || 'France', p.tel || null, p.email || CC_SAV]);
        id = cs.id;
      }
      const { rows: [mx] } = await pg.query('SELECT COALESCE(MAX(ordre),-1)+1 AS o FROM commandes_suede_lignes WHERE commande_id=$1', [id]);
      let ordre = mx.o;
      for (const l of lignes) {
        const q = parseInt(l.quantite) || 1, note = txt(l.note, 600);
        // Rattachement au catalogue (id fourni, sinon référence identique sans espaces ni tirets)
        let cat = null;
        if (parseInt(l.catalogue_id)) cat = (await pg.query('SELECT id, ref, designation, ref_fournisseur, prix_achat_suede FROM catalogue WHERE id=$1', [parseInt(l.catalogue_id)])).rows[0] || null;
        if (!cat && txt(l.reference)) cat = (await pg.query(`SELECT id, ref, designation, ref_fournisseur, prix_achat_suede FROM catalogue
            WHERE upper(regexp_replace(ref, '[^A-Za-z0-9]', '', 'g')) = upper(regexp_replace($1, '[^A-Za-z0-9]', '', 'g')) LIMIT 1`, [txt(l.reference)])).rows[0] || null;
        const ref = cat ? cat.ref : txt(l.reference, 80);
        // Même article déjà présent sans configuration particulière → on augmente la quantité
        const ex = !note && (await pg.query(`SELECT id FROM commandes_suede_lignes WHERE commande_id=$1 AND COALESCE(note,'')='' AND
            ${cat ? 'catalogue_id=$2' : "catalogue_id IS NULL AND upper(COALESCE(reference,''))=upper($2)"} LIMIT 1`, [id, cat ? cat.id : (ref || '')])).rows[0];
        if (ex && (cat || ref)) await pg.query('UPDATE commandes_suede_lignes SET quantite_commandee=quantite_commandee+$1 WHERE id=$2', [q, ex.id]);
        else await pg.query(`INSERT INTO commandes_suede_lignes (commande_id, catalogue_id, reference, ref_fournisseur, designation, note, quantite_commandee, prix_unitaire, ordre)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [id, cat ? cat.id : null, ref, cat ? cat.ref_fournisseur : null, txt(l.designation, 300) || (cat && cat.designation) || ref, note, q,
            cat && cat.prix_achat_suede != null ? cat.prix_achat_suede : null, ordre++]);
      }
      await pg.query('UPDATE commandes_suede SET updated_at=NOW() WHERE id=$1', [id]);
      await pg.query('COMMIT');
      await histo(id, u, nouveau ? 'création depuis les éclatés' : 'ajout depuis les éclatés' + (revalider ? ' (validation annulée)' : ''),
        lignes.map(l => `${parseInt(l.quantite) || 1} × ${txt(l.reference) || txt(l.designation)}`).join(', ').slice(0, 300));
      res.json({ ok: true, id, numero_bc: numero, nouveau, revalider });
    } catch (e) { await pg.query('ROLLBACK').catch(() => {}); res.status(500).json({ error: e.message }); }
    finally { pg.release(); }
  });

  // Aperçu du devis Pennylane (PDF relayé par le serveur, pour l'afficher à côté du bon de commande)
  const _pdfCache = new Map();
  router.get('/commandes-suede-po/devis-pdf', async (req, res) => {
    try {
      const numero = String(req.query.numero || '').trim();
      if (!numero) return res.status(400).send('Numéro de devis manquant');
      if (!(process.env.PENNYLANE_API_KEY || process.env.PENNYLANE_TOKEN)) return res.status(400).send('Pennylane non configuré');
      const c = _pdfCache.get(numero.toUpperCase());
      let buf = c && Date.now() - c.t < 10 * 60 * 1000 ? c.buf : null;
      if (!buf) {
        const r = await require('../scripts/sync-pennylane').lookupDocumentPennylane(numero);
        if (!r || !r.found) return res.status(404).send(`Devis ${numero} introuvable dans Pennylane`);
        if (!r.url_doc) return res.status(404).send('Pennylane ne fournit pas de PDF pour ce devis');
        const axios = require('axios');
        const d = await axios.get(r.url_doc, { responseType: 'arraybuffer', timeout: 25000, maxRedirects: 5, validateStatus: () => true,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EloflexSAV/1.0)', Accept: 'application/pdf,*/*' } });
        buf = Buffer.from(d.data);
        if (buf.slice(0, 5).toString('latin1') !== '%PDF-') return res.status(502).send('Le document renvoyé par Pennylane n’est pas un PDF');
        _pdfCache.set(numero.toUpperCase(), { t: Date.now(), buf });
        if (_pdfCache.size > 30) _pdfCache.delete(_pdfCache.keys().next().value);
      }
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${numero.replace(/[^\w.\-]+/g, '_')}.pdf"`);
      res.send(buf);
    } catch (e) { res.status(500).send(e.message); }
  });

  router.get('/commandes-suede-po/:id', async (req, res) => {
    try {
      await assurer(db);
      const cs = await lire(db, req.params.id);
      if (!cs) return res.status(404).json({ error: 'Introuvable' });
      cs.pdfs = await db.all(`SELECT id, nom, taille, created_at FROM documents_signes WHERE objet='commande_suede' AND objet_id=$1 ORDER BY created_at DESC`, [cs.id]);
      cs.manques = manques(cs);
      res.json(cs);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/commandes-suede-po', adminOrOp, async (req, res) => {
    await assurer(db);
    const b = req.body || {};
    const pg = await db.pool.connect();
    try {
      await pg.query('BEGIN');
      const numero = txt(b.numero_bc, 60) || await prochainNumero(db);
      const existe = await pg.query('SELECT 1 FROM commandes_suede WHERE numero_bc=$1', [numero]);
      if (existe.rows.length) { await pg.query('ROLLBACK'); return res.status(409).json({ error: `Le numéro ${numero} existe déjà.` }); }
      const { rows: [cs] } = await pg.query(`INSERT INTO commandes_suede (numero_bc, fournisseur, statut, etape, cree_par, date_commande)
        VALUES ($1,'Eloflex AB','En cours','brouillon',$2,CURRENT_DATE) RETURNING id`, [numero, nomU(res.locals.user)]);
      await ecrire(pg, cs.id, b);
      if (txt(b.devis_pennylane)) await pg.query('UPDATE commandes_suede SET devis_pennylane=$2 WHERE id=$1', [cs.id, txt(b.devis_pennylane, 60)]);
      await pg.query('COMMIT');
      await histo(cs.id, res.locals.user, txt(b.devis_pennylane) ? 'création depuis le devis Pennylane' : 'création', txt(b.devis_pennylane, 60));
      await memoriser(b).catch(() => {});
      res.status(201).json({ ok: true, id: cs.id, numero_bc: numero });
    } catch (e) { await pg.query('ROLLBACK').catch(() => {}); res.status(500).json({ error: e.message }); }
    finally { pg.release(); }
  });

  // Modification : possible tant que la commande n'est pas envoyée. Une commande validée qui est
  // modifiée repasse en brouillon (il faudra la revalider).
  router.put('/commandes-suede-po/:id', adminOrOp, async (req, res) => {
    await assurer(db);
    const b = req.body || {};
    const pg = await db.pool.connect();
    try {
      await pg.query('BEGIN');
      const { rows: [cs] } = await pg.query('SELECT id, etape FROM commandes_suede WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!cs) { await pg.query('ROLLBACK'); return res.status(404).json({ error: 'Introuvable' }); }
      if (!['brouillon', 'validee'].includes(cs.etape)) { await pg.query('ROLLBACK'); return res.status(409).json({ error: 'Commande déjà envoyée : elle ne peut plus être modifiée.' }); }
      await ecrire(pg, cs.id, b);
      if (b.devis_pennylane !== undefined) await pg.query('UPDATE commandes_suede SET devis_pennylane=$2 WHERE id=$1', [cs.id, txt(b.devis_pennylane, 60)]);
      if (cs.etape === 'validee') await pg.query(`UPDATE commandes_suede SET etape='brouillon', valide_par=NULL, valide_le=NULL WHERE id=$1`, [cs.id]);
      await pg.query('COMMIT');
      await histo(cs.id, res.locals.user, cs.etape === 'validee' ? 'modification (validation annulée)' : 'modification');
      await memoriser(b).catch(() => {});
      res.json({ ok: true, revalider: cs.etape === 'validee' });
    } catch (e) { await pg.query('ROLLBACK').catch(() => {}); res.status(500).json({ error: e.message }); }
    finally { pg.release(); }
  });

  router.post('/commandes-suede-po/:id/valider', async (req, res) => {
    try {
      await assurer(db);
      if (!estValidateur(res.locals.user, await listeValidateurs(db)))
        return res.status(403).json({ error: 'Validation réservée à Brice, Lyes, Frédéric ou Olivier.' });
      const cs = await lire(db, req.params.id);
      if (!cs) return res.status(404).json({ error: 'Introuvable' });
      if (cs.etape !== 'brouillon') return res.status(409).json({ error: 'Seul un brouillon peut être validé.' });
      const m = manques(cs);
      if (m.length) return res.status(400).json({ error: 'À compléter avant validation : ' + m.join(', ') + '.' });
      await db.run(`UPDATE commandes_suede SET etape='validee', valide_par=$2, valide_le=NOW(), updated_at=NOW() WHERE id=$1`, [cs.id, nomU(res.locals.user)]);
      await histo(cs.id, res.locals.user, 'validation');
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/commandes-suede-po/:id/devalider', async (req, res) => {
    try {
      await assurer(db);
      if (!estValidateur(res.locals.user, await listeValidateurs(db)))
        return res.status(403).json({ error: 'Réservé à Brice, Lyes, Frédéric ou Olivier.' });
      const r = await db.get(`UPDATE commandes_suede SET etape='brouillon', valide_par=NULL, valide_le=NULL, updated_at=NOW()
        WHERE id=$1 AND etape='validee' RETURNING id`, [req.params.id]);
      if (!r) return res.status(409).json({ error: 'Commande non validée ou déjà envoyée.' });
      await histo(r.id, res.locals.user, 'validation annulée');
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Envoi à la Suède : PDF (généré par le navigateur) en pièce jointe. { pdf, message, apercu }
  router.post('/commandes-suede-po/:id/envoyer', async (req, res) => {
    try {
      await assurer(db);
      const u = res.locals.user, b = req.body || {};
      const cs = await lire(db, req.params.id);
      if (!cs) return res.status(404).json({ error: 'Introuvable' });
      const renvoi = ['envoyee', 'expediee'].includes(cs.etape);
      if (cs.etape !== 'validee' && !renvoi) return res.status(409).json({ error: 'La commande doit être validée avant envoi.' });
      if (renvoi && !estValidateur(u, await listeValidateurs(db))) return res.status(403).json({ error: 'Renvoi réservé aux validateurs.' });
      const nbArt = cs.lignes.reduce((s, l) => s + (+l.quantite_commandee || 0), 0);
      const message = txt(b.message, 3000);
      const sujet = `Purchase order ${cs.numero_bc} — Eloflex France${cs.reference_client ? ' — Ref. ' + cs.reference_client : ''}${renvoi ? ' (resent)' : ''}`;
      const ligne = (k, v) => `<tr><td style="padding:7px 12px;border:1px solid #e5e7eb;background:#f8fafc;width:38%;color:#555">${k}</td><td style="padding:7px 12px;border:1px solid #e5e7eb;font-weight:600">${v}</td></tr>`;
      const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:620px;color:#222;font-size:14px;line-height:1.55">
        <p>Hello,</p>
        <p>Please find attached our purchase order <b>${esc(cs.numero_bc)}</b> (${cs.lignes.length} line(s), ${nbArt} item(s)).</p>
        <table role="presentation" style="width:100%;border-collapse:collapse;margin:8px 0 14px">
          ${ligne('PO number', esc(cs.numero_bc))}
          ${cs.reference_client ? ligne('Customer order ref.', esc(cs.reference_client)) : ''}
          ${ligne('Deliver to', esc([cs.livraison_nom, cs.livraison_contact].filter(Boolean).join(' — ')) + '<br><span style="font-weight:400">' + esc(cs.livraison_adresse || '').replace(/\n/g, '<br>') + (cs.livraison_pays ? '<br>' + esc(cs.livraison_pays) : '') + '</span>')}
          ${ligne('Phone / e-mail', esc([cs.livraison_tel, cs.livraison_email].filter(Boolean).join(' / ')))}
          ${ligne('Approved by', esc(cs.valide_par || '—'))}
        </table>
        ${message ? `<p style="white-space:pre-wrap;border-left:4px solid #1F5C8C;background:#f2f5f8;padding:10px 14px;border-radius:6px">${esc(message)}</p>` : ''}
        <p>Could you please confirm by e-mail the <b>shipping date</b> and the <b>tracking number</b> (UPS / DSV)?</p>
        <p>Best regards,<br>${esc(nomU(u) || 'Eloflex France')}</p>
        <div style="margin-top:20px">${SIGNATURE_EMAIL_HTML()}</div></div>`;
      if (b.apercu) return res.json({ ok: true, apercu: true, to: TO_SUEDE, cc: CC_SAV, sujet, html });
      const pdf = String(b.pdf || '');
      if (!/^data:application\/pdf/.test(pdf)) return res.status(400).json({ error: 'PDF du bon de commande manquant' });
      const nomPdf = `${cs.numero_bc.replace(/[^\w.\-]+/g, '_')}.pdf`;
      await envoyerEmailPret({ to: TO_SUEDE, cc: CC_SAV, subject: sujet, html, attachments: [{ name: nomPdf, content: pdf }] });
      await db.run(`UPDATE commandes_suede SET etape=CASE WHEN etape='validee' THEN 'envoyee' ELSE etape END, envoye_par=$2, envoye_le=NOW(), envoye_a=$3,
          date_commande=COALESCE(date_commande, CURRENT_DATE), updated_at=NOW() WHERE id=$1`, [cs.id, nomU(u), `${TO_SUEDE} (cc ${CC_SAV})`]);
      await db.run(`INSERT INTO documents_signes (objet, objet_id, nom, mime, taille, data, ajoute_par) VALUES ('commande_suede',$1,$2,'application/pdf',$3,$4,$5)`,
        [cs.id, nomPdf, Math.round(pdf.length * 0.75), pdf, (u && u.id) || null]);
      await histo(cs.id, u, renvoi ? 'renvoi à la Suède' : 'envoi à la Suède', TO_SUEDE);
      res.json({ ok: true, to: TO_SUEDE, cc: CC_SAV });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Confirmation de la Suède : date d'expédition + transporteur + n° de suivi ; livraison
  router.post('/commandes-suede-po/:id/expedition', adminOrOp, async (req, res) => {
    try {
      await assurer(db);
      const b = req.body || {};
      const cs = await db.get('SELECT id, etape, stock_integre FROM commandes_suede WHERE id=$1', [req.params.id]);
      if (!cs) return res.status(404).json({ error: 'Introuvable' });
      if (cs.stock_integre) return res.status(409).json({ error: 'Commande déjà réceptionnée.' });
      const dExp = ISO.test(String(b.date_expedition || '')) ? b.date_expedition : null;
      const dLiv = ISO.test(String(b.date_livraison || '')) ? b.date_livraison : null;
      const transp = txt(b.transporteur, 40), suivi = txt(b.num_suivi, 80);
      const etape = (['envoyee', 'expediee'].includes(cs.etape) && (dExp || suivi)) ? 'expediee' : cs.etape;
      await db.run(`UPDATE commandes_suede SET date_expedition=$2, transporteur=$3, num_suivi=$4, date_livraison=$5, etape=$6,
          statut=$7, updated_at=NOW() WHERE id=$1`,
        [cs.id, dExp, transp, suivi, dLiv, etape, dLiv ? 'Livrée' : (suivi ? 'En transit' : 'En cours')]);
      await histo(cs.id, res.locals.user, 'expédition / livraison', [dExp && 'expédiée ' + dExp, transp, suivi, dLiv && 'livrée ' + dLiv].filter(Boolean).join(' · '));
      res.json({ ok: true, etape });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PDF envoyé (archive)
  router.get('/commandes-suede-po/:id/pdf/:docId', async (req, res) => {
    try {
      const d = await db.get(`SELECT nom, data FROM documents_signes WHERE id=$1 AND objet='commande_suede' AND objet_id=$2`, [req.params.docId, req.params.id]);
      if (!d) return res.status(404).json({ error: 'Introuvable' });
      const buf = Buffer.from(String(d.data).replace(/^data:[^,]*,/, ''), 'base64');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${String(d.nom).replace(/"/g, '')}"`);
      res.send(buf);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
module.exports.estValidateur = estValidateur;
module.exports.assurer = assurer;
