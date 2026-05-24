/**
 * HTTP step — makes an outbound HTTP request and returns the response body.
 *
 * Config:
 *   {
 *     "url": "https://hooks.example.com/notify",
 *     "method": "POST",          // GET | POST | PUT | PATCH | DELETE
 *     "headers": { "X-Key": "{{trigger.api_key}}" },
 *     "body_template": "{{prior_step.result.text}}",  // string or object template
 *     "timeout_ms": 10000
 *   }
 *
 * URL and headers are expanded via the transform template engine before the call.
 * Response bodies > 64 KB are truncated in the output (stored as run_step.output).
 */

import { expandTemplate, applyMapping } from "./transform";

export interface HttpConfig {
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body_template?: string | Record<string, unknown>;
  timeout_ms?: number;
}

export interface HttpInput {
  context: Record<string, unknown>;
}

export interface HttpOutput {
  status: number;
  ok: boolean;
  body: string;
  headers: Record<string, string>;
}

const MAX_BODY_BYTES = 64 * 1024; // 64 KB stored in run_step.output
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;

export async function runHttpStep(
  config: HttpConfig,
  input: HttpInput
): Promise<HttpOutput> {
  if (!config.url) throw new Error("http: config.url is required");

  const method = (config.method ?? "POST").toUpperCase();
  const url = expandTemplate(config.url, input.context);

  const resolvedHeaders: Record<string, string> = {};
  if (config.headers) {
    for (const [k, v] of Object.entries(config.headers)) {
      resolvedHeaders[k] = expandTemplate(v, input.context);
    }
  }

  let body: BodyInit | undefined;
  if (config.body_template !== undefined && method !== "GET" && method !== "DELETE") {
    if (typeof config.body_template === "string") {
      body = expandTemplate(config.body_template, input.context);
      resolvedHeaders["Content-Type"] ??= "text/plain";
    } else {
      const resolved = applyMapping(config.body_template, input.context);
      body = JSON.stringify(resolved);
      resolvedHeaders["Content-Type"] ??= "application/json";
    }
  }

  const timeoutMs = Math.min(
    config.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS
  );

  const res = await fetch(url, {
    method,
    headers: resolvedHeaders,
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });

  const rawText = await res.text();
  const truncated =
    rawText.length > MAX_BODY_BYTES ? rawText.slice(0, MAX_BODY_BYTES) + "…[truncated]" : rawText;

  const resHeaders: Record<string, string> = {};
  res.headers.forEach((value, key) => { resHeaders[key] = value; });

  return {
    status: res.status,
    ok: res.ok,
    body: truncated,
    headers: resHeaders,
  };
}
