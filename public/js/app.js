// public/js/app.js v2

let STATE = { view:'dashboard', clientId:null, fauteuilId:null, q:'' };
let CMD_FILTERS = { annee:'', mois:'', statut:'', groupe:'', distributeur:'', q:'', type:'' };
let _cmdReqId = 0; // anti-race condition pour la recherche commandes
// Colonnes visibles en Suivi commandes (persistées en localStorage)
const CMD_COLS_DEFAULT = { num_annuel: false, paiement: false, facture: false, date_facture: false, demo_origine: false, edi: false, pays: false, retour: false, date_retour: false };
// Merge stored prefs with defaults — nouvelles colonnes héritent de false si absentes du stockage
let CMD_COLS = { ...CMD_COLS_DEFAULT, ...JSON.parse(localStorage.getItem('sav_cmd_cols') || '{}') };
let CACHE = { catalogue:[], params:{} };
let TMP_PRODUITS = [];
let CURRENT_USER = null; // Chargé au démarrage via /api/auth/me

const fd  = d => { if(!d)return'—'; const[y,m,day]=d.split('-'); return`${day}/${m}/${y}`; };
// Formatage universel des numéros de téléphone → « 09 67 66 51 29 » (paires espacées).
// Gère 0967665129, 09.67.66.51.29, +33967665129, 0033967665129. Idempotent.
function fmtTel(v){
  if(v==null) return '';
  const raw=String(v).trim(); if(!raw) return '';
  let d=raw.replace(/[^\d+]/g,''); let plus=false;
  if(/^\+33/.test(d)) d='0'+d.slice(3);
  else if(/^0033/.test(d)) d='0'+d.slice(4);
  else if(d[0]==='+'){ plus=true; d=d.slice(1); }
  d=d.replace(/\D/g,''); if(!d) return raw;
  const pairs=d.match(/\d{1,2}/g)||[];
  return (plus?'+':'')+pairs.join(' ');
}
// Version pour l'attribut href="tel:" (chiffres + éventuel +).
function telHref(v){ return String(v==null?'':v).replace(/[^\d+]/g,''); }
window.fmtTel=fmtTel; window.telHref=telHref;
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
  { key:'carte',         label:'Carte distributeurs' },
  { key:'demandes',      label:"Demandes d'infos" },
  { key:'interventions', label:'Interventions SAV' },
  { key:'commandes',     label:'Suivi commandes' },
  { key:'catalogue',     label:'Catalogue pièces' },
  { key:'prets',         label:'Prêts' },
  { key:'rapports',      label:'Rapports & exports' },
  { key:'alertes',       label:'Alertes' },
  { key:'retours_suede', label:'Retours Suède' },
  { key:'transferts',    label:'Transferts fauteuils' },
  { key:'devis',         label:'Devis VosFactures' },
  { key:'parametres',    label:'Paramètres' },
];

// Modules qui héritent d'un autre module si non défini explicitement
const PERM_FALLBACK = {
  'discussions': 'commandes',
  'carte':      'clients',     // Carte : par défaut, qui gère les clients voit/modifie la carte
  'devis':      'commandes',   // Devis hérite de commandes
  'dashboard':  'commandes',   // Tableau de bord toujours accessible si commandes
  'parc-demo':  'commandes',   // Parc démo : visible si accès au suivi commandes
};

function hasAccess(module) {
  if (module === 'logs') return true; // Journal d'activité : accessible à tous les utilisateurs
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
// Droit d'écriture sur la carte : admin, ou permission 'carte'=write (repli 'clients').
function canWriteCarte() {
  if (isAdmin()) return true;
  const perms = CURRENT_USER?.permissions || {};
  let p = perms['carte'];
  if (p === undefined) p = perms['clients'];
  return p === 'write';
}
window.canWriteCarte = canWriteCarte;
// Rétrocompatibilité (générique sans module)
const isOp = () => isAdmin() || Object.values(CURRENT_USER?.permissions || {}).includes('write');

async function seDeconnecter(){
  if(!confirm(TR('Se déconnecter ?'))) return;
  await fetch('/api/auth/logout', { method:'POST' });
  window.location.href = '/login';
}

function toast(msg,icon='ti-check',color=''){
  $('toast-area').innerHTML=`<div class="toast" style="${color?'background:'+color:''}">${icon?`<i class="ti ${icon}"></i>`:''} ${esc(msg)}</div>`;
  setTimeout(()=>{$('toast-area').innerHTML='';},3000);
}
function showModal(html){$('modal-area').innerHTML=`<div class="modal-overlay"><div class="modal">${html}</div></div>`;}
function closeModal(){$('modal-area').innerHTML='';}
// Fermeture des fenêtres uniquement via les boutons ou la touche Échap (jamais par un clic en dehors)
document.addEventListener('keydown', function(e){ if(e.key==='Escape'){ var ma=document.getElementById('modal-area'); if(ma && ma.innerHTML.trim()){ closeModal(); } } });

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
  operateur:    ['dashboard','clients','interventions','commandes','catalogue','alertes','retours_suede','transferts'],
  consultation: ['dashboard'],
};

function appliquerNavRole(){
  if(!CURRENT_USER) return;
  document.querySelectorAll('.nav-item[data-view]').forEach(n => {
    n.style.display = hasAccess(n.dataset.view) ? '' : 'none';
  });
  const userZone = $('user-zone');
  if(userZone) userZone.innerHTML = `
    <span style="font-size:13px;color:var(--text2);flex:1">${esc(CURRENT_USER.nom)}</span>
    ${CURRENT_USER.pays?`<span style="font-size:13px;padding:2px 7px;border-radius:10px;background:var(--accent-soft,rgba(59,130,246,.12));color:var(--accent);font-weight:600">${esc(CURRENT_USER.pays)}</span>`:''}
    <div id="pays-switcher" style="display:flex"></div>
    <button class="btn sm" onclick="seDeconnecter()" title="${TR("Se déconnecter")}" style="padding:4px 8px"><i class="ti ti-logout"></i></button>`;
}

function setView(v, extra={}){
  if(!hasAccess(v)) return;
  // Réinitialiser les recherches locales quand on change de vue
  if(v !== 'clients')   window._clientsQ = '';
  if(v !== 'catalogue') { STATE.q = ''; }
  // Suivi commandes : on repart d'une recherche vierge à chaque entrée dans la vue.
  // Un appelant peut pré-remplir un filtre via extra (ex. depuis le Parc de démo).
  if(v === 'commandes'){
    CMD_FILTERS = { annee:'', mois:'', statut:'', groupe:'', distributeur:'', q:'', type:'' };
    if(extra.q!=null)            CMD_FILTERS.q = extra.q;
    if(extra.statut!=null)       CMD_FILTERS.statut = extra.statut;
    if(extra.distributeur!=null) CMD_FILTERS.distributeur = extra.distributeur;
    if(extra.groupe!=null)       CMD_FILTERS.groupe = extra.groupe;
    if(extra.type!=null)         CMD_FILTERS.type = extra.type;
  }
  STATE={view:v, clientId:extra.clientId||null, fauteuilId:extra.fauteuilId||null, q:''};
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.toggle('active', n.dataset.view===v));
  render();
}
document.querySelectorAll('.nav-item').forEach(n=>n.addEventListener('click',()=>setView(n.dataset.view)));


async function render(){
  const ttl=$('topbar-title'),c=$('content'),a=$('topbar-actions');
  a.innerHTML='';
  c.innerHTML=`<div class="empty" style="padding-top:60px"><i class="ti ti-loader-2" style="font-size:30px;display:block;margin-bottom:8px"></i>${t('msg_chargement')}</div>`;
  try{
    if(STATE.view==='dashboard')     await renderDashboard(ttl,c,a);
    else if(STATE.view==='clients')  await renderClients(ttl,c,a);
    else if(STATE.view==='demandes') await renderDemandes(ttl,c,a);
    else if(STATE.view==='client')   await renderClient(ttl,c,a);
    else if(STATE.view==='devis')    await renderDevis(ttl,c,a);
    else if(STATE.view==='fauteuil') await renderFauteuil(ttl,c,a);
    else if(STATE.view==='interventions') await renderInterventions(ttl,c,a);
    else if(STATE.view==='expeditions')   await renderExpeditions(ttl,c,a);
    else if(STATE.view==='commandes')     await renderCommandes(ttl,c,a);
    else if(STATE.view==='catalogue')     await renderCatalogue(ttl,c,a);
    else if(STATE.view==='commande-suede') await renderCommandeSuede(ttl,c,a);
    else if(STATE.view==='rapports')      await renderRapports(ttl,c,a);
    else if(STATE.view==='alertes')       await renderAlertes(ttl,c,a);
    else if(STATE.view==='carte')         { renderCarte(ttl,c,a); return; }
  else if(STATE.view==='discussions')   {
    localStorage.setItem('sav_discussions_seen', Date.now());
    localStorage.setItem('sav_fil_seen', Date.now());
    const badge = document.getElementById('discussions-badge');
    if(badge) badge.style.display='none';
    renderDiscussions(ttl,c,a); return;
  }
    else if(STATE.view==='parametres')    await renderParametres(ttl,c,a);
    else if(STATE.view==='retours-suede')  await renderRetoursSuede(ttl,c,a);
    else if(STATE.view==='transferts')     await renderTransferts(ttl,c,a);
    else if(STATE.view==='parc-demo')       await renderParcDemo(ttl,c,a);
    else if(STATE.view==='prets')          await renderPrets(ttl,c,a);
    else if(STATE.view==='logs')           await renderLogs(ttl,c,a);
  }catch(e){c.innerHTML=`<div class="empty"><i class="ti ti-alert-circle"></i>Erreur : ${esc(e.message)}</div>`;}
}

// ── Badges ────────────────────────────────────────────────────────
async function refreshDiscussionsBadge(){
  try {
    const me = CURRENT_USER ? CURRENT_USER.id : null;
    const seenNotes = parseInt(localStorage.getItem('sav_discussions_seen')||'0');
    const seenFil   = parseInt(localStorage.getItem('sav_fil_seen')||'0');
    let count = 0;
    // Nouveaux messages/réponses du fil d'équipe
    try {
      const fil = await fetch('/api/discussions/fil?archived=0').then(r => r.ok ? r.json() : []);
      (Array.isArray(fil) ? fil : []).forEach(m => {
        if (new Date(m.created_at).getTime() > seenFil && m.user_id !== me) count++;
        (m.replies || []).forEach(rp => { if (new Date(rp.created_at).getTime() > seenFil && rp.user_id !== me) count++; });
      });
    } catch(_) {}
    // Nouvelles notes de commandes
    try {
      const notes = await API.notesRecent(30);
      count += notes.filter(n => new Date(n.created_at).getTime() > seenNotes && n.user_id !== me).length;
    } catch(_) {}
    const badge = document.getElementById('discussions-badge');
    if (badge) {
      if (count > 0) { badge.textContent = count > 99 ? '99+' : count; badge.style.display = ''; }
      else badge.style.display = 'none';
    }
  } catch(_) {}
}

async function refreshBadges(){
  try{
    const[alertes,cat]=await Promise.all([API.alertes(),API.catalogue()]);
    const nb=alertes.length;
    const bdot=$('badge-alertes'); if(bdot){bdot.style.display=nb>0?'block':'none';}
    const bstock=$('badge-stock'); const nbs=cat.filter(p=>p.stock<=p.stock_alerte).length;
    if(bstock){bstock.style.display=nbs>0?'inline-flex':'none';bstock.textContent=nbs;}
  }catch(e){}
}

// ── LOGS / JOURNAL D'ACTIVITÉ (accessible à tous) ────────────────
let _LOGS_F = { q:'', module:'', action:'' };
function _logModLabel(k){ const m=MODULES.find(x=>x.key===k); return m?m.label:(k||'—'); }
function _logActionBadge(a){
  const map={ 'Ajout':'g', 'Modification':'attente', 'Suppression':'urgent' };
  const ic ={ 'Ajout':'ti-plus', 'Modification':'ti-edit', 'Suppression':'ti-trash' };
  return `<span class="badge ${map[a]||''}"><i class="ti ${ic[a]||'ti-point'}"></i> ${esc(a||'—')}</span>`;
}
function _logDate(v){
  if(!v) return '—';
  const s=String(v); const d=s.slice(0,10).split('-'); const h=s.slice(11,16);
  return d.length===3 ? `${d[2]}/${d[1]}/${d[0]}${h?' '+h:''}` : s.slice(0,16).replace('T',' ');
}
async function renderLogs(ttl,c,a){
  ttl.textContent=TR("Logs d'activité");
  a.innerHTML=`<button class="btn sm" onclick="chargerLogs()"><i class="ti ti-refresh"></i>${TR('Actualiser')}</button>`;
  c.innerHTML=`
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;align-items:center">
      <input class="form-input" id="logs-q" placeholder="${TR('Rechercher (utilisateur…)')}" value="${esc(_LOGS_F.q)}" style="max-width:240px;padding:10px 12px" oninput="_LOGS_F.q=this.value;clearTimeout(window._logT);window._logT=setTimeout(chargerLogs,300)">
      <select class="form-input" id="logs-module" style="width:auto;padding:10px 12px" onchange="_LOGS_F.module=this.value;chargerLogs()">
        <option value="">${TR('Tous les modules')}</option>
        ${MODULES.map(m=>`<option value="${m.key}" ${_LOGS_F.module===m.key?'selected':''}>${esc(m.label)}</option>`).join('')}
      </select>
      <select class="form-input" id="logs-action" style="width:auto;padding:10px 12px" onchange="_LOGS_F.action=this.value;chargerLogs()">
        <option value="">${TR('Toutes les actions')}</option>
        <option value="Ajout" ${_LOGS_F.action==='Ajout'?'selected':''}>${TR('Ajout')}</option>
        <option value="Modification" ${_LOGS_F.action==='Modification'?'selected':''}>${TR('Modification')}</option>
        <option value="Suppression" ${_LOGS_F.action==='Suppression'?'selected':''}>${TR('Suppression')}</option>
      </select>
    </div>
    <div id="logs-body"><div style="color:var(--text2);font-size:15px;padding:20px 0">${t('msg_chargement')}</div></div>`;
  chargerLogs();
}
async function chargerLogs(){
  const el=document.getElementById('logs-body'); if(!el) return;
  let rows=[]; try{ rows=await API.logs({ q:_LOGS_F.q, module:_LOGS_F.module, action:_LOGS_F.action, limit:300 }); }
  catch(e){ el.innerHTML=`<div class="empty"><i class="ti ti-alert-circle"></i>Erreur : ${esc(e.message)}</div>`; return; }
  if(!rows.length){ el.innerHTML=`<div class="empty"><i class="ti ti-history"></i>${TR('Aucune activité enregistrée.')}</div>`; return; }
  el.innerHTML=`<div class="table-wrap"><table class="t">
    <thead><tr>
      <th style="white-space:nowrap">${TR('Date / heure')}</th>
      <th>${TR('Utilisateur')}</th>
      <th>${TR('Action')}</th>
      <th>${TR('Module')}</th>
      <th>${TR('Référence')}</th>
    </tr></thead>
    <tbody>${rows.map(l=>`<tr>
      <td style="white-space:nowrap;font-size:14px;color:var(--text2)">${_logDate(l.created_at)}</td>
      <td style="font-weight:600">${esc(l.user_nom||'—')}</td>
      <td>${_logActionBadge(l.action)}</td>
      <td>${esc(_logModLabel(l.module))}</td>
      <td style="font-size:14px;color:var(--text3)">${l.cible_id?('#'+esc(l.cible_id)):''} <span class="mono" style="font-size:13px">${esc(l.chemin||'')}</span></td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}
window.renderLogs=renderLogs; window.chargerLogs=chargerLogs;

// ── DASHBOARD ────────────────────────────────────────────────────

async function renderDashboard(ttl,c,a){
  ttl.textContent=t('nav_dashboard');
  const{stats:s,recentes}=await API.stats();
  c.innerHTML=`
    <div class="quick-search-bar">
      <div style="position:relative;flex:1;max-width:560px">
        <i class="ti ti-search" style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--text3);font-size:18px;pointer-events:none"></i>
        <input class="form-input" id="qs-input" placeholder="${t('qs_placeholder')}"
          style="padding-left:34px;font-size:16px;border-radius:10px"
          oninput="quickSearch(this.value)"
          onkeydown="if(event.key==='Escape'){this.value='';clearQuickSearch();}">
        <div id="qs-results" class="qs-results" style="display:none"></div>
      </div>
    </div>
    <div id="dash-demos"></div>
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
    </div>
    <div class="grid-4" style="margin-bottom:14px">
      <div class="stat-card"><div class="stat-label">${t('db_garantie')}</div><div class="stat-value" style="color:var(--success)">${s.garantie}</div></div>
      <div class="stat-card"><div class="stat-label">${t('db_hors_garantie')}</div><div class="stat-value" style="color:var(--warning)">${s.hors_garantie}</div></div>
      <div class="stat-card"><div class="stat-label">${t('db_pieces_alerte')}</div><div class="stat-value" style="color:${s.pieces_alerte>0?'var(--danger)':'var(--text)'}">${s.pieces_alerte}</div></div>
      <div class="stat-card" style="cursor:pointer" onclick="setView('alertes')"><div class="stat-label">${t('db_alertes')}</div><div class="stat-value" style="color:${s.alertes_non_lues>0?'var(--danger)':'var(--text)'}">${s.alertes_non_lues}</div></div>
    </div>
    ${hasAccess('demandes')?`<div class="card">
      <div class="section-title"><i class="ti ti-address-book"></i>${t('db_dernieres_demandes')||"Dernières demandes d'informations"}
        <button class="btn sm" style="margin-left:auto" onclick="setView('demandes')"><i class="ti ti-arrow-right"></i>${t('cmd_voir_tout')||'Voir tout'}</button>
      </div>
      <div id="dash-demandes-info">${t('msg_chargement')}</div>
    </div>`:''}
    <div class="card" style="margin-top:14px">
      <div class="section-title"><i class="ti ti-arrows-exchange"></i>${t('transferts_en_cours')}
        <button class="btn sm" style="margin-left:auto" onclick="setView('transferts')"><i class="ti ti-arrow-right"></i>${t('transferts_voir_tout')}</button>
      </div>
      <div id="dash-transferts">${t('msg_chargement')}</div>
    </div>`;
  chargerTransfertsDashboard();
  chargerCommandesDashboard();
  chargerDemosDashboard();
  if(hasAccess('demandes')) chargerDemandesInfoDashboard();
}

async function chargerDemandesInfoDashboard(){
  const el=document.getElementById('dash-demandes-info'); if(!el) return;
  let rows=[]; try{ rows=await API.demandesInfo({}); }catch(e){ el.innerHTML=`<div style="font-size:14px;color:var(--danger);padding:6px 0">Erreur : ${esc(e.message)}</div>`; return; }
  rows=(rows||[]).slice().sort((a,b)=>(b.id||0)-(a.id||0)).slice(0,10);
  if(!rows.length){ el.innerHTML=`<div style="font-size:14px;color:var(--text3);padding:6px 0">${TR('Aucune demande.')}</div>`; return; }
  el.innerHTML=`<div class="table-wrap"><table class="t">
      <thead><tr><th>${TR('Statut')}</th><th>${TR('Date')}</th><th>${TR('Distributeur')}</th><th>${TR('Contact')}</th><th>${TR('Ville / CP')}</th></tr></thead>
      <tbody>${rows.map(d=>`<tr style="cursor:pointer" onclick="setView('demandes')">
        <td>${diBadge(d.statut)}</td>
        <td style="white-space:nowrap">${_dfd(d.date_transmission)}</td>
        <td>${esc(d.client_nom_actuel||d.distributeur_nom||'—')}</td>
        <td>${esc(d.nom||'')}${d.telephone?`<div class="mono" style="color:var(--text3);font-size:13px">${esc(fmtTel(d.telephone))}</div>`:''}</td>
        <td style="white-space:nowrap">${esc(d.ville||'')}${d.cp?' '+esc(d.cp):''}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;
}
window.chargerDemandesInfoDashboard = chargerDemandesInfoDashboard;

async function chargerDemosDashboard(){
  const el=document.getElementById('dash-demos'); if(!el) return;
  try{
    const demos=await API.demosSuivi();
    const dues=(demos||[]).filter(d=>d.du);
    if(!dues.length){ el.innerHTML=''; return; }
    el.innerHTML=`<div class="card" style="margin-bottom:14px;border-left:4px solid var(--warning)">
      <div class="section-title"><i class="ti ti-wheelchair"></i> ${dues.length} démo(s) à suivre (rappel échu)
        <button class="btn sm" style="margin-left:auto" onclick="setView('alertes')"><i class="ti ti-arrow-right"></i>Traiter</button>
      </div>
      <div style="font-size:14px;color:var(--text2)">${dues.slice(0,6).map(d=>esc((d.client_nom||d.distributeur_nom||'')+' — '+(d.modele||'')+(d.num_serie?' ('+d.num_serie+')':''))).join(' · ')}${dues.length>6?' …':''}</div>
    </div>`;
  }catch(_){ el.innerHTML=''; }
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
      <div style="font-size:13px;color:var(--text2);margin-bottom:8px;font-weight:600;text-transform:uppercase;letter-spacing:.04em">Année ${anneeEnCours}</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin-bottom:14px">
        <div class="stat-card"><div class="stat-label">${t('cmd_total')||'Total'}</div><div class="stat-value">${stats.total}</div></div>
        <div class="stat-card"><div class="stat-label">${TR('🦽 Avec N° série')}</div><div class="stat-value" style="color:var(--accent)">${stats.fauteuils_serie||0}</div></div>
        <div class="stat-card"><div class="stat-label">⏳ En attente</div><div class="stat-value">${stats.en_attente||0}</div></div>
        <div class="stat-card"><div class="stat-label">${t('cmd_en_prep')||'En préparation'}</div><div class="stat-value" style="color:var(--danger)">${stats.en_preparation}</div></div>
        <div class="stat-card"><div class="stat-label">${t('cmd_expedie')||'Expédié'}</div><div class="stat-value" style="color:var(--warning)">${stats.expedie}</div></div>
        <div class="stat-card"><div class="stat-label">${t('cmd_livre')||'Livré'}</div><div class="stat-value" style="color:var(--success)">${stats.livre}</div></div>
        <div class="stat-card"><div class="stat-label">${t('cmd_facture_statut')||'Facturé'}</div><div class="stat-value" style="color:var(--accent)">${stats.facture||0}</div></div>
        <div class="stat-card" style="cursor:pointer${stats.impaye>0?';animation:pulse-danger 2s infinite':''}" onclick="STATE.view='commandes';CMD_FILTERS.statut='Impayé';render()" title="${TR("Voir les commandes impayées")}"><div class="stat-label" style="color:var(--danger)">${TR('⚠️ Impayés')}</div><div class="stat-value" style="color:var(--danger)">${stats.impaye||0}</div></div>
        <div class="stat-card"><div class="stat-label">🔄 ${t('cmd_demo_count')||'Démos'}</div><div class="stat-value" style="color:var(--warning)">${stats.demo||0}</div></div>
        <div class="stat-card"><div class="stat-label">${t('cmd_probleme')||'Problème'}</div><div class="stat-value" style="color:${stats.probleme>0?'var(--danger)':'var(--text)'}">${stats.probleme}</div></div>
      </div>
      ${!list.length?`<div style="font-size:14px;color:var(--text3)">${t('cmd_empty')||'Aucune commande trouvée'}</div>`:`
      <div class="table-wrap"><table class="t">
        <thead><tr>
          ${CMD_COLS.num_annuel?'<th style="width:40px;text-align:center;color:var(--text3)">#</th>':''}
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
            ${CMD_COLS.num_annuel?`<td style="text-align:center;font-size:13px;color:var(--text3);font-weight:600">${cm.num_annuel||''}</td>`:''}
        <td>${fd(cm.date_commande)}</td>
            <td><span style="font-size:13px;color:var(--text2)">${esc(cm.groupe||'')}</span></td>
            <td>${esc(cm.distributeur_nom)}</td>
            <td class="mono">${esc(cm.bdc||'')}${cm.num_commande_distrib?` <span style="color:var(--text3);font-size:13px">(${esc(cm.num_commande_distrib)})</span>`:''}</td>
            <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(cm.modele||(cm.accessoire||'').split('\n')[0]||'')}">${esc(cm.modele||(cm.accessoire||'').split('\n')[0]||'')}</td>
            <td class="mono" style="max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(cm.num_suivi||'')}${lien?` <a href="${lien}" target="_blank" rel="noopener" onclick="event.stopPropagation()"><i class="ti ti-external-link" style="color:var(--accent)"></i></a>`:''}</td>
            <td><span class="badge ${cmdStatutClass(cm.statut_calc)}">${esc(tStatut(cm.statut_calc))}</span></td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>`}`;
  }catch(e){ el.innerHTML=`<div style="font-size:14px;color:var(--danger)">${esc(e.message)}</div>`; }
}

async function chargerTransfertsDashboard(){  const el=document.getElementById('dash-transferts');
  if(!el) return;
  if(!isAdmin() && !hasAccess('transferts')){
    el.closest('.card')?.remove(); return;
  }
  try{
    const list=(await API.transferts()).filter(tr=>tr.statut!=='Arrivé'&&tr.statut!=='Annulé');
    if(!list.length){ el.innerHTML=`<div style="font-size:14px;color:var(--text3)">${t('transferts_empty')}</div>`; return; }
    const scT={'En préparation':'attente','En transit':'ouvert'};
    const stTr={'En préparation':t('transferts_statut_prep'),'En transit':t('transferts_statut_transit')};
    el.innerHTML=`<div class="table-wrap"><table class="t">
      <thead><tr><th>${t('transferts_fauteuil')}</th><th>${t('transferts_depart')}</th><th>${t('transferts_arrivee')}</th><th>${t('transferts_num_suivi')}</th><th>${t('col_statut')}</th></tr></thead>
      <tbody>${list.slice(0,5).map(tr=>`<tr onclick="modalTransfert(${tr.id})" style="cursor:pointer">
        <td><div>${esc(tr.modele||'')}</div><div class="mono" style="color:var(--text3);font-size:13px">${esc(tr.serie||'')}</div></td>
        <td>${esc(tr.client_depart_nom||'—')}</td>
        <td>${esc(tr.client_arrivee_nom||'—')}</td>
        <td class="mono" style="font-size:13px">${tr.num_suivi?`${esc(tr.num_suivi)} <a href="${lienhSuiviInter(tr.transporteur,tr.num_suivi)}" target="_blank" rel="noopener" onclick="event.stopPropagation()"><i class="ti ti-external-link" style="color:var(--accent)"></i></a>`:'—'}</td>
        <td><span class="badge ${scT[tr.statut]||''}">${stTr[tr.statut]||esc(tr.statut)}</span></td>
      </tr>`).join('')}</tbody>
    </table></div>`;
  }catch(e){ el.innerHTML=`<div style="font-size:14px;color:var(--danger)">${esc(e.message)}</div>`; }
}

// ── CLIENTS ───────────────────────────────────────────────────────

// ── COMPLÉTER LES ADRESSES DES DISTRIBUTEURS ──────────────────────
// Récupère les distributeurs à adresse incomplète, propose les adresses
// VosFactures, laisse corriger à la main, puis enregistre en masse.
async function modalCompleterAdresses(){
  showModal(`<div class="modal-header"><i class="ti ti-map-pin-cog" style="font-size:20px;color:var(--accent)"></i><h2>${TR('Compléter les adresses')}</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body" style="max-width:900px">
      <div id="adr-body"><div style="color:var(--text2);font-size:15px;padding:20px 0">${TR('Analyse des distributeurs et récupération des adresses VosFactures…')}</div></div>
    </div>`);
  try {
    const r = await API.adressesIncompletes();
    window._ADR_LIGNES = r.lignes || [];
    dessinerAdresses(r);
  } catch(e) {
    const b = document.getElementById('adr-body');
    if (b) b.innerHTML = '<div style="color:var(--danger);font-size:15px">Erreur : '+esc(e.message)+'</div>';
  }
}

function dessinerAdresses(r){
  const b = document.getElementById('adr-body');
  if (!b) return;
  const lignes = window._ADR_LIGNES || [];
  if (!lignes.length) {
    b.innerHTML = '<div style="text-align:center;padding:30px 0;color:var(--text2)"><i class="ti ti-circle-check" style="font-size:34px;color:#16a34a;display:block;margin-bottom:8px"></i>'+TR("Tous les distributeurs ont déjà une adresse renseignée.")+'</div>';
    return;
  }
  const infoVF = r.configured
    ? `<span style="color:#16a34a">${r.avec_suggestion}</span> adresse(s) trouvée(s) dans VosFactures sur ${r.total} distributeur(s) à compléter.`
    : `VosFactures non configuré — saisie manuelle uniquement (${r.total} distributeur(s)).`;
  b.innerHTML = `
    <div style="font-size:14px;color:var(--text2);margin-bottom:10px">${infoVF} Vérifiez et corrigez avant d'enregistrer. Les lignes vides seront ignorées.</div>
    <div style="display:flex;gap:8px;margin-bottom:10px">
      <button class="btn sm" onclick="appliquerSuggestionsVF()"><i class="ti ti-download"></i>Reprendre toutes les adresses VosFactures</button>
      <button class="btn sm" onclick="viderAdressesSaisies()"><i class="ti ti-eraser"></i>Tout vider</button>
    </div>
    <div class="table-wrap" style="max-height:52vh;overflow:auto">
      <table class="t"><thead><tr>
        <th style="min-width:150px">${TR('Distributeur')}</th>
        <th style="min-width:200px">Adresse (rue)</th>
        <th style="width:90px">CP</th>
        <th style="min-width:130px">Ville</th>
        <th style="width:120px">VosFactures</th>
      </tr></thead>
      <tbody>${lignes.map((l,i)=>{
        const sugg = l.suggestion_dispo
          ? `<button class="btn sm" title="Reprendre : ${esc(l.vf_street)} ${esc(l.vf_post_code)} ${esc(l.vf_city)}" onclick="reprendreLigneVF(${i})"><i class="ti ti-arrow-left"></i>Reprendre</button>`
          : '<span style="font-size:13px;color:var(--text3)">—</span>';
        return `<tr>
          <td style="font-weight:600;font-size:14px">${esc(l.nom)}</td>
          <td><input class="form-input" id="adr-rue-${i}" value="${esc(l._adresse||'')}" placeholder="${l.suggestion_dispo?esc(l.vf_street):'N° et rue'}" style="padding:4px 7px;font-size:14px;width:100%"></td>
          <td><input class="form-input" id="adr-cp-${i}" value="${esc(l._cp!==undefined?l._cp:(l.cp||''))}" placeholder="${l.vf_post_code?esc(l.vf_post_code):''}" style="padding:4px 7px;font-size:14px;width:80px"></td>
          <td><input class="form-input" id="adr-ville-${i}" value="${esc(l._ville!==undefined?l._ville:(l.ville||''))}" placeholder="${l.vf_city?esc(l.vf_city):''}" style="padding:4px 7px;font-size:14px;width:100%"></td>
          <td>${sugg}</td>
        </tr>`;
      }).join('')}</tbody></table>
    </div>
    <div class="modal-footer" style="margin-top:12px">
      <button class="btn" onclick="closeModal()">${t('btn_annuler')||'Annuler'}</button>
      <button class="btn primary" onclick="enregistrerAdresses()"><i class="ti ti-check"></i>${TR('Enregistrer les adresses')}</button>
    </div>`;
}

// Reprend l'adresse VosFactures d'une seule ligne
function reprendreLigneVF(i){
  const l = (window._ADR_LIGNES||[])[i];
  if (!l) return;
  const rue = document.getElementById('adr-rue-'+i);
  const cp = document.getElementById('adr-cp-'+i);
  const ville = document.getElementById('adr-ville-'+i);
  if (rue && l.vf_street) rue.value = l.vf_street;
  if (cp && l.vf_post_code) cp.value = l.vf_post_code;
  if (ville && l.vf_city) ville.value = l.vf_city;
}
window.reprendreLigneVF = reprendreLigneVF;

// Reprend toutes les adresses VosFactures disponibles
function appliquerSuggestionsVF(){
  (window._ADR_LIGNES||[]).forEach((l,i)=>{ if (l.suggestion_dispo) reprendreLigneVF(i); });
}
window.appliquerSuggestionsVF = appliquerSuggestionsVF;

function viderAdressesSaisies(){
  (window._ADR_LIGNES||[]).forEach((l,i)=>{
    const rue = document.getElementById('adr-rue-'+i);
    if (rue) rue.value = '';
  });
}
window.viderAdressesSaisies = viderAdressesSaisies;

// Collecte les lignes où une rue a été saisie et enregistre
async function enregistrerAdresses(){
  const lignes = window._ADR_LIGNES || [];
  const aEnvoyer = [];
  lignes.forEach((l,i)=>{
    const rue = document.getElementById('adr-rue-'+i)?.value.trim();
    const cp = document.getElementById('adr-cp-'+i)?.value.trim();
    const ville = document.getElementById('adr-ville-'+i)?.value.trim();
    // On n'envoie que si une rue a été renseignée (le but de l'écran)
    if (rue) aEnvoyer.push({ id: l.id, adresse: rue, cp: cp||l.cp||null, ville: ville||l.ville||null });
  });
  if (!aEnvoyer.length) { toast(TR('Aucune adresse à enregistrer'), 'ti-alert-circle'); return; }
  if (!confirm(`Enregistrer ${aEnvoyer.length} adresse(s) ? Les points carte concernés seront repositionnés.`)) return;
  try {
    const r = await API.completerAdresses(aEnvoyer);
    closeModal();
    toast(`${r.maj} adresse(s) enregistrée(s)`, 'ti-check', 'var(--success)');
    if (r.echecs && r.echecs.length) {
      setTimeout(()=>alert(r.echecs.length+' échec(s) : '+r.echecs.map(e=>e.raison).join(', ')), 400);
    }
    render();
  } catch(e) { toast(e.message, 'ti-alert-circle', 'var(--danger)'); }
}
window.enregistrerAdresses = enregistrerAdresses;
window.modalCompleterAdresses = modalCompleterAdresses;
window.dessinerAdresses = dessinerAdresses;

async function renderClients(ttl,c,a){
  ttl.textContent=t('nav_clients');
  if(!window._clientsQ) window._clientsQ = '';
  a.innerHTML=`<div style="display:flex;gap:8px;align-items:center;justify-content:space-between;width:100%;flex-wrap:wrap">
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <input id="clients-search" class="search-bar" placeholder="${t('cat_search')||'Rechercher…'}" value="${esc(window._clientsQ)}" style="max-width:260px">
      <button class="btn primary" onclick="modalNewClient()"><i class="ti ti-plus"></i>${t('clients_new')}</button>
    </div>
    ${(typeof isAdmin==='function' && isAdmin()) ? '<button class="btn" onclick="modalCompleterAdresses()"><i class="ti ti-map-pin-cog"></i>'+TR("Compléter les adresses")+'</button>' : ''}
  </div>`;
  document.getElementById('clients-search')?.addEventListener('input', e => {
    window._clientsQ = e.target.value;
    clearTimeout(window._CLT); window._CLT = setTimeout(() => chargerListeClients(), 250);
  });
  c.innerHTML=`<div id="clients-list-body"><div style="color:var(--text2);font-size:15px;padding:20px 0">${t('msg_chargement')}</div></div>`;
  chargerListeClients();
}

let _clientsReqId = 0;
async function chargerListeClients(){
  const el = document.getElementById('clients-list-body'); if(!el) return;
  const reqId = ++_clientsReqId;
  const list = await API.clients(window._clientsQ||'');
  if(reqId !== _clientsReqId) return; // réponse périmée — une requête plus récente a pris le relais
  el.innerHTML=`<div class="table-wrap"><table class="t">
    <thead><tr>
      <th>${t('col_distributeur')}</th>
      <th>${TR('Adresse complète')}</th>
      <th>${TR('Téléphone')}</th>
      <th>${TR('Mail contact')}</th>
      <th style="text-align:center">${TR('Dernière cmd')}</th>
      <th style="text-align:center" title="${TR('Fauteuils vendus')}">${TR('Fauteuils')}</th>
      <th style="text-align:center">${TR('Interv.')}</th>
      <th style="text-align:center">${TR('Dem. infos')}</th>
      <th></th>
    </tr></thead>
    <tbody>${list.map(cl=>{
      const adr=[cl.adresse,cl.adresse2,[cl.cp,cl.ville].filter(Boolean).join(' '),cl.pays&&cl.pays!=='France'?cl.pays:''].filter(Boolean).join(', ');
      const tel=cl.tel||cl.portable||'';
      return `<tr onclick="setView('client',{clientId:${cl.id}})">
      <td><div style="font-weight:600">${esc(cl.nom)}</div><div style="font-size:13px;color:var(--text3)">${esc(cl.type)}</div></td>
      <td style="font-size:14px;color:var(--text2);max-width:260px">${adr?esc(adr):'<span style="color:var(--text3)">—</span>'}</td>
      <td style="font-size:14px">${tel?esc(fmtTel(tel)):'<span style="color:var(--text3)">—</span>'}</td>
      <td style="font-size:14px;color:var(--text2)">${cl.email?esc(cl.email):'<span style="color:var(--text3)">—</span>'}</td>
      <td style="text-align:center;font-size:14px;white-space:nowrap">${cl.derniere_commande?fd((''+cl.derniere_commande).slice(0,10)):'<span style="color:var(--text3)">—</span>'}</td>
      <td style="text-align:center;font-weight:600">${cl.nb_fauteuils_vendus||0}</td>
      <td style="text-align:center">${cl.nb_interventions||0}</td>
      <td style="text-align:center">${cl.nb_demandes_info?`<span class="badge ouvert">${cl.nb_demandes_info}</span>`:'<span style="color:var(--text3)">—</span>'}</td>
      <td><button class="btn sm" onclick="event.stopPropagation();setView('client',{clientId:${cl.id}})"><i class="ti ti-arrow-right"></i></button></td>
    </tr>`;}).join('')}</tbody>
  </table></div>`;
}

// Bloc « Fiche distributeur » — présentation pratique et lisible.
// Ordre demandé : adresse complète, téléphone, mail, contact, type, groupe,
// voir carte, OpenStreetMap, carte (si coché), EDI (si coché), annotation.
function ficheDistributeurBloc(cl){
  const nomEsc = esc(cl.nom).replace(/'/g,'&#39;');
  const lignes=[cl.adresse,cl.adresse2,[cl.cp,cl.ville].filter(Boolean).join(' '),cl.pays].filter(Boolean);
  const adrTxt=lignes.join(', ');
  const q=encodeURIComponent(adrTxt);
  const row=(icon,label,val)=>`<div style="display:flex;align-items:flex-start;gap:10px;padding:7px 0;border-bottom:0.5px solid var(--border)">
      <i class="ti ${icon}" style="font-size:17px;color:var(--accent);width:18px;text-align:center;margin-top:1px"></i>
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;text-transform:uppercase;letter-spacing:.3px;color:var(--text3);font-weight:600">${label}</div>
        <div style="font-size:15px;font-weight:500;word-break:break-word">${val}</div>
      </div>
    </div>`;
  const typeBadge=`<span style="font-size:13px;font-weight:700;padding:2px 9px;border-radius:99px;background:${cl.type==='Particulier'?'#e0e7ff;color:#3730a3':'#dcfce7;color:#166534'}">${esc(cl.type||'Distributeur')}</span>`;
  // Adresse : bloc principal mis en avant
  const adresseBloc = lignes.length
    ? `<div style="background:rgba(59,130,246,.06);border:0.5px solid var(--border);border-radius:12px;padding:11px 13px;margin-bottom:10px">
        <div style="font-size:12px;text-transform:uppercase;letter-spacing:.3px;color:var(--text3);font-weight:600;margin-bottom:3px"><i class="ti ti-map-pin" style="font-size:14px"></i> ${TR('Adresse complète')}</div>
        <div style="font-size:15px;font-weight:600;line-height:1.5">${lignes.map(l=>esc(l)).join('<br>')}</div>
        <div style="margin-top:7px;display:flex;gap:12px;flex-wrap:wrap;font-size:13px">
          <span onclick="voirDistributeurSurCarte(${cl.id},'${nomEsc}')" style="color:var(--accent);cursor:pointer;font-weight:600"><i class="ti ti-map-pin" style="font-size:14px"></i> ${TR("Voir sur la carte")}</span>
          <a href="https://www.openstreetmap.org/search?query=${q}" target="_blank" rel="noopener" style="color:var(--text3);text-decoration:none"><i class="ti ti-external-link" style="font-size:14px"></i> OpenStreetMap</a>
          <span onclick="copierAdresse(this,'${esc(adrTxt).replace(/'/g,'&#39;')}')" style="color:var(--text3);cursor:pointer"><i class="ti ti-copy" style="font-size:14px"></i> ${TR("Copier")}</span>
        </div>
      </div>`
    : `<div style="background:rgba(245,158,11,.08);border:0.5px solid var(--border);border-radius:12px;padding:11px 13px;margin-bottom:10px;font-size:14px;color:var(--text2)">
        <i class="ti ti-map-pin-off" style="font-size:15px"></i> ${TR('Adresse')} — ${TR('(à compléter)')}</div>`;
  // Chips d'état : carte (si coché), EDI (si coché), site public, priorité, facturation
  const chips=[];
  if(cl.sur_carte) chips.push(`<span class="badge ouvert" style="cursor:pointer" onclick="voirDistributeurSurCarte(${cl.id},'${nomEsc}')" title="${TR('Affiché sur la carte distributeurs')}"><i class="ti ti-map-2"></i> ${TR('Sur la carte distributeurs')}</span>`);
  if(cl.edi) chips.push(`<span class="badge ouvert" title="${TR('Prélèvement EDI')}"><i class="ti ti-credit-card"></i> ${TR('EDI — Prélèvement')}</span>`);
  if(cl.public_site) chips.push(`<span class="badge hg" title="Visible sur la carte publique eloflex.fr"><i class="ti ti-world"></i> ${TR('Site public')}</span>`);
  if(cl.priorite) chips.push(`<span style="font-size:13px;font-weight:700;color:#fff;background:${({T1:'#dc2626',T2:'#d97706',T3:'#65a30d'})[cl.priorite]||'#888'};padding:2px 8px;border-radius:99px">${TR('Priorité')} ${cl.priorite}</span>`);
  if(cl.entite_facturation_id) chips.push(`<span class="badge ouvert"><i class="ti ti-receipt"></i> ${TR('Facturé à')} ${esc(cl.entite_facturation_nom||'—')}</span>`);
  const annEsc = cl.annotation ? esc(cl.annotation) : '';
  return `<div class="card">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px">
      <div class="section-title" style="margin:0"><i class="ti ti-building-store"></i>${TR("Fiche distributeur")}</div>
      ${typeBadge}
    </div>
    ${adresseBloc}
    <div>
      ${row('ti-phone', TR('Téléphone'), cl.tel?`<a href="tel:${esc(telHref(cl.tel))}" style="color:inherit;text-decoration:none">${esc(fmtTel(cl.tel))}</a>`:'<span style="color:var(--text3)">—</span>')}
      ${cl.portable?row('ti-device-mobile', TR('Portable'), `<a href="tel:${esc(telHref(cl.portable))}" style="color:inherit;text-decoration:none">${esc(fmtTel(cl.portable))}</a>`):''}
      ${row('ti-mail', TR('Mail'), cl.email?`<a href="mailto:${esc(cl.email)}" style="color:var(--accent);text-decoration:none">${esc(cl.email)}</a>`:'<span style="color:var(--text3)">—</span>')}
      ${row('ti-user', TR('Personne de contact'), cl.contact?esc(cl.contact):'<span style="color:var(--text3)">—</span>')}
      ${row('ti-users-group', TR("Groupe d'appartenance"), cl.reseau_carte?esc(cl.reseau_carte):'<span style="color:var(--text3)">—</span>')}
    </div>
    ${chips.length?`<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:11px">${chips.join('')}</div>`:''}
    <div style="margin-top:12px;background:rgba(250,204,21,.08);border:0.5px solid var(--border);border-radius:12px;padding:10px 12px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px">
        <div style="font-size:12px;text-transform:uppercase;letter-spacing:.3px;color:var(--text3);font-weight:700"><i class="ti ti-note" style="font-size:14px"></i> ${TR('Annotation — information spécifique')}</div>
        <button class="btn sm" id="annot-save-${cl.id}" onclick="saveAnnotationDistrib(${cl.id})" style="display:none"><i class="ti ti-check"></i>${TR('Enregistrer')}</button>
      </div>
      <textarea id="annot-${cl.id}" class="form-input" rows="2" placeholder="${TR('Note libre sur ce distributeur…')}" style="width:100%;font-size:15px;resize:vertical" oninput="document.getElementById('annot-save-${cl.id}').style.display='inline-flex'">${annEsc}</textarea>
    </div>
    <div style="margin-top:10px;display:flex;gap:6px">
      <button class="btn sm" onclick="modalEditClient(${cl.id})"><i class="ti ti-edit"></i>${t('btn_modifier')}</button>
      <button class="btn sm" onclick="modalFusionnerClient(${cl.id})"><i class="ti ti-git-merge"></i>${TR('Fusionner')}</button>
    </div>
  </div>`;
}

async function saveAnnotationDistrib(id){
  const ta=document.getElementById('annot-'+id); if(!ta) return;
  const btn=document.getElementById('annot-save-'+id);
  try{
    if(btn){ btn.disabled=true; btn.innerHTML='<i class="ti ti-loader-2"></i>'; }
    await API.put(`/clients/${id}/annotation`, { annotation: ta.value });
    if(btn){ btn.innerHTML='<i class="ti ti-check"></i>'+TR('Enregistré'); btn.style.display='none'; }
    toast&&toast(TR('Annotation enregistrée'));
  }catch(e){
    if(btn){ btn.disabled=false; btn.innerHTML='<i class="ti ti-check"></i>'+TR('Enregistrer'); }
    alert('Erreur : '+e.message);
  }
}
window.saveAnnotationDistrib=saveAnnotationDistrib;

async function renderClient(ttl,c,a){
  const cl=await API.client(STATE.clientId);
  ttl.textContent=cl.nom;
  a.innerHTML=`
    <button class="btn sm success" onclick="exportClientPDF(${cl.id})"><i class="ti ti-file-type-pdf"></i>PDF</button>
    <button class="btn sm" onclick="modalPortail(${cl.id},'${cl.token_portail||''}')"><i class="ti ti-link"></i>Portail</button>
    <button class="btn sm" onclick="modalNewFauteuil(${cl.id})"><i class="ti ti-plus"></i>${TR('Fauteuil')}</button>
    <button class="btn sm" onclick="modalPret(null,${cl.id})"><i class="ti ti-file-certificate"></i>${TR('Bon de prêt')}</button>
    ${cl.type!=='Particulier'?`<button class="btn sm" onclick="modalContrat(${cl.id})"><i class="ti ti-file-description"></i>${TR('Contrat-cadre')}</button>`:''}
    <button class="btn sm primary" onclick="modalNewIntervention(null,${cl.id})"><i class="ti ti-plus"></i>Intervention</button>`;
  const s=cl.stats||{};
  c.innerHTML=`
    <div class="breadcrumb"><span onclick="setView('clients')">Clients</span><i class="ti ti-chevron-right" style="font-size:13px"></i>${esc(cl.nom)}</div>
    <div class="grid-2" style="margin-bottom:12px">
      ${ficheDistributeurBloc(cl)}
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
            <div style="font-weight:700;font-size:15px"><i class="ti ti-wheelchair" style="font-size:15px;margin-right:3px"></i>${esc(f.modele)}</div>
            <button class="btn sm" onclick="event.stopPropagation();exportFauteuilPDF(${f.id})"><i class="ti ti-file-type-pdf"></i></button>
          </div>
          <div style="font-size:13px;color:var(--text3)">${TR('Série :')} <span class="mono">${esc(f.serie)}</span></div>
          <div style="font-size:13px;color:var(--text3)">Année : ${f.annee||'—'}</div>
          ${f.date_achat?`<div style="font-size:13px;color:var(--text3)">Achat : ${fd(f.date_achat)}</div>`:''}
          ${f.num_facture?`<div style="font-size:13px;margin:3px 0;display:flex;align-items:center;gap:4px"><i class="ti ti-receipt" style="font-size:14px;color:var(--accent)"></i><span style="color:var(--accent)" class="mono">${esc(f.num_facture)}</span></div>`:''}
          <div style="margin-top:6px">${garantieChip(f)}</div>
          <div style="display:flex;gap:5px;margin-top:6px">
            <span class="badge g">${f.nb_garantie||0} garantie</span>
            <span class="badge hg">${(f.nb_interventions||0)-(f.nb_garantie||0)} HG</span>
          </div>
        </div>`).join('')}
    </div>
    <div class="section-title" style="margin:16px 0 8px"><i class="ti ti-clipboard-list"></i>Commandes</div>
    <div id="client-commandes-list" style="margin-bottom:20px"><div style="font-size:14px;color:var(--text2)"><i class="ti ti-loader-2"></i> ${TR("Chargement…")}</div></div>
    ${cl.type!=='Particulier'?`<div id="client-demandes" data-client="${cl.id}" data-nom="${esc(cl.nom)}" data-email="${esc(cl.email||'')}" style="margin-bottom:20px"></div>`:''}`;
  chargerCommandesClient(cl.id);
  if(cl.type!=='Particulier') chargerDemandesFiche(cl.id);
}

async function chargerCommandesClient(clientId){
  const el = document.getElementById('client-commandes-list'); if(!el) return;
  try{
    // Filtrage par client_id EXACT (et non par nom) : plusieurs agences partagent le même
    // nom générique (ex. « BASTIDE LE CONFORT MEDICAL » pour Nantes, Poitiers…) → un filtre
    // par nom ramasserait les commandes de toutes les agences. Le client_id isole la bonne fiche.
    const res = await API.commandes({ client_id: clientId, per_page: 200 });
    const list = res.rows||[];
    if(!list.length){
      el.innerHTML=`<div style="font-size:14px;color:var(--text3)">${TR('Aucune commande pour ce distributeur.')}</div>`;
      return;
    }
    el.innerHTML=`<div class="table-wrap"><table class="t">
      <thead><tr>
        ${CMD_COLS.num_annuel?'<th style="width:40px;text-align:center;color:var(--text3)">#</th>':''}
        <th>${t('col_date')||'Date'}</th>
        <th>${t('cmd_bdc')||'Bdc'}</th>
        <th>${t('cmd_modele')||'Modèle / Pièce'}</th>
        <th>${t('cmd_suivi')||'N° suivi'}</th>
        <th>${TR('N° série')}</th>
        <th>${t('col_statut')||'Statut'}</th>
      </tr></thead>
      <tbody>${list.map(cm=>{
        const lien = lienSuiviColis(cm.transporteur, cm.num_suivi);
        return `<tr onclick="modalCommande(${cm.id})" style="cursor:pointer">
          ${CMD_COLS.num_annuel?`<td style="text-align:center;font-size:13px;color:var(--text3);font-weight:600">${cm.num_annuel||''}</td>`:''}
        <td>${fd(cm.date_commande)}</td>
          <td class="mono">${esc(cm.bdc||'')}${cm.num_commande_distrib?` <span style="color:var(--text3);font-size:13px">(${esc(cm.num_commande_distrib)})</span>`:''}</td>
          <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(cm.modele||(cm.accessoire||'').split('\n')[0]||'')}${cm.modele_demo?` <span class="badge hg" style="font-size:12px">🔄 ${t('cmd_demo_badge')||'Démo'}</span>`:''}</td>
          <td class="mono">${esc(cm.num_suivi||'')}${lien?` <a href="${lien}" target="_blank" rel="noopener" onclick="event.stopPropagation()"><i class="ti ti-external-link" style="color:var(--accent)"></i></a>`:''}</td>
          <td class="mono">${esc(cm.num_serie||'')}</td>
          <td><span class="badge ${cmdStatutClass(cm.statut_calc)}">${esc(tStatut(cm.statut_calc))}</span>${cm.reliquat?` <i class="ti ti-clock-exclamation" style="color:var(--warning)" title="Reliquat"></i>`:''}${cm.informations?` <i class="ti ti-info-circle" style="color:var(--accent)" title="${esc(cm.informations)}"></i>`:''}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;
  }catch(e){ el.innerHTML=`<div style="font-size:14px;color:var(--danger)">${esc(e.message)}</div>`; }
}

function garantieChip(f){
  if(!f.date_achat||!f.duree_garantie_mois) return '<span class="garantie-chip unknown">Garantie inconnue</span>';
  if(f.garantie_active===true||f.garantie_active===null){
    const exp=new Date(f.date_achat); exp.setMonth(exp.getMonth()+(f.duree_garantie_mois||24));
    const j=Math.ceil((exp-new Date())/86400000);
    if(f.garantie_active===null||j>0) return `<span class="garantie-chip active"><i class="ti ti-shield-check" style="font-size:14px"></i>Garantie active (${j>0?j+' j':fd(exp.toISOString().slice(0,10))})</span>`;
  }
  const exp=new Date(f.date_achat); exp.setMonth(exp.getMonth()+(f.duree_garantie_mois||24));
  return `<span class="garantie-chip expired"><i class="ti ti-shield-x" style="font-size:14px"></i>Garantie expirée le ${fd(exp.toISOString().slice(0,10))}</span>`;
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
      <i class="ti ti-chevron-right" style="font-size:13px"></i>
      <span ${f.client_id?`onclick="setView('client',{clientId:${f.client_id}})"`:''}>${esc(f.client_nom||'—')}</span>
      <i class="ti ti-chevron-right" style="font-size:13px"></i>${esc(f.modele)}
    </div>
    <div class="grid-2" style="margin-bottom:12px">
      <div class="card">
        <div class="section-title"><i class="ti ti-wheelchair"></i>${TR('Fauteuil')}</div>
        <table style="width:100%;font-size:14px">
          ${[['Modèle',f.modele],['N° de série',f.serie],['Année',f.annee],['Couleur',f.couleur]].map(([k,v])=>`<tr><td style="color:var(--text3);padding:3px 0;width:110px">${k}</td><td style="font-weight:500">${esc(String(v||'—'))}</td></tr>`).join('')}
          ${f.date_achat?`<tr><td style="color:var(--text3);padding:3px 0">Date d'achat</td><td>${fd(f.date_achat)}</td></tr>`:''}
          ${f.num_facture?`<tr><td style="color:var(--text3);padding:3px 0">${TR('Facture')}</td><td><span class="mono" style="color:var(--accent)">${esc(f.num_facture)}</span></td></tr>`:''}
          <tr><td style="color:var(--text3);padding:3px 0">Garantie</td><td>${garantieChip(f)}</td></tr>
        </table>
      </div>
      <div class="card">
        <div class="section-title"><i class="ti ti-chart-bar"></i>${TR('Historique SAV')}</div>
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
            <span style="font-weight:700;font-size:15px">${traduireType(i.type)}</span>
            <span class="badge ${i.garantie?'g':'hg'}">${i.garantie?t('badge_garantie'):t('garantie_expiree')}</span>
            <span class="badge ${sc(i.statut)}">${traduireStatut(i.statut)}</span>
            <span style="margin-left:auto;font-size:13px;color:var(--text3)">${fd(i.date)}</span>
          </div>
          <div style="font-size:14px;color:var(--text2)">${esc(i.description||'')}</div>
          <div style="font-size:13px;color:var(--text3);margin-top:3px;display:flex;gap:10px;flex-wrap:wrap">
            <span>${i.produits?.length||0} pièce${(i.produits?.length||0)!==1?'s':''}</span>
            ${i.nb_photos?`<span><i class="ti ti-photo" style="font-size:13px"></i> ${i.nb_photos} photo${i.nb_photos>1?'s':''}</span>`:''}
            ${i.nb_commentaires?`<span><i class="ti ti-message" style="font-size:13px"></i> ${i.nb_commentaires}</span>`:''}
            ${i.envoi_numero?`<span><i class="ti ti-send" style="font-size:13px"></i> ${esc(i.envoi_numero)}</span>`:''}
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
      <td class="mono" style="color:var(--accent);font-size:13px">${esc(i.num_sav||'—')}</td><td>${fd(i.date)}</td><td>${esc(i.client_nom||'')}</td>
      <td><div>${esc(i.modele)}</div><div class="mono" style="color:var(--text3)">${esc(i.serie)}</div></td>
      <td>${esc(traduireType(i.type))}</td>
      <td style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(i.description||'')}</td>
      <td><span class="badge ${i.garantie?'g':'hg'}">${i.garantie?t('badge_garantie'):t('garantie_expiree')}</span></td>
      <td><span class="badge ${sc(i.statut)}">${traduireStatut(i.statut)}</span></td>
      <td>${esc(i.technicien||'')}</td>
      <td style="text-align:center;color:var(--text3);font-size:13px">${i.nb_photos||''}</td>
      <td style="font-size:13px">${esc(i.envoi_transporteur||'—')}</td>
      <td style="font-size:13px">
        ${i.envoi_numero
          ? `<a href="${lienhSuiviInter(i.envoi_transporteur, i.envoi_numero)}" target="_blank" rel="noopener"
               style="color:var(--accent);font-family:monospace;text-decoration:none" title="Suivre le colis">
               <i class="ti ti-external-link" style="font-size:12px"></i> ${esc(i.envoi_numero)}
             </a>`
          : '—'}
      </td>
      <td style="font-size:13px">${i.envoi_date ? fd(i.envoi_date) : '—'}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

// ── EXPÉDITIONS ───────────────────────────────────────────────────

async function renderExpeditions(ttl,c,a){
  ttl.textContent=t('exp_title');
  a.innerHTML=`<button class="btn success" onclick="API.exportExcel('expeditions')"><i class="ti ti-file-spreadsheet"></i>${t('rap_export_excel')}</button>`;
  const list=await API.expeditions();
  c.innerHTML=`
    <div style="font-size:14px;color:var(--text2);margin-bottom:12px">${t('exp_subtitle')}</div>
    ${list.length===0?`<div class="empty"><i class="ti ti-truck-delivery"></i>${t('exp_empty')}</div>`:`
    <div class="table-wrap"><table class="t">
      <thead><tr><th>N°</th><th>${t('col_client')}</th><th>${t('inter_fauteuil').replace(' *','')}</th><th>${t('col_transporteur')||'Transporteur'}</th><th>${t('col_suivi')||'N° Suivi'}</th><th>${t('col_date_envoi')||'Date envoi'}</th></tr></thead>
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
const cmdStatutClass = s => s==='Payé'?'g':s==='Livré'?'g':s==='Facturé'?'facture':s==='Impayé'?'urgent':s==='Expédié'?'attente':s==='Problème'?'urgent':s==='Annulé'?'hg':s==='Avoir'?'hg':s==='En attente confirmation'?'ouvert':'ouvert';
// Commande contenant un fauteuil roulant (vs pièces détachées uniquement)
const estCmdFauteuil = cm => !!(cm.type_fauteuil_neuf || cm.type_fauteuil_demo || cm.commande_type==='fauteuil' || /eloflex/i.test(cm.modele||''));

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
    'Avoir':          t('cmd_avoir_statut')||'Avoir',
    'Problème':       t('cmd_probleme')||'Problème',
    'Annulé':         t('cmd_annule')||'Annulé',
  };
  return map[s] || s;
}

let TMP_CMD_LIGNES = []; // Lignes de la commande en cours d'édition

function renderCmdLignes(){
  const el=$('cmd-lignes-list'); if(!el) return;
  if(!TMP_CMD_LIGNES.length){
    el.innerHTML=`<div style="font-size:14px;color:var(--text3);padding:8px 0">${t('cmd_lignes_empty')||'Aucune ligne — importe un BDC ou ajoute une ligne manuellement.'}</div>`;
    return;
  }
  el.innerHTML=`<table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:4px">
    <thead><tr style="background:var(--bg)">
      <th style="padding:5px 8px;text-align:left;color:var(--text2);font-weight:600">${t('col_designation_court')||'Désignation'}</th>
      <th style="padding:5px 8px;text-align:left;color:var(--text2);font-weight:600;width:130px">${t('col_ref_short')||'Référence'}</th>
      <th style="padding:5px 8px;text-align:center;color:var(--text2);font-weight:600;width:60px">${t('col_qte')||'Qté'}</th>
      <th style="width:32px"></th>
    </tr></thead>
    <tbody>${TMP_CMD_LIGNES.map((l,i)=>`<tr style="${i%2===0?'background:var(--surface)':'background:var(--bg)'}">
      <td style="padding:4px 6px">
        <div style="position:relative">
          <input class="form-input cmd-ligne-search" style="font-size:14px;padding:4px 7px"
            value="${esc(l.designation)}"
            placeholder="${t('cat_search_catalogue')||'Taper nom ou référence catalogue…'}"
            oninput="TMP_CMD_LIGNES[${i}].designation=this.value;searchCmdPieces(${i},this.value)"
            onfocus="searchCmdPieces(${i},this.value)"
            onblur="setTimeout(()=>{const d=document.getElementById('cmd-piece-drop-${i}');if(d)d.style.display='none'},150)">
          <div id="cmd-piece-drop-${i}" class="piece-dropdown" style="display:none"></div>
        </div>
      </td>
      <td style="padding:4px 6px">
        <div style="position:relative">
          <input class="form-input mono cmd-ligne-ref" style="font-size:13px;padding:4px 7px" value="${esc(l.reference||'')}" placeholder="${TR("Réf.")}"
            oninput="TMP_CMD_LIGNES[${i}].reference=this.value;searchCmdPieces(${i},this.value,'ref')"
            onfocus="searchCmdPieces(${i},this.value,'ref')"
            onblur="setTimeout(()=>{const d=document.getElementById('cmd-piece-drop-ref-${i}');if(d)d.style.display='none'},150)">
          <div id="cmd-piece-drop-ref-${i}" class="piece-dropdown" style="display:none"></div>
        </div>
      </td>
      <td style="padding:4px 6px"><input class="form-input" type="number" min="1" style="font-size:14px;padding:4px 7px;text-align:center" value="${l.quantite||1}" oninput="TMP_CMD_LIGNES[${i}].quantite=parseInt(this.value)||1"></td>
      <td style="padding:4px 2px"><button class="btn sm danger" onclick="removeCmdLigne(${i})" style="padding:4px 6px"><i class="ti ti-x"></i></button></td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function searchCmdPieces(idx, q, field){
  field = field==='ref' ? 'ref' : 'desig';
  const dropId = field==='ref' ? 'cmd-piece-drop-ref-'+idx : 'cmd-piece-drop-'+idx;
  const drop = document.getElementById(dropId); if(!drop) return;
  const query = (q||'').toLowerCase().trim();
  if(!query){ drop.style.display='none'; return; }
  // Depuis le champ Référence : on privilégie une correspondance sur la réf ; sinon on cherche partout
  let results = CACHE.catalogue.filter(p =>
    p.designation.toLowerCase().includes(query) ||
    (p.ref && p.ref.toLowerCase().includes(query)) ||
    (p.ref_fournisseur && p.ref_fournisseur.toLowerCase().includes(query))
  );
  if(field==='ref'){
    results.sort((a,b)=>{
      const ar=(a.ref||'').toLowerCase().startsWith(query)?0:1;
      const br=(b.ref||'').toLowerCase().startsWith(query)?0:1;
      return ar-br;
    });
  }
  results = results.slice(0,12);
  if(!results.length){ drop.style.display='none'; return; }
  window._CMD_PIECE_RESULTS = window._CMD_PIECE_RESULTS || {};
  window._CMD_PIECE_RESULTS[field+'-'+idx] = results;
  drop.innerHTML = results.map((p,ri) => `<div class="piece-option" onmousedown="event.preventDefault();selectCmdPieceResult(${idx},${ri},'${field}')">
    <div style="font-size:14px;font-weight:600">${esc(p.designation)}</div>
    <div style="font-size:13px;color:var(--text3);display:flex;gap:8px"><span class="mono">${esc(p.ref||'')}</span></div>
  </div>`).join('');
  drop.style.display = 'block';
}

function selectCmdPieceResult(idx, resultIdx, field){
  field = field==='ref' ? 'ref' : 'desig';
  const store = window._CMD_PIECE_RESULTS || {};
  const p = store[field+'-'+idx] ? store[field+'-'+idx][resultIdx] : null;
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
    <button class="btn" onclick="syncCommandesVF()"><i class="ti ti-refresh"></i>${t('cmd_sync_vf')||'Synchroniser VosFactures'}</button>`;

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
      <div class="stat-card"><div class="stat-label">${TR('En prép.')}</div><div class="stat-value" style="color:var(--danger)">${stats.en_preparation}</div></div>
      <div class="stat-card"><div class="stat-label">${TR('Expédié')}</div><div class="stat-value" style="color:var(--warning)">${stats.expedie}</div></div>
      <div class="stat-card"><div class="stat-label">${TR('Livré')}</div><div class="stat-value" style="color:var(--success)">${stats.livre}</div></div>
      <div class="stat-card"><div class="stat-label">${TR('Facturé')}</div><div class="stat-value" style="color:var(--accent)">${stats.facture||0}</div></div>
      <div class="stat-card" style="cursor:pointer${stats.impaye>0?';animation:pulse-danger 2s infinite':''}" onclick="STATE.view='commandes';CMD_FILTERS.statut='Impayé';render()" title="${TR("Voir les commandes impayées")}"><div class="stat-label" style="color:var(--danger)">${TR('⚠️ Impayés')}</div><div class="stat-value" style="color:var(--danger)">${stats.impaye||0}</div></div>
      <div class="stat-card"><div class="stat-label">${TR('🔄 Démos')}</div><div class="stat-value" style="color:var(--warning)">${stats.demo||0}</div></div>
      <div class="stat-card"><div class="stat-label">${TR('Problème')}</div><div class="stat-value" style="color:${stats.probleme>0?'var(--danger)':'var(--text)'}">${stats.probleme}</div></div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;align-items:center">
      <button class="btn" id="btn-kanban-toggle" onclick="CMD_VIEW=CMD_VIEW==='liste'?'kanban':'liste';renderCommandesView()" title="Basculer liste / Kanban">
        <i class="ti ${CMD_VIEW==='kanban'?'ti-list':'ti-layout-kanban'}"></i> ${CMD_VIEW==='kanban'?'Liste':'Kanban'}
      </button>
      <button class="btn primary" onclick="modalNouvelleCommande()"><i class="ti ti-plus"></i>${t('cmd_add')||'Nouvelle commande'}</button>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;align-items:center">
      <input class="form-input" style="max-width:240px;padding:10px 12px;font-size:16px" placeholder="${t('cmd_search')||'Rechercher (distributeur, bdc, série...)'}" value="${esc(CMD_FILTERS.q)}" oninput="CMD_FILTERS.q=this.value;clearTimeout(window._cmdSearchTimer);window._cmdSearchTimer=setTimeout(()=>renderCommandesTable(1),300)">
      <select class="form-input" style="width:auto;padding:10px 12px;font-size:16px" id="cmd-f-type" onchange="CMD_FILTERS.type=this.value;renderCommandesTable(1)">
        <option value="" ${!CMD_FILTERS.type?'selected':''}>${TR('Toutes les commandes')}</option>
        <option value="fauteuil" ${CMD_FILTERS.type==='fauteuil'?'selected':''}>♿ ${TR('Fauteuils')}</option>
        <option value="accessoire" ${CMD_FILTERS.type==='accessoire'?'selected':''}>📦 ${TR('Accessoires')}</option>
      </select>
      <select class="form-input" style="width:auto;padding:10px 12px;font-size:16px" id="cmd-f-annee" onchange="CMD_FILTERS.annee=this.value;CMD_FILTERS.mois='';render()">
        <option value="">${t('cmd_toutes_annees')||'Toutes années'}</option>
        ${years.map(y=>`<option value="${y}" ${CMD_FILTERS.annee==y?'selected':''}>${y}</option>`).join('')}
      </select>
      <select class="form-input" style="width:auto;padding:10px 12px;font-size:16px" id="cmd-f-mois" onchange="CMD_FILTERS.mois=this.value;renderCommandesTable(1)">
        <option value="">Tous les mois</option>
        ${['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'].map((m,i)=>`<option value="${i+1}" ${CMD_FILTERS.mois==i+1?'selected':''}>${m}</option>`).join('')}
      </select>
      <select class="form-input" style="width:auto;padding:10px 12px;font-size:16px" id="cmd-f-statut" onchange="CMD_FILTERS.statut=this.value;renderCommandesTable(1)">
        <option value="">${t('cmd_tous_statuts')||'Tous statuts'}</option>
        <option value="En attente confirmation" ${CMD_FILTERS.statut==='En attente confirmation'?'selected':''}>⏳ ${t('cmd_en_attente')||'En attente'}</option>
        <option value="En préparation" ${CMD_FILTERS.statut==='En préparation'?'selected':''}>${t('cmd_en_prep')||'En préparation'}</option>
        <option value="Expédié" ${CMD_FILTERS.statut==='Expédié'?'selected':''}>${t('cmd_expedie')||'Expédié'}</option>
        <option value="Livré" ${CMD_FILTERS.statut==='Livré'?'selected':''}>${t('cmd_livre')||'Livré'}</option>
        <option value="Facturé" ${CMD_FILTERS.statut==='Facturé'?'selected':''}>${t('cmd_facture_statut')||'Facturé'}</option>
        <option value="Payé" ${CMD_FILTERS.statut==='Payé'?'selected':''}>${TR('✅ Payé')}</option>
        <option value="Impayé" ${CMD_FILTERS.statut==='Impayé'?'selected':''}>${TR('⚠️ Impayé')}</option>
        <option value="Avoir" ${CMD_FILTERS.statut==='Avoir'?'selected':''}>${t('cmd_avoir_statut')||'Avoir'}</option>
        <option value="Problème" ${CMD_FILTERS.statut==='Problème'?'selected':''}>${t('cmd_probleme')||'Problème'}</option>
        <option value="Annulé" ${CMD_FILTERS.statut==='Annulé'?'selected':''}>${t('cmd_annule')||'Annulé'}</option>
      </select>
      <input class="form-input" style="width:auto;max-width:180px;padding:10px 12px;font-size:16px" id="cmd-f-distrib" placeholder="${t('cmd_filtre_distrib')||'Filtrer distributeur'}" value="${esc(CMD_FILTERS.distributeur)}" oninput="CMD_FILTERS.distributeur=this.value;renderCommandesTable(1)">
      <button class="btn sm" onclick="toggleColsPanel()" title="Colonnes visibles"><i class="ti ti-layout-columns"></i></button>
      ${CMD_FILTERS.distributeur||CMD_FILTERS.statut||CMD_FILTERS.q||CMD_FILTERS.mois||CMD_FILTERS.type
        ? `<button class="btn sm" onclick="CMD_FILTERS={annee:CMD_FILTERS.annee,mois:'',statut:'',groupe:'',distributeur:'',q:'',type:''};render()" title="Effacer filtres"><i class="ti ti-x"></i></button>`:''}
    </div>
    <div id="cmd-cols-panel" style="display:none;padding:10px 14px;margin-bottom:8px;background:rgba(255,255,255,.55);border:0.5px solid var(--border);border-radius:var(--radius);backdrop-filter:blur(12px)">
      <div style="font-size:13px;font-weight:700;color:var(--text2);margin-bottom:8px;text-transform:uppercase">Colonnes optionnelles</div>
      <div style="display:flex;gap:16px;flex-wrap:wrap">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:15px"><input type="checkbox" ${CMD_COLS.num_annuel?'checked':''} onchange="CMD_COLS.num_annuel=this.checked;saveCmdCols();renderCommandesTable(1)"> # N° annuel</label>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:15px"><input type="checkbox" ${CMD_COLS.paiement?'checked':''} onchange="CMD_COLS.paiement=this.checked;saveCmdCols();renderCommandesTable(1)"> 💳 Paiement VF</label>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:15px"><input type="checkbox" ${CMD_COLS.facture?'checked':''} onchange="CMD_COLS.facture=this.checked;saveCmdCols();renderCommandesTable(1)"> ${TR('N° Facture')}</label>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:15px"><input type="checkbox" ${CMD_COLS.date_facture?'checked':''} onchange="CMD_COLS.date_facture=this.checked;saveCmdCols();renderCommandesTable(1)"> Date facturation</label>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:15px"><input type="checkbox" ${CMD_COLS.demo_origine?'checked':''} onchange="CMD_COLS.demo_origine=this.checked;saveCmdCols();renderCommandesTable(1)"> ${TR('🔄 Origine démo')}</label>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:15px"><input type="checkbox" ${CMD_COLS.edi?'checked':''} onchange="CMD_COLS.edi=this.checked;saveCmdCols();renderCommandesTable(1)"> ${TR('💳 EDI (prélèvement)')}</label>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:15px"><input type="checkbox" ${CMD_COLS.pays?'checked':''} onchange="CMD_COLS.pays=this.checked;saveCmdCols();renderCommandesTable(1)"> 🌍 Pays</label>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:15px"><input type="checkbox" ${CMD_COLS.retour?'checked':''} onchange="CMD_COLS.retour=this.checked;saveCmdCols();renderCommandesTable(1)"> ${TR('↩ Retour')}</label>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:15px"><input type="checkbox" ${CMD_COLS.date_retour?'checked':''} onchange="CMD_COLS.date_retour=this.checked;saveCmdCols();renderCommandesTable(1)"> ${TR("📅 Date retour")}</label>
      </div>
    </div>
      ${CMD_FILTERS.distributeur
        ? `<span style="display:flex;align-items:center;gap:5px;padding:4px 10px;background:var(--accent-bg);border:0.5px solid var(--accent);border-radius:var(--radius);font-size:14px;color:var(--accent);font-weight:600">
            <i class="ti ti-building-store" style="font-size:14px"></i>
            ${esc(CMD_FILTERS.distributeur)}
            <button onclick="CMD_FILTERS.distributeur='';renderCommandesTable(1)" style="background:none;border:none;cursor:pointer;color:var(--accent);padding:0;line-height:1;font-size:16px" title="Retirer ce filtre">×</button>
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
    annee: CMD_FILTERS.annee, mois: CMD_FILTERS.mois, statut: CMD_FILTERS.statut,
    distributeur: CMD_FILTERS.distributeur, q: CMD_FILTERS.q, type: CMD_FILTERS.type,
    per_page: PER_PAGE, page
  });
  const list = res.rows||[];
  const total = res.total || list.length;
  const nbPages = Math.ceil(total / PER_PAGE);

  if(!list.length){ wrap.innerHTML=`<div class="empty"><i class="ti ti-clipboard-list"></i>${t('cmd_empty')||'Aucune commande trouvée'}</div>`; return; }

  // Navigation pagination
  const nav = nbPages > 1 ? `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;padding:8px 14px;background:rgba(255,255,255,.55);border:0.5px solid var(--border);border-radius:12px;backdrop-filter:blur(8px);font-size:15px">
      <button class="btn sm" ${page<=1?'disabled':''} onclick="renderCommandesTable(1)" title="${TR("Première page")}"><i class="ti ti-chevron-left-pipe"></i></button>
      <button class="btn sm" ${page<=1?'disabled':''} onclick="renderCommandesTable(${page-1})"><i class="ti ti-chevron-left"></i></button>
      <span style="color:var(--text2);display:flex;align-items:center;gap:6px">
        Page <b>${page}</b> /
        <input type="number" min="1" max="${nbPages}" value="${page}"
          style="width:52px;padding:3px 6px;border:0.5px solid var(--border-dark);border-radius:6px;background:rgba(255,255,255,.7);font-size:14px;font-weight:600;text-align:center;color:var(--text)"
          onkeydown="if(event.key==='Enter'){const p=parseInt(this.value);if(p>=1&&p<=${nbPages})renderCommandesTable(p);}"
          onblur="const p=parseInt(this.value);if(p>=1&&p<=${nbPages})renderCommandesTable(p);"
          onclick="this.select()">
        <b>${nbPages}</b>
      </span>
      <button class="btn sm" ${page>=nbPages?'disabled':''} onclick="renderCommandesTable(${page+1})"><i class="ti ti-chevron-right"></i></button>
      <button class="btn sm" ${page>=nbPages?'disabled':''} onclick="renderCommandesTable(${nbPages})" title="${TR("Dernière page")}"><i class="ti ti-chevron-right-pipe"></i></button>
      <span style="color:var(--text3);font-size:14px">${total} résultat(s)</span>
    </div>` : `<div style="font-size:14px;color:var(--text2);margin-bottom:8px">${total} ${t('cmd_resultats')||'résultat(s)'}</div>`;

  wrap.innerHTML=`${nav}
    <div class="table-wrap"><table class="t">
      <thead><tr>
        ${CMD_COLS.num_annuel?'<th style="width:40px;text-align:center;color:var(--text3)">#</th>':''}
        <th>${t('col_date')||'Date'}</th><th style="width:75px">Groupe</th>
        ${CMD_COLS.pays&&!CURRENT_USER.pays?'<th style="width:80px">Pays</th>':''}
        <th>${t('col_client')||'Distributeur'}</th>
        <th>${t('cmd_bdc')||'Bdc'}</th><th style="width:30px;text-align:center" title="${TR("Type : fauteuil roulant ou pièces détachées")}"><i class="ti ti-wheelchair"></i></th><th>Articles</th>
        <th>${t('cmd_suivi')||'N° suivi'}</th><th>${TR("Date livraison")}</th><th>${t('cmd_serie')||'N° série'}</th>
        ${CMD_COLS.facture?`<th>${t('cmd_facture')||'N° Facture'}</th>`:''}
        ${CMD_COLS.date_facture?'<th>Date facturation</th>':''}
        ${CMD_COLS.demo_origine?'<th>'+TR("🔄 Origine démo")+'</th>':''}
        ${CMD_COLS.edi?'<th>💳 EDI</th>':''}
        ${CMD_COLS.paiement?'<th>Paiement</th>':''}
        ${CMD_COLS.retour?'<th>'+TR("↩ Retour")+'</th>':''}
        ${CMD_COLS.date_retour?'<th>'+TR("Date retour")+'</th>':''}
        <th>${t('col_statut')||'Statut'}</th><th></th>
      </tr></thead>
      <tbody>${list.map(cm=>`<tr onclick="modalCommande(${cm.id})">
        ${CMD_COLS.num_annuel?`<td style="text-align:center;font-size:13px;color:var(--text3);font-weight:600">${cm.num_annuel||''}</td>`:''}
        <td>${fd(cm.date_commande)}</td>
        <td><span style="font-size:13px;color:var(--text2)">${esc(cm.groupe||'')}</span></td>
        ${CMD_COLS.pays&&!CURRENT_USER.pays?`<td><span style="font-size:13px;color:var(--text2)">${esc(cm.pays||'')}</span></td>`:''}
        <td><span style="cursor:pointer;color:var(--accent)" onclick="event.stopPropagation();CMD_FILTERS.distributeur='${esc(cm.distributeur_nom)}';render()" title="${TR("Filtrer par ce distributeur")}">${esc(cm.distributeur_nom)}</span> ${cm.client_id?`<button onclick="event.stopPropagation();setView('client',{clientId:${cm.client_id}})" title="${TR("Ouvrir la fiche client")}" style="background:none;border:none;cursor:pointer;padding:1px 3px;color:var(--text3);vertical-align:middle" class="btn-fiche-client"><i class="ti ti-user" style="font-size:13px"></i></button>`:`<span title="${TR("Commande non rattachée à une fiche client")}" style="color:var(--border-s);padding:1px 3px;font-size:13px"><i class="ti ti-user-off"></i></span>`}</td>
        <td class="mono">${esc(cm.bdc||'')}${cm.num_commande_distrib?` <span style="color:var(--text3);font-size:13px">(${esc(cm.num_commande_distrib)})</span>`:''}</td>
        <td style="text-align:center">${estCmdFauteuil(cm)
          ? `<i class="ti ti-wheelchair" style="color:var(--accent);font-size:18px" title="Commande fauteuil roulant${cm.modele?' — '+esc(cm.modele):''}"></i>`
          : `<i class="ti ti-box" style="color:var(--text3);font-size:15px" title="${TR("Pièces détachées")}"></i>`}</td>
        <td>${esc(cm.modele || (cm.accessoire||'').replace(/\n/g,' · '))}${cm.quantite&&cm.quantite>1?` <span style="color:var(--text3)">×${cm.quantite}</span>`:''}${cm.modele_demo?` <span class="badge hg" style="font-size:12px">🔄 ${t('cmd_demo_badge')||'Démo'}</span>`:''}${(cm.est_avoir||/avoir/i.test(cm.informations||''))?` <span class="badge urgent" style="font-size:12px" title="${TR("Cette commande porte un avoir (retour / remboursement) — voir le champ Informations")}">↩ Avoir</span>`:''}${cm.origine==='sav'?` <span class="badge hg" style="font-size:12px" title="Commande issue d'un SAV facturé (hors stats de ventes)">🛠️ SAV</span>`:''}</td>
        <td class="mono">${(()=>{
          if(!cm.num_suivi) return '';
          if(isRealTracking(cm.num_suivi)){
            const l=lienSuiviColis(cm.transporteur,cm.num_suivi);
            return esc(cm.num_suivi)+(l?` <a href="${l}" target="_blank" rel="noopener" onclick="event.stopPropagation()"><i class="ti ti-external-link" style="color:var(--accent)"></i></a>`:'');
          }
          return `<span style="color:var(--text3);font-size:13px" title="${esc(cm.num_suivi)}">${esc(cm.num_suivi)}</span>`;
        })()}</td>
        <td style="font-size:14px;color:var(--text2)">${cm.date_livraison?fd(cm.date_livraison):'—'}</td>
        <td class="mono">${esc(cm.num_serie||'')}</td>
        ${CMD_COLS.facture?`<td class="mono" style="font-size:13px">${esc(cm.num_facture||'')}</td>`:''}
        ${CMD_COLS.date_facture?`<td style="font-size:13px;color:var(--text2)">${cm.date_livraison&&cm.num_facture?fd(cm.date_livraison):'—'}</td>`:''}
        ${CMD_COLS.demo_origine?`<td style="font-size:13px">${cm.demo_origine_nom?`<span class="badge hg" title="${TR("Origine démo")}">🔄 ${esc(cm.demo_origine_nom)}</span>`:'—'}</td>`:''}
        ${CMD_COLS.edi?`<td>${cm.client_edi?'<span class="badge ouvert" style="font-size:12px">💳 EDI</span>':'—'}</td>`:''}
        ${CMD_COLS.paiement?`<td>${cm.facture_paiement_statut?
  `<span class="badge ${(cm.facture_paiement_statut==='paye'||cm.facture_paiement_statut==='payé'||cm.facture_paiement_statut==='paid')?'g':(cm.facture_paiement_statut==='impaye'||cm.facture_paiement_statut==='impayé')?'urgent':cm.facture_paiement_statut==='partiel'?'hg':'attente'}" style="font-size:12px">${
    (cm.facture_paiement_statut==='paye'||cm.facture_paiement_statut==='payé'||cm.facture_paiement_statut==='paid')?'✅ Payé':
    (cm.facture_paiement_statut==='impaye'||cm.facture_paiement_statut==='impayé')?'⚠️ Impayé':
    cm.facture_paiement_statut==='partiel'?'🔸 Partiel':'⏳ En attente'
  }${cm.facture_date_echeance&&cm.facture_paiement_statut!=='payé'?` <span style="font-size:11px;opacity:.8">${fd(cm.facture_date_echeance)}</span>`:''}</span>`
  :'—'}</td>`:''}
        ${CMD_COLS.retour?`<td class="mono" style="font-size:13px">${esc(cm.num_retour||'—')}</td>`:''}
        ${CMD_COLS.date_retour?`<td style="font-size:13px;color:var(--text2)">${cm.date_retour?fd(cm.date_retour):'—'}</td>`:''}
        <td onclick="event.stopPropagation()" style="position:relative">
          <span class="badge ${cmdStatutClass(cm.statut_calc)}" style="cursor:pointer" onclick="toggleStatutMenu(event,${cm.id},'${esc(cm.statut||'Auto')}')">${esc(tStatut(cm.statut_calc))} <i class="ti ti-chevron-down" style="font-size:11px;opacity:.6"></i></span>
        </td>
        <td style="text-align:center">
          ${cm.client_final ? clientFinalBadge(cm) : ''}
          ${cm.num_retour?`<i class="ti ti-arrow-back-up" style="color:var(--danger);margin-left:2px" title="Retour : ${esc(cm.num_retour)}${cm.date_retour?' — reçu le '+fd(cm.date_retour):''}"></i>`:''}
          ${cm.informations?`<i class="ti ti-info-circle" style="color:var(--text2);margin-left:2px" title="${esc(cm.informations)}"></i>`:''}
          ${cm.reliquat?`<i class="ti ti-clock-exclamation" style="color:var(--warning);margin-left:2px" title="Reliquat${cm.reliquat_description?' : '+cm.reliquat_description:''}"></i>`:''}
        </td>
      </tr>`).join('')}</tbody>
    </table></div>
    ${nbPages > 1 ? nav : ''}`;
}

// Correspondance réseau distributeur (reseau_carte) → libellé du champ "Groupe" des commandes
var RESEAU_VERS_GROUPE = {
  base: 'De base', bastide: 'Bastide', providom: 'Providom',
  districlub: 'Distri club', negocies: 'Négocié'
};

// Pré-remplit le "Groupe" d'une commande à partir du réseau du distributeur saisi,
// seulement si le champ Groupe est encore vide (ne jamais écraser un choix manuel).
// ── Autocomplétion du distributeur dans la modale de commande ──
// Propose les fiches clients existantes quand on tape le nom ; en sélectionnant
// une proposition on fixe le client_id exact (évite les doublons/amalgames à la création).
function searchCmdDistrib(q){
  const drop = document.getElementById('cmd-distrib-drop'); if(!drop) return;
  const src = Array.isArray(window._ALL_CLIENTS) ? window._ALL_CLIENTS : (window._ALL_CLIENTS && window._ALL_CLIENTS.rows) || [];
  const query = (q||'').toLowerCase().trim();
  if(!query){ drop.style.display='none'; return; }
  const results = src.filter(c =>
    (c.nom && c.nom.toLowerCase().includes(query)) ||
    (c.ville && c.ville.toLowerCase().includes(query))
  ).slice(0,15);
  if(!results.length){ drop.style.display='none'; return; }
  drop.innerHTML = results.map(c => `<div class="piece-option" onmousedown="event.preventDefault();selectCmdDistrib(${c.id},'${(c.nom||'').replace(/'/g,"\\'")}')">
    <div style="font-size:14px;font-weight:600">${esc(c.nom||'')}</div>
    <div style="font-size:13px;color:var(--text3)">${esc(c.ville||'')}${c.cp?' ('+esc(c.cp)+')':''}</div>
  </div>`).join('');
  drop.style.display = 'block';
}
function cmdDistribInput(v){
  // Saisie manuelle → on annule tout client_id sélectionné précédemment (nouveau distributeur possible)
  const hid = document.getElementById('cmd-client-id'); if(hid) hid.value='';
  searchCmdDistrib(v);
}
function selectCmdDistrib(id, nom){
  const inp = document.getElementById('cmd-distrib');
  const hid = document.getElementById('cmd-client-id');
  if(inp) inp.value = nom;
  if(hid) hid.value = id;
  const drop = document.getElementById('cmd-distrib-drop'); if(drop) drop.style.display='none';
  prefillGroupeDepuisDistrib();
}

async function prefillGroupeDepuisDistrib(){
  var champGroupe = document.getElementById('cmd-groupe');
  var champDistrib = document.getElementById('cmd-distrib');
  if (!champGroupe || !champDistrib) return;
  if (champGroupe.value) return; // déjà renseigné → on respecte le choix
  var nom = champDistrib.value.trim();
  if (!nom) return;
  try {
    var r = await API.reseauParNom(nom);
    if (r && r.reseau && RESEAU_VERS_GROUPE[r.reseau] && !champGroupe.value) {
      champGroupe.value = RESEAU_VERS_GROUPE[r.reseau];
    }
  } catch(_) { /* silencieux : le pré-remplissage est un confort, pas un blocage */ }
}
window.prefillGroupeDepuisDistrib = prefillGroupeDepuisDistrib;

// ── Nouvelle commande : fenêtre initiale d'import VosFactures / Pennylane ──────────
function modalNouvelleCommande(){
  window._NC_SOURCE = 'vf';
  showModal(`
    <div class="modal-header">
      <i class="ti ti-clipboard-plus" style="font-size:20px;color:var(--accent)"></i>
      <h2 style="flex:1">${t('cmd_add')||'Nouvelle commande'}</h2>
      <button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button>
    </div>
    <div style="padding:22px;display:flex;flex-direction:column;gap:14px">
      <div style="font-size:15px;color:var(--text2)">${TR('Importer une commande depuis son numéro :')}</div>
      <div style="display:flex;gap:8px">
        <button type="button" id="nc-src-vf" class="btn" onclick="ncSetSource('vf')" style="flex:1"><i class="ti ti-file-invoice"></i> VosFactures</button>
        <button type="button" id="nc-src-pl" class="btn" onclick="ncSetSource('pennylane')" style="flex:1"><i class="ti ti-brand-stripe"></i> Pennylane</button>
      </div>
      <div>
        <label class="form-label">${TR('Numéro de commande (BDC / devis)')}</label>
        <input class="form-input mono" id="nc-numero" placeholder="${TR("Numéro VosFactures ou Pennylane")}" onkeydown="if(event.key==='Enter')importerNouvelleCommande()" style="width:100%">
      </div>
      <div id="nc-msg" style="font-size:14px;color:var(--text3);min-height:16px"></div>
      <div style="display:flex;gap:8px;justify-content:space-between;margin-top:4px">
        <button class="btn" type="button" onclick="closeModal();modalCommande()"><i class="ti ti-edit"></i> Saisie manuelle</button>
        <button class="btn primary" type="button" onclick="importerNouvelleCommande()"><i class="ti ti-download"></i> Importer</button>
      </div>
    </div>
  `);
  setTimeout(function(){ ncSetSource('vf'); var i=document.getElementById('nc-numero'); if(i) i.focus(); }, 50);
}
function ncSetSource(src){
  window._NC_SOURCE = src;
  [['vf','vf'],['pl','pennylane']].forEach(function(k){
    var b=document.getElementById('nc-src-'+k[0]); if(b) b.classList.toggle('primary', src===k[1]);
  });
}
async function importerNouvelleCommande(){
  var numero=(document.getElementById('nc-numero').value||'').trim();
  var src=window._NC_SOURCE||'vf';
  var msg=document.getElementById('nc-msg');
  if(!numero){ if(msg) msg.innerHTML='<span style="color:var(--danger)">'+TR("Indique d’abord un numéro.")+'</span>'; return; }
  if(msg) msg.innerHTML='<i class="ti ti-loader-2"></i> Recherche dans '+(src==='pennylane'?'Pennylane':'VosFactures')+'…';
  var today=new Date().toISOString().slice(0,10);
  try{
    var r = src==='pennylane' ? await API.pennylane_bdc_lookup(numero) : await API.vfBdcLookup(numero);
    if(r && r.configured===false){ if(msg) msg.innerHTML='<span style="color:var(--danger)">'+(src==='pennylane'?'Pennylane':'VosFactures')+' non configuré.</span>'; return; }
    if(r && r.found){
      var estFauteuil=/eloflex/i.test(r.modele||'');
      var prefill={
        statut:'Auto',
        distributeur_nom: r.distributeur||'',
        bdc: r.numero||numero,
        quantite: r.quantite||1,
        modele: r.modele||'',
        modele_demo: !!r.modele_demo,
        lignes: r.lignes||[],
        date_commande: today,          // date du jour, pas celle tirée de VF/Pennylane
        bdc_source: src,
        bdc_doc_id: (r.vf_id!=null? String(r.vf_id) : ''),
        commande_type: estFauteuil ? 'fauteuil' : (r.modele ? 'pieces' : '')
      };
      if(estFauteuil){ if(r.modele_demo) prefill.type_fauteuil_demo=true; else prefill.type_fauteuil_neuf=true; }
      else if(r.modele){ prefill.type_pieces=true; }
      closeModal();
      modalCommande(null, prefill);
    } else if(r && r.suggestions && r.suggestions.length){
      // Numéro sans suffixe : Pennylane numérote avec -1/-2/-3 → proposer les documents correspondants
      var chips=r.suggestions.map(function(sg){
        var lbl=esc(sg.numero)+(sg.distributeur?(' — '+esc(sg.distributeur)):'');
        return '<button class="btn sm" type="button" style="margin:2px;text-align:left" onclick="ncChoisirNumero(\''+String(sg.numero).replace(/[^A-Za-z0-9_-]/g,'')+'\')"><i class="ti ti-file-invoice"></i> '+lbl+'</button>';
      }).join('');
      if(msg) msg.innerHTML='<div style="color:var(--warning);margin-bottom:6px">'+TR('Numéro incomplet — Pennylane ajoute un suffixe. Choisissez le bon document :')+'</div><div style="display:flex;flex-direction:column;gap:2px">'+chips+'</div>';
    } else {
      // Introuvable → formulaire vide avec le numéro pré-rempli (saisie manuelle)
      if(msg) msg.innerHTML='<span style="color:var(--warning)">Introuvable dans '+(src==='pennylane'?'Pennylane':'VosFactures')+' — ouverture en saisie manuelle…</span>';
      setTimeout(function(){ closeModal(); modalCommande(null, { statut:'Auto', quantite:1, bdc:numero, date_commande:today, bdc_source:src }); }, 600);
    }
  }catch(e){ if(msg) msg.innerHTML='<span style="color:var(--danger)">Erreur : '+esc(e.message)+'</span>'; }
}
// Ouvre le bon de commande dans le bon système (VosFactures ou Pennylane)
function ouvrirBdcSource(){
  var src=(document.getElementById('cmd-bdc-source')||{}).value||'';
  var docid=(document.getElementById('cmd-bdc-docid')||{}).value||'';
  var bdc=(document.getElementById('cmd-bdc').value||'').trim();
  if(src==='pennylane'){
    if(docid){ window.open('https://app.pennylane.com/companies/invoices/'+docid, '_blank', 'noopener'); }
    else { toast(TR('Pièce Pennylane non identifiée — ouvre Pennylane manuellement'),'ti-alert-circle','var(--warning)'); window.open('https://app.pennylane.com/companies/invoices', '_blank', 'noopener'); }
    return;
  }
  ouvrirDansVF(docid||null, bdc);
}
// Ouvrir le BDC / devis dans le système choisi (VosFactures OU Pennylane), pour consulter l'un ou l'autre
async function ouvrirBdcDans(sys){
  var src=(document.getElementById('cmd-bdc-source')||{}).value||'';
  var docid=(document.getElementById('cmd-bdc-docid')||{}).value||'';
  var bdc=(document.getElementById('cmd-bdc').value||'').trim();
  if(sys==='pennylane'){
    var win=window.open('about:blank','_blank');
    var go=function(u){ if(win && !win.closed){ win.location.href=u; } else { window.open(u,'_blank','noopener'); } };
    if(!bdc){ if(win)win.close(); toast(TR('Renseigne d\'abord le numéro'),'ti-alert-circle','var(--warning)'); return; }
    try{
      // On récupère le lien de consultation direct du document (public_file_url)
      var r=await API.pennylane_bdc_lookup(bdc);
      if(r && r.configured===false){ if(win)win.close(); toast(TR('Pennylane non configuré'),'ti-alert-circle','var(--warning)'); return; }
      if(r && r.found && r.url_doc){ go(r.url_doc); }
      else { go('https://app.pennylane.com/companies/clients_invoices'); toast(TR('Pièce non trouvée dans Pennylane — liste ouverte'),'ti-alert-circle','var(--warning)'); }
    }catch(e){ go('https://app.pennylane.com/companies/clients_invoices'); }
    return;
  }
  // VosFactures : ID direct seulement si la pièce vient bien de VosFactures, sinon recherche par n°
  ouvrirDansVF((src==='vf' && docid) ? docid : null, bdc);
}
window.ouvrirBdcDans=ouvrirBdcDans;
function ncChoisirNumero(n){ var el=document.getElementById('nc-numero'); if(el){ el.value=n; } importerNouvelleCommande(); }
window.ncChoisirNumero=ncChoisirNumero;
window.modalNouvelleCommande=modalNouvelleCommande; window.ncSetSource=ncSetSource; window.importerNouvelleCommande=importerNouvelleCommande; window.ouvrirBdcSource=ouvrirBdcSource;

async function modalCommande(id, prefill){
  window._currentCmdId = id;
  // Assure que la base produits est chargée pour l'autocomplétion des lignes (désignation / référence)
  if(!CACHE.catalogue.length){ try{ CACHE.catalogue = await API.catalogue(); }catch(e){} }
  // Base clients pour l'autocomplétion du distributeur (propositions quand on tape le nom)
  if(!window._ALL_CLIENTS){ try{ window._ALL_CLIENTS = await API.clients(); }catch(e){ window._ALL_CLIENTS = []; } }
  let cm = id ? await API.commande(id) : Object.assign({statut:'Auto', quantite:1}, prefill||{});

  const hasExp  = !!(cm.num_suivi || cm.date_livraison || cm.num_bordereau || cm.num_serie);
  const hasFact = !!(cm.num_facture || (cm.statut && cm.statut!=='Auto' && cm.statut!=='En préparation' && cm.statut!=='En attente confirmation'));
  const initTab = id && (cm.statut_calc==='Expédié'||cm.statut_calc==='Livré') && !hasFact ? 'expedition' : 'commande';
  const type = cm.commande_type || (/eloflex/i.test(cm.modele||'') ? 'fauteuil' : cm.modele ? 'pieces' : '');
  const isFauteuil = type==='fauteuil', isPieces=type==='pieces';

  const tabBtn = (key, label, icon, dot) =>
    `<button id="tab-btn-${key}" onclick="switchCmdTab('${key}')"
      style="flex:1;padding:10px 6px;border:none;background:none;cursor:pointer;font-size:15px;font-weight:600;
             border-bottom:2px solid ${key===initTab?'var(--accent)':'transparent'};
             color:${key===initTab?'var(--accent)':'var(--text2)'};display:flex;align-items:center;justify-content:center;gap:5px">
      <i class="ti ${icon}"></i>${label}${dot?`<span style="width:7px;height:7px;border-radius:50%;background:var(--accent);display:inline-block;margin-left:2px"></span>`:''}
    </button>`;

  showModal(`
    <div class="modal-header">
      <i class="ti ti-clipboard-list" style="font-size:20px;color:var(--accent)"></i>
      <h2 style="flex:1">${id?(t('cmd_edit')||'Modifier'):(t('cmd_add')||'Nouvelle commande')}${cm.distributeur_nom?` <span style="font-weight:400;color:var(--text2);font-size:17px">— ${esc(cm.distributeur_nom)}</span>`:''}</h2>
      ${cm.client_edi?`<span class="badge ouvert" style="font-size:13px;margin-right:4px">💳 EDI</span>`:''}
      ${/avoir/i.test(cm.informations||'')?`<span class="badge urgent" style="font-size:13px;margin-right:4px" title="${esc((cm.informations||'').replace(/"/g,'&quot;').slice(0,140))}">${TR('↩ Avoir / Retour')}</span>`:''}
      ${id&&cm.origine==='sav'?`<span class="badge hg" style="font-size:13px;margin-right:4px" title="Commande issue d'un SAV facturé — exclue des stats de ventes et de la numérotation">${TR('🛠️ SAV facturé')}</span>`:''}
      ${id?(cm.intervention_id
        ? `<button class="btn sm" onclick="ouvrirInterventionLiee(${cm.intervention_id})" title="${TR("Voir le SAV lié")}"><i class="ti ti-tool"></i> ${TR('SAV lié')}</button>`
        : `<button class="btn sm" onclick="basculerCommandeVersSAV(${id})" title="${TR("Créer un SAV lié pour cette commande")}"><i class="ti ti-tool"></i> ${TR('Créer SAV')}</button>`):''}
      <button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button>
    </div>
    <div style="display:flex;border-bottom:0.5px solid var(--border-s)">
      ${tabBtn('commande',t('cmd_tab_commande')||'Commande','ti-clipboard-list',false)}
      ${tabBtn('expedition',t('cmd_tab_expedition')||'Expédition','ti-truck-delivery',hasExp)}
      ${tabBtn('facturation',t('cmd_tab_facturation')||'Facturation','ti-receipt-2',hasFact)}
      ${tabBtn('notes','Notes 💬','ti-message-circle',false)}
    </div>
    <div style="display:flex;align-items:center;gap:10px;padding:10px 22px;background:var(--bg);border-bottom:0.5px solid var(--border-s)">
      <span style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text2)">${t('cmd_statut_label')||'STATUT'}</span>
      <select id="cmd-statut" onchange="majZonePreuveLivraison();majStatutBadge()" style="font-size:14px;padding:4px 8px;border:0.5px solid var(--border-s);border-radius:var(--radius);background:var(--surface);cursor:pointer">
        <option value="Auto" ${(cm.statut||'Auto')==='Auto'?'selected':''}>${t('cmd_auto_option')||t('cmd_auto_option')||'Auto (calculé)'}</option>
        <option value="En attente confirmation" ${cm.statut==='En attente confirmation'?'selected':''}>⏳ En attente confirmation</option>
        <option value="En préparation" ${cm.statut==='En préparation'?'selected':''}>${t('cmd_en_prep')||'En préparation'}</option>
        <option value="Expédié" ${cm.statut==='Expédié'?'selected':''}>${t('cmd_expedie')||'Expédié'}</option>
        <option value="Livré" ${cm.statut==='Livré'?'selected':''}>${t('cmd_livre')||'Livré'}</option>
        <option value="Facturé" ${cm.statut==='Facturé'?'selected':''}>${t('cmd_facture_statut')||'Facturé'}</option>
        <option value="Payé" ${cm.statut==='Payé'?'selected':''}>${TR('✅ Payé')}</option>
        <option value="Impayé" ${cm.statut==='Impayé'?'selected':''}>${TR('⚠️ Impayé')}</option>
        <option value="Avoir" ${cm.statut==='Avoir'?'selected':''}>${t('cmd_avoir_statut')||'Avoir'}</option>
        <option value="Problème" ${cm.statut==='Problème'?'selected':''}>${t('cmd_probleme')||'Problème'}</option>
        <option value="Annulé" ${cm.statut==='Annulé'?'selected':''}>${t('cmd_annule')||'Annulé'}</option>
      </select>
      <span id="cmd-statut-badge" class="badge ${cmdStatutClass(cm.statut_calc||'En préparation')}" style="font-size:13px">${tStatut(cm.statut_calc||'En préparation')}</span>
      <span style="font-size:13px;color:var(--text3)" id="cmd-statut-auto-hint">${(cm.statut||'Auto')==='Auto'?t('cmd_auto_hint')||'← calculé automatiquement':''}</span>
    </div>
    <div class="modal-body" style="padding-top:16px">

      <div id="cmd-tab-commande" style="${initTab!=='commande'?'display:none':''}">
        <div class="grid-2">
          <div class="form-group"><label class="form-label">${t('col_client')||'Distributeur'} *</label>
            <div style="position:relative">
              <input class="form-input" id="cmd-distrib" autocomplete="off" value="${esc(cm.distributeur_nom||'')}" required placeholder="${t('col_client')||'Nom du distributeur'}"
                oninput="cmdDistribInput(this.value)"
                onfocus="searchCmdDistrib(this.value)"
                onchange="prefillGroupeDepuisDistrib()"
                onblur="setTimeout(()=>{const d=document.getElementById('cmd-distrib-drop');if(d)d.style.display='none'},150)">
              <input type="hidden" id="cmd-client-id" value="${cm.client_id||''}">
              <div id="cmd-distrib-drop" class="piece-dropdown" style="display:none"></div>
            </div>
          </div>
          ${cm.facturation_nom?`<div class="form-group" style="grid-column:1/-1;margin:-2px 0 6px"><div style="font-size:14px;color:var(--text2);background:var(--bg);border:0.5px solid var(--border-s);border-radius:6px;padding:7px 10px">${TR('🧾 Facturé à :')} <strong>${esc(cm.facturation_nom)}</strong> <span style="color:var(--text3)">${TR('— défini sur la fiche distributeur')}</span></div></div>`:''}
          <div class="form-group"><label class="form-label">${t('cmd_groupe')||'Groupe'}</label>
            <select class="form-input" id="cmd-groupe">
              <option value="">${TR("— Choisir —")}</option>
              ${['De base','Bastide','Providom','Distri club','Négocié','Particulier'].map(g=>`<option value="${g}" ${cm.groupe===g?'selected':''}>${g}</option>`).join('')}
            </select>
          </div>
          <div class="form-group" style="grid-column:1/-1"><label class="form-label">${t('cmd_modele')||'Modèle / Article'}</label>
            <input class="form-input" id="cmd-modele" value="${esc(cm.modele||'')}">
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 2fr 2fr;gap:10px;margin-bottom:12px">
          <div class="form-group" style="margin:0"><label class="form-label">${TR('Quantité')}</label>
            <input class="form-input" id="cmd-quantite" type="number" min="1" value="${cm.quantite||1}">
          </div>
          <div class="form-group" style="margin:0"><label class="form-label">${TR("Bdc / Devis")}</label>
            <input type="hidden" id="cmd-bdc-source" value="${cm.bdc_source||(cm.vf_commande_id?'vf':'')}">
            <input type="hidden" id="cmd-bdc-docid" value="${cm.bdc_doc_id||cm.vf_commande_id||''}">
            <div style="display:flex;gap:5px">
              <input class="form-input mono" id="cmd-bdc" value="${esc(cm.bdc||'')}" style="flex:1" placeholder="${t('cmd_num_bdc_placeholder')||'Numéro BDC ou Devis'}" oninput="majStatutBadge()">
              ${cm.origine==='sav'
                ? `<span title="Commande issue d'un SAV : le contenu (lignes, série, facture, suivi) est repris automatiquement du SAV lié — pas d'import VosFactures ici" style="color:var(--text3);font-size:13px;align-self:center;white-space:nowrap;padding:0 6px"><i class="ti ti-tool"></i> SAV</span>`
                : `<button class="btn sm" type="button" title="Importer depuis Pennylane / VosFactures" onmousedown="lookupBdcVF()"><i class="ti ti-download"></i></button>`}
              <button class="btn sm" type="button" title="${TR("Ouvrir dans VosFactures")}" onclick="ouvrirBdcDans('vf')"><i class="ti ti-file-invoice"></i></button>
              <button class="btn sm" type="button" title="${TR("Ouvrir dans Pennylane")}" onclick="ouvrirBdcDans('pennylane')"><i class="ti ti-brand-stripe"></i></button>
            </div>
          </div>
          <div class="form-group" style="margin:0"><label class="form-label">${TR("N° commande distributeur")}</label>
            <input class="form-input mono" id="cmd-num-distrib" value="${esc(cm.num_commande_distrib||'')}" placeholder="${t('cmd_ref_interne')||'Réf. interne'}">
          </div>
        </div>
        <div style="background:var(--bg);border:0.5px solid var(--border-s);border-radius:var(--radius);padding:12px;margin-bottom:12px">
          <div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text2);margin-bottom:10px">${t('cmd_type_label')||'TYPE DE COMMANDE'}</div>
          <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:10px">
            <label style="display:flex;align-items:center;gap:7px;cursor:pointer;font-size:15px">
              <input type="checkbox" id="cmd-type-fauteuil-neuf" ${cm.type_fauteuil_neuf?'checked':''} style="width:15px;height:15px;accent-color:var(--accent)" onchange="majTypeSuede();majBdcConfirme()">${t('cmd_type_fauteuil_neuf')||'Fauteuil Neuf'}
            </label>
            <label style="display:flex;align-items:center;gap:7px;cursor:pointer;font-size:15px">
              <input type="checkbox" id="cmd-type-fauteuil-demo" ${cm.type_fauteuil_demo||cm.modele_demo?'checked':''} style="width:15px;height:15px;accent-color:var(--warning)" onchange="majTypeSuede();majBdcConfirme();majSerieDemoHint()">${t('cmd_type_fauteuil_demo')||'Fauteuil Démo'}
            </label>
            <label style="display:flex;align-items:center;gap:7px;cursor:pointer;font-size:15px">
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
              <div style="font-size:13px;font-weight:600;color:var(--text2);margin-bottom:6px">${t('cmd_bdc_confirme_par')||'BDC confirmé par :'}</div>
              <div style="display:flex;gap:14px;flex-wrap:wrap">
                ${['mail','vosfactures','fiche de mesure'].map(m=>`
                <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:15px">
                  <input type="radio" name="cmd-confirmation-mode" value="${m}" ${cm.confirmation_mode===m?'checked':''} onchange="toggleDateConfirmation(this)" style="accent-color:var(--accent)">
                  ${m==='mail'?t('cmd_mail')||'✉ Mail':m==='vosfactures'?'📋 VosFactures':`📐 ${t('cmd_fiche_mesure')||'Fiche de mesure'}`}
                </label>`).join('')}
                <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:14px;color:var(--text3)">
                  <input type="radio" name="cmd-confirmation-mode" value="" ${!cm.confirmation_mode?'checked':''} onchange="toggleDateConfirmation(this)" style="accent-color:var(--text3)">
                  ${t('cmd_non_confirme')||'Non confirmé'}
                </label>
              </div>
              <div id="cmd-date-confirmation-wrap" style="margin-top:8px;${cm.confirmation_mode?'':'display:none'}">
                <label class="form-label" style="font-size:13px;color:var(--text2);margin-bottom:2px;display:block">${t('cmd_date_confirmation')||'Date de confirmation'}</label>
                <input class="form-input" id="cmd-date-confirmation" type="date" style="max-width:180px" value="${cm.date_confirmation||new Date().toISOString().slice(0,10)}">
              </div>
            </div>
          </div>
        </div>
        <div style="margin-bottom:12px">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px">
            <span class="form-label" style="margin:0">${t('cmd_lignes_bdc')||'Lignes du bon de commande'}</span>
            <label style="display:flex;align-items:center;gap:6px;font-size:14px;color:var(--text2);cursor:pointer">
              <input type="checkbox" id="cmd-ajout-articles" ${id?'checked':''} onchange="var w=document.getElementById('cmd-ajout-btn-wrap');if(w)w.style.display=this.checked?'':'none'"> Uniquement si oubli ou complément d'articles
            </label>
          </div>
          <div id="cmd-ajout-btn-wrap" style="display:${id?'':'none'};margin-bottom:6px">
            <button class="btn sm" type="button" onclick="addCmdLigne()"><i class="ti ti-plus"></i> ${t('btn_ajouter')||'+ Ajouter'}</button>
          </div>
          <div id="cmd-lignes-list" style="border:0.5px solid var(--border-s);border-radius:var(--radius);padding:6px;min-height:40px"></div>
        </div>
        <div class="grid-2">
          <div class="form-group"><label class="form-label">${t('cmd_date_commande')||'Date commande'}</label><input class="form-input" id="cmd-date" type="date" value="${cm.date_commande || (id ? '' : new Date().toISOString().slice(0,10))}"></div>
          <div class="form-group"><label class="form-label">Pays</label>
            ${CURRENT_USER.pays
              ? `<div class="form-input" style="background:var(--bg);cursor:default">${esc(CURRENT_USER.pays)}</div><input type="hidden" id="cmd-pays" value="${esc(CURRENT_USER.pays)}">`
              : `<select class="form-input" id="cmd-pays">
                  <option value="France" ${(cm.pays||'France')==='France'?'selected':''}>🇫🇷 France</option>
                  <option value="Sweden" ${cm.pays==='Sweden'?'selected':''}>${TR('🇸🇪 Suède')}</option>
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
          <div class="form-group"><label class="form-label">${TR('Client final (bénéficiaire)')}</label>
            <input class="form-input" id="cmd-clientfinal" value="${esc(cm.client_final||'')}" placeholder="${TR("Nom du bénéficiaire")}">
          </div>
          <div class="form-group"><label class="form-label">Type de destinataire</label>
            <select class="form-input" id="cmd-clientfinal-type" onchange="toggleClientFinalForm(this.value)">
              <option value="">${TR('— Même adresse que le distributeur')}</option>
              <option value="particulier" ${cm.client_final_type==='particulier'?'selected':''}>🏠 Particulier</option>
              <option value="entreprise" ${cm.client_final_type==='entreprise'?'selected':''}>🏢 Entreprise / Structure</option>
            </select>
          </div>
        </div>
        <div id="cf-form" style="${cm.client_final_type?'':'display:none'}">
          <div style="background:rgba(255,255,255,.5);border:0.5px solid var(--border);border-radius:10px;padding:14px 16px;margin-top:4px">
            <div id="cf-titre" style="font-size:13px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">
              Adresse de livraison — ${cm.client_final_type==='particulier'?'🏠 Particulier':'🏢 Entreprise / Structure'}
            </div>
            <div class="grid-2">
              <div class="form-group" style="position:relative">
                <label class="form-label" id="cf-nom-label">${cm.client_final_type==='particulier'?'Nom':'Raison sociale / Nom'}</label>
                <input class="form-input" id="cf-nom" value="${esc(cm.cf_nom||'')}" placeholder="Nom / Raison sociale"
                  oninput="cfAutocomplete(this,'nom')">
                <div id="cf-suggest" style="display:none;position:absolute;top:100%;left:0;right:0;background:#fff;border:0.5px solid var(--border);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.12);z-index:999;max-height:180px;overflow-y:auto"></div>
              </div>
              <div class="form-group" id="cf-prenom-group" style="${cm.client_final_type==='particulier'?'':'display:none'}">
                <label class="form-label">${TR('Prénom')}</label>
                <input class="form-input" id="cf-prenom" value="${esc(cm.cf_prenom||'')}" placeholder="${TR("Prénom")}">
              </div>
              <div class="form-group" style="grid-column:1/-1">
                <label class="form-label">Adresse</label>
                <input class="form-input" id="cf-adresse" value="${esc(cm.cf_adresse||'')}" placeholder="${TR("Numéro et nom de rue")}">
              </div>
              <div class="form-group">
                <label class="form-label">Code postal</label>
                <input class="form-input" id="cf-cp" value="${esc(cm.cf_cp||'')}" placeholder="75001" oninput="cfAutocomplete(this,'cp')">
              </div>
              <div class="form-group">
                <label class="form-label">Ville</label>
                <input class="form-input" id="cf-ville" value="${esc(cm.cf_ville||'')}" placeholder="Paris" oninput="cfAutocomplete(this,'ville')">
              </div>
              <div class="form-group">
                <label class="form-label">${TR('Téléphone')}</label>
                <input class="form-input" id="cf-tel" type="tel" value="${esc(fmtTel(cm.cf_tel||''))}" placeholder="06 00 00 00 00">
              </div>
              <div class="form-group">
                <label class="form-label">Email</label>
                <input class="form-input" id="cf-email" type="email" value="${esc(cm.cf_email||'')}" placeholder="contact@example.fr">
              </div>
            </div>
          </div>
        </div>
        <div class="grid-2">
          <div class="form-group"><label class="form-label">N° suivi</label>
            <input class="form-input mono" id="cmd-suivi" value="${esc(cm.num_suivi||'')}" oninput="majLienSuiviModal();majStatutBadge()" placeholder="${t('cmd_num_transporteur_placeholder')||'Numéro transporteur'}">
          </div>
          <div class="form-group"><label class="form-label">Transporteur</label>
            <select class="form-input" id="cmd-transporteur" onchange="majLienSuiviModal()">
              <option value="">${TR("— Choisir —")}</option>
              <option value="Chronopost" ${cm.transporteur==='Chronopost'?'selected':''}>Chronopost</option>
              <option value="Colissimo" ${cm.transporteur==='Colissimo'?'selected':''}>Colissimo (La Poste)</option>
              <option value="DB Schenker" ${cm.transporteur==='DB Schenker'?'selected':''}>DB Schenker</option>
              <option value="UPS" ${cm.transporteur==='UPS'?'selected':''}>UPS</option>
              <option value="Autre" ${cm.transporteur==='Autre'?'selected':''}>Autre</option>
            </select>
          </div>
          <div id="cmd-lien-suivi-wrap" style="grid-column:1/-1;margin-top:-8px"></div>
          <div class="form-group"><label class="form-label">${TR("Date livraison")}</label>
            <input class="form-input" id="cmd-livraison" type="date" value="${cm.date_livraison||''}" onchange="majZonePreuveLivraison();majStatutBadge()">
          </div>
          <div class="form-group"><label class="form-label">${TR("N° Bordereau de livraison")}</label>
            <div style="display:flex;gap:5px">
              <input class="form-input mono" id="cmd-bordereau" value="${esc(cm.num_bordereau||'')}" placeholder="BL-2026-..." style="flex:1">
              ${cm.num_bordereau?`<button class="btn sm" type="button" title="${TR("Ouvrir dans VosFactures")}" onclick="ouvrirDansVF(null,'${esc(cm.num_bordereau)}')"><i class="ti ti-external-link"></i></button>`:''}
            </div>
          </div>
          <div class="form-group"><label class="form-label">${TR('N° série')}</label>
            <input class="form-input mono" id="cmd-serie" value="${esc(cm.num_serie||'')}" placeholder="${t('cmd_num_serie_placeholder')||'Numéro de série'}" oninput="majSerieDemoHint()">
            <div id="cmd-serie-demo-hint" style="display:none;font-size:13.5px;color:var(--warning);margin-top:4px"><i class="ti ti-info-circle" style="font-size:14px;margin-right:2px"></i>${TR('Fauteuil démo : renseignez le n° de série pour le suivre dans le Parc démo et le rattacher aux prêts / transferts.')}</div>
          </div>
        </div>
        <div id="cmd-preuve-zone"></div>
        <div style="margin-top:14px;padding-top:14px;border-top:0.5px solid var(--border-s)">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;color:var(--danger);font-size:14px;font-weight:700;text-transform:uppercase;letter-spacing:.04em">
            <i class="ti ti-arrow-back-up"></i> Retour produit
          </div>
          <div class="grid-2" style="gap:10px">
            <div class="form-group"><label class="form-label">${t('cmd_suivi_retour')||'N° suivi retour'}</label>
              <input class="form-input mono" id="cmd-num-retour" value="${esc(cm.num_retour||'')}" placeholder="ex: XN123456789JB">
            </div>
            <div class="form-group"><label class="form-label">${t('cmd_transporteur_retour')||'Transporteur retour'}</label>
              <select class="form-input" id="cmd-transporteur-retour">
                <option value="">${TR("— Choisir —")}</option>
                ${['Chronopost','Colissimo','DB Schenker','UPS','TNT','DHL','Autre'].map(tr=>`<option value="${tr}" ${cm.transporteur_retour===tr?'selected':''}>${tr}</option>`).join('')}
              </select>
            </div>
            <div class="form-group"><label class="form-label">${t('cmd_date_retour_reception')||'Date réception retour'}</label>
              <input class="form-input" id="cmd-date-retour" type="date" value="${cm.date_retour||''}">
            </div>
            <div class="form-group" style="display:flex;align-items:flex-end">
              ${cm.num_retour&&lienSuiviColis(cm.transporteur_retour,cm.num_retour)?`<a href="${lienSuiviColis(cm.transporteur_retour,cm.num_retour)}" target="_blank" class="btn sm"><i class="ti ti-external-link"></i> ${TR("Suivre le retour")}</a>`:`<span style="font-size:14px;color:var(--text3)">${t('cmd_renseigne_suivi')||'Renseigne le N° pour suivre'}</span>`}
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
            <input type="hidden" id="cmd-facture-vfid" value="${cm.facture_vf_id||''}">
            <div style="display:flex;gap:5px">
              <input class="form-input mono" id="cmd-facture" value="${esc(cm.num_facture||'')}" style="flex:1" placeholder="${t('cmd_num_facture_placeholder')||'Numéro de facture'}" oninput="majStatutBadge();var _v=document.getElementById('cmd-facture-vfid');if(_v)_v.value=''">
              <button class="btn sm" type="button" title="${TR("Ouvrir la facture dans VosFactures")}" onclick="ouvrirDansVF((document.getElementById('cmd-facture-vfid')||{}).value||null, (document.getElementById('cmd-facture').value||'').trim())"><i class="ti ti-external-link"></i></button>
              ${id&&cm.num_facture?`<button class="btn sm" type="button" onclick="syncPaiementCommande(${id})" title="${TR("Vérifier le paiement dans VosFactures")}"><i class="ti ti-refresh"></i></button>`:''}
            </div>
          </div>
          ${cm.facture_paiement_statut?'<span class="badge '+(cm.facture_paiement_statut==="payé"?"g":cm.facture_paiement_statut==="impayé"?"urgent":"attente")+'" style="font-size:13px">'+(cm.facture_paiement_statut==="payé"?"✅ Payé":cm.facture_paiement_statut==="impayé"?"⚠️ Impayé":"⏳ En attente")+'</span>':''}
          <div class="form-group"><label class="form-label">${t('cmd_facture_pl_label')||'N° facture Pennylane'}</label>
            <div style="display:flex;gap:6px">
              <input class="form-input mono" id="cmd-facture-pl" value="${esc(cm.num_facture_pennylane||'')}" placeholder="FAC-2026-..." style="flex:1" oninput="majStatutBadge()">
              ${id?`<button class="btn sm" type="button" onclick="genererFacturePennylaneModal(${id})" title="${TR("Créer la facture dans Pennylane (brouillon)")}"><i class="ti ti-brand-stripe"></i></button>`:''}
            </div>
          </div>
          <div class="form-group" style="grid-column:1/-1"><label class="form-label">Informations</label>
            <textarea class="form-input" id="cmd-infos" rows="2" placeholder="${t('cmd_notes_placeholder')||'Notes internes…'}">${esc(cm.informations||'')}</textarea>
          </div>
        </div>
        <div style="margin-bottom:12px">
          <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:0.5px solid var(--border-s);border-radius:var(--radius);background:${cm.reliquat?'var(--warning-bg)':'var(--surface)'}">
            <input type="checkbox" id="cmd-reliquat" ${cm.reliquat?'checked':''} onchange="majReliquatSection()" style="width:16px;height:16px;cursor:pointer;accent-color:var(--warning)">
            <label for="cmd-reliquat" style="font-size:15px;font-weight:600;cursor:pointer;color:var(--warning)">⚠ Reliquat en attente</label>
          </div>
          <div id="cmd-reliquat-desc" style="${cm.reliquat?'':'display:none'};margin-top:8px">
            <textarea class="form-input" id="cmd-reliquat-description" rows="2" placeholder="${t('cmd_reliquat_placeholder')||'Décrire le reliquat…'}">${esc(cm.reliquat_description||'')}</textarea>
          </div>
        </div>
        <div style="margin-top:4px;padding-top:14px;border-top:0.5px solid var(--border-s)">
          <div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text2);margin-bottom:10px"><i class="ti ti-receipt-off" style="font-size:15px"></i> ${t('cmd_avoir_titre')||'AVOIR'}</div>
          <div class="grid-2" style="gap:10px;align-items:end">
            <div class="form-group" style="margin:0"><label class="form-label">${t('cmd_avoir_vf_label')||'N° avoir VosFactures'}</label>
              <input class="form-input mono" id="cmd-avoir" value="${esc(cm.num_avoir||'')}" placeholder="AV-2026-...">
            </div>
            <div class="form-group" style="margin:0;display:flex;align-items:flex-end;gap:6px">
              ${cm.num_avoir?`<button class="btn sm" type="button" onclick="ouvrirAvoirVF('${esc(cm.num_avoir)}')" title="Ouvrir l'avoir dans VosFactures"><i class="ti ti-external-link"></i> ${TR("Ouvrir dans VosFactures")}</button>`:`<span style="font-size:14px;color:var(--text3)">${t('cmd_renseigne_avoir')||'Renseigne le N° pour accéder à l\'avoir'}</span>`}
            </div>
          </div>
        </div>
        ${id?`<div style="padding-top:12px;margin-top:12px;border-top:0.5px solid var(--border-s)">
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <button class="btn sm" onclick="chercherFacturesVF(${id},'${esc(cm.num_facture||'')}')" type="button"><i class="ti ti-search"></i> ${t('cmd_chercher_vf_rattacher')||'Chercher une facture VosFactures à rattacher'}</button>
            <button class="btn sm" onclick="chercherFacturesPennylane(${id},'${esc(cm.num_facture_pennylane||'')}')" type="button"><i class="ti ti-search"></i> ${TR('Chercher une facture Pennylane à rattacher')}</button>
          </div>
          <div id="cmd-vf-suggest-list" style="margin-top:10px"></div>
          <div id="cmd-pl-suggest-list" style="margin-top:10px"></div>
        </div>`:''}
      </div>
    </div>
    <div class="modal-footer">
      ${id?`<button class="btn danger" onclick="supprimerCommande(${id})"><i class="ti ti-trash"></i></button>`:''}
      ${id?`<button class="btn sm" onclick="envoyerEmailConfirmation(${id})" title="Demander confirmation BDC"><i class="ti ti-mail"></i> ${t('btn_confirmer_bdc')||'Confirmer'}</button>`:''}
      ${id&&cm.num_suivi&&isRealTracking(cm.num_suivi)?`<button class="btn sm" onclick="envoyerEmailExpedition(${id})" title="Email d'expédition"><i class="ti ti-mail"></i> ${t('btn_email_exped')||'Email expéd.'}</button>`:''}
      ${id&&(cm.statut_calc==='Livré'||cm.statut_calc==='Facturé')?`<button class="btn sm" onclick="genererFactureVF(${id})" title="${TR("Créer la facture dans VosFactures")}"><i class="ti ti-receipt-2"></i> ${TR('Facture VF')}</button>`:''}
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
  setTimeout(()=>{ renderCmdLignes(); renderRetourLignes(); majLienSuiviModal(); majZonePreuveLivraison(); majSerieDemoHint(); if(!id && cm.distributeur_nom) prefillGroupeDepuisDistrib(); }, 60);
}

function toggleDateConfirmation(el){
  const wrap=document.getElementById('cmd-date-confirmation-wrap');
  const inp=document.getElementById('cmd-date-confirmation');
  if(!wrap) return;
  if(el && el.value){
    wrap.style.display='';
    if(inp && !inp.value) inp.value=new Date().toISOString().slice(0,10);
  } else {
    wrap.style.display='none';
  }
}
window.toggleDateConfirmation=toggleDateConfirmation;

function switchCmdTab(tab){
  ['commande','expedition','facturation','notes'].forEach(k=>{
    const panel = document.getElementById('cmd-tab-'+k);
    const btn   = document.getElementById('tab-btn-'+k);
    if(panel) panel.style.display = k===tab ? '' : 'none';
    if(btn){
      btn.style.borderBottom = k===tab ? '2px solid var(--accent)' : '2px solid transparent';
      btn.style.color = k===tab ? 'var(--accent)' : 'var(--text2)';
    }
  });
  if(tab==='expedition') setTimeout(()=>{ majLienSuiviModal(); majZonePreuveLivraison(); renderRetourLignes(); }, 30);
  if(tab==='notes') {
    // Cacher tous les panels et injecter les notes dans un conteneur dédié
    ['commande','expedition','facturation'].forEach(k=>{
      const p = document.getElementById('cmd-tab-'+k);
      if(p) p.style.display='none';
    });
    const cmdId = window._currentCmdId;
    let notesDiv = document.getElementById('cmd-notes-panel');
    if(!notesDiv) {
      notesDiv = document.createElement('div');
      notesDiv.id = 'cmd-notes-panel';
      notesDiv.style.cssText = 'height:370px;overflow:hidden;display:flex;flex-direction:column';
      // Insert after the last visible tab panel
      const factPanel = document.getElementById('cmd-tab-facturation');
      if(factPanel && factPanel.parentNode) factPanel.parentNode.appendChild(notesDiv);
    }
    notesDiv.style.display = '';
    notesDiv.innerHTML = '<div style="padding:20px;color:#aaa;text-align:center">'+TR("Chargement...")+'</div>';
    if(cmdId) renderNotesTab(cmdId).then(function(h){ notesDiv.innerHTML = h; });
  } else {
    // Cacher le panel notes si on revient sur un autre onglet
    const notesDiv = document.getElementById('cmd-notes-panel');
    if(notesDiv) notesDiv.style.display='none';
  }
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
          <i class="ti ${p.mime==='application/pdf'?'ti-file-type-pdf':'ti-photo'}" style="font-size:22px"></i>
          <span style="font-size:15px">${t('cmd_voir_preuve')||'Voir le document'}${taille}</span>
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
  zone.innerHTML=`<div style="font-size:14px;color:var(--text2)"><i class="ti ti-loader-2"></i> ${t('msg_chargement')}</div>`;
  // Utiliser le numéro de facture saisi si disponible
  const numFact = numFacture || gv('cmd-facture') || '';
  const url = `/commandes/${id}/factures-vf-suggestions${numFact?'?num_facture='+encodeURIComponent(numFact):''}`;
  try{
    const r = await API.get(url);
    if(!r.configured){ zone.innerHTML=`<div style="font-size:14px;color:var(--text2)">${t('cmd_vf_non_configure')||'VosFactures non configuré'}</div>`; return; }
    if(r.reason){ zone.innerHTML=`<div style="font-size:14px;color:var(--text2)">${esc(r.reason)}</div>`; return; }
    if(!r.factures||!r.factures.length){ zone.innerHTML=`<div style="font-size:14px;color:var(--text2)">${t('cmd_vf_aucune')||'Aucune facture récente trouvée pour ce distributeur'}</div>`; return; }
    zone.innerHTML=`<div class="form-label" style="margin-bottom:8px">${t('cmd_vf_choisir')||'Choisis la facture correspondante (à confirmer toi-même, aucun lien automatique fiable côté VosFactures) :'}</div>
      <div style="display:flex;flex-direction:column;gap:6px;max-height:220px;overflow:auto">
        ${r.factures.map((f,i)=>{
          window._VF_SUGGEST=window._VF_SUGGEST||{}; window._VF_SUGGEST[i]=f;
          return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border:0.5px solid var(--border-s);border-radius:var(--radius)">
            <div>
              <div style="font-size:15px;font-weight:600">${esc(f.numero||('#'+f.id))} — ${fd(f.date)}</div>
              <div style="font-size:13px;color:var(--text3)">${f.num_serie?('N° série : '+esc(f.num_serie)):(t('cmd_vf_sans_serie')||'Pas de série détectée')}${f.montant_ttc?' · '+parseFloat(f.montant_ttc).toFixed(2)+' €':''}</div>
            </div>
            <button class="btn sm" type="button" onmousedown="appliquerFactureVF(${i})">${t('cmd_vf_utiliser')||'Utiliser'}</button>
          </div>`;
        }).join('')}
      </div>`;
  }catch(e){ zone.innerHTML=`<div style="font-size:14px;color:var(--danger)">${esc(e.message)}</div>`; }
}

function appliquerFactureVF(i){
  const f = (window._VF_SUGGEST||{})[i]; if(!f) return;
  if($('cmd-facture')) $('cmd-facture').value = f.numero || '';
  if(f.num_serie && $('cmd-serie')) $('cmd-serie').value = f.num_serie;
  if($('cmd-facture-vfid')) $('cmd-facture-vfid').value = f.id || '';
  toast(t('cmd_vf_applique')||'Facture rattachée — vérifie puis enregistre');
}

// ── Rattachement d'une facture Pennylane (complément de VosFactures) ─────────
async function chercherFacturesPennylane(id, numFacture){
  const zone=$('cmd-pl-suggest-list'); if(!zone) return;
  zone.innerHTML=`<div style="font-size:14px;color:var(--text2)"><i class="ti ti-loader-2"></i> ${t('msg_chargement')||'Chargement…'}</div>`;
  const numFact = numFacture || gv('cmd-facture-pl') || '';
  const url = `/commandes/${id}/factures-pennylane-suggestions${numFact?'?num_facture='+encodeURIComponent(numFact):''}`;
  try{
    const r = await API.get(url);
    if(!r.configured){ zone.innerHTML=`<div style="font-size:14px;color:var(--text2)">${TR('Pennylane non configuré')}</div>`; return; }
    if(r.reason){ zone.innerHTML=`<div style="font-size:14px;color:var(--text2)">${esc(r.reason)}</div>`; return; }
    if(!r.factures||!r.factures.length){ zone.innerHTML=`<div style="font-size:14px;color:var(--text2)">${TR('Aucune facture Pennylane trouvée pour ce distributeur')}</div>`; return; }
    zone.innerHTML=`<div class="form-label" style="margin-bottom:8px"><i class="ti ti-brand-stripe" style="color:#6772e5"></i> ${TR('Choisis la facture Pennylane correspondante (rattachement manuel) :')}</div>
      <div style="display:flex;flex-direction:column;gap:6px;max-height:220px;overflow:auto">
        ${r.factures.map((f,i)=>{
          window._PL_SUGGEST=window._PL_SUGGEST||{}; window._PL_SUGGEST[i]=f;
          return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border:0.5px solid var(--border-s);border-radius:var(--radius)">
            <div>
              <div style="font-size:15px;font-weight:600">${esc(f.numero||('#'+f.id))}${f.date?' — '+fd((''+f.date).slice(0,10)):''}</div>
              <div style="font-size:13px;color:var(--text3)">${f.distributeur?esc(f.distributeur)+' · ':''}${f.num_serie?('N° série : '+esc(f.num_serie)):(t('cmd_vf_sans_serie')||'Pas de série détectée')}${f.montant_ttc!=null?' · '+parseFloat(f.montant_ttc).toFixed(2)+' €':''}</div>
            </div>
            <button class="btn sm" type="button" onmousedown="appliquerFacturePennylane(${i})">${t('cmd_vf_utiliser')||'Utiliser'}</button>
          </div>`;
        }).join('')}
      </div>`;
  }catch(e){ zone.innerHTML=`<div style="font-size:14px;color:var(--danger)">${esc(e.message)}</div>`; }
}

function appliquerFacturePennylane(i){
  const f = (window._PL_SUGGEST||{})[i]; if(!f) return;
  if($('cmd-facture-pl')) $('cmd-facture-pl').value = f.numero || '';
  if(f.num_serie && $('cmd-serie') && !gv('cmd-serie')) $('cmd-serie').value = f.num_serie;
  if(typeof majStatutBadge==='function') majStatutBadge();
  toast(t('cmd_vf_applique')||'Facture rattachée — vérifie puis enregistre');
}
window.chercherFacturesPennylane=chercherFacturesPennylane;
window.appliquerFacturePennylane=appliquerFacturePennylane;

async function lookupBdcVF(){
  const numero = gv('cmd-bdc').trim();
  if(!numero){ toast(t('cmd_bdc_requis')||'Indique d\u2019abord un n° de bon de commande','ti-alert-circle','var(--danger)'); return; }
  toast(TR('Recherche du bon de commande (Pennylane / VosFactures)…'),'ti-loader-2');
  try{
    // On tente d'abord Pennylane, puis VosFactures en repli
    let r=null, src='vf';
    try{ const pl=await API.pennylane_bdc_lookup(numero); if(pl && pl.found){ r=pl; src='pennylane'; } }catch(_){}
    if(!r){ r = await API.vfBdcLookup(numero); src='vf'; }
    if(r && r.configured===false){ toast('Aucun système (Pennylane / VosFactures) configuré','ti-alert-circle','var(--danger)'); return; }
    if(!r || !r.found){ toast(TR('Bon de commande introuvable (Pennylane / VosFactures)'),'ti-alert-circle','var(--danger)'); return; }
    // Mémorise la source + l'identifiant de pièce pour le bouton « Ouvrir »
    if($('cmd-bdc-source')) $('cmd-bdc-source').value = src;
    if($('cmd-bdc-docid') && r.vf_id!=null) $('cmd-bdc-docid').value = String(r.vf_id);
    let remplis = [];
    if(r.distributeur && $('cmd-distrib') && !gv('cmd-distrib')){ $('cmd-distrib').value=r.distributeur; remplis.push('distributeur'); prefillGroupeDepuisDistrib(); }
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
    el.innerHTML=`<div style="font-size:14px;color:var(--text3);padding:6px 0">${t('cmd_retour_articles_empty')||'Aucun article retourné — cliquez "+ Ajouter"'}</div>`;
    return;
  }
  el.innerHTML=`<table style="width:100%;border-collapse:collapse;font-size:14px">
    <thead><tr style="background:var(--bg)">
      <th style="padding:4px 8px;text-align:left;color:var(--text2);font-weight:600">${t('col_designation_court')||'Désignation'}</th>
      <th style="padding:4px 8px;text-align:left;color:var(--text2);font-weight:600;width:120px">${t('col_ref_short')||'Référence'}</th>
      <th style="padding:4px 8px;text-align:center;color:var(--text2);font-weight:600;width:55px">${t('col_qte')||'Qté'}</th>
      <th style="width:28px"></th>
    </tr></thead>
    <tbody>${TMP_RETOUR_LIGNES.map((l,i)=>`<tr style="${i%2===0?'background:var(--surface)':'background:var(--bg)'}">
      <td style="padding:3px 6px"><input class="form-input" style="font-size:14px;padding:3px 7px" value="${esc(l.designation)}" oninput="TMP_RETOUR_LIGNES[${i}].designation=this.value" placeholder="${TR("Désignation *")}"></td>
      <td style="padding:3px 6px"><input class="form-input mono" style="font-size:13px;padding:3px 7px" value="${esc(l.reference||'')}" oninput="TMP_RETOUR_LIGNES[${i}].reference=this.value" placeholder="${TR("Réf.")}"></td>
      <td style="padding:3px 6px"><input class="form-input" type="number" min="1" style="font-size:14px;padding:3px 7px;text-align:center" value="${l.quantite||1}" oninput="TMP_RETOUR_LIGNES[${i}].quantite=parseInt(this.value)||1"></td>
      <td style="padding:3px 2px"><button class="btn sm danger" onclick="TMP_RETOUR_LIGNES.splice(${i},1);renderRetourLignes()" style="padding:3px 5px"><i class="ti ti-x"></i></button></td>
    </tr>`).join('')}</tbody>
  </table>`;
}
function addRetourLigne(){ TMP_RETOUR_LIGNES.push({designation:'',reference:'',quantite:1}); renderRetourLignes();
  setTimeout(()=>{ const r=document.querySelectorAll('#cmd-retour-lignes-list input'); r[r.length-3]?.focus(); },50); }

async function lookupBordereauVF(){
  const numero = gv('cmd-bordereau').trim();
  if(!numero){ toast('Indique d\u2019abord un N° de bordereau','ti-alert-circle','var(--danger)'); return; }
  toast(TR('Recherche dans VosFactures…'),'ti-loader-2');
  try{
    const r = await API.vfBdcLookup(numero);
    if(!r.configured){ toast(TR('VosFactures non configuré'),'ti-alert-circle','var(--danger)'); return; }
    if(!r.found){ toast(TR('Bordereau introuvable dans VosFactures'),'ti-alert-circle','var(--danger)'); return; }
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

// Récupère le nom du compte VosFactures (pour construire les liens), en le
// chargeant à la volée si le boot ne l'a pas encore mis en cache.
async function vfAccount(){
  if(window._VF_ACCOUNT) return window._VF_ACCOUNT;
  try{ const s = await API.vfStatus(); if(s && s.account){ window._VF_ACCOUNT = s.account; return s.account; } }catch(_){}
  return null;
}
window.vfAccount = vfAccount;

async function ouvrirAvoirVF(num){
  const account = await vfAccount();
  if(!account){ toast(TR('Compte VosFactures non configuré'),'ti-alert-circle','var(--warning)'); return; }
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
  if(el) el.innerHTML = '<span style="font-size:13px;color:var(--text2)"><i class="ti ti-loader-2"></i> '+TR("Chargement du suivi…")+'</span>';
  try{
    const r = await API.tracking(numero);
    if(!el) return;
    if(!r.found){
      const lien = r.lien ? `<a href="${r.lien}" target="_blank" rel="noopener" class="btn sm" style="margin-top:4px">
        <i class="ti ti-external-link"></i> Suivre sur ${esc(r.transporteur||'le site')}
      </a>` : '';
      el.innerHTML = `<div style="font-size:13px;color:var(--text3)">${r.message||'Suivi non disponible'} ${lien}</div>`;
      return;
    }
    const events = r.events||[];
    el.innerHTML = `<div style="background:rgba(255,255,255,.55);border:0.5px solid var(--border);border-radius:10px;padding:10px 12px;margin-top:4px">
      <div style="font-size:13px;font-weight:700;margin-bottom:6px;display:flex;align-items:center;gap:6px">
        <span class="badge ${r.statut==='Livré'?'g':r.statut==='Problème'?'urgent':'attente'}">${r.statut||'En cours'}</span>
        <span style="color:var(--text2)">${esc(r.transporteur||'')}</span>
      </div>
      <div style="font-size:13px;max-height:160px;overflow-y:auto">
        ${events.slice(0,5).map(e=>`<div style="padding:3px 0;border-bottom:0.5px solid var(--border);display:flex;gap:8px">
          <span style="color:var(--text3);white-space:nowrap">${e.date?e.date.slice(0,10):''}</span>
          <span>${esc(e.label||'')}</span>
          ${e.lieu?`<span style="color:var(--text3)">${esc(e.lieu)}</span>`:''}
        </div>`).join('')}
      </div>
    </div>`;
  }catch(e){
    if(el) el.innerHTML = `<span style="font-size:13px;color:var(--danger)">${esc(e.message)}</span>`;
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

// Astuce n° de série : visible tant qu'un fauteuil démo n'a pas de série renseignée.
function majSerieDemoHint(){
  const hint = document.getElementById('cmd-serie-demo-hint');
  if(!hint) return;
  const demo = !!document.getElementById('cmd-type-fauteuil-demo')?.checked;
  const serie = (document.getElementById('cmd-serie')?.value||'').trim();
  hint.style.display = (demo && !serie) ? '' : 'none';
}
window.majSerieDemoHint = majSerieDemoHint;

function renderTopbarPays(){
  const el = document.getElementById('pays-switcher');
  if(!el) return;
  // Visible uniquement pour les admins globaux (sans pays fixé sur le compte)
  if(!isAdmin() || CURRENT_USER.pays){ el.innerHTML=''; return; }
  // Pays actifs (ceux qui ont des commandes, pour l'instant la liste configurée)
  const actifs = PAYS_LIST.filter(p => ['','France','Sweden'].includes(p.code));
  el.innerHTML = actifs.map(p=>`
    <button onclick="setPaysFiltre('${p.code}')" title="${p.label}" style="
      padding:3px 8px;border:none;border-radius:12px;cursor:pointer;font-size:14px;
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

function clientFinalBadge(cm) {
  const t = cm.client_final_type;
  const icon = t==='particulier' ? '🏠' : t==='entreprise' ? '🏢' : '👤';
  const bg   = t==='particulier' ? 'rgba(124,58,237,.12)' : t==='entreprise' ? 'rgba(16,185,129,.12)' : 'rgba(46,124,246,.12)';
  const col  = t==='particulier' ? '#7c3aed' : t==='entreprise' ? '#059669' : '#2e7cf6';
  return '<span title="'+esc(cm.client_final)+'" style="display:inline-flex;align-items:center;gap:3px;background:'+bg+';color:'+col+';border-radius:99px;padding:1px 6px;font-size:12px;font-weight:600">'+icon+' '+esc(cm.client_final)+'</span>';
}

const STATUTS_LISTE = ['Auto','En préparation','Expédié','Livré','Facturé','Payé','Impayé','Avoir','Problème','Annulé'];

function toggleStatutMenu(e, id, statutActuel){
  // Fermer tout menu ouvert
  document.querySelectorAll('.statut-menu').forEach(m => m.remove());
  const menu = document.createElement('div');
  menu.className = 'statut-menu';
  menu.style.cssText = `position:fixed;z-index:9999;background:#fff;border:0.5px solid rgba(100,150,200,.30);border-radius:12px;box-shadow:0 8px 32px rgba(80,130,200,.20),0 1px 0 rgba(255,255,255,.9) inset;padding:4px 0;min-width:160px`;
  menu.innerHTML = STATUTS_LISTE.map(s => `
    <div onclick="changerStatutCommande(${id},'${s}');this.closest('.statut-menu').remove()"
      style="padding:7px 14px;cursor:pointer;font-size:15px;${s===statutActuel?'font-weight:700;color:var(--accent)':''}
      display:flex;align-items:center;gap:8px" class="statut-option">
      ${s===statutActuel?'<i class="ti ti-check" style="font-size:14px"></i>':'<span style="width:12px"></span>'}
      <span class="badge ${s==='Auto'?'ouvert':cmdStatutClass(s)}" style="font-size:13px">${tStatut(s)||s}</span>
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
    bdc_source: gv('cmd-bdc-source')||null, bdc_doc_id: gv('cmd-bdc-docid')||null,
    // Client final : priorité au champ bénéficiaire édité ; le nom du bloc livraison
    // n'est utilisé que si une adresse distincte est réellement choisie (type non vide).
    // Évite que l'ancien nom (caché) ne « revienne » après suppression.
    client_final: gv('cmd-clientfinal') || (gv('cmd-clientfinal-type') ? gv('cf-nom') : ''),
    client_final_type: gv('cmd-clientfinal-type')||null,
    cf_nom: gv('cmd-clientfinal-type') ? (gv('cf-nom')||null) : null,
    cf_prenom: gv('cmd-clientfinal-type') ? (gv('cf-prenom')||null) : null,
    cf_adresse: gv('cmd-clientfinal-type') ? (gv('cf-adresse')||null) : null,
    cf_cp: gv('cmd-clientfinal-type') ? (gv('cf-cp')||null) : null,
    cf_ville: gv('cmd-clientfinal-type') ? (gv('cf-ville')||null) : null,
    cf_tel: gv('cmd-clientfinal-type') ? (gv('cf-tel')||null) : null,
    cf_email: gv('cmd-clientfinal-type') ? (gv('cf-email')||null) : null,
    num_suivi: gv('cmd-suivi'), transporteur: gv('cmd-transporteur')||null,
    date_livraison: gv('cmd-livraison')||null, num_bordereau: gv('cmd-bordereau')||null,
    num_serie: gv('cmd-serie'), num_facture: gv('cmd-facture'), statut: gv('cmd-statut'),
    facture_vf_id: gv('cmd-facture-vfid')||null,
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
    date_confirmation: document.querySelector('input[name="cmd-confirmation-mode"]:checked')?.value ? (gv('cmd-date-confirmation') || window._CMD_CONF_DATE || new Date().toISOString().slice(0,10)) : null,
    num_avoir: gv('cmd-avoir')||null,
    num_facture_pennylane: gv('cmd-facture-pl')||null,
    pays: gv('cmd-pays')||CURRENT_USER.pays||'France',
  };
  // Si une proposition a été sélectionnée dans l'autocomplétion, on rattache à la fiche exacte
  const _cid = parseInt(gv('cmd-client-id'))||null; if(_cid) d.client_id = _cid;
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
    ${isAdmin()?'<button class="btn" onclick="importerVFIds()" title="Lier IDs VosFactures"><i class="ti ti-plug-connected"></i> Lier VF</button>':''}
    <label style="display:flex;align-items:center;gap:6px;font-size:14px;cursor:pointer;margin-left:8px;color:var(--text2)" title="Afficher le prix d'achat fournisseur (Eloflex AB)">
      <input type="checkbox" id="cat-show-price" ${localStorage.getItem('sav_show_prix_achat')==='1'?'checked':''} onchange="localStorage.setItem('sav_show_prix_achat',this.checked?'1':'0');document.getElementById('cat-table')?.classList.toggle('show-prix',this.checked)">
      Prix achat 🇸🇪
    </label>
  </div>`;
  document.getElementById('cat-search')?.addEventListener('input', e => {
    STATE.q = e.target.value;
    clearTimeout(window._CAT); window._CAT = setTimeout(() => chargerListeCatalogue(), 250);
  });
  c.innerHTML=`<div id="catalogue-list-body"><div style="color:var(--text2);font-size:15px;padding:20px 0">${t('msg_chargement')}</div></div>`;
  chargerListeCatalogue();
}

let _catalogueReqId = 0;
async function chargerListeCatalogue(){
  const el = document.getElementById('catalogue-list-body'); if(!el) return;
  const reqId = ++_catalogueReqId;
  const list = await API.catalogue(STATE.q);
  if(reqId !== _catalogueReqId) return;
  CACHE.catalogue = list;
  el.innerHTML=`<div class="table-wrap"><table id="cat-table" class="t ${localStorage.getItem('sav_show_prix_achat')==='1'?'show-prix':''}">
    <thead><tr><th>${t('col_ref')}</th><th>${t('col_designation')}</th><th>${t('col_fournisseur')}</th><th>${t('col_ref_fou')}</th><th class="col-prix">${t('col_prix')}</th><th>${t('col_stock')}</th><th>${t('col_seuil')}</th><th style="width:40px">VF</th></tr></thead>
    <tbody>${list.map(p=>`<tr onclick="modalPiece(${p.id})">
      <td class="mono">${esc(p.ref)}</td><td>${esc(p.designation)}</td>
      <td style="color:var(--text3)">${esc(p.fournisseur||'')}</td>
      <td class="mono">${esc(p.ref_fournisseur||'')}</td>
      <td class="col-prix" style="font-weight:700">${parseFloat(p.pxht||0).toFixed(2)} €</td>
      <td><span class="badge ${p.stock===0?'urgent':p.stock<=p.stock_alerte?'attente':'g'}">${p.stock}</span></td>
      <td style="font-size:13px;color:var(--text3)">${p.stock_alerte}</td>
      <td style="text-align:center">${p.vf_product_id?`<a href="https://eloflex.vosfactures.fr/products/${p.vf_product_id}" target="_blank" onclick="event.stopPropagation()" title="${TR("Voir sur VosFactures")}" style="color:var(--accent);font-size:15px"><i class="ti ti-external-link"></i></a>`:'—'}</td>
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
        <div class="form-group"><label class="form-label">${TR('Période')}</label>
          <div class="grid-2"><input class="form-input" id="exp-from" type="date"><input class="form-input" id="exp-to" type="date"></div>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;margin-top:4px">
          <button class="btn success" onclick="exportExcel('interventions')"><i class="ti ti-tool"></i>Interventions</button>
          <button class="btn success" onclick="exportExcel('catalogue')"><i class="ti ti-box"></i>${TR('Catalogue pièces')}</button>
          <button class="btn success" onclick="exportExcel('clients')"><i class="ti ti-users"></i>Clients</button>
          <button class="btn primary" onclick="exportExcel('complet')"><i class="ti ti-file-zip"></i>Export complet (tous les onglets)</button>
        </div>
      </div>
      <div class="card">
        <div class="section-title"><i class="ti ti-file-type-pdf"></i>Export PDF</div>
        <div style="display:flex;flex-direction:column;gap:8px">
          <div style="font-size:14px;color:var(--text2)">${TR('Les PDF se génèrent depuis chaque fiche client, fauteuil ou intervention via le bouton PDF correspondant.')}</div>
          <div class="divider"></div>
          <div class="section-title"><i class="ti ti-filter"></i>Filtres interventions</div>
          <div class="form-group"><label class="form-label">${TR('Statut')}</label>
            <select class="form-input" id="r-statut"><option value="">Tous</option><option>Ouvert</option><option>En attente</option><option>${TR('Fermé')}</option></select>
          </div>
          <div class="form-group"><label class="form-label">Garantie</label>
            <select class="form-input" id="r-garantie"><option value="">Tous</option><option value="1">Sous garantie</option><option value="0">Hors garantie</option></select>
          </div>
          <button class="btn success" onclick="exportExcelFiltre()"><i class="ti ti-file-spreadsheet"></i>${TR('Export filtré')}</button>
        </div>
      </div>
    </div>`;
}

function exportExcel(type){
  API.exportExcel(type,{date_from:gv('exp-from')||undefined, date_to:gv('exp-to')||undefined});
  toast(TR('Téléchargement en cours…'),'ti-download');
}
function exportExcelFiltre(){
  const params={};
  const s=gv('r-statut'); if(s) params.statut=s;
  const g=gv('r-garantie'); if(g!=='') params.garantie=g;
  API.exportExcel('interventions',params);
  toast(TR('Téléchargement en cours…'),'ti-download');
}

// ── ALERTES ───────────────────────────────────────────────────────

async function renderAlertes(ttl,c,a){
  ttl.textContent=t('alertes_title');
  a.innerHTML=`<button class="btn" onclick="API.marquerToutesLues().then(()=>{refreshBadges();render();})"><i class="ti ti-checks"></i>${t('alertes_tout_lire')}</button>`;
  const [list, demos] = await Promise.all([API.alertes(), API.demosSuivi().catch(()=>[])]);
  const icons={relance:'ti-clock',retour_manquant:'ti-truck-return',garantie_expire:'ti-shield-x',stock_faible:'ti-alert-triangle',stock_zero:'ti-circle-x',intervention_fermee:'ti-circle-check',demo_rappel:'ti-wheelchair'};
  const colors={relance:'var(--warning)',retour_manquant:'var(--accent)',garantie_expire:'var(--danger)',stock_faible:'var(--warning)',stock_zero:'var(--danger)',intervention_fermee:'var(--success)',demo_rappel:'var(--warning)'};
  const demosHtml = (demos&&demos.length) ? `<div class="card" style="margin-bottom:14px">
      <div class="section-title" style="margin-bottom:10px"><i class="ti ti-wheelchair"></i> Démos à suivre (${demos.length})</div>
      <div class="table-wrap"><table class="t">
        <thead><tr><th>${TR('Distributeur')}</th><th>${TR('Modèle / Série')}</th><th>${TR('Livraison')}</th><th>Rappel</th><th>${TR('Retour / Prolonger / Facturer')}</th></tr></thead>
        <tbody>${demos.map(d=>`<tr>
          <td>${esc(d.client_nom||d.distributeur_nom)}${d.client_ville?` <span style="color:var(--text3);font-size:13px">${esc(d.client_ville)}</span>`:''}</td>
          <td>${esc(d.modele||'')} ${d.num_serie?`<span class="mono" style="font-size:13px;color:var(--text3)">${esc(d.num_serie)}</span>`:''}</td>
          <td style="font-size:14px">${esc(d.date_livraison||'—')}</td>
          <td><span class="badge ${d.du?'urgent':'hg'}" style="font-size:13px">${esc(d.demo_rappel_date)}${d.du?' ⚠':''}</span></td>
          <td style="white-space:nowrap">
            <button class="btn sm" onclick="demoCloturer(${d.id},'retour')" title="${TR("Retour organisé")}"><i class="ti ti-truck-return"></i></button>
            <button class="btn sm" onclick="demoProlonger(${d.id},'${d.demo_rappel_date}')" title="Prolonger le rappel"><i class="ti ti-calendar-plus"></i></button>
            <button class="btn sm success" onclick="demoCloturer(${d.id},'facture')" title="${TR("Facturé / vendu")}"><i class="ti ti-file-euro"></i></button>
            <button class="btn sm" onclick="demoCloturer(${d.id},'avoir')" title="${TR("Clôturer en avoir (annulation)")}"><i class="ti ti-receipt-refund"></i></button>
          </td></tr>`).join('')}</tbody>
      </table></div>
    </div>` : '';
  c.innerHTML=demosHtml + (list.length===0?`<div class="empty"><i class="ti ti-bell-off"></i>${t('alertes_empty')}</div>`:
    `<div class="card">${list.map(al=>`
      <div class="alerte-row">
        <div class="alerte-icon" style="background:${colors[al.type]||'var(--accent)'}20;color:${colors[al.type]||'var(--accent)'}">
          <i class="ti ${icons[al.type]||'ti-bell'}"></i>
        </div>
        <div style="flex:1">
          <div style="font-size:15px">${esc(al.message)}</div>
          <div style="font-size:13px;color:var(--text3);margin-top:2px">${al.created_at?.slice(0,16).replace('T',' ')}</div>
        </div>
        <button class="btn sm" onclick="API.marquerAlerteLue(${al.id}).then(()=>{refreshBadges();render();})"><i class="ti ti-x"></i></button>
      </div>`).join('')}</div>`);
}

async function demoProlonger(id, cur){
  const d = prompt(TR('Nouvelle date de rappel (AAAA-MM-JJ) :'), cur||'');
  if(!d) return;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(d.trim())){ alert('Format attendu : AAAA-MM-JJ'); return; }
  try{ await API.demoProlonger(id, d.trim()); toast(TR('Rappel prolongé au ')+d.trim(),'ti-calendar-plus'); refreshBadges(); render(); }catch(e){ alert(e.message); }
}
async function demoCloturer(id, resultat){
  const lbl = resultat==='facture' ? TR('vendue / facturée')
            : resultat==='avoir'   ? TR('annulée par avoir')
            : TR('de retour à Éloflex France');
  const suite = resultat==='facture' ? TR('Elle sort du parc démo (conservée dans le Suivi commandes).')
              : resultat==='avoir'   ? TR('Elle sort du parc démo (annulation) et n’apparaît plus que dans l’Historique.')
              : TR('Elle reste dans le parc, marquée « Disponible » pour un autre essai.');
  if(!confirm(TR('Marquer cette démo comme ')+lbl+' ? '+suite)) return;
  const okMsg = resultat==='facture' ? TR('Démo marquée vendue')
              : resultat==='avoir'   ? TR('Démo clôturée par avoir')
              : TR('Démo de retour — disponible');
  try{ await API.demoCloturer(id, resultat); toast(okMsg,'ti-check'); refreshBadges(); render(); }catch(e){ alert(e.message); }
}
window.demoProlonger=demoProlonger; window.demoCloturer=demoCloturer;
async function reserverDemoRetour(id, prefill){
  const nom = prompt(TR('Réserver cette unité, à son retour, pour quel distributeur ? (videz le champ pour retirer la réservation)'), prefill||'');
  if(nom===null) return;                       // annulé
  const v = nom.trim();
  try{ await API.demoReserver(id, v); toast(v?TR('Réservé au retour pour ')+v:TR('Réservation retirée'),'ti-bookmark'); render(); }catch(e){ alert(e.message); }
}
window.reserverDemoRetour=reserverDemoRetour;

// ── PARAMÈTRES ────────────────────────────────────────────────────

async function renderParametres(ttl,c,a){
  ttl.textContent=t('param_title');
  a.innerHTML=`<button class="btn primary" onclick="saveParametres()"><i class="ti ti-check"></i>${t('btn_enregistrer')}</button>`;
  const p=await API.parametres();
  CACHE.params=p;
  setTimeout(chargerResumeSauvegarde, 50);
  c.innerHTML=`
    <div class="param-section">
      <h3><i class="ti ti-database-export"></i>${TR('Sauvegarde de la base')}</h3>
      <div style="font-size:14px;color:var(--text2);margin-bottom:12px">
        L'ensemble des données (commandes, clients, interventions, notes, points de carte…) dans un fichier unique.
        Une sauvegarde compressée part automatiquement vers info@eloflex.fr chaque lundi.
        Les mots de passe n'y figurent pas.
      </div>
      <div id="sauvegarde-resume" style="font-size:14px;color:var(--text3);margin-bottom:12px">${TR("Chargement…")}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <a class="btn primary" href="/api/sauvegarde/export" download><i class="ti ti-download"></i>${TR('Télécharger la sauvegarde')}</a>
        <button class="btn" onclick="envoyerSauvegardeMaintenant(this)"><i class="ti ti-mail-forward"></i>${TR('Envoyer par courriel')}</button>
      </div>
      <div style="margin-top:16px;padding-top:14px;border-top:0.5px solid var(--border)">
        <div style="font-size:15px;font-weight:600;margin-bottom:4px"><i class="ti ti-database-import"></i> ${TR('Restaurer une sauvegarde')}</div>
        <div style="font-size:14px;color:var(--danger);margin-bottom:8px">${TR('⚠ Remplace TOUTES les données actuelles par celles du fichier. À utiliser sur une base vide ou pour restaurer après incident. Accepte les fichiers .json et .json.gz.')}</div>
        <input type="file" id="restore-file" accept=".json,.gz,application/json,application/gzip" style="font-size:14px">
        <button class="btn danger" onclick="restaurerSauvegarde(this)" style="margin-left:8px"><i class="ti ti-upload"></i>${TR('Restaurer')}</button>
        <div id="restore-result" style="font-size:14px;margin-top:8px"></div>
      </div>
    </div>
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
      <div style="font-size:14px;color:var(--text2);margin-bottom:10px">${t('param_email_hint')}</div>
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
        <div class="form-group" style="grid-column:1/-1"><label class="form-label">${t('param_email_from')}</label><input class="form-input" id="p-email-from" placeholder="SAV Eloflex <sav@eloflex.fr>" value="${esc(p.email_from||'')}"></div>
        <div class="form-group"><label class="form-label">${TR('CC — Emails SAV (confirmations, expéditions)')}</label><input class="form-input" id="p-email-cc-sav" placeholder="sav@eloflex.fr" value="${esc(p.email_cc_sav||'sav@eloflex.fr')}"></div>
        <div class="form-group"><label class="form-label">${TR("CC — Emails relances devis & BDC")}</label><input class="form-input" id="p-email-cc-relance" placeholder="info@eloflex.fr" value="${esc(p.email_cc_relance||'info@eloflex.fr')}"></div>
      </div>
    </div>
    <div class="param-section">
      <h3><i class="ti ti-mail"></i> ${TR('Email relances devis (compte séparé)')}</h3>
      <div style="font-size:14px;color:var(--text2);margin-bottom:10px">${TR('Utilisé pour les relances devis et BDC commercial. Laissez vide pour utiliser le même compte que SAV.')}</div>
      <div class="grid-2">
        <div class="form-group" style="grid-column:1/-1"><label class="form-label">${TR('Expéditeur relances')}</label><input class="form-input" id="p-email-from-relance" placeholder="info@eloflex.fr" value="${esc(p.email_from_relance||p.email_from||'')}"></div>
        <div class="form-group"><label class="form-label">Utilisateur SMTP relances</label><input class="form-input" id="p-smtp-user-relance" placeholder="${TR("Même que SAV si vide")}" value="${esc(p.email_smtp_user_relance||'')}"></div>
        <div class="form-group"><label class="form-label">Mot de passe SMTP relances</label><input class="form-input" type="password" autocomplete="new-password" id="p-smtp-pass-relance" placeholder="${TR("Même que SAV si vide")}" value="${esc(p.email_smtp_pass_relance||'')}"></div>
      </div>
    </div>
    <div class="param-section">
      <h3><i class="ti ti-building"></i>${t('param_societe')}</h3>
      <div class="form-group"><label class="form-label">${t('param_nom_societe')}</label>
        <input class="form-input" id="p-societe" value="${esc(p.nom_societe||'Eloflex France')}"></div>
    </div>
    <div class="param-section">
      <h3><i class="ti ti-globe"></i>${t('param_portail')}</h3>
      <div class="form-group"><label class="form-label">${t('param_portail')}</label>
        <select class="form-input" id="p-portail"><option value="1" ${p.portail_actif==='1'?'selected':''}>${t('param_portail_on')}</option><option value="0" ${p.portail_actif!=='1'?'selected':''}>${t('param_portail_off')}</option></select>
      </div>
      <div style="font-size:14px;color:var(--text2)">${t('param_portail_hint')}</div>
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
          <button class="btn ${LANG==='fr'?'primary':''}" id="btn-lang-fr" onclick="switchLang('fr')" style="min-width:90px">${TR('🇫🇷 Français')}</button>
          <button class="btn ${LANG==='en'?'primary':''}" id="btn-lang-en" onclick="switchLang('en')" style="min-width:90px">🇬🇧 English</button>
        </div>
      </div>
    </div>
    <div class="param-section">
      <h3><i class="ti ti-file-import"></i>${t('param_import_title')}</h3>
      <div style="font-size:14px;color:var(--text2);margin-bottom:8px">${t('param_import_hint')}</div>
      <label class="btn" style="cursor:pointer;display:inline-flex;align-items:center;gap:6px">
        <i class="ti ti-file-import"></i>${t('param_import_choose')}
        <input type="file" accept=".xlsx,.xls" style="display:none" onchange="importerExcel(this.files[0])">
      </label>
      <div id="qs-import-progress" style="display:none;margin-top:10px"></div>
    </div>
    <div class="param-section">
      <h3><i class="ti ti-refresh"></i>${t('param_vf')}</h3>
      <div class="form-group"><label class="form-label">${t('param_vf_status')}</label>
        <div id="vf-status-detail" style="font-size:14px;color:var(--text2)">${t('param_vf_checking')}</div>
      </div>
      <button class="btn" onclick="syncVosFactures()"><i class="ti ti-refresh"></i>${t('param_vf_sync')}</button>
    </div>
    <div class="param-section">
      <h3><i class="ti ti-link"></i> Rattrapage VosFactures</h3>
      <p style="font-size:14px;color:var(--text2);margin-bottom:10px">
        Parcourt toutes les commandes ayant un n° de BDC ou de facture, retrouve le document VosFactures correspondant
        (y compris les anciens, ex. 2021), puis enregistre le <b>lien</b>, le <b>${TR("statut de paiement")}</b> et les
        <b>infos manquantes</b> (série, modèle, date). Écritures sûres : rien n'est écrasé, seuls les champs vides sont
        complétés. À lancer par exemple après un gros import. Garde l'onglet ouvert pendant le traitement (quelques minutes).
      </p>
      <button class="btn primary" id="btn-rattrapage-vf" onclick="lancerRattrapageVF()"><i class="ti ti-link"></i> Lancer le rattrapage</button>
      <div id="rattrapage-vf-result" style="margin-top:10px"></div>
    </div>
    <div class="param-section">
      <h3><i class="ti ti-brand-stripe"></i> Pennylane <span id="pl-status-badge" style="font-size:13px;margin-left:8px"></span></h3>
      <p style="font-size:14px;color:var(--text2);margin-bottom:10px">
        Intégration Pennylane V2 — parallèle à VosFactures.<br>
        Configure la variable d'environnement <code>PENNYLANE_API_KEY</code> dans Render (Environment) avec ton token API Pennylane.
      </p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" onclick="syncPennylane(false)"><i class="ti ti-refresh"></i> Sync Pennylane (90j)</button>
        <button class="btn" onclick="syncPennylane(true)"><i class="ti ti-history"></i> ${TR("Sync historique complet")}</button>
      </div>
      <div id="pl-sync-result" style="margin-top:8px"></div>
    </div>
    <div class="param-section">
      <h3><i class="ti ti-copy"></i> Doublons de commandes</h3>
      <p style="font-size:14px;color:var(--text2);margin-bottom:10px">${TR('Commandes ayant le même numéro de BDC ou devis pour le même distributeur.')}</p>
      <button class="btn danger" onclick="supprimerTousDoublons()" id="btn-suppr-doublons"><i class="ti ti-trash"></i> ${TR('Supprimer tous les doublons')}</button>
      <div id="param-doublons-list" style="margin-top:10px"><div style="font-size:14px;color:var(--text2)"><i class="ti ti-loader-2"></i> ${TR("Chargement…")}</div></div>
    </div>
    <div class="param-section">
      <h3><i class="ti ti-clock-exclamation"></i> ${TR('Commandes bloquées')}</h3>
      <p style="font-size:14px;color:var(--text2);margin-bottom:10px">${TR("Commandes \"En préparation\" sans numéro de suivi valide depuis plus de :")}</p>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
        <select class="form-input" id="blocage-seuil" style="width:auto" onchange="chargerAlertesBlocage()">
          <option value="3">3 jours</option>
          <option value="7" selected>7 jours</option>
          <option value="14">14 jours</option>
          <option value="30">30 jours</option>
        </select>
        <button class="btn sm" onclick="chargerAlertesBlocage()"><i class="ti ti-refresh"></i> Actualiser</button>
      </div>
      <div id="alertes-blocage-list"><div style="font-size:14px;color:var(--text2)"><i class="ti ti-loader-2"></i> ${TR("Chargement…")}</div></div>
    </div>
    <div class="param-section">
      <h3><i class="ti ti-receipt-2"></i> ${TR("Migration facturation historique")}</h3>
      <p style="font-size:14px;color:var(--text2);margin-bottom:10px">
        Passe toutes les commandes antérieures à juin 2026 (hors Annulé et déjà Facturé) au statut <b>${TR('Facturé')}</b>.<br>
        <span style="color:var(--danger);font-size:13px">${TR("⚠ Action irréversible — à n'exécuter qu'une seule fois.")}</span>
      </p>
      <button class="btn" onclick="lancerMigrationFacture()" id="btn-migration-facture"><i class="ti ti-check"></i> ${TR("Passer l'historique en Facturé")}</button>
      <div id="migration-facture-result" style="margin-top:8px"></div>
    </div>
    <div class="param-section">
      <h3><i class="ti ti-database-export"></i> Nettoyage N° suivi</h3>
      <p style="font-size:14px;color:var(--text2);margin-bottom:10px">${TR("Migre les valeurs texte (\"RETOUR BRICE\", \"SUÈDE\", \"ATTENTE VALIDATION\"…) stockées dans le champ N° suivi vers les champs appropriés : retours → N° retour, autres → Informations.")}</p>
      <button class="btn" onclick="lancerMigrationSuivi()"><i class="ti ti-arrow-merge"></i> Lancer la migration</button>
      <div id="migration-suivi-result" style="margin-top:8px"></div>
    </div>
      <p style="font-size:14px;color:var(--text2);margin-bottom:12px">
        Importe toutes les commandes de ton fichier Excel (onglets 2019, 2020… 2026) sans avoir besoin du terminal.
        L'import est idempotent : relancer ne crée pas de doublons.
      </p>
      <label class="btn" style="cursor:pointer;display:inline-flex">
        <i class="ti ti-upload"></i> Choisir le fichier Excel comptabilité…
        <input type="file" accept=".xlsx,.xls" style="display:none" onchange="importerHistoriqueCommandes(this.files[0])">
      </label>
      <div id="import-commandes-result" style="margin-top:10px"></div>
    </div>`;
  API.vfStatus().then(s=>{const el=$('vf-status-detail');if(el)el.innerHTML=s.configured?`<span style="color:var(--success)">✓ Compte configuré : ${esc(s.account||'')}${s.last_sync?' — Dernière sync : '+s.last_sync.created_at?.slice(0,16).replace('T',' '):''}</span>`:`<span style="color:var(--danger)">${TR('⚠ Non configuré — renseigner VOSFACTURES_API_TOKEN et VOSFACTURES_ACCOUNT dans .env')}</span>`;}).catch(()=>{});

  // Section utilisateurs — toujours affichée dans Paramètres (la route /parametres est déjà adminOnly)
  const usersSection = document.createElement('div');
  usersSection.className = 'param-section';
  usersSection.id = 'section-utilisateurs';
  usersSection.innerHTML = `
    <h3><i class="ti ti-users-group"></i> ${TR('Utilisateurs & accès')}</h3>
    <div id="users-list-wrap" style="margin-bottom:14px"><div style="font-size:14px;color:var(--text2)"><i class="ti ti-loader-2"></i> ${TR("Chargement…")}</div></div>
    <button class="btn primary" onclick="modalNouvelUtilisateur()"><i class="ti ti-user-plus"></i> ${TR('Ajouter un utilisateur')}</button>`;
  c.appendChild(usersSection);
  chargerListeUtilisateurs();
  chargerAlertesBlocage();
  chargerDoublonsParametres();
  loadPennylaneStatus();
}

async function chargerListeUtilisateurs(){
  const wrap = $('users-list-wrap'); if(!wrap) return;
  wrap.innerHTML = `<div style="font-size:14px;color:var(--text2)"><i class="ti ti-loader-2"></i> ${TR("Chargement…")}</div>`;
  try{
    const users = await API.users();
    if(!users.length){ wrap.innerHTML=`<div style="font-size:14px;color:var(--text2)">${TR('Aucun utilisateur.')}</div>`; return; }
    wrap.innerHTML=`<div class="table-wrap"><table class="t">
      <thead><tr><th>Nom</th><th>E-mail</th><th>Pays</th><th>Type</th><th>${TR('Statut')}</th><th>${TR('Dernière connexion')}</th><th></th></tr></thead>
      <tbody>${users.map(u=>`<tr>
        <td style="font-weight:600">${esc(u.nom)}</td>
        <td style="font-size:14px">${esc(u.email)}</td>
        <td><span style="font-size:14px">${u.pays||'<span style="color:var(--text3)">🌍 Tous</span>'}</span></td>
        <td><span class="badge ${u.role==='admin'?'urgent':'attente'}">${u.role==='admin'?'Administrateur':'Utilisateur'}</span></td>
        <td><span class="badge ${u.actif?'g':'hg'}">${u.actif?'Actif':'Désactivé'}</span></td>
        <td style="font-size:13px;color:var(--text2)">${u.last_login?fd(u.last_login.slice(0,10)):'—'}</td>
        <td style="display:flex;gap:6px;justify-content:flex-end">
          <button class="btn sm" onclick="modalEditerUtilisateur(${u.id})" title="${TR("Modifier")}"><i class="ti ti-edit"></i></button>
          <button class="btn sm" onclick="modalResetPassword(${u.id},'${esc(u.nom)}')" title="Changer le mot de passe"><i class="ti ti-key"></i></button>
          ${u.id!==CURRENT_USER.id?`<button class="btn sm danger" onclick="supprimerUtilisateur(${u.id},'${esc(u.nom)}')" title="${TR("Supprimer")}"><i class="ti ti-trash"></i></button>`:''}
        </td>
      </tr>`).join('')}</tbody>
    </table></div>`;
  }catch(e){ wrap.innerHTML=`<div style="font-size:14px;color:var(--danger)">${esc(e.message)}</div>`; }
}

function _permGrid(perms={}){
  return `<div style="margin-top:4px;border:0.5px solid var(--border-s);border-radius:var(--radius);overflow:hidden">
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <thead><tr style="background:var(--bg)">
        <th style="padding:6px 10px;text-align:left;font-weight:600;color:var(--text2)">Module</th>
        <th style="padding:6px 10px;text-align:center;font-weight:600;color:var(--success);width:100px">${TR('Accès complet')}</th>
        <th style="padding:6px 10px;text-align:center;font-weight:600;color:var(--warning);width:100px">Lecture seule</th>
        <th style="padding:6px 10px;text-align:center;font-weight:600;color:var(--text3);width:90px">${TR('Masquée')}</th>
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
        <div class="form-group" style="grid-column:1/-1"><label class="form-label">${TR('Prénom et nom *')}</label><input class="form-input" id="nu-nom" placeholder="${TR("Frédéric Dijd")}"></div>
        <div class="form-group" style="grid-column:1/-1"><label class="form-label">Adresse e-mail *</label><input class="form-input" id="nu-email" type="email" placeholder="frederic@eloflex.fr"></div>
        <div class="form-group"><label class="form-label">Mot de passe * <span style="font-size:12px;color:var(--text2)">(8 car. min.)</span></label><input class="form-input" id="nu-mdp" type="password" placeholder="••••••••"></div>
        <div class="form-group"><label class="form-label">Langue de l'interface</label>
          <select class="form-input" id="nu-langue">
            <option value="fr">${TR('🇫🇷 Français')}</option>
            <option value="en">🇬🇧 English</option>
          </select>
        </div>
        <div class="form-group" style="grid-column:1/-1"><label class="form-label">${TR('Pays / Périmètre commandes')}</label>
          <select class="form-input" id="nu-pays">
            <option value="">🌍 Tous pays (admin global)</option>
            <option value="France">🇫🇷 France</option>
            <option value="Sweden">${TR('🇸🇪 Suède')}</option>
            <option value="UK">🇬🇧 United Kingdom</option>
            <option value="Germany">🇩🇪 Deutschland</option>
            <option value="Spain">🇪🇸 España</option>
            <option value="Italy">🇮🇹 Italia</option>
            <option value="Belgium">🇧🇪 Belgique</option>
            <option value="Switzerland">🇨🇭 Suisse</option>
            <option value="Netherlands">🇳🇱 Nederland</option>
          </select>
          <div style="font-size:13px;color:var(--text2);margin-top:4px">${TR('Laisse vide pour un accès admin à tous les pays.')}</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;margin:12px 0;padding:10px 12px;background:var(--danger-bg);border-radius:var(--radius)">
        <input type="checkbox" id="nu-admin" onchange="_onAdminToggle()" style="width:16px;height:16px;cursor:pointer">
        <label for="nu-admin" style="font-size:15px;font-weight:600;color:var(--danger);cursor:pointer">${TR('Administrateur — accès complet à tout (y compris Paramètres et exports)')}</label>
      </div>
      <div id="perm-grid">
        <div style="font-size:14px;font-weight:600;color:var(--text2);margin-bottom:6px">${TR("Permissions par module (cocher une case par ligne, ou aucune pour bloquer l'accès) :")}</div>
        ${_permGrid()}
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">${TR('Annuler')}</button>
      <button class="btn primary" onclick="creerUtilisateur()"><i class="ti ti-check"></i> ${TR('Créer')}</button>
    </div>`);
}

async function creerUtilisateur(){
  const nom=gv('nu-nom'), email=gv('nu-email'), mot_de_passe=gv('nu-mdp'), langue=gv('nu-langue')||'fr', pays=gv('nu-pays')||null;
  const admin=!!document.getElementById('nu-admin')?.checked;
  const permissions=admin?{}:_collectPerms();
  if(!nom||!email||!mot_de_passe){ toast(TR('Nom, email et mot de passe sont requis.'),'ti-alert-circle','var(--danger)'); return; }
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
    <div class="modal-header"><i class="ti ti-edit" style="color:var(--accent)"></i><h2>${TR("Modifier l'utilisateur")}</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body" style="max-height:70vh;overflow-y:auto">
      <div class="grid-2">
        <div class="form-group" style="grid-column:1/-1"><label class="form-label">${TR('Prénom et nom')}</label><input class="form-input" id="eu-nom" value="${esc(user.nom)}"></div>
        <div class="form-group" style="grid-column:1/-1"><label class="form-label">E-mail</label><input class="form-input" id="eu-email" type="email" value="${esc(user.email)}"></div>
        <div class="form-group"><label class="form-label">Langue de l'interface</label>
          <select class="form-input" id="eu-langue">
            <option value="fr" ${(user.langue||'fr')==='fr'?'selected':''}>${TR('🇫🇷 Français')}</option>
            <option value="en" ${user.langue==='en'?'selected':''}>🇬🇧 English</option>
          </select>
        </div>
        <div class="form-group" style="grid-column:1/-1"><label class="form-label">${TR('Pays / Périmètre commandes')}</label>
          <select class="form-input" id="eu-pays">
            <option value="" ${!user.pays?'selected':''}>🌍 Tous pays (admin global)</option>
            <option value="France" ${user.pays==='France'?'selected':''}>🇫🇷 France</option>
            <option value="Sweden" ${user.pays==='Sweden'?'selected':''}>${TR('🇸🇪 Suède')}</option>
            <option value="UK" ${user.pays==='UK'?'selected':''}>🇬🇧 United Kingdom</option>
            <option value="Germany" ${user.pays==='Germany'?'selected':''}>🇩🇪 Deutschland</option>
            <option value="Spain" ${user.pays==='Spain'?'selected':''}>🇪🇸 España</option>
            <option value="Italy" ${user.pays==='Italy'?'selected':''}>🇮🇹 Italia</option>
            <option value="Belgium" ${user.pays==='Belgium'?'selected':''}>🇧🇪 Belgique</option>
            <option value="Switzerland" ${user.pays==='Switzerland'?'selected':''}>🇨🇭 Suisse</option>
            <option value="Netherlands" ${user.pays==='Netherlands'?'selected':''}>🇳🇱 Nederland</option>
          </select>
        </div>
        <div class="form-group"><label class="form-label">${TR('Statut')}</label>
          <select class="form-input" id="eu-actif">
            <option value="1" ${user.actif?'selected':''}>Actif</option>
            <option value="0" ${!user.actif?'selected':''}>${TR('Désactivé')}</option>
          </select>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;margin:12px 0;padding:10px 12px;background:var(--danger-bg);border-radius:var(--radius)">
        <input type="checkbox" id="eu-admin" onchange="_onAdminToggle()" ${user.role==='admin'?'checked':''} style="width:16px;height:16px;cursor:pointer">
        <label for="eu-admin" style="font-size:15px;font-weight:600;color:var(--danger);cursor:pointer">${TR('Administrateur — accès complet à tout')}</label>
      </div>
      <div id="perm-grid" ${user.role==='admin'?'style="display:none"':''}>
        <div style="font-size:14px;font-weight:600;color:var(--text2);margin-bottom:6px">Permissions par module :</div>
        ${_permGrid(perms)}
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">${TR('Annuler')}</button>
      <button class="btn primary" onclick="enregistrerUtilisateur(${id})"><i class="ti ti-check"></i> ${TR('Enregistrer')}</button>
    </div>`);
}

async function enregistrerUtilisateur(id){
  const admin=!!document.getElementById('eu-admin')?.checked;
  const permissions=admin?{}:_collectPerms();
  const langue=gv('eu-langue')||'fr';
  const pays=gv('eu-pays')||null;
  try{
    await API.updateUser(id, { nom:gv('eu-nom'), email:gv('eu-email'), admin, permissions, langue, actif: gv('eu-actif')==='1', pays });
    closeModal(); toast(TR('Utilisateur mis à jour')); chargerListeUtilisateurs();
  }catch(e){ toast(e.message,'ti-alert-circle','var(--danger)'); }
}

function modalResetPassword(id, nom){
  showModal(`
    <div class="modal-header"><i class="ti ti-key" style="color:var(--accent)"></i><h2>${TR('Nouveau mot de passe')}</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body">
      <div style="margin-bottom:12px;font-size:15px">${TR('Définir un nouveau mot de passe pour')} <b>${esc(nom)}</b>.</div>
      <div class="form-group"><label class="form-label">${TR('Nouveau mot de passe')} <span style="font-size:12px;color:var(--text2)">(8 car. min.)</span></label>
        <input class="form-input" id="rp-mdp" type="password" placeholder="••••••••"></div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">${TR('Annuler')}</button>
      <button class="btn primary" onclick="appliquerResetPassword(${id})"><i class="ti ti-check"></i> Appliquer</button>
    </div>`);
}

async function appliquerResetPassword(id){
  const mdp = gv('rp-mdp');
  if(mdp.length < 8){ toast(TR('Minimum 8 caractères.'),'ti-alert-circle','var(--danger)'); return; }
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
  if(!confirm(TR('Envoyer un email de demande de confirmation BDC au distributeur ?'))) return;
  toast('Envoi en cours…','ti-loader-2');
  try{
    const r = await API.emailConfirmation(id);
    if(r.ok){ toast(`Email de confirmation envoyé à ${r.to}`,'ti-mail'); closeModal(); render(); }
    else toast(`Non envoyé : ${r.reason}`,'ti-alert-circle','var(--warning)');
  }catch(e){ toast(e.message,'ti-alert-circle','var(--danger)'); }
}

// Ouvre le bon de livraison / bordereau dans VosFactures.
// Le champ peut contenir un ID (ou une URL warehouse_documents…), ou un simple numéro
// de document — dans ce cas on retrouve la pièce par son numéro et on ouvre le document exact.
async function ouvrirBordereauVF(num){
  const account = await vfAccount();
  num = (num == null ? '' : String(num)).trim();
  if(!account){ toast(TR('Compte VosFactures non configuré'),'ti-alert-circle','var(--warning)'); return; }
  if(!num){ return; }
  const base = 'https://' + account + '.vosfactures.fr/';
  const win = window.open('about:blank', '_blank');
  const go = (url) => { if(win && !win.closed){ win.location.href = url; } else { window.open(url, '_blank', 'noopener'); } };
  // ID direct ou URL warehouse_documents collée
  const m = num.match(/warehouse_documents\/(\d+)/);
  if(m){ go(base + 'warehouse_documents/' + m[1]); return; }
  if(/^\d{5,}$/.test(num)){ go(base + 'warehouse_documents/' + num); return; }
  // Sinon : on retrouve le document par son numéro
  try{
    const r = await API.stockLookup(num);
    if(r && r.found && r.vf_id){
      go(base + (r.source === 'invoice' ? 'invoices/' : 'warehouse_documents/') + r.vf_id);
      return;
    }
  }catch(_){}
  go(base + 'documents?q=' + encodeURIComponent(num)); // repli
}
window.ouvrirBordereauVF = ouvrirBordereauVF;

async function genererFactureVF(id){
  if(!confirm('Générer la facture dans VosFactures ?\n\nLa commande passera au statut "Facturé" et le N° de facture sera renseigné automatiquement.')) return;
  toast(TR('Génération en cours…'),'ti-loader-2');
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
  const account = await vfAccount();
  if(!account){ toast(TR('Compte VosFactures non configuré'),'ti-alert-circle','var(--warning)'); return; }
  // Si on a l'ID VosFactures → lien direct vers le document
  if(vfId){
    window.open(`https://${account}.vosfactures.fr/invoices/${vfId}`, '_blank', 'noopener');
    return;
  }
  if(!bdc){ toast(TR('Renseigne d\'abord le numéro'),'ti-alert-circle','var(--warning)'); return; }
  // Pas d'ID connu : on retrouve le document via l'API (même recherche que l'import) pour
  // ouvrir la pièce EXACTE. La recherche web VosFactures (?search_text=) n'applique pas le
  // filtre → on l'évite si possible. L'onglet est ouvert tout de suite (geste du clic) pour
  // ne pas être bloqué par le navigateur.
  const win = window.open('about:blank', '_blank');
  const urlRecherche = `https://${account}.vosfactures.fr/invoices?search_text=${encodeURIComponent(bdc)}`;
  const aller = (url) => { if(win && !win.closed){ win.location.href = url; } else { window.open(url, '_blank', 'noopener'); } };
  try{
    const r = await API.vfBdcLookup(bdc);
    if(r && r.found && r.vf_id){ aller(`https://${account}.vosfactures.fr/invoices/${r.vf_id}`); }
    else { aller(urlRecherche); }
  }catch(_){ aller(urlRecherche); }
}

async function creerBLVF(id){
  if(!confirm(TR('Créer le bordereau de livraison dans VosFactures ?'))) return;
  toast(TR('Création BL en cours…'),'ti-loader-2');
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
  wrap.innerHTML=`<div style="color:var(--text2);padding:20px"><i class="ti ti-loader-2"></i> ${TR("Chargement…")}</div>`;
  const reqId = ++_cmdReqId;
  const res = await API.commandes({ annee: CMD_FILTERS.annee, mois: CMD_FILTERS.mois, statut: CMD_FILTERS.statut, distributeur: CMD_FILTERS.distributeur, q: CMD_FILTERS.q, per_page: 500, ...((_PAYS_FILTRE||CURRENT_USER.pays)?{pays:_PAYS_FILTRE||CURRENT_USER.pays}:{}) });
  const list = res.rows||[];
  const COLS = ['En attente confirmation','En préparation','Expédié','Livré','Facturé','Payé','Impayé','Problème','Annulé'];
  const grouped = {};
  COLS.forEach(s => grouped[s] = []);
  list.forEach(cm => {
    const s = cm.statut_calc || 'En préparation';
    if(grouped[s]) grouped[s].push(cm); else grouped['En préparation'].push(cm);
  });
  wrap.innerHTML=`<div style="display:flex;gap:10px;overflow-x:auto;padding-bottom:8px">
    ${COLS.map(col=>`
      <div style="min-width:220px;flex:0 0 220px">
        <div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text2);margin-bottom:8px;display:flex;justify-content:space-between">
          <span>${tStatut(col)}</span>
          <span class="badge ${cmdStatutClass(col)}" style="font-size:12px">${grouped[col].length}</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px">
          ${grouped[col].map(cm=>`
            <div onclick="modalCommande(${cm.id})" style="padding:10px 12px;background:var(--surface);border:0.5px solid var(--border-s);border-radius:var(--radius);cursor:pointer;font-size:14px">
              <div style="font-weight:700;margin-bottom:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(cm.distributeur_nom)}</div>
              <div style="color:var(--text2);display:flex;justify-content:space-between">
                <span class="mono">${esc(cm.bdc||'—')}</span>
                <span>${fd(cm.date_commande)}</span>
              </div>
              ${cm.modele?`<div style="color:var(--text3);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:3px">${esc(cm.modele)}</div>`:''}
              ${cm.reliquat?`<span class="badge hg" style="font-size:12px;margin-top:4px;display:inline-block">⏰ Reliquat</span>`:''}
              ${cm.modele_demo?`<span class="badge hg" style="font-size:12px;margin-top:4px;display:inline-block">${TR('🔄 Démo')}</span>`:''}
            </div>`).join('')}
          ${grouped[col].length===0?`<div style="font-size:14px;color:var(--text3);text-align:center;padding:12px 0">—</div>`:''}
        </div>
      </div>`).join('')}
  </div>`;
}

async function envoyerEmailExpedition(id){
  if(!confirm(TR('Envoyer la confirmation d\'expédition par email au distributeur ?'))) return;
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
        <i class="ti ti-alert-triangle" style="color:var(--warning);font-size:20px;flex-shrink:0;margin-top:1px"></i>
        <div style="flex:1">
          <div style="font-weight:700;font-size:15px;color:var(--warning);margin-bottom:8px;display:flex;align-items:center;justify-content:space-between">
            <span>${rows.length} doublon${rows.length>1?'s':''} détecté${rows.length>1?'s':''} — même numéro de BDC pour plusieurs commandes</span>
            <button class="btn sm danger" onclick="supprimerTousDoublonsBanner(this)" style="margin-left:12px;white-space:nowrap"><i class="ti ti-trash"></i> ${TR('Supprimer tous')}</button>
          </div>
          <div class="table-wrap"><table class="t" style="font-size:14px">
            <thead><tr><th>BDC</th><th>${TR('Distributeur')}</th><th style="text-align:center">Nb</th><th>Commandes</th></tr></thead>
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
  el.innerHTML=`<div style="font-size:14px;color:var(--text2)"><i class="ti ti-loader-2"></i> ${TR("Chargement…")}</div>`;
  try{
    const jours = parseInt($('blocage-seuil')?.value)||7;
    const data = await API.commandesAlertesBlocage(jours);
    // Support ancien format (tableau) et nouveau format (objet avec 2 listes)
    const nonExp  = Array.isArray(data) ? data : (data.non_expedies||[]);
    const nonFact = Array.isArray(data) ? [] : (data.non_facturees||[]);
    if(!nonExp.length && !nonFact.length){
      el.innerHTML=`<div style="font-size:14px;color:var(--success)"><i class="ti ti-check"></i> ${TR('Aucune alerte — tout est à jour !')}</div>`;
      return;
    }
    const tableRow = (r, type) => `<tr onclick="modalCommande(${r.id})" style="cursor:pointer">
      <td><span class="badge ${type==='non_expedie'?'attente':'urgent'}" style="font-size:12px">${type==='non_expedie'?'📦 Non expédié':'🧾 Non facturé'}</span></td>
      <td>${esc(r.distributeur_nom)}</td>
      <td class="mono">${esc(r.bdc||'')}</td>
      <td style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.modele||'')}</td>
      <td>${fd(r.date_commande||r.date_livraison)}</td>
      <td><span class="badge ${r.jours_attente>14?'urgent':'hg'}">${r.jours_attente}j</span></td>
      <td><button class="btn sm" onclick="event.stopPropagation();modalCommande(${r.id})"><i class="ti ti-pencil"></i></button></td>
    </tr>`;
    el.innerHTML=`<div class="table-wrap"><table class="t">
      <thead><tr><th>Type</th><th>${TR('Distributeur')}</th><th>Bdc</th><th>${TR('Modèle')}</th><th>${TR('Date réf.')}</th><th>${TR('Délai')}</th><th></th></tr></thead>
      <tbody>
        ${nonExp.map(r=>tableRow(r,'non_expedie')).join('')}
        ${nonFact.map(r=>tableRow(r,'non_facturee')).join('')}
      </tbody>
    </table></div>`;
  }catch(e){ el.innerHTML=`<div style="font-size:14px;color:var(--danger)">${esc(e.message)}</div>`; }
}

async function supprimerTousDoublonsBanner(btn){
  if(!confirm(TR('Supprimer tous les doublons ?\n\nPour chaque BDC en doublon, la commande la plus complète est conservée (priorité : source VosFactures > N° suivi > N° série > facture).\n\nAction irréversible.'))) return;
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
      el.innerHTML=`<div style="font-size:14px;color:var(--success)"><i class="ti ti-check"></i> ${TR('Aucun doublon détecté.')}</div>`;
      return;
    }
    el.innerHTML=`<div style="font-size:14px;color:var(--warning);margin-bottom:8px;font-weight:600">
      <i class="ti ti-alert-triangle"></i> ${rows.length} BDC en doublon
    </div>
    <div class="table-wrap"><table class="t" style="font-size:14px">
      <thead><tr><th>BDC</th><th>${TR('Distributeur')}</th><th>Nb</th><th>Commandes</th></tr></thead>
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
  }catch(e){ el.innerHTML=`<div style="font-size:14px;color:var(--danger)">${esc(e.message)}</div>`; }
}

async function lancerMigrationFacture(){
  if(!confirm('Passer TOUTES les commandes antérieures à juin 2026 au statut "Facturé" ?\n\nCela exclut les commandes déjà "Annulé" et déjà "Facturé".\nAction irréversible.')) return;
  const btn=$('btn-migration-facture'); if(btn) btn.disabled=true;
  toast('Migration en cours…','ti-loader-2');
  try{
    const r = await API.migrationFactureHistorique();
    const msg = `✅ ${r.mises_a_jour} commande(s) passée(s) en Facturé.`;
    $('migration-facture-result').innerHTML=`<div style="padding:8px 12px;background:var(--success-bg);border:0.5px solid var(--success);border-radius:var(--radius);font-size:14px;color:var(--success)">${msg}</div>`;
    toast(msg,'ti-check');
    if(btn){ btn.disabled=true; btn.innerHTML='<i class="ti ti-check"></i> Migration effectuée'; }
  }catch(e){
    $('migration-facture-result').innerHTML=`<div style="color:var(--danger);font-size:14px">❌ ${esc(e.message)}</div>`;
    if(btn) btn.disabled=false;
  }
}

async function lancerMigrationSuivi(){
  if(!confirm(TR('Migrer les faux numéros de suivi (RETOUR BRICE, SUÈDE, etc.) vers les champs appropriés ? Cette action est irréversible.'))) return;
  toast('Migration en cours…','ti-loader-2');
  try{
    const r = await API.fixSuivi();
    toast(r.detail,'ti-check');
  }catch(e){ toast(e.message,'ti-alert-circle','var(--danger)'); }
}

let RATT_LAST=null;
async function lancerRattrapageVF(){
  const btn=document.getElementById('btn-rattrapage-vf');
  const out=document.getElementById('rattrapage-vf-result');
  if(!confirm('Lancer le rattrapage VosFactures sur toutes les commandes ? Cela peut prendre plusieurs minutes — garde cet onglet ouvert pendant le traitement.')) return;
  if(btn){ btn.disabled=true; btn.innerHTML='<i class="ti ti-loader-2"></i> Rattrapage en cours…'; }
  const S={ offset:0, total:null, liens:0, paiements:0, infos:0, introuvables:[], errors:0 };
  const LIMIT=80;
  const maj=()=>{
    const pct=S.total?Math.round(100*S.offset/S.total):0;
    if(out) out.innerHTML=
      '<div style="background:#eef2f7;border-radius:8px;overflow:hidden;height:14px;margin-bottom:8px">'+
        '<div style="width:'+pct+'%;height:100%;background:var(--success,#1b8a3a);transition:width .3s"></div></div>'+
      '<div style="font-size:14px;color:var(--text2)">'+pct+'% — '+(S.offset||0)+'/'+(S.total||'?')+' commandes · '+
        S.liens+' liens · '+S.paiements+' paiements · '+S.infos+' infos · '+
        '<b style="color:var(--danger)">'+S.introuvables.length+'</b> introuvables'+(S.errors?(' · '+S.errors+' erreurs réseau'):'')+'</div>';
  };
  maj();
  try{
    while(true){
      let data=null;
      for(let a=0;a<3 && !data;a++){
        try{
          const r=await fetch('/api/admin/vf-rattrapage?offset='+S.offset+'&limit='+LIMIT);
          const j=await r.json();
          if(j && j.ok) data=j;
          else if(j && j.configured===false) throw new Error('VosFactures non configuré');
          else throw new Error('réponse inattendue');
        }catch(e){ if(/non configuré/.test(e.message)) throw e; S.errors++; await new Promise(x=>setTimeout(x,4000)); }
      }
      if(!data) throw new Error('Échec réseau répété au lot '+S.offset);
      S.total=data.total; S.liens+=data.liens||0; S.paiements+=data.paiements||0; S.infos+=data.infos||0;
      if(data.introuvables && data.introuvables.length) S.introuvables.push(...data.introuvables);
      S.offset=data.next_offset; maj();
      if(data.done) break;
    }
    RATT_LAST=S;
    const nbFac=S.introuvables.filter(x=>x.type==='facture').length, nbBdc=S.introuvables.length-nbFac;
    if(out) out.innerHTML=
      '<div style="background:var(--success,#1b8a3a);color:#fff;border-radius:8px;padding:12px 14px;font-size:15px;margin-bottom:8px">'+
        '✓ Rattrapage terminé — '+S.total+' commandes · '+S.liens+' liens créés · '+S.paiements+' paiements · '+S.infos+' infos complétées.</div>'+
      '<div style="font-size:14px;color:var(--text2);margin-bottom:8px">'+S.introuvables.length+' introuvables ('+nbBdc+' BDC, '+nbFac+
        ' factures) — souvent des numéros internes distributeur ou des cases multi-documents, sans correspondance VosFactures.</div>'+
      '<button class="btn sm" onclick="telechargerRapportRattrapage()"><i class="ti ti-download"></i> '+TR("Télécharger le rapport des introuvables")+'</button>';
    toast(TR('Rattrapage VosFactures terminé'),'ti-check');
  }catch(e){
    if(out) out.innerHTML='<div style="color:var(--danger);font-size:15px">Erreur : '+esc(e.message)+
      '. Les commandes déjà traitées sont enregistrées ; tu peux relancer pour reprendre.</div>';
    toast(e.message,'ti-alert-circle','var(--danger)');
  }finally{
    if(btn){ btn.disabled=false; btn.innerHTML='<i class="ti ti-link"></i> Lancer le rattrapage'; }
  }
}
window.lancerRattrapageVF = lancerRattrapageVF;

function telechargerRapportRattrapage(){
  const S=RATT_LAST; if(!S){ toast(TR('Aucun rapport disponible'),'ti-alert-circle','var(--danger)'); return; }
  const e=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const parDist={}; for(const x of S.introuvables){ const k=x.distributeur||'(sans nom)'; (parDist[k]=parDist[k]||[]).push(x); }
  const groupes=Object.entries(parDist).sort((a,b)=>b[1].length-a[1].length);
  const nbFac=S.introuvables.filter(x=>x.type==='facture').length, nbBdc=S.introuvables.length-nbFac;
  let rows='';
  for(const g of groupes){
    rows+='<tr class="grp"><td colspan="3">'+e(g[0])+' <span class="cnt">'+g[1].length+'</span></td></tr>';
    for(const x of g[1]){ const b=x.type==='facture'?'<span class="b b-fac">'+TR("Facture")+'</span>':'<span class="b b-bdc">BDC</span>';
      rows+='<tr><td>'+b+'</td><td class="num">'+e(x.numero)+'</td><td class="id">#'+e(x.id)+'</td></tr>'; }
  }
  const html='<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>Rattrapage VosFactures — introuvables</title><style>'+
    'body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:0;background:#f4f6f9;color:#1a2a3a}.wrap{max-width:900px;margin:0 auto;padding:24px}h1{font-size:24px;margin:0 0 4px}.sub{color:#667;margin:0 0 20px;font-size:15px}.cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:22px}.card{background:#fff;border-radius:10px;padding:14px 18px;box-shadow:0 1px 3px rgba(0,0,0,.08);flex:1;min-width:130px}.card .n{font-size:28px;font-weight:700}.card .l{font-size:14px;color:#667;text-transform:uppercase;letter-spacing:.04em}.g{color:#1b8a3a}.r{color:#b3261e}table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)}td{padding:7px 12px;border-bottom:1px solid #eef1f4;font-size:15px}tr.grp td{background:#eef2f7;font-weight:700}.cnt{background:#b3261e;color:#fff;border-radius:10px;padding:1px 8px;font-size:13px;margin-left:6px}.b{display:inline-block;border-radius:4px;padding:1px 7px;font-size:13px;font-weight:600}.b-bdc{background:#e6effa;color:#1a56a0}.b-fac{background:#fdeaea;color:#b3261e}.num{font-family:ui-monospace,Menlo,monospace}.note{background:#fff8e6;border-left:4px solid #c47f00;padding:12px 16px;border-radius:6px;margin:18px 0;font-size:15px;line-height:1.5}'+
    '</style></head><body><div class="wrap"><h1>Rattrapage VosFactures — documents introuvables</h1><p class="sub">'+S.total+' commandes analysées</p><div class="cards">'+
    '<div class="card"><div class="n g">'+S.liens+'</div><div class="l">'+TR("Liens créés")+'</div></div><div class="card"><div class="n g">'+S.paiements+'</div><div class="l">Paiements</div></div><div class="card"><div class="n g">'+S.infos+'</div><div class="l">'+TR("Infos complétées")+'</div></div><div class="card"><div class="n r">'+S.introuvables.length+'</div><div class="l">Introuvables</div></div></div>'+
    '<div class="note"><b>'+TR("À savoir :")+'</b> '+nbBdc+' BDC et '+nbFac+' factures sans correspondance VosFactures — le plus souvent un numéro interne du distributeur, une case contenant deux documents, ou une annotation libre. Ce ne sont pas des erreurs de recherche.</div>'+
    '<table><tbody>'+rows+'</tbody></table></div></body></html>';
  const blob=new Blob([html],{type:'text/html'}); const url=URL.createObjectURL(blob); const a=document.createElement('a');
  a.href=url; a.download='rattrapage-vosfactures-introuvables.html'; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),4000);
}
window.telechargerRapportRattrapage = telechargerRapportRattrapage;

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
    email_from:gv('p-email-from')||'',
    email_cc_sav:gv('p-email-cc-sav')||'sav@eloflex.fr',
    email_cc_relance:gv('p-email-cc-relance')||'info@eloflex.fr',
    email_from_relance:gv('p-email-from-relance')||'',
    email_smtp_user_relance:gv('p-smtp-user-relance')||'',
    email_smtp_pass_relance:gv('p-smtp-pass-relance')||''
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
      <i class="ti ti-tool" style="font-size:20px;color:var(--accent)"></i>
      <h2>${esc(i.num_sav||'#'+i.id)} — ${traduireType(i.type)}</h2>
      <button class="btn sm success" onclick="exportInterventionPDF(${i.id})"><i class="ti ti-file-type-pdf"></i>PDF</button>
      <button class="btn sm" onclick="envoyerEmailInter(${i.id})" title="${TR("Envoyer notification au distributeur")}"><i class="ti ti-mail"></i></button>
      <button class="btn sm" onclick="modalEditIntervention(${i.id})"><i class="ti ti-edit"></i></button>
      <button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button>
    </div>
    <div class="modal-body">
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
        <span class="badge ${i.garantie?'g':'hg'}">${i.garantie?'Sous garantie':'Hors garantie'}</span>
        ${i.garantie_auto?'<span style="font-size:12px;color:var(--text3)">'+TR("détecté auto")+'</span>':''}
        <span class="badge ${sc(i.statut)}">${traduireStatut(i.statut)}</span>
        <span style="font-size:13px;color:var(--text3);margin-left:auto">${fd(i.date)}</span>
      </div>
      <div style="margin-bottom:12px">
        ${i.commande_id
          ? `<button class="btn sm" onclick="ouvrirCommandeLiee(${i.commande_id})"><i class="ti ti-clipboard-list"></i> ${TR('Voir la commande liée')}</button>`
          : `<button class="btn sm" onclick="basculerSAVversCommande(${i.id})" title="${TR("Créer une commande liée « SAV facturé » dans Suivi commandes")}"><i class="ti ti-clipboard-plus"></i> ${TR("Basculer en commande")}</button>`}
      </div>
      <div class="grid-2" style="font-size:14px;margin-bottom:12px">
        <div><div class="stat-label">${TR("Client")}</div><div style="font-weight:600">${esc(i.client_nom||'')}</div></div>
        <div><div class="stat-label">${TR('Fauteuil')}</div><div style="font-weight:600">${esc(i.modele)} – <span class="mono">${esc(i.serie)}</span></div></div>
        <div>
          <div class="stat-label">Facture VosFactures
            <button class="btn sm" style="padding:1px 6px;font-size:12px;margin-left:6px" onclick="toggleEditFacture(${i.id},'${esc(i.num_facture||'')}')"><i class="ti ti-edit" style="font-size:12px"></i></button>
          </div>
          <div id="facture-display-${i.id}">
            ${i.num_facture?`<span class="mono" style="color:var(--accent)">${esc(i.num_facture)}</span>`:'<span style="color:var(--text3)">—</span>'}
          </div>
          <div id="facture-edit-${i.id}" style="display:none;display:flex;gap:6px;align-items:center;margin-top:4px">
            <input class="form-input mono" id="facture-input-${i.id}" style="font-size:14px;padding:4px 8px;flex:1" placeholder="ex: 7574" value="${esc(i.num_facture||'')}">
            <button class="btn sm primary" onclick="saveFactureInter(${i.id})"><i class="ti ti-check"></i></button>
            <button class="btn sm" onclick="document.getElementById('facture-edit-${i.id}').style.display='none';document.getElementById('facture-display-${i.id}').style.display='block'"><i class="ti ti-x"></i></button>
          </div>
        </div>
        <div><div class="stat-label">Technicien</div><div>${esc(i.technicien||'—')}</div></div>
      </div>
      <div class="form-group"><div class="form-label">Description</div><div style="font-size:14px;background:var(--bg);padding:8px;border-radius:var(--radius)">${esc(i.description||'—')}</div></div>
      ${i.notes?`<div class="form-group"><div class="form-label">${TR('Intervention réalisée')}</div><div style="font-size:14px;color:var(--text2)">${esc(i.notes)}</div></div>`:''}
      <div class="divider"></div>
      <div class="section-title"><i class="ti ti-box"></i>${TR('Pièces')}</div>
      ${(i.produits||[]).length===0?'<div style="font-size:14px;color:var(--text3)">'+TR("Aucune pièce")+'</div>':`
        <table class="t"><thead><tr><th>${t('col_designation')}</th><th>${TR('Réf')}</th><th>${t('col_qte')||'Qté'}</th><th>PU HT</th><th>Total HT</th></tr></thead>
        <tbody>${(i.produits||[]).map(p=>`<tr><td>${esc(p.designation)}</td><td class="mono">${esc(p.ref||'')}</td><td>${p.qte}</td><td>${parseFloat(p.pxht||0).toFixed(2)} €</td><td style="font-weight:700">${(parseFloat(p.pxht||0)*p.qte).toFixed(2)} €</td></tr>`).join('')}</tbody></table>
        <div style="text-align:right;padding-top:6px;font-weight:700;font-size:15px">Total HT : ${total.toFixed(2)} €</div>`}
      <div class="divider"></div>
      <div class="section-title"><i class="ti ti-send"></i>${TR('Expédition')}</div>
      ${i.envoi_numero?`<div class="tracking-block"><div style="font-size:13px;font-weight:700;color:var(--text3);margin-bottom:5px;text-transform:uppercase">Envoi</div><div style="font-size:14px">${esc(i.envoi_transporteur)} — <a href="${lienhSuiviInter(i.envoi_transporteur,i.envoi_numero)}" target="_blank" style="color:var(--accent);font-family:monospace;text-decoration:none"><i class="ti ti-external-link" style="font-size:12px"></i> ${esc(i.envoi_numero)}</a> — ${fd(i.envoi_date)}</div></div>`:'<div style="font-size:14px;color:var(--text3)">'+TR("Aucun envoi")+'</div>'}
      ${i.num_bordereau_vf?`<div style="margin-top:8px"><a href="#" data-bl="${esc(i.num_bordereau_vf)}" onclick="event.preventDefault();ouvrirBordereauVF(this.dataset.bl)" style="color:var(--accent);font-size:14px;text-decoration:none;cursor:pointer"><i class="ti ti-file-invoice" style="font-size:13px"></i> BL/Bordereau : ${esc(i.num_bordereau_vf)}</a></div>`:''}
      <div class="section-title" style="margin-top:10px"><i class="ti ti-arrow-back-up"></i>${TR('Retour')}</div>
      ${i.retour_numero?`<div class="tracking-block"><div style="font-size:13px;font-weight:700;color:var(--text3);margin-bottom:5px;text-transform:uppercase">${TR('Retour')}</div><div style="font-size:14px">${esc(i.retour_transporteur)} — <a href="${lienhSuiviInter(i.retour_transporteur,i.retour_numero)}" target="_blank" style="color:var(--accent);font-family:monospace;text-decoration:none"><i class="ti ti-external-link" style="font-size:12px"></i> ${esc(i.retour_numero)}</a> — ${fd(i.retour_date)}</div></div>`:'<div style="font-size:14px;color:var(--text3)">'+TR("Aucun retour")+'</div>'}
      <div class="divider"></div>
      <div class="section-title"><i class="ti ti-photo"></i>Photos (${photos.length})</div>
      <div id="photo-gallery">${renderPhotoGallery(photos,i.id)}</div>
      <div id="photo-upload-zone" class="photo-drop-zone" ondragover="event.preventDefault();this.classList.add('drag-over')" ondragleave="this.classList.remove('drag-over')" ondrop="handlePhotoDrop(event,${i.id})">
        <i class="ti ti-cloud-upload" style="font-size:28px;color:var(--text3);margin-bottom:6px"></i>
        <div style="font-size:15px;color:var(--text2);margin-bottom:3px">${TR('Glisser-déposer des photos ici')}</div>
        <div style="font-size:13px;color:var(--text3);margin-bottom:8px">JPEG, PNG, WEBP — 15 Mo max</div>
        <label class="btn sm primary" style="cursor:pointer"><i class="ti ti-upload"></i>${TR("Choisir des fichiers")}<input type="file" accept="image/*" multiple style="display:none" onchange="handlePhotoFiles(this.files,${i.id})"></label>
      </div>
      <div class="divider"></div>
      <div class="section-title"><i class="ti ti-message"></i>Commentaires (${(i.commentaires||[]).length})</div>
      <div id="commentaires-list">${renderCommentaires(i.commentaires||[],i.id)}</div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <input class="form-input" id="new-comment" placeholder="${TR("Ajouter un commentaire…")}" style="flex:1">
        <button class="btn primary" onclick="addComment(${i.id})"><i class="ti ti-send"></i>${TR('Envoyer')}</button>
      </div>
      <div class="divider"></div>
      <div class="section-title" style="cursor:pointer" onclick="toggleHistorique(${i.id})"><i class="ti ti-history"></i>${TR('Historique des modifications')} <i class="ti ti-chevron-down" id="hist-chevron" style="margin-left:auto"></i></div>
      <div id="historique-list" style="display:none">${renderHistorique(i.historique||[])}</div>
    </div>
    <div class="modal-footer">
      <button class="btn danger" onclick="if(confirm(TR('Supprimer ?')))API.deleteIntervention(${i.id}).then(()=>{closeModal();render();toast(t('msg_supprime'),'ti-trash');})"><i class="ti ti-trash"></i></button>
      <button class="btn" onclick="closeModal()">${TR('Fermer')}</button>
    </div>`);
}

function renderCommentaires(comms,interId){
  if(!comms.length) return '<div style="font-size:14px;color:var(--text3);margin-bottom:8px">'+TR("Aucun commentaire")+'</div>';
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
  toast(TR('Commentaire ajouté'),'ti-message');
}

function renderHistorique(hist){
  if(!hist.length) return '<div style="font-size:14px;color:var(--text3)">'+TR("Aucune modification enregistrée")+'</div>';
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
  if(!photos.length) return '<div style="font-size:14px;color:var(--text3);margin-bottom:10px">'+TR("Aucune photo")+'</div>';
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
  zone.innerHTML='<div style="text-align:center;padding:16px"><i class="ti ti-loader-2" style="font-size:24px"></i><div style="margin-top:5px;font-size:14px">Upload en cours…</div></div>';
  try{
    await API.uploadPhotos(interId,Array.from(files));
    const photos=await API.photos(interId);
    $('photo-gallery').innerHTML=renderPhotoGallery(photos,interId);
    zone.innerHTML=uploadZoneHTML(interId);
    toast(`${files.length} photo${files.length>1?'s':''} ajoutée${files.length>1?'s':''}`, 'ti-photo');
  }catch(e){zone.innerHTML=uploadZoneHTML(interId);toast(TR('Erreur upload : ')+e.message,'ti-alert-circle','var(--danger)');}
}
function handlePhotoDrop(e,interId){e.preventDefault();$('photo-upload-zone').classList.remove('drag-over');if(e.dataTransfer.files.length)handlePhotoFiles(e.dataTransfer.files,interId);}
function uploadZoneHTML(interId){return `<i class="ti ti-cloud-upload" style="font-size:28px;color:var(--text3);margin-bottom:6px"></i><div style="font-size:15px;color:var(--text2);margin-bottom:3px">${TR('Glisser-déposer des photos ici')}</div><div style="font-size:13px;color:var(--text3);margin-bottom:8px">JPEG, PNG, WEBP — 15 Mo max</div><label class="btn sm primary" style="cursor:pointer"><i class="ti ti-upload"></i>${TR("Choisir des fichiers")}<input type="file" accept="image/*" multiple style="display:none" onchange="handlePhotoFiles(this.files,${interId})"></label>`;}
async function deletePhoto(interId,photoId){if(!confirm(TR('Supprimer ?')))return;await API.deletePhoto(interId,photoId);const photos=await API.photos(interId);$('photo-gallery').innerHTML=renderPhotoGallery(photos,interId);toast(TR('Photo supprimée'),'ti-trash');}
async function editPhotoLegende(interId,photoId,cur){const l=prompt(TR('Légende :'),cur);if(l===null)return;await API.updatePhotoLegende(interId,photoId,l);const photos=await API.photos(interId);$('photo-gallery').innerHTML=renderPhotoGallery(photos,interId);}

let LB={filenames:[],idx:0};
function openLightbox(interId,idx,filenames){LB={filenames,idx};showLightbox();}
function showLightbox(){
  const fname=LB.filenames[LB.idx];
  document.getElementById('lightbox-overlay')?.remove();
  const el=document.createElement('div');el.id='lightbox-overlay';
  el.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.93);z-index:500;display:flex;flex-direction:column;align-items:center;justify-content:center;';
  el.innerHTML=`
    <button onclick="closeLightbox()" style="position:absolute;top:16px;right:20px;background:none;border:none;color:#fff;font-size:30px;cursor:pointer"><i class="ti ti-x"></i></button>
    <div style="position:absolute;top:16px;left:50%;transform:translateX(-50%);color:rgba(255,255,255,.5);font-size:14px">${LB.idx+1} / ${LB.filenames.length}</div>
    ${LB.idx>0?`<button onclick="lbNav(-1)" style="position:absolute;left:16px;background:rgba(255,255,255,.12);border:none;color:#fff;font-size:26px;padding:12px 16px;border-radius:8px;cursor:pointer"><i class="ti ti-chevron-left"></i></button>`:''}
    ${LB.idx<LB.filenames.length-1?`<button onclick="lbNav(1)" style="position:absolute;right:16px;background:rgba(255,255,255,.12);border:none;color:#fff;font-size:26px;padding:12px 16px;border-radius:8px;cursor:pointer"><i class="ti ti-chevron-right"></i></button>`:''}
    <img src="/uploads/${fname}" style="max-width:90vw;max-height:82vh;object-fit:contain;border-radius:6px;">
    <a href="/uploads/${fname}" download style="margin-top:12px;color:rgba(255,255,255,.6);font-size:14px;display:flex;align-items:center;gap:4px;text-decoration:none"><i class="ti ti-download"></i>${TR("Télécharger l'original")}</a>`;
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
  <div class="form-group"><label class="form-label">${TR('Téléphone')}</label><input class="form-input" id="f-tel" value="${esc(fmtTel(d.tel||''))}"></div>
  <div class="form-group"><label class="form-label">Portable</label><input class="form-input" id="f-portable" value="${esc(fmtTel(d.portable||''))}"></div>
  <div class="form-group" style="grid-column:1/-1"><label class="form-label">Adresse</label><input class="form-input" id="f-adresse" placeholder="12 rue des Lilas" value="${esc(d.adresse||'')}"></div>
  <div class="form-group" style="grid-column:1/-1"><label class="form-label">${TR("Complément d'adresse")}</label><input class="form-input" id="f-adresse2" placeholder="${TR("Bâtiment B, ZI de la Plaine…")}" value="${esc(d.adresse2||'')}"></div>
  <div class="form-group"><label class="form-label">Code postal</label><input class="form-input" id="f-cp" placeholder="17000" value="${esc(d.cp||'')}"></div>
  <div class="form-group"><label class="form-label">Ville</label><input class="form-input" id="f-ville" value="${esc(d.ville||'')}"></div>
  <div class="form-group"><label class="form-label">Pays</label><select class="form-input" id="f-pays">${optionsPays(d.pays||'France')}</select></div>
  <div class="form-group"><label class="form-label">${TR('Réseau')}</label>
    <select class="form-input" id="f-reseau">
      <option value="">${TR('— Aucun —')}</option>
      ${[['base','De base'],['bastide','Bastide'],['providom','Providom'],['districlub','DistriClub Medical'],['negocies','Négociés'],['capvital','CAP Vital'],['lecarre','Le Carré Medical']].map(r=>`<option value="${r[0]}" ${d.reseau_carte===r[0]?'selected':''}>${r[1]}</option>`).join('')}
    </select>
  </div>
  <div class="form-group"><label class="form-label">${TR('Priorité')}</label>
    <select class="form-input" id="f-priorite">
      <option value="">${TR('— Aucune —')}</option>
      ${[['T1','T1 — Priorité absolue'],['T2','T2 — Priorité moyenne'],['T3','T3 — Priorité basse']].map(p=>`<option value="${p[0]}" ${d.priorite===p[0]?'selected':''}>${p[1]}</option>`).join('')}
    </select>
  </div>
  <div class="form-group" style="grid-column:1/-1"><label class="form-label">Facturation</label>
    <select class="form-input" id="f-facturation-mode" onchange="toggleFacturation(this.value)">
      <option value="identique" ${!d.entite_facturation_id?'selected':''}>${TR('Identique (le distributeur se facture lui-même)')}</option>
      <option value="autre" ${d.entite_facturation_id?'selected':''}>${TR("Autre distributeur…")}</option>
    </select>
    <div id="f-entite-wrap" style="margin-top:8px;${d.entite_facturation_id?'':'display:none'}">
      <select class="form-input" id="f-entite">
        <option value="">${TR('— Choisir le distributeur facturé —')}</option>
        ${(window._clientsCache||[]).map(c=>`<option value="${c.id}" ${d.entite_facturation_id==c.id?'selected':''}>${esc(c.nom)}${c.ville?' — '+esc(c.ville):''}</option>`).join('')}
      </select>
    </div>
  </div>
  <div class="form-group" style="grid-column:1/-1">
    <label style="display:flex;align-items:center;gap:10px;padding:10px 14px;border:0.5px solid var(--border-s);border-radius:var(--radius);cursor:pointer;background:${d.sur_carte?'rgba(34,197,94,.08)':'var(--surface)'}">
      <input type="checkbox" id="f-sur-carte" ${d.sur_carte?'checked':''} style="width:16px;height:16px;accent-color:#22c55e">
      <div style="flex:1"><div style="font-size:15px;font-weight:600;color:#16a34a">🗺️ Afficher sur la carte distributeurs</div>
      <div style="font-size:13px;color:var(--text2)">${TR('Le point est créé et positionné depuis la ville, avec le réseau choisi ci-dessus')}</div></div>
    </label>
  </div>
  <div class="form-group" style="grid-column:1/-1">
    <label style="display:flex;align-items:center;gap:10px;padding:10px 14px;border:0.5px solid var(--border-s);border-radius:var(--radius);cursor:pointer;background:${d.public_site?'rgba(217,119,6,.08)':'var(--surface)'}">
      <input type="checkbox" id="f-public-site" ${d.public_site?'checked':''} style="width:16px;height:16px;accent-color:#d97706">
      <div style="flex:1"><div style="font-size:15px;font-weight:600;color:#b45309">🌐 Visible sur le site public (eloflex.fr)</div>
      <div style="font-size:13px;color:var(--text2)">${TR('Ce distributeur apparaîtra sur la carte publique du site (nom, adresse, téléphone uniquement). Nécessite une adresse et un positionnement.')}</div></div>
    </label>
  </div>
  <div class="form-group" style="grid-column:1/-1">
    <label style="display:flex;align-items:center;gap:10px;padding:10px 14px;border:0.5px solid var(--border-s);border-radius:var(--radius);cursor:pointer;background:${d.edi?'rgba(46,124,246,.08)':'var(--surface)'}">
      <input type="checkbox" id="f-edi" ${d.edi?'checked':''} style="width:16px;height:16px;accent-color:var(--accent)">
      <div><div style="font-size:15px;font-weight:600;color:var(--accent)">${TR('💳 EDI — Prélèvement automatique')}</div>
      <div style="font-size:13px;color:var(--text2)">${TR('Ce distributeur règle ses factures par prélèvement EDI')}</div></div>
    </label>
  </div>
</div>`;}
// Cache léger des clients (id/nom/ville) pour le sélecteur « Facturer à » de la fiche
async function ensureClientsCache(){ if(!window._clientsCache){ try{ const cs = await API.clients(); window._clientsCache = (cs||[]).map(c=>({id:c.id,nom:c.nom,ville:c.ville})); }catch(e){ window._clientsCache=[]; } } }
window.ensureClientsCache = ensureClientsCache;
function toggleFacturation(mode){ const w=document.getElementById('f-entite-wrap'); if(w) w.style.display=(mode==='autre')?'':'none'; }
window.toggleFacturation = toggleFacturation;
async function modalNewClient(){await ensureClientsCache();showModal(`<div class="modal-header"><i class="ti ti-user-plus" style="font-size:20px;color:var(--accent)"></i><h2>${TR('Nouveau client')}</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div><div class="modal-body">${clientForm()}</div><div class="modal-footer"><button class="btn" onclick="closeModal()">${t('btn_annuler')}</button><button class="btn primary" onclick="saveClient()"><i class="ti ti-check"></i>${t('btn_enregistrer')}</button></div>`);}
async function modalEditClient(id){const cl=await API.client(id);await ensureClientsCache();showModal(`<div class="modal-header"><i class="ti ti-edit" style="font-size:20px;color:var(--accent)"></i><h2>${TR('Modifier client')}</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div><div class="modal-body">${clientForm(cl)}</div><div class="modal-footer"><button class="btn danger" onclick="deleteClient(${id})"><i class="ti ti-trash"></i></button><button class="btn" onclick="closeModal()">${t('btn_annuler')}</button><button class="btn primary" onclick="saveClient(${id})"><i class="ti ti-check"></i>${t('btn_enregistrer')}</button></div>`);}
async function saveClient(id){
  const surCarte = !!document.getElementById('f-sur-carte')?.checked;
  // Réseau désormais indépendant de la carte ; si affiché sur carte sans réseau choisi, défaut 'base'
  let reseau = gv('f-reseau') || null;
  if (surCarte && !reseau) reseau = 'base';
  const data = {
    nom: gv('f-nom'), type: gv('f-type'), contact: gv('f-contact'),
    email: gv('f-email'), tel: gv('f-tel'), portable: gv('f-portable'),
    adresse: gv('f-adresse'), adresse2: gv('f-adresse2'),
    cp: gv('f-cp'), ville: gv('f-ville'), pays: gv('f-pays'),
    edi: !!document.getElementById('f-edi')?.checked,
    sur_carte: surCarte,
    public_site: !!document.getElementById('f-public-site')?.checked,
    priorite: gv('f-priorite') || null,
    reseau_carte: reseau
  };
  // Facturation : Identique (=null) ou Autre (id d'un distributeur existant)
  const factEl = document.getElementById('f-facturation-mode');
  if (factEl) {
    if (factEl.value === 'autre') {
      const eid = gv('f-entite');
      if (!eid) { alert(TR('Sélectionnez le distributeur à facturer, ou choisissez « Identique ».')); return; }
      data.entite_facturation_id = parseInt(eid);
    } else {
      data.entite_facturation_id = null;
    }
  }
  if(!data.nom){ alert(TR('Nom requis')); return; }
  if(surCarte && !data.ville && !data.cp){ alert(TR('Renseignez au moins le code postal ou la ville : ils servent à positionner le point sur la carte.')); return; }
  try{
    const r = id ? await API.updateClient(id, data) : await API.createClient(data);
    toast(id ? 'Client mis à jour' : 'Client créé');
    // Retour du positionnement sur la carte
    if (surCarte && r && r.carte && !r.carte.ok) {
      setTimeout(function(){ alert(TR('Client enregistré, mais non placé sur la carte :\n') + (r.carte.reason || 'raison inconnue') + '\n\nVous pouvez le positionner manuellement depuis la carte.'); }, 400);
    } else if (surCarte && r && r.carte && r.carte.action === 'cree') {
      setTimeout(function(){ toast(TR('Placé sur la carte'), 'ti-map-pin', 'var(--success)'); }, 600);
    }
    closeModal(); render();
  }catch(e){ alert(e.message); }
}
async function deleteClient(id){if(!confirm(t('confirm_suppr_client')))return;await API.deleteClient(id);toast(t('msg_supprime'),'ti-trash');closeModal();setView('clients');}

async function modalPortail(id,token){
  const base=window.location.origin;
  const url=token?`${base}/portail.html?token=${token}`:'Non disponible';
  showModal(`<div class="modal-header"><i class="ti ti-link" style="font-size:20px;color:var(--accent)"></i><h2>${TR("Lien portail client")}</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body">
      <p style="font-size:15px;color:var(--text2);margin-bottom:12px">${TR("Ce lien permet au client de suivre ses interventions en lecture seule, sans accès à l'administration.")}</p>
      <div class="portail-link"><i class="ti ti-external-link"></i><span id="portail-url">${esc(url)}</span></div>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn primary" onclick="navigator.clipboard.writeText('${esc(url)}');toast(TR('Lien copié'),'ti-copy')"><i class="ti ti-copy"></i>${TR("Copier")}</button>
        <button class="btn" onclick="regenererToken(${id})"><i class="ti ti-refresh"></i>${TR('Régénérer le lien')}</button>
      </div>
    </div>
    <div class="modal-footer"><button class="btn" onclick="closeModal()">${TR('Fermer')}</button></div>`);}

async function regenererToken(id){if(!confirm(TR('Régénérer invalide l\'ancien lien. Continuer ?')))return;const r=await API.regenererToken(id);const base=window.location.origin;const url=`${base}/portail.html?token=${r.token}`;$('portail-url').textContent=url;toast(TR('Lien régénéré'),'ti-refresh');}

// ── MODALES FAUTEUILS ─────────────────────────────────────────────

function fauteuilForm(d={}, clients=null){const mods=['Modèle L','Modèle F','Modèle P','Modèle D2','Modèle X','Modèle H','Modèle C3','Modèle C','Modèle K','Modèle H2','Modèle S1'];
  const selDistrib = Array.isArray(clients) ? `<div class="form-group" style="grid-column:1/-1"><label class="form-label">${TR('Distributeur')}</label><select class="form-input" id="f-client">${clients.map(c=>`<option value="${c.id}" ${d.client_id===c.id?'selected':''}>${esc(c.nom)}</option>`).join('')}</select></div>` : '';
  return `<div class="grid-2">
  ${selDistrib}
  <div class="form-group"><label class="form-label">${TR('Modèle *')}</label><select class="form-input" id="f-modele">${mods.map(m=>`<option ${d.modele===m?'selected':''}>${m}</option>`).join('')}</select></div>
  <div class="form-group"><label class="form-label">${TR('N° de série *')}</label><input class="form-input" id="f-serie" value="${esc(d.serie||'')}"></div>
  <div class="form-group"><label class="form-label">${TR('Année')}</label><input class="form-input" id="f-annee" type="number" value="${d.annee||new Date().getFullYear()}"></div>
  <div class="form-group"><label class="form-label">Couleur</label><input class="form-input" id="f-couleur" value="${esc(d.couleur||'')}"></div>
  <div class="form-group"><label class="form-label">Date d'achat</label><input class="form-input" id="f-dateachat" type="date" value="${d.date_achat||''}"></div>
  <div class="form-group"><label class="form-label">${TR('Durée garantie (mois)')}</label><input class="form-input" id="f-garduree" type="number" min="0" value="${d.duree_garantie_mois||24}"></div>
  <div class="form-group" style="grid-column:1/-1"><label class="form-label">${TR("N° facture VosFactures")}</label><input class="form-input" id="f-facture" value="${esc(d.num_facture||'')}"></div>
</div>
<div class="form-group"><label class="form-label">Notes</label><textarea class="form-input" id="f-notes">${esc(d.notes||'')}</textarea></div>`;}
function modalNewFauteuil(clientId){showModal(`<div class="modal-header"><i class="ti ti-wheelchair" style="font-size:20px;color:var(--accent)"></i><h2>${TR('Nouveau fauteuil')}</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div><div class="modal-body">${fauteuilForm()}</div><div class="modal-footer"><button class="btn" onclick="closeModal()">${t('btn_annuler')}</button><button class="btn primary" onclick="saveFauteuil(null,${clientId})"><i class="ti ti-check"></i>${t('btn_enregistrer')}</button></div>`);}
async function modalEditFauteuil(id){const [f,clients]=await Promise.all([API.fauteuil(id),API.clients()]);showModal(`<div class="modal-header"><i class="ti ti-edit" style="font-size:20px;color:var(--accent)"></i><h2>${TR('Modifier fauteuil')}</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div><div class="modal-body">${fauteuilForm(f,clients)}</div><div class="modal-footer"><button class="btn danger" onclick="deleteFauteuil(${id},${f.client_id})"><i class="ti ti-trash"></i></button><button class="btn" onclick="closeModal()">${t('btn_annuler')}</button><button class="btn primary" onclick="saveFauteuil(${id})"><i class="ti ti-check"></i>${t('btn_enregistrer')}</button></div>`);}
async function saveFauteuil(id,clientId){const selClient=gv('f-client');const data={client_id:selClient?parseInt(selClient):clientId,modele:gv('f-modele'),serie:gv('f-serie'),annee:parseInt(gv('f-annee')),couleur:gv('f-couleur'),date_achat:gv('f-dateachat'),duree_garantie_mois:parseInt(gv('f-garduree'))||24,num_facture:gv('f-facture'),notes:gv('f-notes')};if(!data.serie){alert(TR('N° de série requis'));return;}try{if(id)await API.updateFauteuil(id,data);else await API.createFauteuil(data);toast(id?'Fauteuil mis à jour':'Fauteuil créé');closeModal();render();}catch(e){alert(e.message);}}
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
  <div class="modal-header"><i class="ti ti-tool" style="font-size:20px;color:var(--accent)"></i><h2>${i?(i.num_sav?esc(i.num_sav):'#'+i.id):t('inter_nouvelle')}</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
  <div class="modal-body" style="max-height:74vh;overflow-y:auto">
    <div class="grid-2">
      <!-- FAUTEUIL — recherche libre dans toute la base -->
      <div class="form-group" style="grid-column:1/-1">
        <label class="form-label" style="display:flex;justify-content:space-between;align-items:center">
          <span>${TR('Fauteuil *')} <span style="font-size:13px;color:var(--text3);font-weight:400">${TR('(série, modèle ou distributeur)')}</span></span>
          <button type="button" class="btn sm" style="font-size:12px;padding:2px 7px" onclick="toggleNewFauteuilInline()"><i class="ti ti-plus"></i>${TR('Créer')}</button>
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
          <div style="font-size:13px;font-weight:700;color:var(--text2);margin-bottom:8px;text-transform:uppercase;letter-spacing:.4px">${TR('Nouveau fauteuil')}</div>
          <div class="grid-2" style="gap:6px">
            <div class="form-group" style="margin-bottom:4px"><label class="form-label">${TR('Modèle *')}</label>
              <select class="form-input" id="nf-modele">${['Eloflex L','Eloflex F','Eloflex D2','Eloflex X','Eloflex P','Eloflex H','Eloflex C','Eloflex C3','Eloflex K','Eloflex R','Eloflex S1','Eloflex M+'].map(m=>`<option>${m}</option>`).join('')}</select>
            </div>
            <div class="form-group" style="margin-bottom:4px">
              <label class="form-label" style="display:flex;justify-content:space-between;align-items:center">
                <span>${TR('N° de série *')}</span>
                <label style="display:flex;align-items:center;gap:4px;font-weight:400;font-size:13px;cursor:pointer">
                  <input type="checkbox" id="nf-serie-absent" onchange="toggleSerieAbsent(this.checked)">Numéro absent
                </label>
              </label>
              <input class="form-input mono" id="nf-serie" placeholder="ex: A06L2502011042">
              <div id="nf-serie-absent-msg" style="display:none;font-size:13px;color:var(--warning);margin-top:3px"><i class="ti ti-alert-triangle" style="font-size:13px"></i> ${TR('Numéro temporaire généré automatiquement')}</div>
            </div>
            <div class="form-group" style="margin-bottom:4px"><label class="form-label">Date d'achat</label><input class="form-input" id="nf-dateachat" type="date"></div>
            <div class="form-group" style="margin-bottom:4px"><label class="form-label">${TR('Durée garantie (mois)')}</label><input class="form-input" id="nf-garduree" type="number" value="24"></div>
          </div>
          <div style="display:flex;gap:6px;margin-top:4px">
            <button type="button" class="btn sm primary" onclick="createFauteuilInline()"><i class="ti ti-check"></i>${TR('Créer et sélectionner')}</button>
            <button type="button" class="btn sm" onclick="toggleNewFauteuilInline()">${t('btn_annuler')}</button>
          </div>
        </div>
      </div>

      <!-- DISTRIBUTEUR — avec option "autre distributeur" -->
      <div class="form-group" style="grid-column:1/-1">
        <label class="form-label" style="display:flex;justify-content:space-between;align-items:center">
          <span>${TR('Distributeur')}</span>
          <label style="display:flex;align-items:center;gap:5px;font-weight:400;font-size:13px;cursor:pointer">
            <input type="checkbox" id="f-autre-distrib" ${autreDistrib?"checked":""} onchange="toggleAutreDistrib(this.checked)">
            <span>${TR("Intervention chez un autre distributeur")}</span>
          </label>
        </label>
        <!-- Champ affiché par défaut : distributeur du fauteuil (lecture seule si pas coché) -->
        <div id="distrib-readonly" style="display:${autreDistrib?'none':'flex'};align-items:center;gap:8px;padding:8px 10px;background:var(--bg);border-radius:var(--radius);font-size:15px;border:1px solid var(--border)">
          <i class="ti ti-users" style="color:var(--text3)"></i>
          <span id="distrib-readonly-nom">${esc(clients.find(c=>c.id===(clientId||d.client_id))?.nom||'— sera renseigné depuis le fauteuil —')}</span>
          <input type="hidden" id="f-client" value="${clientId||d.client_id||''}">
        </div>
        <!-- Champ de recherche : visible si "autre distributeur" coché -->
        <div id="distrib-search-wrap" style="display:${autreDistrib?'block':'none'};position:relative">
          <input class="form-input" id="f-client-search" autocomplete="off"
            placeholder="${TR("Rechercher le distributeur…")}"
            value="${autreDistrib ? esc(clients.find(c=>c.id===clientId)?.nom||'') : ''}"
            oninput="document.getElementById('f-client').value='';searchClients(this.value,TMP_CLIENTS)"
            onfocus="searchClients(this.value,TMP_CLIENTS)"
            onblur="setTimeout(()=>{const dr=document.getElementById('client-drop');if(dr)dr.style.display='none'},150)">
          <div id="client-drop" class="piece-dropdown" style="display:none"></div>
        </div>
        <div style="font-size:13px;color:var(--text3);margin-top:4px">
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
        <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:14px"><input type="radio" name="garantie" value="1" ${!i||i.garantie?'checked':''}> <span class="badge g">${t('inter_sous_garantie')}</span></label>
        <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:14px"><input type="radio" name="garantie" value="0" ${i&&!i.garantie?'checked':''}> <span class="badge hg">${t('inter_hors_garantie')}</span></label>
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
      <div class="form-group" style="margin-bottom:0;grid-column:1/-1"><label class="form-label">${TR("N° de suivi retour")}</label><input class="form-input" id="f-ret-num" value="${esc(d.retour_numero||'')}"></div>
    </div></div>
    <div class="divider"></div>
    <div class="section-title"><i class="ti ti-receipt"></i>Lien VosFactures</div>
    <div class="form-group" style="margin-bottom:4px">
      <label class="form-label">${TR("N° bordereau / bon de livraison VosFactures")}</label>
      <input class="form-input mono" id="f-bordereau" placeholder="ex: BL-2026-0042" value="${esc(d.num_bordereau_vf||'')}">
      <div style="font-size:13px;color:var(--text3);margin-top:3px">${TR("Permet d'accéder directement au document dans VosFactures depuis la fiche intervention.")}</div>
    </div>
  </div>
  <div class="modal-footer">
    ${i?`<button class="btn danger" onclick="if(confirm(TR('Supprimer ?')))API.deleteIntervention(${i.id}).then(()=>{closeModal();render();toast(t('msg_supprime'),'ti-trash');})"><i class="ti ti-trash"></i></button>`:''}
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
    <div style="font-size:14px;font-weight:600">${esc(p.designation)}</div>
    <div style="font-size:13px;color:var(--text3);display:flex;gap:8px"><span class="mono">${esc(p.ref)}</span><span style="margin-left:auto">${parseFloat(p.pxht||0).toFixed(2)} €</span></div>
  </div>`).join('');
  drop.style.display='block';
}
function renderProduitsForm(){
  const el=$('produits-list');if(!el)return;
  if(!TMP_PRODUITS.length){el.innerHTML='<div style="font-size:14px;color:var(--text3)">'+TR("Aucune pièce")+'</div>';return;}
  el.innerHTML=TMP_PRODUITS.map((p,i)=>`
    <div style="display:grid;grid-template-columns:2fr 0.8fr 0.5fr 0.7fr auto;gap:5px;align-items:start;margin-bottom:8px">
      <div>
        ${i===0?`<div class="form-label">${t('col_designation_court')||'Désignation'}</div>`:''}
        <div style="position:relative">
          <input class="form-input piece-search" style="font-size:14px" placeholder="${t('cat_search_placeholder')||'Taper nom ou référence…'}"
            value="${esc(p.designation)}"
            oninput="TMP_PRODUITS[${i}].designation=this.value;searchPieces(${i},this.value)"
            onfocus="searchPieces(${i},this.value)"
            onblur="setTimeout(()=>{const d=document.getElementById('piece-drop-${i}');if(d)d.style.display='none'},150)">
          <div id="piece-drop-${i}" class="piece-dropdown" style="display:none"></div>
        </div>
      </div>
      <div>${i===0?'<div class="form-label">'+TR("Réf")+'</div>':''}<input class="form-input mono" style="font-size:13px" value="${esc(p.ref)}" oninput="TMP_PRODUITS[${i}].ref=this.value"></div>
      <div>${i===0?`<div class="form-label">${t('col_qte')||'Qté'}</div>`:''}<input class="form-input piece-qte" type="number" min="1" value="${p.qte}" oninput="TMP_PRODUITS[${i}].qte=parseInt(this.value)||1"></div>
      <div>${i===0?'<div class="form-label">PU HT</div>':''}<input class="form-input" type="number" step="0.01" value="${parseFloat(p.pxht||0).toFixed(2)}" oninput="TMP_PRODUITS[${i}].pxht=parseFloat(this.value)||0"></div>
      <div style="${i===0?'padding-top:18px':''}"><button class="btn sm danger" onclick="removeProduit(${i})"><i class="ti ti-x"></i></button></div>
    </div>`).join('');
}

// ── Bascule SAV <-> commande ─────────────────────────────────────
async function basculerSAVversCommande(id){
  try{
    const r = await API.basculerSAVenCommande(id);
    if(r && r.commande_id){
      toast(r.existant?'Commande liée déjà existante':'Commande « SAV facturé » créée','ti-clipboard-check','var(--success)');
      closeModal(); setView('commandes'); setTimeout(()=>modalCommande(r.commande_id), 250);
    } else alert((r&&r.error)||'Échec de la bascule');
  }catch(e){ alert(e.message); }
}
window.basculerSAVversCommande = basculerSAVversCommande;
async function ouvrirCommandeLiee(cid){ closeModal(); setView('commandes'); setTimeout(()=>modalCommande(cid), 250); }
window.ouvrirCommandeLiee = ouvrirCommandeLiee;
async function basculerCommandeVersSAV(id){
  try{
    const r = await API.basculerCommandeenSAV(id);
    if(r && r.intervention_id){
      toast(r.existant?'SAV lié déjà existant':'SAV créé depuis la commande','ti-tool','var(--success)');
      closeModal(); setView('interventions'); setTimeout(()=>viewIntervention(r.intervention_id), 250);
    } else alert((r&&r.error)||'Échec de la bascule');
  }catch(e){ alert(e.message); }
}
window.basculerCommandeVersSAV = basculerCommandeVersSAV;
async function ouvrirInterventionLiee(iid){ closeModal(); setView('interventions'); setTimeout(()=>viewIntervention(iid), 250); }
window.ouvrirInterventionLiee = ouvrirInterventionLiee;

async function saveIntervention(id){
  const data={fauteuil_id:parseInt(gv('f-fauteuil')),client_id:parseInt(gv('f-client')),num_sav:gv('f-num-sav')||undefined,date:gv('f-date'),type:gv('f-type'),statut:gv('f-statut'),technicien:gv('f-tech'),garantie:document.querySelector('input[name="garantie"]:checked')?.value==='1',description:gv('f-desc'),notes:gv('f-notes'),envoi_transporteur:gv('f-env-trans'),envoi_numero:gv('f-env-num'),envoi_date:gv('f-env-date'),retour_transporteur:gv('f-ret-trans'),retour_numero:gv('f-ret-num'),retour_date:gv('f-ret-date'),num_bordereau_vf:gv('f-bordereau')||undefined,produits:TMP_PRODUITS};
  if(!data.fauteuil_id||!data.date){alert(TR('Fauteuil et date requis'));return;}
  try{if(id)await API.updateIntervention(id,data);else await API.createIntervention(data);TMP_PRODUITS=[];toast(id?'Intervention mise à jour':'Intervention créée');closeModal();render();refreshBadges();}catch(e){alert(e.message);}
}

// ── MODALES CATALOGUE ─────────────────────────────────────────────

async function modalPiece(id){
  const p=id?CACHE.catalogue.find(x=>x.id===id)||await API.catalogue().then(l=>l.find(x=>x.id===id)):null;
  showModal(`<div class="modal-header"><i class="ti ti-box" style="font-size:20px;color:var(--accent)"></i><h2>${id?'Modifier pièce':'Nouvelle pièce'}</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body"><div class="grid-2">
      <div class="form-group"><label class="form-label">${TR('Référence *')}</label><input class="form-input mono" id="f-ref" value="${esc(p?.ref||'')}"></div>
      <div class="form-group"><label class="form-label">${TR('Réf fournisseur')}</label><input class="form-input mono" id="f-reffou" value="${esc(p?.ref_fournisseur||'')}"></div>
      <div class="form-group" style="grid-column:1/-1"><label class="form-label">${TR('Désignation *')}</label><input class="form-input" id="f-des" value="${esc(p?.designation||'')}"></div>
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
async function savePiece(id){const data={ref:gv('f-ref'),designation:gv('f-des'),fournisseur:gv('f-fou'),ref_fournisseur:gv('f-reffou'),pxht:parseFloat(gv('f-px'))||0,stock:parseInt(gv('f-stock'))||0,stock_alerte:parseInt(gv('f-stalerte'))||2,vf_product_id:parseInt(gv('f-vfid'))||null};if(!data.ref||!data.designation){alert(TR('Référence et désignation requises'));return;}try{if(id)await API.updatePiece(id,data);else await API.createPiece(data);CACHE.catalogue=[];toast(id?'Pièce mise à jour':'Pièce ajoutée');closeModal();render();refreshBadges();}catch(e){alert(e.message);}}
async function deletePiece(id){if(!confirm(TR('Supprimer ?')))return;await API.deletePiece(id);CACHE.catalogue=[];toast(t('msg_supprime'),'ti-trash');closeModal();render();}

// ── EXPORTS PDF ───────────────────────────────────────────────────

async function exportInterventionPDF(id){const i=await API.intervention(id);PDF.intervention(i);toast(t('msg_pdf_genere'),'ti-file-type-pdf');}
async function exportFauteuilPDF(id){const f=await API.fauteuil(id);PDF.fauteuil(f,f.interventions||[]);toast(t('msg_pdf_genere'),'ti-file-type-pdf');}
async function exportClientPDF(id){const cl=await API.client(id);const inters=await API.interventions({client_id:id});PDF.client(cl,cl.fauteuils||[],inters);toast(t('msg_pdf_genere'),'ti-file-type-pdf');}

// ── VOSFACTURES ───────────────────────────────────────────────────

async function importerHistoriqueCommandes(file){
  const el=$('import-commandes-result'); if(!el) return;
  if(!file){ el.innerHTML=''; return; }
  el.innerHTML=`<div style="font-size:14px;color:var(--text2)"><i class="ti ti-loader-2"></i> Import en cours… (peut prendre 1-3 min selon la taille du fichier)</div>`;
  try{
    const r = await API.importCommandesExcel(file);
    const annees = Object.entries(r.stats.par_annee||{}).map(([a,n])=>`${a} : ${n} nouvelles`).join(', ');
    el.innerHTML=`<div style="padding:10px 12px;background:var(--success-bg);border:0.5px solid var(--success);border-radius:var(--radius);font-size:14px">
      <div style="font-weight:700;color:var(--success);margin-bottom:6px"><i class="ti ti-check"></i> ${TR('Import terminé !')}</div>
      <div>${TR('Onglets traités :')} <b>${r.annees?.join(', ')||'—'}</b></div>
      <div>Nouvelles commandes : <b>${r.stats.inserees}</b> ${TR('· Mises à jour :')} <b>${r.stats.maj}</b> · Nouveaux clients : <b>${r.stats.clients_crees}</b></div>
      ${annees?`<div style="margin-top:4px;color:var(--text2)">${annees}</div>`:''}
      ${r.stats.erreurs?`<div style="color:var(--danger);margin-top:4px">⚠ ${r.stats.erreurs} erreur(s)${r.stats.premiere_erreur?' — Première : '+r.stats.premiere_erreur:''}</div>`:''}
    </div>`;
    toast(`Import terminé — ${r.stats.inserees} commandes importées`,'ti-table-import');
  }catch(e){
    el.innerHTML=`<div style="padding:10px 12px;background:var(--danger-bg);border:0.5px solid var(--danger);border-radius:var(--radius);font-size:14px;color:var(--danger)">
      ❌ Erreur : <b>${esc(e.message)}</b><br>
      <span style="font-size:13px;color:var(--text2)">${TR("Vérifie que tu as bien sélectionné le bon fichier Excel (Compta_Eloflex…) et recharge la page si l'erreur persiste.")}</span>
    </div>`;
  }
}

async function genererFacturePennylaneModal(id){
  if(!confirm(TR('Créer un brouillon de facture dans Pennylane ?\n\nLa facture sera créée en brouillon — tu pourras la vérifier et la finaliser dans Pennylane.'))) return;
  toast(TR('Création en cours dans Pennylane…'),'ti-loader-2');
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
  if(el) el.innerHTML = `<div style="font-size:14px;color:var(--text2)"><i class="ti ti-loader-2"></i> Synchronisation en cours…</div>`;
  try {
    const r = await API.pennylaneSyncCommandes(full);
    if(el) el.innerHTML = `<div style="font-size:14px;color:var(--success)"><i class="ti ti-check"></i> ${esc(r.message||'OK')}</div>`;
    toast(r.message || 'Sync Pennylane terminé', 'ti-check');
  } catch(e) {
    if(el) el.innerHTML = `<div style="font-size:14px;color:var(--danger)">❌ ${esc(e.message)}</div>`;
  }
}

async function loadPennylaneStatus(){
  const badge = $('pl-status-badge'); if(!badge) return;
  try {
    const s = await API.pennylaneStatus();
    if(s.configured){
      badge.innerHTML = `<span class="badge g" style="font-size:12px">✓ Connecté${s.account?.email?' — '+esc(s.account.email):''}</span>`;
    } else {
      badge.innerHTML = `<span class="badge hg" style="font-size:12px">${TR('Non configuré')}</span>`;
    }
  } catch(_) {
    badge.innerHTML = `<span class="badge hg" style="font-size:12px">${TR('Erreur')}</span>`;
  }
}

async function syncVosFactures(){  const btn=$('btn-sync');if(btn){btn.disabled=true;btn.innerHTML='<i class="ti ti-loader-2"></i>Sync…';}
  try{const r=await API.vfSync();toast(`Sync OK — ${r.results.clients} clients, ${r.results.products} produits`,'ti-refresh');CACHE.catalogue=[];render();}
  catch(e){toast(TR('Erreur sync : ')+e.message,'ti-alert-circle','var(--danger)');}
  finally{if(btn){btn.disabled=false;btn.innerHTML='<i class="ti ti-refresh"></i>Sync VosFactures';}loadVfStatus();}
}
async function loadVfStatus(){
  try{const s=await API.vfStatus();
    if(s.account) window._VF_ACCOUNT=s.account; // Stocké pour construire les liens VF (toujours, même sans widget vf-status)
    const el=$('vf-status');if(!el)return;
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
  }catch(e){alert(TR('Erreur email : ')+e.message);}
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
  showModal(`<div class="modal-header"><i class="ti ti-package" style="font-size:20px;color:var(--accent)"></i><h2>${id?t('retours_modal_edit'):t('retours_modal_new')}</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
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
  c.innerHTML=`<div style="font-size:14px;color:var(--text2);margin-bottom:12px">${t('transferts_subtitle')}</div>`;
  if(!list.length){c.innerHTML+=`<div class="empty"><i class="ti ti-arrows-exchange"></i><p>${t('transferts_empty')}</p></div>`;return;}
  const scT={'En préparation':'attente','En transit':'ouvert','Arrivé':'g','Annulé':'urgent'};
  const stTr={'En préparation':t('transferts_statut_prep'),'En transit':t('transferts_statut_transit'),'Arrivé':t('transferts_statut_arrive'),'Annulé':t('transferts_statut_annule')};
  c.innerHTML+=`<div class="table-wrap"><table class="t">
    <thead><tr><th>${t('transferts_fauteuil').replace(' *','')}</th><th>${t('transferts_depart')}</th><th>${t('transferts_date_depart')}</th><th>${t('transferts_arrivee')}</th><th>${t('transferts_date_arrivee')}</th><th>${t('col_transporteur')}</th><th>${t('transferts_num_suivi')}</th><th>${t('col_statut')}</th><th></th></tr></thead>
    <tbody>${list.map(tr=>`<tr onclick="modalTransfert(${tr.id})">
      <td><div style="font-weight:600">${esc(tr.modele||'—')}</div><div class="mono" style="color:var(--text3);font-size:13px">${esc(tr.serie||'')}</div></td>
      <td>${esc(tr.client_depart_nom||'—')}</td>
      <td>${tr.date_depart?fd(tr.date_depart):'—'}</td>
      <td>${esc(tr.client_arrivee_nom||'—')}</td>
      <td>${tr.date_arrivee?fd(tr.date_arrivee):'—'}</td>
      <td>${esc(tr.transporteur||'—')}</td>
      <td class="mono" style="font-size:13px">${tr.num_suivi?`${esc(tr.num_suivi)} <a href="${lienhSuiviInter(tr.transporteur,tr.num_suivi)}" target="_blank" rel="noopener" onclick="event.stopPropagation()"><i class="ti ti-external-link" style="color:var(--accent)"></i></a>`:'—'}</td>
      <td><span class="badge ${scT[tr.statut]||''}">${stTr[tr.statut]||esc(tr.statut)}</span></td>
      <td><button class="btn sm danger" onclick="event.stopPropagation();if(confirm(t('transferts_confirm_suppr')))API.deleteTransfert(${tr.id}).then(()=>{render();toast(t('msg_supprime'),'ti-trash')})"><i class="ti ti-trash"></i></button></td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

// ══════════════════════════════════════════════════════════════════
// PARC DÉMO — vue consolidée (lecture seule) : démos déclarées +
// transferts + prêts/essais, pour piloter le parc de démonstration.
// ══════════════════════════════════════════════════════════════════
const _SNZ = s => (s||'').toString().toUpperCase().replace(/[^A-Z0-9]/g,'');
const _PRET_ACTIF = ['signe','en_cours','prolonge','retard'];
let PARC_SHOW_CONCLUES = false;   // (obsolète) — remplacé par les onglets du Parc de démo
function parcToggleConclues(v){ PARC_SHOW_CONCLUES = !!v; render(); }
let PARC_TAB = 'demo';            // onglet actif du Parc de démo : 'demo' | 'dispo' | 'hist'
window.parcToggleConclues = parcToggleConclues;
// Seule la VENTE fait sortir une démo du parc. Un retour à Éloflex France la garde
// dans le parc, « Disponible » pour un nouvel essai.
function parcDemoStatut(d){
  if(d.demo_suivi_resultat==='facture') return {l:'Vendu',c:'#15803d',ic:'ti-cash'};
  if(d.demo_suivi_resultat==='avoir')   return {l:'Avoir',c:'#6b7280',ic:'ti-receipt-refund'};
  if(d.demo_suivi_resultat==='retour')  return {l:'Disponible',c:'#2563eb',ic:'ti-home-check'};
  if(d.rappel_echu)                     return {l:'Rappel échu',c:'#dc2626',ic:'ti-clock-exclamation'};
  return {l:'En démo',c:'#0d9488',ic:'ti-wheelchair'};
}
// Normalise un libellé de modèle vers sa famille (Modèle H2, D2, P, F, R…) pour le comptage.
function demoModele(m){
  const s=(m||'').toString();
  const mm=s.match(/mod[eè]le\s+([A-Za-z]?[0-9]?[A-Za-z0-9]{0,2})/i);
  if(mm) return 'Modèle '+mm[1].toUpperCase();
  const known=['H2','D2','C3','P','F','R','K','X','L'];
  const hit=s.toUpperCase().split(/[^A-Z0-9]+/).find(tk=>known.includes(tk));
  if(hit) return 'Modèle '+hit;
  return s.trim()||'—';
}
async function renderParcDemo(ttl,c,a){
  ttl.textContent = TR('Parc de démo');
  a.innerHTML = `<button class="btn sm" onclick="render()"><i class="ti ti-refresh"></i>${TR('Actualiser')}</button>`;
  c.innerHTML = `<div style="color:var(--text2);font-size:15px;padding:16px 0"><i class="ti ti-loader-2"></i> ${t('msg_chargement')||'Chargement…'}</div>`;
  let demos=[], prets=[], transferts=[];
  try{
    demos = await API.demosParc();
    prets = await API.prets().catch(()=>[]);
    transferts = await API.transferts().catch(()=>[]);
  }catch(e){ c.innerHTML=`<div class="empty"><i class="ti ti-alert-circle"></i>Erreur : ${esc(e.message)}</div>`; return; }

  // Le statut de commande « Avoir » fait autorité : la démo est une annulation → résultat 'avoir'
  // (sort du parc actif), même si elle avait été marquée « Vendue » auparavant.
  demos.forEach(d=>{ if((d.statut||'')==='Avoir') d.demo_suivi_resultat='avoir'; });

  const fdate = d => d ? fd((''+d).slice(0,10)) : '—';
  const _today = new Date().toISOString().slice(0,10);
  const _recence = d => (''+(d.date_livraison||d.date_commande||'0000-00-00')).slice(0,10) + '#' + String(d.id||0).padStart(12,'0');

  // ── Regroupement par n° de série = unité physique ──────────────────────────
  // Une même unité peut enchaîner plusieurs épisodes de démo (distributeurs
  // successifs, retours, reconditionnements). L'ÉPISODE LE PLUS RÉCENT définit
  // l'état courant de l'unité : ainsi un fauteuil revendu par un 2ᵉ distributeur
  // sort du parc même si un ancien épisode « retour » subsiste. Les démos sans
  // n° de série restent comptées individuellement (unité non traçable).
  const _bySerie = new Map();
  const unites = [];                       // { rep, hist:[], sn }
  demos.forEach(d=>{
    const sn=_SNZ(d.num_serie);
    if(!sn){ unites.push({rep:d, hist:[d], sn:null}); return; }
    if(!_bySerie.has(sn)){ const u={rep:d, hist:[d], sn}; _bySerie.set(sn,u); unites.push(u); }
    else { const u=_bySerie.get(sn); u.hist.push(d); if(_recence(d) > _recence(u.rep)) u.rep=d; }
  });
  const _stU = u => u.rep.demo_suivi_resultat;                 // état courant = épisode le plus récent
  const _TERMINAL = ['facture','avoir'];                       // états qui sortent l'unité du parc actif
  const parcActif   = unites.filter(u=>!_TERMINAL.includes(_stU(u)));  // en essai + disponibles
  const enEssai     = unites.filter(u=>!_stU(u));              // sorties chez un distributeur
  const disponibles = unites.filter(u=>_stU(u)==='retour');   // revenues à Éloflex FR
  const echues      = enEssai.filter(u=>u.rep.rappel_echu);
  const vendues     = unites.filter(u=>_stU(u)==='facture');
  const avoirs      = unites.filter(u=>_stU(u)==='avoir');    // clôturées par avoir (annulation)
  const transEnCours = transferts.filter(tr=>tr.statut!=='Arrivé' && tr.statut!=='Annulé');
  const pretsActifs  = prets.filter(p=>_PRET_ACTIF.includes(p.statut));
  const serieEnTransit = new Set(transEnCours.map(tr=>_SNZ(tr.serie)).filter(Boolean));

  // ── Pivot n° de série : rattacher les prêts actifs et transferts à chaque unité ──
  const pretParSerie = new Map();   // série normalisée -> prêt actif (le plus récent rattaché)
  pretsActifs.forEach(p=>{ pretArticlesOf(p).forEach(ar=>{ const sn=_SNZ(ar.num_serie); if(sn && !pretParSerie.has(sn)) pretParSerie.set(sn, p); }); });
  const transParSerie = new Map();  // série normalisée -> transfert en cours
  transEnCours.forEach(tr=>{ const sn=_SNZ(tr.serie); if(sn && !transParSerie.has(sn)) transParSerie.set(sn, tr); });
  const sansSerie = parcActif.filter(u=>!u.sn).length;
  const _aAvoir = d => !!(d && (d.a_avoir || (d.num_avoir && (''+d.num_avoir).trim())));
  // Démos marquées « Vendues » alors qu'un avoir existe : une vente annulée par avoir
  // devrait normalement être clôturée en « Retour ». À vérifier par l'utilisateur.
  const venduAvecAvoir = vendues.filter(u=>_aAvoir(u.rep)).length;

  const tiles = `<div class="grid-2" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:14px">
    <div class="stat-card"><div class="stat-label">${TR('Parc démo (actif)')}</div><div class="stat-value" style="color:#0d9488">${parcActif.length}</div></div>
    <div class="stat-card"><div class="stat-label">${TR('En essai')}</div><div class="stat-value" style="color:#0d9488">${enEssai.length}</div></div>
    <div class="stat-card"><div class="stat-label">${TR('Disponibles')}</div><div class="stat-value" style="color:#2563eb">${disponibles.length}</div></div>
    <div class="stat-card"><div class="stat-label">${TR('Rappels échus')}</div><div class="stat-value" style="color:${echues.length?'var(--danger)':'var(--text)'}">${echues.length}</div></div>
    <div class="stat-card"><div class="stat-label">${TR('Transferts en cours')}</div><div class="stat-value" style="color:#2563eb">${transEnCours.length}</div></div>
    <div class="stat-card"><div class="stat-label">${TR('Vendues')}</div><div class="stat-value" style="color:#15803d">${vendues.length}</div></div>
  </div>`;

  // ── Compteur par modèle (parc actif) : En essai / Disponibles / Total + vendues (cumul) ──
  const grp = {};
  parcActif.forEach(u=>{ const k=demoModele(u.rep.modele); const g=grp[k]||(grp[k]={modele:k,essai:0,dispo:0}); if(_stU(u)==='retour') g.dispo++; else g.essai++; });
  const venduGrp = {};
  vendues.forEach(u=>{ const k=demoModele(u.rep.modele); venduGrp[k]=(venduGrp[k]||0)+1; });
  const grpList = Object.values(grp).sort((x,y)=>(y.essai+y.dispo)-(x.essai+x.dispo));
  const compteurModele = grpList.length ? `<div class="card" style="margin-bottom:14px">
    <div class="section-title"><i class="ti ti-list-numbers"></i>${TR('Compteur par modèle')}</div>
    <div class="table-wrap"><table class="t">
      <thead><tr><th>${TR('Modèle')}</th><th style="text-align:center">${TR('En essai')}</th><th style="text-align:center">${TR('Disponibles')}</th><th style="text-align:center">${TR('Total parc')}</th><th style="text-align:center">${TR('Vendues (cumul)')}</th></tr></thead>
      <tbody>${grpList.map(g=>`<tr>
        <td style="font-weight:600">${esc(g.modele)}</td>
        <td style="text-align:center;color:#0d9488;font-weight:600">${g.essai}</td>
        <td style="text-align:center;color:#2563eb;font-weight:600">${g.dispo}</td>
        <td style="text-align:center;font-weight:700">${g.essai+g.dispo}</td>
        <td style="text-align:center;color:var(--text3)">${venduGrp[g.modele]||0}</td>
      </tr>`).join('')}
      <tr style="border-top:2px solid var(--border)"><td style="font-weight:700">${TR('Total')}</td>
        <td style="text-align:center;font-weight:700">${enEssai.length}</td>
        <td style="text-align:center;font-weight:700">${disponibles.length}</td>
        <td style="text-align:center;font-weight:700">${parcActif.length}</td>
        <td style="text-align:center;font-weight:700;color:var(--text3)">${vendues.length}</td></tr>
      </tbody>
    </table></div>
  </div>` : '';

  // ── Trois onglets : En démo (en essai) · Disponibles (revenus) · Historique ──
  // Une unité vit dans « En démo » tant qu'elle est en essai, bascule en
  // « Disponibles » à son retour ; chaque stint terminé (stint antérieur =
  // changement de main, ou vente) est journalisé dans « Historique ».
  function parcRow(u, ep, mode){
    const d = ep;
    const sn = u.sn;
    const isHist = mode==='hist';
    const supersede = isHist && !d.demo_suivi_resultat;   // épisode passé non clôturé = changement de main
    const s = supersede ? {l:TR('Changé de main'),c:'#6b7280',ic:'ti-arrows-exchange'} : parcDemoStatut(d);
    const enMvt = !isHist && sn && serieEnTransit.has(sn);
    const pretLie = (!isHist && sn) ? pretParSerie.get(sn) : null;   // prêt actif rattaché (par n° de série)
    const pretHolder = pretLie ? (pretLie.client_nom_actuel || pretLie.distributeur_nom || '') : '';
    const detenteur = d.demo_suivi_resultat==='retour'
      ? 'Éloflex France'
      : (pretHolder || d.demo_localisation_actuelle || d.client_nom || d.distributeur_nom || '—');
    const echeance = (!isHist && pretLie && pretLie.date_retour_prevue) ? (''+pretLie.date_retour_prevue).slice(0,10) : (isHist ? null : d.demo_rappel_date);
    const echEchue = echeance && (''+echeance).slice(0,10) <= _today && d.demo_suivi_resultat!=='facture';
    const mise = d.date_livraison || d.date_commande;
    // Parcours de l'unité (épisodes chronologiques) pour l'info-bulle.
    const histSorted = u.hist.slice().sort((x,y)=>_recence(x).localeCompare(_recence(y)));
    const parcoursTxt = histSorted.map(h=>{
      const who = h.demo_localisation_actuelle||h.client_nom||h.distributeur_nom||'?';
      const r = h.demo_suivi_resultat==='facture'?TR('vendu'):h.demo_suivi_resultat==='retour'?TR('retour'):TR('en démo');
      return who+' ('+r+(_aAvoir(h)?', '+TR('avoir'):'')+')';
    }).join('  →  ');
    const cle = (d.modele||'')+' '+(d.num_serie||'')+' '+(detenteur||'')+' '+(d.demo_origine_nom||'')+' '+(pretHolder||'')+' '+parcoursTxt;
    const histBadge = (!isHist && u.hist.length>1)
      ? ` <span class="badge" style="background:var(--surface-2,#eef1f4);color:var(--text2);border:0.5px solid var(--border-s);font-size:12px;cursor:help" title="${TR('Parcours de l’unité')} : ${esc(parcoursTxt)}"><i class="ti ti-history" style="font-size:13px;margin-right:2px"></i>${u.hist.length} ${TR('épisodes')}</span>`
      : '';
    const serieCell = d.num_serie
      ? `<span class="mono">${esc(d.num_serie)}</span>`
      : `<span class="badge" style="background:var(--warning-bg);color:var(--warning);border:0.5px solid rgba(180,85,31,.3);font-size:12px" title="${TR('Renseignez le n° de série pour suivre l’unité physique et ses transferts')}"><i class="ti ti-alert-triangle" style="font-size:13px;margin-right:2px"></i>${TR('à renseigner')}</span>`;
    const pretBadgeHtml = pretLie
      ? ` <span class="badge" style="background:#7c3aed18;color:#7c3aed;border:0.5px solid #7c3aed44;font-size:12px;cursor:pointer" title="${TR('Prêt actif rattaché à cette unité')} — ${esc(PRET_FORMULES[pretLie.formule]||pretLie.formule||'')}${pretLie.date_retour_prevue?' · '+TR('retour prévu')+' '+fdate(pretLie.date_retour_prevue):''}" onclick="modalPret(${pretLie.id})"><i class="ti ti-file-certificate" style="font-size:13px;margin-right:2px"></i>${TR('prêt')}</span>`
      : '';
    // Réservation : unité promise à un distributeur en attente, à son retour.
    const resaBadge = (!isHist && d.demo_reservation)
      ? ` <span class="badge" style="background:#7c3aed18;color:#7c3aed;border:0.5px solid #7c3aed44;font-size:12px;cursor:pointer" title="${TR('Réservée au retour — cliquez pour modifier / retirer')}" onclick="reserverDemoRetour(${d.id},'${esc((d.demo_reservation||'').replace(/'/g,'&#39;'))}')"><i class="ti ti-bookmark" style="font-size:13px;margin-right:2px"></i>${TR('réservé')} : ${esc(d.demo_reservation)}</span>`
      : '';
    const aAvoir = _aAvoir(d);
    const avoirBadge = (d.demo_suivi_resultat==='facture' && aAvoir)
      ? ` <span class="badge" style="background:#dc262618;color:#dc2626;border:0.5px solid #dc262644;font-size:12px;cursor:pointer" title="${TR('Marquée Vendue mais un avoir existe')}${d.num_avoir?' ('+esc(d.num_avoir)+')':''} — ${TR('vente annulée par avoir : cliquez pour la clôturer en « Avoir » (sort du parc).')}" onclick="demoCloturer(${d.id},'avoir')"><i class="ti ti-alert-triangle" style="font-size:13px;margin-right:2px"></i>${TR('avoir ?')}</span>`
      : ((aAvoir && d.demo_suivi_resultat!=='avoir') ? ` <span class="badge" style="background:#f59e0b18;color:#b45309;border:0.5px solid #f59e0b44;font-size:12px" title="${TR('Un avoir est enregistré sur cette commande')}${d.num_avoir?' ('+esc(d.num_avoir)+')':''}"><i class="ti ti-receipt-refund" style="font-size:13px;margin-right:2px"></i>${TR('avoir')}</span>` : '');
    const voirBtn = `<button class="btn sm" title="${TR('Voir dans le suivi commandes')}" onclick="setView('commandes',{q:'${esc((d.num_serie||d.bdc||d.modele||'').replace(/'/g,'&#39;'))}'})"><i class="ti ti-arrow-right"></i></button>`;
    const actions = isHist
      ? voirBtn
      : `${!d.demo_suivi_resultat ? `<button class="btn sm" title="${TR('Retour à Éloflex France (redevient disponible)')}" onclick="demoCloturer(${d.id},'retour')"><i class="ti ti-truck-return"></i></button><button class="btn sm" title="${TR('Prolonger le rappel')}" onclick="demoProlonger(${d.id},'${d.demo_rappel_date||''}')"><i class="ti ti-calendar-plus"></i></button>` : ''}${d.demo_suivi_resultat!=='facture' ? `<button class="btn sm success" title="${TR('Marquer vendu / facturé')}" onclick="demoCloturer(${d.id},'facture')"><i class="ti ti-file-euro"></i></button>` : ''}<button class="btn sm" title="${TR('Clôturer en avoir (annulation — sort du parc)')}" onclick="demoCloturer(${d.id},'avoir')"><i class="ti ti-receipt-refund"></i></button>${voirBtn}`;
    return `<tr data-k="${esc(cle.toLowerCase())}">
      <td><span class="badge" style="background:${s.c}22;color:${s.c};border:0.5px solid ${s.c}55"><i class="ti ${s.ic}" style="font-size:14px;margin-right:3px"></i>${s.l}</span>${enMvt?` <span class="badge ouvert" title="${TR('Un transfert est en cours pour ce n° de série')}"><i class="ti ti-arrows-exchange"></i></span>`:''}${avoirBadge}</td>
      <td style="font-weight:600">${esc(d.modele||'—')}${histBadge}</td>
      <td style="font-size:13px">${serieCell}</td>
      <td>${esc(detenteur)}${pretBadgeHtml}${resaBadge}</td>
      <td style="font-size:14px;color:var(--text2)">${d.demo_origine_nom?esc(d.demo_origine_nom):'—'}</td>
      <td style="white-space:nowrap">${fdate(mise)}</td>
      <td style="white-space:nowrap;${echEchue?'color:var(--danger);font-weight:600':''}">${echeance?fdate(echeance):'—'}</td>
      <td style="white-space:nowrap">${actions}</td>
    </tr>`;
  }

  const enDemoUnits = enEssai;                 // unités en essai (état courant)
  const dispoUnits  = disponibles;             // unités revenues, disponibles pour un autre essai
  // Historique : stints antérieurs (changements de main) + ventes (épisode terminal).
  const histList = [];
  unites.forEach(u=>{
    u.hist.forEach(ep=>{
      if(ep===u.rep){ if(_TERMINAL.includes(_stU(u))) histList.push({u,ep}); }  // vente / avoir = terminal → historique
      else histList.push({u,ep});                                       // stint antérieur → historique
    });
  });
  histList.sort((a,b)=> _recence(b.ep).localeCompare(_recence(a.ep)));

  const tableHead = `<thead><tr><th>${TR('Statut')}</th><th>${TR('Modèle')}</th><th>${TR('N° série')}</th><th>${TR('Détenteur')}</th><th>${TR('Origine')}</th><th>${TR('Date')}</th><th>${TR('Échéance')}</th><th></th></tr></thead>`;
  const mkTable = (rowsHtml, emptyMsg) => rowsHtml
    ? `<div class="table-wrap"><table class="t parc-tbl">${tableHead}<tbody>${rowsHtml}</tbody></table></div>`
    : `<div class="empty" style="padding:20px"><i class="ti ti-wheelchair"></i>${emptyMsg}</div>`;

  const tabDemoHtml  = mkTable(enDemoUnits.map(u=>parcRow(u,u.rep,'actif')).join(''), TR('Aucun fauteuil en essai actuellement.'));
  const tabDispoHtml = mkTable(dispoUnits.map(u=>parcRow(u,u.rep,'actif')).join(''), TR('Aucun fauteuil disponible (revenu) pour le moment.'));
  const tabHistHtml  = mkTable(histList.map(x=>parcRow(x.u,x.ep,'hist')).join(''), TR('Aucune démo dans l’historique.'));

  const _TABS=[['demo','ti-wheelchair',TR('En démo'),enDemoUnits.length],['dispo','ti-home-check',TR('Disponibles'),dispoUnits.length],['hist','ti-history',TR('Historique'),histList.length]];
  const tabsBar = `<div style="display:flex;gap:2px;border-bottom:0.5px solid var(--border-s);margin-bottom:12px;flex-wrap:wrap">${_TABS.map(([k,ic,lbl,n])=>`<button class="parc-tab-btn" data-tab="${k}" onclick="parcSetTab('${k}')" style="cursor:pointer;border:none;border-bottom:2px solid ${PARC_TAB===k?'var(--accent)':'transparent'};background:none;color:${PARC_TAB===k?'var(--accent)':'var(--text2)'};font-weight:${PARC_TAB===k?'700':'500'};padding:9px 14px;font-size:15px"><i class="ti ${ic}" style="margin-right:5px"></i>${lbl} <span style="opacity:.6">(${n})</span></button>`).join('')}</div>`;

  const demoTable = `${tabsBar}
    <div style="margin-bottom:10px"><input class="form-input" id="parc-q" placeholder="${TR('Rechercher (modèle, série, distributeur…)')}" style="max-width:320px;padding:9px 12px" oninput="parcDemoFiltrer(this.value)"></div>
    <div class="parc-pane" data-tab="demo" style="${PARC_TAB==='demo'?'':'display:none'}">${tabDemoHtml}</div>
    <div class="parc-pane" data-tab="dispo" style="${PARC_TAB==='dispo'?'':'display:none'}">${tabDispoHtml}</div>
    <div class="parc-pane" data-tab="hist" style="${PARC_TAB==='hist'?'':'display:none'}">${tabHistHtml}</div>`;

  const scT={'En préparation':'attente','En transit':'ouvert','Arrivé':'g','Annulé':'urgent'};
  const transTable = transferts.length ? `<div class="table-wrap"><table class="t">
      <thead><tr><th>${TR('Modèle')}</th><th>${TR('N° série')}</th><th>${TR('Départ')}</th><th>${TR('Arrivée')}</th><th>${TR('Statut')}</th><th>${TR('Départ')}</th><th>${TR('Arrivée')}</th></tr></thead>
      <tbody>${transferts.map(tr=>`<tr style="cursor:pointer" onclick="modalTransfert(${tr.id})">
        <td style="font-weight:600">${esc(tr.modele||'—')}</td>
        <td class="mono" style="font-size:13px">${esc(tr.serie||'—')}</td>
        <td>${esc(tr.client_depart_nom||'—')}</td>
        <td>${esc(tr.client_arrivee_nom||'—')}</td>
        <td><span class="badge ${scT[tr.statut]||''}">${esc(tr.statut||'')}</span></td>
        <td style="white-space:nowrap">${tr.date_depart?fd(tr.date_depart):'—'}</td>
        <td style="white-space:nowrap">${tr.date_arrivee?fd(tr.date_arrivee):'—'}</td>
      </tr>`).join('')}</tbody>
    </table></div>`
    : `<div style="font-size:14px;color:var(--text3);padding:8px 0">${TR('Aucun transfert enregistré.')}</div>`;

  const pretsTable = pretsActifs.length ? `<div class="table-wrap"><table class="t">
      <thead><tr><th>${TR('Distributeur')}</th><th>${TR('Matériel')}</th><th>${TR('Formule')}</th><th>${TR('Statut')}</th><th>${TR('Remise')}</th><th>${TR('Retour prévu')}</th></tr></thead>
      <tbody>${pretsActifs.map(p=>{
        const arts=pretArticlesOf(p); const mat=esc(arts.map(x=>x.designation).filter(Boolean).join(', ')||p.designation||'—');
        return `<tr style="cursor:pointer" onclick="modalPret(${p.id})">
        <td style="font-weight:600">${esc(p.client_nom_actuel||p.distributeur_nom||'—')}</td>
        <td>${mat}</td>
        <td style="font-size:14px">${esc(PRET_FORMULES[p.formule]||p.formule||'—')}</td>
        <td>${pretBadge(p.statut)}</td>
        <td style="white-space:nowrap">${p.date_remise?fd((''+p.date_remise).slice(0,10)):'—'}</td>
        <td style="white-space:nowrap">${p.date_retour_prevue?fd((''+p.date_retour_prevue).slice(0,10)):'—'}</td>
      </tr>`;}).join('')}</tbody>
    </table></div>`
    : `<div style="font-size:14px;color:var(--text3);padding:8px 0">${TR('Aucun prêt / essai actif.')}</div>`;

  const bannerSerie = sansSerie ? `<div style="display:flex;align-items:center;gap:8px;background:var(--warning-bg);border:0.5px solid rgba(180,85,31,.3);color:var(--warning);border-radius:var(--radius);padding:9px 12px;margin-bottom:12px;font-size:14.5px">
    <i class="ti ti-alert-triangle" style="font-size:17px"></i>
    <span><b>${sansSerie}</b> ${TR('démo(s) sans n° de série')} — ${TR('renseignez-le dans la fiche commande pour suivre l’unité physique et la rattacher automatiquement aux prêts et transferts.')}</span>
  </div>` : '';
  const bannerAvoir = venduAvecAvoir ? `<div style="display:flex;align-items:center;gap:8px;background:#dc262614;border:0.5px solid #dc262644;color:#b91c1c;border-radius:var(--radius);padding:9px 12px;margin-bottom:12px;font-size:14.5px">
    <i class="ti ti-alert-triangle" style="font-size:17px"></i>
    <span><b>${venduAvecAvoir}</b> ${TR('démo(s) marquée(s) « Vendue » avec un avoir')} — ${TR('à vérifier : une vente annulée par avoir devrait être clôturée en « Retour ». Ouvrez l’onglet « Historique » pour les voir et les requalifier.')}</span>
  </div>` : '';

  // ── Fauteuils de démo EN NOTRE POSSESSION, par modèle (hors S1) ──────────────
  // Parc actif = en essai + disponibles = les unités que nous possédons réellement.
  // Sert à voir d'un coup d'œil s'il faut recommander des modèles de démo à la Suède.
  const possGrp = {};
  parcActif.forEach(u=>{
    const k = demoModele(u.rep.modele);
    const fam = k.replace(/^Modèle\s+/i,'').trim().toUpperCase();
    if(fam==='S1') return;                        // exclusion du modèle S1
    const g = possGrp[k] || (possGrp[k]={modele:k, essai:0, dispo:0});
    if(_stU(u)==='retour') g.dispo++; else g.essai++;
  });
  const possList  = Object.values(possGrp).sort((a,b)=>(b.essai+b.dispo)-(a.essai+a.dispo) || a.modele.localeCompare(b.modele));
  const possTotal = possList.reduce((s,g)=>s+g.essai+g.dispo,0);
  const possDispo = possList.reduce((s,g)=>s+g.dispo,0);
  const possMax   = Math.max(1, ...possList.map(g=>g.essai+g.dispo));
  const possessionCard = `<div class="card" style="margin-top:14px">
    <div class="section-title"><i class="ti ti-packages"></i>${TR('Fauteuils de démo en notre possession')}
      <span style="margin-left:auto;font-size:14px;font-weight:400;color:var(--text3)">${possTotal} ${TR('fauteuil(s)')} · ${possDispo} ${TR('dispo')} · ${TR('hors S1')}</span></div>
    ${possList.length ? possList.map(g=>{
      const tot=g.essai+g.dispo; const w=Math.round(tot/possMax*100); const wd=tot?Math.round(g.dispo/tot*100):0;
      const reco = g.dispo===0 ? ` <span class="badge" style="background:#f59e0b18;color:#b45309;border:0.5px solid #f59e0b44;font-size:12px" title="${TR('Aucun exemplaire disponible chez nous — à recommander à la Suède si besoin')}">${TR('à recommander ?')}</span>` : '';
      return `<div style="display:flex;align-items:center;gap:10px;margin:7px 0">
        <div style="width:100px;font-weight:600;font-size:15px">${esc(g.modele)}</div>
        <div style="flex:1;background:var(--surface-2,#eef1f4);border-radius:6px;height:22px;overflow:hidden">
          <div style="height:100%;width:${w}%;min-width:26px;display:flex">
            <div style="width:${wd}%;background:#2563eb"></div>
            <div style="flex:1;background:#0d9488"></div>
          </div>
        </div>
        <div style="width:210px;font-size:14px;color:var(--text2);white-space:nowrap;text-align:right"><b style="color:var(--text)">${tot}</b> ${TR('total')} · ${g.dispo} ${TR('dispo')} · ${g.essai} ${TR('en essai')}${reco}</div>
      </div>`;
    }).join('') : `<div style="font-size:14px;color:var(--text3)">${TR('Aucun fauteuil de démo actif.')}</div>`}
    <div style="margin-top:12px;display:flex;gap:16px;font-size:13px;color:var(--text3);border-top:0.5px solid var(--border-s);padding-top:8px">
      <span><span style="display:inline-block;width:10px;height:10px;background:#2563eb;border-radius:2px;margin-right:4px;vertical-align:-1px"></span>${TR('Disponibles (chez nous)')}</span>
      <span><span style="display:inline-block;width:10px;height:10px;background:#0d9488;border-radius:2px;margin-right:4px;vertical-align:-1px"></span>${TR('En essai (sortis chez un distributeur)')}</span>
    </div>
  </div>`;

  // ── Modèles « sous tension » : 0 exemplaire disponible alors qu'au moins un est en essai ──
  // C'est le cas d'une 2ᵉ demande sur un modèle déjà sorti : on affiche la prochaine
  // libération (échéance de l'unité qui revient le plus tôt) et on propose de réserver
  // cette unité au retour, ou de commander un neuf à la Suède.
  const tensGrp = {};
  const _fam = m => demoModele(m).replace(/^Modèle\s+/i,'').trim().toUpperCase();
  enEssai.forEach(u=>{ if(_fam(u.rep.modele)==='S1') return; const k=demoModele(u.rep.modele); (tensGrp[k]||(tensGrp[k]={modele:k,essai:[],dispo:0})).essai.push(u); });
  disponibles.forEach(u=>{ if(_fam(u.rep.modele)==='S1') return; const k=demoModele(u.rep.modele); (tensGrp[k]||(tensGrp[k]={modele:k,essai:[],dispo:0})).dispo++; });
  const tension = Object.values(tensGrp).filter(g=>g.dispo===0 && g.essai.length>=1).map(g=>{
    const tri = g.essai.slice().sort((a,b)=>{ const da=a.rep.demo_rappel_date||'9999', db=b.rep.demo_rappel_date||'9999'; return (''+da).localeCompare(''+db); });
    return { modele:g.modele, nb:g.essai.length, next:tri[0].rep, essais:tri };
  }).sort((a,b)=> (a.next.demo_rappel_date||'9999').localeCompare(b.next.demo_rappel_date||'9999'));
  const tensionCard = tension.length ? `<div class="card" style="margin-bottom:14px;border-left:3px solid #b45309">
    <div class="section-title"><i class="ti ti-alert-triangle" style="color:#b45309"></i>${TR('Modèles sous tension')}
      <span style="margin-left:auto;font-size:14px;font-weight:400;color:var(--text3)">${TR('aucun exemplaire disponible — 2ᵉ demande à arbitrer')}</span></div>
    ${tension.map(tg=>{
      const d=tg.next; const holder = d.demo_localisation_actuelle || d.client_nom || d.distributeur_nom || '—';
      const dateTxt = d.demo_rappel_date ? fdate(d.demo_rappel_date) : TR('date non renseignée');
      const resa = d.demo_reservation ? ` <span class="badge" style="background:#7c3aed18;color:#7c3aed;border:0.5px solid #7c3aed44;font-size:12px;cursor:pointer" title="${TR('Modifier / retirer la réservation')}" onclick="reserverDemoRetour(${d.id},'${esc((d.demo_reservation||'').replace(/'/g,'&#39;'))}')"><i class="ti ti-bookmark" style="font-size:13px;margin-right:2px"></i>${TR('réservé')} : ${esc(d.demo_reservation)}</span>` : '';
      return `<div style="display:flex;align-items:center;gap:10px;margin:8px 0;flex-wrap:wrap">
        <div style="min-width:220px"><b style="font-size:15px">${esc(tg.modele)}</b> <span style="color:var(--text3);font-size:14px">— ${tg.nb} ${TR('en essai')}, 0 ${TR('dispo')}</span><br>
          <span style="font-size:14px;color:var(--text2)"><i class="ti ti-clock-hour-4" style="font-size:14px"></i> ${TR('prochaine libération')} : <b${d.demo_rappel_date?'':' style="color:var(--warning)"'}>${dateTxt}</b> ${TR('chez')} ${esc(holder)}</span>${resa}</div>
        <span style="flex:1"></span>
        <button class="btn sm" onclick="reserverDemoRetour(${d.id},'${esc((d.demo_reservation||'').replace(/'/g,'&#39;'))}')"><i class="ti ti-bookmark"></i>${TR('Réserver au retour')}</button>
        <button class="btn sm primary" onclick="setView('commande-suede')"><i class="ti ti-truck-delivery"></i>${TR('Commander à la Suède')}</button>
      </div>`;
    }).join('')}
    <div style="margin-top:8px;font-size:13px;color:var(--text3)">${TR('Astuce : si l’essai en cours est en long terme ou que le distributeur ne peut pas attendre, commandez un neuf ; sinon réservez l’unité et planifiez le transfert à son retour.')}</div>
  </div>` : '';

  c.innerHTML = tiles
    + tensionCard
    + `<div class="card" style="margin-bottom:14px"><div class="section-title"><i class="ti ti-wheelchair"></i>${TR('Démos déclarées')}</div>${bannerAvoir}${bannerSerie}${demoTable}</div>`
    + `<div class="card" style="margin-bottom:14px"><div class="section-title"><i class="ti ti-arrows-exchange"></i>${TR('Transferts de fauteuils')} <span style="margin-left:auto;font-size:14px;font-weight:400"><span onclick="setView('transferts')" style="color:var(--accent);cursor:pointer">${TR('Gérer')} →</span></span></div>${transTable}</div>`
    + `<div class="card"><div class="section-title"><i class="ti ti-file-certificate"></i>${TR('Prêts / essais en cours')} <span style="margin-left:auto;font-size:14px;font-weight:400"><span onclick="setView('prets')" style="color:var(--accent);cursor:pointer">${TR('Gérer')} →</span></span></div>${pretsTable}</div>`
    + possessionCard;
}
window.renderParcDemo = renderParcDemo;
function parcDemoFiltrer(v){
  const q=(v||'').toLowerCase().trim();
  document.querySelectorAll('.parc-tbl tbody tr').forEach(tr=>{
    tr.style.display = (!q || (tr.getAttribute('data-k')||'').includes(q)) ? '' : 'none';
  });
}
window.parcDemoFiltrer = parcDemoFiltrer;
function parcSetTab(k){
  PARC_TAB = k;
  document.querySelectorAll('.parc-pane').forEach(p=>{ p.style.display = (p.getAttribute('data-tab')===k)?'':'none'; });
  document.querySelectorAll('.parc-tab-btn').forEach(b=>{ const on=b.getAttribute('data-tab')===k; b.style.borderBottom='2px solid '+(on?'var(--accent)':'transparent'); b.style.color=on?'var(--accent)':'var(--text2)'; b.style.fontWeight=on?'700':'500'; });
}
window.parcSetTab = parcSetTab;

async function modalTransfert(id){
  const d = id ? await API.transfert(id) : {};
  TMP_CLIENTS = await API.clients();
  showModal(`<div class="modal-header"><i class="ti ti-arrows-exchange" style="font-size:20px;color:var(--accent)"></i><h2>${id?t('transferts_modal_edit'):t('transferts_modal_new')}</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label">${t('transferts_fauteuil')}</label>
        <div style="position:relative">
          <input class="form-input" id="tr-fauteuil-search" autocomplete="off"
            placeholder="${TR("Taper n° de série, modèle ou distributeur…")}"
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
          <select class="form-input" id="tr-transporteur" onchange="majLienSuiviTransfert()">
            <option value="">${t('select_aucun')}</option>
            <option value="DSV" ${d.transporteur==='DSV'?'selected':''}>${t('transferts_dsv')}</option>
            <option value="Autre" ${d.transporteur==='Autre'?'selected':''}>${t('transferts_autre')}</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">${t('transferts_num_suivi')}</label>
          <div style="display:flex;gap:6px;align-items:center">
            <input class="form-input mono" id="tr-num-suivi" value="${esc(d.num_suivi||'')}" oninput="majLienSuiviTransfert()" style="flex:1">
            <a id="tr-suivi-lien" target="_blank" rel="noopener" title="${t('cmd_suivre_colis')||'Suivre le colis'}" style="display:${d.num_suivi?'inline-flex':'none'};align-items:center;color:var(--accent);padding:0 6px;font-size:18px" ${d.num_suivi?`href="${lienhSuiviInter(d.transporteur,d.num_suivi)}"`:''}><i class="ti ti-external-link"></i></a>
          </div>
        </div>
        <div class="form-group" style="grid-column:1/-1">
          <label class="form-label">${t('col_statut')}</label>
          <select class="form-input" id="tr-statut" onchange="document.getElementById('tr-arrive-hint').style.display=this.value==='Arrivé'?'block':'none'">
            ${[['En préparation','transferts_statut_prep'],['En transit','transferts_statut_transit'],['Arrivé','transferts_statut_arrive'],['Annulé','transferts_statut_annule']].map(([v,k])=>`<option value="${v}" ${d.statut===v?'selected':''}>${t(k)}</option>`).join('')}
          </select>
          <div id="tr-arrive-hint" style="display:${d.statut==='Arrivé'?'block':'none'};font-size:13px;color:var(--warning);margin-top:4px"><i class="ti ti-alert-triangle"></i> ${t('transferts_arrive_hint')}</div>
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

// Met à jour le lien de suivi (icône) à côté du n° de suivi dans la modale de transfert
function majLienSuiviTransfert(){
  const n = gv('tr-num-suivi');
  const tr = gv('tr-transporteur');
  const a = document.getElementById('tr-suivi-lien');
  if (!a) return;
  if (n && n.trim()) { a.href = lienhSuiviInter(tr, n.trim()); a.style.display = 'inline-flex'; }
  else { a.style.display = 'none'; a.removeAttribute('href'); }
}
window.majLienSuiviTransfert = majLienSuiviTransfert;

async function searchFauteuilTransfert(q){
  const drop=document.getElementById('tr-fauteuil-drop');
  if(!drop)return;
  if(!q||q.trim().length<2){drop.style.display='none';return;}
  try{
    const res=await API.recherche(q.trim());
    const fauteuils=res.fauteuils||[];
    if(!fauteuils.length){drop.innerHTML=`<div class="qs-empty" style="padding:10px 12px;font-size:14px;color:var(--text3)">${t('qs_no_result')} "${esc(q)}"</div>`;drop.style.display='block';return;}
    drop.innerHTML=fauteuils.map(f=>`<div class="piece-option" onmousedown="event.preventDefault();selectFauteuilTransfert(${f.id},'${esc(f.modele||'')}','${esc(f.serie||'')}',${f.client_id||'null'},'${esc(f.client_nom||'')}')">
      <div style="font-size:15px;font-weight:700">${esc(f.modele||'?')} <span class="mono" style="font-weight:400;font-size:14px;color:var(--accent)">${esc(f.serie)}</span></div>
      <div style="font-size:13px;color:var(--text3)">${esc(f.client_nom||'')}</div>
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
    <div style="font-size:14px;font-weight:600">${esc(c.nom)}</div>
    <div style="font-size:13px;color:var(--text3)">${esc(c.ville||'')}</div>
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
    positionQsResults();el.innerHTML=`<div class="qs-empty"><i class="ti ti-search-off"></i> ${TR("Aucun résultat pour \"")}<b>${esc(q)}</b>"</div>`;
    el.style.display='block';return;
  }
  let html='';
  if(fauteuils.length){
    html+=`<div class="qs-section-label">Fauteuils</div>`;
    html+=fauteuils.map(f=>`<div class="qs-item">
      <div style="display:flex;align-items:center;gap:10px">
        <i class="ti ti-wheelchair" style="font-size:20px;color:var(--accent);flex-shrink:0"></i>
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:15px">${esc(f.modele||'?')} <span class="mono" style="font-weight:400;color:var(--text3);font-size:14px">${esc(f.serie)}</span></div>
          <div style="font-size:14px;color:var(--text2)">${esc(f.client_nom||'')}${f.date_achat?' — achat '+fd(f.date_achat):''}</div>
        </div>
        <span class="badge ${f.nb_interventions>0?'attente':'g'}" style="font-size:12px">${f.nb_interventions} inter.</span>
      </div>
      <div style="display:flex;gap:6px;margin-top:6px;padding-left:28px;flex-wrap:wrap">
        <button class="btn sm primary" onclick="quickNewInter(${f.id},${f.client_id})"><i class="ti ti-plus"></i>${TR('Nouvelle intervention')}</button>
        <button class="btn sm" onclick="setView('fauteuil',{fauteuilId:${f.id},clientId:${f.client_id}});clearQuickSearch()"><i class="ti ti-eye"></i>${TR("Voir la fiche")}</button>
        <button class="btn sm" onclick="${f.commande_id
          ? `setView('commandes');clearQuickSearch();setTimeout(()=>modalCommande(${f.commande_id}),300)`
          : `setView('commandes',{q:${JSON.stringify(f.serie||'')}});clearQuickSearch()`
        }"><i class="ti ti-clipboard-list"></i>${TR('Commande')}</button>
      </div>
    </div>`).join('');
  }
  if(commandes.length){
    html+=`<div class="qs-section-label" style="margin-top:4px">Commandes</div>`;
    html+=commandes.map(cmd=>{
      const statut = cmdStatutClass ? cmdStatutClass(cmd.statut||'En préparation') : '';
      return `<div class="qs-item" onclick="setView('commandes');clearQuickSearch();setTimeout(()=>modalCommande(${cmd.id}),300)" style="cursor:pointer">
        <div style="display:flex;align-items:center;gap:10px">
          <i class="ti ti-clipboard-list" style="font-size:20px;color:var(--accent);flex-shrink:0"></i>
          <div style="flex:1;min-width:0">
            <div style="font-weight:700;font-size:15px">${esc(cmd.distributeur_nom)}${cmd.bdc?` <span class="mono" style="font-weight:400;color:var(--text3);font-size:14px">${esc(cmd.bdc)}</span>`:''}${cmd.modele_demo?` <span class="badge hg" style="font-size:12px">🔄 ${t('cmd_demo_badge')||'Démo'}</span>`:''}</div>
            <div style="font-size:14px;color:var(--text2)">${esc(cmd.modele||'')}${cmd.num_facture?' · Facture : '+esc(cmd.num_facture):''}${cmd.num_serie?' · '+esc(cmd.num_serie):''}${cmd.date_commande?' · '+fd(cmd.date_commande):''}</div>
          </div>
          ${cmd.statut?`<span class="badge ${statut}" style="font-size:12px">${esc(tStatut(cmd.statut))}</span>`:''}
        </div>
      </div>`;
    }).join('');
  }
  if(clients.length){
    html+=`<div class="qs-section-label" style="margin-top:4px">Distributeurs</div>`;
    html+=clients.map(c=>`<div class="qs-item" onclick="setView('client',{clientId:${c.id}});clearQuickSearch()">
      <div style="display:flex;align-items:center;gap:10px">
        <i class="ti ti-users" style="font-size:20px;color:var(--accent);flex-shrink:0"></i>
        <div style="flex:1">
          <div style="font-weight:700;font-size:15px">${esc(c.nom)}</div>
          <div style="font-size:14px;color:var(--text2)">${esc(c.ville||'')} — ${c.nb_fauteuils||0} fauteuil${(c.nb_fauteuils||0)!==1?'s':''}</div>
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
  if(progress){progress.style.display='block';progress.innerHTML=`<div class="card" style="padding:12px;display:flex;align-items:center;gap:10px"><i class="ti ti-loader-2" style="font-size:22px;color:var(--accent)"></i><span>Import en cours : <b>${esc(file.name)}</b>…</span></div>`;}
  try{
    const res=await API.importExcel(file);
    const s=res.stats;
    if(progress){progress.innerHTML=`<div class="card" style="padding:12px;background:var(--success-bg);border-color:var(--success)">
      <div style="font-weight:700;color:var(--success);margin-bottom:6px"><i class="ti ti-check"></i> Import réussi (${res.sheets.join(', ')})</div>
      <div style="font-size:14px;display:flex;gap:16px;flex-wrap:wrap">
        <span>✚ ${s.clients} nouveaux clients</span><span>✚ ${s.fauteuils} nouveaux fauteuils</span>
        <span>↻ ${s.doublons} mis à jour</span><span style="color:var(--text3)">— ${s.ignores} ignorés (accessoires)</span>
        ${s.erreurs?`<span style="color:var(--danger)">⚠ ${s.erreurs} erreurs</span>`:''}
      </div>
      <button class="btn sm" style="margin-top:8px" onclick="this.parentElement.parentElement.style.display='none';render()"><i class="ti ti-x"></i>${TR('Fermer')}</button>
    </div>`;}
    refreshBadges();
  }catch(e){
    if(progress){progress.innerHTML=`<div class="card" style="padding:12px;background:var(--danger-bg);border-color:var(--danger)"><div style="color:var(--danger);font-weight:700"><i class="ti ti-alert-circle"></i> Erreur : ${esc(e.message)}</div><button class="btn sm" style="margin-top:8px" onclick="this.parentElement.parentElement.style.display='none'"><i class="ti ti-x"></i>${TR('Fermer')}</button></div>`;}
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
    if(!fauteuils.length){drop.innerHTML=`<div class="qs-empty" style="padding:10px 12px;font-size:14px;color:var(--text3)">${TR("Aucun fauteuil — utilisez \"+ Créer\" pour en ajouter un")}</div>`;drop.style.display='block';return;}
    drop.innerHTML=fauteuils.map(f=>`<div class="piece-option" onmousedown="event.preventDefault();selectFauteuilInter(${f.id},'${esc(f.modele||'')}','${esc(f.serie||'')}',${f.client_id||'null'},'${esc(f.client_nom||'')}')">
      <div style="font-size:15px;font-weight:700">${esc(f.modele||'?')} <span class="mono" style="font-weight:400;font-size:14px;color:var(--accent)">${esc(f.serie)}</span></div>
      <div style="font-size:13px;color:var(--text3)">${esc(f.client_nom||'')}${f.date_achat?' — achat '+fd(f.date_achat):''}</div>
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
  }catch(e){alert(TR('Erreur : ')+e.message);}
}

// ── RECHERCHE CLIENTS DANS FORMULAIRE ────────────────────────────
function searchClients(q,allClients){
  const drop=document.getElementById('client-drop');if(!drop)return;
  const query=q.toLowerCase().trim();
  const results=(query?allClients.filter(c=>c.nom.toLowerCase().includes(query)||(c.ville&&c.ville.toLowerCase().includes(query))):allClients).slice(0,15);
  if(!results.length){drop.style.display='none';return;}
  drop.innerHTML=results.map(c=>`<div class="piece-option" onmousedown="event.preventDefault();selectClient(${c.id},'${c.nom.replace(/'/g,"\'")}')">
    <div style="font-size:14px;font-weight:600">${esc(c.nom)}</div>
    <div style="font-size:13px;color:var(--text3)">${esc(c.ville||'')}${c.contact?' — '+esc(c.contact):''}</div>
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
    toast(TR('Numéro de facture mis à jour'),'ti-receipt');
  } catch(e) { alert(TR('Erreur : ')+e.message); }
}

async function chargerFacturesVF(fauteuilId){
  const el=document.getElementById('factures-vf-content');if(!el)return;
  el.innerHTML='<i class="ti ti-loader-2"></i> Chargement depuis VosFactures…';
  try{
    const{factures,serie,configured}=await API.facturesVF(fauteuilId);
    if(!configured){el.innerHTML='<span style="color:var(--text3)">'+TR("VosFactures non configuré.")+'</span>';return;}
    if(!factures.length){el.innerHTML=`<span style="color:var(--text3)">${TR('Aucune facture trouvée pour la série')} <span class="mono">${esc(serie||'?')}</span>.</span>`;return;}
    el.innerHTML=`<table class="t"><thead><tr><th>${TR('Numéro')}</th><th>${t('col_date')}</th><th>${TR("Client VF")}</th><th>Montant TTC</th><th>${t('col_statut')}</th><th></th></tr></thead>
      <tbody>${factures.map(f=>`<tr>
        <td class="mono" style="color:var(--accent)">${esc(f.numero)}</td>
        <td>${f.date?fd(f.date.substring(0,10)):'—'}</td>
        <td style="font-size:13px">${esc(f.client_nom||'')}</td>
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
  el.innerHTML=`<div class="card" style="padding:10px;font-size:14px"><div style="font-weight:600;margin-bottom:4px"><i class="ti ti-loader-2"></i> ${TR('Sync historique lancée en arrière-plan…')}</div><div id="sync-histo-msg" style="color:var(--text3)">${TR('Démarrage…')}</div><div style="font-size:13px;color:var(--text3);margin-top:4px">${TR("Cela peut prendre 10 à 20 min. Vous pouvez continuer à utiliser l'application.")}</div></div>`;
  try{await API.vfSyncHistorique();pollSyncHistorique();}catch(e){el.innerHTML=`<div class="card" style="padding:10px;background:var(--danger-bg);border-color:var(--danger);font-size:14px;color:var(--danger)"><i class="ti ti-alert-circle"></i> Erreur : ${esc(e.message)}</div>`;}
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
        if(s.error){el.innerHTML=`<div class="card" style="padding:10px;background:var(--danger-bg);border-color:var(--danger);font-size:14px;color:var(--danger)"><i class="ti ti-alert-circle"></i> Erreur : ${esc(s.error)}<button class="btn sm" style="display:block;margin-top:6px" onclick="this.parentElement.parentElement.style.display='none'"><i class="ti ti-x"></i>${TR('Fermer')}</button></div>`;}
        else{el.innerHTML=`<div class="card" style="padding:10px;background:var(--success-bg);border-color:var(--success);font-size:14px"><div style="font-weight:700;color:var(--success);margin-bottom:6px"><i class="ti ti-check"></i> ${TR('Sync historique terminée !')}</div><div>${esc(s.results?.clients||'—')}</div><div>${esc(s.results?.products||'—')}</div><div>${esc(s.results?.invoices||'—')}</div><button class="btn sm" style="margin-top:8px" onclick="this.parentElement.parentElement.style.display='none';render()"><i class="ti ti-x"></i>${TR('Fermer')}</button></div>`;toast(TR('Sync historique terminée'),'ti-history');}
      }
    }catch(e){}
  },5000);
}

// ── FUSION CLIENTS ────────────────────────────────────────────────
async function modalFusionnerClient(idCible){
  const clients=await API.clients();
  const cible=clients.find(c=>c.id===idCible);if(!cible)return;
  window._FUSION_CLIENTS=clients.filter(c=>c.id!==idCible);
  window._FUSION_OUVERT=cible; // fiche depuis laquelle on a ouvert la modale
  window._FUSION_AUTRE=null;   // autre fiche (doublon) sélectionnée
  showModal(`<div style="width:min(92vw,640px)">
    <div class="modal-header"><i class="ti ti-git-merge" style="font-size:20px;color:var(--accent)"></i><h2>${TR('Fusionner un doublon')}</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body" style="min-height:340px">
      <div class="form-group"><label class="form-label">${TR("Autre fiche (le doublon)")}</label>
        <div style="position:relative">
          <input class="form-input" id="fusion-search" placeholder="Taper le nom de l'autre fiche…" autocomplete="off"
            oninput="searchFusionClient(this.value)" onfocus="searchFusionClient(this.value)"
            onblur="setTimeout(()=>{const d=document.getElementById('fusion-drop');if(d)d.style.display='none'},150)">
          <input type="hidden" id="fusion-source-id">
          <div id="fusion-drop" class="piece-dropdown" style="display:none;position:absolute;left:0;right:0;top:100%;z-index:50;max-height:300px;overflow-y:auto;background:var(--surface,#fff);border:1px solid var(--border,#ddd);border-radius:var(--radius,8px);box-shadow:0 8px 24px rgba(0,0,0,.14);margin-top:2px"></div>
        </div>
      </div>
      <div class="form-group" id="fusion-choix-garder" style="display:none">
        <label class="form-label">Quelle fiche conserver ?</label>
        <div style="display:flex;flex-direction:column;gap:8px">
          <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;border:1px solid var(--border);border-radius:var(--radius);padding:10px 12px">
            <input type="radio" name="fusion-garder" value="ouvert" checked onchange="majApercuFusion()" style="margin-top:2px">
            <div><div style="font-weight:600;font-size:15px">${esc(cible.nom)}</div>
              <div style="font-size:13px;color:var(--text3)">Fiche actuelle — ${cible.nb_fauteuils||0} fauteuil(s)</div></div>
          </label>
          <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;border:1px solid var(--border);border-radius:var(--radius);padding:10px 12px">
            <input type="radio" name="fusion-garder" value="autre" onchange="majApercuFusion()" style="margin-top:2px">
            <div><div style="font-weight:600;font-size:15px" id="fusion-autre-nom">—</div>
              <div style="font-size:13px;color:var(--text3)" id="fusion-autre-info">—</div></div>
          </label>
        </div>
      </div>
      <div class="form-group"><label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:15px">
        <input type="checkbox" id="fusion-vf-ignore" checked>
        <span>${TR('Empêcher la sync VosFactures de recréer ce doublon')}</span>
      </label></div>
      <div id="fusion-apercu" style="background:var(--danger-bg);border:1px solid var(--danger);border-radius:var(--radius);padding:8px 12px;font-size:14px;color:var(--danger);display:none"></div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">${t('btn_annuler')}</button>
      <button class="btn danger" onclick="confirmerFusion()"><i class="ti ti-git-merge"></i>${TR('Fusionner et supprimer')}</button>
    </div>
  </div>`);
}
function searchFusionClient(q){
  const drop=document.getElementById('fusion-drop');if(!drop)return;
  const query=q.toLowerCase().trim();
  const results=(query?(window._FUSION_CLIENTS||[]).filter(c=>c.nom.toLowerCase().includes(query)):(window._FUSION_CLIENTS||[])).slice(0,30);
  if(!results.length){drop.style.display='none';return;}
  drop.innerHTML=results.map(c=>`<div class="piece-option" onmousedown="event.preventDefault();selectFusionSource(${c.id},'${c.nom.replace(/'/g,"\\'")}',${c.nb_fauteuils||0})"><div style="font-size:14px;font-weight:600">${esc(c.nom)}</div><div style="font-size:13px;color:var(--text3)">${c.nb_fauteuils||0} fauteuil(s)</div></div>`).join('');
  drop.style.display='block';
}
function selectFusionSource(id,nom,nbFauteuils){
  const inp=document.getElementById('fusion-search');if(inp)inp.value=nom;
  const hid=document.getElementById('fusion-source-id');if(hid)hid.value=id;
  const drop=document.getElementById('fusion-drop');if(drop)drop.style.display='none';
  window._FUSION_AUTRE={id,nom,nb_fauteuils:nbFauteuils};
  const bloc=document.getElementById('fusion-choix-garder');if(bloc)bloc.style.display='';
  const an=document.getElementById('fusion-autre-nom');if(an)an.textContent=nom;
  const ai=document.getElementById('fusion-autre-info');if(ai)ai.textContent=`Autre fiche — ${nbFauteuils} fauteuil(s)`;
  majApercuFusion();
}
function majApercuFusion(){
  const ouvert=window._FUSION_OUVERT, autre=window._FUSION_AUTRE;
  if(!ouvert||!autre)return;
  const garder=document.querySelector('input[name="fusion-garder"]:checked')?.value||'ouvert';
  const conserve = garder==='autre' ? autre : ouvert;
  const supprime = garder==='autre' ? ouvert : autre;
  const ap=document.getElementById('fusion-apercu');
  if(ap){
    ap.style.display='';
    ap.innerHTML=`<i class="ti ti-alert-triangle"></i> Les fauteuils, interventions et commandes de <b>${esc(supprime.nom)}</b> ${TR('seront transférés vers')} <b>${esc(conserve.nom)}</b>, puis <b>${esc(supprime.nom)}</b> sera supprimé définitivement.`;
  }
}
async function confirmerFusion(){
  const ouvert=window._FUSION_OUVERT, autre=window._FUSION_AUTRE;
  if(!ouvert||!autre){alert(TR('Veuillez sélectionner une autre fiche.'));return;}
  const garder=document.querySelector('input[name="fusion-garder"]:checked')?.value||'ouvert';
  const idCible  = garder==='autre' ? autre.id : ouvert.id;
  const idSource = garder==='autre' ? ouvert.id : autre.id;
  const nomConserve = garder==='autre' ? autre.nom : ouvert.nom;
  const nomSupprime = garder==='autre' ? ouvert.nom : autre.nom;
  const vfIgnore=document.getElementById('fusion-vf-ignore')?.checked!==false;
  if(!confirm(`Confirmer la fusion ? "${nomSupprime}" sera supprimé et son contenu transféré vers "${nomConserve}".`))return;
  try{
    const r=await API.fusionnerClients(idCible,idSource,vfIgnore);
    toast(`Fusion réussie — ${r.fauteuils_transferes} fauteuil(s) transférés`,'ti-git-merge');
    closeModal();
    // Si on était sur une fiche client : aller sur la fiche conservée (idCible)
    if(STATE.view==='client'){ setView('client',{clientId:idCible}); }
    else { render(); }
  }catch(e){alert(TR('Erreur : ')+e.message);}
}
window.modalFusionnerClient = modalFusionnerClient;
window.searchFusionClient = searchFusionClient;
window.selectFusionSource = selectFusionSource;
window.majApercuFusion = majApercuFusion;
window.confirmerFusion = confirmerFusion;

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
  refreshDiscussionsBadge();
  setInterval(refreshDiscussionsBadge, 45000);
  render();


async function syncPaiementCommande(id){
  toast(TR('Vérification paiement VF…'),'ti-loader-2');
  try{
    const resp = await fetch('/api/commandes/'+id+'/sync-paiement',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    const r = await resp.json();
    if(r.ok){
      const label = r.statut==='payé'?'✅ Payé':r.statut==='impayé'?'⚠️ Impayé':'⏳ En attente';
      toast(TR('Statut paiement : ')+label,'ti-check',r.statut==='payé'?'var(--success)':r.statut==='impayé'?'var(--danger)':'var(--warning)');
      console.log('[VF RAW]', JSON.stringify(r.raw,null,2));
      modalCommande(id);
    } else toast(TR('Erreur : ')+(r.reason||r.error||'Inconnu'),'ti-alert-circle','var(--warning)');
  }catch(e){ toast(e.message,'ti-alert-circle','var(--danger)'); }
}
window.syncPaiementCommande = syncPaiementCommande;


// ══════════════════════════════════════════════════════════════════
// VUE COMMANDE SUÈDE : réappro pièces auprès d'Eloflex AB
// ══════════════════════════════════════════════════════════════════
async function renderCommandeSuede(ttl, c, a) {
  ttl.textContent = t('nav_commande_suede') || 'Commande Suède';
  a.innerHTML = `<button class="btn primary" onclick="modalNouvelleCommandeSuede()"><i class="ti ti-plus"></i>${TR('Nouvelle commande')}</button>`;
  c.innerHTML = `<div id="cs-body"><div style="color:var(--text2);font-size:15px;padding:20px 0">${t('msg_chargement')||'Chargement…'}</div></div>`;
  chargerCommandesSuede();
}

async function chargerCommandesSuede() {
  const el = document.getElementById('cs-body');
  if (!el) return;
  try {
    const list = await API.commandesSuede();
    if (!list.length) {
      el.innerHTML = `<div class="empty"><i class="ti ti-truck-delivery"></i>${TR('Aucune commande Suède.')}<br><span style="font-size:14px;color:var(--text3)">${TR('Créez-en une pour réapprovisionner le stock de pièces depuis Eloflex AB.')}</span></div>`;
      return;
    }
    el.innerHTML = `<div class="table-wrap"><table class="t">
      <thead><tr><th>${TR('Référence')}</th><th>Date</th><th>Transporteur</th><th>Suivi</th><th>${TR('Livraison')}</th><th>Lignes</th><th>Stock</th><th></th></tr></thead>
      <tbody>${list.map(cs => {
        const lien = lienSuiviColis(cs.transporteur, cs.num_suivi);
        const badgeStock = cs.stock_integre
          ? '<span class="badge g">'+TR("Intégré")+'</span>'
          : (cs.date_livraison ? '<span class="badge hg">'+TR("À intégrer")+'</span>' : '<span class="badge" style="opacity:.6">En attente</span>');
        const reliquat = cs.total_reliquat > 0 ? ` <span class="badge hg" title="Reliquat">R:${cs.total_reliquat}</span>` : '';
        return `<tr onclick="ouvrirCommandeSuede(${cs.id})" style="cursor:pointer">
          <td style="font-weight:600" class="mono">${esc(cs.numero_bc)}</td>
          <td>${cs.date_commande ? fd(cs.date_commande) : '—'}</td>
          <td>${esc(cs.transporteur || '—')}</td>
          <td>${lien ? `<a href="${lien}" target="_blank" rel="noopener" onclick="event.stopPropagation()" class="mono" style="color:var(--accent)">${esc(cs.num_suivi)}</a>` : (cs.num_suivi ? `<span class="mono">${esc(cs.num_suivi)}</span>` : '—')}</td>
          <td>${cs.date_livraison ? fd(cs.date_livraison) : '—'}</td>
          <td>${cs.nb_lignes || 0}${reliquat}</td>
          <td>${badgeStock}</td>
          <td><button class="btn sm" onclick="event.stopPropagation();ouvrirCommandeSuede(${cs.id})"><i class="ti ti-arrow-right"></i></button></td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;
  } catch (e) {
    el.innerHTML = `<div style="color:var(--danger);padding:20px 0;font-size:15px">Erreur : ${esc(e.message)}</div>`;
  }
}

// Lignes en cours de saisie (création). Format aligné sur le serveur :
// { catalogue_id, reference, designation, quantite }
let _csLignes = [];
let _csCatalogue = null;

function modalNouvelleCommandeSuede() {
  _csLignes = [];
  showModal(`
    <div class="modal-head"><h3><i class="ti ti-truck-delivery"></i>${TR('Nouvelle commande Suède')}</h3>
      <button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body">
      <div class="form-group"><label class="form-label">${TR('Référence de la commande')}</label>
        <input class="form-input mono" id="cs-bc" placeholder="STOCK0241" style="max-width:220px">
        <div style="font-size:13px;color:var(--text3);margin-top:3px">${TR("Votre référence interne (ex. STOCK + numéro).")}</div>
      </div>

      <details open style="margin:10px 0;border:0.5px solid var(--border);border-radius:8px;padding:8px 12px">
        <summary style="cursor:pointer;font-size:14px;color:var(--text2)">${TR("Importer depuis un bon de commande VosFactures")}</summary>
        <div style="display:flex;gap:6px;margin-top:8px">
          <input class="form-input" id="cs-vf-url" placeholder="Collez l'URL ou l'ID du document VosFactures" style="flex:1">
          <button class="btn primary" type="button" onclick="importerDocVF()"><i class="ti ti-download"></i>Importer</button>
        </div>
        <div style="font-size:13px;color:var(--text3);margin-top:3px">${TR('Ex. https://eloflex.vosfactures.fr/warehouse_documents/73745036 — ou le numéro du document.')}</div>
        <div id="cs-lookup" style="margin-top:8px"></div>
      </details>

      <div class="section-title" style="margin-top:6px"><i class="ti ti-list"></i>${TR('Pièces commandées')}</div>
      <div style="position:relative;margin-bottom:8px">
        <input class="form-input" id="cs-piece-recherche" placeholder="${TR("Ajouter une pièce du catalogue (réf. ou désignation)…")}" oninput="rechercherPieceSuede(this.value)" autocomplete="off">
        <div id="cs-piece-suggest" style="position:absolute;left:0;right:0;top:100%;background:#fff;border:0.5px solid var(--border);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.12);z-index:50;max-height:200px;overflow:auto;display:none"></div>
      </div>
      <div id="cs-lignes-liste"></div>

      <div class="grid-2" style="margin-top:10px">
        <div class="form-group"><label class="form-label">Transporteur</label>
          <select class="form-input" id="cs-transporteur">
            <option value="">—</option>
            <option value="UPS">UPS</option>
            <option value="DB Schenker">DB Schenker</option>
          </select></div>
        <div class="form-group"><label class="form-label">N° de suivi</label>
          <input class="form-input mono" id="cs-suivi" placeholder="1Z…"></div>
      </div>
      <div class="grid-2">
        <div class="form-group"><label class="form-label">${TR("Date de commande")}</label>
          <input class="form-input" id="cs-date" type="date"></div>
        <div class="form-group"><label class="form-label">${TR('Date de livraison prévue')}</label>
          <input class="form-input" id="cs-livraison" type="date"></div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn" onclick="closeModal()">${t('btn_annuler')||'Annuler'}</button>
      <button class="btn primary" onclick="enregistrerCommandeSuede()"><i class="ti ti-check"></i>${TR('Créer')}</button>
    </div>`);
  dessinerLignesSuede();
}

async function rechercherPieceSuede(q) {
  const boite = document.getElementById('cs-piece-suggest');
  if (!boite) return;
  q = (q || '').trim().toLowerCase();
  if (q.length < 1) { boite.style.display = 'none'; return; }
  if (!_csCatalogue) {
    try { _csCatalogue = await API.catalogue(); } catch (_) { _csCatalogue = []; }
  }
  const n = s => String(s || '').toLowerCase();
  const trouves = _csCatalogue.filter(c => n(c.ref).includes(q) || n(c.designation).includes(q)).slice(0, 8);
  if (!trouves.length) { boite.style.display = 'none'; return; }
  boite.innerHTML = trouves.map(c =>
    `<div onclick="ajouterLigneSuede(${c.id})" style="padding:7px 10px;cursor:pointer;border-bottom:0.5px solid rgba(0,0,0,.05);font-size:14px" onmouseover="this.style.background='rgba(46,124,246,.08)'" onmouseout="this.style.background=''">
      <span class="mono" style="color:var(--text3)">${esc(c.ref)}</span> — ${esc(c.designation)}
    </div>`).join('');
  boite.style.display = '';
}
window.rechercherPieceSuede = rechercherPieceSuede;

function ajouterLigneSuede(catalogueId) {
  const art = (_csCatalogue || []).find(c => c.id === catalogueId);
  if (!art) return;
  const existante = _csLignes.find(l => l.catalogue_id === catalogueId);
  if (existante) existante.quantite += 1;
  else _csLignes.push({ catalogue_id: art.id, reference: art.ref, designation: art.designation, quantite: 1, rapproche: true });
  const champ = document.getElementById('cs-piece-recherche');
  if (champ) champ.value = '';
  const boite = document.getElementById('cs-piece-suggest');
  if (boite) boite.style.display = 'none';
  dessinerLignesSuede();
}
window.ajouterLigneSuede = ajouterLigneSuede;

function dessinerLignesSuede() {
  const zone = document.getElementById('cs-lignes-liste');
  if (!zone) return;
  if (!_csLignes.length) {
    zone.innerHTML = '<div style="font-size:14px;color:var(--text3);padding:8px 0">'+TR("Aucune pièce pour l'instant. Ajoutez-les ci-dessus, ou importez un document VosFactures.")+'</div>';
    return;
  }
  zone.innerHTML = `<div class="table-wrap"><table class="t"><thead><tr><th>${TR('Réf.')}</th><th>${TR('Désignation')}</th><th style="width:90px">${TR('Qté')}</th><th></th></tr></thead>
    <tbody>${_csLignes.map((l, i) => `<tr>
      <td class="mono">${esc(l.reference || '—')}${l.rapproche === false ? ' <span class="badge hg" title="Hors catalogue">?</span>' : ''}</td>
      <td>${esc(l.designation)}</td>
      <td><input class="form-input" type="number" min="1" value="${l.quantite}" onchange="majQteLigneSuede(${i}, this.value)" style="width:70px;padding:3px 6px"></td>
      <td><button class="btn sm" onclick="retirerLigneSuede(${i})" title="Retirer"><i class="ti ti-x"></i></button></td>
    </tr>`).join('')}</tbody></table></div>`;
}

function majQteLigneSuede(index, valeur) {
  const q = parseInt(valeur);
  if (_csLignes[index] && q > 0) _csLignes[index].quantite = q;
}
window.majQteLigneSuede = majQteLigneSuede;

function retirerLigneSuede(index) {
  _csLignes.splice(index, 1);
  dessinerLignesSuede();
}
window.retirerLigneSuede = retirerLigneSuede;

// Import direct par URL ou ID du document VosFactures
async function importerDocVF() {
  const saisie = document.getElementById('cs-vf-url')?.value.trim();
  const zone = document.getElementById('cs-lookup');
  if (!saisie) { toast('Collez l\'URL ou l\'ID du document', 'ti-alert-circle'); return; }
  let id = null;
  const m = saisie.match(/warehouse_documents\/(\d+)/) || saisie.match(/\/(\d{4,})/);
  if (m) id = m[1];
  else if (/^\d+$/.test(saisie)) id = saisie;

  if (id) {
    if (zone) zone.innerHTML = '<div style="font-size:14px;color:var(--text2)">'+TR("Chargement du document…")+'</div>';
    try {
      const r = await API.stockDoc(id, '', '1'); // warehouse=1
      if (!r.found || !Array.isArray(r.lignes) || !r.lignes.length) {
        if (zone) zone.innerHTML = '<div style="font-size:14px;color:var(--warning)">'+TR("Document trouvé mais sans lignes exploitables. Ajoutez les pièces manuellement.")+'</div>';
        return;
      }
      fusionnerLignesImportees(r.lignes, r.date);
      if (zone) zone.innerHTML = `<div style="font-size:14px;color:var(--success);padding:6px 0"><i class="ti ti-check"></i> ${r.lignes.length} ligne(s) importée(s)${r.numero ? ' du ' + esc(r.numero) : ''}.</div>`;
    } catch (e) {
      if (zone) zone.innerHTML = `<div style="font-size:14px;color:var(--danger)">Erreur : ${esc(e.message)}</div>`;
    }
    return;
  }
  // Pas d'ID reconnaissable : recherche par numéro via stock-lookup
  if (zone) zone.innerHTML = '<div style="font-size:14px;color:var(--text2)">'+TR("Recherche par numéro…")+'</div>';
  try {
    const r = await API.stockLookup(saisie);
    if (!r.found || !Array.isArray(r.lignes) || !r.lignes.length) {
      if (zone) zone.innerHTML = '<div style="font-size:14px;color:var(--warning)">'+TR("Document introuvable. Ajoutez les pièces manuellement.")+'</div>';
      return;
    }
    fusionnerLignesImportees(r.lignes, r.date);
    if (zone) zone.innerHTML = `<div style="font-size:14px;color:var(--success);padding:6px 0"><i class="ti ti-check"></i> ${r.lignes.length} ligne(s) importée(s)${r.numero ? ' du ' + esc(r.numero) : ''}.</div>`;
  } catch (e) {
    if (zone) zone.innerHTML = `<div style="font-size:14px;color:var(--danger)">Erreur : ${esc(e.message)}</div>`;
  }
}
window.importerDocVF = importerDocVF;

// Ajoute les lignes importées (format serveur : reference/designation/quantite/catalogue_id)
function fusionnerLignesImportees(lignes, dateDoc) {
  for (const l of lignes) {
    const existante = l.catalogue_id
      ? _csLignes.find(x => x.catalogue_id === l.catalogue_id)
      : _csLignes.find(x => x.designation === l.designation && !x.catalogue_id);
    if (existante) existante.quantite += (l.quantite || 0);
    else _csLignes.push({
      catalogue_id: l.catalogue_id || null,
      reference: l.reference || null,
      designation: l.designation,
      quantite: l.quantite || 0,
      rapproche: !!l.catalogue_id
    });
  }
  // Pré-remplir la date de commande depuis le document importé, si le champ est vide
  const champDate = document.getElementById('cs-date');
  if (champDate && !champDate.value && dateDoc) champDate.value = String(dateDoc).slice(0, 10);
  dessinerLignesSuede();
}

async function enregistrerCommandeSuede() {
  const numero_bc = document.getElementById('cs-bc')?.value.trim();
  if (!numero_bc) { toast(TR('Référence requise'), 'ti-alert-circle'); return; }
  try {
    await API.createCommandeSuede({
      numero_bc,
      date_commande: document.getElementById('cs-date')?.value || null,
      transporteur: document.getElementById('cs-transporteur')?.value || null,
      num_suivi: document.getElementById('cs-suivi')?.value || null,
      date_livraison: document.getElementById('cs-livraison')?.value || null,
      lignes: _csLignes.map(l => ({
        catalogue_id: l.catalogue_id || null,
        reference: l.reference || null,
        designation: l.designation,
        quantite: l.quantite || 1
      }))
    });
    closeModal();
    toast(TR('Commande Suède créée'), 'ti-check');
    chargerCommandesSuede();
  } catch (e) { toast(e.message, 'ti-alert-circle', 'var(--danger)'); }
}

async function ouvrirCommandeSuede(id) {
  try {
    const cs = await API.commandeSuede(id);
    window._csNumeroBc = cs.numero_bc;
    const lien = lienSuiviColis(cs.transporteur, cs.num_suivi);
    const peutIntegrer = cs.date_livraison && !cs.stock_integre;
    showModal(`
      <div class="modal-head"><h3><i class="ti ti-truck-delivery"></i>${esc(cs.numero_bc)}</h3>
        <button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
      <div class="modal-body">
        <div class="grid-2">
          <div class="form-group"><label class="form-label">${TR('Référence')}</label>
            <input class="form-input mono" value="${esc(cs.numero_bc)}" readonly style="background:rgba(0,0,0,.03)"></div>
          <div class="form-group"><label class="form-label">${TR("Date de commande")}</label>
            <input class="form-input" id="cs-e-date" type="date" value="${cs.date_commande||''}"></div>
          <div class="form-group"><label class="form-label">Transporteur</label>
            <select class="form-input" id="cs-e-transporteur">
              <option value="" ${!cs.transporteur?'selected':''}>—</option>
              <option value="UPS" ${cs.transporteur==='UPS'?'selected':''}>UPS</option>
              <option value="DB Schenker" ${cs.transporteur==='DB Schenker'?'selected':''}>DB Schenker</option>
            </select></div>
          <div class="form-group"><label class="form-label">N° de suivi</label>
            <input class="form-input mono" id="cs-e-suivi" value="${esc(cs.num_suivi||'')}"></div>
        </div>
        <div class="form-group"><label class="form-label">${TR("Date de livraison")}</label>
          <input class="form-input" id="cs-e-livraison" type="date" value="${cs.date_livraison||''}">
          ${lien ? `<a href="${lien}" target="_blank" rel="noopener" style="font-size:14px;color:var(--accent);display:inline-block;margin-top:4px"><i class="ti ti-external-link"></i> Suivre le colis</a>` : ''}
        </div>
        <div class="section-title" style="margin-top:8px"><i class="ti ti-list"></i>Lignes (${cs.lignes.length})</div>
        <div class="table-wrap"><table class="t"><thead><tr><th>${TR('Désignation')}</th><th>${TR('Réf.')}</th><th>${TR('Cmdé')}</th>${cs.stock_integre?'<th>'+TR("Reçu")+'</th><th>Reliquat</th>':''}</tr></thead>
          <tbody>${cs.lignes.map(l => `<tr>
            <td>${esc(l.designation)}${l.catalogue_id?'':' <span class="badge hg" title="'+TR("Non rattaché au catalogue")+'">?</span>'}</td>
            <td class="mono">${esc(l.reference||'—')}</td>
            <td>${l.quantite_commandee}</td>
            ${cs.stock_integre?`<td>${l.quantite_recue==null?'—':l.quantite_recue}</td><td>${l.reliquat>0?`<span class="badge hg">${l.reliquat}</span>`:'0'}</td>`:''}
          </tr>`).join('')}</tbody></table></div>
        ${cs.stock_integre ? `<div style="font-size:14px;color:var(--success);margin-top:8px"><i class="ti ti-check"></i> Stock intégré${cs.integre_le?' le '+fd(String(cs.integre_le).slice(0,10)):''}</div>` : ''}
      </div>
      <div class="modal-foot" style="justify-content:space-between">
        <div>${cs.stock_integre ? '' : `<button class="btn sm danger" onclick="supprimerCommandeSuede(${cs.id})"><i class="ti ti-trash"></i>${TR('Supprimer')}</button>`}</div>
        <div style="display:flex;gap:6px">
          ${cs.stock_integre ? '' : `<button class="btn" onclick="sauverCommandeSuede(${cs.id})"><i class="ti ti-device-floppy"></i>${TR('Enregistrer')}</button>`}
          ${peutIntegrer ? `<button class="btn primary" onclick="modalIntegrerStock(${cs.id})"><i class="ti ti-package-import"></i>${TR('Intégrer dans le stock')}</button>` : ''}
        </div>
      </div>`);
  } catch (e) { toast(e.message, 'ti-alert-circle', 'var(--danger)'); }
}

async function sauverCommandeSuede(id) {
  try {
    await API.updateCommandeSuede(id, {
      numero_bc: window._csNumeroBc,
      date_commande: document.getElementById('cs-e-date')?.value || null,
      transporteur: document.getElementById('cs-e-transporteur')?.value || null,
      num_suivi: document.getElementById('cs-e-suivi')?.value || null,
      date_livraison: document.getElementById('cs-e-livraison')?.value || null
    });
    closeModal();
    toast(TR('Enregistré'), 'ti-check');
    chargerCommandesSuede();
  } catch (e) { toast(e.message, 'ti-alert-circle', 'var(--danger)'); }
}

// Réception : corriger réf, désignation, quantité reçue, relier au catalogue
async function modalIntegrerStock(id) {
  try {
    const cs = await API.commandeSuede(id);
    if (!_csCatalogue) { try { _csCatalogue = await API.catalogue(); } catch (_) { _csCatalogue = []; } }
    window._csIntLignes = cs.lignes.map(l => ({
      id: l.id, reference: l.reference, designation: l.designation,
      catalogue_id: l.catalogue_id, quantite_commandee: l.quantite_commandee
    }));
    showModal(`
      <div class="modal-head"><h3><i class="ti ti-package-import"></i>Réception ${esc(cs.numero_bc)}</h3>
        <button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
      <div class="modal-body">
        <div style="font-size:14px;color:var(--text2);margin-bottom:10px">${TR('Vérifiez la livraison. Ajustez la quantité reçue (un reliquat est calculé si elle est inférieure à la commande) et, au besoin, corrigez la référence ou reliez une ligne au catalogue pour que le stock soit mis à jour.')}</div>
        <div id="cs-int-liste"></div>
      </div>
      <div class="modal-foot">
        <button class="btn" onclick="ouvrirCommandeSuede(${id})">${t('btn_annuler')||'Annuler'}</button>
        <button class="btn primary" onclick="confirmerIntegrationStock(${id})"><i class="ti ti-check"></i>${TR('Valider et mettre à jour le stock')}</button>
      </div>`);
    dessinerLignesIntegration();
  } catch (e) { toast(e.message, 'ti-alert-circle', 'var(--danger)'); }
}

function dessinerLignesIntegration() {
  const zone = document.getElementById('cs-int-liste');
  if (!zone) return;
  const lignes = window._csIntLignes || [];
  zone.innerHTML = `<div class="table-wrap"><table class="t">
    <thead><tr><th>${TR('Réf.')}</th><th>${TR('Désignation')}</th><th style="width:70px">${TR('Cmdé')}</th><th style="width:80px">${TR('Reçu')}</th><th style="width:70px">Reliquat</th></tr></thead>
    <tbody>${lignes.map((l, i) => {
      const recu = (l._recu !== undefined) ? l._recu : l.quantite_commandee;
      const reliquat = Math.max(0, l.quantite_commandee - recu);
      const rattache = !!l.catalogue_id;
      return `<tr>
        <td>
          <input class="form-input mono" value="${esc(l.reference || '')}" onchange="majIntLigne(${i},'reference',this.value)" style="width:90px;padding:3px 6px;font-size:14px" placeholder="${TR("réf.")}">
          ${rattache
            ? '<div style="font-size:12px;color:var(--success)"><i class="ti ti-link"></i> catalogue</div>'
            : `<div style="font-size:12px"><span onclick="relierLigneCatalogue(${i})" style="color:var(--accent);cursor:pointer"><i class="ti ti-link"></i> relier au stock</span></div>`}
        </td>
        <td><input class="form-input" value="${esc(l.designation || '')}" onchange="majIntLigne(${i},'designation',this.value)" style="min-width:160px;padding:3px 6px;font-size:14px"></td>
        <td>${l.quantite_commandee}</td>
        <td><input class="form-input" type="number" min="0" value="${recu}" oninput="majIntLigne(${i},'_recu',this.value)" style="width:70px;padding:3px 6px"></td>
        <td id="cs-int-reliquat-${i}">${reliquat > 0 ? `<span class="badge hg">${reliquat}</span>` : '<span style="color:var(--text3)">0</span>'}</td>
      </tr>`;
    }).join('')}</tbody></table></div>
    <div style="font-size:13px;color:var(--text3);margin-top:6px">${TR("Une ligne « relier au stock » non reliée n'incrémente aucun stock, mais la réception est enregistrée.")}</div>`;
}

function majIntLigne(index, champ, valeur) {
  const l = (window._csIntLignes || [])[index];
  if (!l) return;
  if (champ === '_recu') {
    l._recu = Math.max(0, parseInt(valeur) || 0);
    // Recalculer uniquement la cellule reliquat de cette ligne (sans redessiner tout le tableau,
    // ce qui ferait perdre le focus du champ en cours de saisie)
    const cell = document.getElementById('cs-int-reliquat-' + index);
    if (cell) {
      const reliquat = Math.max(0, l.quantite_commandee - l._recu);
      cell.innerHTML = reliquat > 0 ? `<span class="badge hg">${reliquat}</span>` : '<span style="color:var(--text3)">0</span>';
    }
  } else {
    l[champ] = valeur;
  }
}
window.majIntLigne = majIntLigne;

function relierLigneCatalogue(index) {
  const l = (window._csIntLignes || [])[index];
  if (!l) return;
  const choix = prompt(TR('Référence de la pièce du catalogue à relier :'), l.reference || '');
  if (!choix) return;
  const art = (_csCatalogue || []).find(c => String(c.ref).toLowerCase() === choix.trim().toLowerCase());
  if (!art) { toast(TR('Référence introuvable dans le catalogue'), 'ti-alert-circle', 'var(--danger)'); return; }
  l.catalogue_id = art.id;
  l.reference = art.ref;
  if (!l.designation) l.designation = art.designation;
  dessinerLignesIntegration();
}
window.relierLigneCatalogue = relierLigneCatalogue;

async function confirmerIntegrationStock(id) {
  const lignes = (window._csIntLignes || []).map(l => ({
    id: l.id,
    reference: l.reference || null,
    designation: l.designation || null,
    catalogue_id: l.catalogue_id || null,
    quantite_recue: (l._recu !== undefined) ? l._recu : l.quantite_commandee
  }));
  try {
    await API.integrerStockSuede(id, lignes);
    closeModal();
    toast(TR('Stock mis à jour'), 'ti-check', 'var(--success)');
    chargerCommandesSuede();
  } catch (e) { toast(e.message, 'ti-alert-circle', 'var(--danger)'); }
}

async function supprimerCommandeSuede(id) {
  if (!confirm(TR('Supprimer cette commande Suède ?'))) return;
  try {
    await API.deleteCommandeSuede(id);
    closeModal();
    toast(TR('Supprimé'), 'ti-check');
    chargerCommandesSuede();
  } catch (e) { toast(e.message, 'ti-alert-circle', 'var(--danger)'); }
}

window.renderCommandeSuede = renderCommandeSuede;
window.modalNouvelleCommandeSuede = modalNouvelleCommandeSuede;
window.enregistrerCommandeSuede = enregistrerCommandeSuede;
window.ouvrirCommandeSuede = ouvrirCommandeSuede;
window.sauverCommandeSuede = sauverCommandeSuede;
window.modalIntegrerStock = modalIntegrerStock;
window.confirmerIntegrationStock = confirmerIntegrationStock;
window.supprimerCommandeSuede = supprimerCommandeSuede;

})();

// ═══════════════════════════════════════════════════════════════════
// RATTACHEMENT EN MASSE DES POINTS DE CARTE AUX FICHES CLIENTS
// ═══════════════════════════════════════════════════════════════════
var _ratDonnees = null;
var _ratChoix = {};      // id du point -> id du client retenu (ou null)
var _ratChoixNom = {};   // id du point -> nom du client choisi manuellement (affichage)

function ouvrirRattachements() {
  var div = document.createElement('div');
  div.id = 'modal-rattachements';
  div.innerHTML =
    '<div style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9998;display:flex;align-items:center;justify-content:center" onclick="if(event.target===this)fermerRattachements()">' +
      '<div style="background:#fff;border-radius:12px;width:820px;max-width:94vw;height:86vh;display:flex;flex-direction:column" onclick="event.stopPropagation()">' +
        '<div style="padding:18px 22px 12px;border-bottom:0.5px solid var(--border)">' +
          '<h3 style="margin:0 0 4px;font-size:18px">'+TR("Rattacher les points aux fiches clients")+'</h3>' +
          '<div style="font-size:14px;color:var(--text2)">'+TR("Un point relié à une fiche affiche les ventes de ce client, quelle que soit l\\u2019orthographe employée dans les commandes.")+'</div>' +
          '<div id="rat-stats" style="font-size:14px;color:var(--text3);margin-top:8px">'+TR("Chargement…")+'</div>' +
        '</div>' +
        '<div id="rat-liste" style="flex:1;overflow:auto;padding:14px 22px"></div>' +
        '<div style="padding:14px 22px;border-top:0.5px solid var(--border);display:flex;gap:8px;justify-content:flex-end;align-items:center">' +
          '<span id="rat-compteur" style="font-size:14px;color:var(--text3);margin-right:auto"></span>' +
          '<button class="btn" onclick="fermerRattachements()">'+TR("Fermer")+'</button>' +
          '<button class="btn primary" onclick="enregistrerRattachements(this)"><i class="ti ti-check"></i>'+TR("Enregistrer")+'</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(div);
  _ratChoix = {};
  _ratChoixNom = {};
  // Liste des clients pour la recherche manuelle (« Autre fiche… »)
  fetch('/api/carte/clients-liste').then(function(r){ return r.json(); }).then(function(c){ window._RAT_CLIENTS = Array.isArray(c) ? c : []; }).catch(function(){});
  chargerRattachements();
}
window.ouvrirRattachements = ouvrirRattachements;

// Recherche manuelle d'une fiche client pour un point (écran Rattacher)
function ratSearch(pid, q) {
  var drop = document.getElementById('rat-drop-' + pid); if (!drop) return;
  var src = window._RAT_CLIENTS || [];
  var query = (q || '').toLowerCase().trim();
  if (!query) { drop.style.display = 'none'; return; }
  var res = src.filter(function(c){ return (c.nom && c.nom.toLowerCase().indexOf(query) >= 0) || (c.ville && c.ville.toLowerCase().indexOf(query) >= 0); }).slice(0, 20);
  if (!res.length) { drop.style.display = 'none'; return; }
  drop.innerHTML = res.map(function(c){
    return '<div class="piece-option" onmousedown="event.preventDefault();ratSelect(' + pid + ',' + c.id + ',\'' + String(c.nom||'').replace(/'/g,'&#39;') + '\')">' +
      '<div style="font-size:14px;font-weight:600">' + _esc(c.nom) + '</div>' +
      (c.ville ? '<div style="font-size:13px;color:var(--text3)">' + _esc(c.ville) + '</div>' : '') + '</div>';
  }).join('');
  drop.style.display = 'block';
}
window.ratSearch = ratSearch;
function ratSelect(pid, clientId, nom) {
  _ratChoix[pid] = clientId;
  _ratChoixNom[pid] = nom;
  var drop = document.getElementById('rat-drop-' + pid); if (drop) drop.style.display = 'none';
  var inp = document.getElementById('rat-search-' + pid); if (inp) inp.value = '';
  var disp = document.getElementById('rat-choix-' + pid); if (disp) disp.innerHTML = '<i class="ti ti-check"></i> '+TR("Rattaché à :")+' <strong>' + _esc(nom) + '</strong>';
  // Décocher les radios de suggestion de ce point (le choix manuel prime)
  var radios = document.querySelectorAll('input[name="rat-' + pid + '"]');
  radios.forEach(function(r){ r.checked = false; });
  majCompteurRat();
}
window.ratSelect = ratSelect;

function fermerRattachements() {
  var m = document.getElementById('modal-rattachements');
  if (m) m.remove();
}
window.fermerRattachements = fermerRattachements;

function chargerRattachements() {
  fetch('/api/carte/rattachements')
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (!d.ok) throw new Error(d.error || 'chargement impossible');
      _ratDonnees = d;
      var stats = document.getElementById('rat-stats');
      if (stats) stats.innerHTML =
        '<strong>' + d.total + '</strong> points — ' +
        '<span style="color:#16a34a">' + d.lies + ' déjà reliés</span> · ' +
        '<span style="color:#2e7cf6">' + d.avec_suggestion + ' avec une correspondance probable</span> · ' +
        '<span style="color:var(--text3)">' + d.sans_suggestion + ' sans correspondance</span>';
      dessinerRattachements();
    })
    .catch(function(e){
      var l = document.getElementById('rat-liste');
      if (l) l.innerHTML = '<div style="color:var(--danger);padding:20px">Erreur : ' + _esc(e.message) + '</div>';
    });
}

function dessinerRattachements() {
  var l = document.getElementById('rat-liste');
  if (!l || !_ratDonnees) return;

  var aTraiter = _ratDonnees.points.filter(function(p){ return p.etat === 'suggestion'; });
  var sansRien = _ratDonnees.points.filter(function(p){ return p.etat === 'aucune'; });

  if (!aTraiter.length && !sansRien.length) {
    l.innerHTML = '<div style="padding:30px;text-align:center;color:#16a34a"><i class="ti ti-check" style="font-size:28px"></i><br>'+TR("Tous les points sont reliés à une fiche client.")+'</div>';
    majCompteurRat();
    return;
  }

  var html = '';
  if (aTraiter.length) {
    html += '<div style="font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--text3);font-weight:700;margin-bottom:8px">'+TR("Correspondances proposées")+'</div>';
    html += aTraiter.map(function(p){
      var cfg = RESEAUX_CONFIG[p.reseau] || { color: '#888', label: p.reseau };
      var choix = _ratChoix[p.id];
      var options = p.suggestions.map(function(s){
        var actif = (choix === s.id);
        return '<label style="display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;cursor:pointer;' +
               (actif ? 'background:rgba(46,124,246,.1)' : '') + '">' +
          '<input type="radio" name="rat-' + p.id + '" ' + (actif ? 'checked' : '') +
            ' onchange="choisirRattachement(' + p.id + ',' + s.id + ')">' +
          '<span style="flex:1;font-size:15px">' + _esc(s.nom) +
            (s.ville ? ' <span style="color:var(--text3)">— ' + _esc(s.ville) + '</span>' : '') + '</span>' +
          (s.commandes ? '<span style="font-size:13px;background:rgba(46,124,246,.1);color:#2e7cf6;padding:1px 6px;border-radius:99px">' + s.commandes + ' cmd</span>' : '') +
          (s.deja_lie ? '<span style="font-size:13px;color:#d97706" title="'+TR("Déjà relié à un autre point")+'">'+TR("déjà relié")+'</span>' : '') +
          '<span style="font-size:13px;color:var(--text3);width:34px;text-align:right">' + s.score + '%</span>' +
        '</label>';
      }).join('');

      return '<div style="border:0.5px solid var(--border);border-radius:9px;padding:10px 12px;margin-bottom:8px">' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
          '<span style="width:11px;height:11px;border-radius:50%;background:' + cfg.color + ';flex-shrink:0"></span>' +
          '<strong style="font-size:15px">' + _esc(p.nom) + '</strong>' +
          '<span style="font-size:13px;color:var(--text3)">' + _esc([p.cp, p.ville].filter(Boolean).join(' ')) + '</span>' +
        '</div>' + options +
        '<label style="display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;cursor:pointer">' +
          '<input type="radio" name="rat-' + p.id + '" ' + (choix === null ? 'checked' : '') +
            ' onchange="choisirRattachement(' + p.id + ',null)">' +
          '<span style="font-size:14px;color:var(--text3)">'+TR("Aucune de ces fiches")+'</span>' +
        '</label>' +
        '<div style="position:relative;margin-top:4px;padding-top:6px;border-top:0.5px dashed var(--border)">' +
          '<input id="rat-search-' + p.id + '" placeholder="🔎 Chercher une autre fiche…" autocomplete="off" oninput="ratSearch(' + p.id + ',this.value)" onblur="setTimeout(function(){var d=document.getElementById(\'rat-drop-' + p.id + '\');if(d)d.style.display=\'none\'},150)" style="width:100%;border:0.5px solid var(--border);border-radius:6px;padding:5px 8px;font-size:14px;background:var(--surface)">' +
          '<div id="rat-drop-' + p.id + '" class="piece-dropdown" style="display:none"></div>' +
          '<div id="rat-choix-' + p.id + '" style="font-size:13px;color:#16a34a;margin-top:3px">' + (_ratChoixNom[p.id] ? '<i class="ti ti-check"></i> '+TR("Rattaché à :")+' <strong>' + _esc(_ratChoixNom[p.id]) + '</strong>' : '') + '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  if (sansRien.length) {
    html += '<div style="font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--text3);font-weight:700;margin:18px 0 8px">' +
            'Sans correspondance (' + sansRien.length + ')</div>' +
            '<div style="font-size:14px;color:var(--text3);margin-bottom:8px">'+TR("Ces points n\\u2019ont pas d\\u2019équivalent parmi les fiches clients. Leurs ventes restent rapprochées par le nom.")+'</div>' +
            sansRien.map(function(p){
              var cfg = RESEAUX_CONFIG[p.reseau] || { color: '#888' };
              return '<div style="border:0.5px solid var(--border);border-radius:9px;padding:10px 12px;margin-bottom:8px">' +
                '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
                  '<span style="width:11px;height:11px;border-radius:50%;background:' + cfg.color + ';flex-shrink:0"></span>' +
                  '<strong style="font-size:15px">' + _esc(p.nom) + '</strong>' +
                  '<span style="font-size:13px;color:var(--text3)">' + _esc([p.cp, p.ville].filter(Boolean).join(' ')) + '</span>' +
                '</div>' +
                '<div style="position:relative">' +
                  '<input id="rat-search-' + p.id + '" placeholder="'+TR("🔎 Chercher une fiche à relier…")+'" autocomplete="off" oninput="ratSearch(' + p.id + ',this.value)" onblur="setTimeout(function(){var d=document.getElementById(\'rat-drop-' + p.id + '\');if(d)d.style.display=\'none\'},150)" style="width:100%;border:0.5px solid var(--border);border-radius:6px;padding:5px 8px;font-size:14px;background:var(--surface)">' +
                  '<div id="rat-drop-' + p.id + '" class="piece-dropdown" style="display:none"></div>' +
                  '<div id="rat-choix-' + p.id + '" style="font-size:13px;color:#16a34a;margin-top:3px">' + (_ratChoixNom[p.id] ? '<i class="ti ti-check"></i> '+TR("Rattaché à :")+' <strong>' + _esc(_ratChoixNom[p.id]) + '</strong>' : '') + '</div>' +
                '</div>' +
              '</div>';
            }).join('');
  }

  l.innerHTML = html;
  majCompteurRat();
}

function choisirRattachement(pointId, clientId) {
  _ratChoix[pointId] = clientId;
  majCompteurRat();
}
window.choisirRattachement = choisirRattachement;

function majCompteurRat() {
  var n = Object.keys(_ratChoix).filter(function(k){ return _ratChoix[k] != null; }).length;
  var el = document.getElementById('rat-compteur');
  if (el) el.textContent = n ? n + ' rattachement(s) à enregistrer' : 'Aucun rattachement sélectionné';
}

function enregistrerRattachements(btn) {
  var liens = Object.keys(_ratChoix)
    .filter(function(k){ return _ratChoix[k] != null; })
    .map(function(k){ return { point_id: parseInt(k), client_id: _ratChoix[k] }; });
  if (!liens.length) { toast(TR('Aucun rattachement sélectionné'), 'ti-info-circle'); return; }

  var libelle = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader-2"></i>Enregistrement…'; }
  fetch('/api/carte/rattachements', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ liens: liens })
  })
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (!d.ok) throw new Error(d.error || 'échec');
      toast(d.appliques + ' point(s) rattaché(s)', 'ti-check', 'var(--success)');
      _ratChoix = {};
      chargerRattachements();
      if (typeof chargerPoints === 'function') chargerPoints();
    })
    .catch(function(e){ toast(e.message, 'ti-alert-circle', 'var(--danger)'); })
    .finally(function(){ if (btn) { btn.disabled = false; btn.innerHTML = libelle; } });
}
window.enregistrerRattachements = enregistrerRattachements;


// ═══════════════════════════════════════════════════════════════════
// SAUVEGARDE DE LA BASE
// ═══════════════════════════════════════════════════════════════════
function chargerResumeSauvegarde() {
  var el = document.getElementById('sauvegarde-resume');
  if (!el) return;
  fetch('/api/sauvegarde/resume')
    .then(function(r){ return r.json(); })
    .then(function(d){
      var el = document.getElementById('sauvegarde-resume');
      if (!el || !d.ok) return;
      var principales = ['commandes','clients','interventions','fauteuils','distributeurs_carte','catalogue'];
      var detail = principales
        .filter(function(t){ return d.tables[t] != null; })
        .map(function(t){ return '<strong>' + d.tables[t] + '</strong> ' + t.replace('distributeurs_carte','points de carte'); })
        .join(' · ');
      var derniere = d.derniere_sauvegarde
        ? 'Dernier envoi automatique : ' + _fd(d.derniere_sauvegarde)
        : 'Aucun envoi automatique enregistré pour le moment.';
      el.innerHTML = detail + '<br><span style="color:var(--text3)">' +
        d.total_lignes + ' lignes au total — ' + derniere + '</span>';
    })
    .catch(function(){
      var el = document.getElementById('sauvegarde-resume');
      if (el) el.textContent = '';
    });
}
window.chargerResumeSauvegarde = chargerResumeSauvegarde;

function envoyerSauvegardeMaintenant(btn) {
  if (!confirm(TR('Envoyer la sauvegarde complète à info@eloflex.fr maintenant ?'))) return;
  var libelle = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader-2"></i>Envoi en cours…'; }
  fetch('/api/sauvegarde/envoyer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (d.ok) {
        toast(TR('Sauvegarde envoyée (') + d.poids_mo + ' Mo)' + (d.joint ? '' : ' — trop volumineuse pour être jointe'),
              'ti-check', 'var(--success)');
      } else {
        toast(d.erreur || d.ignore || 'Envoi impossible', 'ti-alert-circle', 'var(--danger)');
      }
      chargerResumeSauvegarde();
    })
    .catch(function(e){ toast(e.message, 'ti-alert-circle', 'var(--danger)'); })
    .finally(function(){ if (btn) { btn.disabled = false; btn.innerHTML = libelle; } });
}
window.envoyerSauvegardeMaintenant = envoyerSauvegardeMaintenant;

// Restaure la base depuis un fichier de sauvegarde (.json ou .json.gz)
async function restaurerSauvegarde(btn){
  const input = document.getElementById('restore-file');
  const zone = document.getElementById('restore-result');
  const f = input && input.files && input.files[0];
  if (!f) { toast(TR('Choisissez d\'abord un fichier de sauvegarde'), 'ti-alert-circle'); return; }
  if (!confirm(TR('Restaurer cette sauvegarde ?\n\nToutes les données actuelles seront REMPLACÉES par celles du fichier. Cette action n\'est pas annulable.'))) return;

  const libelle = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = 'Restauration…'; }
  if (zone) zone.innerHTML = '<span style="color:var(--text2)">Lecture du fichier…</span>';
  try {
    let texte;
    const estGz = /\.gz$/i.test(f.name);
    if (estGz) {
      // Décompression gzip côté navigateur via DecompressionStream
      const ds = new DecompressionStream('gzip');
      const flux = f.stream().pipeThrough(ds);
      texte = await new Response(flux).text();
    } else {
      texte = await f.text();
    }
    const data = JSON.parse(texte);
    if (!data || !data.donnees) { throw new Error('Fichier invalide : structure "donnees" absente'); }
    if (zone) zone.innerHTML = '<span style="color:var(--text2)">Restauration en cours (cela peut prendre un moment)…</span>';
    const r = await API.restaurerSauvegarde(data);
    const lignes = Object.entries(r.rapport || {}).filter(([,n])=>n>0).sort((a,b)=>b[1]-a[1]);
    const total = lignes.reduce((s,[,n])=>s+n,0);
    if (zone) zone.innerHTML = '<span style="color:#16a34a">✓ Restauration réussie — '+total+' ligne(s) importée(s) sur '+lignes.length+' table(s).</span>';
    toast(TR('Sauvegarde restaurée'), 'ti-check', 'var(--success)');
    setTimeout(function(){ chargerResumeSauvegarde(); }, 500);
  } catch(e) {
    if (zone) zone.innerHTML = '<span style="color:var(--danger)">Erreur : '+esc(e.message)+'</span>';
    toast(TR('Échec de la restauration'), 'ti-alert-circle', 'var(--danger)');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = libelle; }
  }
}
window.restaurerSauvegarde = restaurerSauvegarde;


// Lien de suivi transporteur pour les interventions (envoi et retour).
// Renvoie toujours une URL exploitable : 17track sert de repli universel.
function lienhSuiviInter(transporteur, numero) {
  if (!numero) return '#';
  var n = encodeURIComponent(String(numero).trim());
  var t = String(transporteur || '').toLowerCase();
  if (t.indexOf('chronopost') >= 0) return 'https://www.chronopost.fr/tracking-no-cms/suivi-page?listeNumerosLT=' + n + '&langue=fr';
  if (t.indexOf('colissimo') >= 0 || t.indexOf('poste') >= 0) return 'https://www.laposte.fr/outils/suivre-vos-envois?code=' + n;
  if (t.indexOf('dpd') >= 0) return 'https://www.dpd.fr/trace/' + n;
  if (t.indexOf('ups') >= 0) return 'https://www.ups.com/track?loc=fr_FR&tracknum=' + n;
  if (t.indexOf('dhl') >= 0) return 'https://www.dhl.com/fr-fr/home/tracking/tracking-express.html?tracking-id=' + n;
  if (t.indexOf('schenker') >= 0) return 'https://www.dbschenker.com/app/tracking-public/?refNumber=' + n + '&language_region=fr-FR_FR';
  if (t.indexOf('dsv') >= 0) return 'https://www.dsv.com/mydsv/tracking-public/?refNumber=' + n + '&language_region=fr-FR_FR';
  if (t.indexOf('gls') >= 0) return 'https://gls-group.eu/FR/fr/suivi-colis?match=' + n;
  if (t.indexOf('tnt') >= 0) return 'https://www.tnt.com/express/fr_fr/site/outils-expedition/suivi.html?searchType=CON&cons=' + n;
  return 'https://t.17track.net/fr#nums=' + n;
}
window.lienhSuiviInter = lienhSuiviInter;


// ═══════════════════════════════════════════════════════════════════
// VUE DISCUSSIONS — fil des notes internes, toutes commandes
// ═══════════════════════════════════════════════════════════════════
var _DISC_TAB = 'fil';
var _DISC_ARCH = false;
var _DISC_EDIT = null;
var DISC_EMOJIS = ['👍','✅','❤️','👀','🎉'];

function renderDiscussions(ttl, c, a) {
  ttl.textContent = t('nav_discussions') || 'Discussions';
  a.innerHTML = '<button onclick="renderDiscussionsRecharger()" style="background:var(--surface);border:0.5px solid var(--border);border-radius:6px;padding:4px 10px;font-size:14px;cursor:pointer"><i class="ti ti-refresh"></i> Actualiser</button>';
  var tab = function(k,lbl){ return '<button id="disc-tab-'+k+'" onclick="switchDiscTab(\''+k+'\')" style="flex:0 0 auto;padding:8px 14px;border:none;background:none;cursor:pointer;font-size:15px;font-weight:600;border-bottom:2px solid transparent;color:var(--text2)">'+lbl+'</button>'; };
  c.innerHTML =
    '<div style="display:flex;gap:4px;border-bottom:0.5px solid var(--border-s);margin-bottom:14px">' +
      tab('fil','💬 Fil d\'équipe') + tab('notes','📦 Notes commandes') +
    '</div>' +
    '<div id="disc-fil"></div>' +
    '<div id="disc-notes" style="display:none"><div id="disc-body" style="color:var(--text2);font-size:15px;padding:10px 0">'+TR("Chargement…")+'</div></div>';
  switchDiscTab(_DISC_TAB);
}
window.renderDiscussions = renderDiscussions;

function switchDiscTab(k){
  _DISC_TAB = k;
  ['fil','notes'].forEach(function(x){
    var pane = document.getElementById('disc-'+x), btn = document.getElementById('disc-tab-'+x);
    if (pane) pane.style.display = (x===k)?'':'none';
    if (btn){ btn.style.borderBottom = (x===k)?'2px solid var(--accent)':'2px solid transparent'; btn.style.color = (x===k)?'var(--accent)':'var(--text2)'; }
  });
  if (k==='fil') chargerFil(); else chargerDiscussions();
}
window.switchDiscTab = switchDiscTab;

function renderDiscussionsRecharger() { if (_DISC_TAB==='fil') chargerFil(); else chargerDiscussions(); }
window.renderDiscussionsRecharger = renderDiscussionsRecharger;

function chargerFil(){
  var host = document.getElementById('disc-fil'); if(!host) return;
  host.innerHTML =
    '<div class="card" style="padding:12px 14px;margin-bottom:14px">' +
      '<textarea id="fil-nouveau" rows="2" placeholder="'+TR("Écrire un message à l'équipe…")+'" style="width:100%;border:0.5px solid var(--border-s);border-radius:8px;padding:8px 10px;font-size:15px;resize:vertical;font-family:inherit"></textarea>' +
      '<div style="display:flex;align-items:center;gap:12px;margin-top:8px">' +
        '<label style="display:flex;align-items:center;gap:6px;font-size:14px;color:var(--text2);cursor:pointer;margin-left:auto"><input type="checkbox" id="fil-arch-toggle" ' + (_DISC_ARCH?'checked':'') + ' onchange="_DISC_ARCH=this.checked;chargerFil()"> '+TR("Afficher les archivés")+'</label>' +
        '<button class="btn primary" onclick="publierFil()"><i class="ti ti-send"></i> Publier</button>' +
      '</div>' +
    '</div>' +
    '<div id="fil-liste" style="color:var(--text2);font-size:15px">'+TR("Chargement…")+'</div>';
  fetch('/api/discussions/fil?archived=' + (_DISC_ARCH?'1':'0'))
    .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
    .then(function(list){
      var el = document.getElementById('fil-liste'); if(!el) return;
      try { localStorage.setItem('sav_fil_seen', Date.now()); } catch(_) {}
      if (typeof refreshDiscussionsBadge === 'function') refreshDiscussionsBadge();
      if(!Array.isArray(list) || !list.length){ el.innerHTML = '<div class="empty"><i class="ti ti-messages"></i>'+(_DISC_ARCH?'Aucun message archivé.':'Aucun message pour le moment. Sois le premier à publier !')+'</div>'; return; }
      el.innerHTML = list.map(filCarte).join('');
    })
    .catch(function(e){ var el=document.getElementById('fil-liste'); if(el) el.innerHTML='<div style="color:var(--danger);padding:10px 0">Erreur : '+_esc(e.message)+'</div>'; });
}
window.chargerFil = chargerFil;

function filCarte(m){
  var edit = _DISC_EDIT === m.id;
  var reacts = DISC_EMOJIS.map(function(em){
    var found = (m.reactions||[]).find(function(r){ return r.emoji===em; });
    var cnt = found ? found.count : 0, mine = found ? found.mine : false, title = found ? found.users.join(', ') : '';
    return '<button onclick="reactFil('+m.id+',\''+em+'\')" title="'+_esc(title)+'" style="border:0.5px solid '+(mine?'var(--accent)':'var(--border-s)')+';background:'+(mine?'rgba(46,124,246,.10)':'var(--surface)')+';border-radius:99px;padding:2px 9px;font-size:15px;cursor:pointer;line-height:1.5">'+em+(cnt?' <span style="font-size:13px;color:var(--text2)">'+cnt+'</span>':'')+'</button>';
  }).join(' ');
  var actions = '';
  if (m.can_edit){
    actions += '<button onclick="pinFil('+m.id+','+(m.pinned?'false':'true')+')" title="'+(m.pinned?'Désépingler':'Épingler')+'" style="background:none;border:none;cursor:pointer;color:'+(m.pinned?'var(--accent)':'var(--text3)')+';padding:2px 4px"><i class="ti ti-pin'+(m.pinned?'-filled':'')+'"></i></button>';
    actions += '<button onclick="archiveFil('+m.id+','+(m.archived?'false':'true')+')" title="'+(m.archived?'Désarchiver':'Archiver')+'" style="background:none;border:none;cursor:pointer;color:var(--text3);padding:2px 4px"><i class="ti ti-archive"></i></button>';
    actions += '<button onclick="editFil('+m.id+')" title="'+TR("Éditer")+'" style="background:none;border:none;cursor:pointer;color:var(--text3);padding:2px 4px"><i class="ti ti-pencil"></i></button>';
    actions += '<button onclick="supprFil('+m.id+')" title="'+TR("Supprimer")+'" style="background:none;border:none;cursor:pointer;color:var(--danger);padding:2px 4px"><i class="ti ti-trash"></i></button>';
  }
  var corps = edit
    ? '<textarea id="fil-edit-'+m.id+'" rows="3" style="width:100%;border:0.5px solid var(--border-s);border-radius:8px;padding:8px 10px;font-size:15px;resize:vertical;font-family:inherit">'+_esc(m.contenu)+'</textarea>' +
      '<div style="display:flex;gap:6px;justify-content:flex-end;margin-top:6px"><button class="btn sm" onclick="_DISC_EDIT=null;chargerFil()">'+TR("Annuler")+'</button><button class="btn sm primary" onclick="sauverEditFil('+m.id+')">'+TR("Enregistrer")+'</button></div>'
    : '<div style="font-size:15.5px;white-space:pre-wrap;line-height:1.5">'+_esc(m.contenu)+'</div>';
  var initiale = (m.user_nom||'?').trim().charAt(0).toUpperCase();
  return '<div class="card" style="padding:12px 14px;margin-bottom:10px;'+(m.pinned?'border-left:3px solid var(--accent)':'')+'">' +
    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">' +
      '<span style="width:26px;height:26px;border-radius:50%;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;flex-shrink:0">'+_esc(initiale)+'</span>' +
      '<span style="font-weight:700;font-size:15px">'+_esc(m.user_nom||'Utilisateur')+'</span>' +
      (m.pinned?'<span class="badge ouvert" style="font-size:12px"><i class="ti ti-pin-filled" style="font-size:12px"></i> '+TR("Épinglé")+'</span>':'') +
      (m.archived?'<span class="badge hg" style="font-size:12px">'+TR("Archivé")+'</span>':'') +
      '<span style="font-size:13px;color:var(--text3)">'+_fd(m.created_at)+ (m.updated_at && m.updated_at!==m.created_at ? ' · modifié' : '') +'</span>' +
      '<span style="margin-left:auto;display:flex;gap:2px">'+actions+'</span>' +
    '</div>' +
    corps +
    (edit ? '' :
      '<div style="display:flex;gap:5px;margin-top:10px;flex-wrap:wrap">'+reacts+'</div>' +
      ((m.replies||[]).length ? '<div style="margin-top:8px">'+(m.replies||[]).map(filReply).join('')+'</div>' : '') +
      '<div style="display:flex;gap:6px;margin-top:8px;padding-left:34px">' +
        '<input id="reply-'+m.id+'" placeholder="'+TR("Répondre…")+'" onkeydown="if(event.key===\'Enter\'){event.preventDefault();repondreFil('+m.id+')}" style="flex:1;border:0.5px solid var(--border-s);border-radius:7px;padding:6px 9px;font-size:14px">' +
        '<button class="btn sm" onclick="repondreFil('+m.id+')"><i class="ti ti-corner-down-right"></i> '+TR("Répondre")+'</button>' +
      '</div>'
    ) +
  '</div>';
}

// Réponse (style réduit, indentée sous le message d'origine)
function filReply(r){
  var edit = _DISC_EDIT === r.id;
  var actions = (r.can_edit && !edit)
    ? '<button onclick="editFil('+r.id+')" title="'+TR("Éditer")+'" style="background:none;border:none;cursor:pointer;color:var(--text3);padding:1px 3px"><i class="ti ti-pencil" style="font-size:14px"></i></button>' +
      '<button onclick="supprFil('+r.id+')" title="'+TR("Supprimer")+'" style="background:none;border:none;cursor:pointer;color:var(--danger);padding:1px 3px"><i class="ti ti-trash" style="font-size:14px"></i></button>'
    : '';
  var corps = edit
    ? '<textarea id="fil-edit-'+r.id+'" rows="2" style="width:100%;border:0.5px solid var(--border-s);border-radius:7px;padding:6px 8px;font-size:14px;resize:vertical;font-family:inherit">'+_esc(r.contenu)+'</textarea><div style="display:flex;gap:6px;justify-content:flex-end;margin-top:4px"><button class="btn sm" onclick="_DISC_EDIT=null;chargerFil()">'+TR("Annuler")+'</button><button class="btn sm primary" onclick="sauverEditFil('+r.id+')">'+TR("Enregistrer")+'</button></div>'
    : '<div style="font-size:14px;white-space:pre-wrap;line-height:1.45;color:var(--text)">'+_esc(r.contenu)+'</div>';
  var ini = (r.user_nom||'?').trim().charAt(0).toUpperCase();
  return '<div style="display:flex;gap:7px;padding:6px 0 6px 10px;border-left:2px solid var(--border-s);margin-left:22px;margin-top:6px">' +
    '<span style="width:20px;height:20px;border-radius:50%;background:var(--text3);color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0">'+_esc(ini)+'</span>' +
    '<div style="flex:1">' +
      '<div style="display:flex;align-items:center;gap:6px"><span style="font-weight:600;font-size:14px">'+_esc(r.user_nom||'Utilisateur')+'</span><span style="font-size:12px;color:var(--text3)">'+_fd(r.created_at)+(r.updated_at && r.updated_at!==r.created_at?' · modifié':'')+'</span><span style="margin-left:auto;display:flex;gap:2px">'+actions+'</span></div>' +
      corps +
    '</div>' +
  '</div>';
}

function repondreFil(id){
  var inp = document.getElementById('reply-'+id); if(!inp) return;
  var contenu = inp.value.trim(); if(!contenu) return;
  fetch('/api/discussions/fil',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contenu:contenu, parent_id:id})})
    .then(function(r){return r.json();}).then(function(d){ if(d&&d.ok){ chargerFil(); } else toast((d&&d.error)||'Erreur','ti-alert-circle','var(--danger)'); })
    .catch(function(e){ toast(TR('Erreur : ')+e.message,'ti-alert-circle','var(--danger)'); });
}
window.filReply = filReply; window.repondreFil = repondreFil;

function publierFil(){
  var ta = document.getElementById('fil-nouveau'); if(!ta) return;
  var contenu = ta.value.trim(); if(!contenu){ toast(TR('Message vide'),'ti-alert-circle','var(--warning)'); return; }
  fetch('/api/discussions/fil',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contenu:contenu})})
    .then(function(r){return r.json();}).then(function(d){ if(d&&d.ok){ chargerFil(); } else toast((d&&d.error)||'Erreur','ti-alert-circle','var(--danger)'); })
    .catch(function(e){ toast(TR('Erreur : ')+e.message,'ti-alert-circle','var(--danger)'); });
}
window.publierFil = publierFil;

function reactFil(id, emoji){
  fetch('/api/discussions/fil/'+id+'/reaction',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({emoji:emoji})})
    .then(function(r){return r.json();}).then(function(){ chargerFil(); }).catch(function(){});
}
window.reactFil = reactFil;

function editFil(id){ _DISC_EDIT = id; chargerFil(); }
window.editFil = editFil;

function sauverEditFil(id){
  var ta = document.getElementById('fil-edit-'+id); if(!ta) return;
  var contenu = ta.value.trim(); if(!contenu){ toast(TR('Message vide'),'ti-alert-circle','var(--warning)'); return; }
  fetch('/api/discussions/fil/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({contenu:contenu})})
    .then(function(r){return r.json();}).then(function(d){ if(d&&d.ok){ _DISC_EDIT=null; chargerFil(); } else toast((d&&d.error)||'Non autorisé','ti-alert-circle','var(--danger)'); })
    .catch(function(e){ toast(TR('Erreur : ')+e.message,'ti-alert-circle','var(--danger)'); });
}
window.sauverEditFil = sauverEditFil;

function supprFil(id){
  if(!confirm(TR('Supprimer ce message ?'))) return;
  fetch('/api/discussions/fil/'+id,{method:'DELETE'})
    .then(function(r){return r.json();}).then(function(d){ if(d&&d.ok){ chargerFil(); } else toast((d&&d.error)||'Non autorisé','ti-alert-circle','var(--danger)'); })
    .catch(function(e){ toast(TR('Erreur : ')+e.message,'ti-alert-circle','var(--danger)'); });
}
window.supprFil = supprFil;

function archiveFil(id, val){
  fetch('/api/discussions/fil/'+id+'/archive',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({archived:val})})
    .then(function(r){return r.json();}).then(function(d){ if(d&&d.ok) chargerFil(); else toast((d&&d.error)||'Non autorisé','ti-alert-circle','var(--danger)'); })
    .catch(function(){});
}
window.archiveFil = archiveFil;

function pinFil(id, val){
  fetch('/api/discussions/fil/'+id+'/pin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pinned:val})})
    .then(function(r){return r.json();}).then(function(d){ if(d&&d.ok) chargerFil(); else toast((d&&d.error)||'Non autorisé','ti-alert-circle','var(--danger)'); })
    .catch(function(){});
}
window.pinFil = pinFil;

function chargerDiscussions() {
  var el = document.getElementById('disc-body');
  if (!el) return;
  fetch('/api/notes/recent?limit=80')
    .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(notes){
      var el = document.getElementById('disc-body');
      if (!el) return;
      if (!Array.isArray(notes) || !notes.length) {
        el.innerHTML = '<div class="empty"><i class="ti ti-messages"></i>'+TR("Aucune note pour le moment.")+'<br><span style="font-size:14px;color:var(--text3)">'+TR("Les notes ajoutées depuis l'onglet Notes d'une commande apparaîtront ici.")+'</span></div>';
        return;
      }
      // Regroupement par commande, en conservant l'ordre d'arrivée
      var groupes = [], index = {};
      notes.forEach(function(n){
        var cle = n.commande_id;
        if (index[cle] === undefined) { index[cle] = groupes.length; groupes.push({ cmd: n, notes: [] }); }
        groupes[index[cle]].notes.push(n);
      });

      el.innerHTML = groupes.map(function(g){
        var cmd = g.cmd;
        var titre = cmd.bdc ? 'BDC ' + _esc(cmd.bdc) : 'Commande #' + cmd.commande_id;
        return '<div class="card" style="margin-bottom:10px;padding:12px 14px">' +
          '<div onclick="_ouvrirCmd(' + cmd.commande_id + ')" style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:8px">' +
            '<i class="ti ti-package" style="font-size:16px;color:var(--accent)"></i>' +
            '<span style="font-weight:700;font-size:15px">' + titre + '</span>' +
            (cmd.distributeur_nom ? '<span style="font-size:14px;color:var(--text3)">— ' + _esc(cmd.distributeur_nom) + '</span>' : '') +
            (cmd.num_serie ? '<span class="mono" style="font-size:13px;color:var(--text3)">' + _esc(cmd.num_serie) + '</span>' : '') +
            '<span style="margin-left:auto;font-size:13px;color:var(--text3)">' + g.notes.length + ' note' + (g.notes.length > 1 ? 's' : '') + '</span>' +
            '<i class="ti ti-arrow-right" style="font-size:15px;color:var(--text3)"></i>' +
          '</div>' +
          g.notes.map(function(n){
            return '<div style="border-left:2px solid var(--border);padding:5px 0 5px 10px;margin-bottom:4px">' +
              '<div style="display:flex;align-items:baseline;gap:8px">' +
                '<span style="font-size:14px;font-weight:600">' + _esc(n.user_nom || 'Utilisateur') + '</span>' +
                '<span style="font-size:13px;color:var(--text3)">' + _fd(n.created_at) + '</span>' +
              '</div>' +
              '<div style="font-size:15px;white-space:pre-wrap;margin-top:2px">' + _esc(n.texte || '') + '</div>' +
            '</div>';
          }).join('') +
        '</div>';
      }).join('');
    })
    .catch(function(e){
      var el = document.getElementById('disc-body');
      if (el) el.innerHTML = '<div style="color:var(--danger);padding:20px 0;font-size:15px">Erreur de chargement : ' + _esc(e.message) + '</div>';
    });
}
window.chargerDiscussions = chargerDiscussions;


// Rapprochement automatique Catalogue <-> produits VosFactures
async function importerVFIds() {
  if (!confirm(TR('Lancer la correspondance automatique VosFactures ↔ Catalogue ?\nCela peut prendre une à deux minutes.'))) return;
  if (typeof toast === 'function') toast(TR('Correspondance en cours…'), 'ti-loader-2');
  try {
    const r = await API.post('/catalogue/import-vf-ids', {});
    if (r && r.ok) {
      toast(r.matched + ' article(s) lié(s) sur ' + r.catalogue + ' (' + r.vf_products + ' produits VF analysés)', 'ti-check', 'var(--success)');
      if (typeof render === 'function') render();
    } else {
      toast((r && r.reason) || 'Aucune correspondance trouvée', 'ti-alert-circle', 'var(--danger)');
    }
  } catch (e) {
    toast(e.message, 'ti-alert-circle', 'var(--danger)');
  }
}
window.importerVFIds = importerVFIds;


// ═══════════════════════════════════════════════════════════════════
// CLIENT FINAL (Expédition) — bascule Particulier / Entreprise
// ═══════════════════════════════════════════════════════════════════

// Affiche ou masque le bloc adresse et adapte ses libellés au type choisi
function toggleClientFinalForm(type) {
  var box = document.getElementById('cf-form');
  if (!box) return;
  var estParticulier = (type === 'particulier');
  box.style.display = type ? '' : 'none';

  var titre = document.getElementById('cf-titre');
  if (titre) titre.textContent = 'Adresse de livraison — ' + (estParticulier ? '🏠 Particulier' : '🏢 Entreprise / Structure');

  var lbl = document.getElementById('cf-nom-label');
  if (lbl) lbl.textContent = estParticulier ? 'Nom' : 'Raison sociale / Nom';

  var grpPrenom = document.getElementById('cf-prenom-group');
  if (grpPrenom) grpPrenom.style.display = estParticulier ? '' : 'none';

  // Passage en entreprise : le prénom n'a plus de sens
  if (!estParticulier) {
    var pr = document.getElementById('cf-prenom');
    if (pr) pr.value = '';
  }
  var sug = document.getElementById('cf-suggest');
  if (sug) sug.style.display = 'none';
}
window.toggleClientFinalForm = toggleClientFinalForm;

// Suggestions issues des destinataires déjà saisis
var _cfTimer = null;
var _cfResultats = [];

function cfAutocomplete(input, champ) {
  var q = (input.value || '').trim();
  var boite = document.getElementById('cf-suggest');
  if (!boite) return;
  if (q.length < 2) { boite.style.display = 'none'; return; }

  clearTimeout(_cfTimer);
  _cfTimer = setTimeout(function() {
    var type = (document.getElementById('cmd-clientfinal-type') || {}).value || '';
    fetch('/api/clients-finaux/suggest?q=' + encodeURIComponent(q) + '&type=' + encodeURIComponent(type))
      .then(function(r){ return r.json(); })
      .then(function(rows){
        if (!Array.isArray(rows) || !rows.length) { boite.style.display = 'none'; return; }
        _cfResultats = rows;
        boite.innerHTML = rows.map(function(c, i){
          var ligne2 = [c.cp, c.ville].filter(Boolean).join(' ');
          return '<div onclick="cfSelect(' + i + ')" style="padding:7px 10px;cursor:pointer;border-bottom:0.5px solid rgba(0,0,0,.06)"' +
            ' onmouseover="this.style.background=\'rgba(46,124,246,.08)\'" onmouseout="this.style.background=\'\'">' +
            '<div style="font-size:14px;font-weight:600">' + _esc([c.nom, c.prenom].filter(Boolean).join(' ')) + '</div>' +
            '<div style="font-size:13px;color:var(--text3)">' + _esc(ligne2 || c.email || '') +
              (c.nb_commandes > 1 ? ' · ' + c.nb_commandes + ' commandes' : '') + '</div>' +
            '</div>';
        }).join('');
        boite.style.display = '';
      })
      .catch(function(){ boite.style.display = 'none'; });
  }, 250);
}
window.cfAutocomplete = cfAutocomplete;

// Remplit le formulaire depuis une suggestion
function cfSelect(index) {
  var c = _cfResultats[index];
  if (!c) return;
  var mettre = function(id, val){ var el = document.getElementById(id); if (el) el.value = val || ''; };
  mettre('cf-nom', c.nom);
  mettre('cf-prenom', c.prenom);
  mettre('cf-adresse', c.adresse);
  mettre('cf-cp', c.cp);
  mettre('cf-ville', c.ville);
  mettre('cf-tel', c.tel);
  mettre('cf-email', c.email);

  // Aligner le type sur celui du destinataire retenu
  var sel = document.getElementById('cmd-clientfinal-type');
  if (sel && c.type && sel.value !== c.type) {
    sel.value = c.type;
    toggleClientFinalForm(c.type);
  }
  var boite = document.getElementById('cf-suggest');
  if (boite) boite.style.display = 'none';
}
window.cfSelect = cfSelect;

// Fermer les suggestions en cliquant ailleurs
document.addEventListener('click', function(e) {
  var boite = document.getElementById('cf-suggest');
  if (!boite || boite.style.display === 'none') return;
  if (e.target.id === 'cf-nom' || boite.contains(e.target)) return;
  boite.style.display = 'none';
});


function copierAdresse(el, txt) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(txt).then(function(){
      var av = el.innerHTML;
      el.innerHTML = '<i class="ti ti-check" style="font-size:13px"></i> Copié';
      setTimeout(function(){ el.innerHTML = av; }, 1500);
    }).catch(function(){});
  }
}
window.copierAdresse = copierAdresse;


// Helpers globaux (hors IIFE)
function _esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
function _fd(d){ if(!d) return '-'; try{ return new Date(d).toLocaleDateString('fr-FR'); }catch(e){ return String(d).slice(0,10); } }
window._esc = _esc; window._fd = _fd;


// ═══════════════════════════════════════════════════════════════════
// CARTE DISTRIBUTEURS (Leaflet + KML importés)
// ═══════════════════════════════════════════════════════════════════
var _carteMap = null;
var _carteAnnee = new Date().getFullYear();
var _carteReseaux = { base:true, bastide:true, providom:true, districlub:true, negocies:true, capvital:true, lecarre:true };
var _carteHorsCarte = false;   // affiche aussi les distributeurs hors carte (décoché par défaut)
var _carteHorsPoints = [];     // points "hors carte" chargés à la demande
var _carteHorsMarkers = [];
// Filtre par année de dernière commande : par défaut, TOUTES les années affichées
// (pour localiser tous les distributeurs). _carteToutesAnnees=true ignore le filtre.
var _carteAnneesFiltre = {};
var _carteToutesAnnees = true;
var _carteSansAnnee = false; // affiche les points sans année de dernière commande (null ou < 2019)
// Filtre par priorité (T1/T2/T3) : toutes cochées par défaut + "sans priorité"
var _cartePriorites = { T1:true, T2:true, T3:true };
var _cartePrioriteSans = true; // affiche les points sans priorité assignée
(function(){ _carteAnneesFiltre[new Date().getFullYear()] = true; })();
var _carteMarkers = [];
var _carteClusterGroup = null; // groupe de clustering (leaflet.markercluster) si dispo
var _carteDeptFiltre = '';     // (obsolète) ancien filtre "département couvert"
var _carteDeptGeo = '';        // filtre par département via la recherche "Ville / CP / département" (ex "83", "2A")
var _cartePoints = [];
// Point actuellement ciblé (via « Voir sur la carte ») : les recadrages auto
// (après chargement / resize) doivent le respecter au lieu de revenir sur la France.
var _carteCible = null; // { clientId, nom, lat, lng } ou null

// Limites de la France métropolitaine (Corse incluse)
var FRANCE_BOUNDS = [[41.30, -5.20], [51.15, 9.60]];

// Pays proposés sur la carte (mêmes clés que le champ Pays des commandes)
var PAYS_CARTE = [
  ['France','🇫🇷 France'], ['Belgium','🇧🇪 Belgique'], ['Switzerland','🇨🇭 Suisse'],
  ['Luxembourg','🇱🇺 Luxembourg'], ['Spain','🇪🇸 Espagne'], ['Italy','🇮🇹 Italie'],
  ['Portugal','🇵🇹 Portugal'], ['Germany','🇩🇪 Allemagne'], ['Netherlands','🇳🇱 Pays-Bas'],
  ['Austria','🇦🇹 Autriche'], ['UK','🇬🇧 Royaume-Uni'], ['Ireland','🇮🇪 Irlande'],
  ['Sweden','🇸🇪 Suède'], ['Norway','🇳🇴 Norvège'], ['Denmark','🇩🇰 Danemark'], ['Finland','🇫🇮 Finlande']
];
function optionsPays(selection) {
  return PAYS_CARTE.map(function(p){
    return '<option value="' + p[0] + '"' + ((selection||'France') === p[0] ? ' selected' : '') + '>' + p[1] + '</option>';
  }).join('');
}
function libellePays(code) {
  for (var i = 0; i < PAYS_CARTE.length; i++) if (PAYS_CARTE[i][0] === code) return PAYS_CARTE[i][1];
  return code || '';
}
window.optionsPays = optionsPays; window.libellePays = libellePays;
var _carteResizeBound = false;

// Cadre la carte sur la France, au zoom maximal permis par la fenêtre.
// Les points situés hors de France restent sur la carte : on les atteint
// en dézoomant, ou via la recherche par nom / par ville qui zoome dessus.
function cadrerFrance() {
  if (!_carteMap) return;
  _carteCible = null; // recadrage France explicite → on abandonne toute cible
  _carteMap.invalidateSize();
  _carteMap.fitBounds(FRANCE_BOUNDS, { padding: [0, 0], animate: false });
}
window.cadrerFrance = cadrerFrance;

// Recadrage AUTOMATIQUE (après chargement des points ou redimensionnement).
// Si un distributeur est ciblé (via « Voir sur la carte »), on reste centré dessus
// au lieu de repartir sur la France entière — sinon les recadrages différés de
// chargerPoints (+100/+400/+900 ms) annulaient le centrage sur le point.
function cadrerAuto() {
  if (!_carteMap) return;
  _carteMap.invalidateSize();
  if (_carteCible && _carteCible.lat != null && _carteCible.lng != null) {
    _carteMap.setView([parseFloat(_carteCible.lat), parseFloat(_carteCible.lng)], 13, { animate: false });
    return;
  }
  _carteMap.fitBounds(FRANCE_BOUNDS, { padding: [0, 0], animate: false });
}
window.cadrerAuto = cadrerAuto;

var RESEAUX_CONFIG = {
  base:       { label: 'De base',            color: '#e24b4a', letter: 'B', img: '/img/reseaux/base.png' },
  bastide:    { label: 'Bastide',            color: '#378add', letter: 'A', img: '/img/reseaux/bastide.png' },
  providom:   { label: 'Providom',           color: '#ef9f27', letter: 'P', img: '/img/reseaux/providom.png' },
  districlub: { label: 'DistriClub Medical', color: '#7f77dd', letter: 'D', img: '/img/reseaux/districlub.png' },
  negocies:   { label: 'Négociés',           color: '#16a34a', letter: 'N', img: '/img/reseaux/negocies.png' },
  capvital:   { label: 'CAP Vital',          color: '#0891b2', letter: 'V', img: '/img/reseaux/capvital.png' },
  lecarre:    { label: 'Le Carré Medical',   color: '#db2777', letter: 'C', img: '/img/reseaux/lecarre.png' }
};

// Génère le panneau de filtre par année de dernière commande (2019 → année en cours)
// Traduit le libellé d'un réseau : seuls 'base' et 'negocies' ont un sens traduisible ;
// les autres (Bastide, Providom, DistriClub) sont des noms propres → inchangés.
function labelReseauTraduit(cle, labelParDefaut){
  if (cle === 'base') return t('carte_reseau_base') || labelParDefaut;
  if (cle === 'negocies') return t('carte_reseau_negocies') || labelParDefaut;
  return labelParDefaut;
}
window.labelReseauTraduit = labelReseauTraduit;

function legendeAnnees(){
  var actuelle = new Date().getFullYear();
  var html = '<details class="card carte-collapse" style="padding:0;margin-bottom:10px">' +
    '<summary class="section-title carte-collapse-sum" style="padding:13px;margin:0"><i class="ti ti-calendar"></i>'+TR("Année")+'</summary>' +
    '<div style="padding:0 13px 13px">' +
    '<label style="display:flex;align-items:center;gap:8px;padding:4px 4px;cursor:pointer;font-size:14px;font-weight:600;color:var(--text)">' +
      '<input type="checkbox" ' + (_carteToutesAnnees?'checked':'') + ' onchange="basculerToutesAnnees(this.checked)"> ' + (t('carte_toutes_annees')||'Toutes les années') +
    '</label>' +
    '<div id="carte-annees-liste" style="' + (_carteToutesAnnees?'opacity:.4;pointer-events:none':'') + '">';
  for (var y = actuelle; y >= 2019; y--) {
    html += '<label style="display:flex;align-items:center;gap:8px;padding:3px 4px 3px 14px;cursor:pointer;font-size:14px">' +
      '<input type="checkbox" ' + (_carteAnneesFiltre[y]?'checked':'') + ' onchange="basculerAnnee(' + y + ',this.checked)"> ' + y +
      '<span id="cnt-annee-' + y + '" style="margin-left:auto;font-size:13px;color:var(--text3)">0</span>' +
      '</label>';
  }
  html += '<label style="display:flex;align-items:center;gap:8px;padding:3px 4px 3px 14px;cursor:pointer;font-size:14px;color:var(--text2)">' +
    '<input type="checkbox" ' + (_carteSansAnnee?'checked':'') + ' onchange="basculerSansAnnee(this.checked)"> ' + (t('carte_sans_commande')||'Sans commande / avant 2019') +
    '<span id="cnt-annee-sans" style="margin-left:auto;font-size:13px;color:var(--text3)">0</span>' +
    '</label>';
  html += '</div></div></details>';
  return html;
}
function basculerSansAnnee(actif){
  _carteSansAnnee = !!actif;
  afficherMarkers();
}
window.basculerSansAnnee = basculerSansAnnee;
function basculerToutesAnnees(actif){
  _carteToutesAnnees = !!actif;
  var liste = document.getElementById('carte-annees-liste');
  if (liste) { liste.style.opacity = actif?'.4':''; liste.style.pointerEvents = actif?'none':''; }
  afficherMarkers();
}
window.basculerToutesAnnees = basculerToutesAnnees;
function basculerAnnee(annee, actif){
  if (actif) _carteAnneesFiltre[annee] = true;
  else delete _carteAnneesFiltre[annee];
  afficherMarkers();
}
window.basculerAnnee = basculerAnnee;

// Panneau de filtre par priorité (T1/T2/T3 + sans priorité)
function legendePriorites(){
  var libelles = { T1:'T1 — Priorité absolue', T2:'T2 — Priorité moyenne', T3:'T3 — Priorité basse' };
  var couleurs = { T1:'#dc2626', T2:'#d97706', T3:'#65a30d' };
  var html = '<details class="card carte-collapse" style="padding:0;margin-bottom:10px">' +
    '<summary class="section-title carte-collapse-sum" style="padding:13px;margin:0"><i class="ti ti-flag"></i>' + (t('carte_priorite')||'Priorité') + '</summary>' +
    '<div style="padding:0 13px 13px">';
  ['T1','T2','T3'].forEach(function(p){
    html += '<label style="display:flex;align-items:center;gap:8px;padding:3px 4px;cursor:pointer;font-size:14px">' +
      '<input type="checkbox" ' + (_cartePriorites[p]?'checked':'') + ' onchange="basculerPriorite(\'' + p + '\',this.checked)">' +
      '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + couleurs[p] + '"></span>' +
      libelles[p] +
      '<span id="cnt-prio-' + p + '" style="margin-left:auto;font-size:13px;color:var(--text3)">0</span>' +
      '</label>';
  });
  html += '<label style="display:flex;align-items:center;gap:8px;padding:3px 4px;cursor:pointer;font-size:14px;color:var(--text2)">' +
    '<input type="checkbox" ' + (_cartePrioriteSans?'checked':'') + ' onchange="basculerPrioriteSans(this.checked)"> ' + (t('carte_priorite_sans')||'Sans priorité') +
    '<span id="cnt-prio-sans" style="margin-left:auto;font-size:13px;color:var(--text3)">0</span>' +
    '</label>';
  html += '</div></details>';
  return html;
}
function basculerPriorite(p, actif){
  if (actif) _cartePriorites[p] = true; else _cartePriorites[p] = false;
  afficherMarkers();
}
window.basculerPriorite = basculerPriorite;
function basculerPrioriteSans(actif){
  _cartePrioriteSans = !!actif;
  afficherMarkers();
}
window.basculerPrioriteSans = basculerPrioriteSans;

function renderCarte(ttl, c, a) {
  ttl.textContent = t('nav_carte') || 'Carte';
  // Ouverture normale de la carte : aucune cible (voirDistributeurSurCarte la
  // réarmera juste après si on arrive depuis une fiche distributeur).
  _carteCible = null;

  a.innerHTML = '<div style="display:flex;gap:8px;align-items:center">' +
    '<select id="carte-annee" onchange="_carteAnnee=parseInt(this.value);chargerPoints()" style="border:0.5px solid var(--border);border-radius:6px;padding:4px 8px;font-size:15px;background:var(--surface)">' +
    [new Date().getFullYear(), new Date().getFullYear()-1, new Date().getFullYear()-2].map(function(y){
      return '<option value="'+y+'"'+(y===_carteAnnee?' selected':'')+'>'+y+'</option>';
    }).join('') + '</select>' +
    '<button onclick="cadrerFrance()" title="Recentrer sur la France" style="background:var(--surface);border:0.5px solid var(--border);border-radius:6px;padding:4px 10px;font-size:14px;cursor:pointer"><i class="ti ti-focus-centered"></i> Recentrer</button>' +
    (typeof canWriteCarte==='function' && canWriteCarte() ? '<button onclick="modalPointCarte()" style="background:#2e7cf6;color:#fff;border:none;border-radius:6px;padding:4px 10px;font-size:14px;cursor:pointer"><i class="ti ti-plus"></i> '+TR("Ajouter")+'</button>' : '') +
    (typeof canWriteCarte==='function' && canWriteCarte() ? '<button onclick="ouvrirRattachements()" title="Relier les points aux fiches clients" style="background:var(--surface);border:0.5px solid var(--border);border-radius:6px;padding:4px 10px;font-size:14px;cursor:pointer"><i class="ti ti-link"></i> '+TR("Rattacher")+'</button>' : '') +
    (typeof canWriteCarte==='function' && canWriteCarte() ? '<button onclick="lancerGeocodageCarte()" title="'+TR("Positionner les distributeurs dont l'adresse a été complétée")+'" style="background:var(--surface);border:0.5px solid var(--border);border-radius:6px;padding:4px 10px;font-size:14px;cursor:pointer"><i class="ti ti-map-pin-search"></i> '+TR("Géocoder")+'</button>' : '') +
    (typeof canWriteCarte==='function' && canWriteCarte() ? '<button onclick="controleVillesCarte()" title="'+TR("Repérer les villes ne correspondant pas au code postal")+'" style="background:var(--surface);border:0.5px solid var(--border);border-radius:6px;padding:4px 10px;font-size:14px;cursor:pointer"><i class="ti ti-map-check"></i> '+TR("Contrôle villes")+'</button>' : '') +
    (typeof canWriteCarte==='function' && canWriteCarte() ? '<label style="background:var(--surface);border:0.5px solid var(--border);border-radius:6px;padding:4px 10px;font-size:14px;cursor:pointer"><input type="file" accept=".kml" multiple style="display:none" onchange="importerKML(this.files)"><i class="ti ti-upload"></i> Importer KML</label>' : '') +
    '</div>';

  var legende = Object.keys(RESEAUX_CONFIG).map(function(k){
    var r = RESEAUX_CONFIG[k];
    return '<label style="display:flex;align-items:center;gap:8px;padding:5px 4px;cursor:pointer;border-radius:6px">' +
      '<input type="checkbox" ' + (_carteReseaux[k]?'checked':'') + ' onchange="_carteReseaux[\'' + k + '\']=this.checked;afficherMarkers()">' +
      (r.img
        ? '<img src="' + r.img + '" width="22" height="22" style="display:block;flex-shrink:0" alt="">'
        : '<span style="width:14px;height:14px;border-radius:50%;background:' + r.color + ';border:2px solid #fff;box-shadow:0 0 0 1px #0002"></span>') +
      '<span style="flex:1;font-size:15px;color:var(--text)">' + labelReseauTraduit(k, r.label) + '</span>' +
      '<span id="cnt-' + k + '" style="font-size:14px;color:var(--text3)">0</span>' +
      '</label>';
  }).join('');

  // Panneau "Recherche" (placé en premier, tout en haut de la sidebar)
  var rechercheCard = '<div class="card" style="padding:13px;margin-bottom:10px">' +
        '<div class="section-title"><i class="ti ti-search"></i>' + (t('carte_recherche')||'Recherche') + '</div>' +
        '<div style="position:relative;margin-bottom:4px">' +
          '<input id="carte-search" class="form-input" placeholder="' + (t('carte_nom_distrib')||'Nom de distributeur…') + '" oninput="rechercheNom()" onkeydown="if(event.key===\'Enter\'){clearTimeout(_tmrRechercheNom);afficherMarkers(true);}" style="width:100%;padding:6px 26px 6px 9px;font-size:15px">' +
          '<span onclick="document.getElementById(\'carte-search\').value=\'\';afficherMarkers(true)" title="Effacer" style="position:absolute;right:7px;top:50%;transform:translateY(-50%);cursor:pointer;color:var(--text3);font-size:15px">✕</span>' +
        '</div>' +
        '<div id="carte-nom-result" style="font-size:13px;color:var(--text3);margin-bottom:8px;min-height:14px"></div>' +
        '<div style="display:flex;gap:6px">' +
          '<input id="carte-geo" class="form-input" placeholder="'+TR("Ville, code postal ou n° de département (ex : 83)")+'" onkeydown="if(event.key===\'Enter\')rechercheGeo()" style="flex:1;padding:6px 9px;font-size:15px">' +
          '<button onclick="rechercheGeo()" style="background:var(--accent);color:#fff;border:none;border-radius:6px;padding:6px 10px;font-size:14px;cursor:pointer"><i class="ti ti-search"></i></button>' +
        '</div>' +
        '<div style="margin-top:8px"><label style="display:flex;align-items:center;gap:6px;font-size:14px;color:var(--text2);cursor:pointer"><input type="checkbox" id="carte-rayon-actif" onchange="rechercheGeo()"> ' + (t('carte_afficher_rayon')||'Afficher rayon') + ' <select id="carte-rayon" onchange="if(document.getElementById(\'carte-rayon-actif\').checked)rechercheGeo()" style="border:0.5px solid var(--border);border-radius:4px;padding:1px 4px;font-size:14px;background:var(--surface);color:var(--text)"><option value="25">25 km</option><option value="50" selected>50 km</option><option value="100">100 km</option><option value="150">150 km</option></select></label></div>' +
        '<div id="carte-geo-result" style="margin-top:10px;font-size:14px;color:var(--text2)"></div>' +
        '<div style="margin-top:10px;font-size:13px;color:var(--text3);line-height:1.5">' + (t('carte_aide')||'Recherchez une ville pour voir les distributeurs alentour. Cliquez un point pour le détail.') + '</div>' +
      '</div>';

  // Conteneur en position absolue pour garantir une hauteur
  c.innerHTML = '<style>.carte-collapse>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:6px;user-select:none}.carte-collapse>summary::-webkit-details-marker{display:none}.carte-collapse>summary::after{content:"+";margin-left:auto;font-size:19px;line-height:1;color:var(--text3);font-weight:400}.carte-collapse[open]>summary::after{content:"\\2212"}</style>' +
    '<div id="carte-wrap" style="display:flex;height:75vh;min-height:500px;margin:-18px -20px;background:var(--bg)">' +
    '<div style="width:256px;border-right:0.5px solid var(--border);padding:12px;overflow:auto;flex-shrink:0">' +
      rechercheCard +
      '<details class="card carte-collapse" style="padding:0;margin-bottom:10px">' +
        '<summary class="section-title carte-collapse-sum" style="padding:13px;margin:0"><i class="ti ti-affiliate"></i>' + (t('carte_reseaux')||'Réseaux') + '</summary>' +
        '<div style="padding:0 13px 13px">' +
        legende +
        '<label style="display:flex;align-items:center;gap:8px;padding:7px 4px 0;margin-top:5px;border-top:0.5px solid var(--border);cursor:pointer;font-size:14px;color:var(--text2)">' +
          '<input type="checkbox" ' + (_carteHorsCarte?'checked':'') + ' onchange="basculerHorsCarte(this.checked)">' +
          '<img src="/img/reseaux/inconnu.png" width="18" height="18" style="display:block">' +
          '<span style="flex:1">Autres distributeurs (hors carte)</span>' +
        '</label>' +
        '</div>' +
      '</details>' +
      legendeAnnees() +
      legendePriorites() +
    '</div>' +
    '<div id="carte-leaflet" style="flex:1;height:100%;background:#dce4ec"></div>' +
    '</div>';

  setTimeout(chargerPoints, 150);
}
window.renderCarte = renderCarte;

// Ouvre la carte de l'interface centrée sur un distributeur donné (par client_id).
// Affiche un message si ce distributeur n'a pas encore de point sur la carte.
function voirDistributeurSurCarte(clientId, nom){
  // Afficher toutes les années pour être sûr que le point ciblé n'est pas masqué par le filtre
  _carteToutesAnnees = true;
  setView('carte');
  var essais = 0;
  var minuteur = setInterval(function(){
    essais++;
    // Attendre que la carte et les points soient chargés (chargerPoints est async)
    if (!_carteMap || !Array.isArray(_cartePoints)) {
      if (essais > 40) clearInterval(minuteur); // ~6s max
      return;
    }
    if (_cartePoints.length === 0 && essais < 15) return; // laisser le temps au fetch
    clearInterval(minuteur);
    var pt = _cartePoints.find(function(p){ return p.client_id === clientId; });
    var info = document.getElementById('carte-nom-result');
    if (pt && pt.lat != null && pt.lng != null) {
      // S'assurer que le réseau du point est bien affiché (sinon on ne verrait pas le marker)
      if (_carteReseaux && pt.reseau && _carteReseaux[pt.reseau] === false) {
        _carteReseaux[pt.reseau] = true;
        var cb = document.querySelector('input[onchange*="' + pt.reseau + '"]');
        if (cb) cb.checked = true;
        afficherMarkers();
      }
      // S'assurer que la PRIORITÉ du point n'est pas masquée par le filtre priorité
      // (sinon le marker n'est pas créé → pas de popup). Ajouté avec le filtre priorité du 28/07.
      var prio = pt.priorite;
      if (prio === 'T1' || prio === 'T2' || prio === 'T3') {
        if (_cartePriorites[prio] === false) {
          _cartePriorites[prio] = true;
          var cbp = document.querySelector('input[onchange*="basculerPriorite(\'' + prio + '\'"]');
          if (cbp) cbp.checked = true;
          afficherMarkers();
        }
      } else if (_cartePrioriteSans === false) {
        _cartePrioriteSans = true;
        var cbs = document.querySelector('input[onchange*="basculerPrioriteSans"]');
        if (cbs) cbs.checked = true;
        afficherMarkers();
      }
      // Armer la cible : les recadrages auto différés (chargerPoints) resteront centrés
      // sur ce distributeur au lieu de repartir sur la France entière.
      _carteCible = { clientId: clientId, nom: nom, lat: pt.lat, lng: pt.lng };
      _carteMap.setView([parseFloat(pt.lat), parseFloat(pt.lng)], 13, { animate: true });
      // Ouvrir la popup du marker correspondant
      var m = _carteMarkers.find(function(mk){
        var ll = mk.getLatLng();
        return Math.abs(ll.lat - parseFloat(pt.lat)) < 1e-6 && Math.abs(ll.lng - parseFloat(pt.lng)) < 1e-6;
      });
      if (m) ouvrirPopupMarkerCarte(m);
      if (info) info.innerHTML = '<span style="color:#16a34a">' + esc(nom || pt.nom) + ' — centré sur la carte</span>';
    } else {
      // Pas de point pour ce distributeur : proposer de l'ajouter directement
      if (info) {
        info.innerHTML = '<div style="color:#b45309;margin-bottom:6px">' + esc(nom || 'Ce distributeur') + ' n\'a pas encore de point sur la carte.</div>' +
          '<button onclick="ajouterDistributeurCarte(' + clientId + ',\'' + String(nom||'').replace(/'/g,'&#39;') + '\')" style="background:#2e7cf6;color:#fff;border:none;border-radius:6px;padding:6px 12px;font-size:14px;cursor:pointer"><i class="ti ti-map-pin-plus"></i> '+TR("Ajouter à la carte maintenant")+'</button>';
      }
    }
  }, 150);
}
window.voirDistributeurSurCarte = voirDistributeurSurCarte;

// Ajoute un distributeur à la carte (coche sur_carte + géocode), sans quitter la carte.
async function ajouterDistributeurCarte(clientId, nom){
  var info = document.getElementById('carte-nom-result');
  if (info) info.innerHTML = '<span style="color:#666">Positionnement de ' + esc(nom || '') + ' en cours…</span>';
  try {
    // Récupérer la fiche complète pour ne pas écraser ses autres champs au PUT
    var cl = await API.client(clientId);
    if (!cl.ville && !cl.cp) {
      if (info) info.innerHTML = '<span style="color:#b45309">'+TR("Impossible : ce distributeur n'a ni ville ni code postal. Complétez son adresse dans sa fiche.")+'</span>';
      return;
    }
    var data = {
      nom: cl.nom, type: cl.type, contact: cl.contact, email: cl.email, tel: cl.tel, portable: cl.portable,
      adresse: cl.adresse, adresse2: cl.adresse2, cp: cl.cp, ville: cl.ville, pays: cl.pays,
      edi: !!cl.edi, entite_facturation_id: cl.entite_facturation_id || null,
      public_site: !!cl.public_site, priorite: cl.priorite || null,
      sur_carte: true, reseau_carte: cl.reseau_carte || 'base'
    };
    var r = await API.updateClient(clientId, data);
    if (r && r.carte && r.carte.ok === false) {
      if (info) info.innerHTML = '<span style="color:#b45309">Non positionné : ' + esc(r.carte.reason || 'adresse introuvable') + '. Vous pouvez le placer manuellement via « Ajouter » sur la carte.</span>';
      return;
    }
    toast(TR('Ajouté à la carte'), 'ti-map-pin', 'var(--success)');
    // Recharger les points puis centrer sur le nouveau
    _cartePoints = [];
    chargerPoints();
    voirDistributeurSurCarte(clientId, nom);
  } catch(e) {
    if (info) info.innerHTML = '<span style="color:#dc2626">Erreur : ' + esc(e.message) + '</span>';
  }
}
window.ajouterDistributeurCarte = ajouterDistributeurCarte;

// Rafraîchit les points/marqueurs SANS reconstruire la carte ni recadrer (conserve la vue
// actuelle). Utilisé après une modification/suppression pour ne pas revenir sur la France.
function rafraichirPointsCarte() {
  if (!_carteMap) { chargerPoints(); return; }
  fetch('/api/carte/points?annee=' + _carteAnnee)
    .then(function(r){ return r.json(); })
    .then(function(data){
      if (!Array.isArray(data)) return;
      _cartePoints = data;
      majCompteursCarte();
      afficherMarkers(); // redessine les marqueurs sur la carte existante, sans recadrer
    })
    .catch(function(){});
}
window.rafraichirPointsCarte = rafraichirPointsCarte;

function chargerPoints() {
  if (typeof L === 'undefined') {
    var cc = document.getElementById('carte-leaflet');
    if (cc) cc.innerHTML = '<div style="padding:40px;text-align:center;color:#dc2626">'+TR("Leaflet non chargé.")+'</div>';
    return;
  }
  // Garantir une hauteur explicite sur le conteneur leaflet
  var leafEl = document.getElementById('carte-leaflet');
  if (leafEl) {
    var rect = leafEl.getBoundingClientRect();
    var h = window.innerHeight - rect.top;
    if (h < 300) h = 500;
    leafEl.style.height = h + 'px';
    console.log('[CARTE] hauteur conteneur:', h, 'top:', rect.top);
  }
  fetch('/api/carte/points?annee=' + _carteAnnee)
    .then(function(r){ return r.json(); })
    .then(function(data){
      if (!Array.isArray(data)) { console.error('Carte: réponse invalide', data); return; }
      _cartePoints = data;
      console.log('[CARTE]', data.length, 'points chargés');

      majCompteursCarte();

      // Init carte
      var container = document.getElementById('carte-leaflet');
      if (!container) return;
      if (_carteMap) { _carteMap.remove(); _carteMap = null; }
      // Les calques de la carte précédente n'existent plus
      _carteRayonCircle = null; _carteGeoMarker = null; _carteMarkers = []; _carteClusterGroup = null;
      _carteMap = L.map('carte-leaflet', { preferCanvas: false });
      _carteMap.fitBounds(FRANCE_BOUNDS, { padding: [0, 0], animate: false });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap', maxZoom: 19
      }).addTo(_carteMap);
      // Regroupement des points en pastilles chiffrées (leaflet.markercluster) si disponible
      if (typeof L.markerClusterGroup === 'function') {
        _carteClusterGroup = L.markerClusterGroup({ chunkedLoading: true, maxClusterRadius: 48, showCoverageOnHover: false, spiderfyOnMaxZoom: true });
        _carteMap.addLayer(_carteClusterGroup);
      }
      afficherMarkers();
      // Si le filtre "hors carte" est actif, on redessine ses points (données fraîches) sur la
      // nouvelle carte — sinon la case reste cochée mais les points disparaissent au rechargement.
      _carteHorsMarkers = [];
      if (_carteHorsCarte) { _carteHorsPoints = []; basculerHorsCarte(true); }
      // Le conteneur n'a pas toujours sa taille finale à l'init : recadrer après stabilisation
      // (cadrerAuto respecte un distributeur ciblé au lieu de forcer la France)
      setTimeout(cadrerAuto, 100);
      setTimeout(cadrerAuto, 400);
      setTimeout(cadrerAuto, 900);

      // Recadrer automatiquement quand la fenêtre change de taille
      if (!_carteResizeBound) {
        _carteResizeBound = true;
        var tmr = null;
        window.addEventListener('resize', function(){
          if (!_carteMap || !document.getElementById('carte-leaflet')) return;
          clearTimeout(tmr);
          tmr = setTimeout(function(){
            var el = document.getElementById('carte-leaflet');
            if (el) {
              var h = window.innerHeight - el.getBoundingClientRect().top;
              el.style.height = (h < 300 ? 500 : h) + 'px';
            }
            cadrerAuto();
          }, 150);
        });
      }
    })
    .catch(function(e){
      var c = document.getElementById('carte-leaflet');
      if (c) c.innerHTML = '<div style="padding:40px;text-align:center;color:#888">'+TR("Aucun point pour le moment.")+'<br>' + (typeof canWriteCarte==='function'&&canWriteCarte() ? 'Importez vos fichiers KML via le bouton en haut.' : '') + '</div>';
    });
}
window.chargerPoints = chargerPoints;

function pinIconCarte(reseau, point) {
  var cfg = RESEAUX_CONFIG[reseau] || { color:'#888', letter:'?' };
  // Image spécifique par groupe (marqueur = l'image ronde, ancrée en son centre)
  if (cfg.img) {
    var noteI = point.note_interne ? '<div style="position:absolute;top:-1px;right:-1px;width:11px;height:11px;background:#16a34a;border:2px solid #fff;border-radius:50%"></div>' : '';
    var htmlI = '<div style="position:relative;width:34px;height:34px">' +
      '<img src="' + cfg.img + '" width="34" height="34" style="display:block;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))">' + noteI + '</div>';
    return L.divIcon({ html: htmlI, className: '', iconSize: [34,34], iconAnchor: [17,17], popupAnchor: [0,-18] });
  }
  // Anneau de statut selon commandes
  var ring = point.impayes > 0 ? '#ef4444' : point.en_cours > 0 ? '#f97316' : point.nb_commandes > 0 ? '#22c55e' : '#cbd5e1';
  var noted = point.note_interne ? '<div style="position:absolute;top:-2px;right:-2px;width:11px;height:11px;background:#16a34a;border:2px solid #fff;border-radius:50%"></div>' : '';
  var html = '<div style="position:relative">' +
    '<svg width="30" height="42" viewBox="0 0 30 42">' +
    '<circle cx="15" cy="15" r="14" fill="none" stroke="' + ring + '" stroke-width="3"/>' +
    '<path d="M15 3C9 3 4 8 4 14c0 8 11 24 11 24s11-16 11-24C26 8 21 3 15 3z" fill="' + cfg.color + '" stroke="#fff" stroke-width="1.5"/>' +
    '<circle cx="15" cy="14" r="7" fill="#fff"/>' +
    '<text x="15" y="17.5" text-anchor="middle" font-size="10" font-weight="700" fill="' + cfg.color + '">' + cfg.letter + '</text>' +
    '</svg>' + noted + '</div>';
  return L.divIcon({ html: html, className: '', iconSize: [30,42], iconAnchor: [15,42], popupAnchor: [0,-38] });
}

// Met à jour les compteurs (par réseau selon le filtre année actif, par année en absolu)
function majCompteursCarte(){
  var pts = _cartePoints || [];
  // Un point passe-t-il le filtre année courant ?
  var passeAnnee = function(p){
    if (_carteToutesAnnees) return true;
    var da = p.derniere_annee;
    var sansAnnee = !da || da < 2019;
    if (sansAnnee) return _carteSansAnnee;
    return !!_carteAnneesFiltre[da];
  };
  // Compteur par réseau : combien de points visibles selon le filtre année
  Object.keys(RESEAUX_CONFIG).forEach(function(k){
    var el = document.getElementById('cnt-' + k);
    if (!el) return;
    el.textContent = pts.filter(function(p){ return p.reseau === k && passeAnnee(p); }).length;
  });
  // Compteur par année : combien de points ont leur dernière commande cette année (absolu)
  var actuelle = new Date().getFullYear();
  for (var y = actuelle; y >= 2019; y--) {
    var el2 = document.getElementById('cnt-annee-' + y);
    if (el2) el2.textContent = pts.filter(function(p){ return p.derniere_annee === y; }).length;
  }
  // Compteur "sans commande / avant 2019"
  var elSans = document.getElementById('cnt-annee-sans');
  if (elSans) elSans.textContent = pts.filter(function(p){ return !p.derniere_annee || p.derniere_annee < 2019; }).length;
  // Compteurs par priorité (absolu)
  ['T1','T2','T3'].forEach(function(pr){
    var el = document.getElementById('cnt-prio-' + pr);
    if (el) el.textContent = pts.filter(function(p){ return p.priorite === pr; }).length;
  });
  var elPrioSans = document.getElementById('cnt-prio-sans');
  if (elPrioSans) elPrioSans.textContent = pts.filter(function(p){ return p.priorite !== 'T1' && p.priorite !== 'T2' && p.priorite !== 'T3'; }).length;
}
window.majCompteursCarte = majCompteursCarte;

// Ouvre le popup d'un marqueur, en dézoomant le cluster qui le contient si nécessaire
function ouvrirPopupMarkerCarte(m) {
  if (!m) return;
  if (_carteClusterGroup && typeof _carteClusterGroup.zoomToShowLayer === 'function') {
    _carteClusterGroup.zoomToShowLayer(m, function(){ m.openPopup(); });
  } else { m.openPopup(); }
}
window.ouvrirPopupMarkerCarte = ouvrirPopupMarkerCarte;

function afficherMarkers(recadrer) {
  if (!_carteMap) return;
  majCompteursCarte();
  var q = (document.getElementById('carte-search') || {}).value || '';
  q = q.trim().toLowerCase();

  // Retirer les anciens
  if (_carteClusterGroup) _carteClusterGroup.clearLayers();
  else _carteMarkers.forEach(function(m){ _carteMap.removeLayer(m); });
  _carteMarkers = [];

  var bounds = [];
  _cartePoints.forEach(function(p){
    if (!_carteReseaux[p.reseau]) return;
    // Filtre par année de dernière commande (sauf si "toutes les années")
    if (!_carteToutesAnnees) {
      var da = p.derniere_annee;
      // "Sans année" = aucune commande datée, ou dernière commande avant 2019
      var sansAnnee = !da || da < 2019;
      if (sansAnnee) {
        if (!_carteSansAnnee) return;
      } else if (!_carteAnneesFiltre[da]) {
        return;
      }
    }
    // Filtre par priorité (T1/T2/T3, ou sans priorité)
    var prio = p.priorite;
    if (prio === 'T1' || prio === 'T2' || prio === 'T3') {
      if (!_cartePriorites[prio]) return;
    } else {
      if (!_cartePrioriteSans) return;
    }
    if (q && (p.nom + ' ' + (p.ville||'') + ' ' + (p.description||'')).toLowerCase().indexOf(q) < 0) return;
    // Filtre par département (recherche "Ville / CP / département") : basé sur le CP du point
    if (_carteDeptGeo && !pointDansDepartement(p, _carteDeptGeo)) return;
    var marker = L.marker([parseFloat(p.lat), parseFloat(p.lng)], { icon: pinIconCarte(p.reseau, p) });
    marker.bindPopup(function(){ return popupCarte(p); }, { maxWidth: 280 });
    marker.on('popupopen', function(e){ wirePopupCarte(e, p); });
    marker.on('popupclose', function(){ effacerCouverture(); });
    if (_carteClusterGroup) _carteClusterGroup.addLayer(marker); else marker.addTo(_carteMap);
    _carteMarkers.push(marker);
    bounds.push([parseFloat(p.lat), parseFloat(p.lng)]);
  });

  if (!recadrer) return;

  var info = document.getElementById('carte-nom-result');
  // Recherche par département (via "Ville / CP / département") : on cadre sur les points du département
  if (_carteDeptGeo) {
    var geoInfo = document.getElementById('carte-geo-result');
    if (bounds.length) {
      _carteMap.fitBounds(bounds, { padding: [50, 50], maxZoom: 11, animate: true });
      if (geoInfo) geoInfo.innerHTML = '<span style="color:#16a34a">' + bounds.length + ' distributeur' + (bounds.length>1?'s':'') + ' — département ' + esc(_carteDeptGeo) + '</span>';
    } else {
      cadrerFrance();
      if (geoInfo) geoInfo.innerHTML = '<span style="color:#dc2626">Aucun distributeur dans le département ' + esc(_carteDeptGeo) + '</span>';
    }
    return;
  }
  if (!q) {
    // Recherche vidée : on revient sur la France entière
    if (info) info.innerHTML = '';
    cadrerFrance();
  } else if (bounds.length === 1) {
    // Un seul résultat : on zoome dessus et on ouvre sa fiche
    _carteMap.setView(bounds[0], 13, { animate: true });
    if (_carteMarkers[0]) ouvrirPopupMarkerCarte(_carteMarkers[0]);
    if (info) info.innerHTML = '<span style="color:#16a34a">'+TR("1 distributeur trouvé")+'</span>';
  } else if (bounds.length > 1) {
    // Plusieurs résultats : on cadre sur l'ensemble
    _carteMap.fitBounds(bounds, { padding: [50, 50], maxZoom: 12, animate: true });
    if (info) info.innerHTML = bounds.length + ' distributeurs trouvés';
  } else {
    if (info) info.innerHTML = '<span style="color:#dc2626">'+TR("Aucun résultat")+'</span>';
  }
}
window.afficherMarkers = afficherMarkers;

// Recherche par nom, avec un léger délai pour ne pas recadrer à chaque frappe
var _tmrRechercheNom = null;
function rechercheNom() {
  clearTimeout(_tmrRechercheNom);
  _tmrRechercheNom = setTimeout(function(){ afficherMarkers(true); }, 300);
}
window.rechercheNom = rechercheNom;

// Sélecteur de priorité dans le popup carte (modifiable sans passer par la fiche client)
function prioSelectCarte(p) {
  var libs = { '':'— Aucune priorité —', T1:'T1 — Priorité absolue', T2:'T2 — Priorité moyenne', T3:'T3 — Priorité basse' };
  var opts = ['','T1','T2','T3'].map(function(v){
    return '<option value="' + v + '"' + ((p.priorite||'')===v?' selected':'') + '>' + libs[v] + '</option>';
  }).join('');
  return '<div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">' +
    '<span style="font-size:13px;color:#888;text-transform:uppercase;letter-spacing:.03em">'+TR("Priorité")+'</span>' +
    '<select onchange="sauverPrioriteCarte(' + p.id + ',this.value)" style="flex:1;border:0.5px solid #cfcfca;border-radius:6px;padding:4px 7px;font-size:14px;cursor:pointer">' + opts + '</select>' +
    '</div>';
}

function popupCarte(p) {
  var cfg = RESEAUX_CONFIG[p.reseau] || { label:'?', color:'#888' };
  var statutTxt = p.impayes > 0 ? '<span style="background:#fef2f2;color:#dc2626;padding:2px 7px;border-radius:99px;font-size:13px">⚠️ ' + p.impayes + ' impayé' + (p.impayes>1?'s':'') + '</span>'
    : p.en_cours > 0 ? '<span style="background:#fff7ed;color:#ea580c;padding:2px 7px;border-radius:99px;font-size:13px">' + p.en_cours + ' en cours</span>'
    : p.nb_commandes > 0 ? '<span style="background:#f0fdf4;color:#16a34a;padding:2px 7px;border-radius:99px;font-size:13px">'+TR("à jour")+'</span>'
    : '<span style="background:#f1f5f9;color:#64748b;padding:2px 7px;border-radius:99px;font-size:13px">'+TR("aucune commande")+'</span>';

  var prioCoul = {T1:'#dc2626',T2:'#d97706',T3:'#65a30d'}[p.priorite] || '#888';
  var prioLib  = {T1:'T1 — Priorité absolue',T2:'T2 — Priorité moyenne',T3:'T3 — Priorité basse'}[p.priorite] || '';
  var telTxt   = p.tel ? String(p.tel).trim() : '';
  var telHref  = telTxt.replace(/[^0-9+]/g, '');
  var mobTxt   = p.portable ? String(p.portable).trim() : '';
  var mobHref  = mobTxt.replace(/[^0-9+]/g, '');
  var emailTxt = p.email ? String(p.email).trim() : '';
  return '<div style="width:262px;font-size:15px">' +
    '<div style="font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:.03em;color:' + cfg.color + ';margin-bottom:6px">' + labelReseauTraduit(p.reseau, cfg.label) + '</div>' +
    '<div style="font-weight:700;font-size:17px;margin-bottom:6px;line-height:1.3">' + _esc(p.nom) + '</div>' +
    '<div style="font-size:15.5px;line-height:1.65;margin-bottom:10px;color:var(--text)">' +
      ((p.adresse && p.adresse.trim().toLowerCase() !== String(p.nom||'').trim().toLowerCase()) ? _esc(p.adresse) + '<br>' : '') +
      (p.cp || p.ville ? _esc((p.cp||'') + ' ' + (p.ville||'')) + '<br>' : '') +
      (p.pays && p.pays !== 'France' ? '<span style="font-weight:600">' + libellePays(p.pays) + '</span><br>' : '') +
      (telTxt ? '<a href="tel:' + telHref + '" style="color:var(--accent);text-decoration:none;font-size:16.5px;font-weight:600"><i class="ti ti-phone" style="font-size:15px"></i> ' + _esc(fmtTel(telTxt)) + '</a><br>' : '') +
      (mobTxt ? '<a href="tel:' + mobHref + '" style="color:var(--accent);text-decoration:none;font-size:16.5px;font-weight:600"><i class="ti ti-device-mobile" style="font-size:15px"></i> ' + _esc(fmtTel(mobTxt)) + '</a><br>' : '') +
      (emailTxt ? '<a href="mailto:' + _esc(emailTxt) + '" style="color:var(--accent);text-decoration:none;font-size:14px;font-weight:500;word-break:break-all"><i class="ti ti-mail" style="font-size:14px"></i> ' + _esc(emailTxt) + '</a>' : '') +
    '</div>' +
    (p.priorite ? '<div style="margin-bottom:9px"><span style="font-size:15px;font-weight:700;color:#fff;background:' + prioCoul + ';padding:3px 11px;border-radius:99px"><i class="ti ti-flag" style="font-size:14px"></i> ' + prioLib + '</span></div>' : '') +
    '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">' +
      '<span style="background:rgba(46,124,246,.1);color:#2e7cf6;padding:2px 7px;border-radius:99px;font-size:13px">' + p.nb_commandes + ' commande' + (p.nb_commandes>1?'s':'') + ' ' + _carteAnnee + '</span>' +
      statutTxt +
    '</div>' +
    ((p.abs_retour||0) > 3 ? '<div style="background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;border-radius:6px;padding:5px 8px;font-size:13.5px;font-weight:600;margin-bottom:8px"><i class="ti ti-alert-triangle" style="font-size:14px"></i> ' + p.abs_retour + ' ' + TR("demandes sans retour (distributeur peu réactif)") + '</div>' : '') +
    '<div style="font-size:13px;color:#999;margin-bottom:10px">' +
      (p.lien_type === 'client'
        ? '<span style="color:#16a34a">'+TR("🔗 Lié au client")+'</span>'
        : p.lien_type === 'nom'
          ? 'Rapproché par nom : ' + _esc((p.noms_rattaches||[]).join(', '))
          : '<span style="color:#d97706">'+TR("⚠ Aucune commande rattachée — liez ce point à un client pour fiabiliser")+'</span>') +
    '</div>' +
    (p.zone_chalandise ? '<div style="background:rgba(46,124,246,.10);color:#2e7cf6;border-radius:6px;padding:5px 8px;font-size:13px;margin-bottom:8px"><i class="ti ti-map-2" style="font-size:13px"></i> <strong>Couvre :</strong> ' + _esc(p.zone_chalandise) + (p.rayon_km ? ' · rayon ' + _esc(String(p.rayon_km)) + ' km' : '') + '</div>' : '') +
    (p.note_interne ? '<div style="background:var(--bg);border:0.5px solid var(--border);border-radius:6px;padding:6px 8px;font-size:14px;color:var(--text2);margin-bottom:8px"><i class="ti ti-note" style="font-size:13px"></i> ' + _esc(p.note_interne) + '</div>' : '') +
    (p.client_id ? '<button onclick="ouvrirFicheDistrib(' + p.client_id + ')" style="width:100%;background:#16a34a;color:#fff;border:none;border-radius:6px;padding:7px 0;font-size:14px;cursor:pointer;margin-bottom:8px"><i class="ti ti-user"></i> '+TR("Voir la fiche complète →")+'</button>' : '') +
    (p.nb_commandes > 0 ? '<button onclick="filtrerParDistrib(\'' + _esc(p.nom).replace(/\'/g,"") + '\')" style="width:100%;background:#2e7cf6;color:#fff;border:none;border-radius:6px;padding:7px 0;font-size:14px;cursor:pointer;margin-bottom:8px">'+TR("Voir ses commandes →")+'</button>' : '') +
    '<button onclick="nouvelleDemandeDepuisCarte(' + (p.client_id||'null') + ',\'' + _esc(p.nom).replace(/\'/g,"") + '\')" style="width:100%;background:#7c3aed;color:#fff;border:none;border-radius:6px;padding:7px 0;font-size:14px;cursor:pointer;margin-bottom:8px"><i class="ti ti-address-book"></i> '+TR("Nouvelle demande d'info →")+'</button>' +
    (typeof canWriteCarte==='function' && canWriteCarte() ? '<div style="margin-top:6px;padding-top:8px;border-top:0.5px solid var(--border);display:flex;gap:6px"><button onclick="modalPointCarte(' + p.id + ')" style="flex:1;background:var(--surface);border:0.5px solid #cfcfca;border-radius:6px;padding:6px 0;font-size:14px;cursor:pointer"><i class="ti ti-edit"></i> '+TR("Modifier")+'</button><button onclick="supprimerPointCarte(' + p.id + ')" style="background:#fef2f2;color:#dc2626;border:0.5px solid #fecaca;border-radius:6px;padding:6px 10px;font-size:14px;cursor:pointer"><i class="ti ti-trash"></i></button></div>' : '') +
    '</div>';
}

function wirePopupCarte(e, p) { dessinerCouverture(p); }

// ── Couverture géographique d'un distributeur (départements colorés + rayon) ──
var _carteCouvertureLayer = null;   // couche des overlays de couverture (départements + cercle)
var _departementsGeoP = null;       // promesse de chargement du fond de départements (une seule fois)
var _departementsIdx = null;        // index code -> feature GeoJSON

function chargerDepartementsGeo() {
  if (_departementsGeoP) return _departementsGeoP;
  var url = 'https://cdn.jsdelivr.net/gh/gregoiredavid/france-geojson@master/departements-version-simplifiee.geojson';
  _departementsGeoP = fetch(url).then(function(r){ return r.json(); }).then(function(geo){
    _departementsIdx = {};
    (geo.features||[]).forEach(function(f){ if (f.properties && f.properties.code) _departementsIdx[String(f.properties.code).toUpperCase()] = f; });
    return _departementsIdx;
  }).catch(function(e){ _departementsGeoP = null; return null; });
  return _departementsGeoP;
}

// Surlignage du contour d'un département lors d'une recherche par n° de département
var _carteDeptSearchLayer = null;
function retirerDepartement() {
  if (_carteDeptSearchLayer && _carteMap) { _carteMap.removeLayer(_carteDeptSearchLayer); }
  _carteDeptSearchLayer = null;
}
function surlignerDepartement(dep) {
  if (!_carteMap || !dep) return;
  chargerDepartementsGeo().then(function(idx){
    if (!idx) return;
    var feat = idx[String(dep).toUpperCase()];
    if (!feat) return;
    retirerDepartement();
    _carteDeptSearchLayer = L.geoJSON(feat, {
      interactive: false,
      style: function(){ return { color:'#2e7cf6', weight:2, opacity:0.9, fillColor:'#2e7cf6', fillOpacity:0.12, dashArray:'5 3' }; }
    }).addTo(_carteMap);
    try { _carteDeptSearchLayer.bringToBack(); } catch(e){}
    try { _carteMap.fitBounds(_carteDeptSearchLayer.getBounds(), { padding:[30,30] }); } catch(e){}
  });
}
window.surlignerDepartement = surlignerDepartement;
window.retirerDepartement = retirerDepartement;

// Extrait les codes départements d'un texte libre ("84, 30, 13" ou "Vaucluse, Gard"…)
function parseDepartements(txt) {
  if (!txt) return [];
  var codes = [];
  // Corse : 2A / 2B
  var corse = txt.toUpperCase().match(/\b2[AB]\b/g);
  if (corse) corse.forEach(function(c){ codes.push(c); });
  // Codes numériques : DOM (971-976) puis départements 2 chiffres (avec 0 ajouté si 1 chiffre)
  var nums = txt.match(/\b\d{1,3}\b/g) || [];
  nums.forEach(function(n){
    if (n.length === 3) { if (/^97[1-6]$/.test(n)) codes.push(n); }
    else { var c = n.length === 1 ? '0' + n : n; if (parseInt(c,10) >= 1 && parseInt(c,10) <= 95) codes.push(c); }
  });
  return [...new Set(codes)];
}

function effacerCouverture() {
  if (_carteCouvertureLayer && _carteMap) { _carteMap.removeLayer(_carteCouvertureLayer); }
  _carteCouvertureLayer = null;
}

function dessinerCouverture(p) {
  effacerCouverture();
  if (!_carteMap || !p) return;
  var cfg = (typeof RESEAUX_CONFIG !== 'undefined' && RESEAUX_CONFIG[p.reseau]) || { color: '#2e7cf6' };
  var couleur = cfg.color || '#2e7cf6';
  var layer = L.layerGroup();
  // 1) Rayon en km
  if (p.rayon_km && parseFloat(p.rayon_km) > 0 && p.lat && p.lng) {
    L.circle([parseFloat(p.lat), parseFloat(p.lng)], {
      radius: parseFloat(p.rayon_km) * 1000,
      color: couleur, weight: 1.5, fillColor: couleur, fillOpacity: 0.10
    }).addTo(layer);
  }
  layer.addTo(_carteMap);
  _carteCouvertureLayer = layer;
  // 2) Départements colorés (fond chargé à la demande)
  var codes = parseDepartements(p.zone_chalandise);
  if (codes.length) {
    chargerDepartementsGeo().then(function(idx){
      if (!idx || _carteCouvertureLayer !== layer) return; // popup fermé/point changé entre-temps
      codes.forEach(function(code){
        var f = idx[code];
        if (!f) return;
        L.geoJSON(f, { style: { color: couleur, weight: 1.5, fillColor: couleur, fillOpacity: 0.22 } })
          .bindTooltip('Dép. ' + code + (f.properties && f.properties.nom ? ' — ' + f.properties.nom : ''), { sticky: true })
          .addTo(layer);
      });
    });
  }
}
window.dessinerCouverture = dessinerCouverture;
window.effacerCouverture = effacerCouverture;

// Ouvre la fiche client complète depuis un point de la carte
function ouvrirFicheDistrib(clientId){
  if (!clientId) return;
  if (_carteMap) _carteMap.closePopup();
  setView('client', { clientId: clientId });
}
window.ouvrirFicheDistrib = ouvrirFicheDistrib;
// Depuis la carte : créer une demande d'info pour ce distributeur (client qui a appelé)
function nouvelleDemandeDepuisCarte(clientId, nom){
  if (_carteMap) _carteMap.closePopup();
  setView('demandes');
  setTimeout(function(){ if (typeof modalDemande==='function') modalDemande(clientId||null, nom||''); }, 500);
}
window.nouvelleDemandeDepuisCarte = nouvelleDemandeDepuisCarte;

function filtrerParDistrib(nom) {
  if (typeof STATE !== 'undefined') STATE.view = 'commandes';
  if (typeof CMD_FILTERS !== 'undefined') CMD_FILTERS.distributeur = nom;
  if (typeof render === 'function') render();
}
window.filtrerParDistrib = filtrerParDistrib;

function sauverNoteCarte(id) {
  var ta = document.getElementById('carte-note-' + id);
  if (!ta) return;
  var note = ta.value;
  fetch('/api/carte/points/' + id + '/note', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: note })
  }).then(function(r){ return r.json(); }).then(function(){
    var pt = _cartePoints.find(function(x){ return x.id === id; });
    if (pt) pt.note_interne = note;
    afficherMarkers();
    if (typeof toast === 'function') toast(TR('Note enregistrée'), 'ti-check', 'var(--success)');
  }).catch(function(e){ alert(TR('Erreur : ') + e.message); });
}
window.sauverNoteCarte = sauverNoteCarte;

function sauverCouvertureCarte(id) {
  var ta = document.getElementById('carte-zone-' + id);
  var ra = document.getElementById('carte-rayon-' + id);
  if (!ta) return;
  var zone = ta.value;
  var rayon = ra && ra.value !== '' ? parseFloat(ra.value) : null;
  fetch('/api/carte/points/' + id + '/zone', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ zone: zone, rayon_km: rayon })
  }).then(function(r){ return r.json(); }).then(function(){
    var pt = _cartePoints.find(function(x){ return x.id === id; });
    if (pt) { pt.zone_chalandise = zone; pt.rayon_km = (rayon && rayon > 0) ? rayon : null; if (typeof dessinerCouverture === 'function') dessinerCouverture(pt); }
    if (typeof toast === 'function') toast(TR('Couverture enregistrée'), 'ti-map-2', 'var(--success)');
  }).catch(function(e){ alert(TR('Erreur : ') + e.message); });
}
window.sauverCouvertureCarte = sauverCouvertureCarte;

// Enregistre la priorité depuis le popup carte → met à jour la fiche client (répercussion
// automatique dans Clients / distributeurs, et inversement au rechargement de la carte).
function sauverPrioriteCarte(id, prio) {
  fetch('/api/carte/points/' + id + '/priorite', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ priorite: prio || null })
  }).then(function(r){ return r.json(); }).then(function(res){
    if (res && res.error) { alert(res.error); return; }
    var pt = _cartePoints.find(function(x){ return x.id === id; });
    if (pt) pt.priorite = prio || null;
    afficherMarkers();
    if (typeof toast === 'function') toast(TR('Priorité mise à jour'), 'ti-flag', 'var(--success)');
  }).catch(function(e){ alert(TR('Erreur : ') + e.message); });
}
window.sauverPrioriteCarte = sauverPrioriteCarte;

// ── Distributeurs "hors carte" (présents dans Clients/distributeurs, pas sur la carte) ──
function basculerHorsCarte(actif) {
  _carteHorsCarte = !!actif;
  if (!actif) { (_carteHorsMarkers || []).forEach(function(m){ if (_carteMap) _carteMap.removeLayer(m); }); _carteHorsMarkers = []; return; }
  if (_carteHorsPoints.length) { afficherHorsMarkers(); return; }
  var info = document.getElementById('carte-nom-result');
  if (info) info.innerHTML = '<span style="color:#666">'+TR("Chargement des distributeurs hors carte…")+'</span>';
  fetch('/api/carte/hors-carte').then(function(r){ return r.json(); }).then(function(rows){
    _carteHorsPoints = Array.isArray(rows) ? rows : [];
    afficherHorsMarkers();
    if (info) info.innerHTML = _carteHorsPoints.length
      ? '<span style="color:#16a34a">' + _carteHorsPoints.length + ' distributeur(s) hors carte affiché(s)</span>'
      : '<span style="color:#b45309">'+TR("Aucun distributeur hors carte géocodé pour l'instant.")+'</span>';
  }).catch(function(e){ if (info) info.innerHTML = '<span style="color:#dc2626">Erreur : ' + esc(e.message) + '</span>'; });
}
window.basculerHorsCarte = basculerHorsCarte;

function afficherHorsMarkers() {
  (_carteHorsMarkers || []).forEach(function(m){ if (_carteMap) _carteMap.removeLayer(m); });
  _carteHorsMarkers = [];
  if (!_carteMap || !_carteHorsCarte) return;
  var iconAutres = L.divIcon({
    html: '<img src="/img/reseaux/inconnu.png" width="30" height="30" style="display:block;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))">',
    className: '', iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -15]
  });
  _carteHorsPoints.forEach(function(c){
    if (c.lat == null || c.lng == null) return;
    var m = L.marker([parseFloat(c.lat), parseFloat(c.lng)], { icon: iconAutres });
    m.bindPopup(popupHorsCarte(c), { maxWidth: 260 });
    m.addTo(_carteMap); _carteHorsMarkers.push(m);
  });
}
function popupHorsCarte(c) {
  return '<div style="width:230px;font-size:15px">' +
    '<div style="font-weight:700;font-size:16px;margin-bottom:4px">' + _esc(c.nom) + ' <span style="font-size:12px;color:#888;font-weight:600">(hors carte)</span></div>' +
    '<div style="color:#666;line-height:1.5;margin-bottom:8px">' +
      ((c.adresse && c.adresse.trim().toLowerCase() !== String(c.nom||'').trim().toLowerCase()) ? _esc(c.adresse) + '<br>' : '') +
      ((c.cp || c.ville) ? _esc((c.cp||'') + ' ' + (c.ville||'')) : '') + '</div>' +
    '<button onclick="ajouterDistributeurCarte(' + c.id + ',\'' + String(c.nom||'').replace(/'/g,'&#39;') + '\')" style="width:100%;background:#2e7cf6;color:#fff;border:none;border-radius:6px;padding:6px 0;font-size:14px;cursor:pointer;margin-bottom:6px"><i class="ti ti-map-pin-plus"></i> '+TR("Ajouter à la carte")+'</button>' +
    (typeof canWriteCarte==='function' && canWriteCarte() ? '<button onclick="passerParticulierCarte(' + c.id + ',\'' + String(c.nom||'').replace(/'/g,'&#39;') + '\',this)" style="width:100%;background:#d97706;color:#fff;border:none;border-radius:6px;padding:6px 0;font-size:14px;cursor:pointer;margin-bottom:6px"><i class="ti ti-user"></i> '+TR("Passer en particulier")+'</button>' : '') +
    '<button onclick="ouvrirFicheDistrib(' + c.id + ')" style="width:100%;background:#16a34a;color:#fff;border:none;border-radius:6px;padding:6px 0;font-size:14px;cursor:pointer">'+TR("Voir la fiche →")+'</button>' +
    '</div>';
}
// Passe une fiche "hors carte" directement en Particulier (la retire de la carte), sans ouvrir la fiche.
async function passerParticulierCarte(id, nom, btn) {
  var libelle = String(nom || '').replace(/&#39;/g, "'");
  if (!confirm(libelle + ' → ' + TR('passer en Particulier ? La fiche sera retirée de la carte.'))) return;
  if (btn) { btn.disabled = true; btn.style.opacity = '.6'; }
  try {
    await API.setClientType(id, 'Particulier');
    _carteHorsPoints = (_carteHorsPoints || []).filter(function(p){ return p.id !== id; });
    if (_carteMap && typeof _carteMap.closePopup === 'function') _carteMap.closePopup();
    afficherHorsMarkers();
    var info = document.getElementById('carte-nom-result');
    if (info) info.innerHTML = '<span style="color:#16a34a">' + _esc(libelle) + TR(' — passé en Particulier, retiré de la carte.') + '</span>';
    if (typeof toast === 'function') toast(TR('Fiche passée en Particulier'), 'ti-user', 'var(--success)');
  } catch (e) {
    if (btn) { btn.disabled = false; btn.style.opacity = ''; }
    alert('Erreur : ' + e.message);
  }
}
window.passerParticulierCarte = passerParticulierCarte;
window.afficherHorsMarkers = afficherHorsMarkers;

// ── Filtre strict "département couvert" ──
function setDeptFiltre(v) {
  var s = String(v || '').toUpperCase().replace(/[^0-9AB]/g, '');
  if (/^\d$/.test(s)) s = '0' + s;            // "5" -> "05"
  _carteDeptFiltre = s;
  afficherMarkers(true);
}
window.setDeptFiltre = setDeptFiltre;

// ── Bouton "Géocoder" : enrichissement VosFactures + positionnement des adresses manquantes ──
async function lancerGeocodageCarte() {
  if (!confirm(TR('Positionner les distributeurs dont l\'adresse est renseignée ?\n\nÉtapes : complément d\'adresse depuis VosFactures, puis géocodage par code postal. Cela peut prendre quelques minutes.'))) return;
  var info = document.getElementById('carte-nom-result');
  var setInfo = function(t, col) { if (info) info.innerHTML = '<span style="color:' + (col || '#666') + '">' + t + '</span>'; };
  try {
    setInfo('Complément des adresses depuis VosFactures…');
    for (var i = 0; i < 12; i++) { var e = await fetch('/api/admin/enrichir-adresses-vf?limit=80', { method: 'POST' }).then(function(r){ return r.json(); }); if (!e || (e.traites || 0) < 80) break; }
    var tot = 0;
    for (var j = 0; j < 60; j++) {
      var r = await fetch('/api/admin/geocoder-hors-carte?limit=15', { method: 'POST' }).then(function(r){ return r.json(); });
      tot += (r.geocodes || 0);
      setInfo('Géocodage en cours… ' + tot + ' positionné(s), ' + (r.restants || 0) + ' restant(s)');
      if (!r.restants || r.restants <= 0) break;
    }
    setInfo('Terminé : ' + tot + ' distributeur(s) positionné(s).', '#16a34a');
    _carteHorsPoints = [];
    if (_carteHorsCarte) basculerHorsCarte(true); // recharge les points hors carte affichés
    if (typeof toast === 'function') toast(TR('Géocodage terminé (') + tot + ')', 'ti-map-pin', 'var(--success)');
  } catch (e) { setInfo('Erreur : ' + esc(e.message), '#dc2626'); }
}
window.lancerGeocodageCarte = lancerGeocodageCarte;

// ── Contrôle "ville ↔ code postal" : repère les villes ne correspondant pas au CP officiel ──
async function controleVillesCarte() {
  var info = document.getElementById('carte-nom-result');
  var setInfo = function(t, col) { if (info) info.innerHTML = '<span style="color:' + (col || '#666') + '">' + t + '</span>'; };
  try {
    setInfo('Contrôle des villes en cours…');
    var norm = function(s){ return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]+/g,' ').replace(/\bSAINT\b/g,'ST').trim(); };
    var cls = await fetch('/api/clients').then(function(r){ return r.json(); });
    var arr = Array.isArray(cls) ? cls : (cls.rows || []);
    var fiches = arr.filter(function(c){ return c.type !== 'Particulier' && c.ville && String(c.ville).trim() && /^\d{5}$/.test(String(c.cp||'').trim()); });
    var cps = Object.keys(fiches.reduce(function(a,c){ a[String(c.cp).trim()]=1; return a; }, {}));
    var cache = {};
    for (var i = 0; i < cps.length; i++) {
      try { var j = await fetch('https://geo.api.gouv.fr/communes?codePostal=' + cps[i] + '&fields=nom&format=json').then(function(r){ return r.json(); }); cache[cps[i]] = (j||[]).map(function(x){ return { brut:x.nom, n:norm(x.nom) }; }); }
      catch(e) { cache[cps[i]] = null; }
      if (i % 15 === 0) setInfo('Contrôle des villes… ' + i + '/' + cps.length);
    }
    var mism = [];
    fiches.forEach(function(c){
      var off = cache[String(c.cp).trim()]; if (!off || !off.length) return;
      var v = norm(c.ville);
      var ok = off.some(function(o){ return o.n === v || o.n.indexOf(v) >= 0 || v.indexOf(o.n) >= 0; });
      if (!ok) mism.push({ id: c.id, nom: c.nom, ville: c.ville, cp: c.cp, suggestion: off[0].brut, autres: off.map(function(o){ return o.brut; }).join(', ') });
    });
    setInfo(mism.length + ' incohérence(s) trouvée(s).', mism.length ? '#d97706' : '#16a34a');
    afficherModalControleVilles(mism);
  } catch (e) { setInfo('Erreur : ' + esc(e.message), '#dc2626'); }
}
window.controleVillesCarte = controleVillesCarte;

function afficherModalControleVilles(mism) {
  var lignes = mism.length ? mism.map(function(m){
    return '<tr style="border-bottom:0.5px solid var(--border)">' +
      '<td style="padding:6px 8px">' + esc(m.nom) + '</td>' +
      '<td style="padding:6px 8px;color:#dc2626">' + esc(m.ville) + '</td>' +
      '<td style="padding:6px 8px;text-align:center">' + esc(m.cp) + '</td>' +
      '<td style="padding:6px 8px;color:#16a34a">' + esc(m.suggestion) + '</td>' +
      '<td style="padding:6px 8px;text-align:right"><button onclick="corrigerVilleCarte(' + m.id + ',\'' + String(m.suggestion).replace(/'/g,'&#39;') + '\',this)" style="background:#16a34a;color:#fff;border:none;border-radius:6px;padding:4px 10px;font-size:14px;cursor:pointer">Corriger</button></td>' +
    '</tr>';
  }).join('') : '<tr><td colspan="5" style="padding:14px;text-align:center;color:var(--text3)">'+TR("Aucune incohérence détectée 🎉")+'</td></tr>';
  var html = '<div style="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9999;display:flex;align-items:center;justify-content:center" onclick="if(event.target===this)this.remove()">' +
    '<div style="background:var(--surface);border-radius:12px;padding:20px;width:760px;max-width:94vw;max-height:86vh;overflow:auto" onclick="event.stopPropagation()">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px"><h3 style="margin:0;font-size:18px">Contrôle ville ↔ code postal — ' + mism.length + ' à vérifier</h3><button onclick="this.closest(\'div[style*=fixed]\').remove()" style="background:var(--bg);border:0.5px solid var(--border);border-radius:6px;padding:4px 10px;cursor:pointer"><i class="ti ti-x"></i></button></div>' +
      '<div style="font-size:14px;color:var(--text2);margin-bottom:10px">'+TR("La ville de la fiche ne correspond pas à la commune officielle du code postal. « Corriger » remplace la ville par la commune officielle proposée.")+'</div>' +
      '<table style="width:100%;border-collapse:collapse;font-size:14px"><thead><tr style="background:var(--bg)"><th style="padding:6px 8px;text-align:left">'+TR("Distributeur")+'</th><th style="padding:6px 8px;text-align:left">Ville (fiche)</th><th style="padding:6px 8px">CP</th><th style="padding:6px 8px;text-align:left">Commune officielle</th><th></th></tr></thead><tbody>' + lignes + '</tbody></table>' +
    '</div></div>';
  var div = document.createElement('div'); div.innerHTML = html; document.body.appendChild(div.firstChild);
}
function corrigerVilleCarte(id, ville, btn) {
  fetch('/api/clients/' + id + '/ville', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ville: ville }) })
    .then(function(r){ return r.json(); }).then(function(res){
      if (res && res.error) { alert(res.error); return; }
      if (btn) { btn.textContent = '✓ Corrigé'; btn.disabled = true; btn.style.background = '#9ca3af'; }
      if (typeof toast === 'function') toast(TR('Ville corrigée'), 'ti-check', 'var(--success)');
    }).catch(function(e){ alert(TR('Erreur : ') + e.message); });
}
window.corrigerVilleCarte = corrigerVilleCarte;

var _carteRayonCircle = null;
var _carteGeoCenter = null;
var _carteGeoMarker = null;

// Styles du repère de recherche (injectés une seule fois)
function stylesRepereGeo() {
  if (document.getElementById('carte-geo-styles')) return;
  var st = document.createElement('style');
  st.id = 'carte-geo-styles';
  st.textContent =
    '@keyframes geoPulse{0%{transform:scale(.5);opacity:.6}70%{transform:scale(1.8);opacity:0}100%{transform:scale(1.8);opacity:0}}' +
    '.geo-onde{position:absolute;inset:0;border-radius:50%;background:#2e7cf6;animation:geoPulse 1.9s ease-out infinite}' +
    '.leaflet-tooltip.geo-label{background:#2e7cf6;color:#fff;border:none;box-shadow:0 2px 7px rgba(0,0,0,.3);' +
      'font-weight:700;font-size:13px;padding:3px 10px;border-radius:99px;white-space:nowrap}' +
    '.leaflet-tooltip.geo-label:before{border-top-color:#2e7cf6}';
  document.head.appendChild(st);
}

// Distance entre deux points (formule Haversine, en km)
function distanceKm(lat1, lng1, lat2, lng2) {
  var R = 6371;
  var dLat = (lat2 - lat1) * Math.PI / 180;
  var dLng = (lng2 - lng1) * Math.PI / 180;
  var a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng/2) * Math.sin(dLng/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Département officiel d'un code postal (ex "83160" -> "83", Corse -> "2A"/"2B", DOM -> "971"…)
function departementDeCp(cp) {
  cp = String(cp || '').trim();
  if (!/^\d{2}/.test(cp)) return '';
  var d2 = cp.slice(0, 2);
  if (d2 === '97' || d2 === '98') return cp.slice(0, 3);        // DOM-TOM
  if (d2 === '20') {                                            // Corse
    var n = parseInt(cp.slice(0, 5), 10);
    return (!isNaN(n) && n >= 20200) ? '2B' : '2A';
  }
  return d2;
}
// Interprète une requête de recherche comme un n° de département, sinon renvoie ''
function departementDeRequete(q) {
  var s = String(q || '').trim().toUpperCase();
  if (/^2[AB]$/.test(s)) return s;
  if (/^\d{1,3}$/.test(s)) {
    if (s.length === 3) return /^(97[1-6]|98[4-9])$/.test(s) ? s : '';
    var c = s.length === 1 ? '0' + s : s;
    var n = parseInt(c, 10);
    return (n >= 1 && n <= 95) ? c : '';
  }
  return '';
}
// Un point appartient-il au département recherché ? ("20" matche 2A et 2B)
function pointDansDepartement(p, dep) {
  var pd = departementDeCp(p.cp);
  if (!pd) return false;
  if (dep === '20') return pd === '2A' || pd === '2B';
  return pd === dep;
}
window.departementDeCp = departementDeCp;

function rechercheGeo() {
  var q = (document.getElementById('carte-geo') || {}).value || '';
  q = q.trim();
  var resultEl = document.getElementById('carte-geo-result');
  if (!q) {
    // Réinitialiser
    if (_carteRayonCircle && _carteMap) { _carteMap.removeLayer(_carteRayonCircle); _carteRayonCircle = null; }
    if (_carteGeoMarker && _carteMap) { _carteMap.removeLayer(_carteGeoMarker); _carteGeoMarker = null; }
    _carteGeoCenter = null;
    _carteDeptGeo = '';
    retirerDepartement();
    if (resultEl) resultEl.innerHTML = '';
    afficherMarkers();
    cadrerFrance();
    return;
  }
  // Requête = n° de département (ex "83") : on filtre les distributeurs situés dans ce département
  var dep = departementDeRequete(q);
  if (dep) {
    if (_carteRayonCircle && _carteMap) { _carteMap.removeLayer(_carteRayonCircle); _carteRayonCircle = null; }
    if (_carteGeoMarker && _carteMap) { _carteMap.removeLayer(_carteGeoMarker); _carteGeoMarker = null; }
    _carteGeoCenter = null;
    _carteDeptGeo = dep;
    afficherMarkers(true);
    surlignerDepartement(dep);
    return;
  }
  _carteDeptGeo = '';
  retirerDepartement();
  if (resultEl) resultEl.innerHTML = '<span style="color:#999">'+TR("Recherche…")+'</span>';

  // Chercher d'abord dans nos propres points (CP ou ville exacte)
  var qLow = q.toLowerCase();
  var localMatch = _cartePoints.find(function(p){
    return (p.cp && p.cp === q) || (p.ville && p.ville.toLowerCase() === qLow);
  });

  if (localMatch) {
    centrerSurGeo(parseFloat(localMatch.lat), parseFloat(localMatch.lng), localMatch.ville || q);
    return;
  }

  // Sinon géocoder via l'API (Nominatim)
  fetch('/api/carte/geocode-adresse?q=' + encodeURIComponent(q))
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (d.found) {
        centrerSurGeo(d.lat, d.lng, q);
      } else {
        if (resultEl) resultEl.innerHTML = '<span style="color:#dc2626">'+TR("Lieu introuvable")+'</span>';
      }
    })
    .catch(function(e){ if (resultEl) resultEl.innerHTML = '<span style="color:#dc2626">'+TR("Erreur")+'</span>'; });
}
window.rechercheGeo = rechercheGeo;

function centrerSurGeo(lat, lng, label) {
  if (!_carteMap) return;
  _carteGeoCenter = { lat: lat, lng: lng };
  var rayonActif = (document.getElementById('carte-rayon-actif') || {}).checked;
  var rayonKm = parseInt((document.getElementById('carte-rayon') || {}).value || '50');

  stylesRepereGeo();

  // Repère sur le lieu recherché
  if (_carteGeoMarker) { _carteMap.removeLayer(_carteGeoMarker); _carteGeoMarker = null; }
  _carteGeoMarker = L.marker([lat, lng], {
    zIndexOffset: 2000,
    interactive: false,
    icon: L.divIcon({
      className: '',
      html: '<div style="position:relative;width:28px;height:28px;pointer-events:none">' +
              '<div class="geo-onde"></div>' +
              '<div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:14px;height:14px;' +
                'border-radius:50%;background:#2e7cf6;border:3px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.45)"></div>' +
            '</div>',
      iconSize: [28, 28], iconAnchor: [14, 14]
    })
  }).addTo(_carteMap);
  _carteGeoMarker.bindTooltip(_esc(label), {
    permanent: true, direction: 'top', offset: [0, -14], className: 'geo-label'
  });

  // Cercle de rayon
  if (_carteRayonCircle) { _carteMap.removeLayer(_carteRayonCircle); _carteRayonCircle = null; }
  if (rayonActif) {
    _carteRayonCircle = L.circle([lat, lng], {
      radius: rayonKm * 1000, color: '#2e7cf6', weight: 1.5, fillColor: '#2e7cf6', fillOpacity: 0.08
    }).addTo(_carteMap);
    _carteMap.fitBounds(_carteRayonCircle.getBounds(), { padding: [40, 40] });
  } else {
    _carteMap.setView([lat, lng], 10);
  }

  afficherMarkers();

  // Compter et lister les distributeurs proches
  var proches = _cartePoints.filter(function(p){
    if (!_carteReseaux[p.reseau]) return false;
    var dist = distanceKm(lat, lng, parseFloat(p.lat), parseFloat(p.lng));
    p._dist = dist;
    return dist <= rayonKm;
  }).sort(function(a, b){ return a._dist - b._dist; });

  var resultEl = document.getElementById('carte-geo-result');
  if (resultEl) {
    if (proches.length) {
      resultEl.innerHTML = '<div style="font-weight:600;margin-bottom:6px">' + proches.length + ' distributeur' + (proches.length>1?'s':'') + ' dans un rayon de ' + rayonKm + ' km de ' + _esc(label) + ' :</div>' +
        proches.slice(0, 15).map(function(p){
          var cfg = RESEAUX_CONFIG[p.reseau] || { color:'#888' };
          return '<div onclick="zoomSurPoint(' + p.id + ')" style="display:flex;align-items:center;gap:6px;padding:4px 2px;cursor:pointer;border-radius:4px" onmouseover="this.style.background=\'#f0f0ee\'" onmouseout="this.style.background=\'\'">' +
            '<span style="width:9px;height:9px;border-radius:50%;background:' + cfg.color + ';flex-shrink:0"></span>' +
            '<span style="flex:1;font-size:14px">' + _esc(p.nom) + '</span>' +
            '<span style="font-size:13px;color:#999">' + p._dist.toFixed(0) + ' km</span>' +
            '</div>';
        }).join('') +
        (proches.length > 15 ? '<div style="font-size:13px;color:#999;margin-top:4px">… et ' + (proches.length - 15) + ' autres</div>' : '');
    } else {
      resultEl.innerHTML = '<span style="color:#999">'+TR("Aucun distributeur dans ce rayon.")+'</span>';
    }
  }
}
window.centrerSurGeo = centrerSurGeo;

function zoomSurPoint(id) {
  var p = _cartePoints.find(function(x){ return x.id === id; });
  if (!p || !_carteMap) return;
  _carteMap.setView([parseFloat(p.lat), parseFloat(p.lng)], 13);
  // Ouvrir le popup du marker correspondant
  var marker = _carteMarkers.find(function(m){
    var ll = m.getLatLng();
    return Math.abs(ll.lat - parseFloat(p.lat)) < 0.0001 && Math.abs(ll.lng - parseFloat(p.lng)) < 0.0001;
  });
  if (marker) ouvrirPopupMarkerCarte(marker);
}
window.zoomSurPoint = zoomSurPoint;

function modalPointCarte(id) {
  var p = id ? _cartePoints.find(function(x){ return x.id === id; }) : null;
  var titre = p ? 'Modifier le distributeur' : 'Nouveau distributeur';
  var reseauOpts = Object.keys(RESEAUX_CONFIG).map(function(k){
    return '<option value="' + k + '"' + (p && p.reseau===k ? ' selected' : '') + '>' + RESEAUX_CONFIG[k].label + '</option>';
  }).join('');

  var html = '<div style="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9999;display:flex;align-items:center;justify-content:center" onclick="if(event.target===this)fermerModalPoint()">' +
    '<div style="background:#fff;border-radius:12px;padding:24px;width:440px;max-width:92vw;max-height:88vh;overflow:auto" onclick="event.stopPropagation()">' +
      '<h3 style="margin:0 0 16px;font-size:18px">' + titre + '</h3>' +
      '<div style="display:flex;flex-direction:column;gap:10px">' +
        '<div><label style="font-size:14px;color:#666;display:block;margin-bottom:3px">'+TR("Réseau")+'</label><select id="pc-reseau" style="width:100%;border:0.5px solid #cfcfca;border-radius:7px;padding:7px 9px;font-size:15px">' + reseauOpts + '</select></div>' +
        '<div><label style="font-size:14px;color:#666;display:block;margin-bottom:3px">'+TR("Nom du distributeur *")+'</label><input id="pc-nom" value="' + (p?_esc(p.nom):'') + '" style="width:100%;border:0.5px solid #cfcfca;border-radius:7px;padding:7px 9px;font-size:15px"></div>' +
        '<div><label style="font-size:14px;color:#666;display:block;margin-bottom:3px">'+TR("Client rattaché")+' <span style="color:#999">'+TR("(recommandé)")+'</span></label>' +
          '<div style="position:relative">' +
            '<input id="pc-client-search" autocomplete="off" placeholder="'+TR("Taper le nom du client…")+'" oninput="pcClientInput(this.value)" onfocus="searchPcClient(this.value)" onblur="setTimeout(function(){var d=document.getElementById(\'pc-client-drop\');if(d)d.style.display=\'none\'},150)" style="width:100%;border:0.5px solid #cfcfca;border-radius:7px;padding:7px 9px;font-size:15px">' +
            '<input type="hidden" id="pc-client" value="' + (p&&p.client_id?p.client_id:'') + '">' +
            '<div id="pc-client-drop" class="piece-dropdown" style="display:none"></div>' +
          '</div>' +
          '<div style="font-size:13px;color:#999;margin-top:3px">'+TR("Lier au client garantit que ses ventes s'affichent, même si l'orthographe diffère. Laisser vide = rattachement par nom.")+'</div></div>' +
        '<div><label style="font-size:14px;color:#666;display:block;margin-bottom:3px">Adresse</label><input id="pc-adresse" value="' + (p&&p.adresse?_esc(p.adresse):'') + '" style="width:100%;border:0.5px solid #cfcfca;border-radius:7px;padding:7px 9px;font-size:15px"></div>' +
        '<div style="display:flex;gap:8px"><div style="width:110px"><label style="font-size:14px;color:#666;display:block;margin-bottom:3px">Code postal</label><input id="pc-cp" value="' + (p&&p.cp?_esc(p.cp):'') + '" style="width:100%;border:0.5px solid #cfcfca;border-radius:7px;padding:7px 9px;font-size:15px"></div>' +
        '<div style="flex:1"><label style="font-size:14px;color:#666;display:block;margin-bottom:3px">Ville</label><input id="pc-ville" value="' + (p&&p.ville?_esc(p.ville):'') + '" style="width:100%;border:0.5px solid #cfcfca;border-radius:7px;padding:7px 9px;font-size:15px"></div></div>' +
        '<div><label style="font-size:14px;color:#666;display:block;margin-bottom:3px">Pays</label><select id="pc-pays" style="width:100%;border:0.5px solid #cfcfca;border-radius:7px;padding:7px 9px;font-size:15px">' + optionsPays(p ? p.pays : 'France') + '</select></div>' +
        '<div style="display:flex;gap:8px"><div style="flex:1"><label style="font-size:14px;color:#666;display:block;margin-bottom:3px">'+TR("Téléphone")+'</label><input id="pc-tel" value="' + (p&&p.tel?_esc(fmtTel(p.tel)):'') + '" style="width:100%;border:0.5px solid #cfcfca;border-radius:7px;padding:7px 9px;font-size:15px"></div>' +
        '<div style="flex:1"><label style="font-size:14px;color:#666;display:block;margin-bottom:3px">Portable</label><input id="pc-portable" value="' + (p&&p.portable?_esc(fmtTel(p.portable)):'') + '" style="width:100%;border:0.5px solid #cfcfca;border-radius:7px;padding:7px 9px;font-size:15px"></div></div>' +
        '<div><label style="font-size:14px;color:#666;display:block;margin-bottom:3px">Email</label><input id="pc-email" value="' + (p&&p.email?_esc(p.email):'') + '" style="width:100%;border:0.5px solid #cfcfca;border-radius:7px;padding:7px 9px;font-size:15px"></div>' +
        '<div style="display:flex;gap:8px">' +
          '<div style="flex:1"><label style="font-size:14px;color:#666;display:block;margin-bottom:3px">'+TR("Priorité")+'</label><select id="pc-priorite" style="width:100%;border:0.5px solid #cfcfca;border-radius:7px;padding:7px 9px;font-size:15px">' +
            ['','T1','T2','T3'].map(function(v){ var lib={'':'— Aucune —',T1:'T1 — absolue',T2:'T2 — moyenne',T3:'T3 — basse'}[v]; return '<option value="'+v+'"'+(p&&(p.priorite||'')===v?' selected':'')+'>'+lib+'</option>'; }).join('') +
          '</select></div>' +
          '<div style="width:130px"><label style="font-size:14px;color:#666;display:block;margin-bottom:3px">Rayon (km)</label><input id="pc-rayon" type="number" min="0" step="5" value="' + (p&&p.rayon_km!=null?_esc(String(p.rayon_km)):'') + '" placeholder="optionnel" style="width:100%;border:0.5px solid #cfcfca;border-radius:7px;padding:7px 9px;font-size:15px"></div>' +
        '</div>' +
        '<div><label style="font-size:14px;color:#666;display:block;margin-bottom:3px">'+TR("Zone de chalandise / départements")+'</label><textarea id="pc-zone" rows="2" placeholder="ex : 84, 30, 13 — ou Vaucluse, Gard" style="width:100%;border:0.5px solid #cfcfca;border-radius:7px;padding:7px 9px;font-size:15px;resize:vertical;font-family:inherit">' + (p&&p.zone_chalandise?_esc(p.zone_chalandise):'') + '</textarea></div>' +
        '<div><label style="font-size:14px;color:#666;display:block;margin-bottom:3px">'+TR("Note interne")+'</label><textarea id="pc-note" rows="2" style="width:100%;border:0.5px solid #cfcfca;border-radius:7px;padding:7px 9px;font-size:15px;resize:vertical;font-family:inherit">' + (p&&p.note_interne?_esc(p.note_interne):'') + '</textarea></div>' +
        '<div style="background:#f8f9fa;border-radius:8px;padding:10px 12px">' +
          '<div style="display:flex;gap:8px;align-items:flex-end">' +
            '<div style="width:120px"><label style="font-size:14px;color:#666;display:block;margin-bottom:3px">Latitude *</label><input id="pc-lat" value="' + (p?p.lat:'') + '" placeholder="48.85" style="width:100%;border:0.5px solid #cfcfca;border-radius:7px;padding:7px 9px;font-size:15px"></div>' +
            '<div style="width:120px"><label style="font-size:14px;color:#666;display:block;margin-bottom:3px">Longitude *</label><input id="pc-lng" value="' + (p?p.lng:'') + '" placeholder="2.35" style="width:100%;border:0.5px solid #cfcfca;border-radius:7px;padding:7px 9px;font-size:15px"></div>' +
            '<button onclick="geocoderAdresse()" style="background:#2e7cf6;color:#fff;border:none;border-radius:7px;padding:7px 12px;font-size:14px;cursor:pointer;white-space:nowrap"><i class="ti ti-map-pin"></i> Trouver</button>' +
          '</div>' +
          '<div style="font-size:13px;color:#999;margin-top:5px">'+TR("Cliquez \"Trouver\" pour localiser depuis l'adresse, ou saisissez les coordonnées manuellement.")+'</div>' +
        '</div>' +
      '</div>' +
      '<div style="display:flex;gap:8px;margin-top:18px;justify-content:flex-end">' +
        '<button onclick="fermerModalPoint()" style="background:var(--surface);border:0.5px solid #cfcfca;border-radius:7px;padding:8px 16px;font-size:15px;cursor:pointer">'+TR("Annuler")+'</button>' +
        '<button onclick="sauverPointCarte(' + (id||'null') + ')" style="background:#2e7cf6;color:#fff;border:none;border-radius:7px;padding:8px 16px;font-size:15px;cursor:pointer">'+TR("Enregistrer")+'</button>' +
      '</div>' +
    '</div></div>';

  var div = document.createElement('div');
  div.id = 'modal-point-carte';
  div.innerHTML = html;
  document.body.appendChild(div);
  if (_carteMap) _carteMap.closePopup();

  // Charger la liste des clients pour l'autocomplétion + pré-remplir si déjà rattaché
  fetch('/api/carte/clients-liste')
    .then(function(r){ return r.json(); })
    .then(function(clients){
      window._PC_CLIENTS = Array.isArray(clients) ? clients : [];
      if (p && p.client_id) {
        var cur = window._PC_CLIENTS.find(function(c){ return c.id === p.client_id; });
        var inp = document.getElementById('pc-client-search');
        if (cur && inp) inp.value = cur.nom + (cur.ville ? ' — ' + cur.ville : '');
      }
    })
    .catch(function(){});
}
window.modalPointCarte = modalPointCarte;

// Autocomplétion du client rattaché dans la modale "Modifier" de la carte
function pcClientInput(v) {
  var hid = document.getElementById('pc-client'); if (hid) hid.value = ''; // saisie manuelle annule la sélection
  searchPcClient(v);
}
function searchPcClient(q) {
  var drop = document.getElementById('pc-client-drop'); if (!drop) return;
  var src = window._PC_CLIENTS || [];
  var query = (q || '').toLowerCase().trim();
  var res = (query ? src.filter(function(c){ return (c.nom && c.nom.toLowerCase().indexOf(query) >= 0) || (c.ville && c.ville.toLowerCase().indexOf(query) >= 0); }) : src).slice(0, 25);
  if (!res.length) { drop.style.display = 'none'; return; }
  drop.innerHTML = res.map(function(c){
    return '<div class="piece-option" onmousedown="event.preventDefault();selectPcClient(' + c.id + ',\'' + String(c.nom||'').replace(/'/g,'&#39;') + '\')">' +
      '<div style="font-size:14px;font-weight:600">' + esc(c.nom) + '</div>' +
      (c.ville ? '<div style="font-size:13px;color:var(--text3)">' + esc(c.ville) + '</div>' : '') + '</div>';
  }).join('');
  drop.style.display = 'block';
}
function selectPcClient(id, nom) {
  var inp = document.getElementById('pc-client-search'), hid = document.getElementById('pc-client');
  if (inp) inp.value = nom;
  if (hid) hid.value = id;
  var drop = document.getElementById('pc-client-drop'); if (drop) drop.style.display = 'none';
}
window.pcClientInput = pcClientInput; window.searchPcClient = searchPcClient; window.selectPcClient = selectPcClient;

function fermerModalPoint() {
  var m = document.getElementById('modal-point-carte');
  if (m) m.remove();
}
window.fermerModalPoint = fermerModalPoint;

function geocoderAdresse() {
  var adresse = [document.getElementById('pc-adresse').value, document.getElementById('pc-cp').value, document.getElementById('pc-ville').value].filter(Boolean).join(', ');
  if (!adresse) { alert('Renseignez au moins la ville.'); return; }
  var pays = (document.getElementById('pc-pays') || {}).value || 'France';
  fetch('/api/carte/geocode-adresse?pays=' + encodeURIComponent(pays) + '&q=' + encodeURIComponent(adresse))
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (d.found) {
        document.getElementById('pc-lat').value = d.lat.toFixed(6);
        document.getElementById('pc-lng').value = d.lng.toFixed(6);
        if (typeof toast === 'function') toast(TR('Coordonnées trouvées'), 'ti-check', 'var(--success)');
      } else alert(TR('Adresse introuvable. Saisissez les coordonnées manuellement.'));
    })
    .catch(function(e){ alert(TR('Erreur : ') + e.message); });
}
window.geocoderAdresse = geocoderAdresse;

function sauverPointCarte(id) {
  var data = {
    reseau: document.getElementById('pc-reseau').value,
    nom: document.getElementById('pc-nom').value.trim(),
    adresse: document.getElementById('pc-adresse').value.trim(),
    cp: document.getElementById('pc-cp').value.trim(),
    ville: document.getElementById('pc-ville').value.trim(),
    tel: document.getElementById('pc-tel').value.trim(),
    portable: (document.getElementById('pc-portable') || {}).value ? document.getElementById('pc-portable').value.trim() : '',
    email: document.getElementById('pc-email').value.trim(),
    lat: parseFloat(document.getElementById('pc-lat').value),
    lng: parseFloat(document.getElementById('pc-lng').value),
    client_id: (document.getElementById('pc-client') || {}).value || null,
    pays: (document.getElementById('pc-pays') || {}).value || 'France'
  };
  if (!data.nom || isNaN(data.lat) || isNaN(data.lng)) {
    alert('Nom, latitude et longitude sont obligatoires.');
    return;
  }
  // Champs additionnels gérés dans "Modifier" : priorité, zone/rayon, note
  var extra = {
    priorite: (document.getElementById('pc-priorite') || {}).value || null,
    zone: (document.getElementById('pc-zone') || {}).value || '',
    rayon: (document.getElementById('pc-rayon') && document.getElementById('pc-rayon').value !== '') ? parseFloat(document.getElementById('pc-rayon').value) : null,
    note: (document.getElementById('pc-note') || {}).value || ''
  };
  var url = id ? '/api/carte/points/' + id : '/api/carte/points';
  var method = id ? 'PUT' : 'POST';
  fetch(url, { method: method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (!d.ok) { alert(TR('Erreur : ') + (d.error || 'inconnue')); return; }
      var pid = id || (d && (d.id || (d.point && d.point.id)));
      var suites = [];
      if (pid) {
        suites.push(fetch('/api/carte/points/' + pid + '/zone', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ zone: extra.zone, rayon_km: extra.rayon }) }));
        suites.push(fetch('/api/carte/points/' + pid + '/note', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: extra.note }) }));
        suites.push(fetch('/api/carte/points/' + pid + '/priorite', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ priorite: extra.priorite }) }).then(function(r){ return r.json(); }).then(function(pr){ if (pr && pr.error) console.warn('Priorité :', pr.error); }).catch(function(){}));
      }
      Promise.all(suites).catch(function(){}).then(function(){
        fermerModalPoint();
        // Modification d'un point existant : on garde la vue actuelle (pas de recadrage France).
        // Nouveau point : rechargement complet pour l'intégrer proprement.
        if (id) rafraichirPointsCarte(); else chargerPoints();
        if (typeof toast === 'function') toast(id ? 'Distributeur modifié' : 'Distributeur ajouté', 'ti-check', 'var(--success)');
      });
    })
    .catch(function(e){ alert(TR('Erreur : ') + e.message); });
}
window.sauverPointCarte = sauverPointCarte;

function supprimerPointCarte(id) {
  var p = _cartePoints.find(function(x){ return x.id === id; });
  if (!confirm('Supprimer "' + (p ? p.nom : 'ce distributeur') + '" de la carte ?')) return;
  fetch('/api/carte/points/' + id, { method: 'DELETE' })
    .then(function(r){ return r.json(); })
    .then(function(){
      rafraichirPointsCarte(); // conserve la vue actuelle
      if (typeof toast === 'function') toast(TR('Distributeur supprimé'), 'ti-check', 'var(--success)');
    })
    .catch(function(e){ alert(TR('Erreur : ') + e.message); });
}
window.supprimerPointCarte = supprimerPointCarte;

function importerKML(files) {
  if (!files || !files.length) return;
  var arr = Array.from(files);
  toast('Import de ' + arr.length + ' fichier(s)…', 'ti-loader-2');

  function detectReseau(fname) {
    fname = fname.toLowerCase();
    if (fname.indexOf('bastide') >= 0) return 'bastide';
    if (fname.indexOf('providom') >= 0) return 'providom';
    if (fname.indexOf('districlub') >= 0 || fname.indexOf('distri') >= 0 || fname.indexOf('dcm') >= 0) return 'districlub';
    if (fname.indexOf('negoci') >= 0 || fname.indexOf('négoci') >= 0) return 'negocies';
    if (fname.indexOf('base') >= 0) return 'base';
    return null;
  }

  // Traitement SÉQUENTIEL pour éviter les race conditions
  var idx = 0;
  var resultats = [];
  function suivant() {
    if (idx >= arr.length) {
      // Tout est importé
      var msg = resultats.map(function(r){ return r.label + ': ' + r.inserted; }).join(' — ');
      if (typeof toast === 'function') toast(TR('Import terminé : ') + msg, 'ti-check', 'var(--success)');
      setTimeout(chargerPoints, 300);
      return;
    }
    var file = arr[idx];
    var reseau = detectReseau(file.name);
    if (!reseau) {
      resultats.push({ label: file.name + ' (réseau inconnu)', inserted: 0 });
      idx++; suivant(); return;
    }
    var reader = new FileReader();
    reader.onload = function() {
      fetch('/api/carte/import-kml', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reseau: reseau, kml: reader.result })
      }).then(function(r){ return r.json(); }).then(function(d){
        resultats.push({ label: (RESEAUX_CONFIG[reseau]||{}).label || reseau, inserted: d.inserted || 0 });
        idx++; suivant();
      }).catch(function(e){
        resultats.push({ label: reseau + ' (erreur)', inserted: 0 });
        idx++; suivant();
      });
    };
    reader.readAsText(file);
  }
  suivant();
}
window.importerKML = importerKML;



// ═══════════════════════════════════════════════════════════════════
function _ouvrirCmd(id) {
  if (typeof STATE !== 'undefined') STATE.view = 'commandes';
  if (typeof render === 'function') render();
  setTimeout(function() { if (typeof modalCommande === 'function') modalCommande(id); }, 600);
}
window._ouvrirCmd = _ouvrirCmd;

// Onglet Notes dans fiche commande
function renderNotesTab(cmdId) {
  if (!cmdId) return Promise.resolve('<div style="padding:20px;color:#aaa;text-align:center">'+TR("Enregistrez d'abord la commande.")+'</div>');
  return fetch('/api/commandes/' + cmdId + '/notes')
    .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(notes) {
      var html = '<div style="display:flex;flex-direction:column;height:370px;overflow:hidden">';
      html += '<div id="notes-list-' + cmdId + '" style="flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px">';
      if (notes.length) {
        for (var i = 0; i < notes.length; i++) {
          var n = notes[i];
          var ini = String(n.user_nom||'?')[0].toUpperCase();
          var dt = String(n.created_at||'').slice(0,16).replace('T',' ');
          html += '<div style="background:rgba(255,255,255,.7);border:0.5px solid #dde3ef;border-radius:9px;padding:10px 12px">';
          html += '<div style="display:flex;align-items:center;gap:7px;margin-bottom:5px">';
          html += '<span style="background:#2e7cf6;color:#fff;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700">' + _esc(ini) + '</span>';
          html += '<strong style="font-size:14px">' + _esc(n.user_nom||'?') + '</strong>';
          html += '<span style="font-size:12px;color:#aaa;margin-left:auto">' + dt + '</span>';
          html += '<button onclick="_delNote(' + cmdId + ',' + n.id + ')" style="background:none;border:none;cursor:pointer;color:#ccc;font-size:13px;line-height:1;padding:0 2px">✕</button>';
          html += '</div>';
          html += '<div style="font-size:14px;line-height:1.5;white-space:pre-wrap">' + _esc(n.texte) + '</div>';
          html += '</div>';
        }
      } else {
        html += '<div style="padding:24px;text-align:center;color:#aaa;font-size:14px">'+TR("Aucune note — ajoutez un commentaire ci-dessous.")+'</div>';
      }
      html += '</div>';
      html += '<div style="padding:10px 12px;border-top:0.5px solid #dde3ef;display:flex;gap:8px">';
      html += '<textarea id="ni-' + cmdId + '" placeholder="'+TR("Ajouter une note...")+'" rows="2" style="flex:1;border:0.5px solid #c0c8d8;border-radius:7px;padding:6px 9px;font-size:14px;resize:none;background:rgba(255,255,255,.8)"></textarea>';
      html += '<button onclick="_sendNote(' + cmdId + ')" style="background:#2e7cf6;color:#fff;border:none;border-radius:7px;padding:7px 12px;cursor:pointer;font-size:14px">&#10148;</button>';
      html += '</div>';
      html += '</div>';
      return html;
    })
    .catch(function(e) { return '<div style="padding:20px;color:red;font-size:14px">Erreur : ' + String(e.message) + '</div>'; });
}
window.renderNotesTab = renderNotesTab;

function _sendNote(cmdId) {
  var inp = document.getElementById('ni-' + cmdId);
  if (!inp || !inp.value.trim()) return;
  var txt = inp.value.trim();
  fetch('/api/commandes/' + cmdId + '/notes', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({texte: txt})})
    .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function() {
      inp.value = '';
      var tab = document.getElementById('tab-notes');
      if (tab) renderNotesTab(cmdId).then(function(h) { tab.innerHTML = h; });
    })
    .catch(function(e) { alert(TR('Erreur : ') + e.message); });
}
window._sendNote = _sendNote;

function _delNote(cmdId, noteId) {
  if (!confirm(TR('Supprimer cette note ?'))) return;
  fetch('/api/commandes/' + cmdId + '/notes/' + noteId, {method:'DELETE'})
    .then(function() {
      var tab = document.getElementById('tab-notes');
      if (tab) renderNotesTab(cmdId).then(function(h) { tab.innerHTML = h; });
    })
    .catch(function(e) { alert(TR('Erreur : ') + e.message); });
}
window._delNote = _delNote;


// ══════════════════════════════════════════════════════════════════
// MODULE PRÊTS — bons de prêt / essai de fauteuils aux distributeurs
// ══════════════════════════════════════════════════════════════════
// Statuts de prêt : couleur (c) + icône (ic). Les icônes sont personnalisables ici,
// en un seul endroit (noms d'icônes Tabler : https://tabler.io/icons).
const PRET_STATUTS_UI = {
  brouillon:{l:'Brouillon',c:'#6b7280',ic:'ti-pencil'},
  envoye:   {l:'Envoyé',   c:'#2563eb',ic:'ti-send'},
  signe:    {l:'Signé',    c:'#16a34a',ic:'ti-writing-sign'},
  en_cours: {l:'En cours', c:'#0d9488',ic:'ti-clock-play'},
  retard:   {l:'En retard',c:'#dc2626',ic:'ti-alert-triangle'},
  prolonge: {l:'Prolongé', c:'#d97706',ic:'ti-calendar-plus'},
  cloture:  {l:'Clôturé',  c:'#374151',ic:'ti-circle-check'},
  rachete:  {l:'Racheté',  c:'#7c3aed',ic:'ti-cash'}
};
const PRET_FORMULES = { essai_court:'Essai court (15–30 j)', long_terme:'Prêt long terme (≥ 3 mois)' };
function pretBadge(s){ const u=PRET_STATUTS_UI[s]||{l:s,c:'#6b7280'}; return `<span style="display:inline-block;padding:2px 9px;border-radius:99px;font-size:13px;font-weight:600;color:#fff;background:${u.c}">${u.l}</span>`; }

// Sélecteur de statut en icônes (façon « Demandes d'infos ») : l'icône colorée = statut
// actuel, les grisées = les autres ; clic = change le statut.
function pretStatutIcons(p){
  return `<span style="display:inline-flex;align-items:center;gap:1px;white-space:nowrap">${Object.keys(PRET_STATUTS_UI).map(k=>{
    const u=PRET_STATUTS_UI[k], on=(p.statut===k);
    if(on) return `<span title="${u.l}" onclick="event.stopPropagation();setPretStatutInline(${p.id},'${k}')" style="cursor:pointer;background:${u.c};color:#fff;width:25px;height:25px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;flex:none"><i class="ti ${u.ic}" style="font-size:16px"></i></span>`;
    return `<span onclick="event.stopPropagation();setPretStatutInline(${p.id},'${k}')" title="${u.l}" style="cursor:pointer;width:23px;height:25px;display:inline-flex;align-items:center;justify-content:center;flex:none"><i class="ti ${u.ic}" style="font-size:18px;color:var(--text3);opacity:.35"></i></span>`;
  }).join('')}</span>`;
}
window.pretStatutIcons = pretStatutIcons;

// Change le statut d'un prêt en un clic. Cas particuliers : « Prolongé » demande une date,
// « Signé » ouvre la fenêtre de signature (pour saisir la date). Les autres sont directs.
async function setPretStatutInline(id, statut){
  try{
    if(statut==='prolonge'){
      const d = prompt(TR('Prorogation accordée jusqu\'au (AAAA-MM-JJ) :'));
      if(!d) return;
      await API.setPretStatut(id, 'prolonge', {prorogation_date:d});
    } else if(statut==='signe'){
      modalPretSigneMail(id);   // saisie de la date de signature
      return;
    } else {
      await API.setPretStatut(id, statut, null);
    }
    toast(TR('Statut mis à jour'),'ti-check','var(--success)');
    if(STATE.view==='prets') render();
  }catch(e){ toast('Erreur : '+e.message,'ti-alert-circle','var(--danger)'); }
}
window.setPretStatutInline = setPretStatutInline;

async function renderPrets(ttl,c,a){
  ttl.textContent = TR('Prêts') || 'Prêts';
  a.innerHTML = `<button class="btn sm" onclick="ouvrirContratsModal()"><i class="ti ti-file-description"></i>${TR('Contrats-cadre')}</button><button class="btn sm" onclick="creerPretDepuisPennylane()"><i class="ti ti-brand-stripe"></i>${TR('Depuis Pennylane')}</button><button class="btn sm primary" onclick="modalPret()"><i class="ti ti-plus"></i>${TR('Nouveau bon de prêt')}</button>`;
  let rows=[]; try{ rows = await API.prets(); }catch(e){ c.innerHTML=`<div class="empty"><i class="ti ti-alert-circle"></i>Erreur : ${esc(e.message)}</div>`; return; }
  if(!rows.length){ c.innerHTML=`<div class="empty"><i class="ti ti-file-certificate"></i>${TR('Aucun bon de prêt pour le moment.')}<br><span style="font-size:14px;color:var(--text3)">${TR('Créez-en un depuis une fiche distributeur ou avec « Nouveau bon de prêt ».')}</span></div>`; return; }
  const fdate = d => d ? fd((''+d).slice(0,10)) : '—';
  const lignes = rows.map(p=>{
    const arts = pretArticlesOf(p);
    const nom = esc(p.client_nom_actuel || p.distributeur_nom || '—');
    const mat = esc(arts.map(a=>a.designation).filter(Boolean).join(', ') || p.designation || '—');
    const serie = esc(arts.map(a=>a.num_serie).filter(Boolean).join(', ') || p.num_serie || '—');
    const sign = p.signed_at ? `<span title="Signé le ${fdate(p.signed_at)}" style="color:#16a34a;margin-left:4px"><i class="ti ti-writing-sign"></i></span>` : '';
    return `<tr>
      <td>${nom}</td>
      <td>${mat}</td>
      <td class="mono" style="white-space:nowrap">${serie}</td>
      <td style="font-size:14px">${esc(PRET_FORMULES[p.formule]||p.formule||'—')}</td>
      <td style="white-space:nowrap">${fdate(p.date_remise)}</td>
      <td style="white-space:nowrap">${fdate(p.date_retour_prevue)}</td>
      <td style="white-space:nowrap">${pretStatutIcons(p)}${sign}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn sm" title="Aperçu" onclick="apercuPret(${p.id})"><i class="ti ti-eye"></i></button>
        <button class="btn sm" title="PDF" onclick="exportPretPDF(${p.id})"><i class="ti ti-file-type-pdf"></i></button>
        <button class="btn sm" title="Lien de signature (test, sans e-mail)" onclick="montrerLienSignature(location.origin+'/pret/'+'${p.token_signature||''}')"><i class="ti ti-link"></i></button>
        <button class="btn sm" title="Envoyer le lien de signature" onclick="envoyerPretLien(${p.id})"><i class="ti ti-mail"></i></button>
        <button class="btn sm" title="Modifier" onclick="modalPret(${p.id})"><i class="ti ti-pencil"></i></button>
        <button class="btn sm danger" title="Supprimer" onclick="supprPret(${p.id})"><i class="ti ti-trash"></i></button>
      </td></tr>`;
  }).join('');
  c.innerHTML = `<style>#prets-tbl th,#prets-tbl td{padding:13px 18px;vertical-align:middle}#prets-tbl tbody tr{border-top:0.5px solid var(--border-s,#e8eaed)}#prets-tbl tbody tr:hover{background:var(--surface-2,rgba(0,0,0,.02))}</style>
    <div class="card" style="padding:0;overflow:auto">
    <table class="table" id="prets-tbl"><thead><tr>
      <th>${TR('Distributeur')}</th><th>${TR('Matériel')}</th><th>${TR('N° de série')}</th><th>${TR('Formule')}</th>
      <th>${TR('Remise')}</th><th>${TR('Retour prévu')}</th><th>${TR('Statut')}</th><th></th>
    </tr></thead><tbody>${lignes}</tbody></table></div>`;
}
window.renderPrets = renderPrets;

async function modalPret(id, prefillClientId){
  await ensureClientsCache();
  let p = { formule:'essai_court', statut:'brouillon' };
  if(id){ try{ p = await API.pret(id); }catch(e){ toast('Erreur : '+e.message,'ti-alert-circle','var(--danger)'); return; } }
  else if(prefillClientId){
    try{ const cl = await API.client(prefillClientId);
      p.client_id = cl.id; p.distributeur_nom = cl.nom; p.contact = cl.contact||''; p.email = cl.email||'';
      p.tel = cl.tel||cl.portable||''; p.adresse = [cl.adresse, cl.cp, cl.ville].filter(Boolean).join(' ');
    }catch(e){}
  }
  // liste de noms pour l'autocomplétion (datalist) ; noms dédoublonnés
  const noms = [...new Set((window._clientsCache||[]).map(c=>c.nom).filter(Boolean))];
  const dl = noms.map(n=>`<option value="${esc(n)}">`).join('');
  // articles : soit la liste enregistrée, soit une ligne dérivée de l'ancien format
  let arts = Array.isArray(p.articles) ? p.articles : (typeof p.articles==='string' && p.articles ? (()=>{try{return JSON.parse(p.articles);}catch(_){return [];}})() : []);
  if(!arts.length && (p.designation || p.num_serie || p.valeur_ht!=null)) arts = [{designation:p.designation||'', reference:'', num_serie:p.num_serie||'', prix:(p.valeur_ht!=null?p.valeur_ht:'')}];
  if(!arts.length) arts = [{designation:'',reference:'',num_serie:'',prix:''}];
  const today = new Date().toISOString().slice(0,10);
  showModal(`
    <div class="modal-header"><i class="ti ti-file-certificate" style="color:var(--accent)"></i><h2>${id?TR('Modifier le bon de prêt'):TR('Nouveau bon de prêt')}</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body">
      <input type="hidden" id="pret-id" value="${id||''}">
      <input type="hidden" id="pret-client-id" value="${p.client_id||''}">
      <input type="hidden" id="pret-liv-id" value="${p.livraison_client_id||''}">
      <input type="hidden" id="pret-bdc-vfid" value="${esc(p.bdc_vf_id||'')}">
      <div class="form-group" style="position:relative"><label class="form-label">${TR('Distributeur emprunteur')}</label>
        <input class="form-input" id="pret-client-search" autocomplete="off" placeholder="${TR('Taper le nom du distributeur…')}" value="${esc(p.distributeur_nom||'')}" oninput="pretDistribInput('pret-client')" onfocus="pretDistribSearch('pret-client',this.value)" onblur="setTimeout(function(){var d=document.getElementById('pret-client-drop');if(d)d.style.display='none'},150)">
        <div id="pret-client-drop" class="piece-dropdown" style="display:none"></div></div>
      <div id="pret-cc-hint" style="margin:-4px 0 8px"></div>
      <div class="grid-2">
        <div class="form-group"><label class="form-label">${TR('Contact')}</label><input class="form-input" id="pret-contact" value="${esc(p.contact||'')}"></div>
        <div class="form-group"><label class="form-label">${TR('Email')}</label><input class="form-input" id="pret-email" type="email" value="${esc(p.email||'')}"></div>
        <div class="form-group"><label class="form-label">${TR('Téléphone')}</label><input class="form-input" id="pret-tel" value="${esc(fmtTel(p.tel||''))}"></div>
        <div class="form-group"><label class="form-label">${TR('Formule')}</label>
          <select class="form-input" id="pret-formule" onchange="pretMajRetour()">
            <option value="essai_court" ${p.formule!=='long_terme'?'selected':''}>${PRET_FORMULES.essai_court}</option>
            <option value="long_terme" ${p.formule==='long_terme'?'selected':''}>${PRET_FORMULES.long_terme}</option>
          </select></div>
      </div>
      <div class="form-group"><label class="form-label">${TR('Adresse du distributeur')}</label><input class="form-input" id="pret-adresse" value="${esc(p.adresse||'')}"></div>
      <div class="form-group" style="margin-bottom:6px">
        <label style="display:flex;align-items:center;gap:8px;font-size:15px;cursor:pointer;font-weight:500">
          <input type="checkbox" id="pret-liv-autre" ${p.livraison_autre?'checked':''} onchange="pretToggleLivraison()" style="accent-color:var(--accent)">
          ${TR('Autre adresse de livraison')}</label>
      </div>
      <div id="pret-liv-block" style="${p.livraison_autre?'':'display:none'};border-left:2px solid var(--border);padding-left:12px;margin-bottom:10px">
        <div class="form-group" style="position:relative"><label class="form-label">${TR('Distributeur / destinataire de livraison')}</label>
          <input class="form-input" id="pret-liv-search" autocomplete="off" placeholder="${TR('Distributeur enregistré, ou saisie manuelle…')}" value="${esc(p.livraison_nom||'')}" oninput="pretDistribInput('pret-liv')" onfocus="pretDistribSearch('pret-liv',this.value)" onblur="setTimeout(function(){var d=document.getElementById('pret-liv-drop');if(d)d.style.display='none'},150)">
          <div id="pret-liv-drop" class="piece-dropdown" style="display:none"></div></div>
        <div class="form-group"><label class="form-label">${TR('Adresse de livraison')}</label><input class="form-input" id="pret-liv-adresse" value="${esc(p.livraison_adresse||'')}"></div>
      </div>
      <div class="form-group"><label class="form-label">${TR('N° de bon de commande (Pennylane / VosFactures)')}</label>
        <div style="display:flex;gap:6px">
          <input class="form-input mono" id="pret-bdc-vf" value="${esc(p.bdc_vf||'')}" placeholder="ex. BC-2026-08-2" style="flex:1">
          <button type="button" class="btn sm" title="Ouvrir la pièce" onclick="ouvrirPretVF()"><i class="ti ti-external-link"></i></button>
          <button type="button" class="btn sm primary" onclick="importerPretVF()" title="Récupérer distributeur et matériel depuis la pièce"><i class="ti ti-download"></i> ${TR('Importer')}</button>
        </div>
        <div id="pret-vf-msg" style="font-size:13px;color:var(--text3);margin-top:3px"></div></div>
      <div class="form-group">
        <label class="form-label" style="display:flex;justify-content:space-between;align-items:center">${TR('Matériel prêté')}
          <button type="button" class="btn sm" onclick="addPretArticle()"><i class="ti ti-plus"></i> ${TR('Ajouter')}</button></label>
        <div style="display:grid;grid-template-columns:1fr 90px 120px 90px 30px;gap:6px;font-size:13px;color:var(--text3);margin-bottom:4px;padding:0 2px">
          <span>${TR('Désignation / Modèle')}</span><span>${TR('Réf.')}</span><span>${TR('N° de série')}</span><span>${TR('Prix HT (€)')}</span><span></span></div>
        <div id="pret-articles"></div>
        <div style="font-size:13px;color:var(--text3);margin-top:5px"><i class="ti ti-info-circle" style="font-size:14px;margin-right:2px;color:var(--accent)"></i>${TR('Renseignez le n° de série du fauteuil : le prêt est alors rattaché à l’unité dans le Parc démo (détenteur et échéance suivis automatiquement).')}</div>
        <div style="text-align:right;font-size:15px;margin-top:6px">${TR('Total HT')} : <b id="pret-total">0,00 €</b></div>
      </div>
      <div class="grid-2">
        <div class="form-group"><label class="form-label">${TR('Date de remise')}</label><input class="form-input" id="pret-remise" type="date" value="${(p.date_remise||'').slice(0,10)||today}" onchange="pretMajRetour(true)"></div>
        <div class="form-group"><label class="form-label">${TR('Date de retour prévue')}</label><input class="form-input" id="pret-retour" type="date" value="${(p.date_retour_prevue||'').slice(0,10)}"></div>
      </div>
      <div class="form-group"><label class="form-label">${TR('Observations sur l\'état initial')}</label><textarea class="form-input" id="pret-obs" rows="2">${esc(p.observations||'')}</textarea></div>
      <p style="font-size:13px;color:var(--text3);margin:0">${TR('Rappel automatique : Essai court → avant l\'échéance de retour (retour proposé à +30 j de la remise). Prêt long terme → rappel périodique (bilan trimestriel).')}</p>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">${t('btn_annuler')||'Annuler'}</button>
      <button class="btn primary" onclick="savePret()"><i class="ti ti-check"></i>${t('btn_enregistrer')||'Enregistrer'}</button>
    </div>`);
  arts.forEach(a=>addPretArticle(a));
  pretMajTotal();
  pretMajRetour();
  if(p.client_id) majContratCadreHint(p.client_id);
}
window.modalPret = modalPret;

function pretArticleRowHTML(a){
  a = a || {};
  return `<div class="pret-art-row" style="display:grid;grid-template-columns:1fr 90px 120px 90px 30px;gap:6px;margin-bottom:5px">
    <input class="form-input pa-des" value="${esc(a.designation||'')}" placeholder="Eloflex …">
    <input class="form-input pa-ref" value="${esc(a.reference||'')}">
    <input class="form-input mono pa-ser" value="${esc(a.num_serie||'')}">
    <input class="form-input pa-prix" type="number" step="0.01" value="${a.prix!=null&&a.prix!==''?a.prix:''}" oninput="pretMajTotal()">
    <button type="button" class="btn sm danger" onclick="this.closest('.pret-art-row').remove();pretMajTotal()"><i class="ti ti-x"></i></button>
  </div>`;
}
function addPretArticle(a){ const c=$('pret-articles'); if(!c) return; c.insertAdjacentHTML('beforeend', pretArticleRowHTML(a&&a.designation!==undefined?a:{})); }
window.addPretArticle = addPretArticle;
function lirePretArticles(){
  return [...document.querySelectorAll('#pret-articles .pret-art-row')].map(r=>({
    designation:(r.querySelector('.pa-des').value||'').trim(),
    reference:(r.querySelector('.pa-ref').value||'').trim(),
    num_serie:(r.querySelector('.pa-ser').value||'').trim(),
    prix: r.querySelector('.pa-prix').value!==''?parseFloat(r.querySelector('.pa-prix').value):null
  })).filter(a=>a.designation||a.reference||a.num_serie||a.prix!=null);
}
function pretMajTotal(){
  const tot = lirePretArticles().reduce((s,a)=>s+(a.prix||0),0);
  const el=$('pret-total'); if(el) el.textContent = tot.toLocaleString('fr-FR',{minimumFractionDigits:2,maximumFractionDigits:2})+' €';
}
window.pretMajTotal = pretMajTotal;
// Retour prévu adapté à la formule : Essai court → remise + 30 j.
// force=true (changement de date de remise) recalcule ; sinon ne remplit que si vide.
function pretMajRetour(force){
  const f = gv('pret-formule'); const remise = gv('pret-remise'); const ret = $('pret-retour');
  if(!ret) return;
  if(f==='essai_court' && remise && (force || !ret.value)){
    const d = new Date(remise+'T00:00:00'); if(!isNaN(d)){ d.setDate(d.getDate()+30); ret.value = d.toISOString().slice(0,10); }
  }
}
window.pretMajRetour = pretMajRetour;

// ── Autocomplétion distributeur (même composant déroulant que le reste de l'app) ──
// prefix = 'pret-client' (emprunteur) ou 'pret-liv' (livraison)
function pretDistribInput(prefix){
  const hid = $(prefix+'-id'); if(hid) hid.value=''; // saisie manuelle → plus de fiche liée
  pretDistribSearch(prefix, gv(prefix+'-search'));
}
window.pretDistribInput = pretDistribInput;
function pretDistribSearch(prefix, q){
  const drop = $(prefix+'-drop'); if(!drop) return;
  const src = window._clientsCache || [];
  const query = (q||'').toLowerCase().trim();
  const res = (query ? src.filter(c=> (c.nom&&c.nom.toLowerCase().includes(query)) || (c.ville&&c.ville.toLowerCase().includes(query))) : src).slice(0,25);
  if(!res.length){ drop.style.display='none'; return; }
  drop.innerHTML = res.map(c=>'<div class="piece-option" onmousedown="event.preventDefault();pretDistribSelect(\''+prefix+'\','+c.id+',\''+String(c.nom||'').replace(/\x27/g,'&#39;')+'\')">'+
    '<div style="font-size:14px;font-weight:600">'+esc(c.nom)+'</div>'+
    (c.ville?'<div style="font-size:13px;color:var(--text3)">'+esc(c.ville)+'</div>':'')+'</div>').join('');
  drop.style.display='block';
}
window.pretDistribSearch = pretDistribSearch;
function pretDistribSelect(prefix, id, nom){
  const inp=$(prefix+'-search'), hid=$(prefix+'-id'); if(inp) inp.value=nom; if(hid) hid.value=id;
  const drop=$(prefix+'-drop'); if(drop) drop.style.display='none';
  if(prefix==='pret-client'){ pretRemplirClient(id); majContratCadreHint(id); } else pretRemplirLivraison(id);
}
window.pretDistribSelect = pretDistribSelect;
// Renseigne le champ distributeur depuis un nom (import BDC) : lie la fiche si le nom correspond
function pretSetDistrib(prefix, nom){
  const inp=$(prefix+'-search'); if(inp) inp.value = nom||'';
  const m = (window._clientsCache||[]).find(c=> (c.nom||'').toLowerCase() === (nom||'').toLowerCase());
  if(m){ pretDistribSelect(prefix, m.id, m.nom); } else { const hid=$(prefix+'-id'); if(hid) hid.value=''; }
}
window.pretSetDistrib = pretSetDistrib;

// Remplit (écrase toujours) contact / email / tél / adresse de l'emprunteur depuis la fiche
function pretRemplirClient(id){
  id = id || gv('pret-client-id'); if(!id) return;
  API.client(id).then(cl=>{
    $('pret-contact').value = cl.contact||'';
    $('pret-email').value   = cl.email||'';
    $('pret-tel').value     = cl.tel||cl.portable||'';
    $('pret-adresse').value = [cl.adresse, cl.cp, cl.ville].filter(Boolean).join(' ');
  }).catch(()=>{});
}
window.pretRemplirClient = pretRemplirClient;
function pretRemplirLivraison(id){
  if(!id) return;
  API.client(id).then(cl=>{ $('pret-liv-adresse').value = [cl.adresse, cl.cp, cl.ville].filter(Boolean).join(' '); }).catch(()=>{});
}
window.pretRemplirLivraison = pretRemplirLivraison;
function pretToggleLivraison(){
  const on = $('pret-liv-autre') && $('pret-liv-autre').checked;
  const b = $('pret-liv-block'); if(b) b.style.display = on ? '' : 'none';
}
window.pretToggleLivraison = pretToggleLivraison;

function ouvrirPretVF(){
  const num = (gv('pret-bdc-vf')||'').trim();
  const vfid = gv('pret-bdc-vfid')||null;
  if(!num && !vfid){ toast(TR('Renseigne d\'abord le numéro'),'ti-alert-circle','var(--warning)'); return; }
  ouvrirDansVF(vfid, num);
}
window.ouvrirPretVF = ouvrirPretVF;

async function importerPretVF(){
  const num = (gv('pret-bdc-vf')||'').trim();
  const msg = $('pret-vf-msg');
  if(!num){ if(msg) msg.innerHTML='<span style="color:var(--danger)">'+TR('Indique d’abord un numéro.')+'</span>'; return; }
  if(msg) msg.innerHTML='<i class="ti ti-loader-2"></i> '+TR('Recherche du bon de commande…');
  try{
    // On tente d'abord Pennylane (BC-…, devis, factures), puis VosFactures en repli
    let r = null;
    try{ const pl = await API.pennylane_bdc_lookup(num); if(pl && pl.found) r = pl; }catch(_){}
    if(!r){ r = await API.vfBdcLookup(num); }
    if(r && r.configured===false){ if(msg) msg.innerHTML='<span style="color:var(--danger)">Aucun système (Pennylane / VosFactures) configuré.</span>'; return; }
    if(!r || !r.found){ if(msg) msg.innerHTML='<span style="color:var(--warning)">'+TR('Bon de commande introuvable (Pennylane / VosFactures)')+'</span>'; return; }
    if(r.vf_id!=null) $('pret-bdc-vfid').value = String(r.vf_id);
    if(r.numero) $('pret-bdc-vf').value = r.numero;
    if(r.distributeur){ pretSetDistrib('pret-client', r.distributeur); }
    // Formule déduite du sujet du document (essai court / long terme)
    if(r.formule){ const fs=$('pret-formule'); if(fs){ fs.value=r.formule; } }
    // remplace les lignes articles par celles du BDC
    const cont = $('pret-articles'); if(cont) cont.innerHTML='';
    (r.lignes||[]).forEach(l=>addPretArticle({designation:l.designation||'', reference:l.reference||'', num_serie:(l.num_serie||''), prix:(l.prix!=null?l.prix:'')}));
    if(!(r.lignes||[]).length) addPretArticle({});
    // n° de série global détecté → sur la première ligne fauteuil si vide
    if(r.num_serie){ const first=document.querySelector('#pret-articles .pa-ser'); if(first && !first.value) first.value=r.num_serie; }
    pretMajTotal();
    pretMajRetour();
    // Contrat-cadre du distributeur : on crée le brouillon (idempotent) puis on affiche le statut
    const cidLie = gv('pret-client-id');
    if(cidLie){
      try{ await API.createContratCadre({ client_id: cidLie, distributeur_nom: (gv('pret-client-search')||r.distributeur||null) }); }catch(_){}
      majContratCadreHint(cidLie);
    }
    var note = (r.source==='pennylane' && r.est_pret===false) ? ' <span style="color:#d97706">— ⚠ ce document ne semble pas être un prêt</span>' : '';
    if(msg) msg.innerHTML='<span style="color:#16a34a">'+((r.lignes||[]).length)+' '+TR('ligne(s) importée(s)')+(r.total_ht?(' — '+TR('total')+' '+Number(r.total_ht).toLocaleString('fr-FR',{minimumFractionDigits:2,maximumFractionDigits:2})+' € HT'):'')+'</span>'+note;
  }catch(e){ if(msg) msg.innerHTML='<span style="color:var(--danger)">Erreur : '+esc(e.message)+'</span>'; }
}
window.importerPretVF = importerPretVF;

// Créer un bon de prêt directement depuis un BDC de prêt Pennylane
async function creerPretDepuisPennylane(){
  const num = prompt(TR('N° du bon de commande de prêt Pennylane (ex. BC-2026-08-2) :'));
  if(!num || !num.trim()) return;
  await modalPret();                       // ouvre un nouveau bon de prêt vierge
  const f = $('pret-bdc-vf'); if(f) f.value = num.trim();
  await importerPretVF();                   // pré-remplit distributeur / matériel / réf / prix / formule
}
window.creerPretDepuisPennylane = creerPretDepuisPennylane;

async function savePret(){
  const cid = gv('pret-client-id');
  const nom = (gv('pret-client-search')||'').trim() || (cid ? ((window._clientsCache||[]).find(c=>String(c.id)===String(cid))||{}).nom : '');
  const articles = lirePretArticles();
  const total = articles.reduce((s,a)=>s+(a.prix||0),0);
  const livAutre = !!($('pret-liv-autre') && $('pret-liv-autre').checked);
  const data = {
    client_id: cid||null, distributeur_nom: nom||null,
    contact: gv('pret-contact')||null, email: gv('pret-email')||null, tel: gv('pret-tel')||null,
    adresse: gv('pret-adresse')||null, formule: gv('pret-formule')||'essai_court',
    bdc_vf: gv('pret-bdc-vf')||null, bdc_vf_id: gv('pret-bdc-vfid')||null,
    articles, valeur_ht: total||null,
    livraison_autre: livAutre,
    livraison_client_id: livAutre ? (gv('pret-liv-id')||null) : null,
    livraison_nom: livAutre ? (gv('pret-liv-search')||null) : null,
    livraison_adresse: livAutre ? (gv('pret-liv-adresse')||null) : null,
    designation: (articles[0]&&articles[0].designation)||null, num_serie: (articles[0]&&articles[0].num_serie)||null,
    date_remise: gv('pret-remise')||null, date_retour_prevue: gv('pret-retour')||null,
    observations: gv('pret-obs')||null
  };
  const id = gv('pret-id');
  try{
    if(id){ await API.updatePret(id, data); } else { await API.createPret(data); }
    closeModal(); toast(TR('Bon de prêt enregistré'),'ti-check','var(--success)');
    if(STATE.view==='prets') render();
  }catch(e){ toast('Erreur : '+e.message,'ti-alert-circle','var(--danger)'); }
}
window.savePret = savePret;

function menuPretStatut(id){
  showModal(`<div class="modal-header"><i class="ti ti-adjustments" style="color:var(--accent)"></i><h2>${TR('Statut du prêt')}</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body" style="display:flex;flex-direction:column;gap:7px">
      <button class="btn primary" onclick="modalPretSigneMail(${id})"><i class="ti ti-mail-check"></i> ${TR('Offre de prêt signée par mail')}</button>
      <button class="btn" onclick="pretStatut(${id},'en_cours')">${PRET_STATUTS_UI.en_cours.l}</button>
      <button class="btn" onclick="pretStatut(${id},'prolonge')">${PRET_STATUTS_UI.prolonge.l} (${TR('choisir une date')})</button>
      <button class="btn success" onclick="pretStatut(${id},'cloture')">${PRET_STATUTS_UI.cloture.l} — ${TR('retour effectué')}</button>
      <button class="btn" onclick="pretStatut(${id},'rachete')">${PRET_STATUTS_UI.rachete.l}</button>
      <button class="btn danger" onclick="pretStatut(${id},'retard')">${PRET_STATUTS_UI.retard.l}</button>
    </div>`);
}
window.menuPretStatut = menuPretStatut;

// Enregistre une signature reçue par e-mail (hors ligne), avec la date choisie
function modalPretSigneMail(id){
  const today = new Date().toISOString().slice(0,10);
  showModal(`<div class="modal-header"><i class="ti ti-mail-check" style="color:var(--accent)"></i><h2>${TR('Offre de prêt signée par mail')}</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body">
      <p style="font-size:15px;color:var(--text2);margin-top:0">${TR('Le distributeur a renvoyé le bon signé par e-mail. Indiquez la date de signature.')}</p>
      <div class="form-group"><label class="form-label">${TR('Date de signature')}</label><input class="form-input" id="pret-signe-date" type="date" value="${today}" style="max-width:200px"></div>
    </div>
    <div class="modal-footer"><button class="btn" onclick="closeModal()">${t('btn_annuler')||'Annuler'}</button><button class="btn primary" onclick="validerSigneMail(${id})"><i class="ti ti-check"></i>${t('btn_enregistrer')||'Enregistrer'}</button></div>`);
}
window.modalPretSigneMail = modalPretSigneMail;
async function validerSigneMail(id){
  const d = gv('pret-signe-date'); if(!d){ toast(TR('Date requise'),'ti-alert-circle','var(--warning)'); return; }
  try{ await API.signePretMail(id, d); closeModal(); toast(TR('Offre de prêt signée par mail'),'ti-check','var(--success)'); if(STATE.view==='prets') render(); }
  catch(e){ toast('Erreur : '+e.message,'ti-alert-circle','var(--danger)'); }
}
window.validerSigneMail = validerSigneMail;

async function pretStatut(id, statut){
  let extra=null;
  if(statut==='prolonge'){ const d = prompt(TR('Prorogation accordée jusqu\'au (AAAA-MM-JJ) :')); if(!d) return; extra={prorogation_date:d}; }
  try{ await API.setPretStatut(id, statut, extra); closeModal(); toast(TR('Statut mis à jour'),'ti-check','var(--success)');
    if(STATE.view==='prets') render();
  }catch(e){ toast('Erreur : '+e.message,'ti-alert-circle','var(--danger)'); }
}
window.pretStatut = pretStatut;

async function envoyerPretLien(id){
  let p; try{ p = await API.pret(id); }catch(e){ toast('Erreur : '+e.message,'ti-alert-circle','var(--danger)'); return; }
  const dest = p.email || p.client_email_actuel || '';
  const email = prompt(TR('Envoyer le lien de signature à :'), dest);
  if(!email) return;
  // génère le PDF (pour le joindre au mail : option signature manuelle)
  let pdfData=null;
  try{ if(typeof PDF!=='undefined' && PDF.pretDoc) pdfData = PDF.pretDoc(p).output('datauristring'); }catch(e){}
  try{ const r = await API.envoyerPret(id, email, pdfData); toast(TR('Lien de signature envoyé à ')+r.to,'ti-mail','var(--success)');
    if(STATE.view==='prets') render();
  }catch(e){ toast('Erreur : '+e.message,'ti-alert-circle','var(--danger)'); }
}
window.envoyerPretLien = envoyerPretLien;

// Affiche le lien de signature d'un document pour le tester soi-même, sans envoi d'e-mail
function montrerLienSignature(url){
  showModal(`<div class="modal-header"><i class="ti ti-link" style="color:var(--accent)"></i><h2>${TR('Lien de signature')}</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body">
      <p style="font-size:15px;color:var(--text2);margin-top:0">${TR('Ouvre ce lien pour signer le document toi-même (test), sans envoyer d\'e-mail au distributeur.')}</p>
      <input class="form-input mono" id="lien-sign" value="${esc(url)}" readonly onclick="this.select()" style="font-size:14px">
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
        <button class="btn primary" onclick="window.open(document.getElementById('lien-sign').value,'_blank','noopener')"><i class="ti ti-external-link"></i> ${TR('Ouvrir la page de signature')}</button>
        <button class="btn" onclick="try{navigator.clipboard.writeText(document.getElementById('lien-sign').value);toast(TR('Lien copié'),'ti-copy')}catch(e){}"><i class="ti ti-copy"></i> ${TR('Copier le lien')}</button>
      </div>
    </div>`);
}
window.montrerLienSignature = montrerLienSignature;

async function supprPret(id){
  if(!confirm(TR('Supprimer ce bon de prêt ?'))) return;
  try{ await API.deletePret(id); toast(TR('Supprimé'),'ti-trash');
    if(STATE.view==='prets') render();
  }catch(e){ toast('Erreur : '+e.message,'ti-alert-circle','var(--danger)'); }
}
window.supprPret = supprPret;

async function apercuPret(id){
  let p; try{ p = await API.pret(id); }catch(e){ toast('Erreur : '+e.message,'ti-alert-circle','var(--danger)'); return; }
  showModal(`<div class="modal-header"><i class="ti ti-file-certificate" style="color:var(--accent)"></i><h2>${TR('Aperçu du bon de prêt')}</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body" style="max-height:70vh;overflow:auto;background:#fff">${pretBonHTML(p)}</div>
    <div class="modal-footer"><button class="btn" onclick="closeModal()">${TR('Fermer')}</button><button class="btn primary" onclick="exportPretPDF(${id})"><i class="ti ti-file-type-pdf"></i>PDF</button></div>`);
}
window.apercuPret = apercuPret;

async function exportPretPDF(id){
  let p; try{ p = await API.pret(id); }catch(e){ toast('Erreur : '+e.message,'ti-alert-circle','var(--danger)'); return; }
  if(typeof PDF!=='undefined' && PDF.pret){ PDF.pret(p); } else { toast('Générateur PDF indisponible','ti-alert-circle','var(--danger)'); }
}
window.exportPretPDF = exportPretPDF;

// Normalise la liste d'articles d'un prêt (JSON ou ancien format mono-ligne)
function pretArticlesOf(p){
  let a = p.articles;
  if(typeof a==='string'){ try{ a=JSON.parse(a); }catch(_){ a=null; } }
  if(!Array.isArray(a) || !a.length){
    if(p.designation || p.num_serie || p.valeur_ht!=null) return [{designation:p.designation||'', reference:'', num_serie:p.num_serie||'', prix:p.valeur_ht}];
    return [];
  }
  return a;
}
window.pretArticlesOf = pretArticlesOf;

// Gabarit HTML du bon (aperçu) — repris du modèle Eloflex
function pretBonHTML(p){
  const bx='&#9744;'; const fdi=d=>d?fd((''+d).slice(0,10)):'___ / ___ / ______';
  const formuleTxt = PRET_FORMULES[p.formule]||p.formule||'';
  return `<div style="font-family:Calibri,Arial,sans-serif;color:#222;font-size:12px;line-height:1.45;max-width:760px;margin:0 auto">
    <div style="text-align:center;color:#1F5C8C;font-size:18px;font-weight:bold;margin:0 0 3px">BON DE PRÊT — FAUTEUIL ROULANT ÉLECTRIQUE</div>
    <div style="text-align:center;font-style:italic;color:#666;font-size:12px;margin:0 0 10px;padding-bottom:7px;border-bottom:2px solid #1F5C8C">ELOFLEX SAS — Offre de prêt / essai (non valable sur les accessoires)</div>
    <table style="width:100%;border-collapse:collapse;margin:0 0 8px"><tr>
      <td style="border:1px solid #CCC;padding:6px 9px;vertical-align:top;width:50%"><b style="color:#1F5C8C">PRÊTEUR</b><br><b>ELOFLEX SAS</b><br>Contact SAV : ${esc(CURRENT_USER&&CURRENT_USER.nom||'')}</td>
      <td style="border:1px solid #CCC;padding:6px 9px;vertical-align:top;width:50%"><b style="color:#1F5C8C">DISTRIBUTEUR EMPRUNTEUR</b><br><b>${esc(p.distributeur_nom||'—')}</b><br>${esc(p.adresse||'')}<br>${esc(p.contact||'')} ${esc(fmtTel(p.tel||''))}<br>${esc(p.email||'')}${p.livraison_autre?`<br><span style="color:#1F5C8C">📦 Livraison : ${esc(p.livraison_nom||'')}${p.livraison_adresse?' — '+esc(p.livraison_adresse):''}</span>`:''}</td>
    </tr></table>
    <table style="width:100%;border-collapse:collapse;margin:0 0 8px"><tr>
      <td style="border:1px solid #CCC;padding:6px 9px;background:#F2F5F8;color:#1F5C8C;font-weight:bold;width:50%">FORMULE : ${esc(formuleTxt)}</td>
      <td style="border:1px solid #CCC;padding:6px 9px;background:#F2F5F8;color:#1F5C8C;font-weight:bold;width:50%">DURÉE</td>
    </tr><tr>
      <td style="border:1px solid #CCC;padding:6px 9px;vertical-align:top">${p.formule==='long_terme'?bx+' Prêt Long Terme (&ge; 3 mois)':bx+' Essai Court (15 à 30 j)'}</td>
      <td style="border:1px solid #CCC;padding:6px 9px;vertical-align:top">Date de remise : ${fdi(p.date_remise)}<br>Date de retour prévue : ${fdi(p.date_retour_prevue)}<br>Prorogation jusqu'au : ${fdi(p.prorogation_date)}</td>
    </tr></table>
    <table style="width:100%;border-collapse:collapse;margin:0 0 8px"><tr>
      <td style="border:1px solid #CCC;padding:5px 7px;background:#F2F5F8;font-weight:bold;font-size:11px">Désignation / Modèle</td>
      <td style="border:1px solid #CCC;padding:5px 7px;background:#F2F5F8;font-weight:bold;font-size:11px">Réf.</td>
      <td style="border:1px solid #CCC;padding:5px 7px;background:#F2F5F8;font-weight:bold;font-size:11px">N° de série</td>
      <td style="border:1px solid #CCC;padding:5px 7px;background:#F2F5F8;font-weight:bold;font-size:11px">Valeur HT</td>
    </tr>
    ${pretArticlesOf(p).map(a=>`<tr>
      <td style="border:1px solid #CCC;padding:6px 7px">${esc(a.designation||'')}</td>
      <td style="border:1px solid #CCC;padding:6px 7px">${esc(a.reference||'')}</td>
      <td style="border:1px solid #CCC;padding:6px 7px">${esc(a.num_serie||'')}</td>
      <td style="border:1px solid #CCC;padding:6px 7px">${a.prix!=null&&a.prix!==''?esc(Number(a.prix).toFixed(2))+' € HT':''}</td>
    </tr>`).join('')}
    <tr><td colspan="3" style="border:1px solid #CCC;padding:5px 7px;text-align:right;font-weight:bold">Total HT</td>
      <td style="border:1px solid #CCC;padding:5px 7px;font-weight:bold">${esc(Number(pretArticlesOf(p).reduce((s,a)=>s+(parseFloat(a.prix)||0),0)).toFixed(2))} € HT</td></tr></table>
    ${p.observations?`<p style="margin:0 0 8px;font-style:italic;color:#555;font-size:11px">Observations sur l'état initial : ${esc(p.observations)}</p>`:''}
    <div style="background:#1F5C8C;color:#fff;font-weight:bold;font-size:12px;padding:4px 9px">ENGAGEMENTS DE L'EMPRUNTEUR</div>
    <p style="margin:6px 0 6px;font-style:italic;color:#555;font-size:11px">Le distributeur déclare avoir pris connaissance du Contrat-cadre de prêt ELOFLEX et en accepter sans réserve toutes les conditions. Il confirme notamment :</p>
    <table style="width:100%;border-collapse:collapse;margin:0 0 8px;table-layout:fixed"><tr>
      <td style="padding:0 12px 0 0;vertical-align:top;width:50%;font-size:11px;line-height:1.5">
        <span style="color:#1F5C8C">&#9679;</span> Utiliser le matériel uniquement pour des essais patients supervisés par un ergothérapeute<br>
        <span style="color:#1F5C8C">&#9679;</span> Conserver l'emballage et les mousses de protection<br>
        <span style="color:#1F5C8C">&#9679;</span> Signaler immédiatement tout incident ou dommage à ELOFLEX
      </td>
      <td style="padding:0 0 0 12px;vertical-align:top;width:50%;font-size:11px;line-height:1.5">
        <span style="color:#1F5C8C">&#9679;</span> Maintenir le matériel en état quasi-neuf (Prêt Long Terme)<br>
        <span style="color:#1F5C8C">&#9679;</span> Assurer au moins 1 essai / mois (Prêt Long Terme)<br>
        <span style="color:#1F5C8C">&#9679;</span> Confirmer par e-mail le bon état du fauteuil avant retour<br>
        <span style="color:#1F5C8C">&#9679;</span> Prendre en charge les frais de retour (50 € HT / fauteuil)
      </td>
    </tr></table>
    <div style="background:#1F5C8C;color:#fff;font-weight:bold;font-size:12px;padding:4px 9px">CONDITIONS FINANCIÈRES EN CAS DE DOMMAGE OU PERTE</div>
    <table style="width:100%;border-collapse:collapse;margin:6px 0 6px;table-layout:fixed">
      <tr><td style="border:1px solid #CCC;padding:6px 9px;background:#F2F5F8;font-weight:bold;width:36%">Perte / destruction totale</td>
        <td style="border:1px solid #CCC;padding:6px 9px">Prix catalogue HT &minus; décote vétusté (5 % / mois, plafonnée à 30 %)</td></tr>
      <tr><td style="border:1px solid #CCC;padding:6px 9px;background:#F2F5F8;font-weight:bold">Dommages partiels / reconditionnement</td>
        <td style="border:1px solid #CCC;padding:6px 9px">Frais réels de remise en état (pièces détachées + main-d'œuvre) sur devis ELOFLEX</td></tr>
      <tr><td style="border:1px solid #CCC;padding:6px 9px;background:#F2F5F8;font-weight:bold">Emballage / mousses manquants</td>
        <td style="border:1px solid #CCC;padding:6px 9px">40 € HT supplémentaires, soit 90 € HT au total des frais de retour</td></tr>
    </table>
    <p style="margin:0 0 8px;font-size:11px"><strong>Option d'achat :</strong> <span style="font-style:italic;color:#555">l'emprunteur peut proposer le rachat du matériel à tout moment. Prix fixé d'un commun accord, formalisé par une facture de vente distincte.</span></p>
    <div style="background:#1F5C8C;color:#fff;font-weight:bold;font-size:12px;padding:4px 9px">SIGNATURES</div>
    <table style="width:100%;border-collapse:collapse;margin:8px 0 0"><tr>
      <td style="border:1px solid #CCC;padding:6px 9px;width:50%;vertical-align:top"><b>ELOFLEX SAS</b><br>${esc(p.signataire_eloflex||(CURRENT_USER&&CURRENT_USER.nom)||'')}<br><span style="font-size:10px;color:#777">Signé électroniquement le ${fd(((p.eloflex_date||p.created_at||new Date().toISOString())+'').slice(0,10))}</span></td>
      <td style="border:1px solid #CCC;padding:6px 9px;width:50%;vertical-align:top"><b>Distributeur</b><br>${p.signataire_nom?('Signé par : '+esc(p.signataire_nom)+(p.signed_at?' le '+fd((''+p.signed_at).slice(0,10)):'')):'Nom : _______________  « Lu et approuvé, bon pour accord »'}<br>${p.signature_data?`<img src="${p.signature_data}" style="max-height:60px;max-width:220px;margin-top:4px">`:'&nbsp;'}</td>
    </tr></table>
  </div>`;
}
window.pretBonHTML = pretBonHTML;

// ══════════════════════════════════════════════════════════════════
// ── CONTRAT-CADRE DE PRÊT (signé une fois par distributeur) ──
// ══════════════════════════════════════════════════════════════════
const CONTRAT_STATUTS_UI = {
  aucun:     { l:'Non créé',  c:'#9ca3af' },
  brouillon: { l:'Brouillon', c:'#6b7280' },
  envoye:    { l:'Envoyé',    c:'#d97706' },
  signe:     { l:'Signé',     c:'#16a34a' },
};
function contratBadge(s){ const u=CONTRAT_STATUTS_UI[s]||{l:s,c:'#6b7280'}; return `<span style="display:inline-block;padding:2px 9px;border-radius:99px;font-size:13px;font-weight:600;color:#fff;background:${u.c}">${u.l}</span>`; }

// Bandeau d'info dans la fenêtre du bon de prêt : le distributeur a-t-il signé son contrat-cadre ?
async function majContratCadreHint(clientId){
  const el = $('pret-cc-hint'); if(!el || !clientId) return;
  try{
    const cc = await API.contratCadreByClient(clientId);
    if(cc && cc.statut==='signe'){
      el.innerHTML = `<div style="font-size:13px;color:#16a34a;display:flex;align-items:center;gap:5px"><i class="ti ti-shield-check"></i> ${TR('Contrat-cadre signé')}${cc.signed_at?(' — '+fd((''+cc.signed_at).slice(0,10))):''}</div>`;
    } else if(cc && (cc.statut==='envoye'||cc.statut==='brouillon')){
      el.innerHTML = `<div style="font-size:13px;color:#d97706;display:flex;align-items:center;gap:6px;flex-wrap:wrap"><i class="ti ti-alert-triangle"></i> ${TR('Contrat-cadre')} : ${contratBadge(cc.statut)} — ${TR('non signé')} <a href="#" onclick="event.preventDefault();closeModal();modalContrat(${clientId})" style="color:var(--accent)">${TR('gérer')}</a></div>`;
    } else {
      el.innerHTML = `<div style="font-size:13px;color:#d97706;display:flex;align-items:center;gap:6px;flex-wrap:wrap"><i class="ti ti-alert-triangle"></i> ${TR('Aucun contrat-cadre pour ce distributeur.')} <a href="#" onclick="event.preventDefault();closeModal();modalContrat(${clientId})" style="color:var(--accent)">${TR('en créer un')}</a></div>`;
    }
  }catch(e){ el.innerHTML=''; }
}
window.majContratCadreHint = majContratCadreHint;

// Gestionnaire global : liste des contrats-cadre + création
async function ouvrirContratsModal(){
  await ensureClientsCache();
  let rows=[]; try{ rows = await API.contratsCadre(); }catch(e){}
  const lignes = rows.map(cc=>{
    const nom = esc(cc.client_nom_actuel || cc.distributeur_nom || '—');
    const sign = cc.signed_at ? `<span style="color:#16a34a;font-size:13px;margin-left:4px">${fd((''+cc.signed_at).slice(0,10))}</span>` : '';
    return `<tr style="border-top:0.5px solid var(--border)">
      <td style="padding:9px 10px">${nom}</td>
      <td style="padding:9px 10px">${contratBadge(cc.statut)}${sign}</td>
      <td style="padding:9px 10px;text-align:right;white-space:nowrap">
        <button class="btn sm" title="${TR('Gérer')}" onclick="modalContrat(${cc.client_id})"><i class="ti ti-pencil"></i></button>
        <button class="btn sm" title="Aperçu" onclick="apercuContrat(${cc.id})"><i class="ti ti-eye"></i></button>
        <button class="btn sm" title="PDF" onclick="exportContratPDF(${cc.id})"><i class="ti ti-file-type-pdf"></i></button>
      </td></tr>`;
  }).join('');
  showModal(`<div class="modal-header"><i class="ti ti-file-description" style="color:var(--accent)"></i><h2>${TR('Contrats-cadre de prêt')}</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body">
      <div class="form-group" style="position:relative"><label class="form-label">${TR('Créer / gérer pour un distributeur')}</label>
        <input class="form-input" id="cc-pick-search" autocomplete="off" placeholder="${TR('Taper le nom du distributeur…')}" oninput="ccPickInput()" onfocus="ccPickInput()" onblur="setTimeout(function(){var d=document.getElementById('cc-pick-drop');if(d)d.style.display='none'},150)">
        <div id="cc-pick-drop" class="piece-dropdown" style="display:none"></div></div>
      ${rows.length?`<div class="card" style="padding:0;overflow:auto;margin-top:6px"><table class="table" style="width:100%"><thead><tr>
        <th style="text-align:left;padding:9px 10px">${TR('Distributeur')}</th><th style="text-align:left;padding:9px 10px">${TR('Statut')}</th><th></th></tr></thead>
        <tbody>${lignes}</tbody></table></div>`:`<div class="empty" style="padding:20px"><i class="ti ti-file-description"></i>${TR('Aucun contrat-cadre pour le moment.')}</div>`}
    </div>`);
}
window.ouvrirContratsModal = ouvrirContratsModal;
function ccPickInput(){
  const drop=$('cc-pick-drop'); if(!drop) return;
  const q=(gv('cc-pick-search')||'').toLowerCase().trim();
  const src=window._clientsCache||[];
  const res=(q?src.filter(c=>c.nom&&c.nom.toLowerCase().includes(q)):src).filter(c=>c.type!=='Particulier').slice(0,25);
  if(!res.length){ drop.style.display='none'; return; }
  drop.innerHTML=res.map(c=>'<div class="piece-option" onmousedown="event.preventDefault();modalContrat('+c.id+')"><div style="font-size:14px;font-weight:600">'+esc(c.nom)+'</div>'+(c.ville?'<div style="font-size:13px;color:var(--text3)">'+esc(c.ville)+'</div>':'')+'</div>').join('');
  drop.style.display='block';
}
window.ccPickInput = ccPickInput;

// Fenêtre de gestion du contrat-cadre d'un distributeur
async function modalContrat(clientId){
  if(!clientId){ toast(TR('Sélectionne un distributeur'),'ti-alert-circle','var(--warning)'); return; }
  let cl=null; try{ cl = await API.client(clientId); }catch(e){}
  // s'assure qu'un contrat existe (création idempotente)
  let cc=null;
  try{
    cc = await API.createContratCadre({
      client_id: clientId,
      distributeur_nom: cl?cl.nom:null,
      siret_distrib: cl?(cl.siret||cl.siren||''):'',
      siege_distrib: cl?[cl.adresse,cl.cp,cl.ville].filter(Boolean).join(' '):''
    });
    cc = await API.contratCadre(cc.id);
  }catch(e){ toast('Erreur : '+e.message,'ti-alert-circle','var(--danger)'); return; }
  const signe = cc.statut==='signe';
  showModal(`<div class="modal-header"><i class="ti ti-file-description" style="color:var(--accent)"></i><h2>${TR('Contrat-cadre')} — ${esc(cc.distributeur_nom||cl&&cl.nom||'')}</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body">
      <input type="hidden" id="cc-id" value="${cc.id}">
      <div style="margin-bottom:10px">${TR('Statut')} : ${contratBadge(cc.statut)}${cc.signed_at?` <span style="font-size:14px;color:var(--text2)">— ${TR('signé le')} ${fd((''+cc.signed_at).slice(0,10))}${cc.signataire_nom?(' '+TR('par')+' '+esc(cc.signataire_nom)):''}</span>`:''}</div>
      <div class="grid-2">
        <div class="form-group"><label class="form-label">${TR('Représentant Eloflex')}</label><input class="form-input" id="cc-rep-eloflex" value="${esc(cc.representant_eloflex||(CURRENT_USER&&CURRENT_USER.nom)||'')}"></div>
        <div class="form-group"><label class="form-label">${TR('Représentant distributeur')}</label><input class="form-input" id="cc-rep-distrib" value="${esc(cc.representant_distrib||cc.signataire_nom||'')}"></div>
        <div class="form-group"><label class="form-label">${TR('SIRET distributeur')}</label><input class="form-input mono" id="cc-siret" value="${esc(cc.siret_distrib||'')}"></div>
        <div class="form-group"><label class="form-label">${TR('Lieu (Fait à)')}</label><input class="form-input" id="cc-lieu" value="${esc(cc.lieu||'')}"></div>
      </div>
      <div class="form-group"><label class="form-label">${TR('Siège du distributeur')}</label><input class="form-input" id="cc-siege" value="${esc(cc.siege_distrib||'')}"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">
        <button class="btn" onclick="apercuContrat(${cc.id})"><i class="ti ti-eye"></i> ${TR('Aperçu')}</button>
        <button class="btn" onclick="exportContratPDF(${cc.id})"><i class="ti ti-file-type-pdf"></i> PDF</button>
        ${signe?'':`<button class="btn" onclick="montrerLienSignature(location.origin+'/contrat/'+'${cc.token_signature||''}')"><i class="ti ti-link"></i> ${TR('Lien de signature')}</button>
        <button class="btn primary" onclick="envoyerContratLien(${cc.id})"><i class="ti ti-mail"></i> ${TR('Envoyer à signer')}</button>
        <button class="btn success" onclick="modalContratSigneMail(${cc.id})"><i class="ti ti-mail-check"></i> ${TR('Signé par mail')}</button>`}
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn danger" style="margin-right:auto" onclick="supprContrat(${cc.id})"><i class="ti ti-trash"></i></button>
      <button class="btn" onclick="closeModal()">${TR('Fermer')}</button>
      <button class="btn primary" onclick="saveContratInfos(${cc.id})"><i class="ti ti-check"></i>${t('btn_enregistrer')||'Enregistrer'}</button>
    </div>`);
}
window.modalContrat = modalContrat;

async function saveContratInfos(id){
  const d = { lieu:gv('cc-lieu')||null, representant_eloflex:gv('cc-rep-eloflex')||null, representant_distrib:gv('cc-rep-distrib')||null, siret_distrib:gv('cc-siret')||null, siege_distrib:gv('cc-siege')||null };
  try{ await API.updateContratCadre(id, d); toast(TR('Contrat-cadre enregistré'),'ti-check','var(--success)'); closeModal(); }
  catch(e){ toast('Erreur : '+e.message,'ti-alert-circle','var(--danger)'); }
}
window.saveContratInfos = saveContratInfos;

async function envoyerContratLien(id){
  // enregistre d'abord les infos saisies
  try{ await API.updateContratCadre(id, { lieu:gv('cc-lieu')||null, representant_eloflex:gv('cc-rep-eloflex')||null, representant_distrib:gv('cc-rep-distrib')||null, siret_distrib:gv('cc-siret')||null, siege_distrib:gv('cc-siege')||null }); }catch(e){}
  let cc; try{ cc = await API.contratCadre(id); }catch(e){ toast('Erreur : '+e.message,'ti-alert-circle','var(--danger)'); return; }
  const dest = prompt(TR('Envoyer le contrat-cadre à signer à :'), cc.client_email_actuel||'');
  if(!dest) return;
  let pdfData=null; try{ if(typeof PDF!=='undefined' && PDF.contratCadreDoc) pdfData = PDF.contratCadreDoc(cc).output('datauristring'); }catch(e){}
  try{ const r = await API.envoyerContratCadre(id, dest, pdfData); toast(TR('Lien de signature envoyé à ')+r.to,'ti-mail','var(--success)'); closeModal(); }
  catch(e){ toast('Erreur : '+e.message,'ti-alert-circle','var(--danger)'); }
}
window.envoyerContratLien = envoyerContratLien;

function modalContratSigneMail(id){
  const today = new Date().toISOString().slice(0,10);
  showModal(`<div class="modal-header"><i class="ti ti-mail-check" style="color:var(--accent)"></i><h2>${TR('Contrat-cadre signé par mail')}</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body">
      <p style="font-size:15px;color:var(--text2);margin-top:0">${TR('Le distributeur a renvoyé le contrat-cadre signé par e-mail. Indiquez la date de signature.')}</p>
      <div class="form-group"><label class="form-label">${TR('Date de signature')}</label><input class="form-input" id="cc-signe-date" type="date" value="${today}" style="max-width:200px"></div>
    </div>
    <div class="modal-footer"><button class="btn" onclick="closeModal()">${t('btn_annuler')||'Annuler'}</button><button class="btn primary" onclick="validerContratSigneMail(${id})"><i class="ti ti-check"></i>${t('btn_enregistrer')||'Enregistrer'}</button></div>`);
}
window.modalContratSigneMail = modalContratSigneMail;
async function validerContratSigneMail(id){
  const d = gv('cc-signe-date'); if(!d){ toast(TR('Date requise'),'ti-alert-circle','var(--warning)'); return; }
  try{ await API.signeContratCadreMail(id, d); closeModal(); toast(TR('Contrat-cadre signé par mail'),'ti-check','var(--success)'); }
  catch(e){ toast('Erreur : '+e.message,'ti-alert-circle','var(--danger)'); }
}
window.validerContratSigneMail = validerContratSigneMail;

async function apercuContrat(id){
  let cc; try{ cc = await API.contratCadre(id); }catch(e){ toast('Erreur : '+e.message,'ti-alert-circle','var(--danger)'); return; }
  showModal(`<div class="modal-header"><i class="ti ti-file-description" style="color:var(--accent)"></i><h2>${TR('Aperçu du contrat-cadre')}</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body" style="max-height:70vh;overflow:auto;background:#fff">${contratBonHTML(cc)}</div>
    <div class="modal-footer"><button class="btn" onclick="closeModal()">${TR('Fermer')}</button><button class="btn primary" onclick="exportContratPDF(${id})"><i class="ti ti-file-type-pdf"></i>PDF</button></div>`);
}
window.apercuContrat = apercuContrat;

async function exportContratPDF(id){
  let cc; try{ cc = await API.contratCadre(id); }catch(e){ toast('Erreur : '+e.message,'ti-alert-circle','var(--danger)'); return; }
  if(typeof PDF!=='undefined' && PDF.contratCadre){ PDF.contratCadre(cc); } else { toast('Générateur PDF indisponible','ti-alert-circle','var(--danger)'); }
}
window.exportContratPDF = exportContratPDF;

async function supprContrat(id){
  if(!confirm(TR('Supprimer ce contrat-cadre ? (le distributeur devra le re-signer)'))) return;
  try{ await API.deleteContratCadre(id); toast(TR('Supprimé'),'ti-trash'); closeModal(); }
  catch(e){ toast('Erreur : '+e.message,'ti-alert-circle','var(--danger)'); }
}
window.supprContrat = supprContrat;

// Aperçu HTML du contrat-cadre (résumé fidèle des articles)
function contratBonHTML(c){
  c = c || {};
  const nom = esc(c.distributeur_nom || c.client_nom_actuel || '…');
  return `<div style="font-family:Calibri,Arial,sans-serif;color:#222;font-size:12px;line-height:1.5;max-width:760px;margin:0 auto">
    <div style="text-align:center;color:#1F5C8C;font-size:17px;font-weight:bold">CONTRAT-CADRE DE PRÊT À USAGE</div>
    <div style="text-align:center;font-style:italic;color:#666;font-size:12px;margin:0 0 10px;border-bottom:2px solid #1F5C8C;padding-bottom:7px">Commodat – Articles 1875 à 1891 du Code civil</div>
    <p><b>Entre</b> ELOFLEX SAS (« le Prêteur »)${c.representant_eloflex?', représentée par '+esc(c.representant_eloflex):''} <b>et</b> ${nom} (« l'Emprunteur »)${c.siret_distrib?' — SIRET : '+esc(c.siret_distrib):''}${c.representant_distrib?', représenté par '+esc(c.representant_distrib):''}.</p>
    <h3 style="color:#1F5C8C;font-size:13px;margin:12px 0 4px">Article 1 – Objet et nature juridique</h3>
    <p>Mise à disposition, à titre gratuit et temporaire, de fauteuils roulants électriques Eloflex aux fins exclusives d'essai patient supervisé par un ergothérapeute (arrêté du 6 février 2025 modifié, VPH, art. L.165-1 CSS). Commodat : ELOFLEX conserve la pleine propriété ; aucun transfert de propriété ne résulte de la remise. Chaque prêt fait l'objet d'un Bon de Prêt distinct.</p>
    <h3 style="color:#1F5C8C;font-size:13px;margin:12px 0 4px">Article 2 – Formules de prêt</h3>
    <p><b>Essai Court (15 à 30 j)</b> : max 30 jours calendaires dès la livraison, sauf prorogation écrite. <b>Prêt Long Terme (≥ 3 mois, renouvelable)</b> : réservé aux partenaires sélectionnés, engagements de l'article 4.2.</p>
    <h3 style="color:#1F5C8C;font-size:13px;margin:12px 0 4px">Article 3 – Livraison et état du matériel</h3>
    <p>Expédition par ELOFLEX à ses frais (sauf mention contraire). État des lieux contradictoire par la signature du Bon de Prêt. Conservation de l'emballage et des mousses.</p>
    <h3 style="color:#1F5C8C;font-size:13px;margin:12px 0 4px">Article 4 – Obligations de l'Emprunteur</h3>
    <p style="margin:0 0 3px">4.1 – Communes : essais supervisés par un ergothérapeute ; bon état et propreté ; interdiction de prêter/céder à un tiers ; signalement des incidents ; retour emballé avec mousses ; confirmation par e-mail avant retour ; respect du délai ; frais de retour 50 € HT/fauteuil ; prise en charge MO + pièces de remise en état.</p>
    <p style="margin:0">4.2 – Long Terme : état « quasi neuf » ; ≥ 1 essai/mois ; information en cas d'indisponibilité ; bilan trimestriel simplifié.</p>
    <h3 style="color:#1F5C8C;font-size:13px;margin:12px 0 4px">Article 5 – Responsabilité et garantie</h3>
    <p>Responsabilité de la réception au retour (art. 1880-1884 C. civ.). Perte/destruction totale : prix catalogue public HT à la date du sinistre. Dommages partiels : frais réels (pièces + MO tarif SAV) sur devis ou facture ; usure normale non facturée. Assurance RC pro recommandée.</p>
    <h3 style="color:#1F5C8C;font-size:13px;margin:12px 0 4px">Article 6 – Frais de retour et d'emballage</h3>
    <p>Retour : 50 € HT/fauteuil. Emballage/mousses manquants : 90 € HT au total si l'emballage complet est absent. Facturés séparément, sans contrepartie du prêt.</p>
    <h3 style="color:#1F5C8C;font-size:13px;margin:12px 0 4px">Article 7 – Cession du matériel</h3>
    <p>Offre de rachat possible à tout moment, sans engagement pour ELOFLEX ; prix librement fixé au jour de la vente, formalisé par un bon de commande distinct + facture de vente. Le transfert de propriété met fin au prêt pour ce matériel.</p>
    <h3 style="color:#1F5C8C;font-size:13px;margin:12px 0 4px">Article 8 – Durée et fin du prêt</h3>
    <p>Fin à l'échéance du Bon de Prêt ; par accord mutuel ; à la demande d'ELOFLEX (préavis 15 j Essai Court / 30 j Long Terme) ; de plein droit sans préavis en cas de manquement grave. Restitution sous 7 jours calendaires après notification.</p>
    <h3 style="color:#1F5C8C;font-size:13px;margin:12px 0 4px">Article 9 – Dispositions générales</h3>
    <p>Droit français ; à défaut d'accord amiable, compétence exclusive des juridictions du siège d'ELOFLEX. Modification par avenant écrit ; divisibilité des clauses.</p>
    <p style="margin-top:10px">Fait à ${esc(c.lieu||'……………')}, le ${c.signed_at?fd((''+c.signed_at).slice(0,10)):'……/……/………'} — en deux exemplaires originaux.</p>
    <table style="width:100%;border-collapse:collapse;margin-top:8px"><tr>
      <td style="border:1px solid #CCC;padding:6px 9px;width:50%;vertical-align:top"><b>LE PRÊTEUR — ELOFLEX SAS</b><br>Représenté par : ${esc(c.representant_eloflex||'')}<br><span style="font-size:10px;color:#777">Signé électroniquement le ${fd(((c.eloflex_date||c.created_at||new Date().toISOString())+'').slice(0,10))}</span></td>
      <td style="border:1px solid #CCC;padding:6px 9px;width:50%;vertical-align:top"><b>L'EMPRUNTEUR</b><br>${nom}<br>${c.signataire_nom?('Signé par : '+esc(c.signataire_nom)+(c.signed_at?' le '+fd((''+c.signed_at).slice(0,10)):'')):'Nom : _______________  « Lu et approuvé, bon pour accord »'}<br>${c.signature_data?`<img src="${c.signature_data}" style="max-height:60px;max-width:220px;margin-top:4px">`:'&nbsp;'}</td>
    </tr></table>
  </div>`;
}
window.contratBonHTML = contratBonHTML;

// ══════════════════════════════════════════════════════════════════
// ── DEMANDES D'INFORMATIONS (leads transmis aux distributeurs) ──
// ══════════════════════════════════════════════════════════════════
const DI_STATUTS = {
  transmise:   { l:'Transmise',    c:'#2563eb', ic:'ti-send' },
  relance:     { l:'Relancé mail', c:'#d97706', ic:'ti-mail-forward' },
  retour_recu: { l:'Appel émis',   c:'#16a34a', ic:'ti-phone-outgoing' },
  essai:       { l:'Essai',        c:'#7c3aed', ic:'ti-flask' },
  vente:       { l:'Vente',        c:'#15803d', ic:'ti-shopping-cart' },
  sans_suite:  { l:'Sans suite',   c:'#6b7280', ic:'ti-ban' },
  absence_retour:{ l:'Absence de retour', c:'#dc2626', ic:'ti-clock-x' },
};
const DI_NON_TRAITEES = ['transmise','relance'];   // = "En attente" (à traiter) — hors "Absence de retour"
function diBadge(s){ const u=DI_STATUTS[s]||{l:s,c:'#6b7280'}; return `<span style="display:inline-block;padding:2px 9px;border-radius:99px;font-size:13px;font-weight:600;color:#fff;background:${u.c};white-space:nowrap">${u.l}</span>`; }
function diCouleur(s){ return (DI_STATUTS[s]||{c:'#6b7280'}).c; }
function diStatutOptions(sel){ return Object.keys(DI_STATUTS).map(k=>`<option value="${k}" ${k===sel?'selected':''}>${DI_STATUTS[k].l}</option>`).join(''); }
const _dfd = d => d ? fd((''+d).slice(0,10)) : '—';
function _joursDepuis(v){ if(!v) return null; const d=new Date((''+v).slice(0,10)); if(isNaN(d)) return null; return Math.max(0,Math.round((Date.now()-d.getTime())/86400000)); }
// Relances à faire (s'arrêtent dès que la demande est conclue) :
function diRelanceMailDue(d){ return d.statut==='transmise' && !d.relance_mail_date && (_joursDepuis(d.date_transmission)>=7); }
function diRelanceTelDue(d){ return d.statut==='relance' && d.relance_mail_date && !d.relance_tel_date && (_joursDepuis(d.relance_mail_date)>=7); }
function diRelanceDue(d){ return diRelanceMailDue(d) || diRelanceTelDue(d); }
// Sélecteur de statut en icônes : coloré = sélectionné, grisé = non sélectionné ; clic = change le statut
function diStatutIcons(d){
  // Date de chaque statut (dernier passage) pour l'afficher au survol
  const dates = {};
  if(Array.isArray(d.historique)) d.historique.forEach(h=>{ if(h && h.statut && h.date) dates[h.statut]=h.date; });
  if(d.statut && d.statut_date) dates[d.statut]=d.statut_date;
  return `<span style="display:inline-flex;align-items:center;gap:2px;white-space:nowrap">${Object.keys(DI_STATUTS).map(k=>{
    const u=DI_STATUTS[k], on=(d.statut===k);
    const t = u.l + (dates[k] ? ' — '+_dfd(dates[k]) : '');
    if(on) return `<span title="${t}" onclick="event.stopPropagation();setDemandeStatutInline(${d.id},'${k}')" style="cursor:pointer;background:${u.c};color:#fff;width:26px;height:26px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;flex:none"><i class="ti ${u.ic}" style="font-size:18px"></i></span>`;
    return `<span onclick="event.stopPropagation();setDemandeStatutInline(${d.id},'${k}')" title="${t}" style="cursor:pointer;width:25px;height:26px;display:inline-flex;align-items:center;justify-content:center;flex:none"><i class="ti ${u.ic}" style="font-size:20px;color:var(--text3);opacity:.3"></i></span>`;
  }).join('')}</span>`;
}
// Icône historique (placée en dernière colonne)
function diHistCell(d){
  const nb = Array.isArray(d.historique)?d.historique.length:0;
  if(nb<2) return '';
  return `<i class="ti ti-history" title="${TR('Historique des statuts')}" onclick="event.stopPropagation();historiqueDemande(${d.id})" style="cursor:pointer;color:var(--text3);font-size:19px"></i>`;
}
async function setDemandeStatutInline(id, statut){
  try{ await API.setDemandeInfoStatut(id, statut, {date_statut:new Date().toISOString().slice(0,10)});
    rafraichirDemandes();
  }catch(e){ toast('Erreur : '+e.message,'ti-alert-circle','var(--danger)'); }
}
window.setDemandeStatutInline = setDemandeStatutInline;
// Groupe d'actions : envoyer le mail de relance (séparé du statut) + éditer + supprimer.
function diActionsCluster(d){
  const blink = diRelanceMailDue(d) ? ' di-blink' : '';
  const relTitle = TR('Relancer par mail')+(d.relance_mail_date?(' — '+TR('dernière : ')+_dfd(d.relance_mail_date)):'');
  return `<span style="display:inline-flex;gap:1px;flex:none">
    <button class="btn sm" title="${relTitle}" onclick="event.stopPropagation();if(confirm('${TR('Envoyer le mail de relance à ce distributeur ?')}'))relancerMailContact(${d.id})" style="color:${d.relance_mail_date?'#d97706':'var(--accent)'}"><i class="ti ti-mail${blink}"></i></button>
    <button class="btn sm" title="${TR('Modifier / changer de distributeur')}" onclick="event.stopPropagation();modalDemande(${d.client_id||'null'},'',${d.id})"><i class="ti ti-pencil"></i></button>
    <button class="btn sm danger" title="${TR('Supprimer ce contact')}" onclick="event.stopPropagation();supprDemande(${d.id})"><i class="ti ti-trash"></i></button>
  </span>`;
}
// Injecte le CSS de clignotement (une seule fois)
function diEnsureBlinkCSS(){
  if(document.getElementById('di-blink-css')) return;
  const s=document.createElement('style'); s.id='di-blink-css';
  s.textContent='@keyframes diBlink{0%,100%{opacity:1}50%{opacity:.15}} .di-blink{animation:diBlink 1s ease-in-out infinite}'
    + ' .di-table td{padding-top:11px!important;padding-bottom:11px!important;font-size:14.5px}'
    + ' .di-table th{padding-top:8px!important;padding-bottom:8px!important}';
  document.head.appendChild(s);
}
// Cellule "Relance mail" : enveloppe cliquable (envoie le mail au distributeur + date). Clignote si en attente et pas de relance après 7 j.
function diRelanceMailCell(d){
  const dt = d.relance_mail_date ? `<span style="font-size:12px;color:var(--text3);display:block;margin-top:2px">${_dfd(d.relance_mail_date)}</span>` : '';
  const j = _joursDepuis(d.date_transmission);
  const blink = (DI_NON_TRAITEES.includes(d.statut) && !d.relance_mail_date && j!=null && j>=7) ? ' di-blink' : '';
  return `<i class="ti ti-mail${blink}" title="${TR('Relancer par mail (au distributeur)')}" onclick="event.stopPropagation();relancerMailContact(${d.id})" style="cursor:pointer;color:${d.relance_mail_date?'#d97706':'var(--accent)'};font-size:19px"></i>${dt}`;
}
// Cellule "Relance téléphonique" : téléphone cliquable (enregistre la date). Clignote 7 j après la relance mail si pas encore fait.
function diRelanceTelCell(d){
  const dt = d.relance_tel_date ? `<span style="font-size:12px;color:var(--text3);display:block;margin-top:2px">${_dfd(d.relance_tel_date)}</span>` : '';
  const j = _joursDepuis(d.relance_mail_date);
  const blink = (DI_NON_TRAITEES.includes(d.statut) && d.relance_mail_date && !d.relance_tel_date && j!=null && j>=7) ? ' di-blink' : '';
  return `<i class="ti ti-phone${blink}" title="${TR('Marquer une relance téléphonique')}" onclick="event.stopPropagation();relanceTel(${d.id})" style="cursor:pointer;color:${d.relance_tel_date?'#16a34a':'var(--text3)'};font-size:19px"></i>${dt}`;
}
async function relancerMailContact(id){
  try{ const r=await API.relanceContactInfo(id); toast(TR('Relance envoyée à ')+r.to,'ti-mail','var(--success)'); rafraichirDemandes(); }
  catch(e){
    if(/adresse/i.test(e.message||'')){
      const dest=prompt(TR('Aucune adresse sur la fiche distributeur. Saisir une adresse e-mail :'),'');
      if(dest){ try{ const r=await API.relanceContactInfo(id,dest); toast(TR('Relance envoyée à ')+r.to,'ti-mail','var(--success)'); rafraichirDemandes(); }catch(e2){ toast('Erreur : '+e2.message,'ti-alert-circle','var(--danger)'); } }
    } else { toast('Erreur : '+(e.message||''),'ti-alert-circle','var(--danger)'); }
  }
}
window.relancerMailContact = relancerMailContact;
async function relanceTel(id){
  const today=new Date().toISOString().slice(0,10);
  const date=prompt(TR('Date de la relance téléphonique :'), today);
  if(date==null) return;
  try{ await API.relanceTelInfo(id, date||today); toast(TR('Relance téléphonique enregistrée'),'ti-phone','var(--success)'); rafraichirDemandes(); }
  catch(e){ toast('Erreur : '+e.message,'ti-alert-circle','var(--danger)'); }
}
window.relanceTel = relanceTel;
// Petite légende des statuts
function diLegende(){
  return `<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;font-size:13px;color:var(--text2);margin-bottom:10px">
    <span style="font-weight:600;color:var(--text3)">${TR('Statuts')} :</span>
    ${Object.keys(DI_STATUTS).map(k=>`<span style="display:inline-flex;align-items:center;gap:4px"><span style="width:9px;height:9px;border-radius:99px;background:${DI_STATUTS[k].c};display:inline-block"></span>${DI_STATUTS[k].i} ${DI_STATUTS[k].l}</span>`).join('')}
  </div>`;
}
// Modale historique des statuts (timeline avec dates)
function historiqueDemande(id){
  const d = trouverDemande(id); if(!d){ toast(TR('Demande introuvable'),'ti-alert-circle','var(--warning)'); return; }
  let hist = Array.isArray(d.historique)?d.historique.slice():[];
  hist.sort((a,b)=>(''+(b.date||'')).localeCompare(''+(a.date||'')));
  const items = hist.length ? hist.map((h,i)=>`<div style="display:flex;gap:10px;align-items:flex-start;padding:8px 0;${i?'border-top:0.5px solid var(--border)':''}">
      <span style="width:11px;height:11px;border-radius:99px;background:${diCouleur(h.statut)};margin-top:3px;flex:none"></span>
      <div style="flex:1"><div>${diBadge(h.statut)}</div>
      <div style="font-size:13px;color:var(--text3);margin-top:2px">${_dfd(h.date)}${h.par?(' · '+esc(h.par)):''}</div></div>
    </div>`).join('') : `<div style="color:var(--text3);font-size:14px">${TR('Aucun changement de statut enregistré.')}</div>`;
  showModal(`<div class="modal-header"><i class="ti ti-history" style="color:var(--accent)"></i><h2>${TR('Historique du suivi')} — ${esc(d.nom||'')}</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body">
      <div style="font-size:14px;color:var(--text3);margin-bottom:6px">${TR('Transmis le')} ${_dfd(d.date_transmission)}</div>
      ${items}
    </div>`);
}
window.historiqueDemande = historiqueDemande;
function trouverDemande(id){
  id = Number(id);
  const groups = window._DI_GROUPS||{};
  for(const k in groups){ const f=(groups[k].items||[]).find(x=>Number(x.id)===id); if(f) return f; }
  return (window._DI_ROWS||[]).find(x=>Number(x.id)===id) || null;
}

// ── Section sur la fiche distributeur ──
async function chargerDemandesFiche(clientId){
  const el = document.getElementById('client-demandes'); if(!el) return;
  const nom = el.getAttribute('data-nom')||''; const email = el.getAttribute('data-email')||'';
  let rows=[]; try{ rows = await API.demandesInfo({client_id:clientId}); }catch(e){ el.innerHTML=''; return; }
  const nonTraitees = rows.filter(r=>DI_NON_TRAITEES.includes(r.statut)).length;
  const absN = rows.filter(r=>r.statut==='absence_retour').length;
  const alerte = absN>3 ? `<div style="background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;border-radius:8px;padding:8px 12px;margin:4px 0 10px;font-size:15px;font-weight:600"><i class="ti ti-alert-triangle"></i> ${TR('Distributeur peu réactif :')} ${absN} ${TR('demandes en « absence de retour » (le distributeur ne fait pas les relances).')}</div>` : '';
  const header = `<div class="section-title" style="margin:4px 0 8px;display:flex;align-items:center;gap:8px">
      <i class="ti ti-address-book"></i>${TR("Demandes d'informations")}
      <span class="badge hg" style="font-weight:600">${rows.length}</span>
      ${nonTraitees?`<span style="color:#d97706;font-size:14px;font-weight:600">● ${nonTraitees} ${TR('en attente')}</span>`:''}
      <span style="margin-left:auto;display:flex;gap:6px">
        <button class="btn sm primary" onclick="modalDemande(${clientId},'${esc(nom).replace(/'/g,'&#39;')}')"><i class="ti ti-plus"></i> ${TR('Ajouter')}</button>
        ${nonTraitees?`<button class="btn sm" onclick="relancerDemandes(${clientId},'${esc(email).replace(/'/g,'&#39;')}')"><i class="ti ti-mail"></i> ${TR('Demander un retour')}</button>`:''}
        <button class="btn sm" onclick="exporterDemandes(${clientId})"><i class="ti ti-download"></i> ${TR('Export')}</button>
      </span></div>` + alerte;
  if(!rows.length){ el.innerHTML = header + `<div style="font-size:14px;color:var(--text3);padding:6px 0">${TR('Aucune demande transmise pour ce distributeur.')}</div>`; return; }
  el.innerHTML = header + demandesTableHTML(rows, false);
}
window.chargerDemandesFiche = chargerDemandesFiche;

// ── Tableau des demandes (réutilisé fiche + vue globale) ──
function demandesTableHTML(rows, withDistrib){
  diEnsureBlinkCSS();
  const lignes = rows.map(d=>`<tr style="border-top:0.5px solid var(--border)">
    <td style="padding:8px 8px;border-left:3px solid ${diCouleur(d.statut)}"><div style="display:flex;align-items:center;gap:12px">${diStatutIcons(d)}${diActionsCluster(d)}</div></td>
    <td style="padding:8px 10px;white-space:nowrap">${_dfd(d.date_transmission)}</td>
    ${withDistrib?`<td style="padding:8px 10px">${esc(d.client_nom_actuel||d.distributeur_nom||'—')}</td>`:''}
    <td style="padding:8px 10px">${esc(d.nom||'')}</td>
    <td style="padding:8px 10px;white-space:nowrap">${d.telephone?`<a href="tel:${esc(telHref(d.telephone))}" style="color:inherit;text-decoration:none">${esc(fmtTel(d.telephone))}</a>`:'—'}</td>
    <td style="padding:8px 10px;word-break:break-word">${d.email?`<a href="mailto:${esc(d.email)}" style="color:var(--accent);text-decoration:none;font-size:14px">${esc(d.email)}</a>`:'—'}</td>
    <td style="padding:8px 10px;white-space:nowrap">${esc(d.ville||'')}${d.cp?`<span style="color:var(--text3)"> ${esc(d.cp)}</span>`:''}${(!d.ville&&!d.cp)?'—':''}</td>
    <td style="padding:8px 10px;font-size:14px">${esc(d.demande_client||'')}</td>
    <td style="padding:8px 10px;font-size:14px;color:var(--text2)">${esc(d.annotation||'')}</td>
    <td style="padding:8px 8px;text-align:center">${diHistCell(d)}</td>
    </tr>`).join('');
  return `<div class="card" style="padding:0;overflow:hidden"><table class="table di-table" style="width:100%;table-layout:fixed">
    <colgroup>
      <col style="width:322px"><col style="width:96px">${withDistrib?'<col style="width:160px">':''}<col style="width:160px"><col style="width:128px">
      <col style="width:220px"><col style="width:128px"><col style="width:300px"><col><col style="width:44px">
    </colgroup>
    <thead><tr>
    <th style="text-align:left;padding:8px 8px">${TR('Statut')}</th>
    <th style="text-align:left;padding:8px 10px">${TR('Date')}</th>
    ${withDistrib?`<th style="text-align:left;padding:8px 10px">${TR('Distributeur')}</th>`:''}
    <th style="text-align:left;padding:8px 10px">${TR('Contact')}</th>
    <th style="text-align:left;padding:8px 10px">${TR('Téléphone')}</th>
    <th style="text-align:left;padding:8px 10px">${TR('Mail')}</th>
    <th style="text-align:left;padding:8px 10px">${TR('Ville / CP')}</th>
    <th style="text-align:left;padding:8px 10px">${TR('Demande client')}</th>
    <th style="text-align:left;padding:8px 10px">${TR('Annotation de suivi')}</th>
    <th style="text-align:center;padding:8px 6px" title="${TR('Historique')}"><i class="ti ti-history"></i></th>
  </tr></thead><tbody>${lignes}</tbody></table></div>`;
}

// ── Vue globale ──
let DEMANDES_FILTRE = { statut:'', non_traitees:false, q:'' };
let DEMANDES_VUE = 'distrib';   // 'liste' | 'distrib'
let DI_OPEN = new Set();         // noms des distributeurs dépliés (persiste au re-render)
function setDemandesVue(v){ DEMANDES_VUE=v; render(); }
window.setDemandesVue = setDemandesVue;
async function renderDemandes(ttl,c,a){
  ttl.textContent = TR("Demandes d'informations");
  a.innerHTML = `<label class="btn sm" style="cursor:pointer"><input type="file" accept=".xlsx,.xls" style="display:none" onchange="importDemandesExcel(this)"><i class="ti ti-upload"></i> ${TR('Importer Excel')}</label>
    <button class="btn sm" onclick="exporterDemandes()"><i class="ti ti-download"></i> ${TR('Export')}</button>
    <button class="btn sm primary" onclick="modalDemande()"><i class="ti ti-plus"></i> ${TR('Nouvelle demande')}</button>`;
  let stats={total:0,non_traitees:0,par_statut:{}}; try{ stats=await API.demandesInfoStats(); }catch(e){}
  const tiles = `<div class="grid-2" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:12px">
    <div class="stat-card"><div class="stat-label">${TR('Total')}</div><div class="stat-value">${stats.total||0}</div></div>
    <div class="stat-card"><div class="stat-label">${TR('En attente')}</div><div class="stat-value" style="color:#d97706">${stats.non_traitees||0}</div></div>
    <div class="stat-card" title="${TR('Mail')} : ${stats.relances_mail||0} · ${TR('Téléphone')} : ${stats.relances_tel||0}" onclick="DI_RELANCE_ONLY=true;DI_STATUT_FILTRE=new Set();setDemandesVue('distrib')" style="cursor:pointer;border:1px solid ${(stats.relances_a_faire||0)?'#dc2626':'var(--border)'}">
      <div class="stat-label"><i class="ti ti-bell-ringing"></i> ${TR('Relances à faire')}</div>
      <div class="stat-value" style="color:${(stats.relances_a_faire||0)?'#dc2626':'var(--text3)'}">${stats.relances_a_faire||0}</div></div>
    ${['retour_recu','essai','vente'].map(k=>`<div class="stat-card"><div class="stat-label">${DI_STATUTS[k].l}</div><div class="stat-value" style="color:${DI_STATUTS[k].c}">${stats.par_statut[k]||0}</div></div>`).join('')}
  </div>`;
  const vueTabs = `<div style="display:inline-flex;border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:10px">
    <button class="btn sm" style="border:0;border-radius:0;${DEMANDES_VUE==='liste'?'background:var(--accent);color:#fff':''}" onclick="setDemandesVue('liste')"><i class="ti ti-list"></i> ${TR('Liste')}</button>
    <button class="btn sm" style="border:0;border-radius:0;${DEMANDES_VUE==='distrib'?'background:var(--accent);color:#fff':''}" onclick="setDemandesVue('distrib')"><i class="ti ti-building-store"></i> ${TR('Par distributeur')}</button>
  </div>`;
  const filtres = `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;align-items:center">
    <input class="form-input" id="di-q" placeholder="${TR('Rechercher (contact, distributeur, ville…)')}" value="${esc(DEMANDES_FILTRE.q)}" oninput="DEMANDES_FILTRE.q=this.value;clearTimeout(window._diT);window._diT=setTimeout(chargerDemandesGlobal,300)" style="max-width:320px">
    <select class="form-input" id="di-statut" onchange="DEMANDES_FILTRE.statut=this.value;chargerDemandesGlobal()" style="max-width:180px"><option value="">${TR('Tous les statuts')}</option>${diStatutOptions(DEMANDES_FILTRE.statut)}</select>
    <label style="display:flex;align-items:center;gap:6px;font-size:15px;cursor:pointer"><input type="checkbox" ${DEMANDES_FILTRE.non_traitees?'checked':''} onchange="DEMANDES_FILTRE.non_traitees=this.checked;chargerDemandesGlobal()"> ${TR('En attente seulement')}</label>
  </div>`;
  if(DEMANDES_VUE==='distrib'){
    c.innerHTML = tiles + vueTabs + `<div id="di-distrib-list"><div style="font-size:14px;color:var(--text2)"><i class="ti ti-loader-2"></i> ${TR('Chargement…')}</div></div>`;
    chargerDemandesParDistrib();
  } else {
    c.innerHTML = tiles + vueTabs + filtres + `<div id="di-global-list"><div style="font-size:14px;color:var(--text2)"><i class="ti ti-loader-2"></i> ${TR('Chargement…')}</div></div>`;
    chargerDemandesGlobal();
  }
}
window.renderDemandes = renderDemandes;
async function chargerDemandesGlobal(){
  const el = document.getElementById('di-global-list'); if(!el) return;
  const params={}; if(DEMANDES_FILTRE.statut) params.statut=DEMANDES_FILTRE.statut; if(DEMANDES_FILTRE.non_traitees) params.non_traitees='1'; if(DEMANDES_FILTRE.q) params.q=DEMANDES_FILTRE.q;
  let rows=[]; try{ rows=await API.demandesInfo(params); }catch(e){ el.innerHTML=`<div class="empty">Erreur : ${esc(e.message)}</div>`; return; }
  window._DI_ROWS = rows;
  if(!rows.length){ el.innerHTML=`<div class="empty"><i class="ti ti-address-book"></i>${TR('Aucune demande.')}</div>`; return; }
  el.innerHTML = `<div style="font-size:14px;color:var(--text3);margin-bottom:6px">${rows.length} ${TR('demande(s)')}</div>` + demandesTableHTML(rows, true);
}
window.chargerDemandesGlobal = chargerDemandesGlobal;

// ── Vue par distributeur (accordéon alphabétique, façon Excel) ──
let DI_DISTRIB_Q = '';
let DI_STATUT_FILTRE = new Set();   // filtre par catégorie de statut (vue par distributeur)
let DI_RELANCE_ONLY = false;        // filtre "Relances à faire"
const DI_NON_TRAITEES_FILTRE = ['transmise','relance','retour_recu'];   // "Non traitées" = 3 premiers statuts
function diFiltreRelances(){ DI_RELANCE_ONLY=!DI_RELANCE_ONLY; if(STATE.view==='demandes'){ DEMANDES_VUE='distrib'; if(document.getElementById('di-distrib-list')) chargerDemandesParDistrib(); else render(); } }
window.diFiltreRelances = diFiltreRelances;
function diFiltreStatut(k){ if(DI_STATUT_FILTRE.has(k)) DI_STATUT_FILTRE.delete(k); else DI_STATUT_FILTRE.add(k); chargerDemandesParDistrib(); }
window.diFiltreStatut = diFiltreStatut;
function diFiltreNonTraitees(){ const on = DI_STATUT_FILTRE.size===DI_NON_TRAITEES_FILTRE.length && DI_NON_TRAITEES_FILTRE.every(x=>DI_STATUT_FILTRE.has(x)); DI_STATUT_FILTRE = new Set(on?[]:DI_NON_TRAITEES_FILTRE); chargerDemandesParDistrib(); }
window.diFiltreNonTraitees = diFiltreNonTraitees;
function diFiltreReset(){ DI_STATUT_FILTRE = new Set(); chargerDemandesParDistrib(); }
window.diFiltreReset = diFiltreReset;
const _diKey = s => (s==null?'':String(s)).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
async function chargerDemandesParDistrib(){
  const el = document.getElementById('di-distrib-list'); if(!el) return;
  let rows=[]; try{ rows=await API.demandesInfo({}); }catch(e){ el.innerHTML=`<div class="empty">Erreur : ${esc(e.message)}</div>`; return; }
  if(!rows.length){ el.innerHTML=`<div class="empty"><i class="ti ti-building-store"></i>${TR('Aucune demande.')}</div>`; return; }
  // Regroupement par distributeur
  const groups = {};
  for(const d of rows){
    const key = (d.client_nom_actuel||d.distributeur_nom||'—').trim() || '—';
    if(!groups[key]) groups[key] = { nom:key, client_id:d.client_id||null, email:d.client_email_actuel||d.email||'', items:[] };
    else if(!groups[key].email && (d.client_email_actuel||d.email)) groups[key].email = d.client_email_actuel||d.email;
    groups[key].items.push(d);
  }
  window._DI_GROUPS = groups;
  // Tri alphabétique robuste (insensible aux accents et à la casse)
  let list = Object.values(groups).sort((a,b)=>{ const ka=_diKey(a.nom), kb=_diKey(b.nom); return ka<kb?-1:ka>kb?1:0; });
  // Recherche : distributeur OU contact (nom / mail / téléphone / ville / CP / annotation)
  const q = _diKey(DI_DISTRIB_Q);
  if(q){
    list = list.map(g=>{
      const nameHit = _diKey(g.nom).includes(q);
      if(nameHit) return Object.assign({}, g, {_open:true, _items:g.items});
      const its = g.items.filter(d=> _diKey(d.nom).includes(q) || _diKey(d.email).includes(q) || _diKey(d.telephone).includes(q) || _diKey(d.ville).includes(q) || _diKey(d.cp).includes(q) || _diKey(d.annotation).includes(q));
      return its.length ? Object.assign({}, g, {_open:true, _items:its}) : null;
    }).filter(Boolean);
  }
  // Filtre par catégorie de statut (n'affiche que les demandes des statuts sélectionnés)
  if(DI_STATUT_FILTRE.size){
    list = list.map(g=>{
      const base = g._items || g.items;
      const its = base.filter(d=>DI_STATUT_FILTRE.has(d.statut));
      return its.length ? Object.assign({}, g, {_items:its, _open:true}) : null;
    }).filter(Boolean);
  }
  // Filtre "Relances à faire"
  if(DI_RELANCE_ONLY){
    list = list.map(g=>{
      const base = g._items || g.items;
      const its = base.filter(diRelanceDue);
      return its.length ? Object.assign({}, g, {_items:its, _open:true}) : null;
    }).filter(Boolean);
  }
  const ntActif = DI_STATUT_FILTRE.size===DI_NON_TRAITEES_FILTRE.length && DI_NON_TRAITEES_FILTRE.every(x=>DI_STATUT_FILTRE.has(x));
  const filtres = `<div style="display:inline-flex;gap:3px;align-items:center;flex-wrap:wrap">
      <button class="btn sm${ntActif?' primary':''}" title="${TR('Non traitées (Transmise, Relancé mail, Appel émis)')}" onclick="diFiltreNonTraitees()"><i class="ti ti-inbox"></i> ${TR('Non traitées')}</button>
      <button class="btn sm${DI_RELANCE_ONLY?' primary':''}" title="${TR('Relances à faire (mail à 7j, tél. à 7j après le mail)')}" onclick="diFiltreRelances()"><i class="ti ti-bell-ringing"></i> ${TR('Relances à faire')}</button>
      <span style="width:1px;height:22px;background:var(--border);margin:0 4px"></span>
      ${Object.keys(DI_STATUTS).map(k=>{const u=DI_STATUTS[k];const on=DI_STATUT_FILTRE.has(k);return `<span onclick="diFiltreStatut('${k}')" title="${u.l}" style="cursor:pointer;width:26px;height:26px;border-radius:7px;display:inline-flex;align-items:center;justify-content:center;${on?('background:'+u.c):''}"><i class="ti ${u.ic}" style="font-size:19px;color:${on?'#fff':'var(--text3)'};opacity:${on?1:.4}"></i></span>`;}).join('')}
      ${(DI_STATUT_FILTRE.size||DI_RELANCE_ONLY)?`<button class="btn sm" title="${TR('Réinitialiser le filtre')}" onclick="DI_STATUT_FILTRE=new Set();DI_RELANCE_ONLY=false;chargerDemandesParDistrib()"><i class="ti ti-x"></i></button>`:''}
    </div>`;
  const barre = `<div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
    <input class="form-input" id="di-distrib-q" autofocus placeholder="${TR('Rechercher : distributeur, contact, mail, téléphone…')}" value="${esc(DI_DISTRIB_Q)}" oninput="DI_DISTRIB_Q=this.value;clearTimeout(window._diDT);window._diDT=setTimeout(chargerDemandesParDistrib,250)" style="max-width:300px">
    ${filtres}
    <span style="flex:1"></span>
    <span style="font-size:14px;color:var(--text3)">${list.length} ${TR('distributeur(s)')}</span>
    <button class="btn sm" onclick="toggleTousDistrib(true)"><i class="ti ti-chevrons-down"></i> ${TR('Tout déplier')}</button>
    <button class="btn sm" onclick="toggleTousDistrib(false)"><i class="ti ti-chevrons-up"></i> ${TR('Tout replier')}</button>
  </div>`;
  diEnsureBlinkCSS();
  window._DI_GID2NOM = {};
  const blocs = list.map((g,i)=>{
    const gid = 'dg'+i;
    const srcItems = g._items || g.items;
    const nt = g.items.filter(x=>DI_NON_TRAITEES.includes(x.statut)).length;
    const absN = g.items.filter(x=>x.statut==='absence_retour').length;
    const alerte = absN>3;   // distributeur peu réactif : >3 "absence de retour"
    const items = srcItems.slice().sort((a,b)=>(''+(b.date_transmission||'')).localeCompare(''+(a.date_transmission||'')));
    const ntBadge = nt ? `<span title="${nt} ${TR('en attente')}" style="width:8px;height:8px;border-radius:99px;background:#d97706;display:inline-block;flex:none"></span>` : '';
    const open = DI_OPEN.has(g.nom) || !!g._open;
    window._DI_GID2NOM[gid] = g.nom;
    const lignes = items.map(d=>{
      return `<tr style="border-top:0.5px solid var(--border)">
      <td style="padding:7px 8px;border-left:3px solid ${diCouleur(d.statut)}"><div style="display:flex;align-items:center;gap:12px">${diStatutIcons(d)}${diActionsCluster(d)}</div></td>
      <td style="padding:7px 10px;white-space:nowrap">${_dfd(d.date_transmission)}</td>
      <td style="padding:7px 10px;word-break:break-word">${esc(d.nom||'')}</td>
      <td style="padding:7px 10px;white-space:nowrap">${d.telephone?`<a href="tel:${esc(telHref(d.telephone))}" style="color:inherit;text-decoration:none">${esc(fmtTel(d.telephone))}</a>`:'—'}</td>
      <td style="padding:7px 10px;word-break:break-word">${d.email?`<a href="mailto:${esc(d.email)}" style="color:var(--accent);text-decoration:none;font-size:14px">${esc(d.email)}</a>`:'—'}</td>
      <td style="padding:7px 10px;word-break:break-word">${esc(d.ville||'')}${d.cp?`<span style="color:var(--text3)"> ${esc(d.cp)}</span>`:''}${(!d.ville&&!d.cp)?'—':''}</td>
      <td style="padding:7px 10px;font-size:14px;word-break:break-word">${esc(d.demande_client||'')}</td>
      <td style="padding:7px 10px;font-size:14px;color:var(--text2);word-break:break-word">${esc(d.annotation||'')}</td>
      <td style="padding:7px 8px;text-align:center">${diHistCell(d)}</td>
      </tr>`;
    }).join('');
    return `<div style="border-top:0.5px solid var(--border)">
      <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;user-select:none">
        <i id="ic-${gid}" class="ti ${open?'ti-eye-off':'ti-eye'}" title="${alerte?(absN+' '+TR('demandes sans retour du distributeur !')):TR('Voir les demandes')}" onclick="toggleDistribGroup('${gid}')" style="color:${alerte?'#dc2626':'var(--accent)'};width:18px;cursor:pointer;font-size:19px"></i>
        <span style="font-weight:600;cursor:pointer;${alerte?'color:#dc2626':''}" onclick="toggleDistribGroup('${gid}')">${esc(g.nom)}${alerte?` <i class="ti ti-alert-triangle" title="${absN} ${TR('demandes sans retour')}" style="font-size:15px"></i>`:''}</span>
        ${ntBadge}
        <span style="background:var(--bg2,#eef1f4);border:1px solid var(--border);border-radius:50%;width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;flex:none" title="${TR('Nombre de demandes')}">${g.items.length}</span>
        <span style="flex:1"></span>
        ${g.client_id?`<button class="btn sm" title="${TR('Ouvrir la fiche du distributeur (ventes, adresse…)')}" onclick="event.stopPropagation();ouvrirFicheDistrib(${g.client_id})"><i class="ti ti-user"></i></button>`:''}
        <button class="btn sm" title="${TR('Renommer / réaffecter ce distributeur')}" onclick="reaffecterGroupe('${g.nom.replace(/'/g,'&#39;')}')"><i class="ti ti-arrow-move-right"></i></button>
      </div>
      <div id="bd-${gid}" style="display:${open?'block':'none'};overflow:hidden">
        <table class="table di-table" style="width:100%;table-layout:fixed">
          <colgroup>
            <col style="width:322px"><col style="width:96px"><col style="width:160px"><col style="width:128px">
            <col style="width:220px"><col style="width:128px"><col style="width:300px"><col><col style="width:44px">
          </colgroup>
          <thead><tr>
          <th style="text-align:left;padding:6px 8px;font-size:13px">${TR('Statut')}</th>
          <th style="text-align:left;padding:6px 10px;font-size:13px">${TR('Date')}</th>
          <th style="text-align:left;padding:6px 10px;font-size:13px">${TR('Contact')}</th>
          <th style="text-align:left;padding:6px 10px;font-size:13px">${TR('Téléphone')}</th>
          <th style="text-align:left;padding:6px 10px;font-size:13px">${TR('Mail')}</th>
          <th style="text-align:left;padding:6px 10px;font-size:13px">${TR('Ville / CP')}</th>
          <th style="text-align:left;padding:6px 10px;font-size:13px">${TR('Demande client')}</th>
          <th style="text-align:left;padding:6px 10px;font-size:13px">${TR('Annotation de suivi')}</th>
          <th style="text-align:center;padding:6px 6px;font-size:13px" title="${TR('Historique')}"><i class="ti ti-history"></i></th>
        </tr></thead><tbody>${lignes}</tbody></table>
      </div>
    </div>`;
  }).join('');
  el.innerHTML = barre + `<div class="card" style="padding:0">${blocs || `<div class="empty" style="padding:20px">${TR('Aucun distributeur.')}</div>`}</div>`;
  // Garder le focus + curseur dans la barre de recherche après re-render
  const qi=document.getElementById('di-distrib-q'); if(qi && DI_DISTRIB_Q){ qi.focus(); const v=qi.value; qi.value=''; qi.value=v; }
}
window.chargerDemandesParDistrib = chargerDemandesParDistrib;
function toggleDistribGroup(gid){
  const bd=document.getElementById('bd-'+gid), ic=document.getElementById('ic-'+gid); if(!bd) return;
  const open = bd.style.display==='none';
  if(open){
    // Un seul distributeur ouvert à la fois : on ferme tous les autres
    document.querySelectorAll('[id^="bd-dg"]').forEach(x=>{ if(x!==bd) x.style.display='none'; });
    document.querySelectorAll('[id^="ic-dg"]').forEach(x=>{ if(x!==ic){ x.classList.add('ti-eye'); x.classList.remove('ti-eye-off'); } });
    DI_OPEN.clear();
  }
  bd.style.display = open?'block':'none';
  if(ic){ ic.classList.toggle('ti-eye',!open); ic.classList.toggle('ti-eye-off',open); }
  const nom=(window._DI_GID2NOM||{})[gid];
  if(nom){ if(open) DI_OPEN.add(nom); else DI_OPEN.delete(nom); }
}
window.toggleDistribGroup = toggleDistribGroup;
function toggleTousDistrib(open){
  document.querySelectorAll('[id^="bd-dg"]').forEach(bd=>{ bd.style.display = open?'block':'none'; });
  document.querySelectorAll('[id^="ic-dg"]').forEach(ic=>{ ic.classList.toggle('ti-eye',!open); ic.classList.toggle('ti-eye-off',open); });
  const map=window._DI_GID2NOM||{};
  if(open){ Object.values(map).forEach(n=>DI_OPEN.add(n)); } else { DI_OPEN.clear(); }
}
window.toggleTousDistrib = toggleTousDistrib;
async function relancerContact(id, email){
  const dest = prompt(TR('Envoyer la demande de retour (au distributeur) à :'), email||'');
  if(!dest) return;
  try{ const r = await API.relanceContactInfo(id, dest);
    toast(TR('Relance envoyée à ')+r.to,'ti-mail','var(--success)');
    if(DEMANDES_VUE==='distrib') chargerDemandesParDistrib(); else if(STATE.view==='demandes') chargerDemandesGlobal(); else if(STATE.view==='client') chargerDemandesFiche(STATE.clientId);
  }catch(e){ toast('Erreur : '+e.message,'ti-alert-circle','var(--danger)'); }
}
window.relancerContact = relancerContact;
async function reaffecterGroupe(nom){
  // Fenêtre de rattachement / renommage avec autocomplétion des fiches Clients
  const g = (window._DI_GROUPS||{})[nom]; if(!g){ return; }
  await ensureClientsCache();
  if(!window._DISTRIB_NOMS){ try{ window._DISTRIB_NOMS = await API.distributeursReferences(); }catch(e){ window._DISTRIB_NOMS=[]; } }
  const clientNoms=(window._clientsCache||[]).map(c=>c.nom).filter(Boolean);
  const noms=[...new Set([...clientNoms, ...(window._DISTRIB_NOMS||[])])].filter(n=>n&&n.trim()&&n.trim()!=='0').sort((a,b)=>_diKey(a)<_diKey(b)?-1:_diKey(a)>_diKey(b)?1:0);
  window._DI_NOMS_LISTE = noms;
  showModal(`<div class="modal-header"><i class="ti ti-arrow-move-right" style="color:var(--accent)"></i><h2>${TR('Rattacher / renommer le distributeur')}</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body">
      <input type="hidden" id="di-client-id" value="${g.client_id||''}">
      <div style="font-size:15px;color:var(--text2);margin-bottom:12px"><strong>${g.items.length}</strong> ${TR('demande(s) actuellement sous')} « <strong>${esc(nom)}</strong> ».</div>
      <div class="form-group"><label class="form-label">${TR('Rattacher à ce distributeur (fiche Clients) ou nouveau nom')}</label>
        <div style="position:relative">
          <input class="form-input" id="di-distrib" autocomplete="off" value="${esc(nom)}" placeholder="${TR('Nom du distributeur')}" oninput="diDistribInput(this.value)" onfocus="diDistribInput(this.value)" onblur="setTimeout(diDistribHideDrop,200)">
          <div id="di-distrib-drop" style="display:none;position:absolute;z-index:60;left:0;right:0;top:calc(100% + 2px);max-height:240px;overflow:auto;background:rgba(255,255,255,0.98);border:0.5px solid var(--border);border-radius:10px;box-shadow:0 8px 24px rgba(30,60,110,.18)"></div>
        </div>
        <div id="di-distrib-lien" style="font-size:14px;margin-top:4px"></div></div>
      <div style="font-size:13px;color:var(--text3)">${TR('Choisissez une fiche existante dans la liste pour un rattachement correct, ou tapez un nouveau nom.')}</div>
    </div>
    <div class="modal-footer"><button class="btn" onclick="closeModal()">${t('btn_annuler')||'Annuler'}</button><button class="btn primary" onclick="confirmerReaffectation('${nom.replace(/'/g,'&#39;')}')"><i class="ti ti-check"></i> ${t('btn_enregistrer')||'Enregistrer'}</button></div>`);
  setTimeout(()=>{ const di=$('di-distrib'); if(di) diDistribChange(di.value); },0);
}
window.reaffecterGroupe = reaffecterGroupe;
async function confirmerReaffectation(nom){
  const g = (window._DI_GROUPS||{})[nom]; if(!g){ return; }
  const nn = (gv('di-distrib')||'').trim(); if(!nn){ toast(TR('Nom vide'),'ti-alert-circle','var(--warning)'); return; }
  const clientId = gv('di-client-id') || null;
  try{
    const r = await API.reaffecterDemandes({ ids: g.items.map(x=>x.id), nouveau_nom: nn, client_id: clientId });
    closeModal();
    toast(`${r.deplaces} ${TR('demande(s) déplacée(s) vers')} « ${nn} »${r.lie_client?(' — '+TR('lié à la fiche')):''}`,'ti-check','var(--success)');
    window._DISTRIB_NOMS = null;
    chargerDemandesParDistrib();
  }catch(e){ toast('Erreur : '+e.message,'ti-alert-circle','var(--danger)'); }
}
window.confirmerReaffectation = confirmerReaffectation;
function voirDemandesDistrib(nom){ DEMANDES_FILTRE={statut:'',non_traitees:false,q:nom}; DEMANDES_VUE='liste'; render(); }
window.voirDemandesDistrib = voirDemandesDistrib;

// ── Ajout / modification ──
async function modalDemande(clientId, distribNom, id){
  await ensureClientsCache();
  let d = { statut:'transmise', date_transmission:new Date().toISOString().slice(0,10) };
  if(id){ try{ const all = (window._DI_ROWS||[]); d = all.find(x=>x.id===id) || await API.demandesInfo({}).then(r=>r.find(x=>x.id===id)); }catch(e){} }
  else if(clientId){ d.client_id=clientId; d.distributeur_nom=distribNom||((window._clientsCache||[]).find(c=>c.id===clientId)||{}).nom||''; }
  // Liste de référence : fiches clients (distributeurs) + distributeurs déjà présents dans les demandes
  if(!window._DISTRIB_NOMS){ try{ window._DISTRIB_NOMS = await API.distributeursReferences(); }catch(e){ window._DISTRIB_NOMS=[]; } }
  const clientNoms = (window._clientsCache||[]).filter(c=>c.type!=='Particulier').map(c=>c.nom).filter(Boolean);
  const noms=[...new Set([...clientNoms, ...(window._DISTRIB_NOMS||[])])]
    .filter(n=>n && n.trim() && n.trim()!=='0')
    .sort((a,b)=>_diKey(a)<_diKey(b)?-1:_diKey(a)>_diKey(b)?1:0);
  window._DI_NOMS_LISTE = noms;
  showModal(`<div class="modal-header"><i class="ti ti-address-book" style="color:var(--accent)"></i><h2>${id?TR('Modifier la demande'):TR("Nouvelle demande d'information")}</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body">
      <input type="hidden" id="di-id" value="${id||''}">
      <input type="hidden" id="di-client-id" value="${d.client_id||''}">
      <div class="form-group"><label class="form-label">${TR('Distributeur')}</label>
        <div style="position:relative">
          <input class="form-input" id="di-distrib" autocomplete="off" value="${esc(d.distributeur_nom||'')}" placeholder="${TR('Nom du distributeur (lié à une fiche existante)')}" oninput="diDistribInput(this.value)" onfocus="diDistribInput(this.value)" onblur="setTimeout(diDistribHideDrop,200)">
          <div id="di-distrib-drop" style="display:none;position:absolute;z-index:60;left:0;right:0;top:calc(100% + 2px);max-height:240px;overflow:auto;background:rgba(255,255,255,0.98);border:0.5px solid var(--border);border-radius:10px;box-shadow:0 8px 24px rgba(30,60,110,.18)"></div>
        </div>
        <div id="di-distrib-lien" style="font-size:14px;margin-top:4px"></div></div>
      <div class="grid-2">
        <div class="form-group"><label class="form-label">${TR('Nom du contact / patient')}</label><input class="form-input" id="di-nom" value="${esc(d.nom||'')}"></div>
        <div class="form-group"><label class="form-label">${TR('Téléphone')}</label><input class="form-input" id="di-tel" value="${esc(fmtTel(d.telephone||''))}"></div>
        <div class="form-group"><label class="form-label">${TR('Ville')}</label><input class="form-input" id="di-ville" value="${esc(d.ville||'')}"></div>
        <div class="form-group"><label class="form-label">${TR('Code postal')}</label><input class="form-input" id="di-cp" value="${esc(d.cp||'')}"></div>
        <div class="form-group"><label class="form-label">${TR('E-mail')}</label><input class="form-input" id="di-email" value="${esc(d.email||'')}"></div>
        <div class="form-group"><label class="form-label">${TR('Statut')}</label><select class="form-input" id="di-statut">${diStatutOptions(d.statut)}</select></div>
        <div class="form-group"><label class="form-label">${TR('Date de transmission')}</label><input class="form-input" id="di-date" type="date" value="${(d.date_transmission||'').slice(0,10)}"></div>
        <div class="form-group"><label class="form-label">${TR('Relance mail (date)')}</label><input class="form-input" id="di-rel-mail" type="date" value="${(d.relance_mail_date||'').slice(0,10)}"></div>
        <div class="form-group"><label class="form-label">${TR('Relance téléphonique (date)')}</label><input class="form-input" id="di-rel-tel" type="date" value="${(d.relance_tel_date||'').slice(0,10)}"></div>
      </div>
      <div class="form-group"><label class="form-label">${TR('Demande client')}</label><textarea class="form-input" id="di-demande" rows="2" placeholder="${TR('Ce que demande / recherche le client')}">${esc(d.demande_client||'')}</textarea></div>
      <div class="form-group"><label class="form-label">${TR('Annotation de suivi')}</label><textarea class="form-input" id="di-annot" rows="2">${esc(d.annotation||'')}</textarea></div>
    </div>
    <div class="modal-footer"><button class="btn" onclick="closeModal()">${t('btn_annuler')||'Annuler'}</button><button class="btn primary" onclick="saveDemande()"><i class="ti ti-check"></i>${t('btn_enregistrer')||'Enregistrer'}</button></div>`);
  setTimeout(()=>{ const di=$('di-distrib'); if(di) diDistribChange(di.value); },0);
}
window.modalDemande = modalDemande;
function diDistribChange(nom){
  const val=(nom||'').trim();
  const m=(window._clientsCache||[]).find(c=>(c.nom||'').toLowerCase()===val.toLowerCase());
  const h=$('di-client-id'); if(h) h.value = m?m.id:'';
  const lien=$('di-distrib-lien');
  if(lien){
    if(!val){ lien.innerHTML=''; }
    else if(m){ lien.innerHTML=`<span style="color:var(--success)"><i class="ti ti-link"></i> ${TR('Lié à la fiche')} : <strong>${esc(m.nom)}</strong></span>`; }
    else { lien.innerHTML=`<span style="color:var(--text3)"><i class="ti ti-alert-triangle"></i> ${TR('Nouveau distributeur (non lié à une fiche existante)')}</span>`; }
  }
}
window.diDistribChange = diDistribChange;
// Autocomplétion personnalisée (la datalist native ne s'affiche plus au-delà de ~1000 options)
function diDistribInput(val){
  const drop=document.getElementById('di-distrib-drop'); if(!drop) return;
  diDistribChange(val);
  const q=_diKey(val);
  const list=window._DI_NOMS_LISTE||[];
  const matches=(q?list.filter(n=>_diKey(n).includes(q)):list).slice(0,15);
  window._DI_MATCH=matches;
  if(!matches.length){ drop.style.display='none'; return; }
  drop.innerHTML=matches.map((n,i)=>`<div onmousedown="event.preventDefault();diDistribPick(${i})" onmouseover="this.style.background='rgba(46,124,246,.10)'" onmouseout="this.style.background='transparent'" style="padding:8px 11px;cursor:pointer;font-size:15px;color:var(--text);border-bottom:0.5px solid var(--border)">${esc(n)}</div>`).join('');
  drop.style.display='block';
}
window.diDistribInput=diDistribInput;
function diDistribPick(i){
  const n=(window._DI_MATCH||[])[i]; if(n==null) return;
  const inp=$('di-distrib'); if(inp) inp.value=n;
  diDistribChange(n);
  diDistribHideDrop();
}
window.diDistribPick=diDistribPick;
function diDistribHideDrop(){ const d=document.getElementById('di-distrib-drop'); if(d) d.style.display='none'; }
window.diDistribHideDrop=diDistribHideDrop;
async function saveDemande(){
  const id=gv('di-id');
  const data={
    client_id: gv('di-client-id')||null, distributeur_nom: gv('di-distrib')||null,
    nom: gv('di-nom')||null, telephone: gv('di-tel')||null, ville: gv('di-ville')||null, cp: gv('di-cp')||null,
    email: gv('di-email')||null, statut: gv('di-statut')||'transmise',
    date_transmission: gv('di-date')||null, annotation: gv('di-annot')||null,
    demande_client: gv('di-demande')||null,
    relance_mail_date: gv('di-rel-mail')||null, relance_tel_date: gv('di-rel-tel')||null
  };
  try{ if(id){ await API.updateDemandeInfo(id,data); } else { await API.createDemandeInfo(data); }
    closeModal(); toast(TR('Demande enregistrée'),'ti-check','var(--success)');
    rafraichirDemandes(gv('di-client-id')||STATE.clientId);
  }catch(e){ toast('Erreur : '+e.message,'ti-alert-circle','var(--danger)'); }
}
window.saveDemande = saveDemande;
function rafraichirDemandes(clientId){
  window._DISTRIB_NOMS = null;   // recharger l'autocomplétion (nouveaux distributeurs)
  if(STATE.view==='demandes'){ if(DEMANDES_VUE==='distrib') chargerDemandesParDistrib(); else chargerDemandesGlobal(); }
  else if(STATE.view==='client') chargerDemandesFiche(clientId||STATE.clientId);
}
window.rafraichirDemandes = rafraichirDemandes;

function menuDemandeStatut(id){
  const d = trouverDemande(id) || {};
  const today = new Date().toISOString().slice(0,10);
  showModal(`<div class="modal-header"><i class="ti ti-adjustments" style="color:var(--accent)"></i><h2>${TR('Changer le statut')}</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body">
      <div class="form-group"><label class="form-label">${TR('Date du changement')}</label>
        <input class="form-input" type="date" id="di-statut-date" value="${today}"></div>
      <div style="font-size:13px;color:var(--text3);margin-bottom:8px">${TR('Statut actuel')} : ${d.statut?diBadge(d.statut):'—'}</div>
      <div style="display:flex;flex-direction:column;gap:7px">
        ${Object.keys(DI_STATUTS).map(k=>`<button class="btn" style="justify-content:flex-start;border-left:4px solid ${DI_STATUTS[k].c}${k===d.statut?';background:var(--bg2,#eef1f4)':''}" onclick="setDemandeStatut(${id},'${k}')">${DI_STATUTS[k].l}${k===d.statut?' ✓':''}</button>`).join('')}
      </div>
    </div>`);
}
window.menuDemandeStatut = menuDemandeStatut;
async function setDemandeStatut(id, statut){
  const date = (document.getElementById('di-statut-date')||{}).value || '';
  try{ await API.setDemandeInfoStatut(id, statut, date?{date_statut:date}:{}); closeModal(); toast(TR('Statut mis à jour'),'ti-check','var(--success)');
    rafraichirDemandes();
  }catch(e){ toast('Erreur : '+e.message,'ti-alert-circle','var(--danger)'); }
}
window.setDemandeStatut = setDemandeStatut;
async function supprDemande(id){
  if(!confirm(TR('Supprimer cette demande ?'))) return;
  try{ await API.deleteDemandeInfo(id); toast(TR('Supprimé'),'ti-trash');
    rafraichirDemandes();
  }catch(e){ toast('Erreur : '+e.message,'ti-alert-circle','var(--danger)'); }
}
window.supprDemande = supprDemande;

async function relancerDemandes(clientId, email){
  const dest = prompt(TR('Envoyer la demande de retour à :'), email||'');
  if(!dest) return;
  try{ const r = await API.relanceDemandesInfo(clientId, dest);
    toast(TR('Relance envoyée à ')+r.to+' ('+r.count+')','ti-mail','var(--success)');
    if(STATE.view==='client') chargerDemandesFiche(clientId); else if(STATE.view==='demandes') chargerDemandesGlobal();
  }catch(e){ toast('Erreur : '+e.message,'ti-alert-circle','var(--danger)'); }
}
window.relancerDemandes = relancerDemandes;

// Export CSV (ouvrable dans Excel)
async function exporterDemandes(clientId){
  let rows;
  try{ rows = clientId ? await API.demandesInfo({client_id:clientId}) : (window._DI_ROWS || await API.demandesInfo({})); }catch(e){ toast('Erreur : '+e.message,'ti-alert-circle','var(--danger)'); return; }
  if(!rows.length){ toast(TR('Aucune demande à exporter'),'ti-alert-circle','var(--warning)'); return; }
  const esc2 = v => { v=(v==null?'':String(v)); return /[";\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v; };
  const head=['Distributeur','Date','Contact','Téléphone','Email','Ville','CP','Demande client','Relance mail','Relance tél.','Annotation de suivi','Statut'];
  const lines=[head.join(';')].concat(rows.map(d=>[
    d.client_nom_actuel||d.distributeur_nom||'', (d.date_transmission||'').slice(0,10), d.nom||'', d.telephone||'', d.email||'',
    d.ville||'', d.cp||'', d.demande_client||'', (d.relance_mail_date||'').slice(0,10), (d.relance_tel_date||'').slice(0,10),
    d.annotation||'', (DI_STATUTS[d.statut]||{}).l||d.statut||''
  ].map(esc2).join(';')));
  const blob=new Blob(['﻿'+lines.join('\r\n')],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='demandes_informations.csv'; a.click(); URL.revokeObjectURL(url);
}
window.exporterDemandes = exporterDemandes;

// Import de l'historique Excel
async function importDemandesExcel(input){
  const f = input.files && input.files[0]; if(!f){ return; }
  const remplacer = confirm(TR("Remplacer tout l'historique des demandes existant ?")+"\n\n"+TR("OK = vider puis importer.   Annuler = ajouter à l'existant."));
  const fd2 = new FormData(); fd2.append('file', f);
  toast(TR('Import en cours…'),'ti-loader-2');
  try{
    const url = '/api/demandes-info/import-excel' + (remplacer ? '?remplacer=1' : '');
    const r = await fetch(url,{method:'POST',body:fd2}).then(x=>x.json());
    if(r.error){ toast('Erreur : '+r.error,'ti-alert-circle','var(--danger)'); input.value=''; return; }
    let msg = `${r.inserted} ${TR('demande(s) importée(s)')} — ${r.lies_distributeur} ${TR('reliées à un distributeur')}`;
    if(r.errors){ msg += ` — ${r.errors} ${TR('erreur(s)')}`; }
    toast(msg, r.errors ? 'ti-alert-triangle' : 'ti-check', r.errors ? 'var(--warning)' : 'var(--success)');
    if(STATE.view==='demandes') chargerDemandesGlobal();
  }catch(e){ toast('Erreur : '+e.message,'ti-alert-circle','var(--danger)'); }
  input.value='';
}
window.importDemandesExcel = importDemandesExcel;
