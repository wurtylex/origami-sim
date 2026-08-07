// render2d.js — SVG renderer for the crease pattern.
//
// Pure function of FoldDocument + an SVG element. Exposes:
//   render2d(doc, mode, svgEl) → render data (so the caller can update stats)
//   resetView2d(svgEl)         → reset pan/zoom
//   attachPanZoom2d(svgEl)     → install pan/zoom handlers (call once)
//
// Also exposes entity picking + marker overlay helpers used by the Huzita
// axiom panel to let the user select points/lines directly on the pattern.
// There is no in-app crease drawing or FOLD export here — this module only
// renders a loaded FOLD document and lets the Huzita panel read points off it.

const EDGE_STYLE = {
  M: { stroke: '#B8352C', width: 1.4, dash: null },
  V: { stroke: '#2C4B8C', width: 1.4, dash: '4,3' },
  B: { stroke: '#18140F', width: 1.8, dash: null },
  F: { stroke: '#C4BDB0', width: 0.6, dash: null },
  U: { stroke: '#8A8075', width: 1.0, dash: '2,2' },
};

const DRAW_ORDER = ['F', 'U', 'V', 'M', 'B'];
const SVG_NS = 'http://www.w3.org/2000/svg';

// Per-SVG state — tied to the element so multiple SVGs could coexist.
const state = new WeakMap();

export function render2d(doc, mode, svg) {
  const data = JSON.parse(doc.renderJson(mode));
  const [minX, minY, maxX, maxY] = data.bounds;
  const w = Math.max(maxX - minX, 1e-9);
  const h = Math.max(maxY - minY, 1e-9);
  const margin = Math.max(w, h) * 0.08;

  const baseViewBox = {
    x: minX - margin,
    y: -(maxY + margin),  // y-flipped because origami is y-up
    w: w + margin * 2,
    h: h + margin * 2,
  };
  const viewBox = { ...baseViewBox };
  const strokeScale = Math.max(w, h) / 400;
  state.set(svg, { baseViewBox, viewBox, strokeScale });
  applyViewBox(svg, viewBox);

  svg.replaceChildren();
  const world = document.createElementNS(SVG_NS, 'g');
  world.setAttribute('transform', 'scale(1, -1)');
  svg.appendChild(world);

  for (const face of data.faces) {
    const poly = document.createElementNS(SVG_NS, 'polygon');
    poly.setAttribute('points', face.points.map(p => `${p[0]},${p[1]}`).join(' '));
    poly.setAttribute('fill', 'rgba(0, 0, 0, 0.025)');
    world.appendChild(poly);
  }

  const sorted = [...data.edges].sort((a, b) => {
    return DRAW_ORDER.indexOf(a.kind) - DRAW_ORDER.indexOf(b.kind);
  });

  for (const edge of sorted) {
    const style = EDGE_STYLE[edge.kind] || EDGE_STYLE.U;
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', edge.x1);
    line.setAttribute('y1', edge.y1);
    line.setAttribute('x2', edge.x2);
    line.setAttribute('y2', edge.y2);
    line.setAttribute('stroke', style.stroke);
    line.setAttribute('stroke-width', style.width * strokeScale);
    line.setAttribute('stroke-linecap', 'round');
    if (style.dash) {
      const scaled = style.dash.split(',').map(n => parseFloat(n) * strokeScale).join(',');
      line.setAttribute('stroke-dasharray', scaled);
    }
    line.setAttribute('data-type', edge.kind);
    world.appendChild(line);
  }

  const vertexSet = new Set();
  for (const edge of data.edges) {
    vertexSet.add(`${edge.x1},${edge.y1}`);
    vertexSet.add(`${edge.x2},${edge.y2}`);
  }
  if (Array.isArray(data.vertices_coords)) {
    for (const v of data.vertices_coords) {
      if (Array.isArray(v) && v.length >= 2) {
        vertexSet.add(`${v[0]},${v[1]}`);
      }
    }
  }
  const dotRadius = 0.6 * strokeScale;
  for (const key of vertexSet) {
    const [x, y] = key.split(',').map(Number);
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('cx', x);
    dot.setAttribute('cy', y);
    dot.setAttribute('r', dotRadius);
    dot.setAttribute('fill', '#18140F');
    world.appendChild(dot);
  }

  return data;
}

export function resetView2d(svg) {
  const s = state.get(svg);
  if (!s) return;
  s.viewBox = { ...s.baseViewBox };
  applyViewBox(svg, s.viewBox);
}

// Convert screen coordinates to SVG viewBox coordinates
function screenToSvg(svg, clientX, clientY) {
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;

  if (typeof DOMPoint !== 'undefined') {
    const pt = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: pt.x, y: pt.y };
  }

  const rect = svg.getBoundingClientRect();
  const s = state.get(svg);
  if (!s) return null;

  const sx = (clientX - rect.left) / rect.width;
  const sy = (clientY - rect.top) / rect.height;

  const x = s.viewBox.x + sx * s.viewBox.w;
  const y = s.viewBox.y + sy * s.viewBox.h;

  return { x, y };
}

// Convert SVG viewBox coordinates to world coordinates (accounting for y-flip and scale)
function svgToWorld(x, y) {
  // The world group has 'scale(1, -1)' transform, so flip y-coordinate
  return { x, y: -y };
}

// -----------------------------------------------------------------------------
// Entity picking (points / lines) — used by the Huzita axiom panel to let the
// user select the geometric entities each axiom call needs, directly on the
// crease pattern.
// -----------------------------------------------------------------------------

let entityPickMode = false;

export function isEntityPickMode() {
  return entityPickMode;
}

export function screenToWorld(svg, clientX, clientY) {
  const pos = screenToSvg(svg, clientX, clientY);
  if (!pos) return null;
  return svgToWorld(pos.x, pos.y);
}

function dist(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

function pointToSegmentDistance(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const abLen2 = abx * abx + aby * aby;
  if (abLen2 === 0) return dist(px, py, ax, ay);
  let t = ((px - ax) * abx + (py - ay) * aby) / abLen2;
  t = Math.max(0, Math.min(1, t));
  return dist(px, py, ax + t * abx, ay + t * aby);
}

function pickTolerance(svg, multiplier = 14) {
  const s = state.get(svg);
  const strokeScale = s?.strokeScale || 1;
  return strokeScale * multiplier;
}

// Only geometry the construction has actually made available can be picked —
// there is no "click anywhere" fallback. `candidates` is a flat array of
// point entities ({x,y,...}) or line entities ({x1,y1,x2,y2,...}); which one
// a given item is is inferred from its shape, so points and lines can be
// mixed in principle, though callers pass one kind at a time.
export function findNearestCandidate(candidates, worldX, worldY, tolerance) {
  let best = null;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = 'x1' in c
      ? pointToSegmentDistance(worldX, worldY, c.x1, c.y1, c.x2, c.y2)
      : dist(worldX, worldY, c.x, c.y);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best && bestD <= tolerance ? best : null;
}

// onPick(entity) fires with the exact candidate object that was hit.
// onMiss() fires when the click doesn't land near any candidate.
export function enableEntityPickMode(svg, candidates, onPick, onMiss, toleranceMultiplier = 14) {
  disableEntityPickMode(svg);
  entityPickMode = true;
  svg.style.cursor = 'crosshair';

  const handler = (e) => {
    if (!e.isPrimary) return;
    const world = screenToWorld(svg, e.clientX, e.clientY);
    if (!world) return;

    e.preventDefault();
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    e.stopPropagation();

    const tol = pickTolerance(svg, toleranceMultiplier);
    const hit = findNearestCandidate(candidates, world.x, world.y, tol);
    if (!hit) {
      if (onMiss) onMiss();
      return;
    }
    onPick(hit);
  };

  svg.addEventListener('pointerdown', handler, true);
  svg._pickHandler = handler;
}

export function disableEntityPickMode(svg) {
  entityPickMode = false;
  svg.style.cursor = 'default';
  if (svg._pickHandler) {
    svg.removeEventListener('pointerdown', svg._pickHandler, true);
    delete svg._pickHandler;
  }
}

// -----------------------------------------------------------------------------
// Axiom entity markers — a persistent overlay showing:
//  - the points/lines the construction has made available to pick from
//  - the ones selected for the axiom currently being built
//  - candidate fold solutions awaiting disambiguation (axioms with >1 fold)
// Redrawn after every render() call and every geometry update.
// marker.variant: 'available' | 'selected' | 'candidate'
// marker.coordKey: opaque string used to pulse-highlight from the stack list
// -----------------------------------------------------------------------------

// Dash patterns in the same world-relative units as EDGE_STYLE's dashes
// above — scaled by strokeScale before being applied, never used raw.
const MARKER_DASH = {
  available: [2, 2.4],
  'available-dim': [2, 2.4],
  'available-active': [2.6, 1.6],
  candidate: [4, 2.5],
};

// Point radius / line width per variant, in world-relative units (scaled by
// strokeScale below). 'selected' and 'candidate' are drawn noticeably larger
// than the resting 'available' pool so the current pick stays legible
// against the paper background. Points are sized well above line width so
// they stay easy to click/see without the lines getting comically thick.
const POINT_SIZE = {
  available: 3.4,
  'available-dim': 3.4,
  'available-active': 4.2,
  selected: 5.2,
  candidate: 5.2,
};

const LINE_SIZE = {
  available: 1.8,
  'available-dim': 1.8,
  'available-active': 2.2,
  selected: 2.8,
  candidate: 2.8,
};

export function drawAxiomMarkers(svg, markers) {
  clearAxiomMarkers(svg);
  const world = svg.querySelector('g');
  if (!world) return;
  const s = state.get(svg);
  const strokeScale = s?.strokeScale || 1;

  const layer = document.createElementNS(SVG_NS, 'g');
  layer.setAttribute('class', 'axiom-marker-layer');
  world.appendChild(layer);

  for (const marker of markers) {
    const variant = marker.variant || 'available';
    const cls = `axiom-marker axiom-marker-${marker.kind} ${variant}`;

    if (marker.kind === 'point') {
      const size = (POINT_SIZE[variant] ?? 3.4) * strokeScale;
      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('cx', marker.x);
      dot.setAttribute('cy', marker.y);
      dot.setAttribute('r', size);
      dot.setAttribute('class', cls);
      if (marker.id) dot.setAttribute('data-entity-id', marker.id);
      if (marker.coordKey) dot.setAttribute('data-coord-key', marker.coordKey);
      layer.appendChild(dot);

      if (marker.label) {
        layer.appendChild(makeMarkerLabel(marker.label, marker.x + 3 * strokeScale, marker.y, strokeScale));
      }
    } else {
      const size = (LINE_SIZE[variant] ?? 1.8) * strokeScale;
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', marker.x1);
      line.setAttribute('y1', marker.y1);
      line.setAttribute('x2', marker.x2);
      line.setAttribute('y2', marker.y2);
      line.setAttribute('stroke-width', size);
      // Dash patterns must scale with strokeScale like everything else here —
      // a CSS-declared dasharray is in absolute user-space units, which for a
      // small paper (e.g. a 1x1 square) makes a single dash longer than the
      // whole line, so it visually stops partway instead of looking dashed.
      const dash = MARKER_DASH[variant];
      line.setAttribute('stroke-dasharray', dash ? dash.map(n => n * strokeScale).join(',') : 'none');
      line.setAttribute('class', cls);
      if (marker.id) line.setAttribute('data-entity-id', marker.id);
      if (marker.coordKey) line.setAttribute('data-coord-key', marker.coordKey);
      layer.appendChild(line);

      if (marker.label) {
        const midX = (marker.x1 + marker.x2) / 2;
        const midY = (marker.y1 + marker.y2) / 2;
        layer.appendChild(makeMarkerLabel(marker.label, midX, midY, strokeScale));
      }
    }
  }
}

function makeMarkerLabel(text, x, y, strokeScale) {
  const label = document.createElementNS(SVG_NS, 'text');
  label.setAttribute('class', 'axiom-marker-label');
  label.setAttribute('transform', `translate(${x}, ${y}) scale(1, -1)`);
  label.setAttribute('font-size', 3.2 * strokeScale);
  label.textContent = text;
  return label;
}

export function clearAxiomMarkers(svg) {
  const world = svg.querySelector('g');
  if (!world) return;
  world.querySelectorAll('.axiom-marker-layer').forEach(n => n.remove());
}

export function attachPanZoom2d(svg) {
  let dragging = false;
  let last = { x: 0, y: 0 };

  const handlePointerDown = (e) => {
    if (entityPickMode) return;
    dragging = true;
    last = { x: e.clientX, y: e.clientY };
    svg.setPointerCapture(e.pointerId);
  };

  const handlePointerUp = (e) => {
    dragging = false;
    svg.releasePointerCapture(e.pointerId);
  };

  const handlePointerMove = (e) => {
    if (!dragging) return;
    const s = state.get(svg);
    if (!s) return;
    const rect = svg.getBoundingClientRect();
    const dx = (e.clientX - last.x) / rect.width  * s.viewBox.w;
    const dy = (e.clientY - last.y) / rect.height * s.viewBox.h;
    s.viewBox.x -= dx;
    s.viewBox.y -= dy;
    applyViewBox(svg, s.viewBox);
    last = { x: e.clientX, y: e.clientY };
  };

  const handleWheel = (e) => {
    if (entityPickMode) return;
    const s = state.get(svg);
    if (!s) return;
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top)  / rect.height;
    const factor = Math.pow(1.0015, e.deltaY);
    const newW = s.viewBox.w * factor;
    const newH = s.viewBox.h * factor;
    s.viewBox.x += (s.viewBox.w - newW) * px;
    s.viewBox.y += (s.viewBox.h - newH) * py;
    s.viewBox.w = newW;
    s.viewBox.h = newH;
    applyViewBox(svg, s.viewBox);
  };

  svg.addEventListener('pointerdown', handlePointerDown);
  svg.addEventListener('pointerup', handlePointerUp);
  svg.addEventListener('pointermove', handlePointerMove);
  svg.addEventListener('wheel', handleWheel, { passive: false });

  // Store handlers for potential cleanup
  svg._panZoomHandlers = { handlePointerDown, handlePointerUp, handlePointerMove, handleWheel };
}

function applyViewBox(svg, vb) {
  svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
}
