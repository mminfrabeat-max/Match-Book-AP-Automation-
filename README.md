# Match Book – Matched. Checked. Booked.

One application for accounts payable: vendor invoices arrive by mail or in the common folder, agents read
and check them against SAP, people review what needs a decision, and the MIRO document is parked in SAP.
Built from the AP AI use case deck and the invoice booking automation document.

The name is a setting: change `appName`, `appTagline` and `orgName` in `config.json`.

## Start

```
cd prototype
npm install                # first time only
npm run samples            # demo invoices (7 PDFs)
npm run demo               # puts 5 PDFs in the common folder and 5 mails (2 with invoices) in the mailbox folder
npm start                  # simulated SAP  -> http://localhost:3000
npm run start:sap          # real SAP S4T over RFC (office network / VPN)
```

## Sign in

Accounts are created at first start, one per person in `config.json`, plus `admin`.
Initial password for everyone: **`Welcome@123`**. It must be changed at the first sign-in.

| User | Role | Sees |
|---|---|---|
| `admin` | Administrator | everything, users |
| `priya`, `rahul`, `kavita` | AP team (materials / services / MSME desk) | all invoices, own queue, park, review |
| `apctrl` | AP controller | everything, overrides, SAP follow-ups, learning |
| `ajadhav` | Buyer (PO creator) | own POs: GR/IR, advances, late deliveries, invoice status |
| `bharatm`, `ashokm` | Managers | their team's items |
| `sushant` | Requestor (user department) | pending UDs and invoices on own PRs, payment done |
| `qclab`, `stores` | QC, Stores | pending / rejected UDs, "post 122" tasks |

Passwords are stored as scrypt hashes (`data/runtime/users.json`); 5 wrong attempts lock the account for 10 minutes;
sessions last 8 hours. The administrator can add users, reset passwords and disable accounts (Users page).

## What the agents do

| Agent (from the deck / document) | In the app |
|---|---|
| Orchestration | Mail with invoice keyword + PDF → processed; status question → status reply; no PDF → "please send PDF" reply; other → AP team |
| Invoice Reading / Monitoring | Common folder `invoices/inbox`, mailbox folder `invoices/mail/*.eml`, optional Microsoft Graph mailbox; category + AP queue routing |
| Data Extraction (OCR/ICR) | Groq (`openai/gpt-oss-120b`) + rules cross-check, confidence per field; low confidence → human review |
| SAP Integration | Vendor, PO, PR, plant GSTIN, GRN, UD, SES, delivery dates, advances, TDS, earlier invoices |
| Quality Inspection | UD check per invoice; pending-UD digest to requestor + manager; rejection mail; "post 122" to stores |
| Validation | 20 checks (3-way match, GST type/amount, tax code, duplicates, GSTIN/PAN, ship-to, clauses, LD, MSME, TDS, DSC …) |
| Human Review | Correct values and re-check, approve, approve with override (controller, reason recorded), reject |
| Learning | Learns field corrections per vendor and warnings approved 3 times (master-data checks only); can be switched off |
| Open GR/IR & advances | Hourly SAP scan: GRN without invoice, advances without GRN, late deliveries → digest per buyer |
| MSME notification | 45-day clock tile |
| MIRO parking | `BAPI_INCOMINGINVOICE_PARK`; auto in simulated SAP, on click in real SAP |
| Invoice PDF in SAP | GOS attachments (`SO_DOCUMENT_INSERT_API1` + `BINARY_RELATION_CREATE_COMMIT`): on park to the invoice document (BUS2081, MIR4) and each PO (BUS2012, ME23N); on posting to the FI document (BKPF, FB03). "Attach PDF in SAP" fills in what is missing. In S4T MIR4 shows "No service available": view via SE37 `GOS_ATTACHMENT_LIST_POPUP` |
| BG / SD received (check 25) | PO text with a BG or security-deposit clause needs a noted item in SAP (F-57, special G/L G or H): present, valid, and the agreed % of the PO value |
| JMS (check 26) | Joint measurement sheet for service POs and POs whose text mentions JMS: a JMS file on the SES or PO (Services for Object) or JMS in the SES text; rule in config.jms until DFPCL names their field |
| Vendor due list | Open vendor items from SAP (BSIK) in Follow-ups > Due list: pay-by from payment terms or the MSME 45-day limit, overdue / 7-day / MSME / blocked buckets, CSV for the payment run, weekly digest and "Payments due this week" tile for AP |
| Reverse data & DMS | Status sync (parked → posted → paid), "payment done" to requestor/buyer, PDF + data in `data/dms/<company>/<year>/<vendor>/` |
| Mail / Teams | Outbox in the app; Teams via `TEAMS_WEBHOOK_URL` if set; mails are drafts |
| Dashboard | KPIs, stop reasons, workload, full agent log |

## Settings (`config.json`)

People and managers, AP routing rules, tax codes per system, tolerances, overridable checks, learning rules,
monitor timing, login rules. Secrets (Groq key, RFC paths, optional `AP_GRAPH_*`, `TEAMS_WEBHOOK_URL`) go in `.env.local`.

## Demo helpers

- `npm run sap:invoice -- --list` / `-- <PO> --inbox` – invoice PDF from a real S4T PO
- In simulated SAP: "Demo: create PO", "Demo: post in MIR4", "Demo: payment run" buttons
- `npm run reset` (stop the app first) – fresh demo; `--users` also resets accounts; `--all` also clears the real-SAP queue

## SAP data read over RFC (checked on S4T)

Vendor master LFA1 (+ PAN `J_1IPANNO`, MSME `J_1ISSIST`, GSTIN `STCD3`), address ADRC/ADR6, PO BAPI_PO_GETDETAIL1,
PR EBAN, delivery dates EKET, advances EKBE (VGABE 4), TDS LFBW, plant GSTIN T001W/J_1BBRANCH, QM QALS/QAVE, SES ESSR,
**delivery costs EKBZ** (GR and invoiced), **shipment costs** LIPS → VTTP → VFKP, earlier invoices RBKP,
posting / payment status RBKP → BKPF → BSEG, SAP user names USR21/ADRP/ADR6, reporting manager PA0105 → PA0001 → HRP1001.
The QC result is written into the item text of the parked invoice.

## E-invoice QR signature

The signed e-invoice QR (a JWT from the Invoice Registration Portal) is verified with the public keys in
`config.json` → `einvoice.publicKeys`. Put the NIC e-invoice portal's public key in `data/keys/nic-einvoice-public.pem`
for real vendor invoices. Test PDFs are signed with `data/keys/demo-irp-*.pem` ("Demo IRP key (test PDFs only)");
remove that entry for production. A QR whose signature does not match is blocked as a possible fake invoice.

## SAP connection

One long-running Python worker keeps the RFC connection open (about 0.4 s per SAP read instead of 2.6 s).
`AP_RFC_WORKER=off` in `.env.local` goes back to one process per call. A park is never re-sent automatically.
Match Book runs on port 3100 (Revo uses 3000).

## Not built yet

Sending e-mail through Graph (drafts only), attaching the PDF to the SAP document (GOS), reading scanned
image-only PDFs with Groq (needs an image-capable model), a real Teams app (tiles are in this app; Teams gets
webhook messages), a JMS flag (S4T has no JMS field; the SES acceptance is used).
