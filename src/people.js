// Who is who: AP team, AP controller, buyers, requestors, their managers, QC, stores.
// Configured people come from config.json; SAP users seen in POs / PRs (e.g. ERNAM in S4T) are added
// on the fly so every buyer and requestor gets their own tiles.
let cfgPeople = [];
const seen = new Map();

export function init(cfg) { cfgPeople = cfg.people ?? []; }

export function person(id) {
  if (!id) return null;
  return cfgPeople.find(p => p.id.toUpperCase() === String(id).toUpperCase()) ?? seen.get(String(id).toUpperCase()) ?? { id, name: `SAP user ${id}`, roles: [], discovered: true };
}

// info: name / e-mail / manager read from SAP (USR21-ADRP, ADR6, HR org structure)
export function discover(id, role, info) {
  if (!id || cfgPeople.some(p => p.id.toUpperCase() === String(id).toUpperCase())) return;
  const key = String(id).toUpperCase();
  const p = seen.get(key) ?? { id: key, name: `SAP user ${key}`, roles: [], discovered: true };
  if (role && !p.roles.includes(role)) p.roles.push(role);
  if (info?.NAME) p.name = info.NAME;
  if (info?.EMAIL) p.email = info.EMAIL;
  if (info?.MANAGER) { p.manager = info.MANAGER; discover(info.MANAGER, "MANAGER"); }
  seen.set(key, p);
}
export const known = () => [...seen.values()].filter(p => !isCfg(p.id));
export function restore(list = []) { for (const p of list) if (!seen.has(p.id) && !isCfg(p.id)) seen.set(p.id, p); }

export const manager = id => person(person(id)?.manager);
export const name = id => person(id)?.name ?? id;
const isCfg = id => cfgPeople.some(p => p.id.toUpperCase() === String(id).toUpperCase());
export const all = () => [...cfgPeople, ...[...seen.values()].filter(p => !isCfg(p.id))];
export const withRole = role => all().filter(p => p.roles.includes(role));

// AP queue routing: first matching rule wins (category, company code, plant), else the default desk.
export function route(cfg, facts) {
  const r = (cfg.routing ?? []).find(x => Object.entries(x.match).every(([k, v]) => String(facts[k] ?? "") === String(v)));
  return r?.to ?? cfg.routingDefault;
}
