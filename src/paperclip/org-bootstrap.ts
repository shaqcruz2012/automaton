/**
 * Paperclip Org Chart Bootstrap — Quant HF-Scale Fund
 *
 * Defines the full organizational structure for a quantitative hedge fund
 * with ~40-80 humans and a dense layer of AI agents managed through Paperclip.
 *
 * This module can be called by the chief-of-staff to bootstrap or update
 * the entire org chart in a Paperclip deployment.
 */

import type { PaperclipClient, HireAgentParams } from "./client.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("paperclip.org-bootstrap");

/**
 * Org chart node — represents an agent role in the fund.
 */
interface OrgNode {
  name: string;
  role: string;
  title: string;
  capabilities: string;
  adapterType: string;
  reportsTo?: string;  // Role name of manager (resolved to ID at hire time)
  children?: OrgNode[];
}

/**
 * Complete quant fund org chart definition.
 * Each node maps to a Paperclip agent that can be hired and assigned tasks.
 */
const QUANT_FUND_ORG: OrgNode = {
  name: "CEO Agent",
  role: "ceo",
  title: "Chief Executive Officer",
  capabilities: "Firm mission, culture, capital allocation. Chairs Investment & Risk Committee. Sets top-level goals (AUM, Sharpe, drawdown, diversification). Approves large strategic projects and hires.",
  adapterType: "claude_local",
  children: [
    // ─── CIO Branch ────────────────────────
    {
      name: "CIO Agent",
      role: "cio",
      title: "Chief Investment Officer",
      capabilities: "Investment strategy, portfolio construction, research roadmap across all desks. Leads investment meetings, strategy review, and pruning.",
      adapterType: "claude_local",
      children: [
        {
          name: "Macro Desk Head",
          role: "macro_desk_head",
          title: "Head of Global Macro",
          capabilities: "Cross-asset macro signals, regime detection, policy/flow models. Manages macro PMs and quants.",
          adapterType: "claude_local",
          children: [
            { name: "Macro PM Agent", role: "macro_pm", title: "Macro Portfolio Manager", capabilities: "Position sizing, macro trade structuring, cross-asset allocation.", adapterType: "process" },
            { name: "Macro Quant Agent", role: "macro_quant", title: "Macro Quantitative Researcher", capabilities: "Time-series modeling, regime detection, policy signal extraction using language + time-series models.", adapterType: "process" },
          ],
        },
        {
          name: "Equities Desk Head",
          role: "equities_desk_head",
          title: "Head of Equities / Stat Arb",
          capabilities: "Cross-sectional signals, factor models, intraday stat-arb strategies.",
          adapterType: "claude_local",
          children: [
            { name: "Equities PM Agent", role: "equities_pm", title: "Equities Portfolio Manager", capabilities: "Factor portfolio construction, sector rotation, long/short equity.", adapterType: "process" },
            { name: "Stat Arb Quant Agent", role: "stat_arb_quant", title: "Statistical Arbitrage Researcher", capabilities: "Pairs trading, mean reversion, cross-sectional alpha discovery.", adapterType: "process" },
          ],
        },
        {
          name: "Vol Desk Head",
          role: "vol_desk_head",
          title: "Head of Options / Volatility",
          capabilities: "Vol surfaces, dispersion trades, structured trades. Risk monitoring of Greeks and tail exposures.",
          adapterType: "claude_local",
          children: [
            { name: "Vol PM Agent", role: "vol_pm", title: "Volatility Portfolio Manager", capabilities: "Vol surface trading, dispersion, tail hedging, structured products.", adapterType: "process" },
            { name: "Vol Quant Agent", role: "vol_quant", title: "Volatility Quantitative Researcher", capabilities: "Stochastic vol modeling, surface fitting, Greeks computation.", adapterType: "process" },
          ],
        },
        {
          name: "HF Trading Head",
          role: "hf_desk_head",
          title: "Head of HF / Market Making",
          capabilities: "Low-latency execution, liquidity provision, market making. Tight loop with CTO infra and risk monitoring.",
          adapterType: "process",
          children: [
            { name: "HF Trader Agent", role: "hf_trader", title: "High-Frequency Trader", capabilities: "Low-latency order routing, inventory management, spread capture.", adapterType: "process" },
            { name: "HF Quant Agent", role: "hf_quant", title: "HF Quantitative Developer", capabilities: "Microstructure signals, tick data analysis, latency optimization.", adapterType: "process" },
          ],
        },
        {
          name: "Execution Head",
          role: "execution_head",
          title: "Head of Cross-Desk Execution & Treasury",
          capabilities: "Firm-wide execution strategy, algo choice, funding/hedging, route proposals.",
          adapterType: "claude_local",
          children: [
            { name: "Execution Trader Agent", role: "execution_trader", title: "Execution Trader", capabilities: "Algo selection, venue routing, TCA analysis, scheduling.", adapterType: "process" },
          ],
        },
      ],
    },

    // ─── CAIO Branch (AI Research) ────────────────────────
    {
      name: "CAIO Agent",
      role: "caio",
      title: "Chief AI & Research Officer",
      capabilities: "AI lab leadership: modeling, agents, research platform. Owns agent frameworks, evaluation harnesses, and Paperclip integration.",
      adapterType: "claude_local",
      children: [
        {
          name: "Alpha Discovery Lead",
          role: "alpha_lead",
          title: "Lead Scientist — Alpha Discovery",
          capabilities: "Alpha models, hypothesis generators, ML/econometrics/GNN research agents.",
          adapterType: "claude_local",
          children: [
            { name: "Alpha Research Agent", role: "alpha_researcher", title: "Alpha Researcher", capabilities: "Feature engineering, signal discovery, model training and evaluation.", adapterType: "process" },
          ],
        },
        {
          name: "Microstructure Lead",
          role: "microstructure_lead",
          title: "Lead — Market Microstructure & Execution Intelligence",
          capabilities: "Order book dynamics, impact/slippage modeling, RL agents for execution.",
          adapterType: "claude_local",
          children: [
            { name: "Microstructure Agent", role: "microstructure_researcher", title: "Microstructure Researcher", capabilities: "Order flow analysis, LOB modeling, execution RL agents.", adapterType: "process" },
          ],
        },
        {
          name: "Chief Economist Agent",
          role: "chief_economist",
          title: "Chief Economist",
          capabilities: "Macro narratives, policy risk, regime classification. Language agents for filings, speeches, economic releases.",
          adapterType: "claude_local",
          children: [
            { name: "Econ Research Agent", role: "econ_researcher", title: "Economic Researcher", capabilities: "NLP on central bank communications, macro indicator analysis, policy modeling.", adapterType: "process" },
          ],
        },
        {
          name: "Research Platform Lead",
          role: "research_platform_lead",
          title: "Lead — Research Platform",
          capabilities: "Notebooks, experiment tracking, simulation frameworks, data access for labs/desks.",
          adapterType: "process",
        },
      ],
    },

    // ─── CTO Branch (Technology) ────────────────────────
    {
      name: "CTO Agent",
      role: "cto",
      title: "Chief Technology Officer",
      capabilities: "Trading/infra stack: data pipelines, backtesting, execution, connectivity. Builds low-latency infra, risk systems, dev environment.",
      adapterType: "claude_local",
      children: [
        {
          name: "Data Engineering Lead",
          role: "data_eng_lead",
          title: "Lead — Data Engineering",
          capabilities: "Market feed ingestion, alt data ETL, storage, quality checks.",
          adapterType: "process",
          children: [
            { name: "Data Engineer Agent", role: "data_engineer", title: "Data Engineer", capabilities: "Pipeline building, data quality monitoring, schema management.", adapterType: "process" },
          ],
        },
        {
          name: "Core Systems Lead",
          role: "core_systems_lead",
          title: "Lead — Core Trading Systems",
          capabilities: "Portfolio/risk systems, OMS, exchange connectivity.",
          adapterType: "process",
          children: [
            { name: "Systems Engineer Agent", role: "systems_engineer", title: "Backend Systems Engineer", capabilities: "OMS development, exchange connectivity, risk system integration.", adapterType: "process" },
          ],
        },
        {
          name: "Platform Lead",
          role: "platform_lead",
          title: "Lead — Platform & Tooling",
          capabilities: "Internal SDKs, feature stores, job orchestration, agent skill APIs, Paperclip backend integration.",
          adapterType: "process",
        },
        {
          name: "SRE Lead",
          role: "sre_lead",
          title: "Lead — DevOps / SRE / Security",
          capabilities: "Reliability, deployment, observability, security controls, incident response.",
          adapterType: "process",
        },
      ],
    },

    // ─── CRO Branch (Risk) ────────────────────────
    {
      name: "CRO Agent",
      role: "cro",
      title: "Chief Risk Officer",
      capabilities: "Independent risk function with veto over CIO. Risk appetite, limits, aggregate risk view. Real-time risk, stress testing, post-mortems, kill-switches.",
      adapterType: "claude_local",
      children: [
        { name: "Risk Monitor Agent", role: "risk_monitor", title: "Real-Time Risk Monitor", capabilities: "Position monitoring, limit breach detection, Greeks aggregation, circuit breaker triggers.", adapterType: "process" },
        { name: "Stress Test Agent", role: "stress_tester", title: "Stress Testing Analyst", capabilities: "Scenario analysis, VaR computation, tail risk assessment, drawdown simulation.", adapterType: "process" },
      ],
    },

    // ─── COO Branch (Operations) ────────────────────────
    {
      name: "COO Agent",
      role: "coo",
      title: "Chief Operating Officer",
      capabilities: "Operations: middle/back office, trade ops, HR, facilities, vendor management. Execution, settlements, reconciliations.",
      adapterType: "claude_local",
      children: [
        { name: "Ops Analyst Agent", role: "ops_analyst", title: "Operations Analyst", capabilities: "Trade capture, reconciliation, corporate actions, valuations. Raises tickets for exceptions.", adapterType: "process" },
        { name: "IR Agent", role: "ir_agent", title: "Investor Relations Associate", capabilities: "Performance analytics, LP letter drafting, investor communication support.", adapterType: "claude_local" },
      ],
    },

    // ─── CFO Branch (Finance) ────────────────────────
    {
      name: "CFO Agent",
      role: "cfo",
      title: "Chief Financial Officer",
      capabilities: "Firm finances: capital structure, budgeting, runway, fee economics, tax, PnL attribution. Agent and compute cost tracking.",
      adapterType: "claude_local",
      children: [
        { name: "Controller Agent", role: "controller", title: "Financial Controller", capabilities: "NAV calculation, management/performance fee computation, vendor management, cost tracing.", adapterType: "process" },
      ],
    },

    // ─── CCO Branch (Compliance) ────────────────────────
    {
      name: "CCO Agent",
      role: "cco",
      title: "Chief Compliance Officer / General Counsel",
      capabilities: "Regulatory compliance, legal risk, licensing, policy framework. Audit log verification, recordkeeping, supervision.",
      adapterType: "claude_local",
      children: [
        { name: "Compliance Reviewer Agent", role: "compliance_reviewer", title: "Compliance Reviewer", capabilities: "Pre-trade compliance checks, marketing material review, regulatory filing preparation.", adapterType: "process" },
      ],
    },

    // ─── CHRO Branch (People) ────────────────────────
    {
      name: "CHRO Agent",
      role: "chro",
      title: "Chief Human & Agent Resources Officer",
      capabilities: "Talent, compensation, performance. Agent workforce management. Roles, ladders, review cycles for human and AI teams.",
      adapterType: "claude_local",
      children: [
        { name: "People Ops Agent", role: "people_ops", title: "People Operations", capabilities: "Sourcing, performance report drafting, review cycle support, onboarding.", adapterType: "process" },
      ],
    },
  ],
};

/**
 * Flatten the org tree into a list of agents with parent references.
 */
function flattenOrg(node: OrgNode, parentRole?: string): Array<HireAgentParams & { _role: string; _parentRole?: string }> {
  const result: Array<HireAgentParams & { _role: string; _parentRole?: string }> = [];

  result.push({
    name: node.name,
    role: node.role,
    title: node.title,
    capabilities: node.capabilities,
    adapterType: node.adapterType,
    _role: node.role,
    _parentRole: parentRole,
  });

  if (node.children) {
    for (const child of node.children) {
      result.push(...flattenOrg(child, node.role));
    }
  }

  return result;
}

/**
 * Bootstrap the entire quant fund org chart in Paperclip.
 * Hires all agents and sets up reporting relationships.
 */
export async function bootstrapQuantFundOrg(client: PaperclipClient): Promise<{
  hired: number;
  failed: number;
  agents: Array<{ name: string; role: string; id: string }>;
  errors: string[];
}> {
  const agents = flattenOrg(QUANT_FUND_ORG);
  const roleToId = new Map<string, string>();
  const results: Array<{ name: string; role: string; id: string }> = [];
  const errors: string[] = [];

  logger.info(`Bootstrapping quant fund org: ${agents.length} agents to hire`);

  for (const agent of agents) {
    const reportsTo = agent._parentRole ? roleToId.get(agent._parentRole) : undefined;

    const result = await client.hireAgent({
      name: agent.name,
      role: agent.role,
      title: agent.title,
      capabilities: agent.capabilities,
      adapterType: agent.adapterType,
      reportsTo,
    });

    if (result.ok && result.data) {
      roleToId.set(agent._role, result.data.id);
      results.push({ name: agent.name, role: agent.role, id: result.data.id });
      logger.info(`Hired: ${agent.name} (${agent.role}) → ${result.data.id}`);
    } else {
      errors.push(`Failed to hire ${agent.name}: ${result.error}`);
      logger.warn(`Failed to hire: ${agent.name}`, { error: result.error });
    }
  }

  return {
    hired: results.length,
    failed: errors.length,
    agents: results,
    errors,
  };
}

/**
 * Get a summary of the org chart for display.
 */
export function getOrgChartSummary(): string {
  const agents = flattenOrg(QUANT_FUND_ORG);
  const lines = [`Quant Fund Org Chart (${agents.length} agents):\n`];

  function printTree(node: OrgNode, indent: number): void {
    const prefix = "  ".repeat(indent) + (indent > 0 ? "├─ " : "");
    lines.push(`${prefix}${node.title} — ${node.name} [${node.adapterType}]`);
    if (node.children) {
      for (const child of node.children) {
        printTree(child, indent + 1);
      }
    }
  }

  printTree(QUANT_FUND_ORG, 0);
  return lines.join("\n");
}
