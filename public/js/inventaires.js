// public/js/inventaires.js
// ─────────────────────────────────────────────────────────────────────────────
// Inventaire mensuel par emplacement (Lagord, Paris, Stock SAV) : feuille de comptage
// enregistrée au fil de la saisie, contrôle des écarts, puis validation qui régularise
// VosFactures (bons d'entrée / de sortie internes) et le stock de l'appli.
// ─────────────────────────────────────────────────────────────────────────────
(function(){
'use strict';

const I = window._INV = window._INV || { id: null, data: null, q: '', filtre: 'tous', attendu: false };
const $ = id => document.getElementById(id);
const e_ = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const _T = s => (typeof TR === 'function') ? TR(s) : s;
const MOIS = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
const libPeriode = p => { const [a, m] = String(p || '').split('-'); return m ? `${MOIS[parseInt(m) - 1]} ${a}` : (p || ''); };
const dateFr = d => d ? new Date(d).toLocaleDateString('fr-FR') : '';
const eur = v => (Math.round((+v || 0) * 100) / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const peutEcrire = () => (typeof isAdmin === 'function' && isAdmin()) || (typeof canWrite === 'function' && canWrite('catalogue'));
const ICONES = { lagord: 'ti-building-warehouse', paris: 'ti-building', sav: 'ti-tool' };
let _compteVF = null;
const lienVF = id => `https://${_compteVF || 'eloflex'}.vosfactures.fr/warehouse_documents/${id}`;

async function renderInventaire(ttl, c, a){
  ttl.textContent = _T('Inventaire');
  if (I.id) return renderFeuille(ttl, c, a);
  if (I.synthese) return renderSynthese(ttl, c, a);
  a.innerHTML = '';
  const d = await API.get('/inventaires');
  _compteVF = d.compte_vf;
  c.innerHTML = `
    <div style="font-size:13.5px;color:var(--text2);margin-bottom:14px;max-width:900px">${_T('Un inventaire par emplacement et par mois. Le comptage s’enregistre au fur et à mesure (on peut s’arrêter et reprendre, ou compter à plusieurs). À la validation, les écarts de Lagord et Paris sont régularisés dans VosFactures ; le stock SAV reste propre à l’appli.')}</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin-bottom:22px">
      ${d.emplacements.map(e => {
        const ec = e.en_cours, pct = ec && ec.nb ? Math.round(ec.comptees * 100 / ec.nb) : 0;
        return `<div class="card" style="padding:16px 18px">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px"><i class="ti ${ICONES[e.code] || 'ti-box'}" style="font-size:22px;color:var(--accent)"></i>
            <div style="font-weight:700;font-size:16px">${e_(e.nom)}</div>
            <span style="margin-left:auto;font-size:11.5px;font-weight:600;padding:2px 8px;border-radius:99px;${e.vf ? 'background:#dbeafe;color:#1e40af' : 'background:#ede9fe;color:#6d28d9'}">${e.vf ? _T('inclus dans VosFactures') : _T('hors VosFactures')}</span></div>
          <div style="font-size:13px;color:var(--text2)">${_T('Pièces en stock')} : <b>${e.quantite}</b></div>
          <div style="font-size:13px;color:var(--text2);margin-bottom:12px">${_T('Dernier inventaire')} : ${e.dernier ? `<b>${libPeriode(e.dernier.periode)}</b> (${_T('validé le')} ${dateFr(e.dernier.valide_at)})` : `<i>${_T('aucun')}</i>`}</div>
          ${peutEcrire() ? `<div style="margin:-6px 0 12px"><a href="#" onclick="event.preventDefault();invGererZones('${e.code}')" style="font-size:12.5px;color:var(--accent)"><i class="ti ti-map-pins"></i> ${_T('Gérer les zones de rangement')}</a></div>` : ''}
          ${ec ? `<div style="font-size:13px;margin-bottom:6px">${_T('En cours')} : <b>${libPeriode(ec.periode)}</b> — ${ec.comptees}/${ec.nb} ${_T('comptées')}</div>
              <div style="height:7px;background:var(--bg);border-radius:99px;overflow:hidden;margin-bottom:12px"><div style="height:100%;width:${pct}%;background:var(--accent)"></div></div>
              <button class="btn primary" onclick="invOuvrir(${ec.id})"><i class="ti ti-player-play"></i>${_T('Reprendre le comptage')}</button>`
            : (peutEcrire() ? `<button class="btn primary" onclick="invDemarrer('${e.code}')"><i class="ti ti-plus"></i>${_T('Démarrer l’inventaire')} ${libPeriode(d.periode)}</button>` : '')}
        </div>`; }).join('')}
    </div>
    <div style="margin:-8px 0 20px"><button class="btn" onclick="invSynthese(true)"><i class="ti ti-columns"></i>${_T('Synthèse Lagord + Paris')}</button></div>
    <h3 style="font-size:15px;margin-bottom:8px">${_T('Historique')}</h3>
    ${d.historique.length ? `<div class="table-wrap"><table class="t"><thead><tr>
        <th>${_T('Mois')}</th><th>${_T('Emplacement')}</th><th>${_T('Validé le')}</th><th>${_T('Par')}</th><th style="text-align:right">${_T('Écarts')}</th><th style="text-align:right">${_T('Valeur achat')}</th><th>VosFactures</th><th></th></tr></thead>
      <tbody>${d.historique.map(h => { const r = h.resume || {}, e = d.emplacements.find(x => x.code === h.emplacement) || {}; return `<tr>
        <td><b>${libPeriode(h.periode)}</b></td><td>${e_(e.nom || h.emplacement)}</td><td>${dateFr(h.valide_at)}</td><td>${e_(h.valide_par || '')}</td>
        <td style="text-align:right">${r.lignes_ecart != null ? `${r.lignes_ecart} <span style="color:var(--text3);font-size:12px">(+${r.plus || 0} / −${r.moins || 0})</span>` : '—'}</td>
        <td style="text-align:right;font-size:12.5px">${r.valeur_plus != null ? `<span style="color:var(--success)">+${eur(r.valeur_plus)}</span><br><span style="color:var(--danger)">−${eur(r.valeur_moins)}</span>` : ''}</td>
        <td style="font-size:12.5px">${h.mise_en_place ? `<i>${_T('mise en place, VF inchangé')}</i>` : !e.vf ? `<i>${_T('hors VosFactures')}</i>` : [h.vf_entree_id ? `<a href="${lienVF(h.vf_entree_id)}" target="_blank">${_T('Bon d’entrée')}</a>` : '', h.vf_sortie_id ? `<a href="${lienVF(h.vf_sortie_id)}" target="_blank">${_T('Bon de sortie')}</a>` : ''].filter(Boolean).join(' · ') || '—'}${h.vf_message ? `<div style="color:#b45309">${e_(h.vf_message)}</div>` : ''}</td>
        <td style="white-space:nowrap"><button class="btn sm" onclick="invOuvrir(${h.id})"><i class="ti ti-eye"></i>${_T('Voir')}</button> <a class="btn sm" href="/api/inventaires/${h.id}/export"><i class="ti ti-file-spreadsheet"></i>CSV</a></td></tr>`; }).join('')}</tbody></table></div>`
      : `<div style="color:var(--text3);font-size:13.5px">${_T('Aucun inventaire validé pour l’instant.')}</div>`}`;
}

async function invDemarrer(code){
  try { const r = await API.post('/inventaires', { emplacement: code }); I.id = r.id; I.q = ''; I.filtre = 'tous'; render(); }
  catch (e) { toast('Erreur : ' + e.message, 'ti-alert-circle', 'var(--danger)'); }
}
function invOuvrir(id){ I.synthese = false; I.id = id; I.q = ''; I.filtre = 'tous'; I.fzone = ''; render(); }
function invRetour(){ I.id = null; I.data = null; render(); }

async function renderFeuille(ttl, c, a){
  const d = I.data = await API.get(`/inventaires/${I.id}`);
  const enCours = d.statut === 'en_cours', ecr = enCours && peutEcrire();
  // Zone en cours (rayon, étagère…) : appliquée aux pièces comptées sans zone ; mémorisée pour cet inventaire
  try { I.zone = localStorage.getItem('inv_zone_' + d.id) || ''; } catch (_) { I.zone = I.zone || ''; }
  I.fzone = I.fzone || '';
  ttl.textContent = `${_T('Inventaire')} ${d.emplacement_nom} — ${libPeriode(d.periode)}`;
  a.innerHTML = `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end">
    <button class="btn" onclick="invRetour()"><i class="ti ti-arrow-left"></i>${_T('Tous les inventaires')}</button>
    <a class="btn" href="/api/inventaires/${d.id}/export"><i class="ti ti-file-spreadsheet"></i>${_T('Export Excel (CSV)')}</a>
    ${ecr ? `<button class="btn" style="color:var(--danger)" onclick="invSupprimer()"><i class="ti ti-trash"></i>${_T('Abandonner')}</button>
      <button class="btn primary" onclick="invControle()"><i class="ti ti-checklist"></i>${_T('Contrôler et valider')}</button>` : ''}
  </div>`;
  c.innerHTML = `
    ${enCours ? '' : `<div style="background:var(--bg);border-radius:10px;padding:10px 14px;margin-bottom:12px;font-size:13.5px"><i class="ti ti-lock"></i> ${_T('Inventaire validé le')} ${dateFr(d.valide_at)} ${_T('par')} ${e_(d.valide_par || '')}${d.mise_en_place ? ' — ' + _T('mise en place (VosFactures inchangé)') : ''}.</div>`}
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px;position:sticky;top:0;z-index:3;background:var(--bg-page, var(--bg));padding:6px 0">
      <input id="inv-q" class="search-bar" style="max-width:320px" placeholder="${_T('Référence ou désignation… (Entrée = aller à la pièce)')}" value="${e_(I.q)}" autocomplete="off">
      <select id="inv-filtre" class="form-input" style="width:auto;padding:6px 8px">
        ${[['tous', 'Toutes les pièces'], ['a_compter', 'À compter'], ['comptees', 'Comptées'], ['ecarts', 'Avec écart']].map(([v, l]) => `<option value="${v}" ${I.filtre === v ? 'selected' : ''}>${_T(l)}</option>`).join('')}</select>
      <select id="inv-fzone" class="form-input" style="width:auto;padding:6px 8px;max-width:200px" title="${_T('Filtrer par zone')}"></select>
      ${ecr ? `<label style="display:flex;gap:6px;align-items:center;font-size:13px;color:var(--text2)" title="${_T('Zone appliquée automatiquement aux pièces que vous comptez ensuite (si elles n’ont pas déjà une zone). Laisser vide pour ne rien appliquer.')}"><i class="ti ti-map-pin"></i>${_T('Zone en cours')}
        <select id="inv-zone" class="form-input" style="width:170px;padding:6px 8px"></select></label>
        <button class="btn sm" onclick="invGererZones('${d.emplacement}')" title="${_T('Ajouter, renommer ou supprimer des zones')}"><i class="ti ti-map-pins"></i>${_T('Gérer les zones')}</button>` : ''}
      ${enCours ? `<label style="display:flex;gap:6px;align-items:center;font-size:13px;color:var(--text2);cursor:pointer"><input type="checkbox" id="inv-attendu" ${I.attendu ? 'checked' : ''}> ${_T('Afficher le stock attendu')}</label>` : ''}
      <div id="inv-prog" style="margin-left:auto;font-size:13px;color:var(--text2)"></div>
    </div>
    <div class="table-wrap"><table class="t" id="inv-table"><thead><tr>
      <th style="width:150px">${_T('Réf.')}</th><th>${_T('Désignation')}</th><th style="width:160px">${_T('Zone')}</th>
      <th class="inv-att" style="width:80px;text-align:right">${enCours ? _T('Attendu') : _T('Au lancement')}</th>
      <th style="width:110px">${_T('Compté')}</th><th class="inv-att" style="width:70px;text-align:right">${_T('Écart')}</th>
      <th>${_T('Note')}</th><th style="width:30px"></th></tr></thead><tbody id="inv-body"></tbody></table></div>
    <style>#inv-table:not(.att) .inv-att{display:none} #inv-table input.inv-c{width:90px;padding:5px 8px;font-weight:700;text-align:right}
      #inv-table tr.ok td{background:rgba(34,197,94,.06)} #inv-table input.inv-n{padding:5px 8px;font-size:12.5px}
      #inv-table select.inv-z{padding:5px 8px;font-size:12.5px;width:150px}</style>`;
  const tb = $('inv-table'); if (tb) tb.classList.toggle('att', !enCours || I.attendu);
  $('inv-q').addEventListener('input', ev => { I.q = ev.target.value; clearTimeout(I._t); I._t = setTimeout(dessinerLignes, 150); });
  $('inv-q').addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); allerAPiece(); } });
  $('inv-filtre').onchange = ev => { I.filtre = ev.target.value; dessinerLignes(); };
  if ($('inv-attendu')) $('inv-attendu').onchange = ev => { I.attendu = ev.target.checked; tb.classList.toggle('att', I.attendu); };
  if ($('inv-zone')) $('inv-zone').addEventListener('change', async ev => {
    let v = ev.target.value;
    if (v === '__new') { v = await nouvelleZone(); if (v == null) { ev.target.value = I.zone; return; } }
    definirZone(v); majZones();
  });
  $('inv-fzone').onchange = ev => { I.fzone = ev.target.value; dessinerLignes(); };
  majZones();
  dessinerLignes();
  if (enCours) setTimeout(() => $('inv-q') && $('inv-q').focus(), 50);
}

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const ecartDe = l => l.compte == null ? null : l.compte - (I.data.statut === 'en_cours' ? (l.actuel ?? l.theorique) : l.theorique);
function lignesVisibles(){
  const q = norm(I.q).trim(), mots = q.split(/\s+/).filter(Boolean);
  return I.data.lignes.filter(l => {
    if (I.filtre === 'a_compter' && l.compte != null) return false;
    if (I.filtre === 'comptees' && l.compte == null) return false;
    if (I.filtre === 'ecarts' && !(I.data.statut === 'en_cours' ? ecartDe(l) : l.ecart)) return false;
    if (I.fzone === '__vide' && l.zone) return false;
    if (I.fzone && I.fzone !== '__vide' && l.zone !== I.fzone) return false;
    if (!mots.length) return true;
    const t = norm(l.ref + ' ' + l.designation + ' ' + (l.zone || ''));
    return mots.every(m => t.includes(m));
  });
}
function dessinerLignes(){
  const body = $('inv-body'); if (!body) return;
  const d = I.data, enCours = d.statut === 'en_cours', ecr = enCours && peutEcrire();
  const vis = lignesVisibles();
  body.innerHTML = vis.slice(0, 1500).map(l => {
    const ec = enCours ? ecartDe(l) : l.ecart, i = d.lignes.indexOf(l);
    return `<tr id="inv-r-${l.catalogue_id}" class="${l.compte != null ? 'ok' : ''}">
      <td class="mono">${e_(l.ref)}${l.vf === false && d.vf_emplacement ? ` <i class="ti ti-plug-connected-x" style="color:#b45309" title="${_T('Pièce non liée à VosFactures : régularisée dans l’appli seulement')}"></i>` : ''}</td>
      <td>${e_(l.designation)}</td>
      <td>${ecr ? `<select class="form-input inv-z" onchange="invZone(${i},this)">${optionsZones(l.zone)}</select>` : e_(l.zone || '')}</td>
      <td class="inv-att" style="text-align:right;color:var(--text2)">${enCours ? (l.actuel ?? l.theorique) : l.theorique}</td>
      <td>${ecr ? `<input class="form-input inv-c" type="number" min="0" inputmode="numeric" data-i="${i}" value="${l.compte ?? ''}" onfocus="invZoneAuto(${i})" onchange="invSaisie(${i},this.value)" onkeydown="invTouche(event,this)">` : `<b>${l.compte ?? '—'}</b>`}</td>
      <td class="inv-att inv-ec" style="text-align:right;font-weight:700;color:${ec > 0 ? 'var(--success)' : ec < 0 ? 'var(--danger)' : 'var(--text3)'}">${ec == null ? '' : ec > 0 ? '+' + ec : ec}</td>
      <td>${ecr ? `<input class="form-input inv-n" value="${e_(l.note || '')}" placeholder="—" onchange="invNote(${i},this.value)">` : e_(l.note || '')}</td>
      <td style="color:var(--text3);font-size:11px" title="${e_(l.maj_par ? l.maj_par + ' — ' + new Date(l.maj_at).toLocaleString('fr-FR') : '')}">${l.maj_par ? '<i class="ti ti-user-check"></i>' : ''}</td></tr>`;
  }).join('') || `<tr><td colspan="8" style="color:var(--text3);padding:16px">${_T('Aucune pièce')}</td></tr>`;
  majProgression();
}
function majProgression(){
  const el = $('inv-prog'); if (!el) return;
  const L = I.data.lignes, n = L.filter(l => l.compte != null).length;
  el.innerHTML = `<b>${n}</b> / ${L.length} ${_T('pièces comptées')} (${L.length ? Math.round(n * 100 / L.length) : 0} %)`;
}
function allerAPiece(){
  const q = norm(I.q).trim(); if (!q) return;
  // Saisie rapide : le tableau filtré n'est peut-être pas encore redessiné
  if (I._t) { clearTimeout(I._t); I._t = null; dessinerLignes(); }
  const vis = lignesVisibles();
  const l = I.data.lignes.find(x => norm(x.ref) === q) || (vis.length === 1 ? vis[0] : null);
  if (!l) return;
  const inp = document.querySelector(`#inv-r-${l.catalogue_id} input.inv-c`);
  if (inp) { inp.focus(); inp.select(); inp.scrollIntoView({ block: 'center' }); }
}
function invTouche(ev, el){
  if (ev.key !== 'Enter') return;
  ev.preventDefault();
  el.dispatchEvent(new Event('change'));
  // Recherche active : on revient à la recherche pour la pièce suivante ; sinon ligne suivante
  if (I.q && $('inv-q')) { const q = $('inv-q'); q.focus(); q.select(); return; }
  const ins = [...document.querySelectorAll('#inv-body input.inv-c')], k = ins.indexOf(el);
  if (ins[k + 1]) { ins[k + 1].focus(); ins[k + 1].select(); }
}
async function invSaisie(i, v){
  const l = I.data.lignes[i]; if (!l) return;
  const val = String(v).trim() === '' ? null : parseInt(v);
  if (val != null && !(val >= 0)) { toast(_T('Quantité invalide'), 'ti-alert-circle', 'var(--danger)'); return; }
  if (val === l.compte) return;
  const body = { compte: val };
  if (val != null && !l.zone && I.zone) body.zone = I.zone;   // zone en cours appliquée aux pièces sans zone
  try {
    const r = await API.put(`/inventaires/${I.data.id}/lignes/${l.catalogue_id}`, body);
    Object.assign(l, { compte: r.compte, maj_par: r.maj_par, maj_at: r.maj_at, zone: r.zone });
    const tr = $('inv-r-' + l.catalogue_id);
    if (tr) {
      tr.classList.toggle('ok', l.compte != null);
      const iz = tr.querySelector('select.inv-z'); if (iz && body.zone) { iz.innerHTML = optionsZones(l.zone); majZones(); }
      const ec = ecartDe(l), td = tr.querySelector('td.inv-ec');
      td.textContent = ec == null ? '' : ec > 0 ? '+' + ec : String(ec);
      td.style.color = ec > 0 ? 'var(--success)' : ec < 0 ? 'var(--danger)' : 'var(--text3)';
    }
    majProgression();
  } catch (e) { toast('Erreur : ' + e.message, 'ti-alert-circle', 'var(--danger)'); }
}
// Zone d'une pièce : enregistrée, mémorisée pour les prochains inventaires, et devient la zone en cours
async function invZone(i, sel){
  const l = I.data.lignes[i]; if (!l) return;
  let z = sel.value;
  if (z === '__new') { z = await nouvelleZone(); if (z == null) { sel.innerHTML = optionsZones(l.zone); return; } }
  try {
    const r = await API.put(`/inventaires/${I.data.id}/lignes/${l.catalogue_id}`, { zone: z });
    l.zone = r.zone; sel.innerHTML = optionsZones(l.zone);
    if (z) definirZone(z);
    majZones();
  } catch (e) { toast('Erreur : ' + e.message, 'ti-alert-circle', 'var(--danger)'); }
}
// Dès qu'on arrive sur une pièce sans zone (recherche + Entrée, clic ou ligne suivante), la zone en cours lui est appliquée
async function invZoneAuto(i){
  const l = I.data.lignes[i]; if (!l || l.zone || !I.zone || l._zAuto) return;
  l._zAuto = true; const z = I.zone;
  l.zone = z;   // affichage immédiat
  const sel = document.querySelector(`#inv-r-${l.catalogue_id} select.inv-z`); if (sel) sel.innerHTML = optionsZones(z);
  try { const r = await API.put(`/inventaires/${I.data.id}/lignes/${l.catalogue_id}`, { zone: z }); l.zone = r.zone; majZones(); }
  catch (e) { l.zone = null; if (sel) sel.innerHTML = optionsZones(null); toast('Erreur : ' + e.message, 'ti-alert-circle', 'var(--danger)'); }
  finally { l._zAuto = false; }
}
// Zones connues de l'emplacement (liste gérée + zones présentes sur les lignes)
function listeZones(){ return [...new Set([...(I.data.zones || []), ...I.data.lignes.map(l => l.zone).filter(Boolean)])].sort((a, b) => a.localeCompare(b, 'fr')); }
function optionsZones(sel){
  const zs = listeZones();
  return `<option value="">—</option>` + zs.map(z => `<option value="${e_(z)}" ${z === sel ? 'selected' : ''}>${e_(z)}</option>`).join('')
    + `<option value="__new">➕ ${_T('Nouvelle zone…')}</option>`;
}
async function nouvelleZone(empl){
  const nom = String(prompt(_T('Nom de la nouvelle zone (ex. Rayon A, Étagère 3, Réserve) :')) || '').trim().replace(/\s+/g, ' ');
  if (!nom) return null;
  try {
    const r = await API.post(`/inventaires-zones/${empl || I.data.emplacement}`, { nom });
    if (I.data && (!empl || empl === I.data.emplacement)) { I.data.zones = r.zones.map(z => z.nom); rafraichirSelectsZones(); }
    return r.nom;
  } catch (e) { toast('Erreur : ' + e.message, 'ti-alert-circle', 'var(--danger)'); return null; }
}
function rafraichirSelectsZones(){
  document.querySelectorAll('#inv-body select.inv-z').forEach(s => {
    const tr = s.closest('tr'), cid = tr && parseInt(tr.id.replace('inv-r-', ''));
    const l = I.data.lignes.find(x => x.catalogue_id === cid); s.innerHTML = optionsZones(l && l.zone);
  });
  majZones();
}

// ── Gestion des zones (ajout / renommage / suppression) ──
async function invGererZones(empl){
  let zs = [];
  try { zs = await API.get(`/inventaires-zones/${empl}`); } catch (e) { toast('Erreur : ' + e.message, 'ti-alert-circle', 'var(--danger)'); return; }
  const nomEmpl = { lagord: 'Lagord', paris: 'Paris (Malakoff)', sav: 'Stock SAV' }[empl] || empl;
  showModal(`<div class="modal-header"><i class="ti ti-map-pins" style="font-size:19px;color:var(--accent)"></i><h2>${_T('Zones de rangement')} — ${e_(nomEmpl)}</h2><button class="btn sm" onclick="invZonesFermer()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body">
      <div style="font-size:13px;color:var(--text2);margin-bottom:10px">${_T('Les zones servent à repérer où se trouve chaque pièce pendant le comptage. Supprimer une zone ne supprime aucune pièce : celles qui y étaient passent simplement « sans zone ».')}</div>
      <div style="display:flex;gap:8px;margin-bottom:12px"><input class="form-input" id="zn-nom" placeholder="${_T('Nouvelle zone (ex. Rayon A, Étagère 3, Réserve)')}" maxlength="60" onkeydown="if(event.key==='Enter')invZoneAjouter('${empl}')">
        <button class="btn primary" onclick="invZoneAjouter('${empl}')"><i class="ti ti-plus"></i>${_T('Ajouter')}</button></div>
      ${zs.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>${_T('Zone')}</th><th style="text-align:right">${_T('Pièces rangées')}</th><th style="width:230px"></th></tr></thead><tbody>
        ${zs.map(z => `<tr><td><b>${e_(z.nom)}</b></td><td style="text-align:right">${z.nb}</td>
          <td style="white-space:nowrap;text-align:right"><button class="btn sm" data-z="${e_(z.nom)}" onclick="invZoneRenommer('${empl}',this.dataset.z)" title="${_T('Renommer')}"><i class="ti ti-pencil"></i>${_T('Renommer')}</button>
          <button class="btn sm" style="color:var(--danger)" data-z="${e_(z.nom)}" data-n="${z.nb}" onclick="invZoneSupprimer('${empl}',this.dataset.z,+this.dataset.n)" title="${_T('Supprimer')}"><i class="ti ti-trash"></i>${_T('Supprimer')}</button></td></tr>`).join('')}
      </tbody></table></div>` : `<div style="color:var(--text3);font-size:13.5px">${_T('Aucune zone pour l’instant.')}</div>`}
    </div>
    <div class="modal-footer"><button class="btn primary" onclick="invZonesFermer()">${_T('Fermer')}</button></div>`);
  setTimeout(() => $('zn-nom') && $('zn-nom').focus(), 50);
}
async function invZoneAjouter(empl){
  const nom = String(($('zn-nom') || {}).value || '').trim();
  if (!nom) return;
  try { await API.post(`/inventaires-zones/${empl}`, { nom }); I._zonesModif = true; invGererZones(empl); }
  catch (e) { toast('Erreur : ' + e.message, 'ti-alert-circle', 'var(--danger)'); }
}
async function invZoneRenommer(empl, ancien){
  const nom = String(prompt(_T('Nouveau nom de la zone :'), ancien) || '').trim();
  if (!nom || nom === ancien) return;
  try { await API.put(`/inventaires-zones/${empl}`, { ancien, nom }); I._zonesModif = true; if (I.zone === ancien) definirZone(nom); invGererZones(empl); }
  catch (e) { toast('Erreur : ' + e.message, 'ti-alert-circle', 'var(--danger)'); }
}
async function invZoneSupprimer(empl, nom, nb){
  if (!confirm(`${_T('Supprimer la zone')} « ${nom} » ?${nb ? `\n${nb} ${_T('pièce(s) y sont rangées : elles passeront « sans zone ».')}` : ''}`)) return;
  try { await API.del(`/inventaires-zones/${empl}?nom=${encodeURIComponent(nom)}`); I._zonesModif = true; if (I.zone === nom) definirZone(''); invGererZones(empl); }
  catch (e) { toast('Erreur : ' + e.message, 'ti-alert-circle', 'var(--danger)'); }
}
function invZonesFermer(){
  closeModal();
  if (I._zonesModif) { I._zonesModif = false; render(); }   // recharge la feuille / la liste avec les zones à jour
}
function definirZone(v){
  I.zone = String(v || '').trim().replace(/\s+/g, ' ');
  try { localStorage.setItem('inv_zone_' + I.data.id, I.zone); } catch (_) {}
  const el = $('inv-zone'); if (el && el.value !== I.zone) el.value = I.zone;
}
function majZones(){
  const zs = listeZones();
  const zc = $('inv-zone');
  if (zc) zc.innerHTML = `<option value="">${_T('aucune')}</option>` + zs.map(z => `<option value="${e_(z)}" ${z === I.zone ? 'selected' : ''}>${e_(z)}</option>`).join('')
    + `<option value="__new">➕ ${_T('Nouvelle zone…')}</option>`;
  const f = $('inv-fzone'); if (!f) return;
  if (I.fzone && I.fzone !== '__vide' && !zs.includes(I.fzone)) I.fzone = '';
  const n = z => I.data.lignes.filter(l => z === '__vide' ? !l.zone : l.zone === z).length;
  f.innerHTML = `<option value="">${_T('Toutes les zones')}</option>` + zs.map(z => `<option value="${e_(z)}" ${I.fzone === z ? 'selected' : ''}>${e_(z)} (${n(z)})</option>`).join('')
    + `<option value="__vide" ${I.fzone === '__vide' ? 'selected' : ''}>${_T('Sans zone')} (${n('__vide')})</option>`;
}
async function invNote(i, v){
  const l = I.data.lignes[i]; if (!l) return;
  try { await API.put(`/inventaires/${I.data.id}/lignes/${l.catalogue_id}`, { note: v }); l.note = v; }
  catch (e) { toast('Erreur : ' + e.message, 'ti-alert-circle', 'var(--danger)'); }
}
async function invSupprimer(){
  if (!confirm(_T('Abandonner cet inventaire ? Les quantités saisies seront perdues (le stock n’a pas encore été modifié).'))) return;
  try { await API.del(`/inventaires/${I.data.id}`); invRetour(); } catch (e) { toast('Erreur : ' + e.message, 'ti-alert-circle', 'var(--danger)'); }
}

// ── Contrôle et validation ─────────────────────────────────────────
async function invControle(){
  const d = I.data;
  I.opts = I.opts || {};
  I.opts.non_comptes = I.opts.non_comptes || 'inchange';
  let r;
  try { r = await API.get(`/inventaires/${d.id}/controle?non_comptes=${I.opts.non_comptes}`); }
  catch (e) { toast('Erreur : ' + e.message, 'ti-alert-circle', 'var(--danger)'); return; }
  if (I.opts.mise_en_place === undefined) I.opts.mise_en_place = d.emplacement === 'paris' && r.premier;
  const mep = d.emplacement === 'paris' && I.opts.mise_en_place;
  const avecVF = r.vf_emplacement && !mep;
  const nPlus = r.lignes.filter(l => l.ecart > 0).length, nMoins = r.lignes.filter(l => l.ecart < 0).length;
  showModal(`<div class="modal-header"><i class="ti ti-checklist" style="font-size:19px;color:var(--accent)"></i><h2>${_T('Contrôle avant validation')} — ${e_(d.emplacement_nom)} ${libPeriode(d.periode)}</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:14px">
        ${[['Pièces comptées', r.comptees, ''], ['Non comptées', r.non_comptees, r.non_comptees ? '#b45309' : ''], ['Pièces en plus', '+' + r.plus + ' · ' + eur(r.valeur_plus), 'var(--success)'], ['Pièces manquantes', '−' + r.moins + ' · ' + eur(r.valeur_moins), 'var(--danger)']]
          .map(([l, v, col]) => `<div style="background:var(--bg);border-radius:10px;padding:10px 12px"><div style="font-size:12px;color:var(--text2)">${_T(l)}</div><div style="font-weight:700;font-size:16px;${col ? 'color:' + col : ''}">${v}</div></div>`).join('')}
      </div>
      ${r.non_comptees ? `<div class="form-group"><label class="form-label">${_T('Pièces non comptées')} (${r.non_comptees})</label>
        <label style="display:flex;gap:8px;align-items:center;font-size:13.5px;margin-bottom:4px"><input type="radio" name="inv-nc" value="inchange" ${I.opts.non_comptes !== 'zero' ? 'checked' : ''} onchange="invOpt('non_comptes','inchange')"> ${_T('Laisser leur stock inchangé')}</label>
        <label style="display:flex;gap:8px;align-items:center;font-size:13.5px"><input type="radio" name="inv-nc" value="zero" ${I.opts.non_comptes === 'zero' ? 'checked' : ''} onchange="invOpt('non_comptes','zero')"> ${_T('Elles ne sont pas dans cet emplacement : stock à 0')}</label></div>` : ''}
      ${r.paris_a_faire ? `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:13.5px;color:#991b1b">
        <i class="ti ti-alert-triangle"></i> <b>${_T('Validez d’abord l’inventaire de Paris.')}</b> ${_T('Paris n’a encore jamais été inventorié : pour l’instant, tout le stock VosFactures est considéré à Lagord. Les pièces transférées à Paris apparaîtraient donc comme manquantes et sortiraient à tort de VosFactures. Gardez ce comptage (il est enregistré), comptez et validez Paris (mise en place), puis revenez valider Lagord : les écarts seront recalculés.')}${r.paris_en_cours ? '' : ` <button class="btn sm" style="margin-left:6px" onclick="closeModal();invDemarrer('paris')">${_T('Démarrer l’inventaire de Paris')}</button>`}</div>` : ''}
      ${d.emplacement === 'paris' ? `<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:13.5px">
        <label style="display:flex;gap:8px;align-items:flex-start;cursor:pointer"><input type="checkbox" ${mep ? 'checked' : ''} onchange="invOpt('mise_en_place',this.checked)" style="margin-top:3px">
        <span><b>${_T('Mise en place du stock de Paris')}</b> — ${_T('les pièces de Paris étaient déjà comptées dans le stock VosFactures : on les répartit sans modifier VosFactures (le stock de Lagord diminue d’autant). À cocher pour le tout premier inventaire de Paris.')}</span></label></div>` : ''}
      <div style="background:var(--bg);border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:13.5px"><i class="ti ti-info-circle"></i>
        ${!r.vf_emplacement ? _T('Stock SAV : seul le stock SAV de l’appli est mis à jour, VosFactures n’est pas modifié.')
          : mep ? _T('Mise en place : seule la répartition Lagord / Paris change dans l’appli, VosFactures n’est pas modifié.')
          : `${_T('À la validation, VosFactures reçoit')} ${nPlus ? `<b>${_T('un bon d’entrée interne')}</b> (${nPlus} ${_T('réf.')}, +${r.plus})` : ''}${nPlus && nMoins ? ` ${_T('et')} ` : ''}${nMoins ? `<b>${_T('un bon de sortie interne')}</b> (${nMoins} ${_T('réf.')}, −${r.moins})` : ''}${!nPlus && !nMoins ? _T('aucun bon (aucun écart)') : ''}, ${_T('numéroté')} INV-${d.emplacement.toUpperCase()}-${d.periode}. ${_T('Le stock de l’appli est ensuite mis à jour.')}${r.sans_vf ? `<div style="color:#b45309;margin-top:4px">${r.sans_vf} ${_T('pièce(s) en écart non liée(s) à VosFactures : régularisée(s) dans l’appli seulement.')}</div>` : ''}${r.vf_configure ? '' : `<div style="color:var(--danger);margin-top:4px">${_T('VosFactures n’est pas configuré : validation impossible.')}</div>`}`}
      </div>
      ${r.lignes.length ? `<div class="table-wrap" style="max-height:340px;overflow:auto"><table class="t"><thead><tr><th>${_T('Réf.')}</th><th>${_T('Désignation')}</th><th style="text-align:right">${_T('Stock')}</th><th style="text-align:right">${_T('Compté')}</th><th style="text-align:right">${_T('Écart')}</th><th style="text-align:right">${_T('Valeur')}</th></tr></thead>
        <tbody>${r.lignes.map(l => `<tr><td class="mono">${e_(l.ref)}</td><td>${e_(l.designation)}${l.zone ? ` <span style="font-size:11.5px;color:var(--text3)"><i class="ti ti-map-pin"></i>${e_(l.zone)}</span>` : ''}${l.compte_saisi ? '' : ` <i style="color:#b45309;font-size:12px">(${_T('non comptée')})</i>`}${l.note ? `<div style="font-size:12px;color:var(--text3)">${e_(l.note)}</div>` : ''}</td>
          <td style="text-align:right">${l.actuel}</td><td style="text-align:right"><b>${l.compte}</b></td>
          <td style="text-align:right;font-weight:700;color:${l.ecart > 0 ? 'var(--success)' : 'var(--danger)'}">${l.ecart > 0 ? '+' : ''}${l.ecart}</td>
          <td style="text-align:right;font-size:12.5px">${l.pu ? eur(l.ecart * l.pu) : '—'}</td></tr>`).join('')}</tbody></table></div>`
        : `<div style="color:var(--success);font-weight:600"><i class="ti ti-circle-check"></i> ${_T('Aucun écart : le stock compté correspond au stock enregistré.')}</div>`}
      <div id="inv-val-msg" style="font-size:13px;margin-top:8px"></div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">${_T('Retour au comptage')}</button>
      ${(typeof isAdmin === 'function' && isAdmin()) ? `<button class="btn primary" id="inv-valider" ${avecVF && !r.vf_configure ? 'disabled' : ''} onclick="invValider()"><i class="ti ti-check"></i>${_T('Valider l’inventaire')}</button>`
        : `<span style="font-size:12.5px;color:var(--text2)">${_T('La validation est réservée à un administrateur.')}</span>`}
    </div>`);
  const m = document.querySelector('#modal-area .modal'); if (m) m.style.maxWidth = '920px';
}
function invOpt(k, v){ I.opts[k] = v; invControle(); }
async function invValider(){
  const d = I.data, o = I.opts || {};
  if (!confirm(_T('Valider l’inventaire ? Les écarts seront appliqués au stock (et à VosFactures pour Lagord / Paris). Cette action est définitive.'))) return;
  const b = $('inv-valider'); if (b) { b.disabled = true; b.innerHTML = '<i class="ti ti-loader-2"></i> ' + _T('Validation…'); }
  try {
    const r = await API.post(`/inventaires/${d.id}/valider`, { non_comptes: o.non_comptes || 'inchange', mise_en_place: !!o.mise_en_place });
    I.opts = {};
    showModal(`<div class="modal-header"><i class="ti ti-circle-check" style="font-size:19px;color:var(--success)"></i><h2>${_T('Inventaire validé')}</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
      <div class="modal-body" style="font-size:14px;line-height:1.7">
        ${r.lignes_ecart} ${_T('écart(s) appliqué(s)')} : <b style="color:var(--success)">+${r.plus}</b> / <b style="color:var(--danger)">−${r.moins}</b>.<br>
        ${r.vf_entree_id ? `<a href="${lienVF(r.vf_entree_id)}" target="_blank"><i class="ti ti-external-link"></i> ${_T('Bon d’entrée VosFactures')}</a><br>` : ''}
        ${r.vf_sortie_id ? `<a href="${lienVF(r.vf_sortie_id)}" target="_blank"><i class="ti ti-external-link"></i> ${_T('Bon de sortie VosFactures')}</a><br>` : ''}
        ${r.mise_en_place ? _T('Mise en place : VosFactures n’a pas été modifié.') + '<br>' : ''}
        ${r.vf_message ? `<span style="color:#b45309">${e_(r.vf_message)}</span>` : ''}
      </div>
      <div class="modal-footer"><button class="btn primary" onclick="closeModal();invRetour()">${_T('Fermer')}</button></div>`);
  } catch (e) {
    const m = $('inv-val-msg'); if (m) m.innerHTML = `<span style="color:var(--danger)">${e_(e.message)}</span>`;
    if (b) { b.disabled = false; b.innerHTML = '<i class="ti ti-check"></i> ' + _T('Valider l’inventaire'); }
  }
}

// ── Synthèse Lagord + Paris (colonnes côte à côte, écart par rapport au stock VosFactures) ──
function invSynthese(on){ I.synthese = !!on; I.id = null; I.sq = ''; I.sf = I.sf || 'tous'; render(); }
const stSyn = l => {
  const compte = l.compte_lagord != null || l.compte_paris != null;
  if (!compte) return l.stock_vf ? 'non' : 'vide';
  const e = (l.compte_lagord || 0) + (l.compte_paris || 0) - l.stock_vf;
  return e === 0 ? 'ok' : e > 0 ? 'plus' : 'moins';
};
async function renderSynthese(ttl, c, a){
  ttl.textContent = _T('Synthèse inventaire Lagord + Paris');
  const d = I.syn = await API.get('/inventaires-synthese');
  const lib = i => i ? `${libPeriode(i.periode)} — ${i.statut === 'en_cours' ? _T('en cours') : _T('validé le') + ' ' + dateFr(i.valide_at)}` : _T('aucun inventaire');
  a.innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
    <button class="btn" onclick="invSynthese(false)"><i class="ti ti-arrow-left"></i>${_T('Tous les inventaires')}</button>
    <button class="btn" onclick="invSyntheseCSV()"><i class="ti ti-file-spreadsheet"></i>${_T('Export Excel (CSV)')}</button></div>`;
  const L = d.lignes, S = k => L.filter(l => stSyn(l) === k);
  const val = arr => arr.reduce((s, l) => s + ((l.compte_lagord || 0) + (l.compte_paris || 0) - l.stock_vf) * (l.pu || 0), 0);
  const tot = k => L.reduce((s, l) => s + (l[k] || 0), 0);
  const carte = (t, v, col) => `<div style="background:var(--bg);border-radius:10px;padding:10px 12px"><div style="font-size:12px;color:var(--text2)">${t}</div><div style="font-weight:700;font-size:17px;${col ? 'color:' + col : ''}">${v}</div></div>`;
  c.innerHTML = `
    <div style="font-size:13px;color:var(--text2);margin-bottom:10px">Lagord : <b>${lib(d.lagord)}</b> · Paris : <b>${lib(d.paris)}</b> · ${_T('Écart = Lagord + Paris comptés − stock VosFactures (total des deux sites).')}</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:14px">
      ${carte(_T('Compté Lagord'), tot('compte_lagord') + ' u.')}${carte(_T('Compté Paris'), tot('compte_paris') + ' u.')}
      ${carte(_T('Conformes'), S('ok').length)}${carte(_T('En surplus'), S('plus').length + ' · +' + eur(val(S('plus'))), 'var(--success)')}
      ${carte(_T('Manquantes'), S('moins').length + ' · ' + eur(val(S('moins'))), 'var(--danger)')}${carte(_T('Non comptées (stock VF > 0)'), S('non').length, '#b45309')}
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px">
      <input id="syn-q" class="search-bar" style="max-width:300px" placeholder="${_T('Référence ou désignation…')}" value="${e_(I.sq || '')}">
      <select id="syn-f" class="form-input" style="width:auto;padding:6px 8px">${[['tous', 'Toutes les pièces'], ['ecarts', 'Avec écart'], ['moins', 'Manquantes'], ['plus', 'En surplus'], ['non', 'Non comptées (stock VF > 0)'], ['ok', 'Conformes']].map(([v, l]) => `<option value="${v}" ${I.sf === v ? 'selected' : ''}>${_T(l)}</option>`).join('')}</select>
      <span id="syn-n" style="font-size:13px;color:var(--text2);align-self:center"></span></div>
    <div class="table-wrap"><table class="t"><thead><tr><th>${_T('Réf.')}</th><th>${_T('Désignation')}</th><th style="text-align:right">${_T('Stock VF')}</th>
      <th style="text-align:right;background:rgba(37,99,235,.08)">Lagord</th><th style="text-align:right;background:rgba(124,58,237,.08)">Paris</th>
      <th style="text-align:right">${_T('Total')}</th><th style="text-align:right">${_T('Écart')}</th><th style="text-align:right">${_T('Valeur')}</th><th>${_T('Remarque')}</th></tr></thead>
      <tbody id="syn-body"></tbody></table></div>`;
  $('syn-q').oninput = ev => { I.sq = ev.target.value; dessinerSynthese(); };
  $('syn-f').onchange = ev => { I.sf = ev.target.value; dessinerSynthese(); };
  dessinerSynthese();
}
function lignesSynthese(){
  const mots = norm(I.sq || '').split(/\s+/).filter(Boolean);
  return I.syn.lignes.filter(l => { const s = stSyn(l);
    if (I.sf === 'ecarts' ? !(s === 'plus' || s === 'moins') : I.sf !== 'tous' && s !== I.sf) return false;
    if (I.sf === 'tous' && s === 'vide') return false;
    const t = norm(l.ref + ' ' + l.designation); return mots.every(m => t.includes(m)); });
}
function dessinerSynthese(){
  const v = lignesSynthese(), b = $('syn-body'); if (!b) return;
  const f = x => x == null ? '<span style="color:var(--text3)">—</span>' : x;
  b.innerHTML = v.slice(0, 2000).map(l => { const s = stSyn(l), tot = (l.compte_lagord || 0) + (l.compte_paris || 0), e = s === 'non' ? null : tot - l.stock_vf;
    return `<tr><td class="mono">${e_(l.ref)}</td><td>${e_(l.designation)}</td><td style="text-align:right">${l.stock_vf}</td>
      <td style="text-align:right;font-weight:700;background:rgba(37,99,235,.05)">${f(l.compte_lagord)}${l.zone_lagord ? `<div style="font-size:11px;color:var(--text3);font-weight:400">${e_(l.zone_lagord)}</div>` : ''}</td>
      <td style="text-align:right;font-weight:700;background:rgba(124,58,237,.05)">${f(l.compte_paris)}${l.zone_paris ? `<div style="font-size:11px;color:var(--text3);font-weight:400">${e_(l.zone_paris)}</div>` : ''}</td>
      <td style="text-align:right">${s === 'non' ? f(null) : tot}</td>
      <td style="text-align:right;font-weight:700;color:${e > 0 ? 'var(--success)' : e < 0 ? 'var(--danger)' : 'var(--text3)'}">${e == null ? `<span style="color:#b45309;font-weight:600;font-size:12px">${_T('non comptée')}</span>` : e > 0 ? '+' + e : e}</td>
      <td style="text-align:right;font-size:12.5px">${e && l.pu ? eur(e * l.pu) : ''}</td><td style="font-size:12px;color:var(--text2)">${e_(l.note || '')}</td></tr>`; }).join('')
    || `<tr><td colspan="9" style="color:var(--text3);padding:14px">${_T('Aucune pièce')}</td></tr>`;
  $('syn-n').textContent = v.length + ' ' + _T('pièce(s)');
}
function invSyntheseCSV(){
  const q = x => { const s = x == null ? '' : String(x); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const out = ['Référence;Réf. fournisseur (Suède);Désignation;Stock VF;Compté Lagord;Zone Lagord;Compté Paris;Zone Paris;Total compté;Écart;Prix achat Suède;Valeur écart;Statut;Remarque'];
  const ST = { ok: 'Conforme', plus: 'Surplus', moins: 'Manquant', non: 'Non comptée', vide: 'Non comptée (stock 0)' };
  for (const l of lignesSynthese()) { const s = stSyn(l), tot = (l.compte_lagord || 0) + (l.compte_paris || 0), e = s === 'non' || s === 'vide' ? '' : tot - l.stock_vf;
    out.push([q(l.ref), q(l.ref_fournisseur), q(l.designation), l.stock_vf, l.compte_lagord ?? '', q(l.zone_lagord), l.compte_paris ?? '', q(l.zone_paris), s === 'non' || s === 'vide' ? '' : tot, e,
      l.pu != null ? String(l.pu).replace('.', ',') : '', e !== '' && l.pu ? String(Math.round(e * l.pu * 100) / 100).replace('.', ',') : '', ST[s], q(l.note)].join(';')); }
  const blob = new Blob(['\ufeff' + out.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `Synthese_inventaire_Lagord_Paris_${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
Object.assign(window, { invSynthese, invSyntheseCSV });
Object.assign(window, { invZoneAuto, invZone, invGererZones, invZoneAjouter, invZoneRenommer, invZoneSupprimer, invZonesFermer, renderInventaire, invDemarrer, invOuvrir, invRetour, invSaisie, invNote, invTouche, invSupprimer, invControle, invOpt, invValider });
})();
