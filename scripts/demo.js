// Demo intake: sample invoices arrive both ways, by mail and in the common folder.
//   common folder : S01, S03, S04, S05, S07      (invoices/inbox)
//   mailbox       : S02 and S06 as invoice mails, plus a status question, an invoice mail without the PDF
//                   and an unrelated mail       (invoices/mail/*.eml)
// Generate the PDFs first with `npm run samples`.
import fs from "node:fs";
import path from "node:path";
import { ROOT, INBOX } from "../src/paths.js";
import { MAILDROP } from "../src/intake.js";

const SAMPLES = path.join(ROOT, "samples");
const files = fs.existsSync(SAMPLES) ? fs.readdirSync(SAMPLES).filter(f => f.endsWith(".pdf")).sort() : [];
if (!files.length) { console.log("No samples yet. Run: npm run samples"); process.exit(1); }
const BY_MAIL = { S02: { from: "Shree Ganesh Engineering <sales@shreeganesh.example>", subject: "Tax Invoice SGE/1187 against PO 4500018305" },
  S06: { from: "Om Sai Fabricators <omsaifab@example.com>", subject: "Invoice no OSF/26/118 - prilling tower repair" } };

fs.mkdirSync(INBOX, { recursive: true });
fs.mkdirSync(MAILDROP, { recursive: true });

const eml = (from, subject, text, att) => {
  const b = "----=_demo_" + Math.random().toString(16).slice(2);
  const head = `From: ${from}\r\nTo: ap.invoices@example.com\r\nSubject: ${subject}\r\nDate: ${new Date().toUTCString()}\r\nMIME-Version: 1.0\r\n`;
  if (!att) return `${head}Content-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n`;
  const data = fs.readFileSync(att).toString("base64").replace(/.{76}/g, "$&\r\n");
  return `${head}Content-Type: multipart/mixed; boundary="${b}"\r\n\r\n--${b}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n--${b}\r\n`
    + `Content-Type: application/pdf; name="${path.basename(att)}"\r\nContent-Disposition: attachment; filename="${path.basename(att)}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${data}\r\n--${b}--\r\n`;
};

let n = 0;
for (const f of files) {
  const m = BY_MAIL[f.slice(0, 3)];
  if (m) fs.writeFileSync(path.join(MAILDROP, `${f.slice(0, 3)}_mail.eml`), eml(m.from, m.subject, "Dear Sir,\r\n\r\nPlease find attached our invoice for processing.\r\n\r\nRegards", path.join(SAMPLES, f)));
  else fs.copyFileSync(path.join(SAMPLES, f), path.join(INBOX, f));
  n++;
}
fs.writeFileSync(path.join(MAILDROP, "Z1_status.eml"), eml("Vishwa Carbon Accounts <accounts@vishwacarbon.example>", "Payment status - invoice VC/26-27/0412", "Dear Team,\r\n\r\nKindly update the payment status of our invoice no VC/26-27/0412.\r\n\r\nThanks"));
fs.writeFileSync(path.join(MAILDROP, "Z2_noattach.eml"), eml("Kaveri Pumps <accounts@kaveripumps.example>", "Invoice for October supplies", "Hi,\r\n\r\nWe have sent our invoice for the October supplies. Please process.\r\n\r\nRegards"));
fs.writeFileSync(path.join(MAILDROP, "Z3_other.eml"), eml("Nirmal Fasteners <nirmal@fasteners.example>", "Visit next week", "Dear Sir,\r\n\r\nWe would like to visit your Taloja plant next week to discuss the annual rate contract.\r\n\r\nRegards"));
console.log(`Demo: ${n - Object.keys(BY_MAIL).length} invoices into the common folder, ${Object.keys(BY_MAIL).length} invoice mails + 3 other mails into invoices/mail`);
