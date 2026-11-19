// Sample vendor mails (.eml) for the live S4T test, one per kind the Mail Agent handles:
//   invoice with PDF(s) -> read and checked like an upload; status question -> reply drafted with the SAP status;
//   invoice mentioned but no PDF -> reply asking for the PDF; anything else -> handed to the AP controller.
//   npm run mails            -> samples-sap/mails/*.eml
// To test: copy a mail into invoices/mail (or save a real one from Outlook as .eml there). Match Book picks it up.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../src/paths.js";

const OUT = path.join(ROOT, "samples-sap", "mails");
const VENDOR = "Sonata Demo BP 1 Accounts <accounts@sonatademo.example>";
const pdf = (po, layout) => {
  const d = path.join(ROOT, "samples-sap", `po-${po}`);
  const f = fs.existsSync(d) && fs.readdirSync(d).find(x => x.endsWith(".pdf") && (!layout || x.includes(layout)));
  if (!f) throw new Error(`No PDF for PO ${po} in ${d}`);
  return path.join(d, f);
};

// a plain-text mail, optionally with PDF attachments (MIME multipart, base64), the way Outlook saves it
function eml(from, subject, text, atts = []) {
  const b = "----=_matchbook_" + Math.random().toString(16).slice(2);
  const head = `From: ${from}\r\nTo: ap.invoices@example.com\r\nSubject: ${subject}\r\nDate: ${new Date().toUTCString()}\r\nMIME-Version: 1.0\r\n`;
  if (!atts.length) return `${head}Content-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n`;
  const parts = atts.map(a => `--${b}\r\nContent-Type: application/pdf; name="${path.basename(a)}"\r\nContent-Disposition: attachment; filename="${path.basename(a)}"\r\n`
    + `Content-Transfer-Encoding: base64\r\n\r\n${fs.readFileSync(a).toString("base64").replace(/.{76}/g, "$&\r\n")}\r\n`).join("");
  return `${head}Content-Type: multipart/mixed; boundary="${b}"\r\n\r\n--${b}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n${parts}--${b}--\r\n`;
}

const mails = [
  ["M1_two_invoices.eml", "Invoices DEMO/261105/2148 and DEMO/261105/1072 - PO 4500001041 / 4500001042",
    "Dear AP Team,\r\n\r\nPlease find attached our tax invoices:\r\n  - DEMO/261105/2148 against PO 4500001041 (INR 1,762.92)\r\n  - DEMO/261105/1072 against PO 4500001042 (INR 1,624.84)\r\n\r\nBoth are e-invoices with IRN and QR code.\r\n\r\nRegards,\r\nAccounts, Sonata Demo BP 1",
    [pdf("4500001041"), pdf("4500001042")]],
  ["M2_status_paid.eml", "Payment status - invoice DEMO/261104/8908",
    "Dear Team,\r\n\r\nKindly update the payment status of our invoice no DEMO/261104/8908 against PO 4500001036.\r\n\r\nThanks,\r\nAccounts, Sonata Demo BP 1"],
  ["M3_status_partpaid.eml", "Reminder: balance payment for invoice DEMO/261104/8593",
    "Dear Sir/Madam,\r\n\r\nWe received a part payment for invoice no DEMO/261104/8593. Please let us know when the balance will be paid.\r\n\r\nRegards,\r\nAccounts, Sonata Demo BP 1"],
  ["M4_status_unknown.eml", "Status of invoice DEMO/261020/7777",
    "Hello,\r\n\r\nCould you confirm the status of our invoice no DEMO/261020/7777 sent last month?\r\n\r\nRegards,\r\nAccounts, Sonata Demo BP 1"],
  ["M5_no_attachment.eml", "Invoice DEMO/261105/3001 for PO 4500001039",
    "Dear AP Team,\r\n\r\nPlease process our invoice DEMO/261105/3001 for the material supplied against PO 4500001039.\r\n\r\nRegards,\r\nAccounts, Sonata Demo BP 1"],
  ["M6_other.eml", "Visit next week - annual rate contract",
    "Dear Sir,\r\n\r\nWe would like to visit your Pune plant next week to discuss the annual rate contract for 2027.\r\n\r\nRegards,\r\nSales, Sonata Demo BP 1"],
];

fs.mkdirSync(OUT, { recursive: true });
for (const [file, subject, text, atts] of mails) {
  fs.writeFileSync(path.join(OUT, file), eml(VENDOR, subject, text, atts));
  console.log(`${file.padEnd(24)} ${subject}${atts?.length ? `  [${atts.length} PDF]` : ""}`);
}
console.log(`\nWrote ${mails.length} mails to ${OUT}\nCopy any of them into ${path.join(ROOT, "invoices", "mail")} to test.`);
