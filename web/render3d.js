// render3d.js — Three.js renderer for the rigid-folded 3D form.
//
// Exposes:
//   create3dRenderer(canvasEl) → { update(doc, t), dispose() }
//
// We import Three and OrbitControls from a CDN as ES modules so there's no
// build step. If you want a fully offline build, vendor them under web/vendor/.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const PAPER_FRONT = 0xF7F1E3;
const PAPER_BACK  = 0xE2D9C2;
const EDGE_COLOR = {
  M: 0xB8352C,
  V: 0x2C4B8C,
  B: 0x18140F,
  F: 0xC4BDB0,
  U: 0x8A8075,
};

export function create3dRenderer(canvas) {
  const scene = new THREE.Scene();
  scene.background = null; // transparent so the page background shows through

  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  camera.position.set(1.6, 1.2, 1.6);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);

  // Soft warm lighting that flatters paper. Two directional lights from
  // opposite sides so both faces of the paper are lit.
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 0.7);
  key.position.set(2, 3, 2);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xfff1d6, 0.35);
  fill.position.set(-2, -1, -2);
  scene.add(fill);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  // We rebuild the mesh from scratch on each update — origami geometry is
  // small (hundreds of vertices, not thousands) so this is fine and avoids
  // the bookkeeping of incremental updates.
  //
  // Two nested groups so centering and scaling don't interact:
  //   scaleGroup (scale only) → centerGroup (position only) → meshes
  let scaleGroup = new THREE.Group();
  let centerGroup = new THREE.Group();
  scaleGroup.add(centerGroup);
  scene.add(scaleGroup);

  function clearPaper() {
    centerGroup.traverse(obj => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
        else obj.material.dispose();
      }
    });
    scene.remove(scaleGroup);
    scaleGroup = new THREE.Group();
    centerGroup = new THREE.Group();
    scaleGroup.add(centerGroup);
    scene.add(scaleGroup);
  }

  function update(doc, t) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      renderer.setSize(rect.width, rect.height, false);
      camera.aspect = rect.width / rect.height;
      camera.updateProjectionMatrix();
    }
    const data = JSON.parse(doc.foldedGeometry(t));
    clearPaper();

    // ---- Paper mesh: faces with two-sided shading -----------------------
    const positions = new Float32Array(data.vertices.length * 3);
    for (let i = 0; i < data.vertices.length; i++) {
      positions[i * 3]     = data.vertices[i][0];
      positions[i * 3 + 1] = data.vertices[i][1];
      positions[i * 3 + 2] = data.vertices[i][2];
    }
    const indices = new Uint32Array(data.triangles);

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setIndex(new THREE.BufferAttribute(indices, 1));
    geom.computeVertexNormals();

    // Front face (default winding)
    const frontMat = new THREE.MeshLambertMaterial({
      color: PAPER_FRONT,
      side: THREE.FrontSide,
      flatShading: true,
    });
    centerGroup.add(new THREE.Mesh(geom, frontMat));

    // Back face — slightly darker so you can read which side is which
    const backMat = new THREE.MeshLambertMaterial({
      color: PAPER_BACK,
      side: THREE.BackSide,
      flatShading: true,
    });
    centerGroup.add(new THREE.Mesh(geom, backMat));

    // ---- Crease + boundary lines as an overlay --------------------------
    // Group edges by kind so we can use one LineSegments per color.
    const byKind = {};
    for (let i = 0; i < data.edges.length; i++) {
      const [a, b] = data.edges[i];
      const kind = data.edge_kinds[i];
      if (!byKind[kind]) byKind[kind] = [];
      const va = data.vertices[a];
      const vb = data.vertices[b];
      byKind[kind].push(va[0], va[1], va[2], vb[0], vb[1], vb[2]);
    }

    for (const [kind, coords] of Object.entries(byKind)) {
      const lineGeom = new THREE.BufferGeometry();
      lineGeom.setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array(coords), 3)
      );
      const lineMat = new THREE.LineBasicMaterial({
        color: EDGE_COLOR[kind] ?? EDGE_COLOR.U,
        // M and V get a slight bump to read clearly against the paper
        linewidth: kind === 'M' || kind === 'V' ? 2 : 1,
      });
      centerGroup.add(new THREE.LineSegments(lineGeom, lineMat));
    }

    // ---- Center + scale to a unit-ish size ------------------------------
    // centerGroup translates the model so its centroid sits at the origin;
    // scaleGroup then scales the whole thing uniformly. Keeping these on
    // separate groups avoids the order-of-operations issue where a single
    // group's scale would distort the position offset.
    const [lx, ly, lz, hx, hy, hz] = data.bounds;
    const cx = (lx + hx) / 2, cy = (ly + hy) / 2, cz = (lz + hz) / 2;
    const span = Math.max(hx - lx, hy - ly, hz - lz, 1e-9);
    centerGroup.position.set(-cx, -cy, -cz);
    scaleGroup.scale.setScalar(1.5 / span);
  }

  // ---- Animation loop --------------------------------------------------------

  let running = true;
  function loop() {
    if (!running) return;
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  }
  loop();

  // ---- Resize handling -------------------------------------------------------
  // Three needs explicit resize calls when the canvas's display size changes.

  const resizeObserver = new ResizeObserver(() => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    renderer.setSize(rect.width, rect.height, false);
    camera.aspect = rect.width / rect.height;
    camera.updateProjectionMatrix();
  });
  resizeObserver.observe(canvas);

  function dispose() {
    running = false;
    resizeObserver.disconnect();
    controls.dispose();
    clearPaper();
    renderer.dispose();
  }

  return { update, dispose };
}
