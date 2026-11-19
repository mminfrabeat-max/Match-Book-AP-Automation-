// Offline OCR for scanned invoices (no text layer): renders each page and reads it with Tesseract.
// The words come back as rows of cells with x positions in PDF points, the same shape readRows() gives for
// digital PDFs, so every rule of the rules engine (labels, tables, address blocks) works on scans too.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { createWorker } from "tesseract.js";
import { ROOT } from "./paths.js";

const { createCanvas } = createRequire(import.meta.url)("@napi-rs/canvas");
const CACHE = path.join(ROOT, "data", "ocr");                 // language data is downloaded once, then reused offline
export const SCALE = 3;                                       // render at ~216 dpi: good for OCR, quick enough
let worker = null;

async function getWorker() {
  if (!worker) { fs.mkdirSync(CACHE, { recursive: true }); worker = createWorker("eng", 1, { cachePath: CACHE }); }
  return worker;
}
export async function stopOcr() { if (worker) { const w = await worker; await w.terminate(); worker = null; } }

export async function renderPage(doc, p, scale = SCALE) {
  const page = await doc.getPage(p);
  const vp = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
  return { page, vp, canvas, ctx };
}

// Words -> rows of cells. A gap wider than ~1.6 character widths starts a new cell (table columns, label | value).
function toRows(words, scale) {
  const lines = [];
  const good = words.filter(w => w.text.trim() && w.confidence > 25);
  // line tolerance from the typical word height: a logo, QR code or stamp read as one tall "word" must not
  // pull a whole column of text into a single row
  const hs = good.map(w => w.bbox.y1 - w.bbox.y0).sort((a, b) => a - b), hMed = hs[hs.length >> 1] ?? 10;
  for (const w of good.filter(w => w.bbox.y1 - w.bbox.y0 < hMed * 3).sort((a, b) => a.bbox.y0 - b.bbox.y0)) {
    const mid = (w.bbox.y0 + w.bbox.y1) / 2;
    const line = lines.find(l => Math.abs(l.mid - mid) < hMed * 0.55);
    if (line) { line.words.push(w); line.mid = (line.mid + mid) / 2; } else lines.push({ mid, words: [w] });
  }
  lines.sort((a, b) => a.mid - b.mid);
  const rows = [], rowsX = [], conf = [];
  for (const l of lines) {
    const ws = l.words.sort((a, b) => a.bbox.x0 - b.bbox.x0);
    const cells = [];
    for (const w of ws) {
      const last = cells[cells.length - 1], charW = (w.bbox.x1 - w.bbox.x0) / Math.max(1, w.text.length);
      if (last && w.bbox.x0 - last.x1 < charW * 1.6) { last.text += " " + w.text; last.x1 = w.bbox.x1; last.c.push(w.confidence); }
      else cells.push({ x0: w.bbox.x0, x1: w.bbox.x1, text: w.text, c: [w.confidence] });
    }
    rows.push(cells.map(c => c.text));
    rowsX.push(cells.map(c => [c.x0 / scale, c.text]));
    conf.push(...cells.flatMap(c => c.c));
  }
  return { rows, rowsX, meanConf: conf.length ? conf.reduce((a, b) => a + b, 0) / conf.length : 0 };
}

export async function ocrPdf(file, maxPages = 3) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), verbosity: 0 }).promise;
  const w = await getWorker();
  const out = { rows: [], rowsX: [], words: [], pages: doc.numPages, confidence: 0 };
  const confs = [];
  for (let p = 1; p <= Math.min(doc.numPages, maxPages); p++) {
    const { canvas } = await renderPage(doc, p);
    const { data } = await w.recognize(await canvas.encode("png"));
    const words = data.words ?? [];
    const r = toRows(words, SCALE);
    out.rows.push(...r.rows); out.rowsX.push(...r.rowsX); confs.push(r.meanConf);
    out.words.push(...words.map(x => ({ page: p, text: x.text, conf: x.confidence, x0: x.bbox.x0 / SCALE, y0: x.bbox.y0 / SCALE, x1: x.bbox.x1 / SCALE, y1: x.bbox.y1 / SCALE })));
  }
  out.confidence = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length / 100 : 0;
  return out;
}
