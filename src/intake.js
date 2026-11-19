// Invoice Reading / Monitoring Agent: collects invoices from
//   1. the common folder       invoices/inbox/*.pdf
//   2. a mail drop folder      invoices/mail/*.eml   (mails saved from Outlook, or written by the demo script)
//   3. a mailbox via Microsoft Graph (optional, AP_GRAPH_* in .env.local; not tested against a live tenant yet)
// For mail, the Orchestration Agent first checks whether the mail is about an invoice (keyword or invoice
// number + PDF). Other mails go to the Mail Agent: a status reply when it asks about a known invoice,
// otherwise a "please send the invoice as PDF" reply.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./paths.js";

export const MAILDROP = path.join(ROOT, "invoices", "mail");
const MAILDONE = path.join(ROOT, "invoices", "mail-processed");

// ---------- minimal MIME parser (multipart, base64 / quoted-printable, attachments) ----------
function splitHead(raw) {
  const i = raw.search(/\r?\n\r?\n/);
  const head = i < 0 ? raw : raw.slice(0, i), body = i < 0 ? "" : raw.slice(i).replace(/^\r?\n\r?\n/, "");
  const headers = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m) headers[m[1].toLowerCase()] = m[2];
  }
  return { headers, body };
}
const param = (h, k) => (h || "").match(new RegExp(`${k}\\*?=\\s*"?([^";]+)"?`, "i"))?.[1];
const decodeWord = s => (s || "").replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, cs, enc, txt) =>
  enc.toUpperCase() === "B" ? Buffer.from(txt, "base64").toString("utf8") : txt.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))));

function parsePart(raw, out) {
  const { headers, body } = splitHead(raw);
  const ct = headers["content-type"] || "text/plain";
  if (/^multipart\//i.test(ct)) {
    const b = param(ct, "boundary");
    for (const p of body.split(`--${b}`).slice(1)) if (!p.startsWith("--")) parsePart(p.replace(/^\r?\n/, ""), out);
    return;
  }
  const enc = (headers["content-transfer-encoding"] || "").toLowerCase();
  const buf = enc === "base64" ? Buffer.from(body.replace(/\s+/g, ""), "base64")
    : enc === "quoted-printable" ? Buffer.from(body.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), "latin1")
    : Buffer.from(body, "utf8");
  const name = decodeWord(param(headers["content-disposition"], "filename") || param(ct, "name"));
  if (name || /^application\/pdf/i.test(ct)) out.attachments.push({ name: name || "attachment.pdf", contentType: ct.split(";")[0], data: buf });
  else if (/^text\/plain/i.test(ct)) out.text += buf.toString("utf8");
  else if (/^text\/html/i.test(ct) && !out.text) out.text += buf.toString("utf8").replace(/<[^>]+>/g, " ");
}

export function parseEml(raw) {
  const { headers } = splitHead(raw);
  const out = { from: decodeWord(headers.from), to: decodeWord(headers.to), subject: decodeWord(headers.subject), date: headers.date, text: "", attachments: [] };
  parsePart(raw, out);
  return out;
}

// ---------- Orchestration Agent: is this mail an invoice? ----------
const INVOICE_WORD = /\b(tax\s+)?invoice|\bbill\b|\binv\s*no|\bbilling\b/i;
const STATUS_WORD = /\b(status|payment|paid|pay|when|pending|update|remind|reminder)\b/i;
const INV_NO = /\b(?:invoice|inv|bill)\s*(?:no\.?|number|#)?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\/\-]{2,})/i;

export function classify(mail) {
  const pdfs = mail.attachments.filter(a => /pdf/i.test(a.contentType) || /\.pdf$/i.test(a.name));
  const words = `${mail.subject}\n${mail.text}`;
  const invNo = [...words.matchAll(new RegExp(INV_NO, "gi"))].map(m => m[1]).find(v => /\d/.test(v)) ?? null;
  if (pdfs.length && (INVOICE_WORD.test(words) || invNo)) return { kind: "INVOICE", pdfs, invNo };
  if (pdfs.length) return { kind: "INVOICE", pdfs, invNo, note: "PDF without invoice keyword: processed, flagged for review" };
  if (STATUS_WORD.test(words) && invNo) return { kind: "STATUS_QUERY", invNo };
  if (INVOICE_WORD.test(words)) return { kind: "NO_ATTACHMENT", invNo };
  return { kind: "OTHER" };
}

// ---------- mail drop folder ----------
export function pendingMailFiles() {
  fs.mkdirSync(MAILDROP, { recursive: true });
  return fs.readdirSync(MAILDROP).filter(f => /\.eml$/i.test(f)).sort().map(f => path.join(MAILDROP, f));
}

export function archiveMailFile(file, id) {
  fs.mkdirSync(MAILDONE, { recursive: true });
  const dest = path.join(MAILDONE, `${id}_${path.basename(file)}`);
  fs.renameSync(file, dest);
  return path.relative(ROOT, dest);
}

// ---------- Microsoft Graph mailbox (optional) ----------
export const graphEnabled = () => !!(process.env.AP_GRAPH_TENANT_ID && process.env.AP_GRAPH_CLIENT_ID && process.env.AP_GRAPH_CLIENT_SECRET && process.env.AP_GRAPH_MAILBOX);
let token = null;
async function graphToken() {
  if (token && token.exp > Date.now() + 60_000) return token.value;
  const res = await fetch(`https://login.microsoftonline.com/${process.env.AP_GRAPH_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.AP_GRAPH_CLIENT_ID, client_secret: process.env.AP_GRAPH_CLIENT_SECRET, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }),
  });
  if (!res.ok) throw new Error(`Graph token ${res.status}`);
  const j = await res.json();
  token = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return token.value;
}

export async function fetchGraphMails(max = 10) {
  const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(process.env.AP_GRAPH_MAILBOX)}`;
  const h = { Authorization: `Bearer ${await graphToken()}` };
  const list = await (await fetch(`${base}/mailFolders/inbox/messages?$filter=isRead eq false&$top=${max}&$select=id,subject,from,receivedDateTime,body`, { headers: h })).json();
  const mails = [];
  for (const m of list.value ?? []) {
    const att = await (await fetch(`${base}/messages/${m.id}/attachments`, { headers: h })).json();
    mails.push({
      graphId: m.id, from: m.from?.emailAddress?.address ?? "", subject: m.subject ?? "", date: m.receivedDateTime,
      text: (m.body?.content ?? "").replace(/<[^>]+>/g, " "),
      attachments: (att.value ?? []).filter(a => a.contentBytes).map(a => ({ name: a.name, contentType: a.contentType, data: Buffer.from(a.contentBytes, "base64") })),
    });
    await fetch(`${base}/messages/${m.id}`, { method: "PATCH", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify({ isRead: true }) });
  }
  return mails;
}
