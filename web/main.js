// main.js — orchestrator. Loads WASM, owns app state, dispatches to renderers.
//
// The two renderers (render2d, render3d) are isolated modules. This file
// decides which one is active, hands them the FoldDocument, and updates the
// stats panel. It doesn't know how either renderer draws — only that they
// have an `update` (or `render2d`) function.
//
// The crease pattern loaded here (default unit square, or an uploaded .fold
// file) is purely the paper substrate the Huzita axiom panel picks points
// and creases from — there is no in-app crease drawing or FOLD verification;
// that lives entirely in the Python server / API / Lean pipeline described
// in project description.txt.
//
// Stacking model: at the start, only the paper's corners and border edges
// are available to pick from. Each stacked axiom computes the real fold line
// (geometry.js) it produces, which becomes a newly available line, and every
// point where that fold crosses an existing line becomes a newly available
// point — this is what "stacking axioms on top of each other" means: later
// folds are built from geometry earlier folds introduced.

import init, { FoldDocument } from './pkg/origami.js';
import { render2d, attachPanZoom2d, enableEntityPickMode, disableEntityPickMode, drawAxiomMarkers } from './render2d.js';
import { create3dRenderer } from './render3d.js';
import * as Geo from './geometry.js';

// -----------------------------------------------------------------------------
// Huzita axiom definitions — mirrors OrigamiAPI.AXIOM_REQUIREMENTS in origami_api.py
// -----------------------------------------------------------------------------

const AXIOMS = {
  1: { desc: 'Fold through two points p1 and p2.', slots: [{ name: 'p1', kind: 'point' }, { name: 'p2', kind: 'point' }] },
  2: { desc: 'Fold that places point p1 onto point p2.', slots: [{ name: 'p1', kind: 'point' }, { name: 'p2', kind: 'point' }] },
  3: { desc: 'Fold that places line l1 onto line l2.', slots: [{ name: 'l1', kind: 'line' }, { name: 'l2', kind: 'line' }] },
  4: { desc: 'Fold through p1, perpendicular to l1.', slots: [{ name: 'p1', kind: 'point' }, { name: 'l1', kind: 'line' }] },
  5: { desc: 'Fold that places p1 onto l1 and passes through p2.', slots: [{ name: 'p1', kind: 'point' }, { name: 'p2', kind: 'point' }, { name: 'l1', kind: 'line' }] },
  6: { desc: 'Fold that places p1 onto l1 and p2 onto l2.', slots: [{ name: 'p1', kind: 'point' }, { name: 'p2', kind: 'point' }, { name: 'l1', kind: 'line' }, { name: 'l2', kind: 'line' }] },
  7: { desc: 'Fold that places p1 onto l1, perpendicular to l2 (l1, l2 not parallel).', slots: [{ name: 'p1', kind: 'point' }, { name: 'l1', kind: 'line' }, { name: 'l2', kind: 'line' }] },
};

const AXIOM_SOLVER = {
  1: (e) => Geo.axiom1(e.p1, e.p2),
  2: (e) => Geo.axiom2(e.p1, e.p2),
  3: (e) => Geo.axiom3(e.l1, e.l2),
  4: (e) => Geo.axiom4(e.p1, e.l1),
  5: (e) => Geo.axiom5(e.p1, e.p2, e.l1),
  6: (e) => Geo.axiom6(e.p1, e.p2, e.l1, e.l2),
  7: (e) => Geo.axiom7(e.p1, e.l1, e.l2),
};

// -----------------------------------------------------------------------------
// DOM references
// -----------------------------------------------------------------------------

const el = {
  svg:           document.getElementById('canvas'),
  three:         document.getElementById('three-canvas'),
  fileInput:     document.getElementById('file-input'),
  uploadLabel:   document.querySelector('label.upload'),
  errorNote:     document.getElementById('error-note'),
  successNote:   document.getElementById('success-note'),
  viewToggle:    document.getElementById('view-toggle'),
  toggleButtons: document.querySelectorAll('#view-toggle button'),
  sliderRow:     document.getElementById('fold-slider-row'),
  slider:        document.getElementById('fold-slider'),
  sliderValue:   document.getElementById('fold-value'),
  themeSelect:   document.getElementById('theme-select'),
  axiomButtons:  document.querySelectorAll('.axiom-btn'),
  axiomDesc:     document.getElementById('axiom-desc'),
  axiomSlots:    document.getElementById('axiom-slots'),
  addAxiomBtn:   document.getElementById('add-axiom-btn'),
  axiomNote:     document.getElementById('axiom-note'),
  stackList:     document.getElementById('axiom-stack-list'),
  undoAxiomBtn:  document.getElementById('undo-axiom-btn'),
  clearStackBtn: document.getElementById('clear-stack-btn'),
  buildLeanBtn:  document.getElementById('build-lean-btn'),
  buildNote:     document.getElementById('build-note'),
  leanPreviewWrap: document.getElementById('lean-preview-wrap'),
  leanPreview:   document.getElementById('lean-preview'),
  stat: {
    title:    document.getElementById('stat-title'),
    vertices: document.getElementById('stat-vertices'),
    edges:    document.getElementById('stat-edges'),
    faces:    document.getElementById('stat-faces'),
    spec:     document.getElementById('stat-spec'),
  },
  counts: {
    m: document.querySelector('[data-count="m"]'),
    v: document.querySelector('[data-count="v"]'),
    b: document.querySelector('[data-count="b"]'),
    f: document.querySelector('[data-count="f"]'),
    u: document.querySelector('[data-count="u"]'),
  },
  corner: {
    spec:  document.getElementById('corner-spec'),
    view:  document.getElementById('corner-view'),
    dims:  document.getElementById('corner-dims'),
    title: document.getElementById('corner-title'),
  },
};

const themes = {
  bewd: {
    '--paper':        '#012a4a',
    '--paper-raised': '#013a63',
    '--ink':          '#a9d6e5',
    '--ink-soft':     '#89c2d9',
    '--pencil':       '#a9d6e5',
    '--pencil-light': '#89c2d9',
    '--rule':         '#61a5c2',
    '--mountain':     '#B8352C',
    '--valley':       '#2C4B8C',
    '--flat':         '#18140F',
  },
  lf: {
    '--paper':        '#33415c',
    '--paper-raised': '#5c677d',
    '--ink':          '#C4BDB0',
    '--ink-soft':     '#C4BDB0',
    '--pencil':       '#979dac',
    '--pencil-light': '#C4BDB0',
    '--rule':         '#979dac',
    '--mountain':     '#B8352C',
    '--valley':       '#2C4B8C',
    '--flat':         '#a9d6e5',
  },
  al: {
    '--paper':        '#F2EDE1',
    '--paper-raised': '#FAF6EC',
    '--ink':          '#18140F',
    '--ink-soft':     '#4A4540',
    '--pencil':       '#8A8075',
    '--pencil-light': '#C4BDB0',
    '--rule':         '#2C2620',
    '--mountain':     '#B8352C',
    '--valley':       '#2C4B8C',
    '--flat':         '#C4BDB0',
  }
};

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------

let doc = null;
let mode = 'cp';        // 'cp' | '3d'
let foldT = 1.0;
let renderer3d = null;  // lazily created

// Huzita axiom stacking state
let selectedAxiomType = null;
let axiomSlotValues = {};   // slot name -> entity | null, for the axiom being built
let pickingSlotName = null;
let candidateSolutions = []; // computed fold lines for the in-progress axiom (0, 1 or many)
let chosenSolution = null;   // the candidate selected to commit on "Add to stack"
let stackEntities = {};     // Lean identifier -> entity, from the server
let stackAxioms = [];       // [{index, type, params}], from the server
let buildPollId = null;

// Client-side construction geometry: what's actually available to pick from.
// Seeded from the paper's corners/border edges, then grown as folds stack.
let paperBounds = null;      // [minX, minY, maxX, maxY] of the loaded paper
let availablePoints = [];    // {kind:'point', id, x, y}
let availableLines = [];     // {kind:'line', id, a, b, c, x1, y1, x2, y2}
let pointCounter = 0;
let lineCounter = 0;
let geometryHistory = [];    // one entry per stacked axiom: {lineId, addedPointIds}

// -----------------------------------------------------------------------------
// Render dispatch
// -----------------------------------------------------------------------------

function render() {
  if (!doc) return;
  clearError();

  if (mode === 'cp') {
    el.svg.style.display = 'block';
    el.three.style.display = 'none';
    try {
      const data = render2d(doc, 'cp', el.svg);
      updateStats(data);
      refreshAxiomMarkers();
    } catch (err) {
      showError(String(err));
    }
  } else {
    el.svg.style.display = 'none';
    el.three.style.display = 'block';
    if (!renderer3d) renderer3d = create3dRenderer(el.three);
    try {
      renderer3d.update(doc, foldT);
      // Stats still come from the CP frame — they describe the pattern itself.
      const data = JSON.parse(doc.renderJson('cp'));
      updateStats(data);
    } catch (err) {
      showError(String(err));
    }
  }
}

// -----------------------------------------------------------------------------
// Stats panel
// -----------------------------------------------------------------------------

function updateStats(data) {
  el.stat.title.textContent    = data.title || 'Untitled';
  el.stat.vertices.textContent = data.vertex_count;
  el.stat.edges.textContent    = data.edge_count;
  el.stat.faces.textContent    = data.face_count;
  el.stat.spec.textContent     = doc.fileSpec != null ? `v${doc.fileSpec}` : '—';

  for (const kind of ['m', 'v', 'b', 'f', 'u']) {
    const n = data.counts[kind];
    el.counts[kind].textContent = n > 0 ? n : '—';
  }

  el.corner.title.textContent = data.title || 'Untitled';
  el.corner.spec.textContent  = doc.fileSpec != null ? `FOLD v${doc.fileSpec}` : 'FOLD';
  el.corner.view.textContent  = mode === '3d' ? '3D Fold' : 'Crease Pattern';

  const [minX, minY, maxX, maxY] = data.bounds;
  const fmt = n => Number.isInteger(n) ? n : n.toFixed(2);
  el.corner.dims.textContent = `${fmt(maxX - minX)} × ${fmt(maxY - minY)}`;
}

// -----------------------------------------------------------------------------
// View toggle + fold slider
// -----------------------------------------------------------------------------

function setMode(next) {
  mode = next;
  el.toggleButtons.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === mode);
  });
  el.sliderRow.hidden = (mode !== '3d');
  render();
}

function setupViewToggle() {
  el.toggleButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      setMode(btn.dataset.view);
    });
  });
}

function setupSlider() {
  el.slider.addEventListener('input', () => {
    foldT = parseFloat(el.slider.value);
    el.sliderValue.textContent = `${Math.round(foldT * 100)}%`;
    if (mode === '3d' && doc && renderer3d) {
      renderer3d.update(doc, foldT);
    }
  });
}

function setupThemeSelector() {
  el.themeSelect.addEventListener('change', (e) => {
    const selectedTheme = themes[e.target.value];
    for (const [property, value] of Object.entries(selectedTheme)) {
      document.documentElement.style.setProperty(property, value);
    }
  });

  const initialTheme = themes[el.themeSelect.value];
  if (initialTheme) {
    for (const [property, value] of Object.entries(initialTheme)) {
      document.documentElement.style.setProperty(property, value);
    }
  }
}

// -----------------------------------------------------------------------------
// File I/O — loading a paper (default unit square, or an uploaded .fold) to
// pick Huzita axiom entities from. No editing or export happens here.
// -----------------------------------------------------------------------------

function setupFileInput() {
  el.fileInput.addEventListener('change', () => {
    const file = el.fileInput.files?.[0];
    if (file) loadFile(file, { resetStack: true });
  });

  ['dragenter', 'dragover'].forEach(evt => {
    el.uploadLabel.addEventListener(evt, e => {
      e.preventDefault();
      el.uploadLabel.classList.add('drag-over');
    });
  });
  ['dragleave', 'drop'].forEach(evt => {
    el.uploadLabel.addEventListener(evt, e => {
      e.preventDefault();
      el.uploadLabel.classList.remove('drag-over');
    });
  });
  el.uploadLabel.addEventListener('drop', e => {
    const file = e.dataTransfer?.files?.[0];
    if (file) loadFile(file, { resetStack: true });
  });
}

async function loadFile(file, { resetStack = false } = {}) {
  try {
    const text = await file.text();
    doc = new FoldDocument(text);
    seedGeometry(JSON.parse(doc.renderJson('cp')));
    resetAxiomSelection();
    render();

    if (resetStack) {
      const res = await fetch('./clear-axioms', { method: 'POST' });
      if (res.ok) applyStack((await res.json()).stack);
    }
  } catch (err) {
    showError(`Could not load file: ${err.message || err}`);
  }
}

async function loadDefaultSquare() {
  const response = await fetch('./square.fold');
  if (!response.ok) {
    throw new Error('Could not load square.fold');
  }
  const blob = await response.blob();
  const initialFile = new File([blob], 'square.fold');
  await loadFile(initialFile);
}

function showError(msg) {
  clearSuccess();
  el.errorNote.textContent = msg;
  el.errorNote.hidden = false;
}

function showSuccess(msg) {
  el.successNote.textContent = msg;
  el.successNote.hidden = false;
}

function clearError() {
  el.errorNote.textContent = '';
  el.errorNote.hidden = true;
}

function clearSuccess() {
  el.successNote.textContent = '';
  el.successNote.hidden = true;
}

// -----------------------------------------------------------------------------
// Construction geometry — the growing pool of points/lines the paper makes
// available. Seeded from corners/border edges; grown by committing the fold
// line each stacked axiom actually produces, plus every point where that
// fold crosses geometry that was already available.
// -----------------------------------------------------------------------------

function coordKey(entity) {
  if (entity.kind === 'point') {
    return `p:${entity.x.toFixed(6)},${entity.y.toFixed(6)}`;
  }
  const pts = [[entity.x1, entity.y1], [entity.x2, entity.y2]].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return `l:${pts[0][0].toFixed(6)},${pts[0][1].toFixed(6)}-${pts[1][0].toFixed(6)},${pts[1][1].toFixed(6)}`;
}

function seedGeometry(data) {
  availablePoints = [];
  availableLines = [];
  geometryHistory = [];
  pointCounter = 0;
  lineCounter = 0;
  paperBounds = data.bounds;

  const pointForCoord = (x, y) => {
    const existing = availablePoints.find(p => Geo.pointsEqual(p, { x, y }));
    if (existing) return existing;
    pointCounter += 1;
    const p = { kind: 'point', id: `P${pointCounter}`, x, y };
    availablePoints.push(p);
    return p;
  };

  for (const edge of data.edges) {
    if (edge.kind !== 'B') continue;
    pointForCoord(edge.x1, edge.y1);
    pointForCoord(edge.x2, edge.y2);
    const line = Geo.lineFromPoints({ x: edge.x1, y: edge.y1 }, { x: edge.x2, y: edge.y2 });
    if (!line) continue;
    lineCounter += 1;
    availableLines.push({
      kind: 'line', id: `L${lineCounter}`,
      a: line.a, b: line.b, c: line.c,
      x1: edge.x1, y1: edge.y1, x2: edge.x2, y2: edge.y2,
    });
  }
}

function addAvailablePoint(x, y) {
  const dup = availablePoints.find(p => Geo.pointsEqual(p, { x, y }));
  if (dup) return { id: dup.id, isNew: false };
  pointCounter += 1;
  const p = { kind: 'point', id: `P${pointCounter}`, x, y };
  availablePoints.push(p);
  return { id: p.id, isNew: true };
}

function commitSolutionToGeometry(solution) {
  lineCounter += 1;
  const newLine = {
    kind: 'line', id: `L${lineCounter}`,
    a: solution.a, b: solution.b, c: solution.c,
    x1: solution.x1, y1: solution.y1, x2: solution.x2, y2: solution.y2,
  };

  const addedPointIds = [];
  for (const existing of availableLines) {
    const ix = Geo.intersectLines(newLine, existing);
    if (!ix) continue;
    if (!Geo.pointOnSegment(ix, newLine) || !Geo.pointOnSegment(ix, existing)) continue;
    const { id, isNew } = addAvailablePoint(ix.x, ix.y);
    if (isNew) addedPointIds.push(id);
  }

  availableLines.push(newLine);
  geometryHistory.push({ lineId: newLine.id, addedPointIds });
}

function undoLastGeometry() {
  const entry = geometryHistory.pop();
  if (!entry) return;
  availableLines = availableLines.filter(l => l.id !== entry.lineId);
  availablePoints = availablePoints.filter(p => !entry.addedPointIds.includes(p.id));
}

// Best-effort reconstruction after a page reload: the server keeps the axiom
// stack (identifiers + coordinates) but not which concrete fold a
// multi-solution axiom resolved to, so ambiguous steps just take the first
// valid candidate rather than leaving the canvas with nothing pickable.
function replayStackIntoGeometry(stackData) {
  for (const axiom of stackData.axioms) {
    const entities = {};
    for (const [slotName, id] of Object.entries(axiom.params)) {
      entities[slotName] = stackData.entities[id];
    }
    const solver = AXIOM_SOLVER[axiom.type];
    if (!solver) continue;
    const rawLines = solver(entities) || [];
    const clipped = rawLines
      .map(line => {
        const seg = Geo.clipLineToBox(line, paperBounds);
        return seg ? { a: line.a, b: line.b, c: line.c, ...seg } : null;
      })
      .filter(Boolean);
    if (clipped.length === 0) continue;
    commitSolutionToGeometry(clipped[0]);
  }
}

// -----------------------------------------------------------------------------
// Huzita axiom panel — pick geometric entities on the canvas, stack axiom
// calls against the Python server, and watch the construction accumulate
// both as a list and as markers drawn directly on the crease pattern.
// -----------------------------------------------------------------------------

function setAxiomNote(msg, kind = 'info') {
  if (!msg) {
    el.axiomNote.hidden = true;
    el.axiomNote.textContent = '';
    return;
  }
  el.axiomNote.textContent = msg;
  el.axiomNote.hidden = false;
  const color = kind === 'error' ? 'var(--mountain)' : kind === 'success' ? '#2f7a4a' : 'var(--rule)';
  el.axiomNote.style.color = kind === 'info' ? '' : color;
  el.axiomNote.style.borderLeftColor = color;
}

function setBuildNote(msg, kind = 'info') {
  if (!msg) {
    el.buildNote.hidden = true;
    el.buildNote.textContent = '';
    return;
  }
  el.buildNote.textContent = msg;
  el.buildNote.hidden = false;
  const color = kind === 'error' ? 'var(--mountain)' : kind === 'success' ? '#2f7a4a' : 'var(--rule)';
  el.buildNote.style.color = kind === 'info' ? '' : color;
  el.buildNote.style.borderLeftColor = color;
}

function formatEntity(entity) {
  if (!entity) return '— unset —';
  const fmt = n => Number.isInteger(n) ? n : n.toFixed(2);
  if (entity.kind === 'point') return `${entity.id ? entity.id + ' ' : ''}(${fmt(entity.x)}, ${fmt(entity.y)})`;
  return `${entity.id ? entity.id + ' ' : ''}(${fmt(entity.x1)}, ${fmt(entity.y1)}) → (${fmt(entity.x2)}, ${fmt(entity.y2)})`;
}

function resetAxiomSelection() {
  selectedAxiomType = null;
  axiomSlotValues = {};
  pickingSlotName = null;
  candidateSolutions = [];
  chosenSolution = null;
  disableEntityPickMode(el.svg);
  el.axiomButtons.forEach(b => b.classList.remove('active'));
  el.axiomDesc.textContent = 'Select an axiom to begin stacking a fold.';
  setAxiomNote('');
  renderAxiomSlots();
}

function selectAxiom(type) {
  selectedAxiomType = type;
  axiomSlotValues = {};
  for (const slot of AXIOMS[type].slots) axiomSlotValues[slot.name] = null;
  pickingSlotName = null;
  candidateSolutions = [];
  chosenSolution = null;
  disableEntityPickMode(el.svg);
  el.axiomDesc.textContent = AXIOMS[type].desc;
  el.axiomButtons.forEach(b => b.classList.toggle('active', Number(b.dataset.axiom) === type));
  setAxiomNote('');
  renderAxiomSlots();
  refreshAxiomMarkers();
}

function renderAxiomSlots() {
  el.axiomSlots.innerHTML = '';
  if (!selectedAxiomType) {
    updateAddAxiomButtonState();
    return;
  }
  for (const slot of AXIOMS[selectedAxiomType].slots) {
    const value = axiomSlotValues[slot.name];
    const isPicking = pickingSlotName === slot.name;

    const row = document.createElement('div');
    row.className = 'axiom-slot' + (value ? ' filled' : '') + (isPicking ? ' picking' : '');

    const label = document.createElement('span');
    label.className = 'axiom-slot-label';
    label.textContent = `${slot.name} (${slot.kind})`;

    const valueSpan = document.createElement('span');
    valueSpan.className = 'axiom-slot-value';
    valueSpan.textContent = formatEntity(value);

    const pickBtn = document.createElement('button');
    pickBtn.className = 'axiom-slot-pick';
    pickBtn.classList.toggle('active-mode', isPicking);
    pickBtn.textContent = isPicking ? 'Click canvas…' : (value ? 'Re-pick' : 'Pick');
    pickBtn.addEventListener('click', () => startPickingSlot(slot.name, slot.kind));

    row.append(label, valueSpan, pickBtn);
    el.axiomSlots.appendChild(row);
  }
  updateAddAxiomButtonState();
}

function updateAddAxiomButtonState() {
  const slotsReady = !!selectedAxiomType && AXIOMS[selectedAxiomType].slots.every(s => axiomSlotValues[s.name]);
  el.addAxiomBtn.disabled = !(slotsReady && chosenSolution);
}

function startPickingSlot(name, kind) {
  if (!doc) {
    setAxiomNote('Load a pattern first.', 'error');
    return;
  }
  if (mode !== 'cp') setMode('cp');

  const candidates = kind === 'point' ? availablePoints : availableLines;
  if (candidates.length === 0) {
    setAxiomNote(`No ${kind}s available yet — stack a fold first.`, 'error');
    return;
  }

  pickingSlotName = name;
  candidateSolutions = [];
  chosenSolution = null;
  renderAxiomSlots();
  setAxiomNote(`Click on the canvas to pick ${name} (${kind}).`);

  enableEntityPickMode(
    el.svg,
    candidates,
    (entity) => {
      axiomSlotValues[name] = entity;
      pickingSlotName = null;
      disableEntityPickMode(el.svg);
      renderAxiomSlots();
      computeCandidates();
    },
    () => {
      setAxiomNote(`No available ${kind} near that click — pick one of the highlighted ${kind}s.`, 'error');
    },
  );
}

// Once every slot is filled, compute the real fold(s) this axiom call would
// produce. 0 solutions means these entities can't actually be folded
// together on this paper; >1 means the user must choose which fold to use
// (Huzita axioms 3, 5 and 6 can have multiple valid folds).
function computeCandidates() {
  candidateSolutions = [];
  chosenSolution = null;

  if (!selectedAxiomType || !AXIOMS[selectedAxiomType].slots.every(s => axiomSlotValues[s.name])) {
    updateAddAxiomButtonState();
    refreshAxiomMarkers();
    return;
  }

  const solver = AXIOM_SOLVER[selectedAxiomType];
  const rawLines = solver(axiomSlotValues) || [];
  candidateSolutions = rawLines
    .map(line => {
      const seg = Geo.clipLineToBox(line, paperBounds);
      if (!seg) return null;
      return { kind: 'line', a: line.a, b: line.b, c: line.c, ...seg };
    })
    .filter(Boolean);

  if (candidateSolutions.length === 0) {
    setAxiomNote('No real fold places these entities on the paper — try different points/lines.', 'error');
  } else if (candidateSolutions.length === 1) {
    chosenSolution = candidateSolutions[0];
    setAxiomNote('Fold computed — ready to add.', 'success');
  } else {
    setAxiomNote(`${candidateSolutions.length} possible folds — click the one to use on the canvas.`, 'info');
    startChoosingSolution();
  }

  updateAddAxiomButtonState();
  refreshAxiomMarkers();
}

function startChoosingSolution() {
  enableEntityPickMode(
    el.svg,
    candidateSolutions,
    (picked) => {
      chosenSolution = picked;
      disableEntityPickMode(el.svg);
      setAxiomNote('Fold selected — ready to add.', 'success');
      updateAddAxiomButtonState();
      refreshAxiomMarkers();
    },
    () => {
      setAxiomNote('Click directly on one of the highlighted candidate folds.', 'error');
    },
    20,
  );
}

async function addAxiomToStack() {
  if (!selectedAxiomType || !chosenSolution) return;
  const params = {};
  for (const slot of AXIOMS[selectedAxiomType].slots) {
    params[slot.name] = axiomSlotValues[slot.name];
  }

  el.addAxiomBtn.disabled = true;
  try {
    const res = await fetch('./add-axiom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: selectedAxiomType, params }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `HTTP ${res.status}`);
    }
    const data = await res.json();
    commitSolutionToGeometry(chosenSolution);
    applyStack(data.stack);
    setAxiomNote(`Axiom ${selectedAxiomType} added as step #${data.axiom.index}.`, 'success');

    for (const slot of AXIOMS[selectedAxiomType].slots) axiomSlotValues[slot.name] = null;
    candidateSolutions = [];
    chosenSolution = null;
    renderAxiomSlots();
    refreshAxiomMarkers();
  } catch (err) {
    setAxiomNote(`Could not add axiom: ${err.message || err}`, 'error');
    updateAddAxiomButtonState();
  }
}

function applyStack(stackData) {
  stackEntities = stackData.entities || {};
  stackAxioms = stackData.axioms || [];

  renderStackList();
  el.leanPreview.textContent = stackData.lean_preview || '';
  el.leanPreviewWrap.hidden = stackAxioms.length === 0;
  el.undoAxiomBtn.disabled = stackAxioms.length === 0;
  el.clearStackBtn.disabled = stackAxioms.length === 0;
  el.buildLeanBtn.disabled = stackAxioms.length === 0;
}

function renderStackList() {
  el.stackList.innerHTML = '';
  if (stackAxioms.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No axioms stacked yet.';
    el.stackList.appendChild(li);
    return;
  }
  for (const axiom of stackAxioms) {
    const keys = Object.values(axiom.params)
      .map(id => stackEntities[id])
      .filter(Boolean)
      .map(coordKey);
    const paramsText = Object.entries(axiom.params).map(([k, v]) => `${k}=${v}`).join(', ');

    const li = document.createElement('li');
    const indexSpan = document.createElement('span');
    indexSpan.className = 'stack-index';
    indexSpan.textContent = `#${axiom.index}`;
    const paramsSpan = document.createElement('span');
    paramsSpan.className = 'stack-params';
    paramsSpan.textContent = paramsText;

    li.append(indexSpan, `Axiom ${axiom.type}`, paramsSpan);
    li.addEventListener('click', () => pulseEntities(keys));
    el.stackList.appendChild(li);
  }
}

function pulseEntities(keys) {
  const world = el.svg.querySelector('g');
  if (!world) return;
  for (const key of keys) {
    world.querySelectorAll(`[data-coord-key="${CSS.escape(key)}"]`).forEach(node => {
      node.classList.remove('pulse');
      void node.getBoundingClientRect(); // restart the CSS animation
      node.classList.add('pulse');
    });
  }
}

function refreshAxiomMarkers() {
  if (!el.svg || mode !== 'cp') return;
  const markers = [];

  for (const p of availablePoints) {
    markers.push({ kind: 'point', x: p.x, y: p.y, variant: 'available', label: p.id, coordKey: coordKey(p) });
  }
  for (const l of availableLines) {
    markers.push({ kind: 'line', x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2, variant: 'available', label: l.id, coordKey: coordKey(l) });
  }

  if (selectedAxiomType) {
    for (const slot of AXIOMS[selectedAxiomType].slots) {
      const entity = axiomSlotValues[slot.name];
      if (!entity) continue;
      if (entity.kind === 'point') {
        markers.push({ kind: 'point', x: entity.x, y: entity.y, variant: 'selected', label: slot.name });
      } else {
        markers.push({ kind: 'line', x1: entity.x1, y1: entity.y1, x2: entity.x2, y2: entity.y2, variant: 'selected', label: slot.name });
      }
    }
    for (const cand of candidateSolutions) {
      markers.push({ kind: 'line', x1: cand.x1, y1: cand.y1, x2: cand.x2, y2: cand.y2, variant: 'candidate' });
    }
  }

  drawAxiomMarkers(el.svg, markers);
}

function setupHuzitaPanel() {
  el.axiomButtons.forEach(btn => {
    btn.addEventListener('click', () => selectAxiom(Number(btn.dataset.axiom)));
  });
  el.addAxiomBtn.addEventListener('click', addAxiomToStack);
}

function stopBuildPolling() {
  if (buildPollId) {
    clearInterval(buildPollId);
    buildPollId = null;
  }
}

async function pollBuildStatus(jobId) {
  const res = await fetch(`./build-lean/status?job_id=${encodeURIComponent(jobId)}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json();
}

async function buildLeanFromStack() {
  stopBuildPolling();
  setBuildNote('Starting Lean build...');
  el.buildLeanBtn.disabled = true;

  try {
    const res = await fetch('./build-lean', { method: 'POST' });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `HTTP ${res.status}`);
    }
    const { job_id: jobId } = await res.json();

    buildPollId = setInterval(async () => {
      try {
        const status = await pollBuildStatus(jobId);
        if (status.status === 'done') {
          stopBuildPolling();
          el.buildLeanBtn.disabled = stackAxioms.length === 0;
          if (status.success) {
            setBuildNote('Lean build succeeded.', 'success');
          } else {
            setBuildNote(status.error || 'Lean build failed.', 'error');
          }
          return;
        }
        setBuildNote(status.step === 'compile' ? 'Compiling Lean...' : 'Queued...');
      } catch (err) {
        stopBuildPolling();
        el.buildLeanBtn.disabled = stackAxioms.length === 0;
        setBuildNote(`Build status failed: ${err.message || err}`, 'error');
      }
    }, 1000);
  } catch (err) {
    el.buildLeanBtn.disabled = stackAxioms.length === 0;
    setBuildNote(`Could not start build: ${err.message || err}`, 'error');
  }
}

function setupStackPanel() {
  el.undoAxiomBtn.addEventListener('click', async () => {
    try {
      const res = await fetch('./undo-axiom', { method: 'POST' });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      if (data.status === 'undone') undoLastGeometry();
      applyStack(data.stack);
      refreshAxiomMarkers();
    } catch (err) {
      setBuildNote(`Undo failed: ${err.message || err}`, 'error');
    }
  });

  el.clearStackBtn.addEventListener('click', async () => {
    if (!confirm('Clear the whole construction stack?')) return;
    try {
      const res = await fetch('./clear-axioms', { method: 'POST' });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      applyStack(data.stack);
      if (doc) seedGeometry(JSON.parse(doc.renderJson('cp')));
      resetAxiomSelection();
      refreshAxiomMarkers();
      setBuildNote('');
    } catch (err) {
      setBuildNote(`Clear failed: ${err.message || err}`, 'error');
    }
  });

  el.buildLeanBtn.addEventListener('click', buildLeanFromStack);
}

async function loadStack() {
  try {
    const res = await fetch('./axioms');
    if (!res.ok) return;
    const data = await res.json();
    applyStack(data);
    if (paperBounds) replayStackIntoGeometry(data);
    refreshAxiomMarkers();
  } catch (err) {
    console.warn('Could not load axiom stack:', err);
  }
}

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------

async function main() {
  console.log('Starting app');
  await init();
  attachPanZoom2d(el.svg);
  setupFileInput();
  setupViewToggle();
  setupSlider();
  setupThemeSelector();
  setupHuzitaPanel();
  setupStackPanel();
  render();

  // Set up default file
  try {
    await loadDefaultSquare();
  } catch (err) {
    console.warn("Failed to preload default pattern:", err);
  }

  await loadStack();

  console.log('Setup complete');
}

main().catch(err => {
  console.error(err);
  showError(`Failed to start: ${err.message || err}`);
});
