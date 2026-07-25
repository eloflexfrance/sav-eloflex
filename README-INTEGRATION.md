# Module "Doublons VosFactures" — intégration dans sav-eloflex

Ce module ajoute une nouvelle vue qui, en un clic :
1. Récupère TOUS les contacts VosFactures (pagination automatique)
2. Regroupe ceux qui portent le même nom (accents/casse ignorés) → doublons
3. Propose une fiche "principale" (la plus complète) par groupe, avec possibilité de changer le choix
4. Fusionne le groupe via l'API VosFactures officielle (`/clients/:id/merge.json`) en un clic — les commandes/factures des fiches fusionnées sont automatiquement rattachées à la fiche conservée par VosFactures lui-même
5. Liste toutes les fiches dont l'adresse (rue + CP + ville) est incomplète, avec un formulaire d'édition en ligne qui met à jour directement VosFactures

## Fichiers du patch

```
server/routes-doublons-vf.js   → nouvelles routes API
public/js/doublons-vf.js       → nouvelle vue frontend
```

## Étapes d'intégration

### 1. Ajouter le fichier de routes
Copier `server/routes-doublons-vf.js` dans ton dossier `server/`.

Dans `server/routes.js` (ou ton fichier qui monte les routeurs), ajouter :
```js
const doublonsVfRouter = require('./routes-doublons-vf');
app.use('/api/doublons-vf', doublonsVfRouter);
```

**⚠️ Deux points à adapter dans `routes-doublons-vf.js` :**
- `const pool = require('../db');` → remplace par le chemin réel de ton module PostgreSQL
- Les noms de table/colonnes dans la section "Réattribution locale" de `/fusionner`
  (actuellement `commandes.client_id` et `clients.vf_id`) → adapte à ton schéma réel.
  **Si tu ne les adaptes pas, aucun risque** : la fusion VosFactures se fait quand même,
  seule la réattribution locale est ignorée (avec un simple avertissement en log).

Si tes routes protégées passent par un middleware (ex: `requireRole('admin')`),
ajoute-le sur les routes `POST /fusionner` et `PUT /adresse/:id`.

### 2. Ajouter le fichier frontend
Copier `public/js/doublons-vf.js` dans `public/js/`.

Dans `public/index.html`, ajouter le script (après `api.js`/`i18n.js`) :
```html
<script src="js/doublons-vf.js"></script>
```

Ajouter un lien de navigation, par exemple à côté de "Devis VosFactures" :
```html
<a href="#" data-view="doublons-vf">Doublons VosFactures</a>
```

### 3. Brancher la vue dans le routeur
Dans `app.js`, dans la fonction qui dispatch les vues (`render()` ou équivalent),
ajouter un cas :
```js
case 'doublons-vf':
  renderDoublonsVF();
  break;
```

**Point de vigilance** (déjà rencontré sur le module Discussions) : vérifier que
ce cas est bien atteint depuis TOUS les points d'entrée du routeur (menu, lien direct,
etc.), pas seulement le clic de nav.

### 4. Vérifier avant déploiement
Lancer `node verifier.js` comme d'habitude pour détecter tout appel/route manquant
après intégration.

## Variables d'environnement nécessaires
Déjà présentes pour le module Devis : `VOSFACTURES_API_TOKEN`, `VOSFACTURES_ACCOUNT`.
Aucune nouvelle variable requise.

## Ce que fait la fusion (rappel du fonctionnement VosFactures)
La fusion appelle `POST /clients/{principal_id}/merge.json` avec les IDs à fusionner.
VosFactures réattribue lui-même tous les documents de facturation (bons de commande,
factures, devis...) des fiches fusionnées vers la fiche conservée, puis supprime
définitivement les fiches fusionnées. **Cette action est irréversible côté VosFactures**
— une confirmation est demandée dans l'interface avant chaque fusion.
