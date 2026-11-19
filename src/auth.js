// Login, sessions and permissions.
// Passwords are stored as scrypt hashes in data/runtime/users.json (never in plain text, never logged).
// First start creates one account per person in config.json with the initial password from
// config.auth.initialPassword; everyone must change it at first login.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ROOT } from "./paths.js";
import { readJson, writeJson } from "./jsonfile.js";

const FILE = path.join(ROOT, "data", "runtime", "users.json");
// Sessions survive a server restart: kept in data/runtime/sessions.json under the SHA-256 of the token
// (the token itself only lives in the browser cookie).
const SFILE = path.join(ROOT, "data", "runtime", "sessions.json");
const sessions = new Map();          // sha256(token) -> { username, exp }
const tkey = token => crypto.createHash("sha256").update(token).digest("hex");
function loadSessions() {
  const now = Date.now();
  for (const [k, s] of Object.entries(readJson(SFILE, {}))) if (s.exp > now) sessions.set(k, s);
}
const saveSessions = () => { const now = Date.now(); writeJson(SFILE, Object.fromEntries([...sessions].filter(([, s]) => s.exp > now)), { pretty: false }); };
const failures = new Map();          // username -> { n, until }
let users = [];
let cfgAuth = {};

// What each role may do. Viewing is limited by role in the UI and API as well.
export const PERMS = {
  ADMIN: ["view_all", "park", "review", "override", "monitor", "learning", "users", "demo", "mail"],
  AP_CONTROLLER: ["view_all", "park", "review", "override", "monitor", "learning", "mail"],
  AP: ["view_all", "park", "review", "mail", "demo"],
  BUYER: ["view_own"], REQUESTOR: ["view_own"], MANAGER: ["view_team"], QC: ["view_qc"], STORES: ["view_stores"],
};

const hash = (pw, salt = crypto.randomBytes(16).toString("hex")) => `${salt}:${crypto.scryptSync(pw, salt, 32).toString("hex")}`;
const verify = (pw, stored) => {
  const [salt, h] = stored.split(":");
  const a = Buffer.from(h, "hex"), b = crypto.scryptSync(pw, salt, 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const save = () => writeJson(FILE, users);
const pub = u => u && { username: u.username, name: u.name, roles: u.roles, personId: u.personId, mustChange: !!u.mustChange, perms: perms(u) };
export const perms = u => [...new Set(u.roles.flatMap(r => PERMS[r] ?? []))];
export const can = (u, p) => !!u && perms(u).includes(p);

export function init(cfg) {
  cfgAuth = cfg.auth;
  if (fs.existsSync(FILE) || fs.existsSync(`${FILE}.bak`)) { users = readJson(FILE); loadSessions(); return { created: 0 }; }
  const accounts = [{ username: "admin", name: "Administrator", roles: ["ADMIN"], personId: null },
    ...cfg.people.map(p => ({ username: p.id.toLowerCase(), name: p.name, roles: p.roles, personId: p.id }))];
  users = accounts.map(a => ({ ...a, password: hash(cfgAuth.initialPassword), mustChange: true, created: new Date().toISOString() }));
  save();
  return { created: users.length };
}

export function login(username, password) {
  const key = String(username || "").toLowerCase().trim();
  const f = failures.get(key);
  if (f?.until > Date.now()) throw new Error(`Too many failed attempts. Try again in ${Math.ceil((f.until - Date.now()) / 60000)} min.`);
  const u = users.find(x => x.username === key && !x.disabled);
  if (!u || !verify(String(password || ""), u.password)) {
    const n = (f?.n ?? 0) + 1;
    failures.set(key, { n, until: n >= cfgAuth.maxFailures ? Date.now() + cfgAuth.lockMinutes * 60000 : 0 });
    throw new Error("Wrong username or password");
  }
  failures.delete(key);
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(tkey(token), { username: u.username, exp: Date.now() + cfgAuth.sessionHours * 3600_000 });
  u.lastLogin = new Date().toISOString(); save(); saveSessions();
  return { token, user: pub(u) };
}

export function fromRequest(req) {
  const token = (req.headers.cookie || "").match(/(?:^|;\s*)apsid=([a-f0-9]{64})/)?.[1];
  const k = token && tkey(token), s = k && sessions.get(k);
  if (!s || s.exp < Date.now()) { if (k && sessions.delete(k)) saveSessions(); return null; }
  const u = users.find(x => x.username === s.username && !x.disabled);
  return u ? { ...pub(u), token } : null;
}

export const logout = token => { sessions.delete(tkey(token)); saveSessions(); };
// sign a user out everywhere (password reset, account disabled)
const endSessions = username => { let n = 0; for (const [k, s] of sessions) if (s.username === username) { sessions.delete(k); n++; } if (n) saveSessions(); };

export function changePassword(username, oldPw, newPw) {
  const u = users.find(x => x.username === username);
  if (!u || !verify(String(oldPw || ""), u.password)) throw new Error("Current password is wrong");
  if (String(newPw).length < 8 || !/\d/.test(newPw) || !/[A-Za-z]/.test(newPw)) throw new Error("New password: at least 8 characters with letters and numbers");
  if (newPw === cfgAuth.initialPassword) throw new Error("Choose a password different from the initial one");
  u.password = hash(newPw); u.mustChange = false; save();
}

export const list = () => users.map(u => ({ ...pub(u), disabled: !!u.disabled, lastLogin: u.lastLogin ?? null }));

export function upsert({ username, name, roles, personId }) {
  const key = String(username || "").toLowerCase().trim();
  if (!/^[a-z0-9._-]{3,30}$/.test(key)) throw new Error("Username: 3-30 letters, numbers, dot, dash");
  if (!roles?.length || roles.some(r => !PERMS[r])) throw new Error("Pick at least one valid role");
  let u = users.find(x => x.username === key);
  if (u) Object.assign(u, { name: name || u.name, roles, personId: personId ?? u.personId });
  else { u = { username: key, name: name || key, roles, personId: personId || key.toUpperCase(), password: hash(cfgAuth.initialPassword), mustChange: true, created: new Date().toISOString() }; users.push(u); }
  save(); return pub(u);
}

export function resetPassword(username) {
  const u = users.find(x => x.username === username);
  if (!u) throw new Error("No such user");
  u.password = hash(cfgAuth.initialPassword); u.mustChange = true; save();
  endSessions(username);
}

export function setDisabled(username, disabled) {
  const u = users.find(x => x.username === username);
  if (!u || u.username === "admin") throw new Error("Cannot change this user");
  u.disabled = disabled; save();
  if (disabled) endSessions(username);
}
