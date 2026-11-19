"""AP invoice prototype <-> SAP over RFC (PyRFC + SAP NW RFC SDK).
Connection handling follows Project_Automation_SubCon/sap_rfc/revo_rfc.py (same settings file).

  python sap_rfc/ap_rfc.py ping
  python sap_rfc/ap_rfc.py open_items [days]              # PO items with GR not yet invoiced (for demo invoices)
  python sap_rfc/ap_rfc.py context --job job.json         # everything the Validation Agent needs for one invoice
  python sap_rfc/ap_rfc.py park    --job job.json         # BAPI_INCOMINGINVOICE_PARK + commit
  python sap_rfc/ap_rfc.py attach  --job job.json         # invoice PDF -> GOS attachment (BUS2081 invoice, BUS2012 PO, BKPF FI doc)
  python sap_rfc/ap_rfc.py attachments --job job.json     # list GOS attachments of a business object

Connection: SAP_ASHOST, SAP_SYSNR, SAP_CLIENT, SAP_USER, SAP_PASSWD, SAP_LANG from the environment or
from the file named in AP_RFC_ENV. The password is never printed or logged.
Prints one JSON object on stdout.
"""
import argparse
import json
import os
import re
import sys
import time
from datetime import date, timedelta
from decimal import Decimal


class RfcError(Exception):
    def __init__(self, step, message, messages=None):
        super().__init__(message)
        self.step, self.message, self.messages = step, message, messages or []


def env():
    vals = {}
    path = os.environ.get("AP_RFC_ENV")
    if path and os.path.exists(path):
        for line in open(path, encoding="utf-8"):
            m = re.match(r"\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$", line)
            if m and not line.lstrip().startswith("#"):
                vals[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    for k in ("SAP_ASHOST", "SAP_SYSNR", "SAP_CLIENT", "SAP_USER", "SAP_PASSWD", "SAP_LANG"):
        if os.environ.get(k):
            vals[k] = os.environ[k]
    missing = [k for k in ("SAP_ASHOST", "SAP_SYSNR", "SAP_CLIENT", "SAP_USER", "SAP_PASSWD") if not vals.get(k)]
    if missing:
        raise RfcError("config", f"RFC connection settings missing: {', '.join(missing)} (set AP_RFC_ENV)")
    return vals


def connect():
    from pyrfc import Connection
    e = env()
    try:
        return Connection(ashost=e["SAP_ASHOST"], sysnr=e["SAP_SYSNR"], client=e["SAP_CLIENT"],
                          user=e["SAP_USER"], passwd=e["SAP_PASSWD"], lang=e.get("SAP_LANG") or "EN")
    except Exception as x:
        raise RfcError("connect", f"RFC logon failed: {type(x).__name__}: {str(x).replace(e['SAP_PASSWD'], '***')[:300]}")


def session(c):
    a = c.get_connection_attributes()
    return {"system": a.get("sysId", ""), "client": a.get("client", ""), "user": a.get("user", ""), "via": "RFC"}


def read_table(c, table, fields, where, max_rows=500):
    options, line = [], ""
    for word in where.split(" "):
        if len(line) + len(word) + 1 > 72:
            options.append({"TEXT": line})
            line = ""
        line = f"{line} {word}".strip()
    if line:
        options.append({"TEXT": line})
    r = c.call("RFC_READ_TABLE", QUERY_TABLE=table, DELIMITER="|", ROWCOUNT=max_rows,
               FIELDS=[{"FIELDNAME": f} for f in fields], OPTIONS=options)
    return [dict(zip(fields, (v.strip() for v in row["WA"].split("|")))) for row in r["DATA"]]


def optional(fn, note, notes):
    """Tables differ between releases (QM, SES, India localisation): a failed read is noted, not fatal."""
    try:
        return fn()
    except Exception as x:
        notes.append(f"{note}: {type(x).__name__}: {str(x)[:160]}")
        return None


def iso(d):
    d = str(d or "").strip()
    return f"{d[:4]}-{d[4:6]}-{d[6:]}" if re.fullmatch(r"\d{8}", d) and d != "00000000" else ""


def num(v):
    v = str(v or "").strip()
    neg = v.endswith("-")
    try:
        n = float(v.rstrip("-").replace(",", "") or 0)
    except ValueError:
        return 0.0
    return -n if neg else n


def ext(v):
    return str(v or "").lstrip("0") or str(v or "")


def msgs(ret):
    if isinstance(ret, dict):
        ret = [ret]
    return [{"type": m.get("TYPE", ""), "id": m.get("ID", ""), "number": m.get("NUMBER", ""), "message": m.get("MESSAGE", "")}
            for m in (ret or []) if m.get("MESSAGE")]


def errors(ms):
    return [m for m in ms if m["type"] in ("E", "A")]


_UNITS = {}


def unit(c, internal):
    u = (internal or "").strip()
    if u and u not in _UNITS:
        rows = read_table(c, "T006A", ["MSEH3"], f"SPRAS = 'E' AND MSEHI = '{u}'", 1)
        _UNITS[u] = rows[0]["MSEH3"] if rows and rows[0]["MSEH3"] else u
    return _UNITS.get(u, u)


SSI = {"1": "Micro", "2": "Small", "3": "Medium", "M": "Micro", "S": "Small", "D": "Medium"}   # J_1ISSIST: SSI / MSME status


def vendor_row(c, where):
    rows = read_table(c, "LFA1", ["LIFNR", "NAME1", "REGIO", "STCD3", "ADRNR", "LOEVM", "SPERR", "J_1IPANNO", "J_1ISSIST", "J_1IVTYP"], where, 5)
    if not rows:
        return None
    r = rows[0]
    email, address = "", ""
    if r["ADRNR"]:
        e = read_table(c, "ADR6", ["SMTP_ADDR"], f"ADDRNUMBER = '{r['ADRNR']}'", 1)
        email = e[0]["SMTP_ADDR"] if e else ""
        a = read_table(c, "ADRC", ["HOUSE_NUM1", "STREET", "CITY1", "POST_CODE1", "REGION", "COUNTRY"], f"ADDRNUMBER = '{r['ADRNR']}'", 1)
        if a:
            a = a[0]
            address = ", ".join(x for x in [" ".join(y for y in [a["HOUSE_NUM1"], a["STREET"]] if y), a["CITY1"], " ".join(y for y in [a["POST_CODE1"], a["REGION"], a["COUNTRY"]] if y)] if x)
    pan = r["J_1IPANNO"] or (r["STCD3"][2:12] if len(r["STCD3"]) >= 12 else "")
    return {"LIFNR": ext(r["LIFNR"]), "NAME1": r["NAME1"], "REGION": r["REGIO"], "GSTIN": r["STCD3"], "PAN": pan, "PAN_SOURCE": "vendor master (J_1IPANNO)" if r["J_1IPANNO"] else "from GSTIN" if pan else "",
            "MSME": SSI.get(r["J_1ISSIST"], r["J_1ISSIST"]), "GST_REGISTERED": bool(r["STCD3"]), "VENDOR_TYPE": r["J_1IVTYP"], "ADDRESS": address,
            "EMAIL": email, "POSTING_BLOCK": bool(r["SPERR"]), "DELETION_FLAG": bool(r["LOEVM"])}


# ---------------------------------------------------------------- SAP users: name, e-mail, reporting manager (HR org structure)
def user_info(c, bnames, notes):
    out = {}
    for b in [x for x in dict.fromkeys(bnames) if x]:
        info = {"BNAME": b, "NAME": "", "EMAIL": "", "MANAGER": ""}
        u = optional(lambda: read_table(c, "USR21", ["PERSNUMBER", "ADDRNUMBER"], f"BNAME = '{b}'", 1), "user names (USR21)", notes) or []
        if u:
            p = optional(lambda: read_table(c, "ADRP", ["NAME_TEXT"], f"PERSNUMBER = '{u[0]['PERSNUMBER']}'", 1), "user names (ADRP)", notes) or []
            m = optional(lambda: read_table(c, "ADR6", ["SMTP_ADDR"], f"PERSNUMBER = '{u[0]['PERSNUMBER']}'", 1), "user e-mail (ADR6)", notes) or []
            info["NAME"] = p[0]["NAME_TEXT"].title() if p and p[0]["NAME_TEXT"] and p[0]["NAME_TEXT"] != b else ""
            info["EMAIL"] = m[0]["SMTP_ADDR"] if m else ""
        info["MANAGER"] = optional(lambda: manager_of(c, b), "reporting manager (HR: PA0105 / PA0001 / HRP1001)", notes) or ""
        out[b] = info
    return out


def manager_of(c, bname):
    """SAP user -> employee (PA0105) -> org unit (PA0001) -> chief position of the unit (HRP1001 B012) -> holder (A008)
    -> holder's SAP user. If the user is the chief, walk up to the parent org unit (A002)."""
    today = date.today().strftime("%Y%m%d")
    p = read_table(c, "PA0105", ["PERNR"], f"USRTY = '0001' AND USRID = '{bname}' AND ENDDA >= '{today}'", 1)
    if not p:
        return ""
    me = p[0]["PERNR"]
    org = read_table(c, "PA0001", ["ORGEH"], f"PERNR = '{me}' AND ENDDA >= '{today}'", 1)
    unit = org[0]["ORGEH"] if org else ""
    for _ in range(4):
        if not unit or unit == "00000000":
            return ""
        chief = read_table(c, "HRP1001", ["SOBID"], f"OTYPE = 'O' AND OBJID = '{unit}' AND RSIGN = 'B' AND RELAT = '012' AND ENDDA >= '{today}'", 1)
        holder = read_table(c, "HRP1001", ["SOBID"], f"OTYPE = 'S' AND OBJID = '{chief[0]['SOBID'][:8]}' AND RSIGN = 'A' AND RELAT = '008' AND SCLAS = 'P' AND ENDDA >= '{today}'", 1) if chief else []
        boss = holder[0]["SOBID"][:8] if holder else ""
        if boss and boss != me:
            u = read_table(c, "PA0105", ["USRID"], f"PERNR = '{boss}' AND USRTY = '0001' AND ENDDA >= '{today}'", 1)
            return u[0]["USRID"] if u else ""
        up = read_table(c, "HRP1001", ["SOBID"], f"OTYPE = 'O' AND OBJID = '{unit}' AND RSIGN = 'A' AND RELAT = '002' AND ENDDA >= '{today}'", 1)
        unit = up[0]["SOBID"][:8] if up else ""
    return ""


# ---------------------------------------------------------------- delivery costs (EKBZ) and shipment costs (VFKP)
def delivery_costs(c, ebeln, notes):
    rows = optional(lambda: read_table(c, "EKBZ", ["EBELP", "VGABE", "KSCHL", "SHKZG", "MENGE", "DMBTR", "BUDAT", "BELNR", "GJAHR", "LIFNR"], f"EBELN = '{ebeln}'", 200), "delivery costs (EKBZ)", notes) or []
    by = {}
    for r in rows:
        k = (r["KSCHL"], ext(r["LIFNR"]))
        b = by.setdefault(k, {"KSCHL": r["KSCHL"], "LIFNR": ext(r["LIFNR"]), "GR_VALUE": 0.0, "IR_VALUE": 0.0, "GR_DOCS": [], "IR_DOCS": []})
        v = num(r["DMBTR"]) * (-1 if r["SHKZG"] == "H" else 1)
        if r["VGABE"] == "1":
            b["GR_VALUE"] += v; b["GR_DOCS"].append(r["BELNR"])
        elif r["VGABE"] == "2":
            b["IR_VALUE"] += v; b["IR_DOCS"].append(r["BELNR"])
    names = {ext(v["LIFNR"]): v["NAME1"] for v in optional(lambda: read_in(c, "LFA1", ["LIFNR", "NAME1"], "LIFNR", [k[1].zfill(10) if k[1].isdigit() else k[1] for k in by]), "freight vendors (LFA1)", notes) or []}
    # freight GRs post to the freight clearing account as credits: report amounts without the posting sign
    return [{**b, "VENDOR": names.get(b["LIFNR"], ""), "GR_VALUE": round(abs(b["GR_VALUE"]), 2), "IR_VALUE": round(abs(b["IR_VALUE"]), 2),
             "GR_DOCS": sorted(set(b["GR_DOCS"])), "IR_DOCS": sorted(set(b["IR_DOCS"]))} for b in by.values()]


def shipment_costs(c, ebeln, notes):
    """Inbound deliveries for the PO (LIPS) -> shipments (VTTP) -> shipment cost items (VFKP)."""
    dl = optional(lambda: read_table(c, "LIPS", ["VBELN"], f"VGBEL = '{ebeln}'", 50), "inbound deliveries (LIPS)", notes) or []
    if not dl:
        return []
    sh = optional(lambda: read_in(c, "VTTP", ["TKNUM", "VBELN"], "VBELN", [d["VBELN"] for d in dl]), "shipments (VTTP)", notes) or []
    if not sh:
        return []
    cost = optional(lambda: read_in(c, "VFKP", ["FKNUM", "FKPOS", "REBEL", "NETWR", "WAERS", "TDLNR", "SLSTOR"], "REBEL", [s["TKNUM"] for s in sh]), "shipment costs (VFKP)", notes) or []
    return [{"SHIPMENT": x["REBEL"], "COST_DOC": x["FKNUM"], "ITEM": x["FKPOS"], "VALUE": num(x["NETWR"]), "CURRENCY": x["WAERS"], "CARRIER": ext(x["TDLNR"]), "SETTLED": x["SLSTOR"] == ""} for x in cost]


def guarantees(c, lifnr, bukrs, ebeln):
    """Bank guarantees and security deposits received from the vendor: open noted items (F-57) with special G/L
    G 'Guarantee received' or H 'Security deposit'. Due date (ZFBDT) = valid till. LINKED: the item names this PO
    (purchasing document field, assignment or text)."""
    if not lifnr:
        return []
    rows = read_table(c, "BSIK", ["BELNR", "GJAHR", "UMSKZ", "WRBTR", "WAERS", "ZFBDT", "BLDAT", "EBELN", "ZUONR", "SGTXT"],
                      f"LIFNR = '{lifnr}' AND BUKRS = '{bukrs}' AND ( UMSKZ = 'G' OR UMSKZ = 'H' )", 100)
    return [{"BELNR": r["BELNR"], "GJAHR": r["GJAHR"], "TYPE": "BG" if r["UMSKZ"] == "G" else "SD", "UMSKZ": r["UMSKZ"], "AMOUNT": num(r["WRBTR"]),
             "CURRENCY": r["WAERS"], "VALID_TO": iso(r["ZFBDT"]), "POSTED": iso(r["BLDAT"]), "REF": r["ZUONR"] or r["SGTXT"],
             "LINKED": r["EBELN"] == ebeln or ebeln in (r["ZUONR"] + " " + r["SGTXT"])} for r in rows]


def plant_row(c, werks):
    t = read_table(c, "T001W", ["WERKS", "NAME1", "REGIO", "J_1BBRANCH", "ADRNR", "ORT01", "PSTLZ", "STRAS"], f"WERKS = '{werks}'", 1)
    if not t:
        return None
    r = t[0]
    gstin = ""
    if r["J_1BBRANCH"]:
        b = read_table(c, "J_1BBRANCH", ["GSTIN"], f"BRANCH = '{r['J_1BBRANCH']}'", 1)
        gstin = b[0]["GSTIN"] if b else ""
    # delivery address of the plant (ADRC, else the address fields on T001W)
    a = read_table(c, "ADRC", ["HOUSE_NUM1", "STREET", "STR_SUPPL1", "CITY1", "POST_CODE1"], f"ADDRNUMBER = '{r['ADRNR']}'", 1) if r["ADRNR"] else []
    a = a[0] if a else {"HOUSE_NUM1": "", "STREET": r["STRAS"], "STR_SUPPL1": "", "CITY1": r["ORT01"], "POST_CODE1": r["PSTLZ"]}
    street = ", ".join(x for x in [" ".join(y for y in [a["HOUSE_NUM1"], a["STREET"]] if y), a["STR_SUPPL1"]] if x)
    return {"WERKS": werks, "NAME1": r["NAME1"], "BUPLA": r["J_1BBRANCH"], "STATE_CODE": gstin[:2] if gstin else "", "REGIO": r["REGIO"], "GSTIN": gstin,
            "STREET": street, "CITY": a["CITY1"], "PIN": a["POST_CODE1"], "ADDRESS": ", ".join(x for x in [street, a["CITY1"], a["POST_CODE1"]] if x)}


# ---------------------------------------------------------------- context for one invoice
def cmd_context(c, job, log):
    notes = []
    out = {"vendorByGstin": None, "po": None, "vendor": None, "plant": None, "grs": [], "lots": [], "ses": [], "invoices": [], "notes": notes}
    if job.get("gstin"):
        out["vendorByGstin"] = vendor_row(c, f"STCD3 = '{job['gstin']}'")
    ebeln = job.get("ebeln")
    if not ebeln:
        return out
    r = c.call("BAPI_PO_GETDETAIL1", PURCHASEORDER=ebeln, HEADER_TEXT="X")
    err = errors(msgs(r.get("RETURN")))
    if err:
        out["poError"] = err[0]["message"]
        return out
    h = r["POHEADER"]
    totals = {t["PO_ITEM"]: t for t in r.get("POHISTORY_TOTALS", []) if t.get("SERIAL_NO") in ("00", "", None)}
    text = " ".join(t.get("TEXT_LINE", "") for t in r.get("POTEXTHEADER", [])).strip()
    items = []
    for it in r.get("POITEM", []):
        if it.get("DELETE_IND"):
            continue
        e = str(it["PO_ITEM"]).zfill(5)
        t = totals.get(it["PO_ITEM"], {})
        items.append({"EBELP": e, "TXZ01": it.get("SHORT_TEXT", ""), "MENGE": float(it.get("QUANTITY") or 0), "MEINS": unit(c, it.get("PO_UNIT", "")),
                      "PO_UNIT": it.get("PO_UNIT", ""), "NETPR": float(it.get("NET_PRICE") or 0) / (float(it.get("PRICE_UNIT") or 1) or 1),
                      "MWSKZ": it.get("TAX_CODE", ""), "WERKS": it.get("PLANT", ""), "PSTYP": it.get("ITEM_CAT", ""), "WEBRE": it.get("GR_BASEDIV") == "X",
                      "GR_QTY": float(t.get("DELIV_QTY") or 0), "IR_QTY": float(t.get("IV_QTY") or 0)})
    released = read_table(c, "EKKO", ["FRGKE", "FRGRL"], f"EBELN = '{ebeln}'", 1)
    lifnr = ext(h.get("VENDOR", ""))
    out["po"] = {"EBELN": ebeln, "LIFNR": lifnr, "BUKRS": h.get("COMP_CODE", ""), "WAERS": h.get("CURRENCY", ""), "ZTERM": h.get("PMNTTRMS", ""),
                 "ERNAM": h.get("CREATED_BY", ""), "BSART": h.get("DOC_TYPE", ""), "FRGKE": "R" if released and not released[0]["FRGRL"] else "B",
                 "TYPE": "SERVICE" if any(i["PSTYP"] == "9" for i in items) else "MATERIAL", "TEXT": text, "items": items,
                 "WERKS": items[0]["WERKS"] if items else ""}
    out["vendor"] = vendor_row(c, f"LIFNR = '{h.get('VENDOR', '')}'")
    if out["vendor"]:   # company-code level flags: SAP refuses to post (F5A002 etc.) when the vendor is flagged here
        cc = optional(lambda: read_table(c, "LFB1", ["LOEVM", "SPERR"], f"LIFNR = '{h.get('VENDOR', '')}' AND BUKRS = '{h.get('COMP_CODE', '')}'", 1), "vendor company code (LFB1)", notes)
        out["vendor"].update(CC_DELETION_FLAG=bool(cc and cc[0]["LOEVM"]), CC_POSTING_BLOCK=bool(cc and cc[0]["SPERR"]), CC_EXISTS=bool(cc), BUKRS=h.get("COMP_CODE", ""))
    if items:
        out["plant"] = optional(lambda: plant_row(c, items[0]["WERKS"]), "plant GSTIN (T001W / J_1BBRANCH)", notes)
    for g in r.get("POHISTORY", []):
        # goods receipts incl. two-step ones: 103/105 (GR blocked stock) and 107/109 (valuated GR blocked stock)
        if g.get("HIST_TYPE") == "E" and g.get("MOVE_TYPE") in ("101", "102", "103", "104", "105", "106", "107", "108", "109", "110", "122", "123"):
            out["grs"].append({"MBLNR": g["MAT_DOC"], "MJAHR": g["DOC_YEAR"], "ZEILE": g["MATDOC_ITM"], "BWART": g["MOVE_TYPE"], "EBELP": str(g["PO_ITEM"]).zfill(5),
                               "MENGE": float(g.get("QUANTITY") or 0) * (-1 if g.get("DB_CR_IND") == "H" else 1), "XBLNR": g.get("REF_DOC_NO", ""), "BUDAT": iso(g.get("PSTNG_DATE"))})
    lots = optional(lambda: read_table(c, "QALS", ["PRUEFLOS", "EBELP", "MBLNR", "ART"], f"EBELN = '{ebeln}'", 50), "inspection lots (QALS)", notes) or []
    for l in lots:
        ud = optional(lambda: read_table(c, "QAVE", ["VCODE", "VBEWERTUNG"], f"PRUEFLOS = '{l['PRUEFLOS']}'", 1), "usage decision (QAVE)", notes) or []
        out["lots"].append({"PRUEFLOS": l["PRUEFLOS"], "EBELP": l["EBELP"], "MBLNR": l["MBLNR"],
                            "UD": ud[0]["VBEWERTUNG"] if ud else "", "UD_TEXT": (f"UD code {ud[0]['VCODE']}, {'accepted' if ud[0]['VBEWERTUNG'] == 'A' else 'rejected'}" if ud else "no usage decision yet")})
    if out["po"]["TYPE"] == "SERVICE":
        ses = optional(lambda: read_table(c, "ESSR", ["LBLNI", "EBELP", "KZABN", "LOEKZ", "LWERT", "TXZ01"], f"EBELN = '{ebeln}'", 50), "service entry sheets (ESSR)", notes) or []
        # JMS evidence: files attached to the entry sheet (GOS, BUS2091) and the SES short text
        out["ses"] = [{"LBLNI": s["LBLNI"], "EBELP": s["EBELP"], "RELEASED": s["KZABN"] == "X", "VALUE": num(s["LWERT"]), "TEXT": s["TXZ01"],
                       "ATTACHMENTS": [a["title"] for a in optional(lambda: gos_list(c, "BUS2091", s["LBLNI"]), "SES attachments (GOS)", notes) or []]}
                      for s in ses if not s["LOEKZ"]]
    out["poAttachments"] = [a["title"] for a in optional(lambda: gos_list(c, "BUS2012", ebeln), "PO attachments (GOS)", notes) or []]
    # PR data (requestor), delivery dates, advances, TDS
    ekpo = optional(lambda: read_table(c, "EKPO", ["EBELP", "BANFN", "BNFPO"], f"EBELN = '{ebeln}'", 50), "PR link (EKPO)", notes) or []
    prs = {}
    for p in ekpo:
        if p["BANFN"]:
            pr = optional(lambda: read_table(c, "EBAN", ["AFNAM", "ERNAM", "BADAT"], f"BANFN = '{p['BANFN']}' AND BNFPO = '{p['BNFPO']}'", 1), "PR (EBAN)", notes) or []
            if pr:
                prs[p["EBELP"]] = {"BANFN": p["BANFN"], "AFNAM": pr[0]["AFNAM"], "ERNAM": pr[0]["ERNAM"], "BADAT": iso(pr[0]["BADAT"])}
    out["pr"] = prs
    eket = optional(lambda: read_table(c, "EKET", ["EBELP", "EINDT", "MENGE", "WEMNG"], f"EBELN = '{ebeln}'", 100), "delivery dates (EKET)", notes) or []
    out["delivery"] = [{"EBELP": e["EBELP"], "EINDT": iso(e["EINDT"]), "MENGE": num(e["MENGE"]), "WEMNG": num(e["WEMNG"])} for e in eket]
    adv = optional(lambda: read_table(c, "EKBE", ["EBELP", "BEWTP", "SHKZG", "DMBTR", "BELNR", "BUDAT"], f"EBELN = '{ebeln}' AND VGABE = '4'", 100), "advances (EKBE)", notes) or []
    out["advances"] = [{"EBELP": a["EBELP"], "BEWTP": a["BEWTP"], "AMOUNT": num(a["DMBTR"]) * (-1 if a["SHKZG"] == "H" else 1), "BELNR": a["BELNR"], "BUDAT": iso(a["BUDAT"])} for a in adv]
    tds = optional(lambda: read_table(c, "LFBW", ["WITHT", "WT_WITHCD", "WT_SUBJCT"], f"LIFNR = '{h.get('VENDOR', '')}' AND BUKRS = '{h.get('COMP_CODE', '')}'", 20), "withholding tax (LFBW)", notes) or []
    out["tds"] = [{"WITHT": t["WITHT"], "WT_WITHCD": t["WT_WITHCD"], "SUBJECT": t["WT_SUBJCT"] == "X"} for t in tds]
    out["deliveryCosts"] = delivery_costs(c, ebeln, notes)
    out["shipmentCosts"] = shipment_costs(c, ebeln, notes)
    out["guarantees"] = optional(lambda: guarantees(c, h.get("VENDOR", ""), h.get("COMP_CODE", ""), ebeln), "BG / security deposit (BSIK special G/L)", notes) or []
    out["users"] = user_info(c, [h.get("CREATED_BY", "")] + [p["ERNAM"] for p in prs.values()], notes)
    fy_start = (date.today().replace(month=4, day=1) if date.today().month >= 4 else date.today().replace(year=date.today().year - 1, month=4, day=1)) - timedelta(days=365)
    inv = optional(lambda: read_table(c, "RBKP", ["BELNR", "GJAHR", "XBLNR", "BLDAT", "RMWWR", "RBSTAT", "STBLG"],
                                      f"LIFNR = '{h.get('VENDOR', '')}' AND BLDAT >= '{fy_start.strftime('%Y%m%d')}'", 2000), "earlier invoices (RBKP)", notes) or []
    status = {"A": "PARKED", "B": "PARKED", "C": "PARKED", "D": "PARKED", "E": "PARKED", "5": "POSTED"}
    out["invoices"] = [{"BELNR": i["BELNR"], "GJAHR": i["GJAHR"], "XBLNR": i["XBLNR"], "BLDAT": iso(i["BLDAT"]), "RMWWR": num(i["RMWWR"]),
                        "STATUS": status.get(i["RBSTAT"], f"STATUS {i['RBSTAT']}"), "LIFNR": lifnr} for i in inv if not i["STBLG"]]
    return out


# ---------------------------------------------------------------- open GR, not invoiced (demo helper)
def cmd_open_items(c, args, log):
    days = int(args[0]) if args else 180
    since = (date.today() - timedelta(days=days)).strftime("%Y%m%d")
    rows = read_table(c, "EKBE", ["EBELN", "EBELP", "VGABE", "SHKZG", "MENGE", "BUDAT"], f"BUDAT >= '{since}' AND ( VGABE = '1' OR VGABE = '2' )", 5000)
    bal = {}
    for r in rows:
        k = (r["EBELN"], r["EBELP"])
        q = num(r["MENGE"]) * (-1 if r["SHKZG"] == "H" else 1)
        b = bal.setdefault(k, {"gr": 0.0, "ir": 0.0, "last": ""})
        b["gr" if r["VGABE"] == "1" else "ir"] += q
        b["last"] = max(b["last"], r["BUDAT"])
    open_ = [(k, v) for k, v in bal.items() if v["gr"] - v["ir"] > 1e-6]
    open_.sort(key=lambda kv: kv[1]["last"], reverse=True)
    return {"items": [{"ebeln": k[0], "ebelp": k[1], "open": round(v["gr"] - v["ir"], 3), "lastGr": iso(v["last"])} for k, v in open_[:40]]}


# ---------------------------------------------------------------- monitor (GR/IR, advances, delivery, open UD)
def po_heads(c, ebelns, notes):
    heads = {}
    for r in optional(lambda: read_in(c, "EKKO", ["EBELN", "LIFNR", "ERNAM", "BUKRS", "BSART"], "EBELN", ebelns), "PO headers (EKKO)", notes) or []:
        heads[r["EBELN"]] = {"LIFNR": ext(r["LIFNR"]), "ERNAM": r["ERNAM"], "BUKRS": r["BUKRS"], "BSART": r["BSART"]}
    names = {ext(v["LIFNR"]): v["NAME1"] for v in optional(lambda: read_in(c, "LFA1", ["LIFNR", "NAME1"], "LIFNR", list({h["LIFNR"].zfill(10) if h["LIFNR"].isdigit() else h["LIFNR"] for h in heads.values()})), "vendor names (LFA1)", notes) or []}
    for h in heads.values():
        h["NAME1"] = names.get(h["LIFNR"], "")
    return heads


def read_in(c, table, fields, key, values, extra="", chunk=15):
    rows, values = [], [v for v in dict.fromkeys(values) if v]
    for i in range(0, len(values), chunk):
        cond = "( " + " OR ".join(f"{key} = '{v}'" for v in values[i:i + chunk]) + " )"
        rows += read_table(c, table, fields, f"{cond}{' AND ' + extra if extra else ''}", 5000)
    return rows


def cmd_monitor(c, job, log):
    notes = []
    days = int(job.get("days") or 180)
    today = date.today()
    since = (today - timedelta(days=days)).strftime("%Y%m%d")
    # open GR not invoiced
    rows = read_table(c, "EKBE", ["EBELN", "EBELP", "VGABE", "SHKZG", "MENGE", "DMBTR", "BUDAT"], f"BUDAT >= '{since}' AND ( VGABE = '1' OR VGABE = '2' )", 5000)
    bal = {}
    for r in rows:
        k = (r["EBELN"], r["EBELP"])
        s = -1 if r["SHKZG"] == "H" else 1
        b = bal.setdefault(k, {"gr": 0.0, "ir": 0.0, "grValue": 0.0, "last": ""})
        if r["VGABE"] == "1":
            b["gr"] += s * num(r["MENGE"]); b["grValue"] += s * num(r["DMBTR"]); b["last"] = max(b["last"], r["BUDAT"])
        else:
            b["ir"] += s * num(r["MENGE"])
    grir = [{"EBELN": k[0], "EBELP": k[1], "OPEN_QTY": round(v["gr"] - v["ir"], 3), "VALUE": round(v["grValue"] * (v["gr"] - v["ir"]) / v["gr"], 2) if v["gr"] else 0,
             "LAST_GR": iso(v["last"]), "DAYS": (today - date.fromisoformat(iso(v["last"]))).days if v["last"] else None}
            for k, v in bal.items() if v["gr"] - v["ir"] > 1e-6]
    grir.sort(key=lambda x: x["LAST_GR"], reverse=True)
    grir = grir[:60]
    # advances (down payments on POs) not yet cleared
    adv_rows = optional(lambda: read_table(c, "EKBE", ["EBELN", "EBELP", "BEWTP", "SHKZG", "DMBTR", "BUDAT"], f"BUDAT >= '{since}' AND VGABE = '4'", 2000), "advances (EKBE VGABE 4)", notes) or []
    adv = {}
    for r in adv_rows:
        a = adv.setdefault(r["EBELN"], {"amount": 0.0, "date": ""})
        a["amount"] += num(r["DMBTR"]) * (-1 if r["SHKZG"] == "H" else 1)
        a["date"] = max(a["date"], r["BUDAT"])
    gr_pos = {k[0] for k, v in bal.items() if v["gr"] > 0}
    advances = [{"EBELN": e, "AMOUNT": round(a["amount"], 2), "PAID_ON": iso(a["date"]), "GR_DONE": e in gr_pos} for e, a in adv.items() if a["amount"] > 0.01]
    # delivery date passed, not fully received
    eket = optional(lambda: read_table(c, "EKET", ["EBELN", "EBELP", "EINDT", "MENGE", "WEMNG"], f"EINDT >= '{since}' AND EINDT <= '{today.strftime('%Y%m%d')}'", 3000), "delivery dates (EKET)", notes) or []
    late = [{"EBELN": e["EBELN"], "EBELP": e["EBELP"], "EINDT": iso(e["EINDT"]), "OPEN": round(num(e["MENGE"]) - num(e["WEMNG"]), 3),
             "DAYS_LATE": (today - date.fromisoformat(iso(e["EINDT"]))).days} for e in eket if num(e["MENGE"]) - num(e["WEMNG"]) > 1e-6]
    late.sort(key=lambda x: x["DAYS_LATE"])
    late = late[:60]
    # inspection lots for POs without usage decision, and rejected ones
    lots = optional(lambda: read_table(c, "QALS", ["PRUEFLOS", "EBELN", "EBELP", "MBLNR", "ENSTEHDAT", "MATNR"], f"ENSTEHDAT >= '{since}' AND EBELN <> ''", 300), "inspection lots (QALS)", notes) or []
    ud = {}
    for r in optional(lambda: read_in(c, "QAVE", ["PRUEFLOS", "VCODE", "VBEWERTUNG", "VDATUM"], "PRUEFLOS", [l["PRUEFLOS"] for l in lots]), "usage decisions (QAVE)", notes) or []:
        ud[r["PRUEFLOS"]] = r
    qm = [{"PRUEFLOS": l["PRUEFLOS"], "EBELN": l["EBELN"], "EBELP": l["EBELP"], "MBLNR": l["MBLNR"], "MATNR": ext(l["MATNR"]), "CREATED": iso(l["ENSTEHDAT"]),
           "UD": ud.get(l["PRUEFLOS"], {}).get("VBEWERTUNG", ""), "UD_CODE": ud.get(l["PRUEFLOS"], {}).get("VCODE", "")} for l in lots]
    qm = [q for q in qm if q["UD"] != "A"][:60]
    # who to tell: PO creator, vendor, PR requestor
    ebelns = list({x["EBELN"] for x in grir + advances + late + qm})
    heads = po_heads(c, ebelns, notes)
    prq = {}
    for p in optional(lambda: read_in(c, "EKPO", ["EBELN", "EBELP", "BANFN", "TXZ01"], "EBELN", ebelns), "PO items (EKPO)", notes) or []:
        prq[(p["EBELN"], p["EBELP"])] = {"BANFN": p["BANFN"], "TXZ01": p["TXZ01"]}
    pr_users = {}
    for r in optional(lambda: read_in(c, "EBAN", ["BANFN", "AFNAM", "ERNAM"], "BANFN", [v["BANFN"] for v in prq.values()]), "PRs (EBAN)", notes) or []:
        pr_users.setdefault(r["BANFN"], r)
    def enrich(x):
        h = heads.get(x["EBELN"], {})
        it = prq.get((x["EBELN"], x.get("EBELP", "")), {}) or next((v for k, v in prq.items() if k[0] == x["EBELN"]), {})
        pr = pr_users.get(it.get("BANFN", ""), {})
        return {**x, "LIFNR": h.get("LIFNR", ""), "VENDOR": h.get("NAME1", ""), "BUYER": h.get("ERNAM", ""), "BUKRS": h.get("BUKRS", ""),
                "TXZ01": it.get("TXZ01", ""), "REQUESTOR": pr.get("ERNAM", "") or pr.get("AFNAM", ""), "REQ_NAME": pr.get("AFNAM", "")}
    lists = {"grir": [enrich(x) for x in grir], "advances": [enrich(x) for x in advances], "late": [enrich(x) for x in late], "qm": [enrich(x) for x in qm]}
    who = {x[k] for l in lists.values() for x in l for k in ("BUYER", "REQUESTOR") if x.get(k)}
    due = optional(lambda: due_list(c, today, int(job.get("dueDays") or 400), int(job.get("msmeDays") or 45), notes), "open vendor items (BSIK)", notes) or []
    return {**lists, "due": due, "users": user_info(c, sorted(who), notes), "notes": notes, "asOf": today.isoformat()}


def due_list(c, today, days, msme_days, notes):
    """Vendor due list for the payment run: open vendor invoices (BSIK, no special G/L) with their net due date
    (baseline + the last payment-term period, as SAP does), the MSME limit (document date + 45 days, MSMED Act
    s.15) and payment blocks. Debit items that reference an invoice (part payments, credit notes) reduce it."""
    since = (today - timedelta(days=days)).strftime("%Y%m%d")
    F = ["BUKRS", "LIFNR", "BELNR", "GJAHR", "BUZEI", "BLDAT", "BUDAT", "ZFBDT", "ZBD1T", "ZBD2T", "ZBD3T", "SHKZG", "WRBTR", "WAERS", "XBLNR", "BLART", "UMSKZ", "REBZG", "REBZJ", "ZLSPR", "ZTERM"]
    rows = [r for r in read_table(c, "BSIK", F, f"BUDAT >= '{since}'", 3000) if not r["UMSKZ"]]
    less = {}
    for r in rows:
        if r["SHKZG"] == "S" and r["REBZG"]:
            k = (r["BUKRS"], r["REBZG"], r["REBZJ"] or r["GJAHR"])
            less[k] = less.get(k, 0) + num(r["WRBTR"])
    vend = {v["LIFNR"]: v for v in optional(lambda: read_in(c, "LFA1", ["LIFNR", "NAME1", "J_1ISSIST"], "LIFNR", list({r["LIFNR"] for r in rows})), "vendor names (LFA1)", notes) or []}
    out = []
    for r in rows:
        if r["SHKZG"] != "H":
            continue
        amount = round(num(r["WRBTR"]) - less.get((r["BUKRS"], r["BELNR"], r["GJAHR"]), 0), 2)
        if amount <= 0.004:
            continue
        base = iso(r["ZFBDT"]) or iso(r["BLDAT"])
        term = next((int(num(r[k])) for k in ("ZBD3T", "ZBD2T", "ZBD1T") if num(r[k])), 0)
        due = date.fromisoformat(base) + timedelta(days=term) if base else today
        v = vend.get(r["LIFNR"], {})
        msme = bool(v.get("J_1ISSIST", "").strip())
        msme_due = date.fromisoformat(iso(r["BLDAT"]) or base) + timedelta(days=msme_days) if msme and (iso(r["BLDAT"]) or base) else None
        pay_by = min(due, msme_due) if msme_due else due
        out.append({"BUKRS": r["BUKRS"], "LIFNR": r["LIFNR"], "VENDOR": v.get("NAME1", ""), "MSME": msme, "MSME_TYPE": v.get("J_1ISSIST", ""),
                    "BELNR": r["BELNR"], "GJAHR": r["GJAHR"], "XBLNR": r["XBLNR"], "BLART": r["BLART"], "BLDAT": iso(r["BLDAT"]), "BASELINE": base,
                    "TERM_DAYS": term, "ZTERM": r["ZTERM"], "AMOUNT": amount, "PART_PAID": round(less.get((r["BUKRS"], r["BELNR"], r["GJAHR"]), 0), 2),
                    "CURRENCY": r["WAERS"], "DUE": due.isoformat(), "MSME_DUE": msme_due.isoformat() if msme_due else "",
                    "PAY_BY": pay_by.isoformat(), "DAYS": (pay_by - today).days, "BLOCK": r["ZLSPR"]})
    out.sort(key=lambda x: (x["PAY_BY"], x["LIFNR"]))
    return out[:500]


# ---------------------------------------------------------------- status of parked invoices (reverse data)
def cmd_status(c, job, log):
    notes, out = [], {}
    status = {"A": "PARKED", "B": "PARKED", "C": "PARKED", "D": "PARKED", "E": "PARKED", "5": "POSTED"}
    for d in job["docs"]:
        b, g = d["belnr"], d["gjahr"]
        r = optional(lambda: read_table(c, "RBKP", ["RBSTAT", "BUKRS", "STBLG", "LIFNR"], f"BELNR = '{b}' AND GJAHR = '{g}'", 1), f"RBKP {b}/{g}", notes)
        if r is None:                                   # the read failed: status unknown, so leave it as it was
            continue
        if not r:                                       # the read worked and found nothing: really deleted
            out[f"{b}/{g}"] = {"status": "DELETED"}
            continue
        st = {"status": "REVERSED" if r[0]["STBLG"] else status.get(r[0]["RBSTAT"], r[0]["RBSTAT"])}
        if st["status"] == "POSTED":
            fi = optional(lambda: read_table(c, "BKPF", ["BUKRS", "BELNR", "GJAHR", "BUDAT"], f"AWTYP = 'RMRP' AND AWKEY = '{b}{g}'", 1), "FI document (BKPF)", notes) or []
            if fi:
                st.update(fiDoc=fi[0]["BELNR"], fiYear=fi[0]["GJAHR"], fiBukrs=fi[0]["BUKRS"], postedOn=iso(fi[0]["BUDAT"]))
                st.update(optional(lambda: payment_state(c, fi[0]), "payments (BSEG)", notes) or {})
        out[f"{b}/{g}"] = st
    return {"docs": out, "notes": notes}


def payment_state(c, fi):
    """Full or partial payment of a posted invoice, from its vendor line and the vendor lines that reference it
    (BSEG-REBZG). F-53 books a part payment in one of two ways:
      partial payment  - the invoice stays open, a debit line with REBZT 'Z' references it;
      residual item    - the invoice is cleared, a new open item with REBZT 'V' carries the remaining amount.
    Amounts are vendor-line amounts, so withholding tax deducted at payment counts as settled."""
    bk, bl, gj = fi["BUKRS"], fi["BELNR"], fi["GJAHR"]
    F = ["BELNR", "GJAHR", "BUZEI", "SHKZG", "WRBTR", "AUGBL", "AUGDT", "REBZT"]
    v = read_table(c, "BSEG", F, f"BUKRS = '{bk}' AND BELNR = '{bl}' AND GJAHR = '{gj}' AND KOART = 'K'", 1)
    if not v:
        return {}
    v = v[0]
    gross = num(v["WRBTR"])
    refs = [r for r in read_table(c, "BSEG", F, f"BUKRS = '{bk}' AND REBZG = '{bl}' AND REBZJ = '{gj}' AND KOART = 'K'", 50) if r["BELNR"] != bl]
    dates = {}
    def posted(belnr, gjahr):
        if (belnr, gjahr) not in dates:
            h = read_table(c, "BKPF", ["BUDAT"], f"BUKRS = '{bk}' AND BELNR = '{belnr}' AND GJAHR = '{gjahr}'", 1)
            dates[(belnr, gjahr)] = iso(h[0]["BUDAT"]) if h else ""
        return dates[(belnr, gjahr)]
    base = {"invoiceAmount": gross}
    if v["AUGBL"]:
        open_res = [r for r in refs if r["REBZT"] == "V" and not r["AUGBL"]]
        pays = [{"doc": v["AUGBL"], "date": iso(v["AUGDT"]), "amount": round(gross - sum(num(r["WRBTR"]) for r in refs if r["REBZT"] == "V" and r["BELNR"] == v["AUGBL"]), 2)}]
        pays += [{"doc": r["AUGBL"], "date": iso(r["AUGDT"]), "amount": num(r["WRBTR"])} for r in refs if r["REBZT"] == "V" and r["AUGBL"]]
        if open_res:
            left = round(sum(num(r["WRBTR"]) for r in open_res), 2)
            return {**base, "status": "PART_PAID", "paidAmount": round(gross - left, 2), "openAmount": left, "payments": pays,
                    "paymentDoc": pays[-1]["doc"], "paidOn": pays[-1]["date"], "method": "residual item"}
        last = pays[-1]
        return {**base, "status": "PAID", "paidAmount": gross, "openAmount": 0, "payments": pays, "paymentDoc": last["doc"], "paidOn": last["date"]}
    parts = [r for r in refs if r["REBZT"] == "Z" or (r["SHKZG"] == "S" and r["REBZT"] != "V")]
    if not parts:
        return {}
    paid = round(sum(num(r["WRBTR"]) for r in parts), 2)
    pays = sorted(({"doc": r["BELNR"], "date": posted(r["BELNR"], r["GJAHR"]), "amount": num(r["WRBTR"])} for r in parts), key=lambda p: p["date"])
    return {**base, "status": "PART_PAID", "paidAmount": paid, "openAmount": round(gross - paid, 2), "payments": pays,
            "paymentDoc": pays[-1]["doc"], "paidOn": pays[-1]["date"], "method": "partial payment"}


# ---------------------------------------------------------------- park (BAPI_INCOMINGINVOICE_PARK)
def cmd_park(c, job, log):
    p = job["payload"]
    hd = dict(p["HEADERDATA"])
    hd.pop("VENDOR", None)
    hd.pop("FISC_YEAR", None)
    for k in ("DOC_DATE", "PSTNG_DATE", "BLINE_DATE"):
        if hd.get(k):
            hd[k] = hd[k].replace("-", "")
    hd["GROSS_AMOUNT"] = Decimal(str(round(float(hd["GROSS_AMOUNT"]), 2)))
    items = []
    for it in p["ITEMDATA"]:
        row = {k: v for k, v in it.items() if v not in (None, "")}
        row["ITEM_AMOUNT"] = Decimal(str(round(float(row["ITEM_AMOUNT"]), 2)))
        row["QUANTITY"] = Decimal(str(row["QUANTITY"]))
        items.append(row)
    hd = {k: v for k, v in hd.items() if v is not None}
    tax = [{"TAX_CODE": t["TAX_CODE"], "TAX_AMOUNT": Decimal(str(round(float(t["TAX_AMOUNT"]), 2))),
            "TAX_BASE_AMOUNT": Decimal(str(round(float(t["TAX_BASE_AMOUNT"]), 2)))} for t in p.get("TAXDATA") or []]
    r = c.call("BAPI_INCOMINGINVOICE_PARK", HEADERDATA=hd, ITEMDATA=items, **({"TAXDATA": tax} if tax else {}))
    ms = msgs(r.get("RETURN"))
    log.append({"step": "park", "messages": ms})
    doc = r.get("INVOICEDOCNUMBER") or ""
    if errors(ms) or not doc:
        c.call("BAPI_TRANSACTION_ROLLBACK")
        raise RfcError("park", "; ".join(m["message"] for m in errors(ms)) or "SAP returned no invoice document number", ms)
    c.call("BAPI_TRANSACTION_COMMIT", WAIT="X")
    return {"RETURN": ms or [{"type": "S", "message": f"Document {doc} parked"}], "INVOICEDOCNUMBER": doc, "FISCALYEAR": r.get("FISCALYEAR", "")}


def gos_list(c, objtype, objkey):
    """GOS attachments (relation ATTA) of a business object, e.g. BUS2081 invoice document (BELNR + GJAHR),
    BUS2012 purchase order (EBELN), BKPF accounting document (BUKRS + BELNR + GJAHR)."""
    rels = read_table(c, "SRGBTBREL", ["INSTID_B"], f"TYPEID_A = '{objtype}' AND RELTYPE = 'ATTA' AND INSTID_A = '{objkey}'")
    out = []
    for r in rels:
        b = r["INSTID_B"]                                     # FOLTP FOLYR FOLNO (17) + OBJTP OBJYR OBJNO (17)
        objtp, objyr, objno = b[17:20], b[20:22], b[22:34]
        sood = read_table(c, "SOOD", ["OBJDES", "FILE_EXT", "OBJLEN", "CRONAM", "CRDAT"],
                          f"OBJTP = '{objtp}' AND OBJYR = '{objyr}' AND OBJNO = '{objno}'", 1)
        s = sood[0] if sood else {}
        out.append({"docId": b, "title": s.get("OBJDES", ""), "ext": s.get("FILE_EXT", ""), "bytes": num(s.get("OBJLEN")),
                    "by": s.get("CRONAM", ""), "on": iso(s.get("CRDAT", ""))})
    return out


def obj_of(job):
    """objtype / objkey from the job; belnr + gjahr alone mean the invoice document (BUS2081)."""
    if job.get("objtype"):
        return job["objtype"], job["objkey"]
    return "BUS2081", f"{job['belnr']}{job['gjahr']}"


def cmd_attachments(c, job, log):
    return {"attachments": gos_list(c, *obj_of(job))}


def cmd_attach(c, job, log):
    """Attach the invoice PDF to a business object (GOS 'Attachment list'):
    SO_DOCUMENT_INSERT_API1 stores the file in the SAPoffice folder, BINARY_RELATION_CREATE_COMMIT links it to the object.
    The same title already attached -> nothing is added again."""
    objtype, objkey = obj_of(job)
    title = (job.get("title") or "Invoice")[:50]
    have = gos_list(c, objtype, objkey)
    same = next((a for a in have if a["title"] == title), None)
    if same:
        log.append({"step": "attach", "messages": [{"type": "I", "message": f"'{title}' is already attached to {objtype} {objkey}"}]})
        return {"attachment": same, "already": True, "attachments": have}
    data = open(job["file"], "rb").read()
    rows = [{"LINE": data[i:i + 255]} for i in range(0, len(data), 255)]
    root = c.call("SO_FOLDER_ROOT_ID_GET", REGION="B")["FOLDER_ID"]
    folder = root["OBJTP"] + root["OBJYR"] + root["OBJNO"]
    ins = c.call("SO_DOCUMENT_INSERT_API1", FOLDER_ID=folder, DOCUMENT_TYPE="PDF", CONTENTS_HEX=rows,
                 DOCUMENT_DATA={"OBJ_NAME": "ATTACHMENT", "OBJ_DESCR": title, "OBJ_LANGU": "E", "DOC_SIZE": str(len(data))})
    doc_id = ins["DOCUMENT_INFO"]["DOC_ID"]
    if not doc_id.strip():
        c.call("BAPI_TRANSACTION_ROLLBACK")
        raise RfcError("attach", "SAPoffice returned no document id")
    c.call("BINARY_RELATION_CREATE_COMMIT", RELATIONTYPE="ATTA",
           OBJ_ROLEA={"OBJKEY": objkey, "OBJTYPE": objtype}, OBJ_ROLEB={"OBJKEY": doc_id, "OBJTYPE": "MESSAGE"})
    c.call("BAPI_TRANSACTION_COMMIT", WAIT="X")
    # the relation is committed without waiting for the update task (seen on BKPF): look again for a few seconds
    att = None
    for wait in (0, 1, 2, 3, 4):
        time.sleep(wait)
        have = gos_list(c, objtype, objkey)
        att = next((a for a in have if a["title"] == title), None)
        if att:
            break
    if not att:
        raise RfcError("attach", f"The PDF was stored but the link to {objtype} {objkey} is not visible in SRGBTBREL after 10 s")
    log.append({"step": "attach", "messages": [{"type": "S", "message": f"{title} attached to {objtype} {objkey}"}]})
    return {"attachment": att, "already": False, "attachments": have}


COMMANDS = {"context": cmd_context, "park": cmd_park, "monitor": cmd_monitor, "status": cmd_status, "attach": cmd_attach, "attachments": cmd_attachments}


def run(c, cmd, args, job):
    """One command on an open connection -> result dict (never raises)."""
    out = {"ok": False, "log": []}
    try:
        out["session"] = session(c)
        if cmd == "ping":
            c.call("RFC_PING")
        elif cmd == "open_items":
            out.update(cmd_open_items(c, args or [], out["log"]))
        elif cmd in COMMANDS:
            out.update(COMMANDS[cmd](c, job or {}, out["log"]))
        else:
            raise RfcError("cmd", f"unknown command {cmd}")
        out["ok"] = True
    except RfcError as e:
        out["error"] = {"step": e.step, "message": e.message, "messages": e.messages}
    except Exception as e:
        out["error"] = {"step": "unexpected", "message": f"{type(e).__name__}: {str(e)[:400]}"}
    return out


def serve():
    """Long-running worker: one request per stdin line {"id","cmd","args","job"}, one JSON answer per stdout line.
    Keeps the RFC connection open (log-on once instead of per call) and reconnects when SAP drops it."""
    c = None
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue
        out = None
        for attempt in (1, 2):
            try:
                if c is None:
                    c = connect()
                out = run(c, req.get("cmd"), req.get("args"), req.get("job"))
                # a broken connection shows up as an unexpected communication error: log on again once
                if not out["ok"] and out.get("error", {}).get("step") == "unexpected" and re.search(r"COMMUNICATION|connection|closed|RFC_INVALID_HANDLE", out["error"]["message"], re.I) and attempt == 1:
                    c = None
                    continue
            except RfcError as e:
                c = None
                out = {"ok": False, "log": [], "error": {"step": e.step, "message": e.message, "messages": e.messages}}
            break
        out["id"] = req.get("id")
        print(json.dumps(out, default=str), flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["ping", "open_items", "context", "park", "monitor", "status", "attach", "attachments", "serve"])
    ap.add_argument("args", nargs="*")
    ap.add_argument("--job")
    a = ap.parse_args()
    if a.cmd == "serve":
        serve()
        return 0
    try:
        c = connect()
        out = run(c, a.cmd, a.args, json.load(open(a.job, encoding="utf-8")) if a.job else None)
    except RfcError as e:
        out = {"ok": False, "log": [], "error": {"step": e.step, "message": e.message, "messages": e.messages}}
    print(json.dumps(out, default=str))
    return 0 if out["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
