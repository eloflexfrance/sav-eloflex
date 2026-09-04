// public/js/api.js v2
const API = {
  base: '/api',
  async get(p){
    const r = await fetch(this.base+p);
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch(_) { throw new Error('Réponse invalide ('+r.status+'): '+text.slice(0,120)); }
    if(!r.ok) throw new Error(data.error||data.message||r.statusText);
    return data;
  },
  async post(p,b){
    const r = await fetch(this.base+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch(_) { throw new Error('Réponse invalide ('+r.status+'): '+text.slice(0,120)); }
    if(!r.ok) throw new Error(data.error||data.message||r.statusText);
    return data;
  },
  async put(p,b){
    const r = await fetch(this.base+p,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch(_) { throw new Error('Réponse invalide ('+r.status+'): '+text.slice(0,120)); }
    if(!r.ok) throw new Error(data.error||data.message||r.statusText);
    return data;
  },
  async delete(p){
    const r = await fetch(this.base+p,{method:'DELETE'});
    const text = await r.text();
    if(!text) return {};
    try { return JSON.parse(text); } catch(_) { return {}; }
  },
  async patch(p,b){
    const r = await fetch(this.base+p,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});
    const text = await r.text(); let data;
    try { data = JSON.parse(text); } catch(_) { throw new Error(r.status===429?'VosFactures : trop de requêtes, réessayez dans quelques secondes.':'Réponse invalide ('+r.status+'): '+text.slice(0,120)); }
    if(!r.ok) throw new Error(data.error||data.message||r.statusText);
    return data;
  },
  async del(p){
    const r = await fetch(this.base+p,{method:'DELETE'});
    const text = await r.text(); if(!text) return {};
    let data;
    try { data = JSON.parse(text); } catch(_) { throw new Error(r.status===429?'VosFactures : trop de requêtes, réessayez dans quelques secondes.':'Réponse invalide ('+r.status+'): '+text.slice(0,120)); }
    if(!r.ok) throw new Error(data.error||data.message||r.statusText);
    return data;
  },
  stats:()=>API.get('/stats'),
  clients:(q)=>API.get('/clients'+(q?`?q=${encodeURIComponent(q)}`:'')),
  client:(id)=>API.get(`/clients/${id}`),
  createClient:(d)=>API.post('/clients',d),
  updateClient:(id,d)=>API.put(`/clients/${id}`,d),
  setClientType:(id,type)=>API.post(`/clients/${id}/type`,{type}),
  deleteClient:(id)=>API.del(`/clients/${id}`),
  regenererToken:(id)=>API.post(`/clients/${id}/regenerer-token`,{}),
  prets:()=>API.get('/prets'),
  pret:(id)=>API.get(`/prets/${id}`),
  createPret:(d)=>API.post('/prets',d),
  updatePret:(id,d)=>API.put(`/prets/${id}`,d),
  setPretStatut:(id,statut,extra)=>API.post(`/prets/${id}/statut`,Object.assign({statut},extra||{})),
  deletePret:(id)=>API.del(`/prets/${id}`),
  envoyerPret:(id,email,pdf)=>API.post(`/prets/${id}/envoyer`,{...(email?{email}:{}),...(pdf?{pdf_data:pdf}:{})}),
  signePretMail:(id,date)=>API.post(`/prets/${id}/signe-mail`,{date}),
  // ── Contrat-cadre de prêt ──
  contratsCadre:()=>API.get('/contrats-cadre'),
  contratCadre:(id)=>API.get(`/contrats-cadre/${id}`),
  contratCadreByClient:(clientId)=>API.get(`/contrats-cadre/by-client/${clientId}`),
  createContratCadre:(d)=>API.post('/contrats-cadre',d),
  updateContratCadre:(id,d)=>API.put(`/contrats-cadre/${id}`,d),
  deleteContratCadre:(id)=>API.del(`/contrats-cadre/${id}`),
  envoyerContratCadre:(id,email,pdf)=>API.post(`/contrats-cadre/${id}/envoyer`,{...(email?{email}:{}),...(pdf?{pdf_data:pdf}:{})}),
  signeContratCadreMail:(id,date)=>API.post(`/contrats-cadre/${id}/signe-mail`,{date}),
  // ── Demandes d'informations (distributeurs) ──
  logs:(params)=>API.get('/logs'+(params&&Object.keys(params).length?('?'+new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([,v])=>v!=null&&v!==''))).toString()):'')),
  demandesInfo:(params)=>API.get('/demandes-info'+(params?('?'+new URLSearchParams(params).toString()):'')),
  demandesInfoStats:(clientId)=>API.get('/demandes-info/stats'+(clientId?('?client_id='+clientId):'')),
  demandesInfoParDistrib:()=>API.get('/demandes-info/par-distributeur'),
  createDemandeInfo:(d)=>API.post('/demandes-info',d),
  updateDemandeInfo:(id,d)=>API.put(`/demandes-info/${id}`,d),
  setDemandeInfoStatut:(id,statut,opts)=>API.post(`/demandes-info/${id}/statut`,{statut,...(opts&&typeof opts==='object'?opts:(opts?{date_retour:opts}:{}))}),
  deleteDemandeInfo:(id)=>API.del(`/demandes-info/${id}`),
  relanceDemandesInfo:(clientId,email)=>API.post('/demandes-info/relance',{client_id:clientId,email}),
  relanceContactInfo:(id,email)=>API.post(`/demandes-info/${id}/relance`,{email}),
  relanceTelInfo:(id,date)=>API.post(`/demandes-info/${id}/relance-tel`,{date}),
  reaffecterDemandes:(payload)=>API.post('/demandes-info/reaffecter',payload),
  distributeursReferences:()=>API.get('/demandes-info/distributeurs'),
  fusionnerClients:(idCible,idSource,vfIgnore)=>API.post(`/clients/${idCible}/fusionner`,{client_source_id:idSource,vf_ignore_source:vfIgnore}),
  adressesIncompletes:()=>API.get('/clients/adresses-incompletes'),
  reseauParNom:(nom)=>API.get('/clients/reseau-par-nom?nom='+encodeURIComponent(nom||'')),
  restaurerSauvegarde:(data)=>API.post('/sauvegarde/restaurer',data),
  completerAdresses:(lignes)=>API.post('/clients/adresses-completer',{lignes}),
  fauteuils:(cid)=>API.get('/fauteuils'+(cid?`?client_id=${cid}`:'')),
  fauteuil:(id)=>API.get(`/fauteuils/${id}`),
  createFauteuil:(d)=>API.post('/fauteuils',d),
  updateFauteuil:(id,d)=>API.put(`/fauteuils/${id}`,d),
  deleteFauteuil:(id)=>API.del(`/fauteuils/${id}`),
  interventions:(p)=>API.get('/interventions'+(p?'?'+new URLSearchParams(Object.fromEntries(Object.entries(p).filter(([,v])=>v!=null&&v!==''))).toString():'')),
  intervention:(id)=>API.get(`/interventions/${id}`),
  createIntervention:(d)=>API.post('/interventions',d),
  updateIntervention:(id,d)=>API.put(`/interventions/${id}`,d),
  basculerSAVenCommande:(id)=>API.post(`/interventions/${id}/basculer-commande`,{}),
  basculerCommandeenSAV:(id)=>API.post(`/commandes/${id}/basculer-intervention`,{}),
  deleteIntervention:(id)=>API.del(`/interventions/${id}`),
  archiverIntervention:(id,archive)=>API.post(`/interventions/${id}/archive`,{archive}),
  commentaires:(id)=>API.get(`/interventions/${id}/commentaires`),
  addCommentaire:(id,d)=>API.post(`/interventions/${id}/commentaires`,d),
  deleteCommentaire:(id,cid)=>API.del(`/interventions/${id}/commentaires/${cid}`),
  historique:(id)=>API.get(`/interventions/${id}/historique`),
  photos:(id)=>API.get(`/interventions/${id}/photos`),
  uploadPhotos:async(id,files,legende)=>{const fd=new FormData();for(const f of files)fd.append('photos',f);if(legende)fd.append('legende',legende);const r=await fetch(`/api/interventions/${id}/photos`,{method:'POST',body:fd});if(!r.ok)throw new Error((await r.json()).error||r.statusText);return r.json();},
  updatePhotoLegende:(id,pid,legende)=>API.patch(`/interventions/${id}/photos/${pid}`,{legende}),
  deletePhoto:(id,pid)=>API.del(`/interventions/${id}/photos/${pid}`),
  expeditions:()=>API.get('/expeditions'),
  catalogue:(q,alerte)=>API.get('/catalogue'+(q?`?q=${encodeURIComponent(q)}`:'')+(alerte?`${q?'&':'?'}alerte=1`:'')),
  createPiece:(d)=>API.post('/catalogue',d),
  updatePiece:(id,d)=>API.put(`/catalogue/${id}`,d),
  deletePiece:(id)=>API.del(`/catalogue/${id}`),
  catalogueSyncPennylane:()=>API.post('/catalogue/sync-pennylane',{}),
  alertes:()=>API.get('/alertes'),
  marquerAlerteLue:(id)=>API.patch(`/alertes/${id}/lue`,{}),
  marquerToutesLues:()=>API.patch('/alertes/lire-toutes',{}),
  exportExcel:(type,params={})=>{const p=new URLSearchParams({type,...Object.fromEntries(Object.entries(params).filter(([,v])=>v))}).toString();window.open(`/api/export/excel?${p}`);},
  parametres:()=>API.get('/parametres'),
  saveParametres:(d)=>API.put('/parametres',d),
  portail:(token)=>API.get(`/portail/${token}`),
  vfStatus:()=>API.get('/vosfactures/status'),
  retoursSuede:()=>API.get('/retours-suede'),
  createRetour:(d)=>API.post('/retours-suede',d),
  updateRetour:(id,d)=>API.put(`/retours-suede/${id}`,d),
  deleteRetour:(id)=>API.delete(`/retours-suede/${id}`),
  transferts:()=>API.get('/transferts'),
  transfert:(id)=>API.get(`/transferts/${id}`),
  createTransfert:(d)=>API.post('/transferts',d),
  updateTransfert:(id,d)=>API.put(`/transferts/${id}`,d),
  deleteTransfert:(id)=>API.delete(`/transferts/${id}`),
  sendEmailInter:(id)=>API.post('/email/notification-intervention',{intervention_id:id}),
  vfSyncHistorique:()=>API.post('/vosfactures/sync-historique',{}),
  vfSyncHistoriqueStatus:()=>API.get('/vosfactures/sync-historique/status'),
  facturesVF:(fauteuilId)=>API.get(`/fauteuils/${fauteuilId}/factures-vf`),
  recherche:(q)=>API.get(`/recherche?q=${encodeURIComponent(q)}`),
  importExcel:async(file)=>{const fd=new FormData();fd.append('file',file);const r=await fetch('/api/import/excel',{method:'POST',body:fd});if(!r.ok)throw new Error((await r.json()).error||r.statusText);return r.json();},
  vfSync:()=>API.post('/vosfactures/sync',{}),
  vfLogs:()=>API.get('/vosfactures/logs'),
  commandes:(p={})=>API.get('/commandes'+('?slim=1&'+new URLSearchParams(Object.fromEntries(Object.entries(p).filter(([,v])=>v!=null&&v!==''))).toString())),
  commande:(id)=>API.get(`/commandes/${id}`),
  commandesStats:(annee,pays)=>API.get(`/commandes/stats${annee||pays?'?'+[annee?'annee='+annee:'',pays?'pays='+encodeURIComponent(pays):''].filter(Boolean).join('&'):''}`),
  createCommande:(d)=>API.post('/commandes',d),
  updateCommande:(id,d)=>API.put(`/commandes/${id}`,d),
  deleteCommande:(id)=>API.del(`/commandes/${id}`),
  demosSuivi:()=>API.get('/demos/suivi'),
  demosParc:()=>API.get('/demos/parc'),
  demoProlonger:(id,date)=>API.post(`/commandes/${id}/demo-prolonger`,{date}),
  demoCloturer:(id,resultat,date)=>API.post(`/commandes/${id}/demo-cloturer`,{resultat,date}),
  demoReserver:(id,reservation)=>API.post(`/commandes/${id}/demo-reserver`,{reservation}),
  vfSyncCommandes:(historique=false)=>API.post(`/vosfactures/sync-commandes${historique?'?historique=1':''}`,{}),
  commandeFacturesSuggestions:(id)=>API.get(`/commandes/${id}/factures-vf-suggestions`),
  vfFactureLookup:(numero)=>API.get(`/vosfactures/facture-lookup?numero=${encodeURIComponent(numero)}`),
  uploadPreuveLivraison:async(id,file)=>{const fd=new FormData();fd.append('fichier',file);const r=await fetch(`/api/commandes/${id}/preuve-livraison`,{method:'POST',body:fd});if(!r.ok)throw new Error((await r.json()).error||r.statusText);return r.json();},
  deletePreuveLivraison:(id)=>API.del(`/commandes/${id}/preuve-livraison`),
  vfBdcLookup:(numero)=>API.get(`/vosfactures/bdc-lookup?numero=${encodeURIComponent(numero)}`),
  // Gestion des utilisateurs (admin)
  users:()=>API.get('/users'),
  createUser:(d)=>API.post('/users',d),
  updateUser:(id,d)=>API.put(`/users/${id}`,d),
  resetUserPassword:(id,mdp)=>API.post(`/users/${id}/reset-password`,{mot_de_passe:mdp}),
  deleteUser:(id)=>API.del(`/users/${id}`),
  commandeLignes:(id)=>API.get(`/commandes/${id}/lignes`),
  saveCommandeLignes:(id,lignes)=>API.put(`/commandes/${id}/lignes`, lignes),
  saveRetourLignes:(id,lignes)=>API.put(`/commandes/${id}/retour-lignes`, lignes),
  importCommandesExcel:async(file)=>{const fd=new FormData();fd.append('file',file);const r=await fetch('/api/import/commandes-excel',{method:'POST',body:fd});if(!r.ok)throw new Error((await r.json()).error||r.statusText);return r.json();},
  commandesAlertesBlocage:(jours=7)=>API.get(`/commandes/alertes-blocage?jours=${jours}`),
  emailExpedition:(id)=>API.post(`/commandes/${id}/email-expedition`,{}),
  fixSuivi:()=>API.post('/commandes/fix-suivi',{}),
  commandesDoublons:()=>API.get('/commandes/doublons'),
  supprimerDoublons:()=>API.post('/commandes/supprimer-doublons',{}),
  migrationFactureHistorique:()=>API.post('/commandes/migration-facture-historique',{}),
  emailConfirmation:(id)=>API.post(`/commandes/${id}/email-confirmation`,{}),
  genererFacture:(id)=>API.post(`/commandes/${id}/generer-facture`,{}),
  creerBL:(id)=>API.post(`/commandes/${id}/creer-bl`,{}),
  // ── Pennylane ──
  pennylaneStatus:()=>API.get('/pennylane/status'),
  pennylaneSyncCommandes:(full)=>API.post(`/pennylane/sync-commandes${full?'?historique=1':''}`),
  pennylaneGenererFacture:(id)=>API.post(`/pennylane/generer-facture/${id}`,{}),
  pennylane_bdc_lookup:(numero)=>API.get(`/pennylane/bdc-lookup?numero=${encodeURIComponent(numero)}`),
  // ── Devis ──
  devis:(statut)=>API.get(`/devis${statut?'?statut='+statut:''}`),
  devisSyncVF:()=>API.post('/devis/sync-vf',{}),
  devisSyncPennylane:()=>API.post('/pennylane/sync-devis',{}),
  devisStatut:(id,statut,notes)=>API.put(`/devis/${id}/statut`,{statut,notes}),
  devisRelances:(id)=>API.get(`/devis/${id}/relances`),
  devisRelance:(id,email,notes)=>API.post(`/devis/${id}/relance`,{email,notes}),
  devisEnvoyerSignature:(id,email)=>API.post(`/devis/${id}/envoyer-signature`,{email}),
  devisAjouter:(payload)=>API.post('/devis/ajouter',payload),
  devisResetSignature:(id)=>API.post(`/devis/${id}/reset-signature`,{}),
  devisSupprimer:(id)=>API.del(`/devis/${id}`),
  // ── Commande Suède ──
  commandesSuede:()=>API.get('/commandes-suede'),
  commandeSuede:(id)=>API.get(`/commandes-suede/${id}`),
  stockLookup:(numero)=>API.get(`/vosfactures/stock-lookup?numero=${encodeURIComponent(numero)}`),
  stockDoc:(id,kind,warehouse)=>API.get(`/vosfactures/stock-doc/${id}?kind=${encodeURIComponent(kind||'')}&warehouse=${warehouse||''}`),
  createCommandeSuede:(data)=>API.post('/commandes-suede',data),
  updateCommandeSuede:(id,data)=>API.put(`/commandes-suede/${id}`,data),
  integrerStockSuede:(id,lignes)=>API.post(`/commandes-suede/${id}/integrer-stock`,{lignes}),
  deleteCommandeSuede:(id)=>API.del(`/commandes-suede/${id}`),
  // ── Tracking ──
  tracking:(numero)=>API.get(`/tracking/${encodeURIComponent(numero)}`),
  trackingSync:()=>API.post('/tracking/sync',{}),
  syncPaiementsVF:()=>API.get('/paiement-vf/sync-all'),
  // Notes internes
  notes:(id)=>API.get(`/commandes/${id}/notes`),
  addNote:(id,texte)=>API.post(`/commandes/${id}/notes`,{texte}),
  deleteNote:(cmdId,noteId)=>API.delete(`/commandes/${cmdId}/notes/${noteId}`),
  notesRecent:(limit=50)=>API.get(`/notes/recent?limit=${limit}`),
  notesCounts:()=>API.get('/notes/counts'),
  syncPaiementCommande:(id)=>API.post(`/commandes/${id}/sync-paiement`,{}),
};
