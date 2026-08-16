// foldmesh.js — the crease pattern as an editable FOLD mesh, so stacked
// Huzita axioms become real creases the WASM FoldDocument can fold, instead
// of only living in the pick-geometry overlay.
//
// `FoldDocument` (Rust/WASM) is immutable once constructed from a FOLD JSON
// string — there is no API to add a crease afterward. So this module keeps
// its own indexed mesh (vertices / faces / per-edge M-V-B-F-U assignment)
// alongside `doc`, mutates *that* whenever an axiom is committed, and
// main.js re-constructs `doc` from `toFoldJson(mesh)`.
//
// Every stacked axiom fold is a straight line spanning the whole paper, so
// splitting a face by that line always yields two convex faces — the
// algorithm below relies on that invariant and does not handle arbitrary
// (non-convex, self-intersecting) polygons.

import { signedDistance } from './geometry.js';

const EPS = 1e-6;

function coordKey(x, y) {
  return `${x.toFixed(6)},${y.toFixed(6)}`;
}

function edgeKey(i, j) {
  return i < j ? `${i},${j}` : `${j},${i}`;
}

function findOrAddVertex(mesh, x, y) {
  const key = coordKey(x, y);
  const existing = mesh.coordIndex.get(key);
  if (existing !== undefined) return existing;
  const idx = mesh.vertices.length;
  mesh.vertices.push({ x, y });
  mesh.coordIndex.set(key, idx);
  return idx;
}

// Build the initial mesh from the Rust renderer's `renderJson('cp')` output
// (coordinate-based edges + faces) — this is whatever frame Rust considers
// the crease pattern, so we stay in sync with it regardless of file layout.
export function fromRenderData(data) {
  const mesh = { vertices: [], coordIndex: new Map(), faces: [], edgeKind: new Map() };

  for (const e of data.edges) {
    const i = findOrAddVertex(mesh, e.x1, e.y1);
    const j = findOrAddVertex(mesh, e.x2, e.y2);
    mesh.edgeKind.set(edgeKey(i, j), e.kind);
  }

  mesh.faces = data.faces.map(f => f.points.map(([x, y]) => findOrAddVertex(mesh, x, y)));

  return mesh;
}

// Split one convex face by an infinite line, walking its boundary once.
// Returns { faceA, faceB, crease: [vA, vB] } or null if the line doesn't
// cross the face's interior (misses it, or only grazes a single corner).
function splitFaceByLine(mesh, face, line, cutEdges) {
  const n = face.length;
  const d = face.map(vi => signedDistance(mesh.vertices[vi], line));

  const ring = [];
  const touched = [];

  for (let i = 0; i < n; i++) {
    ring.push(face[i]);
    if (Math.abs(d[i]) < EPS) touched.push(face[i]);

    const j = (i + 1) % n;
    if (Math.abs(d[i]) >= EPS && Math.abs(d[j]) >= EPS && (d[i] > 0) !== (d[j] > 0)) {
      const key = edgeKey(face[i], face[j]);
      let k = cutEdges.get(key);
      if (k === undefined) {
        const t = d[i] / (d[i] - d[j]);
        const p1 = mesh.vertices[face[i]], p2 = mesh.vertices[face[j]];
        k = findOrAddVertex(mesh, p1.x + t * (p2.x - p1.x), p1.y + t * (p2.y - p1.y));
        cutEdges.set(key, k);
      }
      ring.push(k);
      touched.push(k);
    }
  }

  const uniqueTouched = [...new Set(touched)];
  if (uniqueTouched.length !== 2) return null;

  const [vA, vB] = uniqueTouched;
  const i1 = ring.indexOf(vA);
  const i2 = ring.indexOf(vB);

  const arcA = [];
  for (let k = i1; ; k = (k + 1) % ring.length) {
    arcA.push(ring[k]);
    if (k === i2) break;
  }
  const arcB = [];
  for (let k = i2; ; k = (k + 1) % ring.length) {
    arcB.push(ring[k]);
    if (k === i1) break;
  }
  if (arcA.length < 3 || arcB.length < 3) return null;

  return { faceA: arcA, faceB: arcB, crease: [vA, vB] };
}

// Pure: returns a new mesh with `solution`'s fold line cut into it as a real
// crease, or the same `mesh` reference unchanged if the line doesn't cross
// any face (so callers can detect a no-op via `===`).
export function addCrease(mesh, solution, assignment) {
  const line = { a: solution.a, b: solution.b, c: solution.c };
  const next = {
    vertices: mesh.vertices.slice(),
    coordIndex: new Map(mesh.coordIndex),
    edgeKind: new Map(mesh.edgeKind),
    faces: mesh.faces,
  };

  const cutEdges = new Map(); // original edge key -> new vertex index
  const newFaces = [];
  const creaseSegments = [];
  for (const face of mesh.faces) {
    const result = splitFaceByLine(next, face, line, cutEdges);
    if (!result) { newFaces.push(face); continue; }
    newFaces.push(result.faceA, result.faceB);
    creaseSegments.push(result.crease);
  }

  if (creaseSegments.length === 0) return mesh;

  next.faces = newFaces;

  // Original edges that got a new vertex inserted mid-span need to be
  // split into two, preserving their assignment, so the physics solver's
  // per-triangle-edge lookup (keyed on vertex pairs) still matches.
  for (const [key, k] of cutEdges) {
    const [i, j] = key.split(',').map(Number);
    const kind = next.edgeKind.get(key) ?? 'U';
    next.edgeKind.delete(key);
    next.edgeKind.set(edgeKey(i, k), kind);
    next.edgeKind.set(edgeKey(k, j), kind);
  }

  for (const [vA, vB] of creaseSegments) {
    next.edgeKind.set(edgeKey(vA, vB), assignment);
  }

  return next;
}

export function toFoldJson(mesh, { title } = {}) {
  const edges_vertices = [];
  const edges_assignment = [];
  for (const [key, kind] of mesh.edgeKind) {
    const [i, j] = key.split(',').map(Number);
    edges_vertices.push([i, j]);
    edges_assignment.push(kind);
  }

  return {
    file_spec: 1.1,
    file_creator: 'Origami Huzita Panel',
    frame_classes: ['creasePattern'],
    frame_title: title,
    vertices_coords: mesh.vertices.map(v => [v.x, v.y]),
    edges_vertices,
    edges_assignment,
    faces_vertices: mesh.faces,
  };
}
