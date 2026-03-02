/**
 * Smoke test: x402 gateway end-to-end payment flow
 */
import { privateKeyToAccount } from "viem/accounts";
import http from "http";
import type { Address } from "viem";

// Hardhat test key #0 (simulating a customer, NOT Datchi's wallet)
const testKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const customer = privateKeyToAccount(testKey as `0x${string}`);
const DATCHI: Address = "0xad045ca2979269Bb7471DC9750BfFeaa24E8A706";
const USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function httpReq(
  method: string, path: string, body: string, headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: 7402, path, method, headers: { "Content-Type": "application/json", ...headers } },
      (res) => { let d = ""; res.on("data", c => (d += c)); res.on("end", () => resolve({ status: res.statusCode!, body: d })); },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function signPayment(amount: string, to: Address): Promise<string> {
  const nonce = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}` as `0x${string}`;
  const now = Math.floor(Date.now() / 1000);

  const sig = await customer.signTypedData({
    domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" }, { name: "to", type: "address" },
        { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: customer.address, to,
      value: BigInt(amount),
      validAfter: BigInt(now - 60), validBefore: BigInt(now + 300),
      nonce,
    },
  });

  return Buffer.from(JSON.stringify({
    x402Version: 1, scheme: "exact", network: "eip155:8453",
    payload: {
      signature: sig,
      authorization: { from: customer.address, to, value: amount, validAfter: String(now - 60), validBefore: String(now + 300), nonce },
    },
  })).toString("base64");
}

async function main() {
  console.log("=== x402 Gateway Smoke Test ===\n");
  console.log(`Customer: ${customer.address}`);
  console.log(`Datchi:   ${DATCHI}\n`);

  // Test 1: Free endpoints
  console.log("--- Test 1: GET /health ---");
  const health = await httpReq("GET", "/health", "");
  console.log(`  Status: ${health.status} ${health.status === 200 ? "PASS" : "FAIL"}`);

  console.log("\n--- Test 2: GET /pricing ---");
  const pricing = await httpReq("GET", "/pricing", "");
  const p = JSON.parse(pricing.body);
  console.log(`  Status: ${pricing.status} | Tiers: ${Object.keys(p.tiers).length} ${pricing.status === 200 ? "PASS" : "FAIL"}`);

  // Test 3: 402 without payment
  console.log("\n--- Test 3: POST /analyze (no payment) ---");
  const noPay = await httpReq("POST", "/analyze", JSON.stringify({ content: "test" }));
  const noPayBody = JSON.parse(noPay.body);
  console.log(`  Status: ${noPay.status} | x402v${noPayBody.x402Version} | Amount: ${noPayBody.accepts?.[0]?.maxAmountRequired} atomic ${noPay.status === 402 ? "PASS" : "FAIL"}`);

  // Test 4: Paid request
  console.log("\n--- Test 4: POST /analyze (with $0.01 payment) ---");
  const payment = await signPayment("10000", DATCHI);
  const paid = await httpReq("POST", "/analyze", JSON.stringify({ content: "Analyze this text for sentiment." }), { "X-Payment": payment });
  console.log(`  Status: ${paid.status} ${paid.status === 200 ? "PASS" : "FAIL"}`);
  try { console.log(`  Response: ${JSON.stringify(JSON.parse(paid.body)).slice(0, 120)}...`); } catch { console.log(`  Response: ${paid.body.slice(0, 120)}`); }

  // Test 5: Replay (same payment header)
  console.log("\n--- Test 5: POST /analyze (replay same nonce) ---");
  const replay = await httpReq("POST", "/analyze", JSON.stringify({ content: "replay" }), { "X-Payment": payment });
  const replayBody = JSON.parse(replay.body);
  console.log(`  Status: ${replay.status} | Blocked: ${replayBody.error?.includes("already used") ? "YES" : "NO"} ${replay.status === 402 ? "PASS" : "FAIL"}`);

  // Test 6: Different paid endpoint (trustcheck expects { domain: "..." })
  console.log("\n--- Test 6: POST /trustcheck (with $0.05 payment) ---");
  const tcPayment = await signPayment("50000", DATCHI);
  const tc = await httpReq("POST", "/trustcheck", JSON.stringify({ domain: "example.com" }), { "X-Payment": tcPayment });
  console.log(`  Status: ${tc.status} ${tc.status === 200 ? "PASS" : "FAIL"}`);
  try { console.log(`  Response: ${JSON.stringify(JSON.parse(tc.body)).slice(0, 120)}...`); } catch { console.log(`  Response: ${tc.body.slice(0, 120)}`); }

  // Test 7: 404
  console.log("\n--- Test 7: GET /nonexistent ---");
  const notFound = await httpReq("GET", "/nonexistent", "");
  console.log(`  Status: ${notFound.status} ${notFound.status === 404 ? "PASS" : "FAIL"}`);

  console.log("\n=== Smoke Test Complete ===");
}

main().catch(console.error);
