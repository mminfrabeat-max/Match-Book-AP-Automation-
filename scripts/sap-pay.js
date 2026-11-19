// Runs sap_rfc/pay_invoice.py with the SAP Python and settings from .env.local (AP_RFC_PYTHON, AP_RFC_ENV).
//   npm run sap:pay -- 9561                     dry run (stops at Simulate, posts nothing)
//   npm run sap:pay -- 9561 --post              full payment
//   npm run sap:pay -- 9563 --amount 700 --post partial payment
import { spawnSync } from "node:child_process";
import path from "node:path";
import { ROOT } from "../src/paths.js";

const py = process.env.AP_RFC_PYTHON || (process.platform === "win32" ? "py" : "python3");
const r = spawnSync(py, ["-I", path.join(ROOT, "sap_rfc", "pay_invoice.py"), ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
process.exit(r.status ?? 1);
