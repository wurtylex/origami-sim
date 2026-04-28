// render2d.js — SVG renderer for the crease pattern.
//
// Pure function of FoldDocument + an SVG element. Exposes:
//   render2d(doc, mode, svgEl) → render data (so the caller can update stats)
//   resetView2d(svgEl)         → reset pan/zoom
//   attachPanZoom2d(svgEl)     → install pan/zoom handlers (call once)

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
  state.set(svg, { baseViewBox, viewBox });
  applyViewBox(svg, viewBox);

  svg.replaceChildren();
  const world = document.createElementNS(SVG_NS, 'g');
  world.setAttribute('transform', 'scale(1, -1)');
  svg.appendChild(world);

  const strokeScale = Math.max(w, h) / 400;

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
    world.appendChild(line);
  }

  const vertexSet = new Set();
  for (const edge of data.edges) {
    vertexSet.add(`${edge.x1},${edge.y1}`);
    vertexSet.add(`${edge.x2},${edge.y2}`);
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

export function attachPanZoom2d(svg) {
  let dragging = false;
  let last = { x: 0, y: 0 };

  svg.addEventListener('pointerdown', e => {
    dragging = true;
    last = { x: e.clientX, y: e.clientY };
    svg.setPointerCapture(e.pointerId);
  });

  svg.addEventListener('pointerup', e => {
    dragging = false;
    svg.releasePointerCapture(e.pointerId);
  });

  svg.addEventListener('pointermove', e => {
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
  });

  svg.addEventListener('wheel', e => {
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
  }, { passive: false });
}

function applyViewBox(svg, vb) {
  svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
}
