# Module "Suivi des commandes" — intégration dans sav-eloflex

## ⚠️ Correctifs (déjà inclus dans ce ZIP)

**30/06 — Tableau de bord : top pièces vendues + fauteuils électriques (nouveau)**
Le graphique "Interventions / 12 mois" est remplacé par "Top 10 pièces
détachées vendues", calculé à partir des bons de commande VosFactures
(champ `accessoire`) **depuis le 1er janvier de l'année en cours**. Une 3ème
carte "Fauteuils électriques vendus (depuis janvier)" est ajoutée à côté
(total + détail par modèle Eloflex L/D2/F/...), même période, basée sur les
commandes dont la ligne fauteuil contient "Eloflex" — qu'elles aient ou non
des accessoires associés. La carte "Pièces les plus utilisées
(interventions)" existante n'a pas changé, juste repositionnée à côté des
deux nouvelles pour les comparer en un coup d'œil. J'ai testé les deux
algorithmes d'agrégation sur des données réalistes avant de livrer.

**30/06 — Nouveau statut "Problème" (nouveau)**
Ajout d'un statut "Problème" pour signaler les commandes ayant un souci de
livraison (colis perdu, endommagé, refusé...). Disponible dans le menu
déroulant Statut de chaque commande, dans le filtre de l'écran "Suivi
commandes", et compté à part dans les compteurs (écran commandes + tableau
de bord), affiché en rouge dès qu'il y en a au moins une. Au passage, j'ai
ajusté les couleurs : "En préparation" passe en bleu neutre pour ne plus se
confondre visuellement avec "Problème" (rouge, réservé aux cas qui
nécessitent vraiment ton attention), et "Annulé" passe en gris/jaune
discret.

**30/06 — Preuve de livraison (nouveau)**
Une fois une commande passée au statut "Livré" (manuellement, ou
automatiquement dès qu'une date de livraison est renseignée), une zone
apparaît dans sa fiche pour uploader un justificatif (PDF, JPEG ou PNG —
bon de livraison signé, capture transporteur, etc.). Le fichier est stocké
sur Cloudinary si configuré (mêmes identifiants que pour les photos
d'intervention), sinon sur le disque local du serveur dans
`public/uploads/livraisons/`. Un lien "Voir le document" apparaît ensuite
dans la fiche, avec possibilité de le supprimer/remplacer. Nouveau fichier
`server/uploads.js` (modifié, à copier en plus des autres). Migration
automatique des colonnes au démarrage.

**30/06 — Lien de suivi colis (nouveau)**
Ajout d'une colonne `transporteur` (migration automatique). Dans la fiche
commande, un sélecteur "Transporteur" (Chronopost / Colissimo (La Poste) /
DB Schenker / UPS / Autre) apparaît à côté du N° suivi ; dès que les deux
sont renseignés, un bouton "Suivre le colis" s'affiche, qui ouvre la page de
suivi officielle du transporteur avec le numéro pré-rempli. Le même lien
apparaît aussi en icône directement dans le tableau récapitulatif, sans
ouvrir la fiche. URLs de suivi vérifiées (Chronopost, La Poste/Colissimo,
UPS, DB Schenker) — "Autre" n'affiche pas de lien (pas de format universel).

**30/06 — Synthèse "Suivi commandes" sur le tableau de bord (nouveau)**
Ajout d'une carte dédiée sur le tableau de bord, bien distincte du bloc
Interventions : 4 compteurs (Total / En préparation / Expédié / Livré) +
les 5 commandes "En préparation" les plus récentes, avec un bouton "Voir
toutes les commandes" vers l'écran complet. Placée entre "Récentes
activités" (interventions) et "Transferts fauteuils", dans le même style
visuel que ce dernier.

**30/06 — Exclusion affinée des lignes "frais d'envoi"**
Règle corrigée : seules les lignes "frais d'envoi" accompagnées d'un poids
(ex: "Frais d'envoi - 0,8 kg") sont exclues du détail — ce sont de pures
lignes de coût postal sans info utile. Les lignes "frais d'envoi" SANS
poids, comme "Frais d'envoi et retour - Tests recharges 2 batteries", sont
conservées car elles contiennent une info opérationnelle. Règle dans
`EXCLUSIONS_ACCESSOIRES` (`scripts/sync-vosfactures.js`), facile à étendre.
**Reclique sur "Synchroniser VosFactures"** après redéploiement.

**30/06 — Colonne Quantité remplacée par une icône Info**
La colonne "Quantité" du tableau récapitulatif est masquée ; à la place, une
icône (ⓘ) apparaît à droite de chaque ligne uniquement si la commande a du
texte dans "Informations" — survole-la pour lire le contenu sans ouvrir la
fiche. La quantité reste visible, juste déplacée : un petit "×N" apparaît
à côté du modèle quand elle est supérieure à 1 (pour ne pas la perdre).
Dis-moi si tu préfères que je l'enlève complètement de là aussi.

**30/06 — Accessoires regroupés par catégorie (nouveau)**
Les accessoires/pièces d'un bon de commande sont maintenant regroupés par
catégorie (Batteries, Chargeurs, Moteurs, Supports, Roues & freins, Commande
& électronique, Confort & assise, Frais & services, Autres pièces) au lieu
d'une simple liste à plat, avec la quantité de chaque ligne. La
catégorisation se fait par mots-clés sur le nom du produit (testée sur tes
vrais libellés VosFactures). Le champ "Accessoire" de la fiche commande est
passé en zone de texte multi-lignes pour bien l'afficher. **Reclique sur
"Synchroniser VosFactures"** après redéploiement pour réorganiser les
commandes déjà importées.

**30/06 — Quantités (nouveau)**
Ajout d'une colonne `quantite` sur les commandes (migration automatique au
démarrage). La sync VosFactures récupère désormais la quantité de la ligne
fauteuil, et ajoute "×N" à côté de chaque accessoire/pièce dont la quantité
est supérieure à 1. Visible dans le tableau, modifiable dans la fiche, et
exporté dans l'Excel. **Reclique sur "Synchroniser VosFactures"** après
redéploiement pour rétro-remplir les commandes déjà importées.

**30/06 — Modale "Commande" mal stylée**
Le formulaire d'édition d'une commande utilisait une grille ad hoc au lieu
des classes CSS du reste de l'app (`.modal-header`, `.form-group`,
`.form-label`, `.form-input`...), d'où le rendu brut sans espacement.
Corrigé dans `public/js/app.js` : la modale reprend maintenant exactement le
même habillage que les autres fiches (pièces, fauteuils...).

**30/06 — Détection de modèle erronée ("Eloflex L" partout)**
La sync VosFactures devinait le modèle du fauteuil en testant des lettres
isolées (L, F, H, D2...) sur tout le texte du document (accessoires, notes,
adresse...). La lettre "L" matchait quasi systématiquement en premier
(tailles d'accessoires, fragments de texte...), d'où la sur-représentation
de "Eloflex L". Corrigé dans `scripts/sync-vosfactures.js` : on repère
maintenant la ligne du document dont le nom contient littéralement
"Eloflex" (la ligne du fauteuil) et on utilise son nom tel quel, sans
devinette par motif. **Après avoir redéployé, reclique sur "Synchroniser
VosFactures"** : la sync est idempotente (upsert), donc elle va corriger les
402 commandes déjà importées avec le bon modèle, sans doublon.

**30/06 — Compteurs et filtre année figés à 0**
Après une synchronisation (ou un ajout/suppression manuelle), seul le
tableau se rafraîchissait — les 4 compteurs et la liste des années
restaient figés sur l'état d'avant l'action. Corrigé dans `public/js/app.js`.

## 1. Fichiers à copier dans ton repo

Copie ces 8 fichiers en écrasant ceux du repo (ils remplacent les versions existantes ; import-commandes.js est nouveau) :

- scripts/init-db.js             (modifié — ajoute la table `commandes` + colonne `vf_commande_id`)
- scripts/import-commandes.js    (NOUVEAU — import de l'historique Excel)
- scripts/sync-vosfactures.js    (modifié — ajoute `syncCommandesVF()` / `syncCommandesHistorique()`)
- server/routes.js                (modifié — ajoute les routes /api/commandes/* + sync VF)
- server/uploads.js                (modifié — ajoute le stockage de la preuve de livraison)
- public/js/api.js                (modifié — ajoute les appels API commandes + sync)
- public/js/app.js                (modifié — ajoute l'écran "Suivi commandes" + bouton sync)
- public/js/i18n.js               (modifié — ajoute les traductions FR/EN)
- public/index.html               (modifié — ajoute l'onglet de navigation)

## 2. Déploiement

1. `git add -A && git commit -m "Ajout module suivi commandes + sync VosFactures" && git push`
2. Au prochain déploiement Render, `init-db.js` créera automatiquement la table
   `commandes` et la colonne `vf_commande_id` (idempotent, ne touche pas aux
   données existantes).

## 3. Import de l'historique Excel (une seule fois)

En local ou via un shell Render avec `DATABASE_URL` défini :

```bash
node scripts/import-commandes.js "Compta_Eloflex_140819 (1).xlsx"
```

Ce script :
- Parcourt tous les onglets années (2019 → 2026) automatiquement.
- Réutilise les clients/distributeurs déjà en base (matching par nom) ou les
  crée s'ils n'existent pas encore.
- Rattache chaque commande au fauteuil correspondant (`fauteuils.serie`) s'il
  est déjà importé.
- Est idempotent : tu peux le relancer plusieurs fois sans créer de doublons
  (clé d'import = année + bdc + distributeur + série + date).

Sur ton fichier réel, le test à blanc a validé 5197 lignes exploitables sur
5198 (1 ligne vide ignorée), réparties sur les 8 onglets.

## 4. Synchronisation automatique depuis VosFactures (NOUVEAU)

D'après la doc API VosFactures, il n'existe pas d'endpoint "orders" séparé :
tous les documents (factures, devis, bons de commande...) passent par
`/invoices.json`, filtrable par `kind`. Comme tu crées un document dédié
« bon de commande client » par commande distributeur (`kind=client_order`),
le script récupère désormais ces documents automatiquement et alimente la
table `commandes` :

- `syncCommandesVF()` : récupère les bons de commande des 12 derniers mois
  (appelé automatiquement par le bouton "Sync VosFactures" existant et par
  le nouveau bouton "Synchroniser VosFactures" sur l'écran Suivi commandes).
- `syncCommandesHistorique()` : récupère tout l'historique (appelé
  automatiquement par la sync historique complète existante).

Pour chaque bon de commande, le script récupère : distributeur (via
`client_id` VosFactures, créé si besoin), modèle/accessoire (déduits des
lignes du document), date, numéro de bon de commande (`number`), numéro de
commande (`oid`), et numéro de série du fauteuil (extrait du texte des
lignes via le même pattern que la sync factures existante). L'import est
idempotent (upsert sur `vf_commande_id` = l'ID interne VosFactures du
document).

**Ce qui reste manuel, volontairement** : le numéro de suivi transporteur
(UPS, DB Schenker...) et la date de livraison, puisque tu les saisis
uniquement dans le fichier Excel/l'app — pas dans VosFactures. Ces deux
champs continuent de se remplir à la main sur la fiche commande (formulaire
déjà en place).

⚠️ **À vérifier de ton côté** : je n'ai pas pu tester ce code contre ton
compte VosFactures réel (pas d'accès à ton API token depuis cet environnement).
Le mapping des champs (`kind=client_order`, `oid`, `buyer_name`, `client_id`,
`positions`) est basé sur la documentation officielle VosFactures et sur le
code de sync des factures que tu avais déjà en prod — mais si un champ ne
correspond pas exactement à ce que renvoie ton compte (ex: modèle mal
détecté, distributeur en double), lance d'abord une sync sur une courte
période de test, vérifie le résultat dans l'écran "Suivi commandes", et
dis-moi ce qui ne colle pas : j'ajusterai le mapping précisément.

## 5. Ce que ça donne côté interface

Nouvel onglet **"Suivi commandes"** dans la barre latérale :
- 4 compteurs (total / en préparation / expédiées / livrées)
- Bouton **"Synchroniser VosFactures"** pour tirer les derniers bons de
  commande à la demande
- Filtres : année, statut, distributeur, recherche libre (bdc, n° série, n° suivi, client final, facture)
- Tableau cliquable → fiche détail/édition (modifiable manuellement, y
  compris le n° de suivi et la date de livraison)
- Export Excel dédié (bouton "Excel" en haut)
- Statut calculé automatiquement (En préparation / Expédié / Livré) selon la
  présence d'un n° de suivi ou d'une date de livraison, mais modifiable
  manuellement (ex: "Annulé").

## 6. Rattachement facture/n° de série (NOUVEAU — manuel, volontairement)

À l'étape "bon de commande", VosFactures n'a pas encore de n° de série
(affecté seulement à la facturation), et il n'existe pas de lien fiable
automatique entre un bon de commande et la facture qui en découle (vérifié :
seul le champ `oid` permettrait ça, mais tu ne le ressaisis pas
systématiquement). Plutôt que de deviner et risquer de rattacher la mauvaise
facture à la mauvaise commande (un distributeur a souvent plusieurs
commandes ouvertes en même temps), j'ai ajouté un rattachement **manuel
assisté** :

Dans la fiche d'une commande déjà enregistrée, un bouton "Chercher une
facture VosFactures à rattacher" interroge en direct les factures récentes
du distributeur concerné, tente d'en extraire le n° de série, et te les
liste pour que tu cliques sur la bonne (n° de facture + série pré-remplis
dans le formulaire, à toi de vérifier puis d'enregistrer). Rien n'est
appliqué automatiquement sans ton clic.

**Raccourci ajouté** : comme tu as confirmé que la colonne "Facture" de ton
Excel correspond 1:1 au numéro de facture VosFactures, j'ai ajouté une petite
loupe à côté du champ "N° facture" dans la fiche commande. Si tu connais déjà
ce numéro (tapé à la main, ou collé depuis une autre source), un clic va
chercher directement CETTE facture précise dans VosFactures (recherche
exacte par numéro, pas une liste à parcourir) et remplir automatiquement le
n° de série s'il en trouve un dans les lignes du document.

## 7. Pour la suite (non fait, à discuter si tu veux)

- Alerte automatique sur les commandes "en préparation" depuis trop longtemps
  (sur le modèle de l'alerte stock existante).
- Lien automatique bon de commande ↔ facture VosFactures une fois la
  commande facturée (actuellement, `num_facture` reste à saisir/lier à la
  main côté commande, même si la facture elle-même est déjà synchronisée
  via `fauteuils`).

