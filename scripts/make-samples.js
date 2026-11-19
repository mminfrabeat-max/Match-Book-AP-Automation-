// Generates demo vendor invoices (five different layouts, logos, e-invoice / UPI QR codes) into ./samples.
// Each one is built to hit one scenario against the mock SAP data in data/sap-seed/sap.json.
import fs from "node:fs";
import path from "node:path";
import { make as makePdf } from "./invoice-pdf.js";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(import.meta.url);
const OUT = path.resolve(path.dirname(HERE), "..", "samples");

const TALOJA = { name: "Demo Industries Ltd - Taloja Plant", addr: "Plot K-1, MIDC Taloja, Raigad, Maharashtra 410208", gstin: "27AAACD1234F1Z5" };
const DAHEJ = { name: "Demo Industries Ltd - Dahej Plant", addr: "GIDC Dahej, Bharuch, Gujarat 392130", gstin: "24AAACD1234F1Z1" };

const SAMPLES = [
  { file: "S01_VishwaCarbon_VC-26-27-0412.pdf", scenario: "Clean e-invoice, 3-way match OK",
    vendor: { name: "Vishwa Carbon Pvt Ltd", addr: "Plot 44, TTC Industrial Area, Mahape, Navi Mumbai 400710", gstin: "27AABCV4821K1Z2", pan: "AABCV4821K" },
    shipTo: TALOJA, no: "VC/26-27/0412", date: "19-10-2026", po: "4500018231", lr: "LR77812", dn: "DN-7741", irn: true, signed: true,
    lines: [{ desc: "Activated carbon, granular 8x30", hsn: "3802", qty: 10, uom: "MT", rate: 68500 }], gst: { type: "CGST+SGST", rate: 18 } },
  { file: "S02_ShreeGanesh_SGE-1187.pdf", scenario: "Invoice qty 120 > GRN qty 100",
    vendor: { name: "Shree Ganesh Engineering Works", addr: "Gala 12, Sector 8, Turbhe MIDC, Navi Mumbai 400705", gstin: "27AAGFS3390P1ZK", pan: "AAGFS3390P" },
    shipTo: TALOJA, no: "SGE/1187", date: "20-10-2026", po: "4500018305", lr: "", dn: "DC-2231", irn: false, signed: true,
    lines: [{ desc: "Gland packing set, PTFE 12 mm", hsn: "8484", qty: 120, uom: "NOS", rate: 1450 }], gst: { type: "CGST+SGST", rate: 18 } },
  { file: "S03_ApexChemicals_APX-2026-5521.pdf", scenario: "Quality usage decision rejected",
    vendor: { name: "Apex Chemicals Ltd", addr: "D-9, MIDC Industrial Area, Mahad, Raigad 402309", gstin: "27AADCA7712M1Z9", pan: "AADCA7712M" },
    shipTo: TALOJA, no: "APX/2026/5521", date: "21-10-2026", po: "4500018240", lr: "LR90311", dn: "DN-5521", irn: true, signed: true,
    lines: [{ desc: "Sulphuric acid 98%", hsn: "2807", qty: 25, uom: "MT", rate: 9200 }], gst: { type: "CGST+SGST", rate: 18 } },
  { file: "S04_scan_0042.pdf", scenario: "Duplicate of S01 (re-sent scan, number written without leading zero)",
    vendor: { name: "Vishwa Carbon Pvt Ltd", addr: "Plot 44, TTC Industrial Area, Mahape, Navi Mumbai 400710", gstin: "27AABCV4821K1Z2", pan: "AABCV4821K" },
    shipTo: TALOJA, no: "VC/26-27/412", date: "19-10-2026", po: "4500018231", lr: "LR77812", dn: "DN-7741", irn: false, signed: true,
    lines: [{ desc: "Activated carbon, granular 8x30", hsn: "3802", qty: 10, uom: "MT", rate: 68500 }], gst: { type: "CGST+SGST", rate: 18 } },
  { file: "S05_SaiPackaging_SPI-GJ-0907.pdf", scenario: "Ship-to GSTIN (Dahej) does not match PO plant (Taloja)",
    vendor: { name: "Sai Packaging Industries", addr: "Survey 211, GIDC Vapi, Valsad, Gujarat 396195", gstin: "24AAKFS6610Q1Z3", pan: "AAKFS6610Q" },
    shipTo: DAHEJ, no: "SPI/GJ/0907", date: "22-10-2026", po: "4500018266", lr: "LR4410", dn: "DC-0907", irn: true, signed: true,
    lines: [{ desc: "HDPE woven bags 50 kg, laminated", hsn: "3923", qty: 20000, uom: "NOS", rate: 14.5 }], gst: { type: "IGST", rate: 18 } },
  { file: "S06_OmSaiFabricators_OSF-26-118.pdf", scenario: "MSME service invoice, SES released, JMS done",
    vendor: { name: "Om Sai Fabricators", addr: "Shed 7, Pawane MIDC, Navi Mumbai 400703", gstin: "27ABXPO5521R1ZN", pan: "ABXPO5521R", udyam: "UDYAM-MH-33-0012345" },
    shipTo: TALOJA, no: "OSF/26/118", date: "23-10-2026", po: "4600004412", lr: "", dn: "", irn: false, signed: true,
    lines: [{ desc: "Structural repair, prilling tower platform", hsn: "998719", qty: 1, uom: "AU", rate: 186000 }], gst: { type: "CGST+SGST", rate: 18 } },
  { file: "S07_KaveriPumps_KPV-26-0412.pdf", scenario: "Stamp and signature missing",
    vendor: { name: "Kaveri Pumps & Valves", addr: "A-31, Wagle Estate, Thane 400604", gstin: "27AAFCK2201L1ZD", pan: "AAFCK2201L", udyam: "UDYAM-MH-34-0098765" },
    shipTo: TALOJA, no: "KPV/26/0412", date: "24-10-2026", po: "4500018390", lr: "LR5120", dn: "DC-118", irn: false, signed: false,
    lines: [{ desc: "Centrifugal pump seal kit", hsn: "8413", qty: 4, uom: "NOS", rate: 42500 }], gst: { type: "CGST+SGST", rate: 18 } },
];

// Each sample gets its own layout, so the reading agents see different structures, logos and QR codes.
const LAYOUT_OF = { S01: 'einvoice', S02: 'banner', S03: 'classic', S04: 'compact', S05: 'modern', S06: 'compact', S07: 'banner' };
export async function make(s, outDir = OUT) {
  return makePdf({ ...s, layout: s.layout ?? LAYOUT_OF[s.file.slice(0, 3)] ?? 'classic' }, outDir);
}

if (process.argv[1] && path.resolve(process.argv[1]) === HERE) {
  fs.mkdirSync(OUT, { recursive: true });
  await Promise.all(SAMPLES.map(s => make(s)));
  fs.writeFileSync(path.join(OUT, "scenarios.json"), JSON.stringify(SAMPLES.map(s => ({ file: s.file, scenario: s.scenario })), null, 2));
  console.log(`Wrote ${SAMPLES.length} sample invoices to ${OUT}`);
}
