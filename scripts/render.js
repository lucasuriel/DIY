#!/usr/bin/env node
/**
 * Render a GLB from four angles so you can see what a model actually contains
 * before placing anything. Writes <out>/<name>-{front,side,back,top}.png.
 *
 * Serves three.js out of node_modules over a throwaway local server, so it needs
 * no network and no build step.
 *
 * Usage:
 *   node scripts/render.js path/to/model.glb [outDir]
 *   node scripts/render.js path/to/model.glb out/look --islands
 *
 * --islands  tints each connected piece of geometry a different colour, which is
 *            the quickest way to see whether a parts sheet will come apart or has
 *            fused into one shell.
 */
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const SRC = process.argv[2];
const OUT = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : "out/look";
const ISLANDS = process.argv.includes("--islands");

if (!SRC || !fs.existsSync(SRC)) {
  console.error("usage: node scripts/render.js <model.glb> [outDir] [--islands]");
  process.exit(2);
}

const THREE_DIR = path.join(__dirname, "..", "node_modules", "three");
if (!fs.existsSync(THREE_DIR)) {
  console.error("three.js not found - run npm install first");
  process.exit(2);
}

const TYPES = {
  ".js": "text/javascript",
  ".glb": "model/gltf-binary",
  ".html": "text/html",
};

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:#15171c;overflow:hidden}
</style>
<script type="importmap">
{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}
</script></head>
<body><script type="module">
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const SHOW_ISLANDS = ${ISLANDS};
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(900, 900);
renderer.setPixelRatio(1);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x15171c);
scene.add(new THREE.HemisphereLight(0xffffff, 0x333344, 2.2));
const key = new THREE.DirectionalLight(0xffffff, 2.4);
key.position.set(3, 5, 4);
scene.add(key);
const fill = new THREE.DirectionalLight(0xffffff, 1.0);
fill.position.set(-4, 2, -3);
scene.add(fill);

const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 200);

/** Split a geometry into connected pieces and give each one its own colour. */
function tintIslands(geo) {
  const pos = geo.attributes.position;
  const index = geo.index ? geo.index.array : null;
  const count = index ? index.length : pos.count;
  // Weld by rounded position so touching triangles share a key.
  const key = new Map();
  const node = new Int32Array(pos.count).fill(-1);
  const find = (a) => { while (node[a] !== a) { node[a] = node[node[a]]; a = node[a]; } return a; };
  for (let i = 0; i < pos.count; i++) node[i] = i;
  for (let i = 0; i < pos.count; i++) {
    const k = [pos.getX(i), pos.getY(i), pos.getZ(i)].map((v) => Math.round(v * 1e4)).join(",");
    if (key.has(k)) { const r = find(key.get(k)); node[find(i)] = r; } else key.set(k, i);
  }
  for (let i = 0; i < count; i += 3) {
    const a = index ? index[i] : i, b = index ? index[i + 1] : i + 1, c = index ? index[i + 2] : i + 2;
    node[find(b)] = find(a); node[find(c)] = find(a);
  }
  const colour = new Float32Array(pos.count * 3);
  const palette = new Map();
  for (let i = 0; i < pos.count; i++) {
    const root = find(i);
    if (!palette.has(root)) {
      const h = (palette.size * 0.37) % 1;
      palette.set(root, new THREE.Color().setHSL(h, 0.75, 0.55));
    }
    const col = palette.get(root);
    colour[i * 3] = col.r; colour[i * 3 + 1] = col.g; colour[i * 3 + 2] = col.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colour, 3));
  return palette.size;
}

const loader = new GLTFLoader();
loader.load("/model.glb", (gltf) => {
  const root = gltf.scene;
  let islands = 0;
  root.traverse((o) => {
    if (!o.isMesh) return;
    if (SHOW_ISLANDS) {
      islands += tintIslands(o.geometry);
      o.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.0 });
    } else if (o.material) {
      o.material.envMapIntensity = 1.0;
    }
  });

  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const span = Math.max(size.x, size.y, size.z);
  root.position.sub(centre);
  scene.add(root);

  const dist = span * 2.1;
  const views = {
    front: [0, span * 0.25, dist],
    side: [dist, span * 0.25, 0],
    back: [0, span * 0.25, -dist],
    top: [0.001, dist, 0.001],
  };
  window.__shots = [];
  for (const [name, p] of Object.entries(views)) {
    camera.position.set(p[0], p[1], p[2]);
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
    window.__shots.push([name, renderer.domElement.toDataURL("image/png")]);
  }
  window.__info = {
    islands,
    size: [size.x, size.y, size.z].map((v) => +v.toFixed(3)),
  };
  window.__done = true;
}, undefined, (e) => { window.__error = String(e); window.__done = true; });
</script></body></html>`;

(async () => {
  const server = http.createServer((req, res) => {
    const url = req.url.split("?")[0];
    let file = null;
    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(PAGE);
    }
    if (url === "/model.glb") file = path.resolve(SRC);
    else if (url.startsWith("/three/")) file = path.join(THREE_DIR, url.slice(7));
    if (!file || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end("not found");
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const browser = await chromium.launch({
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  page.on("pageerror", (e) => console.error("page error:", e.message));

  await page.goto(`http://localhost:${port}/`);
  // preserveDrawingBuffer is off, so each view is captured right after its render.
  await page.waitForFunction(() => window.__done === true, null, { timeout: 180000 });

  const error = await page.evaluate(() => window.__error);
  if (error) {
    console.error("failed to load:", error);
    await browser.close();
    server.close();
    process.exit(1);
  }

  const info = await page.evaluate(() => window.__info);
  const shots = await page.evaluate(() => window.__shots);
  fs.mkdirSync(OUT, { recursive: true });
  const stem = path.basename(SRC).replace(/\.glb$/i, "").slice(0, 40);
  for (const [name, data] of shots) {
    fs.writeFileSync(path.join(OUT, `${stem}-${name}.png`), Buffer.from(data.split(",")[1], "base64"));
  }

  console.log(`${stem}`);
  console.log(`  size: ${info.size.join(" x ")}`);
  if (ISLANDS) console.log(`  islands: ${info.islands}`);
  console.log(`  wrote ${shots.length} views to ${OUT}`);

  await browser.close();
  server.close();
})();
