import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks ---

const mockStripeAccountsCreate = vi.fn();
const mockStripeAccountsRetrieve = vi.fn();
const mockStripeAccountLinksCreate = vi.fn();

vi.mock("@/lib/stripe/client", () => ({
  getStripe: () => ({
    accounts: {
      create: mockStripeAccountsCreate,
      retrieve: mockStripeAccountsRetrieve,
    },
    accountLinks: {
      create: mockStripeAccountLinksCreate,
    },
  }),
}));

const mockAdminFrom = vi.fn();
vi.mock("@/lib/services/supabase", () => ({
  createAdminClient: () => ({ from: mockAdminFrom }),
}));

import { getOrCreateConnectAccount, createOnboardingLink, syncConnectStatus } from "../connect";

// Helper to build chainable Supabase mock
function buildQuery(result: unknown) {
  const q: Record<string, ReturnType<typeof vi.fn>> = {
    select: vi.fn(),
    eq: vi.fn(),
    update: vi.fn(),
    single: vi.fn(),
    maybeSingle: vi.fn(),
  };
  q.select.mockReturnValue(q);
  q.eq.mockReturnValue(q);
  q.update.mockReturnValue(q);
  q.single.mockResolvedValue(result);
  q.maybeSingle.mockResolvedValue(result);
  q.update.mockImplementation(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) }));
  return q;
}

// Chainable query that returns null from maybeSingle (no org found — safe no-op)
function buildNullQuery() {
  return buildQuery({ data: null, error: null });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getOrCreateConnectAccount", () => {
  it("returns existing account_id without calling Stripe", async () => {
    const query = buildQuery({ data: { stripe_account_id: "acct_existing" }, error: null });
    mockAdminFrom.mockReturnValue(query);

    const id = await getOrCreateConnectAccount("vendor-uuid");
    expect(id).toBe("acct_existing");
    expect(mockStripeAccountsCreate).not.toHaveBeenCalled();
  });

  it("creates new account when none exists and stores it", async () => {
    // call 1: profiles select (no account)
    const selectQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { stripe_account_id: null }, error: null }),
    };
    // call 2: profiles update (store account id)
    const updateProfilesQuery = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null }),
    };
    // call 3: org_members select (no personal org — safe no-op)
    const orgMembersQuery = buildNullQuery();
    mockAdminFrom
      .mockReturnValueOnce(selectQuery)
      .mockReturnValueOnce(updateProfilesQuery)
      .mockReturnValueOnce(orgMembersQuery);

    mockStripeAccountsCreate.mockResolvedValue({ id: "acct_new" });

    const id = await getOrCreateConnectAccount("vendor-uuid");
    expect(id).toBe("acct_new");
    expect(mockStripeAccountsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ type: "express" }),
      expect.objectContaining({ idempotencyKey: "acct_create:vendor_vendor-uuid" })
    );
  });

  it("uses idempotency key so re-runs return same account", async () => {
    const selectQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { stripe_account_id: null }, error: null }),
    };
    const updateQuery = {
      update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
    };
    const orgMembersQuery = buildNullQuery();
    mockAdminFrom
      .mockReturnValueOnce(selectQuery)
      .mockReturnValueOnce(updateQuery)
      .mockReturnValueOnce(orgMembersQuery);

    mockStripeAccountsCreate.mockResolvedValue({ id: "acct_idempotent" });

    await getOrCreateConnectAccount("vendor-uuid");
    const [, opts] = mockStripeAccountsCreate.mock.calls[0];
    expect(opts.idempotencyKey).toBe("acct_create:vendor_vendor-uuid");
  });
});

describe("createOnboardingLink", () => {
  it("returns the account link url", async () => {
    mockStripeAccountLinksCreate.mockResolvedValue({ url: "https://connect.stripe.com/onboard/123" });
    const url = await createOnboardingLink("acct_abc", "https://app/return", "https://app/refresh");
    expect(url).toBe("https://connect.stripe.com/onboard/123");
    expect(mockStripeAccountLinksCreate).toHaveBeenCalledWith(
      expect.objectContaining({ account: "acct_abc", type: "account_onboarding" })
    );
  });
});

describe("syncConnectStatus", () => {
  it("updates charges_enabled and payouts_enabled on profiles and organizations", async () => {
    mockStripeAccountsRetrieve.mockResolvedValue({
      charges_enabled: true,
      payouts_enabled: false,
    });

    const updateEq = vi.fn().mockResolvedValue({ error: null });
    const updateQuery = { update: vi.fn().mockReturnValue({ eq: updateEq }) };
    // Both profiles and organizations updates use the same mock shape
    mockAdminFrom.mockReturnValue(updateQuery);

    const result = await syncConnectStatus("vendor-uuid", "acct_abc");
    expect(result).toEqual({ charges_enabled: true, payouts_enabled: false });
    expect(updateQuery.update).toHaveBeenCalledWith({ charges_enabled: true, payouts_enabled: false });
  });
});
