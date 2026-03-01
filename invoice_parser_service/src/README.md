# ReceiptJSON — minimal invoice/receipt → JSON microservice (FastAPI)

Privacy-forward microservice that parses **plain text** receipts/invoices into JSON.

## Run

```bash
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

## Parse example

```bash
curl -s -X POST http://localhost:8000/parse \
  -F "text=ACME Supplies\n2026-03-01\nWidget 9.99\nTax 0.80\nTotal 10.79" | python -m json.tool
```

## Data handling

- No storage by default; processed in-memory.
- Logs minimal metadata only.
- Not legal/tax advice.

## Payments (design): x402 / USDC

Return `402 Payment Required` when out of credits; include USDC payment instructions; verify tx hash and mint credits.
