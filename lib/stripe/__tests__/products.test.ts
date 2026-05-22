import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks ---

const mockProductsCreate = vi.fn();
const mockPricesCreate = vi.fn();

vi.mock("@/lib/stripe/client", () => ({
  getStripe: () => ({
    products: { create: mockProductsCreate },
    prices: { create: mockPricesCreate },
  }),
}));

const mockAdminFrom = vi.fn();
vi.mock("@/lib/services/supabase", () => ({
  createAdminClient: () => ({ from: mockAdminFrom }),
}));

import { approveAppWithStripe, updateAppPrice } from "../products";

beforeEach(() => {
  vi.clearAllMocks();
});

function buildAppQuery(app: Record<string, unknown>) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: app, error: null }),
  };
}

function buildUpdateQuery() {
  const eq = vi.fn().mockResolvedValue({ error: null });
  return { update: vi.fn().mockReturnValue({ eq }) };
}

describe("approveAppWithStripe", () => {
  it("creates Product and Price and sets status=approved", async () => {
    const appQuery = buildAppQuery({
      id: "app-1",
      name: "My App",
      price_cents: 4900,
      currency: "usd",
      stripe_product_id: null,
      stripe_price_id: null,
      vendor_id: "vendor-1",
      status: "pending",
    });
    const vendorQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { charges_enabled: true }, error: null }),
    };
    const updateQuery = buildUpdateQuery();

    mockAdminFrom
      .mockReturnValueOnce(appQuery)
      .mockReturnValueOnce(vendorQuery)
      .mockReturnValueOnce(updateQuery);

    mockProductsCreate.mockResolvedValue({ id: "prod_abc" });
    mockPricesCreate.mockResolvedValue({ id: "price_xyz" });

    const result = await approveAppWithStripe("app-1");
    expect(result).toEqual({ productId: "prod_abc", priceId: "price_xyz" });

    // Product idempotency key
    expect(mockProductsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: "My App", metadata: { app_id: "app-1" } }),
      expect.objectContaining({ idempotencyKey: "product_create:app_app-1" })
    );

    // Price idempotency key includes amount
    expect(mockPricesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ unit_amount: 4900, currency: "usd", product: "prod_abc" }),
      expect.objectContaining({ idempotencyKey: "price_create:app_app-1:4900" })
    );

    // Update sets status=approved
    expect(updateQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "approved", stripe_product_id: "prod_abc", stripe_price_id: "price_xyz" })
    );
  });

  it("is idempotent — reuses existing product if already stored", async () => {
    const appQuery = buildAppQuery({
      id: "app-1",
      name: "My App",
      price_cents: 4900,
      currency: "usd",
      stripe_product_id: "prod_existing",
      stripe_price_id: null,
      vendor_id: "vendor-1",
      status: "pending",
    });
    const vendorQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { charges_enabled: true }, error: null }),
    };
    const updateQuery = buildUpdateQuery();

    mockAdminFrom
      .mockReturnValueOnce(appQuery)
      .mockReturnValueOnce(vendorQuery)
      .mockReturnValueOnce(updateQuery);

    mockPricesCreate.mockResolvedValue({ id: "price_new" });

    await approveAppWithStripe("app-1");
    expect(mockProductsCreate).not.toHaveBeenCalled();
    expect(mockPricesCreate).toHaveBeenCalledTimes(1);
  });

  it("throws if vendor is not charges_enabled", async () => {
    const appQuery = buildAppQuery({
      id: "app-1",
      name: "My App",
      price_cents: 4900,
      currency: "usd",
      stripe_product_id: null,
      stripe_price_id: null,
      vendor_id: "vendor-1",
      status: "pending",
    });
    const vendorQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { charges_enabled: false }, error: null }),
    };

    mockAdminFrom
      .mockReturnValueOnce(appQuery)
      .mockReturnValueOnce(vendorQuery);

    await expect(approveAppWithStripe("app-1")).rejects.toThrow("onboarding");
  });
});

describe("updateAppPrice", () => {
  it("creates a new Price and updates the app row atomically", async () => {
    const appQuery = buildAppQuery({
      stripe_product_id: "prod_abc",
      currency: "usd",
    });
    const updateQuery = buildUpdateQuery();

    mockAdminFrom
      .mockReturnValueOnce(appQuery)
      .mockReturnValueOnce(updateQuery);

    mockPricesCreate.mockResolvedValue({ id: "price_new" });

    const { priceId } = await updateAppPrice("app-1", 7900);
    expect(priceId).toBe("price_new");
    expect(mockPricesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ unit_amount: 7900, product: "prod_abc" }),
      expect.objectContaining({ idempotencyKey: "price_create:app_app-1:7900" })
    );
    expect(updateQuery.update).toHaveBeenCalledWith({ price_cents: 7900, stripe_price_id: "price_new" });
  });

  it("creates a different Price id when price changes (idempotency key encodes amount)", async () => {
    const appQuery = buildAppQuery({ stripe_product_id: "prod_abc", currency: "usd" });
    const updateQuery = buildUpdateQuery();
    mockAdminFrom.mockReturnValueOnce(appQuery).mockReturnValueOnce(updateQuery);
    mockPricesCreate.mockResolvedValue({ id: "price_v2" });

    const { priceId } = await updateAppPrice("app-1", 9900);
    expect(priceId).toBe("price_v2");

    const [, opts] = mockPricesCreate.mock.calls[0];
    expect(opts.idempotencyKey).toBe("price_create:app_app-1:9900");
  });
});
