from __future__ import annotations

import hashlib
import os
import re
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Any, Dict, List, Optional, Tuple

from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

APP_NAME = "ReceiptJSON (MVP)"
APP_VERSION = "0.1.0"

class LineItem(BaseModel):
    description: str
    quantity: Optional[float] = None
    unit_price: Optional[float] = None
    amount: Optional[float] = None

class ParsedDocument(BaseModel):
    vendor: Optional[str] = None
    invoice_number: Optional[str] = None
    date: Optional[str] = None
    currency: Optional[str] = None
    subtotal: Optional[float] = None
    tax: Optional[float] = None
    total: Optional[float] = None
    line_items: List[LineItem] = Field(default_factory=list)
    confidence: Dict[str, float] = Field(default_factory=dict)

class ParseResponse(BaseModel):
    ok: bool = True
    parsed: ParsedDocument
    warnings: List[str] = Field(default_factory=list)
    meta: Dict[str, Any] = Field(default_factory=dict)

MONEY_RE = re.compile(
    r"(?i)(?P<cur>usd|eur|gbp|cad|aud|inr|jpy|chf|sek|nok|dkk|zar|sgd|hkd|mxn|brl|pln|czk|huf|ron|try|ils|aed|sar|qar|kwd|bhd|omr|php|thb|idr|myr|vnd|krw|cny|rmb|\$|€|£)\s*"
    r"(?P<amt>\d{1,3}(?:[\.,]\d{3})*(?:[\.,]\d{2})|\d+(?:[\.,]\d{2})?)"
)

DATE_RES = [
    re.compile(r"\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b"),
    re.compile(r"\b(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})\b"),
]

INVOICE_NO_RE = re.compile(r"(?i)\b(invoice|inv)\s*(no\.|number|#|:)?\s*([A-Z0-9-]{3,})\b")

TOTAL_KEYS = ["total", "amount due", "balance due", "grand total"]
TAX_KEYS = ["tax", "vat", "gst", "hst", "sales tax"]
SUBTOTAL_KEYS = ["subtotal", "sub total"]


def _norm_money(s: str) -> Optional[Tuple[Optional[str], float]]:
    m = MONEY_RE.search(s)
    if not m:
        return None
    cur = m.group("cur").upper()
    cur_map = {"$": "USD", "€": "EUR", "£": "GBP"}
    cur = cur_map.get(cur, cur)
    raw = m.group("amt")
    if raw.count(",") > 0 and raw.count(".") > 0:
        if raw.rfind(",") > raw.rfind("."):
            raw = raw.replace(".", "").replace(",", ".")
        else:
            raw = raw.replace(",", "")
    else:
        raw = raw.replace(",", "")
    try:
        return cur, float(Decimal(raw))
    except (InvalidOperation, ValueError):
        return None


def _pick_vendor(lines: List[str]) -> Optional[str]:
    bad = {"invoice", "receipt", "tax invoice", "bill", "statement"}
    for ln in lines[:10]:
        t = ln.strip()
        if not t:
            continue
        if t.lower() in bad:
            continue
        if sum(c.isdigit() for c in t) > max(3, len(t) // 2):
            continue
        return t[:120]
    return None


def _pick_date(text: str) -> Optional[str]:
    for rx in DATE_RES:
        m = rx.search(text)
        if not m:
            continue
        parts = m.groups()
        try:
            if len(parts[0]) == 4:
                y, mo, d = int(parts[0]), int(parts[1]), int(parts[2])
            else:
                mo, d, y = int(parts[0]), int(parts[1]), int(parts[2])
                if y < 100:
                    y += 2000
            dt = datetime(y, mo, d)
            return dt.date().isoformat()
        except Exception:
            continue
    return None


def _find_keyed_amount(lines: List[str], keys: List[str]) -> Optional[Tuple[Optional[str], float]]:
    for ln in lines:
        low = ln.lower()
        if any(k in low for k in keys):
            mm = _norm_money(ln)
            if mm:
                return mm
    return None


def parse_text_to_json(text: str) -> Tuple[ParsedDocument, List[str]]:
    warnings: List[str] = []
    clean = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = [ln.strip() for ln in clean.split("\n") if ln.strip()]

    vendor = _pick_vendor(lines)
    date = _pick_date(clean)

    invoice_number = None
    m = INVOICE_NO_RE.search(clean)
    if m:
        invoice_number = m.group(3)

    total = _find_keyed_amount(lines, TOTAL_KEYS)
    tax = _find_keyed_amount(lines, TAX_KEYS)
    subtotal = _find_keyed_amount(lines, SUBTOTAL_KEYS)

    currency = None
    if total and total[0]:
        currency = total[0]
    elif tax and tax[0]:
        currency = tax[0]
    elif subtotal and subtotal[0]:
        currency = subtotal[0]

    line_items: List[LineItem] = []
    for ln in lines:
        low = ln.lower()
        if any(k in low for k in (TOTAL_KEYS + TAX_KEYS + SUBTOTAL_KEYS)):
            continue
        mm = _norm_money(ln)
        if mm:
            desc = re.sub(MONEY_RE, "", ln).strip(" -:\t")
            if desc and len(desc) >= 2:
                line_items.append(LineItem(description=desc[:200], amount=mm[1]))

    conf: Dict[str, float] = {
        "vendor": 0.6 if vendor else 0.0,
        "date": 0.7 if date else 0.0,
        "total": 0.8 if total else 0.0,
        "tax": 0.6 if tax else 0.0,
    }

    parsed = ParsedDocument(
        vendor=vendor,
        invoice_number=invoice_number,
        date=date,
        currency=currency,
        subtotal=subtotal[1] if subtotal else None,
        tax=tax[1] if tax else None,
        total=total[1] if total else None,
        line_items=line_items,
        confidence=conf,
    )

    if not text.strip():
        warnings.append("Empty input.")
    if not parsed.total:
        warnings.append("Could not confidently find TOTAL. Provide clearer text or include a line like 'Total $12.34'.")

    return parsed, warnings


def _sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


app = FastAPI(title=APP_NAME, version=APP_VERSION)

BASE_DIR = os.path.dirname(__file__)
STATIC_DIR = os.path.join(BASE_DIR, "static")
if os.path.isdir(STATIC_DIR):
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", response_class=HTMLResponse)
async def index(_: Request):
    html = """<!doctype html>
<html lang='en'>
<head>
  <meta charset='utf-8'/>
  <meta name='viewport' content='width=device-width, initial-scale=1'/>
  <title>ReceiptJSON — minimal invoice/receipt parser API</title>
  <style>
    body{font-family: ui-sans-serif,system-ui,Segoe UI,Roboto,Arial; max-width: 920px; margin: 32px auto; padding: 0 16px; line-height: 1.5;}
    code,pre{background:#f6f8fa; padding:2px 6px; border-radius:6px;}
    pre{padding:12px; overflow:auto;}
    .card{border:1px solid #e5e7eb; border-radius:12px; padding:16px; margin: 14px 0;}
    .muted{color:#4b5563;}
  </style>
</head>
<body>
  <h1>ReceiptJSON</h1>
  <p class='muted'>A minimal, privacy-forward API that converts invoices/receipts into structured JSON.</p>

  <div class='card'>
    <h2>API</h2>
    <ul>
      <li><code>GET /health</code></li>
      <li><code>POST /parse</code> (supports <code>text</code> now; file upload accepted but parsed as text only in MVP)</li>
      <li>Interactive docs: <a href='/docs'>/docs</a></li>
    </ul>
  </div>

  <div class='card'>
    <h2>Pricing suggestion (honest MVP)</h2>
    <ul>
      <li><b>Free</b>: 25 parses/month, best-effort extraction.</li>
      <li><b>Starter</b>: $9/month for 1,000 parses.</li>
      <li><b>Pro</b>: $49/month for 10,000 parses (SLA + higher limits).</li>
    </ul>
    <p class='muted'>This sandbox demo does not collect payment yet.</p>
  </div>

  <div class='card'>
    <h2>Data handling (default)</h2>
    <ul>
      <li>We do <b>not</b> store uploaded documents by default.</li>
      <li>We log minimal metadata: timestamp, request id, input type, bytes, and a SHA-256 hash of the payload (non-reversible).</li>
      <li>No training on customer documents in this MVP.</li>
    </ul>
  </div>

  <div class='card'>
    <h2>Contact</h2>
    <p>Email: <code>support@example.com</code> (replace with your real address)</p>
  </div>

  <div class='card'>
    <h2>Try it</h2>
    <pre>curl -s http://localhost:8000/parse \
  -F "text=ACME Corp\nInvoice #INV-1001\n2026-02-28\nSubtotal $10.00\nTax $0.80\nTotal $10.80" | python -m json.tool</pre>
  </div>

  <p class='muted'>Disclaimer: Extraction is best-effort. Always verify totals and taxes before bookkeeping.</p>
</body>
</html>"""
    return HTMLResponse(html)


@app.get("/health")
async def health():
    return {"ok": True, "name": APP_NAME, "version": APP_VERSION}


@app.post("/parse", response_model=ParseResponse)
async def parse_endpoint(
    request: Request,
    text: Optional[str] = Form(default=None),
    file: Optional[UploadFile] = File(default=None),
):
    req_id = request.headers.get("x-request-id") or hashlib.sha1(os.urandom(16)).hexdigest()[:12]

    raw_bytes: bytes = b""
    input_type = "none"

    if text is not None and text.strip() != "":
        input_type = "text"
        raw_bytes = text.encode("utf-8", errors="ignore")
        raw_text = text
    elif file is not None:
        input_type = f"file:{file.content_type or 'application/octet-stream'}"
        raw_bytes = await file.read()
        raw_text = raw_bytes.decode("utf-8", errors="ignore")
    else:
        raw_text = ""

    parsed, warnings = parse_text_to_json(raw_text)

    meta = {
        "request_id": req_id,
        "input_type": input_type,
        "bytes": len(raw_bytes),
        "sha256": _sha256_bytes(raw_bytes) if raw_bytes else None,
        "note": "MVP parses plain text only; PDF/image require OCR/PDF text extraction in a paid tier.",
    }

    return ParseResponse(ok=True, parsed=parsed, warnings=warnings, meta=meta)
