/**
 * CSV export registry.
 *
 * Each scope defines a function that returns rows scoped to the caller's org/user.
 * For ≤10k rows: stream direct. For >10k: enqueue job → email ZIP link.
 *
 * Scopes follow "role.table" naming so the ExportButton can reference them
 * without knowing the underlying query.
 */
import { createAdminClient } from "@/lib/services/supabase";
import { enqueueJob } from "@/lib/jobs/queue";

type AnyClient = ReturnType<typeof createAdminClient>;

export type ExportScope =
  | "vendor.subscriptions"
  | "vendor.payouts"
  | "vendor.refunds"
  | "reseller.sales"
  | "reseller.payouts"
  | "reseller.offers"
  | "affiliate.links"
  | "affiliate.sales"
  | "affiliate.payouts"
  | "buyer.invoices"
  | "buyer.subscriptions"
  | "admin.subscriptions"
  | "admin.audit_log"
  | "admin.payouts";

export type ExportRow = Record<string, string | number | boolean | null>;

interface ScopeHandler {
  /** Returns all rows; called with the admin client + caller context. */
  query(admin: AnyClient, ctx: ExportContext): Promise<ExportRow[]>;
  filename: string;
}

export interface ExportContext {
  userId: string;
  orgId: string;
  role: string;
}

// ---------------------------------------------------------------------------
// Scope registry
// ---------------------------------------------------------------------------

const SCOPES: Record<ExportScope, ScopeHandler> = {
  "vendor.subscriptions": {
    filename: "vendor_subscriptions.csv",
    async query(admin, ctx) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (admin as any)
        .from("subscriptions")
        .select("id, status, price_cents, created_at, cancel_at_period_end, affiliate_id, reseller_id, vendor_id")
        .eq("vendor_id", ctx.userId)
        .order("created_at", { ascending: false });
      return ((data ?? []) as ExportRow[]).map((r) => {
        const { vendor_id: _drop, ...rest } = r as ExportRow & { vendor_id: unknown };
        void _drop;
        return { ...rest, channel: r.affiliate_id ? "affiliate" : r.reseller_id ? "reseller" : "direct" };
      });
    },
  },
  "vendor.payouts": {
    filename: "vendor_payouts.csv",
    async query(admin, ctx) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (admin as any)
        .from("vendor_billing")
        .select("id, period_start, period_end, gross_revenue_cents, cut_bps, created_at")
        .eq("vendor_id", ctx.userId)
        .order("period_start", { ascending: false });
      return (data ?? []) as ExportRow[];
    },
  },
  "vendor.refunds": {
    filename: "vendor_refunds.csv",
    async query(admin, ctx) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (admin as any)
        .from("vendor_revenue_events")
        .select("id, amount_cents, net_amount_cents, created_at")
        .eq("vendor_id", ctx.userId)
        .order("created_at", { ascending: false });
      return (data ?? []) as ExportRow[];
    },
  },
  "reseller.sales": {
    filename: "reseller_sales.csv",
    async query(admin, ctx) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (admin as any)
        .from("reseller_subscriptions")
        .select("id, status, created_at")
        .eq("reseller_id", ctx.userId)
        .order("created_at", { ascending: false });
      return (data ?? []) as ExportRow[];
    },
  },
  "reseller.payouts": {
    filename: "reseller_payouts.csv",
    async query(admin, ctx) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (admin as any)
        .from("vendor_billing")
        .select("id, period_start, period_end, created_at")
        .eq("reseller_id", ctx.userId)
        .order("period_start", { ascending: false });
      return (data ?? []) as ExportRow[];
    },
  },
  "reseller.offers": {
    filename: "reseller_offers.csv",
    async query(admin, ctx) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (admin as any)
        .from("reseller_offers")
        .select("id, app_id, slug, status, wl_tier, created_at")
        .eq("reseller_id", ctx.userId)
        .order("created_at", { ascending: false });
      return (data ?? []) as ExportRow[];
    },
  },
  "affiliate.links": {
    filename: "affiliate_links.csv",
    async query(admin, ctx) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (admin as any)
        .from("affiliate_links")
        .select("id, app_id, code, created_at")
        .eq("affiliate_id", ctx.userId)
        .order("created_at", { ascending: false });
      return (data ?? []) as ExportRow[];
    },
  },
  "affiliate.sales": {
    filename: "affiliate_sales.csv",
    async query(admin, ctx) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (admin as any)
        .from("affiliate_attributions")
        .select("id, app_id, commission_bps, created_at")
        .eq("affiliate_id", ctx.userId)
        .order("created_at", { ascending: false });
      return (data ?? []) as ExportRow[];
    },
  },
  "affiliate.payouts": {
    filename: "affiliate_payouts.csv",
    async query(admin, ctx) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (admin as any)
        .from("affiliate_attributions")
        .select("id, app_id, commission_bps, created_at")
        .eq("affiliate_id", ctx.userId)
        .order("created_at", { ascending: false });
      return (data ?? []) as ExportRow[];
    },
  },
  "buyer.invoices": {
    filename: "buyer_invoices.csv",
    async query(admin, ctx) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (admin as any)
        .from("subscriptions")
        .select("id, app_id, status, price_cents, created_at")
        .eq("buyer_id", ctx.userId)
        .order("created_at", { ascending: false });
      return (data ?? []) as ExportRow[];
    },
  },
  "buyer.subscriptions": {
    filename: "buyer_subscriptions.csv",
    async query(admin, ctx) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (admin as any)
        .from("subscriptions")
        .select("id, app_id, status, price_cents, cancel_at_period_end, created_at")
        .eq("buyer_id", ctx.userId)
        .order("created_at", { ascending: false });
      return (data ?? []) as ExportRow[];
    },
  },
  "admin.subscriptions": {
    filename: "all_subscriptions.csv",
    async query(admin) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (admin as any)
        .from("subscriptions")
        .select("id, app_id, status, price_cents, created_at, affiliate_id, reseller_id")
        .order("created_at", { ascending: false })
        .limit(50_000);
      return (data ?? []) as ExportRow[];
    },
  },
  "admin.audit_log": {
    filename: "audit_log.csv",
    async query(admin) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (admin as any)
        .from("audit_log")
        .select("id, actor_id, actor_role, action, entity_type, entity_id, created_at")
        .order("created_at", { ascending: false })
        .limit(50_000);
      return (data ?? []) as ExportRow[];
    },
  },
  "admin.payouts": {
    filename: "all_payouts.csv",
    async query(admin) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (admin as any)
        .from("vendor_billing")
        .select("id, vendor_id, period_start, period_end, gross_revenue_cents, created_at")
        .order("period_start", { ascending: false })
        .limit(50_000);
      return (data ?? []) as ExportRow[];
    },
  },
};

// ---------------------------------------------------------------------------
// CSV serialisation
// ---------------------------------------------------------------------------

function toCsv(rows: ExportRow[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  return [
    headers.join(","),
    ...rows.map((r) => headers.map((h) => escape(r[h])).join(",")),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Run export synchronously (≤10k rows) and return CSV string. */
export async function runExportDirect(
  scope: ExportScope,
  ctx: ExportContext
): Promise<{ csv: string; filename: string }> {
  const handler = SCOPES[scope];
  if (!handler) throw new Error(`Unknown export scope: ${scope}`);
  const admin = createAdminClient();
  const rows = await handler.query(admin, ctx);
  return { csv: toCsv(rows), filename: handler.filename };
}

/** Enqueue async export job for large datasets (>10k rows → email ZIP). */
export async function enqueueExport(
  scope: ExportScope,
  ctx: ExportContext,
  emailTo: string
): Promise<{ jobId: string }> {
  return enqueueJob(
    "export",
    { scope, userId: ctx.userId, orgId: ctx.orgId, role: ctx.role, emailTo },
    {
      idempotencyKey: `export:${ctx.userId}:${scope}:${new Date().toISOString().slice(0, 13)}`,
      orgId: ctx.orgId,
    }
  );
}

/** Auto-route: direct for ≤10k rows, async otherwise. Returns CSV or jobId. */
export async function triggerExport(
  scope: ExportScope,
  ctx: ExportContext,
  emailTo: string
): Promise<
  | { mode: "direct"; csv: string; filename: string }
  | { mode: "async"; jobId: string }
> {
  const handler = SCOPES[scope];
  if (!handler) throw new Error(`Unknown export scope: ${scope}`);
  const admin = createAdminClient();
  const rows = await handler.query(admin, ctx);
  if (rows.length <= 10_000) {
    return { mode: "direct", csv: toCsv(rows), filename: handler.filename };
  }
  const { jobId } = await enqueueExport(scope, ctx, emailTo);
  return { mode: "async", jobId };
}
