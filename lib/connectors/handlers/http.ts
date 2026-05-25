/**
 * HTTP connector handler — no auth required.
 * Universal escape hatch: any workflow can hit any HTTP endpoint.
 */

export interface HttpCredentials {
  // no credentials needed
}

export interface HttpInput {
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: string;
  timeout_ms?: number;
}

export interface HttpOutput {
  status: number;
  ok: boolean;
  body: string;
  headers: Record<string, string>;
}

const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;

export async function executeHttpAction(
  actionId: string,
  input: HttpInput,
  _credentials: HttpCredentials
): Promise<HttpOutput> {
  if (actionId !== "send_request") {
    throw new Error(`http connector: unknown action '${actionId}'`);
  }

  const method = (input.method ?? "POST").toUpperCase();
  const timeoutMs = Math.min(input.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

  const res = await fetch(input.url, {
    method,
    headers: input.headers,
    body: method !== "GET" && method !== "DELETE" ? input.body : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });

  const rawText = await res.text();
  const body =
    rawText.length > MAX_BODY_BYTES
      ? rawText.slice(0, MAX_BODY_BYTES) + "…[truncated]"
      : rawText;

  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return { status: res.status, ok: res.ok, body, headers };
}
