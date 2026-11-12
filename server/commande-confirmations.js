// server/commande-confirmations.js
// ─────────────────────────────────────────────────────────────────────────────
// Confirmation de commande par le distributeur : le mail de validation (glissé depuis
// Outlook → .msg, ou exporté en .eml), un PDF / une capture, ou le texte collé, est
// archivé sur la commande (table documents_signes, objet 'commande').
// À l'ajout : « BDC confirmé par mail » est coché et la date de confirmation renseignée
// (date du mail, sinon aujourd'hui) si elle ne l'était pas déjà.
// ─────────────────────────────────────────────────────────────────────────────
let _ok = false;
async function assurer(db) {
  if (_ok) return;
  await db.run(`CREATE TABLE IF NOT EXISTS documents_signes (
    id SERIAL PRIMARY KEY, objet TEXT NOT NULL, objet_id INTEGER NOT NULL,
    nom TEXT, mime TEXT, taille INTEGER, data TEXT NOT NULL, ajoute_par INTEGER, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await db.run(`ALTER TABLE documents_signes ADD COLUMN IF NOT EXISTS apercu JSONB`);
  _ok = true;
}

// ── Lecture d'un mail ───────────────────────────────────────────────
const isoDe = d => { const x = d ? new Date(d) : null; return x && !isNaN(x) ? x.toISOString() : null; };
function decoder(buf, charset) {
  const cs = String(charset || 'utf-8').toLowerCase().replace(/^(x-)?windows-1252$|^iso-8859-15?$|^latin-?1$/, 'latin1');
  try { return new TextDecoder(cs === 'latin1' ? 'windows-1252' : cs).decode(buf); } catch (_) { return buf.toString('utf8'); }
}
function motsEncodes(s) {   // =?utf-8?Q?...?= / =?utf-8?B?...?=
  return String(s || '').replace(/=\?([^?]+)\?([QBqb])\?([^?]*)\?=/g, (m, cs, enc, txt) => {
    try {
      const buf = enc.toUpperCase() === 'B' ? Buffer.from(txt, 'base64')
        : Buffer.from(txt.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (x, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
      return decoder(buf, cs);
    } catch (_) { return m; }
  }).replace(/\?=\s+=\?/g, '');
}
const sansHtml = h => String(h || '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li)>/gi, '\n')
  .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\n{3,}/g, '\n\n').trim();
function lireEml(buf) {
  const brut = buf.toString('latin1');
  const sep = brut.search(/\r?\n\r?\n/);
  const enTete = (sep >= 0 ? brut.slice(0, sep) : brut).replace(/\r?\n[ \t]+/g, ' ');
  const h = k => { const m = enTete.match(new RegExp('^' + k + ':\\s*(.*)$', 'im')); return m ? motsEncodes(m[1].trim()) : ''; };
  // Partie texte (text/plain de préférence, sinon text/html)
  let texte = '';
  const parties = [];
  const parcourir = (bloc) => {
    const s = bloc.search(/\r?\n\r?\n/); if (s < 0) return;
    const eh = bloc.slice(0, s).replace(/\r?\n[ \t]+/g, ' '), corps = bloc.slice(s).replace(/^\r?\n\r?\n/, '');
    const ct = (eh.match(/^content-type:\s*([^;\r\n]+)/im) || [])[1] || 'text/plain';
    const bnd = (eh.match(/boundary="?([^";\r\n]+)"?/i) || [])[1];
    if (/^multipart\//i.test(ct) && bnd) { corps.split('--' + bnd).slice(1).forEach(p => { if (!/^--/.test(p)) parcourir(p.replace(/^\r?\n/, '')); }); return; }
    const cte = ((eh.match(/^content-transfer-encoding:\s*(\S+)/im) || [])[1] || '').toLowerCase();
    const cs = (eh.match(/charset="?([^";\s]+)"?/i) || [])[1];
    let b = Buffer.from(corps, 'latin1');
    if (cte === 'base64') b = Buffer.from(corps.replace(/\s+/g, ''), 'base64');
    else if (cte === 'quoted-printable') b = Buffer.from(corps.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (x, hx) => String.fromCharCode(parseInt(hx, 16))), 'latin1');
    parties.push({ ct: ct.toLowerCase(), txt: decoder(b, cs) });
  };
  parcourir(brut);
  const p = parties.find(x => x.ct === 'text/plain') || parties.find(x => x.ct === 'text/html');
  if (p) texte = p.ct === 'text/html' ? sansHtml(p.txt) : p.txt.trim();
  return { de: h('From'), a: h('To'), objet: h('Subject'), date: isoDe(h('Date')), texte };
}
function lireMsg(buf) {
  const MsgReader = require('@kenjiuno/msgreader').default;
  const d = new MsgReader(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)).getFileData();
  if (d.error) throw new Error(d.error);
  const de = [d.senderName, d.senderEmail || d.senderSmtpAddress ? `<${d.senderSmtpAddress || d.senderEmail}>` : ''].filter(Boolean).join(' ');
  const a = (d.recipients || []).filter(r => !r.recipType || r.recipType === 'to').map(r => r.smtpAddress || r.email || r.name).filter(Boolean).join(', ');
  return { de, a, objet: d.subject || '', date: isoDe(d.messageDeliveryTime || d.clientSubmitTime || d.creationTime),
    texte: String(d.body || (d.bodyHtml ? sansHtml(d.bodyHtml) : '')).replace(/\r\n/g, '\n').trim() };
}

module.exports = function monterConfirmations(router, { db }) {
  // Liste des confirmations d'une commande (sans le contenu des fichiers)
  router.get('/commandes/:id/confirmations', async (req, res) => {
    try {
      await assurer(db);
      res.json(await db.all(`SELECT d.id, d.nom, d.mime, d.taille, d.apercu, d.created_at, u.nom AS ajoute_par_nom
        FROM documents_signes d LEFT JOIN users u ON u.id=d.ajoute_par WHERE d.objet='commande' AND d.objet_id=$1 ORDER BY d.created_at`, [req.params.id]));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Ajout : { fichier:{ nom, data (data-URL) } } et/ou { texte }
  router.post('/commandes/:id/confirmation', async (req, res) => {
    try {
      await assurer(db);
      const cmd = await db.get('SELECT id, confirmation_mode, date_confirmation FROM commandes WHERE id=$1', [req.params.id]);
      if (!cmd) return res.status(404).json({ error: 'Commande introuvable' });
      const b = req.body || {}, uid = (req.session && req.session.user && req.session.user.id) || null;
      let nom, mime, data, apercu = {};
      if (b.fichier && b.fichier.data) {
        nom = String(b.fichier.nom || 'confirmation').slice(0, 200);
        const m = /^data:([^;,]*)(;base64)?,/.exec(String(b.fichier.data));
        if (!m) return res.status(400).json({ error: 'Fichier illisible' });
        if (String(b.fichier.data).length > 22000000) return res.status(400).json({ error: 'Fichier trop lourd (15 Mo max)' });
        const buf = Buffer.from(String(b.fichier.data).slice(m[0].length), 'base64');
        const ext = (nom.match(/\.([a-z0-9]+)$/i) || [])[1] || '';
        if (/^msg$/i.test(ext) || buf.slice(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) {
          mime = 'application/vnd.ms-outlook'; if (!/\.msg$/i.test(nom)) nom += '.msg';
          try { apercu = lireMsg(buf); } catch (e) { apercu = { erreur: 'Mail Outlook non lu : ' + e.message }; }
        } else if (/^eml$/i.test(ext) || m[1] === 'message/rfc822') {
          mime = 'message/rfc822';
          try { apercu = lireEml(buf); } catch (e) { apercu = { erreur: 'Mail non lu : ' + e.message }; }
        } else if (/^(application\/pdf|image\/(jpeg|png|webp|gif))$/.test(m[1])) {
          mime = m[1];
        } else if (/^text\//.test(m[1]) || /^txt$/i.test(ext)) {
          mime = 'text/plain'; apercu = { texte: decoder(buf, 'utf-8').trim() };
        } else return res.status(400).json({ error: 'Format non pris en charge : mail Outlook (.msg), .eml, PDF, image ou texte' });
        data = `data:${mime};base64,` + buf.toString('base64');
      } else if (String(b.texte || '').trim()) {
        const t = String(b.texte).trim();
        nom = 'confirmation (texte collé).txt'; mime = 'text/plain'; apercu = { texte: t };
        data = 'data:text/plain;base64,' + Buffer.from(t, 'utf8').toString('base64');
      } else return res.status(400).json({ error: 'Rien à enregistrer' });
      if (apercu.texte && apercu.texte.length > 4000) apercu.texte = apercu.texte.slice(0, 4000) + '…';
      const doc = await db.run(`INSERT INTO documents_signes (objet, objet_id, nom, mime, taille, data, ajoute_par, apercu)
        VALUES ('commande',$1,$2,$3,$4,$5,$6,$7) RETURNING id, nom, mime, taille, apercu, created_at`,
        [cmd.id, nom, mime, Math.round(data.length * 0.75), data, uid, JSON.stringify(apercu)]);
      // Commande : confirmée par mail (sans écraser un autre mode déjà choisi ni une date déjà saisie)
      const jour = (apercu.date ? new Date(apercu.date) : new Date()).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
      const maj = await db.run(`UPDATE commandes SET confirmation_mode=COALESCE(NULLIF(confirmation_mode,''),'mail'), confirmation_recue=TRUE,
          date_confirmation=COALESCE(NULLIF(date_confirmation::text,''), $1), updated_at=NOW() WHERE id=$2
          RETURNING confirmation_mode, date_confirmation`, [jour, cmd.id]);
      res.json({ ok: true, doc, confirmation_mode: maj && maj.confirmation_mode, date_confirmation: maj && maj.date_confirmation });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/commandes/:id/confirmations/:docId', async (req, res) => {
    try {
      await assurer(db);
      await db.run(`DELETE FROM documents_signes WHERE id=$1 AND objet='commande' AND objet_id=$2`, [req.params.docId, req.params.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
module.exports.assurer = assurer;
