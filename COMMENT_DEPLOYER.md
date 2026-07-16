# Déploiement sur GitHub → Render

## Méthode recommandée

1. **Extraire ce zip par-dessus ton clone local du repo :**
   ```
   unzip -o patch-sav-eloflex.zip -d /chemin/vers/sav-eloflex/
   ```

2. **Depuis le dossier du repo, pousser vers GitHub :**
   ```
   cd sav-eloflex
   git add .
   git commit -m "Update: Devis VF, Liquid Glass, colonnes optionnelles, pays, EDI"
   git push origin main
   ```

3. **Render déploie automatiquement** en 1-2 minutes.

## Fichiers modifiés
- `public/index.html` — nav Devis VosFactures
- `public/js/app.js` — toutes les corrections
- `public/js/api.js` — appels API
- `public/js/devis.js` — **nouveau fichier** (Devis VosFactures)
- `public/js/i18n.js` — traductions
- `public/css/app.css` — Liquid Glass
- `server/routes.js` — routes backend
- `server/uploads.js` — upload photos
- `scripts/init-db.js` — migrations DB
