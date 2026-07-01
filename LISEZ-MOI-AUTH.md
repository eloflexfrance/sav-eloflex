# Système d'authentification — SAV Éloflex

## 1. Packages à ajouter (si pas déjà dans node_modules)

```bash
npm install express-session connect-pg-simple bcryptjs
```

## 2. Variable d'environnement à ajouter sur Render

Dans Dashboard Render → Environment, ajouter :

```
SESSION_SECRET = une_chaine_aleatoire_longue_et_secrete_ex_abc123xyz789
```

⚠️ Sans cette variable, l'app fonctionne avec une valeur par défaut (OK pour les tests),
mais elle DOIT être définie en production pour que les sessions soient sécurisées.
Génère une chaîne aléatoire de 32+ caractères.

## 3. Déploiement

```bash
git add -A && git commit -m "Ajout système d'authentification" && git push
```

Au redémarrage, Render créera automatiquement les tables `users` et `user_sessions`
via `init-db.js`.

## 4. Créer ton premier compte admin (OBLIGATOIRE avant d'accéder à l'app)

Via le shell Render (Dashboard → ton service → Shell) :

```bash
node scripts/create-user.js create "Brice" brice@eloflex.fr TonMotDePasse123 admin
```

Puis pour Frédéric :
```bash
node scripts/create-user.js create "Frédéric" frederic@eloflex.fr AutreMotDePasse operateur
```

Et pour les contacts suédois (exemple) :
```bash
node scripts/create-user.js create "Linnea" linnea@eloflex.se MotDePasseSuedois consultation
```

## 5. Gérer les utilisateurs

```bash
node scripts/create-user.js list                              # Lister tous les comptes
node scripts/create-user.js reset-password email nouveau_mdp  # Changer un mot de passe
node scripts/create-user.js disable email                     # Désactiver un compte
node scripts/create-user.js enable  email                     # Réactiver un compte
```

## 6. Niveaux d'accès

| Rôle         | Accès                                                                 |
|-------------|-----------------------------------------------------------------------|
| admin        | Tout (y compris Paramètres, Sync VosFactures, Rapports & exports)    |
| operateur    | Clients, Interventions, Expéditions SAV, Commandes, Catalogue, Alertes, Retours Suède, Transferts |
| consultation | Tableau de bord uniquement (lecture seule)                            |

## 7. Ce que chaque personne voit

- La page `/login` est accessible sans authentification.
- Tout le reste redirige vers `/login` si non connecté.
- Nom de l'utilisateur connecté + bouton de déconnexion visible en bas de la barre latérale.
- Les sessions durent 7 jours (cookie httpOnly, secure en production).
- Les sessions sont stockées en PostgreSQL (persistantes entre redémarrages Render).
