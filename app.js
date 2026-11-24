// Steel Tools – Trimble Connect 3D Viewer extension
// FIRST DRAFT – UNTESTED. Checked against trimble-connect-workspace-api v0.3.40 type definitions.
// Units: bounding boxes are in metres; markup positions are in millimetres.

const VERSION = '1.0';
const CHUNK = 1000;

let API;
const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const setStatus = t => { $('status').textContent = t; };
const norm = s => String(s).toLowerCase().replace(/[\s_]/g, '');
const fmt = (n, d = 2) => (n == null || isNaN(n)) ? '–' : Number(n).toFixed(d);
const store = {
  get(k, d) { try { const v = localStorage.getItem('st.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('st.' + k, JSON.stringify(v)); } catch (e) {} }
};

// ---------------------------------------------------------------- Settings
const FIELD_DEFAULTS = {
  Mark: 'Tekla Common.ASSEMBLY_POS',
  Weight: 'Weight',
  Length: 'Length',
  Phase: 'Tekla Common.Phase',
  Profile: 'Product Description',
  Grade: 'IFC Material.Material',
  Finish: 'Finish',
  Name: 'Product Name'
};
let FIELDS = Object.assign({}, FIELD_DEFAULTS, store.get('fields', {}));
let WUNIT = store.get('wunit', 'kg');

function drawSettings() {
  $('setGrid').innerHTML = Object.keys(FIELD_DEFAULTS).map(k =>
    `<span>${k}</span><input data-field="${k}" value="${esc(FIELDS[k])}">`).join('');
  $('setWunit').value = WUNIT;
}

// "Mark" -> mapped key; anything else used as a property key directly
const keyFor = name => {
  const hit = Object.keys(FIELDS).find(k => norm(k) === norm(name));
  return hit ? FIELDS[hit] : name;
};
const listOf = s => s.split(',').map(x => x.trim()).filter(Boolean);

// ---------------------------------------------------------------- Property helpers
function flatten(obj) {
  const m = {};
  const add = (set, name, value) => {
    const full = norm(`${set}.${name}`), bare = norm(name);
    if (!(full in m)) m[full] = value;
    if (!(bare in m)) m[bare] = value;
  };
  (obj.properties || []).forEach(set => (set.properties || []).forEach(p => add(set.name || '', p.name, p.value)));
  const P = obj.product;
  if (P) {
    if (P.name != null) { add('Product', 'Name', P.name); m[norm('Product Name')] ??= P.name; }
    if (P.description != null) { add('Product', 'Description', P.description); m[norm('Product Description')] ??= P.description; }
    if (P.objectType != null) { add('Product', 'ObjectType', P.objectType); m[norm('Product Object Type')] ??= P.objectType; }
  }
  return m;
}
const val = (item, name) => item.m[norm(keyFor(name))];
const has = v => v !== undefined && v !== null && String(v).trim() !== '';
const num = v => { const n = parseFloat(String(v ?? '').replace(',', '.')); return isNaN(n) ? null : n; };
const tonnes = item => { const w = num(val(item, 'Weight')); return w == null ? null : (WUNIT === 'kg' ? w / 1000 : w); };
const markOf = item => val(item, 'Mark') ?? `#${item.id}`;

async function chunked(fn, modelId, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += CHUNK) out.push(...await fn(modelId, ids.slice(i, i + CHUNK)));
  return out;
}
const getProps = (modelId, ids) => chunked((m, c) => API.viewer.getObjectProperties(m, c), modelId, ids);
const getBoxes = (modelId, ids) => chunked((m, c) => API.viewer.getObjectBoundingBoxes(m, c), modelId, ids);

// Adds .box (metres) to items that don't have one yet
async function addBoxes(items) {
  const need = byModel(items.filter(i => !i.box));
  for (const [modelId, list] of Object.entries(need)) {
    const boxes = await getBoxes(modelId, list.map(i => i.id));
    const map = Object.fromEntries(boxes.map(b => [b.id, b.boundingBox]));
    list.forEach(i => { i.box = map[i.id] || null; });
  }
  return items;
}
const centre = b => ({ x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 });
const dims = b => [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z].sort((a, c) => c - a); // metres, largest first
// Length in metres: property (mm) if present, else longest bounding-box side
function lengthM(item) {
  const p = num(val(item, 'Length'));
  if (p != null) return p / 1000;
  return item.box ? dims(item.box)[0] : null;
}

function byModel(items) {
  const g = {};
  items.forEach(i => (g[i.modelId] = g[i.modelId] || []).push(i));
  return g;
}
const selectorFor = items => ({
  modelObjectIds: Object.entries(byModel(items)).map(([modelId, l]) => ({ modelId, objectRuntimeIds: l.map(i => i.id) }))
});

// ---------------------------------------------------------------- Model data
let cache = null;
async function allItems(force) {
  if (cache && !force) return cache;
  setStatus('Reading model data…');
  const models = await API.viewer.getObjects();
  const items = [];
  for (const mo of models) {
    const props = await getProps(mo.modelId, mo.objects.map(o => o.id));
    props.forEach(o => items.push({ modelId: mo.modelId, id: o.id, m: flatten(o) }));
    setStatus(`Reading model data… ${items.length} objects`);
  }
  cache = items;
  setStatus(`Model data read: ${items.length} objects.`);
  return items;
}

async function selectedItems() {
  const sel = await API.viewer.getSelection();
  const items = [];
  for (const s of sel) {
    if (!s.objectRuntimeIds || !s.objectRuntimeIds.length) continue;
    (await getProps(s.modelId, s.objectRuntimeIds)).forEach(o => items.push({ modelId: s.modelId, id: o.id, m: flatten(o) }));
  }
  return items;
}

// ---------------------------------------------------------------- Viewer helpers
const RGB = {
  green: { r: 46, g: 160, b: 67, a: 255 }, red: { r: 211, g: 47, b: 47, a: 255 },
  amber: { r: 245, g: 158, b: 11, a: 255 }, orange: { r: 255, g: 120, b: 0, a: 255 },
  purple: { r: 142, g: 68, b: 173, a: 255 }, grey: { r: 190, g: 190, b: 190, a: 255 },
  blue: { r: 0, g: 99, b: 163, a: 255 }
};
const swatch = c => `<span class="key" style="background:rgb(${c.r},${c.g},${c.b})"></span>`;

async function colour(items, c) { if (items.length) await API.viewer.setObjectState(selectorFor(items), { color: c }); }
async function visible(items, v) { if (items.length) await API.viewer.setObjectState(selectorFor(items), { visible: v }); }
async function resetView() { await API.viewer.setObjectState(undefined, { color: 'reset', visible: 'reset' }); }

async function zoomTo(items) {
  if (!items.length) return;
  const sel = selectorFor(items);
  await API.viewer.setSelection(sel, 'set');
  await API.viewer.setCamera(sel);
}

// Markups we created, per tool, so we only remove our own
const ourMarkups = {};
async function clearMarkups(tool) {
  const ids = ourMarkups[tool] || []; ourMarkups[tool] = [];
  if (ids.length) await API.markup.removeMarkups(ids);
}
const keep = (tool, added) => (ourMarkups[tool] = (ourMarkups[tool] || []).concat(added.map(m => m.id).filter(id => id != null)));
const pick = p => ({ positionX: p.x * 1000, positionY: p.y * 1000, positionZ: p.z * 1000 }); // m -> mm

// Clickable result tables: rows hold item lists, click = select + zoom
const rowSets = {};
function table(tool, headers, rows) {
  rowSets[tool] = rows.map(r => r.items);
  return `<table><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr>` +
    rows.map((r, i) => `<tr class="click" data-tool="${tool}" data-i="${i}">${r.cells.map(c => `<td>${c}</td>`).join('')}</tr>`).join('') +
    '</table>';
}
document.addEventListener('click', e => {
  const tr = e.target.closest('tr.click');
  if (tr) run(() => zoomTo(rowSets[tr.dataset.tool][tr.dataset.i]));
});

const run = fn => Promise.resolve().then(fn).catch(e => setStatus('Error: ' + (e && e.message || e)));

// ---------------------------------------------------------------- 1. Find by mark
async function find() {
  const q = $('findText').value.trim();
  if (!q) return;
  const items = await allItems();
  const qn = norm(q);
  const exact = items.filter(i => norm(markOf(i)) === qn);
  const hits = exact.length ? exact : items.filter(i => norm(val(i, 'Mark') ?? '').includes(qn));
  if (!hits.length) { $('findOut').innerHTML = `<div class="result bad">No member with mark "${esc(q)}".</div>`; return; }
  const groups = {};
  hits.forEach(i => (groups[markOf(i)] = groups[markOf(i)] || []).push(i));
  if ($('findIsolate').checked) {
    await API.viewer.isolateEntities(Object.entries(byModel(hits)).map(([modelId, l]) => ({ modelId, entityIds: l.map(i => i.id) })));
  }
  await zoomTo(exact.length ? exact : hits);
  $('findOut').innerHTML = `<div class="result">${hits.length} object(s) found. Click a row to zoom.</div>` +
    table('find', ['Mark', 'Qty', 'Profile', 'Grade'], Object.entries(groups).slice(0, 100).map(([mk, l]) => ({
      items: l, cells: [esc(mk), l.length, esc(val(l[0], 'Profile')), esc(val(l[0], 'Grade'))]
    })));
  setStatus(`Found ${hits.length} object(s).`);
}

// ---------------------------------------------------------------- 2. Lift checker
let liftItems = [];
async function liftUpdate() {
  liftItems = await addBoxes(await selectedItems());
  if (!liftItems.length) { $('liftOut').innerHTML = 'Select members.'; return; }
  const cap = num($('liftCap').value) ?? 0, rig = num($('liftRig').value) ?? 0;
  let total = 0, heavy = null, noW = 0, cx = 0, cy = 0, cz = 0, wSum = 0;
  liftItems.forEach(i => {
    const t = tonnes(i);
    if (t == null) { noW++; return; }
    total += t;
    if (!heavy || t > tonnes(heavy)) heavy = i;
    if (i.box) { const c = centre(i.box); cx += c.x * t; cy += c.y * t; cz += c.z * t; wSum += t; }
  });
  const gross = total + rig;
  const ok = gross <= cap;
  const cog = wSum ? { x: cx / wSum, y: cy / wSum, z: cz / wSum } : null;
  liftItems.cog = cog;
  $('liftOut').innerHTML = `
    <div>Pieces: <b>${liftItems.length}</b>${noW ? ` <span class="warn">(${noW} without weight)</span>` : ''}</div>
    <div>Steel weight: <b>${fmt(total)} t</b> + rigging ${fmt(rig)} t = <b>${fmt(gross)} t</b></div>
    <div>Capacity: ${fmt(cap)} t → <span class="${ok ? 'ok' : 'bad'}">${ok ? 'OK' : 'OVER CAPACITY'}</span> (${cap ? fmt(gross / cap * 100, 0) : '–'}% utilised)</div>
    <div>Heaviest piece: ${heavy ? `<b>${esc(markOf(heavy))}</b> ${fmt(tonnes(heavy))} t` : '–'}</div>
    <div>Centre of gravity (m): ${cog ? `X ${fmt(cog.x)} · Y ${fmt(cog.y)} · Z ${fmt(cog.z)}` : '–'}</div>`;
}
async function liftCog() {
  if (!liftItems.cog) return setStatus('Select members with weights first.');
  await clearMarkups('lift');
  const c = liftItems.cog;
  keep('lift', await API.markup.addTextMarkup([{ text: 'CoG', start: pick(c), end: pick({ x: c.x, y: c.y, z: c.z + 1 }), color: RGB.red }]));
  setStatus('CoG marker added.');
}
async function liftOver() {
  const cap = (num($('liftCap').value) ?? 0) - (num($('liftRig').value) ?? 0);
  const items = await allItems();
  const over = items.filter(i => (tonnes(i) ?? 0) > cap);
  await colour(over, RGB.red);
  setStatus(`${over.length} piece(s) heavier than ${fmt(cap)} t (capacity minus rigging) coloured red.`);
}

// ---------------------------------------------------------------- 3. Crane radius
function craneChart() {
  return $('craneChart').value.split('\n').map(l => l.split(':').map(s => num(s)))
    .filter(([r, c]) => r != null && c != null).map(([r, c]) => ({ r, c })).sort((a, b) => a.r - b.r);
}
function cranePos() {
  const x = num($('craneX').value), y = num($('craneY').value), z = num($('craneZ').value) ?? 0;
  return (x == null || y == null) ? null : { x, y, z };
}
async function craneFromSel() {
  const items = await addBoxes(await selectedItems());
  const boxes = items.map(i => i.box).filter(Boolean);
  if (!boxes.length) return setStatus('Select the crane base (or any object at its position) first.');
  const min = { x: Math.min(...boxes.map(b => b.min.x)), y: Math.min(...boxes.map(b => b.min.y)), z: Math.min(...boxes.map(b => b.min.z)) };
  const max = { x: Math.max(...boxes.map(b => b.max.x)), y: Math.max(...boxes.map(b => b.max.y)) };
  $('craneX').value = fmt((min.x + max.x) / 2, 3); $('craneY').value = fmt((min.y + max.y) / 2, 3); $('craneZ').value = fmt(min.z, 3);
  setStatus('Crane position set from selection.');
}
async function craneDraw() {
  const p = cranePos(), chart = craneChart();
  if (!p) return setStatus('Enter crane X and Y (or use the selection).');
  if (!chart.length) return setStatus('Enter the load chart.');
  await clearMarkups('crane');
  const lines = [], texts = [], SEG = 48;
  chart.forEach(({ r, c }) => {
    for (let k = 0; k < SEG; k++) {
      const a1 = 2 * Math.PI * k / SEG, a2 = 2 * Math.PI * (k + 1) / SEG;
      lines.push({ start: pick({ x: p.x + r * Math.cos(a1), y: p.y + r * Math.sin(a1), z: p.z }),
                   end: pick({ x: p.x + r * Math.cos(a2), y: p.y + r * Math.sin(a2), z: p.z }), color: RGB.orange });
    }
    const lp = { x: p.x + r, y: p.y, z: p.z };
    texts.push({ text: `${r} m – ${c} t`, start: pick(lp), end: pick({ x: lp.x, y: lp.y, z: lp.z + 1 }), color: RGB.orange });
  });
  texts.push({ text: 'CRANE', start: pick(p), end: pick({ x: p.x, y: p.y, z: p.z + 2 }), color: RGB.red });
  keep('crane', await API.markup.addLineMarkups(lines));
  keep('crane', await API.markup.addTextMarkup(texts));
  setStatus(`Drew ${chart.length} radius ring(s).`);
}
async function craneCheck() {
  const p = cranePos(), chart = craneChart();
  if (!p || !chart.length) return setStatus('Set the crane position and load chart first.');
  const items = await addBoxes((await allItems()).filter(i => tonnes(i) != null));
  const ok = [], over = [], out = [];
  items.forEach(i => {
    if (!i.box) return;
    // worst case: furthest corner of the piece on plan
    const r = Math.max(...[[i.box.min.x, i.box.min.y], [i.box.min.x, i.box.max.y], [i.box.max.x, i.box.min.y], [i.box.max.x, i.box.max.y]]
      .map(([x, y]) => Math.hypot(x - p.x, y - p.y)));
    const row = chart.find(c => c.r >= r);
    if (!row) out.push(i); else if (tonnes(i) <= row.c) ok.push(i); else over.push(i);
  });
  await colour(ok, RGB.green); await colour(over, RGB.red); await colour(out, RGB.grey);
  $('craneOut').innerHTML = `<div class="result">
    ${swatch(RGB.green)}Within capacity: <b>${ok.length}</b><br>
    ${swatch(RGB.red)}Too heavy at that radius: <b>${over.length}</b><br>
    ${swatch(RGB.grey)}Beyond max radius: <b>${out.length}</b></div>` +
    (over.length ? table('crane', ['Mark', 'Weight t'], over.slice(0, 50).map(i => ({ items: [i], cells: [esc(markOf(i)), fmt(tonnes(i))] }))) : '');
  setStatus('Crane check done (uses the furthest corner of each piece; no rigging allowance).');
}

// ---------------------------------------------------------------- 4. Erection sequence
let seq = null, seqTimer = null;
async function seqLoad() {
  const items = await allItems();
  const groups = {}, none = [];
  items.forEach(i => { const p = val(i, 'Phase'); has(p) ? (groups[p] = groups[p] || []).push(i) : none.push(i); });
  const phases = Object.keys(groups).sort((a, b) => (num(a) ?? 0) - (num(b) ?? 0) || String(a).localeCompare(b));
  if (!phases.length) return setStatus('No phase values found – check the Phase setting.');
  seq = { phases, groups, none };
  $('seqSlider').max = phases.length - 1; $('seqSlider').value = 0;
  $('seqCtrl').style.display = 'block';
  await seqShow(0);
}
async function seqShow(i) {
  if (!seq) return;
  i = Math.max(0, Math.min(seq.phases.length - 1, i));
  $('seqSlider').value = i;
  const before = [], now = seq.groups[seq.phases[i]], after = [];
  seq.phases.forEach((p, k) => { if (k < i) before.push(...seq.groups[p]); else if (k > i) after.push(...seq.groups[p]); });
  await visible(after, false);
  await visible(before.concat(now), true);
  await colour(before, RGB.grey);
  await colour(now, RGB.orange);
  const t = now.reduce((s, x) => s + (tonnes(x) ?? 0), 0);
  $('seqLabel').innerHTML = `Phase <b>${esc(seq.phases[i])}</b> (${i + 1} of ${seq.phases.length}) – ${now.length} pieces, ${fmt(t)} t`;
}
function seqPlay() {
  if (seqTimer) { clearInterval(seqTimer); seqTimer = null; $('seqPlay').textContent = '▶ Play'; return; }
  $('seqPlay').textContent = '⏸ Pause';
  seqTimer = setInterval(() => {
    const i = Number($('seqSlider').value) + 1;
    if (i >= seq.phases.length) return seqPlay();
    run(() => seqShow(i));
  }, Math.max(0.5, num($('seqSpeed').value) ?? 1.5) * 1000);
}

// ---------------------------------------------------------------- 5. Load builder
let loadSel = [];
let loads = store.get('loads', []);
async function loadUpdate() {
  loadSel = await addBoxes(await selectedItems());
  if (!loadSel.length) { $('loadOut').innerHTML = 'Select members.'; return; }
  const maxT = num($('loadMaxT').value) ?? 0, maxL = num($('loadMaxL').value) ?? 0, maxW = num($('loadMaxW').value) ?? 0;
  const t = loadSel.reduce((s, i) => s + (tonnes(i) ?? 0), 0);
  const longest = loadSel.reduce((a, i) => (lengthM(i) ?? 0) > (lengthM(a) ?? 0) ? i : a, loadSel[0]);
  const widest = Math.max(...loadSel.map(i => i.box ? dims(i.box)[1] : 0));
  const chk = (bad, txt) => `<span class="${bad ? 'bad' : 'ok'}">${txt}</span>`;
  $('loadOut').innerHTML = `
    <div>Pieces: <b>${loadSel.length}</b></div>
    <div>Weight: <b>${fmt(t)} t</b> of ${fmt(maxT)} t → ${chk(t > maxT, t > maxT ? 'OVERWEIGHT' : 'OK')}</div>
    <div>Longest: <b>${esc(markOf(longest))}</b> ${fmt(lengthM(longest))} m → ${chk((lengthM(longest) ?? 0) > maxL, (lengthM(longest) ?? 0) > maxL ? 'TOO LONG – check abnormal load rules' : 'OK')}</div>
    <div>Widest piece (2nd dimension): ${fmt(widest)} m → ${chk(widest > maxW, widest > maxW ? 'TOO WIDE' : 'OK')}</div>`;
}
function loadSave() {
  if (!loadSel.length) return setStatus('Select members first.');
  const n = loads.length + 1;
  loads.push({ name: `Load ${n}`, pieces: loadSel.map(i => ({ mark: markOf(i), t: tonnes(i), l: lengthM(i), modelId: i.modelId, id: i.id })) });
  store.set('loads', loads); drawLoads(); setStatus(`Saved Load ${n}.`);
}
function drawLoads() {
  if (!loads.length) { $('loadList').innerHTML = ''; return; }
  $('loadList').innerHTML = table('loads', ['Load', 'Pieces', 'Weight t', 'Longest m'], loads.map(L => ({
    items: L.pieces.map(p => ({ modelId: p.modelId, id: p.id })),
    cells: [esc(L.name), L.pieces.length, fmt(L.pieces.reduce((s, p) => s + (p.t ?? 0), 0)), fmt(Math.max(...L.pieces.map(p => p.l ?? 0)))]
  })));
}
function loadCsv() {
  const rows = [['Load', 'Mark', 'Weight t', 'Length m']];
  loads.forEach(L => L.pieces.forEach(p => rows.push([L.name, p.mark, fmt(p.t), fmt(p.l)])));
  download('loads.csv', rows);
}
function download(name, rows) {
  const csv = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------------------------------------------------------------- 6. Heavy / long alerts
async function alerts() {
  const T = num($('alertT').value) ?? Infinity, L = num($('alertL').value) ?? Infinity;
  const items = await addBoxes((await allItems()).filter(i => has(val(i, 'Profile')) || tonnes(i) != null));
  const heavy = [], long = [], both = [];
  items.forEach(i => {
    const h = (tonnes(i) ?? 0) > T, l = (lengthM(i) ?? 0) > L;
    if (h && l) both.push(i); else if (h) heavy.push(i); else if (l) long.push(i);
  });
  await colour(heavy, RGB.red); await colour(long, RGB.amber); await colour(both, RGB.purple);
  const list = both.concat(heavy, long).sort((a, b) => (tonnes(b) ?? 0) - (tonnes(a) ?? 0));
  $('alertOut').innerHTML = `<div class="result">
    ${swatch(RGB.red)}Heavy: <b>${heavy.length}</b> &nbsp; ${swatch(RGB.amber)}Long: <b>${long.length}</b> &nbsp; ${swatch(RGB.purple)}Both: <b>${both.length}</b></div>` +
    (list.length ? table('alerts', ['Mark', 'Weight t', 'Length m'], list.slice(0, 100).map(i => ({ items: [i], cells: [esc(markOf(i)), fmt(tonnes(i)), fmt(lengthM(i))] }))) : '');
  setStatus('Alerts checked.');
}

// ---------------------------------------------------------------- 7. Missing data audit
async function audit() {
  const fields = listOf($('auditFields').value);
  let items = await allItems();
  if ($('auditOnlySteel').checked) items = items.filter(i => has(val(i, 'Profile')));
  const bad = [], good = [], counts = Object.fromEntries(fields.map(f => [f, 0]));
  items.forEach(i => {
    const missing = fields.filter(f => !has(val(i, f)));
    missing.forEach(f => counts[f]++);
    if (missing.length) { i.missing = missing; bad.push(i); } else good.push(i);
  });
  await colour(good, RGB.green); await colour(bad, RGB.red);
  $('auditOut').innerHTML = `<div class="result">
    Checked <b>${items.length}</b>: ${swatch(RGB.green)}complete <b>${good.length}</b>, ${swatch(RGB.red)}missing data <b>${bad.length}</b><br>
    ${fields.map(f => `${esc(f)}: ${counts[f] ? `<span class="bad">${counts[f]} missing</span>` : '<span class="ok">OK</span>'}`).join(' · ')}</div>` +
    (bad.length ? table('audit', ['Mark', 'Missing'], bad.slice(0, 100).map(i => ({ items: [i], cells: [esc(markOf(i)), esc(i.missing.join(', '))] }))) : '');
  setStatus('Audit done.');
}

// ---------------------------------------------------------------- 8. Revision compare
async function revRefresh() {
  const loaded = await API.viewer.getObjects();
  let specs = [];
  try { specs = await API.viewer.getModels('loaded'); } catch (e) {}
  const label = mid => { const s = specs.find(s => s.id === mid || s.versionId === mid); return s ? `${s.name}${s.isLatestVersion ? ' (latest)' : ''}` : mid; };
  const opts = loaded.map(mo => `<option value="${esc(mo.modelId)}">${esc(label(mo.modelId))}</option>`).join('');
  $('revOld').innerHTML = opts; $('revNew').innerHTML = opts;
  if (loaded.length > 1) $('revNew').selectedIndex = 1;
  setStatus(`${loaded.length} loaded model(s) listed.`);
}
async function guidMap(modelId, items) {
  const map = {};
  for (let i = 0; i < items.length; i += CHUNK) {
    const part = items.slice(i, i + CHUNK);
    try {
      const ids = await API.viewer.convertToObjectIds(modelId, part.map(x => x.id));
      ids.forEach((g, k) => { if (g) map[g] = part[k]; });
    } catch (e) {   // one missing ID fails the whole chunk – fall back to one at a time
      for (const x of part) { try { const [g] = await API.viewer.convertToObjectIds(modelId, [x.id]); if (g) map[g] = x; } catch (e2) {} }
    }
  }
  return map;
}
async function revCompare() {
  const oldId = $('revOld').value, newId = $('revNew').value;
  if (!oldId || !newId || oldId === newId) return setStatus('Pick two different loaded models.');
  const fields = listOf($('revFields').value), geom = $('revGeom').checked;
  const items = await allItems(true);
  const oldItems = items.filter(i => i.modelId === oldId), newItems = items.filter(i => i.modelId === newId);
  if (geom) await addBoxes(oldItems.concat(newItems));
  setStatus('Matching objects by GUID…');
  const [O, N] = [await guidMap(oldId, oldItems), await guidMap(newId, newItems)];
  const r5 = v => Math.round(v / 0.005);
  const sig = i => JSON.stringify([fields.map(f => String(val(i, f) ?? '')),
    geom && i.box ? [i.box.min.x, i.box.min.y, i.box.min.z, i.box.max.x, i.box.max.y, i.box.max.z].map(r5) : 0]);
  const added = [], changed = [], same = [], removed = [], oldKeep = [];
  Object.entries(N).forEach(([g, n]) => { const o = O[g]; if (!o) added.push(n); else if (sig(o) !== sig(n)) { n.diff = fields.filter(f => String(val(o, f) ?? '') !== String(val(n, f) ?? '')); changed.push(n); } else same.push(n); });
  Object.entries(O).forEach(([g, o]) => (N[g] ? oldKeep : removed).push(o));
  await visible(oldKeep, false);
  await colour(removed, RGB.red); await colour(added, RGB.green); await colour(changed, RGB.amber); await colour(same, RGB.grey);
  $('revOut').innerHTML = `<div class="result">
    ${swatch(RGB.green)}New: <b>${added.length}</b> &nbsp; ${swatch(RGB.amber)}Changed: <b>${changed.length}</b> &nbsp;
    ${swatch(RGB.red)}Removed: <b>${removed.length}</b> &nbsp; ${swatch(RGB.grey)}Unchanged: <b>${same.length}</b></div>` +
    table('rev', ['Mark', 'Status', 'What changed'], [
      ...changed.map(i => ({ items: [i], cells: [esc(markOf(i)), 'Changed', esc((i.diff && i.diff.length ? i.diff.join(', ') : 'position/size'))] })),
      ...added.map(i => ({ items: [i], cells: [esc(markOf(i)), 'New', ''] })),
      ...removed.map(i => ({ items: [i], cells: [esc(markOf(i)), 'Removed', ''] }))
    ].slice(0, 200));
  setStatus('Compare done. Old version: unchanged objects hidden, removed ones shown red.');
}

// ---------------------------------------------------------------- Tabs & start-up
const TOOLS = ['Find', 'Lift', 'Crane', 'Sequence', 'Loads', 'Alerts', 'Audit', 'Revisions', 'Settings'];
function showTab(name) {
  document.querySelectorAll('.tool').forEach(s => s.classList.toggle('on', s.dataset.tab === name));
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.textContent === name));
  store.set('tab', name);
  if (API && (name === 'Lift' || name === 'Loads')) run(name === 'Lift' ? liftUpdate : loadUpdate);
  if (API && name === 'Revisions') run(revRefresh);
}

(async () => {
  $('ver').textContent = 'Steel Tools v' + VERSION;
  $('tabs').innerHTML = TOOLS.map(t => `<button>${t}</button>`).join('');
  document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => showTab(b.textContent));
  drawSettings(); drawLoads();
  showTab(store.get('tab', 'Find'));

  let timer;
  try {
    API = await TrimbleConnectWorkspace.connect(window.parent, (event, data) => {
      if (data && data.origin && data.origin.isSelf) return;
      if (event === 'viewer.onModelStateChanged') cache = null;          // models loaded/unloaded
      if (event === 'viewer.onSelectionChanged') {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const tab = store.get('tab', 'Find');
          if (tab === 'Lift') run(liftUpdate);
          if (tab === 'Loads') run(loadUpdate);
        }, 300);
      }
    }, 30000);
  } catch (e) { return setStatus('Could not connect to Trimble Connect: ' + (e.message || e)); }
  setStatus('Connected.');

  // wire buttons
  const on = (id, fn) => { $(id).onclick = () => run(fn); };
  on('findGo', find); $('findText').onkeydown = e => { if (e.key === 'Enter') run(find); };
  on('liftCog', liftCog); on('liftOver', liftOver);
  $('liftCap').oninput = $('liftRig').oninput = () => run(liftUpdate);
  on('craneFromSel', craneFromSel); on('craneDraw', craneDraw); on('craneCheck', craneCheck);
  on('craneClear', async () => { await clearMarkups('crane'); setStatus('Rings cleared.'); });
  on('seqLoad', seqLoad); on('seqPrev', () => seqShow(Number($('seqSlider').value) - 1));
  on('seqNext', () => seqShow(Number($('seqSlider').value) + 1)); $('seqPlay').onclick = seqPlay;
  $('seqSlider').oninput = () => run(() => seqShow(Number($('seqSlider').value)));
  on('seqReset', async () => { if (seqTimer) seqPlay(); await resetView(); setStatus('All phases shown.'); });
  on('loadSave', loadSave); on('loadCsv', loadCsv);
  on('loadClear', () => { loads = []; store.set('loads', loads); drawLoads(); setStatus('Loads cleared.'); });
  $('loadMaxT').oninput = $('loadMaxL').oninput = $('loadMaxW').oninput = () => run(loadUpdate);
  on('alertGo', alerts); on('auditGo', audit);
  on('revRefresh', revRefresh); on('revGo', revCompare);
  on('setSave', () => {
    document.querySelectorAll('[data-field]').forEach(i => { FIELDS[i.dataset.field] = i.value.trim(); });
    WUNIT = $('setWunit').value; store.set('fields', FIELDS); store.set('wunit', WUNIT); setStatus('Settings saved.');
  });
  on('setDefaults', () => { FIELDS = Object.assign({}, FIELD_DEFAULTS); WUNIT = 'kg'; drawSettings(); store.set('fields', FIELDS); store.set('wunit', WUNIT); setStatus('Defaults restored.'); });
  on('setRescan', () => allItems(true));
  on('resetAll', async () => {
    if (seqTimer) seqPlay();
    await resetView();
    for (const t of Object.keys(ourMarkups)) await clearMarkups(t);
    setStatus('View reset.');
  });

  showTab(store.get('tab', 'Find'));
})();
