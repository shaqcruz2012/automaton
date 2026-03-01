# ReceiptJSON — minimal invoice/receipt → JSON microservice (FastAPI)

A tiny, privacy-forward API that converts **plain text** invoices/receipts into structured JSON.

- **MVP support:** text input (multipart `text` field or `.txt` upload)
- **Not included in this sandbox:** PDF parsing / OCR for images (design-ready, can be added later)

## Run

```bash
python -m venv .venv
# Windows:
#   .venv\Scripts\activate
# macOS/Linux:
#   source .venv/bin/activate

pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Open:
- Landing page: http://localhost:8000/
- Swagger docs: http://localhost:8000/docs
- Health: http://localhost:8000/health

## API usage

### Health

```bash
curl -s http://localhost:8000/health
```

### Parse (text field)

```bash
curl -s -X POST http://localhost:8000/parse \
  -F "text=ACME Supplies\n2026-03-01\nWidget 9.99\nTax 0.80\nTotal 10.79" \
  | python -m json.tool
```

### Parse (upload .txt)

```bash
printf "Coffee Shop\n03/01/2026\nLatte 4.50\nTax 0.36\nTotal 4.86\n" > sample.txt
curl -s -X POST http://localhost:8000/parse -F "file=@sample.txt" | python -m json.tool
```

## Data handling policy

- **No storage by default:** inputs are processed **in-memory** and not saved.
- **Minimal logs only:** content type, byte size, short SHA-256 prefix, and client IP.
- **No training on customer documents:** this MVP uses deterministic heuristics.

## Disclaimers

Heuristic extraction is imperfect. Always review outputs before bookkeeping/tax filing. Not legal/tax advice.

## Payment plan (design only): x402 / USDC

1. API key issuance per account.
2. Usage metering (parse count, timestamps; no raw docs).
3. If out of credits, return **HTTP 402** with payment instructions:
   - `amount_usdc`, `pay_to` (wallet), `reference`, `chain`.
4. Client pays USDC and retries with a `Payment-Receipt` header (tx hash).
5. Server verifies on-chain transfer and credits the account; prevent replay by redeeming each tx once.
