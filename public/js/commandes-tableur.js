// public/js/commandes-tableur.js
// ─────────────────────────────────────────────────────────────────────────────
// « Test suivi commandes » : le Suivi commandes présenté comme le fichier Excel de l'équipe
// (mêmes colonnes, même ordre, mêmes couleurs, onglets par année), avec saisie directe
// dans les cases, navigation au clavier, copier-coller depuis Excel et rafraîchissement auto.
// Toutes les options de l'appli restent accessibles par l'icône ↗ (fiche complète).
// Les enregistrements passent par les routes existantes (POST /commandes, PUT /commandes/:id).
// ─────────────────────────────────────────────────────────────────────────────
(function(){
'use strict';

const BANDES = {           // couleurs des colonnes du fichier Excel (teintes légères pour le mode sombre)
  bleu:  'rgba(180,198,231,.45)', vert: 'rgba(198,224,180,.45)', peche: 'rgba(252,228,214,.6)',
  bleu2: 'rgba(189,215,238,.5)',  jaune: 'rgba(255,242,204,.75)',
};
const GROUPES = ['De Base','Distri Club','Providom','Négocié','Bastide','Particulier','VYV','Facturation Eloflex AB'];
const STATUTS = ['Auto','En attente confirmation','À préparer','En préparation','Expédié','Livré','Facturé','Problème','Annulé','Avoir'];
const DOCS = ['', 'Oui', 'Non', 'Partielle'];

const COLS = [
  { k:'groupe',          l:'Groupe',       w:96,  type:'liste', options:GROUPES, libre:true },
  { k:'edi',             l:'EDI',          w:44,  ro:true, aide:'X = prélèvement SEPA (fiche distributeur) · P = paiement d’avance (proforma)' },
  { k:'distributeur_nom',l:'Distributeur', w:230, type:'distrib' },
  { k:'adresse',         l:'Adresse',      w:250, ro:true, aide:'Adresse de la fiche distributeur — en rouge : livraison à une adresse inhabituelle (patient)' },
  { k:'client_tel',      l:'Téléphone',    w:118, ro:true, aide:'Fiche distributeur' },
  { k:'client_email',    l:'Email',        w:200, ro:true, aide:'Fiche distributeur' },
  { k:'modele',          l:'Modèle',       w:96,  bande:'vert' },
  { k:'accessoire',      l:'Accessoire',   w:190, bande:'vert' },
  { k:'bdc',             l:'Bdc',          w:100, bande:'bleu', mono:true },
  { k:'date_commande',   l:'Date',         w:90,  bande:'bleu', type:'date' },
  { k:'vf_order_id',     l:'Order',        w:76,  bande:'bleu' },
  { k:'client_final',    l:'Client',       w:120, bande:'peche' },
  { k:'num_suivi',       l:'N° Suivi',     w:165, bande:'peche', mono:true, aide:'En rouge : livraison en cours · en noir : livré' },
  { k:'date_livraison',  l:'Livraison',    w:90,  bande:'peche', type:'date' },
  { k:'num_serie',       l:'N° de série',  w:150, bande:'peche', mono:true },
  { k:'docs_fre',        l:'Docs FRE',     w:80,  bande:'peche', type:'liste', options:DOCS },
  { k:'num_facture',     l:'Facture',      w:92,  bande:'bleu2', aide:'En vert : payée · en rouge : impayée' },
  { k:'invoice_se',      l:'Invoice SE',   w:88,  bande:'jaune' },
  { k:'informations',    l:'Informations', w:320 },
  { k:'statut',          l:'Statut',       w:130, type:'statut', aide:'« Auto » = calculé par l’appli (bordereau, suivi, livraison, facture…)' },
];
const NB_FIGEES = 3;   // Groupe, EDI, Distributeur restent visibles en défilant à droite

let CT = { annee: new Date().getFullYear(), rows: [], vue: [], sel: { r: 0, c: 2 }, edit: null, filtres: {}, tri: null,
           q: '', depuis: null, timer: null, annees: [], undo: [], brouillon: {}, largeurs: {}, miens: {} };
try { CT.largeurs = JSON.parse(localStorage.getItem('ct_largeurs') || '{}') || {}; } catch (_) {}
try { const a = parseInt(localStorage.getItem('ct_annee')); if (a) CT.annee = a; } catch (_) {}

const _e = s => (typeof esc === 'function') ? esc(s) : String(s == null ? '' : s);
const _T = s => (typeof TR === 'function') ? TR(s) : s;
const largeur = c => CT.largeurs[c.k] || c.w;
const actif = () => STATE.view === 'commandes-tableur';

// ── Valeurs affichées ──────────────────────────────────────────────
function dateFr(v){ const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : (v || ''); }
function brut(r, c){
  switch (c.k) {
    case 'edi': return [r.client_edi ? 'X' : '', (r.proforma && !r.proforma_payee) ? 'P' : ''].join('');
    case 'adresse': return r.cf_adresse ? [r.cf_adresse, r.cf_ville].filter(Boolean).join(' - ') : (r.client_adresse || '');
    case 'client_tel': return r.client_tel || r.client_portable || '';
    case 'num_facture': return r.num_facture || r.num_facture_pennylane || '';
    case 'statut': return r.statut_calc || r.statut || '';
    case 'date_commande': case 'date_livraison': return dateFr(r[c.k]);
    default: return r[c.k] == null ? '' : String(r[c.k]);
  }
}
function styleCellule(r, c){
  const st = [];
  if (c.bande) st.push(`background:${BANDES[c.bande]}`);
  if (c.k === 'num_suivi' && r.num_suivi && !r.date_livraison) st.push('color:#d00000;font-weight:600');
  if (c.k === 'adresse' && r.cf_adresse) st.push('color:#d00000');
  if (c.k === 'num_facture') {
    const fp = String(r.facture_paiement_statut || '').toLowerCase();
    if (/^(paye|payé|paid)$/.test(fp)) st.push('color:#00a040;font-weight:600');
    else if (/^(impaye|impayé)$/.test(fp)) st.push('color:#d00000;font-weight:600');
  }
  if (c.k === 'edi' && r.proforma && !r.proforma_payee) st.push('color:#d00000;font-weight:700');
  if (c.mono) st.push('font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px');
  return st.join(';');
}
function htmlCellule(r, c){
  if (c.k === 'statut') {
    const s = r.statut_calc || '';
    const cls = (typeof cmdStatutClass === 'function') ? cmdStatutClass(s) : '';
    return `<span class="badge ${cls}" style="font-size:11px">${_e(s)}</span>${(r.statut && r.statut !== 'Auto') ? ' <i class="ti ti-hand-finger" title="' + _T('Statut forcé à la main') + '" style="font-size:11px;color:var(--text3)"></i>' : ''}`;
  }
  if (c.k === 'docs_fre') { const v = r.docs_fre || ''; return v === 'Oui' ? '✔ Oui' : v === 'Non' ? '✘ Non' : _e(v); }
  return _e(brut(r, c));
}

// ── Chargement ─────────────────────────────────────────────────────
async function renderCommandesTableur(ttl, c, a){
  ttl.textContent = _T('Test suivi commandes');
  a.innerHTML = `<span id="ct-maj" style="font-size:12px;color:var(--text3);margin-right:6px"></span>
    <button class="btn sm" onclick="ctLegende()"><i class="ti ti-palette"></i>${_T('Légende')}</button>
    <button class="btn sm success" onclick="API.exportExcel('commandes',{annee:${CT.annee}})"><i class="ti ti-file-spreadsheet"></i>Excel</button>
    <button class="btn sm" onclick="setView('commandes')" title="${_T('Revenir au Suivi commandes habituel')}"><i class="ti ti-list"></i>${_T('Vue classique')}</button>
    <button class="btn sm primary" onclick="ctNouvelleLigne()"><i class="ti ti-plus"></i>${_T('Nouvelle ligne')}</button>`;
  c.innerHTML = `<div class="empty" style="padding-top:40px"><i class="ti ti-loader-2"></i>${_T('Chargement…')}</div>`;
  try {
    const [d, an] = await Promise.all([
      API.get('/commandes-tableur?annee=' + CT.annee),
      API.get('/commandes-tableur/annees').catch(() => []),
    ]);
    CT.rows = d.rows || []; CT.depuis = d.maintenant; CT.annees = an || [];
    if (!CT.annees.some(x => x.annee === CT.annee)) CT.annees.unshift({ annee: CT.annee, n: CT.rows.length });
  } catch (e) { c.innerHTML = `<div class="empty"><i class="ti ti-alert-circle"></i>Erreur : ${_e(e.message)}</div>`; return; }
  if (!window._DISTRIB_CLIENTS) { try { window._DISTRIB_CLIENTS = await API.clients(); } catch (_) { window._DISTRIB_CLIENTS = []; } }

  c.innerHTML = `
    <style>
      #ct-wrap{position:relative;height:calc(100vh - 205px);min-height:320px;overflow:auto;border:1px solid var(--border);border-radius:10px;background:var(--surface,#fff)}
      #ct-tbl{border-collapse:separate;border-spacing:0;table-layout:fixed;font-size:13px}
      #ct-tbl th,#ct-tbl td{border-right:1px solid rgba(0,0,0,.09);border-bottom:1px solid rgba(0,0,0,.09);padding:0 6px;height:26px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:cell;user-select:none}
      #ct-tbl thead th{position:sticky;top:0;z-index:3;background:#f3f4f6;font-weight:700;font-size:12px;text-align:left;height:28px}
      #ct-tbl thead tr.ct-f th{top:28px;padding:2px 3px;background:#fafafa}
      #ct-tbl thead tr.ct-f input{width:100%;box-sizing:border-box;border:1px solid var(--border);border-radius:4px;padding:2px 5px;font-size:11.5px;background:#fff}
      #ct-wrap{background:#fff}
      #ct-tbl .ct-fig{position:sticky;z-index:2;background:#fff}
      #ct-tbl thead th.ct-fig{z-index:4;background:#f3f4f6}
      #ct-tbl thead tr.ct-f th.ct-fig{background:#fafafa}
      #ct-tbl tr.ct-new td.ct-fig{background:#f4f8f5} #ct-tbl tr.ct-brouillon td.ct-fig{background:#fff6d9}
      #ct-tbl tr td.ct-fig[data-c="2"]{box-shadow:2px 0 0 rgba(0,0,0,.12)}
      #ct-tbl td.ct-sel{outline:2px solid #217346;outline-offset:-2px}
      #ct-tbl tr.ct-ligne-sel td{box-shadow:inset 0 0 0 9999px rgba(33,115,70,.05)}
      #ct-tbl tr.ct-demo td:not(.ct-fig){background-image:linear-gradient(rgba(0,176,240,.18),rgba(0,176,240,.18))}
      #ct-tbl tr.ct-demo td.ct-fig{background:#d6f1fb}
      #ct-tbl tr.ct-annule td{color:var(--text3);text-decoration:line-through}
      #ct-tbl tr.ct-flash td{animation:ctflash 2.2s ease-out}
      @keyframes ctflash{0%{box-shadow:inset 0 0 0 9999px rgba(255,200,0,.55)}100%{box-shadow:inset 0 0 0 9999px rgba(255,200,0,0)}}
      #ct-tbl td.ct-ok{animation:ctok 1.2s ease-out}
      @keyframes ctok{0%{box-shadow:inset 0 0 0 9999px rgba(0,160,64,.35)}100%{box-shadow:inset 0 0 0 9999px rgba(0,160,64,0)}}
      #ct-tbl td.ct-err{box-shadow:inset 0 0 0 9999px rgba(220,0,0,.18)}
      #ct-tbl td.ct-ro{color:var(--text2)}
      #ct-tbl tr.ct-new td{background:rgba(33,115,70,.04);color:var(--text3);font-style:italic}
      #ct-tbl tr.ct-brouillon td{background:rgba(255,200,0,.12)}
      #ct-tbl td input.ct-ed,#ct-tbl td select.ct-ed{width:100%;height:24px;box-sizing:border-box;border:none;outline:none;font:inherit;padding:0 2px;background:#fff;color:#111}
      #ct-tbl .ct-res{position:absolute;right:0;top:0;bottom:0;width:6px;cursor:col-resize}
      #ct-tbl th .ct-h{display:flex;align-items:center;gap:3px;cursor:pointer}
      #ct-tabs{display:flex;gap:2px;margin-top:6px;flex-wrap:wrap;align-items:center}
      #ct-tabs button{border:1px solid var(--border);border-top:none;border-radius:0 0 6px 6px;background:#f3f4f6;padding:4px 14px;font-size:13px;cursor:pointer;color:var(--text2)}
      #ct-tabs button.on{background:#fff;color:#217346;font-weight:700;border-bottom:3px solid #217346}
      body.dark #ct-tbl thead th{background:#2a2f36} body.dark #ct-tbl thead tr.ct-f th{background:#23272d}
      body.dark #ct-tbl thead tr.ct-f input,body.dark #ct-tbl td input.ct-ed,body.dark #ct-tbl td select.ct-ed{background:#1d2126;color:#eee}
      body.dark #ct-wrap,body.dark #ct-tbl .ct-fig{background:#1d2126} body.dark #ct-tbl thead th.ct-fig{background:#2a2f36} body.dark #ct-tbl thead tr.ct-f th.ct-fig{background:#23272d}
      body.dark #ct-tbl tr.ct-new td.ct-fig{background:#1f2a24} body.dark #ct-tbl tr.ct-brouillon td.ct-fig{background:#3a321a}
      body.dark #ct-tbl tr.ct-demo td.ct-fig{background:#173847} body.dark #ct-tabs button{background:#2a2f36} body.dark #ct-tabs button.on{background:#1d2126}
    </style>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
      <div style="position:relative"><i class="ti ti-search" style="position:absolute;left:9px;top:9px;color:var(--text3)"></i>
        <input class="form-input" id="ct-q" placeholder="${_T('Rechercher dans toutes les colonnes…')}" value="${_e(CT.q)}" style="padding:7px 10px 7px 30px;width:300px" oninput="ctRecherche(this.value)"></div>
      <span id="ct-compte" style="font-size:13px;color:var(--text2)"></span>
      <span style="font-size:12px;color:var(--text3);margin-left:auto"><i class="ti ti-keyboard"></i> ${_T('Cliquez puis tapez · Entrée / Tab pour valider · Échap pour annuler · Ctrl+C / Ctrl+V · Ctrl+Z pour annuler la dernière saisie')}</span>
    </div>
    <div id="ct-wrap" tabindex="0"><table id="ct-tbl"></table></div>
    <div id="ct-tabs"></div>`;
  ctConstruire();
  ctOnglets();
  // Comme dans le fichier Excel : on arrive en bas, sur les dernières commandes
  const w = $('ct-wrap');
  if (w) { if (window._CT_SCROLL && window._CT_SCROLL.annee === CT.annee) { w.scrollTop = window._CT_SCROLL.top; w.scrollLeft = window._CT_SCROLL.left; } else w.scrollTop = w.scrollHeight; }
  w.addEventListener('scroll', () => { window._CT_SCROLL = { annee: CT.annee, top: w.scrollTop, left: w.scrollLeft }; });
  ctDemarrerRafraichissement();
}

function ctOnglets(){
  const t = $('ct-tabs'); if (!t) return;
  t.innerHTML = CT.annees.slice().sort((x, y) => y.annee - x.annee).map(a =>
    `<button class="${a.annee === CT.annee ? 'on' : ''}" onclick="ctAnnee(${a.annee})">${a.annee} <span style="opacity:.55;font-size:11px">(${a.n})</span></button>`).join('')
    + `<span style="font-size:12px;color:var(--text3);margin-left:10px">${_T('Onglets par année, comme dans le fichier Excel')}</span>`;
}
function ctAnnee(a){ CT.annee = a; CT.sel = { r: 0, c: 2 }; CT.brouillon = {}; window._CT_SCROLL = null; try { localStorage.setItem('ct_annee', a); } catch (_) {} render(); }

// ── Filtrage / tri ─────────────────────────────────────────────────
function ctCalculerVue(){
  const q = CT.q.trim().toLowerCase();
  let v = CT.rows.filter(r => {
    if (q && !COLS.some(c => brut(r, c).toLowerCase().includes(q))) return false;
    for (const k in CT.filtres) {
      const f = String(CT.filtres[k] || '').trim().toLowerCase(); if (!f) continue;
      const c = COLS.find(x => x.k === k); if (!c) continue;
      const val = brut(r, c).toLowerCase();
      if (f === '(vide)' ? val !== '' : !val.includes(f)) return false;
    }
    return true;
  });
  if (!CT.tri) {
    v = v.slice().sort((a, b) => { const x = String(a.date_commande || '9999'), y = String(b.date_commande || '9999'); return x < y ? -1 : x > y ? 1 : a.id - b.id; });
  } else {
    const c = COLS.find(x => x.k === CT.tri.k), s = CT.tri.sens;
    const cle = r => (c.type === 'date' ? String(r[c.k] || '') : brut(r, c).toLowerCase());
    v = v.slice().sort((a, b) => { const x = cle(a), y = cle(b); return (x < y ? -1 : x > y ? 1 : 0) * s; });
  }
  CT.vue = v;
}
let _tq = null;
function ctRecherche(v){ CT.q = v; clearTimeout(_tq); _tq = setTimeout(() => { ctCalculerVue(); ctCorps(); }, 180); }
function ctFiltre(k, v){ CT.filtres[k] = v; clearTimeout(_tq); _tq = setTimeout(() => { ctCalculerVue(); ctCorps(); }, 180); }
function ctTrier(k){
  if (!CT.tri || CT.tri.k !== k) CT.tri = { k, sens: 1 };
  else if (CT.tri.sens === 1) CT.tri.sens = -1; else CT.tri = null;
  ctCalculerVue(); ctConstruire();
}

// ── Rendu de la grille ─────────────────────────────────────────────
function _gauche(i){ let x = 34; for (let j = 0; j < i; j++) x += largeur(COLS[j]); return x; }
function ctConstruire(){
  const t = $('ct-tbl'); if (!t) return;
  ctCalculerVue();
  const totalW = 34 + COLS.reduce((s, c) => s + largeur(c), 0);
  t.style.width = totalW + 'px';
  const fig = i => i < NB_FIGEES ? ` ct-fig" style="left:${_gauche(i)}px;` : '" style="';
  t.innerHTML = `<colgroup><col style="width:34px">${COLS.map(c => `<col style="width:${largeur(c)}px">`).join('')}</colgroup>
    <thead>
      <tr><th class="ct-fig" style="left:0;text-align:center" title="${_T('Fiche complète')}">↗</th>${COLS.map((c, i) => `<th class="${fig(i)}position:sticky;${c.bande ? 'background:' + BANDES[c.bande].replace(/[\d.]+\)$/, '1)') : ''}" title="${_e(c.aide || '')}">
        <div class="ct-h" onclick="ctTrier('${c.k}')">${_e(c.l)}${c.ro ? ' <i class="ti ti-lock" style="font-size:10px;opacity:.45"></i>' : ''}${CT.tri && CT.tri.k === c.k ? (CT.tri.sens === 1 ? ' ▲' : ' ▼') : ''}</div>
        <span class="ct-res" onmousedown="ctRedim(event,'${c.k}')"></span></th>`).join('')}</tr>
      <tr class="ct-f"><th class="ct-fig" style="left:0"><i class="ti ti-filter" style="font-size:12px;color:var(--text3)"></i></th>${COLS.map((c, i) => `<th class="${fig(i)}"><input placeholder="${_T('filtre')}" value="${_e(CT.filtres[c.k] || '')}" oninput="ctFiltre('${c.k}',this.value)" title="${_T('Contient… (tapez « (vide) » pour les cases vides)')}"></th>`).join('')}</tr>
    </thead><tbody id="ct-body"></tbody>`;
  ctCorps();
}
function ligneHtml(r, idx){
  const cls = [(r.modele_demo || r.type_fauteuil_demo) ? 'ct-demo' : '', ['Annulé', 'Avoir'].includes(r.statut_calc) ? 'ct-annule' : ''].join(' ');
  return `<tr data-i="${idx}" data-id="${r.id}" class="${cls}"><td class="ct-fig" style="left:0;text-align:center;padding:0"><button class="btn sm" style="padding:1px 5px;font-size:11px" title="${_T('Ouvrir la fiche complète (Pennylane, expédition, notes…)')}${r.notes_count ? ' — ' + r.notes_count + ' note(s)' : ''}" onclick="ctFiche(${r.id})"><i class="ti ti-external-link"></i>${r.notes_count ? '<sup style="font-size:9px">' + r.notes_count + '</sup>' : ''}</button></td>${
    COLS.map((c, j) => `<td data-c="${j}" class="${j < NB_FIGEES ? 'ct-fig ' : ''}${c.ro ? 'ct-ro' : ''}" style="${j < NB_FIGEES ? 'left:' + _gauche(j) + 'px;' : ''}${styleCellule(r, c)}" title="${_e(brut(r, c))}">${htmlCellule(r, c)}</td>`).join('')}</tr>`;
}
function ctCorps(){
  const b = $('ct-body'); if (!b) return;
  const br = CT.brouillon || {};
  const aBrouillon = Object.keys(br).length > 0;
  const nouvelle = `<tr data-i="${CT.vue.length}" class="${aBrouillon ? 'ct-brouillon' : 'ct-new'}"><td class="ct-fig" style="left:0;text-align:center"><i class="ti ti-plus" style="font-size:12px"></i></td>${
    COLS.map((c, j) => `<td data-c="${j}" class="${j < NB_FIGEES ? 'ct-fig' : ''}" style="${j < NB_FIGEES ? 'left:' + _gauche(j) + 'px;' : ''}">${
      br[c.k] != null ? _e(c.type === 'date' ? dateFr(br[c.k]) : br[c.k]) : (j === 2 && !aBrouillon ? _T('Nouvelle commande : tapez ici…') : (j === 2 ? '<span style="color:#b45309">' + _T('← distributeur requis') + '</span>' : ''))}</td>`).join('')}</tr>`;
  b.innerHTML = CT.vue.map(ligneHtml).join('') + nouvelle;
  const n = CT.vue.length, tot = CT.rows.length;
  const ong = CT.annees.find(x => x.annee === CT.annee); if (ong && ong.n !== tot) { ong.n = tot; ctOnglets(); }
  const cpt = $('ct-compte'); if (cpt) cpt.textContent = n === tot ? `${tot} ${_T('commande(s)')}` : `${n} / ${tot} ${_T('commande(s) affichée(s)')}`;
  ctMontrerSel(false);
}
function cellule(r, c){ const tr = document.querySelector(`#ct-body tr[data-i="${r}"]`); return tr ? tr.querySelector(`td[data-c="${c}"]`) : null; }
function ctMontrerSel(defiler){
  document.querySelectorAll('#ct-body td.ct-sel').forEach(x => x.classList.remove('ct-sel'));
  document.querySelectorAll('#ct-body tr.ct-ligne-sel').forEach(x => x.classList.remove('ct-ligne-sel'));
  const td = cellule(CT.sel.r, CT.sel.c); if (!td) return;
  td.classList.add('ct-sel'); td.parentElement.classList.add('ct-ligne-sel');
  if (defiler !== false) {
    const w = $('ct-wrap'); const r = td.getBoundingClientRect(), wr = w.getBoundingClientRect();
    const gaucheFig = _gauche(NB_FIGEES);
    if (r.top < wr.top + 58) w.scrollTop -= (wr.top + 58 - r.top);
    else if (r.bottom > wr.bottom - 4) w.scrollTop += (r.bottom - wr.bottom + 4);
    if (CT.sel.c >= NB_FIGEES) {
      if (r.left < wr.left + gaucheFig) w.scrollLeft -= (wr.left + gaucheFig - r.left);
      else if (r.right > wr.right - 4) w.scrollLeft += (r.right - wr.right + 4);
    }
  }
}
function majLigne(r){
  const i = CT.vue.findIndex(x => x.id === r.id); const j = CT.rows.findIndex(x => x.id === r.id);
  if (j >= 0) CT.rows[j] = r; else CT.rows.push(r);
  if (i >= 0) { CT.vue[i] = r; const tr = document.querySelector(`#ct-body tr[data-i="${i}"]`); if (tr) { tr.outerHTML = ligneHtml(r, i); } }
  return i;
}

// ── Sélection / clavier ────────────────────────────────────────────
document.addEventListener('mousedown', ev => {
  if (!actif()) return;
  const td = ev.target.closest && ev.target.closest('#ct-body td[data-c]');
  if (!td) return;
  if (CT.edit && CT.edit.td === td) return;
  if (CT.edit) ctValider(false);
  CT.sel = { r: parseInt(td.parentElement.dataset.i), c: parseInt(td.dataset.c) };
  ctMontrerSel(false);
  const w = $('ct-wrap'); if (w && document.activeElement !== w) w.focus({ preventScroll: true });
});
document.addEventListener('dblclick', ev => {
  if (!actif()) return;
  const td = ev.target.closest && ev.target.closest('#ct-body td[data-c]');
  if (td) ctEditer(null);
});
document.addEventListener('keydown', ev => {
  if (!actif()) return;
  const ma = $('modal-area'); if (ma && ma.innerHTML.trim()) return;
  if (CT.edit) return ctToucheEdition(ev);
  const w = $('ct-wrap'); if (document.activeElement !== w) return;   // filtres, recherche… : comportement normal
  const max = CT.vue.length, k = ev.key;
  const bouge = (dr, dc) => { CT.sel.r = Math.max(0, Math.min(max, CT.sel.r + dr)); CT.sel.c = Math.max(0, Math.min(COLS.length - 1, CT.sel.c + dc)); ctMontrerSel(); ev.preventDefault(); };
  if (k === 'ArrowDown') return bouge(1, 0);
  if (k === 'ArrowUp') return bouge(-1, 0);
  if (k === 'ArrowLeft') return bouge(0, -1);
  if (k === 'ArrowRight') return bouge(0, 1);
  if (k === 'Tab') return bouge(0, ev.shiftKey ? -1 : 1);
  if (k === 'PageDown') return bouge(20, 0);
  if (k === 'PageUp') return bouge(-20, 0);
  if (k === 'Home' && (ev.ctrlKey || ev.metaKey)) { CT.sel = { r: 0, c: 2 }; ctMontrerSel(); return ev.preventDefault(); }
  if (k === 'End' && (ev.ctrlKey || ev.metaKey)) { CT.sel = { r: max, c: 2 }; ctMontrerSel(); return ev.preventDefault(); }
  if (k === 'Enter' || k === 'F2') { ev.preventDefault(); return ctEditer(null); }
  if ((k === 'Delete' || k === 'Backspace')) { ev.preventDefault(); return ctEnregistrer(CT.sel.r, CT.sel.c, ''); }
  if ((ev.ctrlKey || ev.metaKey) && k.toLowerCase() === 'z') { ev.preventDefault(); return ctAnnuler(); }
  if ((ev.ctrlKey || ev.metaKey) && k.toLowerCase() === 'c') { ev.preventDefault(); return ctCopier(); }
  if ((ev.ctrlKey || ev.metaKey) && k.toLowerCase() === 'v') return;   // géré par l'événement « paste »
  if (k.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) { ev.preventDefault(); return ctEditer(k); }
});

// ── Édition d'une case ─────────────────────────────────────────────
function ctEditer(premiereTouche){
  const c = COLS[CT.sel.c], td = cellule(CT.sel.r, CT.sel.c); if (!td) return;
  const r = CT.vue[CT.sel.r];   // undefined = ligne « nouvelle commande »
  if (c.ro) {
    if (r && r.client_id && ['adresse', 'client_tel', 'client_email', 'edi'].includes(c.k))
      toast(_T('Information de la fiche distributeur : double-cliquez sur ↗ ou modifiez la fiche client.'), 'ti-lock');
    return;
  }
  let val = r ? (c.type === 'date' ? dateFr(r[c.k]) : (c.k === 'statut' ? (r.statut || 'Auto') : (c.k === 'num_facture' ? (r.num_facture || '') : (r[c.k] == null ? '' : String(r[c.k]))))) : ((CT.brouillon || {})[c.k] != null ? (c.type === 'date' ? dateFr(CT.brouillon[c.k]) : CT.brouillon[c.k]) : '');
  let el;
  if (c.type === 'statut' || (c.type === 'liste' && !c.libre)) {
    el = document.createElement('select'); el.className = 'ct-ed';
    const opts = c.type === 'statut' ? STATUTS : c.options;
    el.innerHTML = opts.map(o => `<option value="${_e(o)}" ${o === val ? 'selected' : ''}>${o === 'Auto' ? _T('Auto (calculé)') : (o || '—')}</option>`).join('');
  } else {
    el = document.createElement('input'); el.className = 'ct-ed'; el.type = 'text';
    el.value = premiereTouche != null ? premiereTouche : val;
    if (c.type === 'distrib' || c.type === 'liste') {
      const id = 'ct-dl-' + c.k; let dl = document.getElementById(id);
      if (!dl) { dl = document.createElement('datalist'); dl.id = id; document.body.appendChild(dl); }
      dl.innerHTML = (c.type === 'distrib' ? (window._DISTRIB_CLIENTS || []).map(x => x.nom) : c.options).filter(Boolean).map(n => `<option value="${_e(n)}">`).join('');
      el.setAttribute('list', id);
    }
    if (c.type === 'date') el.placeholder = 'jj/mm/aaaa';
  }
  CT.edit = { td, r, c, avant: val, el, ligne: CT.sel.r, col: CT.sel.c };
  td.dataset.html = td.innerHTML; td.innerHTML = ''; td.appendChild(el);
  el.focus();
  if (el.tagName === 'INPUT') { if (premiereTouche == null) el.select(); else el.setSelectionRange(el.value.length, el.value.length); }
  el.addEventListener('blur', () => { setTimeout(() => { if (CT.edit && CT.edit.el === el) ctValider(false); }, 120); });
  if (el.tagName === 'SELECT') el.addEventListener('change', () => { if (CT.edit && CT.edit.el === el) { ctValider(false); ctBouge(1, 0); } });
}
function ctToucheEdition(ev){
  const k = ev.key;
  if (k === 'Escape') { ev.preventDefault(); return ctValider(true); }
  if (k === 'Enter') { ev.preventDefault(); ctValider(false); return ctBouge(1, 0); }
  if (k === 'Tab') { ev.preventDefault(); ctValider(false); return ctBouge(0, ev.shiftKey ? -1 : 1); }
}
function ctBouge(dr, dc){
  CT.sel.r = Math.max(0, Math.min(CT.vue.length, CT.sel.r + dr)); CT.sel.c = Math.max(0, Math.min(COLS.length - 1, CT.sel.c + dc));
  ctMontrerSel(); const w = $('ct-wrap'); if (w) w.focus({ preventScroll: true });
}
function ctValider(annuler){
  const e = CT.edit; if (!e) return; CT.edit = null;
  const v = e.el.value;
  e.td.innerHTML = e.td.dataset.html || '';
  const w = $('ct-wrap'); if (w && actif()) w.focus({ preventScroll: true });
  if (annuler || v === e.avant) return;
  ctEnregistrer(e.ligne, e.col, v);
}

// ── Conversion des saisies ─────────────────────────────────────────
function lireDate(s){
  s = String(s || '').trim(); if (!s) return '';
  if (/^(\.|aujourd'?hui|auj|today)$/i.test(s)) return new Date().toISOString().slice(0, 10);
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](\d{2,4}))?$/);
  if (m) { let y = m[3] ? parseInt(m[3]) : CT.annee; if (y < 100) y += 2000; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  const n = parseFloat(s); if (/^\d{5}$/.test(s) && n > 30000) { const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000); return d.toISOString().slice(0, 10); }  // n° de série de date Excel
  return null;
}
function convertir(c, v){
  v = String(v == null ? '' : v).replace(/\r/g, '').trim();
  if (c.type === 'date') { const d = lireDate(v); if (d === null) throw new Error(_T('Date non reconnue : ') + v + ' (jj/mm/aaaa)'); return d; }
  if (c.k === 'docs_fre') { if (/^(vrai|true|oui|x|1|ok)$/i.test(v)) return 'Oui'; if (/^(faux|false|non|0)$/i.test(v)) return 'Non'; if (/^part/i.test(v)) return 'Partielle'; return v ? v : ''; }
  if (c.k === 'statut') { const s = STATUTS.find(x => x.toLowerCase() === v.toLowerCase()); return s || 'Auto'; }
  if (c.k === 'groupe') { const g = GROUPES.find(x => x.toLowerCase() === v.toLowerCase()); return g || v; }
  return v;
}

// ── Enregistrement ─────────────────────────────────────────────────
async function ctEnregistrer(iLigne, iCol, saisie, opts){
  opts = opts || {};
  const c = COLS[iCol]; if (!c || c.ro) return;
  const r = CT.vue[iLigne];
  let val; try { val = convertir(c, saisie); } catch (e) { toast(e.message, 'ti-alert-circle', 'var(--danger)'); return; }
  if (!r) return ctBrouillon(c, val, opts);
  const corps = {};
  if (c.k === 'distributeur_nom') {
    if (!val) { toast(_T('Le distributeur ne peut pas être vide.'), 'ti-alert-circle', 'var(--warning)'); return; }
    const cl = (window._DISTRIB_CLIENTS || []).find(x => (x.nom || '').trim().toLowerCase() === val.toLowerCase());
    if (cl) { corps.distributeur_nom = cl.nom; corps.client_id = cl.id; }
    else {
      if (!opts.silencieux && !confirm(_T('« ') + val + _T(' » ne correspond à aucune fiche distributeur.') + '\n' + _T('Enregistrer quand même (la commande ne sera plus rattachée à une fiche) ?'))) return;
      corps.distributeur_nom = val; corps.client_id = '';
    }
  } else corps[c.k] = val;
  const avant = c.k === 'distributeur_nom' ? { distributeur_nom: r.distributeur_nom, client_id: r.client_id || '' } : { [c.k]: r[c.k] == null ? '' : r[c.k] };
  const td = cellule(iLigne, iCol);
  try {
    await API.updateCommande(r.id, corps);
    CT.miens[r.id] = Date.now();
    if (!opts.sansUndo) { CT.undo.push({ id: r.id, avant, k: c.k }); if (CT.undo.length > 50) CT.undo.shift(); }
    const frais = await API.get(`/commandes-tableur/ligne/${r.id}`);
    const i = majLigne(frais);
    const td2 = cellule(i, iCol); if (td2) { td2.classList.add('ct-ok'); setTimeout(() => td2.classList.remove('ct-ok'), 1300); }
    ctMontrerSel(false);
  } catch (e) {
    if (td) td.classList.add('ct-err');
    toast(_T('Non enregistré : ') + e.message, 'ti-alert-circle', 'var(--danger)');
  }
}
async function ctAnnuler(){
  const u = CT.undo.pop(); if (!u) { toast(_T('Rien à annuler'), 'ti-arrow-back-up'); return; }
  try {
    await API.updateCommande(u.id, u.avant); CT.miens[u.id] = Date.now();
    const frais = await API.get(`/commandes-tableur/ligne/${u.id}`);
    majLigne(frais); ctMontrerSel(false);
    toast(_T('Saisie annulée'), 'ti-arrow-back-up');
  } catch (e) { toast(_T('Annulation impossible : ') + e.message, 'ti-alert-circle', 'var(--danger)'); }
}

// Nouvelle ligne : les cases se remplissent en brouillon ; la commande est créée dès que le distributeur est connu.
async function ctBrouillon(c, val, opts){
  CT.brouillon = CT.brouillon || {};
  if (c.k === 'statut' && val === 'Auto') val = '';
  if (val === '') delete CT.brouillon[c.k]; else CT.brouillon[c.k] = val;
  if (!CT.brouillon.distributeur_nom) { ctCorps(); return; }
  const r = await ctCreer(CT.brouillon, opts);
  if (r) { CT.brouillon = {}; ctCorps(); ctMontrerSel(); }
  else ctCorps();
}
async function ctCreer(d, opts){
  opts = opts || {};
  const nom = String(d.distributeur_nom || '').trim();
  const cl = (window._DISTRIB_CLIENTS || []).find(x => (x.nom || '').trim().toLowerCase() === nom.toLowerCase());
  if (!cl && !opts.silencieux && !confirm(_T('« ') + nom + _T(' » ne correspond à aucune fiche distributeur.') + '\n' + _T('Une nouvelle fiche distributeur sera créée (sav@eloflex.fr est prévenu). Continuer ?'))) return null;
  const body = { ...d, distributeur_nom: cl ? cl.nom : nom, client_id: cl ? cl.id : undefined, annee_onglet: CT.annee };
  if (!body.date_commande) body.date_commande = new Date().toISOString().slice(0, 10);
  const docs = body.docs_fre; delete body.docs_fre;
  if (body.statut === '') delete body.statut;
  try {
    const cree = await API.createCommande(body);
    const id = cree.id || (cree.commande && cree.commande.id);
    CT.miens[id] = Date.now();
    if (docs && id) await API.updateCommande(id, { docs_fre: docs });
    if (!cl) { try { window._DISTRIB_CLIENTS = await API.clients(); } catch (_) {} }
    const frais = await API.get(`/commandes-tableur/ligne/${id}`);
    CT.rows.push(frais); ctCalculerVue();
    const i = CT.vue.findIndex(x => x.id === id);
    if (!opts.silencieux) { CT.sel.r = i >= 0 ? i : CT.vue.length; toast(_T('Commande créée'), 'ti-check', 'var(--success)'); }
    return frais;
  } catch (e) { toast(_T('Création impossible : ') + e.message, 'ti-alert-circle', 'var(--danger)'); return null; }
}
function ctNouvelleLigne(){
  CT.sel = { r: CT.vue.length, c: 2 }; ctMontrerSel();
  const w = $('ct-wrap'); if (w) { w.scrollTop = w.scrollHeight; w.focus({ preventScroll: true }); }
  setTimeout(() => ctEditer(null), 60);
}

// ── Copier / coller (compatible Excel) ─────────────────────────────
function ctCopier(){
  const r = CT.vue[CT.sel.r], c = COLS[CT.sel.c]; const v = r ? brut(r, c) : '';
  try { navigator.clipboard.writeText(v); toast(_T('Copié'), 'ti-copy'); } catch (_) {}
}
document.addEventListener('paste', async ev => {
  if (!actif() || CT.edit) return;
  if (document.activeElement !== $('ct-wrap')) return;
  const txt = (ev.clipboardData || window.clipboardData).getData('text'); if (!txt) return;
  ev.preventDefault();
  const lignes = txt.replace(/\r/g, '').replace(/\n$/, '').split('\n').map(l => l.split('\t')).filter(l => l.some(x => String(x).trim()));
  const nbCases = lignes.reduce((s, l) => s + l.length, 0);
  if (nbCases === 1) return ctEnregistrer(CT.sel.r, CT.sel.c, lignes[0][0]);
  const debutR = CT.sel.r, debutC = CT.sel.c;
  const existantes = lignes.filter((_, i) => CT.vue[debutR + i]).length, nouvelles = lignes.length - existantes;
  if (!confirm(_T('Coller ') + lignes.length + _T(' ligne(s) × ') + Math.max(...lignes.map(l => l.length)) + _T(' colonne(s) ?') + '\n'
    + (existantes ? '• ' + existantes + _T(' ligne(s) existante(s) modifiée(s)') + '\n' : '') + (nouvelles ? '• ' + nouvelles + _T(' nouvelle(s) commande(s) créée(s)') + '\n' : '')
    + _T('Les colonnes verrouillées (EDI, adresse, téléphone, e-mail) sont ignorées.'))) return;
  toast(_T('Collage en cours…'), 'ti-loader-2');
  let ok = 0, ko = 0;
  for (let i = 0; i < lignes.length; i++) {
    const r = CT.vue[debutR + i];
    if (r) {
      for (let j = 0; j < lignes[i].length; j++) {
        const ci = debutC + j, c = COLS[ci]; if (!c || c.ro) continue;
        const v = lignes[i][j]; const avant = brut(r, c);
        if (String(v).trim() === avant) continue;
        try { await ctEnregistrer(debutR + i, ci, v, { silencieux: true }); ok++; } catch (_) { ko++; }
      }
    } else {
      const d = {};
      for (let j = 0; j < lignes[i].length; j++) {
        const c = COLS[debutC + j]; if (!c) continue;
        // Téléphone / e-mail collés : servent à créer la fiche distributeur si elle n'existe pas encore
        if (c.k === 'client_tel' && lignes[i][j].trim()) { d.tel = lignes[i][j].trim(); continue; }
        if (c.k === 'client_email' && lignes[i][j].trim()) { d.email = lignes[i][j].trim().split(/[,;\s]+/)[0]; continue; }
        if (c.ro) continue;
        try { const v = convertir(c, lignes[i][j]); if (v !== '' && !(c.k === 'statut' && v === 'Auto')) d[c.k] = v; } catch (_) {}
      }
      if (!d.distributeur_nom) { ko++; continue; }
      (await ctCreer(d, { silencieux: true })) ? ok++ : ko++;
    }
  }
  ctCalculerVue(); ctCorps();
  toast(`${_T('Collage terminé')} : ${ok} ${_T('enregistrement(s)')}${ko ? ', ' + ko + ' ' + _T('ignoré(s)') : ''}`, ko ? 'ti-alert-triangle' : 'ti-check', ko ? 'var(--warning)' : 'var(--success)');
});

// ── Fiche complète, redimensionnement, légende ─────────────────────
function ctFiche(id){ const w = $('ct-wrap'); if (w) window._CT_SCROLL = { annee: CT.annee, top: w.scrollTop, left: w.scrollLeft }; modalCommande(id); }
function ctRedim(ev, k){
  ev.preventDefault(); ev.stopPropagation();
  const c = COLS.find(x => x.k === k), x0 = ev.clientX, w0 = largeur(c);
  const mv = e => { CT.largeurs[k] = Math.max(36, w0 + e.clientX - x0); const t = $('ct-tbl'); const col = t && t.querySelectorAll('col')[COLS.indexOf(c) + 1]; if (col) col.style.width = CT.largeurs[k] + 'px'; };
  const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); try { localStorage.setItem('ct_largeurs', JSON.stringify(CT.largeurs)); } catch (_) {} ctConstruire(); };
  document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
}
function ctLegende(){
  const l = (st, t) => `<tr><td style="padding:6px 10px;border:1px solid var(--border);${st}">Exemple</td><td style="padding:6px 10px;border:1px solid var(--border)">${t}</td></tr>`;
  showModal(`<div class="modal-header"><i class="ti ti-palette" style="color:var(--accent)"></i><h2>${_T('Légende — comme dans le fichier Excel')}</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body"><table style="border-collapse:collapse;font-size:13.5px;width:100%">
      ${l('background:#d6f1fb', 'Ligne en bleu = essai / fauteuil de démonstration')}
      ${l('color:#d00000;font-weight:600', 'N° de suivi en rouge = livraison en cours (pas encore arrivée) · en noir = livré')}
      ${l('color:#d00000', 'Adresse en rouge = livraison à une adresse inhabituelle (patient)')}
      ${l('color:#00a040;font-weight:600', 'Facture en vert = payée · en rouge = impayée')}
      ${l('font-weight:700', 'EDI : X = prélèvement SEPA · P (rouge) = paiement d’avance (proforma non réglée)')}
      ${l('text-decoration:line-through;color:#999', 'Ligne barrée = commande annulée ou avoir')}
      ${l('background:rgba(255,200,0,.25)', 'Ligne jaune clignotante = modifiée à l’instant par un collègue')}
    </table>
    <p style="font-size:13px;color:var(--text2);margin-top:12px">${_T('Colonnes avec un cadenas : informations de la fiche distributeur (à modifier dans la fiche). Le statut « Auto » est calculé par l’appli. Toutes les autres options (Pennylane, VosFactures, bordereau, expédition, notes, démo…) sont dans la fiche complète : bouton')} <i class="ti ti-external-link"></i>.</p></div>`);
}

// ── Rafraîchissement automatique (modifications des collègues) ─────
function ctDemarrerRafraichissement(){
  clearInterval(CT.timer);
  CT.timer = setInterval(async () => {
    if (!actif()) { clearInterval(CT.timer); return; }
    if (document.hidden || CT.edit || !CT.depuis) return;
    try {
      const d = await API.get('/commandes-tableur?annee=' + CT.annee + '&depuis=' + encodeURIComponent(CT.depuis));
      CT.depuis = d.maintenant;
      const m = $('ct-maj'); if (m) m.textContent = _T('À jour') + ' · ' + new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      if (!d.rows || !d.rows.length) return;
      const ids = [];
      d.rows.forEach(r => { const j = CT.rows.findIndex(x => x.id === r.id); if (j >= 0) CT.rows[j] = r; else CT.rows.push(r); ids.push(r.id); });
      ctCalculerVue(); ctCorps();
      // Surligne uniquement les lignes modifiées par quelqu'un d'autre (pas mes propres saisies récentes)
      ids.filter(id => !(CT.miens[id] && Date.now() - CT.miens[id] < 45000)).forEach(id => { const tr = document.querySelector(`#ct-body tr[data-id="${id}"]`); if (tr) tr.classList.add('ct-flash'); });
    } catch (_) {}
  }, 30000);
}

Object.assign(window, { renderCommandesTableur, ctAnnee, ctRecherche, ctFiltre, ctTrier, ctNouvelleLigne, ctFiche, ctRedim, ctLegende });
})();
