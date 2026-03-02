/**
 * HTTP Proxy to Backend Services
 *
 * Forwards requests from the gateway to the appropriate backend
 * service and returns the response.
 */
import http from "http";

interface ProxyRequest {
  backend: string;  // e.g., "http://127.0.0.1:9000"
  path: string;     // e.g., "/analyze"
  method: string;
  body: string;
  headers: Record<string, string>;
  timeoutMs?: number;
}

interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Proxy a request to a backend service */
export function proxyRequest(req: ProxyRequest): Promise<ProxyResponse> {
  return new Promise((resolve) => {
    const timeout = req.timeoutMs ?? 30_000;

    try {
      const url = new URL(req.path, req.backend);

      const proxyReq = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method: req.method,
          headers: {
            ...req.headers,
            host: url.host,
          },
          timeout,
        },
        (proxyRes) => {
          let body = "";
          proxyRes.on("data", (chunk) => (body += chunk));
          proxyRes.on("end", () => {
            const headers: Record<string, string> = {};
            for (const [key, val] of Object.entries(proxyRes.headers)) {
              if (typeof val === "string") headers[key] = val;
            }
            resolve({
              status: proxyRes.statusCode ?? 500,
              headers,
              body,
            });
          });
        },
      );

      proxyReq.on("error", () => {
        resolve({
          status: 503,
          headers: {},
          body: JSON.stringify({ error: "Backend unreachable" }),
        });
      });

      proxyReq.on("timeout", () => {
        proxyReq.destroy();
        resolve({
          status: 504,
          headers: {},
          body: JSON.stringify({ error: "Backend timeout" }),
        });
      });

      if (req.body) {
        proxyReq.write(req.body);
      }
      proxyReq.end();
    } catch {
      resolve({
        status: 503,
        headers: {},
        body: JSON.stringify({ error: "Backend unreachable" }),
      });
    }
  });
}
