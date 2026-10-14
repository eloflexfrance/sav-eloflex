// public/js/retours-demo.js
// ─────────────────────────────────────────────────────────────────────────────
// Retours démo : compte rendu de réception d'un fauteuil de démonstration.
// Photos par étape → contrôles → pièces à remplacer (facturées / offertes) →
// forfaits → PDF → envoi par e-mail → facture brouillon Pennylane.
// ─────────────────────────────────────────────────────────────────────────────
(function(){
'use strict';

const RD_ETAPES = [
  { k:'colis',     ic:'ti-package',        l:'1. Colis non ouvert',                          h:'Photo du colis tel que livré par le transporteur, avant ouverture.' },
  { k:'ouverture', ic:'ti-box',            l:'2. Colis ouvert — mousse du dessus',           h:'Contrôle de la présence de la mousse de protection du dessus.' },
  { k:'dessus',    ic:'ti-box-seam',       l:'3. Dessus du fauteuil dans le carton',         h:'Mousse retirée : le fauteuil vu de dessus, encore dans son carton.' },
  { k:'ensemble',  ic:'ti-wheelchair',     l:'4. Vues d’ensemble du fauteuil',               h:'Plusieurs photos du fauteuil sorti du carton (avant, arrière, côtés…).' },
  { k:'anomalie',  ic:'ti-alert-triangle', l:'5. Anomalies constatées',                      h:'Une photo précise par anomalie (rayure, choc, pièce cassée…) avec sa description.' },
];
const RD_ETAPE_LBL = Object.fromEntries(RD_ETAPES.map(e=>[e.k, e.l.replace(/^\d+\.\s*/,'')]));
const RD_ETATS = ['Neuf','Bon état','Correct','Abîmé','Défectueux'];
const RD_NETT = { propre:'Propre', base:'Nettoyage de base', complet:'Nettoyage complet' };
const RD_STATUTS = {
  brouillon:{ l:'Brouillon', c:'#6b7280', ic:'ti-pencil' },
  termine:  { l:'Terminé',   c:'#2563eb', ic:'ti-check' },
  envoye:   { l:'Envoyé',    c:'#059669', ic:'ti-mail-check' },
  devis:    { l:'Devis créé', c:'#d97706', ic:'ti-file-text' },
  facture:  { l:'Facturé',   c:'#7c3aed', ic:'ti-file-euro' },
};
let RD_CFG = null;          // tarifs + destinataires par défaut
let RD = null;              // retour en cours d'édition
let RD_CAT = null;          // catalogue pièces (chargé à la demande)
let RD_LISTE = [];

const _e = s => (typeof esc==='function') ? esc(s) : String(s==null?'':s);
const _T = s => (typeof TR==='function') ? TR(s) : s;
const _fd = d => d ? String(d).slice(0,10).split('-').reverse().join('/') : '—';
const n2 = v => Math.round((parseFloat(v)||0)*100)/100;
const eur = v => n2(v).toLocaleString('fr-FR',{minimumFractionDigits:2,maximumFractionDigits:2})+' €';
const eurPdf = v => n2(v).toFixed(2).replace('.',',')+' €';
const _modele = m => { const s=String(m||'').trim(); return !s ? '—' : (/^eloflex/i.test(s) ? s.replace(/^eloflex/i,'Eloflex') : 'Eloflex '+s); };
const toastErr = e => toast('Erreur : '+(e && e.message || e),'ti-alert-circle','var(--danger)');

async function cfg(){ if(!RD_CFG) RD_CFG = await API.get('/demo-retours/config'); return RD_CFG; }
function badgeStatut(s){ const x=RD_STATUTS[s]||RD_STATUTS.brouillon; return `<span class="badge" style="background:${x.c}18;color:${x.c};border:0.5px solid ${x.c}55"><i class="ti ${x.ic}" style="font-size:12px;margin-right:3px"></i>${_T(x.l)}</span>`; }
const ouiNon = v => v===true ? _T('Oui') : v===false ? _T('Non') : '—';

// ══════════════════════════════════════════════════════════════════
// Vue liste « Retours démo »
// ══════════════════════════════════════════════════════════════════
async function renderRetoursDemo(ttl,c,a){
  ttl.textContent = _T('Retours démo');
  a.innerHTML = `<button class="btn sm" onclick="render()"><i class="ti ti-refresh"></i>${_T('Actualiser')}</button>
    <button class="btn sm primary" onclick="rdNouveau({})"><i class="ti ti-plus"></i>${_T('Nouveau retour')}</button>`;
  try{ RD_LISTE = await API.get('/demo-retours'); await cfg(); }
  catch(e){ c.innerHTML=`<div class="empty"><i class="ti ti-alert-circle"></i>Erreur : ${_e(e.message)}</div>`; return; }
  const nb = s => RD_LISTE.filter(r=>r.statut===s).length;
  const totF = RD_LISTE.reduce((s,r)=>s+n2(r.total_facture),0);
  const totO = RD_LISTE.reduce((s,r)=>s+n2(r.total_pieces_offertes),0);
  const kpi = (lbl,val,col) => `<div class="card" style="padding:12px 16px;min-width:150px;flex:1"><div style="font-size:12px;color:var(--text2)">${lbl}</div><div style="font-size:22px;font-weight:700;color:${col||'var(--text)'}">${val}</div></div>`;
  c.innerHTML = `
    <div style="font-size:13px;color:var(--text2);margin-bottom:12px;line-height:1.5"><i class="ti ti-info-circle"></i> ${_T('Compte rendu de réception des fauteuils de démonstration : photos à chaque étape du déballage, contrôle du carton et des mousses, état général, nettoyage, pièces à remplacer (facturées ou offertes) et forfaits. Créez un retour ici ou depuis le Parc de démo (bouton')} <i class="ti ti-clipboard-check"></i>).</div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">
      ${kpi(_T('Retours enregistrés'), RD_LISTE.length)}
      ${kpi(_T('Brouillons'), nb('brouillon'), nb('brouillon')?'var(--warning)':'')}
      ${kpi(_T('Envoyés / facturés'), nb('envoye')+nb('facture'))}
      ${kpi(_T('Total facturable HT'), eur(totF), '#7c3aed')}
      ${kpi(_T('Pièces offertes (Éloflex)'), eur(totO), '#059669')}
    </div>
    <div style="margin-bottom:10px"><input class="form-input" id="rd-q" placeholder="${_T('Rechercher (modèle, série, distributeur…)')}" style="max-width:340px;padding:9px 12px" oninput="rdFiltrer(this.value)"></div>
    ${RD_LISTE.length ? `<div class="table-wrap"><table class="t" id="rd-table">
      <thead><tr><th></th><th>${_T('Réception')}</th><th>${_T('Fauteuil')}</th><th>${_T('Distributeur')}</th><th>${_T('Carton / mousses')}</th><th>${_T('État')}</th><th>${_T('Photos')}</th><th style="text-align:right">${_T('À facturer HT')}</th><th>${_T('Statut')}</th><th></th></tr></thead>
      <tbody>${RD_LISTE.map(r=>{
        const k = [r.modele,r.num_serie,r.client_nom_actuel,r.distributeur_nom,r.etat_general,r.pl_invoice_num,r.pl_quote_num].join(' ').toLowerCase();
        const cm = (r.carton_origine===false||r.mousses_presentes===false)
          ? `<span style="color:var(--warning)"><i class="ti ti-alert-triangle"></i> ${r.carton_origine===false?_T('carton non d’origine'):''}${r.carton_origine===false&&r.mousses_presentes===false?' · ':''}${r.mousses_presentes===false?_T('mousses absentes'):''}</span>`
          : (r.carton_origine===true ? `<span style="color:var(--success)"><i class="ti ti-check"></i> ${_T('OK')}</span>` : '—');
        return `<tr data-k="${_e(k)}" style="cursor:pointer" onclick="rdOuvrir(${r.id})">
          <td style="width:54px">${r.vignette_url?`<img src="${_e(r.vignette_url)}" style="width:48px;height:36px;object-fit:cover;border-radius:6px;display:block" loading="lazy">`:'<i class="ti ti-photo-off" style="color:var(--text3)"></i>'}</td>
          <td style="white-space:nowrap">${_fd(r.date_reception)}${r.transporteur?`<div style="font-size:11px;color:var(--text3)">${_e(r.transporteur)}</div>`:''}</td>
          <td><b>${_e(_modele(r.modele))}</b><div class="mono" style="font-size:11.5px;color:var(--text2)">${_e(r.num_serie||'')}</div></td>
          <td>${_e(r.client_nom_actuel||r.distributeur_nom||'—')}</td>
          <td style="font-size:12.5px">${cm}</td>
          <td style="font-size:13px">${_e(r.etat_general||'—')}</td>
          <td style="white-space:nowrap;font-size:13px"><i class="ti ti-camera"></i> ${r.nb_photos||0}${r.nb_anomalies?` <span style="color:var(--danger)" title="${_T('Anomalies')}"><i class="ti ti-alert-triangle"></i>${r.nb_anomalies}</span>`:''}</td>
          <td style="text-align:right;font-weight:600;white-space:nowrap">${eur(r.total_facture)}${n2(r.total_pieces_offertes)>0?`<div style="font-size:11px;color:#059669;font-weight:400">${_T('offert')} ${eur(r.total_pieces_offertes)}</div>`:''}</td>
          <td>${badgeStatut(r.statut)}${r.pl_quote_num?`<div style="font-size:11px;color:var(--text3)">${_T('Devis')} ${_e(r.pl_quote_num)}</div>`:''}${r.pl_invoice_num?`<div style="font-size:11px;color:var(--text3)">${_T('Facture')} ${_e(r.pl_invoice_num)}</div>`:''}</td>
          <td style="white-space:nowrap" onclick="event.stopPropagation()">
            <button class="btn sm" title="${_T('Télécharger le PDF')}" onclick="rdPdfTelecharger(${r.id})"><i class="ti ti-file-type-pdf"></i></button>
            <button class="btn sm" title="${_T('Envoyer par e-mail')}" onclick="rdModalEmail(${r.id})"><i class="ti ti-send"></i></button>
          </td></tr>`;
      }).join('')}</tbody></table></div>`
    : `<div class="empty" style="padding:30px"><i class="ti ti-truck-return"></i>${_T('Aucun retour démo enregistré pour le moment.')}</div>`}`;
}
function rdFiltrer(q){
  q=String(q||'').toLowerCase().trim();
  document.querySelectorAll('#rd-table tbody tr').forEach(tr=>{ tr.style.display = !q || (tr.dataset.k||'').includes(q) ? '' : 'none'; });
}

// ══════════════════════════════════════════════════════════════════
// Création (depuis la liste, le parc démo, une commande démo ou un prêt)
// ══════════════════════════════════════════════════════════════════
async function rdNouveau(src){
  src = src || {};
  let pre = {};
  try{
    const qs = ['commande_id','pret_id','serie'].filter(k=>src[k]).map(k=>k+'='+encodeURIComponent(src[k])).join('&');
    if(qs) pre = await API.get('/demo-retours/prefill?'+qs);
  }catch(e){ toastErr(e); return; }
  if(pre.retours_precedents && pre.retours_precedents.length){
    const enCours = pre.retours_precedents.find(x=>x.statut==='brouillon');
    if(enCours && confirm(_T('Un compte rendu de retour en brouillon existe déjà pour ce n° de série (')+_fd(enCours.date_reception)+_T('). L’ouvrir plutôt que d’en créer un nouveau ?'))){ rdOuvrir(enCours.id); return; }
  }
  let marquer = false;
  if(pre.demo_en_cours && pre.commande_id){
    marquer = confirm(_T('Ce fauteuil est encore « en démo » dans le parc.')+'\n'+_T('Le marquer aussi comme revenu chez Éloflex France (disponible) ?'));
  }
  const body = {
    commande_id: pre.commande_id||null, pret_id: pre.pret_id||null, client_id: pre.client_id||null,
    distributeur_nom: pre.distributeur_nom||'', distributeur_email: pre.distributeur_email||'',
    modele: pre.modele||'', num_serie: pre.num_serie||'', date_reception: new Date().toISOString().slice(0,10),
    transporteur: 'DSV', marquer_retour: marquer,
  };
  try{
    const r = await API.post('/demo-retours', body);
    if(marquer && STATE.view==='parc-demo') render();
    rdAfficher(r);
  }catch(e){ toastErr(e); }
}

async function rdOuvrir(id){
  try{ await cfg(); rdAfficher(await API.get(`/demo-retours/${id}`)); }catch(e){ toastErr(e); }
}

// ══════════════════════════════════════════════════════════════════
// Éditeur
// ══════════════════════════════════════════════════════════════════
async function rdAfficher(r){
  await cfg();
  RD = r; RD.pieces = Array.isArray(r.pieces) ? r.pieces : []; RD._dirty = false;
  const C = RD_CFG;
  const radio = (name, val) => `
    <label style="display:inline-flex;align-items:center;gap:5px;margin-right:14px;cursor:pointer"><input type="radio" name="${name}" value="1" ${val===true?'checked':''} onchange="rdCtrlChange()"> ${_T('Oui')}</label>
    <label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer"><input type="radio" name="${name}" value="0" ${val===false?'checked':''} onchange="rdCtrlChange()"> ${_T('Non')}</label>`;
  const sect = (ic, t, body, extra) => `<div style="border:1px solid var(--border-s,var(--border));border-radius:12px;padding:12px 14px;margin-bottom:12px${extra||''}">
      <div style="font-weight:700;font-size:14px;margin-bottom:10px;color:var(--text)"><i class="ti ${ic}" style="color:var(--accent);margin-right:6px"></i>${t}</div>${body}</div>`;
  const devisBadge = RD.pl_quote_id ? `<a href="${_e(urlPennylane('devis', RD.pl_quote_id))}" target="_blank" rel="noopener" class="badge" style="background:#d9770618;color:#b45309;border:0.5px solid #d9770655;text-decoration:none"><i class="ti ti-external-link" style="font-size:12px"></i> ${_T('Devis')} ${_e(RD.pl_quote_num||RD.pl_quote_id)}</a>` : '';
  const fact = RD.pl_invoice_id ? `<a href="${_e(urlPennylane('customer_invoice', RD.pl_invoice_id))}" target="_blank" rel="noopener" class="badge" style="background:#7c3aed18;color:#7c3aed;border:0.5px solid #7c3aed55;text-decoration:none"><i class="ti ti-external-link" style="font-size:12px"></i> ${_T('Facture')} ${_e(RD.pl_invoice_num||RD.pl_invoice_id)}</a>` : '';
  const envois = (RD.envois||[]);
  showModal(`<div class="modal-header"><i class="ti ti-clipboard-check" style="color:var(--accent)"></i>
      <h2>${_T('Retour démo')} — ${_e(_modele(RD.modele))} ${RD.num_serie?`<span class="mono" style="font-weight:500;font-size:13px">${_e(RD.num_serie)}</span>`:''}</h2>
      <span id="rd-statut-badge">${badgeStatut(RD.statut)}</span> ${devisBadge} ${fact}
      <button class="btn sm" onclick="rdFermer()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body" id="rd-body">
      ${sect('ti-wheelchair', _T('Fauteuil & réception'), `
        <div class="grid-2">
          <div class="form-group"><label class="form-label">${_T('Modèle')}</label><input class="form-input" id="rd-modele" value="${_e(RD.modele||'')}" placeholder="Eloflex F" oninput="rdDirty()"></div>
          <div class="form-group"><label class="form-label">${_T('N° de série')}</label>
            <div style="display:flex;gap:6px"><input class="form-input mono" id="rd-serie" value="${_e(RD.num_serie||'')}" oninput="rdDirty()">
            <button class="btn sm" type="button" title="${_T('Retrouver le fauteuil démo et son distributeur')}" onclick="rdChercherSerie()"><i class="ti ti-search"></i></button></div></div>
          <div class="form-group"><label class="form-label">${_T('Distributeur')}</label><input class="form-input" id="rd-distrib" list="rd-distrib-list" value="${_e(RD.client_nom_actuel||RD.distributeur_nom||'')}" oninput="rdDistribSaisie(this.value)"><datalist id="rd-distrib-list"></datalist></div>
          <div class="form-group"><label class="form-label">${_T('E-mail du distributeur')}</label><input class="form-input" id="rd-distrib-email" value="${_e(RD.distributeur_email||RD.client_email||'')}" placeholder="adresse@distributeur.fr" oninput="rdDirty()"></div>
          <div class="form-group"><label class="form-label">${_T('Date de réception')}</label><input class="form-input" type="date" id="rd-date" value="${_e((RD.date_reception||'').slice(0,10))}" oninput="rdDirty()"></div>
          <div class="form-group"><label class="form-label">${_T('Transporteur')}</label><input class="form-input" id="rd-transp" list="rd-transp-list" value="${_e(RD.transporteur||'')}" oninput="rdDirty()"><datalist id="rd-transp-list"><option>DSV</option><option>DB Schenker</option><option>Geodis</option><option>Kuehne+Nagel</option><option>Dépôt direct</option></datalist></div>
          <div class="form-group"><label class="form-label">${_T('N° de suivi / lettre de voiture')}</label><input class="form-input mono" id="rd-suivi" value="${_e(RD.num_suivi||'')}" oninput="rdDirty()"></div>
          <div class="form-group"><label class="form-label">${_T('Réceptionné par')}</label><input class="form-input" id="rd-recep" value="${_e(RD.receptionnaire||'')}" oninput="rdDirty()"></div>
        </div>`)}
      ${sect('ti-camera', _T('Photos du déballage'), `<div style="font-size:12.5px;color:var(--text3);margin:-4px 0 10px">${_T('Sur mobile ou tablette, « Appareil photo » ouvre directement la caméra. Les photos sont enregistrées immédiatement.')}</div><div id="rd-photos"></div>`)}
      ${sect('ti-checklist', _T('Contrôle à réception'), `
        <div class="grid-2">
          <div class="form-group"><label class="form-label">${_T('Réception dans le carton d’origine')}</label><div style="padding:6px 0">${radio('rd-carton', RD.carton_origine)}</div></div>
          <div class="form-group"><label class="form-label">${_T('Mousses de protection présentes')}</label><div style="padding:6px 0">${radio('rd-mousses', RD.mousses_presentes)}</div></div>
          <div class="form-group"><label class="form-label">${_T('État général du fauteuil')}</label>
            <select class="form-input" id="rd-etat" onchange="rdDirty()"><option value="">—</option>${RD_ETATS.map(x=>`<option ${RD.etat_general===x?'selected':''}>${x}</option>`).join('')}</select></div>
          <div class="form-group"><label class="form-label">${_T('Nettoyage')}</label>
            <select class="form-input" id="rd-nett" onchange="rdRecap()">${Object.keys(RD_NETT).map(k=>{ const t=k==='base'?C.nettoyage_base:k==='complet'?C.nettoyage_complet:0; return `<option value="${k}" ${(RD.nettoyage||'propre')===k?'selected':''}>${RD_NETT[k]}${k!=='propre'?' — '+eur(t)+' HT':''}</option>`; }).join('')}</select></div>
        </div>`)}
      ${sect('ti-tool', _T('Pièces à remplacer (remise en état à neuf)'), `
        <div style="position:relative;margin-bottom:8px">
          <input class="form-input" id="rd-piece-q" placeholder="${_T('Rechercher une pièce du catalogue (référence ou désignation)…')}" autocomplete="off" oninput="rdPieceRecherche(this.value)" onfocus="rdPieceRecherche(this.value)">
          <div id="rd-piece-sugg" style="position:absolute;left:0;right:0;top:100%;z-index:5;background:var(--surface,#fff);border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.12);max-height:260px;overflow:auto;display:none"></div>
        </div>
        <div id="rd-pieces"></div>
        <button class="btn sm" type="button" onclick="rdPieceAjouter({})" style="margin-top:6px"><i class="ti ti-plus"></i>${_T('Ligne libre')}</button>
        <div style="font-size:12px;color:var(--text3);margin-top:6px">${_T('Prix unitaires = prix de vente distributeur HT du catalogue (modifiables). « Offerte » = remplacement à la charge d’Éloflex (non facturé).')}</div>`)}
      ${sect('ti-receipt', _T('Récapitulatif à facturer'), `<div id="rd-recap"></div>`)}
      ${sect('ti-message', _T('Commentaire libre'), `<textarea class="form-input" id="rd-comment" rows="3" placeholder="${_T('Observations du réceptionneur…')}" oninput="rdDirty()">${_e(RD.commentaire||'')}</textarea>`)}
      ${envois.length?`<div style="font-size:12.5px;color:var(--text2);background:var(--bg);border-radius:8px;padding:8px 12px"><b><i class="ti ti-history"></i> ${_T('Envois')} :</b><br>${envois.slice(-5).reverse().map(x=>_fd((x.date||'').slice(0,10))+' '+String(x.date||'').slice(11,16)+(x.par?' · '+_e(x.par):'')+' — '+_e((x.destinataires||[]).join(', '))).join('<br>')}</div>`:''}
    </div>
    <div class="modal-footer" style="flex-wrap:wrap">
      <button class="btn danger" style="margin-right:auto" onclick="rdSupprimer()"><i class="ti ti-trash"></i></button>
      <button class="btn" onclick="rdFermer()">${_T('Fermer')}</button>
      <button class="btn" onclick="rdEnregistrer(true)"><i class="ti ti-device-floppy"></i>${_T('Enregistrer')}</button>
      <button class="btn" onclick="rdPdfTelecharger()"><i class="ti ti-file-type-pdf"></i>PDF</button>
      <button class="btn" onclick="rdModalEmail()"><i class="ti ti-send"></i>${_T('Envoyer par e-mail')}</button>
      <button class="btn" onclick="rdDevis()"><i class="ti ti-file-text"></i>${_T('Créer un devis')}</button>
      <button class="btn primary" onclick="rdFacture()"><i class="ti ti-file-euro"></i>${_T('Créer la facture')}</button>
    </div>`);
  const ov = document.querySelector('#modal-area .modal'); if(ov) ov.style.maxWidth='980px';
  rdRenderPhotos(); rdRenderPieces(); rdRecap();
  rdChargerDistributeurs();
  document.addEventListener('click', rdFermerSugg, true);
}
function rdFermerSugg(ev){ const s=$('rd-piece-sugg'); if(s && !s.contains(ev.target) && ev.target.id!=='rd-piece-q') s.style.display='none'; }
function rdDirty(){ if(RD) RD._dirty = true; }
async function rdFermer(){
  if(RD && RD._dirty){ try{ await rdEnregistrer(false); }catch(_){} }
  document.removeEventListener('click', rdFermerSugg, true);
  closeModal(); RD=null;
  if(STATE.view==='retours-demo') render();
}

// Distributeurs (autocomplétion → rattache la fiche, donc le client Pennylane)
async function rdChargerDistributeurs(){
  try{
    if(!window._RD_CLIENTS) window._RD_CLIENTS = await API.clients();
    const dl=$('rd-distrib-list'); if(dl) dl.innerHTML = window._RD_CLIENTS.slice(0,3000).map(c=>`<option value="${_e(c.nom)}">`).join('');
  }catch(_){ window._RD_CLIENTS = []; }
}
function rdDistribSaisie(v){
  rdDirty();
  const c = (window._RD_CLIENTS||[]).find(x=>(x.nom||'').trim().toLowerCase()===String(v||'').trim().toLowerCase());
  RD.client_id = c ? c.id : null;
  if(c && c.email && !gv('rd-distrib-email').trim()) $('rd-distrib-email').value = c.email;
}
async function rdChercherSerie(){
  const s = gv('rd-serie').trim(); if(!s){ toast(_T('Saisissez un n° de série'),'ti-alert-circle','var(--warning)'); return; }
  try{
    const p = await API.get('/demo-retours/prefill?serie='+encodeURIComponent(s));
    if(!p.commande_id){ toast(_T('Aucun fauteuil démo trouvé avec ce n° de série'),'ti-alert-circle','var(--warning)'); return; }
    RD.commande_id = p.commande_id; RD.client_id = p.client_id || RD.client_id;
    if(p.modele) $('rd-modele').value = p.modele;
    if(p.distributeur_nom) $('rd-distrib').value = p.distributeur_nom;
    if(p.distributeur_email) $('rd-distrib-email').value = p.distributeur_email;
    rdDirty(); toast(_T('Fauteuil démo retrouvé'),'ti-check');
  }catch(e){ toastErr(e); }
}

// ── Photos ──
function rdRenderPhotos(){
  const box=$('rd-photos'); if(!box||!RD) return;
  const ph = RD.photos||[];
  box.innerHTML = RD_ETAPES.map(et=>{
    const L = ph.filter(p=>p.etape===et.k);
    return `<div style="padding:8px 0;border-top:1px dashed var(--border)">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <b style="font-size:13.5px"><i class="ti ${et.ic}" style="color:${et.k==='anomalie'?'var(--danger)':'var(--accent)'}"></i> ${_T(et.l)}</b>
        <span style="font-size:12px;color:${L.length?'var(--success)':'var(--text3)'}">${L.length?'✓ '+L.length+' photo'+(L.length>1?'s':''):_T('aucune photo')}</span>
        <span style="margin-left:auto;display:flex;gap:6px">
          <label class="btn sm" style="cursor:pointer"><i class="ti ti-camera"></i>${_T('Appareil photo')}<input type="file" accept="image/*" capture="environment" style="display:none" onchange="rdUpload('${et.k}', this)"></label>
          <label class="btn sm" style="cursor:pointer"><i class="ti ti-photo-plus"></i>${_T('Galerie')}<input type="file" accept="image/*" multiple style="display:none" onchange="rdUpload('${et.k}', this)"></label>
        </span>
      </div>
      <div style="font-size:12px;color:var(--text3);margin:2px 0 6px">${_T(et.h)}</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px">${L.map(p=>`
        <div style="width:${et.k==='anomalie'?'190px':'128px'}">
          <div style="position:relative">
            <a href="${_e(p.url)}" target="_blank" rel="noopener"><img src="${_e(p.url_thumb||p.url)}" style="width:100%;height:${et.k==='anomalie'?'120px':'90px'};object-fit:cover;border-radius:8px;display:block;border:1px solid var(--border)" loading="lazy"></a>
            <button class="btn sm" title="${_T('Supprimer la photo')}" style="position:absolute;top:4px;right:4px;padding:2px 5px;background:rgba(255,255,255,.9)" onclick="rdPhotoSuppr(${p.id})"><i class="ti ti-x"></i></button>
          </div>
          <input class="form-input" style="margin-top:4px;font-size:12px;padding:5px 7px" placeholder="${et.k==='anomalie'?_T('Description de l’anomalie…'):_T('Légende (facultatif)')}" value="${_e(p.legende||'')}" onchange="rdPhotoLegende(${p.id}, this.value)">
        </div>`).join('')}</div>
    </div>`;
  }).join('');
}
async function rdUpload(etape, input){
  const files = Array.from(input.files||[]); input.value=''; if(!files.length||!RD) return;
  toast(_T('Envoi des photos…')+' ('+files.length+')','ti-loader-2');
  try{
    // Réduction côté navigateur (photos de smartphone : 4-8 Mo → ~400 Ko) avant l'envoi.
    const fd2 = new FormData(); fd2.append('etape', etape);
    for(const f of files) fd2.append('photos', await rdReduire(f), (f.name||'photo').replace(/\.[^.]+$/,'')+'.jpg');
    const r = await fetch(`/api/demo-retours/${RD.id}/photos`,{method:'POST',body:fd2});
    const j = await r.json(); if(!r.ok) throw new Error(j.error||r.statusText);
    RD.photos = (RD.photos||[]).concat(j); rdRenderPhotos();
    toast(j.length+' '+_T('photo(s) ajoutée(s)'),'ti-check','var(--success)');
  }catch(e){ toastErr(e); }
}
function rdReduire(file, max=2000, q=0.82){
  return new Promise(res=>{
    if(!/^image\/(jpeg|png|webp)/.test(file.type)) return res(file);
    const img=new Image(), url=URL.createObjectURL(file);
    img.onload=()=>{ try{
      const k=Math.min(1, max/Math.max(img.naturalWidth,img.naturalHeight));
      const cv=document.createElement('canvas'); cv.width=Math.round(img.naturalWidth*k); cv.height=Math.round(img.naturalHeight*k);
      cv.getContext('2d').drawImage(img,0,0,cv.width,cv.height); URL.revokeObjectURL(url);
      cv.toBlob(b=>res(b && b.size < file.size ? b : file),'image/jpeg',q);
    }catch(_){ res(file); } };
    img.onerror=()=>{ URL.revokeObjectURL(url); res(file); };
    img.src=url;
  });
}
async function rdPhotoSuppr(pid){
  if(!confirm(_T('Supprimer cette photo ?'))) return;
  try{ await API.delete(`/demo-retours/${RD.id}/photos/${pid}`); RD.photos=(RD.photos||[]).filter(p=>p.id!==pid); rdRenderPhotos(); }catch(e){ toastErr(e); }
}
async function rdPhotoLegende(pid, v){
  try{ await API.patch(`/demo-retours/${RD.id}/photos/${pid}`,{legende:v}); const p=(RD.photos||[]).find(x=>x.id===pid); if(p) p.legende=v; }catch(e){ toastErr(e); }
}

// ── Contrôles ──
function _radio(name){ const el=document.querySelector(`input[name="${name}"]:checked`); return el ? el.value==='1' : null; }
function rdCtrlChange(){
  rdDirty();
  const carton=_radio('rd-carton'), mousses=_radio('rd-mousses');
  // Pas le carton d'origine ou mousses absentes → forfait carton / mousses coché automatiquement
  const cb=$('rd-f-carton'); if(cb && (carton===false || mousses===false) && !RD._cartonManuel) cb.checked=true;
  if(cb && carton===true && mousses===true && !RD._cartonManuel) cb.checked=false;
  rdRecap();
}

// ── Pièces ──
async function rdPieceRecherche(q){
  const box=$('rd-piece-sugg'); if(!box) return;
  q=String(q||'').trim().toLowerCase();
  if(q.length<2){ box.style.display='none'; return; }
  if(!RD_CAT){ try{ RD_CAT = await API.catalogue(); }catch(e){ RD_CAT=[]; } }
  const mots=q.split(/\s+/).filter(Boolean);
  const L=RD_CAT.filter(p=>{ const k=((p.ref||'')+' '+(p.designation||'')).toLowerCase(); return mots.every(m=>k.includes(m)); }).slice(0,30);
  box.innerHTML = L.length ? L.map(p=>`<div style="padding:7px 10px;cursor:pointer;border-bottom:1px solid var(--border);font-size:13px" onmousedown="event.preventDefault()" onclick="rdPieceChoisir(${p.id})" onmouseover="this.style.background='var(--bg)'" onmouseout="this.style.background=''">
      <span class="mono" style="font-weight:600">${_e(p.ref)}</span> — ${_e(p.designation)} <span style="float:right;color:var(--text2)">${p.pxht!=null?eur(p.pxht)+' HT':''}</span></div>`).join('')
    : `<div style="padding:8px 10px;color:var(--text3);font-size:13px">${_T('Aucune pièce trouvée — utilisez « Ligne libre ».')}</div>`;
  box.style.display='block';
}
function rdPieceChoisir(id){
  const p=(RD_CAT||[]).find(x=>x.id===id); if(!p) return;
  rdPieceAjouter({ catalogue_id:p.id, ref:p.ref, designation:p.designation, qte:1, pu:n2(p.pxht), tva:parseFloat(p.tva_distributeur)||20, facture:true });
  $('rd-piece-q').value=''; $('rd-piece-sugg').style.display='none';
}
function rdPieceAjouter(p){
  rdLirePieces();
  const ex = p.catalogue_id && RD.pieces.find(x=>x.catalogue_id===p.catalogue_id);
  if(ex) ex.qte = (parseInt(ex.qte)||1)+1;
  else RD.pieces.push({ catalogue_id:p.catalogue_id||null, ref:p.ref||'', designation:p.designation||'', qte:p.qte||1, pu:p.pu||0, tva:p.tva||20, facture:p.facture!==false });
  rdDirty(); rdRenderPieces(); rdRecap();
}
function rdRenderPieces(){
  const box=$('rd-pieces'); if(!box) return;
  if(!RD.pieces.length){ box.innerHTML=`<div style="font-size:13px;color:var(--text3);padding:4px 0">${_T('Aucune pièce à remplacer.')}</div>`; return; }
  box.innerHTML = `<div class="table-wrap"><table class="t" style="font-size:13px">
    <thead><tr><th>${_T('Référence')}</th><th>${_T('Désignation')}</th><th style="width:70px">${_T('Qté')}</th><th style="width:105px">${_T('PU HT')}</th><th style="text-align:right">${_T('Total HT')}</th><th>${_T('Prise en charge')}</th><th></th></tr></thead>
    <tbody>${RD.pieces.map((p,i)=>`<tr data-i="${i}">
      <td><input class="form-input mono rdp-ref" style="padding:5px 7px;font-size:12.5px;min-width:90px" value="${_e(p.ref)}" oninput="rdPiecesMaj()"></td>
      <td><input class="form-input rdp-des" style="padding:5px 7px;font-size:12.5px;min-width:180px" value="${_e(p.designation)}" oninput="rdPiecesMaj()"></td>
      <td><input class="form-input rdp-qte" type="number" min="1" style="padding:5px 7px" value="${parseInt(p.qte)||1}" oninput="rdPiecesMaj()"></td>
      <td><input class="form-input rdp-pu" type="number" min="0" step="0.01" style="padding:5px 7px" value="${n2(p.pu)}" oninput="rdPiecesMaj()"></td>
      <td style="text-align:right;white-space:nowrap" class="rdp-tot">${eur((parseInt(p.qte)||1)*n2(p.pu))}</td>
      <td style="white-space:nowrap">
        <select class="form-input rdp-fact" style="padding:5px 7px;width:auto;color:${p.facture!==false?'#7c3aed':'#059669'};font-weight:600" onchange="rdPiecesMaj();this.style.color=this.value==='1'?'#7c3aed':'#059669'">
          <option value="1" ${p.facture!==false?'selected':''}>${_T('Facturée (mauvais usage)')}</option>
          <option value="0" ${p.facture===false?'selected':''}>${_T('Offerte (Éloflex)')}</option></select>
        <input type="hidden" class="rdp-tva" value="${parseFloat(p.tva)||20}"><input type="hidden" class="rdp-cat" value="${p.catalogue_id||''}">
      </td>
      <td><button class="btn sm" title="${_T('Retirer')}" onclick="rdPieceRetirer(${i})"><i class="ti ti-trash"></i></button></td>
    </tr>`).join('')}</tbody></table></div>`;
}
function rdLirePieces(){
  const rows=document.querySelectorAll('#rd-pieces tbody tr'); if(!rows.length) return;
  RD.pieces = Array.from(rows).map(tr=>({
    catalogue_id: parseInt(tr.querySelector('.rdp-cat').value)||null,
    ref: tr.querySelector('.rdp-ref').value.trim(), designation: tr.querySelector('.rdp-des').value.trim(),
    qte: Math.max(1, parseInt(tr.querySelector('.rdp-qte').value)||1), pu: n2(tr.querySelector('.rdp-pu').value),
    tva: parseFloat(tr.querySelector('.rdp-tva').value)||20, facture: tr.querySelector('.rdp-fact').value==='1',
  }));
}
function rdPiecesMaj(){
  rdLirePieces(); rdDirty();
  document.querySelectorAll('#rd-pieces tbody tr').forEach((tr,i)=>{ const p=RD.pieces[i]; tr.querySelector('.rdp-tot').textContent=eur(p.qte*p.pu); });
  rdRecap();
}
function rdPieceRetirer(i){ rdLirePieces(); RD.pieces.splice(i,1); rdDirty(); rdRenderPieces(); rdRecap(); }

// ── Récapitulatif (même calcul que le serveur) ──
function rdCalc(){
  const C=RD_CFG;
  const fRet = $('rd-f-retour') ? $('rd-f-retour').checked : RD.fact_forfait_retour!==false;
  const carton=_radio('rd-carton'), mousses=_radio('rd-mousses');
  const fCar = $('rd-f-carton') ? $('rd-f-carton').checked : (RD.fact_forfait_carton || carton===false || mousses===false);
  const nett = gv('rd-nett') || RD.nettoyage || 'propre';
  const mNet = nett==='base'?C.nettoyage_base:nett==='complet'?C.nettoyage_complet:0;
  const pf = RD.pieces.filter(p=>p.facture!==false).reduce((s,p)=>s+(parseInt(p.qte)||1)*n2(p.pu),0);
  const po = RD.pieces.filter(p=>p.facture===false).reduce((s,p)=>s+(parseInt(p.qte)||1)*n2(p.pu),0);
  const mRet=fRet?C.forfait_retour:0, mCar=fCar?C.forfait_carton:0;
  return { fRet, fCar, nett, mRet, mCar, mNet, pf:n2(pf), po:n2(po), total:n2(mRet+mCar+mNet+pf) };
}
function rdRecap(){
  const box=$('rd-recap'); if(!box) return;
  if(RD && gv('rd-nett')) RD.nettoyage = gv('rd-nett');
  const k=rdCalc(), C=RD_CFG;
  const ligne=(lbl,val,opt)=>`<tr><td style="padding:5px 0">${lbl}</td><td style="text-align:right;padding:5px 0;white-space:nowrap;${opt||''}">${val}</td></tr>`;
  box.innerHTML = `<table style="width:100%;font-size:13.5px;border-collapse:collapse">
    ${ligne(`<label style="cursor:pointer"><input type="checkbox" id="rd-f-retour" ${k.fRet?'checked':''} onchange="rdDirty();rdRecap()"> ${_T('Forfait retour')} (${eur(C.forfait_retour)} HT)</label>`, eur(k.mRet))}
    ${ligne(`<label style="cursor:pointer"><input type="checkbox" id="rd-f-carton" ${k.fCar?'checked':''} onchange="RD._cartonManuel=true;rdDirty();rdRecap()"> ${_T('Forfait carton / mousses de protection')} (${eur(C.forfait_carton)} HT)</label> <span style="font-size:11.5px;color:var(--text3)">${_T('— automatique si carton non d’origine ou mousses absentes')}</span>`, eur(k.mCar))}
    ${ligne(`${_T('Nettoyage')} : ${_e(RD_NETT[k.nett]||'')}`, eur(k.mNet))}
    ${ligne(`${_T('Pièces facturées (mauvais usage)')}`, eur(k.pf))}
    <tr><td colspan="2" style="border-top:1px solid var(--border)"></td></tr>
    ${ligne(`<b>${_T('Total à facturer HT')}</b>`, `<b style="font-size:16px;color:#7c3aed">${eur(k.total)}</b>`)}
    ${k.po>0?ligne(`<span style="color:#059669"><i class="ti ti-gift"></i> ${_T('Pièces offertes — à la charge d’Éloflex (non facturées)')}</span>`, `<span style="color:#059669">${eur(k.po)}</span>`):''}
  </table>
  ${(C.nettoyage_base===0&&C.nettoyage_complet===0)?`<div style="font-size:11.5px;color:var(--warning);margin-top:6px"><i class="ti ti-alert-triangle"></i> ${_T('Tarifs de nettoyage à 0 € : à régler dans Paramètres → Retours démo.')}</div>`:''}`;
}

// ── Enregistrement ──
function rdCollecter(){
  rdLirePieces();
  const k=rdCalc();
  return {
    modele:gv('rd-modele'), num_serie:gv('rd-serie'), distributeur_nom:gv('rd-distrib'), distributeur_email:gv('rd-distrib-email'),
    client_id:RD.client_id||null, commande_id:RD.commande_id||null, pret_id:RD.pret_id||null,
    date_reception:gv('rd-date'), transporteur:gv('rd-transp'), num_suivi:gv('rd-suivi'), receptionnaire:gv('rd-recep'),
    carton_origine:_radio('rd-carton'), mousses_presentes:_radio('rd-mousses'), etat_general:gv('rd-etat'), nettoyage:k.nett,
    commentaire:gv('rd-comment'), pieces:RD.pieces, fact_forfait_retour:k.fRet, fact_forfait_carton:k.fCar,
  };
}
async function rdEnregistrer(notifier){
  if(!RD) return null;
  if(!$('rd-modele')) return RD;   // éditeur non affiché (autre fenêtre ouverte) : rien à relire, on ne touche à rien
  const body = rdCollecter();
  if(RD.statut==='brouillon' && body.etat_general && body.carton_origine!=null && body.mousses_presentes!=null) body.statut='termine';
  const r = await API.put(`/demo-retours/${RD.id}`, body).catch(e=>{ toastErr(e); throw e; });
  const ui = { _cartonManuel: RD._cartonManuel };
  RD = Object.assign(r, ui); RD.pieces = Array.isArray(r.pieces)?r.pieces:[]; RD._dirty=false;
  const b=$('rd-statut-badge'); if(b) b.innerHTML=badgeStatut(RD.statut);
  if(notifier) toast(_T('Retour démo enregistré'),'ti-check','var(--success)');
  return RD;
}
async function rdSupprimer(){
  if(!RD || !confirm(_T('Supprimer définitivement ce compte rendu de retour et ses photos ?'))) return;
  try{ await API.delete(`/demo-retours/${RD.id}`); RD=null; closeModal(); toast(_T('Supprimé'),'ti-trash'); if(STATE.view==='retours-demo') render(); }catch(e){ toastErr(e); }
}
async function _rdCourant(id){
  // Depuis l'éditeur : on enregistre d'abord ; depuis la liste : on charge le retour.
  if(id && (!RD || RD.id!==id)) { await cfg(); return await API.get(`/demo-retours/${id}`); }
  if(RD){ await rdEnregistrer(false); return RD; }
  throw new Error('Aucun retour sélectionné');
}

// ══════════════════════════════════════════════════════════════════
// PDF (jsPDF)
// ══════════════════════════════════════════════════════════════════
async function _rdImage(rid, pid, w){
  const r = await fetch(`/api/demo-retours/${rid}/photos/${pid}/jpeg?w=${w}`);
  if(!r.ok) throw new Error('photo '+pid);
  const blob = await r.blob();
  const data = await new Promise((ok,ko)=>{ const fr=new FileReader(); fr.onload=()=>ok(fr.result); fr.onerror=ko; fr.readAsDataURL(blob); });
  const dim = await new Promise(ok=>{ const im=new Image(); im.onload=()=>ok({w:im.naturalWidth,h:im.naturalHeight}); im.onerror=()=>ok({w:4,h:3}); im.src=data; });
  return { data, ...dim };
}
async function rdGenererPdf(r, opts){
  opts = opts || {};
  const w = opts.w || 1000;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const L=15, R=195, W=R-L, BAS=282;
  const BLEU=[31,92,140];
  let y=18;
  const saut = h => { if(y+h>BAS){ doc.addPage(); y=18; } };
  const band = t => { saut(14); doc.setFillColor(...BLEU); doc.rect(L,y-4.5,W,7,'F'); doc.setTextColor(255,255,255); doc.setFontSize(10); doc.setFont('helvetica','bold'); doc.text(t,L+2,y); doc.setTextColor(0,0,0); y+=8; };
  const kv = (k,v,col) => { const lines=doc.splitTextToSize(String(v==null||v===''?'—':v), W-52); saut(lines.length*5+1); doc.setFontSize(9); doc.setFont('helvetica','bold'); doc.text(k,L,y); doc.setFont('helvetica','normal'); if(col) doc.setTextColor(...col); doc.text(lines,L+52,y); doc.setTextColor(0,0,0); y+=lines.length*4.6+1; };

  doc.setFontSize(14.5); doc.setFont('helvetica','bold'); doc.setTextColor(...BLEU);
  doc.text('COMPTE RENDU DE RETOUR — FAUTEUIL DE DÉMONSTRATION',105,y,{align:'center'}); y+=5;
  doc.setFontSize(8.5); doc.setFont('helvetica','normal'); doc.setTextColor(110,110,110);
  doc.text('ELOFLEX France — Service Après-Vente — 41 rue des Maraichers — 17140 LAGORD — sav@eloflex.fr',105,y,{align:'center'}); y+=3;
  doc.setDrawColor(...BLEU); doc.setLineWidth(0.5); doc.line(L,y,R,y); y+=6; doc.setTextColor(0,0,0);
  doc.setFontSize(9); doc.text(`Compte rendu n° RD-${r.id}`,L,y); doc.text(`Édité le ${new Date().toLocaleDateString('fr-FR')}`,R,y,{align:'right'}); y+=7;

  band('1 · FAUTEUIL & RÉCEPTION');
  kv('Modèle', _modele(r.modele));
  kv('N° de série', r.num_serie);
  kv('Distributeur', r.client_nom_actuel || r.distributeur_nom);
  kv('Date de réception', _fd(r.date_reception));
  kv('Transporteur', [r.transporteur, r.num_suivi].filter(Boolean).join(' — '));
  kv('Réceptionné par', r.receptionnaire);
  y+=2;

  band('2 · CONTRÔLE À RÉCEPTION');
  const alerte=[200,90,20];
  kv("Carton d'origine", ouiNon(r.carton_origine), r.carton_origine===false?alerte:null);
  kv('Mousses de protection', r.mousses_presentes===true?'Présentes':r.mousses_presentes===false?'Absentes':'—', r.mousses_presentes===false?alerte:null);
  kv('État général', r.etat_general, ['Abîmé','Défectueux'].includes(r.etat_general)?[190,30,30]:null);
  kv('Nettoyage', RD_NETT[r.nettoyage]||'—');
  const nbAno=(r.photos||[]).filter(p=>p.etape==='anomalie').length;
  kv('Anomalies photographiées', nbAno ? String(nbAno) : 'Aucune');
  y+=2;

  band('3 · PIÈCES À REMPLACER');
  const pieces = Array.isArray(r.pieces)?r.pieces:[];
  if(!pieces.length){ doc.setFontSize(9); doc.setFont('helvetica','italic'); doc.text('Aucune pièce à remplacer.',L,y); doc.setFont('helvetica','normal'); y+=7; }
  else{
    const X={ref:L, des:L+30, qte:L+105, pu:L+113, tot:L+148, pc:L+152};
    const entete=()=>{ doc.setFontSize(8); doc.setFont('helvetica','bold'); doc.text('Référence',X.ref,y); doc.text('Désignation',X.des,y); doc.text('Qté',X.qte,y,{align:'right'}); doc.text('PU HT',X.pu+12,y,{align:'right'}); doc.text('Total HT',X.tot,y,{align:'right'}); doc.text('Prise en charge',X.pc,y); y+=1.5; doc.setDrawColor(200,200,200); doc.setLineWidth(0.2); doc.line(L,y,R,y); y+=4; doc.setFont('helvetica','normal'); };
    entete();
    pieces.forEach(p=>{
      const des=doc.splitTextToSize(String(p.designation||''),66);
      if(y+des.length*4>BAS){ doc.addPage(); y=18; entete(); }
      doc.setFontSize(8);
      doc.text(doc.splitTextToSize(String(p.ref||''),28)[0]||'',X.ref,y); doc.text(des,X.des,y);
      doc.text(String(parseInt(p.qte)||1),X.qte,y,{align:'right'}); doc.text(eurPdf(p.pu),X.pu+12,y,{align:'right'}); doc.text(eurPdf((parseInt(p.qte)||1)*n2(p.pu)),X.tot,y,{align:'right'});
      if(p.facture===false){ doc.setTextColor(5,130,90); doc.text('Offerte (Éloflex)',X.pc,y); } else { doc.setTextColor(110,50,200); doc.text('Facturée',X.pc,y); }
      doc.setTextColor(0,0,0); y+=des.length*3.8+1.6;
    });
    y+=2;
  }

  band('4 · RÉCAPITULATIF FINANCIER (HT)');
  const lr=(k,v,b)=>{ saut(6); doc.setFontSize(9.5); doc.setFont('helvetica',b?'bold':'normal'); doc.text(k,L,y); doc.text(v,R,y,{align:'right'}); y+=5.4; };
  lr('Forfait retour fauteuil de démonstration', eurPdf(r.montant_forfait_retour));
  lr('Forfait carton / mousses de protection', eurPdf(r.montant_forfait_carton));
  lr('Nettoyage'+(r.nettoyage&&r.nettoyage!=='propre'?' ('+(RD_NETT[r.nettoyage]||'').toLowerCase()+')':''), eurPdf(r.montant_nettoyage));
  lr('Pièces facturées (remise en état)', eurPdf(r.total_pieces_facturees));
  doc.setDrawColor(...BLEU); doc.setLineWidth(0.4); doc.line(L+100,y-3,R,y-3); y+=1;
  doc.setTextColor(...BLEU); lr('TOTAL À FACTURER HT', eurPdf(r.total_facture), true); doc.setTextColor(0,0,0);
  if(n2(r.total_pieces_offertes)>0){ doc.setTextColor(5,130,90); lr("Pièces offertes — prises en charge par Éloflex (non facturées)", eurPdf(r.total_pieces_offertes)); doc.setTextColor(0,0,0); }
  y+=2;

  if(r.commentaire){
    band('5 · COMMENTAIRES');
    doc.setFontSize(9); doc.setFont('helvetica','normal');
    doc.splitTextToSize(String(r.commentaire),W).forEach(l=>{ saut(5); doc.text(l,L,y); y+=4.6; });
    y+=2;
  }

  const photos = r.photos||[];
  if(photos.length && opts.photos!==false){
    band((r.commentaire?'6':'5')+' · PHOTOS');
    for(const et of RD_ETAPES){
      const L2 = photos.filter(p=>p.etape===et.k); if(!L2.length) continue;
      saut(60); doc.setFontSize(9.5); doc.setFont('helvetica','bold'); doc.setTextColor(...(et.k==='anomalie'?[190,30,30]:BLEU));
      doc.text(et.l,L,y); doc.setTextColor(0,0,0); y+=3;
      const colW=(W-6)/2, maxH=72;
      for(let i=0;i<L2.length;i+=2){
        const pair=L2.slice(i,i+2);
        const imgs=[]; for(const p of pair){ try{ imgs.push({p, im:await _rdImage(r.id,p.id,w)}); }catch(_){ imgs.push({p, im:null}); } if(opts.progress) opts.progress(); }
        const hs=imgs.map(x=>x.im?Math.min(maxH, colW*x.im.h/x.im.w):20);
        const legH=imgs.map(x=>x.p.legende?doc.splitTextToSize(String(x.p.legende),colW).length*3.8+1:0);
        const hRow=Math.max(...hs.map((h,j)=>h+legH[j]))+5;
        if(y+hRow>BAS){ doc.addPage(); y=18; }
        imgs.forEach((x,j)=>{
          const x0=L+j*(colW+6);
          if(x.im){ let iw=colW, ih=colW*x.im.h/x.im.w; if(ih>maxH){ ih=maxH; iw=maxH*x.im.w/x.im.h; }
            try{ doc.addImage(x.im.data,'JPEG',x0,y,iw,ih); }catch(_){}
            if(x.p.legende){ doc.setFontSize(8); doc.setFont('helvetica',et.k==='anomalie'?'bold':'italic'); doc.text(doc.splitTextToSize(String(x.p.legende),colW),x0,y+ih+3.6); doc.setFont('helvetica','normal'); }
          } else { doc.setFontSize(8); doc.text('(photo indisponible)',x0,y+5); }
        });
        y+=hRow;
      }
      y+=2;
    }
  }

  const n=doc.getNumberOfPages();
  for(let i=1;i<=n;i++){ doc.setPage(i); doc.setFontSize(7.5); doc.setTextColor(140,140,140);
    doc.text(`Eloflex France — Compte rendu de retour démo RD-${r.id}${r.num_serie?' — '+r.num_serie:''}`,L,291); doc.text(`Page ${i} / ${n}`,R,291,{align:'right'}); doc.setTextColor(0,0,0); }
  return doc;
}
const _rdNomPdf = r => ('Retour_demo_'+(String(r.modele||'').replace(/^eloflex\s*/i,'')||'fauteuil')+'_'+(r.num_serie||('RD'+r.id))).replace(/[^\w\-]+/g,'_')+'.pdf';
async function rdPdfTelecharger(id){
  try{
    const r = await _rdCourant(id);
    toast(_T('Génération du PDF…'),'ti-loader-2');
    const doc = await rdGenererPdf(r);
    doc.save(_rdNomPdf(r));
  }catch(e){ toastErr(e); }
}

// ══════════════════════════════════════════════════════════════════
// Envoi par e-mail
// ══════════════════════════════════════════════════════════════════
async function rdModalEmail(id){
  let r; try{ r = await _rdCourant(id); }catch(e){ toastErr(e); return; }
  const C = await cfg();
  window._RD_ENVOI = r;
  const dEmail = r.distributeur_email || r.client_email || '';
  const ligne = (val, lbl, coche, i) => `<label style="display:flex;align-items:center;gap:8px;padding:6px 0;cursor:pointer"><input type="checkbox" class="rd-dest" value="${_e(val)}" ${coche?'checked':''} onchange="rdEmailMaj()"> <span>${lbl}</span></label>`;
  const env = r.envois||[];
  showModal(`<div class="modal-header"><i class="ti ti-send" style="color:var(--accent)"></i><h2>${_T('Envoyer le compte rendu de retour')}</h2><button class="btn sm" onclick="rdEmailFermer()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body">
      <div style="font-size:13px;color:var(--text2);margin-bottom:10px">${_e(_modele(r.modele))} ${r.num_serie?'— '+_e(r.num_serie):''} · ${_e(r.client_nom_actuel||r.distributeur_nom||'')} · ${_T('à facturer')} <b>${eur(r.total_facture)} HT</b></div>
      ${env.length?`<div style="font-size:12.5px;background:var(--bg);border-radius:8px;padding:8px 12px;margin-bottom:10px"><i class="ti ti-history"></i> ${_T('Déjà envoyé le')} ${env.slice(-3).reverse().map(x=>_fd((x.date||'').slice(0,10))+' → '+_e((x.destinataires||[]).join(', '))).join('<br>')}</div>`:''}
      ${C.emails.map(e=>ligne(e, _e(e), true)).join('')}
      ${ligne(dEmail, `${_T('Distributeur')} — <input class="form-input" id="rd-dest-distrib" style="display:inline-block;width:260px;padding:5px 8px" value="${_e(dEmail)}" placeholder="adresse@distributeur.fr" oninput="this.closest('label').querySelector('input[type=checkbox]').value=this.value;this.closest('label').querySelector('input[type=checkbox]').checked=!!this.value.trim();rdEmailMaj()" onclick="event.preventDefault();this.focus()">`, !!dEmail)}
      <label style="display:flex;align-items:center;gap:8px;padding:6px 0"><input type="checkbox" class="rd-dest" id="rd-dest-libre-cb" value="" onchange="rdEmailMaj()"> <input class="form-input" id="rd-dest-libre" style="flex:1;padding:5px 8px" placeholder="${_T('Autre adresse (facultatif)')}" oninput="$('rd-dest-libre-cb').value=this.value;$('rd-dest-libre-cb').checked=!!this.value.trim();rdEmailMaj()"></label>
      <div class="form-group" style="margin-top:8px"><label class="form-label">${_T('Message complémentaire (facultatif)')}</label><textarea class="form-input" id="rd-dest-msg" rows="2"></textarea></div>
      <div style="font-size:12px;color:var(--text3)"><i class="ti ti-paperclip"></i> ${_T('PDF joint avec les photos')} (${(r.photos||[]).length}) · ${_T('signature SAV')}</div>
      <div id="rd-dest-info" style="font-size:13px;margin-top:8px;min-height:18px"></div>
    </div>
    <div class="modal-footer"><button class="btn" onclick="rdEmailFermer()">${_T('Annuler')}</button>
      <button class="btn primary" id="rd-dest-go" onclick="rdEmailEnvoyer()"><i class="ti ti-send"></i> <span id="rd-dest-lbl">${_T('Envoyer')}</span></button></div>`);
  rdEmailMaj();
}
function _rdDests(){ return [...new Set(Array.from(document.querySelectorAll('.rd-dest')).filter(c=>c.checked).map(c=>String(c.value||'').trim().toLowerCase()).filter(Boolean))]; }
function rdEmailMaj(){ const d=_rdDests(); const l=$('rd-dest-lbl'); if(l) l.textContent=_T('Envoyer')+(d.length?' ('+d.length+')':''); const b=$('rd-dest-go'); if(b) b.disabled=!d.length; }
function rdEmailFermer(){ const r=window._RD_ENVOI; closeModal(); if(RD && r && RD.id===r.id) rdAfficher(RD); else if(STATE.view==='retours-demo') render(); }
async function rdEmailEnvoyer(){
  const r=window._RD_ENVOI, info=$('rd-dest-info'), d=_rdDests();
  const bad=d.filter(x=>!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x));
  if(bad.length){ info.innerHTML='<span style="color:var(--danger)">'+_T('Adresse invalide :')+' '+_e(bad.join(', '))+'</span>'; return; }
  const b=$('rd-dest-go'); b.disabled=true;
  try{
    const nbP=(r.photos||[]).length; let fait=0;
    const prog=()=>{ fait++; info.innerHTML='<i class="ti ti-loader-2"></i> '+_T('Préparation du PDF…')+' '+fait+'/'+nbP; };
    info.innerHTML='<i class="ti ti-loader-2"></i> '+_T('Préparation du PDF…');
    let doc = await rdGenererPdf(r,{w:1000,progress:prog});
    let data = doc.output('datauristring').split(',')[1];
    if(data.length > 12*1024*1024){ fait=0; doc = await rdGenererPdf(r,{w:650,progress:prog}); data = doc.output('datauristring').split(',')[1]; }
    info.innerHTML='<i class="ti ti-loader-2"></i> '+_T('Envoi en cours…')+' ('+Math.round(data.length*0.75/1024)+' Ko)';
    await API.post(`/demo-retours/${r.id}/envoyer`,{ destinataires:d, message:gv('rd-dest-msg'), pdf:{ nom:_rdNomPdf(r), data } });
    toast(_T('Compte rendu envoyé à')+' '+d.join(', '),'ti-mail-check','var(--success)');
    if(RD && RD.id===r.id){ RD = await API.get(`/demo-retours/${r.id}`); }
    rdEmailFermer();
  }catch(e){ b.disabled=false; info.innerHTML='<span style="color:var(--danger)">Erreur : '+_e(e.message)+'</span>'; }
}

// ══════════════════════════════════════════════════════════════════
// Facture brouillon Pennylane
// ══════════════════════════════════════════════════════════════════
async function rdDocumentPL(type, id){
  const devis = type==='devis';
  let r; try{ r = await _rdCourant(id); }catch(e){ toastErr(e); return; }
  if(n2(r.total_facture)<=0){ toast(_T('Rien à facturer (total à 0 €).'),'ti-alert-circle','var(--warning)'); return; }
  const lignes=[];
  if(n2(r.montant_forfait_retour)>0) lignes.push(['Forfait retour', r.montant_forfait_retour]);
  if(n2(r.montant_forfait_carton)>0) lignes.push(['Forfait carton / mousses', r.montant_forfait_carton]);
  if(n2(r.montant_nettoyage)>0) lignes.push([RD_NETT[r.nettoyage]||'Nettoyage', r.montant_nettoyage]);
  (r.pieces||[]).filter(p=>p.facture!==false && n2(p.pu)>0).forEach(p=>lignes.push([(p.qte>1?p.qte+' × ':'')+(p.ref?p.ref+' — ':'')+p.designation, p.qte*n2(p.pu)]));
  let force=false;
  const deja = devis ? r.pl_quote_id : r.pl_invoice_id, dejaNum = devis ? r.pl_quote_num : r.pl_invoice_num;
  if(deja){
    if(!confirm((devis?_T('Un devis a déjà été créé pour ce retour'):_T('Une facture a déjà été créée pour ce retour'))+' ('+(dejaNum||deja)+').\n'+(devis?_T('En créer un nouveau quand même ?'):_T('En créer une nouvelle quand même ?')))) return;
    force=true;
  }
  const titre = devis ? _T('Créer un DEVIS dans Pennylane pour') : _T('Créer une facture BROUILLON dans Pennylane pour');
  const fin = devis ? _T('Le devis apparaîtra ensuite dans « Devis en attente » (relances, signature).') : _T('Elle restera en brouillon : vous la vérifiez et la finalisez dans Pennylane.');
  if(!confirm(titre+' '+(r.client_nom_actuel||r.distributeur_nom||'?')+' :\n\n'+lignes.map(l=>'• '+l[0]+' : '+eur(l[1])+' HT').join('\n')+'\n\n'+_T('Total')+' : '+eur(r.total_facture)+' HT\n\n'+fin)) return;
  const win = window.open('about:blank','_blank');   // ouverte pendant le clic (sinon bloquée par le navigateur)
  toast(devis?_T('Création du devis…'):_T('Création de la facture…'),'ti-loader-2');
  try{
    const res = devis ? await API.post(`/demo-retours/${r.id}/devis-pennylane`,{force}) : await API.post(`/demo-retours/${r.id}/facture-pennylane`,{force});
    toast((devis?_T('Devis créé'):_T('Facture brouillon créée'))+' : '+(res.numero||''),devis?'ti-file-text':'ti-file-euro','var(--success)');
    if(res.url){ if(win && !win.closed) win.location.href=res.url; else window.open(res.url,'_blank','noopener'); } else if(win) win.close();
    if(RD && RD.id===r.id) rdAfficher(await API.get(`/demo-retours/${r.id}`)); else if(STATE.view==='retours-demo') render();
  }catch(e){ if(win) win.close(); toastErr(e); }
}
const rdFacture = id => rdDocumentPL('facture', id);
const rdDevis = id => rdDocumentPL('devis', id);

Object.assign(window, {
  renderRetoursDemo, rdFiltrer, rdNouveau, rdOuvrir, rdFermer, rdDirty, rdDistribSaisie, rdChercherSerie,
  rdUpload, rdPhotoSuppr, rdPhotoLegende, rdCtrlChange, rdPieceRecherche, rdPieceChoisir, rdPieceAjouter,
  rdPiecesMaj, rdPieceRetirer, rdRecap, rdEnregistrer, rdSupprimer, rdPdfTelecharger, rdModalEmail, rdEmailMaj,
  rdEmailFermer, rdEmailEnvoyer, rdFacture, rdDevis, rdGenererPdf,
  rdResetCfg: ()=>{ RD_CFG=null; },
});
})();
