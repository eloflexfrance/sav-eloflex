// server/eclates-import.js
// Import d'un éclaté au format « eclate-v1 » (JSON préparé à partir du PDF) — utilisé par
// POST /api/eclates/import et par l'import automatique au démarrage (scripts/eclates/*.json).
const fs = require('fs');
const path = require('path');

async function importerEclate(pool, b) {
  const meta = b.meta || {};
  if (b.format !== 'eclate-v1' || !meta.slug || !Array.isArray(b.views) || !b.pages) {
    const err = new Error("Fichier d'éclaté invalide"); err.status = 400; throw err;
  }
  const pg = await pool.connect();
  try {
    const ex = await pg.query('SELECT id, photo, lien_web, lien_notice, lien_fiche, lien_web_se, lien_notice_se, lien_fiche_se, caracteristiques FROM eclates_modeles WHERE slug=$1', [meta.slug]);
    if (ex.rows.length && b.remplacer !== true) {
      const err = new Error(`L'éclaté « ${meta.modele} » existe déjà.`); err.code = 'existe'; throw err;
    }
    await pg.query('BEGIN');
    if (ex.rows.length) await pg.query('DELETE FROM eclates_modeles WHERE id=$1', [ex.rows[0].id]);
    // en cas de remplacement, on conserve la photo et le lien site web déjà saisis
    const prev = ex.rows[0] || {};
    const m = (await pg.query(`INSERT INTO eclates_modeles (slug, nom, ref_modele, fichier, date_doc, largeur, hauteur, ordre, photo, lien_web)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [meta.slug, meta.modele || meta.slug, meta.ref_modele || null, meta.fichier || null, meta.date_doc || null,
       meta.W || 842, meta.H || 596, meta.ordre || 0, prev.photo || null,
       (prev.lien_web != null ? prev.lien_web : null) || meta.lien_web || null])).rows[0];
    if (prev.lien_notice != null || prev.lien_fiche != null || meta.lien_notice || meta.lien_fiche)
      await pg.query('UPDATE eclates_modeles SET lien_notice=$1, lien_fiche=$2 WHERE id=$3',
        [prev.lien_notice != null ? prev.lien_notice : (meta.lien_notice || null), prev.lien_fiche != null ? prev.lien_fiche : (meta.lien_fiche || null), m.id]);
    if (prev.lien_web_se != null || prev.lien_notice_se != null || prev.lien_fiche_se != null)
      await pg.query('UPDATE eclates_modeles SET lien_web_se=$1, lien_notice_se=$2, lien_fiche_se=$3 WHERE id=$4',
        [prev.lien_web_se, prev.lien_notice_se, prev.lien_fiche_se, m.id]);
    if (prev.caracteristiques) await pg.query('UPDATE eclates_modeles SET caracteristiques=$1 WHERE id=$2', [JSON.stringify(prev.caracteristiques), m.id]);
    for (const [page, svg] of Object.entries(b.pages)) {
      await pg.query('INSERT INTO eclates_pages (modele_id, page, svg) VALUES ($1,$2,$3)', [m.id, parseInt(page), svg]);
    }
    let nl = 0;
    for (const [k, v] of b.views.entries()) {
      const vr = (await pg.query(`INSERT INTO eclates_vues (modele_id, code, page, ordre, nom_en, nom_fr, assembly_ref, clip, reperes, ocr)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [m.id, v.code || null, v.page, k, v.nom_en || null, v.nom_fr || null, v.assembly_ref || null,
         JSON.stringify(v.clip || null), JSON.stringify(v.reperes || []), !!v.ocr])).rows[0];
      const all = [...(v.items || []).map(i => ({ ...i, cable: false })), ...(v.extras || []).map(i => ({ ...i, cable: true }))];
      for (const [j, i] of all.entries()) {
        await pg.query(`INSERT INTO eclates_lignes (vue_id, ordre, pos, ref, desc_en, desc_fr_auto, qty, note, cable)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [vr.id, j, i.pos || null, i.ref || null, i.desc || null, i.fr_auto || null, i.qty || null, i.note || null, !!i.cable]);
        nl++;
      }
    }
    await pg.query('COMMIT');
    return { id: m.id, remplace: !!ex.rows.length, vues: b.views.length, lignes: nl };
  } catch (e) {
    try { await pg.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally { try { pg.release(); } catch (_) {} }

}

// Au démarrage : importe les éclatés livrés dans scripts/eclates/ quand le modèle n'a encore
// aucune vue en base (ou n'existe pas). Un éclaté déjà importé / corrigé à la main n'est jamais écrasé.
async function importerEclatesLivres(pool) {
  const dir = path.join(__dirname, '..', 'scripts', 'eclates');
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
    try {
      const b = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const slug = b.meta && b.meta.slug; if (!slug) continue;
      const r = await pool.query(`SELECT m.id, (SELECT COUNT(*)::int FROM eclates_vues v WHERE v.modele_id=m.id) AS nb
        FROM eclates_modeles m WHERE m.slug=$1`, [slug]);
      const cleV = 'eclate_reperes_v:' + slug, vFic = parseInt(b.meta.reperes_v) || 0;
      if (r.rows.length && r.rows[0].nb > 0) {
        // Déjà en base : on ne remplace QUE la position des bulles si le fichier livré est plus récent
        // (textes, références et quantités corrigés dans l'appli sont conservés)
        if (!vFic) continue;
        const pv = await pool.query('SELECT valeur FROM parametres WHERE cle=$1', [cleV]);
        if ((parseInt(pv.rows[0] && pv.rows[0].valeur) || 1) >= vFic) continue;
        let n = 0;
        for (const v of b.views) {
          if (!v.code) continue;
          const u = await pool.query('UPDATE eclates_vues SET reperes=$1 WHERE modele_id=$2 AND code=$3', [JSON.stringify(v.reperes || []), r.rows[0].id, v.code]);
          n += u.rowCount;
        }
        await pool.query('INSERT INTO parametres (cle, valeur) VALUES ($1,$2) ON CONFLICT (cle) DO UPDATE SET valeur=EXCLUDED.valeur', [cleV, String(vFic)]);
        console.log(`✅ Éclaté ${slug} : bulles repositionnées (${n} vues, version ${vFic})`);
        continue;
      }
      const res = await importerEclate(pool, { ...b, remplacer: true });
      if (vFic) await pool.query('INSERT INTO parametres (cle, valeur) VALUES ($1,$2) ON CONFLICT (cle) DO UPDATE SET valeur=EXCLUDED.valeur', [cleV, String(vFic)]);
      console.log(`✅ Éclaté ${slug} importé (${res.vues} vues, ${res.lignes} lignes)`);
    } catch (e) { console.error(`❌ Import éclaté ${f} :`, e.message); }
  }
}

module.exports = { importerEclate, importerEclatesLivres };
