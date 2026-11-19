// Validation Agent (+ Quality Inspection Agent check). Deterministic rules over the invoice fields and
// the SAP context (simulated or real - same shape). Every result can be explained to an auditor.
// Status: PASS | WARN (AP review) | BLOCK (exception) | INFO | NA.

const inr = n => (n ?? 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// "VC/26-27/0412" and "VC-26-27-412" both normalise to "VC2627412".
const normNo = s => (s || "").toUpperCase().split(/[^A-Z0-9]+/).map(p => p.replace(/^0+(?=\d)/, "")).join("");
const fiscalYear = iso => { const d = new Date(iso || Date.now()); return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; };
const norm = s => (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
// movements that put received goods into stock: 101, 105 (from GR blocked stock), 109 (from valuated GR blocked stock)
const GR_FINAL = ["101", "105", "109"];
const STD_RATES = [0, 5, 12, 18, 28];

// Invoice line -> PO item: same description, else same position, else the only open item.
export function matchLines(f, po) {
  const items = po?.items ?? [];
  const used = new Set();
  return (f.line_items ?? []).map((l, i) => {
    let it = items.find(x => !used.has(x.EBELP) && norm(x.TXZ01) && norm(x.TXZ01) === norm(l.desc))
      ?? (items[i] && !used.has(items[i].EBELP) ? items[i] : null)
      ?? (items.length === 1 && !used.has(items[0].EBELP) ? items[0] : null);
    if (it) used.add(it.EBELP);
    return { line: l, item: it ?? null };
  });
}

// The vendor's earlier SAP invoice with the same number in the same fiscal year (check 11; also used before a park retry).
export function findDuplicate(f, ctx) {
  if (!f.invoice_no) return null;
  const fy = fiscalYear(f.invoice_date);
  return (ctx.invoices ?? []).find(i => normNo(i.XBLNR) === normNo(f.invoice_no) && fiscalYear(i.BLDAT) === fy) ?? null;
}

function taxCodeFor(codes, type, rate) {
  return Object.entries(codes).find(([, v]) => v.type === type && v.rate === rate)?.[0] ?? null;
}

export function validate(f, ctx, cfg, confidence = {}) {
  const C = [];
  const add = (id, name, status, detail, invoice = null, sapValue = null) => C.push({ id, name, status, detail, invoice, sap: sapValue });
  const codes = cfg.taxCodes;
  const order = ctx.po;
  const vend = ctx.vendor ?? ctx.vendorByGstin;
  const plt = ctx.plant;
  const isService = order?.TYPE === "SERVICE";
  const pairs = order ? matchLines(f, order) : [];

  // 1 stamp / signature
  if (f.signature_visual) {                       // visual check of the signatory area (digital PDFs and offline OCR)
    const v = f.signature_visual, both = f.stamp_present && f.signature_present, none = !f.stamp_present && !f.signature_present;
    add(1, "Stamp and signature", both ? "PASS" : none ? "BLOCK" : "WARN",
      `${both ? "Stamp and signature found" : none ? "No stamp and no signature found" : `Stamp ${f.stamp_present ? "found" : "not found"}, signature ${f.signature_present ? "found" : "not found"}: check the PDF`}`
      + ` (visual check ${v.anchored ? "above 'Authorised Signatory'" : "of the lower right of the page"}; ink scores ${v.stampScore} / ${v.signScore})`);
  } else if (f.stamp_present != null || f.signature_present != null)
    add(1, "Stamp and signature", f.stamp_present && f.signature_present ? "PASS" : "BLOCK",
      `Stamp ${f.stamp_present ? "found" : "missing"}, signature ${f.signature_present ? "found" : "missing"} (judged on the image by the vision model)`);
  else
    add(1, "Stamp and signature", f.signatory_block ? "PASS" : "BLOCK",
      f.signatory_block ? "Authorised-signatory block found (text check; a visual check needs an image-capable model)" : "No authorised-signatory block on the invoice");
  // a digitally signed invoice needs no physical stamp / signature: an e-invoice whose QR is signed by the IRP
  // (verified with the portal's public key) or a PDF with a digital signature (DSC). Switch off: stampNotNeededWhenDigital: false
  const c1 = C[C.length - 1], digital = f.einvoice_qr && f.einvoice_sig === true ? "e-invoice QR signed by the IRP (verified)" : f.digital_signature ? "digital signature (DSC) on the PDF" : null;
  if (digital && c1.status !== "PASS" && cfg.stampNotNeededWhenDigital !== false)
    Object.assign(c1, { status: "PASS", detail: `Digitally signed invoice (${digital}): physical stamp and signature not required. Visual check: ${c1.detail}` });

  // 2 vendor master
  const V = "Vendor GSTIN / PAN vs vendor master";
  if (!f.vendor_gstin) add(2, V, "BLOCK", "Vendor GSTIN not found on invoice");
  else if (!vend) add(2, V, "BLOCK", "No vendor in SAP with this GSTIN", f.vendor_gstin);
  else if (!vend.GSTIN) add(2, V, "WARN", `GSTIN not maintained for vendor ${vend.LIFNR} ${vend.NAME1} in SAP: check manually`, f.vendor_gstin, "(empty)");
  else if (vend.GSTIN !== f.vendor_gstin) add(2, V, "BLOCK", `Invoice GSTIN differs from vendor ${vend.LIFNR} ${vend.NAME1} in SAP`, f.vendor_gstin, vend.GSTIN);
  else {
    const panOk = !f.vendor_pan || !vend.PAN || f.vendor_pan === vend.PAN;
    add(2, V, panOk ? "PASS" : "BLOCK", !panOk ? `PAN ${f.vendor_pan} differs from master ${vend.PAN}` : `Vendor ${vend.LIFNR} ${vend.NAME1}`,
      f.vendor_gstin, vend.GSTIN);
  }

  // 3 PO
  const P = "PO exists, released, same vendor";
  if (!f.po_no) add(3, P, "BLOCK", "PO number not found on invoice");
  else if (!order) add(3, P, "BLOCK", ctx.poError ? `PO ${f.po_no}: ${ctx.poError}` : `PO ${f.po_no} not found in SAP`, f.po_no);
  else {
    const issues = [order.FRGKE !== "R" && "PO not released",
      ctx.vendorByGstin && ctx.vendorByGstin.LIFNR !== order.LIFNR && `invoice GSTIN belongs to vendor ${ctx.vendorByGstin.LIFNR}, PO to ${order.LIFNR}`].filter(Boolean);
    add(3, P, issues.length ? "BLOCK" : "PASS", issues.join("; ") || `Released, company code ${order.BUKRS}, buyer ${order.ERNAM}`, f.po_no, order.EBELN);
  }

  // 4 vendor invoice number (XBLNR is 16 chars in SAP)
  add(4, "Vendor invoice number", !f.invoice_no ? "BLOCK" : f.invoice_no.length > 16 ? "WARN" : "PASS",
    !f.invoice_no ? "Missing" : f.invoice_no.length > 16 ? "Longer than 16 characters, will be cut in SAP" : "Present", f.invoice_no);

  // 5 GRN / SES available
  if (order) {
    const docs = isService ? ctx.ses.map(s => s.LBLNI) : [...new Set(ctx.grs.map(g => g.MBLNR))];
    add(5, isService ? "Service entry sheet available" : "GRN available", docs.length ? "PASS" : "BLOCK",
      docs.length ? `${isService ? "SES" : "GRN"} ${docs.slice(0, 4).join(", ")}${docs.length > 4 ? ` +${docs.length - 4} more` : ""}` : `No ${isService ? "SES" : "goods receipt"} posted yet`);
  }

  // 6 three-way match, per line
  const M = "3-way match: quantity and rate";
  if (order && !pairs.length) add(6, M, "BLOCK", "Line items could not be read from the invoice");
  for (const { line, item } of pairs) {
    if (!item) { add(6, M, "BLOCK", `Invoice line "${line.desc}" does not match any PO item`); continue; }
    const open = item.GR_QTY - item.IR_QTY;
    const rateDiff = item.NETPR ? ((line.rate - item.NETPR) / item.NETPR) * 100 : 0;
    const qtyOk = line.qty <= open + 1e-6, rateOk = Math.abs(rateDiff) <= cfg.rateTolerancePct;
    add(6, `${M} (item ${Number(item.EBELP)})`, qtyOk && rateOk ? "PASS" : "WARN",
      [!qtyOk && `Invoice qty ${line.qty} > open received qty ${open} (received ${item.GR_QTY}, already invoiced ${item.IR_QTY})`,
       !rateOk && `Rate ${inr(line.rate)} is ${rateDiff.toFixed(2)}% from PO rate ${inr(item.NETPR)} (tolerance ${cfg.rateTolerancePct}%)`]
        .filter(Boolean).join("; ") || `${line.qty} ${item.MEINS} @ ${inr(item.NETPR)} matches PO and receipt`,
      `${line.qty} @ ${inr(line.rate)}`, `open ${open} @ ${inr(item.NETPR)}`);
  }

  // 7 GST type + amount, 8 tax code
  let taxCode = null;
  if (order) {
    const tax = (f.cgst || 0) + (f.sgst || 0) + (f.igst || 0);
    const invRate = f.taxable_value ? Math.round((tax / f.taxable_value) * 1000) / 10 : null;
    const item = pairs.find(p => p.item)?.item ?? order.items[0];
    const poCode = item?.MWSKZ && codes[item.MWSKZ] ? item.MWSKZ : null;
    const expRate = item?.GST_RATE ?? (poCode ? codes[poCode].rate : null);
    const vState = (vend?.GSTIN || f.vendor_gstin || "").slice(0, 2), pState = (plt?.GSTIN || "").slice(0, 2);
    const expType = vState && pState ? (vState === pState ? "CGST+SGST" : "IGST") : poCode ? codes[poCode].type : null;
    const problems = [
      expType && f.gst_type !== expType && `invoice charges ${f.gst_type ?? "no GST"}, expected ${expType}${vState && pState ? ` (vendor state ${vState}, plant state ${pState})` : ` (PO tax code ${poCode})`}`,
      expRate != null && Math.abs(tax - (f.taxable_value || 0) * expRate / 100) > cfg.taxToleranceInr && `tax ${inr(tax)} vs expected ${inr((f.taxable_value || 0) * expRate / 100)} at ${expRate}%`,
      expRate == null && !STD_RATES.includes(invRate) && `invoice GST rate ${invRate}% is not a standard rate`,
      f.total && Math.abs((f.taxable_value || 0) + tax - f.total) > cfg.taxToleranceInr && `total ${inr(f.total)} is not taxable + tax`,
    ].filter(Boolean);
    add(7, "GST type and amount", problems.length ? "BLOCK" : "PASS",
      problems.join("; ") || `${f.gst_type} @ ${expRate ?? invRate}% = ${inr(tax)}${expRate == null ? " (PO has no tax code: rate taken from invoice)" : ""}${!expType ? "; GST type not checked (plant GSTIN not in SAP)" : ""}`,
      inr(tax), expRate != null ? `${expRate}%` : null);
    // the PO's tax code only if it fits the GST type (state rule, else invoice): an IGST code on an intra-state PO
    // would book IGST, so the matching code is proposed instead and the PO is flagged
    const needType = expType ?? f.gst_type;
    const poFits = poCode && (!needType || !codes[poCode].type || codes[poCode].type === needType);
    const proposed = poFits ? null : taxCodeFor(codes, needType, expRate ?? invRate);
    taxCode = poFits ? poCode : proposed;
    const poNote = poCode && !poFits ? `PO item has ${poCode} (${codes[poCode].text}) but ${needType} is due: correct the PO tax code in ME22N` : "";
    add(8, "Tax code for MIRO", taxCode && !poNote ? "PASS" : "WARN",
      taxCode ? `${taxCode} (${codes[taxCode].text})${poFits ? " from PO" : " proposed from invoice GST"}${poNote ? `; ${poNote}` : ""}`
        : `No tax code configured for ${needType} ${expRate ?? invRate}%${poNote ? `; ${poNote}` : ""}: set it in config.json`, null, taxCode);
  }

  // 9 quality inspection (Quality Inspection Agent)
  if (order && !isService) {
    const lots = ctx.lots ?? [];
    const required = order.items.some(i => i.QI_REQUIRED) || lots.length > 0;
    if (!required) add(9, "Quality inspection usage decision", "NA", "No inspection lot for this PO");
    else {
      const rej = lots.find(l => l.UD === "R"), pend = lots.find(l => !l.UD) ?? (!lots.length ? {} : null);
      add(9, "Quality inspection usage decision", rej || pend ? "BLOCK" : "PASS",
        rej ? `Lot ${rej.PRUEFLOS}: ${rej.UD_TEXT}` : pend ? `Usage decision pending${pend.PRUEFLOS ? ` on lot ${pend.PRUEFLOS}` : ""}` : `Lot ${lots.map(l => l.PRUEFLOS).join(", ")} accepted`);
    }
  }

  // 10 SES released (service POs)
  if (order && isService) {
    const s = ctx.ses[0];
    add(10, "SES released", s?.RELEASED ? "PASS" : "BLOCK", s ? (s.RELEASED ? `SES ${s.LBLNI} released` : `SES ${s.LBLNI} not released`) : "No SES");
  }

  // 26 JMS (joint measurement sheet): SAP has no standard field, so the rule is in config.jms until DFPCL names theirs.
  // Applies to service POs (jms.servicePOs) and to POs whose text mentions JMS; done = a JMS file attached to the SES or
  // PO (Services for Object) or JMS in the SES text.
  if (order) {
    const J = cfg.jms ?? {}, pat = new RegExp(J.pattern ?? "\\bJMS\\b|joint\\s+measurement", "i");
    const texts = [order.TEXT, ...(order.items ?? []).map(i => i.TXZ01)].filter(Boolean);
    const why = texts.some(t => pat.test(t)) ? "PO text asks for a JMS" : isService && J.servicePOs !== false ? "service PO" : null;
    if (why) {
      const proof = [
        ...(ctx.ses ?? []).flatMap(s => [s.JMS, pat.test(s.TEXT || "") && `SES ${s.LBLNI} text "${s.TEXT}"`, ...(s.ATTACHMENTS ?? []).filter(a => pat.test(a)).map(a => `"${a}" on SES ${s.LBLNI}`)]),
        ...(ctx.poAttachments ?? []).filter(a => pat.test(a)).map(a => `"${a}" on PO ${order.EBELN}`),
      ].filter(Boolean);
      add(26, "JMS sheet (joint measurement) completed", proof.length ? "PASS" : (J.missingStatus ?? "BLOCK"),
        proof.length ? `${why}: ${proof.join("; ")}` : `JMS needed (${why}) but none found: attach the signed JMS to the SES${ctx.ses?.[0] ? ` ${ctx.ses[0].LBLNI}` : ""} or PO ${order.EBELN} (Services for Object > Create attachment, title starting "JMS")`);
    }
  }

  // 11 duplicate (vendor + normalised number + fiscal year, across parked and posted)
  if (vend && f.invoice_no) {
    const hit = findDuplicate(f, ctx);
    add(11, "Duplicate invoice", hit ? "BLOCK" : "PASS",
      hit ? `Same as ${hit.XBLNR} already ${hit.STATUS.toLowerCase()} as document ${hit.BELNR}/${hit.GJAHR}` : `No match among ${(ctx.invoices ?? []).length} earlier invoices of this vendor (number + fiscal year)`, f.invoice_no, hit?.BELNR ?? null);
  }

  // 12 ship-to GSTIN vs plant
  if (plt) {
    if (!plt.GSTIN) add(12, "Ship-to GSTIN = PO plant GSTIN", "WARN", `Plant ${plt.WERKS} ${plt.NAME1} has no GSTIN in SAP (business place): check manually. Invoice ship-to ${f.ship_to_gstin ?? "-"}`, f.ship_to_gstin, "(empty)");
    else add(12, "Ship-to GSTIN = PO plant GSTIN", f.ship_to_gstin === plt.GSTIN ? "PASS" : "BLOCK",
      f.ship_to_gstin === plt.GSTIN ? `Plant ${plt.WERKS} ${plt.NAME1}` : `Invoice ship-to ${f.ship_to_gstin ?? "missing"}, PO plant ${plt.WERKS} ${plt.NAME1} is ${plt.GSTIN}`, f.ship_to_gstin, plt.GSTIN);
  }

  // 13 shipment documents vs GR
  if (order && !isService && ctx.grs.length) {
    const g = ctx.grs[ctx.grs.length - 1];
    const lrOk = !g.LR_NO || !f.lr_no || norm(g.LR_NO) === norm(f.lr_no);
    const dnOk = !g.XBLNR || !f.delivery_note || norm(g.XBLNR) === norm(f.delivery_note);
    add(13, "LR / delivery note vs GRN", lrOk && dnOk ? "PASS" : "WARN",
      lrOk && dnOk ? "Shipment references match GRN (or not given)" : `Invoice LR ${f.lr_no ?? "-"} / DN ${f.delivery_note ?? "-"}, GRN LR ${g.LR_NO || "-"} / DN ${g.XBLNR || "-"}`);
  }

  // 14 PO text clauses
  if (order) {
    const has = re => new RegExp(`(?<!\\bno\\s)(?:${re})`, "i").test(order.TEXT || "");
    const flags = [has("\\bBG\\b|bank guarantee") && "BG", has("\\bSD\\b|security deposit") && "SD", has("\\bLD\\b|liquidated") && "LD", has("penalt") && "Penalty"].filter(Boolean);
    add(14, "BG / LD / penalty clauses in PO text", flags.length ? "INFO" : "PASS", flags.length ? `${flags.join(", ")} clause: "${order.TEXT}"` : order.TEXT ? "No special clauses" : "No PO header text");

    // 25 BG / security deposit received: a BG or SD clause needs the guarantee recorded in SAP as a noted item
    // (F-57, special G/L G 'Guarantee received' / H 'Security deposit'), valid and for the agreed % of the PO value
    const poValue = (order.items ?? []).reduce((a, i) => a + (i.MENGE || 0) * (i.NETPR || 0), 0);
    const today = new Date().toISOString().slice(0, 10);
    for (const [type, name, re] of [["BG", "bank guarantee", "\\bBG\\b|bank guarantee"], ["SD", "security deposit", "\\bSD\\b|security deposit"]]) {
      if (!flags.includes(type)) continue;
      const pct = Number(((order.TEXT || "").match(new RegExp(`(?:${re})\\D{0,12}?(\\d+(?:\\.\\d+)?)\\s*%`, "i")) ?? [])[1]) || null;
      const all = (ctx.guarantees ?? []).filter(g => g.TYPE === type), linked = all.filter(g => g.LINKED), use = linked.length ? linked : all;
      const total = use.reduce((a, g) => a + g.AMOUNT, 0), need = pct && poValue ? poValue * pct / 100 : null;
      const issues = [
        !use.length && `PO has a ${type} clause${pct ? ` (${pct}%${need ? ` = ${inr(need)}` : ""})` : ""} but no ${name} is recorded in SAP for vendor ${order.LIFNR} (F-57, special G/L ${type === "BG" ? "G" : "H"})`,
        ...use.filter(g => g.VALID_TO && g.VALID_TO < today).map(g => `${type} ${g.REF || g.BELNR} expired on ${g.VALID_TO}`),
        use.length && need && total + 1 < need && `${type} amount ${inr(total)} is below ${pct}% of the PO value (${inr(need)})`,
      ].filter(Boolean);
      add(25, `${type === "BG" ? "Bank guarantee" : "Security deposit"} received in SAP`, issues.length ? (cfg.bgMissingStatus ?? "WARN") : "PASS",
        issues.join("; ") || `${use.map(g => `${g.REF || g.BELNR} ${inr(g.AMOUNT)}${g.VALID_TO ? ` valid till ${g.VALID_TO}` : ""}`).join(", ")}${need ? ` covers ${pct}% of ${inr(poValue)}` : ""}${linked.length ? "" : " (vendor-level, not linked to this PO)"}`,
        need ? inr(need) : null, use.length ? inr(total) : null);
    }
  }

  // 15 MSME
  const msme = vend?.MSME || (f.msme_udyam ? "Udyam no. on invoice" : "");
  if (msme) add(15, "MSME vendor", "INFO", `${msme}: pay within 45 days of acceptance (Sec. 43B(h)); flagged on MSME tile`);

  // 16 e-invoice
  // e-invoice QR: signed by the IRP -> genuine; signature wrong -> forged QR (block); no key configured -> information only
  if (f.einvoice_qr && f.einvoice_sig === false)
    add(16, "E-invoice IRN and QR signature", "BLOCK", `E-invoice QR signature is NOT valid (${f.einvoice_sig_note}): the QR was not issued by the e-invoice portal. Treat as a possible fake invoice and confirm with the vendor.`);
  else add(16, "E-invoice IRN and QR signature", f.irn ? "PASS" : "INFO",
    f.einvoice_qr ? `IRN ${f.irn.slice(0, 16)}... from the e-invoice QR; signature ${f.einvoice_sig ? f.einvoice_sig_note : `not checked: ${f.einvoice_sig_note}`}`
      : f.irn ? `IRN ${f.irn.slice(0, 16)}... printed (no e-invoice QR found)` : "No IRN printed (check vendor's e-invoice applicability)");

  // 17 digital signature (PDF signature field)
  add(17, "Digital signature (DSC)", f.digital_signature ? "PASS" : "INFO", f.digital_signature ? "PDF carries a digital signature field" : "No digital signature on the PDF (physical stamp/sign checked in check 1)");

  // 18 open advance on the PO (down payment to adjust)
  const adv = (ctx.advances ?? []).filter(a => a.BEWTP !== "C").reduce((a, x) => a + x.AMOUNT, 0);
  if (order) add(18, "Open advance on PO", adv > 0 ? "WARN" : "PASS", adv > 0 ? `Advance of ${inr(adv)} paid on this PO: clear it against this invoice in MIR4 (down payment clearing)` : "No open advance");

  // 19 TDS from vendor master
  if (order && ctx.tds?.length) add(19, "TDS (withholding tax)", "INFO", `Vendor has ${ctx.tds.map(t => t.TEXT || `${t.WITHT}/${t.WT_WITHCD}`).join(", ")}: SAP applies it when the document is posted`);

  // 20 late delivery vs LD clause
  if (order && !isService) {
    const due = (ctx.delivery ?? []).map(d => d.EINDT).filter(Boolean).sort()[0];
    const grDate = ctx.grs.filter(g => GR_FINAL.includes(g.BWART ?? "101")).map(g => g.BUDAT).filter(Boolean).sort().pop();
    if (due && grDate) {
      const late = Math.round((Date.parse(grDate) - Date.parse(due)) / 864e5);
      const ld = /(?<!\bno\s)(\bLD\b|liquidated|penalt)/i.test(order.TEXT || "");
      add(20, "Delivery date vs LD clause", late > 0 && ld ? "WARN" : late > 0 ? "INFO" : "PASS",
        late > 0 ? `Received ${late} day(s) after the PO delivery date ${due}${ld ? "; PO text has an LD/penalty clause: decide deduction before posting" : ""}` : `Received on time (due ${due})`);
    }
  }

  // 21 delivery costs on the PO (EKBZ): freight / loading booked at GR and what is already invoiced
  for (const d of ctx.deliveryCosts ?? []) {
    const open = +(d.GR_VALUE - d.IR_VALUE).toFixed(2);
    const own = d.LIFNR === order?.LIFNR;
    add(21, `Delivery cost ${d.KSCHL}`, open > 0 ? (own ? "WARN" : "INFO") : "PASS",
      open > 0 ? `${inr(open)} received at GR (${d.GR_DOCS.join(", ")}) and not invoiced yet, payable to ${own ? "this vendor: include the delivery-cost line in MIRO" : `freight vendor ${d.LIFNR} ${d.VENDOR} (separate invoice)`}`
        : `${inr(d.GR_VALUE)} received, ${inr(d.IR_VALUE)} invoiced (${d.IR_DOCS.join(", ") || "-"}) to ${d.LIFNR} ${d.VENDOR}`);
  }
  // 22 shipment costs (VFKP) for the PO's inbound shipments
  if ((ctx.shipmentCosts ?? []).length) {
    const s = ctx.shipmentCosts, tot = s.reduce((a, x) => a + x.VALUE, 0);
    add(22, "Shipment cost documents", "INFO", `${s.length} shipment cost item(s), ${inr(tot)}: ${s.map(x => `${x.COST_DOC}/${x.ITEM} shipment ${x.SHIPMENT} carrier ${x.CARRIER}${x.SETTLED ? " settled" : ""}`).join("; ")}`);
  }

  // 23 vendor can be posted: SAP parks an invoice for a flagged vendor but refuses to post it (F5A002 / posting block)
  if (vend) {
    const cc = vend.BUKRS || order?.BUKRS || "";
    const why = [vend.DELETION_FLAG && "flagged for deletion (central)", vend.CC_DELETION_FLAG && `flagged for deletion in company code ${cc}`,
      vend.POSTING_BLOCK && "posting block (central)", vend.CC_POSTING_BLOCK && `posting block in company code ${cc}`,
      vend.CC_EXISTS === false && cc && `not created in company code ${cc}`].filter(Boolean);
    add(23, "Vendor can be posted in SAP", why.length ? "BLOCK" : "PASS",
      why.length ? `Vendor ${vend.LIFNR} ${vend.NAME1}: ${why.join(", ")}. SAP may park but will refuse to post: fix the vendor master (BP / XK06) first, or let the AP controller override if your system only warns.`
        : `Vendor ${vend.LIFNR} has no deletion flag or posting block${cc ? ` (central and company code ${cc})` : ""}`);
  }

  // 24 delivery address on the invoice vs the PO plant's address in SAP
  if (plt) {
    const inv = `${f.ship_to_name ?? ""} ${f.ship_to_address ?? ""}`;
    const pin = inv.match(/\b\d{3}\s?\d{3}\b/g)?.map(p => p.replace(/\s/, "")) ?? [];
    const cityOk = plt.CITY && new RegExp(`\\b${plt.CITY.replace(/[^\w ]/g, "")}\\b`, "i").test(inv);
    if (!plt.PIN && !plt.CITY) add(24, "Delivery address vs plant", "INFO", `Plant ${plt.WERKS} has no address in SAP; invoice says "${(f.ship_to_address || "-").slice(0, 80)}"`);
    else if (!f.ship_to_address) add(24, "Delivery address vs plant", "WARN", `No delivery address found on the invoice; plant ${plt.WERKS} is at ${plt.ADDRESS}`);
    else {
      const pinOk = plt.PIN && pin.includes(plt.PIN);
      add(24, "Delivery address vs plant", pinOk || cityOk ? "PASS" : "WARN",
        pinOk ? `PIN ${plt.PIN} matches plant ${plt.WERKS} ${plt.NAME1}` : cityOk ? `City ${plt.CITY} matches plant ${plt.WERKS} (PIN ${pin[0] ?? "-"} vs ${plt.PIN || "-"})`
          : `Invoice delivers to "${f.ship_to_address.slice(0, 90)}", PO plant ${plt.WERKS} ${plt.NAME1} is at ${plt.ADDRESS}`, f.ship_to_address, plt.ADDRESS);
    }
  }

  // 0 extraction confidence (Data Extraction Agent: High / Low)
  const low = (cfg.criticalFields ?? []).filter(k => (confidence[k] ?? 1) < cfg.confidenceThreshold);
  if (low.length) add(0, "Extraction confidence", "WARN", `Low confidence on ${low.join(", ")}: check the values against the PDF`);

  for (const n of ctx.notes ?? []) add(99, "SAP data not available", "INFO", n);

  const blocks = C.filter(c => c.status === "BLOCK"), warns = C.filter(c => c.status === "WARN");
  const decision = blocks.length ? "EXCEPTION" : warns.length ? "REVIEW" : "PARK";
  const uniq = a => [...new Set(a.map(c => c.name.replace(/ \(item \d+\)$/, "")))].join(", ");
  return { checks: C, decision, reason: blocks.length ? uniq(blocks) : warns.length ? uniq(warns) : "All checks passed", taxCode, pairs };
}

// BAPI_INCOMINGINVOICE_PARK input. qtys: optional {EBELP: qty} override from the AP reviewer.
export function buildParkPayload(f, v, ctx, cfg, qtys = {}) {
  const order = ctx.po, plt = ctx.plant;
  const rate = cfg.taxCodes[v.taxCode]?.rate ?? 0;
  const items = v.pairs.filter(p => p.item).map(({ line, item }, n) => {
    const qty = qtys[item.EBELP] ?? Math.min(line.qty, Math.max(item.GR_QTY - item.IR_QTY, 0));
    const gr = [...ctx.grs].reverse().find(g => g.EBELP === item.EBELP && GR_FINAL.includes(g.BWART ?? "101"));
    const ses = ctx.ses.find(s => s.EBELP === item.EBELP);
    // Quality Inspection Agent: the usage decision travels with the invoice line (item text, 50 chars)
    const lot = (ctx.lots ?? []).find(l => !l.EBELP || Number(l.EBELP) === Number(item.EBELP));
    const text = lot ? `QC ${lot.UD === "A" ? "accepted" : lot.UD === "R" ? "rejected" : "pending"} lot ${lot.PRUEFLOS}` : "QC: no inspection lot";
    return {
      INVOICE_DOC_ITEM: String(n + 1).padStart(6, "0"), PO_NUMBER: order.EBELN, PO_ITEM: item.EBELP, TAX_CODE: v.taxCode,
      ITEM_AMOUNT: +(qty * line.rate).toFixed(2), QUANTITY: qty, PO_UNIT: item.PO_UNIT, ITEM_TEXT: text.slice(0, 50),
      ...(order.TYPE === "SERVICE" ? { SHEET_NO: ses?.LBLNI } : item.WEBRE && gr ? { REF_DOC: gr.MBLNR, REF_DOC_YEAR: gr.MJAHR, REF_DOC_IT: gr.ZEILE } : {}),
    };
  });
  const net = +items.reduce((a, i) => a + i.ITEM_AMOUNT, 0).toFixed(2);
  const gross = +(net * (1 + rate / 100)).toFixed(2);
  // tax as on the invoice (TAXDATA): SAP stores the tax line at park time, so MIR4 shows the tax code and amount in the
  // header like a MIRO entry. sap.taxData = "calculate" leaves it to SAP (tax code on the items only, filled when posted).
  const taxLines = cfg.sap.taxData !== "calculate" && v.taxCode ? [{ TAX_CODE: v.taxCode, TAX_AMOUNT: +(gross - net).toFixed(2), TAX_BASE_AMOUNT: net }] : null;
  const H = {
    INVOICE_IND: "X", DOC_TYPE: "RE", DOC_DATE: f.invoice_date, PSTNG_DATE: new Date().toISOString().slice(0, 10), BLINE_DATE: f.invoice_date,
    REF_DOC_NO: f.invoice_no.slice(0, 16), COMP_CODE: order.BUKRS, CURRENCY: order.WAERS || "INR",
    GROSS_AMOUNT: gross, CALC_TAX_IND: taxLines ? "" : "X", HEADER_TXT: `AI-AGENT ${f.invoice_no}`.slice(0, 25),
  };
  if (order.ZTERM) H.PMNTTRMS = order.ZTERM;
  if (plt?.BUPLA) H.BUSINESS_PLACE = plt.BUPLA;
  if (cfg.sap.paymentMethod) H.PYMT_METH = cfg.sap.paymentMethod;
  return { HEADERDATA: H, ITEMDATA: items, ...(taxLines ? { TAXDATA: taxLines } : {}), _VENDOR: order.LIFNR };
}
