// server/prets-livraison.js
// ─────────────────────────────────────────────────────────────────────────────
// Bon de prêt — expédition et début du prêt
//  • POST /prets/:id/envoyer-suivi : enregistre transporteur + n° de suivi + livraison estimée et
//    envoie au distributeur un e-mail mis en forme (lien de suivi UPS / DSV / La Poste / Chronopost),
//    copie à sav@eloflex.fr.
//  • POST /prets/:id/livraison-effective : la date de livraison réelle devient le début du prêt ;
//    la date de retour = livraison + durée (30 jours / 3 mois / 6 mois) ; e-mail de confirmation optionnel.
// ─────────────────────────────────────────────────────────────────────────────
const CC_SAV = 'sav@eloflex.fr';
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const esc = x => String(x == null ? '' : x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fr = d => d ? String(d instanceof Date ? d.toISOString() : d).slice(0, 10).split('-').reverse().join('/') : '';
const iso = d => d ? (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10) : '';

function lienSuivi(transporteur, numero) {
  const n = encodeURIComponent(String(numero || '').trim()); const t = String(transporteur || '').toLowerCase();
  if (!n) return '';
  if (t.includes('ups')) return `https://www.ups.com/track?loc=fr_FR&tracknum=${n}`;
  if (t.includes('dsv')) return `https://www.dsv.com/mydsv/tracking-public/?refNumber=${n}&language_region=fr-FR_FR`;
  if (t.includes('chrono')) return `https://www.chronopost.fr/tracking-no-cms/suivi-page?listeNumerosLT=${n}`;
  if (t.includes('poste') || t.includes('colissimo')) return `https://www.laposte.fr/outils/suivre-vos-envois?code=${n}`;
  return `https://t.17track.net/fr#nums=${n}`;
}
function dureeTxt(p) {
  if (p.formule === 'long_terme') return ([3, 6].includes(+p.duree_mois) ? +p.duree_mois : 3) + ' mois';
  return (+p.duree_essai ? Math.min(30, +p.duree_essai) : 30) + ' jours';
}
function finDuPret(p, debut) {
  const d = new Date(debut + 'T00:00:00Z');
  if (p.formule === 'long_terme') {
    const m = [3, 6].includes(+p.duree_mois) ? +p.duree_mois : 3, j = d.getUTCDate();
    d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + m);
    d.setUTCDate(Math.min(j, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()));
  } else d.setUTCDate(d.getUTCDate() + (+p.duree_essai ? Math.min(30, +p.duree_essai) : 30));
  return d.toISOString().slice(0, 10);
}
function materiel(p) {
  let a = p.articles; if (typeof a === 'string') { try { a = JSON.parse(a); } catch (_) { a = null; } }
  if (!Array.isArray(a) || !a.length) a = [{ designation: p.designation, num_serie: p.num_serie }];
  return a.filter(x => x && (x.designation || x.num_serie));
}
function gabarit(titre, corps, signature) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#222">
    <div style="background:#1F5C8C;padding:18px 22px;border-radius:8px 8px 0 0"><h2 style="color:#fff;margin:0;font-size:17px">${titre}</h2></div>
    <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;padding:22px;font-size:14px;line-height:1.55">${corps}</div>
    <div style="margin-top:24px">${signature}</div></div>`;
}
const ligne = (k, v) => `<tr><td style="padding:8px 12px;border:1px solid #e5e7eb;background:#f8fafc;width:42%;color:#555">${k}</td><td style="padding:8px 12px;border:1px solid #e5e7eb;font-weight:600">${v}</td></tr>`;

let _ok = false;
async function assurer(db) {
  if (_ok) return;
  for (const c of ['duree_mois INTEGER', 'transporteur TEXT', 'num_suivi TEXT', 'date_livraison_estimee DATE', 'date_livraison_effective DATE',
    'suivi_envoye_at TIMESTAMPTZ', 'livraison_confirmee_at TIMESTAMPTZ'])
    await db.run(`ALTER TABLE prets ADD COLUMN IF NOT EXISTS ${c}`);
  _ok = true;
}

module.exports = function monter(router, { db, requireAuth, envoyerEmailPret, BCC_PRETS, SIGNATURE_EMAIL_HTML }) {
  assurer(db).catch(e => console.error('[PRETS LIVRAISON]', e.message));
  const trace = async (id, u, quoi, to) => {
    const t = JSON.stringify([{ date: new Date().toISOString(), par: (u && (u.nom || u.email)) || null, to, type: quoi }]);
    await db.run(`UPDATE prets SET envois=COALESCE(envois,'[]'::jsonb) || $2::jsonb WHERE id=$1`, [id, t]);
  };
  const tableauMateriel = p => materiel(p).map(a => ligne('Fauteuil prêté', esc(a.designation || '') + (a.num_serie ? ` <span style="font-weight:400;color:#555">— n° ${esc(a.num_serie)}</span>` : ''))).join('');

  // Aperçu du texte (sans envoi) : utile pour relire avant d'envoyer
  router.post('/prets/:id/envoyer-suivi', requireAuth, async (req, res) => {
    try {
      await assurer(db);
      const b = req.body || {};
      const p = await db.get('SELECT * FROM prets WHERE id=$1', [req.params.id]);
      if (!p) return res.status(404).json({ error: 'Prêt introuvable' });
      const transporteur = String(b.transporteur || '').trim(), num = String(b.num_suivi || '').trim();
      const estimee = ISO.test(String(b.date_estimee || '')) ? b.date_estimee : null;
      const dest = String(b.email || p.email || '').trim();
      if (!transporteur || !num) return res.status(400).json({ error: 'Transporteur et n° de suivi obligatoires' });
      await db.run('UPDATE prets SET transporteur=$1, num_suivi=$2, date_livraison_estimee=$3, updated_at=NOW() WHERE id=$4', [transporteur, num, estimee, p.id]);
      const lien = lienSuivi(transporteur, num);
      const corps = `<p>Bonjour${p.contact ? ' ' + esc(p.contact) : ''},</p>
        <p>Votre fauteuil de prêt Eloflex a été remis au transporteur. Vous pouvez suivre son acheminement grâce aux informations ci-dessous.</p>
        <table role="presentation" style="width:100%;border-collapse:collapse;margin:8px 0 16px">
          ${tableauMateriel(p)}
          ${ligne('Transporteur', esc(transporteur))}
          ${ligne('N° de suivi', `<a href="${esc(lien)}" style="color:#1F5C8C">${esc(num)}</a>`)}
          ${estimee ? ligne('Livraison estimée', fr(estimee)) : ''}
          ${p.livraison_autre && (p.livraison_nom || p.livraison_adresse) ? ligne('Adresse de livraison', esc([p.livraison_nom, p.livraison_adresse].filter(Boolean).join(' — '))) : ''}
        </table>
        <p style="text-align:center;margin:20px 0"><a href="${esc(lien)}" style="background:#1F5C8C;color:#fff;text-decoration:none;padding:11px 24px;border-radius:6px;font-weight:600">Suivre mon colis${transporteur ? ' sur ' + esc(transporteur) : ''}</a></p>
        <div style="border-left:4px solid #1F5C8C;background:#f2f5f8;border-radius:6px;padding:12px 16px;margin:0 0 14px">
          <b>Début de votre prêt</b><br>La durée du prêt (<b>${dureeTxt(p)}</b>) court à compter de la <b>date de livraison effective</b>. Nous vous la confirmerons par e-mail dès réception, avec la date de retour correspondante.
        </div>
        <p>Pensez à conserver l'emballage d'origine et les mousses de protection : ils seront nécessaires au retour du fauteuil.</p>
        <p>Restant à votre disposition.<br>Bien cordialement</p>`;
      const sujet = `Eloflex — Expédition de votre fauteuil de prêt${p.bdc_vf ? ' (' + p.bdc_vf + ')' : ''} — suivi ${transporteur}`;
      const html = gabarit('Votre fauteuil de prêt est en route', corps, SIGNATURE_EMAIL_HTML());
      if (b.apercu) return res.json({ ok: true, apercu: true, to: dest, cc: CC_SAV, sujet, html });
      if (!dest) return res.status(400).json({ error: 'Aucune adresse e-mail pour ce distributeur' });
      await envoyerEmailPret({ to: dest, cc: CC_SAV, bcc: BCC_PRETS, subject: sujet, html });
      await db.run('UPDATE prets SET suivi_envoye_at=NOW() WHERE id=$1', [p.id]);
      await trace(p.id, res.locals.user, 'suivi', dest);
      res.json({ ok: true, to: dest, cc: CC_SAV, lien });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/prets/:id/livraison-effective', requireAuth, async (req, res) => {
    try {
      await assurer(db);
      const b = req.body || {};
      const p = await db.get('SELECT * FROM prets WHERE id=$1', [req.params.id]);
      if (!p) return res.status(404).json({ error: 'Prêt introuvable' });
      const date = String(b.date || '').slice(0, 10);
      if (!ISO.test(date)) return res.status(400).json({ error: 'Date de livraison invalide' });
      const retour = finDuPret(p, date);
      const row = await db.run(`UPDATE prets SET date_livraison_effective=$1, date_remise=$1, date_retour_prevue=$2, livraison_confirmee_at=NOW(),
          statut=CASE WHEN statut IN ('brouillon','envoye','signe') THEN 'en_cours' ELSE statut END, updated_at=NOW()
        WHERE id=$3 RETURNING id, statut, date_remise, date_retour_prevue`, [date, retour, p.id]);
      const out = { ok: true, debut: date, retour, statut: row.statut, mail: false };
      if (b.envoyer) {
        const dest = String(b.email || p.email || '').trim();
        if (!dest) return res.json({ ...out, avertissement: 'Dates enregistrées, mais aucune adresse e-mail pour prévenir le distributeur' });
        const corps = `<p>Bonjour${p.contact ? ' ' + esc(p.contact) : ''},</p>
          <p>Nous vous confirmons la bonne livraison de votre fauteuil de prêt Eloflex. <b>Votre prêt démarre à la date de livraison effective.</b></p>
          <table role="presentation" style="width:100%;border-collapse:collapse;margin:8px 0 16px">
            ${tableauMateriel(p)}
            ${ligne('Formule', p.formule === 'long_terme' ? 'Prêt long terme (renouvelable)' : 'Essai court')}
            ${ligne('Durée du prêt', dureeTxt(p))}
            ${ligne('Début du prêt (livraison)', fr(date))}
            ${ligne('Date de retour prévue', fr(retour))}
          </table>
          <p>Quelques jours avant l'échéance, nous reviendrons vers vous pour organiser le retour ou une éventuelle prolongation. Merci de conserver l'emballage d'origine et les mousses de protection.</p>
          <p>Restant à votre disposition.<br>Bien cordialement</p>`;
        await envoyerEmailPret({ to: dest, cc: CC_SAV, bcc: BCC_PRETS, subject: `Eloflex — Début de votre prêt : du ${fr(date)} au ${fr(retour)}`, html: gabarit('Votre prêt a commencé', corps, SIGNATURE_EMAIL_HTML()) });
        await trace(p.id, res.locals.user, 'livraison', dest);
        out.mail = true; out.to = dest;
      }
      res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
module.exports.lienSuivi = lienSuivi;
module.exports.finDuPret = finDuPret;
