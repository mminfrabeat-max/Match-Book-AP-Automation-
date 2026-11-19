// Simulated SAP. Reads/writes data/runtime/sap.json (a copy of data/sap-seed/sap.json).
// getContext() returns the same shape as the real RFC connector (sap-rfc.js / sap_rfc/ap_rfc.py),
// so the Validation Agent cannot tell the two apart.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./paths.js";
import { readJson, writeJson } from "./jsonfile.js";

const SEED = path.join(ROOT, "data", "sap-seed", "sap.json");
const FILE = path.join(ROOT, "data", "runtime", "sap.json");
const ATTACH = path.join(ROOT, "data", "runtime", "sap-attachments");

let db;

export function load() {
  if (!fs.existsSync(FILE)) reset();
  db = readJson(FILE);
  db.nextBelnr ??= 5105600001;
  return db;
}

export function reset() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.copyFileSync(SEED, FILE);
  fs.rmSync(ATTACH, { recursive: true, force: true });
  db = undefined;
}

function save() { writeJson(FILE, db); }
const tables = () => db ?? load();

export const label = () => "Simulated SAP";

export async function getContext(f) {
  const t = tables();
  const vendorByGstin = f.vendor_gstin ? t.vendors.find(v => v.GSTIN === f.vendor_gstin) ?? null : null;
  const po = f.po_no ? t.pos.find(p => p.EBELN === f.po_no) : null;
  if (!po) return { vendorByGstin, po: null, vendor: null, plant: null, grs: [], lots: [], ses: [], invoices: [], notes: [], poError: f.po_no ? `PO ${f.po_no} does not exist` : null };
  const grs = t.grs.filter(g => g.EBELN === po.EBELN);
  const ses = t.ses.filter(s => s.EBELN === po.EBELN);
  const invoices = t.invoices.filter(i => i.LIFNR === po.LIFNR);
  const items = po.items.map(it => {
    const received = po.TYPE === "SERVICE"
      ? ses.filter(s => s.RELEASED && s.EBELP === it.EBELP).reduce((a, s) => a + s.QTY, 0)
      : grs.filter(g => g.EBELP === it.EBELP).reduce((a, g) => a + g.MENGE, 0);
    const invoiced = t.invoices.filter(i => i.EBELN === po.EBELN).reduce((a, i) => a + (i.QTY || 0), 0);
    return { ...it, PO_UNIT: it.MEINS, MWSKZ: "", WEBRE: po.TYPE !== "SERVICE", QI_REQUIRED: !!it.QI, GR_QTY: received, IR_QTY: invoiced };
  });
  const pr = (t.pr ?? []).find(p => p.EBELN === po.EBELN);
  return {
    vendorByGstin, po: { ...po, items }, vendor: t.vendors.find(v => v.LIFNR === po.LIFNR) ?? null,
    plant: t.plants.find(p => p.WERKS === po.WERKS) ?? null,
    grs, lots: t.inspection_lots.filter(l => grs.some(g => g.MBLNR === l.MBLNR)), ses, invoices, notes: [],
    pr: pr ? Object.fromEntries(items.map(i => [i.EBELP, pr])) : {},
    delivery: items.filter(i => i.EINDT).map(i => ({ EBELP: i.EBELP, EINDT: i.EINDT, MENGE: i.MENGE, WEMNG: i.GR_QTY })),
    advances: (t.advances ?? []).filter(a => a.EBELN === po.EBELN).map(a => ({ ...a, BEWTP: "A" })),
    tds: (t.tds ?? []).filter(x => x.LIFNR === po.LIFNR),
    deliveryCosts: (t.delivery_costs ?? []).filter(x => x.EBELN === po.EBELN),
    shipmentCosts: (t.shipment_costs ?? []).filter(x => x.EBELN === po.EBELN),
    guarantees: (t.guarantees ?? []).filter(x => x.LIFNR === po.LIFNR).map(x => ({ ...x, LINKED: x.EBELN === po.EBELN })),
    users: {},
  };
}

// Monitor scan, same shape as ap_rfc.py monitor: open GR/IR, advances, late deliveries, open / rejected UD.
export async function monitor() {
  const t = tables(), today = new Date().toISOString().slice(0, 10);
  const days = d => Math.round((Date.parse(today) - Date.parse(d)) / 864e5);
  const who = ebeln => {
    const p = t.pos.find(x => x.EBELN === ebeln), v = t.vendors.find(x => x.LIFNR === p?.LIFNR), pr = (t.pr ?? []).find(x => x.EBELN === ebeln);
    return { LIFNR: p?.LIFNR ?? "", VENDOR: v?.NAME1 ?? "", BUYER: p?.ERNAM ?? "", BUKRS: p?.BUKRS ?? "", TXZ01: p?.items[0]?.TXZ01 ?? "", REQUESTOR: pr?.ERNAM ?? "", REQ_NAME: pr?.AFNAM ?? "" };
  };
  const grir = [], late = [];
  for (const p of t.pos) for (const it of p.items) {
    const gr = t.grs.filter(g => g.EBELN === p.EBELN && g.EBELP === it.EBELP);
    const received = gr.reduce((a, g) => a + g.MENGE, 0);
    const invoiced = t.invoices.filter(i => i.EBELN === p.EBELN).reduce((a, i) => a + (i.QTY || 0), 0);
    const last = gr.map(g => g.BUDAT).sort().pop();
    if (received - invoiced > 0) grir.push({ EBELN: p.EBELN, EBELP: it.EBELP, OPEN_QTY: received - invoiced, VALUE: (received - invoiced) * it.NETPR, LAST_GR: last, DAYS: days(last), ...who(p.EBELN) });
    if (it.EINDT && it.EINDT <= today && received < it.MENGE && p.TYPE !== "SERVICE") late.push({ EBELN: p.EBELN, EBELP: it.EBELP, EINDT: it.EINDT, OPEN: it.MENGE - received, DAYS_LATE: days(it.EINDT), ...who(p.EBELN) });
  }
  const advances = (t.advances ?? []).map(a => ({ EBELN: a.EBELN, AMOUNT: a.AMOUNT, PAID_ON: a.BUDAT, GR_DONE: t.grs.some(g => g.EBELN === a.EBELN), ...who(a.EBELN) }));
  const qm = t.inspection_lots.filter(l => l.UD !== "A").map(l => {
    const g = t.grs.find(x => x.MBLNR === l.MBLNR);
    return { PRUEFLOS: l.PRUEFLOS, EBELN: l.EBELN, EBELP: g?.EBELP ?? "00010", MBLNR: l.MBLNR, CREATED: g?.BUDAT ?? today, UD: l.UD, UD_CODE: l.UD_TEXT, ...who(l.EBELN) };
  });
  // vendor due list: posted, not fully paid invoices; net due = baseline + payment-term days (Z030 -> 30), MSME 45 days
  const addDays = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
  const due = t.invoices.filter(i => ["POSTED", "PART_PAID"].includes(i.STATUS)).map(i => {
    const p = t.pos.find(x => x.EBELN === i.EBELN), v = t.vendors.find(x => x.LIFNR === (i.LIFNR || p?.LIFNR));
    const paid = (i.PAYMENTS ?? []).reduce((a, x) => a + x.amount, 0), term = Number(String(p?.ZTERM ?? "").replace(/\D/g, "")) || 30;
    const base = i.BLDAT || i.POSTED_ON, dueOn = addDays(base, term), msmeDue = v?.MSME ? addDays(base, 45) : "";
    const payBy = msmeDue && msmeDue < dueOn ? msmeDue : dueOn;
    return { BUKRS: p?.BUKRS ?? t.company.BUKRS, LIFNR: v?.LIFNR ?? i.LIFNR, VENDOR: v?.NAME1 ?? "", MSME: !!v?.MSME, MSME_TYPE: v?.MSME ?? "", BELNR: i.FI_DOC, GJAHR: i.GJAHR,
      XBLNR: i.XBLNR, BLART: "RE", BLDAT: i.BLDAT, BASELINE: base, TERM_DAYS: term, ZTERM: p?.ZTERM ?? "", AMOUNT: +(i.RMWWR - paid).toFixed(2), PART_PAID: +paid.toFixed(2),
      CURRENCY: "INR", DUE: dueOn, MSME_DUE: msmeDue, PAY_BY: payBy, DAYS: -days(payBy), BLOCK: "" };
  }).sort((a, b) => a.PAY_BY.localeCompare(b.PAY_BY));
  return { grir, advances, late, qm, due, notes: [], asOf: today };
}

// Reverse data: status of parked documents (PARKED -> POSTED -> PART_PAID -> PAID), as ap_rfc.py status.
export async function status(docs) {
  const t = tables(), out = {};
  for (const d of docs) {
    const i = t.invoices.find(x => x.BELNR === d.belnr && x.GJAHR === d.gjahr);
    const pays = i?.PAYMENTS ?? [], paid = +pays.reduce((a, p) => a + p.amount, 0).toFixed(2);
    out[`${d.belnr}/${d.gjahr}`] = !i ? { status: "DELETED" } : { status: i.STATUS, fiDoc: i.FI_DOC, postedOn: i.POSTED_ON, paymentDoc: i.PAY_DOC, paidOn: i.PAID_ON,
      ...(pays.length ? { invoiceAmount: i.RMWWR, paidAmount: paid, openAmount: +(i.RMWWR - paid).toFixed(2), payments: pays, method: "partial payment" } : {}) };
  }
  return { docs: out, notes: [] };
}

// Demo only: what an AP user does in MIR4 and what the payment run does (F-53 part payment: half the open amount).
export function simulate(belnr, step) {
  const t = tables(), i = t.invoices.find(x => x.BELNR === belnr);
  if (!i) throw new Error(`Document ${belnr} not in mock SAP`);
  const today = new Date().toISOString().slice(0, 10);
  const pay = amount => { i.PAYMENTS = [...(i.PAYMENTS ?? []), { doc: String(1500000000 + Number(belnr.slice(-4)) * 10 + (i.PAYMENTS?.length ?? 0)), date: today, amount: +amount.toFixed(2) }]; };
  const open = () => +(i.RMWWR - (i.PAYMENTS ?? []).reduce((a, p) => a + p.amount, 0)).toFixed(2);
  if (step === "post" && i.STATUS === "PARKED") Object.assign(i, { STATUS: "POSTED", FI_DOC: String(5100000000 + Number(belnr.slice(-4))), POSTED_ON: today });
  else if (step === "partpay" && ["POSTED", "PART_PAID"].includes(i.STATUS)) { pay(Math.round(open() / 2)); Object.assign(i, { STATUS: "PART_PAID", PAY_DOC: i.PAYMENTS.at(-1).doc, PAID_ON: today }); }
  else if (step === "pay" && ["POSTED", "PART_PAID"].includes(i.STATUS)) { if (i.PAYMENTS) pay(open()); Object.assign(i, { STATUS: "PAID", PAY_DOC: i.PAYMENTS?.at(-1).doc ?? String(1500000000 + Number(belnr.slice(-4))), PAID_ON: today }); }
  else throw new Error(`Cannot ${step} a document that is ${i.STATUS.toLowerCase()}`);
  save();
  return i;
}

// Simulates BAPI_INCOMINGINVOICE_PARK.
export async function park(payload) {
  const t = tables();
  const belnr = String(t.nextBelnr++);
  const h = payload.HEADERDATA;
  const year = String(new Date().getFullYear());
  t.invoices.push({
    BELNR: belnr, GJAHR: year, LIFNR: payload._VENDOR, XBLNR: h.REF_DOC_NO, BLDAT: h.DOC_DATE, RMWWR: h.GROSS_AMOUNT, STATUS: "PARKED",
    EBELN: payload.ITEMDATA[0].PO_NUMBER, QTY: payload.ITEMDATA.reduce((a, i) => a + i.QUANTITY, 0), PARKED_AT: new Date().toISOString(),
  });
  save();
  return { RETURN: [{ type: "S", message: `Document ${belnr} was parked` }], INVOICEDOCNUMBER: belnr, FISCALYEAR: year };
}

// Simulates the GOS attachment (SO_DOCUMENT_INSERT_API1 + BINARY_RELATION_CREATE_COMMIT on BUS2081):
// one PDF per title in data/runtime/sap-attachments/<object>_<key>/.
export async function attachments(objtype, objkey) {
  const dir = path.join(ATTACH, `${objtype}_${objkey}`);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(x => x.endsWith(".pdf")).map(x => {
    const s = fs.statSync(path.join(dir, x));
    return { docId: `SIM-${objtype}-${objkey}-${x}`, title: x.replace(/\.pdf$/, ""), ext: "PDF", bytes: s.size, by: "SIMULATED", on: s.mtime.toISOString().slice(0, 10), file: path.relative(ROOT, path.join(dir, x)) };
  });
}

export async function attach(objtype, objkey, pdfPath, title = "Invoice") {
  if (objtype === "BUS2081" && !tables().invoices.some(i => i.BELNR + i.GJAHR === objkey)) throw new Error(`Invoice document ${objkey} does not exist`);
  const name = title.slice(0, 50).replace(/[\\/:*?"<>|]/g, "-");
  const have = await attachments(objtype, objkey), same = have.find(a => a.title === name);
  if (same) return { OBJECT: objtype, OBJECT_ID: objkey, ...same, already: true, count: have.length };
  const dir = path.join(ATTACH, `${objtype}_${objkey}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(pdfPath, path.join(dir, `${name}.pdf`));
  const now = await attachments(objtype, objkey);
  return { OBJECT: objtype, OBJECT_ID: objkey, ...now.find(a => a.title === name), already: false, count: now.length };
}

// Demo helper: create vendor / PO / GR in mock SAP from an extracted invoice, so any PDF can be
// walked through the flow. Never part of the real build.
export function seedFromInvoice(f) {
  const t = tables();
  const plt = t.plants.find(p => p.GSTIN === f.ship_to_gstin) ?? t.plants[0];
  let v = t.vendors.find(x => x.GSTIN === f.vendor_gstin);
  if (!v) {
    v = { LIFNR: String(200000 + t.vendors.length), NAME1: f.vendor_name || "Demo vendor", REGION: (f.vendor_gstin || "27").slice(0, 2),
      GSTIN: f.vendor_gstin, PAN: f.vendor_pan || (f.vendor_gstin || "").slice(2, 12), MSME: f.msme_udyam ? "Micro" : "", EMAIL: "" };
    t.vendors.push(v);
  }
  const lines = f.line_items?.length ? f.line_items : [{ desc: "Demo item", qty: 1, uom: "AU", rate: f.taxable_value || 0 }];
  const tax = (f.cgst || 0) + (f.sgst || 0) + (f.igst || 0);
  const rate = f.taxable_value && tax ? Math.round((tax / f.taxable_value) * 100) : 18;
  const ebeln = f.po_no && !t.pos.some(p => p.EBELN === f.po_no) ? f.po_no : String(4500090000 + t.pos.length);
  if (!t.pos.some(p => p.EBELN === ebeln)) {
    const items = lines.map((l, i) => ({ EBELP: String((i + 1) * 10).padStart(5, "0"), TXZ01: l.desc, MENGE: l.qty, MEINS: l.uom || "EA", NETPR: l.rate, GST_RATE: rate, QI: false }));
    t.pos.push({ EBELN: ebeln, LIFNR: v.LIFNR, BUKRS: t.company.BUKRS, WERKS: plt.WERKS, FRGKE: "R", ERNAM: "Demo buyer", ZTERM: "Z030", TYPE: "MATERIAL", TEXT: "Created by demo seed.", items });
    items.forEach(it => t.grs.push({ MBLNR: String(5000300000 + t.grs.length), MJAHR: "2026", ZEILE: "0001", BWART: "101", EBELN: ebeln, EBELP: it.EBELP,
      MENGE: it.MENGE, XBLNR: f.delivery_note || "", LR_NO: f.lr_no || "", BUDAT: new Date().toISOString().slice(0, 10) }));
  }
  save();
  return { vendor: v.LIFNR, po: ebeln };
}

export function snapshot() { return tables(); }
