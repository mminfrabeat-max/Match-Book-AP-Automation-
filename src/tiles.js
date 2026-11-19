// "Teams tiles": what each person sees on their home screen, by role.
// AP team / AP controller / admin see everything; buyers, requestors, managers, QC and stores see their part.
import * as people from "./people.js";

const OPEN = ["READY", "REVIEW", "EXCEPTION", "PROCESSING"];
const brief = i => ({ id: i.id, status: i.status, vendor: i.ctx?.vendorName ?? i.extraction?.fields.vendor_name ?? i.file, invoiceNo: i.extraction?.fields.invoice_no,
  amount: i.extraction?.fields.total, po: i.ctx?.po, reason: i.reason, assignedTo: i.assignedTo, doc: i.park?.result.INVOICEDOCNUMBER, received: i.received, msme: i.ctx?.msme });

export function visibleInvoices(state, user) {
  if (user.perms.includes("view_all")) return state.invoices;
  const me = (user.personId || "").toUpperCase();
  const team = people.all().filter(p => (p.manager || "").toUpperCase() === me).map(p => p.id.toUpperCase());
  return state.invoices.filter(i => {
    const b = (i.ctx?.buyer || "").toUpperCase(), r = (i.ctx?.requestor || "").toUpperCase();
    if (user.roles.includes("BUYER") && b === me) return true;
    if (user.roles.includes("REQUESTOR") && r === me) return true;
    if (user.roles.includes("MANAGER") && (team.includes(b) || team.includes(r))) return true;
    if (user.roles.includes("QC") && i.checks?.some(c => c.id === 9 && c.status === "BLOCK")) return true;
    if (user.roles.includes("STORES") && i.checks?.some(c => (c.id === 9 && /reject/i.test(c.detail)) || (c.id === 5 && c.status === "BLOCK"))) return true;
    return false;
  });
}

export function tiles(state, user, msme) {
  const me = (user.personId || "").toUpperCase();
  const roles = user.roles, all = user.perms.includes("view_all");
  const team = people.all().filter(p => (p.manager || "").toUpperCase() === me).map(p => p.id.toUpperCase());
  const mon = state.monitor ?? { grir: [], advances: [], late: [], qm: [] };
  const mine = x => all || roles.includes("QC") || [x.BUYER, x.REQUESTOR].map(v => (v || "").toUpperCase()).some(v => v === me || team.includes(v));
  const inv = visibleInvoices(state, user);
  const T = [];
  const add = (key, title, sub, items, tone = "neutral") => T.push({ key, title, sub, count: items.length, items: items.slice(0, 8), tone });

  if (roles.some(r => ["AP", "AP_CONTROLLER", "ADMIN"].includes(r))) {
    const queue = state.invoices.filter(i => OPEN.includes(i.status) && (roles.includes("AP") && !roles.includes("AP_CONTROLLER") && !roles.includes("ADMIN") ? i.assignedTo?.toUpperCase() === me : true));
    add("queue", roles.includes("AP") && !roles.includes("AP_CONTROLLER") ? "My invoice queue" : "Invoice queue", "Ready, review and exceptions", queue.map(brief), queue.some(i => i.status === "EXCEPTION") ? "bad" : "accent");
    add("parked", "Parked, to post in MIR4", "MIRO Parking Agent", state.invoices.filter(i => i.status === "PARKED").map(brief), "good");
    add("msme", "MSME: 45-day clock", "MSME Notification Agent", msme.map(m => ({ ...m, invoiceNo: m.invoiceNo, vendor: m.vendor })), msme.some(m => m.left <= 7) ? "bad" : "warn");
    const due = (mon.due ?? []).filter(x => x.DAYS <= 7 && !x.BLOCK).sort((a, b) => (b.MSME - a.MSME) || a.DAYS - b.DAYS);
    add("due", "Payments due this week", "Payment Due Agent · from SAP open items", due, due.some(x => x.MSME && x.DAYS < 0) ? "bad" : due.length ? "warn" : "good");
  }
  if (all || roles.includes("BUYER") || roles.includes("MANAGER")) {
    add("grir", "GRN done, invoice not received", "Open GR/IR Agent", mon.grir.filter(mine), "warn");
    add("advances", "Open advances", "Advances Agent", mon.advances.filter(mine), "warn");
    add("late", "Past delivery date", "Delivery follow-up", mon.late.filter(mine), "warn");
  }
  if (all || roles.some(r => ["REQUESTOR", "MANAGER", "QC", "BUYER"].includes(r)))
    add("ud", "Usage decision pending", "Quality Inspection Agent", mon.qm.filter(x => !x.UD && mine(x)), "warn");
  if (all || roles.some(r => ["STORES", "QC", "BUYER"].includes(r)))
    add("rejected", "Rejected material: post 122", "Quality Inspection Agent", mon.qm.filter(x => x.UD === "R" && (all || roles.includes("STORES") || mine(x))), "bad");
  if (!all) {
    add("myinv", "Invoices on my POs / PRs", "Status from AP", inv.map(brief), "accent");
    add("partpaid", "Partly paid", "Reverse Data Agent", inv.filter(i => i.status === "PART_PAID").map(brief), "warn");
    add("paid", "Payment done", "Reverse Data Agent", inv.filter(i => i.status === "PAID").map(brief), "good");
  }
  return T;
}
