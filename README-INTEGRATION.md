# Module "Doublons VosFactures" — intégration (version exacte)

D'après ton `routes.js` et `app.js`, voici les 3 fichiers à modifier — copier-coller direct, rien à deviner.

## 1. `server/routes.js`

Ouvre le fichier `SNIPPET-routes.js.txt` de ce patch.
Colle tout son contenu **juste après** ce bloc existant (fin de la section VosFactures) :

```js
router.get('/vosfactures/status', async (req, res) => {
  try {
    const configured = !!(process.env.VOSFACTURES_API_TOKEN && process.env.VOSFACTURES_ACCOUNT);
    const lastSync = await db.get("SELECT * FROM sync_log WHERE status='ok' ORDER BY created_at DESC LIMIT 1");
    res.json({ configured, account: process.env.VOSFACTURES_ACCOUNT||null, last_sync: lastSync||null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

Aucune nouvelle dépendance, aucun nouvel `app.use` : ce sont juste 3 nouvelles routes
(`GET /doublons-vf/detecter`, `POST /doublons-vf/fusionner`, `PUT /doublons-vf/adresse/:id`)
ajoutées au routeur existant, avec les mêmes conventions que le reste du fichier
(`db.get/all/run`, `axios` en require local, `requireAuth`/`adminOnly`).

## 2. `public/index.html`

Remplacer la ligne :
```html
<div class="nav-item" data-view="carte"><i class="ti ti-map-2"></i><span>Carte</span></div>
```
par :
```html
<div class="nav-item" data-view="carte"><i class="ti ti-map-2"></i><span>Carte</span></div>
<div class="nav-item" data-view="doublons-vf"><i class="ti ti-copy"></i><span>Doublons VosFactures</span></div>
```

Et ajouter le script, à côté des autres, juste avant `</body>` :
```html
<script src="/js/doublons-vf.js"></script>
```
(après `app.js`, comme `devis.js`)

➡️ Rien d'autre à faire côté clic : ton code attache déjà automatiquement un `onclick`
à tout élément `.nav-item[data-view]` via
`document.querySelectorAll('.nav-item').forEach(n=>n.addEventListener('click',()=>setView(n.dataset.view)))`.

## 3. `public/js/app.js`

Dans la fonction `render()`, ajouter une ligne dans la chaîne de `if/else if`,
juste après le cas `carte` :

```js
else if(STATE.view==='carte')         { renderCarte(ttl,c,a); return; }
else if(STATE.view==='doublons-vf')   { renderDoublonsVF(ttl,c,a); return; }
```

C'est tout — `renderDoublonsVF` est définie dans le nouveau fichier `public/js/doublons-vf.js`.

## 4. `public/js/doublons-vf.js`

Copier ce fichier tel quel dans `public/js/`. Il est déjà adapté à ton conteneur `#content`,
`#topbar-title`, `#topbar-actions` et au style `.card` / `.section-title` de ton app.

## Accès (rôles)

Le module n'étant pas listé dans `NAV_ROLES` / permissions, il n'est visible et
utilisable que par les comptes **admin** (comme la carte des distributeurs, les
utilisateurs, etc.) — cohérent vu que la fusion est une action irréversible.
Si tu veux l'ouvrir à d'autres rôles, ajoute `'doublons-vf'` dans le tableau
`NAV_ROLES.operateur` de `app.js` et adapte `requireAuth`/`adminOnly` dans les routes.

## Après une fusion

La fusion VosFactures est immédiate et irréversible (documents automatiquement
réattribués par VosFactures lui-même). Les fiches locales `clients` (liées via
`vf_id`) et les `commandes` liées sont réattribuées automatiquement quand c'est
possible ; pense ensuite à cliquer sur **Sync VosFactures** (bouton déjà présent
dans la barre latérale) pour nettoyer les éventuelles fiches locales désormais
obsolètes.

## Vérification

Comme d'habitude, lance `node verifier.js` avant de déployer.
