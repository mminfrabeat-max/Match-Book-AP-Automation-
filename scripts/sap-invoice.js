// Demo helper for real SAP: reads a PO from SAP over RFC and writes a matching vendor invoice PDF for
// the quantity received but not yet invoiced, so the live demo runs on real PO / GR data.
//   npm run sap:invoice -- 4500000992            invoice for the open GR quantity
//   npm run sap:invoice -- 4500000992 5 --inbox  invoice 5 units and put it straight into the inbox
//   npm run sap:invoice -- --list                PO items with goods received but not invoiced
import fs from "node:fs";
import path from "node:path";
import { INBOX, ROOT } from "../src/paths.js";
import * as rfc from "../src/sap-rfc.js";
import { make } from "./invoice-pdf.js";

const args = process.argv.slice(2);
if (args.includes("--list")) {
  const r = await rfc.openItems(365);
  if (!r.ok) { console.error(r.error?.message); process.exit(1); }
  console.log(`${rfc.label()} - PO items with goods received, not invoiced:`);
  r.items.forEach(i => console.log(`  ${i.ebeln} item ${Number(i.ebelp)}  open ${i.open}  last GR ${i.lastGr}`));
  process.exit(0);
}
const [ebeln, qtyArg] = args.filter(a => !a.startsWith("--"));
if (!ebeln) { console.error("Usage: npm run sap:invoice -- <PO number> [qty] [--inbox]   |   --list"); process.exit(1); }

const ctx = await rfc.getContext({ po_no: ebeln });
if (!ctx.po) { console.error(`PO ${ebeln}: ${ctx.poError || "not found"}`); process.exit(1); }
const open = ctx.po.items.map(i => ({ ...i, open: i.GR_QTY - i.IR_QTY })).filter(i => i.open > 0);
if (!open.length) { console.error(`PO ${ebeln} has nothing received and not yet invoiced`); process.exit(1); }

const v = ctx.vendor ?? {};
const gstin = v.GSTIN || "27AAACZ9999Z1ZZ";
const shipGstin = ctx.plant?.GSTIN || (gstin.slice(0, 2) === "29" ? "27" : "29") + "AAACD1234F1Z5";   // other state -> IGST, matches tax code T2
const no = `DEMO/${new Date().toISOString().slice(2, 10).replace(/-/g, "")}/${String(Date.now()).slice(-4)}`;
const lines = open.map(i => ({ desc: i.TXZ01, hsn: "9999", qty: qtyArg && open.length === 1 ? Number(qtyArg) : i.open, uom: i.MEINS, rate: i.NETPR }));
const last = ctx.grs.filter(g => g.BWART === "101").pop();
// --layout=classic|banner|einvoice|compact|modern (e-invoice QR on einvoice, banner and modern); --unsigned: no stamp / signature
const layout = (args.find(a => a.startsWith("--layout=")) ?? "--layout=classic").split("=")[1];
const spec = {
  file: `SAP_${ebeln}_${layout}_${no.replace(/\//g, "-")}.pdf`, layout,
  vendor: { name: v.NAME1 || `Vendor ${ctx.po.LIFNR}`, addr: v.ADDRESS || "Registered office (demo address)", gstin, pan: gstin.slice(2, 12) },
  shipTo: { name: `${ctx.plant?.NAME1 || "Plant"} (plant ${ctx.po.WERKS})`, addr: ctx.plant?.ADDRESS || "Delivery address as per PO", gstin: shipGstin },
  no, date: new Date().toISOString().slice(0, 10).split("-").reverse().join("-"), po: ebeln, lr: "", dn: last?.XBLNR || "",
  irn: ["einvoice", "banner", "modern"].includes(layout), signed: !args.includes("--unsigned"),   // --unsigned: no stamp, no signature
  lines, gst: { type: gstin.slice(0, 2) === shipGstin.slice(0, 2) ? "CGST+SGST" : "IGST", rate: 18 },   // same state -> CGST+SGST (S4T T1), else IGST (T2)
};
const outDir = args.includes("--inbox") ? INBOX : path.join(ROOT, "samples-sap");
fs.mkdirSync(outDir, { recursive: true });
await make(spec, outDir);
console.log(`${rfc.label()}: PO ${ebeln}, vendor ${ctx.po.LIFNR} ${v.NAME1 || ""}, company code ${ctx.po.BUKRS}`);
lines.forEach(l => console.log(`  ${l.desc}: ${l.qty} ${l.uom} @ ${l.rate}`));
console.log(`Wrote ${path.join(outDir, spec.file)}`);
if (!v.GSTIN) console.log("Note: vendor has no GSTIN in SAP; the invoice uses a placeholder GSTIN (check 2 will ask for a manual check).");
