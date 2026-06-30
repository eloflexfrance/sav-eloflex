# Module "Suivi des commandes" — intégration dans sav-eloflex

## 1. Fichiers à copier dans ton repo

Copie ces 8 fichiers en écrasant ceux du repo (ils remplacent les versions existantes ; import-commandes.js est nouveau) :

- scripts/init-db.js             (modifié — ajoute la table `commandes` + colonne `vf_commande_id`)
- scripts/import-commandes.js    (NOUVEAU — import de l'historique Excel)
- scripts/sync-vosfactures.js    (modifié — ajoute `syncCommandesVF()` / `syncCommandesHistorique()`)
- server/routes.js                (modifié — ajoute les routes /api/commandes/* + sync VF)
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

## 6. Pour la suite (non fait, à discuter si tu veux)

- Alerte automatique sur les commandes "en préparation" depuis trop longtemps
  (sur le modèle de l'alerte stock existante).
- Lien automatique bon de commande ↔ facture VosFactures une fois la
  commande facturée (actuellement, `num_facture` reste à saisir/lier à la
  main côté commande, même si la facture elle-même est déjà synchronisée
  via `fauteuils`).

