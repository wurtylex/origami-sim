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

// Drawing mode state
let drawingMode = false;
let isDrawing = false;
let startPos = null;
let currentLine = null;
let selectedCreaseType = 'U';

export function setSelectedCreaseType(type) {
  selectedCreaseType = type;
}

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
    // Store the edge assignment so it survives SVG serialization
    line.setAttribute('data-type', edge.kind);
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

export async function svgToFold(svg) {
  // 1. Locate the 'world' group where the lines and dots live
  const world = svg.querySelector('g');
  if (!world) return null;

  const vertices = [];
  const edges = [];
  const edgeAssignment = [];

  // Helper to find or add a vertex and return its index
  const getVertexIndex = (x, y) => {
    // Rounding helps avoid floating point precision issues from SVG transforms
    const precision = 6;
    const rx = parseFloat(x.toFixed(precision));
    const ry = parseFloat(y.toFixed(precision));

    let index = vertices.findIndex(v => v[0] === rx && v[1] === ry);
    if (index === -1) {
      vertices.push([rx, ry]);
      index = vertices.length - 1;
    }
    return index;
  };

  // 2. Iterate through lines to build the edge graph
  // We ignore polygons and circles as they are redundant for the core graph
  const lines = world.querySelectorAll('line');

  lines.forEach(line => {
    const x1 = parseFloat(line.getAttribute('x1'));
    const y1 = parseFloat(line.getAttribute('y1'));
    const x2 = parseFloat(line.getAttribute('x2'));
    const y2 = parseFloat(line.getAttribute('y2'));
    const stroke = line.getAttribute('stroke');

    const v1 = getVertexIndex(x1, y1);
    const v2 = getVertexIndex(x2, y2);

    edges.push([v1, v2]);

    // Get assignment from data-type attribute if present, otherwise reverse-map from color
    let assignment = line.getAttribute('data-type');
    if (!assignment) {
      // Fall back to reverse-mapping the stroke color for compatibility
      assignment = 'U'; // Default Unassigned
      for (const [key, style] of Object.entries(EDGE_STYLE)) {
        if (style.stroke === stroke) {
          assignment = key;
          break;
        }
      }
    }
    edgeAssignment.push(assignment);
  });

  // 3. Compute edges_foldAngle based on assignment
  const foldAngles = edgeAssignment.map(assignment => {
    switch (assignment) {
      case 'M': return 180;
      case 'V': return -180;
      case 'B': return 0;
      case 'F': return 0;
      case 'U': return 180;
      default: return 0;
    }
  });

  // 4. Try to compute faces using Rabbit Ear
  let earGraph = null;
  try {
    const mod = await import('rabbit-ear');
    const ear = mod.default ?? mod;
    console.log('Rabbit Ear loaded, keys:', Object.keys(ear).slice(0, 10));

    let converter = null;
    if (typeof ear.convert?.svgToFold === 'function') {
      converter = ear.convert.svgToFold;
      console.log('Using ear.convert.svgToFold');
    } else if (typeof ear.svgToFold === 'function') {
      converter = ear.svgToFold;
      console.log('Using ear.svgToFold');
    }

    if (converter) {
      const serializer = new XMLSerializer();
      const svgText = serializer.serializeToString(svg);
      console.log('SVG text length:', svgText.length);

      earGraph = converter(svgText);
      console.log('Rabbit Ear graph keys:', Object.keys(earGraph || {}).slice(0, 15));
      if (earGraph && earGraph.vertices_coords) {
        console.log('Rabbit Ear vertices:', earGraph.vertices_coords.length, 'edges:', earGraph.edges_vertices?.length);
      }
    }
  } catch (err) {
    console.error('Could not compute faces with Rabbit Ear:', err.message);
  }

  // 5. Construct the FOLD object
  // Use Rabbit Ear's graph if available (it has proper face topology),
  // but overlay our custom edge assignments
  let fold;

  // 5. Build a map of our assignments keyed by coordinate pairs for robust matching
  // This ensures assignments are preserved even when Rabbit Ear re-parses the SVG
  const ourAssignmentMap = new Map();
  lines.forEach((line, idx) => {
    const x1 = parseFloat(line.getAttribute('x1'));
    const y1 = parseFloat(line.getAttribute('y1'));
    const x2 = parseFloat(line.getAttribute('x2'));
    const y2 = parseFloat(line.getAttribute('y2'));

    // Use our stored data-type if available, otherwise use the computed assignment
    let assignment = line.getAttribute('data-type') || edgeAssignment[idx] || 'U';

    // Create a canonical key (always with smaller coordinate first for consistent lookup)
    const key = `${Math.min(x1, x2).toFixed(6)},${Math.min(y1, y2).toFixed(6)}-${Math.max(x1, x2).toFixed(6)},${Math.max(y1, y2).toFixed(6)}`;
    ourAssignmentMap.set(key, assignment);
    console.log(`Stored assignment for edge: ${key} = ${assignment}`);
  });

  if (earGraph && earGraph.vertices_coords && earGraph.edges_vertices) {
    console.log('Using Rabbit Ear graph as base');
    // Create assignment mapping: overlay our custom assignments onto Rabbit Ear's edges
    const earAssignment = (earGraph.edges_assignment || []).slice(); // copy

    // For each Rabbit Ear edge, try to find our custom assignment
    earGraph.edges_vertices.forEach((edge, eIdx) => {
      const [ev1, ev2] = edge;
      const [ex1, ey1] = earGraph.vertices_coords[ev1];
      const [ex2, ey2] = earGraph.vertices_coords[ev2];

      // Create a canonical key matching how we stored them
      const key = `${Math.min(ex1, ex2).toFixed(6)},${Math.min(ey1, ey2).toFixed(6)}-${Math.max(ex1, ex2).toFixed(6)},${Math.max(ey1, ey2).toFixed(6)}`;

      if (ourAssignmentMap.has(key)) {
        const assignment = ourAssignmentMap.get(key);
        earAssignment[eIdx] = assignment;
        console.log(`Applied custom assignment to Rabbit Ear edge ${eIdx}: ${assignment}`);
      }
    });

    fold = {
      file_spec: 1.1,
      file_creator: "Crease Pattern Inspector",
      file_classes: ["singleModel"],
      frame_classes: ["creasePattern"],
      vertices_coords: earGraph.vertices_coords,
      edges_vertices: earGraph.edges_vertices,
      edges_assignment: earAssignment,
      edges_foldAngle: earGraph.edges_foldAngle || earAssignment.map(a => {
        switch (a) {
          case 'M': return 180;
          case 'V': return -180;
          default: return 0;
        }
      }),
    };

    if (earGraph.vertices_edges) fold.vertices_edges = earGraph.vertices_edges;
    if (earGraph.faces_vertices) fold.faces_vertices = earGraph.faces_vertices;
    if (earGraph.faces_edges) fold.faces_edges = earGraph.faces_edges;

  } else {
    // 6. Fallback: construct FOLD without face topology
    console.log('Rabbit Ear unavailable, using local computation (no faces)');
    // Compute vertices_edges locally
    const verticesEdges = vertices.map(() => []);
    edges.forEach((edge, idx) => {
      const [v1, v2] = edge;
      verticesEdges[v1].push(idx);
      verticesEdges[v2].push(idx);
    });

    fold = {
      file_spec: 1.1,
      file_creator: "Crease Pattern Inspector",
      file_classes: ["singleModel"],
      frame_classes: ["creasePattern"],
      vertices_coords: vertices,
      edges_vertices: edges,
      edges_assignment: edgeAssignment,
      edges_foldAngle: foldAngles,
      vertices_edges: verticesEdges,
    };
  }

  // 7. Done
  console.log('Final FOLD keys:', Object.keys(fold));
  return fold;
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

export function enableDrawingMode(svg, creaseType = 'U') {
  selectedCreaseType = creaseType;
  drawingMode = true;
  svg.style.cursor = 'crosshair';

  const s = state.get(svg);
  const strokeScale = s?.strokeScale || 1;

  const handleDrawStart = (e) => {
    if (drawingMode && e.isPrimary) {
      const pos = screenToSvg(svg, e.clientX, e.clientY);
      if (pos) {
        isDrawing = true;
        startPos = pos;
        const worldPos = svgToWorld(pos.x, pos.y);

        // Create a preview line element
        const world = svg.querySelector('g');
        if (world) {
          currentLine = document.createElementNS(SVG_NS, 'line');
          currentLine.setAttribute('x1', worldPos.x);
          currentLine.setAttribute('y1', worldPos.y);
          currentLine.setAttribute('x2', worldPos.x);
          currentLine.setAttribute('y2', worldPos.y);
          currentLine.setAttribute('stroke', '#FFD700');
          currentLine.setAttribute('stroke-width', 2 * strokeScale);
          currentLine.setAttribute('stroke-linecap', 'round');
          currentLine.setAttribute('class', 'preview-line');
          world.appendChild(currentLine);
        }
      }
      e.stopPropagation();
    }
  };

  const handleDrawMove = (e) => {
    if (isDrawing && currentLine && startPos) {
      const pos = screenToSvg(svg, e.clientX, e.clientY);
      if (pos) {
        const worldPos = svgToWorld(pos.x, pos.y);
        currentLine.setAttribute('x2', worldPos.x);
        currentLine.setAttribute('y2', worldPos.y);
      }
      e.stopPropagation();
    }
  };

  const handleDrawEnd = (e) => {
    if (isDrawing && currentLine) {
      // Line is finalized, apply the selected crease type style
      const style = EDGE_STYLE[selectedCreaseType] || EDGE_STYLE.U;
      currentLine.setAttribute('stroke', style.stroke);
      currentLine.setAttribute('stroke-width', style.width * strokeScale);
      if (style.dash) {
        const scaled = style.dash.split(',').map(n => parseFloat(n) * strokeScale).join(',');
        currentLine.setAttribute('stroke-dasharray', scaled);
      } else {
        currentLine.removeAttribute('stroke-dasharray');
      }
      currentLine.removeAttribute('class');
      currentLine.setAttribute('data-type', selectedCreaseType);

      isDrawing = false;
      startPos = null;
      currentLine = null;
    }
    e.stopPropagation();
  };

  svg.addEventListener('pointerdown', handleDrawStart, true);
  svg.addEventListener('pointermove', handleDrawMove, true);
  svg.addEventListener('pointerup', handleDrawEnd, true);

  svg._drawingHandlers = { handleDrawStart, handleDrawMove, handleDrawEnd };
}

export function disableDrawingMode(svg) {
  drawingMode = false;
  svg.style.cursor = 'default';
  isDrawing = false;
  currentLine = null;
  startPos = null;

  if (svg._drawingHandlers) {
    const { handleDrawStart, handleDrawMove, handleDrawEnd } = svg._drawingHandlers;
    svg.removeEventListener('pointerdown', handleDrawStart, true);
    svg.removeEventListener('pointermove', handleDrawMove, true);
    svg.removeEventListener('pointerup', handleDrawEnd, true);
    delete svg._drawingHandlers;
  }
}

export function attachPanZoom2d(svg) {
  let dragging = false;
  let last = { x: 0, y: 0 };

  const handlePointerDown = (e) => {
    if (drawingMode) return;
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
    if (drawingMode) return;
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
