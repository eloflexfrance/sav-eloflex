/* Devis VosFactures — module séparé */
// ══════════════════════════════════════════════════════════════════
// ── VUE DEVIS ────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

let DEVIS_FILTRE = 'ouvert'; // ouvert | converti | ignoré

async function renderDevis(ttl, c, a){
  ttl.textContent = t('devis_title')||'Devis VosFactures';
  const sinceSync = _devisLastSync ? Math.round((Date.now()-_devisLastSync)/60000) : null;
  const syncLabel = sinceSync === null ? (t('devis_non_configure')||(t('devis_non_configure')||'Jamais synchronisé')) : sinceSync < 60 ? `${t('devis_sync_il_y_a')||'Sync il y a'} ${sinceSync} ${t('devis_sync_min')||'min'}` : `${t('devis_sync_il_y_a')||'Sync il y a'} ${Math.round(sinceSync/60)}${t('devis_sync_h')||'h'}`;
  a.innerHTML = `
    <span style="font-size:12px;color:var(--text2)">${syncLabel}</span>
    <button class="btn" onclick="syncDevisVF(true)"><i class="ti ti-refresh"></i> ${t('devis_sync_btn')||'Sync VosFactures'}</button>
    <button class="btn" onclick="syncDevisPL(true)"><i class="ti ti-refresh"></i> ${TR('Sync Pennylane')}</button>
    <button class="btn primary" onclick="modalAjouterDevis()"><i class="ti ti-plus"></i> ${TR('Ajouter un document')}</button>`;
  
  c.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:14px;align-items:center">
      ${['ouvert','converti','ignoré'].map(s=>`
        <button onclick="setDevisFiltre('${s}')"
          class="btn${DEVIS_FILTRE===s?' primary':''}" style="font-size:13px">${s==='ouvert'?(t('devis_ouverts')||'📋 Ouverts'):s==='converti'?(t('devis_convertis')||'✅ Convertis'):(t('devis_ignores')||(t('devis_ignores')||'🚫 Ignorés'))}</button>`).join('')}
    </div>
    <div id="devis-list"><div style="color:var(--text2);padding:20px"><i class="ti ti-loader-2"></i> ${TR("Chargement…")}</div></div>`;

  await chargerDevis();
  // Auto-sync VosFactures UNIQUEMENT à l'ouverture de la vue (en arrière-plan, si > 6h).
  // Ne jamais le déclencher depuis chargerDevis : sinon chaque « convertir / ignorer »
  // relance une synchro lente qui bloque le rafraîchissement de la liste (bug « à retardement »).
  syncDevisVF(false);
  syncDevisPL(false);
}
function setDevisFiltre(s){ DEVIS_FILTRE = s; render(); }
window.setDevisFiltre = setDevisFiltre;

let _devisPlLastSync = parseInt(localStorage.getItem('sav_devis_pl_last_sync')||'0');
async function syncDevisPL(manuel=false){
  if(!manuel){ if(Date.now() - _devisPlLastSync < 6*60*60*1000) return; }
  if(manuel) toast(TR('Synchronisation Pennylane…'),'ti-loader-2');
  try{
    const r = await API.devisSyncPennylane();
    if(r && r.ok){
      _devisPlLastSync = Date.now(); localStorage.setItem('sav_devis_pl_last_sync', _devisPlLastSync);
      if(manuel) toast(`Pennylane — ${r.total||0} ${TR('document(s)')} (${r.created||0} ${TR('nouveaux')}, ${r.updated||0} ${TR('maj')})`,'ti-check');
      chargerDevis();
    } else if(manuel) toast(`Erreur : ${(r&&(r.reason||r.error))||'Pennylane'}`,'ti-alert-circle','var(--warning)');
  }catch(e){ if(manuel) toast(e.message,'ti-alert-circle','var(--danger)'); }
}
window.syncDevisPL = syncDevisPL;

async function chargerDevis(){
  const el = document.getElementById('devis-list'); if(!el) return;
  try{
    const list = await API.devis(DEVIS_FILTRE);
    if(!list.length){
      el.innerHTML=`<div class="empty"><i class="ti ti-file-search"></i> ${t('devis_empty')||'Aucun devis'} ${DEVIS_FILTRE}.</div>`;
      return;
    }
    el.innerHTML=`<div class="table-wrap"><table class="t">
      <thead><tr><th>${t('devis_col_distributeur')||'Distributeur'}</th><th>${t('devis_col_numero')||'N° Devis'}</th><th>Date</th><th>${t('devis_col_jours')||'Jours'}</th><th>${t('devis_col_montant')||'Montant'}</th><th>${TR('Signature')}</th><th>${t('devis_col_relances')||'Relances'}</th><th></th></tr></thead>
      <tbody>${list.map(d=>{
        const jours = Math.round((Date.now()-new Date(d.date_devis).getTime())/86400000);
        const montant = parseFloat(d.montant||0).toLocaleString('fr-FR',{style:'currency',currency:d.devise||'EUR'});
        const estBdc = d.doc_type==='bdc';
        const estPL = d.source==='pennylane';
        const srcBadge = estPL
          ? `<span class="badge" style="background:#358ddd18;color:#358ddd;border:0.5px solid #358ddd44;font-size:10px" title="Pennylane">PL</span>`
          : `<span class="badge" style="background:#0d948818;color:#0d9488;border:0.5px solid #0d948844;font-size:10px" title="VosFactures">VF</span>`;
        const sigCell = d.signed_at
          ? `<span class="badge g" style="font-size:11px" title="${esc(d.signataire_nom||'')} — ${fd((''+d.signed_at).slice(0,10))}"><i class="ti ti-writing-sign"></i> ${TR('signé')}</span>`
          : (d.token_signature
              ? `<span class="badge attente" style="font-size:11px" title="${TR('Lien de signature envoyé')}${d.signature_email?' — '+esc(d.signature_email):''}"><i class="ti ti-send"></i> ${TR('envoyé')}</span> <button class="btn sm" title="${TR('Copier le lien de signature')}" onclick="copierLienDevis('${esc(d.token_signature)}')"><i class="ti ti-link"></i></button>`
              : `<span style="color:var(--text3);font-size:12px">—</span>`);
        return `<tr>
          <td><strong>${esc(d.distributeur_nom)}</strong> ${srcBadge}${estBdc?` <span class="badge hg" style="font-size:10px">BDC</span>`:''}${d.client_email?`<br><span style="font-size:11px;color:var(--text3)">${esc(d.client_email)}</span>`:''}</td>
          <td class="mono">${esc(d.numero||'')}</td>
          <td>${d.date_devis?fd(d.date_devis):'—'}</td>
          <td><span class="badge ${jours>60?'urgent':jours>30?'hg':'ouvert'}">${jours}j</span></td>
          <td style="font-weight:600">${montant}</td>
          <td style="white-space:nowrap">${sigCell}</td>
          <td style="text-align:center">${d.nb_relances||0}</td>
          <td style="white-space:nowrap">
            ${estPL
              ? (d.pennylane_id?`<button class="btn sm" onclick="window.open('https://app.pennylane.com/companies/documents/${d.pennylane_id}','_blank')" title="${TR('Ouvrir dans Pennylane')}"><i class="ti ti-external-link"></i></button>`:'')
              : (window._VF_ACCOUNT&&d.vf_id?`<button class="btn sm" onclick="window.open('https://${window._VF_ACCOUNT}.vosfactures.fr/invoices/${d.vf_id}','_blank')" title="${t('devis_btn_ouvrir')||'Ouvrir dans VosFactures'}"><i class="ti ti-external-link"></i></button>`:'')}
            ${!d.signed_at?`<button class="btn sm" onclick="envoyerDevisSignature(${d.id},'${esc(d.client_email||'')}','${esc((d.distributeur_nom||'').replace(/'/g,'&#39;'))}',${estBdc?1:0})" title="${TR('Envoyer pour signature en ligne')}"><i class="ti ti-signature"></i></button>`:''}
            <button class="btn sm" onclick="modalRelanceDevis(${d.id},'${esc(d.client_email||'')}','${esc(d.distributeur_nom)}')" title="${t('devis_btn_relancer')||'Envoyer une relance'}"><i class="ti ti-mail"></i></button>
            <button class="btn sm" onclick="voirRelancesDevis(${d.id})" title="${t('devis_btn_historique')||'Historique relances'}"><i class="ti ti-history"></i></button>
            ${DEVIS_FILTRE==='ouvert'?`
            <button class="btn sm success" onclick="changerStatutDevis(${d.id},'converti')" title="${t('devis_btn_converti')||'Marquer converti'}"><i class="ti ti-check"></i></button>
            <button class="btn sm" onclick="changerStatutDevis(${d.id},'ignoré')" title="${t('devis_btn_ignorer')||'Ignorer'}" style="color:var(--text3)"><i class="ti ti-x"></i></button>`:''}
            ${d.signed_at?`<button class="btn sm" onclick="resetSignatureDevis(${d.id},'${esc((d.numero||'').replace(/'/g,'&#39;'))}')" title="${TR('Réinitialiser la signature (re-signer le même document)')}"><i class="ti ti-rotate"></i></button>`:''}
            <button class="btn sm danger" onclick="supprimerDevis(${d.id},'${esc((d.numero||'').replace(/'/g,'&#39;'))}',${d.source&&d.source!=='manuel'?1:0})" title="${TR('Supprimer de la liste')}"><i class="ti ti-trash"></i></button>
          </td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;
  }catch(e){ el.innerHTML=`<div style="color:var(--danger);padding:16px">${esc(e.message)}</div>`; }
}

let _devisLastSync = parseInt(localStorage.getItem('sav_devis_last_sync')||'0');

async function syncDevisVF(manuel=false){
  if(!manuel){
    // Auto-sync : uniquement si la dernière sync date de plus de 6h
    const sixH = 6 * 60 * 60 * 1000;
    if(Date.now() - _devisLastSync < sixH) return; // trop récent
  }
  toast(t('devis_sync_en_cours')||'Synchronisation des devis…','ti-loader-2');
  try{
    const r = await API.devisSyncVF();
    if(r.ok){
      _devisLastSync = Date.now();
      localStorage.setItem('sav_devis_last_sync', _devisLastSync);
      if(manuel) toast(`${r.total} ${t('devis_sync_result')||'devis sync —'} ${r.updated} ${t('devis_sync_convertis')||(t('devis_sync_convertis')||'convertis détectés')}`,'ti-check');
      chargerDevis();
    } else if(manuel) toast(`Erreur : ${r.reason||r.error}`,'ti-alert-circle','var(--warning)');
  }catch(e){ if(manuel) toast(e.message,'ti-alert-circle','var(--danger)'); }
}

// Envoyer au client le lien de signature en ligne (devis ou BDC).
async function envoyerDevisSignature(id, email, nom, estBdc){
  const mot = estBdc ? 'bon de commande' : 'devis';
  const dest = prompt(TR('Envoyer le lien de signature du ')+mot+TR(' à quel e-mail ?'), email||'');
  if(dest===null) return;
  const e = (dest||'').trim();
  if(!e || !/@/.test(e)){ alert(TR('Adresse e-mail invalide')); return; }
  try{
    await API.devisEnvoyerSignature(id, e);
    toast(TR('Lien de signature envoyé à ')+e,'ti-send');
    await chargerDevis();
  }catch(err){ toast(err.message||'Erreur','ti-alert-circle','var(--danger)'); }
}
function copierLienDevis(token){
  const lien = location.origin+'/devis-sign/'+token;
  if(navigator.clipboard){ navigator.clipboard.writeText(lien).then(()=>toast(TR('Lien copié'),'ti-copy')).catch(()=>montrerLienSignature(lien)); }
  else montrerLienSignature(lien);
}

// Ajouter manuellement un devis / BDC par son numéro (import auto s'il existe).
function modalAjouterDevis(){
  showModal(`
    <div class="modal-header"><i class="ti ti-plus" style="color:var(--accent)"></i><h2>${TR('Ajouter un devis / bon de commande')}</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body">
      <p style="font-size:12.5px;color:var(--text2);margin-top:0">${TR('Indiquez le numéro : le document est importé automatiquement depuis VosFactures ou Pennylane s’il existe ; sinon vous pouvez le saisir manuellement.')}</p>
      <div class="grid-2" style="gap:10px">
        <div class="form-group"><label class="form-label">${TR('N° du document')} *</label><input class="form-input mono" id="ajd-numero" placeholder="ex. D0931 / DEV-2026-08"></div>
        <div class="form-group"><label class="form-label">${TR('Type')}</label>
          <select class="form-input" id="ajd-type"><option value="devis">${TR('Devis')}</option><option value="bdc">${TR('Bon de commande')}</option></select></div>
        <div class="form-group"><label class="form-label">${TR('Source')}</label>
          <select class="form-input" id="ajd-source"><option value="auto">${TR('Auto (VF puis Pennylane)')}</option><option value="vosfactures">VosFactures</option><option value="pennylane">Pennylane</option><option value="manuel">${TR('Saisie manuelle')}</option></select></div>
        <div class="form-group"><label class="form-label">${TR('Montant (si saisie manuelle)')}</label><input class="form-input" id="ajd-montant" type="number" step="0.01" placeholder="€"></div>
        <div class="form-group"><label class="form-label">${TR('Distributeur (si saisie manuelle)')}</label><input class="form-input" id="ajd-distrib"></div>
        <div class="form-group"><label class="form-label">${TR('Email client (si saisie manuelle)')}</label><input class="form-input" id="ajd-email" type="email"></div>
      </div>
      <div id="ajd-msg" style="margin-top:8px;font-size:13px"></div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">${t('btn_annuler')||'Annuler'}</button>
      <button class="btn primary" id="ajd-btn" onclick="ajouterDevisSubmit()"><i class="ti ti-download"></i> ${TR('Ajouter')}</button>
    </div>`);
  setTimeout(()=>{ const i=document.getElementById('ajd-numero'); if(i) i.focus(); }, 60);
}
window.modalAjouterDevis = modalAjouterDevis;
async function ajouterDevisSubmit(){
  const numero=(document.getElementById('ajd-numero').value||'').trim();
  const msg=document.getElementById('ajd-msg');
  if(!numero){ if(msg) msg.innerHTML=`<span style="color:var(--danger)">${TR('Indiquez d’abord un numéro.')}</span>`; return; }
  const payload={
    numero, doc_type:document.getElementById('ajd-type').value, source:document.getElementById('ajd-source').value,
    montant:document.getElementById('ajd-montant').value||null,
    distributeur_nom:(document.getElementById('ajd-distrib').value||'').trim(),
    client_email:(document.getElementById('ajd-email').value||'').trim()
  };
  const btn=document.getElementById('ajd-btn'); btn.disabled=true; if(msg) msg.innerHTML=`<i class="ti ti-loader-2"></i> ${TR('Recherche et ajout…')}`;
  try{
    const r=await API.devisAjouter(payload);
    if(r.exists){ if(msg) msg.innerHTML=`<span style="color:var(--warning)">${TR('Ce document est déjà présent dans la liste.')}</span>`; setTimeout(()=>{closeModal();chargerDevis();},900); return; }
    toast(TR('Document ajouté')+(r.source&&r.source!=='manuel'?` (${r.source})`:''),'ti-check');
    closeModal(); if(DEVIS_FILTRE!=='ouvert'){ setDevisFiltre('ouvert'); } else { chargerDevis(); }
  }catch(e){ btn.disabled=false; if(msg) msg.innerHTML=`<span style="color:var(--danger)">${esc(e.message||'Erreur')}</span>`; }
}
window.ajouterDevisSubmit = ajouterDevisSubmit;

async function resetSignatureDevis(id, numero){
  if(!confirm(TR('Réinitialiser la signature du document ')+(numero||'')+' ?\n'+TR('Il repassera « en attente » et pourra être renvoyé pour signature (le même document).'))) return;
  try{ await API.devisResetSignature(id); toast(TR('Signature réinitialisée — document remis en attente'),'ti-rotate'); if(DEVIS_FILTRE!=='ouvert') setDevisFiltre('ouvert'); else chargerDevis(); }
  catch(e){ toast(e.message||'Erreur','ti-alert-circle','var(--danger)'); }
}
window.resetSignatureDevis = resetSignatureDevis;
async function supprimerDevis(id, numero, resync){
  const suite = resync ? '\n'+TR('(Provenant de VosFactures / Pennylane, il réapparaîtra à la prochaine synchro.)') : '';
  if(!confirm(TR('Supprimer le document ')+(numero||'')+' ?'+suite)) return;
  try{ await API.devisSupprimer(id); toast(TR('Document supprimé'),'ti-trash'); chargerDevis(); }
  catch(e){ toast(e.message||'Erreur','ti-alert-circle','var(--danger)'); }
}
window.supprimerDevis = supprimerDevis;

async function changerStatutDevis(id, statut){
  try{
    await API.devisStatut(id, statut);
    toast(statut==='converti'?(t('devis_converti_ok')||(t('devis_converti_ok')||'Devis marqué converti ✓')):(t('devis_ignore_ok')||(t('devis_ignore_ok')||'Devis ignoré')),'ti-check');
    await chargerDevis();   // rafraîchit tout de suite la liste (sans relancer la synchro)
  }catch(e){ toast(e.message||'Erreur','ti-alert-circle','var(--danger)'); }
}

function modalRelanceDevis(id, email, nom){
  showModal(`
    <div class="modal-header"><i class="ti ti-mail" style="color:var(--accent)"></i><h2>${t('devis_modal_relance')||'Relance devis'} — ${esc(nom)}</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body">
      <div class="form-group"><label class="form-label">${t('devis_email_dest')||'Email destinataire'}</label>
        <input class="form-input" id="relance-email" value="${esc(email)}" placeholder="${TR("email@distributeur.fr")}">
      </div>
      <div class="form-group"><label class="form-label">${t('devis_note_interne')||'Note interne (facultatif)'}</label>
        <textarea class="form-input" id="relance-notes" rows="2" placeholder="${t('devis_note_hint')||'Raison de la relance, contexte…'}"></textarea>
      </div>
      <div style="font-size:13px;color:var(--text2);background:var(--glass-input);padding:8px 12px;border-radius:var(--radius-sm)">
        <i class="ti ti-copy" style="font-size:12px"></i> ${t('devis_cc_info')||'Une copie sera envoyée à'} <strong>info@eloflex.fr</strong>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">${TR("Annuler")}</button>
      <button class="btn primary" onclick="envoyerRelanceDevis(${id})"><i class="ti ti-send"></i> ${TR("Envoyer la relance")}</button>
    </div>`);
}

async function envoyerRelanceDevis(id){
  const emailEl = document.getElementById('relance-email');
  const notesEl = document.getElementById('relance-notes');
  const email = emailEl?.value?.trim();
  const notes = notesEl?.value?.trim();
  if(!email){ toast(TR('Email requis'),'ti-alert-circle','var(--warning)'); return; }
  toast('Envoi en cours…','ti-loader-2');
  try{
    // Fetch direct pour diagnostic complet
    const resp = await fetch('/api/devis/'+id+'/relance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, notes })
    });
    const rawText = await resp.text();
    console.log('[RELANCE] status:', resp.status, 'body:', rawText);
    let r;
    try { r = JSON.parse(rawText); }
    catch(_) {
      toast(TR('Erreur serveur (')+resp.status+'): '+rawText.slice(0,80), 'ti-alert-circle', 'var(--danger)');
      return;
    }
    if(r.ok){
      toast(TR('✅ Relance envoyée à ')+r.to,'ti-check','var(--success)');
      closeModal();
      chargerDevis();
    } else {
      toast(TR('Erreur : ')+(r.reason||r.error||JSON.stringify(r)),'ti-alert-circle','var(--danger)');
    }
  }catch(e){
    toast(TR('Erreur réseau : ')+e.message,'ti-alert-circle','var(--danger)');
    console.error('[RELANCE] Exception:', e);
  }
}

async function voirRelancesDevis(id){
  const list = await API.devisRelances(id);
  if(!list.length){ toast(t('devis_aucune_relance')||'Aucune relance envoyée pour ce devis','ti-info-circle'); return; }
  showModal(`
    <div class="modal-header"><i class="ti ti-history" style="color:var(--accent)"></i><h2>${t('devis_modal_historique')||'Historique des relances'}</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body">
      <table class="t"><thead><tr><th>${t('devis_col_date')||'Date'}</th><th>Email</th><th>${t('devis_col_statut')||'Statut'}</th><th>${t('devis_col_note')||'Note'}</th></tr></thead>
      <tbody>${list.map(r=>`<tr>
        <td>${fd(r.date_envoi?.slice(0,10))}</td>
        <td style="font-size:13px">${esc(r.email_dest||'')}</td>
        <td><span class="badge g" style="font-size:11px">${esc(r.statut)}</span></td>
        <td style="font-size:12px;color:var(--text2)">${esc(r.notes||'—')}</td>
      </tr>`).join('')}</tbody></table>
    </div>
    <div class="modal-footer"><button class="btn" onclick="closeModal()">${TR("Fermer")}</button></div>`);
}
