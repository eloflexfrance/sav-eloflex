// server/securite-acces.js
// ─────────────────────────────────────────────────────────────────────────────
// Garde anti-aspiration des données (comptes non administrateurs) :
//  • volume : plus de N lectures (GET) en 10 minutes → accès suspendu 30 min ;
//  • balayage : plus de M fiches différentes d'un même type (clients, commandes, devis,
//    prêts, fauteuils…) ouvertes en 10 minutes → accès suspendu 30 min ;
//  • listes : taille de page plafonnée (per_page / limit ≤ 500).
// À chaque suspension : e-mail aux administrateurs + ligne dans le journal d'activité.
// Les administrateurs ne sont jamais limités ; ils peuvent lever une suspension
// (Paramètres → Utilisateurs). Seuils réglables : paramètres secu_max_lectures_10min,
// secu_max_fiches_10min, secu_blocage_minutes.
// ─────────────────────────────────────────────────────────────────────────────
const FENETRE = 10 * 60 * 1000;
const DEFAUTS = { lectures: 500, fiches: 80, blocage: 30 };
// Requêtes non comptées : images / pages de schémas, session, petits compteurs rafraîchis automatiquement
const EXCLUS = [/^\/eclates\/\d+\/(photo|pages\/\d+)$/, /^\/eclates\/\d+\/photo$/, /^\/auth\//, /^\/notes\/counts$/, /^\/discussions\/non-lues/,
  /^\/alertes$/, /^\/commandes-tableur$/, /^\/espace\/moi$/];
// Fiches individuelles surveillées pour le balayage : /clients/12, /commandes/34/…, etc.
const FICHE = /^\/(clients|commandes|devis|prets|fauteuils|interventions|contrats-cadre|demandes-info|catalogue|commandes-suede|commandes-suede-po)\/(\d+)(?:\/|$)/;

const hist = new Map();      // userId → { t: [timestamps], f: Map(type → Map(id → ts)) }
const bloques = new Map();   // userId → { jusqua, raison, nom, email, depuis }
let _cfg = null, _cfgLu = 0;

const esc = x => String(x == null ? '' : x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function config(db) {
  if (_cfg && Date.now() - _cfgLu < 5 * 60 * 1000) return _cfg;
  const c = { ...DEFAUTS };
  try {
    const rows = await db.all(`SELECT cle, valeur FROM parametres WHERE cle IN ('secu_max_lectures_10min','secu_max_fiches_10min','secu_blocage_minutes')`);
    for (const r of rows) {
      const n = parseInt(r.valeur);
      if (!(n > 0)) continue;
      if (r.cle === 'secu_max_lectures_10min') c.lectures = n;
      if (r.cle === 'secu_max_fiches_10min') c.fiches = n;
      if (r.cle === 'secu_blocage_minutes') c.blocage = n;
    }
  } catch (_) {}
  _cfg = c; _cfgLu = Date.now();
  return c;
}

function garde({ db, alerter }) {
  return async (req, res, next) => {
    const u = res.locals.user;
    if (!u || u.role === 'admin') return next();
    const id = u.id || ('d' + (u.distributeur && u.distributeur.client_id));
    const b = bloques.get(id);
    if (b) {
      if (b.jusqua > Date.now()) {
        if (req.path === '/auth/me' || req.path === '/auth/logout') return next();
        const h = new Date(b.jusqua).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
        return res.status(429).json({ error: `Accès temporairement suspendu jusqu'à ${h} (volume de consultation inhabituel). L'administrateur a été prévenu.`, suspendu: true });
      }
      bloques.delete(id);
    }
    // Listes : taille de page plafonnée
    for (const k of ['per_page', 'limit']) if (req.query && parseInt(req.query[k]) > 500) req.query[k] = '500';
    if (req.method !== 'GET' || EXCLUS.some(r => r.test(req.path))) return next();

    const now = Date.now();
    let h = hist.get(id);
    if (!h) { h = { t: [], f: new Map() }; hist.set(id, h); }
    h.t.push(now);
    while (h.t.length && h.t[0] < now - FENETRE) h.t.shift();
    let raison = null;
    const cfg = await config(db);
    const m = FICHE.exec(req.path);
    if (m) {
      const type = m[1] === 'commandes-suede-po' ? 'commandes-suede' : m[1];
      let ids = h.f.get(type); if (!ids) { ids = new Map(); h.f.set(type, ids); }
      ids.set(m[2], now);
      for (const [k, ts] of ids) if (ts < now - FENETRE) ids.delete(k);
      if (ids.size > cfg.fiches) raison = `${ids.size} fiches « ${type} » différentes consultées en 10 minutes`;
    }
    if (!raison && h.t.length > cfg.lectures) raison = `${h.t.length} lectures de données en 10 minutes`;
    if (!raison) return next();

    const fin = now + cfg.blocage * 60 * 1000;
    bloques.set(id, { jusqua: fin, raison, nom: u.nom || u.email || String(id), email: u.email || '', depuis: now, ip: req.ip, chemin: req.originalUrl });
    hist.delete(id);
    console.warn('[SECURITE] Accès suspendu :', u.nom || u.email, '—', raison);
    db.run(`INSERT INTO activity_logs (user_id, user_nom, action, module, methode, chemin, cible_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [u.id || null, u.nom || u.email || '—', 'Alerte sécurité', 'securite', 'GET', String(req.originalUrl).slice(0, 300), null]).catch(() => {});
    if (alerter) alerter(u, raison, cfg, req).catch(e => console.error('[SECURITE] e-mail :', e.message));
    const hh = new Date(fin).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
    return res.status(429).json({ error: `Accès temporairement suspendu jusqu'à ${hh} (volume de consultation inhabituel). L'administrateur a été prévenu.`, suspendu: true });
  };
}

// E-mail aux administrateurs
function fabriquerAlerte({ db, sendBrevoMail }) {
  return async (u, raison, cfg, req) => {
    const admins = await db.all(`SELECT email FROM users WHERE role='admin' AND actif IS NOT FALSE`);
    const to = admins.map(a => a.email).filter(Boolean).join(',');
    if (!to) return;
    const ligne = (k, v) => `<tr><td style="padding:6px 10px;border:1px solid #e5e7eb;background:#f8fafc;color:#555">${k}</td><td style="padding:6px 10px;border:1px solid #e5e7eb;font-weight:600">${v}</td></tr>`;
    await sendBrevoMail({ to, subject: `⚠️ Sécurité sav-eloflex — accès suspendu : ${u.nom || u.email}`,
      html: `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;max-width:620px">
        <p>Le compte ci-dessous a dépassé le seuil de consultation : son accès est <b>suspendu ${cfg.blocage} minutes</b>.</p>
        <table style="border-collapse:collapse;width:100%">
          ${ligne('Compte', esc(u.nom || '') + ' — ' + esc(u.email || ''))}
          ${ligne('Motif', esc(raison))}
          ${ligne('Dernière requête', esc(String(req.originalUrl).slice(0, 200)))}
          ${ligne('Adresse IP', esc(req.ip || ''))}
          ${ligne('Heure', new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }))}
        </table>
        <p>Si c'est normal, levez la suspension dans <b>Paramètres → Utilisateurs</b>. Sinon, désactivez le compte ou réduisez ses droits.</p></div>` });
  };
}

function monterAdmin(router, { adminOnly }) {
  router.get('/admin/securite', adminOnly, (req, res) => {
    const now = Date.now(), out = [];
    for (const [id, b] of bloques) if (b.jusqua > now) out.push({ user_id: id, nom: b.nom, email: b.email, raison: b.raison, jusqua: new Date(b.jusqua).toISOString(), depuis: new Date(b.depuis).toISOString() });
    res.json({ suspendus: out, seuils: _cfg || DEFAUTS });
  });
  router.post('/admin/securite/debloquer/:id', adminOnly, (req, res) => {
    const id = /^\d+$/.test(req.params.id) ? +req.params.id : req.params.id;
    bloques.delete(id); hist.delete(id);
    res.json({ ok: true });
  });
}

module.exports = { garde, fabriquerAlerte, monterAdmin, _bloques: bloques };
