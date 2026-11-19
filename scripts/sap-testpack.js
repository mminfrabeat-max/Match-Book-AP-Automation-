// Test pack for the live system: invoice PDFs built from real SAP POs (read over RFC, nothing is written),
// one per scenario, so every path of the app can be tried against S4T.
//   npm run sap:testpack              -> samples-sap/test-pack/*.pdf + scenarios.md
//   npm run sap:testpack -- --inbox   -> straight into invoices/inbox
import fs from "node:fs";
import path from "node:path";
import { INBOX, ROOT } from "../src/paths.js";
import * as rfc from "../src/sap-rfc.js";
import { make } from "./invoice-pdf.js";

const OUT = process.argv.includes("--inbox") ? INBOX : path.join(ROOT, "samples-sap", "test-pack");
fs.mkdirSync(OUT, { recursive: true });
const stamp = new Date().toISOString().slice(2, 10).replace(/-/g, "") + String(Date.now()).slice(-3);
const today = new Date().toISOString().slice(0, 10).split("-").reverse().join("-");
const toPdfDate = iso => iso.split("-").reverse().join("-");

// candidate POs: goods received, not invoiced
const open = await rfc.openItems(365);
if (!open.ok) { console.error(open.error?.message); process.exit(1); }
const ebelns = [...new Set(open.items.map(i => i.ebeln))].slice(0, 24);
const ctxs = [];
for (const e of ebelns) {
  const c = await rfc.getContext({ po_no: e });
  if (!c.po) continue;
  const items = c.po.items.map(i => ({ ...i, open: i.GR_QTY - i.IR_QTY })).filter(i => i.open > 0 && i.open < 100000 && i.NETPR > 0);
  if (items.length) ctxs.push({ ...c, openItems: items });
  process.stdout.write(".");
}
console.log(`\n${rfc.label()}: ${ctxs.length} usable POs`);
// vendors SAP can post (no deletion flag / posting block, central or company code) first, with a GSTIN before without
const postable = c => c.vendor && !c.vendor.DELETION_FLAG && !c.vendor.CC_DELETION_FLAG && !c.vendor.POSTING_BLOCK && !c.vendor.CC_POSTING_BLOCK && c.vendor.CC_EXISTS !== false;
const good = [...ctxs.filter(c => postable(c) && c.vendor.GSTIN), ...ctxs.filter(c => postable(c) && !c.vendor.GSTIN)];
const flagged = ctxs.filter(c => c.vendor && !postable(c));
const pick = (f, used) => good.find(c => f(c) && !used.has(c.po.EBELN)) ?? ctxs.find(c => f(c) && !used.has(c.po.EBELN));
const used = new Set();
const take = f => { const c = pick(f, used); if (c) used.add(c.po.EBELN); return c; };

function spec(c, o = {}) {
  const v = c.vendor ?? {};
  const gstin = o.gstin ?? (v.GSTIN || "27AAACZ9999Z1ZZ");
  const ship = c.plant?.GSTIN || (gstin.slice(0, 2) === "29" ? "27" : "29") + "AAACD1234F1Z5";
  const items = o.items ?? c.openItems.slice(0, 1);
  const no = o.no ?? `MB/${stamp}/${String(o.seq).padStart(2, "0")}`;
  return {
    file: `${o.code}_${c.po.EBELN}_${no.replace(/[\/\\]/g, "-")}.pdf`,
    vendor: { name: v.NAME1 || `Vendor ${c.po.LIFNR}`, addr: v.ADDRESS || "Registered office", gstin, pan: gstin.slice(2, 12) },
    shipTo: { name: `${c.plant?.NAME1 || "Plant"} (plant ${c.po.WERKS})`, addr: c.plant?.ADDRESS || "Delivery address as per PO", gstin: ship },
    layout: LAYOUTS[o.code] ?? "classic", no, date: o.date ?? today, po: o.po ?? c.po.EBELN, lr: "", dn: c.grs.filter(g => g.BWART === "101").pop()?.XBLNR || "",
    irn: ["einvoice", "banner", "modern"].includes(LAYOUTS[o.code]), signed: o.signed ?? true,
    lines: items.map(i => ({ desc: i.TXZ01, hsn: "9999", qty: o.qty?.(i) ?? i.open, uom: i.MEINS, rate: +(o.rate?.(i) ?? i.NETPR).toFixed(2) })),
    gst: { type: o.gstType ?? "IGST", rate: 18 },
  };
}

// a different layout for each scenario: structure, fonts, logo and QR code all vary
const LAYOUTS = { T01: "einvoice", T02: "banner", T03: "compact", T04: "modern", T05: "classic", T06: "banner", T07: "compact", T08: "modern", T09: "einvoice", T10: "classic", T11: "einvoice", T12: "banner", T13: "classic" };
const S = [];
const add = (code, title, expect, c, o) => { if (!c) { console.log(`skip ${code}: no suitable PO`); return; } S.push({ code, title, expect, po: c.po.EBELN, vendor: `${c.po.LIFNR} ${c.vendor?.NAME1 ?? ""}`, spec: spec(c, { ...o, code, seq: S.length + 1 }) }); };

const single = c => c.openItems.length === 1;
add("T01", "Clean invoice, full open quantity", "Ready to park (or Review only for missing SAP master data, e.g. plant GSTIN)", take(single));
add("T02", "Quantity higher than received", "Review: 3-way match warning, park suggests the received quantity", take(single), { qty: i => i.open + Math.max(1, Math.round(i.open * 0.2)) });
add("T03", "Rate 5% above PO price", "Review: rate outside 1% tolerance", take(single), { rate: i => i.NETPR * 1.05 });
const dupSrc = good.concat(ctxs).find(c => c.invoices?.some(i => i.XBLNR && i.STATUS === "POSTED"));
if (dupSrc) {
  const old = dupSrc.invoices.find(i => i.XBLNR && i.STATUS === "POSTED");
  add("T04", `Duplicate of posted invoice ${old.XBLNR} (doc ${old.BELNR})`, "Exception: duplicate invoice", dupSrc, { no: old.XBLNR, date: toPdfDate(old.BLDAT) });
}
add("T05", "Vendor GSTIN differs from vendor master", "Exception: GSTIN mismatch", take(c => !!c.vendor?.GSTIN), { gstin: "27AAACQ9999Q1ZQ" });
add("T06", "No stamp and no signature", "Exception: stamp and signature (overridable by AP controller)", take(() => true), { signed: false });
add("T07", "PO number that does not exist", "Exception: PO not found", ctxs[0], { po: "4599999999" });
add("T08", "Multi-line PO, part quantities", "Ready / Review with one line per PO item in the park payload", take(c => c.openItems.length > 1), { items: undefined, qty: i => Math.max(1, Math.floor(i.open / 2)) });
if (S.at(-1)?.code === "T08") S.at(-1).spec.lines = ctxs.find(c => c.po.EBELN === S.at(-1).po).openItems.map(i => ({ desc: i.TXZ01, hsn: "9999", qty: Math.max(1, Math.floor(i.open / 2)), uom: i.MEINS, rate: i.NETPR }));
add("T09", "PO with freight delivery cost", "Check 21 shows the delivery cost (EKBZ) and who it is payable to", ctxs.find(c => c.deliveryCosts?.length) ?? null);
add("T10", "CGST+SGST charged where the tax code is IGST", "Review: no tax code for CGST+SGST 18% in S4T config", take(single), { gstType: "CGST+SGST" });

{ // T11: printed amount raised after the e-invoice was registered; the QR still carries the real value
  const c = take(single) ?? ctxs[0];
  add("T11", "Printed total differs from the signed e-invoice QR (tampered print)", "Exception: QR total used, printed total flagged, amounts no longer add up (GST check)", c, { rate: i => i.NETPR * 1.1 });
  const s = S.at(-1); if (s?.code === "T11") { const it = c.openItems[0]; s.spec.qrTotal = it.open * it.NETPR * 1.18; }
}
{ // T12: e-invoice QR signed with an unknown key: looks like an e-invoice, was never registered on the portal
  add("T12", "Forged e-invoice QR (not signed by the IRP)", "Exception: e-invoice QR signature not valid, possible fake invoice", take(single) ?? ctxs[1] ?? ctxs[0]);
  const s = S.at(-1); if (s?.code === "T12") s.spec.qrForged = true;
}
// T13: vendor flagged for deletion / posting block in SAP: parked documents could never be posted
add("T13", "Vendor flagged for deletion in SAP", "Exception: vendor cannot be posted (stops before parking; AP controller may override)", flagged.find(c => !used.has(c.po.EBELN)) ?? flagged[0] ?? null);
for (const s of S) await make(s.spec, OUT);
const md = [`# Match Book test pack (${rfc.label()}, ${new Date().toLocaleString("en-IN")})`, "", "| File | Layout | Scenario | PO | Vendor | Expected |", "|---|---|---|---|---|---|",
  ...S.map(s => `| ${s.spec.file} | ${s.spec.layout}${s.spec.irn ? " + e-invoice QR" : s.spec.layout === "compact" ? " + UPI QR" : ""} | ${s.title} | ${s.spec.po} | ${s.vendor} | ${s.expect} |`)].join("\n");
if (!process.argv.includes("--inbox")) fs.writeFileSync(path.join(OUT, "scenarios.md"), md + "\n");
console.log(md);
console.log(`\nWrote ${S.length} PDFs to ${OUT}`);
