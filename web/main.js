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
  successNote:   document.getElementById('success-note'),
  leanNote:      document.getElementById('lean-note'),
  viewToggle:    document.getElementById('view-toggle'),
  toggleButtons: document.querySelectorAll('#view-toggle button'),
  sliderRow:     document.getElementById('fold-slider-row'),
  slider:        document.getElementById('fold-slider'),
  sliderValue:   document.getElementById('fold-value'),
  editBtn:       document.getElementById('edit-crease-mode'),
  editModePanel: document.getElementById('edit-mode-panel'),
  typeButtons:   document.querySelectorAll('.type-btn'),
  exportBtn:     document.getElementById('export'),
  runLeanBtn:    document.getElementById('run-lean'),
  themeSelect:   document.getElementById('theme-select'),
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
    // '--paper-shadow': rgba(24, 20, 15, 0.12),
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
    // '--paper-shadow': rgba(24, 20, 15, 0.12),
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
    // '--paper-shadow': rgba(24, 20, 15, 0.12),
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
let isEditMode = false;
let selectedCreaseType = 'U';  // 'M' | 'V' | 'B' | 'F' | 'U'
let lastExportFilename = null;
let leanPollId = null;

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


function setupThemeSelector() {
  el.themeSelect.addEventListener('change', (e) => {
    const selectedTheme = themes[e.target.value];
    console.log('picked theme' + e.target.value)
    // Loop through the selected theme and update CSS variables
    for (const [property, value] of Object.entries(selectedTheme)) {
      document.documentElement.style.setProperty(property, value);
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


async function tryServerExport(foldData, title) {
  try {
    const res = await fetch('./export-fold', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, fold: foldData }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `HTTP ${res.status}`);
    }
    const payload = await res.json().catch(() => null);
    if (payload?.filename) {
      console.log(`Saved ${payload.filename}`);
    }
    return { ok: true, filename: payload?.filename };
  } catch (err) {
    console.warn('Server export failed, falling back to download.', err);
    return { ok: false };
  }
}

async function startLeanJob(filename) {
  const res = await fetch('./run-lean', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }
  const payload = await res.json();
  return payload.job_id;
}

async function pollLeanStatus(jobId) {
  const res = await fetch(`./run-lean/status?job_id=${encodeURIComponent(jobId)}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json();
}

function showLeanStatus(msg) {
  el.leanNote.textContent = msg;
  el.leanNote.hidden = false;
}

function clearLeanStatus() {
  el.leanNote.textContent = '';
  el.leanNote.hidden = true;
}

function stopLeanPolling() {
  if (leanPollId) {
    clearInterval(leanPollId);
    leanPollId = null;
  }
}

function setupExport() {
  el.exportBtn.addEventListener('click', async () => {
    if (!doc) {
      showError('No pattern loaded. Please upload a FOLD file first.');
      return;
    }

    clearLeanStatus();

    try {
      const foldData = await svgToFold(el.svg);
      if (!foldData) {
        showError('Could not export pattern.');
        return;
      }

      // Get the title from the current document or use a default
      const title = doc.renderJson ? JSON.parse(doc.renderJson('cp')).title || 'pattern' : 'pattern';
      foldData.title = title;

      const savedToServer = await tryServerExport(foldData, title);
      if (savedToServer.ok) {
        lastExportFilename = savedToServer.filename || `${title.replace(/\s+/g, '_')}.fold`;
        showSuccess(`Saved to ./data/${savedToServer.filename || 'pattern.fold'}`);
        clearError();
        return;
      }

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
      showSuccess('File downloaded.');
    } catch (err) {
      showError(`Could not export pattern: ${err.message || err}`);
    }
  });
}

function setupLeanRun() {
  el.runLeanBtn.addEventListener('click', async () => {
    if (!doc) {
      showError('No pattern loaded. Please upload a FOLD file first.');
      return;
    }

    stopLeanPolling();
    clearSuccess();
    clearError();
    showLeanStatus('Saving FOLD to server...');
    el.runLeanBtn.disabled = true;

    try {
      const foldData = await svgToFold(el.svg);
      if (!foldData) {
        throw new Error('Could not export pattern.');
      }

      const title = doc.renderJson ? JSON.parse(doc.renderJson('cp')).title || 'pattern' : 'pattern';
      foldData.title = title;

      const savedToServer = await tryServerExport(foldData, title);
      if (!savedToServer.ok) {
        throw new Error('Server export failed. Is the Python server running?');
      }
      lastExportFilename = savedToServer.filename || `${title.replace(/\s+/g, '_')}.fold`;

      showLeanStatus('Starting Lean check...');
      const jobId = await startLeanJob(lastExportFilename);

      leanPollId = setInterval(async () => {
        try {
          const status = await pollLeanStatus(jobId);
          if (status.status === 'done') {
            stopLeanPolling();
            el.runLeanBtn.disabled = false;
            if (status.success) {
              showLeanStatus('Lean compile succeeded.');
              showSuccess('Lean check passed.');
            } else {
              showLeanStatus('Lean compile failed.');
              showError(status.error || 'Lean check failed.');
            }
            return;
          }

          if (status.step === 'convert') {
            showLeanStatus('Converting FOLD to Lean...');
          } else if (status.step === 'compile') {
            showLeanStatus('Compiling Lean...');
          } else {
            showLeanStatus('Queued...');
          }
        } catch (err) {
          stopLeanPolling();
          el.runLeanBtn.disabled = false;
          showError(`Lean status failed: ${err.message || err}`);
        }
      }, 1000);
    } catch (err) {
      el.runLeanBtn.disabled = false;
      showError(err.message || err);
      clearLeanStatus();
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
  setupLeanRun();
  render();
  console.log('About to setup edit mode');
  setupEditMode();
  setupThemeSelector();

  // Set up default file
  try {
    const response = await fetch('./square.fold');
    if (response.ok) {
      const blob = await response.blob();
      // We create a File object so it's compatible with your loadFile(file) helper
      const initialFile = new File([blob], "square.fold");
      await loadFile(initialFile);
    }
  } catch (err) {
    console.warn("Failed to preload default pattern:", err);
  }

  console.log('Setup complete');
}

main().catch(err => {
  console.error(err);
  showError(`Failed to start: ${err.message || err}`);
});
