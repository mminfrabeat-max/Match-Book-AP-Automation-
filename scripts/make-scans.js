// Turns invoice PDFs into "scanned" image-only PDFs (no text layer): slight skew, grey paper, noise, JPEG.
// Used to test OCR and the visual stamp / signature check.
//   npm run scans                      -> samples/scans/ from samples/*.pdf
//   npm run scans -- <folder>          -> <folder>/scans/ from <folder>/*.pdf
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import PDFDocument from "pdfkit";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { ROOT } from "../src/paths.js";

const { createCanvas } = createRequire(import.meta.url)("@napi-rs/canvas");
const SRC = path.resolve(process.argv[2] ?? path.join(ROOT, "samples"));
const OUT = path.join(SRC, "scans");
fs.mkdirSync(OUT, { recursive: true });

for (const f of fs.readdirSync(SRC).filter(x => x.endsWith(".pdf"))) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(path.join(SRC, f))), verbosity: 0 }).promise;
  const page = await doc.getPage(1), vp = page.getViewport({ scale: 2.2 });           // about 160 dpi, like an office scanner
  const flat = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const fctx = flat.getContext("2d"); fctx.fillStyle = "#fff"; fctx.fillRect(0, 0, flat.width, flat.height);
  await page.render({ canvasContext: fctx, viewport: vp, canvas: flat }).promise;
  // the "scan": paper tone, a small random skew, speckle noise
  const scan = createCanvas(flat.width, flat.height), ctx = scan.getContext("2d");
  ctx.fillStyle = "#f3f1ea"; ctx.fillRect(0, 0, scan.width, scan.height);
  ctx.translate(scan.width / 2, scan.height / 2); ctx.rotate(((Math.random() - 0.5) * 1.2 * Math.PI) / 180); ctx.translate(-scan.width / 2, -scan.height / 2);
  ctx.globalAlpha = 0.93; ctx.drawImage(flat, 0, 0); ctx.globalAlpha = 1; ctx.setTransform(1, 0, 0, 1, 0, 0);
  const img = ctx.getImageData(0, 0, scan.width, scan.height);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 18;
    img.data[i] = Math.max(0, Math.min(255, img.data[i] + n)); img.data[i + 1] = Math.max(0, Math.min(255, img.data[i + 1] + n)); img.data[i + 2] = Math.max(0, Math.min(255, img.data[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);
  const jpg = await scan.encode("jpeg", 72);
  const out = new PDFDocument({ size: "A4", margin: 0, info: { Title: `Scan of ${f}`, Producer: "Office scanner (demo)" } });
  const done = new Promise(r => out.pipe(fs.createWriteStream(path.join(OUT, f.replace(/\.pdf$/, "_scan.pdf")))).on("finish", r));
  out.image(jpg, 0, 0, { width: 595.28, height: 841.89 });
  out.end(); await done;
  console.log("scanned", f);
}
console.log(`Wrote image-only scans to ${OUT}`);
