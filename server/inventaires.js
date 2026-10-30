// server/inventaires.js
// ─────────────────────────────────────────────────────────────────────────────
// Inventaire mensuel par emplacement (Lagord, Paris, Stock SAV), saisi dans l'appli puis
// régularisé dans VosFactures à la validation.
//
// Modèle de stock :
//   • catalogue.stock      = stock total VosFactures (Lagord + Paris), resynchronisé depuis VF ;
//   • Paris                = catalogue_emplacements (emplacement 'paris') ;
//   • Lagord               = catalogue.stock − Paris (emplacement par défaut : les mouvements
//                            automatiques — ventes, BL Pennylane — y sont imputés) ;
//   • Stock SAV            = catalogue.stock_sav (hors VosFactures, comme aujourd'hui).
//
// Validation d'un inventaire Lagord ou Paris : écart = compté − stock actuel de l'emplacement ;
// VosFactures reçoit un bon d'entrée interne (PW) pour les écarts positifs et un bon de sortie
// interne (RW) pour les écarts négatifs, dans l'entrepôt unique ; puis l'appli est mise à jour.
// ─────────────────────────────────────────────────────────────────────────────

const EMPLACEMENTS = [
  { code: 'lagord', nom: 'Lagord', vf: true, defaut: true },
  { code: 'paris', nom: 'Paris', vf: true },
  { code: 'sav', nom: 'Stock SAV', vf: false },
];
const EMPL = Object.fromEntries(EMPLACEMENTS.map(e => [e.code, e]));
const periodeDu = (d = new Date()) => d.toISOString().slice(0, 7);

let _tablesOk = false;
async function ensureTables(db) {
  if (_tablesOk) return;
  await db.run(`CREATE TABLE IF NOT EXISTS catalogue_emplacements (
    catalogue_id INTEGER REFERENCES catalogue(id) ON DELETE CASCADE, emplacement TEXT NOT NULL,
    quantite INTEGER NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (catalogue_id, emplacement))`);
  await db.run(`CREATE TABLE IF NOT EXISTS inventaires (
    id SERIAL PRIMARY KEY, emplacement TEXT NOT NULL, periode TEXT NOT NULL, statut TEXT NOT NULL DEFAULT 'en_cours',
    cree_par TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), valide_par TEXT, valide_at TIMESTAMPTZ,
    mise_en_place BOOLEAN DEFAULT FALSE, non_comptes TEXT, vf_entree_id TEXT, vf_sortie_id TEXT, vf_message TEXT, resume JSONB)`);
  await db.run(`CREATE TABLE IF NOT EXISTS inventaires_lignes (
    inventaire_id INTEGER REFERENCES inventaires(id) ON DELETE CASCADE, catalogue_id INTEGER, ref TEXT, designation TEXT,
    theorique INTEGER, compte INTEGER, note TEXT, maj_par TEXT, maj_at TIMESTAMPTZ, ecart INTEGER,
    PRIMARY KEY (inventaire_id, catalogue_id))`);
  // Zone de rangement d'une pièce dans un emplacement (rayon, étagère…) : reprise d'un inventaire à l'autre
  await db.run(`ALTER TABLE inventaires_lignes ADD COLUMN IF NOT EXISTS zone TEXT`);
  await db.run(`CREATE TABLE IF NOT EXISTS catalogue_zones (
    catalogue_id INTEGER REFERENCES catalogue(id) ON DELETE CASCADE, emplacement TEXT NOT NULL, zone TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (catalogue_id, emplacement))`);
  // Liste des zones gérées par emplacement (ajout / renommage / suppression)
  await db.run(`CREATE TABLE IF NOT EXISTS stock_zones (
    emplacement TEXT NOT NULL, nom TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (emplacement, nom))`);
  await db.run(`INSERT INTO stock_zones (emplacement, nom)
    SELECT DISTINCT emplacement, zone FROM catalogue_zones WHERE zone IS NOT NULL ON CONFLICT DO NOTHING`);
  _tablesOk = true;
}

// Stocks par emplacement de toutes les pièces (Map catalogue_id → {lagord, paris, sav})
async function stocksParEmplacement(db, ids) {
  const filtre = ids ? 'WHERE c.id = ANY($1::int[])' : '';
  const rows = await db.all(`SELECT c.id, COALESCE(c.stock,0)::int AS stock, COALESCE(c.stock_sav,0)::int AS sav,
      COALESCE((SELECT quantite FROM catalogue_emplacements e WHERE e.catalogue_id=c.id AND e.emplacement='paris'),0)::int AS paris
    FROM catalogue c ${filtre}`, ids ? [ids] : []);
  const m = new Map();
  for (const r of rows) m.set(r.id, { lagord: r.stock - r.paris, paris: r.paris, sav: r.sav, total: r.stock });
  return m;
}

function vfClient() {
  if (!process.env.VOSFACTURES_API_TOKEN || !process.env.VOSFACTURES_ACCOUNT) return null;
  const axios = require('axios');
  return axios.create({
    baseURL: `https://${process.env.VOSFACTURES_ACCOUNT}.vosfactures.fr`,
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    params: { api_token: process.env.VOSFACTURES_API_TOKEN }, timeout: 60000,
  });
}
const vfErr = e => (e.response && e.response.data && (typeof e.response.data === 'string' ? e.response.data : JSON.stringify(e.response.data)).slice(0, 300)) || e.message;

module.exports = function monterInventaires(router, { db, addAlerte }) {
  const nomU = u => (u && (u.nom || u.email)) || null;
  const ecritureOk = u => u && u.role !== 'distributeur' && (u.role === 'admin' || (u.permissions || {}).catalogue === 'write');

  // Calcul des écarts d'un inventaire par rapport au stock ACTUEL de l'emplacement
  async function calculer(inv, opts) {
    const lignes = await db.all(`SELECT l.*, c.vf_product_id, c.prix_achat_suede, c.pxht
      FROM inventaires_lignes l LEFT JOIN catalogue c ON c.id=l.catalogue_id WHERE l.inventaire_id=$1 ORDER BY l.ref`, [inv.id]);
    const st = await stocksParEmplacement(db, lignes.map(l => l.catalogue_id));
    const zero = opts.non_comptes === 'zero';
    const res = { lignes: [], non_comptees: 0, comptees: 0, plus: 0, moins: 0, valeur_plus: 0, valeur_moins: 0, sans_vf: 0 };
    for (const l of lignes) {
      const s = st.get(l.catalogue_id); if (!s) continue;
      const actuel = s[inv.emplacement];
      let compte = l.compte;
      if (compte == null) { res.non_comptees++; if (!zero) continue; compte = 0; } else res.comptees++;
      const ecart = compte - actuel;
      if (!ecart) continue;
      const pu = parseFloat(l.prix_achat_suede) || 0;
      if (ecart > 0) { res.plus += ecart; res.valeur_plus += ecart * pu; } else { res.moins += -ecart; res.valeur_moins += -ecart * pu; }
      if (!l.vf_product_id) res.sans_vf++;
      res.lignes.push({ catalogue_id: l.catalogue_id, ref: l.ref, designation: l.designation, actuel, compte, ecart, compte_saisi: l.compte != null,
        vf_product_id: l.vf_product_id, pu, note: l.note, zone: l.zone });
    }
    res.valeur_plus = Math.round(res.valeur_plus * 100) / 100; res.valeur_moins = Math.round(res.valeur_moins * 100) / 100;
    return res;
  }

  // ── Zones de rangement d'un emplacement ───────────────────────────
  const nomZone = v => String(v || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  async function listeZones(emplacement) {
    return db.all(`SELECT z.nom, (SELECT COUNT(*)::int FROM catalogue_zones c WHERE c.emplacement=z.emplacement AND c.zone=z.nom) AS nb
      FROM stock_zones z WHERE z.emplacement=$1 ORDER BY z.nom`, [emplacement]);
  }
  router.get('/inventaires-zones/:empl', async (req, res) => {
    try {
      await ensureTables(db);
      if (!EMPL[req.params.empl]) return res.status(400).json({ error: 'Emplacement inconnu' });
      res.json(await listeZones(req.params.empl));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  router.post('/inventaires-zones/:empl', async (req, res) => {
    try {
      const u = res.locals.user || {};
      if (!ecritureOk(u)) return res.status(403).json({ error: 'Droits insuffisants' });
      await ensureTables(db);
      if (!EMPL[req.params.empl]) return res.status(400).json({ error: 'Emplacement inconnu' });
      const nom = nomZone((req.body || {}).nom);
      if (!nom) return res.status(400).json({ error: 'Nom de zone vide' });
      await db.run('INSERT INTO stock_zones (emplacement, nom) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.empl, nom]);
      res.json({ ok: true, nom, zones: await listeZones(req.params.empl) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Renommer : la zone suit sur les pièces et dans les inventaires en cours
  router.put('/inventaires-zones/:empl', async (req, res) => {
    try {
      const u = res.locals.user || {};
      if (!ecritureOk(u)) return res.status(403).json({ error: 'Droits insuffisants' });
      await ensureTables(db);
      const e = req.params.empl, b = req.body || {};
      const ancien = nomZone(b.ancien), nom = nomZone(b.nom);
      if (!EMPL[e] || !ancien || !nom) return res.status(400).json({ error: 'Paramètres invalides' });
      await db.run('DELETE FROM stock_zones WHERE emplacement=$1 AND nom=$2', [e, ancien]);
      await db.run('INSERT INTO stock_zones (emplacement, nom) VALUES ($1,$2) ON CONFLICT DO NOTHING', [e, nom]);
      await db.run('UPDATE catalogue_zones SET zone=$3, updated_at=NOW() WHERE emplacement=$1 AND zone=$2', [e, ancien, nom]);
      await db.run(`UPDATE inventaires_lignes l SET zone=$3 FROM inventaires i
        WHERE i.id=l.inventaire_id AND i.statut='en_cours' AND i.emplacement=$1 AND l.zone=$2`, [e, ancien, nom]);
      res.json({ ok: true, zones: await listeZones(e) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Supprimer : les pièces de cette zone passent « sans zone » (les inventaires validés restent intacts)
  router.delete('/inventaires-zones/:empl', async (req, res) => {
    try {
      const u = res.locals.user || {};
      if (!ecritureOk(u)) return res.status(403).json({ error: 'Droits insuffisants' });
      await ensureTables(db);
      const e = req.params.empl, nom = nomZone(req.query.nom);
      if (!EMPL[e] || !nom) return res.status(400).json({ error: 'Paramètres invalides' });
      await db.run('DELETE FROM stock_zones WHERE emplacement=$1 AND nom=$2', [e, nom]);
      await db.run('DELETE FROM catalogue_zones WHERE emplacement=$1 AND zone=$2', [e, nom]);
      await db.run(`UPDATE inventaires_lignes l SET zone=NULL FROM inventaires i
        WHERE i.id=l.inventaire_id AND i.statut='en_cours' AND i.emplacement=$1 AND l.zone=$2`, [e, nom]);
      res.json({ ok: true, zones: await listeZones(e) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Synthèse Lagord + Paris : comptages des inventaires en cours (ou, à défaut, du dernier validé) côte à côte
  router.get('/inventaires-synthese', async (req, res) => {
    try {
      await ensureTables(db);
      const invDe = async e => (await db.get(`SELECT id, periode, statut, valide_at FROM inventaires WHERE emplacement=$1 AND statut IN ('en_cours','valide')
        ORDER BY (statut='en_cours') DESC, COALESCE(valide_at, created_at) DESC LIMIT 1`, [e])) || null;
      const iL = await invDe('lagord'), iP = await invDe('paris');
      const lignesDe = async inv => inv ? new Map((await db.all('SELECT catalogue_id, compte, zone, note FROM inventaires_lignes WHERE inventaire_id=$1', [inv.id])).map(l => [l.catalogue_id, l])) : new Map();
      const mL = await lignesDe(iL), mP = await lignesDe(iP);
      const st = await stocksParEmplacement(db);
      const cat = await db.all(`SELECT id, ref, ref_fournisseur, designation, prix_achat_suede, COALESCE(en_sommeil,false) AS en_sommeil FROM catalogue
        WHERE stock_actif IS DISTINCT FROM false ORDER BY ref`);
      const lignes = [];
      for (const c of cat) {
        const s = st.get(c.id) || {}, l = mL.get(c.id), p = mP.get(c.id);
        const cL = l && l.compte != null ? l.compte : null, cP = p && p.compte != null ? p.compte : null;
        if (c.en_sommeil && !s.total && cL == null && cP == null) continue;
        lignes.push({ id: c.id, ref: c.ref, ref_fournisseur: c.ref_fournisseur || null, designation: c.designation, pu: c.prix_achat_suede != null ? +c.prix_achat_suede : null,
          stock_vf: s.total || 0, stock_lagord: s.lagord || 0, stock_paris: s.paris || 0, compte_lagord: cL, compte_paris: cP,
          zone_lagord: l && l.zone || null, zone_paris: p && p.zone || null, note: [l && l.note, p && p.note].filter(Boolean).join(' · ') || null });
      }
      res.json({ lagord: iL, paris: iP, lignes });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/inventaires', async (req, res) => {
    try {
      await ensureTables(db);
      const encours = await db.all(`SELECT i.*, (SELECT COUNT(*)::int FROM inventaires_lignes l WHERE l.inventaire_id=i.id) AS nb,
          (SELECT COUNT(*)::int FROM inventaires_lignes l WHERE l.inventaire_id=i.id AND l.compte IS NOT NULL) AS comptees
        FROM inventaires i WHERE statut='en_cours'`);
      const derniers = await db.all(`SELECT DISTINCT ON (emplacement) emplacement, periode, valide_at FROM inventaires WHERE statut='valide' ORDER BY emplacement, valide_at DESC`);
      const totaux = await db.get(`SELECT COALESCE(SUM(c.stock),0)::int AS total, COALESCE(SUM(c.stock_sav),0)::int AS sav,
          COALESCE((SELECT SUM(quantite) FROM catalogue_emplacements WHERE emplacement='paris'),0)::int AS paris
        FROM catalogue c WHERE c.stock_actif IS DISTINCT FROM false`);
      const historique = await db.all(`SELECT id, emplacement, periode, statut, cree_par, created_at, valide_par, valide_at, mise_en_place,
          vf_entree_id, vf_sortie_id, vf_message, resume FROM inventaires WHERE statut<>'en_cours' ORDER BY COALESCE(valide_at, created_at) DESC LIMIT 60`);
      const qte = { lagord: totaux.total - totaux.paris, paris: totaux.paris, sav: totaux.sav };
      res.json({
        periode: periodeDu(), compte_vf: process.env.VOSFACTURES_ACCOUNT || null,
        emplacements: EMPLACEMENTS.map(e => ({ ...e, quantite: qte[e.code],
          en_cours: encours.find(i => i.emplacement === e.code) || null,
          dernier: derniers.find(d => d.emplacement === e.code) || null,
          deja_inventorie: !!derniers.find(d => d.emplacement === e.code) })),
        historique,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Nouvelle feuille de comptage : toutes les pièces suivies en stock (hors pièces en sommeil sans stock)
  router.post('/inventaires', async (req, res) => {
    try {
      const u = res.locals.user || {};
      if (!ecritureOk(u)) return res.status(403).json({ error: 'Droits insuffisants (écriture sur le catalogue requise)' });
      await ensureTables(db);
      const empl = EMPL[(req.body || {}).emplacement];
      if (!empl) return res.status(400).json({ error: 'Emplacement inconnu' });
      const ex = await db.get(`SELECT id FROM inventaires WHERE emplacement=$1 AND statut='en_cours'`, [empl.code]);
      if (ex) return res.json({ ok: true, id: ex.id, existant: true });
      const inv = await db.run(`INSERT INTO inventaires (emplacement, periode, cree_par) VALUES ($1,$2,$3) RETURNING *`, [empl.code, periodeDu(), nomU(u)]);
      const st = await stocksParEmplacement(db);
      const cat = await db.all(`SELECT c.id, c.ref, c.designation, COALESCE(c.en_sommeil,false) AS en_sommeil, z.zone FROM catalogue c
        LEFT JOIN catalogue_zones z ON z.catalogue_id=c.id AND z.emplacement=$1
        WHERE c.stock_actif IS DISTINCT FROM false ORDER BY c.ref`, [empl.code]);
      let n = 0;
      for (const c of cat) {
        const q = (st.get(c.id) || {})[empl.code] || 0;
        if (c.en_sommeil && !q) continue;
        await db.run(`INSERT INTO inventaires_lignes (inventaire_id, catalogue_id, ref, designation, theorique, zone) VALUES ($1,$2,$3,$4,$5,$6)`,
          [inv.id, c.id, c.ref, c.designation, q, c.zone || null]);
        n++;
      }
      res.json({ ok: true, id: inv.id, lignes: n });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/inventaires/:id', async (req, res) => {
    try {
      await ensureTables(db);
      const inv = await db.get('SELECT * FROM inventaires WHERE id=$1', [req.params.id]);
      if (!inv) return res.status(404).json({ error: 'Inventaire introuvable' });
      const lignes = await db.all(`SELECT l.catalogue_id, l.ref, l.designation, l.theorique, l.compte, l.note, l.maj_par, l.maj_at, l.ecart, l.zone,
          (c.vf_product_id IS NOT NULL) AS vf
        FROM inventaires_lignes l LEFT JOIN catalogue c ON c.id=l.catalogue_id WHERE l.inventaire_id=$1 ORDER BY l.ref`, [inv.id]);
      if (inv.statut === 'en_cours') {
        const st = await stocksParEmplacement(db, lignes.map(l => l.catalogue_id));
        for (const l of lignes) l.actuel = (st.get(l.catalogue_id) || {})[inv.emplacement];
      }
      // Zones déjà utilisées dans cet emplacement (suggestions de saisie)
      const zones = (await db.all(`SELECT zone FROM (SELECT nom AS zone FROM stock_zones WHERE emplacement=$1
          UNION SELECT l.zone FROM inventaires_lignes l WHERE l.inventaire_id=$2 AND l.zone IS NOT NULL) z ORDER BY zone`, [inv.emplacement, inv.id])).map(z => z.zone);
      res.json({ ...inv, emplacement_nom: (EMPL[inv.emplacement] || {}).nom, vf_emplacement: !!(EMPL[inv.emplacement] || {}).vf, lignes, zones });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.put('/inventaires/:id/lignes/:cid', async (req, res) => {
    try {
      const u = res.locals.user || {};
      if (!ecritureOk(u)) return res.status(403).json({ error: 'Droits insuffisants' });
      const inv = await db.get('SELECT statut, emplacement FROM inventaires WHERE id=$1', [req.params.id]);
      if (!inv) return res.status(404).json({ error: 'Inventaire introuvable' });
      if (inv.statut !== 'en_cours') return res.status(409).json({ error: 'Cet inventaire est clôturé' });
      const b = req.body || {};
      const avecZone = Object.prototype.hasOwnProperty.call(b, 'zone');
      const zone = avecZone ? (String(b.zone || '').trim().replace(/\s+/g, ' ').slice(0, 60) || null) : undefined;
      const sets = [], vals = [];
      if (Object.prototype.hasOwnProperty.call(b, 'compte')) {
        const v = b.compte === '' || b.compte == null ? null : parseInt(b.compte);
        if (v != null && (!(v >= 0) || v > 100000)) return res.status(400).json({ error: 'Quantité invalide' });
        vals.push(v); sets.push(`compte=$${vals.length}`);
      }
      if (Object.prototype.hasOwnProperty.call(b, 'note')) { vals.push(String(b.note || '').slice(0, 300) || null); sets.push(`note=$${vals.length}`); }
      const saisie = sets.length > 0;
      if (avecZone) { vals.push(zone); sets.push(`zone=$${vals.length}`); }
      if (!sets.length) return res.json({ ok: true });
      if (saisie) { vals.push(nomU(u)); sets.push(`maj_par=$${vals.length}`); sets.push('maj_at=NOW()'); }
      vals.push(req.params.id, req.params.cid);
      const r = await db.run(`UPDATE inventaires_lignes SET ${sets.join(', ')} WHERE inventaire_id=$${vals.length - 1} AND catalogue_id=$${vals.length} RETURNING compte, note, zone, maj_par, maj_at`, vals);
      if (!r) return res.status(404).json({ error: 'Ligne introuvable' });
      // La zone est mémorisée pour la pièce dans cet emplacement (reprise au prochain inventaire)
      if (avecZone) {
        if (zone) await db.run('INSERT INTO stock_zones (emplacement, nom) VALUES ($1,$2) ON CONFLICT DO NOTHING', [inv.emplacement, zone]);
        if (zone) await db.run(`INSERT INTO catalogue_zones (catalogue_id, emplacement, zone) VALUES ($1,$2,$3)
          ON CONFLICT (catalogue_id, emplacement) DO UPDATE SET zone=EXCLUDED.zone, updated_at=NOW()`, [req.params.cid, inv.emplacement, zone]);
        else await db.run('DELETE FROM catalogue_zones WHERE catalogue_id=$1 AND emplacement=$2', [req.params.cid, inv.emplacement]);
      }
      res.json({ ok: true, ...r });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Contrôle avant validation (aucune écriture)
  router.get('/inventaires/:id/controle', async (req, res) => {
    try {
      await ensureTables(db);
      const inv = await db.get('SELECT * FROM inventaires WHERE id=$1', [req.params.id]);
      if (!inv) return res.status(404).json({ error: 'Inventaire introuvable' });
      const r = await calculer(inv, { non_comptes: req.query.non_comptes });
      const deja = await db.get(`SELECT 1 FROM inventaires WHERE emplacement=$1 AND statut='valide' LIMIT 1`, [inv.emplacement]);
      // Lagord validé avant toute mise en place de Paris : les pièces parties à Paris sortiraient à tort de VosFactures
      const parisVu = await db.get(`SELECT 1 FROM inventaires WHERE emplacement='paris' AND statut='valide' LIMIT 1`);
      const parisEnCours = await db.get(`SELECT 1 FROM inventaires WHERE emplacement='paris' AND statut='en_cours' LIMIT 1`);
      res.json({ ...r, emplacement: inv.emplacement, vf_emplacement: !!(EMPL[inv.emplacement] || {}).vf, premier: !deja, vf_configure: !!vfClient(),
        paris_a_faire: inv.emplacement === 'lagord' && !parisVu, paris_en_cours: !!parisEnCours });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Validation : bons VosFactures (si emplacement VF), puis stock de l'appli
  router.post('/inventaires/:id/valider', async (req, res) => {
    try {
      const u = res.locals.user || {};
      if (!u || u.role !== 'admin') return res.status(403).json({ error: 'Validation réservée aux administrateurs (écriture dans VosFactures)' });
      await ensureTables(db);
      const inv = await db.get('SELECT * FROM inventaires WHERE id=$1', [req.params.id]);
      if (!inv) return res.status(404).json({ error: 'Inventaire introuvable' });
      if (inv.statut !== 'en_cours') return res.status(409).json({ error: 'Cet inventaire est déjà clôturé' });
      const b = req.body || {};
      const nonComptes = b.non_comptes === 'zero' ? 'zero' : 'inchange';
      const empl = EMPL[inv.emplacement];
      const miseEnPlace = !!b.mise_en_place && empl.code !== 'lagord' && empl.vf;
      const r = await calculer(inv, { non_comptes: nonComptes });
      const libelle = `Inventaire ${empl.nom} ${inv.periode}`;

      // 1) VosFactures : seulement pour un emplacement inclus dans le stock VF, hors « mise en place »
      let vfEntree = null, vfSortie = null, vfMsg = null;
      const avecVF = empl.vf && !miseEnPlace;
      if (avecVF && r.lignes.some(l => l.vf_product_id)) {
        const vf = vfClient();
        if (!vf) return res.status(400).json({ error: 'VosFactures non configuré : validation impossible' });
        let warehouseId = null;
        try { const { data } = await vf.get('/warehouses.json'); const w = (data || []).find(x => x.kind === 'main') || (data || [])[0]; warehouseId = w && w.id; } catch (_) {}
        const jour = new Date().toISOString().slice(0, 10);
        const base = `INV-${empl.code.toUpperCase()}-${inv.periode}`;
        const plus = r.lignes.filter(l => l.vf_product_id && l.ecart > 0).map(l => ({ product_id: Number(l.vf_product_id), quantity: l.ecart }));
        const moins = r.lignes.filter(l => l.vf_product_id && l.ecart < 0).map(l => ({ product_id: Number(l.vf_product_id), quantity: -l.ecart }));
        const creer = async (kind, actions, suffixe, texte) => {
          const { data } = await vf.post('/warehouse_documents.json', { warehouse_document: {
            kind, ...(warehouseId ? { warehouse_id: warehouseId } : {}), issue_date: jour, number: `${base}-${suffixe}`,
            description: `${libelle} — ${texte} (validé par ${nomU(u) || '?'} dans l'appli SAV)`, warehouse_actions: actions } });
          return data && data.id ? String(data.id) : null;
        };
        try {
          if (plus.length) vfEntree = await creer('pw', plus, 'E', 'pièces en plus');
          if (moins.length) vfSortie = await creer('rw', moins, 'S', 'pièces manquantes');
        } catch (e) {
          // Pas de demi-mesure : on annule le bon déjà créé et on ne touche pas au stock de l'appli
          if (vfEntree) { try { await vf.delete(`/warehouse_documents/${vfEntree}.json`); } catch (_) {} }
          return res.status(502).json({ error: 'VosFactures a refusé la régularisation, rien n’a été modifié : ' + vfErr(e) });
        }
        if (r.sans_vf) vfMsg = `${r.sans_vf} pièce(s) sans lien VosFactures : régularisées dans l'appli seulement`;
      }

      // 2) Appli (transaction)
      const pg = await db.pool.connect();
      try {
        await pg.query('BEGIN');
        for (const l of r.lignes) {
          if (empl.code === 'sav') {
            await pg.query('UPDATE catalogue SET stock_sav=$1, updated_at=NOW() WHERE id=$2', [l.compte, l.catalogue_id]);
          } else {
            if (empl.code === 'paris') {
              await pg.query(`INSERT INTO catalogue_emplacements (catalogue_id, emplacement, quantite) VALUES ($1,'paris',$2)
                ON CONFLICT (catalogue_id, emplacement) DO UPDATE SET quantite=EXCLUDED.quantite, updated_at=NOW()`, [l.catalogue_id, l.compte]);
            }
            if (!miseEnPlace) await pg.query('UPDATE catalogue SET stock=GREATEST(0, stock + $1), updated_at=NOW() WHERE id=$2', [l.ecart, l.catalogue_id]);
          }
          await pg.query('UPDATE inventaires_lignes SET ecart=$1 WHERE inventaire_id=$2 AND catalogue_id=$3', [l.ecart, inv.id, l.catalogue_id]);
        }
        const resume = { comptees: r.comptees, non_comptees: r.non_comptees, lignes_ecart: r.lignes.length, plus: r.plus, moins: r.moins,
          valeur_plus: r.valeur_plus, valeur_moins: r.valeur_moins, sans_vf: r.sans_vf };
        await pg.query(`UPDATE inventaires SET statut='valide', valide_par=$2, valide_at=NOW(), mise_en_place=$3, non_comptes=$4,
          vf_entree_id=$5, vf_sortie_id=$6, vf_message=$7, resume=$8 WHERE id=$1`,
          [inv.id, nomU(u), miseEnPlace, nonComptes, vfEntree, vfSortie, vfMsg, JSON.stringify(resume)]);
        await pg.query('COMMIT');
        try { await addAlerte('inventaire', inv.id, `📋 ${libelle} validé : ${r.lignes.length} écart(s) (+${r.plus} / −${r.moins})${avecVF ? (vfEntree || vfSortie ? ' — régularisé dans VosFactures' : '') : (miseEnPlace ? ' — mise en place (VosFactures inchangé)' : ' — hors VosFactures')}.`); } catch (_) {}
        res.json({ ok: true, ...resume, vf_entree_id: vfEntree, vf_sortie_id: vfSortie, vf_message: vfMsg, mise_en_place: miseEnPlace });
      } catch (e) {
        try { await pg.query('ROLLBACK'); } catch (_) {}
        res.status(500).json({ error: 'Erreur à la mise à jour de l’appli' + (vfEntree || vfSortie ? ` (les bons VosFactures ${[vfEntree, vfSortie].filter(Boolean).join(', ')} ont été créés : prévenir avant de revalider)` : '') + ' : ' + e.message });
      } finally { pg.release(); }
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/inventaires/:id', async (req, res) => {
    try {
      const u = res.locals.user || {};
      if (!ecritureOk(u)) return res.status(403).json({ error: 'Droits insuffisants' });
      const inv = await db.get('SELECT statut FROM inventaires WHERE id=$1', [req.params.id]);
      if (!inv) return res.status(404).json({ error: 'Inventaire introuvable' });
      if (inv.statut !== 'en_cours') return res.status(409).json({ error: 'Un inventaire validé ne peut pas être supprimé' });
      await db.run('DELETE FROM inventaires WHERE id=$1', [req.params.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Export CSV (séparateur « ; », lisible par Excel)
  router.get('/inventaires/:id/export', async (req, res) => {
    try {
      const inv = await db.get('SELECT * FROM inventaires WHERE id=$1', [req.params.id]);
      if (!inv) return res.status(404).json({ error: 'Inventaire introuvable' });
      const lignes = await db.all(`SELECT l.*, c.prix_achat_suede, c.ref_fournisseur FROM inventaires_lignes l LEFT JOIN catalogue c ON c.id=l.catalogue_id
        WHERE l.inventaire_id=$1 ORDER BY l.zone NULLS LAST, l.ref`, [inv.id]);
      const q = v => { const s = v == null ? '' : String(v); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
      const num = v => v == null || v === '' ? '' : String(v).replace('.', ',');
      const out = ['Zone;Référence;Réf. fournisseur (Suède);Désignation;Stock au lancement;Compté;Écart validé;Prix achat Suède;Note;Saisi par'];
      for (const l of lignes) out.push([q(l.zone), q(l.ref), q(l.ref_fournisseur), q(l.designation), l.theorique, l.compte == null ? '' : l.compte, l.ecart == null ? '' : l.ecart, num(l.prix_achat_suede), q(l.note), q(l.maj_par)].join(';'));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="Inventaire_${(EMPL[inv.emplacement] || {}).nom || inv.emplacement}_${inv.periode}.csv"`.replace(/ /g, '_'));
      res.send('﻿' + out.join('\r\n'));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};

module.exports.ensureTables = ensureTables;
module.exports.EMPLACEMENTS = EMPLACEMENTS;
