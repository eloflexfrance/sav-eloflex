#!/usr/bin/env node
/**
 * verifier.js — contrôle avant déploiement
 *
 *   node verifier.js
 *
 * Quatre contrôles :
 *   1. Syntaxe de chaque fichier JavaScript
 *   2. Fonctions appelées par le navigateur mais jamais définies
 *   3. Vues et gestionnaires (onclick…) pointant vers une fonction absente
 *   4. Routes appelées par le navigateur mais absentes du serveur
 *
 * Le contrôle 2 utilise l'analyseur « acorn » s'il est installé.
 * Sans lui, il est ignoré : les contrôles 1, 3 et 4 suffisent à repérer
 * les pannes les plus courantes. Pour l'activer :  npm install acorn
 *
 * Sortie 0 si tout va bien, 1 si un problème est détecté.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RACINE = __dirname;
const P = (...s) => path.join(RACINE, ...s);
const lire = f => fs.readFileSync(P(f), 'utf8');

let problemes = 0;
const C = { rouge: t => `\x1b[31m${t}\x1b[0m`, vert: t => `\x1b[32m${t}\x1b[0m`,
            jaune: t => `\x1b[33m${t}\x1b[0m`, gris: t => `\x1b[90m${t}\x1b[0m` };
const titre = t => console.log(`\n${t}\n${'─'.repeat(t.length)}`);
const ok    = t => console.log(`  ${C.vert('OK')}  ${t}`);
const ko    = t => { console.log(`  ${C.rouge('KO')}  ${t}`); problemes++; };
const note  = t => console.log(`  ${C.jaune('··')}  ${t}`);
const info  = t => console.log(`      ${C.gris(t)}`);

const FICHIERS_JS = [
  'server/routes.js', 'server/index.js', 'server/db.js',
  'public/js/app.js', 'public/js/api.js', 'public/js/devis.js',
  'public/js/i18n.js', 'public/js/pdf.js', 'scripts/init-db.js'
].filter(f => fs.existsSync(P(f)));

const FRONT = FICHIERS_JS.filter(f => f.startsWith('public/js/'));
const APP = 'public/js/app.js';

// Globaux fournis par le navigateur ou les bibliothèques externes
const GLOBAUX = new Set(`
window document navigator location history screen performance console localStorage sessionStorage
setTimeout setInterval clearTimeout clearInterval requestAnimationFrame cancelAnimationFrame
queueMicrotask structuredClone getComputedStyle matchMedia fetch alert confirm prompt open close
print focus blur scroll scrollTo scrollBy btoa atob crypto
Object Array String Number Boolean Symbol BigInt Math JSON Date RegExp Error TypeError RangeError
SyntaxError Promise Map Set WeakMap WeakSet Proxy Reflect Function Intl
parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent encodeURI decodeURI
Blob File FileReader FormData Headers Request Response URL URLSearchParams AbortController
Event CustomEvent MutationObserver IntersectionObserver ResizeObserver Image Audio Worker
undefined NaN Infinity globalThis eval
L Chart XLSX Papa _ d3 THREE html2canvas jsPDF
require module exports process __dirname
`.trim().split(/\s+/));

// ═══════════════════════════════════════════════════════════════════
titre('1. Syntaxe des fichiers JavaScript');
for (const f of FICHIERS_JS) {
  try {
    execFileSync(process.execPath, ['--check', P(f)], { stdio: 'pipe' });
    ok(f);
  } catch (e) {
    ko(f);
    info(String(e.stderr || e.message).split('\n').slice(0, 3).join(' '));
  }
}

// ═══════════════════════════════════════════════════════════════════
titre('2. Fonctions appelées mais jamais définies');

let acorn = null;
for (const chemin of ['acorn', P('node_modules/acorn'), '/tmp/node_modules/acorn']) {
  try { acorn = require(chemin); break; } catch (_) { /* suivant */ }
}

if (!acorn) {
  note("Analyseur « acorn » absent — contrôle ignoré (npm install acorn pour l'activer)");
} else {
  // Parcours générique de l'arbre syntaxique
  function parcourir(noeud, visite, parent = null) {
    if (!noeud || typeof noeud.type !== 'string') return;
    visite(noeud, parent);
    for (const cle of Object.keys(noeud)) {
      if (cle === 'type' || cle === 'start' || cle === 'end' || cle === 'loc') continue;
      const v = noeud[cle];
      if (Array.isArray(v)) v.forEach(x => parcourir(x, visite, noeud));
      else if (v && typeof v.type === 'string') parcourir(v, visite, noeud);
    }
  }

  // Tous les noms liés par une déclaration (motifs de déstructuration compris)
  function nomsLies(motif, sortie) {
    if (!motif) return;
    switch (motif.type) {
      case 'Identifier':        sortie.add(motif.name); break;
      case 'ObjectPattern':     motif.properties.forEach(p => nomsLies(p.value || p.argument, sortie)); break;
      case 'ArrayPattern':      motif.elements.forEach(e => nomsLies(e, sortie)); break;
      case 'AssignmentPattern': nomsLies(motif.left, sortie); break;
      case 'RestElement':       nomsLies(motif.argument, sortie); break;
    }
  }

  const declares = new Set();
  const exports  = [];        // { nom, source, ligne } pour « window.X = Y »
  const appels = new Map();   // nom -> [ligne, …]
  let echecAnalyse = false;

  for (const f of FRONT) {
    let ast;
    try {
      ast = acorn.parse(lire(f), { ecmaVersion: 2022, locations: true });
    } catch (e) {
      ko(`${f} — analyse impossible : ${e.message}`);
      echecAnalyse = true;
      continue;
    }
    parcourir(ast, (n, parent) => {
      // Déclarations
      if (n.type === 'FunctionDeclaration' && n.id) declares.add(n.id.name);
      if (n.type === 'ClassDeclaration' && n.id) declares.add(n.id.name);
      if (n.type === 'VariableDeclarator') nomsLies(n.id, declares);
      if (/Function(Declaration|Expression)|ArrowFunctionExpression/.test(n.type)) {
        (n.params || []).forEach(p => nomsLies(p, declares));
        if (n.id) declares.add(n.id.name);
      }
      if (n.type === 'CatchClause') nomsLies(n.param, declares);
      // window.X = … : global SEULEMENT si la valeur est définie sur place.
      // « window.X = X » n'invente rien : X doit exister par ailleurs.
      if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression'
          && n.left.object.type === 'Identifier' && n.left.object.name === 'window'
          && n.left.property.type === 'Identifier') {
        const nom = n.left.property.name;
        if (n.right.type === 'Identifier') exports.push({ nom, source: n.right.name, ligne: n.loc.start.line });
        else declares.add(nom);   // window.X = function(){…}
      }
      // Appels de la forme nom(...) — on ignore obj.methode(...)
      if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && f === APP) {
        const nom = n.callee.name;
        if (!appels.has(nom)) appels.set(nom, []);
        appels.get(nom).push(n.loc.start.line);
      }
    });
  }

  if (!echecAnalyse) {
    // « window.X = Y » ne rend X global que si Y existe réellement
    const vides = [];
    for (const e of exports) {
      if (declares.has(e.source) || GLOBAUX.has(e.source)) declares.add(e.nom);
      else vides.push(e);
    }
    for (const e of vides) ko(`window.${e.nom} = ${e.source}  —  ${e.source} n'existe pas (ligne ${e.ligne})`);

    const manquantes = [...appels].filter(([nom]) => !declares.has(nom) && !GLOBAUX.has(nom));
    if (!manquantes.length) {
      ok(`${appels.size} fonctions appelées, toutes définies`);
    } else {
      const lignesApp = lire(APP).split('\n');
      for (const [nom, lignes] of manquantes.sort()) {
        ko(`${nom}  —  ligne(s) ${lignes.slice(0, 5).join(', ')}${lignes.length > 5 ? '…' : ''}`);
        info((lignesApp[lignes[0] - 1] || '').trim().slice(0, 100));
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
titre('3. Vues et gestionnaires du navigateur');

const appJs = fs.existsSync(P(APP)) ? lire(APP) : '';
const sourceFront = FRONT.map(lire).join('\n');
// Sans les « window.X = » : un export ne doit pas valider sa propre cible
const sourceFrontStrict = sourceFront.replace(/window\.([A-Za-z_$][\w$]*)\s*=\s*\1\s*;/g, '');

function estDefini(nom, source) {
  const e = nom.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    new RegExp(`function\\s+${e}\\s*\\(`),
    new RegExp(`(?:const|let|var)\\s+${e}(?![\\w$])`),
    new RegExp(`window\\.${e}\\s*=`),
    new RegExp(`\\b${e}\\s*[:=]\\s*(?:async\\s*)?(?:function|\\()`),
    new RegExp(`class\\s+${e}(?![\\w$])`)
  ].some(m => m.test(source));
}

// 3a. Fonctions de vue appelées par le routeur
const vues = [...appJs.matchAll(/STATE\.view\s*===\s*'(\w+)'\)[\s\S]{0,220}?(render[A-Z]\w*)\s*\(/g)];
if (!vues.length) {
  note('Aucun routage de vue détecté (le format a peut-être changé)');
} else {
  const absentes = vues.filter(v => !estDefini(v[2], sourceFrontStrict));
  absentes.length
    ? absentes.forEach(v => ko(`vue « ${v[1]} » → ${v[2]} absente`))
    : ok(`${vues.length} vues, toutes rattachées à une fonction existante`);
}

// 3b. Gestionnaires inline : onclick="maFonction(...)"
const CSS = new Set(['var','rgba','rgb','hsl','hsla','minmax','repeat','translate','translateX',
  'translateY','translateZ','scale','scaleX','scaleY','rotate','skew','matrix','calc','url','blur',
  'linear-gradient','radial-gradient','conic-gradient','cubic-bezier','steps','clamp','min','max',
  'brightness','saturate','drop-shadow','attr','counter','env']);

const MOTS_CLES = new Set(['if','for','while','switch','catch','return','typeof','new','delete',
  'void','in','of','do','else','try','finally','function','class','await','yield','instanceof']);

const handlers = new Map();
for (const m of appJs.matchAll(/\bon(?:click|input|change|keydown|keyup|keypress|submit|blur|focus|mouseover|mouseout|mouseenter|mouseleave)\s*=\s*(["'])((?:\\.|(?!\1)[\s\S])*?)\1/g)) {
  const ligne = appJs.slice(0, m.index).split('\n').length;
  for (const c of m[2].matchAll(/(?<![\w.$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const nom = c[1];
    if (CSS.has(nom) || GLOBAUX.has(nom) || MOTS_CLES.has(nom)) continue;
    if (estDefini(nom, sourceFrontStrict)) continue;
    if (!handlers.has(nom)) handlers.set(nom, []);
    handlers.get(nom).push(ligne);
  }
}
if (!handlers.size) {
  ok('Tous les gestionnaires pointent vers une fonction existante');
} else {
  for (const [nom, lignes] of [...handlers].sort()) {
    ko(`${nom}()  —  gestionnaire ligne(s) ${lignes.slice(0, 5).join(', ')}`);
  }
}

// 3c. window.X = X où X n'existe pas
// Les exports « window.X = Y » sont déjà vérifiés par l'analyse acorn du
// contrôle 2, qui voit aussi les paramètres. Repli si acorn est absent.
if (acorn) {
  ok('Exports window.X vérifiés au contrôle 2');
} else {
  const sansAuto = appJs.replace(/window\.([A-Za-z_$][\w$]*)\s*=\s*\1\s*;/g, '');
  const orphelins = [];
  for (const m of appJs.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*;/g)) {
    if (!estDefini(m[2], sansAuto)) orphelins.push(`${m[1]} = ${m[2]}`);
  }
  orphelins.length
    ? ko(`Exports vers une fonction absente : ${orphelins.join(', ')}`)
    : ok('Aucun export window.X orphelin');
}

// ═══════════════════════════════════════════════════════════════════
titre('4. Routes appelées par le navigateur');

if (!fs.existsSync(P('server/routes.js'))) {
  note('server/routes.js absent, contrôle ignoré');
} else {
  const routes = lire('server/routes.js');
  const gabarit = c => c.split('?')[0].replace(/\/+$/, '')
    .split('/').map(s => (s.startsWith(':') || s === '*' ? '*' : s)).join('/');

  // Côté serveur : couples méthode + gabarit de chemin
  const cotesServeur = [];
  for (const r of routes.matchAll(/router\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/g)) {
    cotesServeur.push({ methode: r[1].toUpperCase(), gab: gabarit(r[2]) });
  }

  const correspond = (methode, chemin) => {
    const seg = gabarit(chemin).split('/');
    return cotesServeur.some(r => {
      if (r.methode !== methode) return false;
      const ss = r.gab.split('/');
      return ss.length === seg.length && ss.every((s, i) => s === '*' || seg[i] === '*' || s === seg[i]);
    });
  };
  // Une interpolation finale est souvent une chaîne de requête : on essaie sans.
  const serveurConnait = (m, c) => correspond(m, c) || (/\*$/.test(c) && correspond(m, c.replace(/\*$/, '')));

  const appelees = new Map();   // "MÉTHODE chemin" -> fichiers
  const ajouter = (methode, brut, fichier) => {
    const chemin = brut.replace(/\$\{[^}]*\}/g, '*').replace(/^\/api/, '').split('?')[0];
    if (!chemin.startsWith('/') || chemin === '/') return;
    const cle = `${methode} ${chemin}`;
    if (!appelees.has(cle)) appelees.set(cle, new Set());
    appelees.get(cle).add(fichier);
  };

  for (const f of FRONT) {
    const src = lire(f);
    // API.get('/x') / API.post / API.put / API.del
    for (const a of src.matchAll(/API\.(get|post|put|del|delete)\s*\(\s*(['"`])((?:\\.|(?!\2)[\s\S])*?)\2/g)) {
      const m = a[1] === 'del' ? 'DELETE' : a[1].toUpperCase();
      ajouter(m, a[3], f);
    }
    // fetch('/api/x', { method: 'PUT' })  —  GET par défaut
    for (const a of src.matchAll(/fetch\s*\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1\s*(,\s*\{[\s\S]{0,200}?\})?/g)) {
      const opts = a[3] || '';
      const mm = opts.match(/method\s*:\s*['"`](\w+)['"`]/);
      ajouter(mm ? mm[1].toUpperCase() : 'GET', a[2], f);
    }
  }

  const inconnues = [...appelees.keys()].filter(k => {
    const [m, ...reste] = k.split(' ');
    return !serveurConnait(m, reste.join(' '));
  }).sort();

  if (!inconnues.length) {
    ok(`${appelees.size} appels de route, tous présents côté serveur`);
  } else {
    inconnues.forEach(k => ko(`${k}  —  depuis ${[...appelees.get(k)].join(', ')}`));
    info('Faux positif possible si le chemin est assemblé par concaténation.');
  }
}

// ═══════════════════════════════════════════════════════════════════
titre('Résultat');
if (problemes === 0) {
  console.log(`  ${C.vert('Aucun problème détecté — le patch peut être déployé.')}\n`);
  process.exit(0);
}
console.log(`  ${C.rouge(`${problemes} problème(s) à corriger avant de déployer.`)}\n`);
process.exit(1);
