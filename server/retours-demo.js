// server/retours-demo.js
// ─────────────────────────────────────────────────────────────────────────────
// Retours démo : compte rendu de réception d'un fauteuil de démonstration
// (photos par étape, contrôle carton / mousses, état général, nettoyage,
// pièces à remplacer facturées ou offertes, forfaits), envoi par e-mail du PDF
// et création d'une facture brouillon dans Pennylane.
// Les routes sont sous /demo-retours (et non /retours…, réservé aux Retours Suède).
// ─────────────────────────────────────────────────────────────────────────────
const path = require('path');
const fs = require('fs');

const ETAPES = ['colis', 'ouverture', 'dessus', 'ensemble', 'anomalie'];
const NETTOYAGES = { propre: 'Propre', base: 'Nettoyage de base', complet: 'Nettoyage complet' };
const ETATS = ['Neuf', 'Bon état', 'Correct', 'Abîmé', 'Défectueux'];

const n2 = v => Math.round((parseFloat(v) || 0) * 100) / 100;
const escH = x => String(x == null ? '' : x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const eur = v => n2(v).toFixed(2).replace('.', ',') + ' €';
const emailOk = v => /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(String(v || '').trim());

module.exports = function monterRetoursDemo(router, deps) {
  const { db, upload, savePhoto, getPhotoUrl, deleteFiles, sendBrevoMail, signatureSav } = deps;

  async function tarifs() {
    const rows = await db.all("SELECT cle, valeur FROM parametres WHERE cle LIKE 'retour_demo_%'");
    const p = {}; rows.forEach(r => { p[r.cle] = r.valeur; });
    const num = (k, d) => { const v = parseFloat(String(p[k] == null ? '' : p[k]).replace(',', '.')); return isFinite(v) ? v : d; };
    return {
      forfait_retour: num('retour_demo_forfait_retour', 50),
      forfait_carton: num('retour_demo_forfait_carton', 90),
      nettoyage_base: num('retour_demo_nettoyage_base', 0),
      nettoyage_complet: num('retour_demo_nettoyage_complet', 0),
      emails: (p.retour_demo_emails != null ? p.retour_demo_emails : 'frederic@eloflex.fr, info@eloflex.fr, sav@eloflex.fr')
        .split(/[,;\s]+/).map(s => s.trim()).filter(emailOk),
    };
  }

  function nettoyerPieces(list) {
    if (typeof list === 'string') { try { list = JSON.parse(list); } catch (_) { list = []; } }
    return (Array.isArray(list) ? list : []).map(p => ({
      catalogue_id: p.catalogue_id ? parseInt(p.catalogue_id) || null : null,
      ref: String(p.ref || '').trim().slice(0, 80),
      designation: String(p.designation || '').trim().slice(0, 300),
      qte: Math.max(1, parseInt(p.qte) || 1),
      pu: n2(p.pu),
      tva: [5.5, 10, 20].includes(parseFloat(p.tva)) ? parseFloat(p.tva) : 20,
      facture: p.facture !== false && p.facture !== 'false' && p.facture !== 0,
    })).filter(p => p.ref || p.designation);
  }

  // Montants : calculés côté serveur (source de vérité) avec les tarifs du jour de l'enregistrement.
  function calculer(r, t) {
    const pieces = nettoyerPieces(r.pieces);
    const totF = n2(pieces.filter(p => p.facture).reduce((s, p) => s + p.qte * p.pu, 0));
    const totO = n2(pieces.filter(p => !p.facture).reduce((s, p) => s + p.qte * p.pu, 0));
    const mRet = r.fact_forfait_retour === false ? 0 : t.forfait_retour;
    const mCar = r.fact_forfait_carton ? t.forfait_carton : 0;
    const mNet = r.nettoyage === 'base' ? t.nettoyage_base : r.nettoyage === 'complet' ? t.nettoyage_complet : 0;
    return {
      pieces, montant_forfait_retour: n2(mRet), montant_forfait_carton: n2(mCar), montant_nettoyage: n2(mNet),
      total_pieces_facturees: totF, total_pieces_offertes: totO, total_facture: n2(mRet + mCar + mNet + totF),
    };
  }

  const bool = v => (v === true || v === 'true' || v === 1 || v === '1') ? true : (v === false || v === 'false' || v === 0 || v === '0') ? false : null;

  function champs(b) {
    const out = {};
    const txt = k => { if (Object.prototype.hasOwnProperty.call(b, k)) out[k] = (b[k] == null || String(b[k]).trim() === '') ? null : String(b[k]).trim(); };
    ['distributeur_nom', 'distributeur_email', 'modele', 'num_serie', 'transporteur', 'num_suivi', 'receptionnaire', 'commentaire'].forEach(txt);
    if ('date_reception' in b) out.date_reception = /^\d{4}-\d{2}-\d{2}$/.test(String(b.date_reception || '').slice(0, 10)) ? String(b.date_reception).slice(0, 10) : null;
    if ('carton_origine' in b) out.carton_origine = bool(b.carton_origine);
    if ('mousses_presentes' in b) out.mousses_presentes = bool(b.mousses_presentes);
    if ('etat_general' in b) out.etat_general = ETATS.includes(b.etat_general) ? b.etat_general : null;
    if ('nettoyage' in b) out.nettoyage = NETTOYAGES[b.nettoyage] ? b.nettoyage : 'propre';
    if ('fact_forfait_retour' in b) out.fact_forfait_retour = bool(b.fact_forfait_retour) !== false;
    if ('fact_forfait_carton' in b) out.fact_forfait_carton = bool(b.fact_forfait_carton) === true;
    for (const k of ['commande_id', 'pret_id', 'client_id']) if (k in b) out[k] = parseInt(b[k]) || null;
    if ('statut' in b && ['brouillon', 'termine', 'envoye', 'devis', 'facture'].includes(b.statut)) out.statut = b.statut;
    return out;
  }

  async function charger(id) {
    const r = await db.get(`SELECT rd.*, to_char(rd.date_reception,'YYYY-MM-DD') AS date_reception, c.nom AS client_nom_actuel, c.email AS client_email, c.pl_customer_id
      FROM retours_demo rd LEFT JOIN clients c ON c.id = rd.client_id WHERE rd.id=$1`, [id]);
    if (!r) return null;
    const photos = await db.all('SELECT * FROM retours_demo_photos WHERE retour_id=$1 ORDER BY ordre, created_at, id', [id]);
    r.photos = photos.map(p => ({ ...p, url: getPhotoUrl(p.filename, false), url_thumb: getPhotoUrl(p.filename_thumb || p.filename, true) }));
    if (typeof r.pieces === 'string') { try { r.pieces = JSON.parse(r.pieces); } catch (_) { r.pieces = []; } }
    if (typeof r.envois === 'string') { try { r.envois = JSON.parse(r.envois); } catch (_) { r.envois = []; } }
    return r;
  }

  async function enregistrer(id, b, user) {
    const t = await tarifs();
    const ch = champs(b || {});
    const actuel = id ? await db.get('SELECT * FROM retours_demo WHERE id=$1', [id]) : {};
    if (id && !actuel) return null;
    const fusion = { ...actuel, ...ch, pieces: (b && 'pieces' in b) ? b.pieces : actuel.pieces };
    // Pas le carton d'origine OU mousses absentes → forfait carton / mousses proposé automatiquement,
    // sauf si l'utilisateur a explicitement décoché la case.
    if (!('fact_forfait_carton' in (b || {})) && (fusion.carton_origine === false || fusion.mousses_presentes === false)) fusion.fact_forfait_carton = true;
    const calc = calculer(fusion, t);
    const data = { ...ch, ...calc, fact_forfait_carton: !!fusion.fact_forfait_carton, pieces: JSON.stringify(calc.pieces) };
    if (fusion.fact_forfait_retour === false) data.fact_forfait_retour = false;
    const cols = Object.keys(data);
    if (!id) {
      cols.push('cree_par'); data.cree_par = user && user.id || null;
      if (!data.receptionnaire && user) { cols.push('receptionnaire'); data.receptionnaire = user.nom || user.email || null; }
      const uniq = [...new Set(cols)];
      const row = await db.run(`INSERT INTO retours_demo (${uniq.join(',')}) VALUES (${uniq.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id`, uniq.map(k => data[k]));
      return row.id;
    }
    const vals = cols.map(k => data[k]); vals.push(id);
    await db.run(`UPDATE retours_demo SET ${cols.map((k, i) => `${k}=$${i + 1}`).join(', ')}, updated_at=NOW() WHERE id=$${vals.length}`, vals);
    return id;
  }

  // ── Configuration (tarifs + destinataires par défaut), lisible sans être admin ──
  router.get('/demo-retours/config', async (req, res) => {
    try { res.json({ ...(await tarifs()), etapes: ETAPES, nettoyages: NETTOYAGES, etats: ETATS }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Pré-remplissage depuis le parc démo / une commande démo / un prêt / un n° de série ──
  router.get('/demo-retours/prefill', async (req, res) => {
    try {
      const out = {};
      let cmd = null, pret = null;
      if (req.query.commande_id) cmd = await db.get(`SELECT cmd.id, cmd.modele, cmd.num_serie, cmd.client_id, cmd.distributeur_nom, cmd.demo_suivi_resultat,
          c.nom AS client_nom, c.email AS client_email FROM commandes cmd LEFT JOIN clients c ON c.id=cmd.client_id WHERE cmd.id=$1`, [req.query.commande_id]);
      if (req.query.pret_id) pret = await db.get(`SELECT p.*, c.nom AS client_nom, c.email AS client_email FROM prets p LEFT JOIN clients c ON c.id=p.client_id WHERE p.id=$1`, [req.query.pret_id]);
      const serie = String(req.query.serie || '').trim();
      if (!cmd && serie) cmd = await db.get(`SELECT cmd.id, cmd.modele, cmd.num_serie, cmd.client_id, cmd.distributeur_nom, cmd.demo_suivi_resultat,
          c.nom AS client_nom, c.email AS client_email FROM commandes cmd LEFT JOIN clients c ON c.id=cmd.client_id
          WHERE cmd.modele_demo=TRUE AND UPPER(REPLACE(cmd.num_serie,' ',''))=UPPER(REPLACE($1,' ','')) ORDER BY cmd.id DESC LIMIT 1`, [serie]);
      if (cmd) Object.assign(out, {
        commande_id: cmd.id, modele: cmd.modele, num_serie: cmd.num_serie, client_id: cmd.client_id,
        distributeur_nom: cmd.client_nom || cmd.distributeur_nom, distributeur_email: cmd.client_email || null,
        demo_en_cours: !cmd.demo_suivi_resultat,
      });
      if (pret) {
        let arts = pret.articles; if (typeof arts === 'string') { try { arts = JSON.parse(arts); } catch (_) { arts = []; } }
        const a = (Array.isArray(arts) && arts.find(x => x && x.num_serie)) || (Array.isArray(arts) && arts[0]) || {};
        Object.assign(out, {
          pret_id: pret.id, client_id: pret.client_id || out.client_id || null,
          distributeur_nom: pret.client_nom || pret.distributeur_nom || out.distributeur_nom,
          distributeur_email: pret.email || pret.client_email || out.distributeur_email || null,
          modele: out.modele || a.designation || pret.designation || null,
          num_serie: out.num_serie || a.num_serie || pret.num_serie || null,
        });
      }
      if (out.num_serie) {
        const prec = await db.all('SELECT id, to_char(date_reception,\'YYYY-MM-DD\') AS date_reception, statut FROM retours_demo WHERE UPPER(REPLACE(num_serie,\' \',\'\'))=UPPER(REPLACE($1,\' \',\'\')) ORDER BY id DESC LIMIT 5', [out.num_serie]);
        out.retours_precedents = prec;
      }
      res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Liste ──
  router.get('/demo-retours', async (req, res) => {
    try {
      const rows = await db.all(`SELECT rd.id, rd.commande_id, rd.pret_id, rd.client_id, rd.distributeur_nom, rd.distributeur_email, rd.modele, rd.num_serie,
          to_char(rd.date_reception,'YYYY-MM-DD') AS date_reception, rd.transporteur, rd.carton_origine, rd.mousses_presentes, rd.etat_general, rd.nettoyage, rd.statut,
          rd.total_facture, rd.total_pieces_offertes, rd.pl_invoice_id, rd.pl_invoice_num, rd.pl_quote_id, rd.pl_quote_num, rd.envois, rd.receptionnaire, rd.created_at, rd.updated_at,
          c.nom AS client_nom_actuel,
          (SELECT COUNT(*)::int FROM retours_demo_photos p WHERE p.retour_id=rd.id) AS nb_photos,
          (SELECT COUNT(*)::int FROM retours_demo_photos p WHERE p.retour_id=rd.id AND p.etape='anomalie') AS nb_anomalies,
          (SELECT p.filename_thumb FROM retours_demo_photos p WHERE p.retour_id=rd.id ORDER BY (p.etape='ensemble') DESC, p.id LIMIT 1) AS vignette
        FROM retours_demo rd LEFT JOIN clients c ON c.id=rd.client_id
        ORDER BY rd.date_reception DESC NULLS LAST, rd.id DESC`);
      res.json(rows.map(r => ({ ...r, vignette_url: r.vignette ? getPhotoUrl(r.vignette, true) : null })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/demo-retours/:id', async (req, res) => {
    try { const r = await charger(parseInt(req.params.id)); if (!r) return res.status(404).json({ error: 'Retour introuvable' }); res.json(r); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/demo-retours', async (req, res) => {
    try {
      const b = req.body || {};
      const id = await enregistrer(null, b, res.locals.user);
      // Option : le fauteuil revient chez Éloflex → l'unité repasse « Disponible » dans le parc démo.
      if (b.marquer_retour && b.commande_id) {
        const d = /^\d{4}-\d{2}-\d{2}$/.test(String(b.date_reception || '')) ? b.date_reception : new Date().toISOString().slice(0, 10);
        await db.run(`UPDATE commandes SET demo_rappel_date=NULL, demo_suivi_resultat='retour', demo_retour_date=$1, updated_at=NOW()
          WHERE id=$2 AND demo_suivi_resultat IS NULL`, [d, parseInt(b.commande_id)]);
      }
      res.status(201).json(await charger(id));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.put('/demo-retours/:id', async (req, res) => {
    try {
      const id = await enregistrer(parseInt(req.params.id), req.body || {}, res.locals.user);
      if (!id) return res.status(404).json({ error: 'Retour introuvable' });
      res.json(await charger(id));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/demo-retours/:id', async (req, res) => {
    try {
      const photos = await db.all('SELECT filename, filename_thumb FROM retours_demo_photos WHERE retour_id=$1', [req.params.id]);
      photos.forEach(p => { try { deleteFiles(p.filename, p.filename_thumb); } catch (_) {} });
      await db.run('DELETE FROM retours_demo WHERE id=$1', [req.params.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Photos ──
  router.post('/demo-retours/:id/photos', upload.array('photos', 20), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!await db.get('SELECT id FROM retours_demo WHERE id=$1', [id])) return res.status(404).json({ error: 'Retour introuvable' });
      if (!req.files || !req.files.length) return res.status(400).json({ error: 'Aucun fichier' });
      const etape = ETAPES.includes(req.body.etape) ? req.body.etape : 'ensemble';
      const base = (await db.get('SELECT COALESCE(MAX(ordre),0)::int AS m FROM retours_demo_photos WHERE retour_id=$1', [id])).m;
      const out = [];
      let i = 0;
      for (const file of req.files) {
        const saved = await savePhoto(file, 'rd' + id);
        // Stockage local : le fichier d'origine est celui écrit par multer.
        if (file.filename && saved.storage === 'local') saved.filename = file.filename;
        const r = await db.run(`INSERT INTO retours_demo_photos (retour_id, etape, filename, filename_thumb, legende, taille, mime, ordre)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [id, etape, saved.filename, saved.filename_thumb || saved.filename, (req.body.legende || '').trim() || null, saved.taille, saved.mime, base + (++i)]);
        out.push({ ...r, url: getPhotoUrl(r.filename, false), url_thumb: getPhotoUrl(r.filename_thumb || r.filename, true) });
      }
      await db.run('UPDATE retours_demo SET updated_at=NOW() WHERE id=$1', [id]);
      res.status(201).json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.patch('/demo-retours/:id/photos/:pid', async (req, res) => {
    try {
      const b = req.body || {}; const sets = [], vals = [];
      if ('legende' in b) { vals.push(String(b.legende || '').trim() || null); sets.push(`legende=$${vals.length}`); }
      if ('etape' in b && ETAPES.includes(b.etape)) { vals.push(b.etape); sets.push(`etape=$${vals.length}`); }
      if (!sets.length) return res.status(400).json({ error: 'Rien à modifier' });
      vals.push(req.params.pid, req.params.id);
      const r = await db.run(`UPDATE retours_demo_photos SET ${sets.join(', ')} WHERE id=$${vals.length - 1} AND retour_id=$${vals.length} RETURNING *`, vals);
      if (!r) return res.status(404).json({ error: 'Photo introuvable' });
      res.json(r);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/demo-retours/:id/photos/:pid', async (req, res) => {
    try {
      const p = await db.get('SELECT * FROM retours_demo_photos WHERE id=$1 AND retour_id=$2', [req.params.pid, req.params.id]);
      if (!p) return res.status(404).json({ error: 'Photo introuvable' });
      try { deleteFiles(p.filename, p.filename_thumb); } catch (_) {}
      await db.run('DELETE FROM retours_demo_photos WHERE id=$1', [p.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Photo recompressée en JPEG (même origine → utilisable dans le PDF sans souci CORS).
  router.get('/demo-retours/:id/photos/:pid/jpeg', async (req, res) => {
    try {
      const p = await db.get('SELECT * FROM retours_demo_photos WHERE id=$1 AND retour_id=$2', [req.params.pid, req.params.id]);
      if (!p) return res.status(404).end();
      let buf;
      const url = getPhotoUrl(p.filename, false);
      if (/^https?:\/\//.test(url)) {
        const axios = require('axios');
        buf = Buffer.from((await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 })).data);
      } else {
        const dir = process.env.UPLOAD_DIR || './public/uploads';
        buf = fs.readFileSync(path.join(dir, path.basename(p.filename)));
      }
      const w = Math.min(2000, Math.max(300, parseInt(req.query.w) || 1100));
      const sharp = require('sharp');
      const out = await sharp(buf).rotate().resize(w, w, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 62, mozjpeg: true }).toBuffer();
      res.set('Content-Type', 'image/jpeg'); res.set('Cache-Control', 'private, max-age=3600');
      res.send(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Envoi du compte rendu (PDF généré dans le navigateur) ──
  router.post('/demo-retours/:id/envoyer', async (req, res) => {
    try {
      const r = await charger(parseInt(req.params.id));
      if (!r) return res.status(404).json({ error: 'Retour introuvable' });
      const b = req.body || {};
      const dest = [...new Set((Array.isArray(b.destinataires) ? b.destinataires : String(b.destinataires || '').split(/[,;\s]+/))
        .map(s => String(s || '').trim().toLowerCase()).filter(Boolean))];
      const bad = dest.filter(x => !emailOk(x));
      if (!dest.length) return res.status(400).json({ error: 'Aucun destinataire' });
      if (bad.length) return res.status(400).json({ error: 'Adresse(s) invalide(s) : ' + bad.join(', ') });
      if (!b.pdf || !b.pdf.data) return res.status(400).json({ error: 'PDF manquant' });
      const data = String(b.pdf.data).replace(/^data:[^,]+,/, '');
      const nom = String(b.pdf.nom || `Compte_rendu_retour_demo_${r.id}.pdf`).replace(/[^\w.\-]+/g, '_');
      const interne = dest.filter(x => /@eloflex\.(fr|se|com)$/i.test(x));
      const externe = dest.filter(x => !interne.includes(x));
      const dateRec = r.date_reception ? String(r.date_reception).slice(0, 10).split('-').reverse().join('/') : '';
      const nett = NETTOYAGES[r.nettoyage] || '—';
      const ouiNon = v => v === true ? 'Oui' : v === false ? 'Non' : '—';
      const lignes = [
        ['Fauteuil', `Eloflex ${escH(String(r.modele || '').replace(/^eloflex\s*/i, ''))}${r.num_serie ? ' — n° de série ' + escH(r.num_serie) : ''}`],
        ['Distributeur', escH(r.client_nom_actuel || r.distributeur_nom || '—')],
        ['Réception', `${escH(dateRec)}${r.transporteur ? ' — ' + escH(r.transporteur) : ''}${r.num_suivi ? ' (' + escH(r.num_suivi) + ')' : ''}`],
        ["Carton d'origine", ouiNon(r.carton_origine)],
        ['Mousses de protection', ouiNon(r.mousses_presentes)],
        ['État général', escH(r.etat_general || '—')],
        ['Nettoyage', escH(nett)],
        ['Montant à facturer', `<b>${eur(r.total_facture)} HT</b>`],
      ];
      const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;line-height:1.6">
        <p>Bonjour,</p>
        <p>Veuillez trouver ci-joint le compte rendu de réception du fauteuil de démonstration retourné${dateRec ? ' le ' + escH(dateRec) : ''}.</p>
        <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;margin:6px 0 14px">
          ${lignes.map(([k, v]) => `<tr><td style="padding:3px 14px 3px 0;color:#666;white-space:nowrap">${k}</td><td style="padding:3px 0">${v}</td></tr>`).join('')}
        </table>
        ${b.message ? `<p>${escH(b.message).replace(/\n/g, '<br>')}</p>` : ''}
        <p>Restant à votre disposition.<br>Bien cordialement</p>
        <div style="margin-top:20px">${signatureSav()}</div></div>`;
      await sendBrevoMail({
        from: 'sav@eloflex.fr', fromName: 'Eloflex France — SAV',
        to: (externe.length ? externe : interne).join(','),
        cc: externe.length && interne.length ? interne.join(',') : undefined,
        subject: `Eloflex — Compte rendu de retour démo${r.modele ? ' ' + String(r.modele).replace(/^eloflex\s*/i, 'Eloflex ') : ''}${r.num_serie ? ' (' + r.num_serie + ')' : ''}`,
        html, attachments: [{ name: nom, content: data }],
      });
      const u = res.locals.user || {};
      const envois = (Array.isArray(r.envois) ? r.envois : []).concat([{ date: new Date().toISOString(), par: u.nom || u.email || null, destinataires: dest }]);
      await db.run(`UPDATE retours_demo SET envois=$1, statut=CASE WHEN statut='facture' THEN statut ELSE 'envoye' END, updated_at=NOW() WHERE id=$2`, [JSON.stringify(envois), r.id]);
      res.json({ ok: true, destinataires: dest });
    } catch (e) {
      const msg = (e.response && e.response.data && (e.response.data.message || JSON.stringify(e.response.data))) || e.message;
      res.status(500).json({ error: msg });
    }
  });

  // ── Facture brouillon / devis Pennylane (forfaits + nettoyage + pièces facturées) ──
  function lignesPennylane(r) {
    const fauteuil = `Eloflex ${String(r.modele || '').replace(/^eloflex\s*/i, '')}${r.num_serie ? ' n° ' + r.num_serie : ''}`.trim();
    const vat = t => t === 5.5 ? 'FR_55' : t === 10 ? 'FR_100' : 'FR_200';
    const lignes = [];
    if (n2(r.montant_forfait_retour) > 0) lignes.push({ label: `Forfait retour fauteuil de démonstration — ${fauteuil}`, quantity: 1, pu: n2(r.montant_forfait_retour), vat: 'FR_200' });
    if (n2(r.montant_forfait_carton) > 0) lignes.push({ label: 'Forfait carton / mousses de protection', quantity: 1, pu: n2(r.montant_forfait_carton), vat: 'FR_200' });
    if (n2(r.montant_nettoyage) > 0) lignes.push({ label: NETTOYAGES[r.nettoyage] || 'Nettoyage', quantity: 1, pu: n2(r.montant_nettoyage), vat: 'FR_200' });
    (r.pieces || []).filter(p => p.facture !== false && n2(p.pu) > 0).forEach(p => lignes.push({
      label: [p.ref, p.designation].filter(Boolean).join(' — ') + ' (remise en état)', quantity: parseInt(p.qte) || 1, pu: n2(p.pu), vat: vat(parseFloat(p.tva)),
    }));
    return lignes;
  }

  async function creerDocumentPL(req, res, type) {
    const devis = type === 'devis';
    try {
      if (!(process.env.PENNYLANE_API_KEY || process.env.PENNYLANE_TOKEN)) return res.status(400).json({ error: 'Pennylane non configuré' });
      const r = await charger(parseInt(req.params.id));
      if (!r) return res.status(404).json({ error: 'Retour introuvable' });
      const dejaId = devis ? r.pl_quote_id : r.pl_invoice_id, dejaNum = devis ? r.pl_quote_num : r.pl_invoice_num;
      if (dejaId && !(req.body && req.body.force)) return res.status(409).json({ error: `Un${devis ? ' devis' : 'e facture'} a déjà été créé${devis ? '' : 'e'} pour ce retour (${dejaNum || dejaId}).` });
      const lignes = lignesPennylane(r);
      if (!lignes.length) return res.status(400).json({ error: 'Rien à facturer (montant nul).' });
      const { creerFactureRetourDemo } = require('../scripts/sync-pennylane');
      const doc = await creerFactureRetourDemo({
        type, customerId: r.pl_customer_id || null, nom: r.client_nom_actuel || r.distributeur_nom || '',
        reference: `RD-${r.id}${r.num_serie ? ' ' + r.num_serie : ''}`, date: new Date().toISOString().slice(0, 10), lignes,
      });
      const numero = doc.quote_number || doc.invoice_number || doc.label || String(doc.id);
      const base = `https://app.pennylane.com/companies/${process.env.PENNYLANE_COMPANY_ID || '22996810'}/clients/`;
      if (devis) {
        await db.run(`UPDATE retours_demo SET pl_quote_id=$1, pl_quote_num=$2, statut=CASE WHEN statut='facture' THEN statut ELSE 'devis' END, updated_at=NOW() WHERE id=$3`, [String(doc.id), numero, r.id]);
        return res.json({ ok: true, quote_id: doc.id, numero, url: `${base}customer_estimates?estimate_id=${doc.id}` });
      }
      await db.run(`UPDATE retours_demo SET pl_invoice_id=$1, pl_invoice_num=$2, statut='facture', updated_at=NOW() WHERE id=$3`, [String(doc.id), numero, r.id]);
      res.json({ ok: true, invoice_id: doc.id, numero, url: `${base}customer_invoices?invoice_id=${doc.id}` });
    } catch (e) {
      const d = e.response && e.response.data;
      res.status(500).json({ error: d ? (d.message || d.error || JSON.stringify(d)).toString().slice(0, 400) : e.message });
    }
  }
  router.post('/demo-retours/:id/facture-pennylane', (req, res) => creerDocumentPL(req, res, 'facture'));
  router.post('/demo-retours/:id/devis-pennylane', (req, res) => creerDocumentPL(req, res, 'devis'));
};

module.exports.ETAPES = ETAPES;
