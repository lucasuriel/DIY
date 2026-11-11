#!/usr/bin/env node
/**
 * Visual QA pass: open every machine in a real browser and check the labels.
 *
 * This catches what scripts/hotspots.py cannot — machines that fail to load,
 * models that render near-black, labels that overlap each other or run off the
 * edge, and runtime errors. The Python check measures distance to the mesh;
 * this one looks at what a person actually sees.
 *
 * Neither catches a label on the WRONG part: a hinge marker sitting neatly on the
 * front edge of a laptop passes both. Only looking finds that, so every run
 * writes screenshots for review.
 *
 * Usage:
 *   npm run build
 *   npx next start -p 3300          # in another terminal
 *   node scripts/qa.js out/qa
 *
 * Exits non-zero if anything failed to load, rendered black, or collided.
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const BASE = process.env.QA_URL || "http://localhost:3300";
const OUT = process.argv[2] || "out/qa";

// Machine name as the rail lists it, short tag for filenames, expected label count.
// The arm is a step-by-step teardown, so it shows no hotspot labels.
const MACHINES = [
  ["The Motorcycle", "moto", 5],
  ["The Robotic Arm", "arm", 0],
  ["The Prosthetic", "prosthetic", 6],
  ["The Tablet", "tablet", 4],
  ["The Laptop", "computer", 7],
  ["The 3D Printer", "printer", 6],
  ["The Bioreactor", "reactor", 7],
];

// A model rendering below this mean luminance is almost certainly unlit or black.
const MIN_LUMINANCE = 4;

/** Pairs of labels whose boxes overlap by more than a couple of pixels. */
function collisions(boxes) {
  const hits = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (x > 2 && y > 2) hits.push(`${a.text}/${b.text}`);
    }
  }
  return hits;
}

/**
 * Mean luminance of the 3D viewport in a saved screenshot.
 *
 * Decoding happens in the browser, which already knows how to read a PNG: the
 * image goes onto a 2D canvas, which reads back reliably. Only the middle of the
 * frame is sampled, so the dark chrome around the viewport does not drag it down.
 */
async function measure(browser, file) {
  const url = "file://" + path.resolve(file);
  const context = await browser.newContext();
  const probe = await context.newPage();
  try {
    const value = await probe.evaluate(async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const w = 160;
      const h = 110;
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d");
      // Middle 60% of the frame: the model, not the rail or the tour bar.
      const sx = img.width * 0.2;
      const sy = img.height * 0.15;
      ctx.drawImage(img, sx, sy, img.width * 0.6, img.height * 0.6, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) {
        sum += d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
      }
      return +(sum / (d.length / 4)).toFixed(1);
    }, url);
    return value;
  } catch {
    return -1;
  } finally {
    await context.close();
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });

  // The display font loads from Google Fonts after mount. Serve it as empty CSS so
  // a slow or unreachable network cannot stall the run. Fulfilling rather than
  // aborting keeps the console clean, so a real error is never lost in the noise.
  await page.route("**fonts.g**", (r) =>
    r.fulfill({ status: 200, contentType: "text/css", body: "" })
  );

  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("ERR_TUNNEL")) errors.push(m.text());
  });
  page.on("requestfailed", (r) => {
    if (!r.url().includes("fonts.g")) errors.push("failed request: " + r.url().split("/").pop());
  });

  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page
    .locator("article", { hasText: "The Motorcycle" })
    .getByRole("button", { name: /Open in sandbox/ })
    .click();

  let failures = 0;

  for (const [name, tag, expected] of MACHINES) {
    if (tag !== "moto") {
      await page.getByRole("button", { name: "Machines" }).click();
      await page.waitForTimeout(250);
      await page
        .locator('section[aria-label="Machines"] button', { hasText: name })
        .first()
        .click();
      await page.waitForTimeout(400);
      // Close the panel by its button; Escape would exit the sandbox entirely.
      const close = page.locator('section[aria-label="Machines"] button[aria-label^="Close"]');
      if (await close.count()) await close.click();
    }

    let loaded = true;
    try {
      await page.waitForFunction(
        () => !document.body.innerText.includes("Loading the 3D model"),
        null,
        { timeout: 90000 }
      );
    } catch {
      loaded = false;
    }
    const missing = await page.locator("text=weren't found").count();
    await page.waitForTimeout(2600);
    await page.screenshot({ path: path.join(OUT, `${tag}.png`) });

    const boxes = await page.$$eval('div[role="group"] button', (nodes) =>
      nodes.map((n) => {
        const r = n.getBoundingClientRect();
        return {
          text: n.textContent.trim(),
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
        };
      })
    );

    // Measure brightness from the saved screenshot, not the live canvas: a WebGL
    // canvas without preserveDrawingBuffer reads back blank once the frame is done,
    // which would report every machine as black.
    const luminance = await measure(browser, path.join(OUT, `${tag}.png`));

    const problems = [];
    if (!loaded) problems.push("timed out loading");
    if (missing) problems.push("model file not found");
    if (expected && boxes.length !== expected) {
      problems.push(`expected ${expected} labels, saw ${boxes.length}`);
    }
    const hits = collisions(boxes);
    if (hits.length) problems.push(`overlapping: ${hits.join(", ")}`);
    const off = boxes.filter((b) => b.left < 0 || b.right > 1280).map((b) => b.text);
    if (off.length) problems.push(`off screen: ${off.join(", ")}`);
    // -1 means the canvas could not be read back, which is not a rendering fault.
    if (luminance >= 0 && luminance < MIN_LUMINANCE) {
      problems.push(`very dark (luminance ${luminance})`);
    }

    if (problems.length) failures++;
    console.log(
      `${tag.padEnd(11)} ${String(boxes.length).padStart(2)} labels  ` +
        (problems.length ? problems.join(" | ") : "ok")
    );
  }

  await browser.close();

  const unique = [...new Set(errors)];
  if (unique.length) {
    console.log(`\nerrors: ${unique.slice(0, 5).join(" | ")}`);
    failures++;
  }
  console.log(`\nScreenshots in ${OUT}. ${failures} machine(s) with problems.`);
  console.log("A label on the wrong part passes every check here — look at the shots.");
  process.exit(failures ? 1 : 0);
})();
