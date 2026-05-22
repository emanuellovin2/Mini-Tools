/**
 * Structured JSON logger for money/access flows and webhook processing.
 *
 * Rules:
 * - Every line is a single JSON object emitted to stdout/stderr.
 * - Never log PII (buyer email, name, card data) or secrets (API keys, webhook secrets).
 * - Use `event_id` / `entity_id` / `stripe_id` instead of raw user data.
 */

type LogLevel = "info" | "warn" | "error";

interface LogEntry {
  level: LogLevel;
  ts: string;
  event: string;
  [key: string]: unknown;
}

function emit(level: LogLevel, event: string, fields: Record<string, unknown>): void {
  const entry: LogEntry = { level, ts: new Date().toISOString(), event, ...fields };
  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

/** Log the outcome of a processed Stripe webhook event. */
export function logWebhookEvent(opts: {
  event_id: string;
  event_type: string;
  outcome: "processed" | "skipped" | "failed";
  latency_ms: number;
  error?: string;
}): void {
  emit(
    opts.outcome === "failed" ? "error" : "info",
    "webhook.processed",
    {
      event_id: opts.event_id,
      event_type: opts.event_type,
      outcome: opts.outcome,
      latency_ms: opts.latency_ms,
      ...(opts.error ? { error: opts.error } : {}),
    }
  );
}

/** Log a money-flow event (invoice paid, transfer, refund, dispute). */
export function logMoneyFlow(opts: {
  action: string;
  entity_id: string | null;
  amount_cents?: number;
  net_amount_cents?: number;
  vendor_id?: string;
  transfer_id?: string;
  cut_bps?: number;
  invoice_id?: string;
  is_reseller_sale?: boolean;
}): void {
  emit("info", "money.flow", opts as Record<string, unknown>);
}

/** Log an access-control event (subscription created/updated, token issued). */
export function logAccessEvent(opts: {
  action: string;
  entity_id: string | null;
  app_id?: string;
  status?: string;
}): void {
  emit("info", "access.event", opts as Record<string, unknown>);
}

/** Log a reconciliation run result. */
export function logReconciliation(opts: {
  status: "ok" | "drift_found" | "failed";
  drift_count: number;
  latency_ms: number;
  error?: string;
}): void {
  emit(
    opts.status === "failed" ? "error" : opts.drift_count > 0 ? "warn" : "info",
    "reconciliation.run",
    opts as Record<string, unknown>
  );
}

/** Log a sent email (type + outcome only — no recipient address or content). */
export function logEmail(opts: {
  template: string;
  outcome: "sent" | "skipped" | "failed";
  error?: string;
}): void {
  emit(
    opts.outcome === "failed" ? "error" : "info",
    "email.sent",
    opts as Record<string, unknown>
  );
}
