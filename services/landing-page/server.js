/**
 * Datchi Landing Page Server
 *
 * Minimal Node.js HTTP server (ESM, no framework, no external deps).
 * Serves the Datchi API marketing + docs site.
 *
 * Routes:
 *   GET /          — Landing page (HTML)
 *   GET /health    — Health check (JSON)
 *   GET /api-docs  — OpenAPI-like endpoint schema (JSON)
 *
 * Usage:
 *   node server.js
 *   LANDING_PORT=8080 node server.js
 */

import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.LANDING_PORT ?? '3000', 10);
const WALLET_ADDRESS = process.env.WALLET_ADDRESS || process.env.GATEWAY_WALLET_ADDRESS || null;

// ── OpenAPI-like schema ──────────────────────────────────────────

const API_DOCS = {
  openapi: '3.0.0',
  info: {
    title: 'Datchi API',
    version: '1.0.0',
    description: 'AI-powered analysis, pay-per-call with crypto via x402 protocol',
    contact: {
      name: 'Datchi Automaton',
      url: 'https://datchi.example.com',
    },
  },
  servers: [
    { url: 'https://datchi.example.com', description: 'Production' },
    { url: 'http://localhost:7402', description: 'Local development' },
  ],
  info_payment: {
    protocol: 'x402',
    network: 'base (eip155:8453)',
    token: 'USDC',
    tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    recipient: WALLET_ADDRESS ?? 'not-configured',
    facilitator: 'https://x402.org/facilitator',
  },
  paths: {
    '/health': {
      get: {
        summary: 'Health check',
        description: 'Returns server uptime and status. Free endpoint — no payment required.',
        price: 'free',
        responses: {
          200: {
            description: 'Server is alive',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'alive' },
                    uptime: { type: 'number', example: 3600 },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/info': {
      get: {
        summary: 'API information',
        description: 'Returns available endpoints and payment configuration. Free endpoint.',
        price: 'free',
        responses: {
          200: {
            description: 'API info',
          },
        },
      },
    },
    '/summarize': {
      post: {
        summary: 'Text summarization',
        description: 'High-volume text summarization up to 4K tokens.',
        price: '$0.25 USDC',
        priceUsd: 0.25,
        tokenLimit: '4K tokens',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['content'],
                properties: {
                  content: {
                    type: 'string',
                    description: 'Text content to summarize (max ~4K tokens)',
                    example: 'Your long-form text content here...',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Summary result',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    summary: { type: 'string' },
                    wordCount: { type: 'number' },
                    model: { type: 'string' },
                  },
                },
              },
            },
          },
          402: { description: 'Payment required — include X-Payment header' },
        },
      },
    },
    '/brief': {
      post: {
        summary: 'Structured brief',
        description: 'Structured brief with findings and recommendations. Supports up to 16K tokens.',
        price: '$2.50 USDC',
        priceUsd: 2.50,
        tokenLimit: '16K tokens',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['content'],
                properties: {
                  content: { type: 'string', description: 'Content to brief (max ~16K tokens)' },
                  format: {
                    type: 'string',
                    enum: ['executive', 'technical', 'strategic'],
                    description: 'Brief output format',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Structured brief with findings and recommendations' },
          402: { description: 'Payment required' },
        },
      },
    },
    '/brief-premium': {
      post: {
        summary: 'Deep-dive premium brief',
        description: 'Deep-dive analysis with competitive landscape. Supports up to 64K tokens.',
        price: '$15.00 USDC',
        priceUsd: 15.00,
        tokenLimit: '64K tokens',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['content'],
                properties: {
                  content: { type: 'string', description: 'Content to analyze (max ~64K tokens)' },
                  includeCompetitive: {
                    type: 'boolean',
                    default: true,
                    description: 'Include competitive landscape analysis',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Deep-dive analysis with competitive landscape' },
          402: { description: 'Payment required' },
        },
      },
    },
    '/analyze': {
      post: {
        summary: 'Text analysis',
        description: 'Text analysis returning sentiment, entities, and keywords. Up to 2K tokens.',
        price: '$0.01 USDC',
        priceUsd: 0.01,
        tokenLimit: '2K tokens',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['content'],
                properties: {
                  content: { type: 'string', description: 'Text to analyze (max ~2K tokens)' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Analysis result',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    sentiment: { type: 'object', properties: { label: { type: 'string' }, score: { type: 'number' } } },
                    entities: { type: 'array', items: { type: 'object' } },
                    keywords: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
            },
          },
          402: { description: 'Payment required' },
        },
      },
    },
    '/trustcheck': {
      post: {
        summary: 'Trust and reputation verification',
        description: 'Verify trust and reputation signals for a given entity. Up to 1K tokens.',
        price: '$0.05 USDC',
        priceUsd: 0.05,
        tokenLimit: '1K tokens',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['entity'],
                properties: {
                  entity: {
                    type: 'string',
                    description: 'Entity to check (domain, address, name, etc.)',
                    example: 'example.com',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Trust verification result',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    trustScore: { type: 'number', minimum: 0, maximum: 100 },
                    signals: { type: 'array', items: { type: 'object' } },
                    verdict: { type: 'string', enum: ['trusted', 'neutral', 'suspicious', 'malicious'] },
                  },
                },
              },
            },
          },
          402: { description: 'Payment required' },
        },
      },
    },
    '/summarize-url': {
      post: {
        summary: 'URL content summarization',
        description: 'Fetch and summarize content from a URL.',
        price: '$0.01 USDC',
        priceUsd: 0.01,
        tokenLimit: 'URL content',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['url'],
                properties: {
                  url: {
                    type: 'string',
                    format: 'uri',
                    description: 'URL to fetch and summarize',
                    example: 'https://example.com/article',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'URL summary',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    url: { type: 'string' },
                    title: { type: 'string' },
                    summary: { type: 'string' },
                  },
                },
              },
            },
          },
          402: { description: 'Payment required' },
        },
      },
    },
  },
};

// ── HTML cache ───────────────────────────────────────────────────

let htmlCache = null;

async function getHtml() {
  if (htmlCache !== null) return htmlCache;
  const htmlPath = join(__dirname, 'index.html');
  let raw = await readFile(htmlPath, 'utf8');
  const walletDisplay = WALLET_ADDRESS ?? 'Wallet address not configured';
  const walletTitle = WALLET_ADDRESS ? 'Click to copy' : '';
  raw = raw.replace('{{WALLET_ADDRESS}}', walletDisplay);
  raw = raw.replace('{{WALLET_TITLE}}', walletTitle);
  htmlCache = raw;
  return htmlCache;
}

// ── Request handlers ─────────────────────────────────────────────

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  });
  res.end(html);
}

function notFound(res) {
  sendJson(res, 404, { error: 'Not Found' });
}

// ── Server ───────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method.toUpperCase();

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  if (method !== 'GET') {
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  try {
    if (path === '/') {
      const html = await getHtml();
      sendHtml(res, 200, html);
      return;
    }

    if (path === '/health') {
      sendJson(res, 200, {
        status: 'alive',
        service: 'datchi-landing-page',
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (path === '/api-docs') {
      sendJson(res, 200, API_DOCS);
      return;
    }

    notFound(res);
  } catch (err) {
    console.error('[landing-page] Request error:', err);
    sendJson(res, 500, { error: 'Internal Server Error' });
  }
});

server.listen(PORT, () => {
  console.log(`[Datchi Landing Page] Listening on http://localhost:${PORT}`);
  console.log(`[Datchi Landing Page] Routes: GET /  GET /health  GET /api-docs`);
});

server.on('error', (err) => {
  console.error('[Datchi Landing Page] Server error:', err);
  process.exit(1);
});
