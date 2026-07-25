// Vue "Doublons VosFactures" — public/js/doublons-vf.js
// -----------------------------------------------------------------------------
// À INTÉGRER :
// 1. Ajouter dans index.html : <script src="js/doublons-vf.js"></script>
//    (après api.js / i18n.js, avant app.js si app.js appelle renderDoublonsVF)
// 2. Ajouter un lien de nav (ex dans index.html ou généré par app.js) :
//    <a href="#" data-view="doublons-vf">Doublons VosFactures</a>
// 3. Dans le routeur de vues de app.js (la fonction render/dispatch de vues),
//    ajouter un cas :
//    case 'doublons-vf': renderDoublonsVF(); break;
//    (adapter au nom réel de ta fonction routeur, voir bug connu "Routing manquait
//    dans render()" déjà rencontré sur le module Discussions)
// -----------------------------------------------------------------------------

let _doublonsVfData = null;

async function renderDoublonsVF() {
  const conteneur = document.getElementById('view-content'); // ADAPTER si l'id diffère
  if (!conteneur) return;

  conteneur.innerHTML = `
    <h2>Doublons VosFactures</h2>
    <p>Détecte les fiches distributeurs en double (même nom) et les adresses incomplètes.</p>
    <button id="btn-detecter-doublons" class="btn btn-primary">Analyser VosFactures</button>
    <div id="doublons-vf-resultats" style="margin-top:20px;"></div>
  `;

  document.getElementById('btn-detecter-doublons').addEventListener('click', chargerDoublonsVF);
}

async function chargerDoublonsVF() {
  const zone = document.getElementById('doublons-vf-resultats');
  zone.innerHTML = '<p>Analyse en cours (peut prendre quelques secondes selon le nombre de contacts)…</p>';
  try {
    const res = await fetch('/api/doublons-vf/detecter');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur inconnue');
    _doublonsVfData = data;
    afficherResultatsDoublonsVF(data);
  } catch (err) {
    zone.innerHTML = `<p class="erreur">Erreur : ${_escVf(err.message)}</p>`;
  }
}

function afficherResultatsDoublonsVF(data) {
  const zone = document.getElementById('doublons-vf-resultats');

  let html = `<p><strong>${data.total_contacts}</strong> contacts analysés — 
    <strong>${data.nb_groupes_doublons}</strong> groupe(s) de doublons — 
    <strong>${data.nb_adresses_incompletes}</strong> adresse(s) incomplète(s).</p>`;

  // --- Section Doublons ---
  html += `<h3>Doublons (${data.nb_groupes_doublons})</h3>`;
  if (data.doublons.length === 0) {
    html += '<p>Aucun doublon détecté.</p>';
  } else {
    data.doublons.forEach((groupe, gi) => {
      html += `<div class="carte-doublon" style="border:1px solid #ddd;border-radius:8px;padding:12px;margin-bottom:12px;">
        <strong>${_escVf(groupe.nom)}</strong> (${groupe.contacts.length} fiches)
        <table class="t" style="width:100%;margin-top:8px;">
          <thead><tr><th>Conserver</th><th>ID</th><th>Adresse</th><th>Email</th><th>Tél.</th></tr></thead>
          <tbody>`;
      groupe.contacts.forEach((c, ci) => {
        const coche = c.id === groupe.principal_suggere ? 'checked' : '';
        const adresseTxt = c.complet
          ? `${c.street}, ${c.post_code} ${c.city}`
          : `<span style="color:#c00;">incomplète</span>`;
        html += `<tr>
          <td><input type="radio" name="principal-${gi}" value="${c.id}" ${coche}></td>
          <td>${c.id}</td>
          <td>${adresseTxt}</td>
          <td>${_escVf(c.email || '')}</td>
          <td>${_escVf(c.phone || '')}</td>
        </tr>`;
      });
      html += `</tbody></table>
        <button class="btn btn-fusionner" data-groupe="${gi}" style="margin-top:8px;">Fusionner ce groupe</button>
      </div>`;
    });
  }

  // --- Section Adresses incomplètes ---
  html += `<h3>Adresses incomplètes (${data.nb_adresses_incompletes})</h3>`;
  if (data.adresses_incompletes.length === 0) {
    html += '<p>Toutes les fiches ont une adresse complète.</p>';
  } else {
    html += `<table class="t" style="width:100%;">
      <thead><tr><th>Nom</th><th>Rue</th><th>Code postal</th><th>Ville</th><th></th></tr></thead>
      <tbody>`;
    data.adresses_incompletes.forEach(c => {
      html += `<tr data-id-adresse="${c.id}">
        <td>${_escVf(c.name)}</td>
        <td><input type="text" class="champ-rue" value="${_escVf(c.street)}" placeholder="N° et rue"></td>
        <td><input type="text" class="champ-cp" value="${_escVf(c.post_code)}" placeholder="CP" style="width:70px;"></td>
        <td><input type="text" class="champ-ville" value="${_escVf(c.city)}" placeholder="Ville"></td>
        <td><button class="btn btn-sauver-adresse" data-id="${c.id}">Enregistrer</button></td>
      </tr>`;
    });
    html += '</tbody></table>';
  }

  zone.innerHTML = html;

  // Boutons fusion
  zone.querySelectorAll('.btn-fusionner').forEach(btn => {
    btn.addEventListener('click', () => fusionnerGroupeVF(parseInt(btn.dataset.groupe, 10)));
  });
  // Boutons sauvegarde adresse
  zone.querySelectorAll('.btn-sauver-adresse').forEach(btn => {
    btn.addEventListener('click', () => sauverAdresseVF(btn));
  });
}

async function fusionnerGroupeVF(gi) {
  const groupe = _doublonsVfData.doublons[gi];
  const carte = document.querySelectorAll('.carte-doublon')[gi];
  const principalId = parseInt(carte.querySelector(`input[name="principal-${gi}"]:checked`).value, 10);
  const mergeIds = groupe.contacts.map(c => c.id).filter(id => id !== principalId);

  if (!confirm(`Fusionner ${mergeIds.length} fiche(s) dans la fiche ID ${principalId} ?\nCette action est IRRÉVERSIBLE côté VosFactures.`)) {
    return;
  }

  try {
    const res = await fetch('/api/doublons-vf/fusionner', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ principal_id: principalId, merge_ids: mergeIds })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur inconnue');
    alert(`Fusion effectuée. ${data.reattribution_locale ? 'Réattribution locale : ' + data.reattribution_locale : ''}`);
    chargerDoublonsVF(); // rafraîchir
  } catch (err) {
    alert('Erreur lors de la fusion : ' + err.message);
  }
}

async function sauverAdresseVF(btn) {
  const ligne = btn.closest('tr');
  const id = btn.dataset.id;
  const street = ligne.querySelector('.champ-rue').value.trim();
  const post_code = ligne.querySelector('.champ-cp').value.trim();
  const city = ligne.querySelector('.champ-ville').value.trim();

  btn.disabled = true;
  btn.textContent = '...';
  try {
    const res = await fetch(`/api/doublons-vf/adresse/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ street, post_code, city, country: 'FR' })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur inconnue');
    ligne.style.background = '#e6ffe6';
    btn.textContent = 'Enregistré ✓';
  } catch (err) {
    alert('Erreur : ' + err.message);
    btn.textContent = 'Enregistrer';
  } finally {
    btn.disabled = false;
  }
}

function _escVf(s) {
  return String(s || '').replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

// Exposition globale (cohérent avec le style vanilla JS SPA de l'app)
window.renderDoublonsVF = renderDoublonsVF;
