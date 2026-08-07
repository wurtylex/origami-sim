// geometry.js — pure math for the Huzita axiom construction engine.
//
// No DOM here. Lines are represented in normal form {a, b, c} with (a, b) a
// unit vector, satisfying a*x + b*y + c = 0. Points are {x, y}.
//
// Each axiomN(...) function computes the fold line(s) a real physical fold
// would produce for the given entities — this is what lets new points and
// lines become "available" after a fold is stacked (project description's
// open UX question: the paper accumulates real geometry as axioms stack).

const EPS = 1e-9;

export function makePoint(x, y) {
  return { x, y };
}

function normalize(a, b) {
  const len = Math.hypot(a, b);
  if (len < EPS) return null;
  return [a / len, b / len];
}

export function lineFromPoints(p1, p2) {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const n = normalize(-dy, dx);
  if (!n) return null;
  const [a, b] = n;
  const c = -(a * p1.x + b * p1.y);
  return { a, b, c };
}

export function perpBisector(p1, p2) {
  const n = normalize(p2.x - p1.x, p2.y - p1.y);
  if (!n) return null;
  const [a, b] = n;
  const mx = (p1.x + p2.x) / 2;
  const my = (p1.y + p2.y) / 2;
  const c = -(a * mx + b * my);
  return { a, b, c };
}

export function perpThrough(p, line) {
  // New line's normal = line's direction (rotate line's normal by 90deg).
  const a = -line.b;
  const b = line.a;
  const c = -(a * p.x + b * p.y);
  return { a, b, c };
}

export function reflectPoint(p, line) {
  const d = line.a * p.x + line.b * p.y + line.c;
  return { x: p.x - 2 * line.a * d, y: p.y - 2 * line.b * d };
}

export function signedDistance(p, line) {
  return line.a * p.x + line.b * p.y + line.c;
}

export function intersectLines(l1, l2) {
  const det = l1.a * l2.b - l2.a * l1.b;
  if (Math.abs(det) < EPS) return null; // parallel (or identical)
  const x = (l1.b * l2.c - l2.b * l1.c) / det;
  const y = (l2.a * l1.c - l1.a * l2.c) / det;
  return { x, y };
}

// Angle bisector(s) of two lines given in normal form. Returns 1 line for
// parallel inputs, 2 for intersecting ones (perpendicular to each other).
export function angleBisectors(l1, l2) {
  const results = [];
  const sumN = normalize(l1.a + l2.a, l1.b + l2.b);
  if (sumN) {
    const [a, b] = sumN;
    const norm = Math.hypot(l1.a + l2.a, l1.b + l2.b);
    results.push({ a, b, c: (l1.c + l2.c) / norm });
  }
  const diffN = normalize(l1.a - l2.a, l1.b - l2.b);
  if (diffN) {
    const [a, b] = diffN;
    const norm = Math.hypot(l1.a - l2.a, l1.b - l2.b);
    results.push({ a, b, c: (l1.c - l2.c) / norm });
  }
  return results;
}

function circleLineIntersect(center, radius, line) {
  const d = signedDistance(center, line);
  if (Math.abs(d) > radius + 1e-7) return [];
  const foot = { x: center.x - line.a * d, y: center.y - line.b * d };
  const half = Math.sqrt(Math.max(radius * radius - d * d, 0));
  if (half < 1e-7) return [foot];
  const dirx = -line.b;
  const diry = line.a;
  return [
    { x: foot.x + dirx * half, y: foot.y + diry * half },
    { x: foot.x - dirx * half, y: foot.y - diry * half },
  ];
}

function dedupeLines(lines) {
  const out = [];
  for (const l of lines) {
    if (!l) continue;
    const dup = out.some(o => Math.abs(o.a - l.a) < 1e-6 && Math.abs(o.b - l.b) < 1e-6 && Math.abs(o.c - l.c) < 1e-6);
    if (!dup) out.push(l);
  }
  return out;
}

// --- Huzita-Justin axioms: each returns an array of candidate fold lines ---

export function axiom1(p1, p2) {
  const l = lineFromPoints(p1, p2);
  return l ? [l] : [];
}

export function axiom2(p1, p2) {
  const l = perpBisector(p1, p2);
  return l ? [l] : [];
}

export function axiom3(l1, l2) {
  return dedupeLines(angleBisectors(l1, l2));
}

export function axiom4(p1, l1) {
  return [perpThrough(p1, l1)];
}

export function axiom5(p1, p2, l1) {
  const radius = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (radius < EPS) return [];
  const candidates = circleLineIntersect(p2, radius, l1);
  return dedupeLines(candidates.map(p1Prime => {
    if (Math.hypot(p1Prime.x - p1.x, p1Prime.y - p1.y) < 1e-7) return null;
    return perpBisector(p1, p1Prime);
  }));
}

export function axiom7(p, l1, l2) {
  const n = normalize(-l2.b, l2.a); // fold direction ⟂ l2 ⇒ fold normal ∥ l2's direction
  if (!n) return [];
  const [nx, ny] = n;
  const s = nx * p.x + ny * p.y;
  const D = l1.a * p.x + l1.b * p.y + l1.c;
  const k = l1.a * nx + l1.b * ny;
  if (Math.abs(k) < 1e-7) return []; // l1 parallel to the fold direction: no fold places p onto l1
  const c = D / (2 * k) - s;
  return [{ a: nx, b: ny, c }];
}

// Axiom 6 has no simple closed form (equivalent to a cubic — the classic
// "Beloch fold" used for angle trisection / cube doubling). We solve it
// numerically: for a fold with normal n(theta) = (cos theta, sin theta),
// the offset required to place p1 onto l1 is c1(theta), and separately the
// offset required to place p2 onto l2 is c2(theta). A valid simultaneous
// fold is a theta where c1(theta) = c2(theta).
//
// Both c1 and c2 have a pole (division by k = dot(line.normal, n)) at one
// theta each in [0, pi). Clearing denominators to search for f = c1 - c2 = 0
// across a pole finds that pole, not a root, so we compute the two pole
// locations analytically, sweep only the open sub-intervals between them,
// and — since clearing denominators can also introduce roots that solve the
// cleared equation but not the original one — verify every candidate by
// actually reflecting p1, p2 and checking they land on l1, l2.
export function axiom6(p1, p2, l1, l2) {
  const offsetFor = (p, line, theta) => {
    const nx = Math.cos(theta);
    const ny = Math.sin(theta);
    const s = nx * p.x + ny * p.y;
    const D = line.a * p.x + line.b * p.y + line.c;
    const k = line.a * nx + line.b * ny;
    if (Math.abs(k) < 1e-9) return null;
    return D / (2 * k) - s;
  };

  const f = (theta) => {
    const c1 = offsetFor(p1, l1, theta);
    const c2 = offsetFor(p2, l2, theta);
    if (c1 === null || c2 === null) return null;
    return c1 - c2;
  };

  // Pole of k(theta) = line.a*cos(theta) + line.b*sin(theta): zero where
  // theta = atan2(line.b, line.a) + pi/2 (mod pi).
  const poleOf = (line) => {
    let theta = Math.atan2(line.b, line.a) + Math.PI / 2;
    theta = ((theta % Math.PI) + Math.PI) % Math.PI;
    return theta;
  };

  const margin = 1e-4;
  const boundaries = [0, poleOf(l1), poleOf(l2), Math.PI]
    .sort((a, b) => a - b);

  const roots = [];
  const N_PER_INTERVAL = 1500;
  for (let seg = 0; seg < boundaries.length - 1; seg++) {
    const lo0 = boundaries[seg] + margin;
    const hi0 = boundaries[seg + 1] - margin;
    if (hi0 <= lo0) continue;

    let prevTheta = lo0;
    let prevVal = f(prevTheta);
    for (let i = 1; i <= N_PER_INTERVAL; i++) {
      const theta = lo0 + ((hi0 - lo0) * i) / N_PER_INTERVAL;
      const val = f(theta);
      if (prevVal !== null && val !== null) {
        if (prevVal === 0) {
          roots.push(prevTheta);
        } else if ((prevVal > 0) !== (val > 0)) {
          let lo = prevTheta, hi = theta, flo = prevVal;
          for (let iter = 0; iter < 60; iter++) {
            const mid = (lo + hi) / 2;
            const fm = f(mid);
            if (fm === null) break;
            if ((fm > 0) === (flo > 0)) { lo = mid; flo = fm; } else { hi = mid; }
          }
          roots.push((lo + hi) / 2);
        }
      }
      prevTheta = theta;
      prevVal = val;
    }
  }

  const candidates = roots.map(theta => {
    const nx = Math.cos(theta);
    const ny = Math.sin(theta);
    const c = offsetFor(p1, l1, theta);
    if (c === null) return null;
    return { a: nx, b: ny, c };
  });

  // Clearing denominators to find sign changes can introduce spurious
  // solutions near the poles we excluded; only accept candidates that
  // actually reflect p1 onto l1 and p2 onto l2.
  const valid = candidates.filter(line => {
    if (!line) return false;
    const r1 = reflectPoint(p1, line);
    const r2 = reflectPoint(p2, line);
    return Math.abs(signedDistance(r1, l1)) < 1e-4 && Math.abs(signedDistance(r2, l2)) < 1e-4;
  });

  return dedupeLines(valid);
}

// Clip an infinite line to an axis-aligned box, for rendering/picking a
// finite crease segment. Returns {x1,y1,x2,y2} or null if it misses the box.
export function clipLineToBox(line, bounds) {
  const [minX, minY, maxX, maxY] = bounds;
  const pts = [];
  const tryAdd = (x, y) => {
    if (x >= minX - 1e-6 && x <= maxX + 1e-6 && y >= minY - 1e-6 && y <= maxY + 1e-6) {
      pts.push({ x, y });
    }
  };
  // Intersect with the 4 box edges (each a line), using generic line-line intersection.
  const edges = [
    { a: 0, b: 1, c: -minY }, // y = minY
    { a: 0, b: 1, c: -maxY }, // y = maxY
    { a: 1, b: 0, c: -minX }, // x = minX
    { a: 1, b: 0, c: -maxX }, // x = maxX
  ];
  for (const edge of edges) {
    const p = intersectLines(line, edge);
    if (p) tryAdd(p.x, p.y);
  }
  // Dedupe near-identical points (corners get hit twice).
  const uniq = [];
  for (const p of pts) {
    if (!uniq.some(u => Math.hypot(u.x - p.x, u.y - p.y) < 1e-6)) uniq.push(p);
  }
  if (uniq.length < 2) return null;
  // Keep the two most distant points (line might clip a box at >2 candidate hits due to corners).
  let best = null, bestD = -1;
  for (let i = 0; i < uniq.length; i++) {
    for (let j = i + 1; j < uniq.length; j++) {
      const d = Math.hypot(uniq[i].x - uniq[j].x, uniq[i].y - uniq[j].y);
      if (d > bestD) { bestD = d; best = [uniq[i], uniq[j]]; }
    }
  }
  if (!best || bestD < 1e-6) return null;
  return { x1: best[0].x, y1: best[0].y, x2: best[1].x, y2: best[1].y };
}

export function pointOnSegment(p, seg, eps = 1e-6) {
  const { x1, y1, x2, y2 } = seg;
  const cross = (p.x - x1) * (y2 - y1) - (p.y - y1) * (x2 - x1);
  if (Math.abs(cross) > eps * Math.max(1, Math.hypot(x2 - x1, y2 - y1))) return false;
  const dot = (p.x - x1) * (x2 - x1) + (p.y - y1) * (y2 - y1);
  const lenSq = (x2 - x1) ** 2 + (y2 - y1) ** 2;
  return dot >= -eps * lenSq && dot <= lenSq * (1 + eps);
}

export function pointsEqual(p1, p2, eps = 1e-6) {
  return Math.hypot(p1.x - p2.x, p1.y - p2.y) < eps;
}
