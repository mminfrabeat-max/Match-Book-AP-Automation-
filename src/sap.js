// SAP Integration Agent: one interface, two back ends (simulated or real SAP over RFC).
import * as mock from "./sap-mock.js";
import * as rfc from "./sap-rfc.js";

let impl = mock;
export let mode = "mock";

export function use(m) { mode = m === "rfc" ? "rfc" : "mock"; impl = mode === "rfc" ? rfc : mock; }
export const label = () => impl.label();
export const getContext = f => impl.getContext(f);
export const park = (payload, pdf) => impl.park(payload, pdf);
export const attach = (objtype, objkey, pdf, title) => impl.attach(objtype, objkey, pdf, title);
export const attachments = (objtype, objkey) => impl.attachments(objtype, objkey);
export const monitor = days => impl.monitor(days);
export const status = docs => impl.status(docs);
export { mock, rfc };
