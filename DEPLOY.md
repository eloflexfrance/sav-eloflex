# Déploiement SAV Éloflex v2 — Render + PostgreSQL

## Sur Render

### 1. Créer la base PostgreSQL
- New → PostgreSQL → nom : `sav-eloflex-db` → Create

### 2. Créer le Web Service
- New → Web Service → connecter le dépôt GitHub
- Build Command : `npm install && npm run init-db`
- Start Command : `node server/index.js`
- Plan : Free

### 3. Variables d'environnement (onglet Environment)
| Variable | Valeur |
|---|---|
| DATABASE_URL | Copier l'Internal Database URL depuis la page PostgreSQL |
| NODE_ENV | production |

C'est tout — Render gère le reste automatiquement.

## Fonctionnalités v2
- Gestion clients / fauteuils / interventions
- Garantie automatique (calcul par date d'achat + durée)
- Photos par intervention (drag & drop, lightbox)
- Commentaires internes + historique modifications
- Expéditions en cours avec alertes retard
- Alertes centralisées (stock, relances, garanties)
- Export Excel (interventions, catalogue, expéditions, clients)
- Portail client lecture seule (lien unique)
- Tâches automatiques quotidiennes
- Dark mode
- Synchronisation VosFactures
