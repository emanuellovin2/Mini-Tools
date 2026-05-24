import { createAdminClient } from "@/lib/services/supabase";
import { withFastTimeout } from "@/lib/db/with-timeout";

export const MARKETPLACE_PAGE_SIZE = 24;

export type MarketplaceApp = {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  price_cents: number;
  currency: string;
  vendor_name: string | null;
  screenshot_urls: string[];
  rating_avg: number;
  rating_count: number;
  affiliate_commission_bps: number | null;
  has_free_trial: boolean;
  subscriber_count: number;
};

export type FeaturedApp = Pick<
  MarketplaceApp,
  | "id"
  | "name"
  | "description"
  | "category"
  | "price_cents"
  | "currency"
  | "vendor_name"
  | "screenshot_urls"
  | "rating_avg"
  | "rating_count"
>;

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

export type MarketplaceSort =
  | "trending"
  | "newest"
  | "price_asc"
  | "price_desc"
  | "rating";

export type AppReview = {
  id: string;
  buyer_id: string;
  display_name: string;
  rating: number;
  title: string | null;
  body: string | null;
  vendor_response: string | null;
  status: string;
  created_at: string;
};

export type ReviewListResult = {
  reviews: AppReview[];
  total: number;
  page: number;
  totalPages: number;
};

export async function listMarketplaceApps({
  page = 1,
  pageSize = MARKETPLACE_PAGE_SIZE,
  category,
  search,
  sort = "trending",
  priceMin,
  priceMax,
  ratingMin,
  hasAffiliate,
  hasTrial,
}: {
  page?: number;
  pageSize?: number;
  category?: string;
  search?: string;
  sort?: MarketplaceSort;
  priceMin?: number;
  priceMax?: number;
  ratingMin?: number;
  hasAffiliate?: boolean;
  hasTrial?: boolean;
} = {}): Promise<MarketplaceListResult> {
  const admin = createAdminClient();

  return withFastTimeout(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (admin.rpc as any)("list_marketplace_apps", {
      p_page: page,
      p_page_size: pageSize,
      p_category: category ?? null,
      p_search: search ?? null,
      p_sort: sort,
      p_price_min: priceMin ?? null,
      p_price_max: priceMax ?? null,
      p_rating_min: ratingMin ?? null,
      p_has_affiliate: hasAffiliate ?? null,
      p_has_trial: hasTrial ?? null,
    });

    if (error) throw new Error(`listMarketplaceApps: ${error.message}`);

    const total = data && data.length > 0 ? Number(data[0].total_count) : 0;
    const apps: MarketplaceApp[] = (data ?? []).map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ({ total_count: _tc, ...rest }: any) => ({
        ...rest,
        rating_avg: Number(rest.rating_avg ?? 0),
        rating_count: Number(rest.rating_count ?? 0),
        subscriber_count: Number(rest.subscriber_count ?? 0),
        affiliate_commission_bps: rest.affiliate_commission_bps ?? null,
        has_free_trial: rest.has_free_trial ?? false,
      })
    );

    return { apps, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
  });
}

export async function getFeaturedApps(limit = 5): Promise<FeaturedApp[]> {
  const admin = createAdminClient();

  return withFastTimeout(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (admin.rpc as any)("get_featured_apps", {
      p_limit: limit,
    });
    if (error) throw new Error(`getFeaturedApps: ${error.message}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (data ?? []).map((r: any) => ({
      ...r,
      rating_avg: Number(r.rating_avg ?? 0),
      rating_count: Number(r.rating_count ?? 0),
    })) as FeaturedApp[];
  });
}

export async function getMarketplaceApp(
  id: string
): Promise<MarketplaceAppDetail | null> {
  const admin = createAdminClient();

  const { data, error } = await admin.rpc("get_marketplace_app", { p_id: id });

  if (error) throw new Error(`getMarketplaceApp: ${error.message}`);
  if (!data || data.length === 0) return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = data[0] as any;
  return {
    ...row,
    rating_avg: Number(row.rating_avg ?? 0),
    rating_count: Number(row.rating_count ?? 0),
    subscriber_count: 0,
    affiliate_commission_bps: row.affiliate_commission_bps ?? null,
    has_free_trial: row.has_free_trial ?? false,
  } as MarketplaceAppDetail;
}

export async function listMarketplaceCategories(): Promise<string[]> {
  const admin = createAdminClient();

  return withFastTimeout(async () => {
    const { data, error } = await admin.rpc("list_marketplace_categories");
    if (error) throw new Error(`listMarketplaceCategories: ${error.message}`);
    return (data ?? []).map((r) => r.category).filter((c): c is string => !!c);
  });
}

export async function listAppReviews(
  appId: string,
  { page = 1, pageSize = 10 }: { page?: number; pageSize?: number } = {}
): Promise<ReviewListResult> {
  const admin = createAdminClient();

  return withFastTimeout(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (admin.rpc as any)("list_app_reviews", {
      p_app_id: appId,
      p_page: page,
      p_page_size: pageSize,
    });
    if (error) throw new Error(`listAppReviews: ${error.message}`);

    const total = data && data.length > 0 ? Number(data[0].total_count) : 0;
    const reviews: AppReview[] = (data ?? []).map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ({ total_count: _tc, ...rest }: any) => rest as AppReview
    );

    return { reviews, total, page, totalPages: Math.ceil(total / pageSize) };
  });
}

// ---------------------------------------------------------------------------
// app_reviews writes — use service-role admin client to bypass stale typed schema
// (types/supabase.ts is regenerated via `npm run types` after migration applies)
// ---------------------------------------------------------------------------

export async function createReview(
  buyerId: string,
  appId: string,
  subscriptionId: string,
  data: { rating: number; title?: string; body?: string }
): Promise<void> {
  const admin = createAdminClient();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (admin.from as any)("app_reviews").insert({
    app_id: appId,
    buyer_id: buyerId,
    subscription_id: subscriptionId,
    rating: data.rating,
    title: data.title ?? null,
    body: data.body ?? null,
  });

  if (error) throw new Error(`createReview: ${error.message}`);
}

export async function respondToReview(
  orgId: string,
  reviewId: string,
  response: string
): Promise<void> {
  const admin = createAdminClient();

  // Verify the review belongs to an app in this org before updating
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: review } = await (admin.from as any)("app_reviews")
    .select("app_id")
    .eq("id", reviewId)
    .single();

  if (!review) throw new Error("Review not found");

  const { data: app } = await admin
    .from("apps")
    .select("org_id")
    .eq("id", (review as { app_id: string }).app_id)
    .single();

  if (!app || (app as { org_id: string | null }).org_id !== orgId)
    throw new Error("Not authorized");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (admin.from as any)("app_reviews")
    .update({ vendor_response: response })
    .eq("id", reviewId);

  if (error) throw new Error(`respondToReview: ${error.message}`);
}

export async function moderateReview(
  reviewId: string,
  status: "published" | "hidden"
): Promise<void> {
  const admin = createAdminClient();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (admin.from as any)("app_reviews")
    .update({ status })
    .eq("id", reviewId);

  if (error) throw new Error(`moderateReview: ${error.message}`);
}

export function formatPrice(cents: number, currency = "usd"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

export function formatRating(avg: number): string {
  return avg.toFixed(1);
}
