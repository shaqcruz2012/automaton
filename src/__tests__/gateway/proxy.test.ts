import { describe, it, expect, afterAll } from "vitest";
import http from "http";
import { proxyRequest } from "../../gateway/proxy.js";

// Spin up a tiny backend for testing
let mockServer: http.Server;
let mockPort: number;

const setupMockBackend = (): Promise<void> =>
  new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ echo: body, method: req.method, url: req.url }));
      });
    });
    mockServer.listen(0, "127.0.0.1", () => {
      mockPort = (mockServer.address() as any).port;
      resolve();
    });
  });

describe("proxy", () => {
  afterAll(() => mockServer?.close());

  it("proxies a POST request and returns the response", async () => {
    await setupMockBackend();
    const result = await proxyRequest({
      backend: `http://127.0.0.1:${mockPort}`,
      path: "/analyze",
      method: "POST",
      body: JSON.stringify({ content: "hello world" }),
      headers: { "content-type": "application/json" },
      timeoutMs: 5000,
    });

    expect(result.status).toBe(200);
    const parsed = JSON.parse(result.body);
    expect(parsed.method).toBe("POST");
    expect(parsed.echo).toContain("hello world");
  });

  it("returns 503 when backend is unreachable", async () => {
    const result = await proxyRequest({
      backend: "http://127.0.0.1:1", // nothing listening
      path: "/test",
      method: "GET",
      body: "",
      headers: {},
      timeoutMs: 2000,
    });
    expect(result.status).toBe(503);
    expect(result.body).toContain("Backend unreachable");
  });
});
