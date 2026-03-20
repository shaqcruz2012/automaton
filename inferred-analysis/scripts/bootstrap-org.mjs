#!/usr/bin/env node
/**
 * Bootstrap Quant Fund Org Chart in Paperclip
 *
 * Hires all 30+ agents and auto-approves them.
 * Usage: node scripts/bootstrap-org.mjs [paperclip-url] [company-id]
 */

const BASE_URL = process.argv[2] || "http://localhost:3100";
const COMPANY_ID = process.argv[3] || null;

// ─── Org Chart Definition ─────────────────────────────────

const ORG_TREE = {
  name: "CEO Agent", role: "ceo", title: "Chief Executive Officer",
  capabilities: "Firm mission, culture, capital allocation. Chairs Investment & Risk Committee.",
  adapter: "claude_local", budget: 5000,
  children: [
    // CIO Branch — Trading
    {
      name: "CIO Agent", role: "cio", title: "Chief Investment Officer",
      capabilities: "Investment strategy, portfolio construction, research roadmap across all desks.",
      adapter: "claude_local", budget: 5000,
      children: [
        {
          name: "Macro Desk Head", role: "macro_desk_head", title: "Head of Global Macro",
          capabilities: "Cross-asset macro signals, regime detection, policy/flow models.",
          adapter: "claude_local", budget: 3000,
          children: [
            { name: "Macro PM", role: "macro_pm", title: "Macro Portfolio Manager", capabilities: "Position sizing, macro trade structuring, cross-asset allocation.", adapter: "process", budget: 2000 },
            { name: "Macro Quant", role: "macro_quant", title: "Macro Quantitative Researcher", capabilities: "Time-series modeling, regime detection, policy signal extraction.", adapter: "process", budget: 2000 },
          ],
        },
        {
          name: "Equities Desk Head", role: "equities_desk_head", title: "Head of Equities / Stat Arb",
          capabilities: "Cross-sectional signals, factor models, intraday stat-arb strategies.",
          adapter: "claude_local", budget: 3000,
          children: [
            { name: "Equities PM", role: "equities_pm", title: "Equities Portfolio Manager", capabilities: "Factor portfolio construction, sector rotation, long/short equity.", adapter: "process", budget: 2000 },
            { name: "Stat Arb Quant", role: "stat_arb_quant", title: "Statistical Arbitrage Researcher", capabilities: "Pairs trading, mean reversion, cross-sectional alpha discovery.", adapter: "process", budget: 2000 },
          ],
        },
        {
          name: "Vol Desk Head", role: "vol_desk_head", title: "Head of Options / Volatility",
          capabilities: "Vol surfaces, dispersion trades, structured trades, Greeks monitoring.",
          adapter: "claude_local", budget: 3000,
          children: [
            { name: "Vol PM", role: "vol_pm", title: "Volatility Portfolio Manager", capabilities: "Vol surface trading, dispersion, tail hedging.", adapter: "process", budget: 2000 },
            { name: "Vol Quant", role: "vol_quant", title: "Volatility Quantitative Researcher", capabilities: "Stochastic vol modeling, surface fitting, Greeks computation.", adapter: "process", budget: 2000 },
          ],
        },
        {
          name: "HF Trading Head", role: "hf_desk_head", title: "Head of HF / Market Making",
          capabilities: "Low-latency execution, liquidity provision, market making.",
          adapter: "process", budget: 3000,
          children: [
            { name: "HF Trader", role: "hf_trader", title: "High-Frequency Trader", capabilities: "Low-latency order routing, inventory management, spread capture.", adapter: "process", budget: 2000 },
            { name: "HF Quant", role: "hf_quant", title: "HF Quantitative Developer", capabilities: "Microstructure signals, tick data analysis, latency optimization.", adapter: "process", budget: 2000 },
          ],
        },
        {
          name: "Execution Head", role: "execution_head", title: "Head of Execution & Treasury",
          capabilities: "Firm-wide execution strategy, algo choice, funding/hedging.",
          adapter: "claude_local", budget: 2000,
          children: [
            { name: "Execution Trader", role: "execution_trader", title: "Execution Trader", capabilities: "Algo selection, venue routing, TCA analysis.", adapter: "process", budget: 1500 },
          ],
        },
      ],
    },

    // CAIO Branch — AI Research Lab
    {
      name: "CAIO Agent", role: "caio", title: "Chief AI & Research Officer",
      capabilities: "AI lab leadership: modeling, agents, research platform, autoresearch loops.",
      adapter: "claude_local", budget: 5000,
      children: [
        {
          name: "Alpha Discovery Lead", role: "alpha_lead", title: "Lead — Alpha Discovery",
          capabilities: "Alpha models, hypothesis generators, ML/econometrics/GNN research.",
          adapter: "claude_local", budget: 3000,
          children: [
            { name: "Alpha Researcher", role: "alpha_researcher", title: "Alpha Researcher", capabilities: "Feature engineering, signal discovery, model training and evaluation.", adapter: "process", budget: 2000 },
          ],
        },
        {
          name: "Microstructure Lead", role: "microstructure_lead", title: "Lead — Market Microstructure",
          capabilities: "Order book dynamics, impact/slippage modeling, RL agents for execution.",
          adapter: "claude_local", budget: 3000,
          children: [
            { name: "Microstructure Researcher", role: "microstructure_researcher", title: "Microstructure Researcher", capabilities: "Order flow analysis, LOB modeling, execution RL agents.", adapter: "process", budget: 2000 },
          ],
        },
        {
          name: "Chief Economist", role: "chief_economist", title: "Chief Economist",
          capabilities: "Macro narratives, policy risk, regime classification, NLP on filings.",
          adapter: "claude_local", budget: 3000,
          children: [
            { name: "Econ Researcher", role: "econ_researcher", title: "Economic Researcher", capabilities: "NLP on central bank communications, macro indicator analysis.", adapter: "process", budget: 2000 },
          ],
        },
        { name: "Research Platform Lead", role: "research_platform_lead", title: "Lead — Research Platform", capabilities: "Notebooks, experiment tracking, simulation frameworks.", adapter: "process", budget: 2000 },
      ],
    },

    // CTO Branch — Technology
    {
      name: "CTO Agent", role: "cto", title: "Chief Technology Officer",
      capabilities: "Trading/infra stack: data pipelines, backtesting, execution, connectivity.",
      adapter: "claude_local", budget: 5000,
      children: [
        {
          name: "Data Engineering Lead", role: "data_eng_lead", title: "Lead — Data Engineering",
          capabilities: "Market feed ingestion, alt data ETL, storage, quality checks.",
          adapter: "process", budget: 2000,
          children: [
            { name: "Data Engineer", role: "data_engineer", title: "Data Engineer", capabilities: "Pipeline building, data quality monitoring, schema management.", adapter: "process", budget: 1500 },
          ],
        },
        {
          name: "Core Systems Lead", role: "core_systems_lead", title: "Lead — Core Trading Systems",
          capabilities: "Portfolio/risk systems, OMS, exchange connectivity.",
          adapter: "process", budget: 2000,
          children: [
            { name: "Systems Engineer", role: "systems_engineer", title: "Backend Systems Engineer", capabilities: "OMS development, exchange connectivity, risk system integration.", adapter: "process", budget: 1500 },
          ],
        },
        { name: "Platform Lead", role: "platform_lead", title: "Lead — Platform & Tooling", capabilities: "Internal SDKs, feature stores, job orchestration.", adapter: "process", budget: 2000 },
        { name: "SRE Lead", role: "sre_lead", title: "Lead — DevOps / SRE / Security", capabilities: "Reliability, deployment, observability, security controls.", adapter: "process", budget: 2000 },
      ],
    },

    // CRO Branch — Risk
    {
      name: "CRO Agent", role: "cro", title: "Chief Risk Officer",
      capabilities: "Independent risk function with veto over CIO. Limits, stress testing, kill-switches.",
      adapter: "claude_local", budget: 3000,
      children: [
        { name: "Risk Monitor", role: "risk_monitor", title: "Real-Time Risk Monitor", capabilities: "Position monitoring, limit breach detection, circuit breaker triggers.", adapter: "process", budget: 2000 },
        { name: "Stress Tester", role: "stress_tester", title: "Stress Testing Analyst", capabilities: "Scenario analysis, VaR computation, tail risk assessment.", adapter: "process", budget: 2000 },
      ],
    },

    // COO Branch — Operations
    {
      name: "COO Agent", role: "coo", title: "Chief Operating Officer",
      capabilities: "Operations: middle/back office, trade ops, vendor management.",
      adapter: "claude_local", budget: 3000,
      children: [
        { name: "Ops Analyst", role: "ops_analyst", title: "Operations Analyst", capabilities: "Trade capture, reconciliation, corporate actions, valuations.", adapter: "process", budget: 1500 },
        { name: "IR Associate", role: "ir_agent", title: "Investor Relations Associate", capabilities: "Performance analytics, LP letter drafting, investor communication.", adapter: "claude_local", budget: 1500 },
      ],
    },

    // CFO, CCO, CHRO
    {
      name: "CFO Agent", role: "cfo", title: "Chief Financial Officer",
      capabilities: "Firm finances: capital structure, budgeting, fee economics, PnL attribution.",
      adapter: "claude_local", budget: 3000,
      children: [
        { name: "Controller", role: "controller", title: "Financial Controller", capabilities: "NAV calculation, fee computation, cost tracing.", adapter: "process", budget: 1500 },
      ],
    },
    {
      name: "CCO Agent", role: "cco", title: "Chief Compliance Officer",
      capabilities: "Regulatory compliance, legal risk, licensing, audit log verification.",
      adapter: "claude_local", budget: 2000,
      children: [
        { name: "Compliance Reviewer", role: "compliance_reviewer", title: "Compliance Reviewer", capabilities: "Pre-trade compliance checks, regulatory filing preparation.", adapter: "process", budget: 1500 },
      ],
    },
    {
      name: "CHRO Agent", role: "chro", title: "Chief Human & Agent Resources Officer",
      capabilities: "Talent, agent workforce management, performance reviews.",
      adapter: "claude_local", budget: 2000,
      children: [
        { name: "People Ops", role: "people_ops", title: "People Operations", capabilities: "Sourcing, performance report drafting, onboarding.", adapter: "process", budget: 1500 },
      ],
    },
  ],
};

// ─── API Helpers ──────────────────────────────────────────

async function api(method, path, body) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

// Map custom roles to Paperclip's valid enum values
const ROLE_MAP = {
  ceo: "ceo", cio: "cfo", caio: "researcher", cto: "cto", cro: "cfo", coo: "pm", cfo: "cfo", cco: "pm", chro: "pm",
  macro_desk_head: "pm", macro_pm: "pm", macro_quant: "researcher",
  equities_desk_head: "pm", equities_pm: "pm", stat_arb_quant: "researcher",
  vol_desk_head: "pm", vol_pm: "pm", vol_quant: "researcher",
  hf_desk_head: "engineer", hf_trader: "engineer", hf_quant: "engineer",
  execution_head: "pm", execution_trader: "engineer",
  alpha_lead: "researcher", alpha_researcher: "researcher",
  microstructure_lead: "researcher", microstructure_researcher: "researcher",
  chief_economist: "researcher", econ_researcher: "researcher",
  research_platform_lead: "engineer",
  data_eng_lead: "devops", data_engineer: "devops",
  core_systems_lead: "engineer", systems_engineer: "engineer",
  platform_lead: "engineer", sre_lead: "devops",
  risk_monitor: "qa", stress_tester: "qa",
  ops_analyst: "pm", ir_agent: "cmo",
  controller: "cfo", compliance_reviewer: "qa",
  people_ops: "pm",
};

async function hireAndApprove(companyId, params, reportsTo) {
  const body = {
    name: params.name,
    role: ROLE_MAP[params.role] || "general",
    title: params.title,
    capabilities: `[${params.role}] ${params.capabilities}`,
    adapterType: params.adapter,
    adapterConfig: {},
    budgetMonthlyCents: params.budget,
  };
  if (reportsTo) body.reportsTo = reportsTo;

  const result = await api("POST", `/api/companies/${companyId}/agent-hires`, body);
  const agentId = result.agent?.id || result.id;
  const approvalId = result.approval?.id;

  // Auto-approve if approval is required
  if (approvalId) {
    await api("POST", `/api/approvals/${approvalId}/decide`, {
      decision: "approved",
      note: "Auto-approved by bootstrap script",
    });
  }

  return agentId;
}

// ─── Recursive Org Hire ──────────────────────────────────

async function hireTree(companyId, node, parentId, depth = 0) {
  const indent = "  ".repeat(depth);
  const agentId = await hireAndApprove(companyId, node, parentId);
  console.log(`${indent}✓ ${node.title} — ${node.name} [${agentId}]`);

  if (node.children) {
    for (const child of node.children) {
      await hireTree(companyId, child, agentId, depth + 1);
    }
  }

  return agentId;
}

// ─── Main ────────────────────────────────────────────────

async function main() {
  console.log("Paperclip Org Bootstrap — Inferred Analysis Quant Fund\n");

  // Check health
  const health = await api("GET", "/api/health");
  console.log(`Server: ${health.status} (v${health.version})\n`);

  // Get or create company
  let companyId = COMPANY_ID;
  if (!companyId) {
    const companies = await api("GET", "/api/companies");
    if (companies.length > 0) {
      companyId = companies[0].id;
      console.log(`Using existing company: ${companies[0].name} [${companyId}]\n`);
    } else {
      const company = await api("POST", "/api/companies", {
        name: "Inferred Analysis",
        description: "AI-native quantitative hedge fund and research lab",
      });
      companyId = company.id;
      console.log(`Created company: Inferred Analysis [${companyId}]\n`);
    }
  }

  // Disable board approval requirement for bulk hiring
  try {
    await api("PATCH", `/api/companies/${companyId}`, {
      requireBoardApprovalForNewAgents: false,
    });
  } catch {
    // May not be supported, continue with per-hire approval
  }

  console.log("Hiring org chart...\n");
  await hireTree(companyId, ORG_TREE, null);

  // Get final count
  const agents = await api("GET", `/api/companies/${companyId}/agents`);
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Total agents hired: ${agents.length}`);
  console.log(`Company ID: ${companyId}`);
  console.log(`Paperclip URL: ${BASE_URL}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  // Print org chart
  console.log("Org Chart:\n");
  const agentMap = new Map(agents.map(a => [a.id, a]));
  const roots = agents.filter(a => !a.reportsTo);
  function printTree(agent, depth = 0) {
    const prefix = depth === 0 ? "" : "  ".repeat(depth) + "├─ ";
    console.log(`${prefix}${agent.title || agent.role} — ${agent.name} [${agent.status}]`);
    const children = agents.filter(a => a.reportsTo === agent.id);
    for (const child of children) {
      printTree(child, depth + 1);
    }
  }
  for (const root of roots) {
    printTree(root);
  }
}

main().catch(err => {
  console.error("Bootstrap failed:", err.message);
  process.exit(1);
});
