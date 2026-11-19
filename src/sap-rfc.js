// Real SAP over RFC: Node calls sap_rfc/ap_rfc.py (PyRFC), same pattern as Project_Automation_SubCon.
//   AP_RFC_PYTHON  Python with PyRFC + SAP NW RFC SDK
//   AP_RFC_ENV     file with SAP_ASHOST / SAP_SYSNR / SAP_CLIENT / SAP_USER / SAP_PASSWD
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./paths.js";

const SCRIPT = path.join(ROOT, "sap_rfc", "ap_rfc.py");
const JOBS = path.join(ROOT, "data", "runtime", "rfc_jobs");
const PY = () => process.env.AP_RFC_PYTHON || (process.platform === "win32" ? "py" : "python3");
let sessionInfo = null;

// Every request and its answer are kept in data/runtime/rfc_jobs for the audit trail.
function record(cmd, job, result) {
  if (!job) return;
  fs.mkdirSync(JOBS, { recursive: true });
  const base = path.join(JOBS, `${cmd}_${Date.now()}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify(job, null, 2));
  fs.writeFileSync(`${base}.result.json`, JSON.stringify(result, null, 2));
}

// ---------- long-running worker: one Python process, one SAP log-on, requests answered in order ----------
// Saves the Python start + SAP log-on (about 2 s) on every call. AP_RFC_WORKER=off goes back to one process per call.
let worker = null, seq = 0;
const waiting = new Map();
function startWorker() {
  const p = spawn(PY(), ["-I", SCRIPT, "serve"], { windowsHide: true, env: process.env });
  const w = { p, ready: null, buf: "" };
  w.ready = new Promise((resolve, reject) => { w.resolveReady = resolve; w.rejectReady = reject; });
  p.stdout.on("data", d => {
    w.buf += d;
    let i;
    while ((i = w.buf.indexOf("\n")) >= 0) {
      const line = w.buf.slice(0, i).trim(); w.buf = w.buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.ready) { w.resolveReady(); continue; }
      const job = waiting.get(msg.id);
      if (job) { waiting.delete(msg.id); clearTimeout(job.timer); job.resolve(msg); }
      if (![...waiting.values()].some(j => j.w === w)) w.hold(false);
    }
  });
  p.stderr.on("data", () => {});
  // an idle worker must not keep a script alive: hold the event loop only while a request is in flight
  w.hold = on => { for (const x of [p, p.stdout, p.stderr, p.stdin]) { try { on ? x.ref() : x.unref(); } catch { /* not refable */ } } };
  w.hold(false);
  const fail = why => {
    if (worker === w) worker = null;
    w.rejectReady(new Error(why));
    for (const [id, job] of waiting) { if (job.w === w) { waiting.delete(id); clearTimeout(job.timer); job.resolve({ ok: false, error: { step: "worker", message: why } }); } }
  };
  p.on("error", e => fail(e.message));
  p.on("close", code => fail(`SAP worker stopped (exit ${code})`));
  return w;
}

async function viaWorker(cmd, args, job, timeoutMs) {
  if (!worker) worker = startWorker();
  const w = worker;
  w.hold(true);                                   // keep the process alive while starting / waiting for SAP
  await w.ready;
  const id = ++seq;
  return new Promise(resolve => {
    // a timed-out request kills the worker (the next call starts a fresh one); it is never re-sent automatically,
    // so a park can never be sent twice - the duplicate check also catches an already parked reference
    const timer = setTimeout(() => { waiting.delete(id); resolve({ ok: false, error: { step: "timeout", message: `SAP did not answer within ${timeoutMs / 1000} s; for a park, check MIR4 / Match Book before trying again` } }); try { w.p.kill(); } catch { /* gone */ } }, timeoutMs);
    waiting.set(id, { resolve, timer, w });
    w.p.stdin.write(JSON.stringify({ id, cmd, args, job }) + "\n");
  });
}

export function stopWorker() { if (worker) { try { worker.p.kill(); } catch { /* gone */ } worker = null; } }
process.on("exit", stopWorker);

export async function runRfc(cmd, { job, args = [], timeoutMs = 120_000 } = {}) {
  let r;
  if (process.env.AP_RFC_WORKER !== "off") {
    try { r = await viaWorker(cmd, args, job, timeoutMs); }
    catch (e) { r = null; }                                  // worker could not start: fall back to one process per call
  }
  if (!r || (r.error?.step === "worker" && cmd !== "park")) r = await runOnce(cmd, { job, args, timeoutMs });
  if (r.session) sessionInfo = r.session;
  record(cmd, job, r);
  return r;
}

function runOnce(cmd, { job, args = [], timeoutMs = 120_000 } = {}) {
  const py = PY();
  const extra = [];
  let jobFile;
  if (job) {
    fs.mkdirSync(JOBS, { recursive: true });
    jobFile = path.join(JOBS, `${cmd}_${Date.now()}_once.json`);
    fs.writeFileSync(jobFile, JSON.stringify(job, null, 2));
    extra.push("--job", jobFile);
  }
  return new Promise(resolve => {
    const p = spawn(py, ["-I", SCRIPT, cmd, ...args, ...extra], { windowsHide: true, env: process.env });
    let out = "", err = "";
    const timer = setTimeout(() => p.kill(), timeoutMs);
    p.stdout.on("data", d => (out += d));
    p.stderr.on("data", d => (err += d));
    p.on("error", e => { clearTimeout(timer); resolve({ ok: false, error: { step: "python", message: e.message } }); });
    p.on("close", () => {
      clearTimeout(timer);
      let r;
      try { r = JSON.parse(out.trim().split("\n").pop()); }
      catch { r = { ok: false, error: { step: "python", message: (err || out || "no output").slice(0, 400) } }; }
      if (jobFile) fs.rmSync(jobFile, { force: true });
      resolve(r);
    });
  });
}

export const label = () => sessionInfo ? `SAP ${sessionInfo.system}/${sessionInfo.client} (RFC, user ${sessionInfo.user})` : "SAP over RFC";
export const ping = () => runRfc("ping");
export const openItems = (days = 180) => runRfc("open_items", { args: [String(days)] });

export async function getContext(f) {
  const r = await runRfc("context", { job: { ebeln: f.po_no || "", gstin: f.vendor_gstin || "" } });
  if (!r.ok) throw new Error(`SAP read failed: ${r.error?.message}`);
  const po = r.po && { ...r.po, items: r.po.items.map(i => ({ ...i, QI_REQUIRED: false })) };
  return { ...r, po, poError: r.poError ?? null };
}

export async function monitor(days = 180) {
  const r = await runRfc("monitor", { job: { days }, timeoutMs: 300_000 });
  if (!r.ok) throw new Error(`SAP monitor scan failed: ${r.error?.message}`);
  return r;
}

export async function status(docs) {
  const r = await runRfc("status", { job: { docs } });
  if (!r.ok) throw new Error(`SAP status read failed: ${r.error?.message}`);
  return r;
}

export async function park(payload) {
  const r = await runRfc("park", { job: { payload } });
  if (!r.ok) throw new Error(`SAP refused to park: ${r.error?.message}`);
  return { RETURN: r.RETURN, INVOICEDOCNUMBER: r.INVOICEDOCNUMBER, FISCALYEAR: r.FISCALYEAR, SESSION: r.session };
}

// Invoice PDF -> GOS attachment on a business object: BUS2081 invoice document (BELNR+GJAHR), BUS2012 purchase
// order (EBELN), BKPF accounting document (BUKRS+BELNR+GJAHR). Shown under Services for Object > Attachment list.
export async function attach(objtype, objkey, pdfPath, title) {
  const r = await runRfc("attach", { job: { objtype, objkey, file: pdfPath, title } });
  if (!r.ok) throw new Error(`SAP attachment failed: ${r.error?.message}`);
  return { OBJECT: objtype, OBJECT_ID: objkey, ...r.attachment, already: r.already, count: r.attachments?.length ?? 1 };
}

export async function attachments(objtype, objkey) {
  const r = await runRfc("attachments", { job: { objtype, objkey } });
  if (!r.ok) throw new Error(`SAP attachment list failed: ${r.error?.message}`);
  return r.attachments;
}
