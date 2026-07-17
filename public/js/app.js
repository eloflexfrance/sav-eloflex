// public/js/app.js v2

let STATE = { view:'dashboard', clientId:null, fauteuilId:null, q:'' };
let CMD_FILTERS = { annee:'', mois:'', statut:'', groupe:'', distributeur:'', q:'' };
// Colonnes visibles en Suivi commandes (persistées en localStorage)
const CMD_COLS_DEFAULT = { facture: false, date_facture: false, demo_origine: false, edi: false, pays: false, retour: false, date_retour: false };
// Merge stored prefs with defaults — nouvelles colonnes héritent de false si absentes du stockage
let CMD_COLS = { ...CMD_COLS_DEFAULT, ...JSON.parse(localStorage.getItem('sav_cmd_cols') || '{}') };
let CACHE = { catalogue:[], params:{} };
let TMP_PRODUITS = [];
let CURRENT_USER = null; // Chargé au démarrage via /api/auth/me

const fd  = d => { if(!d)return'—'; const[y,m,day]=d.split('-'); return`${day}/${m}/${y}`; };
const moisLabel = ym => {
  const[y,m]=ym.split('-');
  const namesFr=['Jan','Fév','Mar','Avr','Mai','Juin','Juil','Aoû','Sep','Oct','Nov','Déc'];
  const namesEn=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const names=(typeof LANG!=='undefined'&&LANG==='en')?namesEn:namesFr;
  return `${names[parseInt(m,10)-1]} ${y.slice(2)}`;
};
const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const sc  = s => s===t('inter_statut_ouvert')?'ouvert':s===t('inter_statut_ferme')?'ferme':s===t('inter_statut_attente')?'attente':'ouvert';
const $   = id => document.getElementById(id);
const gv  = id => ($( id)||{}).value||'';

// ── Rôle utilisateur ────────────────────────────────────────────────
// Filtre pays actif pour les admins globaux (persisté en localStorage)
let _PAYS_FILTRE = localStorage.getItem('sav_pays_filtre') || '';
function setPaysFiltre(pays){
  _PAYS_FILTRE = pays;
  if(pays) localStorage.setItem('sav_pays_filtre', pays);
  else localStorage.removeItem('sav_pays_filtre');
  renderTopbarPays();
  render();
}

const PAYS_LIST = [
  { code:'',          flag:'🌍', label:'Tous' },
  { code:'France',    flag:'🇫🇷', label:'France' },
  { code:'Sweden',    flag:'🇸🇪', label:'Suède' },
  { code:'UK',        flag:'🇬🇧', label:'UK' },
  { code:'Germany',   flag:'🇩🇪', label:'DE' },
  { code:'Spain',     flag:'🇪🇸', label:'ES' },
  { code:'Belgium',   flag:'🇧🇪', label:'BE' },
  { code:'Switzerland',flag:'🇨🇭',label:'CH' },
  { code:'Netherlands',flag:'🇳🇱',label:'NL' },
];

const isAdmin  = () => CURRENT_USER?.role === 'admin';

// Modules de l'application (dans l'ordre d'affichage)
const MODULES = [
  { key:'dashboard',     label:'Tableau de bord' },
  { key:'clients',       label:'Clients / Distributeurs' },
  { key:'interventions', label:'Interventions SAV' },
  { key:'expeditions',   label:'Expéditions SAV' },
  { key:'commandes',     label:'Suivi commandes' },
  { key:'catalogue',     label:'Catalogue pièces' },
  { key:'rapports',      label:'Rapports & exports' },
  { key:'alertes',       label:'Alertes' },
  { key:'retours_suede', label:'Retours Suède' },
  { key:'transferts',    label:'Transferts fauteuils' },
  { key:'devis',         label:'Devis VosFactures' },
  { key:'parametres',    label:'Paramètres' },
];

// Modules qui héritent d'un autre module si non défini explicitement
const PERM_FALLBACK = {
  'devis':      'commandes',   // Devis hérite de commandes
  'dashboard':  'commandes',   // Tableau de bord toujours accessible si commandes
};

function hasAccess(module) {
  if (isAdmin()) return true;
  const perms = CURRENT_USER?.permissions || {};
  let p = perms[module];
  // Si la clé n'existe pas (module ajouté après la création du compte)
  // → on utilise le module parent comme fallback
  if (p === undefined && PERM_FALLBACK[module]) {
    p = perms[PERM_FALLBACK[module]];
  }
  return p === 'write' || p === 'read';
}
function canWrite(module) {
  if (isAdmin()) return true;
  return (CURRENT_USER?.permissions || {})[module] === 'write';
}
// Rétrocompatibilité (générique sans module)
const isOp = () => isAdmin() || Object.values(CURRENT_USER?.permissions || {}).includes('write');

async function seDeconnecter(){
  if(!confirm('Se déconnecter ?')) return;
  await fetch('/api/auth/logout', { method:'POST' });
  window.location.href = '/login';
}

function toast(msg,icon='ti-check',color=''){
  $('toast-area').innerHTML=`<div class="toast" style="${color?'background:'+color:''}">${icon?`<i class="ti ${icon}"></i>`:''} ${esc(msg)}</div>`;
  setTimeout(()=>{$('toast-area').innerHTML='';},3000);
}
function showModal(html){$('modal-area').innerHTML=`<div class="modal-overlay" onclick="if(event.target===this)closeModal()"><div class="modal">${html}</div></div>`;}
function closeModal(){$('modal-area').innerHTML='';}

// ── Dark mode ─────────────────────────────────────────────────────
function toggleDark(){
  document.body.classList.toggle('dark');
  localStorage.setItem('dark', document.body.classList.contains('dark')?'1':'0');
  CACHE.params.mode_sombre = document.body.classList.contains('dark')?'1':'0';
  API.saveParametres({mode_sombre: CACHE.params.mode_sombre}).catch(()=>{});
}
if(localStorage.getItem('dark')==='1') document.body.classList.add('dark');

// ── Navigation (filtrée par rôle) ────────────────────────────────
const NAV_ROLES = {
  operateur:    ['dashboard','clients','interventions','expeditions','commandes','catalogue','alertes','retours_suede','transferts'],
  consultation: ['dashboard'],
};

function appliquerNavRole(){
  if(!CURRENT_USER) return;
  document.querySelectorAll('.nav-item[data-view]').forEach(n => {
    n.style.display = hasAccess(n.dataset.view) ? '' : 'none';
  });
  const userZone = $('user-zone');
  if(userZone) userZone.innerHTML = `
    <span style="font-size:11px;color:var(--text2);flex:1">${esc(CURRENT_USER.nom)}</span>
    ${CURRENT_USER.pays?`<span style="font-size:11px;padding:2px 7px;border-radius:10px;background:var(--accent-soft,rgba(59,130,246,.12));color:var(--accent);font-weight:600">${esc(CURRENT_USER.pays)}</span>`:''}
    <div id="pays-switcher" style="display:flex"></div>
    <button class="btn sm" onclick="seDeconnecter()" title="Se déconnecter" style="padding:4px 8px"><i class="ti ti-logout"></i></button>`;
}

function setView(v, extra={}){
  if(!hasAccess(v)) return;
  // Réinitialiser les recherches locales quand on change de vue
  if(v !== 'clients')   window._clientsQ = '';
  if(v !== 'catalogue') { STATE.q = ''; }
  STATE={view:v, clientId:extra.clientId||null, fauteuilId:extra.fauteuilId||null, q:''};
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.toggle('active', n.dataset.view===v));
  render();
}
document.querySelectorAll('.nav-item').forEach(n=>n.addEventListener('click',()=>setView(n.dataset.view)));


async function render(){
  const ttl=$('topbar-title'),c=$('content'),a=$('topbar-actions');
  a.innerHTML='';
  c.innerHTML=`<div class="empty" style="padding-top:60px"><i class="ti ti-loader-2" style="font-size:28px;display:block;margin-bottom:8px"></i>${t('msg_chargement')}</div>`;
  try{
    if(STATE.view==='dashboard')     await renderDashboard(ttl,c,a);
    else if(STATE.view==='clients')  await renderClients(ttl,c,a);
    else if(STATE.view==='client')   await renderClient(ttl,c,a);
    else if(STATE.view==='devis')    await renderDevis(ttl,c,a);
    else if(STATE.view==='fauteuil') await renderFauteuil(ttl,c,a);
    else if(STATE.view==='interventions') await renderInterventions(ttl,c,a);
    else if(STATE.view==='expeditions')   await renderExpeditions(ttl,c,a);
    else if(STATE.view==='commandes')     await renderCommandes(ttl,c,a);
    else if(STATE.view==='catalogue')     await renderCatalogue(ttl,c,a);
    else if(STATE.view==='rapports')      await renderRapports(ttl,c,a);
    else if(STATE.view==='alertes')       await renderAlertes(ttl,c,a);
    else if(STATE.view==='parametres')    await renderParametres(ttl,c,a);
    else if(STATE.view==='retours-suede')  await renderRetoursSuede(ttl,c,a);
    else if(STATE.view==='transferts')     await renderTransferts(ttl,c,a);
  }catch(e){c.innerHTML=`<div class="empty"><i class="ti ti-alert-circle"></i>Erreur : ${esc(e.message)}</div>`;}
}

// ── Badges ────────────────────────────────────────────────────────
async function refreshBadges(){
  try{
    const[alertes,exp,cat]=await Promise.all([API.alertes(),API.expeditions(),API.catalogue()]);
    const nb=alertes.length;
    const bdot=$('badge-alertes'); if(bdot){bdot.style.display=nb>0?'block':'none';}
    const bexp=$('badge-exp'); if(bexp){bexp.style.display=exp.length>0?'inline-flex':'none';bexp.textContent=exp.length;}
    const bstock=$('badge-stock'); const nbs=cat.filter(p=>p.stock<=p.stock_alerte).length;
    if(bstock){bstock.style.display=nbs>0?'inline-flex':'none';bstock.textContent=nbs;}
  }catch(e){}
}

// ── DASHBOARD ────────────────────────────────────────────────────

async function renderDashboard(ttl,c,a){
  ttl.textContent=t('nav_dashboard');
  const{stats:s,recentes}=await API.stats();
  c.innerHTML=`
    <div class="quick-search-bar">
      <div style="position:relative;flex:1;max-width:560px">
        <i class="ti ti-search" style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--text3);font-size:16px;pointer-events:none"></i>
        <input class="form-input" id="qs-input" placeholder="${t('qs_placeholder')}"
          style="padding-left:34px;font-size:14px;border-radius:10px"
          oninput="quickSearch(this.value)"
          onkeydown="if(event.key==='Escape'){this.value='';clearQuickSearch();}">
        <div id="qs-results" class="qs-results" style="display:none"></div>
      </div>
    </div>
    <div class="card" style="margin-bottom:14px">
      <div class="section-title"><i class="ti ti-clipboard-list"></i>${t('cmd_title')||'Suivi des commandes'}
        <button class="btn sm" style="margin-left:auto" onclick="setView('commandes')"><i class="ti ti-arrow-right"></i>${t('cmd_voir_tout')||'Voir toutes les commandes'}</button>
      </div>
      <div id="dash-commandes">${t('msg_chargement')}</div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin-bottom:12px">
      <div class="stat-card"><div class="stat-label">${t('db_interventions')}</div><div class="stat-value">${s.nb_interventions}</div></div>
      <div class="stat-card"><div class="stat-label">${t('db_ouvertes')}</div><div class="stat-value" style="color:var(--accent)">${s.ouvert}</div></div>
      <div class="stat-card"><div class="stat-label">${t('db_attente')}</div><div class="stat-value" style="color:var(--warning)">${s.attente}</div></div>
      <div class="stat-card"><div class="stat-label">${t('db_expeditions')}</div><div class="stat-value" style="color:var(--accent)">${s.expeditions_cours}</div></div>
    </div>
    <div class="grid-4" style="margin-bottom:14px">
      <div class="stat-card"><div class="stat-label">${t('db_garantie')}</div><div class="stat-value" style="color:var(--success)">${s.garantie}</div></div>
      <div class="stat-card"><div class="stat-label">${t('db_hors_garantie')}</div><div class="stat-value" style="color:var(--warning)">${s.hors_garantie}</div></div>
      <div class="stat-card"><div class="stat-label">${t('db_pieces_alerte')}</div><div class="stat-value" style="color:${s.pieces_alerte>0?'var(--danger)':'var(--text)'}">${s.pieces_alerte}</div></div>
      <div class="stat-card" style="cursor:pointer" onclick="setView('alertes')"><div class="stat-label">${t('db_alertes')}</div><div class="stat-value" style="color:${s.alertes_non_lues>0?'var(--danger)':'var(--text)'}">${s.alertes_non_lues}</div></div>
    </div>
    <div class="card">
      <div class="section-title"><i class="ti ti-tool"></i>${t('db_activites')}</div>
      <div class="table-wrap"><table class="t">
        <thead><tr><th>N° SAV</th><th>${t('col_date')}</th><th>${t('col_client')}</th><th>${t('col_modele')}</th><th>${t('col_type')}</th><th>${t('col_garantie')}</th><th>${t('col_statut')}</th></tr></thead>
        <tbody>${recentes.map(i=>`<tr onclick="viewIntervention(${i.id})">
          <td class="mono" style="color:var(--accent);font-size:11px">${esc(i.num_sav||'—')}</td><td>${fd(i.date)}</td><td>${esc(i.client_nom)}</td>
          <td><div>${esc(i.modele)}</div><div class="mono" style="color:var(--text3)">${esc(i.serie)}</div></td>
          <td>${traduireType(i.type)}</td>
          <td><span class="badge ${i.garantie?'g':'hg'}">${i.garantie?t('badge_garantie'):t('garantie_expiree')}</span></td>
          <td><span class="badge ${sc(i.statut)}">${traduireStatut(i.statut)}</span></td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>
    <div class="card" style="margin-top:14px">
      <div class="section-title"><i class="ti ti-arrows-exchange"></i>${t('transferts_en_cours')}
        <button class="btn sm" style="margin-left:auto" onclick="setView('transferts')"><i class="ti ti-arrow-right"></i>${t('transferts_voir_tout')}</button>
      </div>
      <div id="dash-transferts">${t('msg_chargement')}</div>
    </div>`;
  chargerTransfertsDashboard();
  chargerCommandesDashboard();
}

async function chargerCommandesDashboard(){
  const el=document.getElementById('dash-commandes');
  if(!el) return;
  // Masquer la carte si l'utilisateur a ce module en "Masquée"
  if(!isAdmin() && !hasAccess('commandes')){
    el.closest('.card')?.remove(); return;
  }
  const anneeEnCours = new Date().getFullYear();
  try{
    const [stats, res] = await Promise.all([
      API.commandesStats(anneeEnCours),
      API.commandes({ per_page: 10 })
    ]);
    const list = res.rows||[];
    el.innerHTML=`
      <div style="font-size:11px;color:var(--text2);margin-bottom:8px;font-weight:600;text-transform:uppercase;letter-spacing:.04em">Année ${anneeEnCours}</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin-bottom:14px">
        <div class="stat-card"><div class="stat-label">${t('cmd_total')||'Total'}</div><div class="stat-value">${stats.total}</div></div>
        <div class="stat-card"><div class="stat-label">🦽 Avec N° série</div><div class="stat-value" style="color:var(--accent)">${stats.fauteuils_serie||0}</div></div>
        <div class="stat-card"><div class="stat-label">⏳ En attente</div><div class="stat-value">${stats.en_attente||0}</div></div>
        <div class="stat-card"><div class="stat-label">${t('cmd_en_prep')||'En préparation'}</div><div class="stat-value" style="color:var(--danger)">${stats.en_preparation}</div></div>
        <div class="stat-card"><div class="stat-label">${t('cmd_expedie')||'Expédié'}</div><div class="stat-value" style="color:var(--warning)">${stats.expedie}</div></div>
        <div class="stat-card"><div class="stat-label">${t('cmd_livre')||'Livré'}</div><div class="stat-value" style="color:var(--success)">${stats.livre}</div></div>
        <div class="stat-card"><div class="stat-label">${t('cmd_facture_statut')||'Facturé'}</div><div class="stat-value" style="color:var(--accent)">${stats.facture||0}</div></div>
        <div class="stat-card"><div class="stat-label">🔄 ${t('cmd_demo_count')||'Démos'}</div><div class="stat-value" style="color:var(--warning)">${stats.demo||0}</div></div>
        <div class="stat-card"><div class="stat-label">${t('cmd_probleme')||'Problème'}</div><div class="stat-value" style="color:${stats.probleme>0?'var(--danger)':'var(--text)'}">${stats.probleme}</div></div>
      </div>
      ${!list.length?`<div style="font-size:12px;color:var(--text3)">${t('cmd_empty')||'Aucune commande trouvée'}</div>`:`
      <div class="table-wrap"><table class="t">
        <thead><tr>
          <th>${t('col_date')||'Date'}</th>
          <th style="width:80px">Groupe</th>
          <th>${t('col_client')||'Distributeur'}</th>
          <th>${t('cmd_bdc')||'Bdc'}</th>
          <th>${t('cmd_modele')||'Modèle / Pièce'}</th>
          <th style="max-width:110px">${t('cmd_suivi')||'N° suivi'}</th>
          <th>${t('col_statut')||'Statut'}</th>
        </tr></thead>
        <tbody>${list.map(cm=>{
          const lien = lienSuiviColis(cm.transporteur, cm.num_suivi);
          return `<tr onclick="modalCommande(${cm.id})" style="cursor:pointer">
            <td>${fd(cm.date_commande)}</td>
            <td><span style="font-size:11px;color:var(--text2)">${esc(cm.groupe||'')}</span></td>
            <td>${esc(cm.distributeur_nom)}</td>
            <td class="mono">${esc(cm.bdc||'')}${cm.num_commande_distrib?` <span style="color:var(--text3);font-size:11px">(${esc(cm.num_commande_distrib)})</span>`:''}</td>
            <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(cm.modele||(cm.accessoire||'').split('\n')[0]||'')}">${esc(cm.modele||(cm.accessoire||'').split('\n')[0]||'')}</td>
            <td class="mono" style="max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(cm.num_suivi||'')}${lien?` <a href="${lien}" target="_blank" rel="noopener" onclick="event.stopPropagation()"><i class="ti ti-external-link" style="color:var(--accent)"></i></a>`:''}</td>
            <td><span class="badge ${cmdStatutClass(cm.statut_calc)}">${esc(tStatut(cm.statut_calc))}</span></td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>`}`;
  }catch(e){ el.innerHTML=`<div style="font-size:12px;color:var(--danger)">${esc(e.message)}</div>`; }
}

async function chargerTransfertsDashboard(){  const el=document.getElementById('dash-transferts');
  if(!el) return;
  if(!isAdmin() && !hasAccess('transferts')){
    el.closest('.card')?.remove(); return;
  }
  try{
    const list=(await API.transferts()).filter(tr=>tr.statut!=='Arrivé'&&tr.statut!=='Annulé');
    if(!list.length){ el.innerHTML=`<div style="font-size:12px;color:var(--text3)">${t('transferts_empty')}</div>`; return; }
    const scT={'En préparation':'attente','En transit':'ouvert'};
    const stTr={'En préparation':t('transferts_statut_prep'),'En transit':t('transferts_statut_transit')};
    el.innerHTML=`<div class="table-wrap"><table class="t">
      <thead><tr><th>${t('transferts_fauteuil')}</th><th>${t('transferts_depart')}</th><th>${t('transferts_arrivee')}</th><th>${t('transferts_num_suivi')}</th><th>${t('col_statut')}</th></tr></thead>
      <tbody>${list.slice(0,5).map(tr=>`<tr onclick="modalTransfert(${tr.id})" style="cursor:pointer">
        <td><div>${esc(tr.modele||'')}</div><div class="mono" style="color:var(--text3);font-size:11px">${esc(tr.serie||'')}</div></td>
        <td>${esc(tr.client_depart_nom||'—')}</td>
        <td>${esc(tr.client_arrivee_nom||'—')}</td>
        <td class="mono" style="font-size:11px">${esc(tr.num_suivi||'—')}</td>
        <td><span class="badge ${scT[tr.statut]||''}">${stTr[tr.statut]||esc(tr.statut)}</span></td>
      </tr>`).join('')}</tbody>
    </table></div>`;
  }catch(e){ el.innerHTML=`<div style="font-size:12px;color:var(--danger)">${esc(e.message)}</div>`; }
}

// ── CLIENTS ───────────────────────────────────────────────────────

async function renderClients(ttl,c,a){
  ttl.textContent=t('nav_clients');
  if(!window._clientsQ) window._clientsQ = '';
  a.innerHTML=`<div style="display:flex;gap:8px;align-items:center">
    <input id="clients-search" class="search-bar" placeholder="${t('cat_search')||'Rechercher…'}" value="${esc(window._clientsQ)}" style="max-width:260px">
    <button class="btn primary" onclick="modalNewClient()"><i class="ti ti-plus"></i>${t('clients_new')}</button>
  </div>`;
  document.getElementById('clients-search')?.addEventListener('input', e => {
    window._clientsQ = e.target.value;
    clearTimeout(window._CLT); window._CLT = setTimeout(() => chargerListeClients(), 250);
  });
  c.innerHTML=`<div id="clients-list-body"><div style="color:var(--text2);font-size:13px;padding:20px 0">${t('msg_chargement')}</div></div>`;
  chargerListeClients();
}

let _clientsReqId = 0;
async function chargerListeClients(){
  const el = document.getElementById('clients-list-body'); if(!el) return;
  const reqId = ++_clientsReqId;
  const list = await API.clients(window._clientsQ||'');
  if(reqId !== _clientsReqId) return; // réponse périmée — une requête plus récente a pris le relais
  el.innerHTML=`<div class="table-wrap"><table class="t">
    <thead><tr><th>${t('col_distributeur')}</th><th>${t('col_contact')}</th><th>${t('col_ville')}</th><th>${t('col_fauteuils')}</th><th>${t('col_interventions')}</th><th></th></tr></thead>
    <tbody>${list.map(cl=>`<tr onclick="setView('client',{clientId:${cl.id}})">
      <td><div style="font-weight:600">${esc(cl.nom)}</div><div style="font-size:11px;color:var(--text3)">${esc(cl.type)}</div></td>
      <td><div>${esc(cl.contact||'')}</div><div style="font-size:11px;color:var(--text3)">${esc(cl.email||'')}</div></td>
      <td>${esc(cl.ville||'')}</td><td>${cl.nb_fauteuils}</td><td>${cl.nb_interventions}</td>
      <td><button class="btn sm" onclick="event.stopPropagation();setView('client',{clientId:${cl.id}})"><i class="ti ti-arrow-right"></i></button></td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

async function renderClient(ttl,c,a){
  const cl=await API.client(STATE.clientId);
  ttl.textContent=cl.nom;
  a.innerHTML=`
    <button class="btn sm success" onclick="exportClientPDF(${cl.id})"><i class="ti ti-file-type-pdf"></i>PDF</button>
    <button class="btn sm" onclick="modalPortail(${cl.id},'${cl.token_portail||''}')"><i class="ti ti-link"></i>Portail</button>
    <button class="btn sm" onclick="modalNewFauteuil(${cl.id})"><i class="ti ti-plus"></i>Fauteuil</button>
    <button class="btn sm primary" onclick="modalNewIntervention(null,${cl.id})"><i class="ti ti-plus"></i>Intervention</button>`;
  const s=cl.stats||{};
  c.innerHTML=`
    <div class="breadcrumb"><span onclick="setView('clients')">Clients</span><i class="ti ti-chevron-right" style="font-size:11px"></i>${esc(cl.nom)}</div>
    <div class="grid-2" style="margin-bottom:12px">
      <div class="card">
        <div class="section-title"><i class="ti ti-user"></i>Fiche distributeur</div>
        <table style="width:100%;font-size:12px">
          ${[['Contact',cl.contact],['Email',cl.email],['Téléphone',cl.tel],['Ville',cl.ville],['Type',cl.type]].map(([k,v])=>`<tr><td style="color:var(--text3);padding:3px 0;width:100px">${k}</td><td style="font-weight:500">${esc(v||'—')}</td></tr>`).join('')}
          ${cl.edi?`<tr><td style="color:var(--text3);padding:3px 0;width:100px">Paiement</td><td><span class="badge ouvert">💳 EDI — Prélèvement</span></td></tr>`:''}
        </table>
        <div style="margin-top:10px;display:flex;gap:6px">
          <button class="btn sm" onclick="modalEditClient(${cl.id})"><i class="ti ti-edit"></i>${t('btn_modifier')}</button>
        </div>
      </div>
      <div class="card">
        <div class="section-title"><i class="ti ti-chart-bar"></i>Bilan SAV</div>
        <div class="grid-2">
          <div class="stat-card"><div class="stat-label">Sous garantie</div><div class="stat-value" style="color:var(--success)">${s.garantie||0}</div></div>
          <div class="stat-card"><div class="stat-label">Hors garantie</div><div class="stat-value" style="color:var(--warning)">${s.hors_garantie||0}</div></div>
          <div class="stat-card"><div class="stat-label">Total</div><div class="stat-value">${s.total||0}</div></div>
          <div class="stat-card"><div class="stat-label">Ouvertes</div><div class="stat-value" style="color:var(--accent)">${s.ouvert||0}</div></div>
        </div>
      </div>
    </div>
    <div class="section-title" style="margin-bottom:8px"><i class="ti ti-wheelchair"></i>Fauteuils (${cl.fauteuils.length})</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px">
      ${cl.fauteuils.length===0?`<div class="empty"><i class="ti ti-wheelchair"></i>${t('msg_aucun_fauteuil')}</div>`:cl.fauteuils.map(f=>`
        <div class="fauteuil-card" onclick="setView('fauteuil',{fauteuilId:${f.id},clientId:${cl.id}})">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px">
            <div style="font-weight:700;font-size:13px"><i class="ti ti-wheelchair" style="font-size:13px;margin-right:3px"></i>${esc(f.modele)}</div>
            <button class="btn sm" onclick="event.stopPropagation();exportFauteuilPDF(${f.id})"><i class="ti ti-file-type-pdf"></i></button>
          </div>
          <div style="font-size:11px;color:var(--text3)">Série : <span class="mono">${esc(f.serie)}</span></div>
          <div style="font-size:11px;color:var(--text3)">Année : ${f.annee||'—'}</div>
          ${f.date_achat?`<div style="font-size:11px;color:var(--text3)">Achat : ${fd(f.date_achat)}</div>`:''}
          ${f.num_facture?`<div style="font-size:11px;margin:3px 0;display:flex;align-items:center;gap:4px"><i class="ti ti-receipt" style="font-size:12px;color:var(--accent)"></i><span style="color:var(--accent)" class="mono">${esc(f.num_facture)}</span></div>`:''}
          <div style="margin-top:6px">${garantieChip(f)}</div>
          <div style="display:flex;gap:5px;margin-top:6px">
            <span class="badge g">${f.nb_garantie||0} garantie</span>
            <span class="badge hg">${(f.nb_interventions||0)-(f.nb_garantie||0)} HG</span>
          </div>
        </div>`).join('')}
    </div>
    <div class="section-title" style="margin:16px 0 8px"><i class="ti ti-clipboard-list"></i>Commandes</div>
    <div id="client-commandes-list" style="margin-bottom:20px"><div style="font-size:12px;color:var(--text2)"><i class="ti ti-loader-2"></i> Chargement…</div></div>`;
  chargerCommandesClient(cl.nom);
}

async function chargerCommandesClient(distribNom){
  const el = document.getElementById('client-commandes-list'); if(!el) return;
  try{
    const res = await API.commandes({ distributeur: distribNom, per_page: 200 });
    const list = res.rows||[];
    if(!list.length){
      el.innerHTML=`<div style="font-size:12px;color:var(--text3)">Aucune commande pour ce distributeur.</div>`;
      return;
    }
    el.innerHTML=`<div class="table-wrap"><table class="t">
      <thead><tr>
        <th>${t('col_date')||'Date'}</th>
        <th>${t('cmd_bdc')||'Bdc'}</th>
        <th>${t('cmd_modele')||'Modèle / Pièce'}</th>
        <th>${t('cmd_suivi')||'N° suivi'}</th>
        <th>N° série</th>
        <th>${t('col_statut')||'Statut'}</th>
      </tr></thead>
      <tbody>${list.map(cm=>{
        const lien = lienSuiviColis(cm.transporteur, cm.num_suivi);
        return `<tr onclick="modalCommande(${cm.id})" style="cursor:pointer">
          <td>${fd(cm.date_commande)}</td>
          <td class="mono">${esc(cm.bdc||'')}${cm.num_commande_distrib?` <span style="color:var(--text3);font-size:11px">(${esc(cm.num_commande_distrib)})</span>`:''}</td>
          <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(cm.modele||(cm.accessoire||'').split('\n')[0]||'')}${cm.modele_demo?` <span class="badge hg" style="font-size:10px">🔄 ${t('cmd_demo_badge')||'Démo'}</span>`:''}</td>
          <td class="mono">${esc(cm.num_suivi||'')}${lien?` <a href="${lien}" target="_blank" rel="noopener" onclick="event.stopPropagation()"><i class="ti ti-external-link" style="color:var(--accent)"></i></a>`:''}</td>
          <td class="mono">${esc(cm.num_serie||'')}</td>
          <td><span class="badge ${cmdStatutClass(cm.statut_calc)}">${esc(tStatut(cm.statut_calc))}</span>${cm.reliquat?` <i class="ti ti-clock-exclamation" style="color:var(--warning)" title="Reliquat"></i>`:''}${cm.informations?` <i class="ti ti-info-circle" style="color:var(--accent)" title="${esc(cm.informations)}"></i>`:''}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;
  }catch(e){ el.innerHTML=`<div style="font-size:12px;color:var(--danger)">${esc(e.message)}</div>`; }
}

function garantieChip(f){
  if(!f.date_achat||!f.duree_garantie_mois) return '<span class="garantie-chip unknown">Garantie inconnue</span>';
  if(f.garantie_active===true||f.garantie_active===null){
    const exp=new Date(f.date_achat); exp.setMonth(exp.getMonth()+(f.duree_garantie_mois||24));
    const j=Math.ceil((exp-new Date())/86400000);
    if(f.garantie_active===null||j>0) return `<span class="garantie-chip active"><i class="ti ti-shield-check" style="font-size:12px"></i>Garantie active (${j>0?j+' j':fd(exp.toISOString().slice(0,10))})</span>`;
  }
  const exp=new Date(f.date_achat); exp.setMonth(exp.getMonth()+(f.duree_garantie_mois||24));
  return `<span class="garantie-chip expired"><i class="ti ti-shield-x" style="font-size:12px"></i>Garantie expirée le ${fd(exp.toISOString().slice(0,10))}</span>`;
}

async function renderFauteuil(ttl,c,a){
  const f=await API.fauteuil(STATE.fauteuilId);
  const inters=f.interventions||[];
  ttl.textContent=`${f.modele} — ${f.serie}`;
  a.innerHTML=`
    <button class="btn sm success" onclick="exportFauteuilPDF(${f.id})"><i class="ti ti-file-type-pdf"></i>PDF</button>
    <button class="btn sm" onclick="modalEditFauteuil(${f.id})"><i class="ti ti-edit"></i>${t('btn_modifier')}</button>
    <button class="btn sm primary" onclick="modalNewIntervention(${f.id},${f.client_id})"><i class="ti ti-plus"></i>Intervention</button>`;
  c.innerHTML=`
    <div class="breadcrumb">
      <span onclick="setView('clients')">Clients</span>
      <i class="ti ti-chevron-right" style="font-size:11px"></i>
      <span onclick="setView('client',{clientId:${f.client_id}})">${esc(f.client_nom)}</span>
      <i class="ti ti-chevron-right" style="font-size:11px"></i>${esc(f.modele)}
    </div>
    <div class="grid-2" style="margin-bottom:12px">
      <div class="card">
        <div class="section-title"><i class="ti ti-wheelchair"></i>Fauteuil</div>
        <table style="width:100%;font-size:12px">
          ${[['Modèle',f.modele],['N° de série',f.serie],['Année',f.annee],['Couleur',f.couleur]].map(([k,v])=>`<tr><td style="color:var(--text3);padding:3px 0;width:110px">${k}</td><td style="font-weight:500">${esc(String(v||'—'))}</td></tr>`).join('')}
          ${f.date_achat?`<tr><td style="color:var(--text3);padding:3px 0">Date d'achat</td><td>${fd(f.date_achat)}</td></tr>`:''}
          ${f.num_facture?`<tr><td style="color:var(--text3);padding:3px 0">Facture</td><td><span class="mono" style="color:var(--accent)">${esc(f.num_facture)}</span></td></tr>`:''}
          <tr><td style="color:var(--text3);padding:3px 0">Garantie</td><td>${garantieChip(f)}</td></tr>
        </table>
      </div>
      <div class="card">
        <div class="section-title"><i class="ti ti-chart-bar"></i>Historique SAV</div>
        <div class="grid-2">
          <div class="stat-card"><div class="stat-label">Total</div><div class="stat-value">${inters.length}</div></div>
          <div class="stat-card"><div class="stat-label">Garantie</div><div class="stat-value" style="color:var(--success)">${inters.filter(i=>i.garantie).length}</div></div>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="section-title"><i class="ti ti-tool"></i>Interventions (${inters.length})</div>
      ${inters.length===0?`<div class="empty"><i class="ti ti-tool"></i>${t('msg_aucune_inter')}</div>`:inters.map(i=>`
        <div style="padding:10px;border-bottom:0.5px solid var(--border);cursor:pointer" onclick="viewIntervention(${i.id})" onmouseover="this.style.background='var(--bg)'" onmouseout="this.style.background=''">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;flex-wrap:wrap">
            <span style="font-weight:700;font-size:13px">${traduireType(i.type)}</span>
            <span class="badge ${i.garantie?'g':'hg'}">${i.garantie?t('badge_garantie'):t('garantie_expiree')}</span>
            <span class="badge ${sc(i.statut)}">${traduireStatut(i.statut)}</span>
            <span style="margin-left:auto;font-size:11px;color:var(--text3)">${fd(i.date)}</span>
          </div>
          <div style="font-size:12px;color:var(--text2)">${esc(i.description||'')}</div>
          <div style="font-size:11px;color:var(--text3);margin-top:3px;display:flex;gap:10px;flex-wrap:wrap">
            <span>${i.produits?.length||0} pièce${(i.produits?.length||0)!==1?'s':''}</span>
            ${i.nb_photos?`<span><i class="ti ti-photo" style="font-size:11px"></i> ${i.nb_photos} photo${i.nb_photos>1?'s':''}</span>`:''}
            ${i.nb_commentaires?`<span><i class="ti ti-message" style="font-size:11px"></i> ${i.nb_commentaires}</span>`:''}
            ${i.envoi_numero?`<span><i class="ti ti-send" style="font-size:11px"></i> ${esc(i.envoi_numero)}</span>`:''}
          </div>
        </div>`).join('')}
    </div>`;
}

// ── INTERVENTIONS ─────────────────────────────────────────────────

async function renderInterventions(ttl,c,a){
  ttl.textContent=t('nav_interventions');
  a.innerHTML=`
    <input class="search-bar" placeholder=""+t('cat_search')+"" value="${esc(STATE.q)}" oninput="STATE.q=this.value;renderInterventions(document.getElementById('topbar-title'),document.getElementById('content'),document.getElementById('topbar-actions'))">
    <select class="search-bar" id="filter-statut" onchange="renderInterventions(document.getElementById('topbar-title'),document.getElementById('content'),document.getElementById('topbar-actions'))" style="width:130px">
      <option value="">${t('tous_statuts')}</option><option value="Ouvert">${t('inter_statut_ouvert')}</option><option value="En attente">${t('inter_statut_attente')}</option><option value="Fermé">${t('inter_statut_ferme')}</option>
    </select>
    <button class="btn primary" onclick="modalNewIntervention(null,null)"><i class="ti ti-plus"></i>${t('inter_new')}</button>`;
  const statut=$('filter-statut')?.value||'';
  const list=await API.interventions({q:STATE.q||undefined, statut:statut||undefined});
  c.innerHTML=`<div class="table-wrap"><table class="t">
    <thead><tr><th>N° SAV</th><th>${t('col_date')}</th><th>${t('col_client')}</th><th>${t('col_modele')} / ${t('col_serie')}</th><th>${t('col_type')}</th><th>${t('col_description')}</th><th>${t('col_garantie')}</th><th>${t('col_statut')}</th><th>${t('col_technicien')}</th><th style="text-align:center">  </th></tr></thead>
    <tbody>${list.map(i=>`<tr onclick="viewIntervention(${i.id})">
      <td class="mono" style="color:var(--accent);font-size:11px">${esc(i.num_sav||'—')}</td><td>${fd(i.date)}</td><td>${esc(i.client_nom||'')}</td>
      <td><div>${esc(i.modele)}</div><div class="mono" style="color:var(--text3)">${esc(i.serie)}</div></td>
      <td>${esc(traduireType(i.type))}</td>
      <td style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(i.description||'')}</td>
      <td><span class="badge ${i.garantie?'g':'hg'}">${i.garantie?t('badge_garantie'):t('garantie_expiree')}</span></td>
      <td><span class="badge ${sc(i.statut)}">${traduireStatut(i.statut)}</span></td>
      <td>${esc(i.technicien||'')}</td>
      <td style="text-align:center;color:var(--text3);font-size:11px">${i.nb_photos||''}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

// ── EXPÉDITIONS ───────────────────────────────────────────────────

async function renderExpeditions(ttl,c,a){
  ttl.textContent=t('exp_title');
  a.innerHTML=`<button class="btn success" onclick="API.exportExcel('expeditions')"><i class="ti ti-file-spreadsheet"></i>${t('rap_export_excel')}</button>`;
  const list=await API.expeditions();
  c.innerHTML=`
    <div style="font-size:12px;color:var(--text2);margin-bottom:12px">${t('exp_subtitle')}</div>
    ${list.length===0?`<div class="empty"><i class="ti ti-truck-delivery"></i>${t('exp_empty')}</div>`:`
    <div class="table-wrap"><table class="t">
      <thead><tr><th>N°</th><th>${t('col_client')}</th><th>${t('inter_fauteuil').replace(' *','')}</th><th>${t('col_transporteur')}</th><th>${t('col_suivi')}</th><th>${t('col_date_envoi')}</th><th>${t('col_jours')}</th><th>${t('col_statut')}</th></tr></thead>
      <tbody>${list.map(i=>`<tr onclick="viewIntervention(${i.id})">
        <td>#${i.id}</td><td>${esc(i.client_nom)}</td>
        <td><div>${esc(i.modele)}</div><div class="mono" style="color:var(--text3)">${esc(i.serie)}</div></td>
        <td>${esc(i.envoi_transporteur||'')}</td>
        <td class="mono">${esc(i.envoi_numero||'')}</td>
        <td>${fd(i.envoi_date)}</td>
        <td><span class="badge ${(i.jours_attente||0)>10?'urgent':(i.jours_attente||0)>5?'attente':'g'}">${i.jours_attente!=null?i.jours_attente+' j':'—'}</span></td>
        <td><span class="badge ${sc(i.statut)}">${traduireStatut(i.statut)}</span></td>
      </tr>`).join('')}</tbody>
    </table></div>`}`;
}

// ── COMMANDES (suivi distributeurs) ─────────────────────────────────
const cmdStatutClass = s => s==='Livré'?'g':s==='Facturé'?'facture':s==='Expédié'?'attente':s==='Problème'?'urgent':s==='Annulé'?'hg':s==='En attente confirmation'?'ouvert':'ouvert';

const STATUTS_CMD = ['Auto','En attente confirmation','En préparation','Expédié','Livré','Facturé','Problème','Annulé'];

function isRealTracking(s){
  if(!s) return false;
  const c = s.trim().replace(/\s+/g,'');
  return c.length>=8 && /\d/.test(c) && /^[A-Z0-9\-]+$/i.test(c);
}

// Traduit les valeurs de statut stockées en DB (toujours en français) vers la langue affichée
function tStatut(s){
  const map = {
    'En attente confirmation': 'En attente confirmation',
    'En préparation': t('cmd_en_prep')||'En préparation',
    'Expédié':        t('cmd_expedie')||'Expédié',
    'Livré':          t('cmd_livre')||'Livré',
    'Facturé':        t('cmd_facture_statut')||'Facturé',
    'Problème':       t('cmd_probleme')||'Problème',
    'Annulé':         t('cmd_annule')||'Annulé',
  };
  return map[s] || s;
}

let TMP_CMD_LIGNES = []; // Lignes de la commande en cours d'édition

function renderCmdLignes(){
  const el=$('cmd-lignes-list'); if(!el) return;
  if(!TMP_CMD_LIGNES.length){
    el.innerHTML=`<div style="font-size:12px;color:var(--text3);padding:8px 0">${t('cmd_lignes_empty')||'Aucune ligne — importe un BDC ou ajoute une ligne manuellement.'}</div>`;
    return;
  }
  el.innerHTML=`<table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:4px">
    <thead><tr style="background:var(--bg)">
      <th style="padding:5px 8px;text-align:left;color:var(--text2);font-weight:600">${t('col_designation_court')||'Désignation'}</th>
      <th style="padding:5px 8px;text-align:left;color:var(--text2);font-weight:600;width:130px">${t('col_ref_short')||'Référence'}</th>
      <th style="padding:5px 8px;text-align:center;color:var(--text2);font-weight:600;width:60px">${t('col_qte')||'Qté'}</th>
      <th style="width:32px"></th>
    </tr></thead>
    <tbody>${TMP_CMD_LIGNES.map((l,i)=>`<tr style="${i%2===0?'background:var(--surface)':'background:var(--bg)'}">
      <td style="padding:4px 6px">
        <div style="position:relative">
          <input class="form-input cmd-ligne-search" style="font-size:12px;padding:4px 7px"
            value="${esc(l.designation)}"
            placeholder="${t('cat_search_catalogue')||'Taper nom ou référence catalogue…'}"
            oninput="TMP_CMD_LIGNES[${i}].designation=this.value;searchCmdPieces(${i},this.value)"
            onfocus="searchCmdPieces(${i},this.value)"
            onblur="setTimeout(()=>{const d=document.getElementById('cmd-piece-drop-${i}');if(d)d.style.display='none'},150)">
          <div id="cmd-piece-drop-${i}" class="piece-dropdown" style="display:none"></div>
        </div>
      </td>
      <td style="padding:4px 6px"><input class="form-input mono" style="font-size:11px;padding:4px 7px" value="${esc(l.reference||'')}" oninput="TMP_CMD_LIGNES[${i}].reference=this.value" placeholder="Réf."></td>
      <td style="padding:4px 6px"><input class="form-input" type="number" min="1" style="font-size:12px;padding:4px 7px;text-align:center" value="${l.quantite||1}" oninput="TMP_CMD_LIGNES[${i}].quantite=parseInt(this.value)||1"></td>
      <td style="padding:4px 2px"><button class="btn sm danger" onclick="removeCmdLigne(${i})" style="padding:4px 6px"><i class="ti ti-x"></i></button></td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function searchCmdPieces(idx, q){
  const drop = document.getElementById('cmd-piece-drop-'+idx); if(!drop) return;
  const query = q.toLowerCase().trim();
  if(!query){ drop.style.display='none'; return; }
  const results = CACHE.catalogue.filter(p =>
    p.designation.toLowerCase().includes(query) ||
    (p.ref && p.ref.toLowerCase().includes(query)) ||
    (p.ref_fournisseur && p.ref_fournisseur.toLowerCase().includes(query))
  ).slice(0,12);
  if(!results.length){ drop.style.display='none'; return; }
  window._CMD_PIECE_RESULTS = window._CMD_PIECE_RESULTS || {};
  window._CMD_PIECE_RESULTS[idx] = results;
  drop.innerHTML = results.map((p,ri) => `<div class="piece-option" onmousedown="event.preventDefault();selectCmdPieceResult(${idx},${ri})">
    <div style="font-size:12px;font-weight:600">${esc(p.designation)}</div>
    <div style="font-size:11px;color:var(--text3);display:flex;gap:8px"><span class="mono">${esc(p.ref||'')}</span></div>
  </div>`).join('');
  drop.style.display = 'block';
}

function selectCmdPieceResult(idx, resultIdx){
  const p = (window._CMD_PIECE_RESULTS && window._CMD_PIECE_RESULTS[idx]) ? window._CMD_PIECE_RESULTS[idx][resultIdx] : null;
  if(!p) return;
  TMP_CMD_LIGNES[idx] = { ...TMP_CMD_LIGNES[idx], designation: p.designation||'', reference: p.ref||'' };
  renderCmdLignes();
  // Focus sur le champ Qté de la ligne sélectionnée
  setTimeout(() => {
    const inputs = document.querySelectorAll('.cmd-ligne-search');
    if(inputs[idx]) inputs[idx].closest('tr')?.querySelector('input[type="number"]')?.focus();
  }, 50);
}

function addCmdLigne(){ TMP_CMD_LIGNES.push({designation:'',reference:'',quantite:1}); renderCmdLignes();
  setTimeout(()=>{const inputs=document.querySelectorAll('.cmd-ligne-search');if(inputs.length)inputs[inputs.length-1].focus();},50);
}
function removeCmdLigne(i){ TMP_CMD_LIGNES.splice(i,1); renderCmdLignes(); }

// Génère le lien de suivi officiel du transporteur à partir du n° de suivi.
// Renvoie null si transporteur inconnu/"Autre" ou n° vide (pas de lien à générer dans ce cas).
function lienSuiviColis(transporteur, numero){
  if(!transporteur || !numero) return null;
  const n = encodeURIComponent(numero.trim());
  switch(transporteur){
    case 'Chronopost':  return `https://www.chronopost.fr/tracking-no-cms/suivi-page?listeNumerosLT=${n}&langue=fr`;
    case 'Colissimo':   return `https://www.laposte.fr/outils/suivre-vos-envois?code=${n}`;
    case 'DB Schenker': return `https://www.dbschenker.com/app/tracking-public/?refNumber=${n}&language_region=fr-FR_FR`;
    case 'UPS':          return `https://www.ups.com/track?loc=fr_FR&tracknum=${n}`;
    default: return null;
  }
}

function majLienSuiviModal(){
  const wrap = $('cmd-lien-suivi-wrap'); if(!wrap) return;
  const numero = gv('cmd-suivi'), transporteur = gv('cmd-transporteur');
  const lien = lienSuiviColis(transporteur, numero);
  wrap.innerHTML = lien
    ? `<a href="${lien}" target="_blank" rel="noopener" class="btn sm" style="display:inline-flex"><i class="ti ti-external-link"></i>${t('cmd_suivre_colis')||'Suivre le colis'}</a>`
    : '';
}

async function renderCommandes(ttl,c,a){
  ttl.textContent=t('cmd_title')||'Suivi des commandes';
  a.innerHTML=`<button class="btn success" onclick="API.exportExcel('commandes')"><i class="ti ti-file-spreadsheet"></i>${t('btn_excel')||'Excel'}</button>
    <button class="btn" onclick="syncCommandesVF()"><i class="ti ti-refresh"></i>${t('cmd_sync_vf')||'Synchroniser VosFactures'}</button>
    <button class="btn" id="btn-kanban-toggle" onclick="CMD_VIEW=CMD_VIEW==='liste'?'kanban':'liste';renderCommandesView()" title="Basculer liste / Kanban">
      <i class="ti ${CMD_VIEW==='kanban'?'ti-list':'ti-layout-kanban'}"></i> ${CMD_VIEW==='kanban'?'Liste':'Kanban'}
    </button>
    <button class="btn primary" onclick="modalCommande()"><i class="ti ti-plus"></i>${t('cmd_add')||'Nouvelle commande'}</button>`;

  // Stats filtrées par l'année sélectionnée (ou année en cours par défaut pour les compteurs)
  const anneeFiltre = CMD_FILTERS.annee ? parseInt(CMD_FILTERS.annee) : new Date().getFullYear();
  const stats = await API.commandesStats(anneeFiltre, _PAYS_FILTRE||CURRENT_USER.pays||'');
  // Le menu déroulant des années vient toujours de par_annee (toutes années, voir backend)
  const years = Object.keys(stats.par_annee||{}).filter(Boolean).sort((x,y)=>y-x);

  c.innerHTML=`
    <div id="doublons-banner"></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(90px,1fr));gap:8px;margin-bottom:14px">
      <div class="stat-card"><div class="stat-label">Total</div><div class="stat-value">${stats.total}</div></div>
      <div class="stat-card"><div class="stat-label">⏳ Attente</div><div class="stat-value">${stats.en_attente||0}</div></div>
      <div class="stat-card"><div class="stat-label">En prép.</div><div class="stat-value" style="color:var(--danger)">${stats.en_preparation}</div></div>
      <div class="stat-card"><div class="stat-label">Expédié</div><div class="stat-value" style="color:var(--warning)">${stats.expedie}</div></div>
      <div class="stat-card"><div class="stat-label">Livré</div><div class="stat-value" style="color:var(--success)">${stats.livre}</div></div>
      <div class="stat-card"><div class="stat-label">Facturé</div><div class="stat-value" style="color:var(--accent)">${stats.facture||0}</div></div>
      <div class="stat-card"><div class="stat-label">🔄 Démos</div><div class="stat-value" style="color:var(--warning)">${stats.demo||0}</div></div>
      <div class="stat-card"><div class="stat-label">Problème</div><div class="stat-value" style="color:${stats.probleme>0?'var(--danger)':'var(--text)'}">${stats.probleme}</div></div>
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;align-items:center">
      <input class="form-input" style="max-width:220px;padding:6px 10px" placeholder="${t('cmd_search')||'Rechercher (distributeur, bdc, série...)'}" value="${esc(CMD_FILTERS.q)}" oninput="CMD_FILTERS.q=this.value;renderCommandesTable(1)">
      <select class="form-input" style="width:auto;padding:6px 10px" id="cmd-f-annee" onchange="CMD_FILTERS.annee=this.value;CMD_FILTERS.mois='';render()">
        <option value="">${t('cmd_toutes_annees')||'Toutes années'}</option>
        ${years.map(y=>`<option value="${y}" ${CMD_FILTERS.annee==y?'selected':''}>${y}</option>`).join('')}
      </select>
      <select class="form-input" style="width:auto;padding:6px 10px" id="cmd-f-mois" onchange="CMD_FILTERS.mois=this.value;renderCommandesTable(1)">
        <option value="">Tous les mois</option>
        ${['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'].map((m,i)=>`<option value="${i+1}" ${CMD_FILTERS.mois==i+1?'selected':''}>${m}</option>`).join('')}
      </select>
      <select class="form-input" style="width:auto;padding:6px 10px" id="cmd-f-statut" onchange="CMD_FILTERS.statut=this.value;renderCommandesTable(1)">
        <option value="">${t('cmd_tous_statuts')||'Tous statuts'}</option>
        <option value="En attente confirmation" ${CMD_FILTERS.statut==='En attente confirmation'?'selected':''}>⏳ ${t('cmd_en_attente')||'En attente'}</option>
        <option value="En préparation" ${CMD_FILTERS.statut==='En préparation'?'selected':''}>${t('cmd_en_prep')||'En préparation'}</option>
        <option value="Expédié" ${CMD_FILTERS.statut==='Expédié'?'selected':''}>${t('cmd_expedie')||'Expédié'}</option>
        <option value="Livré" ${CMD_FILTERS.statut==='Livré'?'selected':''}>${t('cmd_livre')||'Livré'}</option>
        <option value="Facturé" ${CMD_FILTERS.statut==='Facturé'?'selected':''}>${t('cmd_facture_statut')||'Facturé'}</option>
        <option value="Problème" ${CMD_FILTERS.statut==='Problème'?'selected':''}>${t('cmd_probleme')||'Problème'}</option>
        <option value="Annulé" ${CMD_FILTERS.statut==='Annulé'?'selected':''}>${t('cmd_annule')||'Annulé'}</option>
      </select>
      <input class="form-input" style="width:auto;max-width:180px;padding:6px 10px" id="cmd-f-distrib" placeholder="${t('cmd_filtre_distrib')||'Filtrer distributeur'}" value="${esc(CMD_FILTERS.distributeur)}" oninput="CMD_FILTERS.distributeur=this.value;renderCommandesTable(1)">
      <button class="btn sm" onclick="toggleColsPanel()" title="Colonnes visibles"><i class="ti ti-layout-columns"></i></button>
      ${CMD_FILTERS.distributeur||CMD_FILTERS.statut||CMD_FILTERS.q||CMD_FILTERS.mois
        ? `<button class="btn sm" onclick="CMD_FILTERS={annee:CMD_FILTERS.annee,mois:'',statut:'',groupe:'',distributeur:'',q:''};render()" title="Effacer filtres"><i class="ti ti-x"></i></button>`:''}
    </div>
    <div id="cmd-cols-panel" style="display:none;padding:10px 14px;margin-bottom:8px;background:rgba(255,255,255,.55);border:0.5px solid var(--border);border-radius:var(--radius);backdrop-filter:blur(12px)">
      <div style="font-size:11px;font-weight:700;color:var(--text2);margin-bottom:8px;text-transform:uppercase">Colonnes optionnelles</div>
      <div style="display:flex;gap:16px;flex-wrap:wrap">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px"><input type="checkbox" ${CMD_COLS.facture?'checked':''} onchange="CMD_COLS.facture=this.checked;saveCmdCols();renderCommandesTable(1)"> N° Facture</label>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px"><input type="checkbox" ${CMD_COLS.date_facture?'checked':''} onchange="CMD_COLS.date_facture=this.checked;saveCmdCols();renderCommandesTable(1)"> Date facturation</label>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px"><input type="checkbox" ${CMD_COLS.demo_origine?'checked':''} onchange="CMD_COLS.demo_origine=this.checked;saveCmdCols();renderCommandesTable(1)"> 🔄 Origine démo</label>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px"><input type="checkbox" ${CMD_COLS.edi?'checked':''} onchange="CMD_COLS.edi=this.checked;saveCmdCols();renderCommandesTable(1)"> 💳 EDI (prélèvement)</label>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px"><input type="checkbox" ${CMD_COLS.pays?'checked':''} onchange="CMD_COLS.pays=this.checked;saveCmdCols();renderCommandesTable(1)"> 🌍 Pays</label>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px"><input type="checkbox" ${CMD_COLS.retour?'checked':''} onchange="CMD_COLS.retour=this.checked;saveCmdCols();renderCommandesTable(1)"> ↩ Retour</label>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px"><input type="checkbox" ${CMD_COLS.date_retour?'checked':''} onchange="CMD_COLS.date_retour=this.checked;saveCmdCols();renderCommandesTable(1)"> 📅 Date retour</label>
      </div>
    </div>
      ${CMD_FILTERS.distributeur
        ? `<span style="display:flex;align-items:center;gap:5px;padding:4px 10px;background:var(--accent-bg);border:0.5px solid var(--accent);border-radius:var(--radius);font-size:12px;color:var(--accent);font-weight:600">
            <i class="ti ti-building-store" style="font-size:12px"></i>
            ${esc(CMD_FILTERS.distributeur)}
            <button onclick="CMD_FILTERS.distributeur='';renderCommandesTable(1)" style="background:none;border:none;cursor:pointer;color:var(--accent);padding:0;line-height:1;font-size:14px" title="Retirer ce filtre">×</button>
           </span>`
        : ''}
    </div>
    <div id="cmd-table-wrap"></div>`;
  await renderCommandesView();
  chargerDoublonsBanner();
}

async function renderCommandesView(){
  if(CMD_VIEW==='kanban') return renderCommandesKanban();
  return renderCommandesTable(1);
}

async function renderCommandesTable(page=1){
  const wrap=$('cmd-table-wrap'); if(!wrap) return;
  wrap.innerHTML=`<div class="empty" style="padding-top:30px"><i class="ti ti-loader-2"></i>${t('msg_chargement')}</div>`;
  const PER_PAGE = 100;
  const res = await API.commandes({
    annee: CMD_FILTERS.annee, statut: CMD_FILTERS.statut,
    distributeur: CMD_FILTERS.distributeur, q: CMD_FILTERS.q,
    per_page: PER_PAGE, page
  });
  const list = res.rows||[];
  const total = res.total || list.length;
  const nbPages = Math.ceil(total / PER_PAGE);

  if(!list.length){ wrap.innerHTML=`<div class="empty"><i class="ti ti-clipboard-list"></i>${t('cmd_empty')||'Aucune commande trouvée'}</div>`; return; }

  // Navigation pagination
  const nav = nbPages > 1 ? `
    <div style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:13px">
      <button class="btn sm" ${page<=1?'disabled':''} onclick="renderCommandesTable(${page-1})"><i class="ti ti-chevron-left"></i></button>
      <span style="color:var(--text2)">Page <b>${page}</b> / ${nbPages}</span>
      <button class="btn sm" ${page>=nbPages?'disabled':''} onclick="renderCommandesTable(${page+1})"><i class="ti ti-chevron-right"></i></button>
      <span style="color:var(--text3);font-size:12px">${total} résultat(s)</span>
    </div>` : `<div style="font-size:12px;color:var(--text2);margin-bottom:8px">${total} ${t('cmd_resultats')||'résultat(s)'}</div>`;

  wrap.innerHTML=`${nav}
    <div class="table-wrap"><table class="t">
      <thead><tr>
        <th>${t('col_date')||'Date'}</th><th style="width:75px">Groupe</th>
        ${CMD_COLS.pays&&!CURRENT_USER.pays?'<th style="width:80px">Pays</th>':''}
        <th>${t('col_client')||'Distributeur'}</th>
        <th>${t('cmd_bdc')||'Bdc'}</th><th>${t('cmd_modele')||'Modèle'}</th>
        <th>${t('cmd_suivi')||'N° suivi'}</th><th>Date livraison</th><th>${t('cmd_serie')||'N° série'}</th>
        ${CMD_COLS.facture?`<th>${t('cmd_facture')||'N° Facture'}</th>`:''}
        ${CMD_COLS.date_facture?'<th>Date facturation</th>':''}
        ${CMD_COLS.demo_origine?'<th>🔄 Origine démo</th>':''}
        ${CMD_COLS.edi?'<th>💳 EDI</th>':''}
        ${CMD_COLS.retour?'<th>↩ Retour</th>':''}
        ${CMD_COLS.date_retour?'<th>Date retour</th>':''}
        <th>${t('col_statut')||'Statut'}</th><th></th>
      </tr></thead>
      <tbody>${list.map(cm=>`<tr onclick="modalCommande(${cm.id})">
        <td>${fd(cm.date_commande)}</td>
        <td><span style="font-size:11px;color:var(--text2)">${esc(cm.groupe||'')}</span></td>
        ${CMD_COLS.pays&&!CURRENT_USER.pays?`<td><span style="font-size:11px;color:var(--text2)">${esc(cm.pays||'')}</span></td>`:''}
        <td><span style="cursor:pointer;color:var(--accent)" onclick="event.stopPropagation();CMD_FILTERS.distributeur='${esc(cm.distributeur_nom)}';render()" title="Filtrer par ce distributeur">${esc(cm.distributeur_nom)}</span> <button onclick="event.stopPropagation();setView('client',{clientId:${cm.client_id}})" title="Ouvrir la fiche client" style="background:none;border:none;cursor:pointer;padding:1px 3px;color:var(--text3);vertical-align:middle" class="btn-fiche-client"><i class="ti ti-user" style="font-size:11px"></i></button></td>
        <td class="mono">${esc(cm.bdc||'')}${cm.num_commande_distrib?` <span style="color:var(--text3);font-size:11px">(${esc(cm.num_commande_distrib)})</span>`:''}</td>
        <td>${esc(cm.modele || (cm.accessoire||'').replace(/\n/g,' · '))}${cm.quantite&&cm.quantite>1?` <span style="color:var(--text3)">×${cm.quantite}</span>`:''}${cm.modele_demo?` <span class="badge hg" style="font-size:10px">🔄 ${t('cmd_demo_badge')||'Démo'}</span>`:''}</td>
        <td class="mono">${(()=>{
          if(!cm.num_suivi) return '';
          if(isRealTracking(cm.num_suivi)){
            const l=lienSuiviColis(cm.transporteur,cm.num_suivi);
            return esc(cm.num_suivi)+(l?` <a href="${l}" target="_blank" rel="noopener" onclick="event.stopPropagation()"><i class="ti ti-external-link" style="color:var(--accent)"></i></a>`:'');
          }
          return `<span style="color:var(--text3);font-size:11px" title="${esc(cm.num_suivi)}">${esc(cm.num_suivi)}</span>`;
        })()}</td>
        <td style="font-size:12px;color:var(--text2)">${cm.date_livraison?fd(cm.date_livraison):'—'}</td>
        <td class="mono">${esc(cm.num_serie||'')}</td>
        ${CMD_COLS.facture?`<td class="mono" style="font-size:11px">${esc(cm.num_facture||'')}</td>`:''}
        ${CMD_COLS.date_facture?`<td style="font-size:11px;color:var(--text2)">${cm.date_livraison&&cm.num_facture?fd(cm.date_livraison):'—'}</td>`:''}
        ${CMD_COLS.demo_origine?`<td style="font-size:11px">${cm.demo_origine_nom?`<span class="badge hg" title="Origine démo">🔄 ${esc(cm.demo_origine_nom)}</span>`:'—'}</td>`:''}
        ${CMD_COLS.edi?`<td>${cm.client_edi?'<span class="badge ouvert" style="font-size:10px">💳 EDI</span>':'—'}</td>`:''}
        ${CMD_COLS.retour?`<td class="mono" style="font-size:11px">${esc(cm.num_retour||'—')}</td>`:''}
        ${CMD_COLS.date_retour?`<td style="font-size:11px;color:var(--text2)">${cm.date_retour?fd(cm.date_retour):'—'}</td>`:''}
        <td onclick="event.stopPropagation()" style="position:relative">
          <span class="badge ${cmdStatutClass(cm.statut_calc)}" style="cursor:pointer" onclick="toggleStatutMenu(event,${cm.id},'${esc(cm.statut||'Auto')}')">${esc(tStatut(cm.statut_calc))} <i class="ti ti-chevron-down" style="font-size:9px;opacity:.6"></i></span>
        </td>
        <td style="text-align:center">
          ${cm.client_final?`<i class="ti ti-user-check" style="color:var(--accent)" title="Client final : ${esc(cm.client_final)}"></i>`:''}
          ${cm.num_retour?`<i class="ti ti-arrow-back-up" style="color:var(--danger);margin-left:2px" title="Retour : ${esc(cm.num_retour)}${cm.date_retour?' — reçu le '+fd(cm.date_retour):''}"></i>`:''}
          ${cm.informations?`<i class="ti ti-info-circle" style="color:var(--text2);margin-left:2px" title="${esc(cm.informations)}"></i>`:''}
          ${cm.reliquat?`<i class="ti ti-clock-exclamation" style="color:var(--warning);margin-left:2px" title="Reliquat${cm.reliquat_description?' : '+cm.reliquat_description:''}"></i>`:''}
        </td>
      </tr>`).join('')}</tbody>
    </table></div>
    ${nbPages > 1 ? nav : ''}`;
}

async function modalCommande(id){
  let cm = id ? await API.commande(id) : {statut:'Auto', quantite:1};

  const hasExp  = !!(cm.num_suivi || cm.date_livraison || cm.num_bordereau || cm.num_serie);
  const hasFact = !!(cm.num_facture || (cm.statut && cm.statut!=='Auto' && cm.statut!=='En préparation' && cm.statut!=='En attente confirmation'));
  const initTab = id && (cm.statut_calc==='Expédié'||cm.statut_calc==='Livré') && !hasFact ? 'expedition' : 'commande';
  const type = cm.commande_type || (/eloflex/i.test(cm.modele||'') ? 'fauteuil' : cm.modele ? 'pieces' : '');
  const isFauteuil = type==='fauteuil', isPieces=type==='pieces';

  const tabBtn = (key, label, icon, dot) =>
    `<button id="tab-btn-${key}" onclick="switchCmdTab('${key}')"
      style="flex:1;padding:10px 6px;border:none;background:none;cursor:pointer;font-size:13px;font-weight:600;
             border-bottom:2px solid ${key===initTab?'var(--accent)':'transparent'};
             color:${key===initTab?'var(--accent)':'var(--text2)'};display:flex;align-items:center;justify-content:center;gap:5px">
      <i class="ti ${icon}"></i>${label}${dot?`<span style="width:7px;height:7px;border-radius:50%;background:var(--accent);display:inline-block;margin-left:2px"></span>`:''}
    </button>`;

  showModal(`
    <div class="modal-header">
      <i class="ti ti-clipboard-list" style="font-size:18px;color:var(--accent)"></i>
      <h2 style="flex:1">${id?(t('cmd_edit')||'Modifier'):(t('cmd_add')||'Nouvelle commande')}${cm.distributeur_nom?` <span style="font-weight:400;color:var(--text2);font-size:15px">— ${esc(cm.distributeur_nom)}</span>`:''}</h2>
      ${cm.client_edi?`<span class="badge ouvert" style="font-size:11px;margin-right:4px">💳 EDI</span>`:''}
      <button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button>
    </div>
    <div style="display:flex;border-bottom:0.5px solid var(--border-s)">
      ${tabBtn('commande',t('cmd_tab_commande')||'Commande','ti-clipboard-list',false)}
      ${tabBtn('expedition',t('cmd_tab_expedition')||'Expédition','ti-truck-delivery',hasExp)}
      ${tabBtn('facturation',t('cmd_tab_facturation')||'Facturation','ti-receipt-2',hasFact)}
    </div>
    <div style="display:flex;align-items:center;gap:10px;padding:10px 22px;background:var(--bg);border-bottom:0.5px solid var(--border-s)">
      <span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text2)">${t('cmd_statut_label')||'STATUT'}</span>
      <select id="cmd-statut" onchange="majZonePreuveLivraison();majStatutBadge()" style="font-size:12px;padding:4px 8px;border:0.5px solid var(--border-s);border-radius:var(--radius);background:var(--surface);cursor:pointer">
        <option value="Auto" ${(cm.statut||'Auto')==='Auto'?'selected':''}>${t('cmd_auto_option')||t('cmd_auto_option')||'Auto (calculé)'}</option>
        <option value="En attente confirmation" ${cm.statut==='En attente confirmation'?'selected':''}>⏳ En attente confirmation</option>
        <option value="En préparation" ${cm.statut==='En préparation'?'selected':''}>${t('cmd_en_prep')||'En préparation'}</option>
        <option value="Expédié" ${cm.statut==='Expédié'?'selected':''}>${t('cmd_expedie')||'Expédié'}</option>
        <option value="Livré" ${cm.statut==='Livré'?'selected':''}>${t('cmd_livre')||'Livré'}</option>
        <option value="Facturé" ${cm.statut==='Facturé'?'selected':''}>${t('cmd_facture_statut')||'Facturé'}</option>
        <option value="Problème" ${cm.statut==='Problème'?'selected':''}>${t('cmd_probleme')||'Problème'}</option>
        <option value="Annulé" ${cm.statut==='Annulé'?'selected':''}>${t('cmd_annule')||'Annulé'}</option>
      </select>
      <span id="cmd-statut-badge" class="badge ${cmdStatutClass(cm.statut_calc||'En préparation')}" style="font-size:11px">${tStatut(cm.statut_calc||'En préparation')}</span>
      <span style="font-size:11px;color:var(--text3)" id="cmd-statut-auto-hint">${(cm.statut||'Auto')==='Auto'?t('cmd_auto_hint')||'← calculé automatiquement':''}</span>
    </div>
    <div class="modal-body" style="padding-top:16px">

      <div id="cmd-tab-commande" style="${initTab!=='commande'?'display:none':''}">
        <div class="grid-2">
          <div class="form-group"><label class="form-label">${t('col_client')||'Distributeur'} *</label>
            <input class="form-input" id="cmd-distrib" value="${esc(cm.distributeur_nom||'')}" required placeholder="${t('col_client')||'Nom du distributeur'}">
          </div>
          <div class="form-group"><label class="form-label">${t('cmd_groupe')||'Groupe'}</label>
            <select class="form-input" id="cmd-groupe">
              <option value="">— Choisir —</option>
              ${['De base','Bastide','Providom','Distri club','Particulier'].map(g=>`<option value="${g}" ${cm.groupe===g?'selected':''}>${g}</option>`).join('')}
            </select>
          </div>
          <div class="form-group" style="grid-column:1/-1"><label class="form-label">${t('cmd_modele')||'Modèle / Article'}</label>
            <input class="form-input" id="cmd-modele" value="${esc(cm.modele||'')}">
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 2fr 2fr;gap:10px;margin-bottom:12px">
          <div class="form-group" style="margin:0"><label class="form-label">Quantité</label>
            <input class="form-input" id="cmd-quantite" type="number" min="1" value="${cm.quantite||1}">
          </div>
          <div class="form-group" style="margin:0"><label class="form-label">Bdc / Devis</label>
            <div style="display:flex;gap:5px">
              <input class="form-input mono" id="cmd-bdc" value="${esc(cm.bdc||'')}" style="flex:1" placeholder="${t('cmd_num_bdc_placeholder')||'Numéro BDC ou Devis'}" oninput="majStatutBadge()">
              <button class="btn sm" type="button" title="Importer depuis VosFactures" onmousedown="lookupBdcVF()"><i class="ti ti-download"></i></button>
              ${cm.bdc?`<button class="btn sm" type="button" title="Ouvrir dans VosFactures" onclick="ouvrirDansVF(${cm.vf_commande_id||'null'},'${esc(cm.bdc)}')"><i class="ti ti-external-link"></i></button>`:''}
            </div>
          </div>
          <div class="form-group" style="margin:0"><label class="form-label">N° commande distributeur</label>
            <input class="form-input mono" id="cmd-num-distrib" value="${esc(cm.num_commande_distrib||'')}" placeholder="${t('cmd_ref_interne')||'Réf. interne'}">
          </div>
        </div>
        <div style="background:var(--bg);border:0.5px solid var(--border-s);border-radius:var(--radius);padding:12px;margin-bottom:12px">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text2);margin-bottom:10px">${t('cmd_type_label')||'TYPE DE COMMANDE'}</div>
          <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:10px">
            <label style="display:flex;align-items:center;gap:7px;cursor:pointer;font-size:13px">
              <input type="checkbox" id="cmd-type-fauteuil-neuf" ${cm.type_fauteuil_neuf?'checked':''} style="width:15px;height:15px;accent-color:var(--accent)" onchange="majTypeSuede();majBdcConfirme()">${t('cmd_type_fauteuil_neuf')||'Fauteuil Neuf'}
            </label>
            <label style="display:flex;align-items:center;gap:7px;cursor:pointer;font-size:13px">
              <input type="checkbox" id="cmd-type-fauteuil-demo" ${cm.type_fauteuil_demo||cm.modele_demo?'checked':''} style="width:15px;height:15px;accent-color:var(--warning)" onchange="majTypeSuede();majBdcConfirme()">${t('cmd_type_fauteuil_demo')||'Fauteuil Démo'}
            </label>
            <label style="display:flex;align-items:center;gap:7px;cursor:pointer;font-size:13px">
              <input type="checkbox" id="cmd-type-pieces" ${cm.type_pieces||(cm.commande_type==='pieces')?'checked':''} style="width:15px;height:15px;accent-color:var(--text2)" onchange="majBdcConfirme()">${t('cmd_type_pieces')||'Pièces détachées'}
            </label>
          </div>
          <div id="cmd-type-section-fauteuil" style="${cm.type_fauteuil_neuf||cm.type_fauteuil_demo||(cm.commande_type==='fauteuil')?'':'display:none'}">
            <div class="grid-2" style="gap:8px;margin-bottom:8px">
              <div class="form-group" style="margin:0"><label class="form-label">${t('cmd_ref_suede')||'Réf. Suède (invoice SE)'}</label><input class="form-input mono" id="cmd-invoice-se" value="${esc(cm.invoice_se||'')}" placeholder="SE-2026-..."></div>
              <div class="form-group" style="margin:0"><label class="form-label">${t('cmd_date_suede')||'Date envoi Suède'}</label><input class="form-input" id="cmd-date-suede" type="date" value="${cm.date_envoi_suede||''}"></div>
            </div>
          </div>
          <div id="cmd-type-section-pieces" style="${cm.type_pieces||(cm.commande_type==='pieces')?'':'display:none'}"></div>
          <div id="cmd-bdc-confirme-section" style="${cm.type_fauteuil_neuf||cm.type_fauteuil_demo||cm.type_pieces||cm.commande_type?'':'display:none'}">
            <div style="border-top:0.5px solid var(--border-s);margin-top:8px;padding-top:8px">
              <div style="font-size:11px;font-weight:600;color:var(--text2);margin-bottom:6px">${t('cmd_bdc_confirme_par')||'BDC confirmé par :'}</div>
              <div style="display:flex;gap:14px;flex-wrap:wrap">
                ${['mail','vosfactures','fiche de mesure'].map(m=>`
                <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">
                  <input type="radio" name="cmd-confirmation-mode" value="${m}" ${cm.confirmation_mode===m?'checked':''} style="accent-color:var(--accent)">
                  ${m==='mail'?t('cmd_mail')||'✉ Mail':m==='vosfactures'?'📋 VosFactures':`📐 ${t('cmd_fiche_mesure')||'Fiche de mesure'}`}
                </label>`).join('')}
                <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:var(--text3)">
                  <input type="radio" name="cmd-confirmation-mode" value="" ${!cm.confirmation_mode?'checked':''} style="accent-color:var(--text3)">
                  ${t('cmd_non_confirme')||'Non confirmé'}
                </label>
              </div>
              ${cm.date_confirmation?`<div style="font-size:11px;color:var(--text2);margin-top:4px">Confirmé le ${fd(cm.date_confirmation)}</div>`:''}
            </div>
          </div>
        </div>
        <div style="margin-bottom:12px">
          <label class="form-label" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            ${t('cmd_lignes_bdc')||'Lignes du bon de commande'}
            <button class="btn sm" type="button" onclick="addCmdLigne()"><i class="ti ti-plus"></i> ${t('btn_ajouter')||'+ Ajouter'}</button>
          </label>
          <div id="cmd-lignes-list" style="border:0.5px solid var(--border-s);border-radius:var(--radius);padding:6px;min-height:40px"></div>
        </div>
        <div class="grid-2">
          <div class="form-group"><label class="form-label">${t('cmd_date_commande')||'Date commande'}</label><input class="form-input" id="cmd-date" type="date" value="${cm.date_commande||''}"></div>
          <div class="form-group"><label class="form-label">Pays</label>
            ${CURRENT_USER.pays
              ? `<div class="form-input" style="background:var(--bg);cursor:default">${esc(CURRENT_USER.pays)}</div><input type="hidden" id="cmd-pays" value="${esc(CURRENT_USER.pays)}">`
              : `<select class="form-input" id="cmd-pays">
                  <option value="France" ${(cm.pays||'France')==='France'?'selected':''}>🇫🇷 France</option>
                  <option value="Sweden" ${cm.pays==='Sweden'?'selected':''}>🇸🇪 Suède</option>
                  <option value="UK" ${cm.pays==='UK'?'selected':''}>🇬🇧 United Kingdom</option>
                  <option value="Germany" ${cm.pays==='Germany'?'selected':''}>🇩🇪 Deutschland</option>
                  <option value="Spain" ${cm.pays==='Spain'?'selected':''}>🇪🇸 España</option>
                  <option value="Italy" ${cm.pays==='Italy'?'selected':''}>🇮🇹 Italia</option>
                  <option value="Belgium" ${cm.pays==='Belgium'?'selected':''}>🇧🇪 Belgique</option>
                  <option value="Switzerland" ${cm.pays==='Switzerland'?'selected':''}>🇨🇭 Suisse</option>
                  <option value="Netherlands" ${cm.pays==='Netherlands'?'selected':''}>🇳🇱 Nederland</option>
                </select>`}
          </div>
        </div>
      </div>

      <div id="cmd-tab-expedition" style="${initTab!=='expedition'?'display:none':''}">
        <div class="grid-2">
          <div class="form-group" style="grid-column:1/-1"><label class="form-label">Client final</label>
            <input class="form-input" id="cmd-clientfinal" value="${esc(cm.client_final||'')}" placeholder="${t('cmd_client_beneficiaire')||'Nom du client bénéficiaire'}">
          </div>
          <div class="form-group"><label class="form-label">N° suivi</label>
            <input class="form-input mono" id="cmd-suivi" value="${esc(cm.num_suivi||'')}" oninput="majLienSuiviModal();majStatutBadge()" placeholder="${t('cmd_num_transporteur_placeholder')||'Numéro transporteur'}">
          </div>
          <div class="form-group"><label class="form-label">Transporteur</label>
            <select class="form-input" id="cmd-transporteur" onchange="majLienSuiviModal()">
              <option value="">— Choisir —</option>
              <option value="Chronopost" ${cm.transporteur==='Chronopost'?'selected':''}>Chronopost</option>
              <option value="Colissimo" ${cm.transporteur==='Colissimo'?'selected':''}>Colissimo (La Poste)</option>
              <option value="DB Schenker" ${cm.transporteur==='DB Schenker'?'selected':''}>DB Schenker</option>
              <option value="UPS" ${cm.transporteur==='UPS'?'selected':''}>UPS</option>
              <option value="Autre" ${cm.transporteur==='Autre'?'selected':''}>Autre</option>
            </select>
          </div>
          <div id="cmd-lien-suivi-wrap" style="grid-column:1/-1;margin-top:-8px"></div>
          <div class="form-group"><label class="form-label">Date livraison</label>
            <input class="form-input" id="cmd-livraison" type="date" value="${cm.date_livraison||''}" onchange="majZonePreuveLivraison();majStatutBadge()">
          </div>
          <div class="form-group"><label class="form-label">N° Bordereau de livraison</label>
            <div style="display:flex;gap:5px">
              <input class="form-input mono" id="cmd-bordereau" value="${esc(cm.num_bordereau||'')}" placeholder="BL-2026-..." style="flex:1">
              ${cm.num_bordereau?`<button class="btn sm" type="button" title="Ouvrir dans VosFactures" onclick="ouvrirDansVF(null,'${esc(cm.num_bordereau)}')"><i class="ti ti-external-link"></i></button>`:''}
            </div>
          </div>
          <div class="form-group"><label class="form-label">N° série</label>
            <input class="form-input mono" id="cmd-serie" value="${esc(cm.num_serie||'')}" placeholder="${t('cmd_num_serie_placeholder')||'Numéro de série'}">
          </div>
        </div>
        <div id="cmd-preuve-zone"></div>
        <div style="margin-top:14px;padding-top:14px;border-top:0.5px solid var(--border-s)">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;color:var(--danger);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em">
            <i class="ti ti-arrow-back-up"></i> Retour produit
          </div>
          <div class="grid-2" style="gap:10px">
            <div class="form-group"><label class="form-label">${t('cmd_suivi_retour')||'N° suivi retour'}</label>
              <input class="form-input mono" id="cmd-num-retour" value="${esc(cm.num_retour||'')}" placeholder="ex: XN123456789JB">
            </div>
            <div class="form-group"><label class="form-label">${t('cmd_transporteur_retour')||'Transporteur retour'}</label>
              <select class="form-input" id="cmd-transporteur-retour">
                <option value="">— Choisir —</option>
                ${['Chronopost','Colissimo','DB Schenker','UPS','TNT','DHL','Autre'].map(tr=>`<option value="${tr}" ${cm.transporteur_retour===tr?'selected':''}>${tr}</option>`).join('')}
              </select>
            </div>
            <div class="form-group"><label class="form-label">${t('cmd_date_retour_reception')||'Date réception retour'}</label>
              <input class="form-input" id="cmd-date-retour" type="date" value="${cm.date_retour||''}">
            </div>
            <div class="form-group" style="display:flex;align-items:flex-end">
              ${cm.num_retour&&lienSuiviColis(cm.transporteur_retour,cm.num_retour)?`<a href="${lienSuiviColis(cm.transporteur_retour,cm.num_retour)}" target="_blank" class="btn sm"><i class="ti ti-external-link"></i> Suivre le retour</a>`:`<span style="font-size:12px;color:var(--text3)">${t('cmd_renseigne_suivi')||'Renseigne le N° pour suivre'}</span>`}
            </div>
          </div>
          <div style="margin-top:8px">
            <label class="form-label" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
              ${t('cmd_articles_retournes')||'Articles retournés'}
              <button class="btn sm" type="button" onclick="addRetourLigne()"><i class="ti ti-plus"></i> ${t('btn_ajouter')||'+ Ajouter'}</button>
            </label>
            <div id="cmd-retour-lignes-list" style="border:0.5px solid var(--border-s);border-radius:var(--radius);padding:6px;min-height:36px"></div>
          </div>
        </div>
      </div>

      <div id="cmd-tab-facturation" style="${initTab!=='facturation'?'display:none':''}">
        <div class="grid-2">
          <div class="form-group"><label class="form-label">${t('cmd_facture_vf_label')||'N° facture VosFactures'}</label>
            <input class="form-input mono" id="cmd-facture" value="${esc(cm.num_facture||'')}" placeholder="${t('cmd_num_facture_placeholder')||'Numéro de facture'}" oninput="majStatutBadge()">
          </div>
          <div class="form-group"><label class="form-label">${t('cmd_facture_pl_label')||'N° facture Pennylane'}</label>
            <div style="display:flex;gap:6px">
              <input class="form-input mono" id="cmd-facture-pl" value="${esc(cm.num_facture_pennylane||'')}" placeholder="FAC-2026-..." style="flex:1" oninput="majStatutBadge()">
              ${id?`<button class="btn sm" type="button" onclick="genererFacturePennylaneModal(${id})" title="Créer la facture dans Pennylane (brouillon)"><i class="ti ti-brand-stripe"></i></button>`:''}
            </div>
          </div>
          <div class="form-group" style="grid-column:1/-1"><label class="form-label">Informations</label>
            <textarea class="form-input" id="cmd-infos" rows="2" placeholder="${t('cmd_notes_placeholder')||'Notes internes…'}">${esc(cm.informations||'')}</textarea>
          </div>
        </div>
        <div style="margin-bottom:12px">
          <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:0.5px solid var(--border-s);border-radius:var(--radius);background:${cm.reliquat?'var(--warning-bg)':'var(--surface)'}">
            <input type="checkbox" id="cmd-reliquat" ${cm.reliquat?'checked':''} onchange="majReliquatSection()" style="width:16px;height:16px;cursor:pointer;accent-color:var(--warning)">
            <label for="cmd-reliquat" style="font-size:13px;font-weight:600;cursor:pointer;color:var(--warning)">⚠ Reliquat en attente</label>
          </div>
          <div id="cmd-reliquat-desc" style="${cm.reliquat?'':'display:none'};margin-top:8px">
            <textarea class="form-input" id="cmd-reliquat-description" rows="2" placeholder="${t('cmd_reliquat_placeholder')||'Décrire le reliquat…'}">${esc(cm.reliquat_description||'')}</textarea>
          </div>
        </div>
        <div style="margin-top:4px;padding-top:14px;border-top:0.5px solid var(--border-s)">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text2);margin-bottom:10px"><i class="ti ti-receipt-off" style="font-size:13px"></i> ${t('cmd_avoir_titre')||'AVOIR'}</div>
          <div class="grid-2" style="gap:10px;align-items:end">
            <div class="form-group" style="margin:0"><label class="form-label">${t('cmd_avoir_vf_label')||'N° avoir VosFactures'}</label>
              <input class="form-input mono" id="cmd-avoir" value="${esc(cm.num_avoir||'')}" placeholder="AV-2026-...">
            </div>
            <div class="form-group" style="margin:0;display:flex;align-items:flex-end;gap:6px">
              ${cm.num_avoir?`<button class="btn sm" type="button" onclick="ouvrirAvoirVF('${esc(cm.num_avoir)}')" title="Ouvrir l'avoir dans VosFactures"><i class="ti ti-external-link"></i> Ouvrir dans VosFactures</button>`:`<span style="font-size:12px;color:var(--text3)">${t('cmd_renseigne_avoir')||'Renseigne le N° pour accéder à l\'avoir'}</span>`}
            </div>
          </div>
        </div>
        ${id?`<div style="padding-top:12px;margin-top:12px;border-top:0.5px solid var(--border-s)">
          <button class="btn sm" onclick="chercherFacturesVF(${id},'${esc(cm.num_facture||'')}')" type="button"><i class="ti ti-search"></i> ${t('cmd_chercher_vf_rattacher')||'Chercher une facture VosFactures à rattacher'}</button>
          <div id="cmd-vf-suggest-list" style="margin-top:10px"></div>
        </div>`:''}
      </div>
    </div>
    <div class="modal-footer">
      ${id?`<button class="btn danger" onclick="supprimerCommande(${id})"><i class="ti ti-trash"></i></button>`:''}
      ${id?`<button class="btn sm" onclick="envoyerEmailConfirmation(${id})" title="Demander confirmation BDC"><i class="ti ti-mail"></i> ${t('btn_confirmer_bdc')||'Confirmer'}</button>`:''}
      ${id&&cm.num_suivi&&isRealTracking(cm.num_suivi)?`<button class="btn sm" onclick="envoyerEmailExpedition(${id})" title="Email d'expédition"><i class="ti ti-mail"></i> ${t('btn_email_exped')||'Email expéd.'}</button>`:''}
      ${id&&(cm.statut_calc==='Livré'||cm.statut_calc==='Facturé')?`<button class="btn sm" onclick="genererFactureVF(${id})" title="Créer la facture dans VosFactures"><i class="ti ti-receipt-2"></i> Facture VF</button>`:''}
      <button class="btn" onclick="closeModal()">${t('btn_annuler')||'Annuler'}</button>
      <button class="btn primary" onclick="enregistrerCommande(${id||'null'})"><i class="ti ti-check"></i>${t('btn_enregistrer')||'Enregistrer'}</button>
    </div>`);

  window._CMD_ID = id || null;
  window._CMD_PREUVE = id ? {
    url: cm.preuve_livraison_data || cm.preuve_livraison_url, // data:... en priorité (Render-safe)
    mime: cm.preuve_livraison_mime,
    taille: cm.preuve_livraison_taille
  } : {};
  window._CMD_CONF_DATE = cm.date_confirmation || null;
  TMP_CMD_LIGNES = (cm.lignes||[]).map(l=>({designation:l.designation||'',reference:l.reference||'',quantite:l.quantite||1}));
  TMP_RETOUR_LIGNES = (cm.retour_lignes||[]).map(l=>({designation:l.designation||'',reference:l.reference||'',quantite:l.quantite||1}));
  setTimeout(()=>{ renderCmdLignes(); renderRetourLignes(); majLienSuiviModal(); majZonePreuveLivraison(); }, 60);
}

function switchCmdTab(tab){
  ['commande','expedition','facturation'].forEach(k=>{
    const panel = document.getElementById('cmd-tab-'+k);
    const btn   = document.getElementById('tab-btn-'+k);
    if(panel) panel.style.display = k===tab ? '' : 'none';
    if(btn){
      btn.style.borderBottom = k===tab ? '2px solid var(--accent)' : '2px solid transparent';
      btn.style.color = k===tab ? 'var(--accent)' : 'var(--text2)';
    }
  });
  if(tab==='expedition') setTimeout(()=>{ majLienSuiviModal(); majZonePreuveLivraison(); renderRetourLignes(); }, 30);
}


function commandeEstLivree(){
  const sel = gv('cmd-statut');
  if (sel === 'Livré' || sel === 'Facturé') return true;
  if ((sel === 'Auto' || !sel) && gv('cmd-livraison')) return true;
  return false;
}

function majZonePreuveLivraison(){
  const zone = $('cmd-preuve-zone'); if(!zone) return;
  if(!window._CMD_ID || !commandeEstLivree()){ zone.innerHTML=''; return; }
  const p = window._CMD_PREUVE || {};
  if(p.url){
    const taille = p.taille ? ' ('+(p.taille/1024).toFixed(0)+' Ko)' : '';
    zone.innerHTML = `<div style="margin-top:6px;padding-top:14px;border-top:0.5px solid var(--border)">
      <div class="form-label" style="margin-bottom:8px">${t('cmd_preuve_livraison')||'Preuve de livraison'}</div>
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border:0.5px solid var(--border-s);border-radius:var(--radius)">
        <a href="${p.url}" target="_blank" rel="noopener" style="display:flex;align-items:center;gap:8px;color:var(--accent);text-decoration:none">
          <i class="ti ${p.mime==='application/pdf'?'ti-file-type-pdf':'ti-photo'}" style="font-size:20px"></i>
          <span style="font-size:13px">${t('cmd_voir_preuve')||'Voir le document'}${taille}</span>
        </a>
        <button class="btn sm danger" type="button" onmousedown="supprimerPreuveLivraison(${window._CMD_ID})"><i class="ti ti-trash"></i></button>
      </div>
    </div>`;
  } else {
    zone.innerHTML = `<div style="margin-top:6px;padding-top:14px;border-top:0.5px solid var(--border)">
      <div class="form-label" style="margin-bottom:8px">${t('cmd_preuve_livraison')||'Preuve de livraison'}</div>
      <label class="btn sm" style="cursor:pointer;display:inline-flex">
        <i class="ti ti-upload"></i>${t('cmd_uploader_preuve')||'Uploader la preuve (PDF, JPEG, PNG)'}
        <input type="file" accept="application/pdf,image/jpeg,image/png" style="display:none" onchange="uploaderPreuveLivraison(this.files[0])">
      </label>
    </div>`;
  }
}

async function uploaderPreuveLivraison(file){
  if(!file || !window._CMD_ID) return;
  toast(t('cmd_upload_en_cours')||'Envoi en cours…','ti-loader-2');
  try{
    const updated = await API.uploadPreuveLivraison(window._CMD_ID, file);
    window._CMD_PREUVE = { url: updated.preuve_livraison_url, mime: updated.preuve_livraison_mime, taille: updated.preuve_livraison_taille };
    majZonePreuveLivraison();
    toast(t('cmd_preuve_envoyee')||'Preuve de livraison enregistrée');
  }catch(e){ toast(e.message,'ti-alert-circle','var(--danger)'); }
}

async function supprimerPreuveLivraison(id){
  if(!confirm(t('cmd_confirm_suppr_preuve')||'Supprimer la preuve de livraison ?')) return;
  try{
    await API.deletePreuveLivraison(id);
    window._CMD_PREUVE = {};
    majZonePreuveLivraison();
    toast(t('msg_supprime')||'Supprimé');
  }catch(e){ toast(e.message,'ti-alert-circle','var(--danger)'); }
}

async function chercherFacturesVF(id, numFacture){
  const zone=$('cmd-vf-suggest-list');
  zone.innerHTML=`<div style="font-size:12px;color:var(--text2)"><i class="ti ti-loader-2"></i> ${t('msg_chargement')}</div>`;
  // Utiliser le numéro de facture saisi si disponible
  const numFact = numFacture || gv('cmd-facture') || '';
  const url = `/commandes/${id}/factures-vf-suggestions${numFact?'?num_facture='+encodeURIComponent(numFact):''}`;
  try{
    const r = await API.get(url);
    if(!r.configured){ zone.innerHTML=`<div style="font-size:12px;color:var(--text2)">${t('cmd_vf_non_configure')||'VosFactures non configuré'}</div>`; return; }
    if(r.reason){ zone.innerHTML=`<div style="font-size:12px;color:var(--text2)">${esc(r.reason)}</div>`; return; }
    if(!r.factures||!r.factures.length){ zone.innerHTML=`<div style="font-size:12px;color:var(--text2)">${t('cmd_vf_aucune')||'Aucune facture récente trouvée pour ce distributeur'}</div>`; return; }
    zone.innerHTML=`<div class="form-label" style="margin-bottom:8px">${t('cmd_vf_choisir')||'Choisis la facture correspondante (à confirmer toi-même, aucun lien automatique fiable côté VosFactures) :'}</div>
      <div style="display:flex;flex-direction:column;gap:6px;max-height:220px;overflow:auto">
        ${r.factures.map((f,i)=>{
          window._VF_SUGGEST=window._VF_SUGGEST||{}; window._VF_SUGGEST[i]=f;
          return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border:0.5px solid var(--border-s);border-radius:var(--radius)">
            <div>
              <div style="font-size:13px;font-weight:600">${esc(f.numero||('#'+f.id))} — ${fd(f.date)}</div>
              <div style="font-size:11px;color:var(--text3)">${f.num_serie?('N° série : '+esc(f.num_serie)):(t('cmd_vf_sans_serie')||'Pas de série détectée')}${f.montant_ttc?' · '+parseFloat(f.montant_ttc).toFixed(2)+' €':''}</div>
            </div>
            <button class="btn sm" type="button" onmousedown="appliquerFactureVF(${i})">${t('cmd_vf_utiliser')||'Utiliser'}</button>
          </div>`;
        }).join('')}
      </div>`;
  }catch(e){ zone.innerHTML=`<div style="font-size:12px;color:var(--danger)">${esc(e.message)}</div>`; }
}

function appliquerFactureVF(i){
  const f = (window._VF_SUGGEST||{})[i]; if(!f) return;
  if($('cmd-facture')) $('cmd-facture').value = f.numero || '';
  if(f.num_serie && $('cmd-serie')) $('cmd-serie').value = f.num_serie;
  toast(t('cmd_vf_applique')||'Facture rattachée — vérifie puis enregistre');
}

async function lookupBdcVF(){
  const numero = gv('cmd-bdc').trim();
  if(!numero){ toast(t('cmd_bdc_requis')||'Indique d\u2019abord un n° de bon de commande','ti-alert-circle','var(--danger)'); return; }
  toast(t('cmd_vf_recherche_en_cours')||'Recherche dans VosFactures…','ti-loader-2');
  try{
    const r = await API.vfBdcLookup(numero);
    if(!r.configured){ toast(t('cmd_vf_non_configure')||'VosFactures non configuré','ti-alert-circle','var(--danger)'); return; }
    if(!r.found){ toast(t('cmd_bdc_introuvable')||'Bon de commande introuvable dans VosFactures','ti-alert-circle','var(--danger)'); return; }
    let remplis = [];
    if(r.distributeur && $('cmd-distrib') && !gv('cmd-distrib')){ $('cmd-distrib').value=r.distributeur; remplis.push('distributeur'); }
    if(r.modele     && $('cmd-modele')  && !gv('cmd-modele'))  { $('cmd-modele').value=r.modele;       remplis.push('modèle'); }
    if(r.quantite   && $('cmd-quantite'))                       { $('cmd-quantite').value=r.quantite;   }
    if(r.date_commande && $('cmd-date') && !gv('cmd-date'))    { $('cmd-date').value=r.date_commande;   remplis.push('date'); }
    if(r.num_serie  && $('cmd-serie')   && !gv('cmd-serie'))   { $('cmd-serie').value=r.num_serie;      remplis.push('n° série'); }
    // Démo détectée automatiquement dans le document VosFactures
    if(r.kind==='receipt' && $('cmd-bordereau') && !gv('cmd-bordereau')){ $('cmd-bordereau').value=r.numero||''; remplis.push('bordereau de livraison'); }
    if(r.modele_demo && document.getElementById('cmd-demo')){
      document.getElementById('cmd-demo').checked = true;
      majDemoStyle(document.getElementById('cmd-demo'));
      remplis.push('🔄 modèle démo détecté');
    }
    // Lignes structurées : remplace TMP_CMD_LIGNES
    if(r.lignes && r.lignes.length){
      TMP_CMD_LIGNES = r.lignes.map(l=>({designation:(LANG==='en'&&l.designation_en?l.designation_en:l.designation)||'',reference:l.reference||'',quantite:l.quantite||1}));
      renderCmdLignes();
      remplis.push(`${r.lignes.length} ligne${r.lignes.length>1?'s':''}`);
    }
    toast(remplis.length
      ? `${t('cmd_bdc_rempli')||'Données récupérées'} : ${remplis.join(', ')}`
      : t('cmd_bdc_deja_rempli')||'Bon de commande trouvé (champs déjà remplis conservés)');
  }catch(e){ toast(e.message,'ti-alert-circle','var(--danger)'); }
}

async function lookupFactureVF(){  const numero = gv('cmd-facture').trim();
  if(!numero){ toast(t('cmd_vf_numero_requis')||'Indique d\u2019abord un n° de facture','ti-alert-circle','var(--danger)'); return; }
  toast(t('cmd_vf_recherche_en_cours')||'Recherche dans VosFactures…','ti-loader-2');
  try{
    const r = await API.vfFactureLookup(numero);
    if(!r.configured){ toast(t('cmd_vf_non_configure')||'VosFactures non configuré','ti-alert-circle','var(--danger)'); return; }
    if(!r.found){ toast(t('cmd_vf_facture_introuvable')||'Facture introuvable dans VosFactures','ti-alert-circle','var(--danger)'); return; }
    if(r.num_serie){ $('cmd-serie').value=r.num_serie; toast(t('cmd_vf_serie_recuperee')||'N° de série récupéré'); }
    else toast(t('cmd_vf_sans_serie')||'Pas de série détectée dans cette facture','ti-alert-circle','var(--danger)');
  }catch(e){ toast(e.message,'ti-alert-circle','var(--danger)'); }
}

let TMP_RETOUR_LIGNES = [];

function renderRetourLignes(){
  const el=$('cmd-retour-lignes-list'); if(!el) return;
  if(!TMP_RETOUR_LIGNES.length){
    el.innerHTML=`<div style="font-size:12px;color:var(--text3);padding:6px 0">${t('cmd_retour_articles_empty')||'Aucun article retourné — cliquez "+ Ajouter"'}</div>`;
    return;
  }
  el.innerHTML=`<table style="width:100%;border-collapse:collapse;font-size:12px">
    <thead><tr style="background:var(--bg)">
      <th style="padding:4px 8px;text-align:left;color:var(--text2);font-weight:600">${t('col_designation_court')||'Désignation'}</th>
      <th style="padding:4px 8px;text-align:left;color:var(--text2);font-weight:600;width:120px">${t('col_ref_short')||'Référence'}</th>
      <th style="padding:4px 8px;text-align:center;color:var(--text2);font-weight:600;width:55px">${t('col_qte')||'Qté'}</th>
      <th style="width:28px"></th>
    </tr></thead>
    <tbody>${TMP_RETOUR_LIGNES.map((l,i)=>`<tr style="${i%2===0?'background:var(--surface)':'background:var(--bg)'}">
      <td style="padding:3px 6px"><input class="form-input" style="font-size:12px;padding:3px 7px" value="${esc(l.designation)}" oninput="TMP_RETOUR_LIGNES[${i}].designation=this.value" placeholder="Désignation *"></td>
      <td style="padding:3px 6px"><input class="form-input mono" style="font-size:11px;padding:3px 7px" value="${esc(l.reference||'')}" oninput="TMP_RETOUR_LIGNES[${i}].reference=this.value" placeholder="Réf."></td>
      <td style="padding:3px 6px"><input class="form-input" type="number" min="1" style="font-size:12px;padding:3px 7px;text-align:center" value="${l.quantite||1}" oninput="TMP_RETOUR_LIGNES[${i}].quantite=parseInt(this.value)||1"></td>
      <td style="padding:3px 2px"><button class="btn sm danger" onclick="TMP_RETOUR_LIGNES.splice(${i},1);renderRetourLignes()" style="padding:3px 5px"><i class="ti ti-x"></i></button></td>
    </tr>`).join('')}</tbody>
  </table>`;
}
function addRetourLigne(){ TMP_RETOUR_LIGNES.push({designation:'',reference:'',quantite:1}); renderRetourLignes();
  setTimeout(()=>{ const r=document.querySelectorAll('#cmd-retour-lignes-list input'); r[r.length-3]?.focus(); },50); }

async function lookupBordereauVF(){
  const numero = gv('cmd-bordereau').trim();
  if(!numero){ toast('Indique d\u2019abord un N° de bordereau','ti-alert-circle','var(--danger)'); return; }
  toast('Recherche dans VosFactures…','ti-loader-2');
  try{
    const r = await API.vfBdcLookup(numero);
    if(!r.configured){ toast('VosFactures non configuré','ti-alert-circle','var(--danger)'); return; }
    if(!r.found){ toast('Bordereau introuvable dans VosFactures','ti-alert-circle','var(--danger)'); return; }
    let remplis = [];
    if(r.lignes && r.lignes.length){
      TMP_CMD_LIGNES = r.lignes.map(l=>({designation:(LANG==='en'&&l.designation_en?l.designation_en:l.designation)||'',reference:l.reference||'',quantite:l.quantite||1}));
      renderCmdLignes(); remplis.push(`${r.lignes.length} article(s)`);
    }
    if(r.num_serie && $('cmd-serie') && !gv('cmd-serie')){ $('cmd-serie').value=r.num_serie; remplis.push('n° série'); }
    if(r.date_commande && $('cmd-date') && !gv('cmd-date')){ $('cmd-date').value=r.date_commande; remplis.push('date'); }
    toast(remplis.length ? `Bordereau importé : ${remplis.join(', ')}` : 'Bordereau trouvé (données déjà remplies)');
  }catch(e){ toast(e.message,'ti-alert-circle','var(--danger)'); }
}

function majStatutBadge(){
  const sel = $('cmd-statut'); if(!sel) return;
  const badge = $('cmd-statut-badge');
  const hint  = $('cmd-statut-auto-hint');
  if(sel.value !== 'Auto'){
    if(badge){ badge.textContent = tStatut(sel.value)||sel.value; badge.className = `badge ${cmdStatutClass(sel.value)}`; }
    if(hint) hint.textContent = '';
    return;
  }
  // Calculer le statut auto côté client
  const bdc      = (gv('cmd-bdc')||'').trim();
  const suivi    = (gv('cmd-suivi')||'').trim();
  const livraison = (gv('cmd-livraison')||'').trim();
  const facture  = (gv('cmd-facture')||'').trim();
  let calc = 'En préparation';
  if(facture)                    calc = 'Facturé';
  else if(livraison)             calc = 'Livré';
  else if(isRealTracking(suivi)) calc = 'Expédié';
  // bdc → En préparation (déjà valeur par défaut)
  if(badge){ badge.textContent = tStatut(calc); badge.className = `badge ${cmdStatutClass(calc)}`; }
  if(hint)  hint.textContent = '← calculé automatiquement';
}

function ouvrirAvoirVF(num){
  const account = window._VF_ACCOUNT;
  if(!account){ toast('Compte VosFactures non configuré','ti-alert-circle','var(--warning)'); return; }
  window.open(`https://${account}.vosfactures.fr/invoices?search_text=${encodeURIComponent(num)}`, '_blank', 'noopener');
}

function toggleColsPanel(){
  const el = document.getElementById('cmd-cols-panel');
  if(el) el.style.display = el.style.display === 'none' ? '' : 'none';
}
function saveCmdCols(){
  localStorage.setItem('sav_cmd_cols', JSON.stringify(CMD_COLS));
}

async function voirSuiviTracking(numero){
  const el = document.getElementById('tracking-widget');
  if(el) el.innerHTML = '<span style="font-size:11px;color:var(--text2)"><i class="ti ti-loader-2"></i> Chargement du suivi…</span>';
  try{
    const r = await API.tracking(numero);
    if(!el) return;
    if(!r.found){
      const lien = r.lien ? `<a href="${r.lien}" target="_blank" rel="noopener" class="btn sm" style="margin-top:4px">
        <i class="ti ti-external-link"></i> Suivre sur ${esc(r.transporteur||'le site')}
      </a>` : '';
      el.innerHTML = `<div style="font-size:11px;color:var(--text3)">${r.message||'Suivi non disponible'} ${lien}</div>`;
      return;
    }
    const events = r.events||[];
    el.innerHTML = `<div style="background:rgba(255,255,255,.55);border:0.5px solid var(--border);border-radius:10px;padding:10px 12px;margin-top:4px">
      <div style="font-size:11px;font-weight:700;margin-bottom:6px;display:flex;align-items:center;gap:6px">
        <span class="badge ${r.statut==='Livré'?'g':r.statut==='Problème'?'urgent':'attente'}">${r.statut||'En cours'}</span>
        <span style="color:var(--text2)">${esc(r.transporteur||'')}</span>
      </div>
      <div style="font-size:11px;max-height:160px;overflow-y:auto">
        ${events.slice(0,5).map(e=>`<div style="padding:3px 0;border-bottom:0.5px solid var(--border);display:flex;gap:8px">
          <span style="color:var(--text3);white-space:nowrap">${e.date?e.date.slice(0,10):''}</span>
          <span>${esc(e.label||'')}</span>
          ${e.lieu?`<span style="color:var(--text3)">${esc(e.lieu)}</span>`:''}
        </div>`).join('')}
      </div>
    </div>`;
  }catch(e){
    if(el) el.innerHTML = `<span style="font-size:11px;color:var(--danger)">${esc(e.message)}</span>`;
  }
}

function majBdcConfirme(){
  const neuf  = !!document.getElementById('cmd-type-fauteuil-neuf')?.checked;
  const demo  = !!document.getElementById('cmd-type-fauteuil-demo')?.checked;
  const pieces= !!document.getElementById('cmd-type-pieces')?.checked;
  const sec = document.getElementById('cmd-bdc-confirme-section');
  if(sec) sec.style.display = (neuf||demo||pieces) ? '' : 'none';
}

function majTypeSuede(){
  const neuf = !!document.getElementById('cmd-type-fauteuil-neuf')?.checked;
  const demo = !!document.getElementById('cmd-type-fauteuil-demo')?.checked;
  const sec = $('cmd-type-section-fauteuil');
  if(sec) sec.style.display = (neuf||demo) ? '' : 'none';
}

function renderTopbarPays(){
  const el = document.getElementById('pays-switcher');
  if(!el) return;
  // Visible uniquement pour les admins globaux (sans pays fixé sur le compte)
  if(!isAdmin() || CURRENT_USER.pays){ el.innerHTML=''; return; }
  // Pays actifs (ceux qui ont des commandes, pour l'instant la liste configurée)
  const actifs = PAYS_LIST.filter(p => ['','France','Sweden'].includes(p.code));
  el.innerHTML = actifs.map(p=>`
    <button onclick="setPaysFiltre('${p.code}')" title="${p.label}" style="
      padding:3px 8px;border:none;border-radius:12px;cursor:pointer;font-size:12px;
      background:${_PAYS_FILTRE===p.code?'var(--accent)':'var(--surface)'};
      color:${_PAYS_FILTRE===p.code?'#fff':'var(--text2)'};
      border:0.5px solid ${_PAYS_FILTRE===p.code?'var(--accent)':'var(--border-s)'};
      margin-left:3px;transition:all .15s">
      ${p.flag} ${p.label}
    </button>`).join('');
}

function majDemoStyle(cb){
  const wrap = document.getElementById('cmd-demo-wrap');
  if(wrap){
    wrap.style.borderColor = cb.checked ? 'var(--warning)' : 'var(--border-s)';
    wrap.style.background  = cb.checked ? 'var(--warning-bg)' : 'var(--surface)';
  }
}

function majReliquatSection(){
  const checked = document.getElementById('cmd-reliquat')?.checked;
  const desc = document.getElementById('cmd-reliquat-desc');
  const wrap = document.getElementById('cmd-reliquat')?.parentElement;
  if(desc) desc.style.display = checked ? '' : 'none';
  if(wrap) wrap.style.background = checked ? 'var(--warning-bg)' : 'var(--surface)';
}

const STATUTS_LISTE = ['Auto','En préparation','Expédié','Livré','Facturé','Problème','Annulé'];

function toggleStatutMenu(e, id, statutActuel){
  // Fermer tout menu ouvert
  document.querySelectorAll('.statut-menu').forEach(m => m.remove());
  const menu = document.createElement('div');
  menu.className = 'statut-menu';
  menu.style.cssText = `position:fixed;z-index:9999;background:#fff;border:0.5px solid rgba(100,150,200,.30);border-radius:12px;box-shadow:0 8px 32px rgba(80,130,200,.20),0 1px 0 rgba(255,255,255,.9) inset;padding:4px 0;min-width:160px`;
  menu.innerHTML = STATUTS_LISTE.map(s => `
    <div onclick="changerStatutCommande(${id},'${s}');this.closest('.statut-menu').remove()"
      style="padding:7px 14px;cursor:pointer;font-size:13px;${s===statutActuel?'font-weight:700;color:var(--accent)':''}
      display:flex;align-items:center;gap:8px" class="statut-option">
      ${s===statutActuel?'<i class="ti ti-check" style="font-size:12px"></i>':'<span style="width:12px"></span>'}
      <span class="badge ${s==='Auto'?'ouvert':cmdStatutClass(s)}" style="font-size:11px">${tStatut(s)||s}</span>
    </div>`).join('');
  document.body.appendChild(menu);
  const rect = e.target.getBoundingClientRect();
  menu.style.left = `${Math.min(rect.left, window.innerWidth - 180)}px`;
  menu.style.top  = `${rect.bottom + 4}px`;
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 50);
}

async function changerStatutCommande(id, statut){
  try{
    await API.updateCommande(id, { statut });
    toast(`Statut → ${tStatut(statut)||statut}`, 'ti-check');
    render();
  }catch(e){ toast(e.message,'ti-alert-circle','var(--danger)'); }
}

async function enregistrerCommande(id){
  const d = {
    distributeur_nom: gv('cmd-distrib'), groupe: gv('cmd-groupe'), modele: gv('cmd-modele'),
    quantite: parseInt(gv('cmd-quantite'))||1,
    bdc: gv('cmd-bdc'), date_commande: gv('cmd-date')||null,
    client_final: gv('cmd-clientfinal'), num_suivi: gv('cmd-suivi'), transporteur: gv('cmd-transporteur')||null,
    date_livraison: gv('cmd-livraison')||null, num_bordereau: gv('cmd-bordereau')||null,
    num_serie: gv('cmd-serie'), num_facture: gv('cmd-facture'), statut: gv('cmd-statut'),
    informations: gv('cmd-infos'),
    reliquat: !!document.getElementById('cmd-reliquat')?.checked,
    reliquat_description: gv('cmd-reliquat-description')||null,
    modele_demo: !!document.getElementById('cmd-demo')?.checked,
    num_retour: gv('cmd-num-retour')||null,
    transporteur_retour: gv('cmd-transporteur-retour')||null,
    date_retour: gv('cmd-date-retour')||null,
    num_commande_distrib: gv('cmd-num-distrib')||null,
    commande_type: document.getElementById('cmd-type-fauteuil-neuf')?.checked ? 'fauteuil' : document.getElementById('cmd-type-pieces')?.checked ? 'pieces' : null,
    type_fauteuil_neuf: !!document.getElementById('cmd-type-fauteuil-neuf')?.checked,
    type_fauteuil_demo: !!document.getElementById('cmd-type-fauteuil-demo')?.checked,
    type_pieces:        !!document.getElementById('cmd-type-pieces')?.checked,
    modele_demo:        !!document.getElementById('cmd-type-fauteuil-demo')?.checked,
    confirmation_mode: document.querySelector('input[name="cmd-confirmation-mode"]:checked')?.value||null,
    confirmation_recue: !!(document.querySelector('input[name="cmd-confirmation-mode"]:checked')?.value),
    invoice_se: gv('cmd-invoice-se')||null,
    date_envoi_suede: gv('cmd-date-suede')||null,
    date_confirmation: document.querySelector('input[name="cmd-confirmation-mode"]:checked')?.value && !window._CMD_CONF_DATE ? new Date().toISOString().slice(0,10) : (window._CMD_CONF_DATE||null),
    num_avoir: gv('cmd-avoir')||null,
    num_facture_pennylane: gv('cmd-facture-pl')||null,
    pays: gv('cmd-pays')||CURRENT_USER.pays||'France',
  };
  if(!d.distributeur_nom){ toast(t('cmd_err_distrib')||'Le distributeur est requis','ti-alert-circle','var(--danger)'); return; }
  try{
    let cmdId = id;
    if(id) await API.updateCommande(id, d);
    else { const r = await API.createCommande(d); cmdId = r.id; }
    // Sauvegarder les lignes si une commande existe
    if(cmdId){
      const lignesValides = TMP_CMD_LIGNES.filter(l=>l.designation?.trim());
      await API.saveCommandeLignes(cmdId, lignesValides);
      const retourValides = TMP_RETOUR_LIGNES.filter(l=>l.designation?.trim());
      if(retourValides.length || window._CMD_ID) await API.saveRetourLignes(cmdId, retourValides);
    }
    closeModal(); toast(t('msg_enregistre')||'Enregistré'); render();
  }catch(e){ toast(e.message,'ti-alert-circle','var(--danger)'); }
}

async function supprimerCommande(id){
  if(!confirm(t('cmd_confirm_suppr')||'Supprimer cette commande ?')) return;
  try{ await API.deleteCommande(id); closeModal(); toast(t('msg_supprime')||'Supprimé'); render(); }
  catch(e){ toast(e.message,'ti-alert-circle','var(--danger)'); }
}

async function syncCommandesVF(){
  toast(t('cmd_sync_en_cours')||'Synchronisation VosFactures en cours…','ti-loader-2');
  try{
    const r = await API.vfSyncCommandes();
    toast(r.message||(t('cmd_sync_ok')||'Synchronisation terminée'));
    render();
  }catch(e){ toast(e.message,'ti-alert-circle','var(--danger)'); }
}

// ── CATALOGUE ─────────────────────────────────────────────────────

async function renderCatalogue(ttl,c,a){
  ttl.textContent=t('cat_title');
  a.innerHTML=`<div style="display:flex;gap:8px;align-items:center">
    <input id="cat-search" class="search-bar" placeholder="${t('cat_search')}" value="${esc(STATE.q)}" style="max-width:280px">
    <button class="btn" onclick="API.exportExcel('catalogue')"><i class="ti ti-file-spreadsheet"></i>${t('btn_excel')}</button>
    <button class="btn primary" onclick="modalPiece()"><i class="ti ti-plus"></i>${t('piece_add')}</button>
  </div>`;
  document.getElementById('cat-search')?.addEventListener('input', e => {
    STATE.q = e.target.value;
    clearTimeout(window._CAT); window._CAT = setTimeout(() => chargerListeCatalogue(), 250);
  });
  c.innerHTML=`<div id="catalogue-list-body"><div style="color:var(--text2);font-size:13px;padding:20px 0">${t('msg_chargement')}</div></div>`;
  chargerListeCatalogue();
}

let _catalogueReqId = 0;
async function chargerListeCatalogue(){
  const el = document.getElementById('catalogue-list-body'); if(!el) return;
  const reqId = ++_catalogueReqId;
  const list = await API.catalogue(STATE.q);
  if(reqId !== _catalogueReqId) return;
  CACHE.catalogue = list;
  el.innerHTML=`<div class="table-wrap"><table class="t">
    <thead><tr><th>${t('col_ref')}</th><th>${t('col_designation')}</th><th>${t('col_fournisseur')}</th><th>${t('col_ref_fou')}</th><th>${t('col_prix')}</th><th>${t('col_stock')}</th><th>${t('col_seuil')}</th></tr></thead>
    <tbody>${list.map(p=>`<tr onclick="modalPiece(${p.id})">
      <td class="mono">${esc(p.ref)}</td><td>${esc(p.designation)}</td>
      <td style="color:var(--text3)">${esc(p.fournisseur||'')}</td>
      <td class="mono">${esc(p.ref_fournisseur||'')}</td>
      <td style="font-weight:700">${parseFloat(p.pxht||0).toFixed(2)} €</td>
      <td><span class="badge ${p.stock===0?'urgent':p.stock<=p.stock_alerte?'attente':'g'}">${p.stock}</span></td>
      <td style="font-size:11px;color:var(--text3)">${p.stock_alerte}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

// ── RAPPORTS ──────────────────────────────────────────────────────

async function renderRapports(ttl,c,a){
  ttl.textContent=t('rap_title');
  c.innerHTML=`
    <div class="grid-2" style="gap:14px">
      <div class="card">
        <div class="section-title"><i class="ti ti-file-spreadsheet"></i>Export Excel</div>
        <div class="form-group"><label class="form-label">Période</label>
          <div class="grid-2"><input class="form-input" id="exp-from" type="date"><input class="form-input" id="exp-to" type="date"></div>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;margin-top:4px">
          <button class="btn success" onclick="exportExcel('interventions')"><i class="ti ti-tool"></i>Interventions</button>
          <button class="btn success" onclick="exportExcel('catalogue')"><i class="ti ti-box"></i>Catalogue pièces</button>
          <button class="btn success" onclick="exportExcel('expeditions')"><i class="ti ti-truck-delivery"></i>Expéditions</button>
          <button class="btn success" onclick="exportExcel('clients')"><i class="ti ti-users"></i>Clients</button>
          <button class="btn primary" onclick="exportExcel('complet')"><i class="ti ti-file-zip"></i>Export complet (tous les onglets)</button>
        </div>
      </div>
      <div class="card">
        <div class="section-title"><i class="ti ti-file-type-pdf"></i>Export PDF</div>
        <div style="display:flex;flex-direction:column;gap:8px">
          <div style="font-size:12px;color:var(--text2)">Les PDF se génèrent depuis chaque fiche client, fauteuil ou intervention via le bouton PDF correspondant.</div>
          <div class="divider"></div>
          <div class="section-title"><i class="ti ti-filter"></i>Filtres interventions</div>
          <div class="form-group"><label class="form-label">Statut</label>
            <select class="form-input" id="r-statut"><option value="">Tous</option><option>Ouvert</option><option>En attente</option><option>Fermé</option></select>
          </div>
          <div class="form-group"><label class="form-label">Garantie</label>
            <select class="form-input" id="r-garantie"><option value="">Tous</option><option value="1">Sous garantie</option><option value="0">Hors garantie</option></select>
          </div>
          <button class="btn success" onclick="exportExcelFiltre()"><i class="ti ti-file-spreadsheet"></i>Export filtré</button>
        </div>
      </div>
    </div>`;
}

function exportExcel(type){
  API.exportExcel(type,{date_from:gv('exp-from')||undefined, date_to:gv('exp-to')||undefined});
  toast('Téléchargement en cours…','ti-download');
}
function exportExcelFiltre(){
  const params={};
  const s=gv('r-statut'); if(s) params.statut=s;
  const g=gv('r-garantie'); if(g!=='') params.garantie=g;
  API.exportExcel('interventions',params);
  toast('Téléchargement en cours…','ti-download');
}

// ── ALERTES ───────────────────────────────────────────────────────

async function renderAlertes(ttl,c,a){
  ttl.textContent=t('alertes_title');
  a.innerHTML=`<button class="btn" onclick="API.marquerToutesLues().then(()=>{refreshBadges();render();})"><i class="ti ti-checks"></i>${t('alertes_tout_lire')}</button>`;
  const list=await API.alertes();
  const icons={relance:'ti-clock',retour_manquant:'ti-truck-return',garantie_expire:'ti-shield-x',stock_faible:'ti-alert-triangle',stock_zero:'ti-circle-x',intervention_fermee:'ti-circle-check'};
  const colors={relance:'var(--warning)',retour_manquant:'var(--accent)',garantie_expire:'var(--danger)',stock_faible:'var(--warning)',stock_zero:'var(--danger)',intervention_fermee:'var(--success)'};
  c.innerHTML=list.length===0?`<div class="empty"><i class="ti ti-bell-off"></i>${t('alertes_empty')}</div>`:
    `<div class="card">${list.map(al=>`
      <div class="alerte-row">
        <div class="alerte-icon" style="background:${colors[al.type]||'var(--accent)'}20;color:${colors[al.type]||'var(--accent)'}">
          <i class="ti ${icons[al.type]||'ti-bell'}"></i>
        </div>
        <div style="flex:1">
          <div style="font-size:13px">${esc(al.message)}</div>
          <div style="font-size:11px;color:var(--text3);margin-top:2px">${al.created_at?.slice(0,16).replace('T',' ')}</div>
        </div>
        <button class="btn sm" onclick="API.marquerAlerteLue(${al.id}).then(()=>{refreshBadges();render();})"><i class="ti ti-x"></i></button>
      </div>`).join('')}</div>`;
}

// ── PARAMÈTRES ────────────────────────────────────────────────────

async function renderParametres(ttl,c,a){
  ttl.textContent=t('param_title');
  a.innerHTML=`<button class="btn primary" onclick="saveParametres()"><i class="ti ti-check"></i>${t('btn_enregistrer')}</button>`;
  const p=await API.parametres();
  CACHE.params=p;
  c.innerHTML=`
    <div class="param-section">
      <h3><i class="ti ti-bell"></i>${t('param_alertes')}</h3>
      <div class="grid-2">
        <div class="form-group"><label class="form-label">${t('param_relance')}</label>
          <input class="form-input" id="p-relance" type="number" min="1" value="${p.relance_jours||7}"></div>
        <div class="form-group"><label class="form-label">${t('param_stock_seuil')}</label>
          <input class="form-input" id="p-stock-alerte" type="number" min="0" value="${p.stock_alerte_defaut||2}"></div>
      </div>
    </div>
    <div class="param-section">
      <h3><i class="ti ti-mail"></i>${t('param_email_title')}</h3>
      <div style="font-size:12px;color:var(--text2);margin-bottom:10px">${t('param_email_hint')}</div>
      <div class="form-group"><label class="form-label">${t('param_email_active')}</label>
        <select class="form-input" id="p-email-notif">
          <option value="0" ${p.email_notifications!=='1'?'selected':''}>${t('param_email_off')}</option>
          <option value="1" ${p.email_notifications==='1'?'selected':''}>${t('param_email_on')}</option>
        </select>
      </div>
      <div class="grid-2">
        <div class="form-group"><label class="form-label">${t('param_smtp_server')}</label><input class="form-input" id="p-smtp-host" placeholder="smtp.gmail.com" value="${esc(p.email_smtp_host||'')}"></div>
        <div class="form-group"><label class="form-label">${t('param_smtp_port')}</label><input class="form-input" id="p-smtp-port" type="number" value="${p.email_smtp_port||587}"></div>
        <div class="form-group"><label class="form-label">${t('param_smtp_user')}</label><input class="form-input" id="p-smtp-user" placeholder="sav@eloflex.fr" value="${esc(p.email_smtp_user||'')}"></div>
        <div class="form-group"><label class="form-label">${t('param_smtp_pass')}</label><input class="form-input" id="p-smtp-pass" type="password" placeholder="••••••••" value="${esc(p.email_smtp_pass||'')}"></div>
        <div class="form-group" style="grid-column:1/-1"><label class="form-label">${t('param_email_from')}</label><input class="form-input" id="p-email-from" placeholder="SAV Éloflex <sav@eloflex.fr>" value="${esc(p.email_from||'')}"></div>
        <div class="form-group"><label class="form-label">CC — Emails SAV (confirmations, expéditions)</label><input class="form-input" id="p-email-cc-sav" placeholder="sav@eloflex.fr" value="${esc(p.email_cc_sav||'sav@eloflex.fr')}"></div>
        <div class="form-group"><label class="form-label">CC — Emails relances devis & BDC</label><input class="form-input" id="p-email-cc-relance" placeholder="info@eloflex.fr" value="${esc(p.email_cc_relance||'info@eloflex.fr')}"></div>
      </div>
    </div>
    <div class="param-section">
      <h3><i class="ti ti-building"></i>${t('param_societe')}</h3>
      <div class="form-group"><label class="form-label">${t('param_nom_societe')}</label>
        <input class="form-input" id="p-societe" value="${esc(p.nom_societe||'Éloflex France')}"></div>
    </div>
    <div class="param-section">
      <h3><i class="ti ti-globe"></i>${t('param_portail')}</h3>
      <div class="form-group"><label class="form-label">${t('param_portail')}</label>
        <select class="form-input" id="p-portail"><option value="1" ${p.portail_actif==='1'?'selected':''}>${t('param_portail_on')}</option><option value="0" ${p.portail_actif!=='1'?'selected':''}>${t('param_portail_off')}</option></select>
      </div>
      <div style="font-size:12px;color:var(--text2)">${t('param_portail_hint')}</div>
    </div>
    <div class="param-section">
      <h3><i class="ti ti-moon"></i>${t('param_apparence')}</h3>
      <div class="form-group"><label class="form-label">${t('param_dark')}</label>
        <select class="form-input" id="p-dark" onchange="if(this.value==='1')document.body.classList.add('dark');else document.body.classList.remove('dark')">
          <option value="0" ${p.mode_sombre!=='1'?'selected':''}>${t('param_dark_clair')}</option>
          <option value="1" ${p.mode_sombre==='1'?'selected':''}>${t('param_dark_sombre')}</option>
        </select>
      </div>
      <div class="form-group"><label class="form-label">${t('param_langue')}</label>
        <div style="display:flex;gap:8px;margin-top:4px">
          <button class="btn ${LANG==='fr'?'primary':''}" id="btn-lang-fr" onclick="switchLang('fr')" style="min-width:90px">🇫🇷 Français</button>
          <button class="btn ${LANG==='en'?'primary':''}" id="btn-lang-en" onclick="switchLang('en')" style="min-width:90px">🇬🇧 English</button>
        </div>
      </div>
    </div>
    <div class="param-section">
      <h3><i class="ti ti-file-import"></i>${t('param_import_title')}</h3>
      <div style="font-size:12px;color:var(--text2);margin-bottom:8px">${t('param_import_hint')}</div>
      <label class="btn" style="cursor:pointer;display:inline-flex;align-items:center;gap:6px">
        <i class="ti ti-file-import"></i>${t('param_import_choose')}
        <input type="file" accept=".xlsx,.xls" style="display:none" onchange="importerExcel(this.files[0])">
      </label>
      <div id="qs-import-progress" style="display:none;margin-top:10px"></div>
    </div>
    <div class="param-section">
      <h3><i class="ti ti-refresh"></i>${t('param_vf')}</h3>
      <div class="form-group"><label class="form-label">${t('param_vf_status')}</label>
        <div id="vf-status-detail" style="font-size:12px;color:var(--text2)">${t('param_vf_checking')}</div>
      </div>
      <button class="btn" onclick="syncVosFactures()"><i class="ti ti-refresh"></i>${t('param_vf_sync')}</button>
    </div>
    <div class="param-section">
      <h3><i class="ti ti-brand-stripe"></i> Pennylane <span id="pl-status-badge" style="font-size:11px;margin-left:8px"></span></h3>
      <p style="font-size:12px;color:var(--text2);margin-bottom:10px">
        Intégration Pennylane V2 — parallèle à VosFactures.<br>
        Configure la variable d'environnement <code>PENNYLANE_TOKEN</code> dans Render (Environment) avec ton token API Pennylane.
      </p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" onclick="syncPennylane(false)"><i class="ti ti-refresh"></i> Sync Pennylane (90j)</button>
        <button class="btn" onclick="syncPennylane(true)"><i class="ti ti-history"></i> Sync historique complet</button>
      </div>
      <div id="pl-sync-result" style="margin-top:8px"></div>
    </div>
    <div class="param-section">
      <h3><i class="ti ti-copy"></i> Doublons de commandes</h3>
      <p style="font-size:12px;color:var(--text2);margin-bottom:10px">Commandes ayant le même numéro de BDC ou devis pour le même distributeur.</p>
      <button class="btn danger" onclick="supprimerTousDoublons()" id="btn-suppr-doublons"><i class="ti ti-trash"></i> Supprimer tous les doublons</button>
      <div id="param-doublons-list" style="margin-top:10px"><div style="font-size:12px;color:var(--text2)"><i class="ti ti-loader-2"></i> Chargement…</div></div>
    </div>
    <div class="param-section">
      <h3><i class="ti ti-clock-exclamation"></i> Commandes bloquées</h3>
      <p style="font-size:12px;color:var(--text2);margin-bottom:10px">Commandes "En préparation" sans numéro de suivi valide depuis plus de :</p>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
        <select class="form-input" id="blocage-seuil" style="width:auto" onchange="chargerAlertesBlocage()">
          <option value="3">3 jours</option>
          <option value="7" selected>7 jours</option>
          <option value="14">14 jours</option>
          <option value="30">30 jours</option>
        </select>
        <button class="btn sm" onclick="chargerAlertesBlocage()"><i class="ti ti-refresh"></i> Actualiser</button>
      </div>
      <div id="alertes-blocage-list"><div style="font-size:12px;color:var(--text2)"><i class="ti ti-loader-2"></i> Chargement…</div></div>
    </div>
    <div class="param-section">
      <h3><i class="ti ti-receipt-2"></i> Migration facturation historique</h3>
      <p style="font-size:12px;color:var(--text2);margin-bottom:10px">
        Passe toutes les commandes antérieures à juin 2026 (hors Annulé et déjà Facturé) au statut <b>Facturé</b>.<br>
        <span style="color:var(--danger);font-size:11px">⚠ Action irréversible — à n'exécuter qu'une seule fois.</span>
      </p>
      <button class="btn" onclick="lancerMigrationFacture()" id="btn-migration-facture"><i class="ti ti-check"></i> Passer l'historique en Facturé</button>
      <div id="migration-facture-result" style="margin-top:8px"></div>
    </div>
    <div class="param-section">
      <h3><i class="ti ti-database-export"></i> Nettoyage N° suivi</h3>
      <p style="font-size:12px;color:var(--text2);margin-bottom:10px">Migre les valeurs texte ("RETOUR BRICE", "SUÈDE", "ATTENTE VALIDATION"…) stockées dans le champ N° suivi vers les champs appropriés : retours → N° retour, autres → Informations.</p>
      <button class="btn" onclick="lancerMigrationSuivi()"><i class="ti ti-arrow-merge"></i> Lancer la migration</button>
      <div id="migration-suivi-result" style="margin-top:8px"></div>
    </div>
      <p style="font-size:12px;color:var(--text2);margin-bottom:12px">
        Importe toutes les commandes de ton fichier Excel (onglets 2019, 2020… 2026) sans avoir besoin du terminal.
        L'import est idempotent : relancer ne crée pas de doublons.
      </p>
      <label class="btn" style="cursor:pointer;display:inline-flex">
        <i class="ti ti-upload"></i> Choisir le fichier Excel comptabilité…
        <input type="file" accept=".xlsx,.xls" style="display:none" onchange="importerHistoriqueCommandes(this.files[0])">
      </label>
      <div id="import-commandes-result" style="margin-top:10px"></div>
    </div>`;
  API.vfStatus().then(s=>{const el=$('vf-status-detail');if(el)el.innerHTML=s.configured?`<span style="color:var(--success)">✓ Compte configuré : ${esc(s.account||'')}${s.last_sync?' — Dernière sync : '+s.last_sync.created_at?.slice(0,16).replace('T',' '):''}</span>`:`<span style="color:var(--danger)">⚠ Non configuré — renseigner VOSFACTURES_API_TOKEN et VOSFACTURES_ACCOUNT dans .env</span>`;}).catch(()=>{});

  // Section utilisateurs — toujours affichée dans Paramètres (la route /parametres est déjà adminOnly)
  const usersSection = document.createElement('div');
  usersSection.className = 'param-section';
  usersSection.id = 'section-utilisateurs';
  usersSection.innerHTML = `
    <h3><i class="ti ti-users-group"></i> Utilisateurs & accès</h3>
    <div id="users-list-wrap" style="margin-bottom:14px"><div style="font-size:12px;color:var(--text2)"><i class="ti ti-loader-2"></i> Chargement…</div></div>
    <button class="btn primary" onclick="modalNouvelUtilisateur()"><i class="ti ti-user-plus"></i> Ajouter un utilisateur</button>`;
  c.appendChild(usersSection);
  chargerListeUtilisateurs();
  chargerAlertesBlocage();
  chargerDoublonsParametres();
  loadPennylaneStatus();
}

async function chargerListeUtilisateurs(){
  const wrap = $('users-list-wrap'); if(!wrap) return;
  wrap.innerHTML = `<div style="font-size:12px;color:var(--text2)"><i class="ti ti-loader-2"></i> Chargement…</div>`;
  try{
    const users = await API.users();
    if(!users.length){ wrap.innerHTML=`<div style="font-size:12px;color:var(--text2)">Aucun utilisateur.</div>`; return; }
    wrap.innerHTML=`<div class="table-wrap"><table class="t">
      <thead><tr><th>Nom</th><th>E-mail</th><th>Pays</th><th>Type</th><th>Statut</th><th>Dernière connexion</th><th></th></tr></thead>
      <tbody>${users.map(u=>`<tr>
        <td style="font-weight:600">${esc(u.nom)}</td>
        <td style="font-size:12px">${esc(u.email)}</td>
        <td><span style="font-size:12px">${u.pays||'<span style="color:var(--text3)">🌍 Tous</span>'}</span></td>
        <td><span class="badge ${u.role==='admin'?'urgent':'attente'}">${u.role==='admin'?'Administrateur':'Utilisateur'}</span></td>
        <td><span class="badge ${u.actif?'g':'hg'}">${u.actif?'Actif':'Désactivé'}</span></td>
        <td style="font-size:11px;color:var(--text2)">${u.last_login?fd(u.last_login.slice(0,10)):'—'}</td>
        <td style="display:flex;gap:6px;justify-content:flex-end">
          <button class="btn sm" onclick="modalEditerUtilisateur(${u.id})" title="Modifier"><i class="ti ti-edit"></i></button>
          <button class="btn sm" onclick="modalResetPassword(${u.id},'${esc(u.nom)}')" title="Changer le mot de passe"><i class="ti ti-key"></i></button>
          ${u.id!==CURRENT_USER.id?`<button class="btn sm danger" onclick="supprimerUtilisateur(${u.id},'${esc(u.nom)}')" title="Supprimer"><i class="ti ti-trash"></i></button>`:''}
        </td>
      </tr>`).join('')}</tbody>
    </table></div>`;
  }catch(e){ wrap.innerHTML=`<div style="font-size:12px;color:var(--danger)">${esc(e.message)}</div>`; }
}

function _permGrid(perms={}){
  return `<div style="margin-top:4px;border:0.5px solid var(--border-s);border-radius:var(--radius);overflow:hidden">
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr style="background:var(--bg)">
        <th style="padding:6px 10px;text-align:left;font-weight:600;color:var(--text2)">Module</th>
        <th style="padding:6px 10px;text-align:center;font-weight:600;color:var(--success);width:100px">Accès complet</th>
        <th style="padding:6px 10px;text-align:center;font-weight:600;color:var(--warning);width:100px">Lecture seule</th>
        <th style="padding:6px 10px;text-align:center;font-weight:600;color:var(--text3);width:90px">Masquée</th>
      </tr></thead>
      <tbody>${MODULES.map((m,i)=>`<tr style="${i%2===0?'background:var(--surface)':'background:var(--bg)'}">
        <td style="padding:7px 10px">${m.label}</td>
        <td style="text-align:center"><input type="radio" name="perm-${m.key}" value="write"  ${perms[m.key]==='write'?'checked':''}></td>
        <td style="text-align:center"><input type="radio" name="perm-${m.key}" value="read"   ${perms[m.key]==='read'?'checked':''}></td>
        <td style="text-align:center"><input type="radio" name="perm-${m.key}" value="hidden" ${perms[m.key]==='hidden'||perms[m.key]==='none'||!perms[m.key]?'checked':''}></td>
      </tr>`).join('')}</tbody>
    </table>
  </div>`;
}

function _collectPerms(){
  const p={};
  MODULES.forEach(m=>{
    const checked=document.querySelector(`input[name="perm-${m.key}"]:checked`);
    p[m.key]=checked?checked.value:'hidden';
  });
  return p;
}

function _onAdminToggle(){
  const isA = document.getElementById('nu-admin')?.checked || document.getElementById('eu-admin')?.checked;
  const grid = document.getElementById('perm-grid');
  if(grid) grid.style.display = isA ? 'none' : '';
}

function modalNouvelUtilisateur(){
  showModal(`
    <div class="modal-header"><i class="ti ti-user-plus" style="color:var(--accent)"></i><h2>Nouvel utilisateur</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body" style="max-height:70vh;overflow-y:auto">
      <div class="grid-2">
        <div class="form-group" style="grid-column:1/-1"><label class="form-label">Prénom et nom *</label><input class="form-input" id="nu-nom" placeholder="Frédéric Dijd"></div>
        <div class="form-group" style="grid-column:1/-1"><label class="form-label">Adresse e-mail *</label><input class="form-input" id="nu-email" type="email" placeholder="frederic@eloflex.fr"></div>
        <div class="form-group"><label class="form-label">Mot de passe * <span style="font-size:10px;color:var(--text2)">(8 car. min.)</span></label><input class="form-input" id="nu-mdp" type="password" placeholder="••••••••"></div>
        <div class="form-group"><label class="form-label">Langue de l'interface</label>
          <select class="form-input" id="nu-langue">
            <option value="fr">🇫🇷 Français</option>
            <option value="en">🇬🇧 English</option>
          </select>
        </div>
        <div class="form-group" style="grid-column:1/-1"><label class="form-label">Pays / Périmètre commandes</label>
          <select class="form-input" id="nu-pays">
            <option value="">🌍 Tous pays (admin global)</option>
            <option value="France">🇫🇷 France</option>
            <option value="Sweden">🇸🇪 Suède</option>
            <option value="UK">🇬🇧 United Kingdom</option>
            <option value="Germany">🇩🇪 Deutschland</option>
            <option value="Spain">🇪🇸 España</option>
            <option value="Italy">🇮🇹 Italia</option>
            <option value="Belgium">🇧🇪 Belgique</option>
            <option value="Switzerland">🇨🇭 Suisse</option>
            <option value="Netherlands">🇳🇱 Nederland</option>
          </select>
          <div style="font-size:11px;color:var(--text2);margin-top:4px">Laisse vide pour un accès admin à tous les pays.</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;margin:12px 0;padding:10px 12px;background:var(--danger-bg);border-radius:var(--radius)">
        <input type="checkbox" id="nu-admin" onchange="_onAdminToggle()" style="width:16px;height:16px;cursor:pointer">
        <label for="nu-admin" style="font-size:13px;font-weight:600;color:var(--danger);cursor:pointer">Administrateur — accès complet à tout (y compris Paramètres et exports)</label>
      </div>
      <div id="perm-grid">
        <div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:6px">Permissions par module (cocher une case par ligne, ou aucune pour bloquer l'accès) :</div>
        ${_permGrid()}
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">Annuler</button>
      <button class="btn primary" onclick="creerUtilisateur()"><i class="ti ti-check"></i> Créer</button>
    </div>`);
}

async function creerUtilisateur(){
  const nom=gv('nu-nom'), email=gv('nu-email'), mot_de_passe=gv('nu-mdp'), langue=gv('nu-langue')||'fr', pays=gv('nu-pays')||null;
  const admin=!!document.getElementById('nu-admin')?.checked;
  const permissions=admin?{}:_collectPerms();
  if(!nom||!email||!mot_de_passe){ toast('Nom, email et mot de passe sont requis.','ti-alert-circle','var(--danger)'); return; }
  try{
    await API.createUser({nom, email, mot_de_passe, admin, permissions, langue, pays});
    closeModal(); toast(`Compte créé pour ${nom}`); chargerListeUtilisateurs();
  }catch(e){ toast(e.message,'ti-alert-circle','var(--danger)'); }
}

async function modalEditerUtilisateur(id){
  let user;
  try{ const list=await API.users(); user=list.find(u=>u.id===id); } catch(e){ toast(e.message,'ti-alert-circle','var(--danger)'); return; }
  if(!user) return;
  const perms = user.permissions||{};
  showModal(`
    <div class="modal-header"><i class="ti ti-edit" style="color:var(--accent)"></i><h2>Modifier l'utilisateur</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body" style="max-height:70vh;overflow-y:auto">
      <div class="grid-2">
        <div class="form-group" style="grid-column:1/-1"><label class="form-label">Prénom et nom</label><input class="form-input" id="eu-nom" value="${esc(user.nom)}"></div>
        <div class="form-group" style="grid-column:1/-1"><label class="form-label">E-mail</label><input class="form-input" id="eu-email" type="email" value="${esc(user.email)}"></div>
        <div class="form-group"><label class="form-label">Langue de l'interface</label>
          <select class="form-input" id="eu-langue">
            <option value="fr" ${(user.langue||'fr')==='fr'?'selected':''}>🇫🇷 Français</option>
            <option value="en" ${user.langue==='en'?'selected':''}>🇬🇧 English</option>
          </select>
        </div>
        <div class="form-group" style="grid-column:1/-1"><label class="form-label">Pays / Périmètre commandes</label>
          <select class="form-input" id="eu-pays">
            <option value="" ${!user.pays?'selected':''}>🌍 Tous pays (admin global)</option>
            <option value="France" ${user.pays==='France'?'selected':''}>🇫🇷 France</option>
            <option value="Sweden" ${user.pays==='Sweden'?'selected':''}>🇸🇪 Suède</option>
            <option value="UK" ${user.pays==='UK'?'selected':''}>🇬🇧 United Kingdom</option>
            <option value="Germany" ${user.pays==='Germany'?'selected':''}>🇩🇪 Deutschland</option>
            <option value="Spain" ${user.pays==='Spain'?'selected':''}>🇪🇸 España</option>
            <option value="Italy" ${user.pays==='Italy'?'selected':''}>🇮🇹 Italia</option>
            <option value="Belgium" ${user.pays==='Belgium'?'selected':''}>🇧🇪 Belgique</option>
            <option value="Switzerland" ${user.pays==='Switzerland'?'selected':''}>🇨🇭 Suisse</option>
            <option value="Netherlands" ${user.pays==='Netherlands'?'selected':''}>🇳🇱 Nederland</option>
          </select>
        </div>
        <div class="form-group"><label class="form-label">Statut</label>
          <select class="form-input" id="eu-actif">
            <option value="1" ${user.actif?'selected':''}>Actif</option>
            <option value="0" ${!user.actif?'selected':''}>Désactivé</option>
          </select>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;margin:12px 0;padding:10px 12px;background:var(--danger-bg);border-radius:var(--radius)">
        <input type="checkbox" id="eu-admin" onchange="_onAdminToggle()" ${user.role==='admin'?'checked':''} style="width:16px;height:16px;cursor:pointer">
        <label for="eu-admin" style="font-size:13px;font-weight:600;color:var(--danger);cursor:pointer">Administrateur — accès complet à tout</label>
      </div>
      <div id="perm-grid" ${user.role==='admin'?'style="display:none"':''}>
        <div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:6px">Permissions par module :</div>
        ${_permGrid(perms)}
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">Annuler</button>
      <button class="btn primary" onclick="enregistrerUtilisateur(${id})"><i class="ti ti-check"></i> Enregistrer</button>
    </div>`);
}

async function enregistrerUtilisateur(id){
  const admin=!!document.getElementById('eu-admin')?.checked;
  const permissions=admin?{}:_collectPerms();
  const langue=gv('eu-langue')||'fr';
  const pays=gv('eu-pays')||null;
  try{
    await API.updateUser(id, { nom:gv('eu-nom'), email:gv('eu-email'), admin, permissions, langue, actif: gv('eu-actif')==='1', pays });
    closeModal(); toast('Utilisateur mis à jour'); chargerListeUtilisateurs();
  }catch(e){ toast(e.message,'ti-alert-circle','var(--danger)'); }
}

function modalResetPassword(id, nom){
  showModal(`
    <div class="modal-header"><i class="ti ti-key" style="color:var(--accent)"></i><h2>Nouveau mot de passe</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body">
      <div style="margin-bottom:12px;font-size:13px">Définir un nouveau mot de passe pour <b>${esc(nom)}</b>.</div>
      <div class="form-group"><label class="form-label">Nouveau mot de passe <span style="font-size:10px;color:var(--text2)">(8 car. min.)</span></label>
        <input class="form-input" id="rp-mdp" type="password" placeholder="••••••••"></div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">Annuler</button>
      <button class="btn primary" onclick="appliquerResetPassword(${id})"><i class="ti ti-check"></i> Appliquer</button>
    </div>`);
}

async function appliquerResetPassword(id){
  const mdp = gv('rp-mdp');
  if(mdp.length < 8){ toast('Minimum 8 caractères.','ti-alert-circle','var(--danger)'); return; }
  try{
    const r = await API.resetUserPassword(id, mdp);
    closeModal(); toast(r.message||'Mot de passe mis à jour');
  }catch(e){ toast(e.message,'ti-alert-circle','var(--danger)'); }
}

async function supprimerUtilisateur(id, nom){
  if(!confirm(`Supprimer définitivement le compte de ${nom} ?`)) return;
  try{
    await API.deleteUser(id);
    toast(`Compte de ${nom} supprimé`);
    chargerListeUtilisateurs();
  }catch(e){ toast(e.message,'ti-alert-circle','var(--danger)'); }
}

async function envoyerEmailConfirmation(id){
  if(!confirm('Envoyer un email de demande de confirmation BDC au distributeur ?')) return;
  toast('Envoi en cours…','ti-loader-2');
  try{
    const r = await API.emailConfirmation(id);
    if(r.ok){ toast(`Email de confirmation envoyé à ${r.to}`,'ti-mail'); closeModal(); render(); }
    else toast(`Non envoyé : ${r.reason}`,'ti-alert-circle','var(--warning)');
  }catch(e){ toast(e.message,'ti-alert-circle','var(--danger)'); }
}

async function genererFactureVF(id){
  if(!confirm('Générer la facture dans VosFactures ?\n\nLa commande passera au statut "Facturé" et le N° de facture sera renseigné automatiquement.')) return;
  toast('Génération en cours…','ti-loader-2');
  try{
    const r = await API.genererFacture(id);
    if(r.ok){
      toast(`Facture ${r.numero} créée dans VosFactures`,'ti-receipt-2');
      if(r.url) window.open(r.url,'_blank');
      closeModal(); render();
    } else toast(`Erreur : ${r.reason}`,'ti-alert-circle','var(--warning)');
  }catch(e){ toast(e.message,'ti-alert-circle','var(--danger)'); }
}

async function ouvrirDansVF(vfId, bdc){
  const account = window._VF_ACCOUNT;
  if(!account){ toast('Compte VosFactures non configuré','ti-alert-circle','var(--warning)'); return; }
  // Si on a l'ID VosFactures → lien direct vers le document
  if(vfId){
    window.open(`https://${account}.vosfactures.fr/invoices/${vfId}`, '_blank', 'noopener');
    return;
  }
  if(!bdc){ toast('Renseigne d\'abord le numéro','ti-alert-circle','var(--warning)'); return; }
  // Pas d'ID connu → ouvrir directement la recherche VosFactures
  // (évite l'API qui ne supporte pas les WZ en recherche par numéro)
  window.open(`https://${account}.vosfactures.fr/invoices?search_text=${encodeURIComponent(bdc)}`, '_blank', 'noopener');
}

async function creerBLVF(id){
  if(!confirm('Créer le bordereau de livraison dans VosFactures ?')) return;
  toast('Création BL en cours…','ti-loader-2');
  try{
    const r = await API.creerBL(id);
    if(r.ok){
      toast(`BL ${r.numero} créé dans VosFactures`,'ti-clipboard-check');
      if(r.url) window.open(r.url,'_blank');
      closeModal(); render();
    } else toast(`Erreur : ${r.reason}`,'ti-alert-circle','var(--warning)');
  }catch(e){ toast(e.message,'ti-alert-circle','var(--danger)'); }
}

// ── Vue Kanban ────────────────────────────────────────────────────
let CMD_VIEW = 'liste'; // 'liste' | 'kanban'

async function renderCommandesKanban(){
  const wrap=$('cmd-table-wrap'); if(!wrap) return;
  wrap.innerHTML=`<div style="color:var(--text2);padding:20px"><i class="ti ti-loader-2"></i> Chargement…</div>`;
  const res = await API.commandes({ annee: CMD_FILTERS.annee, mois: CMD_FILTERS.mois, statut: CMD_FILTERS.statut, distributeur: CMD_FILTERS.distributeur, q: CMD_FILTERS.q, per_page: 500, ...((_PAYS_FILTRE||CURRENT_USER.pays)?{pays:_PAYS_FILTRE||CURRENT_USER.pays}:{}) });
  const list = res.rows||[];
  const COLS = ['En attente confirmation','En préparation','Expédié','Livré','Facturé','Problème'];
  const grouped = {};
  COLS.forEach(s => grouped[s] = []);
  list.forEach(cm => {
    const s = cm.statut_calc || 'En préparation';
    if(grouped[s]) grouped[s].push(cm); else grouped['En préparation'].push(cm);
  });
  wrap.innerHTML=`<div style="display:flex;gap:10px;overflow-x:auto;padding-bottom:8px">
    ${COLS.map(col=>`
      <div style="min-width:220px;flex:0 0 220px">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text2);margin-bottom:8px;display:flex;justify-content:space-between">
          <span>${tStatut(col)}</span>
          <span class="badge ${cmdStatutClass(col)}" style="font-size:10px">${grouped[col].length}</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px">
          ${grouped[col].map(cm=>`
            <div onclick="modalCommande(${cm.id})" style="padding:10px 12px;background:var(--surface);border:0.5px solid var(--border-s);border-radius:var(--radius);cursor:pointer;font-size:12px">
              <div style="font-weight:700;margin-bottom:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(cm.distributeur_nom)}</div>
              <div style="color:var(--text2);display:flex;justify-content:space-between">
                <span class="mono">${esc(cm.bdc||'—')}</span>
                <span>${fd(cm.date_commande)}</span>
              </div>
              ${cm.modele?`<div style="color:var(--text3);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:3px">${esc(cm.modele)}</div>`:''}
              ${cm.reliquat?`<span class="badge hg" style="font-size:10px;margin-top:4px;display:inline-block">⏰ Reliquat</span>`:''}
              ${cm.modele_demo?`<span class="badge hg" style="font-size:10px;margin-top:4px;display:inline-block">🔄 Démo</span>`:''}
            </div>`).join('')}
          ${grouped[col].length===0?`<div style="font-size:12px;color:var(--text3);text-align:center;padding:12px 0">—</div>`:''}
        </div>
      </div>`).join('')}
  </div>`;
}

async function envoyerEmailExpedition(id){
  if(!confirm('Envoyer la confirmation d\'expédition par email au distributeur ?')) return;
  toast('Envoi en cours…','ti-loader-2');
  try{
    const r = await API.emailExpedition(id);
    if(r.ok) toast(`Email envoyé à ${r.to}`,'ti-mail');
    else toast(`Non envoyé : ${r.reason}`,'ti-alert-circle','var(--warning)');
  }catch(e){ toast(e.message,'ti-alert-circle','var(--danger)'); }
}

async function chargerDoublonsBanner(){
  const banner = $('doublons-banner'); if(!banner) return;
  try{
    const rows = await API.commandesDoublons();
    if(!rows.length){ banner.innerHTML=''; return; }
    banner.innerHTML=`
      <div style="display:flex;align-items:flex-start;gap:12px;padding:12px 16px;background:var(--warning-bg);border:0.5px solid var(--warning);border-radius:var(--radius);margin-bottom:14px">
        <i class="ti ti-alert-triangle" style="color:var(--warning);font-size:18px;flex-shrink:0;margin-top:1px"></i>
        <div style="flex:1">
          <div style="font-weight:700;font-size:13px;color:var(--warning);margin-bottom:8px;display:flex;align-items:center;justify-content:space-between">
            <span>${rows.length} doublon${rows.length>1?'s':''} détecté${rows.length>1?'s':''} — même numéro de BDC pour plusieurs commandes</span>
            <button class="btn sm danger" onclick="supprimerTousDoublonsBanner(this)" style="margin-left:12px;white-space:nowrap"><i class="ti ti-trash"></i> Supprimer tous</button>
          </div>
          <div class="table-wrap"><table class="t" style="font-size:12px">
            <thead><tr><th>BDC</th><th>Distributeur</th><th style="text-align:center">Nb</th><th>Commandes</th></tr></thead>
            <tbody>${rows.map(r=>`<tr>
              <td class="mono"><b>${esc(r.bdc)}</b></td>
              <td>${esc(r.distributeur_nom)}</td>
              <td style="text-align:center"><span class="badge urgent">${r.nb}×</span></td>
              <td>${(Array.isArray(r.ids)?r.ids:[r.ids]).map((id,i)=>`
                <button class="btn sm" onclick="modalCommande(${id})" style="margin:1px">
                  <i class="ti ti-clipboard-list"></i> #${id}
                  ${Array.isArray(r.dates)&&r.dates[i]?' · '+fd(r.dates[i]):''}
                </button>`).join('')}
              </td>
            </tr>`).join('')}
            </tbody>
          </table></div>
        </div>
        <button class="btn sm" onclick="this.closest('[style]').remove()" title="Masquer" style="flex-shrink:0"><i class="ti ti-x"></i></button>
      </div>`;
  }catch(e){ console.warn('doublons:', e.message); }
}

async function chargerAlertesBlocage(){
  const el=$('alertes-blocage-list'); if(!el) return;
  el.innerHTML=`<div style="font-size:12px;color:var(--text2)"><i class="ti ti-loader-2"></i> Chargement…</div>`;
  try{
    const jours = parseInt($('blocage-seuil')?.value)||7;
    const data = await API.commandesAlertesBlocage(jours);
    // Support ancien format (tableau) et nouveau format (objet avec 2 listes)
    const nonExp  = Array.isArray(data) ? data : (data.non_expedies||[]);
    const nonFact = Array.isArray(data) ? [] : (data.non_facturees||[]);
    if(!nonExp.length && !nonFact.length){
      el.innerHTML=`<div style="font-size:12px;color:var(--success)"><i class="ti ti-check"></i> Aucune alerte — tout est à jour !</div>`;
      return;
    }
    const tableRow = (r, type) => `<tr onclick="modalCommande(${r.id})" style="cursor:pointer">
      <td><span class="badge ${type==='non_expedie'?'attente':'urgent'}" style="font-size:10px">${type==='non_expedie'?'📦 Non expédié':'🧾 Non facturé'}</span></td>
      <td>${esc(r.distributeur_nom)}</td>
      <td class="mono">${esc(r.bdc||'')}</td>
      <td style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.modele||'')}</td>
      <td>${fd(r.date_commande||r.date_livraison)}</td>
      <td><span class="badge ${r.jours_attente>14?'urgent':'hg'}">${r.jours_attente}j</span></td>
      <td><button class="btn sm" onclick="event.stopPropagation();modalCommande(${r.id})"><i class="ti ti-pencil"></i></button></td>
    </tr>`;
    el.innerHTML=`<div class="table-wrap"><table class="t">
      <thead><tr><th>Type</th><th>Distributeur</th><th>Bdc</th><th>Modèle</th><th>Date réf.</th><th>Délai</th><th></th></tr></thead>
      <tbody>
        ${nonExp.map(r=>tableRow(r,'non_expedie')).join('')}
        ${nonFact.map(r=>tableRow(r,'non_facturee')).join('')}
      </tbody>
    </table></div>`;
  }catch(e){ el.innerHTML=`<div style="font-size:12px;color:var(--danger)">${esc(e.message)}</div>`; }
}

async function supprimerTousDoublonsBanner(btn){
  if(!confirm('Supprimer tous les doublons ?\n\nPour chaque BDC en doublon, la commande la plus complète est conservée (priorité : source VosFactures > N° suivi > N° série > facture).\n\nAction irréversible.')) return;
  if(btn){ btn.disabled=true; btn.innerHTML='<i class="ti ti-loader-2"></i> Suppression…'; }
  try{
    const r = await API.supprimerDoublons();
    toast(`✅ ${r.supprimes} doublon(s) supprimé(s)`,'ti-check');
    render(); // Recharge la page entière pour effacer la bannière
  }catch(e){
    toast(e.message,'ti-alert-circle','var(--danger)');
    if(btn){ btn.disabled=false; btn.innerHTML='<i class="ti ti-trash"></i> Supprimer tous'; }
  }
}

async function supprimerTousDoublons(){
  const el=$('param-doublons-list');
  const btn=$('btn-suppr-doublons');
  const rows = el?.querySelectorAll('tbody tr');
  const nb = rows?.length || 0;
  if(!confirm(`Supprimer les doublons ?\n\nPour chaque groupe, la commande la plus complète est conservée (priorité : source VosFactures > N° suivi > N° série > facture).\n\nAction irréversible.`)) return;
  if(btn) btn.disabled=true;
  toast('Suppression en cours…','ti-loader-2');
  try{
    const r = await API.supprimerDoublons();
    toast(`✅ ${r.supprimes} doublon(s) supprimé(s) sur ${r.groupes} groupe(s)`,'ti-check');
    chargerDoublonsParametres();
    if(btn){ btn.disabled=true; btn.textContent='✓ Doublons supprimés'; }
  }catch(e){
    toast(e.message,'ti-alert-circle','var(--danger)');
    if(btn) btn.disabled=false;
  }
}

async function chargerDoublonsParametres(){
  const el=$('param-doublons-list'); if(!el) return;
  try{
    const rows = await API.commandesDoublons();
    if(!rows.length){
      el.innerHTML=`<div style="font-size:12px;color:var(--success)"><i class="ti ti-check"></i> Aucun doublon détecté.</div>`;
      return;
    }
    el.innerHTML=`<div style="font-size:12px;color:var(--warning);margin-bottom:8px;font-weight:600">
      <i class="ti ti-alert-triangle"></i> ${rows.length} BDC en doublon
    </div>
    <div class="table-wrap"><table class="t" style="font-size:12px">
      <thead><tr><th>BDC</th><th>Distributeur</th><th>Nb</th><th>Commandes</th></tr></thead>
      <tbody>${rows.map(r=>`<tr>
        <td class="mono"><b>${esc(r.bdc)}</b></td>
        <td>${esc(r.distributeur_nom)}</td>
        <td><span class="badge urgent">${r.nb}×</span></td>
        <td>${(Array.isArray(r.ids)?r.ids:[r.ids]).map(id=>`
          <button class="btn sm" onclick="setView('commandes');setTimeout(()=>modalCommande(${id}),300)">#${id}</button>`).join(' ')}
        </td>
      </tr>`).join('')}
      </tbody>
    </table></div>`;
  }catch(e){ el.innerHTML=`<div style="font-size:12px;color:var(--danger)">${esc(e.message)}</div>`; }
}

async function lancerMigrationFacture(){
  if(!confirm('Passer TOUTES les commandes antérieures à juin 2026 au statut "Facturé" ?\n\nCela exclut les commandes déjà "Annulé" et déjà "Facturé".\nAction irréversible.')) return;
  const btn=$('btn-migration-facture'); if(btn) btn.disabled=true;
  toast('Migration en cours…','ti-loader-2');
  try{
    const r = await API.migrationFactureHistorique();
    const msg = `✅ ${r.mises_a_jour} commande(s) passée(s) en Facturé.`;
    $('migration-facture-result').innerHTML=`<div style="padding:8px 12px;background:var(--success-bg);border:0.5px solid var(--success);border-radius:var(--radius);font-size:12px;color:var(--success)">${msg}</div>`;
    toast(msg,'ti-check');
    if(btn){ btn.disabled=true; btn.innerHTML='<i class="ti ti-check"></i> Migration effectuée'; }
  }catch(e){
    $('migration-facture-result').innerHTML=`<div style="color:var(--danger);font-size:12px">❌ ${esc(e.message)}</div>`;
    if(btn) btn.disabled=false;
  }
}

async function lancerMigrationSuivi(){
  if(!confirm('Migrer les faux numéros de suivi (RETOUR BRICE, SUÈDE, etc.) vers les champs appropriés ? Cette action est irréversible.')) return;
  toast('Migration en cours…','ti-loader-2');
  try{
    const r = await API.fixSuivi();
    toast(r.detail,'ti-check');
  }catch(e){ toast(e.message,'ti-alert-circle','var(--danger)'); }
}

async function saveParametres(){
  const p={
    relance_jours:gv('p-relance'),
    stock_alerte_defaut:gv('p-stock-alerte'),
    stock_gestion_active:gv('p-stock-gestion')||'1',
    nom_societe:gv('p-societe'),
    portail_actif:gv('p-portail'),
    mode_sombre:gv('p-dark'),
    sync_vf_auto:gv('p-vf-auto')||'1',
    app_url:gv('p-appurl')||'',
    email_notifications:gv('p-email-notif')||'0',
    email_smtp_host:gv('p-smtp-host')||'',
    email_smtp_port:gv('p-smtp-port')||'587',
    email_smtp_user:gv('p-smtp-user')||'',
    email_smtp_pass:gv('p-smtp-pass')||'',
    email_from:gv('p-email-from')||''
  };
  await API.saveParametres(p);
  if(p.mode_sombre==='1') document.body.classList.add('dark'); else document.body.classList.remove('dark');
  localStorage.setItem('dark', p.mode_sombre==='1'?'1':'0');
  toast(t('param_saved'),'ti-check');
}

// ── DÉTAIL INTERVENTION ───────────────────────────────────────────

async function viewIntervention(id){
  const[i,photos]=await Promise.all([API.intervention(id),API.photos(id)]);
  const total=(i.produits||[]).reduce((s,p)=>s+parseFloat(p.pxht||0)*p.qte,0);
  showModal(`
    <div class="modal-header">
      <i class="ti ti-tool" style="font-size:18px;color:var(--accent)"></i>
      <h2>${esc(i.num_sav||'#'+i.id)} — ${traduireType(i.type)}</h2>
      <button class="btn sm success" onclick="exportInterventionPDF(${i.id})"><i class="ti ti-file-type-pdf"></i>PDF</button>
      <button class="btn sm" onclick="envoyerEmailInter(${i.id})" title="Envoyer notification au distributeur"><i class="ti ti-mail"></i></button>
      <button class="btn sm" onclick="modalEditIntervention(${i.id})"><i class="ti ti-edit"></i></button>
      <button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button>
    </div>
    <div class="modal-body">
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
        <span class="badge ${i.garantie?'g':'hg'}">${i.garantie?'Sous garantie':'Hors garantie'}</span>
        ${i.garantie_auto?'<span style="font-size:10px;color:var(--text3)">détecté auto</span>':''}
        <span class="badge ${sc(i.statut)}">${traduireStatut(i.statut)}</span>
        <span style="font-size:11px;color:var(--text3);margin-left:auto">${fd(i.date)}</span>
      </div>
      <div class="grid-2" style="font-size:12px;margin-bottom:12px">
        <div><div class="stat-label">Client</div><div style="font-weight:600">${esc(i.client_nom||'')}</div></div>
        <div><div class="stat-label">Fauteuil</div><div style="font-weight:600">${esc(i.modele)} – <span class="mono">${esc(i.serie)}</span></div></div>
        <div>
          <div class="stat-label">Facture VosFactures
            <button class="btn sm" style="padding:1px 6px;font-size:10px;margin-left:6px" onclick="toggleEditFacture(${i.id},'${esc(i.num_facture||'')}')"><i class="ti ti-edit" style="font-size:10px"></i></button>
          </div>
          <div id="facture-display-${i.id}">
            ${i.num_facture?`<span class="mono" style="color:var(--accent)">${esc(i.num_facture)}</span>`:'<span style="color:var(--text3)">—</span>'}
          </div>
          <div id="facture-edit-${i.id}" style="display:none;display:flex;gap:6px;align-items:center;margin-top:4px">
            <input class="form-input mono" id="facture-input-${i.id}" style="font-size:12px;padding:4px 8px;flex:1" placeholder="ex: 7574" value="${esc(i.num_facture||'')}">
            <button class="btn sm primary" onclick="saveFactureInter(${i.id})"><i class="ti ti-check"></i></button>
            <button class="btn sm" onclick="document.getElementById('facture-edit-${i.id}').style.display='none';document.getElementById('facture-display-${i.id}').style.display='block'"><i class="ti ti-x"></i></button>
          </div>
        </div>
        <div><div class="stat-label">Technicien</div><div>${esc(i.technicien||'—')}</div></div>
      </div>
      <div class="form-group"><div class="form-label">Description</div><div style="font-size:12px;background:var(--bg);padding:8px;border-radius:var(--radius)">${esc(i.description||'—')}</div></div>
      ${i.notes?`<div class="form-group"><div class="form-label">Intervention réalisée</div><div style="font-size:12px;color:var(--text2)">${esc(i.notes)}</div></div>`:''}
      <div class="divider"></div>
      <div class="section-title"><i class="ti ti-box"></i>Pièces</div>
      ${(i.produits||[]).length===0?'<div style="font-size:12px;color:var(--text3)">Aucune pièce</div>':`
        <table class="t"><thead><tr><th>${t('col_designation')}</th><th>Réf</th><th>${t('col_qte')||'Qté'}</th><th>PU HT</th><th>Total HT</th></tr></thead>
        <tbody>${(i.produits||[]).map(p=>`<tr><td>${esc(p.designation)}</td><td class="mono">${esc(p.ref||'')}</td><td>${p.qte}</td><td>${parseFloat(p.pxht||0).toFixed(2)} €</td><td style="font-weight:700">${(parseFloat(p.pxht||0)*p.qte).toFixed(2)} €</td></tr>`).join('')}</tbody></table>
        <div style="text-align:right;padding-top:6px;font-weight:700;font-size:13px">Total HT : ${total.toFixed(2)} €</div>`}
      <div class="divider"></div>
      <div class="section-title"><i class="ti ti-send"></i>Expédition</div>
      ${i.envoi_numero?`<div class="tracking-block"><div style="font-size:11px;font-weight:700;color:var(--text3);margin-bottom:5px;text-transform:uppercase">Envoi</div><div style="font-size:12px">${esc(i.envoi_transporteur)} — <span class="mono">${esc(i.envoi_numero)}</span> — ${fd(i.envoi_date)}</div></div>`:'<div style="font-size:12px;color:var(--text3)">Aucun envoi</div>'}
      <div class="section-title" style="margin-top:10px"><i class="ti ti-arrow-back-up"></i>Retour</div>
      ${i.retour_numero?`<div class="tracking-block"><div style="font-size:11px;font-weight:700;color:var(--text3);margin-bottom:5px;text-transform:uppercase">Retour</div><div style="font-size:12px">${esc(i.retour_transporteur)} — <span class="mono">${esc(i.retour_numero)}</span> — ${fd(i.retour_date)}</div></div>`:'<div style="font-size:12px;color:var(--text3)">Aucun retour</div>'}
      <div class="divider"></div>
      <div class="section-title"><i class="ti ti-photo"></i>Photos (${photos.length})</div>
      <div id="photo-gallery">${renderPhotoGallery(photos,i.id)}</div>
      <div id="photo-upload-zone" class="photo-drop-zone" ondragover="event.preventDefault();this.classList.add('drag-over')" ondragleave="this.classList.remove('drag-over')" ondrop="handlePhotoDrop(event,${i.id})">
        <i class="ti ti-cloud-upload" style="font-size:26px;color:var(--text3);margin-bottom:6px"></i>
        <div style="font-size:13px;color:var(--text2);margin-bottom:3px">Glisser-déposer des photos ici</div>
        <div style="font-size:11px;color:var(--text3);margin-bottom:8px">JPEG, PNG, WEBP — 15 Mo max</div>
        <label class="btn sm primary" style="cursor:pointer"><i class="ti ti-upload"></i>Choisir des fichiers<input type="file" accept="image/*" multiple style="display:none" onchange="handlePhotoFiles(this.files,${i.id})"></label>
      </div>
      <div class="divider"></div>
      <div class="section-title"><i class="ti ti-message"></i>Commentaires (${(i.commentaires||[]).length})</div>
      <div id="commentaires-list">${renderCommentaires(i.commentaires||[],i.id)}</div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <input class="form-input" id="new-comment" placeholder="Ajouter un commentaire…" style="flex:1">
        <button class="btn primary" onclick="addComment(${i.id})"><i class="ti ti-send"></i>Envoyer</button>
      </div>
      <div class="divider"></div>
      <div class="section-title" style="cursor:pointer" onclick="toggleHistorique(${i.id})"><i class="ti ti-history"></i>Historique des modifications <i class="ti ti-chevron-down" id="hist-chevron" style="margin-left:auto"></i></div>
      <div id="historique-list" style="display:none">${renderHistorique(i.historique||[])}</div>
    </div>
    <div class="modal-footer">
      <button class="btn danger" onclick="if(confirm('Supprimer ?'))API.deleteIntervention(${i.id}).then(()=>{closeModal();render();toast(t('msg_supprime'),'ti-trash');})"><i class="ti ti-trash"></i></button>
      <button class="btn" onclick="closeModal()">Fermer</button>
    </div>`);
}

function renderCommentaires(comms,interId){
  if(!comms.length) return '<div style="font-size:12px;color:var(--text3);margin-bottom:8px">Aucun commentaire</div>';
  return comms.map(cm=>`<div class="commentaire-bubble">
    <div class="meta"><span style="font-weight:600">${esc(cm.auteur)}</span><span>${cm.created_at?.slice(0,16).replace('T',' ')}</span></div>
    <div>${esc(cm.texte)}</div>
  </div>`).join('');
}

async function addComment(interId){
  const texte=gv('new-comment').trim();
  if(!texte)return;
  await API.addCommentaire(interId,{auteur:'Équipe SAV',texte});
  const comms=await API.commentaires(interId);
  $('commentaires-list').innerHTML=renderCommentaires(comms,interId);
  $('new-comment').value='';
  toast('Commentaire ajouté','ti-message');
}

function renderHistorique(hist){
  if(!hist.length) return '<div style="font-size:12px;color:var(--text3)">Aucune modification enregistrée</div>';
  return hist.map(h=>`<div class="historique-row">
    <span style="color:var(--text3);min-width:120px">${h.created_at?.slice(0,16).replace('T',' ')}</span>
    <span style="font-weight:600;min-width:80px">${esc(h.auteur)}</span>
    <span style="color:var(--text2)"><b>${esc(h.champ)}</b>${h.ancienne_valeur?` : <span style="color:var(--danger)">${esc(h.ancienne_valeur)}</span> → `:'  '}<span style="color:var(--success)">${esc(h.nouvelle_valeur)}</span></span>
  </div>`).join('');
}

function toggleHistorique(id){
  const el=$('historique-list'),ch=$('hist-chevron');
  if(!el)return;
  const open=el.style.display==='none';
  el.style.display=open?'block':'none';
  if(ch)ch.className=`ti ${open?'ti-chevron-up':'ti-chevron-down'}`;
  if(open&&!el.dataset.loaded){API.historique(id).then(h=>{el.innerHTML=renderHistorique(h);el.dataset.loaded='1';});}
}

// ── PHOTOS ────────────────────────────────────────────────────────

function renderPhotoGallery(photos,interId){
  if(!photos.length) return '<div style="font-size:12px;color:var(--text3);margin-bottom:10px">Aucune photo</div>';
  return `<div class="photo-grid">${photos.map((p,idx)=>`
    <div class="photo-thumb">
      <img src="/uploads/thumbs/${esc(p.filename_thumb||p.filename)}" alt="${esc(p.legende||'Photo')}"
        onclick="openLightbox(${interId},${idx},[${photos.map(x=>`'${x.filename}'`).join(',')}])"
        onerror="this.src='/uploads/${esc(p.filename)}'">
      <div class="photo-thumb-actions">
        <button class="photo-btn" onclick="editPhotoLegende(${interId},${p.id},'${esc(p.legende||'')}')"><i class="ti ti-pencil"></i></button>
        <button class="photo-btn danger" onclick="deletePhoto(${interId},${p.id})"><i class="ti ti-trash"></i></button>
      </div>
      ${p.legende?`<div class="photo-legende">${esc(p.legende)}</div>`:''}
    </div>`).join('')}</div>`;
}

async function handlePhotoFiles(files,interId){
  if(!files.length)return;
  const zone=$('photo-upload-zone');
  zone.innerHTML='<div style="text-align:center;padding:16px"><i class="ti ti-loader-2" style="font-size:22px"></i><div style="margin-top:5px;font-size:12px">Upload en cours…</div></div>';
  try{
    await API.uploadPhotos(interId,Array.from(files));
    const photos=await API.photos(interId);
    $('photo-gallery').innerHTML=renderPhotoGallery(photos,interId);
    zone.innerHTML=uploadZoneHTML(interId);
    toast(`${files.length} photo${files.length>1?'s':''} ajoutée${files.length>1?'s':''}`, 'ti-photo');
  }catch(e){zone.innerHTML=uploadZoneHTML(interId);toast('Erreur upload : '+e.message,'ti-alert-circle','var(--danger)');}
}
function handlePhotoDrop(e,interId){e.preventDefault();$('photo-upload-zone').classList.remove('drag-over');if(e.dataTransfer.files.length)handlePhotoFiles(e.dataTransfer.files,interId);}
function uploadZoneHTML(interId){return `<i class="ti ti-cloud-upload" style="font-size:26px;color:var(--text3);margin-bottom:6px"></i><div style="font-size:13px;color:var(--text2);margin-bottom:3px">Glisser-déposer des photos ici</div><div style="font-size:11px;color:var(--text3);margin-bottom:8px">JPEG, PNG, WEBP — 15 Mo max</div><label class="btn sm primary" style="cursor:pointer"><i class="ti ti-upload"></i>Choisir des fichiers<input type="file" accept="image/*" multiple style="display:none" onchange="handlePhotoFiles(this.files,${interId})"></label>`;}
async function deletePhoto(interId,photoId){if(!confirm('Supprimer ?'))return;await API.deletePhoto(interId,photoId);const photos=await API.photos(interId);$('photo-gallery').innerHTML=renderPhotoGallery(photos,interId);toast('Photo supprimée','ti-trash');}
async function editPhotoLegende(interId,photoId,cur){const l=prompt('Légende :',cur);if(l===null)return;await API.updatePhotoLegende(interId,photoId,l);const photos=await API.photos(interId);$('photo-gallery').innerHTML=renderPhotoGallery(photos,interId);}

let LB={filenames:[],idx:0};
function openLightbox(interId,idx,filenames){LB={filenames,idx};showLightbox();}
function showLightbox(){
  const fname=LB.filenames[LB.idx];
  document.getElementById('lightbox-overlay')?.remove();
  const el=document.createElement('div');el.id='lightbox-overlay';
  el.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.93);z-index:500;display:flex;flex-direction:column;align-items:center;justify-content:center;';
  el.innerHTML=`
    <button onclick="closeLightbox()" style="position:absolute;top:16px;right:20px;background:none;border:none;color:#fff;font-size:28px;cursor:pointer"><i class="ti ti-x"></i></button>
    <div style="position:absolute;top:16px;left:50%;transform:translateX(-50%);color:rgba(255,255,255,.5);font-size:12px">${LB.idx+1} / ${LB.filenames.length}</div>
    ${LB.idx>0?`<button onclick="lbNav(-1)" style="position:absolute;left:16px;background:rgba(255,255,255,.12);border:none;color:#fff;font-size:24px;padding:12px 16px;border-radius:8px;cursor:pointer"><i class="ti ti-chevron-left"></i></button>`:''}
    ${LB.idx<LB.filenames.length-1?`<button onclick="lbNav(1)" style="position:absolute;right:16px;background:rgba(255,255,255,.12);border:none;color:#fff;font-size:24px;padding:12px 16px;border-radius:8px;cursor:pointer"><i class="ti ti-chevron-right"></i></button>`:''}
    <img src="/uploads/${fname}" style="max-width:90vw;max-height:82vh;object-fit:contain;border-radius:6px;">
    <a href="/uploads/${fname}" download style="margin-top:12px;color:rgba(255,255,255,.6);font-size:12px;display:flex;align-items:center;gap:4px;text-decoration:none"><i class="ti ti-download"></i>Télécharger l'original</a>`;
  document.body.appendChild(el);
  el.addEventListener('click',e=>{if(e.target===el)closeLightbox();});
  document.addEventListener('keydown',lbKey);
}
function lbNav(d){LB.idx=Math.max(0,Math.min(LB.filenames.length-1,LB.idx+d));showLightbox();}
function closeLightbox(){document.getElementById('lightbox-overlay')?.remove();document.removeEventListener('keydown',lbKey);}
function lbKey(e){if(e.key==='ArrowRight')lbNav(1);if(e.key==='ArrowLeft')lbNav(-1);if(e.key==='Escape')closeLightbox();}

// ── MODALES CLIENTS ───────────────────────────────────────────────

function clientForm(d={}){return `<div class="grid-2">
  <div class="form-group"><label class="form-label">Nom *</label><input class="form-input" id="f-nom" value="${esc(d.nom||'')}"></div>
  <div class="form-group"><label class="form-label">Type</label><select class="form-input" id="f-type">${['Distributeur','Revendeur','Particulier'].map(t=>`<option ${d.type===t?'selected':''}>${t}</option>`).join('')}</select></div>
  <div class="form-group"><label class="form-label">Contact</label><input class="form-input" id="f-contact" value="${esc(d.contact||'')}"></div>
  <div class="form-group"><label class="form-label">Email</label><input class="form-input" id="f-email" value="${esc(d.email||'')}"></div>
  <div class="form-group"><label class="form-label">Téléphone</label><input class="form-input" id="f-tel" value="${esc(d.tel||'')}"></div>
  <div class="form-group"><label class="form-label">Ville</label><input class="form-input" id="f-ville" value="${esc(d.ville||'')}"></div>
  <div class="form-group" style="grid-column:1/-1">
    <label style="display:flex;align-items:center;gap:10px;padding:10px 14px;border:0.5px solid var(--border-s);border-radius:var(--radius);cursor:pointer;background:${d.edi?'rgba(46,124,246,.08)':'var(--surface)'}">
      <input type="checkbox" id="f-edi" ${d.edi?'checked':''} style="width:16px;height:16px;accent-color:var(--accent)">
      <div><div style="font-size:13px;font-weight:600;color:var(--accent)">💳 EDI — Prélèvement automatique</div>
      <div style="font-size:11px;color:var(--text2)">Ce distributeur règle ses factures par prélèvement EDI</div></div>
    </label>
  </div>
</div>`;}
function modalNewClient(){showModal(`<div class="modal-header"><i class="ti ti-user-plus" style="font-size:18px;color:var(--accent)"></i><h2>Nouveau client</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div><div class="modal-body">${clientForm()}</div><div class="modal-footer"><button class="btn" onclick="closeModal()">${t('btn_annuler')}</button><button class="btn primary" onclick="saveClient()"><i class="ti ti-check"></i>${t('btn_enregistrer')}</button></div>`);}
async function modalEditClient(id){const cl=await API.client(id);showModal(`<div class="modal-header"><i class="ti ti-edit" style="font-size:18px;color:var(--accent)"></i><h2>Modifier client</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div><div class="modal-body">${clientForm(cl)}</div><div class="modal-footer"><button class="btn danger" onclick="deleteClient(${id})"><i class="ti ti-trash"></i></button><button class="btn" onclick="closeModal()">${t('btn_annuler')}</button><button class="btn primary" onclick="saveClient(${id})"><i class="ti ti-check"></i>${t('btn_enregistrer')}</button></div>`);}
async function saveClient(id){const data={nom:gv('f-nom'),type:gv('f-type'),contact:gv('f-contact'),email:gv('f-email'),tel:gv('f-tel'),ville:gv('f-ville'),edi:!!document.getElementById('f-edi')?.checked};if(!data.nom){alert('Nom requis');return;}try{if(id)await API.updateClient(id,data);else await API.createClient(data);toast(id?'Client mis à jour':'Client créé');closeModal();render();}catch(e){alert(e.message);}}
async function deleteClient(id){if(!confirm(t('confirm_suppr_client')))return;await API.deleteClient(id);toast(t('msg_supprime'),'ti-trash');closeModal();setView('clients');}

async function modalPortail(id,token){
  const base=window.location.origin;
  const url=token?`${base}/portail.html?token=${token}`:'Non disponible';
  showModal(`<div class="modal-header"><i class="ti ti-link" style="font-size:18px;color:var(--accent)"></i><h2>Lien portail client</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body">
      <p style="font-size:13px;color:var(--text2);margin-bottom:12px">Ce lien permet au client de suivre ses interventions en lecture seule, sans accès à l'administration.</p>
      <div class="portail-link"><i class="ti ti-external-link"></i><span id="portail-url">${esc(url)}</span></div>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn primary" onclick="navigator.clipboard.writeText('${esc(url)}');toast('Lien copié','ti-copy')"><i class="ti ti-copy"></i>Copier</button>
        <button class="btn" onclick="regenererToken(${id})"><i class="ti ti-refresh"></i>Régénérer le lien</button>
      </div>
    </div>
    <div class="modal-footer"><button class="btn" onclick="closeModal()">Fermer</button></div>`);}

async function regenererToken(id){if(!confirm('Régénérer invalide l\'ancien lien. Continuer ?'))return;const r=await API.regenererToken(id);const base=window.location.origin;const url=`${base}/portail.html?token=${r.token}`;$('portail-url').textContent=url;toast('Lien régénéré','ti-refresh');}

// ── MODALES FAUTEUILS ─────────────────────────────────────────────

function fauteuilForm(d={}){const mods=['Modèle L','Modèle F','Modèle P','Modèle D2','Modèle X','Modèle H','Modèle C3','Modèle C','Modèle K','Modèle H2','Modèle S1'];return `<div class="grid-2">
  <div class="form-group"><label class="form-label">Modèle *</label><select class="form-input" id="f-modele">${mods.map(m=>`<option ${d.modele===m?'selected':''}>${m}</option>`).join('')}</select></div>
  <div class="form-group"><label class="form-label">N° de série *</label><input class="form-input" id="f-serie" value="${esc(d.serie||'')}"></div>
  <div class="form-group"><label class="form-label">Année</label><input class="form-input" id="f-annee" type="number" value="${d.annee||new Date().getFullYear()}"></div>
  <div class="form-group"><label class="form-label">Couleur</label><input class="form-input" id="f-couleur" value="${esc(d.couleur||'')}"></div>
  <div class="form-group"><label class="form-label">Date d'achat</label><input class="form-input" id="f-dateachat" type="date" value="${d.date_achat||''}"></div>
  <div class="form-group"><label class="form-label">Durée garantie (mois)</label><input class="form-input" id="f-garduree" type="number" min="0" value="${d.duree_garantie_mois||24}"></div>
  <div class="form-group" style="grid-column:1/-1"><label class="form-label">N° facture VosFactures</label><input class="form-input" id="f-facture" value="${esc(d.num_facture||'')}"></div>
</div>
<div class="form-group"><label class="form-label">Notes</label><textarea class="form-input" id="f-notes">${esc(d.notes||'')}</textarea></div>`;}
function modalNewFauteuil(clientId){showModal(`<div class="modal-header"><i class="ti ti-wheelchair" style="font-size:18px;color:var(--accent)"></i><h2>Nouveau fauteuil</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div><div class="modal-body">${fauteuilForm()}</div><div class="modal-footer"><button class="btn" onclick="closeModal()">${t('btn_annuler')}</button><button class="btn primary" onclick="saveFauteuil(null,${clientId})"><i class="ti ti-check"></i>${t('btn_enregistrer')}</button></div>`);}
async function modalEditFauteuil(id){const f=await API.fauteuil(id);showModal(`<div class="modal-header"><i class="ti ti-edit" style="font-size:18px;color:var(--accent)"></i><h2>Modifier fauteuil</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div><div class="modal-body">${fauteuilForm(f)}</div><div class="modal-footer"><button class="btn danger" onclick="deleteFauteuil(${id},${f.client_id})"><i class="ti ti-trash"></i></button><button class="btn" onclick="closeModal()">${t('btn_annuler')}</button><button class="btn primary" onclick="saveFauteuil(${id})"><i class="ti ti-check"></i>${t('btn_enregistrer')}</button></div>`);}
async function saveFauteuil(id,clientId){const data={client_id:clientId,modele:gv('f-modele'),serie:gv('f-serie'),annee:parseInt(gv('f-annee')),couleur:gv('f-couleur'),date_achat:gv('f-dateachat'),duree_garantie_mois:parseInt(gv('f-garduree'))||24,num_facture:gv('f-facture'),notes:gv('f-notes')};if(!data.serie){alert('N° de série requis');return;}try{if(id)await API.updateFauteuil(id,data);else await API.createFauteuil(data);toast(id?'Fauteuil mis à jour':'Fauteuil créé');closeModal();render();}catch(e){alert(e.message);}}
async function deleteFauteuil(id,clientId){if(!confirm(t('confirm_suppr_fauteuil')))return;await API.deleteFauteuil(id);toast(t('msg_supprime'),'ti-trash');closeModal();setView('client',{clientId});}

// ── MODALES INTERVENTIONS ─────────────────────────────────────────

async function modalNewIntervention(fauteuilId,clientId){
  TMP_PRODUITS=[];
  const[clients,fauts]=await Promise.all([API.clients(),fauteuilId?API.fauteuils(clientId||null):Promise.resolve([])]);
  if(!CACHE.catalogue.length) CACHE.catalogue=await API.catalogue();
  TMP_CLIENTS=clients;
  showModal(interForm(null,clients,fauts,fauteuilId,clientId));
  renderProduitsForm();
  // Pré-remplir le fauteuil si fourni via la recherche rapide
  if(fauteuilId){
    const f=fauts.find(ff=>ff.id===fauteuilId);
    if(f) selectFauteuilInter(f.id,f.modele||'',f.serie||'',f.client_id,f.client_nom||'');
  }
}
async function modalEditIntervention(id){
  const i=await API.intervention(id);
  TMP_PRODUITS=JSON.parse(JSON.stringify(i.produits||[]));
  const fauteuil=await API.fauteuil(i.fauteuil_id).catch(()=>null);
  const fauteuilClientId=fauteuil?.client_id;
  const[clients,fauts]=await Promise.all([API.clients(),API.fauteuils(fauteuilClientId||i.client_id)]);
  if(!CACHE.catalogue.length) CACHE.catalogue=await API.catalogue();
  TMP_CLIENTS=clients;
  closeModal();
  setTimeout(()=>{showModal(interForm(i,clients,fauts,i.fauteuil_id,i.client_id,fauteuilClientId));renderProduitsForm();},50);
}

function interForm(i,clients,fauteuils,fauteuilId,clientId,fauteuilClientId){const d=i||{};const autreDistrib=clientId&&fauteuilClientId&&clientId!==fauteuilClientId;return `
  <div class="modal-header"><i class="ti ti-tool" style="font-size:18px;color:var(--accent)"></i><h2>${i?(i.num_sav?esc(i.num_sav):'#'+i.id):t('inter_nouvelle')}</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
  <div class="modal-body" style="max-height:74vh;overflow-y:auto">
    <div class="grid-2">
      <!-- FAUTEUIL — recherche libre dans toute la base -->
      <div class="form-group" style="grid-column:1/-1">
        <label class="form-label" style="display:flex;justify-content:space-between;align-items:center">
          <span>Fauteuil * <span style="font-size:11px;color:var(--text3);font-weight:400">(série, modèle ou distributeur)</span></span>
          <button type="button" class="btn sm" style="font-size:10px;padding:2px 7px" onclick="toggleNewFauteuilInline()"><i class="ti ti-plus"></i>Créer</button>
        </label>
        <div style="position:relative">
          <input class="form-input" id="f-serie-search" autocomplete="off"
            placeholder="${t('qs_type_serie')||'Taper n° de série, modèle ou distributeur…'}"
            value="${(()=>{const f=fauteuils.find(f=>f.id===(fauteuilId||d.fauteuil_id));return f?esc(f.modele+' — '+f.serie):'';})()}"
            oninput="searchFauteuilInter(this.value)"
            onfocus="if(this.value.length>=2)searchFauteuilInter(this.value)"
            onblur="setTimeout(()=>{const dd=document.getElementById('fauteuil-inter-drop');if(dd)dd.style.display='none'},150)">
          <input type="hidden" id="f-fauteuil" value="${fauteuilId||d.fauteuil_id||''}">
          <div id="fauteuil-inter-drop" class="piece-dropdown" style="display:none"></div>
        </div>
        <!-- Création inline -->
        <div id="new-fauteuil-inline" style="display:none;background:var(--bg);border-radius:var(--radius);padding:10px;margin-top:8px;border:1px dashed var(--border-s)">
          <div style="font-size:11px;font-weight:700;color:var(--text2);margin-bottom:8px;text-transform:uppercase;letter-spacing:.4px">Nouveau fauteuil</div>
          <div class="grid-2" style="gap:6px">
            <div class="form-group" style="margin-bottom:4px"><label class="form-label">Modèle *</label>
              <select class="form-input" id="nf-modele">${['Eloflex L','Eloflex F','Eloflex D2','Eloflex X','Eloflex P','Eloflex H','Eloflex C','Eloflex C3','Eloflex K','Eloflex R','Eloflex S1','Eloflex M+'].map(m=>`<option>${m}</option>`).join('')}</select>
            </div>
            <div class="form-group" style="margin-bottom:4px">
              <label class="form-label" style="display:flex;justify-content:space-between;align-items:center">
                <span>N° de série *</span>
                <label style="display:flex;align-items:center;gap:4px;font-weight:400;font-size:11px;cursor:pointer">
                  <input type="checkbox" id="nf-serie-absent" onchange="toggleSerieAbsent(this.checked)">Numéro absent
                </label>
              </label>
              <input class="form-input mono" id="nf-serie" placeholder="ex: A06L2502011042">
              <div id="nf-serie-absent-msg" style="display:none;font-size:11px;color:var(--warning);margin-top:3px"><i class="ti ti-alert-triangle" style="font-size:11px"></i> Numéro temporaire généré automatiquement</div>
            </div>
            <div class="form-group" style="margin-bottom:4px"><label class="form-label">Date d'achat</label><input class="form-input" id="nf-dateachat" type="date"></div>
            <div class="form-group" style="margin-bottom:4px"><label class="form-label">Durée garantie (mois)</label><input class="form-input" id="nf-garduree" type="number" value="24"></div>
          </div>
          <div style="display:flex;gap:6px;margin-top:4px">
            <button type="button" class="btn sm primary" onclick="createFauteuilInline()"><i class="ti ti-check"></i>Créer et sélectionner</button>
            <button type="button" class="btn sm" onclick="toggleNewFauteuilInline()">${t('btn_annuler')}</button>
          </div>
        </div>
      </div>

      <!-- DISTRIBUTEUR — avec option "autre distributeur" -->
      <div class="form-group" style="grid-column:1/-1">
        <label class="form-label" style="display:flex;justify-content:space-between;align-items:center">
          <span>Distributeur</span>
          <label style="display:flex;align-items:center;gap:5px;font-weight:400;font-size:11px;cursor:pointer">
            <input type="checkbox" id="f-autre-distrib" ${autreDistrib?"checked":""} onchange="toggleAutreDistrib(this.checked)">
            <span>Intervention chez un autre distributeur</span>
          </label>
        </label>
        <!-- Champ affiché par défaut : distributeur du fauteuil (lecture seule si pas coché) -->
        <div id="distrib-readonly" style="display:${autreDistrib?'none':'flex'};align-items:center;gap:8px;padding:8px 10px;background:var(--bg);border-radius:var(--radius);font-size:13px;border:1px solid var(--border)">
          <i class="ti ti-users" style="color:var(--text3)"></i>
          <span id="distrib-readonly-nom">${esc(clients.find(c=>c.id===(clientId||d.client_id))?.nom||'— sera renseigné depuis le fauteuil —')}</span>
          <input type="hidden" id="f-client" value="${clientId||d.client_id||''}">
        </div>
        <!-- Champ de recherche : visible si "autre distributeur" coché -->
        <div id="distrib-search-wrap" style="display:${autreDistrib?'block':'none'};position:relative">
          <input class="form-input" id="f-client-search" autocomplete="off"
            placeholder="Rechercher le distributeur…"
            value="${autreDistrib ? esc(clients.find(c=>c.id===clientId)?.nom||'') : ''}"
            oninput="document.getElementById('f-client').value='';searchClients(this.value,TMP_CLIENTS)"
            onfocus="searchClients(this.value,TMP_CLIENTS)"
            onblur="setTimeout(()=>{const dr=document.getElementById('client-drop');if(dr)dr.style.display='none'},150)">
          <div id="client-drop" class="piece-dropdown" style="display:none"></div>
        </div>
        <div style="font-size:11px;color:var(--text3);margin-top:4px">
          Cochez si le fauteuil est en intervention chez un distributeur différent de son propriétaire (démo, revente, SAV tiers…)
        </div>
      </div>
      <div class="form-group"><label class="form-label">${t('col_date')}</label><input class="form-input" id="f-date" type="date" value="${d.date||new Date().toISOString().split('T')[0]}"></div>
      <div class="form-group"><label class="form-label">N° SAV</label><input class="form-input mono" id="f-num-sav" placeholder="ex: SAV-2026-001" value="${esc(d.num_sav||'')}"></div>
      <div class="form-group"><label class="form-label">${t('col_type')}</label><select class="form-input" id="f-type">${['Réparation','Maintenance','Diagnostic','Échange standard'].map((v,idx)=>`<option value="${v}" ${d.type===v?'selected':''}>${t('inter_types')[idx]}</option>`).join('')}</select></div>
      <div class="form-group"><label class="form-label">${t('col_statut')}</label><select class="form-input" id="f-statut">${[['Ouvert','inter_statut_ouvert'],['En attente','inter_statut_attente'],['Fermé','inter_statut_ferme']].map(([v,k])=>`<option value="${v}" ${d.statut===v?'selected':''}>${t(k)}</option>`).join('')}</select></div>
      <div class="form-group"><label class="form-label">${t('col_technicien')}</label><input class="form-input" id="f-tech" value="${esc(d.technicien||'Brice')}"></div>
    </div>
    <div class="form-group"><label class="form-label">${t('col_garantie')}</label>
      <div style="display:flex;gap:12px;margin-top:4px">
        <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:12px"><input type="radio" name="garantie" value="1" ${!i||i.garantie?'checked':''}> <span class="badge g">${t('inter_sous_garantie')}</span></label>
        <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:12px"><input type="radio" name="garantie" value="0" ${i&&!i.garantie?'checked':''}> <span class="badge hg">${t('inter_hors_garantie')}</span></label>
      </div>
    </div>
    <div class="form-group"><label class="form-label">${t('inter_desc')}</label><textarea class="form-input" id="f-desc">${esc(d.description||'')}</textarea></div>
    <div class="form-group"><label class="form-label">${t('intervention_realisee')}</label><textarea class="form-input" id="f-notes" style="min-height:52px">${esc(d.notes||'')}</textarea></div>
    <div class="divider"></div>
    <div class="section-title"><i class="ti ti-box"></i>${t('inter_pieces')}</div>
    <div id="produits-list" style="margin-bottom:8px"></div>
    <button class="btn sm" onclick="addProduitRow()"><i class="ti ti-plus"></i>${t('inter_add_piece')}</button>
    <div class="divider"></div>
    <div class="section-title"><i class="ti ti-send"></i>${t('inter_expedition')}</div>
    <div class="tracking-block"><div class="grid-2">
      <div class="form-group" style="margin-bottom:0"><label class="form-label">${t('col_transporteur')}</label><select class="form-input" id="f-env-trans"><option value="">${t('select_aucun')}</option><option ${d.envoi_transporteur==='La Poste'?'selected':''}>La Poste</option><option ${d.envoi_transporteur==='Chronopost'?'selected':''}>Chronopost</option></select></div>
      <div class="form-group" style="margin-bottom:0"><label class="form-label">${t('col_date')}</label><input class="form-input" id="f-env-date" type="date" value="${d.envoi_date||''}"></div>
      <div class="form-group" style="margin-bottom:0;grid-column:1/-1"><label class="form-label">${t('col_suivi')}</label><input class="form-input" id="f-env-num" value="${esc(d.envoi_numero||'')}"></div>
    </div></div>
    <div class="section-title" style="margin-top:4px"><i class="ti ti-arrow-back-up"></i>${t('inter_retour')}</div>
    <div class="tracking-block"><div class="grid-2">
      <div class="form-group" style="margin-bottom:0"><label class="form-label">${t('col_transporteur')}</label><select class="form-input" id="f-ret-trans"><option value="">${t('select_aucun')}</option><option ${d.retour_transporteur==='La Poste'?'selected':''}>La Poste</option><option ${d.retour_transporteur==='Chronopost'?'selected':''}>Chronopost</option></select></div>
      <div class="form-group" style="margin-bottom:0"><label class="form-label">${t('col_date')}</label><input class="form-input" id="f-ret-date" type="date" value="${d.retour_date||''}"></div>
      <div class="form-group" style="margin-bottom:0;grid-column:1/-1"><label class="form-label">N° de suivi retour</label><input class="form-input" id="f-ret-num" value="${esc(d.retour_numero||'')}"></div>
    </div></div>
    <div class="divider"></div>
    <div class="section-title"><i class="ti ti-receipt"></i>Lien VosFactures</div>
    <div class="form-group" style="margin-bottom:4px">
      <label class="form-label">N° bordereau / bon de livraison VosFactures</label>
      <input class="form-input mono" id="f-bordereau" placeholder="ex: BL-2026-0042" value="${esc(d.num_bordereau_vf||'')}">
      <div style="font-size:11px;color:var(--text3);margin-top:3px">Permet d'accéder directement au document dans VosFactures depuis la fiche intervention.</div>
    </div>
  </div>
  <div class="modal-footer">
    ${i?`<button class="btn danger" onclick="if(confirm('Supprimer ?'))API.deleteIntervention(${i.id}).then(()=>{closeModal();render();toast(t('msg_supprime'),'ti-trash');})"><i class="ti ti-trash"></i></button>`:''}
    <button class="btn" onclick="closeModal()">${t('btn_annuler')}</button>
    <button class="btn primary" onclick="saveIntervention(${i?i.id:'null'})"><i class="ti ti-check"></i>${i?'Mettre à jour':'Enregistrer'}</button>
  </div>`;}

async function refreshFauteuilSelect(){const cid=parseInt(gv('f-client'));const list=cid?await API.fauteuils(cid):await API.fauteuils();$('f-fauteuil').innerHTML=list.map(f=>`<option value="${f.id}">${esc(f.modele)} – ${esc(f.serie)}</option>`).join('');}
function addProduitRow(){
  TMP_PRODUITS.push({ref:'',designation:'',qte:1,pxht:0});
  renderProduitsForm();
  setTimeout(()=>{const inputs=document.querySelectorAll('.piece-search');if(inputs.length)inputs[inputs.length-1].focus();},50);
}
function removeProduit(i){TMP_PRODUITS.splice(i,1);renderProduitsForm();}
function selectPieceResult(idx,resultIdx){
  const p=(window._PIECE_RESULTS&&window._PIECE_RESULTS[idx])?window._PIECE_RESULTS[idx][resultIdx]:null;
  if(!p) return;
  TMP_PRODUITS[idx]={...TMP_PRODUITS[idx],ref:p.ref||'',designation:p.designation||'',pxht:parseFloat(p.pxht||0)};
  renderProduitsForm();
  setTimeout(()=>{const q=document.querySelectorAll('.piece-qte');if(q[idx])q[idx].focus();},50);
}
function selectCatalogueByItem(idx,item){
  TMP_PRODUITS[idx]={...TMP_PRODUITS[idx],ref:item.ref,designation:item.designation,pxht:parseFloat(item.pxht||0)};
  renderProduitsForm();
  setTimeout(()=>{const q=document.querySelectorAll('.piece-qte');if(q[idx])q[idx].focus();},50);
}
function searchPieces(idx,q){
  const drop=document.getElementById('piece-drop-'+idx);if(!drop)return;
  const query=q.toLowerCase().trim();
  if(!query){drop.style.display='none';return;}
  const results=CACHE.catalogue.filter(p=>
    p.designation.toLowerCase().includes(query)||
    (p.ref&&p.ref.toLowerCase().includes(query))||
    (p.ref_fournisseur&&p.ref_fournisseur.toLowerCase().includes(query))
  ).slice(0,12);
  if(!results.length){drop.style.display='none';return;}
  // Stocker les résultats dans une variable globale pour éviter les problèmes d'échappement
  window._PIECE_RESULTS = window._PIECE_RESULTS || {};
  window._PIECE_RESULTS[idx] = results;
  drop.innerHTML=results.map((p,ri)=>`<div class="piece-option" onmousedown="event.preventDefault();selectPieceResult(${idx},${ri})">
    <div style="font-size:12px;font-weight:600">${esc(p.designation)}</div>
    <div style="font-size:11px;color:var(--text3);display:flex;gap:8px"><span class="mono">${esc(p.ref)}</span><span style="margin-left:auto">${parseFloat(p.pxht||0).toFixed(2)} €</span></div>
  </div>`).join('');
  drop.style.display='block';
}
function renderProduitsForm(){
  const el=$('produits-list');if(!el)return;
  if(!TMP_PRODUITS.length){el.innerHTML='<div style="font-size:12px;color:var(--text3)">Aucune pièce</div>';return;}
  el.innerHTML=TMP_PRODUITS.map((p,i)=>`
    <div style="display:grid;grid-template-columns:2fr 0.8fr 0.5fr 0.7fr auto;gap:5px;align-items:start;margin-bottom:8px">
      <div>
        ${i===0?`<div class="form-label">${t('col_designation_court')||'Désignation'}</div>`:''}
        <div style="position:relative">
          <input class="form-input piece-search" style="font-size:12px" placeholder="${t('cat_search_placeholder')||'Taper nom ou référence…'}"
            value="${esc(p.designation)}"
            oninput="TMP_PRODUITS[${i}].designation=this.value;searchPieces(${i},this.value)"
            onfocus="searchPieces(${i},this.value)"
            onblur="setTimeout(()=>{const d=document.getElementById('piece-drop-${i}');if(d)d.style.display='none'},150)">
          <div id="piece-drop-${i}" class="piece-dropdown" style="display:none"></div>
        </div>
      </div>
      <div>${i===0?'<div class="form-label">Réf</div>':''}<input class="form-input mono" style="font-size:11px" value="${esc(p.ref)}" oninput="TMP_PRODUITS[${i}].ref=this.value"></div>
      <div>${i===0?`<div class="form-label">${t('col_qte')||'Qté'}</div>`:''}<input class="form-input piece-qte" type="number" min="1" value="${p.qte}" oninput="TMP_PRODUITS[${i}].qte=parseInt(this.value)||1"></div>
      <div>${i===0?'<div class="form-label">PU HT</div>':''}<input class="form-input" type="number" step="0.01" value="${parseFloat(p.pxht||0).toFixed(2)}" oninput="TMP_PRODUITS[${i}].pxht=parseFloat(this.value)||0"></div>
      <div style="${i===0?'padding-top:18px':''}"><button class="btn sm danger" onclick="removeProduit(${i})"><i class="ti ti-x"></i></button></div>
    </div>`).join('');
}

async function saveIntervention(id){
  const data={fauteuil_id:parseInt(gv('f-fauteuil')),client_id:parseInt(gv('f-client')),num_sav:gv('f-num-sav')||undefined,date:gv('f-date'),type:gv('f-type'),statut:gv('f-statut'),technicien:gv('f-tech'),garantie:document.querySelector('input[name="garantie"]:checked')?.value==='1',description:gv('f-desc'),notes:gv('f-notes'),envoi_transporteur:gv('f-env-trans'),envoi_numero:gv('f-env-num'),envoi_date:gv('f-env-date'),retour_transporteur:gv('f-ret-trans'),retour_numero:gv('f-ret-num'),retour_date:gv('f-ret-date'),num_bordereau_vf:gv('f-bordereau')||undefined,produits:TMP_PRODUITS};
  if(!data.fauteuil_id||!data.date){alert('Fauteuil et date requis');return;}
  try{if(id)await API.updateIntervention(id,data);else await API.createIntervention(data);TMP_PRODUITS=[];toast(id?'Intervention mise à jour':'Intervention créée');closeModal();render();refreshBadges();}catch(e){alert(e.message);}
}

// ── MODALES CATALOGUE ─────────────────────────────────────────────

async function modalPiece(id){
  const p=id?CACHE.catalogue.find(x=>x.id===id)||await API.catalogue().then(l=>l.find(x=>x.id===id)):null;
  showModal(`<div class="modal-header"><i class="ti ti-box" style="font-size:18px;color:var(--accent)"></i><h2>${id?'Modifier pièce':'Nouvelle pièce'}</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body"><div class="grid-2">
      <div class="form-group"><label class="form-label">Référence *</label><input class="form-input mono" id="f-ref" value="${esc(p?.ref||'')}"></div>
      <div class="form-group"><label class="form-label">Réf fournisseur</label><input class="form-input mono" id="f-reffou" value="${esc(p?.ref_fournisseur||'')}"></div>
      <div class="form-group" style="grid-column:1/-1"><label class="form-label">Désignation *</label><input class="form-input" id="f-des" value="${esc(p?.designation||'')}"></div>
      <div class="form-group"><label class="form-label">Fournisseur</label><input class="form-input" id="f-fou" value="${esc(p?.fournisseur||'Eloflex AB')}"></div>
      <div class="form-group"><label class="form-label">Prix HT (€)</label><input class="form-input" id="f-px" type="number" step="0.01" value="${p?.pxht||0}"></div>
      <div class="form-group"><label class="form-label">Stock</label><input class="form-input" id="f-stock" type="number" value="${p?.stock||0}"></div>
      <div class="form-group"><label class="form-label">Seuil alerte stock</label><input class="form-input" id="f-stalerte" type="number" value="${p?.stock_alerte||2}"></div>
    </div></div>
    <div class="modal-footer">
      ${id?`<button class="btn danger" onclick="deletePiece(${id})"><i class="ti ti-trash"></i></button>`:''}
      <button class="btn" onclick="closeModal()">${t('btn_annuler')}</button>
      <button class="btn primary" onclick="savePiece(${id||'null'})"><i class="ti ti-check"></i>${t('btn_enregistrer')}</button>
    </div>`);}
async function savePiece(id){const data={ref:gv('f-ref'),designation:gv('f-des'),fournisseur:gv('f-fou'),ref_fournisseur:gv('f-reffou'),pxht:parseFloat(gv('f-px'))||0,stock:parseInt(gv('f-stock'))||0,stock_alerte:parseInt(gv('f-stalerte'))||2};if(!data.ref||!data.designation){alert('Référence et désignation requises');return;}try{if(id)await API.updatePiece(id,data);else await API.createPiece(data);CACHE.catalogue=[];toast(id?'Pièce mise à jour':'Pièce ajoutée');closeModal();render();refreshBadges();}catch(e){alert(e.message);}}
async function deletePiece(id){if(!confirm('Supprimer ?'))return;await API.deletePiece(id);CACHE.catalogue=[];toast(t('msg_supprime'),'ti-trash');closeModal();render();}

// ── EXPORTS PDF ───────────────────────────────────────────────────

async function exportInterventionPDF(id){const i=await API.intervention(id);PDF.intervention(i);toast(t('msg_pdf_genere'),'ti-file-type-pdf');}
async function exportFauteuilPDF(id){const f=await API.fauteuil(id);PDF.fauteuil(f,f.interventions||[]);toast(t('msg_pdf_genere'),'ti-file-type-pdf');}
async function exportClientPDF(id){const cl=await API.client(id);const inters=await API.interventions({client_id:id});PDF.client(cl,cl.fauteuils||[],inters);toast(t('msg_pdf_genere'),'ti-file-type-pdf');}

// ── VOSFACTURES ───────────────────────────────────────────────────

async function importerHistoriqueCommandes(file){
  const el=$('import-commandes-result'); if(!el) return;
  if(!file){ el.innerHTML=''; return; }
  el.innerHTML=`<div style="font-size:12px;color:var(--text2)"><i class="ti ti-loader-2"></i> Import en cours… (peut prendre 1-3 min selon la taille du fichier)</div>`;
  try{
    const r = await API.importCommandesExcel(file);
    const annees = Object.entries(r.stats.par_annee||{}).map(([a,n])=>`${a} : ${n} nouvelles`).join(', ');
    el.innerHTML=`<div style="padding:10px 12px;background:var(--success-bg);border:0.5px solid var(--success);border-radius:var(--radius);font-size:12px">
      <div style="font-weight:700;color:var(--success);margin-bottom:6px"><i class="ti ti-check"></i> Import terminé !</div>
      <div>Onglets traités : <b>${r.annees?.join(', ')||'—'}</b></div>
      <div>Nouvelles commandes : <b>${r.stats.inserees}</b> · Mises à jour : <b>${r.stats.maj}</b> · Nouveaux clients : <b>${r.stats.clients_crees}</b></div>
      ${annees?`<div style="margin-top:4px;color:var(--text2)">${annees}</div>`:''}
      ${r.stats.erreurs?`<div style="color:var(--danger);margin-top:4px">⚠ ${r.stats.erreurs} erreur(s)${r.stats.premiere_erreur?' — Première : '+r.stats.premiere_erreur:''}</div>`:''}
    </div>`;
    toast(`Import terminé — ${r.stats.inserees} commandes importées`,'ti-table-import');
  }catch(e){
    el.innerHTML=`<div style="padding:10px 12px;background:var(--danger-bg);border:0.5px solid var(--danger);border-radius:var(--radius);font-size:12px;color:var(--danger)">
      ❌ Erreur : <b>${esc(e.message)}</b><br>
      <span style="font-size:11px;color:var(--text2)">Vérifie que tu as bien sélectionné le bon fichier Excel (Compta_Eloflex…) et recharge la page si l'erreur persiste.</span>
    </div>`;
  }
}

async function genererFacturePennylaneModal(id){
  if(!confirm('Créer un brouillon de facture dans Pennylane ?\n\nLa facture sera créée en brouillon — tu pourras la vérifier et la finaliser dans Pennylane.')) return;
  toast('Création en cours dans Pennylane…','ti-loader-2');
  try{
    const r = await API.pennylaneGenererFacture(id);
    if(r.ok){
      const inp = $('cmd-facture-pl');
      if(inp) inp.value = r.numero || '';
      toast(`Facture Pennylane ${r.numero} créée (brouillon)`,'ti-check');
      if(r.url) window.open(r.url,'_blank');
    } else {
      toast(`Erreur : ${r.reason||r.error}`,'ti-alert-circle','var(--warning)');
    }
  }catch(e){ toast(e.message,'ti-alert-circle','var(--danger)'); }
}

async function syncPennylane(full = false){
  const el = $('pl-sync-result');
  if(el) el.innerHTML = `<div style="font-size:12px;color:var(--text2)"><i class="ti ti-loader-2"></i> Synchronisation en cours…</div>`;
  try {
    const r = await API.pennylaneSyncCommandes(full);
    if(el) el.innerHTML = `<div style="font-size:12px;color:var(--success)"><i class="ti ti-check"></i> ${esc(r.message||'OK')}</div>`;
    toast(r.message || 'Sync Pennylane terminé', 'ti-check');
  } catch(e) {
    if(el) el.innerHTML = `<div style="font-size:12px;color:var(--danger)">❌ ${esc(e.message)}</div>`;
  }
}

async function loadPennylaneStatus(){
  const badge = $('pl-status-badge'); if(!badge) return;
  try {
    const s = await API.pennylaneStatus();
    if(s.configured){
      badge.innerHTML = `<span class="badge g" style="font-size:10px">✓ Connecté${s.account?.email?' — '+esc(s.account.email):''}</span>`;
    } else {
      badge.innerHTML = `<span class="badge hg" style="font-size:10px">Non configuré</span>`;
    }
  } catch(_) {
    badge.innerHTML = `<span class="badge hg" style="font-size:10px">Erreur</span>`;
  }
}

async function syncVosFactures(){  const btn=$('btn-sync');btn.disabled=true;btn.innerHTML='<i class="ti ti-loader-2"></i>Sync…';
  try{const r=await API.vfSync();toast(`Sync OK — ${r.results.clients} clients, ${r.results.products} produits`,'ti-refresh');CACHE.catalogue=[];render();}
  catch(e){toast('Erreur sync : '+e.message,'ti-alert-circle','var(--danger)');}
  finally{btn.disabled=false;btn.innerHTML='<i class="ti ti-refresh"></i>Sync VosFactures';loadVfStatus();}
}
async function loadVfStatus(){
  try{const s=await API.vfStatus();const el=$('vf-status');if(!el)return;
    if(s.account) window._VF_ACCOUNT=s.account; // Stocké pour construire les liens VF
    if(!s.configured){el.textContent='⚠ VosFactures non configuré';el.className='vf-status err';}
    else if(s.last_sync){el.textContent=`✓ Sync ${s.last_sync.created_at?.slice(0,10)}`;el.className='vf-status ok';}
    else{el.textContent=`Compte : ${s.account}`;el.className='vf-status';}
  }catch(e){}
}

// ── INIT ──────────────────────────────────────────────────────────

// ── EMAIL NOTIFICATION ───────────────────────────────────────────
async function envoyerEmailInter(id){
  try{
    const r=await API.sendEmailInter(id);
    if(r.ok) toast(`Email envoyé à ${r.to}`,'ti-mail');
    else toast(`Non envoyé : ${r.reason}`,'ti-mail-off');
  }catch(e){alert('Erreur email : '+e.message);}
}

// ── RETOURS PIÈCES VERS SUÈDE ─────────────────────────────────────
async function renderRetoursSuede(ttl,c,a){
  ttl.textContent=t('retours_title');
  a.innerHTML=`<button class="btn primary" onclick="modalRetour()"><i class="ti ti-plus"></i>${t('retours_new')}</button>`;
  const list=await API.retoursSuede();
  if(!list.length){c.innerHTML=`<div class="empty"><i class="ti ti-package-off"></i><p>${t('retours_empty')}</p></div>`;return;}
  const scR={'En attente':'attente','Envoyé':'ouvert','Remboursé':'g','Refusé':'urgent'};
  const stTr={'En attente':t('retours_statut_attente'),'Envoyé':t('retours_statut_envoye'),'Remboursé':t('retours_statut_rembourse'),'Refusé':t('retours_statut_refuse')};
  c.innerHTML=`<div class="table-wrap"><table class="t">
    <thead><tr><th>${t('retours_num')}</th><th>${t('col_date_envoi')}</th><th>${t('col_description')}</th><th>${t('retours_montant')}</th><th>${t('col_statut')}</th><th></th></tr></thead>
    <tbody>${list.map(r=>`<tr onclick="modalRetour(${r.id})">
      <td class="mono" style="color:var(--accent)">${esc(r.num_retour||'—')}</td>
      <td>${r.date_envoi?fd(r.date_envoi):'—'}</td>
      <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.description||'')}</td>
      <td style="font-weight:700">${parseFloat(r.montant||0).toFixed(2)} €</td>
      <td><span class="badge ${scR[r.statut]||''}">${stTr[r.statut]||esc(r.statut)}</span></td>
      <td><button class="btn sm danger" onclick="event.stopPropagation();if(confirm(t('retours_confirm_suppr')))API.deleteRetour(${r.id}).then(()=>{render();toast(t('msg_supprime'),'ti-trash')})"><i class="ti ti-trash"></i></button></td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

async function modalRetour(id){
  const d=id?await API.retoursSuede().then(l=>l.find(r=>r.id===id)||{}):{};
  showModal(`<div class="modal-header"><i class="ti ti-package" style="font-size:18px;color:var(--accent)"></i><h2>${id?t('retours_modal_edit'):t('retours_modal_new')}</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body"><div class="grid-2">
      <div class="form-group"><label class="form-label">${t('retours_num')}</label><input class="form-input mono" id="r-num" placeholder="RET-2026-001" value="${esc(d.num_retour||'')}"></div>
      <div class="form-group"><label class="form-label">${t('col_date_envoi')}</label><input class="form-input" id="r-date" type="date" value="${d.date_envoi||''}"></div>
      <div class="form-group" style="grid-column:1/-1"><label class="form-label">${t('retours_desc_label')}</label><textarea class="form-input" id="r-desc" rows="3">${esc(d.description||'')}</textarea></div>
      <div class="form-group"><label class="form-label">${t('retours_montant')} (€)</label><input class="form-input" id="r-montant" type="number" step="0.01" value="${parseFloat(d.montant||0).toFixed(2)}"></div>
      <div class="form-group"><label class="form-label">${t('col_statut')}</label>
        <select class="form-input" id="r-statut">
          ${[['En attente','retours_statut_attente'],['Envoyé','retours_statut_envoye'],['Remboursé','retours_statut_rembourse'],['Refusé','retours_statut_refuse']].map(([v,k])=>`<option value="${v}" ${d.statut===v?'selected':''}>${t(k)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group" style="grid-column:1/-1"><label class="form-label">Notes</label><textarea class="form-input" id="r-notes" rows="2">${esc(d.notes||'')}</textarea></div>
    </div></div>
    <div class="modal-footer">
      ${id?`<button class="btn danger" onclick="if(confirm(t('retours_confirm_suppr')))API.deleteRetour(${id}).then(()=>{closeModal();render();toast(t('msg_supprime'),'ti-trash')})"><i class="ti ti-trash"></i></button>`:''}
      <button class="btn" onclick="closeModal()">${t('btn_annuler')}</button>
      <button class="btn primary" onclick="saveRetour(${id||'null'})"><i class="ti ti-check"></i>${t('btn_enregistrer')}</button>
    </div>`);
}

async function saveRetour(id){
  const data={num_retour:gv('r-num'),date_envoi:gv('r-date')||null,description:gv('r-desc'),statut:gv('r-statut'),montant:parseFloat(gv('r-montant'))||0,notes:gv('r-notes')};
  try{
    id?await API.updateRetour(id,data):await API.createRetour(data);
    toast(id?'Retour mis à jour':'Retour créé','ti-package');
    closeModal();render();
  }catch(e){alert(e.message);}
}

// ── TRANSFERTS FAUTEUILS (modèles d'exposition) ────────────────────
async function renderTransferts(ttl,c,a){
  ttl.textContent=t('transferts_title');
  a.innerHTML=`<button class="btn primary" onclick="modalTransfert()"><i class="ti ti-plus"></i>${t('transferts_new')}</button>`;
  const list=await API.transferts();
  c.innerHTML=`<div style="font-size:12px;color:var(--text2);margin-bottom:12px">${t('transferts_subtitle')}</div>`;
  if(!list.length){c.innerHTML+=`<div class="empty"><i class="ti ti-arrows-exchange"></i><p>${t('transferts_empty')}</p></div>`;return;}
  const scT={'En préparation':'attente','En transit':'ouvert','Arrivé':'g','Annulé':'urgent'};
  const stTr={'En préparation':t('transferts_statut_prep'),'En transit':t('transferts_statut_transit'),'Arrivé':t('transferts_statut_arrive'),'Annulé':t('transferts_statut_annule')};
  c.innerHTML+=`<div class="table-wrap"><table class="t">
    <thead><tr><th>${t('transferts_fauteuil').replace(' *','')}</th><th>${t('transferts_depart')}</th><th>${t('transferts_date_depart')}</th><th>${t('transferts_arrivee')}</th><th>${t('transferts_date_arrivee')}</th><th>${t('col_transporteur')}</th><th>${t('transferts_num_suivi')}</th><th>${t('col_statut')}</th><th></th></tr></thead>
    <tbody>${list.map(tr=>`<tr onclick="modalTransfert(${tr.id})">
      <td><div style="font-weight:600">${esc(tr.modele||'—')}</div><div class="mono" style="color:var(--text3);font-size:11px">${esc(tr.serie||'')}</div></td>
      <td>${esc(tr.client_depart_nom||'—')}</td>
      <td>${tr.date_depart?fd(tr.date_depart):'—'}</td>
      <td>${esc(tr.client_arrivee_nom||'—')}</td>
      <td>${tr.date_arrivee?fd(tr.date_arrivee):'—'}</td>
      <td>${esc(tr.transporteur||'—')}</td>
      <td class="mono" style="font-size:11px">${esc(tr.num_suivi||'—')}</td>
      <td><span class="badge ${scT[tr.statut]||''}">${stTr[tr.statut]||esc(tr.statut)}</span></td>
      <td><button class="btn sm danger" onclick="event.stopPropagation();if(confirm(t('transferts_confirm_suppr')))API.deleteTransfert(${tr.id}).then(()=>{render();toast(t('msg_supprime'),'ti-trash')})"><i class="ti ti-trash"></i></button></td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

async function modalTransfert(id){
  const d = id ? await API.transfert(id) : {};
  TMP_CLIENTS = await API.clients();
  showModal(`<div class="modal-header"><i class="ti ti-arrows-exchange" style="font-size:18px;color:var(--accent)"></i><h2>${id?t('transferts_modal_edit'):t('transferts_modal_new')}</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label">${t('transferts_fauteuil')}</label>
        <div style="position:relative">
          <input class="form-input" id="tr-fauteuil-search" autocomplete="off"
            placeholder="Taper n° de série, modèle ou distributeur…"
            value="${d.modele?esc(d.modele+' — '+d.serie):''}"
            oninput="searchFauteuilTransfert(this.value)"
            onfocus="if(this.value.length>=2)searchFauteuilTransfert(this.value)"
            onblur="setTimeout(()=>{const dd=document.getElementById('tr-fauteuil-drop');if(dd)dd.style.display='none'},150)">
          <input type="hidden" id="tr-fauteuil-id" value="${d.fauteuil_id||''}">
          <div id="tr-fauteuil-drop" class="piece-dropdown" style="display:none"></div>
        </div>
      </div>
      <div class="divider"></div>
      <div class="grid-2">
        <div class="form-group">
          <label class="form-label">${t('transferts_client_depart')}</label>
          <div style="position:relative">
            <input class="form-input" id="tr-depart-search" autocomplete="off"
              placeholder="${t('select_client')}"
              value="${d.client_depart_nom?esc(d.client_depart_nom):''}"
              oninput="document.getElementById('tr-depart-id').value='';searchClientsTransfert(this.value,'depart')"
              onfocus="searchClientsTransfert(this.value,'depart')"
              onblur="setTimeout(()=>{const dd=document.getElementById('tr-depart-drop');if(dd)dd.style.display='none'},150)">
            <input type="hidden" id="tr-depart-id" value="${d.client_depart_id||''}">
            <div id="tr-depart-drop" class="piece-dropdown" style="display:none"></div>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">${t('transferts_client_arrivee')}</label>
          <div style="position:relative">
            <input class="form-input" id="tr-arrivee-search" autocomplete="off"
              placeholder="${t('select_client')}"
              value="${d.client_arrivee_nom?esc(d.client_arrivee_nom):''}"
              oninput="document.getElementById('tr-arrivee-id').value='';searchClientsTransfert(this.value,'arrivee')"
              onfocus="searchClientsTransfert(this.value,'arrivee')"
              onblur="setTimeout(()=>{const dd=document.getElementById('tr-arrivee-drop');if(dd)dd.style.display='none'},150)">
            <input type="hidden" id="tr-arrivee-id" value="${d.client_arrivee_id||''}">
            <div id="tr-arrivee-drop" class="piece-dropdown" style="display:none"></div>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">${t('transferts_date_depart')}</label>
          <input class="form-input" id="tr-date-depart" type="date" value="${d.date_depart||''}">
        </div>
        <div class="form-group">
          <label class="form-label">${t('transferts_date_arrivee')}</label>
          <input class="form-input" id="tr-date-arrivee" type="date" value="${d.date_arrivee||''}">
        </div>
        <div class="form-group">
          <label class="form-label">${t('transferts_transporteur')}</label>
          <select class="form-input" id="tr-transporteur">
            <option value="">${t('select_aucun')}</option>
            <option value="DSV" ${d.transporteur==='DSV'?'selected':''}>${t('transferts_dsv')}</option>
            <option value="Autre" ${d.transporteur==='Autre'?'selected':''}>${t('transferts_autre')}</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">${t('transferts_num_suivi')}</label>
          <input class="form-input mono" id="tr-num-suivi" value="${esc(d.num_suivi||'')}">
        </div>
        <div class="form-group" style="grid-column:1/-1">
          <label class="form-label">${t('col_statut')}</label>
          <select class="form-input" id="tr-statut" onchange="document.getElementById('tr-arrive-hint').style.display=this.value==='Arrivé'?'block':'none'">
            ${[['En préparation','transferts_statut_prep'],['En transit','transferts_statut_transit'],['Arrivé','transferts_statut_arrive'],['Annulé','transferts_statut_annule']].map(([v,k])=>`<option value="${v}" ${d.statut===v?'selected':''}>${t(k)}</option>`).join('')}
          </select>
          <div id="tr-arrive-hint" style="display:${d.statut==='Arrivé'?'block':'none'};font-size:11px;color:var(--warning);margin-top:4px"><i class="ti ti-alert-triangle"></i> ${t('transferts_arrive_hint')}</div>
        </div>
        <div class="form-group" style="grid-column:1/-1">
          <label class="form-label">Notes</label>
          <textarea class="form-input" id="tr-notes" rows="2">${esc(d.notes||'')}</textarea>
        </div>
      </div>
    </div>
    <div class="modal-footer">
      ${id?`<button class="btn danger" onclick="if(confirm(t('transferts_confirm_suppr')))API.deleteTransfert(${id}).then(()=>{closeModal();render();toast(t('msg_supprime'),'ti-trash')})"><i class="ti ti-trash"></i></button>`:''}
      <button class="btn" onclick="closeModal()">${t('btn_annuler')}</button>
      <button class="btn primary" onclick="saveTransfert(${id||'null'})"><i class="ti ti-check"></i>${t('btn_enregistrer')}</button>
    </div>`);
}

async function searchFauteuilTransfert(q){
  const drop=document.getElementById('tr-fauteuil-drop');
  if(!drop)return;
  if(!q||q.trim().length<2){drop.style.display='none';return;}
  try{
    const res=await API.recherche(q.trim());
    const fauteuils=res.fauteuils||[];
    if(!fauteuils.length){drop.innerHTML=`<div class="qs-empty" style="padding:10px 12px;font-size:12px;color:var(--text3)">${t('qs_no_result')} "${esc(q)}"</div>`;drop.style.display='block';return;}
    drop.innerHTML=fauteuils.map(f=>`<div class="piece-option" onmousedown="event.preventDefault();selectFauteuilTransfert(${f.id},'${esc(f.modele||'')}','${esc(f.serie||'')}',${f.client_id||'null'},'${esc(f.client_nom||'')}')">
      <div style="font-size:13px;font-weight:700">${esc(f.modele||'?')} <span class="mono" style="font-weight:400;font-size:12px;color:var(--accent)">${esc(f.serie)}</span></div>
      <div style="font-size:11px;color:var(--text3)">${esc(f.client_nom||'')}</div>
    </div>`).join('');
    drop.style.display='block';
  }catch(e){}
}

function selectFauteuilTransfert(id,modele,serie,clientId,clientNom){
  document.getElementById('tr-fauteuil-id').value=id;
  document.getElementById('tr-fauteuil-search').value=`${modele} — ${serie}`;
  document.getElementById('tr-fauteuil-drop').style.display='none';
  // Pré-remplir le distributeur de départ si vide
  const departId=document.getElementById('tr-depart-id');
  const departInp=document.getElementById('tr-depart-search');
  if(clientId&&departId&&!departId.value){
    departId.value=clientId;
    if(departInp)departInp.value=clientNom;
  }
}

function searchClientsTransfert(q,which){
  const drop=document.getElementById(`tr-${which}-drop`);
  if(!drop)return;
  const query=(q||'').toLowerCase().trim();
  const results=(query?TMP_CLIENTS.filter(c=>c.nom.toLowerCase().includes(query)):TMP_CLIENTS).slice(0,15);
  if(!results.length){drop.style.display='none';return;}
  drop.innerHTML=results.map(c=>`<div class="piece-option" onmousedown="event.preventDefault();selectClientTransfert(${c.id},'${c.nom.replace(/'/g,"\\'")}','${which}')">
    <div style="font-size:12px;font-weight:600">${esc(c.nom)}</div>
    <div style="font-size:11px;color:var(--text3)">${esc(c.ville||'')}</div>
  </div>`).join('');
  drop.style.display='block';
}

function selectClientTransfert(id,nom,which){
  document.getElementById(`tr-${which}-id`).value=id;
  document.getElementById(`tr-${which}-search`).value=nom;
  document.getElementById(`tr-${which}-drop`).style.display='none';
}

async function saveTransfert(id){
  const fauteuilId=parseInt(gv('tr-fauteuil-id'));
  const departId=parseInt(gv('tr-depart-id'));
  const arriveeId=parseInt(gv('tr-arrivee-id'));
  if(!fauteuilId||!departId||!arriveeId){alert(t('transferts_fauteuil')+' / '+t('transferts_client_depart')+' / '+t('transferts_client_arrivee'));return;}
  const data={
    fauteuil_id:fauteuilId, client_depart_id:departId, client_arrivee_id:arriveeId,
    date_depart:gv('tr-date-depart')||null, date_arrivee:gv('tr-date-arrivee')||null,
    transporteur:gv('tr-transporteur')||null, num_suivi:gv('tr-num-suivi')||null,
    statut:gv('tr-statut'), notes:gv('tr-notes')
  };
  try{
    id?await API.updateTransfert(id,data):await API.createTransfert(data);
    toast(id?t('msg_inter_maj'):t('msg_inter_cree'),'ti-arrows-exchange');
    closeModal();render();
  }catch(e){alert(e.message);}
}

// ── LANGUE ───────────────────────────────────────────────────────
let TMP_CLIENTS = [];

function applyNavTranslations(){
  document.querySelectorAll('[data-i18n]').forEach(el=>{
    const key=el.dataset.i18n;
    el.textContent=t(key);
  });
}

function switchLang(lang, doRender=true){
  setLang(lang);
  applyNavTranslations();
  if(doRender) render();
}

// ── RECHERCHE RAPIDE DASHBOARD ────────────────────────────────────
let QS_TIMER=null;
function quickSearch(q){
  clearTimeout(QS_TIMER);
  if(!q||q.length<2){clearQuickSearch();return;}
  QS_TIMER=setTimeout(async()=>{
    try{
      const res=await API.recherche(q);
      showQuickResults(res,q);
    }catch(e){
      const el=$('qs-results');
      if(el){ el.innerHTML=`<div class="qs-empty" style="color:var(--danger)"><i class="ti ti-alert-circle"></i> Erreur recherche : ${esc(e.message)}</div>`; el.style.display='block'; }
    }
  },200);
}
function clearQuickSearch(){const el=$('qs-results');if(el)el.style.display='none';}
function positionQsResults(){
  const inp = document.getElementById('qs-input');
  let el = document.getElementById('qs-results');
  if(!inp || !el) return;
  // Sortir du stacking context backdrop-filter du parent
  if(el.parentElement !== document.body) document.body.appendChild(el);
  const r = inp.getBoundingClientRect();
  el.style.cssText += ';position:fixed !important;top:'+(r.bottom+6)+'px;left:'+r.left+'px;width:'+Math.max(r.width,400)+'px;z-index:99999 !important';
}

function showQuickResults(res,q){
  const el=$('qs-results');if(!el)return;
  const{fauteuils=[],clients=[],commandes=[]}=res;
  if(!fauteuils.length&&!clients.length&&!commandes.length){
    positionQsResults();el.innerHTML=`<div class="qs-empty"><i class="ti ti-search-off"></i> Aucun résultat pour "<b>${esc(q)}</b>"</div>`;
    el.style.display='block';return;
  }
  let html='';
  if(fauteuils.length){
    html+=`<div class="qs-section-label">Fauteuils</div>`;
    html+=fauteuils.map(f=>`<div class="qs-item">
      <div style="display:flex;align-items:center;gap:10px">
        <i class="ti ti-wheelchair" style="font-size:18px;color:var(--accent);flex-shrink:0"></i>
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:13px">${esc(f.modele||'?')} <span class="mono" style="font-weight:400;color:var(--text3);font-size:12px">${esc(f.serie)}</span></div>
          <div style="font-size:12px;color:var(--text2)">${esc(f.client_nom||'')}${f.date_achat?' — achat '+fd(f.date_achat):''}</div>
        </div>
        <span class="badge ${f.nb_interventions>0?'attente':'g'}" style="font-size:10px">${f.nb_interventions} inter.</span>
      </div>
      <div style="display:flex;gap:6px;margin-top:6px;padding-left:28px;flex-wrap:wrap">
        <button class="btn sm primary" onclick="quickNewInter(${f.id},${f.client_id})"><i class="ti ti-plus"></i>Nouvelle intervention</button>
        <button class="btn sm" onclick="setView('fauteuil',{fauteuilId:${f.id},clientId:${f.client_id}});clearQuickSearch()"><i class="ti ti-eye"></i>Voir la fiche</button>
        <button class="btn sm" onclick="${f.commande_id
          ? `setView('commandes');clearQuickSearch();setTimeout(()=>modalCommande(${f.commande_id}),300)`
          : `CMD_FILTERS.q=${JSON.stringify(f.serie||'')};setView('commandes');clearQuickSearch()`
        }"><i class="ti ti-clipboard-list"></i>Commande</button>
      </div>
    </div>`).join('');
  }
  if(commandes.length){
    html+=`<div class="qs-section-label" style="margin-top:4px">Commandes</div>`;
    html+=commandes.map(cmd=>{
      const statut = cmdStatutClass ? cmdStatutClass(cmd.statut||'En préparation') : '';
      return `<div class="qs-item" onclick="setView('commandes');clearQuickSearch();setTimeout(()=>modalCommande(${cmd.id}),300)" style="cursor:pointer">
        <div style="display:flex;align-items:center;gap:10px">
          <i class="ti ti-clipboard-list" style="font-size:18px;color:var(--accent);flex-shrink:0"></i>
          <div style="flex:1;min-width:0">
            <div style="font-weight:700;font-size:13px">${esc(cmd.distributeur_nom)}${cmd.bdc?` <span class="mono" style="font-weight:400;color:var(--text3);font-size:12px">${esc(cmd.bdc)}</span>`:''}${cmd.modele_demo?` <span class="badge hg" style="font-size:10px">🔄 ${t('cmd_demo_badge')||'Démo'}</span>`:''}</div>
            <div style="font-size:12px;color:var(--text2)">${esc(cmd.modele||'')}${cmd.num_facture?' · Facture : '+esc(cmd.num_facture):''}${cmd.num_serie?' · '+esc(cmd.num_serie):''}${cmd.date_commande?' · '+fd(cmd.date_commande):''}</div>
          </div>
          ${cmd.statut?`<span class="badge ${statut}" style="font-size:10px">${esc(tStatut(cmd.statut))}</span>`:''}
        </div>
      </div>`;
    }).join('');
  }
  if(clients.length){
    html+=`<div class="qs-section-label" style="margin-top:4px">Distributeurs</div>`;
    html+=clients.map(c=>`<div class="qs-item" onclick="setView('client',{clientId:${c.id}});clearQuickSearch()">
      <div style="display:flex;align-items:center;gap:10px">
        <i class="ti ti-users" style="font-size:18px;color:var(--accent);flex-shrink:0"></i>
        <div style="flex:1">
          <div style="font-weight:700;font-size:13px">${esc(c.nom)}</div>
          <div style="font-size:12px;color:var(--text2)">${esc(c.ville||'')} — ${c.nb_fauteuils||0} fauteuil${(c.nb_fauteuils||0)!==1?'s':''}</div>
        </div>
        <button class="btn sm primary" onclick="event.stopPropagation();modalNewIntervention(null,${c.id});clearQuickSearch()"><i class="ti ti-plus"></i>Intervention</button>
      </div>
    </div>`).join('');
  }
  el.innerHTML=html;el.style.display='block';
}
async function quickNewInter(fauteuilId,clientId){clearQuickSearch();const inp=$('qs-input');if(inp)inp.value='';await modalNewIntervention(fauteuilId,clientId);}
async function importerExcel(file){
  if(!file)return;
  const progress=$('qs-import-progress');
  if(progress){progress.style.display='block';progress.innerHTML=`<div class="card" style="padding:12px;display:flex;align-items:center;gap:10px"><i class="ti ti-loader-2" style="font-size:20px;color:var(--accent)"></i><span>Import en cours : <b>${esc(file.name)}</b>…</span></div>`;}
  try{
    const res=await API.importExcel(file);
    const s=res.stats;
    if(progress){progress.innerHTML=`<div class="card" style="padding:12px;background:var(--success-bg);border-color:var(--success)">
      <div style="font-weight:700;color:var(--success);margin-bottom:6px"><i class="ti ti-check"></i> Import réussi (${res.sheets.join(', ')})</div>
      <div style="font-size:12px;display:flex;gap:16px;flex-wrap:wrap">
        <span>✚ ${s.clients} nouveaux clients</span><span>✚ ${s.fauteuils} nouveaux fauteuils</span>
        <span>↻ ${s.doublons} mis à jour</span><span style="color:var(--text3)">— ${s.ignores} ignorés (accessoires)</span>
        ${s.erreurs?`<span style="color:var(--danger)">⚠ ${s.erreurs} erreurs</span>`:''}
      </div>
      <button class="btn sm" style="margin-top:8px" onclick="this.parentElement.parentElement.style.display='none';render()"><i class="ti ti-x"></i>Fermer</button>
    </div>`;}
    refreshBadges();
  }catch(e){
    if(progress){progress.innerHTML=`<div class="card" style="padding:12px;background:var(--danger-bg);border-color:var(--danger)"><div style="color:var(--danger);font-weight:700"><i class="ti ti-alert-circle"></i> Erreur : ${esc(e.message)}</div><button class="btn sm" style="margin-top:8px" onclick="this.parentElement.parentElement.style.display='none'"><i class="ti ti-x"></i>Fermer</button></div>`;}
  }
}
document.addEventListener('click',e=>{const qs=$('qs-results'),inp=$('qs-input');if(qs&&!qs.contains(e.target)&&e.target!==inp)clearQuickSearch();});

// ── RECHERCHE FAUTEUIL DANS FORMULAIRE INTERVENTION ───────────────
async function searchFauteuilInter(q){
  const drop=document.getElementById('fauteuil-inter-drop');
  if(!drop)return;
  if(!q||q.trim().length<2){drop.style.display='none';return;}
  try{
    const res=await API.recherche(q.trim());
    const fauteuils=res.fauteuils||[];
    if(!fauteuils.length){drop.innerHTML=`<div class="qs-empty" style="padding:10px 12px;font-size:12px;color:var(--text3)">Aucun fauteuil — utilisez "+ Créer" pour en ajouter un</div>`;drop.style.display='block';return;}
    drop.innerHTML=fauteuils.map(f=>`<div class="piece-option" onmousedown="event.preventDefault();selectFauteuilInter(${f.id},'${esc(f.modele||'')}','${esc(f.serie||'')}',${f.client_id||'null'},'${esc(f.client_nom||'')}')">
      <div style="font-size:13px;font-weight:700">${esc(f.modele||'?')} <span class="mono" style="font-weight:400;font-size:12px;color:var(--accent)">${esc(f.serie)}</span></div>
      <div style="font-size:11px;color:var(--text3)">${esc(f.client_nom||'')}${f.date_achat?' — achat '+fd(f.date_achat):''}</div>
    </div>`).join('');
    drop.style.display='block';
  }catch(e){}
}
function toggleAutreDistrib(checked){
  const readonly=document.getElementById('distrib-readonly');
  const searchWrap=document.getElementById('distrib-search-wrap');
  const cb=document.getElementById('f-autre-distrib');
  if(!readonly||!searchWrap)return;
  if(checked){
    // Passer en mode recherche libre
    readonly.style.display='none';
    searchWrap.style.display='block';
    // Vider le client sélectionné pour forcer un nouveau choix
    const hid=document.getElementById('f-client');if(hid)hid.value='';
    setTimeout(()=>{const inp=document.getElementById('f-client-search');if(inp){inp.value='';inp.focus();}},50);
  } else {
    // Revenir au distributeur du fauteuil
    searchWrap.style.display='none';
    readonly.style.display='flex';
    const inp=document.getElementById('f-client-search');if(inp)inp.value='';
  }
}

function selectFauteuilInter(id,modele,serie,clientId,clientNom){
  const hid=document.getElementById('f-fauteuil');if(hid)hid.value=id;
  const inp=document.getElementById('f-serie-search');if(inp)inp.value=`${modele} — ${serie}`;
  const drop=document.getElementById('fauteuil-inter-drop');if(drop)drop.style.display='none';
  // Mettre à jour l'affichage du distributeur (mode lecture)
  const clientHid=document.getElementById('f-client');
  const distribNom=document.getElementById('distrib-readonly-nom');
  const autreDistrib=document.getElementById('f-autre-distrib');
  if(!autreDistrib?.checked){
    // Mode normal : afficher le distributeur du fauteuil
    if(clientHid)clientHid.value=clientId||'';
    if(distribNom)distribNom.textContent=clientNom||'—';
    const readonly=document.getElementById('distrib-readonly');
    if(readonly)readonly.style.display='flex';
    const searchWrap=document.getElementById('distrib-search-wrap');
    if(searchWrap)searchWrap.style.display='none';
  }
}
function toggleNewFauteuilInline(){
  const el=document.getElementById('new-fauteuil-inline');
  if(!el)return;
  const open=el.style.display==='none';
  el.style.display=open?'block':'none';
  if(open)setTimeout(()=>{const s=document.getElementById('nf-serie');if(s&&!document.getElementById('nf-serie-absent')?.checked)s.focus();},50);
}
function toggleSerieAbsent(checked){
  const inp=document.getElementById('nf-serie');
  const msg=document.getElementById('nf-serie-absent-msg');
  if(!inp)return;
  inp.disabled=checked;inp.value='';inp.style.opacity=checked?'0.4':'1';
  inp.placeholder=checked?'— généré automatiquement —':'ex: A06L2502011042';
  if(msg)msg.style.display=checked?'block':'none';
}
async function createFauteuilInline(){
  const clientId=parseInt(gv('f-client'));
  if(!clientId){alert("Sélectionnez d'abord un distributeur.");return;}
  const serieAbsent=document.getElementById('nf-serie-absent')?.checked;
  const modele=gv('nf-modele');
  const serie=serieAbsent?`INCONNU-${modele.replace(/\s+/g,'-').toUpperCase()}-${Date.now().toString().slice(-6)}`:gv('nf-serie').trim();
  if(!serie){alert('Le numéro de série est requis (ou cochez "Numéro absent").');return;}
  try{
    const f=await API.createFauteuil({client_id:clientId,modele,serie,date_achat:gv('nf-dateachat')||null,duree_garantie_mois:parseInt(gv('nf-garduree'))||24});
    const hid=document.getElementById('f-fauteuil');if(hid)hid.value=f.id;
    const inp=document.getElementById('f-serie-search');if(inp)inp.value=`${f.modele} — ${f.serie}`;
    const el=document.getElementById('new-fauteuil-inline');if(el)el.style.display='none';
    toast(f.already_exists?`Fauteuil (${f.serie}) déjà en base — sélectionné`:`Fauteuil ${f.modele} (${f.serie}) créé`,'ti-wheelchair');
  }catch(e){alert('Erreur : '+e.message);}
}

// ── RECHERCHE CLIENTS DANS FORMULAIRE ────────────────────────────
function searchClients(q,allClients){
  const drop=document.getElementById('client-drop');if(!drop)return;
  const query=q.toLowerCase().trim();
  const results=(query?allClients.filter(c=>c.nom.toLowerCase().includes(query)||(c.ville&&c.ville.toLowerCase().includes(query))):allClients).slice(0,15);
  if(!results.length){drop.style.display='none';return;}
  drop.innerHTML=results.map(c=>`<div class="piece-option" onmousedown="event.preventDefault();selectClient(${c.id},'${c.nom.replace(/'/g,"\'")}')">
    <div style="font-size:12px;font-weight:600">${esc(c.nom)}</div>
    <div style="font-size:11px;color:var(--text3)">${esc(c.ville||'')}${c.contact?' — '+esc(c.contact):''}</div>
  </div>`).join('');
  drop.style.display='block';
}
async function selectClient(id,nom){
  const inp=document.getElementById('f-client-search');
  const hid=document.getElementById('f-client');
  if(inp)inp.value=nom;
  if(hid)hid.value=id;
  const drop=document.getElementById('client-drop');if(drop)drop.style.display='none';
  // En mode "autre distributeur" on ne recharge pas les fauteuils
  const autreDistrib=document.getElementById('f-autre-distrib');
  if(!autreDistrib?.checked) await refreshFauteuilSelect();
}

// ── FACTURES VF SUR FICHE FAUTEUIL ───────────────────────────────
function toggleEditFacture(interId, currentVal){
  const display = document.getElementById('facture-display-'+interId);
  const edit    = document.getElementById('facture-edit-'+interId);
  const input   = document.getElementById('facture-input-'+interId);
  if(!display||!edit) return;
  display.style.display = 'none';
  edit.style.display    = 'flex';
  if(input){ input.value = currentVal; input.focus(); input.select(); }
}

async function saveFactureInter(interId){
  const input = document.getElementById('facture-input-'+interId);
  if(!input) return;
  const val = input.value.trim();
  try {
    await API.updateIntervention(interId, { num_facture: val || null });
    // Mettre à jour l'affichage
    const display = document.getElementById('facture-display-'+interId);
    const edit    = document.getElementById('facture-edit-'+interId);
    if(display){ display.innerHTML = val ? `<span class="mono" style="color:var(--accent)">${esc(val)}</span>` : '<span style="color:var(--text3)">—</span>'; display.style.display='block'; }
    if(edit)    edit.style.display = 'none';
    toast('Numéro de facture mis à jour','ti-receipt');
  } catch(e) { alert('Erreur : '+e.message); }
}

async function chargerFacturesVF(fauteuilId){
  const el=document.getElementById('factures-vf-content');if(!el)return;
  el.innerHTML='<i class="ti ti-loader-2"></i> Chargement depuis VosFactures…';
  try{
    const{factures,serie,configured}=await API.facturesVF(fauteuilId);
    if(!configured){el.innerHTML='<span style="color:var(--text3)">VosFactures non configuré.</span>';return;}
    if(!factures.length){el.innerHTML=`<span style="color:var(--text3)">Aucune facture trouvée pour la série <span class="mono">${esc(serie||'?')}</span>.</span>`;return;}
    el.innerHTML=`<table class="t"><thead><tr><th>Numéro</th><th>${t('col_date')}</th><th>Client VF</th><th>Montant TTC</th><th>${t('col_statut')}</th><th></th></tr></thead>
      <tbody>${factures.map(f=>`<tr>
        <td class="mono" style="color:var(--accent)">${esc(f.numero)}</td>
        <td>${f.date?fd(f.date.substring(0,10)):'—'}</td>
        <td style="font-size:11px">${esc(f.client_nom||'')}</td>
        <td style="font-weight:700">${f.montant_ttc?parseFloat(f.montant_ttc).toFixed(2)+' €':'—'}</td>
        <td><span class="badge ${f.statut==='paid'?'g':'attente'}">${f.statut==='paid'?'Payée':t('inter_statut_attente')}</span></td>
        <td><a href="${esc(f.url)}" target="_blank" class="btn sm"><i class="ti ti-external-link"></i>VF</a></td>
      </tr>`).join('')}</tbody></table>`;
  }catch(e){el.innerHTML=`<span style="color:var(--danger)">Erreur : ${esc(e.message)}</span>`;}
}

// ── SYNC HISTORIQUE VF ────────────────────────────────────────────
let SYNC_POLL_TIMER=null;
async function syncHistorique(){
  const el=document.getElementById('historique-progress');if(!el)return;
  el.style.display='block';
  el.innerHTML=`<div class="card" style="padding:10px;font-size:12px"><div style="font-weight:600;margin-bottom:4px"><i class="ti ti-loader-2"></i> Sync historique lancée en arrière-plan…</div><div id="sync-histo-msg" style="color:var(--text3)">Démarrage…</div><div style="font-size:11px;color:var(--text3);margin-top:4px">Cela peut prendre 10 à 20 min. Vous pouvez continuer à utiliser l'application.</div></div>`;
  try{await API.vfSyncHistorique();pollSyncHistorique();}catch(e){el.innerHTML=`<div class="card" style="padding:10px;background:var(--danger-bg);border-color:var(--danger);font-size:12px;color:var(--danger)"><i class="ti ti-alert-circle"></i> Erreur : ${esc(e.message)}</div>`;}
}
function pollSyncHistorique(){
  clearInterval(SYNC_POLL_TIMER);
  SYNC_POLL_TIMER=setInterval(async()=>{
    try{
      const s=await API.vfSyncHistoriqueStatus();
      const el=document.getElementById('historique-progress');
      const msg=document.getElementById('sync-histo-msg');
      if(!el){clearInterval(SYNC_POLL_TIMER);return;}
      if(msg)msg.textContent=s.progress||'…';
      if(s.done){
        clearInterval(SYNC_POLL_TIMER);
        if(s.error){el.innerHTML=`<div class="card" style="padding:10px;background:var(--danger-bg);border-color:var(--danger);font-size:12px;color:var(--danger)"><i class="ti ti-alert-circle"></i> Erreur : ${esc(s.error)}<button class="btn sm" style="display:block;margin-top:6px" onclick="this.parentElement.parentElement.style.display='none'"><i class="ti ti-x"></i>Fermer</button></div>`;}
        else{el.innerHTML=`<div class="card" style="padding:10px;background:var(--success-bg);border-color:var(--success);font-size:12px"><div style="font-weight:700;color:var(--success);margin-bottom:6px"><i class="ti ti-check"></i> Sync historique terminée !</div><div>${esc(s.results?.clients||'—')}</div><div>${esc(s.results?.products||'—')}</div><div>${esc(s.results?.invoices||'—')}</div><button class="btn sm" style="margin-top:8px" onclick="this.parentElement.parentElement.style.display='none';render()"><i class="ti ti-x"></i>Fermer</button></div>`;toast('Sync historique terminée','ti-history');}
      }
    }catch(e){}
  },5000);
}

// ── FUSION CLIENTS ────────────────────────────────────────────────
async function modalFusionnerClient(idCible){
  const clients=await API.clients();
  const cible=clients.find(c=>c.id===idCible);if(!cible)return;
  window._FUSION_CLIENTS=clients.filter(c=>c.id!==idCible);
  showModal(`<div class="modal-header"><i class="ti ti-git-merge" style="font-size:18px;color:var(--accent)"></i><h2>Fusionner un doublon</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body">
      <div style="background:var(--accent-bg);border-radius:var(--radius);padding:10px 12px;margin-bottom:14px;font-size:13px"><div style="font-weight:700;color:var(--accent);margin-bottom:2px"><i class="ti ti-shield-check"></i> Client conservé</div><div>${esc(cible.nom)}</div></div>
      <div class="form-group"><label class="form-label">Doublon à supprimer</label>
        <div style="position:relative">
          <input class="form-input" id="fusion-search" placeholder="Taper le nom du doublon…" autocomplete="off"
            oninput="searchFusionClient(this.value)" onfocus="searchFusionClient(this.value)"
            onblur="setTimeout(()=>{const d=document.getElementById('fusion-drop');if(d)d.style.display='none'},150)">
          <input type="hidden" id="fusion-source-id">
          <div id="fusion-drop" class="piece-dropdown" style="display:none"></div>
        </div>
        <div id="fusion-source-info" style="margin-top:6px;font-size:12px;color:var(--text3)"></div>
      </div>
      <div class="form-group"><label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">
        <input type="checkbox" id="fusion-vf-ignore" checked>
        <span>Empêcher la sync VosFactures de recréer ce doublon</span>
      </label></div>
      <div style="background:var(--danger-bg);border:1px solid var(--danger);border-radius:var(--radius);padding:8px 12px;font-size:12px;color:var(--danger)"><i class="ti ti-alert-triangle"></i> Les fauteuils et interventions du doublon seront transférés vers <b>${esc(cible.nom)}</b>, puis le doublon sera supprimé.</div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">${t('btn_annuler')}</button>
      <button class="btn danger" onclick="confirmerFusion(${idCible})"><i class="ti ti-git-merge"></i>Fusionner et supprimer</button>
    </div>`);
}
function searchFusionClient(q){
  const drop=document.getElementById('fusion-drop');if(!drop)return;
  const query=q.toLowerCase().trim();
  const results=(query?(window._FUSION_CLIENTS||[]).filter(c=>c.nom.toLowerCase().includes(query)):(window._FUSION_CLIENTS||[])).slice(0,12);
  if(!results.length){drop.style.display='none';return;}
  drop.innerHTML=results.map(c=>`<div class="piece-option" onmousedown="event.preventDefault();selectFusionSource(${c.id},'${c.nom.replace(/'/g,"\'")}',${c.nb_fauteuils||0})"><div style="font-size:12px;font-weight:600">${esc(c.nom)}</div><div style="font-size:11px;color:var(--text3)">${c.nb_fauteuils||0} fauteuil(s)</div></div>`).join('');
  drop.style.display='block';
}
function selectFusionSource(id,nom,nbFauteuils){
  const inp=document.getElementById('fusion-search');if(inp)inp.value=nom;
  const hid=document.getElementById('fusion-source-id');if(hid)hid.value=id;
  const drop=document.getElementById('fusion-drop');if(drop)drop.style.display='none';
  const info=document.getElementById('fusion-source-info');
  if(info)info.innerHTML=`<span style="color:var(--warning)"><i class="ti ti-alert-triangle"></i> Ce doublon a <b>${nbFauteuils}</b> fauteuil(s) qui seront transférés.</span>`;
}
async function confirmerFusion(idCible){
  const idSource=parseInt(gv('fusion-source-id'));
  if(!idSource){alert('Veuillez sélectionner un doublon.');return;}
  const vfIgnore=document.getElementById('fusion-vf-ignore')?.checked!==false;
  if(!confirm('Confirmer la fusion ? Le doublon sera supprimé définitivement.'))return;
  try{
    const r=await API.fusionnerClients(idCible,idSource,vfIgnore);
    toast(`Fusion réussie — ${r.fauteuils_transferes} fauteuil(s) transférés`,'ti-git-merge');
    closeModal();render();
  }catch(e){alert('Erreur : '+e.message);}
}

// ── INIT ────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(n=>n.classList.toggle('active',n.dataset.view==='dashboard'));
applyNavTranslations();

(async () => {
  // Charger l'utilisateur courant (rôle, nom) avant d'afficher quoi que ce soit
  try {
    const r = await fetch('/api/auth/me');
    if (r.status === 401) { window.location.href = '/login'; return; }
    CURRENT_USER = await r.json();
  } catch(e) {
    window.location.href = '/login';
    return;
  }
  // Appliquer la langue de l'utilisateur (override la préférence navigateur)
  if(CURRENT_USER.langue && CURRENT_USER.langue !== (typeof LANG !== 'undefined' ? LANG : 'fr')){
    switchLang(CURRENT_USER.langue, false); // false = ne pas sauvegarder en DB (déjà en DB)
  }
  appliquerNavRole();
  loadVfStatus();
  refreshBadges();
  setInterval(refreshBadges, 60000);
  render();

})();
