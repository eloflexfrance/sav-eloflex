// public/js/commande-suede-po.js
// ─────────────────────────────────────────────────────────────────────────────
// Commande Suède — bons de commande (Purchase Orders) créés dans l'appli et envoyés à Eloflex AB.
// Page d'édition : référence commande client, adresse de livraison complète, lignes (catalogue ou
// libres : fauteuil + configuration), prix EUR affichables ou non, validation (Brice, Lyes,
// Frédéric, Olivier), envoi PDF à order@eloflex.se (copie sav@eloflex.fr), suivi UPS / DSV,
// puis réception au stock (fenêtre existante « Intégrer dans le stock »).
// ─────────────────────────────────────────────────────────────────────────────
(function(){
'use strict';

const S = window._CSPO = window._CSPO || { vue: 'liste', id: null, cs: null, cfg: null, cat: null, modifie: false };
const $ = id => document.getElementById(id);
const e_ = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const _T = s => (typeof TR === 'function') ? TR(s) : s;
const dateFr = d => d ? String(d).slice(0, 10).split('-').reverse().join('/') : '';
const dhFr = d => { if (!d) return ''; const x = new Date(d); return isNaN(x) ? '' : x.toLocaleDateString('fr-FR') + ' ' + x.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); };
const _toast = (m, ic, c) => (typeof toast === 'function') ? toast(m, ic, c) : alert(m);
const eur = n => (Math.round((+n || 0) * 100) / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const peutEcrire = () => (typeof isAdmin === 'function' && isAdmin()) || (typeof CURRENT_USER !== 'undefined' && CURRENT_USER && CURRENT_USER.role === 'operateur')
  || (typeof canWrite === 'function' && (canWrite('commande-suede') || canWrite('commandes')));
const TRANSP = ['', 'UPS', 'DSV', 'DB Schenker'];

const ETAPES = {
  brouillon: ['Brouillon', 'background:#eef0f3;color:#555'],
  validee:   ['Validée', 'background:#e6f0fb;color:#1F5C8C'],
  envoyee:   ['Envoyée', 'background:#fff4e0;color:#9a5b00'],
  expediee:  ['Expédiée', 'background:#efe7fb;color:#6b3fb0'],
  livree:    ['Livrée — à réceptionner', 'background:#fff4e0;color:#9a5b00'],
  recue:     ['Réceptionnée', 'background:#e5f5ea;color:#1d7a3e'],
  reliquat:  ['Réceptionnée (reliquat)', 'background:#fdecec;color:#b42828'],
  annulee:   ['Annulée', 'background:#fdecec;color:#b42828;text-decoration:line-through'],
};
// Fauteuils Eloflex : EAN de base par modèle (lignes « fauteuil » → choix du joystick)
const EAN_MODELES = { L: '7350006080067', P: '7350006080531', D2: '7350006080616', X: '7350006080623', F: '7350006080685', H: '7350006080852',
  K: '7350006084737', C3: '7350006085994', R: '7350006086007', H2: '7350006088162' };
const EANS = Object.values(EAN_MODELES);
function estFauteuil(l) {
  const r = String(l.reference || '').replace(/\s+/g, '');
  return EANS.some(e => r === e || r.startsWith(e + '-')) || /fauteuil (roulant |électrique )?eloflex|wheelchair|^ESSAI-[A-Z0-9]+-\d{2}\s*CM$/i.test(String(l.designation || '') + ' ' + String(l.reference || ''));
}
// Étape affichée (tient compte de la livraison et de la réception)
function etapeVue(cs) {
  if (cs.etape === 'annulee') return 'annulee';
  if (cs.stock_integre) return (+cs.total_reliquat > 0 || /reliquat/i.test(cs.statut || '')) ? 'reliquat' : 'recue';
  if (cs.date_livraison && cs.etape && !['brouillon', 'validee'].includes(cs.etape)) return 'livree';
  return cs.etape || null;
}
function badgeEtape(cs) {
  const k = etapeVue(cs);
  if (!k) return `<span class="badge" style="opacity:.7" title="${_T('Commande importée de VosFactures')}">VosFactures</span>`;
  const [l, st] = ETAPES[k];
  return `<span class="badge" style="${st};font-weight:600">${_T(l)}</span>`;
}
window.csBadgeEtape = badgeEtape;

async function config(force) {
  if (!S.cfg || force) S.cfg = await API.get('/commandes-suede-po/config');
  return S.cfg;
}
async function catalogue() {
  if (!S.cat) { try { S.cat = await API.catalogue(); } catch (_) { S.cat = []; } }
  return S.cat;
}

// ── Navigation ─────────────────────────────────────────────────────
function quitter(sansConfirm) {
  if (!sansConfirm && S.modifie && !confirm(_T('Modifications non enregistrées : quitter quand même ?'))) return;
  fermerDevis();
  S.vue = 'liste'; S.id = null; S.cs = null; S.modifie = false;
  if (typeof render === 'function') render();
}
async function nouveau() {
  const cfg = await config(true);
  const p = cfg.presets.lagord || {};
  S.cs = { id: null, etape: 'brouillon', numero_bc: cfg.prochain_numero, date_commande: new Date().toISOString().slice(0, 10),
    reference_client: '', livraison_type: 'lagord', livraison_nom: p.nom, livraison_contact: p.contact, livraison_adresse: p.adresse,
    livraison_pays: p.pays || 'France', livraison_tel: p.tel, livraison_email: p.email, afficher_prix: false, notes: '', lignes: [] };
  S.vue = 'edition'; S.id = null; S.modifie = false;
  if (typeof setView === 'function' && typeof STATE !== 'undefined' && STATE.view !== 'commande-suede') setView('commande-suede', { garderPO: true }); else render();
}
async function ouvrir(id) {
  try { if (typeof closeModal === 'function') closeModal(); } catch (_) {}
  S.vue = 'edition'; S.id = id; S.cs = null; S.modifie = false;
  render();
}

// ── Page d'édition ─────────────────────────────────────────────────
async function renderEdition(ttl, c, a) {
  const cfg = await config();
  if (S.id && (!S.cs || S.cs.id !== S.id)) {
    S.cs = await API.get(`/commandes-suede-po/${S.id}`);
    S.cs.lignes = (S.cs.lignes || []).map(l => ({ ...l, quantite: l.quantite_commandee }));
  }
  const cs = S.cs;
  const editable = peutEcrire() && ['brouillon', 'validee'].includes(cs.etape);
  const envoye = !['brouillon', 'validee', 'annulee'].includes(cs.etape);
  ttl.innerHTML = `${_T('Bon de commande Suède')} <span class="mono" style="font-size:.8em;color:var(--text2)">${e_(cs.numero_bc)}</span> ${badgeEtape(cs)}`;
  a.innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
    <button class="btn" onclick="csQuitter()"><i class="ti ti-arrow-left"></i>${_T('Commandes Suède')}</button>
    ${cs.devis_pennylane ? `<button class="btn" onclick="csVoirDevis()"><i class="ti ti-file-search"></i>${_T('Voir le devis')}</button>` : ''}
    <button class="btn" onclick="csApercuPDF()"><i class="ti ti-file-type-pdf"></i>${_T('Aperçu PDF')}</button></div>`;
  S._c = c;
  const dis = editable ? '' : 'disabled';
  const champ = (id, lab, val, extra = '') => `<div class="form-group"><label class="form-label">${lab}</label>
    <input class="form-input" id="${id}" value="${e_(val || '')}" ${dis} oninput="csModif()" ${extra}></div>`;
  const typ = cs.livraison_type || 'autre';
  const radio = (v, l) => `<label style="display:inline-flex;align-items:center;gap:5px;margin-right:14px;font-size:13.5px;cursor:pointer">
    <input type="radio" name="cs-liv-type" value="${v}" ${typ === v ? 'checked' : ''} ${dis} onchange="csTypeLivraison('${v}')">${_T(l)}</label>`;

  c.innerHTML = `
  <div style="max-width:1100px">
    ${!cs.id && cs.devis_pennylane ? `<div style="background:#fff4e0;border-radius:8px;padding:9px 12px;font-size:13px;margin-bottom:12px"><i class="ti ti-file-import"></i> ${_T('Bon pré-rempli depuis le devis Pennylane')} <b class="mono">${e_(cs.devis_pennylane)}</b>${cs.distributeur_devis ? ' (' + e_(cs.distributeur_devis) + ')' : ''}. ${_T('Vérifiez les articles, l’adresse et la référence commande client, puis cliquez sur « Enregistrer ».')}</div>` : ''}
    ${cs.etape === 'annulee' ? `<div style="background:#fdecec;color:#b42828;border-radius:8px;padding:9px 12px;font-size:13px;margin-bottom:12px"><i class="ti ti-ban"></i> ${_T('Commande annulée')}${cs.annule_par ? ' ' + _T('par') + ' <b>' + e_(cs.annule_par) + '</b>' : ''}${cs.annule_le ? ' — ' + dhFr(cs.annule_le) : ''}${cs.annule_motif ? '<br>' + _T('Motif') + ' : ' + e_(cs.annule_motif) : ''}</div>` : ''}
    ${cs.etape === 'validee' && editable ? `<div style="background:#e6f0fb;border-radius:8px;padding:9px 12px;font-size:13px;margin-bottom:12px"><i class="ti ti-info-circle"></i> ${_T('Commande validée : toute modification enregistrée la repasse en brouillon (nouvelle validation nécessaire).')}</div>` : ''}
    <div class="grid-2" style="gap:16px;align-items:start">
      <div class="card" style="padding:14px 16px">
        <div class="section-title"><i class="ti ti-file-invoice"></i>${_T('Commande')}</div>
        <div class="grid-2">
          <div class="form-group"><label class="form-label">${_T('N° bon de commande')}</label>
            <input class="form-input mono" id="cs-num" value="${e_(cs.numero_bc)}" ${dis} oninput="csModif()" title="${_T('Modifiable tant que le bon n’est pas envoyé')}"></div>
          <div class="form-group"><label class="form-label">${_T('Date de commande')}</label>
            <input class="form-input" id="cs-date" type="date" value="${e_(cs.date_commande || '')}" ${dis} oninput="csModif()"></div>
        </div>
        <div class="form-group"><label class="form-label">${_T('Référence commande client')} <span style="font-weight:400;color:var(--text3)">(${_T('facultatif — n° imposé par un distributeur')})</span></label>
          <input class="form-input mono" id="cs-refclient" value="${e_(cs.reference_client || '')}" ${dis} oninput="csModif()" placeholder="${_T('ex. CDE-2026-0457')}"></div>
        <div class="form-group"><label class="form-label">${_T('Devis Pennylane lié')} <span style="font-weight:400;color:var(--text3)">(${_T('facultatif — aperçu à côté du bon, lien avec le suivi commandes')})</span></label>
          <div style="display:flex;gap:6px"><input class="form-input mono" id="cs-devis" value="${e_(cs.devis_pennylane || '')}" ${dis} oninput="csModif()" placeholder="${_T('ex. D-2026-11-240')}" style="flex:1">
          <button class="btn" type="button" onclick="csVoirDevis()" title="${_T('Afficher le devis à côté du bon de commande')}"><i class="ti ti-file-search"></i>${_T('Aperçu')}</button></div></div>
        <label style="display:flex;align-items:center;gap:8px;font-size:13.5px;margin:6px 0 10px;cursor:pointer">
          <input type="checkbox" id="cs-prix" ${cs.afficher_prix ? 'checked' : ''} ${dis} onchange="csModif();csDessinerLignes()"> ${_T('Afficher les prix sur le bon de commande (EUR HT)')}</label>
        <div class="form-group"><label class="form-label">${_T('Commentaires pour la Suède')} <span style="font-weight:400;color:var(--text3)">(${_T('en anglais, imprimés sur le bon')})</span></label>
          <textarea class="form-input" id="cs-notes" rows="3" ${dis} oninput="csModif()">${e_(cs.notes || '')}</textarea></div>
        ${traca(cs, cfg)}
      </div>
      <div class="card" style="padding:14px 16px">
        <div class="section-title"><i class="ti ti-map-pin"></i>${_T('Adresse de livraison')}</div>
        <div style="margin-bottom:8px">${radio('lagord', 'Lagord')}${radio('paris', 'Paris')}${radio('distributeur', 'Distributeur / client')}${radio('autre', 'Autre')}</div>
        <div id="cs-dist-zone" style="position:relative;margin-bottom:8px;${typ === 'distributeur' && editable ? '' : 'display:none'}">
          <input class="form-input" id="cs-dist-q" placeholder="${_T('Rechercher le distributeur / client…')}" oninput="csChercherClient(this.value)" autocomplete="off">
          <div id="cs-dist-sug" style="position:absolute;left:0;right:0;top:100%;background:#fff;border:0.5px solid var(--border);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.12);z-index:50;max-height:220px;overflow:auto;display:none"></div>
        </div>
        ${champ('cs-liv-nom', _T('Société / destinataire') + ' *', cs.livraison_nom)}
        ${champ('cs-liv-contact', _T('Contact (à l’attention de)'), cs.livraison_contact)}
        <div class="form-group"><label class="form-label">${_T('Adresse (rue, code postal, ville)')} *</label>
          <textarea class="form-input" id="cs-liv-adr" rows="3" ${dis} oninput="csModif()">${e_(cs.livraison_adresse || '')}</textarea></div>
        <div class="grid-2">
          ${champ('cs-liv-pays', _T('Pays'), cs.livraison_pays || 'France')}
          ${champ('cs-liv-tel', _T('Téléphone') + ' *', cs.livraison_tel, 'type="tel"')}
        </div>
        ${champ('cs-liv-email', _T('E-mail') + ' *', cs.livraison_email, 'type="email"')}
      </div>
    </div>

    <div class="card" style="padding:14px 16px;margin-top:16px">
      <div class="section-title"><i class="ti ti-list"></i>${_T('Articles commandés')}</div>
      ${editable ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
        <div style="position:relative;flex:1;min-width:260px">
          <input class="form-input" id="cs-art-q" placeholder="${_T('Ajouter une pièce ou un fauteuil du catalogue (réf., réf. fournisseur, désignation)…')}" oninput="csChercherArticle(this.value)" autocomplete="off">
          <div id="cs-art-sug" style="position:absolute;left:0;right:0;top:100%;background:#fff;border:0.5px solid var(--border);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.12);z-index:50;max-height:420px;overflow:auto;display:none"></div>
        </div>
        <button class="btn" onclick="csLigneLibre()"><i class="ti ti-plus"></i>${_T('Ligne libre (fauteuil, configuration…)')}</button>
      </div>` : ''}
      <div id="cs-lignes"></div>
    </div>

    ${envoye ? blocExpedition(cs) : ''}
    ${blocArchives(cs)}

    <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;margin:16px 0 30px">
      <div style="margin-right:auto;display:flex;gap:8px">
        ${cs.id && !cs.stock_integre && (typeof isAdmin === 'function' && isAdmin()) ? `<button class="btn danger" onclick="csSupprimer()" title="${_T('Suppression définitive (administrateur)')}"><i class="ti ti-trash"></i>${_T('Supprimer')}</button>` : ''}
        ${cs.id && !cs.stock_integre && cs.etape !== 'annulee' && (cfg.peut_valider || (typeof isAdmin === 'function' && isAdmin())) ? `<button class="btn" onclick="csAnnuler()" style="color:var(--danger)"><i class="ti ti-ban"></i>${_T('Annuler la commande')}</button>` : ''}
      </div>
      ${editable ? `<button class="btn" onclick="csEnregistrer()"><i class="ti ti-device-floppy"></i>${_T('Enregistrer')}</button>` : ''}
      ${cs.etape === 'brouillon' && cfg.peut_valider && peutEcrire() ? `<button class="btn primary" onclick="csValider()"><i class="ti ti-circle-check"></i>${_T('Valider la commande')}</button>` : ''}
      ${cs.etape === 'brouillon' && !cfg.peut_valider ? `<span style="font-size:12.5px;color:var(--text3);align-self:center">${_T('Validation par')} ${e_((cfg.validateurs.length ? cfg.validateurs : ['Brice', 'Lyes', 'Frédéric', 'Olivier']).join(', '))}</span>` : ''}
      ${cs.etape === 'validee' && cfg.peut_valider ? `<button class="btn" onclick="csDevalider()"><i class="ti ti-arrow-back-up"></i>${_T('Annuler la validation')}</button>` : ''}
      ${cs.etape === 'validee' && peutEcrire() ? `<button class="btn primary" onclick="csEnvoyer()"><i class="ti ti-send"></i>${_T('Envoyer à la Suède')}</button>` : ''}
      ${['envoyee', 'expediee'].includes(cs.etape) && cfg.peut_valider && !cs.stock_integre ? `<button class="btn" onclick="csEnvoyer(true)"><i class="ti ti-send"></i>${_T('Renvoyer')}</button>` : ''}
    </div>
  </div>`;
  dessinerLignes();
}

function traca(cs, cfg) {
  const l = (ic, lab, v) => v ? `<div style="font-size:12.5px;color:var(--text2);margin-top:3px"><i class="ti ${ic}"></i> ${_T(lab)} ${v}</div>` : '';
  return `<div style="border-top:0.5px solid var(--border);margin-top:8px;padding-top:8px">
    ${l('ti-file-invoice', 'Devis Pennylane', cs.devis_pennylane ? `<b class="mono">${e_(cs.devis_pennylane)}</b>` : '')}
    ${l('ti-user', 'Créée par', e_(cs.cree_par || ''))}
    ${l('ti-circle-check', 'Validée par', cs.valide_par ? `<b>${e_(cs.valide_par)}</b> — ${dhFr(cs.valide_le)}` : '')}
    ${l('ti-send', 'Envoyée par', cs.envoye_par ? `<b>${e_(cs.envoye_par)}</b> — ${dhFr(cs.envoye_le)} → ${e_(cs.envoye_a || '')}` : '')}
    ${!cs.id ? `<div style="font-size:12.5px;color:var(--text3)">${_T('Nouveau brouillon — pas encore enregistré.')}</div>` : ''}
  </div>`;
}

function blocExpedition(cs) {
  const lien = typeof lienSuiviColis === 'function' ? lienSuiviColis(cs.transporteur, cs.num_suivi) : null;
  const fin = !!cs.stock_integre;
  const dis = fin || !peutEcrire() ? 'disabled' : '';
  return `<div class="card" style="padding:14px 16px;margin-top:16px">
    <div class="section-title"><i class="ti ti-truck-delivery"></i>${_T('Confirmation de la Suède et livraison')}</div>
    <div style="font-size:12.5px;color:var(--text3);margin:-4px 0 8px">${_T('Reportez ici la date d’envoi et le n° de suivi confirmés par e-mail par Eloflex AB.')}</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px">
      <div class="form-group"><label class="form-label">${_T("Date d'expédition")}</label><input class="form-input" type="date" id="cs-exp-date" value="${e_(cs.date_expedition || '')}" ${dis}></div>
      <div class="form-group"><label class="form-label">${_T('Transporteur')}</label><select class="form-input" id="cs-exp-transp" ${dis}>
        ${TRANSP.map(t => `<option value="${t}" ${(cs.transporteur || '') === t ? 'selected' : ''}>${t || '—'}</option>`).join('')}
        ${cs.transporteur && !TRANSP.includes(cs.transporteur) ? `<option selected>${e_(cs.transporteur)}</option>` : ''}</select></div>
      <div class="form-group"><label class="form-label">${_T('N° de suivi')}</label><input class="form-input mono" id="cs-exp-suivi" value="${e_(cs.num_suivi || '')}" ${dis}>
        ${lien ? `<a href="${lien}" target="_blank" rel="noopener" style="font-size:12.5px;color:var(--accent)"><i class="ti ti-external-link"></i> ${_T('Suivre le colis')}</a>` : ''}</div>
      <div class="form-group"><label class="form-label">${_T('Date de livraison')}</label><input class="form-input" type="date" id="cs-exp-liv" value="${e_(cs.date_livraison || '')}" ${dis}></div>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">
      ${!fin && peutEcrire() ? `<button class="btn" onclick="csExpedition()"><i class="ti ti-device-floppy"></i>${_T('Enregistrer le suivi')}</button>` : ''}
      ${!fin && cs.date_livraison && peutEcrire() ? `<button class="btn primary" onclick="csReception()"><i class="ti ti-package-import"></i>${_T('Réceptionner et intégrer au stock')}</button>` : ''}
      ${fin ? `<span style="font-size:13px;color:var(--success)"><i class="ti ti-check"></i> ${_T('Stock intégré')}${cs.integre_le ? ' ' + _T('le') + ' ' + dateFr(String(cs.integre_le).slice(0, 10)) : ''}</span>` : ''}
    </div>
  </div>`;
}

function blocArchives(cs) {
  const h = Array.isArray(cs.historique) ? cs.historique : [];
  const pdfs = cs.pdfs || [];
  if (!h.length && !pdfs.length) return '';
  return `<details class="card" style="padding:10px 16px;margin-top:16px"><summary style="cursor:pointer;font-size:13.5px;color:var(--text2)"><i class="ti ti-history"></i> ${_T('Historique et PDF envoyés')}</summary>
    ${pdfs.length ? `<div style="margin:8px 0">${pdfs.map(p => `<a class="btn sm" href="/api/commandes-suede-po/${cs.id}/pdf/${p.id}" target="_blank" rel="noopener" style="margin:0 6px 6px 0"><i class="ti ti-file-type-pdf"></i>${e_(p.nom)} — ${dhFr(p.created_at)}</a>`).join('')}</div>` : ''}
    <div style="font-size:12.5px;color:var(--text2)">${h.slice().reverse().map(x => `<div style="padding:3px 0;border-bottom:0.5px solid var(--border)">${dhFr(x.date)} — <b>${e_(x.par || '?')}</b> : ${e_(_T(x.action))}${x.detail ? ' <span style="color:var(--text3)">(' + e_(x.detail) + ')</span>' : ''}</div>`).join('')}</div>
  </details>`;
}

// ── Lignes ─────────────────────────────────────────────────────────
function lireLignesDuDom() {
  const cs = S.cs; if (!cs) return;
  cs.lignes.forEach((l, i) => {
    const v = k => { const el = $(`cs-l-${k}-${i}`); return el ? el.value : undefined; };
    if (v('ref') !== undefined) l.reference = v('ref');
    if (v('sup') !== undefined) l.ref_fournisseur = v('sup');
    if (v('des') !== undefined) l.designation = v('des');
    if (v('note') !== undefined) l.note = v('note');
    if (v('q') !== undefined) l.quantite = Math.max(0, parseInt(v('q')) || 0);
    if (v('px') !== undefined) l.prix_unitaire = v('px') === '' ? null : v('px').replace(',', '.');
    if (v('joy') !== undefined) l.joystick = v('joy') || 'none';
  });
}
function dessinerLignes() {
  const z = $('cs-lignes'), cs = S.cs; if (!z || !cs) return;
  const editable = peutEcrire() && ['brouillon', 'validee'].includes(cs.etape);
  const prix = $('cs-prix') ? $('cs-prix').checked : !!cs.afficher_prix;
  if (!cs.lignes.length) { z.innerHTML = `<div style="font-size:13px;color:var(--text3);padding:8px 0">${_T('Aucun article pour l’instant.')}</div>`; return; }
  const dis = editable ? '' : 'disabled';
  const H = 'height:34px;box-sizing:border-box;padding:0 8px;';
  const inp = (k, i, v, st, extra = '') => `<input class="form-input${k === 'ref' || k === 'sup' ? ' mono' : ''}" id="cs-l-${k}-${i}" value="${e_(v ?? '')}" title="${e_(v ?? '')}" ${dis} oninput="csModif();${k === 'q' || k === 'px' ? 'csTotaux()' : ''}" style="${H}font-size:13px;width:100%;${st}" ${extra}>`;
  const td = (st = '') => `<td style="vertical-align:top;padding-top:10px;padding-bottom:10px;${st}">`;
  const sous = (txt, coul) => `<div style="font-size:11px;color:${coul};margin-top:3px;height:14px">${txt}</div>`;
  z.innerHTML = `<div class="table-wrap"><table class="t" style="table-layout:fixed;width:100%;min-width:780px">
    <colgroup><col style="width:${$('cs-devis-panel') ? 230 : 300}px"><col><col style="width:80px"><col style="width:110px"><col style="width:105px"><col style="width:46px"></colgroup>
    <thead><tr><th>${_T('Réf.')} / ${_T('Réf. fournisseur')}</th><th>${_T('Désignation')} / ${_T('configuration')}</th>
      <th>${_T('Qté')}</th><th>${_T('Prix U. HT')}${prix ? '' : ` <span title="${_T('Non imprimé sur le bon')}" style="opacity:.6">(${_T('masqué')})</span>`}</th><th style="text-align:right">${_T('Total')}</th><th></th></tr></thead>
    <tbody>${cs.lignes.map((l, i) => `<tr>
      ${td()}${inp('ref', i, l.reference, 'font-weight:700;font-size:14px')}
        ${inp('sup', i, l.ref_fournisseur, 'font-size:12px;color:var(--text2);margin-top:4px', `placeholder="${_T('Réf. fournisseur')}"`)}
        ${sous(l.catalogue_id ? `<i class="ti ti-link"></i> ${_T('catalogue')}` : _T('hors catalogue'), l.catalogue_id ? 'var(--success)' : 'var(--text3)')}</td>
      ${td()}${inp('des', i, l.designation, 'font-weight:600')}
        ${inp('note', i, l.note, 'font-style:italic;margin-top:4px', `placeholder="${_T('Configuration / options / accessoires (facultatif)')}"`)}
        ${l.joystick || estFauteuil(l) ? `<div style="display:flex;align-items:center;gap:8px;margin-top:4px;font-size:12.5px;color:var(--text2)"><i class="ti ti-steering-wheel"></i> Joystick
          <select class="form-input" id="cs-l-joy-${i}" ${dis} onchange="csModif()" style="height:30px;padding:0 6px;font-size:12.5px;width:auto">
            <option value="right" ${(l.joystick || 'right') === 'right' ? 'selected' : ''}>on the right (${_T('à droite')})</option>
            <option value="left" ${l.joystick === 'left' ? 'selected' : ''}>on the left (${_T('à gauche')})</option>
            <option value="none" ${l.joystick === 'none' ? 'selected' : ''}>${_T('sans objet')}</option></select></div>` : ''}</td>
      ${td()}${inp('q', i, l.quantite, 'text-align:center', 'type="number" min="1"')}</td>
      ${td()}${inp('px', i, l.prix_unitaire, 'text-align:right', 'inputmode="decimal"')}</td>
      ${td('text-align:right;white-space:nowrap;line-height:34px;font-weight:600')}<span id="cs-l-tot-${i}"></span></td>
      ${td('text-align:center')}${editable ? `<button class="btn sm" style="height:34px" onclick="csRetirerLigne(${i})" title="${_T('Retirer')}"><i class="ti ti-x"></i></button>` : ''}</td>
    </tr>`).join('')}</tbody>
    <tfoot><tr><td colspan="2" style="text-align:right;font-weight:600">${_T('Total')}</td><td id="cs-tot-q" style="font-weight:700;text-align:center"></td><td></td><td id="cs-tot-px" style="text-align:right;font-weight:700;white-space:nowrap"></td><td></td></tr></tfoot>
  </table></div>`;
  totaux();
}
function totaux() {
  const cs = S.cs; if (!cs) return;
  lireLignesDuDom();
  let q = 0, t = 0;
  cs.lignes.forEach((l, i) => {
    const pu = l.prix_unitaire === '' || l.prix_unitaire == null ? null : +l.prix_unitaire;
    q += +l.quantite || 0; if (pu != null && isFinite(pu)) t += pu * (+l.quantite || 0);
    const c = $(`cs-l-tot-${i}`); if (c) c.textContent = pu != null && isFinite(pu) ? eur(pu * (+l.quantite || 0)) : '—';
  });
  if ($('cs-tot-q')) $('cs-tot-q').textContent = q;
  if ($('cs-tot-px')) $('cs-tot-px').textContent = eur(t);
}
async function chercherArticle(q) {
  const box = $('cs-art-sug'); if (!box) return;
  const n = s => String(s || '').toLowerCase().replace(/[ ​\s]+/g, ' ').trim();
  q = n(q);
  if (!q) { box.style.display = 'none'; return; }
  const cat = await catalogue();
  const qc = q.replace(/[\s.\-_/]+/g, '');
  const res = cat.filter(c => n(c.ref).includes(q) || n(c.designation).includes(q) || n(c.ref_fournisseur).includes(q)
    || (qc && String(c.ref || '').toLowerCase().replace(/[\s.\-_/]+/g, '').includes(qc))).slice(0, 12);
  if (!res.length) { box.innerHTML = `<div style="padding:8px 10px;font-size:13px;color:var(--text3)">${_T('Aucun résultat — utilisez « Ligne libre ».')}</div>`; box.style.display = ''; return; }
  box.innerHTML = res.map(c => `<div onclick="csAjouterArticle(${c.id})" style="display:flex;align-items:center;gap:14px;padding:12px 14px;cursor:pointer;border-bottom:1px solid var(--border)" onmouseover="this.style.background='rgba(46,124,246,.08)'" onmouseout="this.style.background=''">
    <span class="mono" style="font-weight:800;font-size:14.5px;color:var(--text);min-width:130px;flex-shrink:0">${e_(c.ref)}</span>
    <span style="flex:1;font-size:13.5px;line-height:1.35">${e_(c.designation)}</span>
    <span style="flex-shrink:0;text-align:right;font-size:12.5px;color:var(--text3);white-space:nowrap">${c.prix_achat_suede != null ? eur(c.prix_achat_suede) + '<br>' : ''}${_T('stock')} <b style="color:${(+c.stock || 0) > 0 ? 'var(--text2)' : 'var(--danger)'}">${c.stock ?? 0}</b></span></div>`).join('');
  box.style.display = '';
}
function ajouterArticle(id) {
  lireLignesDuDom();
  const art = (S.cat || []).find(c => c.id === id); if (!art) return;
  const ex = S.cs.lignes.find(l => l.catalogue_id === id && !l.note);
  const nl = { catalogue_id: art.id, reference: art.ref, ref_fournisseur: art.ref_fournisseur || '', designation: art.designation,
    note: '', quantite: 1, prix_unitaire: art.prix_achat_suede != null ? String(art.prix_achat_suede) : null };
  if (estFauteuil(nl)) nl.joystick = 'right';
  if (ex && !nl.joystick) ex.quantite = (+ex.quantite || 0) + 1;
  else S.cs.lignes.push(nl);
  if ($('cs-art-q')) $('cs-art-q').value = '';
  if ($('cs-art-sug')) $('cs-art-sug').style.display = 'none';
  S.modifie = true; dessinerLignes();
}
function ligneLibre() {
  lireLignesDuDom();
  S.cs.lignes.push({ catalogue_id: null, reference: '', ref_fournisseur: '', designation: '', note: '', quantite: 1, prix_unitaire: null, joystick: 'right' });
  S.modifie = true; dessinerLignes();
  const i = S.cs.lignes.length - 1; const el = $(`cs-l-des-${i}`); if (el) el.focus();
}
function retirerLigne(i) { lireLignesDuDom(); S.cs.lignes.splice(i, 1); S.modifie = true; dessinerLignes(); }

// ── Livraison ──────────────────────────────────────────────────────
function remplirLivraison(p) {
  const set = (id, v) => { const el = $(id); if (el) el.value = v || ''; };
  set('cs-liv-nom', p.nom); set('cs-liv-contact', p.contact); set('cs-liv-adr', p.adresse);
  set('cs-liv-pays', p.pays || 'France'); set('cs-liv-tel', p.tel); set('cs-liv-email', p.email);
  S.modifie = true;
}
function typeLivraison(t) {
  S.cs.livraison_type = t;
  const z = $('cs-dist-zone'); if (z) z.style.display = t === 'distributeur' ? '' : 'none';
  if (t === 'lagord' || t === 'paris') remplirLivraison((S.cfg && S.cfg.presets[t]) || {});
  else if (t === 'autre') remplirLivraison({ pays: 'France' });
  else { remplirLivraison({ pays: 'France' }); const q = $('cs-dist-q'); if (q) q.focus(); }
}
let _tCli = null;
function chercherClient(q) {
  clearTimeout(_tCli);
  _tCli = setTimeout(async () => {
    const box = $('cs-dist-sug'); if (!box) return;
    if (String(q || '').trim().length < 2) { box.style.display = 'none'; return; }
    let rows = []; try { rows = await API.clients(q.trim()); } catch (_) {}
    S._clients = rows.slice(0, 12);
    box.innerHTML = S._clients.length ? S._clients.map((c, i) => `<div onclick="csChoisirClient(${i})" style="padding:7px 10px;cursor:pointer;border-bottom:0.5px solid rgba(0,0,0,.05);font-size:13px" onmouseover="this.style.background='rgba(46,124,246,.08)'" onmouseout="this.style.background=''">
      <b>${e_(c.nom)}</b> <span style="color:var(--text3)">${e_([c.cp, c.ville].filter(Boolean).join(' '))}${c.type ? ' · ' + e_(c.type) : ''}</span></div>`).join('')
      : `<div style="padding:8px 10px;font-size:13px;color:var(--text3)">${_T('Aucun résultat')}</div>`;
    box.style.display = '';
  }, 250);
}
function choisirClient(i) {
  const c = (S._clients || [])[i]; if (!c) return;
  S.cs.client_id = c.id;
  remplirLivraison({ nom: c.nom, contact: c.contact, adresse: [c.adresse, c.adresse2, [c.cp, c.ville].filter(Boolean).join(' ')].filter(x => x && String(x).trim()).join('\n'),
    pays: 'France', tel: c.tel || c.portable, email: c.email });
  const box = $('cs-dist-sug'); if (box) box.style.display = 'none';
  const q = $('cs-dist-q'); if (q) q.value = c.nom;
}

// ── Enregistrement / workflow ──────────────────────────────────────
function donnees() {
  lireLignesDuDom();
  const v = id => ($(id) ? $(id).value : '');
  const cs = S.cs;
  return {
    date_commande: v('cs-date') || cs.date_commande, reference_client: v('cs-refclient').trim(), client_id: cs.client_id || null,
    devis_pennylane: $('cs-devis') ? v('cs-devis').trim() : (cs.devis_pennylane || null),
    numero_bc: (v('cs-num') || '').trim() || cs.numero_bc,
    livraison_type: cs.livraison_type, livraison_nom: v('cs-liv-nom').trim(), livraison_contact: v('cs-liv-contact').trim(),
    livraison_adresse: v('cs-liv-adr').trim(), livraison_pays: v('cs-liv-pays').trim(), livraison_tel: v('cs-liv-tel').trim(),
    livraison_email: v('cs-liv-email').trim(), afficher_prix: $('cs-prix') ? $('cs-prix').checked : !!cs.afficher_prix, notes: v('cs-notes'),
    lignes: cs.lignes.filter(l => (+l.quantite > 0) && (String(l.designation || '').trim() || String(l.reference || '').trim()))
      .map(l => ({ catalogue_id: l.catalogue_id || null, reference: l.reference, ref_fournisseur: l.ref_fournisseur, designation: l.designation,
        note: l.note, quantite: l.quantite, prix_unitaire: l.prix_unitaire, joystick: ['right', 'left', 'none'].includes(l.joystick) ? l.joystick : (estFauteuil(l) ? 'right' : null) })),
  };
}
async function enregistrer(silencieux) {
  const d = donnees();
  if (!d.lignes.length && !silencieux) { if (!confirm(_T('Aucun article : enregistrer quand même le brouillon ?'))) return false; }
  try {
    if (!S.cs.id) {
      const r = await API.post('/commandes-suede-po', d);
      S.id = r.id;
    } else {
      const r = await API.put(`/commandes-suede-po/${S.cs.id}`, d);
      if (r.revalider) _toast(_T('Modifiée : la commande repasse en brouillon et doit être revalidée.'), 'ti-info-circle');
    }
    S.modifie = false; S.cs = null;
    if (!silencieux) _toast(_T('Bon de commande enregistré'), 'ti-check', 'var(--success)');
    render();
    return true;
  } catch (e) { _toast(e.message, 'ti-alert-circle', 'var(--danger)'); return false; }
}
async function valider() {
  if (S.modifie || !S.cs.id) { if (!(await enregistrer(true))) return; await attendreCs(); }
  if (!confirm(_T('Valider le bon de commande ') + S.cs.numero_bc + ' ?')) return;
  try { await API.post(`/commandes-suede-po/${S.cs.id}/valider`, {}); S.cs = null; _toast(_T('Commande validée'), 'ti-circle-check', 'var(--success)'); render(); }
  catch (e) { _toast(e.message, 'ti-alert-circle', 'var(--danger)'); }
}
async function devalider() {
  try { await API.post(`/commandes-suede-po/${S.cs.id}/devalider`, {}); S.cs = null; render(); }
  catch (e) { _toast(e.message, 'ti-alert-circle', 'var(--danger)'); }
}
// Recharge la commande après un enregistrement (render est asynchrone)
async function attendreCs() {
  for (let i = 0; i < 40 && (!S.cs || S.cs.id !== S.id); i++) await new Promise(r => setTimeout(r, 100));
}
function pdfDoc(cs) {
  if (typeof PDF === 'undefined' || !PDF.commandeSuedeDoc || !window.jspdf) throw new Error(_T('Générateur PDF indisponible'));
  return PDF.commandeSuedeDoc(cs);
}
function csCourant() {
  const d = donnees();
  return { ...S.cs, ...d, lignes: d.lignes.map(l => ({ ...l, quantite_commandee: l.quantite })) };
}
function apercuPDF() {
  try {
    const doc = pdfDoc(csCourant());
    const url = doc.output('bloburl');
    window.open(url, '_blank');
  } catch (e) { _toast(e.message, 'ti-alert-circle', 'var(--danger)'); }
}
async function envoyer(renvoi) {
  if (S.modifie) { _toast(_T('Enregistrez d’abord les modifications.'), 'ti-alert-circle', 'var(--danger)'); return; }
  const cs = S.cs, cfg = await config();
  let ap = null;
  try { ap = await API.post(`/commandes-suede-po/${cs.id}/envoyer`, { apercu: true }); } catch (e) { _toast(e.message, 'ti-alert-circle', 'var(--danger)'); return; }
  showModal(`
    <div class="modal-header"><h3><i class="ti ti-send"></i>${renvoi ? _T('Renvoyer') : _T('Envoyer')} ${e_(cs.numero_bc)} ${_T('à la Suède')}</h3>
      <button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body">
      <div style="font-size:13.5px;margin-bottom:8px">${_T('À')} : <b>${e_(cfg.to)}</b> · ${_T('Copie')} : <b>${e_(cfg.cc)}</b><br>
        ${_T('Objet')} : ${e_(ap.sujet)}<br>${_T('Pièce jointe')} : <i class="ti ti-file-type-pdf"></i> ${e_(cs.numero_bc)}.pdf ${cs.afficher_prix ? '(' + _T('avec prix') + ')' : '(' + _T('sans prix') + ')'}
        · <a href="#" onclick="event.preventDefault();csApercuPDF()" style="color:var(--accent)">${_T('voir')}</a></div>
      <div class="form-group"><label class="form-label">${_T('Message complémentaire (facultatif, en anglais)')}</label>
        <textarea class="form-input" id="cs-env-msg" rows="3" placeholder="e.g. Urgent — please ship as soon as possible."></textarea></div>
      <div class="form-group"><label class="form-label">${_T('Copie cachée (facultatif)')} <span style="font-weight:400;color:var(--text3)">(${_T('une ou plusieurs adresses, séparées par une virgule')})</span></label>
        <input class="form-input" id="cs-env-bcc" type="text" placeholder="ex. prenom@eloflex.fr" autocomplete="off"></div>
      <details><summary style="cursor:pointer;font-size:13px;color:var(--text2)">${_T('Aperçu du mail')}</summary>
        <div style="border:0.5px solid var(--border);border-radius:8px;padding:10px;margin-top:6px;max-height:300px;overflow:auto;font-size:12px">${ap.html}</div></details>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">${_T('Annuler')}</button>
      <button class="btn primary" id="cs-env-btn" onclick="csConfirmerEnvoi()"><i class="ti ti-send"></i>${_T('Envoyer')}</button>
    </div>`);
}
async function confirmerEnvoi() {
  const btn = $('cs-env-btn'); if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader"></i>' + _T('Envoi…'); }
  try {
    const pdf = pdfDoc(S.cs).output('datauristring');
    const r = await API.post(`/commandes-suede-po/${S.cs.id}/envoyer`, { pdf, message: ($('cs-env-msg') || {}).value || '', bcc: ($('cs-env-bcc') || {}).value || '' });
    closeModal(); S.cs = null;
    _toast(_T('Bon de commande envoyé à ') + r.to, 'ti-mail', 'var(--success)');
    render();
  } catch (e) { if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-send"></i>' + _T('Envoyer'); } _toast(e.message, 'ti-alert-circle', 'var(--danger)'); }
}
async function expedition() {
  const v = id => ($(id) ? $(id).value : '');
  try {
    await API.post(`/commandes-suede-po/${S.cs.id}/expedition`, { date_expedition: v('cs-exp-date'), transporteur: v('cs-exp-transp'),
      num_suivi: v('cs-exp-suivi').trim(), date_livraison: v('cs-exp-liv') });
    S.cs = null; _toast(_T('Suivi enregistré'), 'ti-check', 'var(--success)'); render();
  } catch (e) { _toast(e.message, 'ti-alert-circle', 'var(--danger)'); }
}
function reception() {
  if (typeof modalIntegrerStock === 'function') {
    S.cs = null;   // rechargée au retour
    modalIntegrerStock(S.id);
  }
}
async function supprimer() {
  if (!confirm(_T('Supprimer définitivement ce bon de commande ?'))) return;
  try { await API.del(`/commandes-suede-po/${S.cs.id}`); quitter(true); _toast(_T('Supprimé'), 'ti-check'); }
  catch (e) { _toast(e.message, 'ti-alert-circle', 'var(--danger)'); }
}

function annuler() {
  const cs = S.cs; if (!cs) return;
  showModal(`
    <div class="modal-header"><h3><i class="ti ti-ban"></i>${_T('Annuler la commande')} ${e_(cs.numero_bc)}</h3>
      <button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body">
      <div style="font-size:13px;color:var(--text2);margin-bottom:10px">${_T('Le bon reste visible dans la liste, marqué « Annulée », mais ne peut plus être modifié ni envoyé.')}</div>
      <div class="form-group"><label class="form-label">${_T('Motif')} <span style="font-weight:400;color:var(--text3)">(${_T('facultatif — repris dans le mail à la Suède, en anglais de préférence')})</span></label>
        <textarea class="form-input" id="cs-ann-motif" rows="3"></textarea></div>
      ${cs.envoye_le ? `<label style="display:flex;gap:8px;align-items:center;font-size:13.5px;cursor:pointer"><input type="checkbox" id="cs-ann-prev" checked> ${_T('Prévenir la Suède par e-mail')} (order@eloflex.se, ${_T('copie')} sav@eloflex.fr)</label>`
        : `<div style="font-size:12.5px;color:var(--text3)">${_T('Ce bon n’a pas été envoyé à la Suède : aucun mail ne part.')}</div>`}
    </div>
    <div class="modal-footer"><button class="btn" onclick="closeModal()">${_T('Retour')}</button>
      <button class="btn danger" id="cs-ann-ok" onclick="csConfirmerAnnulation()"><i class="ti ti-ban"></i>${_T('Annuler la commande')}</button></div>`);
}
async function confirmerAnnulation() {
  const btn = $('cs-ann-ok'); if (btn) btn.disabled = true;
  try {
    const r = await API.post(`/commandes-suede-po/${S.cs.id}/annuler`, { motif: ($('cs-ann-motif') || {}).value || '', prevenir: !!($('cs-ann-prev') && $('cs-ann-prev').checked) });
    closeModal(); S.cs = null; S.modifie = false;
    _toast(_T('Commande annulée') + (r.suede_prevenue ? ' — ' + _T('la Suède a été prévenue') : ''), 'ti-ban');
    render();
  } catch (e) { if (btn) btn.disabled = false; _toast(e.message, 'ti-alert-circle', 'var(--danger)'); }
}
window.csAnnuler = annuler;
window.csConfirmerAnnulation = confirmerAnnulation;

// ── Import d'un devis Pennylane → bon de commande Suède pré-rempli ──
const nRef = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const estFrais = d => /frais|\bport\b|livraison|exp[ée]dition|transport|shipping|\benvoi\b|colissimo|chronopost|remise|escompte/i.test(String(d || ''));
const sansHtml = t => String(t || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
function modalDevisPL(numero) {
  showModal(`
    <div class="modal-header"><h3><i class="ti ti-file-import"></i>${_T('Bon de commande depuis un devis Pennylane')}</h3>
      <button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body">
      <div style="display:flex;gap:8px">
        <input class="form-input mono" id="cs-pl-num" placeholder="${_T('N° du devis, ex. D-2026-11-0123')}" value="${e_(numero || '')}" style="flex:1" onkeydown="if(event.key==='Enter')csChercherDevisPL()">
        <button class="btn primary" id="cs-pl-go" onclick="csChercherDevisPL()"><i class="ti ti-search"></i>${_T('Rechercher')}</button>
      </div>
      <div style="font-size:12px;color:var(--text3);margin-top:4px">${_T('Les articles du devis sont repris (hors frais de port), reliés au catalogue avec la référence fournisseur et le prix d’achat Suède.')}</div>
      <div id="cs-pl-res" style="margin-top:12px"></div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">${_T('Annuler')}</button>
      <button class="btn primary" id="cs-pl-ok" style="display:none" onclick="csCreerDepuisDevisPL()"><i class="ti ti-file-plus"></i>${_T('Préparer le bon de commande')}</button>
    </div>`);
  const i = $('cs-pl-num'); if (i) i.focus();
  if (numero) chercherDevisPL();
}
async function chercherDevisPL() {
  const num = ($('cs-pl-num') || {}).value.trim(), z = $('cs-pl-res'), ok = $('cs-pl-ok');
  if (!num) return;
  if (ok) ok.style.display = 'none';
  z.innerHTML = `<div style="font-size:13px;color:var(--text2)"><i class="ti ti-loader"></i> ${_T('Recherche dans Pennylane…')}</div>`;
  let r;
  try { r = await API.pennylane_bdc_lookup(num); } catch (e) { z.innerHTML = `<div style="color:var(--danger);font-size:13px">${e_(e.message)}</div>`; return; }
  if (r.configured === false) { z.innerHTML = `<div style="color:var(--danger);font-size:13px">${_T('Pennylane n’est pas configuré.')}</div>`; return; }
  if (!r.found) {
    z.innerHTML = `<div style="font-size:13px;color:var(--warning)">${_T('Devis introuvable dans Pennylane.')}</div>
      ${(r.suggestions || []).length ? `<div style="font-size:12.5px;color:var(--text2);margin:8px 0 4px">${_T('Vouliez-vous dire :')}</div>${r.suggestions.map(x => `<button class="btn sm" style="margin:0 6px 6px 0" onclick="document.getElementById('cs-pl-num').value='${e_(x.numero)}';csChercherDevisPL()"><span class="mono">${e_(x.numero)}</span>${x.distributeur ? ' — ' + e_(x.distributeur) : ''}</button>`).join('')}` : ''}`;
    return;
  }
  const cat = await catalogue();
  const parRef = new Map();
  cat.forEach(c => { [c.ref, c.ref_fournisseur].forEach(k => { const n = nRef(k); if (n && !parRef.has(n)) parRef.set(n, c); }); });
  // Fauteuils d'essai : ESSAI-D2-50CM → 7350006080616-E 50 (modèles ayant une référence « -E » au catalogue)
  const eanE = {};
  cat.forEach(c => { const m = /^(7350006\d{6})-E$/.exec(String(c.ref || '').trim()), mm = /mod[eè]le\s+([A-Z0-9]+)/i.exec(c.designation || '');
    if (m && mm) eanE[mm[1].toUpperCase()] = { ean: m[1], designation: c.designation }; });
  for (const [k, e] of Object.entries({ L: '7350006080067', P: '7350006080531', D2: '7350006080616', F: '7350006080685', R: '7350006086007' }))
    if (!eanE[k]) eanE[k] = { ean: e, designation: `Fauteuil Eloflex Modèle ${k} - NM - Equipements de série` };
  S._pl = { r, lignes: (r.lignes || []).map(l => {
    const ess = /^ESSAI-([A-Z0-9]+)-(\d{2})\s*CM$/i.exec(String(l.reference || '').trim());
    if (ess) {
      const mod = ess[1].toUpperCase(), taille = ess[2], e = eanE[mod];
      const des = e ? String(e.designation).replace(/\s*-\s*DEMONSTRATION\s*$/i, '').replace(/\d{2}\s*cm/i, taille + ' cm') : (l.designation || '');
      return { garder: (+l.quantite || 0) > 0, catalogue_id: null, reference: e ? `${e.ean}-E ${taille}` : (l.reference || ''), ref_fournisseur: '',
        designation: !e || /\d{2}\s*cm/i.test(des) ? des : des + ' - ' + taille + ' cm', note: '', quantite: Math.max(1, parseInt(l.quantite) || 1),
        prix_unitaire: null, joystick: 'right', frais: false, essai: e ? 'ok' : 'inconnu', refOrigine: l.reference };
    }
    const c = parRef.get(nRef(l.reference)) || null;
    const frais = estFrais(l.designation) || /^ESSAI/i.test(String(l.reference || '')) || /offre d.essai/i.test(String(l.designation || ''));
    return { garder: !frais && (+l.quantite || 0) > 0, catalogue_id: c ? c.id : null, reference: c ? c.ref : (l.reference || ''),
      ref_fournisseur: c ? (c.ref_fournisseur || '') : '', designation: c ? c.designation : (l.designation || ''),
      note: c ? '' : sansHtml(l.description).slice(0, 300), quantite: Math.max(1, parseInt(l.quantite) || 1),
      prix_unitaire: c && c.prix_achat_suede != null ? String(c.prix_achat_suede) : null, frais,
      joystick: (c && estFauteuil(c.ref ? { reference: c.ref, designation: c.designation } : {})) || (!c && estFauteuil(l)) ? 'right' : undefined };
  }) };
  const cl = r.client || {};
  const adrDist = [cl.adresse, [cl.cp, cl.ville].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  z.innerHTML = `
    <div style="background:var(--bg);border-radius:8px;padding:10px 12px;font-size:13.5px;margin-bottom:10px">
      <b class="mono">${e_(r.numero)}</b> — <b>${e_(r.distributeur || '—')}</b>${r.date_commande ? ' · ' + dateFr(r.date_commande) : ''}${r.url_doc ? ` · <a href="${e_(r.url_doc)}" target="_blank" rel="noopener" style="color:var(--accent)">${_T('voir le devis')}</a>` : ''}</div>
    <div class="table-wrap"><table class="t"><thead><tr><th style="width:30px"></th><th>${_T('Réf.')}</th><th>${_T('Désignation')}</th><th style="width:70px">${_T('Qté')}</th></tr></thead>
      <tbody>${S._pl.lignes.map((l, i) => `<tr style="${l.frais ? 'opacity:.55' : ''}">
        <td><input type="checkbox" ${l.garder ? 'checked' : ''} onchange="csPlLigne(${i},'garder',this.checked)"></td>
        <td class="mono" style="font-weight:700">${e_(l.reference || '—')}${l.essai ? `<div style="font-size:11px;font-weight:400;color:${l.essai === 'ok' ? 'var(--success)' : 'var(--warning)'}">${l.essai === 'ok' ? '<i class="ti ti-arrows-exchange"></i> ' + _T('remplace') + ' ' + e_(l.refOrigine) : _T('modèle d’essai sans référence « -E » : à vérifier')}</div>` : l.catalogue_id ? `<div style="font-size:11px;font-weight:400;color:var(--success)"><i class="ti ti-link"></i> ${_T('catalogue')}</div>` : `<div style="font-size:11px;font-weight:400;color:var(--text3)">${_T('hors catalogue')}</div>`}</td>
        <td>${e_(l.designation)}${l.note ? `<div style="font-size:11.5px;color:var(--text3);font-style:italic">${e_(l.note.slice(0, 140))}${l.note.length > 140 ? '…' : ''}</div>` : ''}${l.frais ? `<div style="font-size:11.5px;color:var(--text3)">${_T('frais ou offre d’essai — non repris par défaut')}</div>` : ''}</td>
        <td><input class="form-input" type="number" min="1" value="${l.quantite}" style="width:60px;padding:3px 6px" onchange="csPlLigne(${i},'quantite',this.value)"></td></tr>`).join('')}</tbody></table></div>
    <div class="section-title" style="margin-top:12px"><i class="ti ti-map-pin"></i>${_T('Livraison')}</div>
    <label style="display:block;font-size:13.5px;margin:4px 0;cursor:pointer"><input type="radio" name="cs-pl-liv" value="distributeur" ${adrDist ? 'checked' : ''}> ${_T('Directement chez le distributeur')} <span style="color:var(--text3)">${e_(adrDist || _T('(adresse absente de Pennylane : à compléter)'))}</span></label>
    <label style="display:block;font-size:13.5px;margin:4px 0;cursor:pointer"><input type="radio" name="cs-pl-liv" value="lagord" ${adrDist ? '' : 'checked'}> Lagord</label>
    <label style="display:block;font-size:13.5px;margin:4px 0;cursor:pointer"><input type="radio" name="cs-pl-liv" value="paris"> Paris</label>`;
  if (ok) ok.style.display = '';
}
function plLigne(i, k, v) {
  const l = S._pl && S._pl.lignes[i]; if (!l) return;
  if (k === 'garder') l.garder = !!v; else l.quantite = Math.max(1, parseInt(v) || 1);
}
async function creerDepuisDevisPL() {
  const pl = S._pl; if (!pl) return;
  const lignes = pl.lignes.filter(l => l.garder).map(({ garder, frais, essai, refOrigine, ...l }) => l);
  if (!lignes.length) { _toast(_T('Cochez au moins un article.'), 'ti-alert-circle', 'var(--danger)'); return; }
  const liv = (document.querySelector('input[name=cs-pl-liv]:checked') || {}).value || 'lagord';
  const cfg = await config(true);
  let adr;
  if (liv === 'distributeur') {
    const cl = pl.r.client || {};
    adr = { nom: cl.nom || pl.r.distributeur || '', contact: cl.contact || '', adresse: [cl.adresse, [cl.cp, cl.ville].filter(Boolean).join(' ')].filter(Boolean).join('\n'),
      pays: cl.pays || 'France', tel: cl.tel || '', email: cl.email || '' };
    // Coordonnées manquantes : on complète avec la fiche du distributeur dans l'appli
    try {
      if (pl.r.distributeur) {
        const rows = await API.clients(pl.r.distributeur);
        const n = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const f = rows.find(c => n(c.nom) === n(pl.r.distributeur)) || (rows.length === 1 ? rows[0] : null);
        if (f) {
          S._plClientId = f.id;
          if (!adr.adresse) adr.adresse = [f.adresse, f.adresse2, [f.cp, f.ville].filter(Boolean).join(' ')].filter(x => x && String(x).trim()).join('\n');
          if (!adr.tel) adr.tel = f.tel || f.portable || '';
          if (!adr.email) adr.email = f.email || '';
          if (!adr.contact) adr.contact = f.contact || '';
        }
      }
    } catch (_) {}
  } else adr = cfg.presets[liv] || {};
  // N° du bon = n° du devis avec « BC- » à la place de « D- » (suffixe -2, -3… s'il existe déjà) ; modifiable dans le bon
  let numBc = cfg.prochain_numero;
  const base = String(pl.r.numero || '').trim();
  if (base) {
    numBc = /^D[-_ ]?/i.test(base) ? base.replace(/^D[-_ ]?/i, 'BC-') : 'BC-' + base;
    try {
      const pris = new Set((await API.commandesSuede()).map(x => String(x.numero_bc || '').toUpperCase()));
      if (pris.has(numBc.toUpperCase())) { let k = 2; while (pris.has((numBc + '-' + k).toUpperCase())) k++; numBc = numBc + '-' + k; }
    } catch (_) {}
  }
  S.cs = { id: null, etape: 'brouillon', numero_bc: numBc, date_commande: new Date().toISOString().slice(0, 10),
    reference_client: '', client_id: liv === 'distributeur' ? (S._plClientId || null) : null, livraison_type: liv,
    livraison_nom: adr.nom, livraison_contact: adr.contact, livraison_adresse: adr.adresse, livraison_pays: adr.pays || 'France',
    livraison_tel: adr.tel, livraison_email: adr.email, afficher_prix: false, notes: '', lignes,
    devis_pennylane: pl.r.numero, distributeur_devis: pl.r.distributeur || '' };
  S.vue = 'edition'; S.id = null; S.modifie = true; S._pl = null; S._plClientId = null;
  closeModal();
  if (typeof setView === 'function' && typeof STATE !== 'undefined' && STATE.view !== 'commande-suede') setView('commande-suede', { garderPO: true }); else render();
}
window.csDepuisDevisPL = modalDevisPL;
window.csChercherDevisPL = chercherDevisPL;
window.csPlLigne = plLigne;
window.csCreerDepuisDevisPL = creerDepuisDevisPL;

// ── Aperçu du devis Pennylane dans un volet à droite (le bon reste modifiable à gauche) ──
function voirDevis() {
  const num = (($('cs-devis') || {}).value || (S.cs && S.cs.devis_pennylane) || '').trim();
  if (!num) { _toast(_T('Indiquez d’abord le n° du devis Pennylane.'), 'ti-alert-circle', 'var(--danger)'); const i = $('cs-devis'); if (i) i.focus(); return; }
  let p = $('cs-devis-panel');
  const L = 'min(42vw, 680px)';
  const tb = document.querySelector('.topbar'), haut = tb ? Math.max(0, Math.round(tb.getBoundingClientRect().bottom)) : 0;
  if (!p) {
    p = document.createElement('div'); p.id = 'cs-devis-panel';
    p.style.cssText = `position:fixed;top:${haut}px;right:0;bottom:0;width:${L};background:var(--bg,#fff);border-left:1px solid var(--border);box-shadow:-6px 0 24px rgba(0,0,0,.12);z-index:900;display:flex;flex-direction:column`;
    document.body.appendChild(p);
    S._devisAbs = 0; S._devisTimer = setInterval(() => { S._devisAbs = $('cs-lignes') ? 0 : S._devisAbs + 1; if (S._devisAbs >= 3) fermerDevis(); }, 1000);
  }
  p.innerHTML = `<div style="display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--border);background:var(--card,#fff)">
      <i class="ti ti-file-search"></i><b>${_T('Devis Pennylane')}</b> <span class="mono">${e_(num)}</span>
      <a class="btn sm" style="margin-left:auto;text-decoration:none" href="/api/commandes-suede-po/devis-pdf?numero=${encodeURIComponent(num)}" target="_blank" rel="noopener" title="${_T('Ouvrir dans un onglet')}"><i class="ti ti-external-link"></i></a>
      <button class="btn sm" onclick="csFermerDevis()" title="${_T('Fermer')}"><i class="ti ti-x"></i></button></div>
    <div style="position:relative;flex:1">
      <div id="cs-devis-chg" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--text2);font-size:13.5px"><i class="ti ti-loader"></i>&nbsp;${_T('Chargement du devis depuis Pennylane…')}</div>
      <iframe id="cs-devis-frame" style="position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff" src="/api/commandes-suede-po/devis-pdf?numero=${encodeURIComponent(num)}" onload="var c=document.getElementById('cs-devis-chg'); if(c) c.remove()"></iframe>
    </div>`;
  if (S._c) S._c.style.paddingRight = `calc(${L} + 12px)`;
  if ($('cs-lignes') && S.cs) { lireLignesDuDom(); dessinerLignes(); }
}
function fermerDevis() {
  const p = $('cs-devis-panel'); if (p) p.remove();
  clearInterval(S._devisTimer); S._devisTimer = null;
  if (S._c) S._c.style.paddingRight = '';
  if ($('cs-lignes') && S.cs) { lireLignesDuDom(); dessinerLignes(); }
}
window.csVoirDevis = voirDevis;
window.csFermerDevis = fermerDevis;
window.csNouveau = nouveau;
window.csOuvrir = ouvrir;
window.csQuitter = () => quitter(false);
window.csRenderEdition = renderEdition;
window.csModif = () => { S.modifie = true; };
window.csDessinerLignes = () => { lireLignesDuDom(); dessinerLignes(); };
window.csTotaux = totaux;
window.csChercherArticle = chercherArticle;
window.csAjouterArticle = ajouterArticle;
window.csLigneLibre = ligneLibre;
window.csRetirerLigne = retirerLigne;
window.csTypeLivraison = typeLivraison;
window.csChercherClient = chercherClient;
window.csChoisirClient = choisirClient;
window.csEnregistrer = () => enregistrer(false);
window.csValider = valider;
window.csDevalider = devalider;
window.csApercuPDF = apercuPDF;
window.csEnvoyer = envoyer;
window.csConfirmerEnvoi = confirmerEnvoi;
window.csExpedition = expedition;
window.csReception = reception;
window.csSupprimer = supprimer;
})();
