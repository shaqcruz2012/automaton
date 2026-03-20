/**
 * Paperclip Client
 *
 * Integrates with a Paperclip control plane (https://github.com/paperclipai/paperclip)
 * to hire, manage, and delegate tasks to AI agents running on a Paperclip deployment.
 *
 * This enables the chief-of-staff to spin up specialized agents (Claude, Codex, Cursor, etc.)
 * through Paperclip's multi-agent orchestration system for complex, long-running tasks.
 */

import { createLogger } from "../observability/logger.js";

const logger = createLogger("paperclip.client");

const DEFAULT_TIMEOUT_MS = 30_000;

export interface PaperclipConfig {
  /** Base URL of the Paperclip server (e.g., http://localhost:3000) */
  baseUrl: string;
  /** API key for authentication */
  apiKey: string;
  /** Default company ID to operate within */
  companyId: string;
}

export interface PaperclipAgent {
  id: string;
  name: string;
  role: string;
  title?: string;
  status: string;
  adapterType: string;
  capabilities?: string;
  reportsTo?: string;
  monthlyBudgetCents?: number;
}

export interface PaperclipTask {
  id: string;
  title: string;
  description?: string;
  status: string;
  assigneeId?: string;
  priority?: string;
  createdAt: string;
  updatedAt: string;
}

export interface HireAgentParams {
  name: string;
  role: string;
  title?: string;
  capabilities?: string;
  adapterType?: string;
  adapterConfig?: Record<string, unknown>;
  reportsTo?: string;
  monthlyBudgetCents?: number;
}

export interface CreateTaskParams {
  title: string;
  description: string;
  assigneeId?: string;
  priority?: string;
  labels?: string[];
}

interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
  status: number;
}

export class PaperclipClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly companyId: string;

  constructor(config: PaperclipConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.companyId = config.companyId;
    logger.info("Paperclip client initialized", { baseUrl: this.baseUrl, companyId: this.companyId });
  }

  /**
   * List all agents in the company.
   */
  async listAgents(): Promise<ApiResponse<PaperclipAgent[]>> {
    return this.request<PaperclipAgent[]>("GET", `/api/companies/${this.companyId}/agents`);
  }

  /**
   * Hire (create) a new agent in the company.
   */
  async hireAgent(params: HireAgentParams): Promise<ApiResponse<PaperclipAgent>> {
    return this.request<PaperclipAgent>("POST", `/api/companies/${this.companyId}/agent-hires`, {
      name: params.name,
      role: params.role,
      title: params.title ?? params.role,
      capabilities: params.capabilities ?? "",
      adapterType: params.adapterType ?? "process",
      adapterConfig: params.adapterConfig ?? {},
      reportsTo: params.reportsTo,
      monthlyBudgetCents: params.monthlyBudgetCents ?? 1000,
    });
  }

  /**
   * Get an agent's details.
   */
  async getAgent(agentId: string): Promise<ApiResponse<PaperclipAgent>> {
    return this.request<PaperclipAgent>("GET", `/api/companies/${this.companyId}/agents/${agentId}`);
  }

  /**
   * List tasks, optionally filtered by assignee or status.
   */
  async listTasks(filters?: { assigneeId?: string; status?: string }): Promise<ApiResponse<PaperclipTask[]>> {
    const params = new URLSearchParams();
    if (filters?.assigneeId) params.set("assigneeId", filters.assigneeId);
    if (filters?.status) params.set("status", filters.status);
    const query = params.toString();
    const path = `/api/companies/${this.companyId}/tasks${query ? `?${query}` : ""}`;
    return this.request<PaperclipTask[]>("GET", path);
  }

  /**
   * Create a new task and optionally assign it to an agent.
   */
  async createTask(params: CreateTaskParams): Promise<ApiResponse<PaperclipTask>> {
    return this.request<PaperclipTask>("POST", `/api/companies/${this.companyId}/tasks`, params);
  }

  /**
   * Assign a task to an agent.
   */
  async assignTask(taskId: string, agentId: string): Promise<ApiResponse<PaperclipTask>> {
    return this.request<PaperclipTask>(
      "PATCH",
      `/api/companies/${this.companyId}/tasks/${taskId}`,
      { assigneeId: agentId },
    );
  }

  /**
   * Get task details including status and results.
   */
  async getTask(taskId: string): Promise<ApiResponse<PaperclipTask>> {
    return this.request<PaperclipTask>("GET", `/api/companies/${this.companyId}/tasks/${taskId}`);
  }

  /**
   * Trigger an agent's heartbeat (wake it up to process tasks).
   */
  async wakeAgent(agentId: string): Promise<ApiResponse<{ queued: boolean }>> {
    return this.request<{ queued: boolean }>(
      "POST",
      `/api/companies/${this.companyId}/agents/${agentId}/wakeup`,
    );
  }

  /**
   * Check if the Paperclip server is reachable.
   */
  async ping(): Promise<boolean> {
    try {
      const res = await this.request<unknown>("GET", "/api/health");
      return res.ok;
    } catch {
      return false;
    }
  }

  // ─── Private ────────────────────────────────────────────────

  private async request<T>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
      const headers: Record<string, string> = {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      };

      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const status = response.status;

      if (!response.ok) {
        let errorText: string;
        try {
          const errorBody = await response.json() as { error?: string; message?: string };
          errorText = errorBody.error ?? errorBody.message ?? `HTTP ${status}`;
        } catch {
          errorText = `HTTP ${status}`;
        }
        logger.warn("Paperclip API error", { method, path, status, error: errorText });
        return { ok: false, error: errorText, status };
      }

      const data = await response.json() as T;
      return { ok: true, data, status };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error("Paperclip API request failed", error instanceof Error ? error : new Error(msg), { method, path });
      return { ok: false, error: msg, status: 0 };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Create a Paperclip client if config is available.
 * Returns null if Paperclip is not configured.
 */
export function createPaperclipClient(config: {
  paperclipUrl?: string;
  paperclipApiKey?: string;
  paperclipCompanyId?: string;
}): PaperclipClient | null {
  if (!config.paperclipUrl || !config.paperclipApiKey || !config.paperclipCompanyId) {
    return null;
  }

  return new PaperclipClient({
    baseUrl: config.paperclipUrl,
    apiKey: config.paperclipApiKey,
    companyId: config.paperclipCompanyId,
  });
}
