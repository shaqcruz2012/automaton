import hashlib
import os
import re
import time
from typing import Any, Dict, List, Optional

import dateparser
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import HTMLResponse

APP_NAME = "Receipt/Invoice Parser API (MVP)"

app = FastAPI(
    title=APP_NAME,
    version="0.1.0",
    description=(
        "Privacy-forward microservice that parses invoices/receipts into structured JSON. "
        "MVP supports plain text input and basic heuristics."
    ),
)


def _sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _money_to_float(s: str) -> Optional[float]:
    if not s:
        return None
    s = s.strip()
    s = s.replace(",", "")
    s = re.sub(r"[^0-9.\-]", "", s)
    if not s or s in {"-", "."}:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _find_candidates(patterns: List[str], text: str) -> List[str]:
    out: List[str] = []
    for pat in patterns:
        for m in re.finditer(pat, text, flags=re.IGNORECASE | re.MULTILINE):
            val = (m.group("val") if "val" in m.groupdict() else m.group(1)).strip()
            if val:
                out.append(val)
    return out


def parse_invoice_text(text: str) -> Dict[str, Any]:
    raw = text or ""
    # Normalize whitespace but keep newlines for simple line-item parsing.
    cleaned = raw.replace("\r\n", "\n").replace("\r", "\n")
    cleaned = re.sub(r"[\t ]+", " ", cleaned)

    # Vendor heuristic: first non-empty line that isn't an obvious header like 'INVOICE'
    vendor = None
    for line in cleaned.split("\n"):
        l = line.strip()
        if not l:
            continue
        if re.fullmatch(r"(invoice|receipt|tax invoice|statement)", l, flags=re.IGNORECASE):
            continue
        vendor = l[:120]
        break

    # Date heuristics
    date_strs = _find_candidates(
        [
            r"(?:invoice\s*date|date)\s*[:#-]?\s*(?P<val>.+)$",
            r"\b(?P<val>\d{4}[-/]\d{1,2}[-/]\d{1,2})\b",
            r"\b(?P<val>\d{1,2}[-/]\d{1,2}[-/]\d{2,4})\b",
        ],
        cleaned,
    )
    parsed_date = None
    for ds in date_strs:
        dt = dateparser.parse(ds, settings={"PREFER_DAY_OF_MONTH": "first"})
        if dt:
            parsed_date = dt.date().isoformat()
            break

    # Totals and taxes (prefer explicit labels)
    total_candidates = _find_candidates(
        [
            r"(?:grand\s*total|total\s*due|amount\s*due|total)\s*[:#-]?\s*(?P<val>[$€£]?\s*[-]?[0-9][0-9,]*\.?[0-9]{0,2})",
        ],
        cleaned,
    )
    tax_candidates = _find_candidates(
        [
            r"(?:tax|vat|gst|sales\s*tax)\s*[:#-]?\s*(?P<val>[$€£]?\s*[-]?[0-9][0-9,]*\.?[0-9]{0,2})",
        ],
        cleaned,
    )

    total = None
    for c in total_candidates:
        total = _money_to_float(c)
        if total is not None:
            break

    taxes = None
    for c in tax_candidates:
        taxes = _money_to_float(c)
        if taxes is not None:
            break

    # Simple line items: look for lines like 'Widget A  2  9.99  19.98'
    line_items: List[Dict[str, Any]] = []
    for line in cleaned.split("\n"):
        l = line.strip()
        if not l:
            continue
        if re.search(r"\b(total|subtotal|tax|vat|gst|amount due|balance)\b", l, flags=re.IGNORECASE):
            continue
        m = re.match(
            r"^(?P<desc>.{3,}?)\s{2,}(?P<qty>\d+(?:\.\d+)?)\s+(?P<unit>[$€£]?\s*[0-9][0-9,]*\.?[0-9]{0,2})\s+(?P<amt>[$€£]?\s*[0-9][0-9,]*\.?[0-9]{0,2})$",
            l,
        )
        if m:
            item = {
                "description": m.group("desc").strip()[:200],
                "quantity": float(m.group("qty")),
                "unit_price": _money_to_float(m.group("unit")),
                "amount": _money_to_float(m.group("amt")),
            }
            line_items.append(item)

    return {
        "vendor": vendor,
        "invoice_date": parsed_date,
        "total": total,
        "taxes": taxes,
        "currency": None,
        "line_items": line_items,
        "confidence": {
            "vendor": 0.4 if vendor else 0.0,
            "invoice_date": 0.6 if parsed_date else 0.0,
            "total": 0.7 if total is not None else 0.0,
            "taxes": 0.6 if taxes is not None else 0.0,
            "line_items": 0.4 if line_items else 0.0,
        },
        "disclaimer": (
            "MVP heuristic extraction. Please verify results; not financial/tax advice. "
            "PDF/image OCR not included in this MVP build."
        ),
    }


LANDING_HTML = """<!doctype html>
<html>
<head>
  <meta charset=\"utf-8\" />
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />
  <title>Invoice/Receipt Parser API</title>
  <style>
    body{font-family:ui-sans-serif,system-ui,Segoe UI,Roboto,Arial; max-width:900px; margin:40px auto; padding:0 16px;}
    code,pre{background:#f6f8fa; padding:2px 6px; border-radius:6px;}
    pre{padding:12px; overflow:auto;}
    .card{border:1px solid #e5e7eb; border-radius:10px; padding:16px; margin:16px 0;}
    h1{margin-bottom:0}
    small{color:#6b7280}
  </style>
</head>
<body>
  <h1>Invoice/Receipt Parser API <small>(MVP)</small></h1>
  <p>Upload text (for now) and get structured JSON: vendor, date, total, taxes, and basic line items.</p>

  <div class=\"card\">
    <h2>Endpoints</h2>
    <ul>
      <li><code>GET /health</code> — uptime check</li>
      <li><code>POST /parse</code> — parse invoice/receipt content</li>
      <li><code>GET /docs</code> — interactive OpenAPI docs</li>
    </ul>
  </div>

  <div class=\"card\">
    <h2>Quick start</h2>
    <pre>curl -s \
  -X POST "$BASE_URL/parse" \
  -F "text=ACME Supplies\nInvoice Date: 2026-02-28\nWidget A  2  9.99  19.98\nTax: 1.60\nTotal: 21.58" | jq</pre>
  </div>

  <div class=\"card\">
    <h2>Pricing suggestion (honest + simple)</h2>
    <ul>
      <li>Free: 25 parses/month (rate-limited, best effort)</li>
      <li>Starter: $9/month for 500 parses</li>
      <li>Pro: $29/month for 3,000 parses + priority support</li>
      <li>Overage: $0.01/parse</li>
    </ul>
    <p><small>These are suggestions for a minimal paid microservice. Tune limits based on costs and support load.</small></p>
  </div>

  <div class=\"card\">
    <h2>Data handling (privacy-forward)</h2>
    <ul>
      <li>We do not store customer documents by default.</li>
      <li>We log minimal metadata for reliability: timestamp, request ID, content length, and a SHA-256 hash of the payload (to detect duplicates), not the content itself.</li>
      <li>Customers should avoid uploading sensitive data they do not want processed.</li>
    </ul>
  </div>

  <div class=\"card\">
    <h2>Contact</h2>
    <p>Email: <a href=\"mailto:founder@example.com\">founder@example.com</a> (replace with your real address)</p>
  </div>
</body>
</html>
"""


@app.get("/", response_class=HTMLResponse)
def landing_page():
    return LANDING_HTML


@app.get("/health")
def health():
    return {"status": "ok", "service": APP_NAME, "time": int(time.time())}


@app.post("/parse")
async def parse(
    text: Optional[str] = Form(default=None),
    file: Optional[UploadFile] = File(default=None),
):
    """Parse an uploaded invoice/receipt.

    MVP behavior:
    - If `text` is provided, parses it.
    - If `file` is provided, only accepts text/* content types (no PDF/image OCR in MVP).

    Privacy:
    - No document content is stored.
    - Minimal logs: request id, length, sha256.
    """

    payload: Optional[bytes] = None
    source: str = ""

    if text is not None and text.strip() != "":
        payload = text.encode("utf-8", errors="ignore")
        source = "text"
    elif file is not None:
        payload = await file.read()
        source = f"file:{file.content_type or 'unknown'}"
    else:
        return {"error": "Provide either 'text' (form field) or 'file' (multipart upload)."}

    content_type = file.content_type if file is not None else "text/plain"
    if file is not None and content_type and not content_type.startswith("text/"):
        return {
            "error": "MVP only supports text/* uploads. PDF/image OCR not enabled.",
            "received_content_type": content_type,
        }

    assert payload is not None
    req_id = _sha256_hex(os.urandom(16))[:12]
    length = len(payload)
    payload_hash = _sha256_hex(payload)

    # Minimal metadata log (stdout)
    print(
        {
            "event": "parse_request",
            "request_id": req_id,
            "source": source,
            "content_length": length,
            "payload_sha256": payload_hash,
        }
    )

    result = parse_invoice_text(payload.decode("utf-8", errors="ignore"))
    return {
        "request_id": req_id,
        "input": {"source": source, "content_length": length},
        "result": result,
    }
