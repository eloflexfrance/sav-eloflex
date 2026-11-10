// public/js/stock-transferts.js
// ─────────────────────────────────────────────────────────────────────────────
// Transferts de stock Lagord → Paris (page Inventaire) : création du bon de transfert,
// impression, réception à Paris (quantités reçues), suppression d'un envoi non reçu.
// Le stock Paris de l'appli est mis à jour ; VosFactures n'est pas concerné (entrepôt unique).
// ─────────────────────────────────────────────────────────────────────────────
(function(){
'use strict';

const T = window._TRS = window._TRS || { vue: 'liste', panier: [], q: '', pieces: null, adresses: null, detail: null };
const $ = id => document.getElementById(id);
const e_ = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const _T = s => (typeof TR === 'function') ? TR(s) : s;
const dateFr = d => d ? String(d).slice(0, 10).split('-').reverse().join('/') : '';
const peutEcrire = () => (typeof isAdmin === 'function' && isAdmin()) || (typeof canWrite === 'function' && canWrite('catalogue'));
const TRANSPORTEURS = ['', 'DSV', 'UPS', 'La Poste', 'Chronopost', 'Messagerie', 'Remis en main propre'];
const _toast = (m, ic, c) => (typeof toast === 'function') ? toast(m, ic, c) : alert(m);

function quitter(){ window._INV.transferts = false; T.vue = 'liste'; render(); }

async function renderTransfertsStock(ttl, c, a){
  ttl.textContent = _T('Transferts Lagord → Paris');
  if (T.vue === 'nouveau') return renderNouveau(ttl, c, a);
  if (T.vue === 'reception') return renderReception(ttl, c, a);
  a.innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
    <button class="btn" onclick="trsQuitter()"><i class="ti ti-arrow-left"></i>${_T('Inventaires')}</button>
    ${peutEcrire() ? `<button class="btn primary" onclick="trsNouveau()"><i class="ti ti-plus"></i>${_T('Nouveau transfert')}</button>` : ''}</div>`;
  const d = await API.get('/inventaires-transferts');
  T.adresses = d.adresses;
  const badge = t => t.statut === 'recu'
    ? (t.nb_ecarts ? `<span class="badge attente">${_T('Reçu avec écarts')} (${t.nb_ecarts})</span>` : `<span class="badge g">${_T('Reçu')}</span>`)
    : `<span class="badge ouvert">${_T('Envoyé — à réceptionner')}</span>`;
  c.innerHTML = `
    <div style="font-size:13.5px;color:var(--text2);margin-bottom:14px;max-width:900px">${_T('Un transfert envoie des pièces de Lagord à Paris : à l’enregistrement, les quantités passent du stock Lagord au stock Paris de l’appli et le bon de transfert s’imprime (2 exemplaires : un dans le colis, un gardé à Lagord). À l’arrivée, Paris saisit les quantités reçues. VosFactures n’est pas modifié (le stock y est global).')}</div>
    ${d.transferts.length ? `<div class="table-wrap"><table class="t"><thead><tr>
      <th>${_T('N°')}</th><th>${_T('Envoi')}</th><th>${_T('Transport')}</th><th style="text-align:right">${_T('Réf.')}</th><th style="text-align:right">${_T('Pièces')}</th><th>${_T('Statut')}</th><th></th></tr></thead>
      <tbody>${d.transferts.map(t => `<tr>
        <td class="mono" style="font-weight:700">${e_(t.numero)}</td>
        <td>${dateFr(t.date_envoi)}<div style="font-size:11.5px;color:var(--text3)">${e_(t.cree_par || '')}</div></td>
        <td>${e_(t.transporteur || '—')}${t.num_suivi ? ` · ${(typeof lienSuiviColis === 'function' && lienSuiviColis(t.transporteur, t.num_suivi)) ? `<a href="${e_(lienSuiviColis(t.transporteur, t.num_suivi))}" target="_blank" rel="noopener">${e_(t.num_suivi)}</a>` : e_(t.num_suivi)}` : ''}${t.nb_colis ? `<div style="font-size:11.5px;color:var(--text3)">${t.nb_colis} ${_T('colis')}</div>` : ''}</td>
        <td style="text-align:right">${t.nb_refs}</td><td style="text-align:right;font-weight:600">${t.nb_pieces}</td>
        <td>${badge(t)}${t.recu_le ? `<div style="font-size:11.5px;color:var(--text3)">${_T('le')} ${dateFr(t.recu_le)}${t.recu_par ? ' · ' + e_(t.recu_par) : ''}</div>` : ''}</td>
        <td style="white-space:nowrap;text-align:right">
          <button class="btn sm" title="${_T('Imprimer le bon de transfert')}" onclick="trsImprimer(${t.id})"><i class="ti ti-printer"></i>${_T('Bon')}</button>
          ${peutEcrire() && t.statut !== 'recu' ? `<button class="btn sm success" onclick="trsReception(${t.id})"><i class="ti ti-package-import"></i>${_T('Réception')}</button>
            <button class="btn sm danger" title="${_T('Supprimer (les quantités reviennent à Lagord)')}" onclick="trsSupprimer(${t.id},'${e_(t.numero)}')"><i class="ti ti-trash"></i></button>` : ''}
          ${t.statut === 'recu' ? `<button class="btn sm" title="${_T('Voir la réception')}" onclick="trsReception(${t.id})"><i class="ti ti-eye"></i></button>` : ''}
        </td></tr>`).join('')}</tbody></table></div>`
      : `<div class="empty" style="padding:24px"><i class="ti ti-truck"></i>${_T('Aucun transfert pour l’instant.')}</div>`}`;
}

// ── Nouveau transfert ─────────────────────────────────────────────
async function trsNouveau(){
  T.vue = 'nouveau'; T.panier = []; T.q = ''; T.pieces = null;
  T.entete = { date_envoi: new Date().toISOString().slice(0, 10), transporteur: '', num_suivi: '', nb_colis: '', notes: '' };
  render();
}
async function renderNouveau(ttl, c, a){
  ttl.textContent = _T('Nouveau transfert Lagord → Paris');
  a.innerHTML = `<button class="btn" onclick="trsAnnuler()"><i class="ti ti-x"></i>${_T('Annuler')}</button>`;
  if (!T.adresses) { try { T.adresses = (await API.get('/inventaires-transferts')).adresses; } catch (_) { T.adresses = {}; } }
  if (!T.pieces) T.pieces = await API.get('/inventaires-transferts-pieces');
  const h = T.entete, ad = T.adresses || {};
  const champ = (k, lbl, type) => `<div class="form-group"><label class="form-label">${lbl}</label><input class="form-input" type="${type || 'text'}" value="${e_(h[k] || '')}" oninput="trsEntete('${k}',this.value)"></div>`;
  c.innerHTML = `
    <div class="card" style="padding:14px 16px;margin-bottom:14px">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px 14px">
        ${champ('date_envoi', _T('Date d’envoi'), 'date')}
        <div class="form-group"><label class="form-label">${_T('Transporteur')}</label><select class="form-input" onchange="trsEntete('transporteur',this.value)">${TRANSPORTEURS.map(x => `<option value="${e_(x)}" ${x === h.transporteur ? 'selected' : ''}>${e_(x || '—')}</option>`).join('')}</select></div>
        ${champ('num_suivi', _T('N° de suivi'))}
        ${champ('nb_colis', _T('Nombre de colis'), 'number')}
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px 14px;margin-top:6px">
        <div class="form-group"><label class="form-label">${_T('Expéditeur (Lagord)')}</label><textarea class="form-input" id="trs-adr-o" rows="3">${e_(ad.lagord || '')}</textarea></div>
        <div class="form-group"><label class="form-label">${_T('Destinataire (Paris)')}</label><textarea class="form-input" id="trs-adr-d" rows="3" placeholder="${_T('Adresse du showroom de Paris')}">${e_(ad.paris || '')}</textarea></div>
        <div class="form-group"><label class="form-label">${_T('Réceptionné par (contact Paris)')}</label><input class="form-input" id="trs-contact" value="${e_(ad.contact_paris || '')}">
          <label class="form-label" style="margin-top:8px">${_T('Notes')}</label><input class="form-input" value="${e_(h.notes || '')}" oninput="trsEntete('notes',this.value)"></div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.15fr);gap:14px;align-items:start">
      <div class="card" style="padding:12px 14px">
        <div class="section-title" style="margin-bottom:8px"><i class="ti ti-search"></i>${_T('Pièces en stock à Lagord')}</div>
        <input class="form-input" id="trs-q" placeholder="${_T('Rechercher (réf., désignation)…')}" value="${e_(T.q)}" oninput="trsChercher(this.value)" style="margin-bottom:8px">
        <div id="trs-res" style="max-height:56vh;overflow:auto"></div>
      </div>
      <div class="card" style="padding:12px 14px">
        <div class="section-title" style="margin-bottom:8px"><i class="ti ti-truck"></i>${_T('Pièces à envoyer')} <span id="trs-tot" style="margin-left:auto;font-size:12.5px;font-weight:500;color:var(--text2)"></span></div>
        <div id="trs-panier"></div>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px">
          <button class="btn primary" id="trs-ok" onclick="trsEnregistrer()"><i class="ti ti-printer"></i>${_T('Enregistrer et imprimer le bon')}</button></div>
      </div>
    </div>`;
  dessinerResultats(); dessinerPanier();
  setTimeout(() => { const q = $('trs-q'); if (q) q.focus(); }, 50);
}
function trsEntete(k, v){ T.entete[k] = v; }
function trsChercher(v){ T.q = v; dessinerResultats(); }
function dessinerResultats(){
  const el = $('trs-res'); if (!el) return;
  const q = T.q.toLowerCase().trim();
  const dans = new Set(T.panier.map(l => l.id));
  let l = (T.pieces || []).filter(p => p.lagord > 0);
  if (q) l = l.filter(p => (p.ref + ' ' + p.designation).toLowerCase().includes(q));
  const n = l.length; l = l.slice(0, 150);
  el.innerHTML = l.length ? `<table class="t" style="font-size:13px"><thead><tr><th>${_T('Réf.')}</th><th>${_T('Désignation')}</th><th style="text-align:right" title="Lagord">L</th><th style="text-align:right" title="Paris">P</th><th></th></tr></thead><tbody>
    ${l.map(p => `<tr style="cursor:pointer" onclick="trsAjouter(${p.id})"><td class="mono">${e_(p.ref)}</td><td>${e_(p.designation)}</td>
      <td style="text-align:right;font-weight:600">${p.lagord}</td><td style="text-align:right;color:var(--text3)">${p.paris}</td>
      <td style="text-align:right">${dans.has(p.id) ? '<i class="ti ti-check" style="color:var(--success)"></i>' : '<i class="ti ti-plus" style="color:var(--accent)"></i>'}</td></tr>`).join('')}</tbody></table>
    ${n > l.length ? `<div style="font-size:12px;color:var(--text3);padding:6px">${n - l.length} ${_T('autre(s) — affinez la recherche')}</div>` : ''}`
    : `<div style="color:var(--text3);font-size:13px;padding:8px">${_T('Aucune pièce trouvée avec du stock à Lagord.')}</div>`;
}
function trsAjouter(id){
  const p = (T.pieces || []).find(x => x.id === id); if (!p) return;
  const ex = T.panier.find(l => l.id === id);
  if (ex) { if (ex.qte < p.lagord) ex.qte++; }
  else T.panier.push({ id, ref: p.ref, designation: p.designation, max: p.lagord, qte: 1, colis: '' });
  dessinerPanier(); dessinerResultats();
}
function trsQte(id, v){ const l = T.panier.find(x => x.id === id); if (!l) return; l.qte = Math.max(0, parseInt(v) || 0); majTotaux(); const i = $('trs-q-' + id); if (i) i.style.borderColor = l.qte > l.max ? 'var(--danger)' : ''; }
function trsColis(id, v){ const l = T.panier.find(x => x.id === id); if (l) l.colis = v; }
function trsRetirer(id){ T.panier = T.panier.filter(l => l.id !== id); dessinerPanier(); dessinerResultats(); }
function majTotaux(){ const el = $('trs-tot'); if (el) el.textContent = `${T.panier.length} ${_T('réf.')} · ${T.panier.reduce((s, l) => s + (l.qte || 0), 0)} ${_T('pièce(s)')}`; }
function dessinerPanier(){
  const el = $('trs-panier'); if (!el) return;
  el.innerHTML = T.panier.length ? `<table class="t" style="font-size:13px"><thead><tr><th>${_T('Réf.')}</th><th>${_T('Désignation')}</th><th style="width:78px">${_T('Qté')}</th><th style="width:70px">${_T('Colis n°')}</th><th></th></tr></thead><tbody>
    ${T.panier.map(l => `<tr><td class="mono">${e_(l.ref)}</td><td>${e_(l.designation)}<div style="font-size:11px;color:var(--text3)">${_T('Lagord')} : ${l.max}</div></td>
      <td><input class="form-input" id="trs-q-${l.id}" type="number" min="1" max="${l.max}" value="${l.qte}" style="padding:5px 7px${l.qte > l.max ? ';border-color:var(--danger)' : ''}" oninput="trsQte(${l.id},this.value)"></td>
      <td><input class="form-input" value="${e_(l.colis)}" style="padding:5px 7px" oninput="trsColis(${l.id},this.value)"></td>
      <td><button class="btn sm" onclick="trsRetirer(${l.id})"><i class="ti ti-x"></i></button></td></tr>`).join('')}</tbody></table>`
    : `<div style="color:var(--text3);font-size:13px;padding:14px 4px">${_T('Cliquez sur une pièce à gauche pour l’ajouter.')}</div>`;
  majTotaux();
}
function trsAnnuler(){
  if (T.panier.length && !confirm(_T('Abandonner ce transfert ? Les pièces sélectionnées seront perdues.'))) return;
  T.vue = 'liste'; T.panier = []; render();
}
async function trsEnregistrer(forcer){
  const lignes = T.panier.filter(l => l.qte > 0);
  if (!lignes.length) { alert(_T('Ajoutez au moins une pièce avec une quantité.')); return; }
  const trop = lignes.filter(l => l.qte > l.max);
  if (trop.length && !forcer && !confirm(_T('Quantité supérieure au stock Lagord connu pour :') + '\n' + trop.map(l => `${l.ref} (${l.qte} / ${l.max})`).join('\n') + '\n\n' + _T('Enregistrer quand même ?'))) return;
  const h = T.entete;
  const body = { ...h, adresse_origine: ($('trs-adr-o') || {}).value, adresse_destination: ($('trs-adr-d') || {}).value,
    contact_destination: ($('trs-contact') || {}).value, lignes: lignes.map(l => ({ catalogue_id: l.id, qte: l.qte, colis: l.colis })), forcer: !!(forcer || trop.length) };
  const b = $('trs-ok'); if (b) { b.disabled = true; }
  // Fenêtre ouverte tout de suite (sinon bloquée par le navigateur), remplie après l'enregistrement
  const w = window.open('', '_blank');
  try {
    const r = await API.post('/inventaires-transferts', body);
    _toast(_T('Transfert enregistré :') + ' ' + r.numero, 'ti-check', 'var(--success)');
    T.vue = 'liste'; T.panier = []; T.pieces = null; T.adresses = null;
    await trsImprimer(r.id, w);
    render();
  } catch (e) { if (w) w.close(); alert(e.message); if (b) b.disabled = false; }
}

// ── Bon de transfert imprimable ───────────────────────────────────
async function trsImprimer(id, w){
  w = w || window.open('', '_blank');
  if (!w) { alert(_T('Autorisez les fenêtres pop-up pour imprimer le bon.')); return; }
  w.document.write('<p style="font-family:Arial;padding:20px">' + _T('Préparation du bon…') + '</p>');
  const t = await API.get(`/inventaires-transferts/${id}`);
  const nbP = t.lignes.reduce((s, l) => s + l.qte_envoyee, 0);
  const recu = t.statut === 'recu';
  const nl = s => e_(s || '').replace(/\n/g, '<br>');
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${e_(t.numero)} — Bon de transfert</title>
  <style>
    @page{size:A4;margin:14mm 12mm}
    body{font-family:Arial,Helvetica,sans-serif;color:#1f2937;font-size:12px;margin:0}
    .top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #1F5C8C;padding-bottom:10px;margin-bottom:14px}
    .marque{font-size:24px;font-weight:800;letter-spacing:1px;color:#1F5C8C}.marque small{display:block;font-size:11px;font-weight:400;color:#6b7280;letter-spacing:0}
    h1{font-size:17px;margin:0 0 4px;text-align:right}.num{font-size:15px;font-weight:700;text-align:right;color:#1F5C8C}
    .blocs{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:14px}
    .bloc{border:1px solid #d1d5db;border-radius:6px;padding:8px 10px}.bloc b.t{display:block;font-size:10px;text-transform:uppercase;color:#6b7280;margin-bottom:4px;letter-spacing:.5px}
    table{width:100%;border-collapse:collapse}th{background:#eef3f8;font-size:10.5px;text-transform:uppercase;text-align:left;padding:6px;border:1px solid #cbd5e1}
    td{padding:6px;border:1px solid #cbd5e1;vertical-align:top}td.n{text-align:center;width:62px}td.r{font-family:monospace;white-space:nowrap}
    tfoot td{font-weight:700;background:#f8fafc}
    .obs{border:1px solid #cbd5e1;border-radius:6px;min-height:58px;padding:8px 10px;margin-top:14px}
    .sign{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}.sign div{border:1px solid #cbd5e1;border-radius:6px;height:78px;padding:8px 10px}
    .pied{margin-top:12px;font-size:10px;color:#6b7280;text-align:center}
    @media print{.noprint{display:none}}
  </style></head><body>
  <div class="noprint" style="text-align:right;margin:8px 0"><button onclick="window.print()" style="padding:8px 14px;font-size:13px;cursor:pointer">🖨 Imprimer / PDF</button></div>
  <div class="top"><div class="marque">ÉLOFLEX<small>Éloflex France — Service Après-Vente</small></div>
    <div><h1>Bon de transfert de stock</h1><div class="num">${e_(t.numero)}</div><div style="text-align:right">Lagord → Paris · envoyé le ${dateFr(t.date_envoi)}</div></div></div>
  <div class="blocs">
    <div class="bloc"><b class="t">Expéditeur</b>${nl(t.adresse_origine)}</div>
    <div class="bloc"><b class="t">Destinataire</b>${nl(t.adresse_destination)}${t.contact_destination ? '<br>À l’attention de : <b>' + e_(t.contact_destination) + '</b>' : ''}</div>
    <div class="bloc"><b class="t">Transport</b>Transporteur : <b>${e_(t.transporteur || '—')}</b><br>N° de suivi : <b>${e_(t.num_suivi || '—')}</b><br>Nombre de colis : <b>${t.nb_colis || '—'}</b>${t.cree_par ? '<br>Préparé par : ' + e_(t.cree_par) : ''}</div>
  </div>
  ${t.notes ? `<p style="margin:0 0 10px"><b>Notes :</b> ${e_(t.notes)}</p>` : ''}
  <table><thead><tr><th style="width:26px">#</th><th>Réf. Éloflex</th><th>Désignation</th><th>Colis n°</th><th style="text-align:center">Qté envoyée</th><th style="text-align:center">Qté reçue</th></tr></thead>
    <tbody>${t.lignes.map((l, i) => `<tr><td style="text-align:center;color:#6b7280">${i + 1}</td><td class="r">${e_(l.ref)}</td><td>${e_(l.designation)}</td><td style="text-align:center">${e_(l.colis || '')}</td>
      <td class="n"><b>${l.qte_envoyee}</b></td><td class="n">${recu && l.qte_recue != null ? `<b${l.qte_recue !== l.qte_envoyee ? ' style="color:#dc2626"' : ''}>${l.qte_recue}</b>` : ''}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td colspan="4">${t.lignes.length} référence(s)</td><td class="n">${nbP}</td><td class="n">${recu ? t.lignes.reduce((s, l) => s + (l.qte_recue || 0), 0) : ''}</td></tr></tfoot></table>
  <div class="obs"><b style="font-size:10px;text-transform:uppercase;color:#6b7280">Observations à la réception (manquants, casse…)</b><br>${recu && t.observations ? nl(t.observations) : ''}</div>
  <div class="sign"><div><b style="font-size:10px;text-transform:uppercase;color:#6b7280">Préparé par (Lagord) — date et signature</b></div>
    <div><b style="font-size:10px;text-transform:uppercase;color:#6b7280">Reçu par (Paris) — date et signature</b>${recu ? `<br>${e_(t.recu_par || '')} — ${dateFr(t.recu_le)}` : ''}</div></div>
  <div class="pied">Transfert interne entre sites Éloflex France — marchandise non facturée, sans changement de propriété. Exemplaire 1 : dans le colis · Exemplaire 2 : conservé à Lagord.</div>
  <script>setTimeout(function(){ window.print(); }, 350);<\/script>
  </body></html>`;
  w.document.open(); w.document.write(html); w.document.close();
}

// ── Réception à Paris ─────────────────────────────────────────────
async function trsReception(id){ T.vue = 'reception'; T.detail = await API.get(`/inventaires-transferts/${id}`); render(); }
async function renderReception(ttl, c, a){
  const t = T.detail; if (!t) { T.vue = 'liste'; return render(); }
  const fait = t.statut === 'recu';
  ttl.textContent = _T('Réception') + ' ' + t.numero;
  a.innerHTML = `<button class="btn" onclick="trsRetour()"><i class="ti ti-arrow-left"></i>${_T('Retour')}</button>`;
  c.innerHTML = `
    <div style="font-size:13.5px;color:var(--text2);margin-bottom:12px;max-width:900px">${fait
      ? _T('Transfert réceptionné le') + ' ' + dateFr(t.recu_le) + (t.recu_par ? ' ' + _T('par') + ' ' + e_(t.recu_par) : '') + '.'
      : _T('Saisissez les quantités réellement reçues à Paris (pré-remplies avec les quantités envoyées). Un manquant repasse dans le stock Lagord de l’appli ; s’il est perdu, l’inventaire de Lagord le régularisera dans VosFactures.')}</div>
    <div class="table-wrap"><table class="t"><thead><tr><th>${_T('Réf.')}</th><th>${_T('Désignation')}</th><th>${_T('Colis n°')}</th><th style="text-align:right">${_T('Envoyé')}</th><th style="width:110px">${_T('Reçu')}</th></tr></thead>
      <tbody>${t.lignes.map(l => `<tr><td class="mono">${e_(l.ref)}</td><td>${e_(l.designation)}</td><td>${e_(l.colis || '')}</td><td style="text-align:right;font-weight:600">${l.qte_envoyee}</td>
        <td>${fait ? `<b style="${l.qte_recue !== l.qte_envoyee ? 'color:var(--danger)' : ''}">${l.qte_recue}</b>` : `<input class="form-input trs-recu" data-id="${l.id}" type="number" min="0" value="${l.qte_envoyee}" style="padding:5px 7px" oninput="this.style.borderColor=(+this.value!==${l.qte_envoyee})?'var(--warning)':''">`}</td></tr>`).join('')}</tbody></table></div>
    <div class="form-group" style="margin-top:12px;max-width:700px"><label class="form-label">${_T('Observations (manquants, casse…)')}</label>
      ${fait ? `<div>${e_(t.observations || '—')}</div>` : `<textarea class="form-input" id="trs-obs" rows="3"></textarea>`}</div>
    <div style="display:flex;gap:8px;margin-top:12px"><button class="btn" onclick="trsImprimer(${t.id})"><i class="ti ti-printer"></i>${_T('Imprimer le bon')}</button>
      ${!fait && peutEcrire() ? `<button class="btn primary" onclick="trsValiderReception(${t.id})"><i class="ti ti-check"></i>${_T('Valider la réception')}</button>` : ''}</div>`;
}
function trsRetour(){ T.vue = 'liste'; T.detail = null; render(); }
async function trsValiderReception(id){
  const lignes = [...document.querySelectorAll('.trs-recu')].map(i => ({ id: +i.dataset.id, qte_recue: i.value === '' ? 0 : parseInt(i.value) }));
  const t = T.detail;
  const ec = lignes.filter(l => { const x = t.lignes.find(y => y.id === l.id); return x && x.qte_envoyee !== l.qte_recue; });
  if (!confirm(ec.length ? `${ec.length} ${_T('ligne(s) avec un écart : le stock Paris sera corrigé. Valider la réception ?')}` : _T('Tout est reçu conforme. Valider la réception ?'))) return;
  try {
    await API.post(`/inventaires-transferts/${id}/reception`, { lignes, observations: ($('trs-obs') || {}).value || '' });
    _toast(_T('Réception enregistrée'), 'ti-check', 'var(--success)'); T.vue = 'liste'; T.detail = null; render();
  } catch (e) { alert(e.message); }
}
async function trsSupprimer(id, num){
  if (!confirm(_T('Supprimer le transfert') + ' ' + num + ' ?\n' + _T('Les quantités envoyées reviennent dans le stock Lagord de l’appli.'))) return;
  try { await API.del(`/inventaires-transferts/${id}`); _toast(_T('Transfert supprimé'), 'ti-trash'); render(); } catch (e) { alert(e.message); }
}

Object.assign(window, { renderTransfertsStock, trsQuitter: quitter, trsNouveau, trsEntete, trsChercher, trsAjouter, trsQte, trsColis, trsRetirer,
  trsAnnuler, trsEnregistrer, trsImprimer, trsReception, trsRetour, trsValiderReception, trsSupprimer });
})();
