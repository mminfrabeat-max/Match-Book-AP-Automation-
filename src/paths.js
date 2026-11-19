import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const INBOX = path.join(ROOT, "invoices", "inbox");
export const PROCESSED = path.join(ROOT, "invoices", "processed");
export const CONFIG = path.join(ROOT, "config.json");
// separate queues for simulated and real SAP, so demo runs never mix with real documents
export const stateFile = mode => path.join(ROOT, "data", "runtime", `state-${mode}.json`);
