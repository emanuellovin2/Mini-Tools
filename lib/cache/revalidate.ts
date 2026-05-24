"use server";

import { revalidateTag } from "next/cache";

// Named tag constants — call the matching revalidate* function from any
// service-layer mutation that changes the cached surface.
// ISR budgets are documented in ENGINEERING.md §8.

export const CACHE_TAGS = {
  marketplace:      "marketplace",
  app:              (slug: string) => `app:${slug}`,
  storefront:       (resellerSlug: string, offerSlug: string) =>
                      `storefront:${resellerSlug}:${offerSlug}`,
  wlStorefront:     (resellerSlug: string, offerSlug: string) =>
                      `wl:${resellerSlug}:${offerSlug}`,
  affiliateProfile: (slug: string) => `affiliate:${slug}`,
  leaderboard:      "leaderboard",
} as const;

// Next.js 16 requires a second "profile" argument; empty string = immediate invalidation.
const DEFAULT_PROFILE = "";

export function revalidateMarketplace(): void {
  revalidateTag(CACHE_TAGS.marketplace, DEFAULT_PROFILE);
}

export function revalidateApp(slug: string): void {
  revalidateTag(CACHE_TAGS.app(slug), DEFAULT_PROFILE);
  revalidateTag(CACHE_TAGS.marketplace, DEFAULT_PROFILE);
}

export function revalidateStorefront(resellerSlug: string, offerSlug: string): void {
  revalidateTag(CACHE_TAGS.storefront(resellerSlug, offerSlug), DEFAULT_PROFILE);
}

export function revalidateWLStorefront(resellerSlug: string, offerSlug: string): void {
  revalidateTag(CACHE_TAGS.wlStorefront(resellerSlug, offerSlug), DEFAULT_PROFILE);
}

export function revalidateAffiliateProfile(slug: string): void {
  revalidateTag(CACHE_TAGS.affiliateProfile(slug), DEFAULT_PROFILE);
}

export function revalidateLeaderboard(): void {
  revalidateTag(CACHE_TAGS.leaderboard, DEFAULT_PROFILE);
}
