import { createAdminClient } from "@/lib/services/supabase";

export const MARKETPLACE_PAGE_SIZE = 12;

export type MarketplaceApp = {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  price_cents: number;
  currency: string;
  vendor_name: string | null;
};

export type MarketplaceAppDetail = MarketplaceApp & {
  auth_url: string | null;
};

export type MarketplaceListResult = {
  apps: MarketplaceApp[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export async function listMarketplaceApps({
  page = 1,
  pageSize = MARKETPLACE_PAGE_SIZE,
  category,
  search,
}: {
  page?: number;
  pageSize?: number;
  category?: string;
  search?: string;
} = {}): Promise<MarketplaceListResult> {
  const admin = createAdminClient();

  const { data, error } = await admin.rpc("list_marketplace_apps", {
    p_page: page,
    p_page_size: pageSize,
    p_category: category ?? undefined,
    p_search: search ?? undefined,
  });

  if (error) throw new Error(`listMarketplaceApps: ${error.message}`);

  const total = data && data.length > 0 ? Number(data[0].total_count) : 0;
  const apps: MarketplaceApp[] = (data ?? []).map(
    ({ total_count: _tc, ...rest }) => rest
  );

  return { apps, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
}

export async function getMarketplaceApp(
  id: string
): Promise<MarketplaceAppDetail | null> {
  const admin = createAdminClient();

  const { data, error } = await admin.rpc("get_marketplace_app", { p_id: id });

  if (error) throw new Error(`getMarketplaceApp: ${error.message}`);
  if (!data || data.length === 0) return null;

  return data[0] as MarketplaceAppDetail;
}

export async function listMarketplaceCategories(): Promise<string[]> {
  const admin = createAdminClient();

  const { data, error } = await admin.rpc("list_marketplace_categories");

  if (error) throw new Error(`listMarketplaceCategories: ${error.message}`);
  return (data ?? []).map((r) => r.category).filter((c): c is string => !!c);
}

export function formatPrice(cents: number, currency = "usd"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
  }).format(cents / 100);
}
