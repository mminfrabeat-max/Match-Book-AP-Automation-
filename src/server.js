// The application: login, the agents running in the background, and the web UI.
//   node src/server.js            simulated SAP
//   node src/server.js --sap rfc  real SAP over RFC (AP_RFC_ENV / AP_RFC_PYTHON in .env.local)
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { ROOT, INBOX, CONFIG } from "./paths.js";
import { readJson } from "./jsonfile.js";
import * as pipeline from "./pipeline.js";
import * as sap from "./sap.js";
import * as auth from "./auth.js";
import * as people from "./people.js";
import * as mail from "./mail.js";
import * as learning from "./learning.js";
import { tiles, visibleInvoices } from "./tiles.js";
import { engineName } from "./extract.js";
import { pendingMailFiles, parseEml, graphEnabled, fetchGraphMails } from "./intake.js";

const cfg = readJson(CONFIG);
const argMode = process.argv.includes("--sap") ? process.argv[process.argv.indexOf("--sap") + 1] : "mock";
sap.use(argMode);
cfg.taxCodes = cfg.taxCodeSets[sap.mode];
people.init(cfg);
mail.configure({ name: cfg.appName, url: process.env.MATCHBOOK_URL || `http://localhost:${cfg.port}` });
pipeline.init(sap.mode);
const created = auth.init(cfg);
fs.mkdirSync(INBOX, { recursive: true });

if (sap.mode === "rfc") {
  const p = await sap.rfc.ping();
  if (!p.ok) { console.error(`SAP RFC connection failed: ${p.error?.message}`); process.exit(1); }
  console.log(`Connected: ${sap.label()}`);
} else sap.mock.load();

// ---------------------------------------------------------------- last-resort error handling
// An unexpected error in a background job must not stop Match Book for everyone: log it and keep serving.
process.on("unhandledRejection", e => { console.error("Unhandled:", e); try { pipeline.logEvent("AP Orchestrator", `Unexpected error (kept running): ${e?.message ?? e}`); } catch { /* logging must not throw */ } });
process.on("uncaughtException", e => { console.error("Uncaught:", e); try { pipeline.logEvent("AP Orchestrator", `Unexpected error (kept running): ${e?.message ?? e}`); } catch { /* logging must not throw */ } });

// ---------------------------------------------------------------- background agents
let busy = false;
const stuck = new Map();               // inbox file -> first failure: a locked file is skipped, never blocks the others
async function intakeLoop() {
  if (busy) return;
  busy = true;
  try {
    for (const f of fs.readdirSync(INBOX).filter(f => f.toLowerCase().endsWith(".pdf")).sort()) {
      const full = path.join(INBOX, f);
      try {
        const a = fs.statSync(full).size; await new Promise(r => setTimeout(r, 300));   // skip files still being copied
        if (!fs.existsSync(full) || fs.statSync(full).size !== a) continue;
        const inv = await pipeline.ingest(full, cfg);
        stuck.delete(f);
        console.log(`${inv.id}  ${inv.file.padEnd(40)}  ${inv.status.padEnd(9)}  ${inv.park?.result.INVOICEDOCNUMBER ?? inv.reason ?? ""}`);
      } catch (e) {
        if (!stuck.has(f)) { stuck.set(f, Date.now()); pipeline.logEvent("Invoice Reading Agent", `Could not take ${f} from the common folder (${e.message}); it is retried, other files go on. Close the file if it is open in another program.`); }
      }
    }
    for (const file of pendingMailFiles()) {
      const m = await pipeline.ingestMail(parseEml(fs.readFileSync(file, "latin1")), cfg, file);
      console.log(`${m.id}  ${m.subject.slice(0, 40).padEnd(40)}  ${m.kind}`);
    }
    if (graphEnabled()) for (const m of await fetchGraphMails()) await pipeline.ingestMail(m, cfg);
  } catch (e) { console.error("Intake failed:", e.message); }
  busy = false;
}
setInterval(intakeLoop, cfg.pollSeconds * 1000);
intakeLoop();

let monBusy = false;
async function monitorLoop() {
  if (monBusy) return; monBusy = true;
  try { await pipeline.runMonitor(cfg); } catch (e) { pipeline.logEvent("Monitor Agents", `Scan failed: ${e.message}`); }
  monBusy = false;
}
setInterval(monitorLoop, cfg.monitor.everyMinutes * 60_000);
setTimeout(monitorLoop, 3000);
setInterval(() => pipeline.syncStatus().catch(e => pipeline.logEvent("Reverse Data Agent", `Status sync failed: ${e.message}`)), cfg.syncMinutes * 60_000);

// ---------------------------------------------------------------- http helpers
const send = (res, code, body, type = "application/json", headers = {}) => {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
};
const readBody = (req, limit = 20e6) => new Promise((resolve, reject) => {
  const c = []; let n = 0;
  req.on("data", d => { n += d.length; if (n > limit) { reject(new Error("Upload too large")); req.destroy(); } else c.push(d); });
  req.on("end", () => resolve(Buffer.concat(c)));
});
const json = async req => JSON.parse((await readBody(req, 1e6)).toString() || "{}");
const ENGINE = { groq: `Groq · ${cfg.groqModel}`, claude: `Claude · ${cfg.claudeModel}`, local: "Rules engine" };
const need = (u, p) => { if (!auth.can(u, p)) { const e = new Error("You are not allowed to do this"); e.code = 403; throw e; } };

function dashboard(state, user) {
  const inv = visibleInvoices(state, user);
  const by = (arr, f) => arr.reduce((m, x) => { const k = f(x) ?? "-"; m[k] = (m[k] || 0) + 1; return m; }, {});
  const done = inv.filter(i => i.status !== "PROCESSING");
  // Touchless (solution design: "invoices parked without correction"): booked in SAP and no person had to correct,
  // approve a warning, override or decide on it. Clicking "Park" on a clean invoice is not a correction.
  const BOOKED = ["PARKED", "POSTED", "PART_PAID", "PAID"];
  const touched = i => i.log.some(l => l.agent === "Human Review Agent" || (l.agent === "AP Orchestrator" && /^(Human Review Agent: sent|Exception:)/.test(l.msg)));
  const clean = inv.filter(i => BOOKED.includes(i.status) && !touched(i)).length;
  // cycle time in days: received -> parked, parked -> posted (posting date from SAP)
  const avg = a => a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : null;
  const dayDiff = (a, b) => Math.max(0, (Date.parse(b) - Date.parse(a)) / 864e5);
  const toPark = inv.filter(i => i.park?.at).map(i => dayDiff(i.received, i.park.at));
  const toPost = inv.filter(i => i.park?.at && i.sapStatus?.postedOn).map(i => dayDiff(i.park.at.slice(0, 10), i.sapStatus.postedOn));
  // ageing of the open follow-ups from the last SAP scan (AP team and controller see all of them)
  const buckets = (ages, edges = [7, 30, 60]) => {
    const names = [`0-${edges[0]}`, `${edges[0] + 1}-${edges[1]}`, `${edges[1] + 1}-${edges[2]}`, `>${edges[2]}`], o = Object.fromEntries(names.map(n => [n, 0]));
    for (const a of ages.filter(a => a != null && !Number.isNaN(a))) o[names[a <= edges[0] ? 0 : a <= edges[1] ? 1 : a <= edges[2] ? 2 : 3]]++;
    return o;
  };
  const age = d => d ? Math.max(0, Math.floor((Date.now() - Date.parse(d)) / 864e5)) : null;
  const mon = state.monitor;
  const msme = pipeline.msmeList().filter(m => inv.some(i => i.id === m.id));
  const ageing = user.perms.includes("view_all") && mon ? {
    at: mon.at,
    rows: [
      { key: "ud", name: "Usage decision pending", ...buckets(mon.qm.filter(x => !x.UD).map(x => age(x.CREATED))) },
      { key: "grir", name: "GRN done, no invoice", ...buckets(mon.grir.map(x => x.DAYS)) },
      { key: "advances", name: "Open advances", ...buckets(mon.advances.map(x => age(x.PAID_ON))) },
    ],
    msme: { overdue: msme.filter(m => m.left < 0).length, week: msme.filter(m => m.left >= 0 && m.left <= 7).length, later: msme.filter(m => m.left > 7).length },
  } : null;
  const reasons = {};
  for (const i of inv) for (const c of i.checks ?? []) if (["BLOCK", "WARN"].includes(c.status)) reasons[c.name.replace(/ \(item \d+\)$/, "")] = (reasons[c.name.replace(/ \(item \d+\)$/, "")] || 0) + 1;
  const value = inv.filter(i => ["PARKED", "POSTED", "PART_PAID", "PAID"].includes(i.status)).reduce((a, i) => a + (i.extraction?.fields.total || 0), 0);
  const ms = done.map(i => i.timings?.ms).filter(Boolean);
  const days = {};
  for (const i of inv) { const d = i.received.slice(0, 10); days[d] = (days[d] || 0) + 1; }
  return {
    total: inv.length, byStatus: by(inv, i => i.status), byCategory: by(inv, i => i.category), bySource: by(inv, i => i.source?.type ?? "Folder"),
    byCompany: by(inv, i => i.ctx?.companyCode), byAssignee: by(inv.filter(i => !["PAID", "REJECTED"].includes(i.status)), i => people.name(i.assignedTo)),
    reasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 8),
    touchless: done.length ? Math.round((clean / done.length) * 100) : null, touchlessCount: clean, decided: done.length,
    daysToPark: avg(toPark), daysToPost: avg(toPost), parkedCount: toPark.length, postedCount: toPost.length, ageing,
    avgSeconds: ms.length ? +(ms.reduce((a, b) => a + b, 0) / ms.length / 1000).toFixed(1) : null, bookedValue: value,
    perDay: Object.entries(days).sort().slice(-14), mails: state.mails.length,
    learned: Object.values(state.learning.patterns).filter(p => p.approvals >= cfg.learning.autoAcceptAfter && !p.off).length
      + state.learning.corrections.filter(c => !c.off && (c.times ?? 1) >= learning.correctAfter(cfg)).length,
    events: user.perms.includes("view_all") ? state.events.slice(0, 300) : state.events.filter(e => inv.some(i => i.id === e.invoice)).slice(0, 300),
  };
}

function outboxFor(state, user) {
  if (user.perms.includes("view_all")) return state.outbox;
  const me = (user.personId || "").toUpperCase();
  const email = (people.person(user.personId)?.email || "").toLowerCase();
  return state.outbox.filter(m => m.to.some(t => t.toUpperCase() === me || t.toLowerCase() === email));
}

const app = { name: cfg.appName, tagline: cfg.appTagline, org: cfg.orgName };

// ---------------------------------------------------------------- Teams / tunnel access
// Opened on this PC (localhost) or through an HTTPS tunnel for the Teams tab. Through the tunnel the session cookie
// must work inside the Teams frame (SameSite=None; Secure; Partitioned) and the demo-accounts box is never shown.
const isLocal = req => !req.headers["x-forwarded-for"] && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(req.headers.host || "");
const cookie = (req, value, maxAge) => `apsid=${value}; HttpOnly; Path=/; Max-Age=${maxAge}; ${isLocal(req) ? "SameSite=Strict" : "SameSite=None; Secure; Partitioned"}`;
// only Teams / Microsoft 365 may show the page in a frame
const FRAME = { "Content-Security-Policy": "frame-ancestors 'self' https://teams.microsoft.com https://*.teams.microsoft.com https://*.teams.cloud.microsoft https://*.cloud.microsoft https://*.office.com https://*.microsoft365.com" };

// ---------------------------------------------------------------- routes
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  try {
    if (req.method === "GET" && (p === "/" || p === "/index.html")) return send(res, 200, fs.readFileSync(path.join(ROOT, "public", "index.html")), "text/html; charset=utf-8", FRAME);
    if (req.method === "GET" && p === "/teams-config.html") return send(res, 200, fs.readFileSync(path.join(ROOT, "public", "teams-config.html")), "text/html; charset=utf-8", FRAME);
    if (req.method === "GET" && p.startsWith("/assets/")) {
      const f = path.join(ROOT, "public", path.normalize(p).replace(/^[\\/]+/, ""));
      if (!f.startsWith(path.join(ROOT, "public")) || !fs.existsSync(f)) return send(res, 404, { error: "not found" });
      return send(res, 200, fs.readFileSync(f), { ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".css": "text/css", ".js": "text/javascript" }[path.extname(f).toLowerCase()] ?? "application/octet-stream");
    }
    if (req.method === "GET" && p === "/api/app") {
      // demo only: list the accounts and the initial password on the sign-in page (config.auth.showDemoAccounts)
      const demo = cfg.auth.showDemoAccounts && isLocal(req) ? { password: cfg.auth.initialPassword,
        users: auth.list().filter(u => !u.disabled).map(u => ({ username: u.username, name: u.name, roles: u.roles, mustChange: u.mustChange })) } : null;
      return send(res, 200, { ...app, sapMode: sap.mode, demo });
    }
    if (req.method === "POST" && p === "/api/login") {
      const b = await json(req);
      const { token, user } = auth.login(b.username, b.password);
      pipeline.logEvent("Security", `${user.name} signed in`);
      return send(res, 200, { user }, "application/json", { "Set-Cookie": cookie(req, token, cfg.auth.sessionHours * 3600) });
    }

    const user = auth.fromRequest(req);
    if (p.startsWith("/api/") && !user) return send(res, 401, { error: "Please sign in" });
    if (req.method === "POST" && p !== "/api/upload" && !/json/.test(req.headers["content-type"] || "")) return send(res, 415, { error: "JSON expected" });

    if (req.method === "POST" && p === "/api/logout") { auth.logout(user.token); return send(res, 200, { ok: true }, "application/json", { "Set-Cookie": cookie(req, "", 0) }); }
    if (req.method === "GET" && p === "/api/me") return send(res, 200, { user, app: { ...app, sapMode: sap.mode, sapLabel: sap.label(), engine: ENGINE[engineName(cfg)] } });
    if (req.method === "POST" && p === "/api/password") { const b = await json(req); auth.changePassword(user.username, b.old, b.new); pipeline.logEvent("Security", `${user.name} changed the password`); return send(res, 200, { ok: true }); }
    if (user.mustChange) return send(res, 403, { error: "Change your password first", mustChange: true });

    const state = pipeline.getState();
    if (req.method === "GET" && p === "/api/state") {
      const inv = visibleInvoices(state, user).map(i => ({ ...i, assignedName: people.name(i.assignedTo),
        ctx: i.ctx && { ...i.ctx, buyerName: i.ctx.buyer && people.name(i.ctx.buyer), requestorName: i.ctx.requestor && people.name(i.ctx.requestor) } }));
      return send(res, 200, { invoices: inv, inbox: user.perms.includes("view_all") ? fs.readdirSync(INBOX).filter(f => /\.pdf$/i.test(f)) : [], busy,
        mails: user.perms.includes("view_all") ? state.mails.slice(0, 100) : [], sapMode: sap.mode, sapLabel: sap.label(), engine: ENGINE[engineName(cfg)],
        monitorAt: state.monitor?.at ?? null, unread: outboxFor(state, user).length });
    }
    if (req.method === "GET" && p === "/api/tiles") return send(res, 200, { tiles: tiles(state, user, pipeline.msmeList()), monitorAt: state.monitor?.at ?? null });
    if (req.method === "GET" && p === "/api/monitor") {
      const m = state.monitor ?? { grir: [], advances: [], late: [], qm: [] };
      // due list rows that Match Book booked link back to the invoice (FI document + year)
      const byFi = new Map(state.invoices.filter(i => i.sapStatus?.fiDoc).map(i => [`${String(i.sapStatus.fiDoc).padStart(10, "0")}/${i.sapStatus.fiYear || i.park?.result.FISCALYEAR}`, i.id]));
      const due = (m.due ?? []).map(x => ({ ...x, INV: byFi.get(`${String(x.BELNR).padStart(10, "0")}/${x.GJAHR}`) ?? null }));
      return send(res, 200, { ...m, due, msme: pipeline.msmeList(), people: Object.fromEntries(people.all().map(x => [x.id.toUpperCase(), x.name])) });
    }
    if (req.method === "POST" && p === "/api/monitor/run") { need(user, "monitor"); await pipeline.runMonitor(cfg); return send(res, 200, { ok: true, at: state.monitor.at }); }
    if (req.method === "POST" && p === "/api/sync") { need(user, "park"); return send(res, 200, await pipeline.syncStatus()); }
    if (req.method === "GET" && p === "/api/dashboard") return send(res, 200, dashboard(state, user));
    if (req.method === "GET" && p === "/api/outbox") return send(res, 200, { outbox: outboxFor(state, user).slice(0, 300), mails: user.perms.includes("view_all") ? state.mails : [] });
    if (req.method === "POST" && /^\/api\/outbox\/MSG-\d+\/sent$/.test(p)) { need(user, "mail"); const m = mail.markSent(state, p.split("/")[3]); pipeline.save(); return send(res, 200, m); }
    if (req.method === "GET" && p === "/api/learning") return send(res, 200, { ...state.learning, autoAcceptAfter: cfg.learning.autoAcceptAfter, correctAfter: learning.correctAfter(cfg) });
    if (req.method === "POST" && p === "/api/learning/toggle") { need(user, "learning"); const b = await json(req); learning.toggle(state.learning, b.kind, b.key, !!b.off); pipeline.logEvent("Learning Agent", `${user.name} switched ${b.off ? "off" : "on"} a learned ${b.kind}`); return send(res, 200, state.learning); }
    if (req.method === "GET" && p === "/api/users") { need(user, "users"); return send(res, 200, { users: auth.list(), roles: Object.keys(auth.PERMS), initial: cfg.auth.initialPassword }); }
    if (req.method === "POST" && p === "/api/users") { need(user, "users"); const u = auth.upsert(await json(req)); pipeline.logEvent("Security", `${user.name} saved user ${u.username}`); return send(res, 200, u); }
    const um = p.match(/^\/api\/users\/([a-z0-9._-]+)\/(reset|disable|enable)$/);
    if (req.method === "POST" && um) {
      need(user, "users");
      if (um[2] === "reset") auth.resetPassword(um[1]); else auth.setDisabled(um[1], um[2] === "disable");
      pipeline.logEvent("Security", `${user.name}: ${um[2]} user ${um[1]}`);
      return send(res, 200, { ok: true });
    }
    if (req.method === "GET" && p === "/api/sap/parked") {
      if (sap.mode === "mock") return send(res, 200, { real: false, invoices: sap.mock.snapshot().invoices, vendors: sap.mock.snapshot().vendors });
      return send(res, 200, { real: true, vendors: [], invoices: state.invoices.filter(i => i.park).map(i => ({ BELNR: i.park.result.INVOICEDOCNUMBER, GJAHR: i.park.result.FISCALYEAR,
        STATUS: i.sapStatus?.status ?? "PARKED", LIFNR: i.park.payload._VENDOR, XBLNR: i.park.payload.HEADERDATA.REF_DOC_NO, BLDAT: i.park.payload.HEADERDATA.DOC_DATE,
        EBELN: i.park.payload.ITEMDATA[0]?.PO_NUMBER, QTY: i.park.payload.ITEMDATA.reduce((a, x) => a + x.QUANTITY, 0), RMWWR: i.park.payload.HEADERDATA.GROSS_AMOUNT })) });
    }
    if (req.method === "POST" && p === "/api/upload") {
      need(user, "review");
      const name = path.basename(url.searchParams.get("name") || `upload_${Date.now()}.pdf`).replace(/[^\w.\-]/g, "_").replace(/\.pdf$/i, "");
      const buf = await readBody(req);
      if (buf.subarray(0, 5).toString() !== "%PDF-") return send(res, 400, { error: "Only PDF files" });
      // same name already waiting in the inbox (two people, same file name): keep both
      let file = path.join(INBOX, `${name}.pdf`);
      for (let n = 2; fs.existsSync(file); n++) file = path.join(INBOX, `${name}_${n}.pdf`);
      fs.writeFileSync(`${file}.part`, buf); fs.renameSync(`${file}.part`, file);     // never picked up half-written
      return send(res, 200, { ok: true, file: path.basename(file) });
    }

    const m = p.match(/^\/api\/invoices\/(INV-\d+)\/([\w-]+)$/);
    if (m) {
      const [, id, action] = m;
      const inv = pipeline.find(id);
      if (!inv || !visibleInvoices(state, user).includes(inv)) return send(res, 404, { error: "not found" });
      if (req.method === "GET" && action === "pdf") return send(res, 200, fs.readFileSync(path.join(ROOT, inv.stored)), "application/pdf");
      if (req.method !== "POST") return send(res, 405, { error: "method" });
      const b = await json(req);
      let out;
      if (action === "approve") { need(user, "park"); out = await pipeline.approve(id, cfg, user, b.qtys); }
      else if (action === "override") { need(user, "override"); out = await pipeline.override(id, cfg, user, b.reason); }
      else if (action === "reject") { need(user, "review"); out = pipeline.reject(id, user, b.reason); }
      else if (action === "correct") { need(user, "review"); out = await pipeline.correct(id, cfg, user, b.fields, b.lines); }
      else if (action === "attach") { need(user, "park"); out = await pipeline.attachPdf(id, user); }
      else if (action === "rerun") { need(user, "review"); out = await pipeline.revalidate(id, cfg); }
      else if (action === "seed") { need(user, "demo"); out = await pipeline.seedAndRerun(id, cfg); }
      else if (["simulate-post", "simulate-partpay", "simulate-pay"].includes(action)) {
        need(user, "demo");
        if (sap.mode !== "mock") throw new Error("Only with simulated SAP: post in MIR4 and run F110 in the real system");
        sap.mock.simulate(inv.park?.result.INVOICEDOCNUMBER, action.replace("simulate-", ""));
        await pipeline.syncStatus(); out = pipeline.find(id);
      }
      return out ? send(res, 200, out) : send(res, 404, { error: "unknown action" });
    }
    send(res, 404, { error: "not found" });
  } catch (e) { send(res, e.code === 403 ? 403 : 400, { error: e.message }); }
}).listen(cfg.port, () => {
  console.log(`${cfg.appName} running: http://localhost:${cfg.port}`);
  if (created.created) console.log(`Created ${created.created} user accounts. Initial password for everyone: ${cfg.auth.initialPassword} (must be changed at first sign-in). Usernames: admin, ${cfg.people.map(p => p.id.toLowerCase()).join(", ")}`);
  console.log(`Invoices: drop PDFs into ${INBOX} or .eml mails into invoices/mail${graphEnabled() ? " (+ Graph mailbox)" : ""}`);
  console.log(`Extraction: ${ENGINE[engineName(cfg)]}; SAP: ${sap.label()}${sap.mode === "rfc" ? " (parks only when you click)" : ""}`);
}).on("error", e => {
  // e.g. port already in use: stop with a clear message instead of running without a web server
  console.error(e.code === "EADDRINUSE" ? `Port ${cfg.port} is already in use: Match Book is probably running already (http://localhost:${cfg.port}).` : `Web server error: ${e.message}`);
  process.exit(1);
});
