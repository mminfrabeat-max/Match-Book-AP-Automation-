// Vendor invoice PDFs in different layouts, so the reading agents are tested on real-world variety:
//   classic   plain GST tax invoice, labels with colons
//   banner    coloured header band with logo, boxed details table, amount in words, e-invoice QR
//   einvoice  GST e-invoice print: IRN / Ack No / Ack Date and the signed QR code top right
//   compact   small supplier: centred header with round logo, "Bill No / P.O. No.", UPI payment QR
//   modern    logo right, details in a side column, totals in a highlight box
// spec: { file, layout, vendor{name,addr,gstin,pan,udyam}, shipTo{name,addr,gstin}, no, date (dd-mm-yyyy), po,
//         lr, dn, irn, signed, lines[{desc,hsn,qty,uom,rate}], gst{type,rate}, theme }
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import { fileURLToPath } from "node:url";

export const LAYOUTS = ["classic", "banner", "einvoice", "compact", "modern"];
const THEMES = [["#1f4fa8", "#e8eefb"], ["#0f766e", "#e3f4f1"], ["#9a3412", "#fbeee6"], ["#6d28d9", "#efe9fd"], ["#334155", "#eef1f5"], ["#b91c1c", "#fbe9e9"]];
const inr = n => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const b64u = s => Buffer.from(s).toString("base64url");

// Indian-system amount in words, e.g. "Eight Lakh Eight Thousand Three Hundred Rupees Only"
function words(n) {
  const a = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const t = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  const two = x => x < 20 ? a[x] : `${t[Math.floor(x / 10)]}${x % 10 ? " " + a[x % 10] : ""}`;
  const three = x => `${x >= 100 ? a[Math.floor(x / 100)] + " Hundred" + (x % 100 ? " " : "") : ""}${x % 100 ? two(x % 100) : ""}`;
  let r = Math.floor(n), out = [];
  for (const [v, w] of [[1e7, "Crore"], [1e5, "Lakh"], [1e3, "Thousand"]]) if (r >= v) { out.push(`${three(Math.floor(r / v))} ${w}`); r %= v; }
  if (r) out.push(three(r));
  const p = Math.round((n % 1) * 100);
  return `${out.join(" ") || "Zero"} Rupees${p ? ` and ${two(p)} Paise` : ""} Only`;
}

function totals(s) {
  const taxable = s.lines.reduce((x, l) => x + l.qty * l.rate, 0);
  const tax = taxable * s.gst.rate / 100;
  const rows = s.gst.type === "IGST" ? [[`IGST @ ${s.gst.rate}%`, tax]] : [[`CGST @ ${s.gst.rate / 2}%`, tax / 2], [`SGST @ ${s.gst.rate / 2}%`, tax / 2]];
  return { taxable, tax, rows, total: taxable + tax };
}

const irnOf = s => crypto.createHash("sha256").update(s.no + s.vendor.gstin).digest("hex");
const isoDt = d => d.split("-").reverse().join("-");

// Test PDFs are signed with a demo key that stands in for the IRP (Invoice Registration Portal). Match Book lists its
// public key as "Demo IRP key (test PDFs only)"; real e-invoices are verified with the NIC portal key instead.
const KEYS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "keys");
function demoKey() {
  const priv = path.join(KEYS, "demo-irp-private.pem"), pub = path.join(KEYS, "demo-irp-public.pem");
  if (!fs.existsSync(priv)) {
    fs.mkdirSync(KEYS, { recursive: true });
    const k = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    fs.writeFileSync(priv, k.privateKey.export({ type: "pkcs8", format: "pem" }));
    fs.writeFileSync(pub, k.publicKey.export({ type: "spki", format: "pem" }));
  }
  return fs.readFileSync(priv, "utf8");
}
const sign = (data, key) => crypto.sign("RSA-SHA256", Buffer.from(data), key).toString("base64url");

// The signed QR printed on GST e-invoices is a JWT whose payload carries the invoice data (signature by the IRP).
// s.qrForged: test only - the QR is signed with some other key (a fake e-invoice); verification must fail.
function einvoiceQr(s) {
  const t = totals(s);
  // s.qrTotal: test only - the value registered on the portal differs from the printed one (tampered print)
  const data = { SellerGstin: s.vendor.gstin, BuyerGstin: s.shipTo.gstin, DocNo: s.no, DocTyp: "INV", DocDt: s.date.replace(/-/g, "/"), TotInvVal: +(s.qrTotal ?? t.total).toFixed(2),
    ItemCnt: s.lines.length, MainHsnCode: s.lines[0]?.hsn ?? "", Irn: irnOf(s), IrnDt: `${isoDt(s.date)} 18:20:00` };
  const body = `${b64u(JSON.stringify({ alg: "RS256", kid: "DEMO-IRP", typ: "JWT" }))}.${b64u(JSON.stringify({ data: JSON.stringify(data), iss: "NIC" }))}`;
  const key = s.qrForged ? crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey : demoKey();
  return `${body}.${sign(body, key)}`;
}
const upiQr = s => `upi://pay?pa=${s.vendor.name.toLowerCase().replace(/[^a-z]/g, "").slice(0, 12)}@okbank&pn=${encodeURIComponent(s.vendor.name)}&am=${totals(s).total.toFixed(2)}&cu=INR&tn=${encodeURIComponent(s.no)}`;
const qrPng = text => QRCode.toBuffer(text, { errorCorrectionLevel: "L", margin: 1, width: 640 });

// Vendor logo: a simple mark drawn from the vendor's initials (fictional / test vendors only).
function logo(doc, x, y, size, name, color, shape) {
  const ini = name.replace(/\b(pvt|ltd|private|limited|and|&)\b/gi, "").split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join("").toUpperCase();
  doc.save();
  if (shape === "circle") doc.circle(x + size / 2, y + size / 2, size / 2).fill(color);
  else if (shape === "hex") { const r = size / 2, cx = x + r, cy = y + r; doc.polygon(...[0, 1, 2, 3, 4, 5].map(k => [cx + r * Math.cos(Math.PI / 3 * k + Math.PI / 6), cy + r * Math.sin(Math.PI / 3 * k + Math.PI / 6)])).fill(color); }
  else { doc.roundedRect(x, y, size, size, size * 0.22).fill(color); doc.polygon([x + size * 0.62, y], [x + size, y], [x + size, y + size * 0.38]).fill("#ffffff").fillOpacity(1); }
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(size * 0.38).text(ini, x, y + size * 0.31, { width: size, align: "center" });
  doc.restore();
}

// Rubber stamps are inked blue, violet or red, whatever the invoice's theme colour (a grey theme would
// give a grey stamp, which no real stamp is and the visual check rightly does not count as ink).
const STAMP_INKS = ["#1f3fa8", "#5b21b6", "#b91c1c"];
function signature(doc, x, y, s, theme) {
  if (!s.signed) return;
  const color = STAMP_INKS[[...s.vendor.name].reduce((a, ch) => a + ch.charCodeAt(0), 0) % STAMP_INKS.length];
  doc.font("Helvetica").fontSize(8.5).fillColor("#000").text(`For ${s.vendor.name}`, x, y);
  doc.save().strokeColor(color).lineWidth(1.4).circle(x + 70, y + 44, 26).stroke();
  doc.fillColor(color).fontSize(5.5).text(s.vendor.name.toUpperCase(), x + 46, y + 40, { width: 48, align: "center" }).restore();
  doc.save().strokeColor("#1d1d1d").lineWidth(1).moveTo(x + 14, y + 60).bezierCurveTo(x + 34, y + 30, x + 54, y + 80, x + 96, y + 52).stroke().restore();
  doc.fillColor("#000").fontSize(8.5).text("Authorised Signatory", x + 18, y + 80);
}

function itemTable(doc, s, x, y, w, cols, color, fill, font = "Helvetica") {
  const widths = cols.map(c => c[1] * w), xs = widths.reduce((a, v, i) => (a.push(i ? a[i - 1] + widths[i - 1] : x), a), []);
  doc.rect(x, y, w, 18).fill(fill);
  doc.fillColor(color).font(`${font === "Times-Roman" ? "Times-Bold" : font === "Courier" ? "Courier-Bold" : "Helvetica-Bold"}`).fontSize(8.5);
  cols.forEach((c, i) => doc.text(c[0], xs[i] + 4, y + 5, { width: widths[i] - 8, align: c[2] ?? "left" }));
  doc.font(font).fillColor("#111").fontSize(8.5);
  let yy = y + 24;
  s.lines.forEach((l, n) => {
    const vals = { sr: String(n + 1), desc: l.desc, hsn: l.hsn, qty: String(l.qty), uom: l.uom, rate: inr(l.rate), amt: inr(l.qty * l.rate) };
    cols.forEach((c, i) => doc.text(vals[c[3]], xs[i] + 4, yy, { width: widths[i] - 8, align: c[2] ?? "left", lineBreak: false }));
    yy += 18;
  });
  doc.moveTo(x, yy + 2).lineTo(x + w, yy + 2).strokeColor("#c9ced8").lineWidth(.6).stroke();
  return yy + 10;
}

const LAYOUT = {
  classic(doc, s, t, c) {
    const L = 40;
    doc.font("Helvetica-Bold").fontSize(16).fillColor("#000").text(s.vendor.name, L, 40);
    doc.font("Helvetica").fontSize(9).text(s.vendor.addr, L, 60).text(`GSTIN: ${s.vendor.gstin}`, L, 74).text(`PAN: ${s.vendor.pan}`, L + 200, 74);
    if (s.vendor.udyam) doc.text(`MSME Udyam Reg No: ${s.vendor.udyam}`, L, 88);
    doc.font("Helvetica-Bold").fontSize(14).text("TAX INVOICE", 420, 40, { width: 135, align: "right" });
    doc.moveTo(L, 104).lineTo(555, 104).stroke();
    doc.font("Helvetica").fontSize(9).text(`Invoice No: ${s.no}`, L, 114).text(`Invoice Date: ${s.date}`, L, 128).text(`PO No: ${s.po}`, L, 142)
      .text(`LR No: ${s.lr || "-"}`, 320, 114).text(`Delivery Note: ${s.dn || "-"}`, 320, 128).text(`Place of Supply: ${s.shipTo.gstin.slice(0, 2)}`, 320, 142);
    doc.font("Helvetica-Bold").text("Bill To / Ship To", L, 166).font("Helvetica").text(s.shipTo.name, L, 180).text(s.shipTo.addr, L, 194).text(`Ship to GSTIN: ${s.shipTo.gstin}`, L, 208);
    let y = itemTable(doc, s, L, 232, 515, [["Description", .4, "left", "desc"], ["HSN/SAC", .12, "left", "hsn"], ["Qty", .09, "right", "qty"], ["UOM", .09, "left", "uom"], ["Rate", .15, "right", "rate"], ["Amount", .15, "right", "amt"]], "#000", "#ececec");
    for (const [k, v] of [["Taxable Value", t.taxable], ...t.rows, ["Total Invoice Value", t.total]]) { doc.font(k.startsWith("Total") ? "Helvetica-Bold" : "Helvetica").text(`${k}: ${inr(v)}`, 330, y); y += 16; }
    if (s.irn) doc.fontSize(7).text(`IRN: ${irnOf(s)}`, L, y + 8).fontSize(9);
    doc.text("Bank: HDFC Bank, A/c 50200012345678, IFSC HDFC0000123", L, 640);
    signature(doc, 380, 640, s, c[0]);
  },

  async banner(doc, s, t, c) {
    doc.rect(0, 0, 595, 96).fill(c[0]);
    doc.roundedRect(36, 22, 52, 52, 11).fill("#ffffff");
    doc.fillColor(c[0]).font("Helvetica-Bold").fontSize(20).text(s.vendor.name.split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase(), 36, 38, { width: 52, align: "center" });
    doc.fillColor("#fff").font("Helvetica-Bold").fontSize(17).text(s.vendor.name, 100, 26);
    doc.font("Helvetica").fontSize(8.5).text(s.vendor.addr, 100, 48, { width: 300 }).text(`GSTIN ${s.vendor.gstin}  |  PAN ${s.vendor.pan}${s.vendor.udyam ? `  |  Udyam ${s.vendor.udyam}` : ""}`, 100, 70);
    doc.font("Helvetica-Bold").fontSize(15).text("TAX INVOICE", 420, 30, { width: 140, align: "right" }).font("Helvetica").fontSize(8).text("Original for Recipient", 420, 52, { width: 140, align: "right" });
    const box = (x, y, w, rows) => { doc.roundedRect(x, y, w, rows.length * 18 + 8, 6).fillAndStroke(c[1], c[1]); rows.forEach(([k, v], i) => { doc.fillColor("#555").font("Helvetica").fontSize(8.5).text(k, x + 10, y + 8 + i * 18); doc.fillColor("#111").font("Helvetica-Bold").text(v, x + 110, y + 8 + i * 18); }); };
    box(36, 112, 255, [["Invoice No.", s.no], ["Invoice Date", s.date], ["Buyer's Order No.", s.po], ["Delivery Challan", s.dn || "-"]]);
    box(304, 112, 255, [["Transporter LR No.", s.lr || "-"], ["Place of Supply", s.shipTo.gstin.slice(0, 2)], ["Reverse Charge", "No"], ["Payment Terms", "As per PO"]]);
    doc.fillColor(c[0]).font("Helvetica-Bold").fontSize(9).text("BILLED TO", 36, 206).text("SHIPPED TO", 304, 206);
    doc.fillColor("#111").font("Helvetica").fontSize(8.5).text(s.shipTo.name, 36, 220).text(s.shipTo.addr, 36, 233, { width: 250 }).text(s.shipTo.name, 304, 220).text(s.shipTo.addr, 304, 233, { width: 250 }).text(`Consignee GSTIN: ${s.shipTo.gstin}`, 304, 246);
    let y = itemTable(doc, s, 36, 262, 523, [["Sr", .05, "left", "sr"], ["Description of Goods", .37, "left", "desc"], ["HSN", .1, "left", "hsn"], ["Quantity", .1, "right", "qty"], ["Unit", .08, "left", "uom"], ["Rate", .14, "right", "rate"], ["Amount", .16, "right", "amt"]], "#fff", c[0]);
    doc.roundedRect(339, y, 220, (t.rows.length + 2) * 17 + 8, 6).fill(c[1]);
    [["Taxable Amount", t.taxable], ...t.rows, ["Grand Total", t.total]].forEach(([k, v], i) => { doc.fillColor("#111").font(k === "Grand Total" ? "Helvetica-Bold" : "Helvetica").fontSize(9).text(k, 349, y + 8 + i * 17).text(inr(v), 449, y + 8 + i * 17, { width: 100, align: "right" }); });
    doc.font("Helvetica-Oblique").fontSize(8.5).fillColor("#333").text(`Amount in words: ${words(t.total)}`, 36, y + 8, { width: 290 });
    if (s.irn) {
      doc.image(await qrPng(einvoiceQr(s)), 36, 600, { width: 96 });
      doc.font("Helvetica").fontSize(6.5).fillColor("#333").text(`IRN: ${irnOf(s)}`, 140, 606, { width: 250, lineBreak: false }).text("Scan to verify e-invoice", 140, 640);
    }
    signature(doc, 400, 610, s, c[0]);
  },

  async einvoice(doc, s, t, c) {
    const irn = irnOf(s), ack = String(1120000000 + parseInt(irn.slice(0, 6), 16) % 99999999);
    doc.font("Helvetica-Bold").fontSize(13).fillColor("#000").text("e-Invoice", 40, 36);
    doc.font("Helvetica").fontSize(8).text(`IRN : ${irn}`, 40, 58, { width: 380 }).text(`Ack No. : ${ack}`, 40, 82).text(`Ack Date : ${isoDt(s.date)} 18:20:00`, 40, 94);
    doc.image(await qrPng(einvoiceQr(s)), 455, 28, { width: 100 });
    doc.moveTo(40, 136).lineTo(555, 136).strokeColor("#888").lineWidth(.8).stroke();
    doc.font("Helvetica-Bold").fontSize(10).text("1. e-Invoice Details", 40, 146);
    doc.font("Helvetica").fontSize(8.5).text(`Category : B2B`, 40, 162).text(`Document Type : Tax Invoice`, 220, 162).text(`Document No : ${s.no}`, 40, 176).text(`Document Date : ${s.date}`, 220, 176)
      .text(`IGST applicable despite Supplier and Recipient located in same State : No`, 40, 190);
    doc.font("Helvetica-Bold").fontSize(10).text("2. Party Details", 40, 212);
    doc.font("Helvetica-Bold").fontSize(8.5).text("Supplier :", 40, 228).text("Recipient :", 300, 228);
    doc.font("Helvetica").text(`GSTIN : ${s.vendor.gstin}`, 40, 242).text(s.vendor.name, 40, 255).text(s.vendor.addr, 40, 268, { width: 240 })
      .text(`GSTIN of Recipient : ${s.shipTo.gstin}`, 300, 242).text(s.shipTo.name, 300, 255).text(s.shipTo.addr, 300, 268, { width: 240 });
    doc.font("Helvetica-Bold").fontSize(10).text("3. Details of Goods / Services", 40, 304);
    doc.font("Helvetica").fontSize(8.5).text(`PO Reference : ${s.po}`, 40, 320).text(`E-Way / LR Ref : ${s.lr || "-"}`, 300, 320);
    let y = itemTable(doc, s, 40, 338, 515, [["SlNo", .06, "left", "sr"], ["Item Description", .36, "left", "desc"], ["HSN Code", .11, "left", "hsn"], ["Quantity", .1, "right", "qty"], ["Unit", .08, "left", "uom"], ["Unit Price", .13, "right", "rate"], ["Taxable Amount", .16, "right", "amt"]], "#000", "#e9e9e9");
    doc.font("Helvetica-Bold").fontSize(10).text("4. Value Details", 40, y + 4);
    y += 22;
    [["Taxable Value", t.taxable], ...t.rows, ["Total Invoice Value", t.total]].forEach(([k, v], i) => doc.font(i === t.rows.length + 1 ? "Helvetica-Bold" : "Helvetica").fontSize(8.5).text(`${k} : ${inr(v)}`, 40, y + i * 14));
    doc.fontSize(7.5).fillColor("#555").text("Generated by e-Invoice system. Digitally signed by the Invoice Registration Portal.", 40, 760);
    signature(doc, 400, 640, s, c[0]);
  },

  async compact(doc, s, t, c) {
    logo(doc, 271, 30, 52, s.vendor.name, c[0], "circle");
    doc.font("Times-Bold").fontSize(18).fillColor("#111").text(s.vendor.name.toUpperCase(), 40, 90, { width: 515, align: "center" });
    doc.font("Times-Roman").fontSize(9.5).text(s.vendor.addr, 40, 112, { width: 515, align: "center" }).text(`GSTIN: ${s.vendor.gstin}    PAN: ${s.vendor.pan}${s.vendor.udyam ? `    UDYAM: ${s.vendor.udyam}` : ""}`, 40, 126, { width: 515, align: "center" });
    doc.font("Times-Bold").fontSize(12).fillColor(c[0]).text("TAX INVOICE / BILL", 40, 148, { width: 515, align: "center" });
    doc.moveTo(40, 166).lineTo(555, 166).strokeColor(c[0]).lineWidth(1.2).stroke();
    doc.font("Times-Roman").fontSize(10).fillColor("#111").text(`Bill No: ${s.no}`, 40, 176).text(`Dated: ${s.date.split("-").map((v, i) => i === 1 ? ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][+v] : v).join("-")}`, 380, 176, { width: 175, align: "right" })
      .text(`P.O. No.: ${s.po}`, 40, 192).text(`L.R. No.: ${s.lr || "-"}`, 380, 192, { width: 175, align: "right" });
    doc.text(`M/s. ${s.shipTo.name}`, 40, 214).text(s.shipTo.addr, 40, 228).text(`Buyer GSTIN: ${s.shipTo.gstin}`, 40, 242);
    let y = itemTable(doc, s, 40, 266, 515, [["#", .05, "left", "sr"], ["Particulars", .41, "left", "desc"], ["HSN/SAC", .12, "left", "hsn"], ["Qty", .1, "right", "qty"], ["Unit", .08, "left", "uom"], ["Rate", .11, "right", "rate"], ["Value", .13, "right", "amt"]], c[0], c[1], "Times-Roman");
    [["Sub Total", t.taxable], ...t.rows, ["Net Amount", t.total]].forEach(([k, v], i) => doc.font(k === "Net Amount" ? "Times-Bold" : "Times-Roman").fontSize(10).fillColor("#111").text(k, 360, y + i * 16).text(`Rs. ${inr(v)}`, 440, y + i * 16, { width: 115, align: "right" }));
    doc.font("Times-Italic").fontSize(9.5).text(`Rupees: ${words(t.total)}`, 40, y + (t.rows.length + 2) * 16 + 8, { width: 515 });
    doc.image(await qrPng(upiQr(s)), 40, 620, { width: 80 });
    doc.font("Times-Roman").fontSize(8).text("Scan & pay (UPI)", 40, 704);
    signature(doc, 400, 620, s, c[0]);
  },

  async modern(doc, s, t, c) {
    doc.rect(415, 0, 180, 842).fill(c[1]);
    logo(doc, 470, 34, 64, s.vendor.name, c[0], "hex");
    doc.fillColor("#111").font("Helvetica-Bold").fontSize(24).text("Invoice", 40, 40);
    doc.font("Helvetica").fontSize(9).fillColor("#666").text("Tax invoice under GST", 40, 70);
    doc.fillColor("#111").font("Helvetica-Bold").fontSize(11).text(s.vendor.name, 40, 100).font("Helvetica").fontSize(8.5).fillColor("#444").text(s.vendor.addr, 40, 116, { width: 340 })
      .text(`GSTIN ${s.vendor.gstin}   PAN ${s.vendor.pan}`, 40, 130);
    const side = [["Invoice Number", s.no], ["Invoice Date", s.date], ["Your PO Ref", s.po], ["Docket / LR", s.lr || "-"], ["Delivery Note", s.dn || "-"], ["Place of Supply", s.shipTo.gstin.slice(0, 2)]];
    side.forEach(([k, v], i) => { doc.fillColor("#777").font("Helvetica").fontSize(8).text(k.toUpperCase(), 432, 120 + i * 34); doc.fillColor("#111").font("Helvetica-Bold").fontSize(10).text(v, 432, 132 + i * 34, { width: 150 }); });
    doc.fillColor(c[0]).font("Helvetica-Bold").fontSize(9).text("INVOICE TO", 40, 166);
    doc.fillColor("#111").font("Helvetica").fontSize(9).text(s.shipTo.name, 40, 180).text(s.shipTo.addr, 40, 194, { width: 340 }).text(`Recipient GSTIN: ${s.shipTo.gstin}`, 40, 208);
    let y = itemTable(doc, s, 40, 240, 360, [["Item", .4, "left", "desc"], ["HSN", .13, "left", "hsn"], ["Qty", .1, "right", "qty"], ["UoM", .09, "left", "uom"], ["Price", .13, "right", "rate"], ["Amount", .15, "right", "amt"]], "#fff", c[0]);
    doc.roundedRect(40, y + 4, 360, (t.rows.length + 2) * 18 + 14, 8).fill(c[1]);
    [["Taxable Amount", t.taxable], ...t.rows, ["Amount Payable", t.total]].forEach(([k, v], i) => doc.fillColor(i === t.rows.length + 1 ? c[0] : "#111").font(i === t.rows.length + 1 ? "Helvetica-Bold" : "Helvetica").fontSize(i === t.rows.length + 1 ? 11 : 9).text(k, 54, y + 12 + i * 18).text(`INR ${inr(v)}`, 230, y + 12 + i * 18, { width: 156, align: "right" }));
    if (s.irn) { doc.image(await qrPng(einvoiceQr(s)), 452, 360, { width: 100 }); doc.fillColor("#555").font("Helvetica").fontSize(7).text("e-Invoice QR", 452, 464, { width: 100, align: "center" }); }
    signature(doc, 40, 640, s, c[0]);
  },
};

export async function make(s, outDir) {
  const layout = s.layout ?? "classic";
  const c = s.theme ?? THEMES[[...s.vendor.name].reduce((a, ch) => a + ch.charCodeAt(0), 0) % THEMES.length];
  const doc = new PDFDocument({ size: "A4", margin: 0, info: { Title: `Tax Invoice ${s.no}`, Author: s.vendor.name } });
  const done = new Promise(r => doc.pipe(fs.createWriteStream(path.join(outDir, s.file))).on("finish", r));
  await LAYOUT[layout](doc, s, totals(s), c);
  doc.font("Helvetica").fontSize(6.5).fillColor("#999").text("Demo invoice generated for testing. Not a real tax document.", 40, 815, { width: 515, align: "center" });
  doc.end();
  return done;
}
