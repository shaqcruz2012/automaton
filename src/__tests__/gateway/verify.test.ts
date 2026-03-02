import { describe, it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { decodePaymentHeader, verifyX402Signature } from "../../gateway/verify.js";

// Test account (hardhat default #0, NOT a real wallet)
const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const testAccount = privateKeyToAccount(TEST_PRIVATE_KEY);

const DATCHI_WALLET: Address = "0xad045ca2979269Bb7471DC9750BfFeaa24E8A706";
const USDC_ADDRESS: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

async function createTestPayment(
  amount: string = "250000",
  to: Address = DATCHI_WALLET,
): Promise<string> {
  const nonce = `0x${Buffer.from(
    crypto.getRandomValues(new Uint8Array(32)),
  ).toString("hex")}` as `0x${string}`;

  const now = Math.floor(Date.now() / 1000);

  const domain = {
    name: "USD Coin",
    version: "2",
    chainId: 8453,
    verifyingContract: USDC_ADDRESS,
  } as const;

  const types = {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  } as const;

  const message = {
    from: testAccount.address,
    to,
    value: BigInt(amount),
    validAfter: BigInt(now - 60),
    validBefore: BigInt(now + 300),
    nonce,
  };

  const signature = await testAccount.signTypedData({
    domain,
    types,
    primaryType: "TransferWithAuthorization",
    message,
  });

  const payload = {
    x402Version: 1,
    scheme: "exact",
    network: "eip155:8453",
    payload: {
      signature,
      authorization: {
        from: testAccount.address,
        to,
        value: amount,
        validAfter: String(now - 60),
        validBefore: String(now + 300),
        nonce,
      },
    },
  };

  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

describe("decodePaymentHeader", () => {
  it("decodes a valid base64 X-Payment header", async () => {
    const header = await createTestPayment();
    const result = decodePaymentHeader(header);
    expect(result).not.toBeNull();
    expect(result!.x402Version).toBe(1);
    expect(result!.payload.authorization.from).toBe(testAccount.address);
  });

  it("returns null for invalid base64", () => {
    expect(decodePaymentHeader("not-valid-base64!!!")).toBeNull();
  });

  it("returns null for missing payload fields", () => {
    const bad = Buffer.from(JSON.stringify({ x402Version: 1 })).toString("base64");
    expect(decodePaymentHeader(bad)).toBeNull();
  });
});

describe("verifyX402Signature", () => {
  it("verifies a valid signed payment", async () => {
    const header = await createTestPayment("250000", DATCHI_WALLET);
    const payment = decodePaymentHeader(header)!;
    const result = await verifyX402Signature(payment, {
      expectedTo: DATCHI_WALLET,
      minimumAmountAtomic: BigInt("250000"),
      usdcAddress: USDC_ADDRESS,
      chainId: 8453,
    });
    expect(result.valid).toBe(true);
    expect(result.signerAddress?.toLowerCase()).toBe(testAccount.address.toLowerCase());
  });

  it("rejects when amount is too low", async () => {
    const header = await createTestPayment("100000", DATCHI_WALLET);
    const payment = decodePaymentHeader(header)!;
    const result = await verifyX402Signature(payment, {
      expectedTo: DATCHI_WALLET,
      minimumAmountAtomic: BigInt("250000"),
      usdcAddress: USDC_ADDRESS,
      chainId: 8453,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Insufficient");
  });

  it("rejects when 'to' address doesn't match", async () => {
    const wrongTo: Address = "0x0000000000000000000000000000000000000001";
    const header = await createTestPayment("250000", wrongTo);
    const payment = decodePaymentHeader(header)!;
    const result = await verifyX402Signature(payment, {
      expectedTo: DATCHI_WALLET,
      minimumAmountAtomic: BigInt("250000"),
      usdcAddress: USDC_ADDRESS,
      chainId: 8453,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Recipient mismatch");
  });

  it("rejects an expired authorization", async () => {
    const nonce = `0x${Buffer.from(
      crypto.getRandomValues(new Uint8Array(32)),
    ).toString("hex")}` as `0x${string}`;
    const pastTime = Math.floor(Date.now() / 1000) - 600;

    const domain = {
      name: "USD Coin", version: "2", chainId: 8453,
      verifyingContract: USDC_ADDRESS,
    } as const;
    const types = {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    } as const;

    const signature = await testAccount.signTypedData({
      domain, types, primaryType: "TransferWithAuthorization",
      message: {
        from: testAccount.address, to: DATCHI_WALLET,
        value: BigInt("250000"),
        validAfter: BigInt(pastTime - 300),
        validBefore: BigInt(pastTime),
        nonce,
      },
    });

    const payment = {
      x402Version: 1, scheme: "exact", network: "eip155:8453",
      payload: {
        signature,
        authorization: {
          from: testAccount.address, to: DATCHI_WALLET,
          value: "250000",
          validAfter: String(pastTime - 300),
          validBefore: String(pastTime),
          nonce,
        },
      },
    };

    const result = await verifyX402Signature(payment as any, {
      expectedTo: DATCHI_WALLET,
      minimumAmountAtomic: BigInt("250000"),
      usdcAddress: USDC_ADDRESS,
      chainId: 8453,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("expired");
  });
});
