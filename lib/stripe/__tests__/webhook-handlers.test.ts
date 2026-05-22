// @vitest-environment node
//
// Tests for webhook handler idempotency, out-of-order delivery, and refund recording.
// All Stripe API calls are mocked — no live keys required.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import {
  handleCheckoutSessionCompleted,
  handleSubscriptionUpdated,
  handleInvoicePaid,
  handleChargeRefunded,
  handleDisputeEvent,
} from "../webhook-handlers";

// ── Stripe mock ──────────────────────────────────────────────────────────────

vi.mock("@/lib/stripe/client", () => ({ getStripe: vi.fn() }));
vi.mock("@/lib/stripe/transfers", () => ({
  getVendorCutBps: vi.fn().mockResolvedValue(2000),
  transferVendorShare: vi
    .fn()
    .mockResolvedValue({ transferId: "tr_test", vendorShareCents: 8000 }),
  transferAffiliateShare: vi
    .fn()
    .mockResolvedValue({ transferId: "tr_aff_test", affiliateShareCents: 100 }),
  reverseTransfers: vi.fn().mockResolvedValue(undefined),
  reverseVendorTransfers: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/services/affiliate", () => ({
  recordAttribution: vi.fn().mockResolvedValue(undefined),
}));

import { getStripe } from "@/lib/stripe/client";
import { reverseTransfers, reverseVendorTransfers, transferVendorShare } from "@/lib/stripe/transfers";

const mockGetStripe = vi.mocked(getStripe);

beforeEach(() => vi.clearAllMocks());

// ── Admin client mock factory ─────────────────────────────────────────────────
//
// Returns a minimal SupabaseClient double. Each `.from(table)` call returns a
// chainable object whose terminal methods (.single, .maybeSingle, direct await)
// resolve with the configured stub data for that table.

type TableStubs = {
  [table: string]: {
    select?: unknown;
    single?: unknown;
    upsertError?: string | null;
    updateError?: string | null;
  };
};

function makeAdmin(stubs: TableStubs = {}) {
  const upsertCalls: { table: string; data: unknown; opts: unknown }[] = [];
  const updateCalls: { table: string; data: unknown }[] = [];
  const insertCalls: { table: string; data: unknown }[] = [];

  function chain(resolveWith: { data: unknown; error: unknown }) {
    const obj: Record<string, unknown> = {
      eq: () => obj,
      neq: () => obj,
      gt: () => obj,
      gte: () => obj,
      lte: () => obj,
      in: () => obj,
      order: () => obj,
      limit: () => obj,
      range: () => obj,
      maybeSingle: () => Promise.resolve(resolveWith),
      single: () => Promise.resolve(resolveWith),
      // Thenable so `await admin.from(t).update().eq()` works
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(resolveWith).then(res, rej),
      catch: (rej: (e: unknown) => unknown) =>
        Promise.resolve(resolveWith).catch(rej),
    };
    return obj;
  }

  const client = {
    from: (table: string) => ({
      select: (_cols?: string) => {
        const s = stubs[table];
        const result = s?.select ?? s?.single ?? null;
        return chain({ data: result, error: null });
      },
      upsert: (data: unknown, opts?: unknown) => {
        upsertCalls.push({ table, data, opts });
        const err = stubs[table]?.upsertError ?? null;
        const result = { data: null as unknown, error: err ? { message: err } : null };
        // Support .select().maybeSingle() chaining (used by handleCheckoutSessionCompleted)
        const upsertObj: Record<string, unknown> = {
          ...result,
          select: (_cols?: string) => ({
            maybeSingle: () => Promise.resolve({ data: { id: "sub-uuid-mock" }, error: result.error }),
            single: () => Promise.resolve({ data: { id: "sub-uuid-mock" }, error: result.error }),
          }),
          then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
            Promise.resolve(result).then(res, rej),
        };
        return upsertObj;
      },
      update: (data: unknown) => {
        updateCalls.push({ table, data });
        const err = stubs[table]?.updateError ?? null;
        return chain({ data: null, error: err ? { message: err } : null });
      },
      insert: (data: unknown) => {
        insertCalls.push({ table, data });
        return Promise.resolve({ data: null, error: null });
      },
    }),
    _upserted: upsertCalls,
    _updated: updateCalls,
    _inserted: insertCalls,
  } as unknown as SupabaseClient<Database> & {
    _upserted: typeof upsertCalls;
    _updated: typeof updateCalls;
    _inserted: typeof insertCalls;
  };

  return client;
}

// ── Fixture builders ──────────────────────────────────────────────────────────

function makeCheckoutSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "cs_test_001",
    mode: "subscription",
    subscription: "sub_001",
    customer: "cus_001",
    metadata: {
      buyer_id: "buyer-uuid-001",
      app_id: "app-uuid-001",
      anon_user_id: "usr_AnonIdXyz123",
    },
    ...overrides,
  } as unknown as import("stripe").Stripe.Checkout.Session;
}

function makeStripeSub(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_001",
    status: "active",
    currency: "usd",
    cancel_at_period_end: false,
    canceled_at: null,
    items: {
      data: [{ price: { unit_amount: 2900 }, current_period_end: 1800000000 }],
    },
    ...overrides,
  } as unknown as import("stripe").Stripe.Subscription;
}

function makeInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: "in_001",
    amount_paid: 2900,
    parent: {
      type: "subscription_details",
      subscription_details: { subscription: "sub_001" },
    },
    payments: { data: [{ payment: { payment_intent: "pi_001" } }] },
    ...overrides,
  } as unknown as import("stripe").Stripe.Invoice;
}

function makeCharge(overrides: Record<string, unknown> = {}) {
  return {
    id: "ch_001",
    payment_intent: "pi_001",
    amount_refunded: 2900,
    refunds: { data: [{ amount: 2900 }] },
    ...overrides,
  } as unknown as import("stripe").Stripe.Charge;
}

// ── Tests: handleCheckoutSessionCompleted ─────────────────────────────────────

describe("handleCheckoutSessionCompleted", () => {
  beforeEach(() => {
    mockGetStripe.mockReturnValue({
      subscriptions: { retrieve: vi.fn().mockResolvedValue(makeStripeSub()) },
    } as unknown as ReturnType<typeof getStripe>);
  });

  it("upserts subscription with onConflict=stripe_subscription_id (idempotency)", async () => {
    const admin = makeAdmin();
    await handleCheckoutSessionCompleted(makeCheckoutSession(), admin);

    const sub = admin._upserted.find((u) => u.table === "subscriptions");
    expect(sub).toBeDefined();
    expect(sub?.opts).toMatchObject({ onConflict: "stripe_subscription_id" });
  });

  it("upserted subscription row contains correct buyer_id and anon_user_id", async () => {
    const admin = makeAdmin();
    await handleCheckoutSessionCompleted(makeCheckoutSession(), admin);

    const sub = admin._upserted.find((u) => u.table === "subscriptions");
    expect((sub?.data as Record<string, unknown>).buyer_id).toBe("buyer-uuid-001");
    expect((sub?.data as Record<string, unknown>).anon_user_id).toBe("usr_AnonIdXyz123");
  });

  it("calling twice with same session is safe — upsert runs twice (DB dedupes on conflict)", async () => {
    const admin = makeAdmin();
    await handleCheckoutSessionCompleted(makeCheckoutSession(), admin);
    await handleCheckoutSessionCompleted(makeCheckoutSession(), admin);
    // Both calls hit upsert; DB deduplication is via onConflict
    expect(admin._upserted.filter((u) => u.table === "subscriptions")).toHaveLength(2);
  });

  it("throws when metadata is missing buyer_id", async () => {
    const session = makeCheckoutSession({ metadata: { app_id: "x", anon_user_id: "y" } });
    await expect(handleCheckoutSessionCompleted(session, makeAdmin())).rejects.toThrow(
      /Missing metadata/
    );
  });

  it("throws when metadata is missing app_id", async () => {
    const session = makeCheckoutSession({
      metadata: { buyer_id: "b", anon_user_id: "y" },
    });
    await expect(handleCheckoutSessionCompleted(session, makeAdmin())).rejects.toThrow(
      /Missing metadata/
    );
  });

  it("skips non-subscription checkout sessions (mode != subscription)", async () => {
    const session = makeCheckoutSession({ mode: "payment" });
    const admin = makeAdmin();
    await handleCheckoutSessionCompleted(session, admin);
    expect(admin._upserted).toHaveLength(0);
  });

  it("writes an audit_log entry", async () => {
    const admin = makeAdmin();
    await handleCheckoutSessionCompleted(makeCheckoutSession(), admin);
    const log = admin._inserted.find((i) => i.table === "audit_log");
    expect(log).toBeDefined();
    expect((log?.data as Record<string, unknown>).action).toBe("subscription.created");
  });
});

// ── Tests: handleSubscriptionUpdated ─────────────────────────────────────────

describe("handleSubscriptionUpdated", () => {
  it("updates status and cancel_at_period_end", async () => {
    const admin = makeAdmin();
    const sub = makeStripeSub({ status: "past_due", cancel_at_period_end: true });
    await handleSubscriptionUpdated(sub, admin);

    const upd = admin._updated.find((u) => u.table === "subscriptions");
    expect(upd).toBeDefined();
    expect((upd?.data as Record<string, unknown>).status).toBe("past_due");
    expect((upd?.data as Record<string, unknown>).cancel_at_period_end).toBe(true);
  });

  it("does NOT throw when the row doesn't exist yet (out-of-order delivery)", async () => {
    // update on a non-existent row is a no-op in Postgres — should not throw
    const admin = makeAdmin({ subscriptions: { updateError: null } });
    const sub = makeStripeSub({ id: "sub_never_created" });
    await expect(handleSubscriptionUpdated(sub, admin)).resolves.toBeUndefined();
  });

  it("writes an audit_log entry on update", async () => {
    const admin = makeAdmin();
    await handleSubscriptionUpdated(makeStripeSub(), admin);
    const log = admin._inserted.find((i) => i.table === "audit_log");
    expect(log).toBeDefined();
    expect((log?.data as Record<string, unknown>).action).toBe("subscription.updated");
  });

  it("sets paused_until when pause_collection.resumes_at is present", async () => {
    const resumesAt = Math.floor(Date.now() / 1000) + 30 * 86400;
    const sub = makeStripeSub({
      pause_collection: { behavior: "void", resumes_at: resumesAt },
    });
    const admin = makeAdmin();
    await handleSubscriptionUpdated(sub, admin);

    const upd = admin._updated.find((u) => u.table === "subscriptions");
    const data = upd?.data as Record<string, unknown>;
    expect(data.paused_until).toBe(new Date(resumesAt * 1000).toISOString());
  });

  it("clears paused_until when pause_collection is null (resume)", async () => {
    const sub = makeStripeSub({ pause_collection: null });
    const admin = makeAdmin();
    await handleSubscriptionUpdated(sub, admin);

    const upd = admin._updated.find((u) => u.table === "subscriptions");
    expect((upd?.data as Record<string, unknown>).paused_until).toBeNull();
  });
});

// ── Tests: handleInvoicePaid ──────────────────────────────────────────────────

describe("handleInvoicePaid", () => {
  const APP_ID = "app-uuid-001";
  const VENDOR_ID = "vendor-uuid-001";
  const STRIPE_ACCOUNT = "acct_test";

  function makeStripeForInvoice() {
    return {
      subscriptions: { retrieve: vi.fn().mockResolvedValue(makeStripeSub()) },
      invoices: {
        retrieve: vi.fn().mockResolvedValue({
          ...makeInvoice(),
          payments: { data: [{ payment: { payment_intent: { id: "pi_001" } } }] },
        }),
      },
      paymentIntents: { update: vi.fn().mockResolvedValue({}) },
    } as unknown as ReturnType<typeof getStripe>;
  }

  function makeAdminForInvoice() {
    return makeAdmin({
      subscriptions: { select: { app_id: APP_ID, reseller_id: null } },
      apps: { single: { vendor_id: VENDOR_ID } },
      profiles: { single: { stripe_account_id: STRIPE_ACCOUNT } },
    });
  }

  beforeEach(() => {
    mockGetStripe.mockReturnValue(makeStripeForInvoice());
  });

  it("skips non-subscription invoices (parent.type != subscription_details)", async () => {
    const invoice = makeInvoice({ parent: { type: "quote_details" } });
    const admin = makeAdmin();
    await handleInvoicePaid(invoice, admin, "evt_001");
    expect(admin._upserted).toHaveLength(0);
  });

  it("skips invoice with no parent at all", async () => {
    const invoice = makeInvoice({ parent: null });
    const admin = makeAdmin();
    await handleInvoicePaid(invoice, admin, "evt_001");
    expect(admin._upserted).toHaveLength(0);
  });

  it("upserts vendor_revenue_event with ignoreDuplicates:true (idempotency)", async () => {
    const admin = makeAdminForInvoice();
    await handleInvoicePaid(makeInvoice(), admin, "evt_001");

    const rev = admin._upserted.find((u) => u.table === "vendor_revenue_events");
    expect(rev).toBeDefined();
    expect(rev?.opts).toMatchObject({ onConflict: "stripe_event_id", ignoreDuplicates: true });
  });

  it("revenue event carries the stripe_event_id for deduplication", async () => {
    const admin = makeAdminForInvoice();
    await handleInvoicePaid(makeInvoice(), admin, "evt_idempotency_key");

    const rev = admin._upserted.find((u) => u.table === "vendor_revenue_events");
    expect((rev?.data as Record<string, unknown>).stripe_event_id).toBe("evt_idempotency_key");
  });

  it("marks subscription status active on paid invoice", async () => {
    const admin = makeAdminForInvoice();
    await handleInvoicePaid(makeInvoice(), admin, "evt_001");

    const upd = admin._updated.find((u) => u.table === "subscriptions");
    expect((upd?.data as Record<string, unknown>).status).toBe("active");
  });

  it("calls transferVendorShare to pay out the vendor", async () => {
    const admin = makeAdminForInvoice();
    await handleInvoicePaid(makeInvoice(), admin, "evt_001");
    expect(transferVendorShare).toHaveBeenCalledWith(
      expect.objectContaining({ vendorId: VENDOR_ID, amountCents: 2900 })
    );
  });

  it("writes audit_log entry for invoice.paid", async () => {
    const admin = makeAdminForInvoice();
    await handleInvoicePaid(makeInvoice(), admin, "evt_001");
    const log = admin._inserted.find((i) => i.table === "audit_log");
    expect((log?.data as Record<string, unknown>).action).toBe("invoice.paid");
  });
});

// ── Tests: handleChargeRefunded ───────────────────────────────────────────────

describe("handleChargeRefunded", () => {
  it("skips if PaymentIntent has no transfer_group", async () => {
    mockGetStripe.mockReturnValue({
      paymentIntents: {
        retrieve: vi.fn().mockResolvedValue({ transfer_group: null }),
      },
    } as unknown as ReturnType<typeof getStripe>);

    const admin = makeAdmin();
    await handleChargeRefunded(makeCharge(), admin, "evt_refund_001");
    expect(reverseVendorTransfers).not.toHaveBeenCalled();
    expect(reverseTransfers).not.toHaveBeenCalled();
    expect(admin._upserted).toHaveLength(0);
  });

  it("skips if transfer_group does not start with 'invoice_'", async () => {
    mockGetStripe.mockReturnValue({
      paymentIntents: {
        retrieve: vi.fn().mockResolvedValue({ transfer_group: "other_group" }),
      },
    } as unknown as ReturnType<typeof getStripe>);

    const admin = makeAdmin();
    await handleChargeRefunded(makeCharge(), admin, "evt_refund_002");
    expect(reverseVendorTransfers).not.toHaveBeenCalled();
  });

  it("calls reverseVendorTransfers (not reverseTransfers) on voluntary refund", async () => {
    mockGetStripe.mockReturnValue({
      paymentIntents: {
        retrieve: vi.fn().mockResolvedValue({ transfer_group: "invoice_in_001" }),
      },
    } as unknown as ReturnType<typeof getStripe>);

    const admin = makeAdmin({
      vendor_revenue_events: {
        select: { vendor_id: "vendor-uuid-001", is_reseller_sale: false },
      },
    });

    await handleChargeRefunded(makeCharge(), admin, "evt_refund_003");
    expect(reverseVendorTransfers).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: "in_001" })
    );
    expect(reverseTransfers).not.toHaveBeenCalled();
  });

  it("records negative revenue event with ignoreDuplicates:true", async () => {
    mockGetStripe.mockReturnValue({
      paymentIntents: {
        retrieve: vi.fn().mockResolvedValue({ transfer_group: "invoice_in_001" }),
      },
    } as unknown as ReturnType<typeof getStripe>);

    const admin = makeAdmin({
      vendor_revenue_events: {
        select: { vendor_id: "vendor-uuid-001", is_reseller_sale: false },
      },
    });

    await handleChargeRefunded(makeCharge(), admin, "evt_refund_004");
    const rev = admin._upserted.find((u) => u.table === "vendor_revenue_events");
    expect(rev).toBeDefined();
    expect((rev?.data as Record<string, unknown>).amount_cents).toBeLessThan(0);
    expect(rev?.opts).toMatchObject({ onConflict: "stripe_event_id", ignoreDuplicates: true });
  });

  it("revenue event for refund uses stripe_event_id for deduplication", async () => {
    mockGetStripe.mockReturnValue({
      paymentIntents: {
        retrieve: vi.fn().mockResolvedValue({ transfer_group: "invoice_in_001" }),
      },
    } as unknown as ReturnType<typeof getStripe>);

    const admin = makeAdmin({
      vendor_revenue_events: {
        select: { vendor_id: "vendor-uuid-001", is_reseller_sale: false },
      },
    });

    await handleChargeRefunded(makeCharge(), admin, "evt_refund_dedup");
    const rev = admin._upserted.find((u) => u.table === "vendor_revenue_events");
    expect((rev?.data as Record<string, unknown>).stripe_event_id).toBe("evt_refund_dedup");
  });

  it("writes audit_log entry for charge.refunded", async () => {
    mockGetStripe.mockReturnValue({
      paymentIntents: {
        retrieve: vi.fn().mockResolvedValue({ transfer_group: "invoice_in_001" }),
      },
    } as unknown as ReturnType<typeof getStripe>);

    const admin = makeAdmin({
      vendor_revenue_events: {
        select: { vendor_id: "vendor-uuid-001", is_reseller_sale: false },
      },
    });

    await handleChargeRefunded(makeCharge(), admin, "evt_refund_005");
    const log = admin._inserted.find((i) => i.table === "audit_log");
    expect((log?.data as Record<string, unknown>).action).toBe("charge.refunded");
  });
});

// ── Tests: handleDisputeEvent ─────────────────────────────────────────────────

function makeDispute(overrides: Record<string, unknown> = {}) {
  return {
    id: "dp_001",
    charge: "ch_001",
    status: "lost",
    ...overrides,
  } as unknown as import("stripe").Stripe.Dispute;
}

describe("handleDisputeEvent", () => {
  function makeStripeForDispute(transferGroup: string | null = "invoice_in_001") {
    return {
      charges: { retrieve: vi.fn().mockResolvedValue({ payment_intent: "pi_001" }) },
      paymentIntents: { retrieve: vi.fn().mockResolvedValue({ transfer_group: transferGroup }) },
    } as unknown as ReturnType<typeof getStripe>;
  }

  it("reverses ALL transfers on charge.dispute.closed outcome=lost", async () => {
    mockGetStripe.mockReturnValue(makeStripeForDispute());
    const admin = makeAdmin();
    await handleDisputeEvent(makeDispute({ status: "lost" }), "charge.dispute.closed", admin);
    expect(reverseTransfers).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: "in_001" })
    );
    expect(reverseVendorTransfers).not.toHaveBeenCalled();
  });

  it("does NOT reverse on charge.dispute.closed outcome!=lost", async () => {
    mockGetStripe.mockReturnValue(makeStripeForDispute());
    const admin = makeAdmin();
    await handleDisputeEvent(makeDispute({ status: "won" }), "charge.dispute.closed", admin);
    expect(reverseTransfers).not.toHaveBeenCalled();
    expect(reverseVendorTransfers).not.toHaveBeenCalled();
  });

  it("does NOT reverse on charge.dispute.created — log only", async () => {
    mockGetStripe.mockReturnValue(makeStripeForDispute());
    const admin = makeAdmin();
    await handleDisputeEvent(makeDispute({ status: "needs_response" }), "charge.dispute.created", admin);
    expect(reverseTransfers).not.toHaveBeenCalled();
    expect(reverseVendorTransfers).not.toHaveBeenCalled();
  });

  it("skips reversal when transfer_group is not an invoice group", async () => {
    mockGetStripe.mockReturnValue(makeStripeForDispute("other_group"));
    const admin = makeAdmin();
    await handleDisputeEvent(makeDispute({ status: "lost" }), "charge.dispute.closed", admin);
    expect(reverseTransfers).not.toHaveBeenCalled();
  });

  it("writes audit_log entry for dispute event", async () => {
    mockGetStripe.mockReturnValue(makeStripeForDispute());
    const admin = makeAdmin();
    await handleDisputeEvent(makeDispute({ status: "lost" }), "charge.dispute.closed", admin);
    const log = admin._inserted.find((i) => i.table === "audit_log");
    expect((log?.data as Record<string, unknown>).action).toBe("charge.dispute.closed");
  });
});
