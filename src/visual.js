// Visual check of the signatory area: is there a stamp (coloured ink) and a signature (hand-drawn strokes)?
// Works on digital PDFs and scans alike: the page is rendered and the pixels above "Authorised Signatory"
// (or, without that text, the lower right of the page) are measured. Printed text in the area is masked out,
// so the words "For <vendor>" do not count as a signature. A heuristic, reported with its scores.
import fs from "node:fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { renderPage } from "./ocr.js";

const S = 2;   // render scale for the check (144 dpi)

// boxes: printed words in PDF points {x0,y0,x1,y1} (y from top); anchor: the "Authorised Signatory" box, if any
export async function checkSignatory(file, { words = [], scan = false } = {}) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), verbosity: 0 }).promise;
  const p = doc.numPages > 1 ? doc.numPages : 1;          // signatures sit on the last page
  const { page, vp, ctx, canvas } = await renderPage(doc, p, S);
  let boxes = words.filter(w => (w.page ?? p) === p);
  if (!boxes.length) {                                     // digital PDF: printed words from the text layer
    for (const it of (await page.getTextContent()).items) {
      if (!it.str?.trim()) continue;
      const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
      const h = Math.abs(it.transform[3]) * S;
      boxes.push({ text: it.str, x0: x / S, y0: (y - h) / S, x1: (x + it.width * S) / S, y1: y / S + 1 });
    }
  }
  const W = canvas.width / S, H = canvas.height / S;
  const anchor = boxes.find(b => /authori[sz]ed/i.test(b.text) && /signator/i.test(b.text)) ?? boxes.find(b => /authori[sz]ed/i.test(b.text));
  // the area where stamps and signatures are placed: above the anchor, else the lower right of the page
  const area = anchor ? { x0: anchor.x0 - 45, x1: anchor.x0 + 190, y0: anchor.y0 - 82, y1: anchor.y0 - 1 } : { x0: W * 0.5, x1: W * 0.97, y0: H * 0.66, y1: H * 0.93 };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ax0 = clamp(Math.round(area.x0 * S), 0, canvas.width - 1), ax1 = clamp(Math.round(area.x1 * S), 1, canvas.width);
  const ay0 = clamp(Math.round(area.y0 * S), 0, canvas.height - 1), ay1 = clamp(Math.round(area.y1 * S), 1, canvas.height);
  const img = ctx.getImageData(ax0, ay0, ax1 - ax0, ay1 - ay0);
  // mask printed text that is not part of the stamp (black / dark grey words such as "For <vendor>")
  const masked = new Uint8Array(img.width * img.height);
  for (const b of boxes) {
    if (anchor && b === anchor) continue;
    const x0 = Math.round(b.x0 * S) - ax0 - 2, x1 = Math.round(b.x1 * S) - ax0 + 2, y0 = Math.round(b.y0 * S) - ay0 - 2, y1 = Math.round(b.y1 * S) - ay0 + 2;
    for (let y = Math.max(0, y0); y < Math.min(img.height, y1); y++) for (let x = Math.max(0, x0); x < Math.min(img.width, x1); x++) masked[y * img.width + x] = 1;
  }
  let coloured = 0, dark = 0, n = 0;
  for (let i = 0, k = 0; i < img.data.length; i += 4, k++) {
    const r = img.data[i], g = img.data[i + 1], bl = img.data[i + 2];
    const mx = Math.max(r, g, bl), mn = Math.min(r, g, bl);
    n++;
    if (mx - mn > 55 && mx > 70) coloured++;                          // stamp ink: blue / violet / red / green
    else if (!masked[k] && mx < 110) dark++;                            // pen strokes outside printed words
  }
  const stampScore = coloured / n, signScore = dark / n;
  const signMin = scan ? 0.0015 : 0.0025;                              // scanning lightens thin pen strokes
  return {
    stamp: stampScore > 0.004, signature: signScore > signMin || stampScore > 0.03,
    stampScore: +stampScore.toFixed(4), signScore: +signScore.toFixed(4), anchored: !!anchor, page: p, method: "visual check of the signatory area",
  };
}
