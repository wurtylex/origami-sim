// convert.js — Rabbit Ear bridge for the Python wrapper.
//
// Rabbit Ear ships as an ES module, so we use dynamic import() rather than
// require(). This file is still CommonJS so it can be invoked as `node
// convert.js` without any package.json gymnastics — only the `import('...')`
// call inside is ESM-aware.

async function loadEar() {
  const mod = await import('rabbit-ear');
  const ear = mod.default ?? mod;
  // Rabbit Ear's SVG functions need a DOM. In a browser this is automatic;
  // in Node we plug in @xmldom/xmldom.
  const xmldom = await import('@xmldom/xmldom');
  if (ear.svg) {
    ear.window = xmldom.default ?? xmldom;
  }
  return ear;
}

const CANDIDATES = [
  { name: "ear.convert.svgToFold",         get: ear => ear.convert?.svgToFold },
  { name: "ear.convert['svg-to-fold']",    get: ear => ear.convert?.['svg-to-fold'] },
  { name: "ear.convert.svg_to_fold",       get: ear => ear.convert?.svg_to_fold },
  { name: "ear.graph.svg",                 get: ear => ear.graph?.svg },
  { name: "ear.svgToFold",                 get: ear => ear.svgToFold },
];

function findConverter(ear) {
  for (const c of CANDIDATES) {
    const fn = c.get(ear);
    if (typeof fn === 'function') return { name: c.name, fn };
  }
  return null;
}

async function probe() {
  const ear = await loadEar();
  console.error('rabbit-ear top-level keys:', Object.keys(ear).sort().join(', ') || '(none)');
  if (ear.convert) {
    console.error('ear.convert keys:', Object.keys(ear.convert).sort().join(', '));
  }
  if (ear.graph) {
    console.error('ear.graph keys:', Object.keys(ear.graph).sort().join(', '));
  }
  const found = findConverter(ear);
  console.error(found ? `Converter found: ${found.name}` : 'No known converter found.');
  process.exit(found ? 0 : 1);
}

async function convert() {
  const ear = await loadEar();
  const converter = findConverter(ear);
  if (!converter) {
    console.error(
      'convert.js: could not find an SVG-to-FOLD function in rabbit-ear.\n' +
      'Run "node convert.js --probe" to see what your installed version exposes.'
    );
    process.exit(2);
  }

  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const svgText = Buffer.concat(chunks).toString('utf8');
  if (!svgText.trim()) {
    console.error('convert.js: empty input on stdin');
    process.exit(2);
  }

  let graph;
  try {
    graph = converter.fn(svgText);
  } catch (err) {
    console.error(`convert.js: ${converter.name} threw: ${err.message}`);
    process.exit(1);
  }

  if (graph && !graph.vertices_coords && graph.graph) graph = graph.graph;
  if (!graph || !graph.vertices_coords) {
    console.error('convert.js: converter returned no usable graph data.');
    console.error('Got:', typeof graph, Object.keys(graph || {}).slice(0, 10));
    process.exit(1);
  }

  graph.file_spec = graph.file_spec || 1.1;
  graph.file_creator = 'svg-to-fold (Rabbit Ear via Node)';
  process.stdout.write(JSON.stringify(graph, null, 2));
}

(async () => {
  if (process.argv.includes('--probe')) {
    await probe();
  } else {
    await convert();
  }
})().catch(err => {
  console.error('convert.js:', err.message || err);
  process.exit(1);
});
