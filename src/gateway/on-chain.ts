/**
 * Async On-Chain Execution
 *
 * Executes TransferWithAuthorization on the USDC contract
 * on Base to collect payment after the response is sent.
 *
 * This is fire-and-forget from the customer's perspective.
 * Success/failure is logged via nonce tracking.
 */
import {
  createWalletClient,
  http,
  encodeFunctionData,
  type Address,
  type PrivateKeyAccount,
} from "viem";
import { base } from "viem/chains";
import { markNonceExecuted, markNonceFailed } from "./nonces.js";
import { logRevenue } from "../local/accounting.js";
import type BetterSqlite3 from "better-sqlite3";

type Database = BetterSqlite3.Database;

const USDC_ADDRESS: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const TRANSFER_WITH_AUTH_ABI = [
  {
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    name: "transferWithAuthorization",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

interface AuthorizationParams {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
  signature: string;
}

/** Split a 65-byte signature into v, r, s components */
function splitSignature(sig: string): { v: number; r: `0x${string}`; s: `0x${string}` } {
  const raw = sig.startsWith("0x") ? sig.slice(2) : sig;
  const r = `0x${raw.slice(0, 64)}` as `0x${string}`;
  const s = `0x${raw.slice(64, 128)}` as `0x${string}`;
  const v = parseInt(raw.slice(128, 130), 16);
  return { v, r, s };
}

/** Build the calldata for transferWithAuthorization (for testing) */
export function buildTransferWithAuthTx(params: AuthorizationParams): `0x${string}` {
  const { v, r, s } = splitSignature(params.signature);

  return encodeFunctionData({
    abi: TRANSFER_WITH_AUTH_ABI,
    functionName: "transferWithAuthorization",
    args: [
      params.from as Address,
      params.to as Address,
      BigInt(params.value),
      BigInt(params.validAfter),
      BigInt(params.validBefore),
      params.nonce as `0x${string}`,
      v,
      r,
      s,
    ],
  });
}

function getRpcUrl(): string {
  return process.env.BASE_RPC_URL || "https://mainnet.base.org";
}

/**
 * Execute TransferWithAuthorization on-chain.
 * Fire-and-forget: logs result to nonce table.
 */
export async function executeTransferOnChain(
  account: PrivateKeyAccount,
  db: Database,
  params: AuthorizationParams & { tier: string; amountCents: number },
): Promise<void> {
  try {
    const calldata = buildTransferWithAuthTx(params);

    const client = createWalletClient({
      account,
      chain: base,
      transport: http(getRpcUrl(), { timeout: 30_000 }),
    });

    const txHash = await client.sendTransaction({
      to: USDC_ADDRESS,
      data: calldata,
    });

    // Mark nonce as executed
    markNonceExecuted(db, params.nonce, txHash);

    // Log revenue
    logRevenue(db, {
      source: `gateway:${params.tier}`,
      amountCents: params.amountCents,
      description: `x402 payment for ${params.tier}`,
      metadata: {
        fromAddr: params.from,
        txHash,
        nonce: params.nonce,
      },
    });
  } catch (err: any) {
    markNonceFailed(db, params.nonce, err?.message || String(err));
  }
}
