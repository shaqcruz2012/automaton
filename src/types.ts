/**
 * Conway Automaton - Type Definitions
 *
 * All shared interfaces for the sovereign AI agent runtime.
 */

import type { PrivateKeyAccount, Address } from "viem";

// ─── Identity ────────────────────────────────────────────────────

export interface AutomatonIdentity {
  readonly name: string;
  readonly address: Address;
  readonly account: PrivateKeyAccount;
  readonly creatorAddress: Address;
  readonly sandboxId: string;
  readonly apiKey: string;
  readonly createdAt: string;
}

export interface WalletData {
  readonly privateKey: `0x${string}`;
  readonly createdAt: string;
}

export interface ProvisionResult {
  readonly apiKey: string;
  readonly walletAddress: string;
  readonly keyPrefix: string;
}

// ─── Configuration ───────────────────────────────────────────────

export interface AutomatonConfig {
  name: string;
  genesisPrompt: string;
  creatorMessage?: string;
  creatorAddress: Address;
  registeredWithConway: boolean;
  sandboxId: string;
  conwayApiUrl: string;
  conwayApiKey: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  groqApiKey?: string;
  ollamaBaseUrl?: string;
  inferenceModel: string;
  maxTokensPerTurn: number;
  heartbeatConfigPath: string;
  dbPath: string;
  logLevel: "debug" | "info" | "warn" | "error";
  walletAddress: Address;
  version: string;
  skillsDir: string;
  agentId?: string;
  maxChildren: number;
  maxTurnsPerCycle?: number;
  /** Child sandbox memory config (MB), default 1024 */
  childSandboxMemoryMb?: number;
  parentAddress?: Address;
  socialRelayUrl?: string;
  treasuryPolicy?: TreasuryPolicy;
  // Phase 2 config additions
  soulConfig?: SoulConfig;
  modelStrategy?: ModelStrategyConfig;
  /** Creator tax: auto-transfer a % of credits to creator at milestones */
  creatorTax?: CreatorTaxConfig;
  /** Perplexity AI API key for web search (market research, niche discovery) */
  perplexityApiKey?: string;
  cerebrasApiKey?: string;
  sambanovaApiKey?: string;
  togetherApiKey?: string;
  hfApiKey?: string;
  mistralApiKey?: string;
}

export interface CreatorTaxConfig {
  /** Whether creator tax is enabled (default: false) */
  enabled: boolean;
  /** Percentage of credits above threshold to transfer (0-100, default: 20) */
  taxRate: number;
  /** Credit balance in cents that must be exceeded before tax applies (default: 1000 = $10) */
  thresholdCents: number;
  /** Minimum transfer amount in cents to avoid tiny transfers (default: 100 = $1) */
  minTransferCents: number;
  /** Cooldown between tax transfers in ms (default: 3600000 = 1 hour) */
  cooldownMs: number;
}

export const DEFAULT_CONFIG: Partial<AutomatonConfig> = {
  conwayApiUrl: "",
  inferenceModel: "claude-haiku-4-5-20251001",
  maxTokensPerTurn: 4096,
  heartbeatConfigPath: "~/.automaton/heartbeat.yml",
  dbPath: "~/.automaton/state.db",
  logLevel: "info",
  version: "0.2.1",
  skillsDir: "~/.automaton/skills",
  maxChildren: 6,
  maxTurnsPerCycle: 25,
  childSandboxMemoryMb: 1024,
  socialRelayUrl: undefined,
};

// ─── Agent State ─────────────────────────────────────────────────

export type AgentState =
  | "setup"
  | "waking"
  | "running"
  | "sleeping"
  | "low_compute"
  | "critical"
  | "dead";

export interface AgentTurn {
  id: string;
  timestamp: string;
  state: AgentState;
  input?: string;
  inputSource?: InputSource;
  thinking: string;
  toolCalls: ToolCallResult[];
  tokenUsage: TokenUsage;
  costCents: number;
}

export type InputSource =
  | "heartbeat"
  | "creator"
  | "agent"
  | "system"
  | "wakeup";

export interface ToolCallResult {
  id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly result: string;
  readonly durationMs: number;
  readonly error?: string;
}

export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

// ─── Tool System ─────────────────────────────────────────────────

export interface AutomatonTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    args: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<string>;
  riskLevel: RiskLevel;
  category: ToolCategory;
}

export type ToolCategory =
  | "vm"
  | "conway"
  | "self_mod"
  | "financial"
  | "survival"
  | "skills"
  | "git"
  | "registry"
  | "replication"
  | "memory";

export interface ToolContext {
  readonly identity: AutomatonIdentity;
  readonly config: AutomatonConfig;
  readonly db: AutomatonDatabase;
  readonly conway: ConwayClient;
  readonly inference: InferenceClient;
  readonly social?: SocialClientInterface;
}

export interface SocialClientInterface {
  send(to: string, content: string, replyTo?: string): Promise<{ id: string }>;
  poll(cursor?: string, limit?: number): Promise<{ messages: InboxMessage[]; nextCursor?: string }>;
  unreadCount(): Promise<number>;
}

export interface InboxMessage {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly content: string;
  readonly signedAt: string;
  readonly createdAt: string;
  readonly replyTo?: string;
}

// ─── Heartbeat ───────────────────────────────────────────────────

export interface HeartbeatEntry {
  name: string;
  schedule: string;
  task: string;
  enabled: boolean;
  lastRun?: string;
  nextRun?: string;
  params?: Record<string, unknown>;
}

export interface HeartbeatConfig {
  entries: HeartbeatEntry[];
  defaultIntervalMs: number;
  lowComputeMultiplier: number;
}

export interface HeartbeatPingPayload {
  readonly name: string;
  readonly address: Address;
  readonly state: AgentState;
  readonly creditsCents: number;
  readonly usdcBalance: number;
  readonly uptimeSeconds: number;
  readonly version: string;
  readonly sandboxId: string;
  readonly timestamp: string;
}

// ─── Financial ───────────────────────────────────────────────────

export interface FinancialState {
  creditsCents: number;
  usdcBalance: number;
  lastChecked: string;
}

export type SurvivalTier = "dead" | "critical" | "low_compute" | "normal" | "high";

export const SURVIVAL_THRESHOLDS = {
  high: 2000, // > $20.00 in cents
  normal: 500, // > $5.00 in cents
  low_compute: 100, // $1.00 - $5.00
  critical: 10, // $0.10 - $1.00
  dead: -1, // negative balance = truly dead
} as const;

export interface Transaction {
  readonly id: string;
  readonly type: TransactionType;
  readonly amountCents?: number;
  readonly balanceAfterCents?: number;
  readonly description: string;
  readonly timestamp: string;
}

export type TransactionType =
  | "credit_check"
  | "credit_purchase"
  | "inference"
  | "tool_use"
  | "transfer_in"
  | "transfer_out"
  | "funding_request";

// ─── Self-Modification ───────────────────────────────────────────

export interface ModificationEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly type: ModificationType;
  readonly description: string;
  readonly filePath?: string;
  readonly diff?: string;
  readonly reversible: boolean;
}

export type ModificationType =
  | "code_edit"
  | "code_revert"
  | "tool_install"
  | "mcp_install"
  | "config_change"
  | "port_expose"
  | "vm_deploy"
  | "heartbeat_change"
  | "prompt_change"
  | "skill_install"
  | "skill_remove"
  | "soul_update"
  | "registry_update"
  | "child_spawn"
  | "upstream_pull"
  | "upstream_reset";

// ─── Injection Defense ───────────────────────────────────────────

export type ThreatLevel = "low" | "medium" | "high" | "critical";

export type SanitizationMode =
  | "social_message"      // Full injection defense
  | "social_address"      // Alphanumeric + 0x prefix only
  | "tool_result"         // Strip prompt boundaries, limit size
  | "skill_instruction";  // Strip tool call syntax, add framing

export interface SanitizedInput {
  readonly content: string;
  readonly blocked: boolean;
  readonly threatLevel: ThreatLevel;
  readonly checks: InjectionCheck[];
}

export interface InjectionCheck {
  readonly name: string;
  readonly detected: boolean;
  readonly details?: string;
}

// ─── Inference ───────────────────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_calls?: InferenceToolCall[];
  tool_call_id?: string;
}

export interface InferenceToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

export interface InferenceResponse {
  readonly id: string;
  readonly model: string;
  readonly message: ChatMessage;
  readonly toolCalls?: InferenceToolCall[];
  readonly usage: TokenUsage;
  readonly finishReason: string;
}

export interface InferenceOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  tools?: InferenceToolDefinition[];
  stream?: boolean;
}

export interface InferenceToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

// ─── Conway Client ───────────────────────────────────────────────

export interface ConwayClient {
  exec(command: string, timeout?: number): Promise<ExecResult>;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
  exposePort(port: number): Promise<PortInfo>;
  removePort(port: number): Promise<void>;
  createSandbox(options: CreateSandboxOptions): Promise<SandboxInfo>;
  deleteSandbox(sandboxId: string): Promise<void>;
  listSandboxes(): Promise<SandboxInfo[]>;
  getCreditsBalance(): Promise<number>;
  getCreditsPricing(): Promise<PricingTier[]>;
  transferCredits(
    toAddress: string,
    amountCents: number,
    note?: string,
  ): Promise<CreditTransferResult>;
  registerAutomaton(params: {
    automatonId: string;
    automatonAddress: Address;
    creatorAddress: Address;
    name: string;
    bio?: string;
    genesisPromptHash?: `0x${string}`;
    account: PrivateKeyAccount;
    nonce?: string;
  }): Promise<{ automaton: Record<string, unknown> }>;
  // Domain operations
  searchDomains(query: string, tlds?: string): Promise<DomainSearchResult[]>;
  registerDomain(domain: string, years?: number): Promise<DomainRegistration>;
  listDnsRecords(domain: string): Promise<DnsRecord[]>;
  addDnsRecord(
    domain: string,
    type: string,
    host: string,
    value: string,
    ttl?: number,
  ): Promise<DnsRecord>;
  deleteDnsRecord(domain: string, recordId: string): Promise<void>;
  // Model discovery
  listModels(): Promise<ModelInfo[]>;
  /** Create a new client scoped to a specific sandbox ID. */
  createScopedClient(targetSandboxId: string): ConwayClient;
}

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface PortInfo {
  readonly port: number;
  readonly publicUrl: string;
  readonly sandboxId: string;
}

export interface CreateSandboxOptions {
  name?: string;
  vcpu?: number;
  memoryMb?: number;
  diskGb?: number;
  region?: string;
}

export interface SandboxInfo {
  readonly id: string;
  readonly status: string;
  readonly region: string;
  readonly vcpu: number;
  readonly memoryMb: number;
  readonly diskGb: number;
  readonly terminalUrl?: string;
  readonly createdAt: string;
}

export interface PricingTier {
  readonly name: string;
  readonly vcpu: number;
  readonly memoryMb: number;
  readonly diskGb: number;
  readonly monthlyCents: number;
}

export interface CreditTransferResult {
  readonly transferId: string;
  readonly status: string;
  readonly toAddress: string;
  readonly amountCents: number;
  readonly balanceAfterCents?: number;
}

// ─── Domains ──────────────────────────────────────────────────────

export interface DomainSearchResult {
  readonly domain: string;
  readonly available: boolean;
  readonly registrationPrice?: number;
  readonly renewalPrice?: number;
  readonly currency?: string;
}

export interface DomainRegistration {
  readonly domain: string;
  readonly status: string;
  readonly expiresAt?: string;
  readonly transactionId?: string;
}

export interface DnsRecord {
  readonly id: string;
  readonly type: string;
  readonly host: string;
  readonly value: string;
  readonly ttl?: number;
  readonly distance?: number;
}

export interface ModelInfo {
  readonly id: string;
  readonly provider: string;
  readonly pricing: {
    readonly inputPerMillion: number;
    readonly outputPerMillion: number;
  };
}

// ─── Policy Engine ───────────────────────────────────────────────

// Risk level for tool classification — replaces `dangerous?: boolean`
export type RiskLevel = 'safe' | 'caution' | 'dangerous' | 'forbidden';

// Policy evaluation result action
export type PolicyAction = 'allow' | 'deny' | 'quarantine';

// Who initiated the action
export type AuthorityLevel = 'system' | 'agent' | 'external';

// Spend categories
export type SpendCategory = 'transfer' | 'x402' | 'inference' | 'other';

export type ToolSelector =
  | { by: 'name'; names: string[] }
  | { by: 'category'; categories: ToolCategory[] }
  | { by: 'risk'; levels: RiskLevel[] }
  | { by: 'all' };

export interface PolicyRule {
  id: string;
  description: string;
  priority: number;
  appliesTo: ToolSelector;
  evaluate(request: PolicyRequest): PolicyRuleResult | null;
}

export interface PolicyRequest {
  readonly tool: AutomatonTool;
  readonly args: Record<string, unknown>;
  readonly context: ToolContext;
  readonly turnContext: {
    readonly inputSource: InputSource | undefined;
    readonly turnToolCallCount: number;
    readonly sessionSpend: SpendTrackerInterface;
  };
}

export interface PolicyRuleResult {
  readonly rule: string;
  readonly action: PolicyAction;
  readonly reasonCode: string;
  readonly humanMessage: string;
}

export interface PolicyDecision {
  readonly action: PolicyAction;
  readonly reasonCode: string;
  readonly humanMessage: string;
  readonly riskLevel: RiskLevel;
  readonly authorityLevel: AuthorityLevel;
  readonly toolName: string;
  readonly argsHash: string;
  readonly rulesEvaluated: string[];
  readonly rulesTriggered: string[];
  readonly timestamp: string;
}

export interface SpendTrackerInterface {
  recordSpend(entry: SpendEntry): void;
  getHourlySpend(category: SpendCategory): number;
  getDailySpend(category: SpendCategory): number;
  getTotalSpend(category: SpendCategory, since: Date): number;
  checkLimit(amount: number, category: SpendCategory, limits: TreasuryPolicy): LimitCheckResult;
  pruneOldRecords(retentionDays: number): number;
}

export interface SpendEntry {
  readonly toolName: string;
  readonly amountCents: number;
  readonly recipient?: string;
  readonly domain?: string;
  readonly category: SpendCategory;
}

export interface LimitCheckResult {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly currentHourlySpend: number;
  readonly currentDailySpend: number;
  readonly limitHourly: number;
  readonly limitDaily: number;
}

export interface TreasuryPolicy {
  maxSingleTransferCents: number;
  maxHourlyTransferCents: number;
  maxDailyTransferCents: number;
  minimumReserveCents: number;
  maxX402PaymentCents: number;
  x402AllowedDomains: string[];
  transferCooldownMs: number;
  maxTransfersPerTurn: number;
  maxInferenceDailyCents: number;
  requireConfirmationAboveCents: number;
}

export const DEFAULT_TREASURY_POLICY: TreasuryPolicy = {
  maxSingleTransferCents: 2000,        // $20 max per transfer
  maxHourlyTransferCents: 5000,        // $50 max per hour
  maxDailyTransferCents: 10000,        // $100 max per day
  minimumReserveCents: 500,            // Keep $5 minimum reserve
  maxX402PaymentCents: 500,            // $5 max for x402 payments
  x402AllowedDomains: ["x402.org", "localhost"],
  transferCooldownMs: 0,
  maxTransfersPerTurn: 5,
  maxInferenceDailyCents: 2000,        // $20 max daily inference spend
  requireConfirmationAboveCents: 1000, // Confirm transfers >$10
};

// ─── Phase 1: Inbox Message Status ──────────────────────────────

export type InboxMessageStatus = 'received' | 'in_progress' | 'processed' | 'failed';

// ─── Phase 1: Runtime Reliability ────────────────────────────────

export interface HttpClientConfig {
  readonly baseTimeout: number;               // default: 30_000ms
  readonly maxRetries: number;                // default: 3
  readonly retryableStatuses: number[];       // default: [429, 500, 502, 503, 504]
  readonly backoffBase: number;               // default: 1_000ms
  readonly backoffMax: number;                // default: 30_000ms
  readonly circuitBreakerThreshold: number;   // default: 5
  readonly circuitBreakerResetMs: number;     // default: 60_000ms
}

export const DEFAULT_HTTP_CLIENT_CONFIG: HttpClientConfig = {
  baseTimeout: 30_000,
  maxRetries: 3,
  retryableStatuses: [429, 500, 502, 503, 504],
  backoffBase: 1_000,
  backoffMax: 30_000,
  circuitBreakerThreshold: 5,
  circuitBreakerResetMs: 60_000,
};

// ─── Database ────────────────────────────────────────────────────

export interface AutomatonDatabase {
  // Identity
  getIdentity(key: string): string | undefined;
  setIdentity(key: string, value: string): void;

  // Turns
  insertTurn(turn: AgentTurn): void;
  getRecentTurns(limit: number): AgentTurn[];
  getTurnById(id: string): AgentTurn | undefined;
  getTurnCount(): number;

  // Tool calls
  insertToolCall(turnId: string, call: ToolCallResult): void;
  getToolCallsForTurn(turnId: string): ToolCallResult[];

  // Heartbeat
  getHeartbeatEntries(): HeartbeatEntry[];
  upsertHeartbeatEntry(entry: HeartbeatEntry): void;
  updateHeartbeatLastRun(name: string, timestamp: string): void;

  // Transactions
  insertTransaction(txn: Transaction): void;
  getRecentTransactions(limit: number): Transaction[];

  // Installed tools
  getInstalledTools(): InstalledTool[];
  installTool(tool: InstalledTool): void;
  removeTool(id: string): void;

  // Modifications
  insertModification(mod: ModificationEntry): void;
  getRecentModifications(limit: number): ModificationEntry[];

  // Key-value store
  getKV(key: string): string | undefined;
  setKV(key: string, value: string): void;
  deleteKV(key: string): void;

  // Skills
  getSkills(enabledOnly?: boolean): Skill[];
  getSkillByName(name: string): Skill | undefined;
  upsertSkill(skill: Skill): void;
  removeSkill(name: string): void;

  // Children
  getChildren(): ChildAutomaton[];
  getChildById(id: string): ChildAutomaton | undefined;
  insertChild(child: ChildAutomaton): void;
  updateChildStatus(id: string, status: ChildStatus): void;

  // Registry
  getRegistryEntry(): RegistryEntry | undefined;
  setRegistryEntry(entry: RegistryEntry): void;

  // Reputation
  insertReputation(entry: ReputationEntry): void;
  getReputation(agentAddress?: string): ReputationEntry[];

  // Inbox
  insertInboxMessage(msg: InboxMessage): void;
  getUnprocessedInboxMessages(limit: number): InboxMessage[];
  markInboxMessageProcessed(id: string): void;

  // Key-value atomic delete
  deleteKVReturning(key: string): string | undefined;

  // State
  getAgentState(): AgentState;
  setAgentState(state: AgentState): void;

  // Transaction helper
  runTransaction<T>(fn: () => T): T;

  close(): void;

  // Raw better-sqlite3 instance for direct DB access (Phase 1.1)
  raw: import("better-sqlite3").Database;
}

export interface InstalledTool {
  readonly id: string;
  readonly name: string;
  readonly type: "builtin" | "mcp" | "custom";
  readonly config?: Record<string, unknown>;
  readonly installedAt: string;
  readonly enabled: boolean;
}

// ─── Inference Client Interface ──────────────────────────────────

export interface InferenceClient {
  chat(
    messages: ChatMessage[],
    options?: InferenceOptions,
  ): Promise<InferenceResponse>;
  setLowComputeMode(enabled: boolean): void;
  getDefaultModel(): string;
}

// ─── Skills ─────────────────────────────────────────────────────

export interface Skill {
  name: string;
  description: string;
  autoActivate: boolean;
  requires?: SkillRequirements;
  instructions: string;
  source: SkillSource;
  path: string;
  enabled: boolean;
  installedAt: string;
}

export interface SkillRequirements {
  bins?: string[];
  env?: string[];
}

export type SkillSource = "builtin" | "git" | "url" | "self";

export interface SkillFrontmatter {
  name: string;
  description: string;
  "auto-activate"?: boolean;
  requires?: SkillRequirements;
}

// ─── Git ────────────────────────────────────────────────────────

export interface GitStatus {
  readonly branch: string;
  readonly staged: string[];
  readonly modified: string[];
  readonly untracked: string[];
  readonly clean: boolean;
}

export interface GitLogEntry {
  readonly hash: string;
  readonly message: string;
  readonly author: string;
  readonly date: string;
}

// ─── ERC-8004 Registry ─────────────────────────────────────────

export interface AgentCard {
  type: string;
  name: string;
  description: string;
  services: AgentService[];
  x402Support: boolean;
  active: boolean;
  parentAgent?: string;
}

export interface AgentService {
  readonly name: string;
  readonly endpoint: string;
}

export interface RegistryEntry {
  agentId: string;
  agentURI: string;
  chain: string;
  contractAddress: string;
  txHash: string;
  registeredAt: string;
}

export interface ReputationEntry {
  readonly id: string;
  readonly fromAgent: string;
  readonly toAgent: string;
  readonly score: number;
  readonly comment: string;
  readonly txHash?: string;
  readonly timestamp: string;
}

export interface DiscoveredAgent {
  agentId: string;
  owner: string;
  agentURI: string;
  name?: string;
  description?: string;
}

// ─── Replication ────────────────────────────────────────────────

export interface ChildAutomaton {
  readonly id: string;
  readonly name: string;
  readonly address: Address;
  readonly sandboxId: string;
  readonly genesisPrompt: string;
  readonly creatorMessage?: string;
  readonly fundedAmountCents: number;
  readonly status: ChildStatus;
  readonly createdAt: string;
  readonly lastChecked?: string;
}

export type ChildStatus =
  | "spawning"
  | "running"
  | "sleeping"
  | "dead"
  | "unknown"
  // Phase 3.1 lifecycle states
  | "requested"
  | "sandbox_created"
  | "runtime_ready"
  | "wallet_verified"
  | "funded"
  | "starting"
  | "healthy"
  | "unhealthy"
  | "stopped"
  | "failed"
  | "cleaned_up";

export interface GenesisConfig {
  readonly name: string;
  readonly genesisPrompt: string;
  readonly creatorMessage?: string;
  readonly creatorAddress: Address;
  readonly parentAddress: Address;
}

/** @deprecated Use AutomatonConfig.maxChildren instead (default: 6). */
export const MAX_CHILDREN = 6;

// ─── Token Budget ───────────────────────────────────────────────

export interface TokenBudget {
  readonly total: number;
  readonly systemPrompt: number;
  readonly recentTurns: number;
  readonly toolResults: number;
  readonly memoryRetrieval: number;
}

export const DEFAULT_TOKEN_BUDGET: TokenBudget = {
  total: 60_000,           // Use more of Haiku's 200K context
  systemPrompt: 12_000,    // Richer system prompt with soul + worklog
  recentTurns: 30_000,     // More conversation history
  toolResults: 10_000,     // Bigger tool outputs
  memoryRetrieval: 8_000,  // More memory context
};

// ─── Phase 1: Runtime Reliability ───────────────────────────────

export interface TickContext {
  readonly tickId: string;                    // ULID, unique per tick
  readonly startedAt: Date;
  readonly creditBalance: number;             // fetched once per tick (cents)
  readonly usdcBalance: number;               // fetched once per tick
  readonly survivalTier: SurvivalTier;
  readonly lowComputeMultiplier: number;      // from config
  readonly config: HeartbeatConfig;
  readonly db: import("better-sqlite3").Database;
}

export type HeartbeatTaskFn = (
  ctx: TickContext,
  taskCtx: HeartbeatLegacyContext,
) => Promise<{ shouldWake: boolean; message?: string }>;

export interface HeartbeatLegacyContext {
  readonly identity: AutomatonIdentity;
  readonly config: AutomatonConfig;
  readonly db: AutomatonDatabase;
  readonly conway: ConwayClient;
  readonly social?: SocialClientInterface;
}

export interface HeartbeatScheduleRow {
  taskName: string;                  // PK
  cronExpression: string;
  intervalMs: number | null;
  enabled: number;                   // 0 or 1
  priority: number;                  // lower = higher priority
  timeoutMs: number;                 // default 30000
  maxRetries: number;                // default 1
  tierMinimum: string;               // minimum tier to run this task
  lastRunAt: string | null;          // ISO-8601
  nextRunAt: string | null;          // ISO-8601
  lastResult: 'success' | 'failure' | 'timeout' | 'skipped' | null;
  lastError: string | null;
  runCount: number;
  failCount: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
}

export interface HeartbeatHistoryRow {
  readonly id: string;                        // ULID
  readonly taskName: string;
  readonly startedAt: string;                 // ISO-8601
  readonly completedAt: string | null;
  readonly result: 'success' | 'failure' | 'timeout' | 'skipped';
  readonly durationMs: number | null;
  readonly error: string | null;
  readonly idempotencyKey: string | null;
}

export interface WakeEventRow {
  readonly id: number;                        // AUTOINCREMENT
  readonly source: string;                    // e.g., 'heartbeat', 'inbox', 'manual'
  readonly reason: string;
  readonly payload: string;                   // JSON, default '{}'
  readonly consumedAt: string | null;
  readonly createdAt: string;
}

export interface HeartbeatDedupRow {
  readonly dedupKey: string;                  // PK
  readonly taskName: string;
  readonly expiresAt: string;                 // ISO-8601
}

// === Phase 2.1: Soul System Types ===

export interface SoulModel {
  format: "soul/v1";
  version: number;
  updatedAt: string; // ISO 8601
  // Immutable frontmatter
  name: string;
  address: string;
  creator: string;
  bornAt: string;
  constitutionHash: string;
  genesisPromptOriginal: string;
  genesisAlignment: number; // 0.0-1.0
  lastReflected: string; // ISO 8601
  // Mutable body sections
  corePurpose: string; // max 2000 chars
  values: string[]; // max 20 items
  behavioralGuidelines: string[]; // max 30 items
  personality: string; // max 1000 chars
  boundaries: string[]; // max 20 items
  strategy: string; // max 3000 chars
  capabilities: string; // auto-populated
  relationships: string; // auto-populated
  financialCharacter: string; // auto-populated + agent-set
  // Metadata
  rawContent: string; // original SOUL.md content
  contentHash: string; // SHA-256 of rawContent
}

export interface SoulValidationResult {
  readonly valid: boolean;
  readonly errors: string[];
  readonly warnings: string[];
  readonly sanitized: SoulModel;
}

export interface SoulHistoryRow {
  readonly id: string; // ULID
  readonly version: number;
  readonly content: string; // full SOUL.md content
  readonly contentHash: string; // SHA-256
  readonly changeSource: "agent" | "human" | "system" | "genesis" | "reflection";
  readonly changeReason: string | null;
  readonly previousVersionId: string | null;
  readonly approvedBy: string | null;
  readonly createdAt: string;
}

export interface SoulReflection {
  currentAlignment: number;
  suggestedUpdates: Array<{
    section: string;
    reason: string;
    suggestedContent: string;
  }>;
  autoUpdated: string[]; // sections auto-updated (capabilities, relationships, financial)
}

export interface SoulConfig {
  soulAlignmentThreshold: number; // default: 0.5
  requireCreatorApprovalForPurposeChange: boolean; // default: false
  enableSoulReflection: boolean; // default: true
}

export const DEFAULT_SOUL_CONFIG: SoulConfig = {
  soulAlignmentThreshold: 0.5,
  requireCreatorApprovalForPurposeChange: false,
  enableSoulReflection: true,
};

// === Phase 2.2: Memory System Types ===

export type WorkingMemoryType = "goal" | "observation" | "plan" | "reflection" | "task" | "decision" | "note" | "summary";

export interface WorkingMemoryEntry {
  readonly id: string; // ULID
  readonly sessionId: string;
  readonly content: string;
  readonly contentType: WorkingMemoryType;
  readonly priority: number; // 0.0-1.0
  readonly tokenCount: number;
  readonly expiresAt: string | null; // ISO 8601 or null
  readonly sourceTurn: string | null; // turn_id
  readonly createdAt: string;
}

export type TurnClassification = "strategic" | "productive" | "communication" | "maintenance" | "idle" | "error";

export interface EpisodicMemoryEntry {
  readonly id: string; // ULID
  readonly sessionId: string;
  readonly eventType: string;
  readonly summary: string;
  readonly detail: string | null;
  readonly outcome: "success" | "failure" | "partial" | "neutral" | null;
  readonly importance: number; // 0.0-1.0
  readonly embeddingKey: string | null;
  readonly tokenCount: number;
  readonly accessedCount: number;
  readonly lastAccessedAt: string | null;
  readonly classification: TurnClassification;
  readonly createdAt: string;
}

export type SemanticCategory = "self" | "environment" | "financial" | "agent" | "domain" | "procedural_ref" | "creator";

export interface SemanticMemoryEntry {
  readonly id: string; // ULID
  readonly category: SemanticCategory;
  readonly key: string;
  readonly value: string;
  readonly confidence: number; // 0.0-1.0
  readonly source: string; // session_id or turn_id
  readonly embeddingKey: string | null;
  readonly lastVerifiedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProceduralStep {
  readonly order: number;
  readonly description: string;
  readonly tool: string | null;
  readonly argsTemplate: Record<string, string> | null;
  readonly expectedOutcome: string | null;
  readonly onFailure: string | null;
}

export interface ProceduralMemoryEntry {
  readonly id: string; // ULID
  readonly name: string; // unique
  readonly description: string;
  readonly steps: ProceduralStep[];
  readonly successCount: number;
  readonly failureCount: number;
  readonly lastUsedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RelationshipMemoryEntry {
  readonly id: string; // ULID
  readonly entityAddress: string; // unique
  readonly entityName: string | null;
  readonly relationshipType: string;
  readonly trustScore: number; // 0.0-1.0
  readonly interactionCount: number;
  readonly lastInteractionAt: string | null;
  readonly notes: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SessionSummaryEntry {
  readonly id: string; // ULID
  readonly sessionId: string; // unique
  readonly summary: string;
  readonly keyDecisions: string[]; // JSON-serialized
  readonly toolsUsed: string[]; // JSON-serialized
  readonly outcomes: string[]; // JSON-serialized
  readonly turnCount: number;
  readonly totalTokens: number;
  readonly totalCostCents: number;
  readonly createdAt: string;
}

export interface MemoryRetrievalResult {
  readonly workingMemory: WorkingMemoryEntry[];
  readonly episodicMemory: EpisodicMemoryEntry[];
  readonly semanticMemory: SemanticMemoryEntry[];
  readonly proceduralMemory: ProceduralMemoryEntry[];
  readonly relationships: RelationshipMemoryEntry[];
  readonly totalTokens: number;
}

export interface MemoryBudget {
  readonly workingMemoryTokens: number;
  readonly episodicMemoryTokens: number;
  readonly semanticMemoryTokens: number;
  readonly proceduralMemoryTokens: number;
  readonly relationshipMemoryTokens: number;
}

export const DEFAULT_MEMORY_BUDGET: MemoryBudget = {
  workingMemoryTokens: 2_000,
  episodicMemoryTokens: 4_000,
  semanticMemoryTokens: 4_000,
  proceduralMemoryTokens: 2_000,
  relationshipMemoryTokens: 2_000,
};

// === Phase 2.3: Inference & Model Strategy Types ===

export type ModelProvider = "openai" | "anthropic" | "groq" | "conway" | "ollama" | "mistral" | "other";

/** Which inference pool the CascadeController should use */
export type CascadePool = "paid" | "free_cloud" | "local";

export type InferenceTaskType =
  | "agent_turn"
  | "heartbeat_triage"
  | "safety_check"
  | "summarization"
  | "planning";

export interface ModelEntry {
  modelId: string; // e.g. "gpt-4.1", "claude-sonnet-4-6"
  provider: ModelProvider;
  displayName: string;
  tierMinimum: SurvivalTier; // minimum tier to use this model
  costPer1kInput: number; // hundredths of cents
  costPer1kOutput: number; // hundredths of cents
  maxTokens: number;
  contextWindow: number;
  supportsTools: boolean;
  supportsVision: boolean;
  parameterStyle: "max_tokens" | "max_completion_tokens";
  enabled: boolean;
  lastSeen: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModelPreference {
  readonly candidates: string[]; // model IDs in preference order
  readonly maxTokens: number;
  readonly ceilingCents: number; // max cost per call (-1 = no limit)
}

export type RoutingMatrix = Record<SurvivalTier, Record<InferenceTaskType, ModelPreference>>;

export interface InferenceRequest {
  readonly messages: ChatMessage[];
  readonly taskType: InferenceTaskType;
  readonly tier: SurvivalTier;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly maxTokens?: number; // override
  readonly tools?: InferenceToolDefinition[];
}

export interface InferenceResult {
  readonly content: string;
  readonly model: string;
  readonly provider: ModelProvider;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costCents: number;
  readonly latencyMs: number;
  readonly toolCalls?: InferenceToolCall[];
  readonly finishReason: string;
}

export interface InferenceCostRow {
  readonly id: string; // ULID
  readonly sessionId: string;
  readonly turnId: string | null;
  readonly model: string;
  readonly provider: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costCents: number;
  readonly latencyMs: number;
  readonly tier: string;
  readonly taskType: string;
  readonly cacheHit: boolean;
  readonly createdAt: string;
}

export interface ModelRegistryRow {
  modelId: string;
  provider: string;
  displayName: string;
  tierMinimum: string;
  costPer1kInput: number;
  costPer1kOutput: number;
  maxTokens: number;
  contextWindow: number;
  supportsTools: boolean;
  supportsVision: boolean;
  parameterStyle: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ModelStrategyConfig {
  inferenceModel: string;
  lowComputeModel: string;
  criticalModel: string;
  maxTokensPerTurn: number;
  hourlyBudgetCents: number; // default: 0 (no limit)
  sessionBudgetCents: number; // default: 0 (no limit)
  perCallCeilingCents: number; // default: 0 (no limit)
  enableModelFallback: boolean; // default: true
  anthropicApiVersion: string; // default: "2023-06-01"
}

export const DEFAULT_MODEL_STRATEGY_CONFIG: ModelStrategyConfig = {
  inferenceModel: "claude-haiku-4-5-20251001",
  lowComputeModel: "claude-haiku-4-5-20251001",
  criticalModel: "claude-haiku-4-5-20251001",
  maxTokensPerTurn: 4096,
  hourlyBudgetCents: 0,
  sessionBudgetCents: 0,
  perCallCeilingCents: 0,
  enableModelFallback: true,
  anthropicApiVersion: "2023-06-01",
};

// === Phase 3.1: Replication & Lifecycle Types ===

export type ChildLifecycleState =
  | "requested"
  | "sandbox_created"
  | "runtime_ready"
  | "wallet_verified"
  | "funded"
  | "starting"
  | "healthy"
  | "unhealthy"
  | "stopped"
  | "failed"
  | "cleaned_up";

export const VALID_TRANSITIONS: Record<ChildLifecycleState, ChildLifecycleState[]> = {
  requested: ["sandbox_created", "failed"],
  sandbox_created: ["runtime_ready", "failed"],
  runtime_ready: ["wallet_verified", "failed"],
  wallet_verified: ["funded", "failed"],
  funded: ["starting", "failed"],
  starting: ["healthy", "failed"],
  healthy: ["unhealthy", "stopped"],
  unhealthy: ["healthy", "stopped", "failed"],
  stopped: ["cleaned_up"],
  failed: ["cleaned_up"],
  cleaned_up: [], // terminal
};

export interface ChildLifecycleEventRow {
  readonly id: string; // ULID
  readonly childId: string;
  readonly fromState: string;
  readonly toState: string;
  readonly reason: string | null;
  readonly metadata: string; // JSON
  readonly createdAt: string;
}

export interface HealthCheckResult {
  readonly childId: string;
  readonly healthy: boolean;
  readonly lastSeen: string | null;
  readonly uptime: number | null;
  readonly creditBalance: number | null;
  readonly issues: string[];
}

export interface ChildHealthConfig {
  readonly checkIntervalMs: number; // default: 300000 (5 min)
  readonly unhealthyThresholdMs: number; // default: 900000 (15 min)
  readonly deadThresholdMs: number; // default: 3600000 (1 hour)
  readonly maxConcurrentChecks: number; // default: 3
}

export const DEFAULT_CHILD_HEALTH_CONFIG: ChildHealthConfig = {
  checkIntervalMs: 300_000,
  unhealthyThresholdMs: 900_000,
  deadThresholdMs: 3_600_000,
  maxConcurrentChecks: 3,
};

export interface GenesisLimits {
  readonly maxNameLength: number; // default: 64
  readonly maxSpecializationLength: number; // default: 2000
  readonly maxTaskLength: number; // default: 4000
  readonly maxMessageLength: number; // default: 2000
  readonly maxGenesisPromptLength: number; // default: 16000
}

export const DEFAULT_GENESIS_LIMITS: GenesisLimits = {
  maxNameLength: 64,
  maxSpecializationLength: 2000,
  maxTaskLength: 4000,
  maxMessageLength: 2000,
  maxGenesisPromptLength: 16000,
};

export interface ParentChildMessage {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly content: string;
  readonly type: string;
  readonly sentAt: string;
}

export const MESSAGE_LIMITS = {
  maxContentLength: 64_000, // 64KB
  maxTotalSize: 128_000, // 128KB
  replayWindowMs: 300_000, // 5 minutes
  maxOutboundPerHour: 100,
} as const;

// === Phase 3.2: Social & Registry Types ===

export interface SignedMessagePayload {
  readonly from: string;
  readonly to: string;
  readonly content: string;
  readonly signed_at: string;
  readonly signature: string;
  readonly reply_to?: string;
}

export interface MessageValidationResult {
  readonly valid: boolean;
  readonly errors: string[];
}

export interface DiscoveryConfig {
  readonly ipfsGateway: string; // default: "https://ipfs.io"
  readonly maxScanCount: number; // default: 20
  readonly maxConcurrentFetches: number; // default: 5
  readonly maxCardSizeBytes: number; // default: 64000
  readonly fetchTimeoutMs: number; // default: 10000
}

export const DEFAULT_DISCOVERY_CONFIG: DiscoveryConfig = {
  ipfsGateway: "https://ipfs.io",
  maxScanCount: 20,
  maxConcurrentFetches: 5,
  maxCardSizeBytes: 64_000,
  fetchTimeoutMs: 10_000,
};

export interface OnchainTransactionRow {
  readonly id: string; // ULID
  readonly txHash: string;
  readonly chain: string;
  readonly operation: string;
  readonly status: "pending" | "confirmed" | "failed";
  readonly gasUsed: number | null;
  readonly metadata: string; // JSON
  readonly createdAt: string;
}

export interface DiscoveredAgentCacheRow {
  readonly agentAddress: string; // PRIMARY KEY
  readonly agentCard: string; // JSON AgentCard
  readonly fetchedFrom: string; // URI
  readonly cardHash: string;
  readonly validUntil: string | null;
  readonly fetchCount: number;
  readonly lastFetchedAt: string;
  readonly createdAt: string;
}

// === Phase 4.1: Observability Types ===

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  context?: Record<string, unknown>;
  error?: { message: string; stack?: string; code?: string };
}

export type MetricType = "counter" | "gauge" | "histogram";

export interface MetricEntry {
  readonly name: string;
  readonly value: number;
  readonly type: MetricType;
  readonly labels: Record<string, string>;
  readonly timestamp: string;
}

export interface MetricSnapshotRow {
  readonly id: string; // ULID
  readonly snapshotAt: string;
  readonly metricsJson: string; // JSON array of MetricEntry
  readonly alertsJson: string; // JSON array of fired alert names
  readonly createdAt: string;
}

export type AlertSeverity = "warning" | "critical";

export interface AlertRule {
  readonly name: string;
  readonly severity: AlertSeverity;
  readonly message: string;
  readonly cooldownMs: number; // minimum ms between firings
  readonly condition: (metrics: MetricSnapshot) => boolean;
}

export interface MetricSnapshot {
  readonly counters: Map<string, number>;
  readonly gauges: Map<string, number>;
  readonly histograms: Map<string, number[]>;
}

export interface AlertEvent {
  readonly rule: string;
  readonly severity: AlertSeverity;
  readonly message: string;
  readonly firedAt: string;
  readonly metricValues: Record<string, number>;
}
