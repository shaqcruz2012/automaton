import { ulid } from "ulid";
import type {
  AutomatonDatabase,
  AutomatonIdentity,
  ChildStatus,
  ConwayClient,
} from "../types.js";
import type { AgentTracker, FundingProtocol } from "./types.js";
import { transferUSDC } from "../local/treasury.js";
import { logTransfer } from "../local/accounting.js";
import { loadWalletAccount } from "../identity/wallet.js";

const IDLE_STATUSES = new Set<ChildStatus>(["running", "healthy"]);

export class SimpleAgentTracker implements AgentTracker {
  constructor(private readonly db: AutomatonDatabase) {}

  getIdle(): { address: string; name: string; role: string; status: string }[] {
    const assignedRows = this.db.raw.prepare(
      `SELECT DISTINCT assigned_to AS address
       FROM task_graph
       WHERE assigned_to IS NOT NULL
         AND status IN ('assigned', 'running')`,
    ).all() as { address: string }[];

    const assignedAddresses = new Set(
      assignedRows
        .map((row) => row.address)
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    );

    const children = this.db.raw.prepare(
      `SELECT id, name, address, status, COALESCE(role, 'generalist') AS role
       FROM children
       WHERE status IN ('running', 'healthy')`,
    ).all() as { id: string; name: string; address: string; status: string; role: string }[];

    return children
      .filter((child) => IDLE_STATUSES.has(child.status as ChildStatus) && !assignedAddresses.has(child.address))
      .map((child) => ({
        address: child.address,
        name: child.name,
        role: child.role,
        status: child.status,
      }));
  }

  getBestForTask(_role: string): { address: string; name: string } | null {
    const idle = this.getIdle();
    if (idle.length === 0) {
      return null;
    }

    return {
      address: idle[0].address,
      name: idle[0].name,
    };
  }

  updateStatus(address: string, status: string): void {
    const child = this.db.getChildren().find((entry) => entry.address === address);
    if (!child) {
      return;
    }

    this.db.updateChildStatus(child.id, status as ChildStatus);
  }

  register(agent: { address: string; name: string; role: string; sandboxId: string }): void {
    this.db.insertChild({
      id: ulid(),
      name: agent.name,
      address: agent.address as `0x${string}`,
      sandboxId: agent.sandboxId,
      genesisPrompt: `Role: ${agent.role}`,
      creatorMessage: "registered by orchestrator",
      fundedAmountCents: 0,
      status: "running",
      createdAt: new Date().toISOString(),
    });
  }
}

export class SimpleFundingProtocol implements FundingProtocol {
  constructor(
    private readonly conway: ConwayClient,
    private readonly identity: AutomatonIdentity,
    private readonly db: AutomatonDatabase,
  ) {}

  async fundChild(childAddress: string, amountCents: number): Promise<{ success: boolean }> {
    const transferAmount = Math.max(0, Math.floor(amountCents));
    if (transferAmount === 0) {
      return { success: true };
    }

    try {
      // Phase 4: Use on-chain USDC transfer instead of Conway credits
      const account = loadWalletAccount();
      if (!account) {
        return { success: false };
      }
      const result = await transferUSDC(
        account,
        childAddress as `0x${string}`,
        transferAmount / 100,
      );

      if (result.success) {
        logTransfer(this.db.raw, {
          toAddress: childAddress,
          amountCents: transferAmount,
          description: "Task funding from orchestrator",
          txHash: result.txHash,
        });
        this.db.raw.prepare(
          "UPDATE children SET funded_amount_cents = funded_amount_cents + ? WHERE address = ?",
        ).run(transferAmount, childAddress);
      }

      return { success: result.success };
    } catch {
      return { success: false };
    }
  }

  async recallCredits(childAddress: string): Promise<{ success: boolean; amountCents: number }> {
    // Phase 4: On-chain USDC transfers are one-way from parent to child.
    // Child agents must send USDC back via their own wallet. We can only
    // track locally what was funded and mark it as recalled.
    const balance = await this.getBalance(childAddress);
    const amountCents = Math.max(0, Math.floor(balance));

    if (amountCents === 0) {
      return { success: true, amountCents: 0 };
    }

    // Mark as recalled locally (child must send funds back independently)
    this.db.raw.prepare(
      "UPDATE children SET funded_amount_cents = MAX(0, funded_amount_cents - ?) WHERE address = ?",
    ).run(amountCents, childAddress);

    return { success: true, amountCents };
  }

  // Phase 4: Child agent USDC balances can be queried on-chain, but for now
  // we track the locally funded amount as an estimate. The child may have spent
  // USDC on inference. Child agents could report their balance via messaging.
  async getBalance(childAddress: string): Promise<number> {
    const row = this.db.raw
      .prepare("SELECT funded_amount_cents FROM children WHERE address = ?")
      .get(childAddress) as { funded_amount_cents: number } | undefined;

    return row?.funded_amount_cents ?? 0;
  }
}

function isTransferSuccessful(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return normalized.length > 0
    && !normalized.includes("fail")
    && !normalized.includes("error")
    && !normalized.includes("reject");
}
