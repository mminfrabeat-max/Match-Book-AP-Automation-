// AP Orchestration Agent: runs the agents in order for each invoice, keeps the queue, the event log
// (Dashboard Agent), the outbox (Mail Agent) and what the Learning Agent has learned.
// Invoice statuses: PROCESSING -> READY | REVIEW | EXCEPTION -> PARKED -> POSTED -> (PART_PAID) -> PAID   (or REJECTED)
import fs from "node:fs";
import path from "node:path";
import { PROCESSED, ROOT, stateFile } from "./paths.js";
import { readJson, writeJson } from "./jsonfile.js";
import { extract } from "./extract.js";
import { validate, buildParkPayload, findDuplicate } from "./validate.js";
import * as sap from "./sap.js";
import * as people from "./people.js";
import * as learning from "./learning.js";
import * as mail from "./mail.js";
import { classify, archiveMailFile } from "./intake.js";

const DMS = path.join(ROOT, "data", "dms");
let state, STATE;

export function init(mode, fresh = false) {
  STATE = stateFile(mode);
  state = fresh ? {} : readJson(STATE, {});
  state.seq ??= 0; state.invoices ??= []; state.mails ??= []; state.mailInSeq ??= 0; state.events ??= []; state.monitor ??= null;
  learning.init(state); mail.init(state);
  people.restore(state.people);
  for (const inv of state.invoices) { if (inv.ctx?.buyer) people.discover(inv.ctx.buyer, "BUYER"); if (inv.ctx?.requestor) people.discover(inv.ctx.requestor, "REQUESTOR"); }
}
export const save = () => { state.people = people.known(); writeJson(STATE, state); };
export const getState = () => state;
export const find = id => state.invoices.find(i => i.id === id);
export function resetState() { init(sap.mode, true); save(); }

const FINAL = ["PARKED", "POSTED", "PART_PAID", "PAID", "REJECTED"];
function event(agent, msg, ref = {}) {
  const e = { t: new Date().toISOString(), agent, msg, ...ref };
  state.events.unshift(e);
  if (state.events.length > 5000) state.events.length = 5000;
  return e;
}
const log = (inv, agent, msg) => { const e = event(agent, msg, { invoice: inv.id }); inv.log.push({ t: e.t, agent, msg }); };
const note = (msg) => mail.queue(state, msg);

// ---------------------------------------------------------------- intake
export async function ingest(file, cfg, source = { type: "Folder" }) {
  fs.mkdirSync(PROCESSED, { recursive: true });
  // take the file first (a locked file throws here, before an invoice number is used up), then number it
  const taken = path.join(PROCESSED, `${sap.mode}_taking_${Date.now()}_${path.basename(file)}`);
  if (source.data) fs.writeFileSync(taken, source.data);
  else try { fs.renameSync(file, taken); } catch (e) {
    if (e.code !== "EXDEV") throw e;                     // common folder on another drive / share: copy, then remove
    fs.copyFileSync(file, taken); fs.rmSync(file);
  }
  const id = `INV-${String(++state.seq).padStart(4, "0")}`;
  const stored = path.join(PROCESSED, `${sap.mode}_${id}_${path.basename(file)}`);
  fs.renameSync(taken, stored);
  const inv = { id, file: path.basename(file), stored: path.relative(ROOT, stored), received: new Date().toISOString(), source: { type: source.type, mail: source.mail, from: source.from },
    status: "PROCESSING", log: [], timings: { start: Date.now() } };
  state.invoices.unshift(inv);
  log(inv, "Invoice Reading Agent", source.type === "Mail" ? `Invoice ${inv.file} taken from mail ${source.mail} (${source.from})` : `Picked up ${inv.file} from the common folder`);
  save();
  try {
    const x = await extract(stored, cfg);
    inv.extraction = x;
    log(inv, "Data Extraction Agent", `Read ${Object.keys(x.confidence).length} fields with ${x.engine}`);
    x.warnings.forEach(w => log(inv, "Data Extraction Agent", w));
    if (!x.fields.invoice_no && !x.fields.po_no) { inv.status = "EXCEPTION"; inv.reason = "Could not read the invoice"; finish(inv); save(); return inv; }
    x.learned = learning.applyCorrections(state.learning, x.fields.vendor_gstin, x.fields, learning.correctAfter(cfg));
    for (const c of x.learned) log(inv, "Learning Agent", `Proposed ${c.field} "${c.from}" → "${c.to}" (same correction made ${c.times} times for this vendor, last by ${c.by}): a person confirms it`);
    await decide(inv, cfg);
  } catch (e) {
    inv.status = "EXCEPTION"; inv.reason = `Processing error: ${e.message}`;
    log(inv, "AP Orchestrator", inv.reason);
  }
  finish(inv); save();
  return inv;
}

export async function ingestMail(m, cfg, file) {
  const id = `MAIL-${String(++state.mailInSeq).padStart(4, "0")}`;
  const c = classify(m);
  const rec = { id, from: m.from, subject: m.subject, date: m.date || new Date().toISOString(), kind: c.kind, attachments: m.attachments.map(a => a.name), invoices: [], at: new Date().toISOString() };
  state.mails.unshift(rec);
  event("Orchestration Agent", `Mail ${id} from ${m.from}: "${m.subject}" → ${{ INVOICE: "invoice mail", STATUS_QUERY: "status question", NO_ATTACHMENT: "invoice mentioned but no PDF", OTHER: "not an invoice mail" }[c.kind]}`, { mail: id });
  if (file) rec.file = archiveMailFile(file, id);
  const sender = (m.from.match(/<([^>]+)>/)?.[1] ?? m.from).trim();
  if (c.kind === "INVOICE") {
    for (const a of c.pdfs) {
      const inv = await ingest(a.name, cfg, { type: "Mail", mail: id, from: sender, data: a.data });
      rec.invoices.push(inv.id);
    }
  } else if (c.kind === "STATUS_QUERY") {
    const norm = s => (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const inv = state.invoices.find(i => norm(i.extraction?.fields.invoice_no) === norm(c.invNo));
    const st = inv ? statusText(inv) : `we have not received invoice ${c.invNo} yet. Please send it as a PDF attachment to this mailbox`;
    rec.reply = note({ channel: "Email", to: sender, subject: `Re: ${m.subject}`, agent: "Mail Agent", ref: { mail: id, invoice: inv?.id },
      text: `Dear Sir/Madam,\n\nRegarding invoice ${c.invNo}: ${st}.\n\nRegards,\nAccounts Payable, ${cfg.appName}` }).id;
  } else if (c.kind === "NO_ATTACHMENT") {
    rec.reply = note({ channel: "Email", to: sender, subject: `Re: ${m.subject}`, agent: "Mail Agent", ref: { mail: id },
      text: `Dear Sir/Madam,\n\nThank you for your mail. We could not find the invoice${c.invNo ? ` ${c.invNo}` : ""} as a PDF attachment. Please send the signed tax invoice as a PDF, with the PO number on it.\n\nRegards,\nAccounts Payable, ${cfg.appName}` }).id;
  } else {
    note({ channel: "Teams", to: people.withRole("AP_CONTROLLER").map(p => p.id), subject: "Mail needs a person", agent: "Mail Agent", ref: { mail: id },
      text: `Mail from ${sender} "${m.subject}" is not about an invoice. Left for the AP team.` });
  }
  save();
  return rec;
}

function statusText(inv) {
  const f = inv.extraction?.fields ?? {}, s = inv.sapStatus ?? {};
  return {
    PAID: `paid on ${s.paidOn} (payment document ${s.paymentDoc})`,
    PART_PAID: `partly paid: ${s.paidAmount?.toLocaleString("en-IN")} of ${s.invoiceAmount?.toLocaleString("en-IN")} INR paid, last payment on ${s.paidOn} (document ${s.paymentDoc}); ${s.openAmount?.toLocaleString("en-IN")} INR still open`,
    POSTED: `booked on ${s.postedOn}; payment follows as per payment terms`,
    PARKED: `received and under booking (document ${inv.park?.result.INVOICEDOCNUMBER})`,
    READY: "received and checked; booking in progress", REVIEW: "received and under review by our AP team",
    EXCEPTION: `received but on hold: ${inv.reason}`, REJECTED: `not accepted: ${inv.reason}`, PROCESSING: "received, being processed",
  }[inv.status] + (f.total ? ` (amount ${f.total.toLocaleString("en-IN")} INR)` : "");
}

function finish(inv) { inv.timings.ms = Date.now() - inv.timings.start; }

// ---------------------------------------------------------------- decide
async function decide(inv, cfg) {
  const x = inv.extraction, f = x.fields;
  const t0 = Date.now();
  const ctx = await sap.getContext(f);
  const v = validate(f, ctx, cfg, x.confidence);
  const learned = learning.relax(state.learning, f.vendor_gstin, v.checks, cfg);
  if (learned.length) log(inv, "Learning Agent", `Accepted warning(s) on check ${learned.join(", ")} automatically (approved repeatedly before)`);
  // 27: values the Learning Agent filled in are proposals until a person confirms them (Correct values, or Approve)
  if (x.learned?.length) v.checks.push({ id: 27, name: "Learning Agent proposal", status: "WARN", invoice: null, sap: null,
    detail: `Filled in from earlier corrections, please confirm: ${x.learned.map(c => `${c.field} "${c.from}" → "${c.to}" (made ${c.times}×)`).join("; ")}` });
  if (learned.length || x.learned?.length) {
    const b = v.checks.filter(c => c.status === "BLOCK"), w = v.checks.filter(c => c.status === "WARN");
    const uniq = a => [...new Set(a.map(c => c.name.replace(/ \(item \d+\)$/, "")))].join(", ");
    v.decision = b.length ? "EXCEPTION" : w.length ? "REVIEW" : "PARK";
    v.reason = b.length ? uniq(b) : w.length ? uniq(w) : "All checks passed";
  }
  inv.checks = v.checks;
  const buyer = ctx.po?.ERNAM || null;
  const requestor = Object.values(ctx.pr ?? {})[0]?.ERNAM || null;
  if (buyer) people.discover(buyer, "BUYER", ctx.users?.[buyer]);
  if (requestor) people.discover(requestor, "REQUESTOR", ctx.users?.[requestor]);
  const category = ctx.po?.TYPE === "SERVICE" ? "SERVICE" : (ctx.vendor?.MSME || f.msme_udyam) ? "MSME" : "MATERIAL";
  inv.category = category;
  inv.assignedTo = people.route(cfg, { category, companyCode: ctx.po?.BUKRS, plant: ctx.plant?.WERKS });
  const V = ctx.vendor ?? ctx.vendorByGstin;
  inv.sapVendor = V && { address: V.ADDRESS, pan: V.PAN, panSource: V.PAN_SOURCE, msme: V.MSME, gstRegistered: V.GST_REGISTERED ?? !!V.GSTIN, email: V.EMAIL, region: V.REGION, deletionFlag: V.DELETION_FLAG };
  inv.costs = { delivery: ctx.deliveryCosts ?? [], shipment: ctx.shipmentCosts ?? [] };
  inv.ctx = { vendor: ctx.po?.LIFNR ?? ctx.vendorByGstin?.LIFNR, vendorName: V?.NAME1 ?? f.vendor_name, vendorEmail: V?.EMAIL,
    po: ctx.po?.EBELN, companyCode: ctx.po?.BUKRS, plant: ctx.plant?.WERKS, plantName: ctx.plant?.NAME1, buyer, requestor,
    msme: ctx.vendor?.MSME || (f.msme_udyam ? "Udyam" : ""), taxCode: v.taxCode, sap: sap.label() };
  log(inv, "SAP Integration Agent", ctx.po
    ? `${sap.label()}: PO ${ctx.po.EBELN} (${ctx.po.items.length} item(s)), vendor ${ctx.po.LIFNR}, ${ctx.grs.length} GR line(s), ${ctx.lots.length} QM lot(s), ${ctx.invoices.length} earlier invoice(s) in ${((Date.now() - t0) / 1000).toFixed(1)} s`
    : `${sap.label()}: ${ctx.poError || "PO not found"}`);
  log(inv, "Invoice Reading Agent", `Category ${category}, company code ${ctx.po?.BUKRS ?? "-"}, plant ${ctx.plant?.WERKS ?? "-"} → queue of ${people.name(inv.assignedTo)}`);
  const qi = v.checks.find(c => c.id === 9);
  if (qi && qi.status !== "NA") log(inv, "Quality Inspection Agent", qi.detail);
  const nb = v.checks.filter(c => c.status === "BLOCK").length, nw = v.checks.filter(c => c.status === "WARN").length;
  log(inv, "Validation Agent", `${v.checks.length} checks: ${nb} block, ${nw} warning → ${v.decision === "PARK" ? "high confidence" : "low confidence"}`);
  inv.reason = v.reason;
  inv.suggested = Object.fromEntries(v.pairs.filter(p => p.item).map(({ line, item }) => [item.EBELP, Math.max(0, Math.min(line.qty, item.GR_QTY - item.IR_QTY))]));
  inv.lines = v.pairs.map(({ line, item }) => ({ desc: line.desc, qty: line.qty, ebelp: item?.EBELP ?? null, open: item ? item.GR_QTY - item.IR_QTY : null, uom: item?.MEINS ?? line.uom }));
  inv.overridable = v.decision === "EXCEPTION" && v.checks.filter(c => c.status === "BLOCK").every(c => cfg.overridableChecks.includes(c.id));
  alertOwners(inv, v, f, ctx);

  const auto = sap.mode === "rfc" ? cfg.sap.autoParkInRealSap : cfg.autoPark;
  if (v.decision === "PARK" && auto) return park(inv, cfg, null, "Posting Agent: auto-parked, all checks passed");
  inv.status = v.decision === "PARK" ? "READY" : v.decision;
  log(inv, "AP Orchestrator", inv.status === "READY" ? `All checks passed. Waiting for ${people.name(inv.assignedTo)} to park it in ${sap.label()}`
    : inv.status === "REVIEW" ? `Human Review Agent: sent to ${people.name(inv.assignedTo)} (${v.reason})` : `Exception: ${v.reason}`);
}

function alertOwners(inv, v, f, ctx) {
  const vend = ctx.vendor ?? ctx.vendorByGstin, order = ctx.po, ref = { invoice: inv.id, po: order?.EBELN };
  const ctrl = people.withRole("AP_CONTROLLER").map(p => p.id);
  const buyer = order?.ERNAM, mgr = people.person(buyer)?.manager;
  for (const c of v.checks) {
    if (c.id === 9 && c.status === "BLOCK" && /reject/i.test(c.detail)) {
      note({ channel: "Email", to: [buyer, mgr, ...ctrl, vend?.EMAIL].filter(Boolean), subject: `Material rejected - PO ${order.EBELN}, invoice ${f.invoice_no}`, agent: "Quality Inspection Agent", ref,
        text: `${c.detail}. Invoice ${f.invoice_no} from ${vend?.NAME1} is on hold. Stores: post movement 122 now and keep the material in the rejection area with a tag. Finance books the credit note on the 122 document.` });
      note({ channel: "Teams", to: people.withRole("STORES").map(p => p.id), subject: `Post 122 for PO ${order.EBELN}`, agent: "Quality Inspection Agent", ref, text: `Usage decision rejected (${c.detail}). Post return delivery 122 and share the document with Finance.` });
    }
    if (c.id === 11 && c.status === "BLOCK") note({ channel: "Teams", to: ctrl, subject: `Duplicate invoice ${f.invoice_no}`, agent: "Validation Agent", ref, text: `${vend?.NAME1}: ${c.detail}. Invoice blocked.` });
    if (c.id === 6 && c.status === "WARN" && buyer) note({ channel: "Teams", to: [buyer], subject: `Invoice ${f.invoice_no}: quantity/rate`, agent: "Validation Agent", ref, text: `${c.detail}. Confirm the short receipt or ask the vendor for a credit note.` });
    if (c.id === 18 && c.status === "WARN") note({ channel: "Teams", to: [inv.assignedTo, buyer].filter(Boolean), subject: `Advance to clear on PO ${order.EBELN}`, agent: "Open GR/IR and Advances Agent", ref, text: c.detail });
    if (c.id === 15) note({ channel: "Teams (MSME tile)", to: ctrl, subject: `MSME invoice ${f.invoice_no}`, agent: "MSME Notification Agent", ref, text: `${vend?.NAME1 ?? f.vendor_name}: 45-day payment clock running from acceptance.` });
    if (c.id === 0 && c.status === "WARN") note({ channel: "Teams", to: [inv.assignedTo], subject: `Check extracted values: ${f.invoice_no}`, agent: "Human Review Agent", ref, text: c.detail });
  }
}

// ---------------------------------------------------------------- park + DMS
async function park(inv, cfg, qtys, msg) {
  const f = inv.extraction.fields;
  const ctx = await sap.getContext(f);          // re-read: SAP may have changed since the check
  // An earlier attempt got no answer (timeout, lost connection) but may have parked it all the same: look in SAP first
  // and take that document over, instead of parking a second one (or stopping on the duplicate check).
  const earlier = inv.parkAttempt && findDuplicate(f, ctx);
  if (earlier && ["PARKED", "POSTED"].includes(earlier.STATUS) && Math.abs((earlier.RMWWR ?? 0) - inv.parkAttempt.gross) <= 1) {
    const result = { RETURN: [{ type: "S", message: `Found document ${earlier.BELNR}/${earlier.GJAHR} in SAP from the attempt of ${inv.parkAttempt.at.slice(0, 16).replace("T", " ")}: taken over, not parked again` }],
      INVOICEDOCNUMBER: earlier.BELNR, FISCALYEAR: earlier.GJAHR };
    return booked(inv, cfg, ctx, inv.parkAttempt.payload, result, `${msg} (recovered)`);
  }
  const v = validate(f, ctx, cfg, inv.extraction.confidence);
  const blocks = v.checks.filter(c => c.status === "BLOCK");
  if (blocks.length && !(inv.override && blocks.every(c => cfg.overridableChecks.includes(c.id)))) throw new Error(`Not parked: SAP now reports ${v.reason}`);
  if (!v.taxCode) throw new Error("Not parked: no tax code (see check 8)");
  const payload = buildParkPayload(f, v, ctx, cfg, qtys ?? {});
  if (!payload.ITEMDATA.length || payload.ITEMDATA.every(i => !i.QUANTITY)) throw new Error("Not parked: nothing open to invoice on this PO");
  inv.parkAttempt = { at: new Date().toISOString(), gross: payload.HEADERDATA.GROSS_AMOUNT, payload };
  save();                                       // remembered before the call, so a crash or timeout leaves a trace
  let result;
  try { result = await sap.park(payload, path.join(ROOT, inv.stored)); }
  catch (e) {
    // SAP answered "no" (and rolled back): nothing was parked. No answer at all: it may have been, so keep the attempt.
    if (/did not answer|timeout|worker|connection|communication|RFC_INVALID|ECONN/i.test(e.message))
      throw new Error(`${e.message}. Match Book will look for it in SAP before parking again, so it is safe to retry.`);
    delete inv.parkAttempt;
    throw e;
  }
  return booked(inv, cfg, ctx, payload, result, msg);
}

async function booked(inv, cfg, ctx, payload, result, msg) {
  const f = inv.extraction.fields;
  delete inv.parkAttempt;
  inv.park = { bapi: "BAPI_INCOMINGINVOICE_PARK", payload, result, bukrs: ctx.po?.BUKRS, at: new Date().toISOString() };
  inv.status = "PARKED"; inv.sapStatus = { status: "PARKED" };
  log(inv, "MIRO Parking Agent", `${msg}. ${sap.label()}: ${result.RETURN.map(r => r.message).join(" ") || `document ${result.INVOICEDOCNUMBER} parked`}`);
  if (cfg.attachPdfInSap !== false) await attachToSap(inv);
  dms(inv, ctx);
  note({ channel: "Teams", to: [inv.assignedTo], subject: `Parked ${result.INVOICEDOCNUMBER}`, agent: "MIRO Parking Agent", ref: { invoice: inv.id },
    text: `${f.vendor_name}, ${f.invoice_no}, ${f.total?.toLocaleString("en-IN")} INR parked as ${result.INVOICEDOCNUMBER}/${result.FISCALYEAR}. Check and post in MIR4.` });
  if (sap.mode === "mock") runMonitor(cfg, { notify: false }).catch(() => {});   // keep GR/IR lists current (real SAP: next scheduled scan)
  return inv;
}

// Invoice PDF -> GOS attachments in SAP, so it opens from the screens people use (Services for Object > Attachment list):
// the MIRO invoice document (BUS2081, MIR4), each purchase order on it (BUS2012, ME23N) and, once posted, the FI
// document (BKPF, FB03). A failed attachment never undoes the park: it is logged and can be repeated from the invoice.
function sapTargets(inv) {
  const r = inv.park.result, s = inv.sapStatus ?? {};
  const t = [{ object: "BUS2081", key: r.INVOICEDOCNUMBER + r.FISCALYEAR, label: `invoice document ${r.INVOICEDOCNUMBER}/${r.FISCALYEAR}`, tcode: "MIR4" }];
  for (const po of new Set(inv.park.payload.ITEMDATA.map(i => i.PO_NUMBER).filter(Boolean)))
    t.push({ object: "BUS2012", key: po, label: `purchase order ${po}`, tcode: "ME23N" });
  const bukrs = s.fiBukrs || inv.park.bukrs;
  if (s.fiDoc && bukrs) {
    const belnr = String(s.fiDoc).padStart(10, "0"), year = s.fiYear || r.FISCALYEAR;
    t.push({ object: "BKPF", key: bukrs + belnr + year, label: `FI document ${bukrs}/${Number(belnr)}/${year}`, tcode: "FB03" });
  }
  return t;
}

async function attachToSap(inv, user) {
  const f = inv.extraction.fields, r = inv.park.result, title = `Invoice ${f.invoice_no || inv.id}`.slice(0, 50);
  // invoices parked before PO / FI attachments existed: keep their invoice-document attachment
  inv.sapAttachments ??= inv.sapAttachment?.ok ? [{ ...inv.sapAttachment, label: `invoice document ${r.INVOICEDOCNUMBER}/${r.FISCALYEAR}`, tcode: "MIR4" }] : [];
  delete inv.sapAttachment;
  // posted before the company code was kept with the park: SAP's status read gives it
  if (inv.sapStatus?.fiDoc && !inv.sapStatus.fiBukrs && !inv.park.bukrs) {
    try { const s = (await sap.status([{ belnr: r.INVOICEDOCNUMBER, gjahr: r.FISCALYEAR }])).docs[`${r.INVOICEDOCNUMBER}/${r.FISCALYEAR}`]; if (s?.fiBukrs) inv.sapStatus.fiBukrs = s.fiBukrs; } catch { /* FI attachment waits */ }
  }
  for (const t of sapTargets(inv)) {
    const i = inv.sapAttachments.findIndex(x => x.object === t.object && x.key === t.key);
    if (inv.sapAttachments[i]?.ok) continue;
    let rec;
    try {
      const a = await sap.attach(t.object, t.key, path.join(ROOT, inv.stored), title);
      rec = { ok: true, ...t, title: a.title, docId: a.docId, bytes: a.bytes, count: a.count, at: new Date().toISOString(), by: user?.name ?? "agent" };
      log(inv, "DMS Update Agent", a.already ? `"${a.title}" was already attached to the ${t.label} in ${sap.label()}`
        : `Invoice PDF attached in ${sap.label()} to the ${t.label} (${t.object}, "${a.title}"): ${t.tcode} > Services for Object > Attachment list`);
    } catch (e) {
      rec = { ok: false, ...t, error: e.message, at: new Date().toISOString() };
      log(inv, "DMS Update Agent", `Invoice PDF not attached to the ${t.label} (${e.message}); use "Attach PDF in SAP" to try again`);
    }
    if (i >= 0) inv.sapAttachments[i] = rec; else inv.sapAttachments.push(rec);
  }
  return inv.sapAttachments;
}

export async function attachPdf(id, user) {
  const inv = find(id);
  if (!inv?.park?.result?.INVOICEDOCNUMBER) throw new Error("Only parked invoices can get their PDF attached in SAP");
  const all = await attachToSap(inv, user);
  save();
  const bad = all.filter(a => !a.ok);
  if (bad.length) throw new Error(bad.map(a => `${a.label}: ${a.error}`).join("; "));
  return inv;
}

function dms(inv, ctx) {
  const r = inv.park.result, f = inv.extraction.fields;
  const dir = path.join(DMS, ctx.po?.BUKRS || "NA", r.FISCALYEAR || "NA", inv.ctx.vendor || "NA");
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `${r.INVOICEDOCNUMBER}_${(f.invoice_no || inv.id).replace(/[^\w-]/g, "-")}`);
  fs.copyFileSync(path.join(ROOT, inv.stored), `${base}.pdf`);
  const meta = { document: r.INVOICEDOCNUMBER, fiscalYear: r.FISCALYEAR, companyCode: ctx.po?.BUKRS, vendor: inv.ctx.vendor, vendorName: inv.ctx.vendorName, invoiceNo: f.invoice_no,
    invoiceDate: f.invoice_date, po: ctx.po?.EBELN, gross: f.total, status: inv.sapStatus, checks: inv.checks.map(c => ({ id: c.id, name: c.name, status: c.status })), source: inv.source, parkedAt: inv.park.at };
  fs.writeFileSync(`${base}.json`, JSON.stringify(meta, null, 2));
  inv.dms = path.relative(ROOT, `${base}.pdf`);
  log(inv, "DMS Update Agent", `Invoice and its data stored in DMS: ${inv.dms}`);
}

// ---------------------------------------------------------------- human review
const busy = new Set();
export async function approve(id, cfg, user, qtys) {
  const inv = find(id);
  if (!inv || !["REVIEW", "READY"].includes(inv.status)) throw new Error("Only invoices in review or ready can be parked");
  if (busy.has(id)) throw new Error("Already being parked");
  busy.add(id);
  try {
    const wasReview = inv.status === "REVIEW";
    await park(inv, cfg, qtys ?? inv.suggested, `${wasReview ? "Approved" : "Parked"} by ${user.name}`);
    if (wasReview) learning.recordApproval(state.learning, inv.extraction.fields.vendor_gstin, inv.checks, cfg, user.name);
  } catch (e) { log(inv, "MIRO Parking Agent", e.message); save(); throw e; }
  finally { busy.delete(id); }
  save(); return inv;
}

export async function override(id, cfg, user, reason) {
  const inv = find(id);
  if (!inv || inv.status !== "EXCEPTION" || !inv.overridable) throw new Error("This exception cannot be overridden (duplicate, PO, vendor, quantity and QC blocks never can)");
  if (!reason || reason.trim().length < 5) throw new Error("Give a reason for the override");
  inv.override = { by: user.name, reason: reason.trim(), at: new Date().toISOString() };
  log(inv, "Human Review Agent", `Override approved by ${user.name}: ${reason.trim()}`);
  try { await park(inv, cfg, inv.suggested, `Parked on override by ${user.name}`); }
  catch (e) { log(inv, "MIRO Parking Agent", e.message); save(); throw e; }
  save(); return inv;
}

export function reject(id, user, why) {
  const inv = find(id);
  if (!inv || FINAL.includes(inv.status)) throw new Error("Cannot reject this invoice");
  inv.status = "REJECTED"; inv.reason = why || inv.reason;
  log(inv, "Human Review Agent", `Rejected by ${user.name}: ${inv.reason}`);
  learning.recordRejection(state.learning, inv.extraction?.fields.vendor_gstin, inv.checks ?? []);
  const f = inv.extraction?.fields ?? {};
  note({ channel: "Email", to: [inv.ctx?.vendorEmail || inv.source?.from, inv.ctx?.buyer].filter(Boolean), subject: `Invoice ${f.invoice_no ?? inv.file} not booked`, agent: "Mail Agent", ref: { invoice: id },
    text: `Dear Sir/Madam,\n\nYour invoice ${f.invoice_no ?? ""} dated ${f.invoice_date ?? ""} could not be booked: ${inv.reason}. Please send a corrected invoice or credit note.\n\nRegards,\nAccounts Payable` });
  save(); return inv;
}

const EDITABLE = ["vendor_name", "vendor_gstin", "vendor_pan", "ship_to_gstin", "ship_to_name", "ship_to_address", "invoice_no", "invoice_date", "po_no", "lr_no", "delivery_note", "irn", "msme_udyam", "taxable_value", "cgst", "sgst", "igst", "total"];
const NUMERIC = ["taxable_value", "cgst", "sgst", "igst", "total"];
export async function correct(id, cfg, user, changes = {}, lines = null) {
  const inv = find(id);
  if (!inv?.extraction || FINAL.includes(inv.status)) throw new Error("This invoice cannot be changed");
  const f = inv.extraction.fields, done = [];
  const proposed = inv.extraction.learned ?? [];
  for (const [k, raw] of Object.entries(changes)) {
    if (!EDITABLE.includes(k)) continue;
    const val = raw === "" || raw == null ? null : NUMERIC.includes(k) ? Number(String(raw).replace(/[^\d.\-]/g, "")) : String(raw).trim();
    if (String(f[k] ?? "") === String(val ?? "")) continue;
    const p = proposed.find(c => c.field === k);
    if (p && String(val ?? "") === String(p.from ?? "")) {        // reviewer put back what was read: the proposal was wrong
      learning.undoCorrection(state.learning, changes.vendor_gstin ?? f.vendor_gstin, k, p.from);
      log(inv, "Learning Agent", `${user.name} undid the proposal for ${k}; it has to be learned again`);
    } else learning.recordCorrection(state.learning, changes.vendor_gstin ?? f.vendor_gstin, k, p ? p.from : f[k], val, user.name);
    done.push(`${k}: "${f[k] ?? ""}" → "${val ?? ""}"`);
    f[k] = val; inv.extraction.confidence[k] = 1;
  }
  if (Array.isArray(lines)) lines.forEach((l, i) => {
    const t = f.line_items[i]; if (!t) return;
    for (const k of ["qty", "rate"]) if (l[k] != null && Number(l[k]) !== t[k]) { done.push(`line ${i + 1} ${k}: ${t[k]} → ${Number(l[k])}`); t[k] = Number(l[k]); }
    t.amount = +(t.qty * t.rate).toFixed(2);
  });
  f.gst_type = f.igst ? "IGST" : f.cgst || f.sgst ? "CGST+SGST" : null;
  log(inv, "Human Review Agent", done.length ? `${user.name} corrected ${done.join("; ")}. Re-validating.` : `${user.name} confirmed the extracted values. Re-validating.`);
  for (const k of EDITABLE) if (f[k] != null) inv.extraction.confidence[k] = Math.max(inv.extraction.confidence[k] ?? 0, 1);
  if (proposed.length) { inv.extraction.confirmedLearned = proposed; delete inv.extraction.learned; }   // a person has looked at them now
  await decide(inv, cfg); save(); return inv;
}

export async function revalidate(id, cfg) {
  const inv = find(id);
  if (!inv?.extraction || FINAL.includes(inv.status)) throw new Error("Nothing to re-run");
  log(inv, "AP Orchestrator", "Re-running SAP fetch and validation");
  await decide(inv, cfg); save(); return inv;
}

export async function seedAndRerun(id, cfg) {
  if (sap.mode !== "mock") throw new Error("Only possible with simulated SAP");
  const inv = find(id);
  if (!inv?.extraction) throw new Error("No extracted data");
  const r = sap.mock.seedFromInvoice(inv.extraction.fields);
  log(inv, "Demo", `Created vendor ${r.vendor} / PO ${r.po} / GRN in mock SAP from this invoice`);
  inv.extraction.fields.po_no = r.po;
  return revalidate(id, cfg);
}

// ---------------------------------------------------------------- reverse data (posted / paid)
export async function syncStatus({ attach = true } = {}) {
  // also re-checks documents once reported deleted / reversed: if SAP shows them again, the invoice comes back
  const gone = i => i.status === "EXCEPTION" && ["DELETED", "REVERSED"].includes(i.sapStatus?.status);
  const open = state.invoices.filter(i => (["PARKED", "POSTED", "PART_PAID"].includes(i.status) || gone(i)) && i.park);
  if (!open.length) return { checked: 0, changed: 0 };
  const r = await sap.status(open.map(i => ({ belnr: i.park.result.INVOICEDOCNUMBER, gjahr: i.park.result.FISCALYEAR })));
  let changed = 0;
  for (const inv of open) {
    const s = r.docs[`${inv.park.result.INVOICEDOCNUMBER}/${inv.park.result.FISCALYEAR}`];
    // a further part payment keeps the status but changes the amount paid
    if (!s || (s.status === inv.sapStatus?.status && (s.paidAmount ?? 0) === (inv.sapStatus?.paidAmount ?? 0))) continue;
    changed++;
    const before = inv.sapStatus;
    const back = gone(inv) && !["DELETED", "REVERSED"].includes(s.status);
    inv.sapStatus = s;
    const f = inv.extraction.fields, ref = { invoice: inv.id };
    // back in SAP after a wrong "deleted": restore quietly (people were told about these steps already) and drop the
    // duplicate block a re-run raised against the invoice's own SAP document
    const note = back ? () => {} : msg => mail.queue(state, msg);
    if (back) {
      log(inv, "Reverse Data Agent", `Document ${inv.park.result.INVOICEDOCNUMBER} is in SAP after all (${s.status.toLowerCase()}): status restored`);
      inv.reason = `Status from SAP: ${s.status.toLowerCase().replace("_", " ")}`;
      for (const c of inv.checks ?? []) if (c.id === 11 && c.status === "BLOCK" && String(c.sap) === String(inv.park.result.INVOICEDOCNUMBER))
        Object.assign(c, { status: "INFO", detail: `Matches this invoice's own SAP document ${c.sap}` });
    }
    const amt = n => Number(n ?? 0).toLocaleString("en-IN", { minimumFractionDigits: 2 });
    if (["PART_PAID", "PAID"].includes(s.status) && before?.status === "PARKED" && s.fiDoc) log(inv, "Reverse Data Agent", `Posted in SAP: FI document ${s.fiDoc} on ${s.postedOn ?? "-"}`);
    if (s.status === "POSTED") {
      inv.status = "POSTED";
      log(inv, "Reverse Data Agent", `Posted in SAP: FI document ${s.fiDoc ?? "-"} on ${s.postedOn ?? "-"}`);
      note({ channel: "Teams", to: [inv.ctx.requestor || inv.ctx.buyer].filter(Boolean), subject: `Invoice ${f.invoice_no} booked`, agent: "Reverse Data Agent", ref, text: `${f.vendor_name} invoice ${f.invoice_no} is booked in SAP (FI ${s.fiDoc}). Payment as per terms.` });
    } else if (s.status === "PART_PAID") {
      inv.status = "PART_PAID";
      const p = s.payments?.at(-1) ?? { doc: s.paymentDoc, date: s.paidOn, amount: s.paidAmount };
      log(inv, "Reverse Data Agent", `Part payment: ${amt(p.amount)} INR, document ${p.doc} on ${p.date}. Paid ${amt(s.paidAmount)} of ${amt(s.invoiceAmount)}, open ${amt(s.openAmount)} (${s.method ?? "partial payment"})`);
      note({ channel: "Teams", to: [inv.ctx.requestor, inv.ctx.buyer].filter(Boolean), subject: `Part payment: ${f.vendor_name}`, agent: "Reverse Data Agent", ref,
        text: `Invoice ${f.invoice_no}: ${amt(p.amount)} INR paid on ${p.date} (document ${p.doc}). Paid so far ${amt(s.paidAmount)} of ${amt(s.invoiceAmount)} INR, ${amt(s.openAmount)} INR still open.` });
    } else if (s.status === "PAID") {
      inv.status = "PAID";
      log(inv, "Reverse Data Agent", `Payment done: document ${s.paymentDoc} on ${s.paidOn}${s.payments?.length > 1 ? ` (final of ${s.payments.length} payments)` : ""}`);
      note({ channel: "Teams", to: [inv.ctx.requestor, inv.ctx.buyer].filter(Boolean), subject: `Payment done: ${f.vendor_name}`, agent: "Reverse Data Agent", ref, text: `Invoice ${f.invoice_no} (${f.total?.toLocaleString("en-IN")} INR) paid on ${s.paidOn}, payment document ${s.paymentDoc}.` });
    } else {
      log(inv, "Reverse Data Agent", `SAP reports the document as ${s.status.toLowerCase()}`);
      if (["DELETED", "REVERSED"].includes(s.status)) inv.status = "EXCEPTION", inv.reason = `Parked document ${s.status.toLowerCase()} in SAP`;
    }
    if (s.fiDoc && attach) await attachToSap(inv);          // posted: the PDF also goes on the FI document (FB03)
    if (inv.dms) { const meta = inv.dms.replace(/\.pdf$/, ".json"); try { const j = JSON.parse(fs.readFileSync(path.join(ROOT, meta))); j.status = s; fs.writeFileSync(path.join(ROOT, meta), JSON.stringify(j, null, 2)); } catch { /* DMS copy optional */ } }
  }
  save();
  return { checked: open.length, changed };
}

// ---------------------------------------------------------------- monitor agents (GR/IR, advances, delivery, UD, MSME)
export async function runMonitor(cfg, { notify = true } = {}) {
  const t0 = Date.now();
  const r = await sap.monitor(cfg.monitor.days);
  state.monitor = { ...r, at: new Date().toISOString(), ms: Date.now() - t0 };
  for (const x of [...r.grir, ...r.advances, ...r.late, ...r.qm]) { if (x.BUYER) people.discover(x.BUYER, "BUYER", r.users?.[x.BUYER]); if (x.REQUESTOR) people.discover(x.REQUESTOR, "REQUESTOR", r.users?.[x.REQUESTOR]); }
  if (!notify) { save(); return state.monitor; }
  const ctrl = people.withRole("AP_CONTROLLER").map(p => p.id);
  const byOwner = (list, key) => list.reduce((m, x) => { const k = x[key] || x.BUYER || "UNASSIGNED"; (m[k] ??= []).push(x); return m; }, {});
  const grir = r.grir.filter(x => (x.DAYS ?? 0) >= cfg.monitor.grirDays);
  for (const [o, l] of Object.entries(byOwner(grir, "BUYER")))
    note({ channel: "Teams", to: [o], subject: `${l.length} GRN(s) without invoice`, agent: "Open GR/IR and Advances Agent", text: l.slice(0, 8).map(x => `PO ${x.EBELN}/${Number(x.EBELP)} ${x.VENDOR}: ${x.OPEN_QTY} open, GR ${x.DAYS} days ago`).join("\n") + "\nPlease follow up with the vendor for the invoice." });
  const adv = r.advances.filter(x => !x.GR_DONE);
  if (adv.length) note({ channel: "Teams", to: [...new Set([...ctrl, ...adv.map(x => x.BUYER)])].filter(Boolean), subject: `${adv.length} advance(s) without GRN`, agent: "Open GR/IR and Advances Agent", text: adv.map(x => `PO ${x.EBELN} ${x.VENDOR}: advance ${x.AMOUNT.toLocaleString("en-IN")} paid ${x.PAID_ON}, no goods receipt yet`).join("\n") });
  for (const [o, l] of Object.entries(byOwner(r.late, "BUYER")))
    note({ channel: "Teams", to: [o], subject: `${l.length} PO line(s) past delivery date`, agent: "Open GR/IR and Advances Agent", text: l.slice(0, 8).map(x => `PO ${x.EBELN}/${Number(x.EBELP)} ${x.VENDOR}: ${x.OPEN} open, ${x.DAYS_LATE} days late`).join("\n") });
  const pend = r.qm.filter(x => !x.UD), rej = r.qm.filter(x => x.UD === "R");
  for (const [o, l] of Object.entries(byOwner(pend, "REQUESTOR"))) {
    const mgr = people.person(o)?.manager;
    note({ channel: "Teams", to: [o, mgr].filter(Boolean), subject: `${l.length} usage decision(s) pending`, agent: "Quality Inspection Agent", text: l.slice(0, 8).map(x => `Lot ${x.PRUEFLOS} PO ${x.EBELN} ${x.VENDOR}, since ${x.CREATED}`).join("\n") + "\nInvoices on these GRNs cannot be booked until the UD is done." });
  }
  if (rej.length) note({ channel: "Teams", to: people.withRole("STORES").map(p => p.id), subject: `${rej.length} rejected lot(s): post 122`, agent: "Quality Inspection Agent", text: rej.map(x => `Lot ${x.PRUEFLOS} PO ${x.EBELN} ${x.VENDOR}`).join("\n") });
  // vendor due list for the payment run: AP controller gets what is overdue or due this week, MSME first
  const due = r.due ?? [], soon = due.filter(x => x.DAYS <= (cfg.monitor.dueSoonDays ?? 7) && !x.BLOCK);
  if (soon.length) {
    const inr = n => Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });
    const msmeLate = soon.filter(x => x.MSME && x.DAYS < 0);
    const top = [...soon].sort((a, b) => (b.MSME - a.MSME) || a.DAYS - b.DAYS).slice(0, 8);
    note({ channel: "Teams", to: [...ctrl, ...people.withRole("AP").map(p => p.id)], subject: `Payment due list: ${soon.length} invoice(s), ${inr(soon.reduce((a, x) => a + x.AMOUNT, 0))} INR${msmeLate.length ? `, ${msmeLate.length} MSME overdue` : ""}`, agent: "Payment Due Agent",
      text: top.map(x => `${x.MSME ? "[MSME] " : ""}${x.VENDOR || x.LIFNR} ${x.XBLNR || x.BELNR}: ${inr(x.AMOUNT)} INR, ${x.DAYS < 0 ? `overdue ${-x.DAYS} days` : x.DAYS === 0 ? "due today" : `due in ${x.DAYS} days`}`).join("\n") + "\nFull list: Follow-ups > Due list (CSV for the payment run)." });
  }
  event("Monitor Agents", `Scan of ${sap.label()}: ${r.grir.length} GR/IR, ${r.advances.length} advances, ${r.late.length} late lines, ${pend.length} pending UD, ${rej.length} rejected UD, ${due.length} open vendor invoices (${soon.length} due within a week) (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  save();
  return state.monitor;
}

export function msmeList() {
  return state.invoices.filter(i => i.ctx?.msme && !["PAID", "REJECTED"].includes(i.status)).map(i => {
    const d = i.extraction?.fields.invoice_date || i.received.slice(0, 10);
    const age = Math.round((Date.now() - Date.parse(d)) / 864e5);
    return { id: i.id, vendor: i.ctx.vendorName, invoiceNo: i.extraction?.fields.invoice_no, amount: i.extraction?.fields.total, status: i.status, invoiceDate: d, days: age, left: 45 - age };
  }).sort((a, b) => a.left - b.left);
}

export function logEvent(agent, msg, ref) { event(agent, msg, ref); save(); }
