import hashlib
import re
from datetime import date
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

APP_NAME = "ReceiptJSON"

app = FastAPI(
    title=f"{APP_NAME} API",
    description=(
        "Minimal invoice/receipt parsing API. MVP supports plain text parsing; "
        "PDF/image OCR is not enabled by default in this sandbox."
    ),
    version="0.1.0",
)

app.mount("/static", StaticFiles(directory="src/app/static"), name="static")
templates = Jinja2Templates(directory="src/app/templates")


def _sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _safe_float(s: str) -> Optional[float]:
    try:
        return float(s)
    except Exception:
        return None


def parse_receipt_text(text: str) -> Dict[str, Any]:
    raw = text.strip()
    lines = [ln.strip() for ln in raw.splitlines() if ln.strip()]

    vendor = lines[0][:120] if lines else None

    date_patterns = [
        r"\b(\d{4}[-/]\d{2}[-/]\d{2})\b",
        r"\b(\d{2}[-/]\d{2}[-/]\d{4})\b",
        r"\b(\d{1,2} [A-Za-z]{3,9} \d{4})\b",
    ]
    found_date: Optional[str] = None
    for pat in date_patterns:
        m = re.search(pat, raw)
        if m:
            found_date = m.group(1)
            break

    money_re = re.compile(
        r"(?i)(?:\$|usd\s*)?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[0-9]+(?:\.[0-9]{2}))"
    )

    def find_labeled_amount(labels: List[str]) -> Optional[float]:
        for label in labels:
            m = re.search(
                rf"(?i)\b{re.escape(label)}\b\s*[:\-]?\s*(?:\$|usd\s*)?\s*([0-9][0-9,]*\.[0-9]{{2}})",
                raw,
            )
            if m:
                return _safe_float(m.group(1).replace(",", ""))
        return None

    total = find_labeled_amount(["total", "amount due", "balance due", "grand total"])
    taxes = find_labeled_amount(["tax", "vat", "gst", "sales tax"])
    subtotal = find_labeled_amount(["subtotal", "sub total"])

    if total is None:
        amounts = [_safe_float(x.replace(",", "")) for x in money_re.findall(raw)]
        amounts = [a for a in amounts if a is not None]
        total = max(amounts) if amounts else None

    line_items: List[Dict[str, Any]] = []
    price_at_end = re.compile(r"^(?P<desc>.+?)\s+(?P<amt>[0-9][0-9,]*\.[0-9]{2})$")
    qty_price = re.compile(r"^(?P<qty>\d+(?:\.\d+)?)\s+x\s+(?P<unit>[0-9][0-9,]*\.[0-9]{2})\s+(?P<desc>.+)$", re.I)

    for ln in lines[1:40]:
        m2 = qty_price.match(ln)
        if m2:
            qty = _safe_float(m2.group("qty"))
            unit = _safe_float(m2.group("unit").replace(",", ""))
            desc = m2.group("desc")[:200]
            amount = (qty * unit) if (qty is not None and unit is not None) else None
            line_items.append({"description": desc, "quantity": qty, "unit_price": unit, "amount": amount})
            continue

        m1 = price_at_end.match(ln)
        if m1 and not re.search(r"(?i)\b(total|subtotal|tax|vat|gst)\b", ln):
            amt = _safe_float(m1.group("amt").replace(",", ""))
            if amt is not None:
                line_items.append({"description": m1.group("desc")[:200], "quantity": None, "unit_price": None, "amount": amt})

    currency = "USD" if re.search(r"(?i)\bUSD\b|\$", raw) else None

    return {
        "vendor": vendor,
        "invoice_date": found_date,
        "currency": currency,
        "subtotal": subtotal,
        "taxes": taxes,
        "total": total,
        "line_items": line_items[:50],
        "confidence": {
            "vendor": 0.6 if vendor else 0.0,
            "invoice_date": 0.7 if found_date else 0.0,
            "total": 0.7 if total is not None else 0.0,
            "line_items": 0.5 if line_items else 0.0,
        },
        "disclaimer": "Heuristic extraction only. Verify totals, tax treatment, and dates before accounting/tax use.",
    }


@app.get("/health")
def health() -> Dict[str, Any]:
    return {"status": "ok", "service": APP_NAME, "version": app.version, "date": str(date.today())}


@app.get("/", response_class=HTMLResponse)
def landing(request: Request):
    return templates.TemplateResponse("index.html", {"request": request, "app_name": APP_NAME})


@app.post("/parse")
async def parse(request: Request, text: Optional[str] = Form(default=None), file: Optional[UploadFile] = File(default=None)) -> JSONResponse:
    content: Optional[str] = None
    content_type = None
    size_bytes = None
    sha256_12 = None

    if text:
        content = text
        content_type = "text/plain"
        size_bytes = len(text.encode("utf-8"))
        sha256_12 = _sha256_bytes(text.encode("utf-8"))[:12]
    elif file is not None:
        content_type = file.content_type
        b = await file.read()
        size_bytes = len(b)
        sha256_12 = _sha256_bytes(b)[:12]
        if (file.filename or "").lower().endswith(".txt") or (content_type or "").startswith("text/"):
            content = b.decode("utf-8", errors="replace")
        else:
            return JSONResponse(
                status_code=415,
                content={
                    "error": "unsupported_media_type",
                    "message": "MVP supports text input only. Provide `text` or upload a .txt/text/* file.",
                    "received_content_type": content_type,
                },
            )
    else:
        return JSONResponse(status_code=400, content={"error": "missing_input", "message": "Provide `text` or `file`."})

    # minimal metadata log (no raw content)
    client_host = getattr(request.client, "host", None)
    print({"event": "parse_request", "client_host": client_host, "content_type": content_type, "size_bytes": size_bytes, "sha256_12": sha256_12})

    return JSONResponse({"input": {"content_type": content_type, "size_bytes": size_bytes}, "parsed": parse_receipt_text(content or "")})
