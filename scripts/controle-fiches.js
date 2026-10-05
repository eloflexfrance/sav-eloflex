// scripts/controle-fiches.js
// ─────────────────────────────────────────────────────────────────────────────
// Contrôle qualité des fiches distributeurs :
//   • vérification d'adresse (Base Adresse Nationale — France) ;
//   • création / complément d'une fiche à partir du client Pennylane d'un devis ;
//   • e-mail de contrôle (sav@eloflex.fr par défaut) : fiche créée, absente de la carte,
//     adresse en anomalie. La fiche est TOUJOURS créée, l'e-mail sert à contrôler.
// ─────────────────────────────────────────────────────────────────────────────
const axios = require('axios');
const db = require('../server/db');

const _sansAccent = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
function _normVille(s) {
  return _sansAccent(s).toUpperCase()
    .replace(/\bCEDEX\b.*$/, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\bSTE\b/g, 'SAINTE').replace(/\bST\b/g, 'SAINT')
    .replace(/\s+/g, ' ').trim();
}
function _villesEgales(a, b) {
  const x = _normVille(a), y = _normVille(b);
  if (!x || !y) return true;
  if (x === y) return true;
  // « PARIS 2E ARRONDISSEMENT » / « LYON 3E » etc.
  return x.startsWith(y + ' ') || y.startsWith(x + ' ') || x.replace(/ /g, '') === y.replace(/ /g, '');
}
// Similarité entre la rue saisie et la rue trouvée (mots significatifs, tolère fautes de frappe / abréviations)
const _STOP = new Set('RUE R AVENUE AV AVE BD BLD BOULEVARD CHEMIN CHE CH ALLEE ALL PLACE PL IMPASSE IMP ROUTE RTE QUAI COURS CRS SQUARE SQ PASSAGE RESIDENCE RES LOTISSEMENT LOT FAUBOURG FBG VOIE SENTIER ESPLANADE PROMENADE DE DU DES LA LE LES L D ET A AU AUX EN SUR SOUS BIS TER'.split(' '));
const _ABR = { ST: 'SAINT', STE: 'SAINTE', GAL: 'GENERAL', GL: 'GENERAL', GEN: 'GENERAL', MAL: 'MARECHAL', MAR: 'MARECHAL', DR: 'DOCTEUR', PDT: 'PRESIDENT', PRES: 'PRESIDENT', CDT: 'COMMANDANT', LT: 'LIEUTENANT', PROF: 'PROFESSEUR' };
function _toksRue(s) {
  return _sansAccent(s).toUpperCase().replace(/[^A-Z0-9]+/g, ' ').split(' ')
    .map(w => _ABR[w] || w).filter(w => w && !/^\d+[A-Z]?$/.test(w) && !_STOP.has(w));
}
function _lev(a, b) {
  const m = a.length, n = b.length; if (Math.abs(m - n) > 2) return 9;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[n];
}
function _simRue(saisie, trouvee) {
  const A = _toksRue(saisie), B = _toksRue(trouvee);
  if (!A.length) return 1;
  const ok = A.filter(a => B.some(b => b === a || (a.length >= 3 && b.startsWith(a)) || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || _lev(a, b) <= (a.length >= 7 ? 2 : 1)))));
  return ok.length / A.length;
}
const _estFrance = p => !p || /^(france|fr|fra)$/i.test(String(p).trim());

// Recherche BAN (nouvelle Géoplateforme IGN, puis ancien point d'accès en secours)
async function _ban(q, extra = {}) {
  const urls = ['https://data.geopf.fr/geocodage/search', 'https://api-adresse.data.gouv.fr/search/'];
  let lastErr = null;
  for (const url of urls) {
    try {
      const { data } = await axios.get(url, { params: { q: q.slice(0, 200), limit: 5, ...extra }, timeout: 7000 });
      if (data && Array.isArray(data.features)) return data.features;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('BAN injoignable');
}

async function _communesDuCP(cp) {
  try {
    const { data } = await axios.get('https://geo.api.gouv.fr/communes', { params: { codePostal: cp, fields: 'nom', format: 'json' }, timeout: 6000 });
    return Array.isArray(data) ? data.map(c => c.nom) : null;
  } catch (_) { return null; }
}

/**
 * Vérifie une adresse.
 * @returns {statut:'ok'|'approx'|'anomalie'|'non_verifiee', message, anomalies:[], suggestion:{adresse,cp,ville,label}|null, lat, lng, score}
 */
async function verifierAdresse({ adresse, cp, ville, pays } = {}) {
  adresse = String(adresse || '').trim(); cp = String(cp || '').trim(); ville = String(ville || '').trim();
  const res = { statut: 'ok', message: '', anomalies: [], suggestion: null, lat: null, lng: null, score: null };
  if (!_estFrance(pays)) return { ...res, statut: 'non_verifiee', message: 'Adresse hors France : non vérifiée automatiquement' };
  if (!adresse && !cp && !ville) return { ...res, statut: 'anomalie', anomalies: ['Aucune adresse renseignée'], message: 'Aucune adresse renseignée' };
  if (cp && !/^\d{5}$/.test(cp)) res.anomalies.push(`Code postal « ${cp} » invalide (5 chiffres attendus)`);
  if (!cp) res.anomalies.push('Code postal manquant');
  if (!ville) res.anomalies.push('Ville manquante');
  const cedex = /cedex/i.test(ville) || /cedex/i.test(adresse);

  try {
    if (!adresse) {
      // Pas de rue : contrôle de cohérence code postal ↔ commune
      if (/^\d{5}$/.test(cp)) {
        const communes = await _communesDuCP(cp);
        if (communes === null) throw new Error('geo.api.gouv.fr injoignable');
        if (!communes.length && !cedex) res.anomalies.push(`Le code postal ${cp} n'existe pas`);
        else if (ville && !cedex && !communes.some(n => _villesEgales(n, ville))) {
          res.anomalies.push(`La ville « ${ville} » ne correspond pas au code postal ${cp} (${communes.slice(0, 4).join(', ')})`);
          res.suggestion = { adresse: '', cp, ville: communes[0], label: `${cp} ${communes[0]}` };
        }
      }
      res.anomalies.push('Adresse (rue) manquante');
    } else {
      // Les boîtes postales / CS ne sont pas dans la BAN
      const rue = adresse.replace(/\b(BP|CS|TSA)\s*\d+\b/gi, ' ').replace(/\s+/g, ' ').trim();
      if (!_toksRue(rue).length) {
        return { ...res, statut: res.anomalies.length ? 'anomalie' : 'approx',
          message: res.anomalies.length ? res.anomalies.join(' · ') : 'Boîte postale / adresse sans nom de rue : non vérifiable' };
      }
      const villeQ = ville.replace(/cedex.*$/i, '').trim();
      const rueDe = f => (f.properties && (f.properties.street || f.properties.name)) || '';
      const bonne = f => f && f.properties && f.properties.type !== 'municipality' && _simRue(rue, rueDe(f)) >= 0.6;
      // 1) adresse complète ; 2) sans code postal (le CP saisi peut être faux) ; 3) rue + CP seul (ville mal orthographiée)
      let feats = await _ban([rue, cp, villeQ].filter(Boolean).join(' '));
      let f = feats.find(bonne);
      if (!f && villeQ) { feats = await _ban([rue, villeQ].join(' ')); f = feats.find(x => bonne(x) && _villesEgales(villeQ, x.properties.city)); }
      if (!f && /^\d{5}$/.test(cp)) { feats = await _ban([rue, cp].join(' ')); f = feats.find(x => bonne(x) && x.properties.postcode === cp); }
      if (!f) {
        res.anomalies.push(`Rue « ${rue} » introuvable${cp || ville ? ' à ' + [cp, ville].filter(Boolean).join(' ') : ''} dans la Base Adresse Nationale` +
          (/\b(ZA|ZI|ZAC|ZAE|PARC|LIEU[- ]DIT|LD|HAMEAU|CENTRE COMMERCIAL|CC)\b/i.test(rue) ? ' (zone d\'activité / lieu-dit : à vérifier manuellement)' : ''));
      } else {
        const p = f.properties || {};
        res.score = Math.round((p.score || 0) * 100) / 100;
        if (f.geometry && f.geometry.coordinates) { res.lng = f.geometry.coordinates[0]; res.lat = f.geometry.coordinates[1]; }
        res.suggestion = { adresse: p.name || '', cp: p.postcode || '', ville: p.city || '', label: p.label || '' };
        if (cp && p.postcode && cp !== p.postcode && !cedex)
          res.anomalies.push(`Le code postal ${cp} ne correspond pas à cette adresse (${p.postcode} attendu)`);
        if (ville && p.city && !cedex && !_villesEgales(ville, p.city))
          res.anomalies.push(`La ville « ${ville} » ne correspond pas à cette adresse (« ${p.city} » attendu)`);
        if (!res.anomalies.length && (_simRue(rue, rueDe(f)) < 1 || p.score < 0.6)) res.statut = 'approx';
      }
    }
  } catch (e) {
    const fmt = res.anomalies.filter(a => !/^Adresse \(rue\) manquante$/.test(a));
    if (fmt.length) return { ...res, anomalies: fmt, statut: 'anomalie', message: fmt.join(' · ') + ' (vérification en ligne indisponible)' };
    return { ...res, statut: 'non_verifiee', message: 'Service de vérification indisponible (' + e.message + ')' };
  }
  if (res.anomalies.length) res.statut = 'anomalie';
  res.message = res.statut === 'ok' ? 'Adresse vérifiée (Base Adresse Nationale)'
    : res.statut === 'approx' ? 'Adresse reconnue approximativement — vérifiez la suggestion'
    : res.anomalies.join(' · ');
  return res;
}

// Suggestions pendant la saisie (autocomplétion)
async function suggestionsAdresse(q) {
  q = String(q || '').trim();
  if (q.length < 4) return [];
  const feats = await _ban(q, { autocomplete: 1 });
  return feats.map(f => {
    const p = f.properties || {};
    return { label: p.label, adresse: p.type === 'municipality' ? '' : p.name, cp: p.postcode, ville: p.city, type: p.type,
      lat: f.geometry && f.geometry.coordinates ? f.geometry.coordinates[1] : null,
      lng: f.geometry && f.geometry.coordinates ? f.geometry.coordinates[0] : null };
  });
}

// Mémorise le résultat de la vérification sur la fiche
async function enregistrerVerif(clientId, v) {
  try {
    await db.run('UPDATE clients SET adresse_verif=$1, adresse_verif_msg=$2, adresse_verif_at=NOW() WHERE id=$3',
      [v.statut, (v.message || '').slice(0, 500) || null, clientId]);
  } catch (_) {}
}

function _fmtTel(t) {
  let d = String(t || '').replace(/[^\d+]/g, '');
  if (/^\+33\d{9}$/.test(d)) d = '0' + d.slice(3);
  if (/^0\d{9}$/.test(d)) return d.replace(/(\d{2})(?=\d)/g, '$1 ').trim();
  return String(t || '').trim();
}
// ── Client Pennylane → champs de fiche ──────────────────────────────────────
const PAYS = { FR: 'France', BE: 'Belgique', CH: 'Suisse', LU: 'Luxembourg', DE: 'Allemagne', ES: 'Espagne', IT: 'Italie', MC: 'Monaco', SE: 'Suède', NL: 'Pays-Bas', GB: 'Royaume-Uni', PT: 'Portugal' };
function ficheDepuisCustomerPL(c) {
  if (!c) return null;
  const a = c.billing_address || c.address || c.headquarter_address || {};
  const nom = (c.name || c.company_name || c.label || [c.first_name, c.last_name].filter(Boolean).join(' ') || '').trim();
  const emails = Array.isArray(c.emails) ? c.emails : (c.emails ? [c.emails] : []);
  const email = String(c.billing_email || c.email || emails[0] || '').trim();
  const iso = String(a.country_alpha2 || c.country_alpha2 || '').toUpperCase();
  const siren = String(c.reg_no || c.registration_number || c.siren || '').replace(/\D/g, '');
  return {
    nom,
    email: email || null,
    tel: _fmtTel(c.phone || c.phone_number) || null,
    adresse: String(a.address || a.street_address || a.line1 || '').trim() || null,
    cp: String(a.postal_code || a.zip_code || a.postcode || '').trim() || null,
    ville: String(a.city || a.town || '').trim() || null,
    pays: PAYS[iso] || (iso ? iso : 'France'),
    contact: String(c.recipient || '').trim() || null,
    siren: siren.length >= 9 ? siren.slice(0, 9) : null,
    siret: siren.length === 14 ? siren : null,
    tva: String(c.vat_number || '').replace(/\s+/g, '').toUpperCase() || null,
  };
}
async function customerPennylane(id) {
  if (!id || !(process.env.PENNYLANE_API_KEY || process.env.PENNYLANE_TOKEN)) return null;
  const { plApi } = require('./sync-pennylane');
  const api = plApi();
  for (const ep of [`/customers/${id}`, `/company_customers/${id}`, `/individual_customers/${id}`]) {
    try {
      const { data } = await api.get(ep);
      const c = data.customer || data.company_customer || data.individual_customer || data;
      if (c && (c.name || c.first_name || c.billing_address)) return c;
    } catch (_) {}
  }
  return null;
}

// ── Absence de la carte ─────────────────────────────────────────────────────
async function estSurCarte(cl) {
  if (cl.sur_carte) return true;
  const r = await db.get('SELECT id FROM distributeurs_carte WHERE client_id=$1 LIMIT 1', [cl.id]);
  if (r) return true;
  const n = _normVille(cl.nom);
  if (!n) return false;
  const m = await db.all('SELECT nom FROM distributeurs_carte');
  return m.some(x => _normVille(x.nom) === n);
}

// ── E-mail de contrôle ──────────────────────────────────────────────────────
async function destinataireControle() {
  const r = await db.get("SELECT valeur FROM parametres WHERE cle='email_controle_fiches'");
  if (!r) return 'sav@eloflex.fr';
  return String(r.valeur || '').trim();       // vide = envois désactivés
}
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function envoyerMailControle(sujet, sections, cl) {
  const to = await destinataireControle();
  if (!to || !process.env.BREVO_API_KEY) return false;
  const p = {}; (await db.all("SELECT cle, valeur FROM parametres WHERE cle IN ('email_from','app_url')")).forEach(r => p[r.cle] = r.valeur);
  const url = (p.app_url || process.env.APP_URL || '').replace(/\/$/, '');
  const fiche = cl ? `<table style="border-collapse:collapse;font-size:13px;margin:8px 0">${[
      ['Nom', cl.nom], ['Contact', cl.contact], ['E-mail', cl.email], ['Téléphone', cl.tel],
      ['Adresse', [cl.adresse, cl.adresse2].filter(Boolean).join(' — ')], ['CP / Ville', [cl.cp, cl.ville].filter(Boolean).join(' ')],
      ['Pays', cl.pays], ['SIREN', cl.siren], ['TVA', cl.tva], ['Sur la carte', cl.sur_carte ? 'Oui' : 'Non']]
      .filter(x => x[1]).map(x => `<tr><td style="padding:2px 10px 2px 0;color:#666">${x[0]}</td><td style="padding:2px 0"><b>${esc(x[1])}</b></td></tr>`).join('')}</table>` : '';
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
    ${sections.map(s => `<h3 style="color:#1F5C8C;font-size:15px;margin:14px 0 6px">${s.titre}</h3>${s.html}`).join('')}
    ${fiche ? `<h3 style="color:#1F5C8C;font-size:15px;margin:14px 0 6px">Fiche distributeur</h3>${fiche}` : ''}
    ${url && cl ? `<p><a href="${url}/#clients" style="color:#1F5C8C">Ouvrir l'application SAV</a> — fiche n° ${cl.id}</p>` : ''}
    <p style="color:#888;font-size:12px">E-mail automatique de contrôle des fiches — application SAV Eloflex.</p></div>`;
  const key = process.env.BREVO_API_KEY;
  await axios.post('https://api.brevo.com/v3/smtp/email', {
    sender: { name: 'Eloflex SAV', email: p.email_from && /@/.test(p.email_from) ? p.email_from.replace(/^.*<|>.*$/g, '').trim() : 'sav@eloflex.fr' },
    to: to.split(/[,;\s]+/).filter(Boolean).map(email => ({ email })),
    subject: sujet, htmlContent: html
  }, { headers: { 'api-key': key, 'Content-Type': 'application/json' }, timeout: 30000 });
  return true;
}
function _sectionAdresse(v, cl) {
  return { titre: '⚠️ Adresse à contrôler', html:
    `<p>Adresse saisie : <b>${esc([cl.adresse, cl.cp, cl.ville].filter(Boolean).join(', ') || '—')}</b></p>
     <ul>${(v.anomalies || []).map(a => `<li>${esc(a)}</li>`).join('')}</ul>
     ${v.suggestion && v.suggestion.label ? `<p>Suggestion : <b>${esc(v.suggestion.label)}</b></p>` : ''}
     <p>La fiche a bien été enregistrée ; merci de corriger l'adresse si nécessaire.</p>` };
}

/**
 * Après la création d'une commande : complète la fiche depuis Pennylane, vérifie
 * l'adresse, contrôle la présence sur la carte et notifie par e-mail.
 * Ne bloque jamais la commande (toutes les erreurs sont absorbées).
 */
async function apresCommande({ clientId, creee, plCustomerId, commande }) {
  try {
    if (!clientId) return;
    let cl = await db.get('SELECT * FROM clients WHERE id=$1', [clientId]);
    if (!cl) return;
    const sections = [];
    let modifies = [];

    // 1) Données Pennylane
    if (plCustomerId) {
      const cust = await customerPennylane(plCustomerId);
      const f = ficheDepuisCustomerPL(cust);
      if (f) {
        const champs = ['contact', 'email', 'tel', 'adresse', 'cp', 'ville', 'pays', 'siren', 'siret', 'tva'];
        const sets = [], vals = [];
        for (const k of champs) {
          if (!f[k]) continue;
          const vide = cl[k] == null || String(cl[k]).trim() === '' || (k === 'pays' && creee);
          if (vide && String(cl[k] || '') !== String(f[k])) { vals.push(f[k]); sets.push(`${k}=$${vals.length}`); modifies.push(k); }
        }
        if (!cl.pl_customer_id) { vals.push(String(plCustomerId)); sets.push(`pl_customer_id=$${vals.length}`); }
        if (sets.length) {
          vals.push(clientId);
          await db.run(`UPDATE clients SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$${vals.length}`, vals);
          cl = await db.get('SELECT * FROM clients WHERE id=$1', [clientId]);
        }
      }
    }
    const libChamp = { contact: 'contact', email: 'e-mail', tel: 'téléphone', adresse: 'adresse', cp: 'code postal', ville: 'ville', pays: 'pays', siren: 'SIREN', siret: 'SIRET', tva: 'n° TVA' };
    const refCmd = commande ? `${commande.bdc || '#' + commande.id}` : '';
    if (creee) {
      sections.push({ titre: '🆕 Nouvelle fiche distributeur créée', html:
        `<p>La commande <b>${esc(refCmd)}</b> a été saisie pour un distributeur inconnu de l'application : la fiche <b>${esc(cl.nom)}</b> a été créée automatiquement${plCustomerId ? ' avec les informations du client Pennylane' : ''}.</p>
         ${plCustomerId && !modifies.length ? '<p>⚠️ Aucune information n\'a pu être récupérée depuis Pennylane.</p>' : ''}
         ${!plCustomerId ? '<p>⚠️ Commande non issue d\'un devis Pennylane : fiche à compléter manuellement.</p>' : ''}` });
    } else if (modifies.length) {
      sections.push({ titre: '🔄 Fiche distributeur complétée depuis Pennylane', html:
        `<p>Commande <b>${esc(refCmd)}</b> : champs vides de la fiche <b>${esc(cl.nom)}</b> complétés depuis Pennylane : ${modifies.map(k => libChamp[k] || k).join(', ')}.</p>` });
    }

    // 2) Vérification d'adresse (fiche créée ou adresse modifiée)
    if (creee || modifies.some(k => ['adresse', 'cp', 'ville', 'pays'].includes(k))) {
      const v = await verifierAdresse(cl);
      await enregistrerVerif(clientId, v);
      if (v.statut === 'anomalie') sections.push(_sectionAdresse(v, cl));
    }

    // 3) Présence sur la carte (une seule alerte par fiche)
    const typeOk = !/particulier|patient/i.test(cl.type || '');
    if (typeOk && !(await estSurCarte(cl)) && !cl.carte_controle_at) {
      sections.push({ titre: '🗺️ Distributeur absent de la carte', html:
        `<p><b>${esc(cl.nom)}</b> a passé commande (${esc(refCmd)}) mais n'apparaît pas sur la carte des distributeurs. À contrôler : cocher « Afficher sur la carte » dans sa fiche si besoin.</p>` });
      await db.run('UPDATE clients SET carte_controle_at=NOW() WHERE id=$1', [clientId]);
    }

    if (sections.length) {
      const sujet = creee ? `Nouvelle fiche distributeur : ${cl.nom}` + (sections.some(s => /Adresse/.test(s.titre)) ? ' — adresse à contrôler' : '')
        : sections.length === 1 && /carte/.test(sections[0].titre) ? `Distributeur absent de la carte : ${cl.nom}`
        : `Fiche distributeur à contrôler : ${cl.nom}`;
      try { await envoyerMailControle(sujet, sections, cl); } catch (e) { console.error('[CONTROLE FICHES] mail', e.message); }
      try {
        await db.run('INSERT INTO alertes (type, reference_id, message) VALUES ($1,$2,$3)', ['controle_fiche', clientId,
          `📇 ${sujet} — ${sections.map(s => s.titre.replace(/^\S+\s/, '')).join(', ')}`]);
      } catch (_) {}
    }
  } catch (e) { console.error('[CONTROLE FICHES]', e.message); }
}

/** Après création / modification manuelle d'une fiche : vérifie l'adresse, e-mail si anomalie. */
async function apresSaisieFiche(clientId, { creee, silencieux } = {}) {
  const cl = await db.get('SELECT * FROM clients WHERE id=$1', [clientId]);
  if (!cl) return null;
  const v = await verifierAdresse(cl);
  await enregistrerVerif(clientId, v);
  if (v.statut === 'anomalie' && !silencieux && !/particulier|patient/i.test(cl.type || '')) {
    envoyerMailControle(`${creee ? 'Nouvelle fiche' : 'Fiche modifiée'} — adresse à contrôler : ${cl.nom}`, [_sectionAdresse(v, cl)], cl)
      .catch(e => console.error('[CONTROLE FICHES] mail', e.message));
  }
  return v;
}

module.exports = { verifierAdresse, suggestionsAdresse, apresCommande, apresSaisieFiche, ficheDepuisCustomerPL, customerPennylane, estSurCarte };
