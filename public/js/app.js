// public/js/app.js v2

let STATE = { view:'dashboard', clientId:null, fauteuilId:null, q:'' };
let CACHE = { catalogue:[], params:{} };
let TMP_PRODUITS = [];

const fd  = d => { if(!d)return'—'; const[y,m,day]=d.split('-'); return`${day}/${m}/${y}`; };
const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const sc  = s => s==='Ouvert'?'ouvert':s==='Fermé'?'ferme':s==='En attente'?'attente':'ouvert';
const $   = id => document.getElementById(id);
const gv  = id => ($( id)||{}).value||'';

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

// ── Navigation ────────────────────────────────────────────────────
function setView(v, extra={}){
  STATE={view:v, clientId:extra.clientId||null, fauteuilId:extra.fauteuilId||null, q:''};
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.toggle('active', n.dataset.view===v));
  render();
}
document.querySelectorAll('.nav-item').forEach(n=>n.addEventListener('click',()=>setView(n.dataset.view)));

async function render(){
  const t=$('topbar-title'),c=$('content'),a=$('topbar-actions');
  a.innerHTML='';
  c.innerHTML='<div class="empty" style="padding-top:60px"><i class="ti ti-loader-2" style="font-size:28px;display:block;margin-bottom:8px"></i>Chargement…</div>';
  try{
    if(STATE.view==='dashboard')     await renderDashboard(t,c,a);
    else if(STATE.view==='clients')  await renderClients(t,c,a);
    else if(STATE.view==='client')   await renderClient(t,c,a);
    else if(STATE.view==='fauteuil') await renderFauteuil(t,c,a);
    else if(STATE.view==='interventions') await renderInterventions(t,c,a);
    else if(STATE.view==='expeditions')   await renderExpeditions(t,c,a);
    else if(STATE.view==='catalogue')     await renderCatalogue(t,c,a);
    else if(STATE.view==='rapports')      await renderRapports(t,c,a);
    else if(STATE.view==='alertes')       await renderAlertes(t,c,a);
    else if(STATE.view==='parametres')    await renderParametres(t,c,a);
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

async function renderDashboard(t,c,a){
  t.textContent='Tableau de bord';
  const{stats:s,recentes,par_mois,pieces_top,par_technicien}=await API.stats();
  const maxMois=Math.max(...par_mois.map(m=>m.total),1);
  c.innerHTML=`
    <div class="quick-search-bar">
      <div style="position:relative;flex:1;max-width:560px">
        <i class="ti ti-search" style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--text3);font-size:16px;pointer-events:none"></i>
        <input class="form-input" id="qs-input" placeholder="Rechercher un fauteuil par n° de série, modèle ou distributeur…"
          style="padding-left:34px;font-size:14px;border-radius:10px"
          oninput="quickSearch(this.value)"
          onkeydown="if(event.key==='Escape'){this.value='';clearQuickSearch();}">
      </div>
      <div id="qs-results" class="qs-results" style="display:none"></div>
      <label class="btn" style="cursor:pointer;white-space:nowrap">
        <i class="ti ti-file-import"></i>Importer Excel
        <input type="file" accept=".xlsx,.xls" style="display:none" onchange="importerExcel(this.files[0])">
      </label>
    </div>
    <div id="qs-import-progress" style="display:none;margin-bottom:12px"></div>
    <div class="grid-4" style="margin-bottom:12px">
      <div class="stat-card"><div class="stat-label">Interventions</div><div class="stat-value">${s.nb_interventions}</div></div>
      <div class="stat-card"><div class="stat-label">Ouvertes</div><div class="stat-value" style="color:var(--accent)">${s.ouvert}</div></div>
      <div class="stat-card"><div class="stat-label">En attente</div><div class="stat-value" style="color:var(--warning)">${s.attente}</div></div>
      <div class="stat-card"><div class="stat-label">Expéditions en cours</div><div class="stat-value" style="color:var(--accent)">${s.expeditions_cours}</div></div>
    </div>
    <div class="grid-4" style="margin-bottom:14px">
      <div class="stat-card"><div class="stat-label">Sous garantie</div><div class="stat-value" style="color:var(--success)">${s.garantie}</div></div>
      <div class="stat-card"><div class="stat-label">Hors garantie</div><div class="stat-value" style="color:var(--warning)">${s.hors_garantie}</div></div>
      <div class="stat-card"><div class="stat-label">Pièces en alerte stock</div><div class="stat-value" style="color:${s.pieces_alerte>0?'var(--danger)':'var(--text)'}">${s.pieces_alerte}</div></div>
      <div class="stat-card" style="cursor:pointer" onclick="setView('alertes')"><div class="stat-label">Alertes non lues</div><div class="stat-value" style="color:${s.alertes_non_lues>0?'var(--danger)':'var(--text)'}">${s.alertes_non_lues}</div></div>
    </div>
    <div class="grid-2" style="margin-bottom:14px">
      <div class="card">
        <div class="section-title"><i class="ti ti-chart-bar"></i>Interventions / 12 mois</div>
        <div class="chart-bar">
          ${par_mois.map(m=>`<div class="chart-bar-col">
            <div style="font-size:9px;color:var(--text3)">${m.total}</div>
            <div class="chart-bar-fill" style="height:${Math.round(m.total/maxMois*70)}px;background:var(--accent)"></div>
            <div class="chart-bar-label">${m.mois.slice(5)}</div>
          </div>`).join('')}
        </div>
      </div>
      <div class="card">
        <div class="section-title"><i class="ti ti-box"></i>Pièces les plus utilisées (6 mois)</div>
        ${pieces_top.length===0?'<div style="font-size:12px;color:var(--text3)">Aucune donnée</div>':pieces_top.map(p=>`
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <div style="flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.designation)}</div>
            <div style="font-weight:700;font-size:12px;color:var(--accent)">${p.total_utilise}×</div>
          </div>`).join('')}
        ${par_technicien.length?`<div class="divider"></div><div class="section-title" style="margin-top:8px"><i class="ti ti-user"></i>Par technicien</div>${par_technicien.map(t=>`<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px"><span>${esc(t.technicien)}</span><span style="font-weight:700">${t.total}</span></div>`).join('')}`:''}
      </div>
    </div>
    <div class="card">
      <div class="section-title"><i class="ti ti-tool"></i>Récentes activités</div>
      <div class="table-wrap"><table class="t">
        <thead><tr><th>Date</th><th>Client</th><th>Modèle</th><th>Type</th><th>Garantie</th><th>Statut</th></tr></thead>
        <tbody>${recentes.map(i=>`<tr onclick="viewIntervention(${i.id})">
          <td>${fd(i.date)}</td><td>${esc(i.client_nom)}</td>
          <td><div>${esc(i.modele)}</div><div class="mono" style="color:var(--text3)">${esc(i.serie)}</div></td>
          <td>${esc(i.type)}</td>
          <td><span class="badge ${i.garantie?'g':'hg'}">${i.garantie?'Garantie':'HG'}</span></td>
          <td><span class="badge ${sc(i.statut)}">${esc(i.statut)}</span></td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>`;
}

// ── CLIENTS ───────────────────────────────────────────────────────

async function renderClients(t,c,a){
  t.textContent='Clients / Distributeurs';
  a.innerHTML=`<input class="search-bar" placeholder="Rechercher..." value="${esc(STATE.q)}" oninput="STATE.q=this.value;renderClients(document.getElementById('topbar-title'),document.getElementById('content'),document.getElementById('topbar-actions'))">
    <button class="btn primary" onclick="modalNewClient()"><i class="ti ti-plus"></i>Nouveau client</button>`;
  const list=await API.clients(STATE.q);
  c.innerHTML=`<div class="table-wrap"><table class="t">
    <thead><tr><th>Distributeur</th><th>Contact</th><th>Ville</th><th>Fauteuils</th><th>Interventions</th><th></th></tr></thead>
    <tbody>${list.map(cl=>`<tr onclick="setView('client',{clientId:${cl.id}})">
      <td><div style="font-weight:600">${esc(cl.nom)}</div><div style="font-size:11px;color:var(--text3)">${esc(cl.type)}</div></td>
      <td><div>${esc(cl.contact||'')}</div><div style="font-size:11px;color:var(--text3)">${esc(cl.email||'')}</div></td>
      <td>${esc(cl.ville||'')}</td><td>${cl.nb_fauteuils}</td><td>${cl.nb_interventions}</td>
      <td><button class="btn sm" onclick="event.stopPropagation();setView('client',{clientId:${cl.id}})"><i class="ti ti-arrow-right"></i></button></td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

async function renderClient(t,c,a){
  const cl=await API.client(STATE.clientId);
  t.textContent=cl.nom;
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
        </table>
        <div style="margin-top:10px;display:flex;gap:6px">
          <button class="btn sm" onclick="modalEditClient(${cl.id})"><i class="ti ti-edit"></i>Modifier</button>
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
      ${cl.fauteuils.length===0?'<div class="empty"><i class="ti ti-wheelchair"></i>Aucun fauteuil</div>':cl.fauteuils.map(f=>`
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
    </div>`;
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

async function renderFauteuil(t,c,a){
  const f=await API.fauteuil(STATE.fauteuilId);
  const inters=f.interventions||[];
  t.textContent=`${f.modele} — ${f.serie}`;
  a.innerHTML=`
    <button class="btn sm success" onclick="exportFauteuilPDF(${f.id})"><i class="ti ti-file-type-pdf"></i>PDF</button>
    <button class="btn sm" onclick="modalEditFauteuil(${f.id})"><i class="ti ti-edit"></i>Modifier</button>
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
      ${inters.length===0?'<div class="empty"><i class="ti ti-tool"></i>Aucune intervention</div>':inters.map(i=>`
        <div style="padding:10px;border-bottom:0.5px solid var(--border);cursor:pointer" onclick="viewIntervention(${i.id})" onmouseover="this.style.background='var(--bg)'" onmouseout="this.style.background=''">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;flex-wrap:wrap">
            <span style="font-weight:700;font-size:13px">${esc(i.type)}</span>
            <span class="badge ${i.garantie?'g':'hg'}">${i.garantie?'Garantie':'HG'}</span>
            <span class="badge ${sc(i.statut)}">${esc(i.statut)}</span>
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

async function renderInterventions(t,c,a){
  t.textContent='Interventions';
  a.innerHTML=`
    <input class="search-bar" placeholder="Rechercher..." value="${esc(STATE.q)}" oninput="STATE.q=this.value;renderInterventions(document.getElementById('topbar-title'),document.getElementById('content'),document.getElementById('topbar-actions'))">
    <select class="search-bar" id="filter-statut" onchange="renderInterventions(document.getElementById('topbar-title'),document.getElementById('content'),document.getElementById('topbar-actions'))" style="width:130px">
      <option value="">Tous statuts</option><option>Ouvert</option><option>En attente</option><option>Fermé</option>
    </select>
    <button class="btn primary" onclick="modalNewIntervention(null,null)"><i class="ti ti-plus"></i>Nouvelle</button>`;
  const statut=$('filter-statut')?.value||'';
  const list=await API.interventions({q:STATE.q||undefined, statut:statut||undefined});
  c.innerHTML=`<div class="table-wrap"><table class="t">
    <thead><tr><th>Date</th><th>Client</th><th>Modèle / Série</th><th>Type</th><th>Description</th><th>Garantie</th><th>Statut</th><th>Tech.</th><th style="text-align:center">  </th></tr></thead>
    <tbody>${list.map(i=>`<tr onclick="viewIntervention(${i.id})">
      <td>${fd(i.date)}</td><td>${esc(i.client_nom||'')}</td>
      <td><div>${esc(i.modele)}</div><div class="mono" style="color:var(--text3)">${esc(i.serie)}</div></td>
      <td>${esc(i.type)}</td>
      <td style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(i.description||'')}</td>
      <td><span class="badge ${i.garantie?'g':'hg'}">${i.garantie?'Garantie':'HG'}</span></td>
      <td><span class="badge ${sc(i.statut)}">${esc(i.statut)}</span></td>
      <td>${esc(i.technicien||'')}</td>
      <td style="text-align:center;color:var(--text3);font-size:11px">${i.nb_photos||''}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

// ── EXPÉDITIONS ───────────────────────────────────────────────────

async function renderExpeditions(t,c,a){
  t.textContent='Expéditions en cours';
  a.innerHTML=`<button class="btn success" onclick="API.exportExcel('expeditions')"><i class="ti ti-file-spreadsheet"></i>Exporter Excel</button>`;
  const list=await API.expeditions();
  c.innerHTML=`
    <div style="font-size:12px;color:var(--text2);margin-bottom:12px">Interventions avec envoi enregistré mais sans retour, statut non fermé.</div>
    ${list.length===0?'<div class="empty"><i class="ti ti-truck-delivery"></i>Aucune expédition en attente de retour</div>':`
    <div class="table-wrap"><table class="t">
      <thead><tr><th>N°</th><th>Client</th><th>Fauteuil</th><th>Transporteur</th><th>N° suivi envoi</th><th>Date envoi</th><th>Jours attente</th><th>Statut</th></tr></thead>
      <tbody>${list.map(i=>`<tr onclick="viewIntervention(${i.id})">
        <td>#${i.id}</td><td>${esc(i.client_nom)}</td>
        <td><div>${esc(i.modele)}</div><div class="mono" style="color:var(--text3)">${esc(i.serie)}</div></td>
        <td>${esc(i.envoi_transporteur||'')}</td>
        <td class="mono">${esc(i.envoi_numero||'')}</td>
        <td>${fd(i.envoi_date)}</td>
        <td><span class="badge ${(i.jours_attente||0)>10?'urgent':(i.jours_attente||0)>5?'attente':'g'}">${i.jours_attente!=null?i.jours_attente+' j':'—'}</span></td>
        <td><span class="badge ${sc(i.statut)}">${esc(i.statut)}</span></td>
      </tr>`).join('')}</tbody>
    </table></div>`}`;
}

// ── CATALOGUE ─────────────────────────────────────────────────────

async function renderCatalogue(t,c,a){
  t.textContent='Catalogue pièces';
  a.innerHTML=`
    <input class="search-bar" placeholder="Rechercher..." value="${esc(STATE.q)}" oninput="STATE.q=this.value;renderCatalogue(document.getElementById('topbar-title'),document.getElementById('content'),document.getElementById('topbar-actions'))">
    <button class="btn" onclick="API.exportExcel('catalogue')"><i class="ti ti-file-spreadsheet"></i>Excel</button>
    <button class="btn primary" onclick="modalPiece()"><i class="ti ti-plus"></i>Ajouter pièce</button>`;
  const list=await API.catalogue(STATE.q);
  CACHE.catalogue=list;
  c.innerHTML=`<div class="table-wrap"><table class="t">
    <thead><tr><th>Référence</th><th>Désignation</th><th>Fournisseur</th><th>Réf fournisseur</th><th>Prix HT</th><th>Stock</th><th>Seuil</th></tr></thead>
    <tbody>${list.map(p=>`<tr onclick="modalPiece(${p.id})">
      <td class="mono">${esc(p.ref)}</td><td>${esc(p.designation)}</td>
      <td style="color:var(--text3)">${esc(p.fournisseur||'')}</td>
      <td class="mono">${esc(p.ref_fournisseur||'')}</td>
      <td style="font-weight:700">${p.pxht.toFixed(2)} €</td>
      <td><span class="badge ${p.stock===0?'urgent':p.stock<=p.stock_alerte?'attente':'g'}">${p.stock}</span></td>
      <td style="font-size:11px;color:var(--text3)">${p.stock_alerte}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

// ── RAPPORTS ──────────────────────────────────────────────────────

async function renderRapports(t,c,a){
  t.textContent='Rapports & exports';
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

async function renderAlertes(t,c,a){
  t.textContent='Alertes';
  a.innerHTML=`<button class="btn" onclick="API.marquerToutesLues().then(()=>{refreshBadges();render();})"><i class="ti ti-checks"></i>Tout marquer comme lu</button>`;
  const list=await API.alertes();
  const icons={relance:'ti-clock',retour_manquant:'ti-truck-return',garantie_expire:'ti-shield-x',stock_faible:'ti-alert-triangle',stock_zero:'ti-circle-x',intervention_fermee:'ti-circle-check'};
  const colors={relance:'var(--warning)',retour_manquant:'var(--accent)',garantie_expire:'var(--danger)',stock_faible:'var(--warning)',stock_zero:'var(--danger)',intervention_fermee:'var(--success)'};
  c.innerHTML=list.length===0?'<div class="empty"><i class="ti ti-bell-off"></i>Aucune alerte non lue</div>':
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

async function renderParametres(t,c,a){
  t.textContent='Paramètres';
  a.innerHTML=`<button class="btn primary" onclick="saveParametres()"><i class="ti ti-check"></i>Enregistrer</button>`;
  const p=await API.parametres();
  CACHE.params=p;
  c.innerHTML=`
    <div class="param-section">
      <h3><i class="ti ti-bell"></i>Notifications & alertes automatiques</h3>
      <div class="grid-2">
        <div class="form-group"><label class="form-label">Relance après (jours sans mise à jour)</label>
          <input class="form-input" id="p-relance" type="number" min="1" value="${p.relance_jours||7}"></div>
        <div class="form-group"><label class="form-label">Seuil stock alerte par défaut</label>
          <input class="form-input" id="p-stock-alerte" type="number" min="0" value="${p.stock_alerte_defaut||2}"></div>
      </div>
    </div>
    <div class="param-section">
      <h3><i class="ti ti-building"></i>Informations société</h3>
      <div class="form-group"><label class="form-label">Nom affiché dans les PDFs</label>
        <input class="form-input" id="p-societe" value="${esc(p.nom_societe||'Éloflex France')}"></div>
    </div>
    <div class="param-section">
      <h3><i class="ti ti-globe"></i>Portail client</h3>
      <div class="form-group"><label class="form-label">Portail client activé</label>
        <select class="form-input" id="p-portail"><option value="1" ${p.portail_actif==='1'?'selected':''}>Activé</option><option value="0" ${p.portail_actif!=='1'?'selected':''}>Désactivé</option></select>
      </div>
      <div style="font-size:12px;color:var(--text2)">Chaque client dispose d'un lien unique pour suivre ses interventions en lecture seule. Accessible depuis la fiche client.</div>
    </div>
    <div class="param-section">
      <h3><i class="ti ti-moon"></i>Apparence</h3>
      <div class="form-group"><label class="form-label">Mode sombre</label>
        <select class="form-input" id="p-dark" onchange="if(this.value==='1')document.body.classList.add('dark');else document.body.classList.remove('dark')">
          <option value="0" ${p.mode_sombre!=='1'?'selected':''}>Clair</option>
          <option value="1" ${p.mode_sombre==='1'?'selected':''}>Sombre</option>
        </select>
      </div>
    </div>
    <div class="param-section">
      <h3><i class="ti ti-refresh"></i>VosFactures</h3>
      <div class="form-group"><label class="form-label">Statut</label>
        <div id="vf-status-detail" style="font-size:12px;color:var(--text2)">Vérification…</div>
      </div>
      <button class="btn" onclick="syncVosFactures()"><i class="ti ti-refresh"></i>Synchroniser maintenant</button>
    </div>`;
  API.vfStatus().then(s=>{const el=$('vf-status-detail');if(el)el.innerHTML=s.configured?`<span style="color:var(--success)">✓ Compte configuré : ${esc(s.account||'')}${s.last_sync?' — Dernière sync : '+s.last_sync.created_at?.slice(0,16).replace('T',' '):''}</span>`:`<span style="color:var(--danger)">⚠ Non configuré — renseigner VOSFACTURES_API_TOKEN et VOSFACTURES_ACCOUNT dans .env</span>`;}).catch(()=>{});
}

async function saveParametres(){
  const p={
    relance_jours:gv('p-relance'),
    stock_alerte_defaut:gv('p-stock-alerte'),
    nom_societe:gv('p-societe'),
    portail_actif:gv('p-portail'),
    mode_sombre:gv('p-dark')
  };
  await API.saveParametres(p);
  if(p.mode_sombre==='1') document.body.classList.add('dark'); else document.body.classList.remove('dark');
  localStorage.setItem('dark', p.mode_sombre==='1'?'1':'0');
  toast('Paramètres enregistrés','ti-check');
}

// ── DÉTAIL INTERVENTION ───────────────────────────────────────────

async function viewIntervention(id){
  const[i,photos]=await Promise.all([API.intervention(id),API.photos(id)]);
  const total=(i.produits||[]).reduce((s,p)=>s+p.pxht*p.qte,0);
  showModal(`
    <div class="modal-header">
      <i class="ti ti-tool" style="font-size:18px;color:var(--accent)"></i>
      <h2>Intervention #${i.id} — ${esc(i.type)}</h2>
      <button class="btn sm success" onclick="exportInterventionPDF(${i.id})"><i class="ti ti-file-type-pdf"></i>PDF</button>
      <button class="btn sm" onclick="modalEditIntervention(${i.id})"><i class="ti ti-edit"></i></button>
      <button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button>
    </div>
    <div class="modal-body">
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
        <span class="badge ${i.garantie?'g':'hg'}">${i.garantie?'Sous garantie':'Hors garantie'}</span>
        ${i.garantie_auto?'<span style="font-size:10px;color:var(--text3)">détecté auto</span>':''}
        <span class="badge ${sc(i.statut)}">${esc(i.statut)}</span>
        <span style="font-size:11px;color:var(--text3);margin-left:auto">${fd(i.date)}</span>
      </div>
      <div class="grid-2" style="font-size:12px;margin-bottom:12px">
        <div><div class="stat-label">Client</div><div style="font-weight:600">${esc(i.client_nom||'')}</div></div>
        <div><div class="stat-label">Fauteuil</div><div style="font-weight:600">${esc(i.modele)} – <span class="mono">${esc(i.serie)}</span></div></div>
        ${i.num_facture?`<div><div class="stat-label">Facture VosFactures</div><div class="mono" style="color:var(--accent)">${esc(i.num_facture)}</div></div>`:''}
        <div><div class="stat-label">Technicien</div><div>${esc(i.technicien||'—')}</div></div>
      </div>
      <div class="form-group"><div class="form-label">Description</div><div style="font-size:12px;background:var(--bg);padding:8px;border-radius:var(--radius)">${esc(i.description||'—')}</div></div>
      ${i.notes?`<div class="form-group"><div class="form-label">Notes</div><div style="font-size:12px;color:var(--text2)">${esc(i.notes)}</div></div>`:''}
      <div class="divider"></div>
      <div class="section-title"><i class="ti ti-box"></i>Pièces</div>
      ${(i.produits||[]).length===0?'<div style="font-size:12px;color:var(--text3)">Aucune pièce</div>':`
        <table class="t"><thead><tr><th>Désignation</th><th>Réf</th><th>Qté</th><th>PU HT</th><th>Total HT</th></tr></thead>
        <tbody>${(i.produits||[]).map(p=>`<tr><td>${esc(p.designation)}</td><td class="mono">${esc(p.ref||'')}</td><td>${p.qte}</td><td>${p.pxht.toFixed(2)} €</td><td style="font-weight:700">${(p.pxht*p.qte).toFixed(2)} €</td></tr>`).join('')}</tbody></table>
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
      <button class="btn danger" onclick="if(confirm('Supprimer ?'))API.deleteIntervention(${i.id}).then(()=>{closeModal();render();toast('Supprimé','ti-trash');})"><i class="ti ti-trash"></i></button>
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
</div>`;}
function modalNewClient(){showModal(`<div class="modal-header"><i class="ti ti-user-plus" style="font-size:18px;color:var(--accent)"></i><h2>Nouveau client</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div><div class="modal-body">${clientForm()}</div><div class="modal-footer"><button class="btn" onclick="closeModal()">Annuler</button><button class="btn primary" onclick="saveClient()"><i class="ti ti-check"></i>Enregistrer</button></div>`);}
async function modalEditClient(id){const cl=await API.client(id);showModal(`<div class="modal-header"><i class="ti ti-edit" style="font-size:18px;color:var(--accent)"></i><h2>Modifier client</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div><div class="modal-body">${clientForm(cl)}</div><div class="modal-footer"><button class="btn danger" onclick="deleteClient(${id})"><i class="ti ti-trash"></i></button><button class="btn" onclick="closeModal()">Annuler</button><button class="btn primary" onclick="saveClient(${id})"><i class="ti ti-check"></i>Enregistrer</button></div>`);}
async function saveClient(id){const data={nom:gv('f-nom'),type:gv('f-type'),contact:gv('f-contact'),email:gv('f-email'),tel:gv('f-tel'),ville:gv('f-ville')};if(!data.nom){alert('Nom requis');return;}try{if(id)await API.updateClient(id,data);else await API.createClient(data);toast(id?'Client mis à jour':'Client créé');closeModal();render();}catch(e){alert(e.message);}}
async function deleteClient(id){if(!confirm('Supprimer ce client ?'))return;await API.deleteClient(id);toast('Supprimé','ti-trash');closeModal();setView('clients');}

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

function fauteuilForm(d={}){const mods=['Eloflex S','Eloflex M','Eloflex L','Eloflex M+','Eloflex XL'];return `<div class="grid-2">
  <div class="form-group"><label class="form-label">Modèle *</label><select class="form-input" id="f-modele">${mods.map(m=>`<option ${d.modele===m?'selected':''}>${m}</option>`).join('')}</select></div>
  <div class="form-group"><label class="form-label">N° de série *</label><input class="form-input" id="f-serie" value="${esc(d.serie||'')}"></div>
  <div class="form-group"><label class="form-label">Année</label><input class="form-input" id="f-annee" type="number" value="${d.annee||new Date().getFullYear()}"></div>
  <div class="form-group"><label class="form-label">Couleur</label><input class="form-input" id="f-couleur" value="${esc(d.couleur||'')}"></div>
  <div class="form-group"><label class="form-label">Date d'achat</label><input class="form-input" id="f-dateachat" type="date" value="${d.date_achat||''}"></div>
  <div class="form-group"><label class="form-label">Durée garantie (mois)</label><input class="form-input" id="f-garduree" type="number" min="0" value="${d.duree_garantie_mois||24}"></div>
  <div class="form-group" style="grid-column:1/-1"><label class="form-label">N° facture VosFactures</label><input class="form-input" id="f-facture" value="${esc(d.num_facture||'')}"></div>
</div>
<div class="form-group"><label class="form-label">Notes</label><textarea class="form-input" id="f-notes">${esc(d.notes||'')}</textarea></div>`;}
function modalNewFauteuil(clientId){showModal(`<div class="modal-header"><i class="ti ti-wheelchair" style="font-size:18px;color:var(--accent)"></i><h2>Nouveau fauteuil</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div><div class="modal-body">${fauteuilForm()}</div><div class="modal-footer"><button class="btn" onclick="closeModal()">Annuler</button><button class="btn primary" onclick="saveFauteuil(null,${clientId})"><i class="ti ti-check"></i>Enregistrer</button></div>`);}
async function modalEditFauteuil(id){const f=await API.fauteuil(id);showModal(`<div class="modal-header"><i class="ti ti-edit" style="font-size:18px;color:var(--accent)"></i><h2>Modifier fauteuil</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div><div class="modal-body">${fauteuilForm(f)}</div><div class="modal-footer"><button class="btn danger" onclick="deleteFauteuil(${id},${f.client_id})"><i class="ti ti-trash"></i></button><button class="btn" onclick="closeModal()">Annuler</button><button class="btn primary" onclick="saveFauteuil(${id})"><i class="ti ti-check"></i>Enregistrer</button></div>`);}
async function saveFauteuil(id,clientId){const data={client_id:clientId,modele:gv('f-modele'),serie:gv('f-serie'),annee:parseInt(gv('f-annee')),couleur:gv('f-couleur'),date_achat:gv('f-dateachat'),duree_garantie_mois:parseInt(gv('f-garduree'))||24,num_facture:gv('f-facture'),notes:gv('f-notes')};if(!data.serie){alert('N° de série requis');return;}try{if(id)await API.updateFauteuil(id,data);else await API.createFauteuil(data);toast(id?'Fauteuil mis à jour':'Fauteuil créé');closeModal();render();}catch(e){alert(e.message);}}
async function deleteFauteuil(id,clientId){if(!confirm('Supprimer ce fauteuil et ses interventions ?'))return;await API.deleteFauteuil(id);toast('Supprimé','ti-trash');closeModal();setView('client',{clientId});}

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
  <div class="modal-header"><i class="ti ti-tool" style="font-size:18px;color:var(--accent)"></i><h2>${i?`Modifier #${i.id}`:'Nouvelle intervention'}</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
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
            placeholder="Taper n° de série, modèle ou distributeur…"
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
            <button type="button" class="btn sm" onclick="toggleNewFauteuilInline()">Annuler</button>
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
      <div class="form-group"><label class="form-label">Date</label><input class="form-input" id="f-date" type="date" value="${d.date||new Date().toISOString().split('T')[0]}"></div>
      <div class="form-group"><label class="form-label">Type</label><select class="form-input" id="f-type">${['Réparation','Maintenance','Diagnostic','Échange standard'].map(t=>`<option ${d.type===t?'selected':''}>${t}</option>`).join('')}</select></div>
      <div class="form-group"><label class="form-label">Statut</label><select class="form-input" id="f-statut">${['Ouvert','En attente','Fermé'].map(s=>`<option ${d.statut===s?'selected':''}>${s}</option>`).join('')}</select></div>
      <div class="form-group"><label class="form-label">Technicien</label><input class="form-input" id="f-tech" value="${esc(d.technicien||'Frédéric')}"></div>
    </div>
    <div class="form-group"><label class="form-label">Garantie</label>
      <div style="display:flex;gap:12px;margin-top:4px">
        <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:12px"><input type="radio" name="garantie" value="1" ${!i||i.garantie?'checked':''}> <span class="badge g">Sous garantie</span></label>
        <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:12px"><input type="radio" name="garantie" value="0" ${i&&!i.garantie?'checked':''}> <span class="badge hg">Hors garantie</span></label>
      </div>
    </div>
    <div class="form-group"><label class="form-label">Description *</label><textarea class="form-input" id="f-desc">${esc(d.description||'')}</textarea></div>
    <div class="form-group"><label class="form-label">Notes internes</label><textarea class="form-input" id="f-notes" style="min-height:52px">${esc(d.notes||'')}</textarea></div>
    <div class="divider"></div>
    <div class="section-title"><i class="ti ti-box"></i>Pièces utilisées</div>
    <div id="produits-list" style="margin-bottom:8px"></div>
    <button class="btn sm" onclick="addProduitRow()"><i class="ti ti-plus"></i>Ajouter une pièce</button>
    <div class="divider"></div>
    <div class="section-title"><i class="ti ti-send"></i>Expédition</div>
    <div class="tracking-block"><div class="grid-2">
      <div class="form-group" style="margin-bottom:0"><label class="form-label">Transporteur</label><select class="form-input" id="f-env-trans"><option value="">-- Aucun --</option><option ${d.envoi_transporteur==='La Poste'?'selected':''}>La Poste</option><option ${d.envoi_transporteur==='Chronopost'?'selected':''}>Chronopost</option></select></div>
      <div class="form-group" style="margin-bottom:0"><label class="form-label">Date</label><input class="form-input" id="f-env-date" type="date" value="${d.envoi_date||''}"></div>
      <div class="form-group" style="margin-bottom:0;grid-column:1/-1"><label class="form-label">N° de suivi</label><input class="form-input" id="f-env-num" value="${esc(d.envoi_numero||'')}"></div>
    </div></div>
    <div class="section-title" style="margin-top:4px"><i class="ti ti-arrow-back-up"></i>Retour</div>
    <div class="tracking-block"><div class="grid-2">
      <div class="form-group" style="margin-bottom:0"><label class="form-label">Transporteur</label><select class="form-input" id="f-ret-trans"><option value="">-- Aucun --</option><option ${d.retour_transporteur==='La Poste'?'selected':''}>La Poste</option><option ${d.retour_transporteur==='Chronopost'?'selected':''}>Chronopost</option></select></div>
      <div class="form-group" style="margin-bottom:0"><label class="form-label">Date</label><input class="form-input" id="f-ret-date" type="date" value="${d.retour_date||''}"></div>
      <div class="form-group" style="margin-bottom:0;grid-column:1/-1"><label class="form-label">N° de suivi retour</label><input class="form-input" id="f-ret-num" value="${esc(d.retour_numero||'')}"></div>
    </div></div>
  </div>
  <div class="modal-footer">
    ${i?`<button class="btn danger" onclick="if(confirm('Supprimer ?'))API.deleteIntervention(${i.id}).then(()=>{closeModal();render();toast('Supprimé','ti-trash');})"><i class="ti ti-trash"></i></button>`:''}
    <button class="btn" onclick="closeModal()">Annuler</button>
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
        ${i===0?'<div class="form-label">Désignation</div>':''}
        <div style="position:relative">
          <input class="form-input piece-search" style="font-size:12px" placeholder="Taper nom ou référence…"
            value="${esc(p.designation)}"
            oninput="TMP_PRODUITS[${i}].designation=this.value;searchPieces(${i},this.value)"
            onfocus="searchPieces(${i},this.value)"
            onblur="setTimeout(()=>{const d=document.getElementById('piece-drop-${i}');if(d)d.style.display='none'},150)">
          <div id="piece-drop-${i}" class="piece-dropdown" style="display:none"></div>
        </div>
      </div>
      <div>${i===0?'<div class="form-label">Réf</div>':''}<input class="form-input mono" style="font-size:11px" value="${esc(p.ref)}" oninput="TMP_PRODUITS[${i}].ref=this.value"></div>
      <div>${i===0?'<div class="form-label">Qté</div>':''}<input class="form-input piece-qte" type="number" min="1" value="${p.qte}" oninput="TMP_PRODUITS[${i}].qte=parseInt(this.value)||1"></div>
      <div>${i===0?'<div class="form-label">PU HT</div>':''}<input class="form-input" type="number" step="0.01" value="${parseFloat(p.pxht||0).toFixed(2)}" oninput="TMP_PRODUITS[${i}].pxht=parseFloat(this.value)||0"></div>
      <div style="${i===0?'padding-top:18px':''}"><button class="btn sm danger" onclick="removeProduit(${i})"><i class="ti ti-x"></i></button></div>
    </div>`).join('');
}

async function saveIntervention(id){
  const data={fauteuil_id:parseInt(gv('f-fauteuil')),client_id:parseInt(gv('f-client')),date:gv('f-date'),type:gv('f-type'),statut:gv('f-statut'),technicien:gv('f-tech'),garantie:document.querySelector('input[name="garantie"]:checked')?.value==='1',description:gv('f-desc'),notes:gv('f-notes'),envoi_transporteur:gv('f-env-trans'),envoi_numero:gv('f-env-num'),envoi_date:gv('f-env-date'),retour_transporteur:gv('f-ret-trans'),retour_numero:gv('f-ret-num'),retour_date:gv('f-ret-date'),produits:TMP_PRODUITS};
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
      <button class="btn" onclick="closeModal()">Annuler</button>
      <button class="btn primary" onclick="savePiece(${id||'null'})"><i class="ti ti-check"></i>Enregistrer</button>
    </div>`);}
async function savePiece(id){const data={ref:gv('f-ref'),designation:gv('f-des'),fournisseur:gv('f-fou'),ref_fournisseur:gv('f-reffou'),pxht:parseFloat(gv('f-px'))||0,stock:parseInt(gv('f-stock'))||0,stock_alerte:parseInt(gv('f-stalerte'))||2};if(!data.ref||!data.designation){alert('Référence et désignation requises');return;}try{if(id)await API.updatePiece(id,data);else await API.createPiece(data);CACHE.catalogue=[];toast(id?'Pièce mise à jour':'Pièce ajoutée');closeModal();render();refreshBadges();}catch(e){alert(e.message);}}
async function deletePiece(id){if(!confirm('Supprimer ?'))return;await API.deletePiece(id);CACHE.catalogue=[];toast('Supprimé','ti-trash');closeModal();render();}

// ── EXPORTS PDF ───────────────────────────────────────────────────

async function exportInterventionPDF(id){const i=await API.intervention(id);PDF.intervention(i);toast('PDF généré','ti-file-type-pdf');}
async function exportFauteuilPDF(id){const f=await API.fauteuil(id);PDF.fauteuil(f,f.interventions||[]);toast('PDF généré','ti-file-type-pdf');}
async function exportClientPDF(id){const cl=await API.client(id);const inters=await API.interventions({client_id:id});PDF.client(cl,cl.fauteuils||[],inters);toast('PDF généré','ti-file-type-pdf');}

// ── VOSFACTURES ───────────────────────────────────────────────────

async function syncVosFactures(){
  const btn=$('btn-sync');btn.disabled=true;btn.innerHTML='<i class="ti ti-loader-2"></i>Sync…';
  try{const r=await API.vfSync();toast(`Sync OK — ${r.results.clients} clients, ${r.results.products} produits`,'ti-refresh');CACHE.catalogue=[];render();}
  catch(e){toast('Erreur sync : '+e.message,'ti-alert-circle','var(--danger)');}
  finally{btn.disabled=false;btn.innerHTML='<i class="ti ti-refresh"></i>Sync VosFactures';loadVfStatus();}
}
async function loadVfStatus(){
  try{const s=await API.vfStatus();const el=$('vf-status');if(!el)return;if(!s.configured){el.textContent='⚠ VosFactures non configuré';el.className='vf-status err';}else if(s.last_sync){el.textContent=`✓ Sync ${s.last_sync.created_at?.slice(0,10)}`;el.className='vf-status ok';}else{el.textContent=`Compte : ${s.account}`;el.className='vf-status';}}catch(e){}
}

// ── INIT ──────────────────────────────────────────────────────────

// ── LANGUE ───────────────────────────────────────────────────────
let TMP_CLIENTS = [];

function applyNavTranslations(){
  document.querySelectorAll('[data-i18n]').forEach(el=>{
    const key=el.dataset.i18n;
    el.textContent=t(key);
  });
}

function switchLang(lang){
  setLang(lang);
  applyNavTranslations();
  render();
}

// ── RECHERCHE RAPIDE DASHBOARD ────────────────────────────────────
let QS_TIMER=null;
function quickSearch(q){
  clearTimeout(QS_TIMER);
  if(!q||q.length<2){clearQuickSearch();return;}
  QS_TIMER=setTimeout(async()=>{
    try{const res=await API.recherche(q);showQuickResults(res,q);}catch(e){}
  },200);
}
function clearQuickSearch(){const el=$('qs-results');if(el)el.style.display='none';}
function showQuickResults(res,q){
  const el=$('qs-results');if(!el)return;
  const{fauteuils=[],clients=[]}=res;
  if(!fauteuils.length&&!clients.length){
    el.innerHTML=`<div class="qs-empty"><i class="ti ti-search-off"></i> Aucun résultat pour "<b>${esc(q)}</b>"</div>`;
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
      <div style="display:flex;gap:6px;margin-top:6px;padding-left:28px">
        <button class="btn sm primary" onclick="quickNewInter(${f.id},${f.client_id})"><i class="ti ti-plus"></i>Nouvelle intervention</button>
        <button class="btn sm" onclick="setView('fauteuil',{fauteuilId:${f.id},clientId:${f.client_id}});clearQuickSearch()"><i class="ti ti-eye"></i>Voir la fiche</button>
      </div>
    </div>`).join('');
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
async function chargerFacturesVF(fauteuilId){
  const el=document.getElementById('factures-vf-content');if(!el)return;
  el.innerHTML='<i class="ti ti-loader-2"></i> Chargement depuis VosFactures…';
  try{
    const{factures,serie,configured}=await API.facturesVF(fauteuilId);
    if(!configured){el.innerHTML='<span style="color:var(--text3)">VosFactures non configuré.</span>';return;}
    if(!factures.length){el.innerHTML=`<span style="color:var(--text3)">Aucune facture trouvée pour la série <span class="mono">${esc(serie||'?')}</span>.</span>`;return;}
    el.innerHTML=`<table class="t"><thead><tr><th>Numéro</th><th>Date</th><th>Client VF</th><th>Montant TTC</th><th>Statut</th><th></th></tr></thead>
      <tbody>${factures.map(f=>`<tr>
        <td class="mono" style="color:var(--accent)">${esc(f.numero)}</td>
        <td>${f.date?fd(f.date.substring(0,10)):'—'}</td>
        <td style="font-size:11px">${esc(f.client_nom||'')}</td>
        <td style="font-weight:700">${f.montant_ttc?parseFloat(f.montant_ttc).toFixed(2)+' €':'—'}</td>
        <td><span class="badge ${f.statut==='paid'?'g':'attente'}">${f.statut==='paid'?'Payée':'En attente'}</span></td>
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
      <button class="btn" onclick="closeModal()">Annuler</button>
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

// ── GARANTIE ─────────────────────────────────────────────────────

document.querySelectorAll('.nav-item').forEach(n=>n.classList.toggle('active',n.dataset.view==='dashboard'));
applyNavTranslations();
loadVfStatus();
refreshBadges();
setInterval(refreshBadges, 60000);
render();
