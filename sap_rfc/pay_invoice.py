"""Pay a posted vendor invoice in SAP from Python - the same steps as F-53 (Post Outgoing Payments), run in the
background as batch input over RFC. Learning script for Match Book; reuses the connection of ap_rfc.py.

  python sap_rfc/pay_invoice.py 9561                    # DRY RUN: fills F-53 up to "Simulate", posts nothing
  python sap_rfc/pay_invoice.py 9561 --post             # full payment of FI document 9561 (company 1100, this year)
  python sap_rfc/pay_invoice.py 9563 --amount 700 --post   # partial payment of 700 against FI document 9563

Options: --bukrs 1100  --year 2026  --bank 9002 (bank G/L)  --date 2026-11-05 (document and posting date)

How it works
  1. Read the open invoice line from SAP (BSIK = open vendor items) to know vendor, amount, currency, reference.
  2. Build "BDC data": the list of screens of F-53 and the value for each field, as if a user typed them.
       screen SAPMF05A 0103  header + bank data + open item selection   (additional selection "Document Number", Enter)
       screen SAPMF05A 0731  which document to select                   ("Process open items")
       screen SAPDF05X 3100  the selected open item                     (Partial Pmt tab, then Post / Simulate)
  3. Run it with ABAP4_CALL_TRANSACTION (remote-enabled) in mode "N" (no screens) and synchronous update.
  4. Read SAP's messages: "Document 1500000xxx was posted in company code 1100" = success.
"""
import argparse
import json
import os
import sys
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ap_rfc  # connect(), read_table(), num(), payment_state()


# ---------------------------------------------------------------- user formats
# SAP screens take dates and amounts in the format of the logged-on user (SU01 > Defaults), so read them first.
def user_formats(c):
    u = ap_rfc.read_table(c, "USR01", ["DATFM", "DCPFM"], f"BNAME = '{ap_rfc.session(c)['user']}'", 1)[0]
    def fdate(d):                                   # d: datetime.date
        return {"1": d.strftime("%d.%m.%Y"), "2": d.strftime("%m/%d/%Y"), "3": d.strftime("%m-%d-%Y"),
                "4": d.strftime("%Y.%m.%d"), "5": d.strftime("%Y/%m/%d"), "6": d.strftime("%Y-%m-%d")}.get(u["DATFM"], d.strftime("%d.%m.%Y"))
    def famount(a):                                 # a: float, e.g. 1486.8
        s = f"{a:,.2f}"                             # 1,486.80
        if u["DCPFM"] == "X":
            return s                                # 1,486.80
        if u["DCPFM"] == "Y":
            return s.replace(",", " ").replace(".", ",")    # 1 486,80
        return s.replace(",", "#").replace(".", ",").replace("#", ".")   # 1.486,80
    return fdate, famount


# ---------------------------------------------------------------- BDC helpers
def screen(program, dynpro):
    """A new screen starts: program + screen number, flagged with DYNBEGIN = X."""
    return {"PROGRAM": program, "DYNPRO": dynpro, "DYNBEGIN": "X"}


def field(name, value):
    """A field on the current screen (DYNPRO is numeric in SAP, so it is left out rather than sent empty)."""
    return {"FNAM": name, "FVAL": str(value)}


def message_texts(c, msgs):
    """BDC messages come as id + number + variables: fetch the English text from T100 and fill in &1..&4."""
    out = []
    for m in msgs:
        t = ap_rfc.read_table(c, "T100", ["TEXT"], f"SPRSL = 'E' AND ARBGB = '{m['MSGID']}' AND MSGNR = '{m['MSGNR']}'", 1)
        text = t[0]["TEXT"] if t else ""
        vals = [m["MSGV1"].strip(), m["MSGV2"].strip(), m["MSGV3"].strip(), m["MSGV4"].strip()]
        for i, v in enumerate(vals, 1):             # numbered placeholders &1..&4
            text = text.replace(f"&{i}", v)
        for v in vals:                              # plain & placeholders, in order
            text = text.replace("&", v, 1)
        out.append({"type": m["MSGTYP"], "id": f"{m['MSGID']} {m['MSGNR']}", "text": text.strip(), "vars": [m["MSGV1"], m["MSGV2"]]})
    return out


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description="Pay a posted vendor invoice (F-53) over RFC")
    ap.add_argument("doc", help="FI document number of the invoice, e.g. 9561")
    ap.add_argument("--bukrs", default="1100")
    ap.add_argument("--year", default=str(date.today().year))
    ap.add_argument("--bank", default="9002", help="bank G/L account (SBI Outgoing Bank in S4T)")
    ap.add_argument("--amount", type=float, help="pay only this much (partial payment); default: the full open amount")
    ap.add_argument("--date", default=date.today().isoformat(), help="document and posting date, YYYY-MM-DD")
    ap.add_argument("--post", action="store_true", help="really post; without it the run stops at 'Simulate'")
    a = ap.parse_args()

    c = ap_rfc.connect()
    belnr = a.doc.zfill(10)
    fdate, famount = user_formats(c)

    # 1. the open invoice line (vendor line of the FI document, still open = in BSIK)
    item = ap_rfc.read_table(c, "BSIK", ["LIFNR", "WRBTR", "WAERS", "XBLNR", "SHKZG", "UMSKZ"],
                             f"BUKRS = '{a.bukrs}' AND BELNR = '{belnr}' AND GJAHR = '{a.year}'", 5)
    item = [i for i in item if i["SHKZG"] == "H" and not i["UMSKZ"]]
    if not item:
        sys.exit(f"Document {a.doc}/{a.year} in company {a.bukrs} is not an open vendor invoice (already paid, or not posted).")
    inv = item[0]
    open_amount = ap_rfc.num(inv["WRBTR"])
    pay = a.amount or open_amount
    partial = pay < open_amount - 0.004
    if pay > open_amount + 0.004:
        sys.exit(f"Amount {pay} is more than the open amount {open_amount}.")
    print(f"Invoice {a.doc}/{a.year}: vendor {inv['LIFNR']}, reference {inv['XBLNR'] or '-'}, open {open_amount:,.2f} {inv['WAERS']}")
    print(f"{'Partial payment' if partial else 'Full payment'} of {pay:,.2f} from bank G/L {a.bank} on {a.date}  ({'POST' if a.post else 'DRY RUN'})")

    # 2. the F-53 screens and fields
    d = date.fromisoformat(a.date)
    bdc = [
        screen("SAPMF05A", "0103"),                 # Post Outgoing Payments: Header Data
        field("BKPF-BLDAT", fdate(d)),              # document date
        field("BKPF-BLART", "KZ"),                  # document type: vendor payment
        field("BKPF-BUKRS", a.bukrs),
        field("BKPF-BUDAT", fdate(d)),              # posting date
        field("BKPF-WAERS", inv["WAERS"]),
        field("BKPF-XBLNR", (inv["XBLNR"] or f"PAY {a.doc}")[:16]),
        field("BKPF-BKTXT", "Paid via Python"),
        field("RF05A-KONTO", a.bank),               # bank data: G/L account
        field("BSEG-WRBTR", famount(pay)),          # bank data: amount
        field("BSEG-VALUT", fdate(d)),              # value date
        field("RF05A-AGKON", inv["LIFNR"]),         # open item selection: vendor
        field("RF05A-AGKOA", "K"),                  # account type K = vendor
        field("RF05A-XNOPS", "X"),                  # standard open items
        field("RF05A-XPOS1(03)", "X"),              # additional selection: document number
        field("BDC_OKCODE", "/00"),                 # Enter: with "Document Number" chosen, SAP goes to the selection screen
        screen("SAPMF05A", "0731"),                 # enter the document number(s) to select
        field("RF05A-SEL01(01)", belnr),
        field("BDC_OKCODE", "=PA"),                 # "Process open items"
    ]
    if partial:
        bdc += [screen("SAPDF05X", "3100"), field("BDC_OKCODE", "=PART"),          # tab "Partial Pmt"
                screen("SAPDF05X", "3100"), field("DF05B-PSZAH(01)", famount(pay))]  # payment amount on the line
    bdc += [screen("SAPDF05X", "3100"), field("BDC_OKCODE", "=BU" if a.post else "=BS")]   # Post / Simulate

    # 3. run F-53 in the background: mode N = no screens, update S = wait until the document is written
    r = c.call("ABAP4_CALL_TRANSACTION", TCODE="F-53", SKIP_SCREEN=" ", MODE_VAL="N", UPDATE_VAL="S", USING_TAB=bdc)
    msgs = message_texts(c, r["MESS_TAB"])
    for m in msgs:
        print(f"  [{m['type']}] {m['id']}: {m['text']}")

    # 4. result
    posted = next((m for m in msgs if m["id"] == "F5 312"), None)       # "Document &1 was posted in company code &2"
    if a.post and posted:
        doc = posted["vars"][0].strip()
        print(f"\n{'PARTLY PAID' if partial else 'PAID'}: payment document {doc} in company {a.bukrs}.")
        fi = {"BUKRS": a.bukrs, "BELNR": belnr, "GJAHR": a.year}
        print("Invoice now:", json.dumps(ap_rfc.payment_state(c, fi), default=str))
        print("In Match Book: SAP documents > Check status in SAP.")
    elif not a.post:
        # a dry run ends after "Simulate": SAP reports "no batch input data" for the NEXT screen (the simulation
        # overview). If that screen is one of ours, SAP stopped earlier than planned - not OK.
        ours = {f"{s['PROGRAM']} {s['DYNPRO']}" for s in bdc if s.get("DYNBEGIN")}
        end = next((m for m in msgs if m["id"] == "00 344"), None)
        stopped_at = " ".join(end["vars"]).strip() if end else ""
        ok = end and stopped_at not in ours and not any(m["type"] in ("E", "A") for m in msgs if m is not end)
        print(f"  (SAP ran through to screen {stopped_at or '?'})")
        print("\nDRY RUN " + ("OK: F-53 accepted all values up to Simulate. Nothing was posted. Add --post to pay." if ok else "stopped early: see the messages above. Nothing was posted."))
    else:
        print("\nNot posted: see the messages above.")


if __name__ == "__main__":
    main()
