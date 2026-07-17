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
    <span style="font-size:11px;color:var(--text2)">${syncLabel}</span>
    <button class="btn" onclick="syncDevisVF(true)"><i class="ti ti-refresh"></i> ${t('devis_sync_btn')||'Sync VosFactures'}</button>`;
  
  c.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:14px;align-items:center">
      ${['ouvert','converti','ignoré'].map(s=>`
        <button onclick="DEVIS_FILTRE='${s}';renderDevis(document.querySelector('.topbar-title'),document.querySelector('.content'),document.querySelector('.topbar-actions'))"
          class="btn${DEVIS_FILTRE===s?' primary':''}" style="font-size:12px">${s==='ouvert'?(t('devis_ouverts')||'📋 Ouverts'):s==='converti'?(t('devis_convertis')||'✅ Convertis'):(t('devis_ignores')||(t('devis_ignores')||'🚫 Ignorés'))}</button>`).join('')}
    </div>
    <div id="devis-list"><div style="color:var(--text2);padding:20px"><i class="ti ti-loader-2"></i> Chargement…</div></div>`;
  
  await chargerDevis();
}

async function chargerDevis(){
  const el = document.getElementById('devis-list'); if(!el) return;
  syncDevisVF(false); // auto-sync si > 6h
  try{
    const list = await API.devis(DEVIS_FILTRE);
    if(!list.length){
      el.innerHTML=`<div class="empty"><i class="ti ti-file-search"></i> ${t('devis_empty')||'Aucun devis'} ${DEVIS_FILTRE}.</div>`;
      return;
    }
    el.innerHTML=`<div class="table-wrap"><table class="t">
      <thead><tr><th>${t('devis_col_distributeur')||'Distributeur'}</th><th>${t('devis_col_numero')||'N° Devis'}</th><th>Date</th><th>${t('devis_col_jours')||'Jours'}</th><th>${t('devis_col_montant')||'Montant'}</th><th>${t('devis_col_relances')||'Relances'}</th><th>${t('devis_col_derniere')||(t('devis_col_derniere')||'Dernière relance')}</th><th></th></tr></thead>
      <tbody>${list.map(d=>{
        const jours = Math.round((Date.now()-new Date(d.date_devis).getTime())/86400000);
        const montant = parseFloat(d.montant||0).toLocaleString('fr-FR',{style:'currency',currency:d.devise||'EUR'});
        return `<tr>
          <td><strong>${esc(d.distributeur_nom)}</strong>${d.client_email?`<br><span style="font-size:10px;color:var(--text3)">${esc(d.client_email)}</span>`:''}</td>
          <td class="mono">${esc(d.numero||'')}</td>
          <td>${d.date_devis?fd(d.date_devis):'—'}</td>
          <td><span class="badge ${jours>60?'urgent':jours>30?'hg':'ouvert'}">${jours}j</span></td>
          <td style="font-weight:600">${montant}</td>
          <td style="text-align:center">${d.nb_relances||0}</td>
          <td style="font-size:11px;color:var(--text2)">${d.derniere_relance?fd(d.derniere_relance.slice(0,10)):'—'}</td>
          <td style="white-space:nowrap">
            ${window._VF_ACCOUNT?`<button class="btn sm" onclick="window.open('https://${window._VF_ACCOUNT}.vosfactures.fr/invoices/${d.vf_id}','_blank')" title="${t('devis_btn_ouvrir')||'Ouvrir dans VosFactures'}"><i class="ti ti-external-link"></i></button>`:''}
            <button class="btn sm" onclick="modalRelanceDevis(${d.id},'${esc(d.client_email||'')}','${esc(d.distributeur_nom)}')" title="${t('devis_btn_relancer')||'Envoyer une relance'}"><i class="ti ti-mail"></i></button>
            <button class="btn sm" onclick="voirRelancesDevis(${d.id})" title="${t('devis_btn_historique')||'Historique relances'}"><i class="ti ti-history"></i></button>
            ${DEVIS_FILTRE==='ouvert'?`
            <button class="btn sm success" onclick="changerStatutDevis(${d.id},'converti')" title="${t('devis_btn_converti')||'Marquer converti'}"><i class="ti ti-check"></i></button>
            <button class="btn sm" onclick="changerStatutDevis(${d.id},'ignoré')" title="${t('devis_btn_ignorer')||'Ignorer'}" style="color:var(--text3)"><i class="ti ti-x"></i></button>`:''}
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

async function changerStatutDevis(id, statut){
  await API.devisStatut(id, statut);
  toast(statut==='converti'?(t('devis_converti_ok')||(t('devis_converti_ok')||'Devis marqué converti ✓')):(t('devis_ignore_ok')||(t('devis_ignore_ok')||'Devis ignoré')),'ti-check');
  chargerDevis();
}

function modalRelanceDevis(id, email, nom){
  showModal(`
    <div class="modal-header"><i class="ti ti-mail" style="color:var(--accent)"></i><h2>${t('devis_modal_relance')||'Relance devis'} — ${esc(nom)}</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body">
      <div class="form-group"><label class="form-label">${t('devis_email_dest')||'Email destinataire'}</label>
        <input class="form-input" id="relance-email" value="${esc(email)}" placeholder="email@distributeur.fr">
      </div>
      <div class="form-group"><label class="form-label">${t('devis_note_interne')||'Note interne (facultatif)'}</label>
        <textarea class="form-input" id="relance-notes" rows="2" placeholder="${t('devis_note_hint')||'Raison de la relance, contexte…'}"></textarea>
      </div>
      <div style="font-size:12px;color:var(--text2);background:var(--glass-input);padding:8px 12px;border-radius:var(--radius-sm)">
        <i class="ti ti-copy" style="font-size:11px"></i> ${t('devis_cc_info')||'Une copie sera envoyée à'} <strong>info@eloflex.fr</strong>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">Annuler</button>
      <button class="btn primary" onclick="envoyerRelanceDevis(${id})"><i class="ti ti-send"></i> Envoyer la relance</button>
    </div>`);
}

async function envoyerRelanceDevis(id){
  const email = document.getElementById('relance-email')?.value?.trim();
  const notes = document.getElementById('relance-notes')?.value?.trim();
  if(!email){ toast('Email requis','ti-alert-circle','var(--warning)'); return; }
  toast('Envoi en cours…','ti-loader-2');
  try{
    const r = await API.devisRelance(id, email, notes);
    if(r.ok){ toast(`${t('devis_relance_envoyee')||'Relance envoyée à'} ${r.to}`,'ti-mail'); closeModal(); chargerDevis(); }
    else toast(`Erreur : ${r.reason}`,'ti-alert-circle','var(--warning)');
  }catch(e){ toast(e.message,'ti-alert-circle','var(--danger)'); }
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
        <td style="font-size:12px">${esc(r.email_dest||'')}</td>
        <td><span class="badge g" style="font-size:10px">${esc(r.statut)}</span></td>
        <td style="font-size:11px;color:var(--text2)">${esc(r.notes||'—')}</td>
      </tr>`).join('')}</tbody></table>
    </div>
    <div class="modal-footer"><button class="btn" onclick="closeModal()">Fermer</button></div>`);
}
