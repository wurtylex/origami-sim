// main.js — orchestrator. Loads WASM, owns app state, dispatches to renderers.
//
// The two renderers (render2d, render3d) are isolated modules. This file
// decides which one is active, hands them the FoldDocument, and updates the
// stats panel. It doesn't know how either renderer draws — only that they
// have an `update` (or `render2d`) function.

import init, { FoldDocument } from './pkg/origami.js';
import { render2d, attachPanZoom2d, enableDrawingMode, disableDrawingMode, svgToFold, setSelectedCreaseType } from './render2d.js';
import { create3dRenderer } from './render3d.js';

// -----------------------------------------------------------------------------
// DOM references
// -----------------------------------------------------------------------------

const el = {
  svg:           document.getElementById('canvas'),
  three:         document.getElementById('three-canvas'),
  fileInput:     document.getElementById('file-input'),
  uploadLabel:   document.querySelector('label.upload'),
  errorNote:     document.getElementById('error-note'),
  viewToggle:    document.getElementById('view-toggle'),
  toggleButtons: document.querySelectorAll('#view-toggle button'),
  sliderRow:     document.getElementById('fold-slider-row'),
  slider:        document.getElementById('fold-slider'),
  sliderValue:   document.getElementById('fold-value'),
  editBtn:       document.getElementById('edit-crease-mode'),
  editModePanel: document.getElementById('edit-mode-panel'),
  typeButtons:   document.querySelectorAll('.type-btn'),
  exportBtn:     document.getElementById('export'),
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

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------

let doc = null;
let mode = 'cp';        // 'cp' | '3d'
let foldT = 1.0;
let renderer3d = null;  // lazily created
let isEditMode = false;
let selectedCreaseType = 'U';  // 'M' | 'V' | 'B' | 'F' | 'U'

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

function setupEditMode() {
  console.log('Setting up edit mode. Button:', el.editBtn);
  if (!el.editBtn) {
    console.error('Edit button not found!');
    return;
  }

  // Setup type button handlers
  el.typeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      selectedCreaseType = btn.dataset.type;
      setSelectedCreaseType(selectedCreaseType);
      el.typeButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  el.editBtn.addEventListener('click', async () => {
    console.log('Edit button clicked! isEditMode was:', isEditMode);
    isEditMode = !isEditMode;

    // Visual feedback for the button
    el.editBtn.textContent = isEditMode ? '[Save Changes]' : '[Edit Pattern]';
    el.editBtn.classList.toggle('active-mode', isEditMode);

    // Show/hide edit mode panel
    el.editModePanel.hidden = !isEditMode;

    if (isEditMode) {
      enablePatternEditing();
    } else {
      await disablePatternEditing();
      // Logic to update your .FOLD data structure here
    }
  });
}

// -----------------------------------------------------------------------------
// File I/O
// -----------------------------------------------------------------------------

function setupFileInput() {
  el.fileInput.addEventListener('change', () => {
    const file = el.fileInput.files?.[0];
    if (file) loadFile(file);
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
    if (file) loadFile(file);
  });
}

function setupExport() {
  el.exportBtn.addEventListener('click', async () => {
    if (!doc) {
      showError('No pattern loaded. Please upload a FOLD file first.');
      return;
    }

    try {
      const foldData = await svgToFold(el.svg);
      if (!foldData) {
        showError('Could not export pattern.');
        return;
      }

      // Get the title from the current document or use a default
      const title = doc.renderJson ? JSON.parse(doc.renderJson('cp')).title || 'pattern' : 'pattern';
      foldData.title = title;

      const json = JSON.stringify(foldData, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = url;
      a.download = `${title.replace(/\s+/g, '_')}.fold`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      clearError();
    } catch (err) {
      showError(`Could not export pattern: ${err.message || err}`);
    }
  });
}

async function loadFile(file) {
  try {
    const text = await file.text();
    doc = new FoldDocument(text);
    render();
  } catch (err) {
    showError(`Could not load file: ${err.message || err}`);
  }
}

function showError(msg) {
  el.errorNote.textContent = msg;
  el.errorNote.hidden = false;
}

function clearError() {
  el.errorNote.textContent = '';
  el.errorNote.hidden = true;
}

function enablePatternEditing() {
  console.log('Entering edit mode');
  setSelectedCreaseType(selectedCreaseType);
  enableDrawingMode(el.svg, selectedCreaseType);
}

async function disablePatternEditing() {
  console.log('Exiting edit mode');
  disableDrawingMode(el.svg);

  // Convert the SVG back to FOLD format and update the document
  try {
    const foldData = await svgToFold(el.svg);
    if (foldData && doc) {
      // Create a new FoldDocument from the updated data
      const foldJson = JSON.stringify(foldData);
      doc = new FoldDocument(foldJson);
      render();
    }
  } catch (err) {
    showError(`Could not update pattern: ${err.message || err}`);
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
  setupExport();
  render();
  console.log('About to setup edit mode');
  setupEditMode();
  console.log('Setup complete');
}

main().catch(err => {
  console.error(err);
  showError(`Failed to start: ${err.message || err}`);
});
