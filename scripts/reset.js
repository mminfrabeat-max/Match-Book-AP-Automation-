// Restores mock SAP to its seed data and clears the demo queue. Stop the server first.
//   --all    also clear the real-SAP queue (documents parked in SAP stay in SAP)
//   --users  also delete user accounts (they are created again with the initial password)
import fs from "node:fs";
import path from "node:path";
import { PROCESSED, INBOX, ROOT } from "../src/paths.js";
import * as mock from "../src/sap-mock.js";
import * as pipeline from "../src/pipeline.js";
import * as sap from "../src/sap.js";

const all = process.argv.includes("--all");
mock.reset();
sap.use("mock"); pipeline.init("mock"); pipeline.resetState();
if (all) { sap.use("rfc"); pipeline.init("rfc"); pipeline.resetState(); }
if (fs.existsSync(PROCESSED)) for (const f of fs.readdirSync(PROCESSED)) if (f.startsWith("mock_") || all) fs.rmSync(path.join(PROCESSED, f));
for (const d of ["invoices/mail-processed", ...(all ? ["data/dms"] : [])]) fs.rmSync(path.join(ROOT, d), { recursive: true, force: true });
if (!all) fs.rmSync(path.join(ROOT, "data", "dms", "4000"), { recursive: true, force: true });
if (process.argv.includes("--users")) fs.rmSync(path.join(ROOT, "data", "runtime", "users.json"), { force: true });
fs.mkdirSync(INBOX, { recursive: true });
console.log(`Mock SAP restored, demo queue cleared${all ? ", real-SAP queue cleared" : ""}${process.argv.includes("--users") ? ", user accounts reset" : ""}.`);
