// Learning Agent: learns from AP reviewers to reduce manual work, in two auditable ways.
//  1. Field corrections: a reviewer corrects a field read from a vendor's invoice ("SGE/1187" -> "SGE/1187A").
//     Once the same correction has been made N times for that vendor (config.learning.correctAfter, default 3),
//     the next invoice with the same wrong reading gets it as a PROPOSAL: the value is filled in, and a person
//     confirms it (check 27 sends the invoice to review). A person undoing a proposal resets the count.
//  2. Accepted warnings: when reviewers approve the same kind of warning for the same vendor N times
//     (e.g. "plant has no GSTIN in SAP"), it is accepted automatically next time - only for checks listed
//     in config.learning.learnableChecks, never for quantity, price, tax or duplicate checks.
// Everything learned is listed in the app and can be switched off.

const sig = (check, vendorKey) => `${check.id}|${vendorKey}|${check.detail.replace(/[\d.,/-]+/g, "#").replace(/\s+/g, " ").trim()}`;

export function init(state) { state.learning ??= { corrections: [], patterns: {} }; return state.learning; }

export const correctAfter = cfg => cfg.learning.correctAfter ?? cfg.learning.autoAcceptAfter ?? 3;

// Fills in learned corrections that have been made often enough; returns what was proposed (for check 27 and the log).
export function applyCorrections(L, vendorKey, fields, need = 3) {
  const applied = [];
  for (const c of L.corrections) {
    if (c.off || (c.times ?? 1) < need || c.vendor !== vendorKey || String(fields[c.field] ?? "") !== String(c.from)) continue;
    fields[c.field] = c.to; c.used = (c.used || 0) + 1;
    applied.push({ field: c.field, from: c.from, to: c.to, times: c.times ?? 1, by: c.by });
  }
  return applied;
}

// Each time a reviewer makes the same correction for the same vendor, the count goes up; a different value starts again.
export function recordCorrection(L, vendorKey, field, from, to, by) {
  if (!vendorKey || String(from ?? "") === String(to ?? "")) return;
  const now = new Date().toISOString();
  const c = L.corrections.find(x => x.vendor === vendorKey && x.field === field && String(x.from) === String(from ?? ""));
  if (c && String(c.to) === String(to ?? "")) Object.assign(c, { times: (c.times ?? 1) + 1, by, at: now });
  else if (c) Object.assign(c, { to, times: 1, by, at: now });
  else L.corrections.push({ vendor: vendorKey, field, from: from ?? "", to, times: 1, by, at: now, used: 0 });
}

// A reviewer put back the value that was read: the proposal was wrong, so it has to be learned again from zero.
export function undoCorrection(L, vendorKey, field, from) {
  const c = L.corrections.find(x => x.vendor === vendorKey && x.field === field && String(x.from) === String(from ?? ""));
  if (c) { c.times = 0; c.undone = (c.undone || 0) + 1; }
}

// Called when a reviewer approves an invoice in review: every warning on it counts as accepted.
export function recordApproval(L, vendorKey, checks, cfg, by) {
  for (const c of checks.filter(c => c.status === "WARN" && cfg.learning.learnableChecks.includes(c.id))) {
    const k = sig(c, vendorKey);
    const p = (L.patterns[k] ??= { check: c.id, name: c.name, vendor: vendorKey, detail: c.detail, approvals: 0 });
    p.approvals++; p.lastBy = by; p.lastAt = new Date().toISOString();
  }
}

export function recordRejection(L, vendorKey, checks) {
  for (const c of checks.filter(c => c.status === "WARN")) { const p = L.patterns[sig(c, vendorKey)]; if (p) p.approvals = 0; }
}

// Turns learned warnings into PASS (with a note) before the decision is taken.
export function relax(L, vendorKey, checks, cfg) {
  const used = [];
  for (const c of checks) {
    if (c.status !== "WARN" || !cfg.learning.learnableChecks.includes(c.id)) continue;
    const p = L.patterns[sig(c, vendorKey)];
    if (p && !p.off && p.approvals >= cfg.learning.autoAcceptAfter) {
      c.status = "PASS"; c.detail += ` (accepted by Learning Agent: approved ${p.approvals} times before, last by ${p.lastBy})`; used.push(c.id);
    }
  }
  return used;
}

export function toggle(L, kind, key, off) {
  if (kind === "pattern" && L.patterns[key]) L.patterns[key].off = off;
  if (kind === "correction" && L.corrections[Number(key)]) L.corrections[Number(key)].off = off;
}
