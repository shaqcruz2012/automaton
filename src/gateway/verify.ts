/**
 * Off-Chain EIP-712 Signature Verification for x402 Payments
 *
 * Verifies TransferWithAuthorization signatures without making
 * any on-chain calls. Pure cryptographic verification using viem.
 */
import { verifyTypedData, type Address } from "viem";
import type { X402Payment, VerifyResult } from "./types.js";

interface VerifyOptions {
  expectedTo: Address;
  minimumAmountAtomic: bigint;
  usdcAddress: Address;
  chainId: number;
}

/** Decode a base64-encoded X-Payment header into an X402Payment object */
export function decodePaymentHeader(header: string): X402Payment | null {
  try {
    const decoded = Buffer.from(header, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded);

    if (
      typeof parsed.x402Version !== "number" ||
      typeof parsed.scheme !== "string" ||
      typeof parsed.network !== "string" ||
      !parsed.payload?.signature ||
      !parsed.payload?.authorization?.from ||
      !parsed.payload?.authorization?.to ||
      !parsed.payload?.authorization?.value ||
      !parsed.payload?.authorization?.nonce
    ) {
      return null;
    }

    return parsed as X402Payment;
  } catch {
    return null;
  }
}

/** Verify an x402 payment signature off-chain */
export async function verifyX402Signature(
  payment: X402Payment,
  options: VerifyOptions,
): Promise<VerifyResult> {
  const { authorization, signature } = payment.payload;
  const now = Math.floor(Date.now() / 1000);

  // Check timing
  const validBefore = Number(authorization.validBefore);
  const validAfter = Number(authorization.validAfter);

  if (validBefore <= now) {
    return { valid: false, error: "Payment authorization expired" };
  }
  if (validAfter > now) {
    return { valid: false, error: "Payment authorization not yet valid" };
  }

  // Check recipient
  if (authorization.to.toLowerCase() !== options.expectedTo.toLowerCase()) {
    return {
      valid: false,
      error: `Recipient mismatch: expected ${options.expectedTo}, got ${authorization.to}`,
    };
  }

  // Check amount
  const paymentAmount = BigInt(authorization.value);
  if (paymentAmount < options.minimumAmountAtomic) {
    return {
      valid: false,
      error: `Insufficient payment: got ${authorization.value} atomic, need ${options.minimumAmountAtomic}`,
    };
  }

  // Build EIP-712 typed data and verify signature
  const domain = {
    name: "USD Coin",
    version: "2",
    chainId: options.chainId,
    verifyingContract: options.usdcAddress,
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
    from: authorization.from as Address,
    to: authorization.to as Address,
    value: paymentAmount,
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
    nonce: authorization.nonce as `0x${string}`,
  };

  try {
    const valid = await verifyTypedData({
      address: authorization.from as Address,
      domain,
      types,
      primaryType: "TransferWithAuthorization",
      message,
      signature: signature as `0x${string}`,
    });

    if (!valid) {
      return { valid: false, error: "Signature verification failed" };
    }

    return {
      valid: true,
      signerAddress: authorization.from as Address,
      amountAtomic: paymentAmount,
    };
  } catch (err: any) {
    return {
      valid: false,
      error: `Signature verification error: ${err?.message || String(err)}`,
    };
  }
}
