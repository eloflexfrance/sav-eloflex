// public/js/eclates.js — Éclatés interactifs (schémas de pièces détachées)
// Vue « Éclatés » : liste des modèles, visionneuse (zoom, bulles cliquables, nomenclature liée au
// catalogue pièces) et mode édition (textes, références, quantités, bulles).
(function(){
'use strict';

// ── État ────────────────────────────────────────────────────────────
const E = window._ECL = window._ECL || { modeleId: null, data: null, vueId: null, sel: null, selN: [], edit: false, lang: null, svgCache: {} };
let vb = null, fit = null, svg = null, back = null, addMode = null;
const $ = id => document.getElementById(id);
const e_ = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const normRef = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// ── Textes FR / EN (langue de l'éclaté, indépendante du reste de l'appli) ──
const TX = {
  fr: { list:'Éclatés', back:'Tous les éclatés', search:'Rechercher une pièce ou une référence…', copy:'Copier', copied:'Copié ✓', qty:'Qté',
    detail:'Voir le détail →', posOn:(p,n)=>`Repère ${p} sur « ${n} » →`, notMarked:'Non repéré sur ce schéma', dup:'Repère en double dans le document',
    sold:'Vendu séparément', cables:'Câbles (sans repère)', subasm:'Sous-ensemble réf. ', marks:'repères', page:'page',
    noLine:'Aucune ligne dans la nomenclature', none:'Aucun résultat', posShort:'repère', horscat:'Absent du catalogue', stock:'Stock',
    ocr:'Schéma en image : repères détectés automatiquement, certains peuvent manquer', fiche:'Fiche article', creer:"Créer l'article",
    foot:'Survole un repère ou une ligne. Clic = sélectionner. Molette / pincement = zoom, glisser = déplacer.',
    edit:'Modifier', editOn:'Mode édition', addLine:'Ajouter une ligne', addBulle:'Ajouter une bulle', editView:'Renommer la vue',
    editFoot:'Mode édition : clic sur une bulle pour la renuméroter ou la supprimer ; crayon sur une ligne pour la modifier.' },
  en: { list:'Exploded views', back:'All exploded views', search:'Search a part or a reference…', copy:'Copy', copied:'Copied ✓', qty:'Qty',
    detail:'View detail →', posOn:(p,n)=>`Callout ${p} on “${n}” →`, notMarked:'No callout on this drawing', dup:'Duplicate callout in document',
    sold:'Sold separately', cables:'Cables (no callout)', subasm:'Sub-assembly ref. ', marks:'callouts', page:'page',
    noLine:'No line in the parts list', none:'No results', posShort:'callout', horscat:'Not in catalogue', stock:'Stock',
    ocr:'Raster drawing: callouts detected automatically, some may be missing', fiche:'Part record', creer:'Create part',
    foot:'Hover a callout or a line. Click = select. Wheel / pinch = zoom, drag = pan.',
    edit:'Edit', editOn:'Edit mode', addLine:'Add a line', addBulle:'Add a callout', editView:'Rename view',
    editFoot:'Edit mode: click a callout to renumber or delete it; pencil on a line to edit it.' }
};
const L = () => E.lang || (typeof LANG !== 'undefined' && LANG === 'en' ? 'en' : 'fr');
const T = k => TX[L()][k];
const peutModifier = () => (typeof canWrite === 'function') && canWrite('eclates');

// ── Données dérivées ────────────────────────────────────────────────
function expandPos(p){
  const out = [];
  String(p || '').split(/[,\s]+/).forEach(part => {
    if (!part) return;
    const m = part.match(/^(\d+)[-–](\d+)$/);
    if (m){ const a = +m[1], b = +m[2]; if (b > a && b - a < 60) for (let k = a; k <= b; k++) out.push(String(k)); }
    else { const n = part.replace(/[^0-9]/g, ''); if (n && /^\d+$/.test(part.replace(/[-–]$/, ''))) out.push(n); }
  });
  return out;
}
function prepare(d){
  const byVue = {};
  d.lignes.forEach(l => {
    l.nums = l.cable ? [] : expandPos(l.pos);
    l.fr = l.desc_fr || l.cat_designation || l.desc_fr_auto || l.desc_en || '';
    l.horscat = !l.cat_id && !!l.ref;
    (byVue[l.vue_id] = byVue[l.vue_id] || []).push(l);
  });
  d.vues.forEach(v => {
    v.reperes = Array.isArray(v.reperes) ? v.reperes : [];
    const all = byVue[v.id] || [];
    v.items = all.filter(l => !l.cable); v.extras = all.filter(l => l.cable);
    v.label_fr = v.nom_fr || v.assembly_designation || v.nom_en || ('Page ' + v.page);
    v.label_en = v.nom_en || v.nom_fr || ('Page ' + v.page);
    const byPos = {};
    v.items.forEach(i => (byPos[i.pos] = byPos[i.pos] || []).push(i));
    Object.values(byPos).forEach(rows => {
      if (rows.length > 1 && new Set(rows.map(r => r.ref + '|' + r.desc_en)).size > 1){
        const lr = new Set(rows.map(r => String(r.desc_en || '').toLowerCase().replace(/\b(left|right|l|r)\b/g, '').replace('&', '').trim())).size === 1;
        rows.forEach(r => r.dup = lr ? 'lr' : 'dup');
      }
    });
  });
  return d;
}
const vname = v => L() === 'fr' ? v.label_fr : v.label_en;
const label = it => L() === 'fr' ? it.fr : (it.desc_en || it.fr);
const cur = () => E.data && E.data.vues.find(v => v.id === E.vueId);
const assemblyView = ref => ref && E.data.vues.find(v => v.assembly_ref && normRef(v.assembly_ref) === normRef(ref));
function elsewhere(ref, vid){
  const out = [];
  E.data.vues.forEach(v => { if (v.id === vid) return;
    v.items.forEach(it => { if (normRef(it.ref) === normRef(ref) && v.reperes.some(b => !b.deleted && it.nums.includes(b.num))) out.push({ v, pos: it.pos }); }); });
  return out;
}

// ── CSS ─────────────────────────────────────────────────────────────
function css(){
  if ($('ecl-css')) return;
  const s = document.createElement('style'); s.id = 'ecl-css';
  s.textContent = `
.ecl-wrap{display:flex;flex-direction:column;height:calc(100vh - 150px);min-height:520px;border:1px solid var(--border);border-radius:var(--radius,12px);overflow:hidden;background:var(--surface,#fff)}
.ecl-tabs{display:flex;gap:6px;padding:8px 12px;border-bottom:1px solid var(--border);overflow-x:auto;flex:none}
.ecl-tabs button{flex:none;border:1px solid var(--border);background:transparent;color:var(--text2);padding:6px 12px;border-radius:999px;font-size:13px;cursor:pointer;white-space:nowrap}
.ecl-tabs button.on{background:var(--accent);border-color:var(--accent);color:#fff}
.ecl-tabs small{opacity:.7;margin-left:4px}
.ecl-main{flex:1;display:flex;min-height:0}
.ecl-viewer{flex:1;position:relative;min-width:0;background:var(--bg)}
.ecl-paper{position:absolute;inset:10px;background:#fff;border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,.08);overflow:hidden;touch-action:none;cursor:grab}
.ecl-paper.drag{cursor:grabbing}.ecl-paper.adding{cursor:crosshair}
.ecl-paper svg{width:100%;height:100%;display:block}
.ecl-tools{position:absolute;right:20px;bottom:20px;display:flex;flex-direction:column;gap:6px;z-index:5}
.ecl-tools button{width:36px;height:36px;border-radius:9px;border:1px solid var(--border);background:var(--surface,#fff);color:var(--text);font-size:17px;cursor:pointer}
.ecl-crumb{position:absolute;left:20px;top:20px;z-index:5;background:var(--surface,#fff);border:1px solid var(--border);border-radius:9px;padding:5px 10px;font-size:13px;display:none}
.ecl-crumb a{color:var(--accent);cursor:pointer;font-weight:600}
.ecl-hint{position:absolute;left:50%;top:18px;transform:translateX(-50%);z-index:6;background:var(--accent);color:#fff;border-radius:9px;padding:6px 12px;font-size:13px;display:none}
.ecl-aside{width:410px;flex:none;border-left:1px solid var(--border);display:flex;flex-direction:column;min-height:0}
.ecl-ahead{padding:12px 14px 8px;border-bottom:1px solid var(--border)}
.ecl-ahead h3{margin:0;font-size:15px;display:flex;gap:8px;align-items:center}
.ecl-ahead p{margin:2px 0 0;color:var(--text3);font-size:12px}
.ecl-list{overflow:auto;flex:1}
.ecl-row{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:start;padding:8px 14px;border-bottom:1px solid var(--border);cursor:pointer}
.ecl-row:hover{background:var(--bg)}
.ecl-row.on{background:rgba(232,89,12,.12)}
.ecl-pos{min-width:28px;height:28px;border-radius:14px;border:1.5px solid var(--text2);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;color:var(--text2);padding:0 5px}
.ecl-pos.multi{font-size:10.5px;height:auto;min-height:28px;line-height:1.2;text-align:center;max-width:70px}
.ecl-row.on .ecl-pos{border-color:#e8590c;background:#e8590c;color:#fff}
.ecl-pos.none{border-style:dashed;opacity:.55}
.ecl-nm{font-weight:600;font-size:13.5px}
.ecl-en{color:var(--text3);font-size:12px}
.ecl-ref{font:12px ui-monospace,Menlo,Consolas,monospace;color:var(--text2);display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:3px}
.ecl-ref button,.ecl-mini{border:1px solid var(--border);background:transparent;color:var(--text2);border-radius:6px;font-size:11px;padding:1px 6px;cursor:pointer}
.ecl-right{text-align:right;font-size:12px;color:var(--text3);white-space:nowrap;padding-top:3px}
.ecl-stock{display:inline-block;margin-top:3px;font-size:11px;padding:1px 6px;border-radius:999px;background:rgba(22,163,74,.12);color:#15803d;font-weight:600}
.ecl-stock.bas{background:rgba(217,119,6,.14);color:#b45309}.ecl-stock.zero{background:rgba(220,38,38,.12);color:#b91c1c}
.ecl-tag{display:inline-block;font-size:11px;padding:1px 7px;border-radius:999px;background:var(--accent-soft,rgba(22,163,74,.12));color:var(--accent);margin:4px 4px 0 0;cursor:pointer;font-weight:600}
.ecl-tag.warn{background:rgba(232,89,12,.14);color:#c2410c;cursor:default}
.ecl-tag.btn{background:transparent;border:1px solid var(--border);color:var(--text2)}
.ecl-sect{padding:9px 14px 5px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text3);font-weight:700;border-bottom:1px solid var(--border)}
.ecl-foot{padding:8px 14px;border-top:1px solid var(--border);font-size:11.5px;color:var(--text3)}
.ecl-tip{position:fixed;z-index:3000;pointer-events:none;background:var(--surface,#fff);color:var(--text);border:1px solid var(--border);border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.18);padding:9px 11px;max-width:300px;display:none;font-size:13px}
.ecl-seg{display:flex;border:1px solid var(--border);border-radius:8px;overflow:hidden}
.ecl-seg button{border:none;background:transparent;color:var(--text2);padding:6px 10px;font-size:12px;cursor:pointer}
.ecl-seg button.on{background:var(--accent);color:#fff}
.ecl-res{position:absolute;top:calc(100% + 4px);left:0;right:0;background:var(--surface,#fff);border:1px solid var(--border);border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.15);max-height:360px;overflow:auto;z-index:60;display:none}
.ecl-res div{padding:7px 11px;cursor:pointer;border-bottom:1px solid var(--border);font-size:13px}
.ecl-res div.on,.ecl-res div:hover{background:var(--bg)}
.ecl-edit-on .ecl-row .ecl-pen{display:inline-flex}
.ecl-pen{display:none}
#ecl-ov .hs{cursor:pointer}
#ecl-ov .ring{fill:transparent;stroke:transparent;stroke-width:1.6}
#ecl-ov .hs:hover .ring,#ecl-ov .hs.on .ring{fill:none;stroke:#e8590c;stroke-width:2.2}
#ecl-ov .lead{stroke:#e8590c;stroke-width:1.4;opacity:0;pointer-events:none}
#ecl-ov .dot{fill:#e8590c;opacity:0;pointer-events:none}
#ecl-ov .halo{fill:none;stroke:#e8590c;stroke-width:1.2;opacity:0;pointer-events:none}
#ecl-ov .lead.on{opacity:.95}#ecl-ov .dot.on{opacity:1}
@keyframes eclpulse{0%{r:3;opacity:.9}100%{r:16;opacity:0}}
#ecl-ov .halo.on{opacity:1;animation:eclpulse 1.2s ease-out infinite}
.ecl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}
.ecl-card{border:1px solid var(--border);border-radius:12px;padding:14px;cursor:pointer;background:var(--surface,#fff)}
.ecl-card:hover{border-color:var(--accent)}
.ecl-card b{font-size:15px}.ecl-card small{display:block;color:var(--text3);margin-top:3px}
@media (max-width:900px){.ecl-main{flex-direction:column}.ecl-viewer{height:55vh;flex:none}.ecl-aside{width:auto;border-left:none;border-top:1px solid var(--border);flex:1}.ecl-wrap{height:auto}}
`;
  document.head.appendChild(s);
}

// ── Point d'entrée (appelé par render() de app.js) ─────────────────
async function renderEclates(ttl, c, a){
  css();
  if (!E.modeleId) return renderListe(ttl, c, a);
  try {
    if (!E.data || E.data.id !== E.modeleId) E.data = prepare(await API.get(`/eclates/${E.modeleId}`));
  } catch (err) { E.modeleId = null; E.data = null; return renderListe(ttl, c, a); }
  if (!E.vueId || !E.data.vues.find(v => v.id === E.vueId)) E.vueId = E.data.vues[0] && E.data.vues[0].id;
  renderViewer(ttl, c, a);
}
window.renderEclates = renderEclates;

// ── Liste des modèles ──────────────────────────────────────────────
async function renderListe(ttl, c, a){
  ttl.textContent = TR('Éclatés');
  const admin = typeof isAdmin === 'function' && isAdmin();
  a.innerHTML = `<div style="display:flex;gap:8px;align-items:center">
    <div style="position:relative"><input id="ecl-gsearch" class="search-bar" placeholder="${TR('Référence (tous modèles)…')}" style="max-width:260px"><div class="ecl-res" id="ecl-gres"></div></div>
    ${admin ? `<label class="btn primary" style="cursor:pointer"><i class="ti ti-upload"></i> ${TR('Importer des éclatés')}<input type="file" id="ecl-import" accept=".json,application/json" multiple style="display:none"></label>` : ''}
  </div>`;
  const list = await API.get('/eclates');
  c.innerHTML = list.length ? `<div class="ecl-grid">${list.map(m => `<div class="ecl-card" data-id="${m.id}">
      <b><i class="ti ti-schema" style="color:var(--accent)"></i> ${e_(m.nom)}</b>
      <small>${m.ref_modele ? 'Réf. ' + e_(m.ref_modele) + ' · ' : ''}${e_(m.date_doc || '')}</small>
      <small>${m.nb_vues} ${TR('vues')} · ${m.nb_lignes} ${TR('lignes')}</small>
      ${admin ? `<small style="margin-top:8px"><span class="ecl-mini" data-del="${m.id}" data-nom="${e_(m.nom)}"><i class="ti ti-trash"></i> ${TR('Supprimer')}</span></small>` : ''}
    </div>`).join('')}</div>`
    : `<div class="empty"><i class="ti ti-schema"></i>${TR('Aucun éclaté importé pour le moment.')}${admin ? '<br>' + TR('Utilisez « Importer des éclatés » avec les fichiers .json fournis.') : ''}</div>`;
  c.querySelectorAll('.ecl-card').forEach(el => el.addEventListener('click', ev => {
    if (ev.target.closest('[data-del]')) return;
    E.modeleId = +el.dataset.id; E.vueId = null; E.data = null; back = null; render();
  }));
  c.querySelectorAll('[data-del]').forEach(el => el.addEventListener('click', async ev => {
    ev.stopPropagation();
    if (!confirm(TR('Supprimer l’éclaté') + ' « ' + el.dataset.nom + ' » ?')) return;
    await API.delete(`/eclates/${el.dataset.del}`); render();
  }));
  const inp = $('ecl-import'); if (inp) inp.addEventListener('change', () => importer(inp));
  const gs = $('ecl-gsearch');
  gs.addEventListener('input', () => { clearTimeout(window._eclGS); window._eclGS = setTimeout(async () => {
    const q = gs.value.trim(), r = $('ecl-gres');
    if (normRef(q).length < 4){ r.style.display = 'none'; return; }
    const hits = await API.get(`/eclates/par-ref/${encodeURIComponent(q)}`);
    r.innerHTML = hits.length ? hits.map((h, i) => `<div data-i="${i}"><b>${e_(h.modele)}</b> · ${e_(h.nom_fr || h.nom_en || '')}<br><small>${TR('repère')} ${e_(h.pos || '–')}</small></div>`).join('')
      : `<div style="cursor:default"><small>${TR('Aucun résultat')}</small></div>`;
    r.style.display = 'block';
    r.querySelectorAll('[data-i]').forEach(d => d.addEventListener('mousedown', ev => { ev.preventDefault(); const h = hits[+d.dataset.i];
      E.modeleId = h.modele_id; E.vueId = h.vue_id; E.data = null; E._pendingSel = h.pos; render(); }));
  }, 250); });
  gs.addEventListener('blur', () => setTimeout(() => { const r = $('ecl-gres'); if (r) r.style.display = 'none'; }, 150));
}

async function importer(inp){
  const files = [...inp.files]; if (!files.length) return;
  let ok = 0, err = [];
  for (const f of files){
    try {
      const body = JSON.parse(await f.text());
      let r = await fetch('/api/eclates/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (r.status === 409){
        const j = await r.json();
        if (!confirm((j.message || 'Existe déjà') + '\n' + TR('Le remplacer ? (les modifications faites dans l’appli sur ce modèle seront perdues)'))) continue;
        body.remplacer = true;
        r = await fetch('/api/eclates/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      }
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      ok++; toast(`${f.name} : ${j.vues} vues, ${j.lignes} lignes`);
    } catch (x) { err.push(f.name + ' : ' + x.message); }
  }
  if (err.length) alert(TR('Erreurs :') + '\n' + err.join('\n'));
  toast(`${ok} ${TR('éclaté(s) importé(s)')}`, 'ti-check', 'var(--success)');
  render();
}

// ── Visionneuse ─────────────────────────────────────────────────────
function renderViewer(ttl, c, a){
  const d = E.data;
  ttl.textContent = TR('Éclaté') + ' — ' + d.nom;
  a.innerHTML = `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
    <button class="btn" id="ecl-back"><i class="ti ti-arrow-left"></i> ${T('back')}</button>
    <div style="position:relative"><input id="ecl-q" class="search-bar" placeholder="${T('search')}" autocomplete="off" style="width:260px"><div class="ecl-res" id="ecl-res"></div></div>
    <div class="ecl-seg"><button data-lg="fr" class="${L()==='fr'?'on':''}">FR</button><button data-lg="en" class="${L()==='en'?'on':''}">EN</button></div>
    ${peutModifier() ? `<button class="btn ${E.edit ? 'primary' : ''}" id="ecl-edit"><i class="ti ti-pencil"></i> ${T('editOn')}</button>` : ''}
  </div>`;
  c.innerHTML = `<div class="ecl-wrap ${E.edit ? 'ecl-edit-on' : ''}">
    <div class="ecl-tabs" id="ecl-tabs"></div>
    <div class="ecl-main">
      <div class="ecl-viewer">
        <div class="ecl-paper" id="ecl-paper"></div>
        <div class="ecl-crumb" id="ecl-crumb"></div>
        <div class="ecl-hint" id="ecl-hint"></div>
        <div class="ecl-tools">
          ${E.edit ? `<button id="ecl-addb" title="${T('addBulle')}"><i class="ti ti-circle-plus"></i></button>` : ''}
          <button id="ecl-zin" title="Zoom +">+</button><button id="ecl-zout" title="Zoom −">−</button><button id="ecl-zfit" title="⤢">⤢</button>
        </div>
      </div>
      <aside class="ecl-aside">
        <div class="ecl-ahead"><h3><span id="ecl-vtitle"></span>${E.edit ? `<button class="ecl-mini" id="ecl-vedit" title="${T('editView')}"><i class="ti ti-pencil"></i></button>` : ''}</h3><p id="ecl-vsub"></p></div>
        <div class="ecl-list" id="ecl-list"></div>
        <div class="ecl-foot">${E.edit ? T('editFoot') : T('foot')}</div>
      </aside>
    </div>
  </div>`;
  if (!$('ecl-tip')){ const t = document.createElement('div'); t.id = 'ecl-tip'; t.className = 'ecl-tip'; document.body.appendChild(t); }
  $('ecl-back').onclick = () => { E.modeleId = null; E.data = null; back = null; render(); };
  a.querySelectorAll('[data-lg]').forEach(b => b.onclick = () => { E.lang = b.dataset.lg; renderViewer(ttl, c, a); });
  if ($('ecl-edit')) $('ecl-edit').onclick = () => { E.edit = !E.edit; addMode = null; renderViewer(ttl, c, a); };
  if ($('ecl-vedit')) $('ecl-vedit').onclick = editerVue;
  if ($('ecl-addb')) $('ecl-addb').onclick = () => { addMode = { step: 1 }; hint(TR('Cliquez à l’endroit de la nouvelle bulle (Échap pour annuler)')); $('ecl-paper').classList.add('adding'); };
  bindZoom(); bindSearch();
  const pend = E._pendingSel; E._pendingSel = null;
  show(E.vueId, pend || E.sel, !!pend);
}

function hint(txt){ const h = $('ecl-hint'); if (!h) return; h.textContent = txt || ''; h.style.display = txt ? 'block' : 'none'; }

function tabs(){
  $('ecl-tabs').innerHTML = E.data.vues.map(v => `<button data-v="${v.id}" class="${v.id === E.vueId ? 'on' : ''}">${e_(vname(v))}<small>${v.items.length + v.extras.length}</small></button>`).join('');
  $('ecl-tabs').querySelectorAll('button').forEach(b => b.onclick = () => { back = null; show(+b.dataset.v); });
}

async function pageSvg(page){
  const k = E.data.id + ':' + page;
  if (!E.svgCache[k]) E.svgCache[k] = await fetch(`/api/eclates/${E.data.id}/pages/${page}`).then(r => r.text());
  return E.svgCache[k];
}

async function show(vueId, selPos, zoom){
  E.vueId = vueId; E.sel = null; E.selN = [];
  const v = cur(); if (!v) return;
  tabs();
  const paper = $('ecl-paper');
  paper.innerHTML = '<div style="padding:30px;color:#888">…</div>';
  const txt = await pageSvg(v.page);
  if (E.vueId !== vueId || !$('ecl-paper')) return;
  paper.innerHTML = txt;
  svg = paper.querySelector('svg');
  if (!svg){ paper.innerHTML = '<div style="padding:30px">SVG ?</div>'; return; }
  svg.removeAttribute('width'); svg.removeAttribute('height');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  const W = +E.data.largeur || 842, H = +E.data.hauteur || 596;
  const [x0, y0, x1, y1] = v.clip || [0, 0, W, H];
  fit = [x0, y0, x1 - x0, y1 - y0];
  const ns = 'http://www.w3.org/2000/svg';
  const g = document.createElementNS(ns, 'g');
  [[0,0,W,y0],[0,y1,W,H-y1],[0,y0,x0,y1-y0],[x1,y0,W-x1,y1-y0]].forEach(r => {
    if (r[2] <= 0 || r[3] <= 0) return;
    const m = document.createElementNS(ns, 'rect'); m.setAttribute('x', r[0]); m.setAttribute('y', r[1]); m.setAttribute('width', r[2]); m.setAttribute('height', r[3]); m.setAttribute('fill', '#fff'); g.appendChild(m);
  });
  svg.appendChild(g);
  drawOverlay();
  vb = fit.slice(); applyVB();
  $('ecl-vtitle').textContent = vname(v);
  $('ecl-vsub').textContent = (v.assembly_ref ? T('subasm') + v.assembly_ref + ' · ' : '') + v.reperes.filter(b => !b.deleted).length + ' ' + T('marks') + ' · ' + T('page') + ' ' + v.page + (v.ocr ? ' · ⚠ ' + T('ocr') : '');
  const cr = $('ecl-crumb');
  if (back){ cr.style.display = 'block'; cr.innerHTML = `<a id="ecl-bk">← ${e_(vname(back.v))}</a>`; $('ecl-bk').onclick = () => { const b = back; back = null; show(b.v.id, b.pos, true); }; }
  else cr.style.display = 'none';
  list();
  if (selPos) select(selPos, true, zoom !== false);
}

function drawOverlay(){
  const v = cur(); const ns = 'http://www.w3.org/2000/svg';
  svg.querySelectorAll('#ecl-fx,#ecl-ov').forEach(n => n.remove());
  // bulles corrigées / ajoutées / supprimées, dessinées par-dessus le schéma
  const fx = document.createElementNS(ns, 'g'); fx.setAttribute('id', 'ecl-fx'); let fh = '';
  v.reperes.forEach(b => {
    if (b.deleted){ fh += `<circle cx="${b.cx}" cy="${b.cy}" r="${b.r + 1}" fill="#fff"/>`; return; }
    if (!b.draw) return;
    if (b.newlead && b.px != null){ const dx = b.px - b.cx, dy = b.py - b.cy, Ln = Math.hypot(dx, dy) || 1;
      fh += `<line x1="${b.cx + dx / Ln * b.r}" y1="${b.cy + dy / Ln * b.r}" x2="${b.px}" y2="${b.py}" stroke="#000" stroke-width=".5"/><circle cx="${b.px}" cy="${b.py}" r=".9" fill="#000"/>`; }
    fh += `<circle cx="${b.cx}" cy="${b.cy}" r="${b.r + .6}" fill="#fff" stroke="#000" stroke-width=".5"/><text x="${b.cx}" y="${b.cy}" text-anchor="middle" dominant-baseline="central" font-family="'Century Gothic','Futura','Avenir','Segoe UI',sans-serif" font-size="${Math.max(7, b.r * 1.05)}" fill="#000">${e_(b.num)}</text>`;
  });
  fx.innerHTML = fh; svg.appendChild(fx);
  const ov = document.createElementNS(ns, 'g'); ov.setAttribute('id', 'ecl-ov');
  let h = '';
  v.reperes.forEach((b, k) => {
    if (b.deleted) return;
    const lead = b.px != null;
    let lx = b.cx, ly = b.cy;
    if (lead){ const dx = b.px - b.cx, dy = b.py - b.cy, Ln = Math.hypot(dx, dy) || 1; lx = b.cx + dx / Ln * b.r; ly = b.cy + dy / Ln * b.r; }
    h += `<g class="hs" data-k="${k}" data-num="${e_(b.num)}"><circle class="ring" cx="${b.cx}" cy="${b.cy}" r="${b.r + 2.5}"/></g>`;
    if (lead) h += `<line class="lead" data-k="${k}" x1="${lx}" y1="${ly}" x2="${b.px}" y2="${b.py}"/><circle class="halo" data-k="${k}" cx="${b.px}" cy="${b.py}" r="4"/><circle class="dot" data-k="${k}" cx="${b.px}" cy="${b.py}" r="2.6"/>`;
  });
  ov.innerHTML = h; svg.appendChild(ov);
  ov.querySelectorAll('.hs').forEach(el => {
    el.addEventListener('mouseenter', ev => { hot(el.dataset.num, true); tipShow(el.dataset.num, ev); });
    el.addEventListener('mousemove', tipMove);
    el.addEventListener('mouseleave', () => { hot(el.dataset.num, false); tipHide(); });
    el.addEventListener('click', ev => { ev.stopPropagation(); if (E.edit) return editerBulle(+el.dataset.k); select(el.dataset.num, true); });
  });
}

function items(num){ return cur().items.filter(i => i.nums.includes(num)); }
function keyNums(key){ const its = cur().items.filter(i => i.pos === key); return its.length ? [...new Set(its.flatMap(i => i.nums))] : [key]; }

function stockBadge(it){
  if (!it.cat_id || L() !== 'fr') return '';
  const s = +it.cat_stock || 0, al = +it.cat_stock_alerte || 0;
  return `<span class="ecl-stock ${s <= 0 ? 'zero' : (s <= al ? 'bas' : '')}">${T('stock')} ${s}</span>`;
}

function list(){
  const v = cur(); let h = '';
  const nums = new Set(v.reperes.filter(b => !b.deleted).map(b => b.num));
  const canCat = typeof canWrite === 'function' && canWrite('catalogue');
  const row = (it, isCable) => {
    const has = it.nums.some(n => nums.has(n));
    const sub = assemblyView(it.ref);
    const oth = (!isCable && !has) ? elsewhere(it.ref, v.id) : [];
    return `<div class="ecl-row" ${isCable ? '' : `data-num="${e_(it.pos)}" data-nums=" ${e_(it.nums.join(' '))} "`} data-id="${it.id}">
      <div class="ecl-pos ${isCable || !has ? 'none' : ''} ${String(it.pos || '').length > 3 ? 'multi' : ''}">${isCable ? '–' : e_(it.pos)}</div>
      <div><div class="ecl-nm">${e_(label(it))}</div>${L() === 'fr' && it.fr !== it.desc_en && it.desc_en ? `<div class="ecl-en">${e_(it.desc_en)}</div>` : ''}
        <div class="ecl-ref">${e_(it.ref || '')}${it.ref ? ` <button data-copy="${e_(it.ref)}">${T('copy')}</button>` : ''}
          ${it.cat_id ? `<button data-fiche="${it.cat_id}">${T('fiche')}</button>` : ''}
          <button class="ecl-pen" data-edit="${it.id}" title="${T('edit')}"><i class="ti ti-pencil"></i></button></div>
        ${sub && sub.id !== v.id ? `<span class="ecl-tag" data-go="${sub.id}">${T('detail')}</span>` : ''}
        ${oth.map(o => `<span class="ecl-tag" data-go="${o.v.id}" data-pos="${e_(o.pos)}">${e_(T('posOn')(o.pos, vname(o.v)))}</span>`).join('')}
        ${!isCable && !has && !oth.length ? `<span class="ecl-tag warn">${T('notMarked')}</span>` : ''}
        ${it.dup === 'dup' ? `<span class="ecl-tag warn">${T('dup')}</span>` : ''}
        ${it.horscat && L() === 'fr' ? `<span class="ecl-tag warn">${T('horscat')}</span>${canCat ? ` <span class="ecl-tag btn" data-creer="${it.id}">+ ${T('creer')}</span>` : ''}` : ''}
        ${it.note ? `<span class="ecl-tag warn">${T('sold')}</span>` : ''}
      </div>
      <div class="ecl-right">${T('qty')} ${e_(it.qty || '—')}${it.cat_id && L() === 'fr' ? `<br>${(+it.cat_prix_distrib || 0).toFixed(2)} € HT` : ''}${it.cat_prix_public != null && L() === 'fr' ? `<br><span title="${TR('Prix public conseillé TTC')}">${(+it.cat_prix_public).toFixed(2)} € TTC</span>` : ''}<br>${stockBadge(it)}</div>
    </div>`;
  };
  v.items.forEach(it => h += row(it, false));
  if (v.extras.length){ h += `<div class="ecl-sect">${T('cables')}</div>`; v.extras.forEach(it => h += row(it, true)); }
  if (E.edit) h += `<div style="padding:10px 14px"><button class="btn sm" id="ecl-addl"><i class="ti ti-plus"></i> ${T('addLine')}</button></div>`;
  const el = $('ecl-list'); el.innerHTML = h;
  el.querySelectorAll('.ecl-row[data-num]').forEach(r => {
    r.addEventListener('mouseenter', () => hot(r.dataset.num, true));
    r.addEventListener('mouseleave', () => hot(r.dataset.num, false));
    r.addEventListener('click', ev => { if (ev.target.closest('button,[data-go],[data-creer]')) return; select(r.dataset.num, true, true); });
  });
  el.querySelectorAll('[data-copy]').forEach(b => b.onclick = ev => { ev.stopPropagation(); navigator.clipboard && navigator.clipboard.writeText(b.dataset.copy).catch(() => {}); b.textContent = T('copied'); setTimeout(() => b.textContent = T('copy'), 1200); });
  el.querySelectorAll('[data-go]').forEach(t => t.onclick = ev => { ev.stopPropagation(); back = { v: cur(), pos: E.sel }; show(+t.dataset.go, t.dataset.pos || null, true); });
  el.querySelectorAll('[data-fiche]').forEach(b => b.onclick = ev => { ev.stopPropagation(); if (typeof modalPiece === 'function'){ E.data = null; modalPiece(+b.dataset.fiche); } });
  el.querySelectorAll('[data-edit]').forEach(b => b.onclick = ev => { ev.stopPropagation(); editerLigne(+b.dataset.edit); });
  el.querySelectorAll('[data-creer]').forEach(b => b.onclick = ev => { ev.stopPropagation(); creerArticle(+b.dataset.creer); });
  if ($('ecl-addl')) $('ecl-addl').onclick = () => editerLigne(null);
}

function hot(key, on){
  if (!svg) return;
  const v = cur(), ns = keyNums(key);
  v.reperes.forEach((b, k) => { if (b.deleted || !ns.includes(b.num)) return; const keep = on || E.selN.includes(b.num);
    svg.querySelectorAll(`#ecl-ov [data-k="${k}"]`).forEach(el => { if (!el.classList.contains('halo')) el.classList.toggle('on', keep); }); });
  ns.forEach(n => $('ecl-list').querySelectorAll(`.ecl-row[data-nums~="${CSS.escape(n)}"]`).forEach(r => r.classList.toggle('on', on || r.dataset.nums.trim().split(' ').some(x => E.selN.includes(x)))));
}
function select(key, scroll, zoom){
  const v = cur(); if (!v || !svg) return;
  E.sel = key; E.selN = keyNums(key);
  svg.querySelectorAll('#ecl-ov .on').forEach(el => el.classList.remove('on'));
  $('ecl-list').querySelectorAll('.ecl-row.on').forEach(r => r.classList.remove('on'));
  hot(key, true);
  v.reperes.forEach((b, k) => svg.querySelectorAll(`#ecl-ov .halo[data-k="${k}"]`).forEach(el => el.classList.toggle('on', !b.deleted && E.selN.includes(b.num))));
  if (scroll){ const r = $('ecl-list').querySelector(`.ecl-row[data-num="${CSS.escape(key)}"]`) || $('ecl-list').querySelector(`.ecl-row[data-nums~="${CSS.escape(key)}"]`); r && r.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  if (zoom){
    const bs = v.reperes.filter(b => !b.deleted && E.selN.includes(b.num)); if (!bs.length) return;
    const xs = [], ys = []; bs.forEach(b => { xs.push(b.cx); ys.push(b.cy); if (b.px != null){ xs.push(b.px); ys.push(b.py); } });
    const mnx = Math.min(...xs), mxx = Math.max(...xs), mny = Math.min(...ys), mxy = Math.max(...ys);
    const w = Math.max(mxx - mnx + 80, fit[2] * .45), hg = Math.max(mxy - mny + 80, fit[3] * .45);
    animateTo([(mnx + mxx) / 2 - w / 2, (mny + mxy) / 2 - hg / 2, w, hg]);
  }
}

// ── Info-bulle ──────────────────────────────────────────────────────
function tipShow(num, ev){
  const its = items(num), t = $('ecl-tip');
  t.innerHTML = !its.length ? `<b>${TR('Repère')} ${e_(num)}</b><div class="ecl-en">${T('noLine')}</div>`
    : its.map(it => `<div style="margin-bottom:4px"><b>${e_(num)} · ${e_(label(it))}</b>${L() === 'fr' && it.desc_en && it.fr !== it.desc_en ? `<div class="ecl-en">${e_(it.desc_en)}</div>` : ''}<div class="ecl-ref">${e_(it.ref || '')} · ${T('qty')} ${e_(it.qty || '—')} ${stockBadge(it)}</div></div>`).join('');
  t.style.display = 'block'; tipMove(ev);
}
function tipMove(ev){ const t = $('ecl-tip'); if (!t) return; t.style.left = Math.min(ev.clientX + 16, innerWidth - t.offsetWidth - 10) + 'px'; t.style.top = Math.min(ev.clientY + 16, innerHeight - t.offsetHeight - 10) + 'px'; }
function tipHide(){ const t = $('ecl-tip'); if (t) t.style.display = 'none'; }

// ── Zoom / déplacement ─────────────────────────────────────────────
function applyVB(){ svg && vb && svg.setAttribute('viewBox', vb.map(n => n.toFixed(2)).join(' ')); }
function animateTo(t){ const s = vb.slice(), t0 = performance.now(); const step = now => { const k = Math.min(1, (now - t0) / 320), e = 1 - Math.pow(1 - k, 3); vb = s.map((x, i) => x + (t[i] - x) * e); applyVB(); if (k < 1) requestAnimationFrame(step); }; requestAnimationFrame(step); }
function toSvg(cx, cy){ const r = $('ecl-paper').getBoundingClientRect(); const sc = Math.max(vb[2] / r.width, vb[3] / r.height); const ox = (r.width * sc - vb[2]) / 2, oy = (r.height * sc - vb[3]) / 2; return [vb[0] - ox + (cx - r.left) * sc, vb[1] - oy + (cy - r.top) * sc]; }
function zoomAt(f, cx, cy){ if (!vb) return; const [sx, sy] = toSvg(cx, cy); const w = Math.min(Math.max(vb[2] * f, fit[2] / 10), fit[2] * 1.4), h = w * vb[3] / vb[2]; vb = [sx - (sx - vb[0]) * w / vb[2], sy - (sy - vb[1]) * h / vb[3], w, h]; applyVB(); }
function bindZoom(){
  const p = $('ecl-paper');
  p.addEventListener('wheel', ev => { ev.preventDefault(); zoomAt(ev.deltaY < 0 ? 0.85 : 1 / 0.85, ev.clientX, ev.clientY); }, { passive: false });
  let drag = null, pts = new Map(), pinch = null;
  p.addEventListener('pointerdown', ev => { pts.set(ev.pointerId, [ev.clientX, ev.clientY]);
    if (pts.size === 1) drag = { x: ev.clientX, y: ev.clientY, vb: vb && vb.slice(), moved: false };
    else if (pts.size === 2){ const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), vb: vb.slice() }; drag = null; } });
  p.addEventListener('pointermove', ev => {
    if (!pts.has(ev.pointerId)) return; pts.set(ev.pointerId, [ev.clientX, ev.clientY]);
    if (pinch && pts.size === 2){ const [a, b] = [...pts.values()]; vb = pinch.vb.slice(); zoomAt(pinch.d / Math.hypot(a[0] - b[0], a[1] - b[1]), (a[0] + b[0]) / 2, (a[1] + b[1]) / 2); return; }
    if (!drag || !drag.vb) return; const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4 && !drag.moved){ drag.moved = true; p.classList.add('drag'); p.setPointerCapture(ev.pointerId); }
    if (drag.moved){ const r = p.getBoundingClientRect(); const sc = Math.max(drag.vb[2] / r.width, drag.vb[3] / r.height); vb = [drag.vb[0] - dx * sc, drag.vb[1] - dy * sc, drag.vb[2], drag.vb[3]]; applyVB(); }
  });
  const up = ev => { const wasDrag = drag && drag.moved; pts.delete(ev.pointerId); if (pts.size < 2) pinch = null;
    if (pts.size === 0){ p.classList.remove('drag'); drag = null; }
    if (ev.type === 'pointerup' && addMode && !wasDrag && !ev.target.closest('#ecl-ov .hs')) clicAjout(ev); };
  p.addEventListener('pointerup', up); p.addEventListener('pointercancel', up);
  p.addEventListener('dblclick', ev => { if (!addMode) zoomAt(0.6, ev.clientX, ev.clientY); });
  $('ecl-zin').onclick = () => { const r = p.getBoundingClientRect(); zoomAt(0.7, r.left + r.width / 2, r.top + r.height / 2); };
  $('ecl-zout').onclick = () => { const r = p.getBoundingClientRect(); zoomAt(1 / 0.7, r.left + r.width / 2, r.top + r.height / 2); };
  $('ecl-zfit').onclick = () => animateTo(fit.slice());
}
document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && addMode){
  if (addMode.step === 2) finirAjout(null); else { addMode = null; hint(''); const p = $('ecl-paper'); p && p.classList.remove('adding'); } } });

// ── Recherche dans le modèle ───────────────────────────────────────
function bindSearch(){
  const q = $('ecl-q'), r = $('ecl-res'); let hits = [], hi = 0;
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  q.addEventListener('input', () => {
    const s = norm(q.value.trim());
    if (s.length < 2){ r.style.display = 'none'; return; }
    const terms = s.split(/\s+/); hits = [];
    E.data.vues.forEach(v => [...v.items, ...v.extras].forEach(it => {
      const hay = norm(it.fr + ' ' + (it.desc_en || '') + ' ' + (it.ref || '') + ' ' + (it.pos ? 'rep pos ' + it.pos : ''));
      if (terms.every(t => hay.includes(t))) hits.push({ v, it });
    }));
    hits = hits.slice(0, 40); hi = 0;
    r.innerHTML = hits.length ? hits.map((x, i) => `<div data-i="${i}" class="${i === 0 ? 'on' : ''}"><b>${e_(label(x.it))}</b><br><small>${e_(x.it.ref || '')} · ${e_(vname(x.v))}${x.it.pos ? ' · ' + T('posShort') + ' ' + e_(x.it.pos) : ''}</small></div>`).join('')
      : `<div style="cursor:default"><small>${T('none')}</small></div>`;
    r.style.display = 'block';
    r.querySelectorAll('[data-i]').forEach(d => d.onmousedown = ev => { ev.preventDefault(); go(hits[+d.dataset.i]); });
  });
  q.addEventListener('keydown', ev => {
    if (r.style.display !== 'block' || !hits.length) return;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp'){ ev.preventDefault(); hi = (hi + (ev.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length; r.querySelectorAll('[data-i]').forEach((d, i) => d.classList.toggle('on', i === hi)); }
    if (ev.key === 'Enter'){ ev.preventDefault(); go(hits[hi]); }
    if (ev.key === 'Escape') r.style.display = 'none';
  });
  q.addEventListener('blur', () => setTimeout(() => r.style.display = 'none', 150));
  const go = x => { r.style.display = 'none'; back = null; show(x.v.id, x.it.pos || null, true); };
}

// ── Édition ─────────────────────────────────────────────────────────
async function recharger(selPos){
  E.data = prepare(await API.get(`/eclates/${E.modeleId}`));
  show(E.vueId, selPos || E.sel, false);
}

function editerLigne(id){
  const v = cur(); const it = id ? [...v.items, ...v.extras].find(x => x.id === id) : null;
  showModal(`<div class="modal-header"><i class="ti ti-schema" style="font-size:19px;color:var(--accent)"></i><h2>${it ? TR('Modifier la ligne') : TR('Nouvelle ligne')}</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body"><div class="grid-2">
      <div class="form-group"><label class="form-label">${TR('Repère(s)')}</label><input class="form-input" id="el-pos" value="${e_(it ? it.pos || '' : '')}" placeholder="12 ou 1,2,3"></div>
      <div class="form-group"><label class="form-label">${TR('Quantité')}</label><input class="form-input" id="el-qty" value="${e_(it ? it.qty || '' : '1')}"></div>
      <div class="form-group" style="grid-column:1/-1"><label class="form-label">${TR('Référence')}</label><input class="form-input mono" id="el-ref" value="${e_(it ? it.ref || '' : '')}"></div>
      <div class="form-group" style="grid-column:1/-1"><label class="form-label">${TR('Désignation anglaise (document)')}</label><input class="form-input" id="el-en" value="${e_(it ? it.desc_en || '' : '')}"></div>
      <div class="form-group" style="grid-column:1/-1"><label class="form-label">${TR('Désignation française (laisser vide pour utiliser le catalogue)')}</label>
        <input class="form-input" id="el-fr" value="${e_(it ? it.desc_fr || '' : '')}" placeholder="${e_(it ? (it.cat_designation || it.desc_fr_auto || '') : '')}">
        ${it && it.cat_designation ? `<div style="font-size:12px;color:var(--text3);margin-top:4px">${TR('Catalogue')} : ${e_(it.cat_designation)}</div>` : ''}</div>
    </div>${it && it.modifie_par ? `<div style="font-size:12px;color:var(--text3)">${TR('Dernière modification')} : ${e_(it.modifie_par)}</div>` : ''}</div>
    <div class="modal-footer">
      ${it ? `<button class="btn danger" id="el-del"><i class="ti ti-trash"></i></button>` : ''}
      <button class="btn" onclick="closeModal()">${TR('Annuler')}</button>
      <button class="btn primary" id="el-ok"><i class="ti ti-check"></i>${TR('Enregistrer')}</button>
    </div>`);
  $('el-ok').onclick = async () => {
    const body = { pos: $('el-pos').value.trim(), qty: $('el-qty').value.trim(), ref: $('el-ref').value.trim(), desc_en: $('el-en').value.trim(), desc_fr: $('el-fr').value.trim() };
    try {
      if (it) await API.put(`/eclates/lignes/${it.id}`, body);
      else await API.post(`/eclates/vues/${v.id}/lignes`, body);
      closeModal(); toast(TR('Enregistré')); await recharger(body.pos || null);
    } catch (x) { alert(x.message); }
  };
  if ($('el-del')) $('el-del').onclick = async () => {
    if (!confirm(TR('Supprimer cette ligne ?'))) return;
    await API.delete(`/eclates/lignes/${it.id}`); closeModal(); await recharger();
  };
}

function editerVue(){
  const v = cur();
  showModal(`<div class="modal-header"><i class="ti ti-schema" style="font-size:19px;color:var(--accent)"></i><h2>${T('editView')}</h2><button class="btn sm" onclick="closeModal()"><i class="ti ti-x"></i></button></div>
    <div class="modal-body">
      <div class="form-group"><label class="form-label">${TR('Nom français (laisser vide pour utiliser le catalogue)')}</label><input class="form-input" id="ev-fr" value="${e_(v.nom_fr || '')}" placeholder="${e_(v.assembly_designation || '')}"></div>
      <div class="form-group"><label class="form-label">${TR('Nom anglais')}</label><input class="form-input" id="ev-en" value="${e_(v.nom_en || '')}"></div>
      <div class="form-group"><label class="form-label">${TR('Référence du sous-ensemble')}</label><input class="form-input mono" id="ev-ref" value="${e_(v.assembly_ref || '')}"></div>
    </div>
    <div class="modal-footer"><button class="btn" onclick="closeModal()">${TR('Annuler')}</button><button class="btn primary" id="ev-ok"><i class="ti ti-check"></i>${TR('Enregistrer')}</button></div>`);
  $('ev-ok').onclick = async () => {
    try { await API.put(`/eclates/vues/${v.id}`, { nom_fr: $('ev-fr').value.trim(), nom_en: $('ev-en').value.trim(), assembly_ref: $('ev-ref').value.trim() });
      closeModal(); toast(TR('Enregistré')); await recharger(); } catch (x) { alert(x.message); }
  };
}

async function sauverReperes(){
  const v = cur();
  await API.put(`/eclates/vues/${v.id}`, { reperes: v.reperes });
  drawOverlay(); list();
  $('ecl-vsub').textContent = (v.assembly_ref ? T('subasm') + v.assembly_ref + ' · ' : '') + v.reperes.filter(b => !b.deleted).length + ' ' + T('marks') + ' · ' + T('page') + ' ' + v.page;
}

async function editerBulle(k){
  const v = cur(), b = v.reperes[k];
  const n = prompt(TR('Numéro de la bulle (laisser vide pour la supprimer) :'), b.num);
  if (n === null) return;
  const val = n.trim();
  if (!val){ if (!confirm(TR('Supprimer cette bulle ?'))) return; if (b.added) v.reperes.splice(k, 1); else b.deleted = true; }
  else if (val !== b.num){ if (!b.orig) b.orig = b.num; b.num = val; b.draw = true; }
  try { await sauverReperes(); toast(TR('Bulle enregistrée')); } catch (x) { alert(x.message); }
}

async function clicAjout(ev){
  const [x, y] = toSvg(ev.clientX, ev.clientY);
  if (addMode.step === 1){
    const n = prompt(TR('Numéro de la nouvelle bulle :'), '');
    if (!n || !n.trim()){ addMode = null; hint(''); $('ecl-paper').classList.remove('adding'); return; }
    const r = (cur().reperes.find(b => !b.deleted) || { r: 10 }).r;
    addMode = { step: 2, b: { num: n.trim(), cx: +x.toFixed(1), cy: +y.toFixed(1), r, px: null, py: null, draw: true, added: true } };
    hint(TR('Cliquez maintenant sur la pièce pour tracer le trait (Échap = sans trait)'));
  } else if (addMode.step === 2){
    addMode.b.px = +x.toFixed(1); addMode.b.py = +y.toFixed(1); addMode.b.newlead = true;
    finirAjout(addMode.b);
  }
}
async function finirAjout(b){
  const bb = b || (addMode && addMode.b); addMode = null; hint(''); const p = $('ecl-paper'); p && p.classList.remove('adding');
  if (!bb) return;
  cur().reperes.push(bb);
  try { await sauverReperes(); toast(TR('Bulle ajoutée')); } catch (x) { alert(x.message); }
}

// Création d'un article manquant, pré-rempli depuis la ligne de l'éclaté
async function creerArticle(id){
  const v = cur(); const it = [...v.items, ...v.extras].find(x => x.id === id); if (!it) return;
  if (typeof modalPiece !== 'function') return;
  await modalPiece(null);
  const set = (k, val) => { const el = $(k); if (el) el.value = val; };
  set('f-ref', it.ref || ''); set('f-reffou', it.ref || ''); set('f-des', it.desc_fr || it.desc_fr_auto || it.desc_en || '');
  E.data = null;   // l'article créé sera relié au prochain affichage
}
})();
