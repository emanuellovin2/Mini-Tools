import { redirect } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import {
  getResellerSubscription,
  getOffers,
  getResellableAppsCatalog,
  getResellerAlerts,
  getResellerPayouts,
  getResellerKpis,
  getOfferAnalytics,
} from "@/lib/services/reseller";
import { KpiCard } from "@/components/ui/KpiCard";
import { Tooltip } from "@/components/ui/Tooltip";
import AlertsBanner from "./_components/AlertsBanner";
import DiscoverSection from "./_components/DiscoverSection";
import OffersGridV2 from "./_components/OffersGridV2";
import ComparisonTable, { type ComparisonRow } from "./_components/ComparisonTable";
import KickbackCard from "./_components/KickbackCard";
import { markupSimulateAction } from "./actions";
import type { OfferCardData } from "./_components/OfferDrawer";
import type { OfferAnalytics } from "@/lib/services/reseller";

export const metadata: Metadata = { title: "Reseller Dashboard — [PLATFORM]" };

function fmt(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
  }).format(cents / 100);
}

function Section({
  title,
  tooltip,
  action,
  children,
}: {
  title: string;
  tooltip?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-surface rounded-[10px] border border-border shadow-[var(--shadow-card)] p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <h2 className="text-[13px] font-semibold text-foreground">{title}</h2>
          {tooltip && (
            <Tooltip content={tooltip}>
              <span className="w-4 h-4 rounded-full bg-muted text-muted-foreground text-[10px] flex items-center justify-center cursor-default">
                ?
              </span>
            </Tooltip>
          )}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

export default async function ResellerDashboard({
  searchParams,
}: {
  searchParams: Promise<{ setup?: string; onboard?: string; tab?: string }>;
}) {
  const { setup, onboard, tab } = await searchParams;
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: profile } = await (supabase as any)
    .from("profiles")
    .select(
      "role, slug, stripe_account_id, charges_enabled, payouts_enabled, display_name, wl_global_logo_url, wl_global_brand_color, wl_global_display_name"
    )
    .eq("id", user.id)
    .single() as {
    data: {
      role: string;
      slug: string | null;
      stripe_account_id: string | null;
      charges_enabled: boolean;
      payouts_enabled: boolean;
      display_name: string | null;
      wl_global_logo_url: string | null;
      wl_global_brand_color: string | null;
      wl_global_display_name: string | null;
    } | null;
  };

  if (profile?.role !== "reseller") redirect("/login");
  if (!profile.slug) redirect("/reseller/setup");

  const resSub = await getResellerSubscription(user.id);
  if (!resSub) redirect("/reseller/setup");

  const isActive = resSub.status === "active" || resSub.status === "trialing";
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

  const [rawOffers, catalog, alerts, payouts, kpis] = await Promise.all([
    getOffers(user.id),
    getResellableAppsCatalog(user.id),
    getResellerAlerts(user.id),
    getResellerPayouts(user.id),
    getResellerKpis(user.id),
  ]);

  // Load per-offer analytics in parallel
  const analyticsArr: OfferAnalytics[] = await Promise.all(
    rawOffers.map((o) => getOfferAnalytics(user.id, o.id))
  );
  const analyticsMap: Record<string, OfferAnalytics> = {};
  for (const a of analyticsArr) analyticsMap[a.offer_id] = a;

  // Shape offers for the grid component
  const offers: OfferCardData[] = rawOffers.map((o) => {
    const a = o.apps as {
      id: string;
      name: string;
      price_cents: number;
      min_price_cents: number | null;
      category: string | null;
    } | null;
    // wl fields are not in generated types but exist from migration #29 — cast via any
    const any = o as unknown as {
      wl_tier: number;
      wl_status: string | null;
      wl_trial_end: string | null;
      wl_display_name: string | null;
      wl_logo_url: string | null;
      wl_brand_color: string | null;
      vendor_openness?: string;
    };
    return {
      id: o.id,
      slug: o.slug,
      app_name: a?.name ?? "—",
      sell_price_cents: o.sell_price_cents,
      vendor_floor_snapshot_cents: o.vendor_floor_snapshot_cents,
      status: o.status,
      wl_tier: any.wl_tier ?? 1,
      wl_status: any.wl_status ?? null,
      wl_trial_end: any.wl_trial_end ?? null,
      wl_display_name: any.wl_display_name ?? null,
      wl_logo_url: any.wl_logo_url ?? null,
      wl_brand_color: any.wl_brand_color ?? null,
      vendor_openness: (any.vendor_openness as "open_to_resellers" | "open_to_wl") ?? "open_to_resellers",
    };
  });

  // Comparison table rows
  const comparisonRows: ComparisonRow[] = rawOffers.map((o) => {
    const an = analyticsMap[o.id];
    const a = o.apps as { name: string } | null;
    return {
      offer_id: o.id,
      offer_slug: o.slug,
      app_name: a?.name ?? "—",
      floor_cents: o.vendor_floor_snapshot_cents,
      price_cents: o.sell_price_cents,
      margin_cents: o.sell_price_cents - o.vendor_floor_snapshot_cents,
      mrr_cents: an?.mrr_cents ?? 0,
      active_subs: an?.active_subs ?? 0,
      churn_rate_pct: an?.churn_rate_pct ?? 0,
      status: o.status,
    };
  });

  // Trial countdown
  const trialDaysLeft =
    resSub.status === "trialing"
      ? Math.max(0, Math.ceil((new Date(resSub.current_period_end).getTime() - Date.now()) / 86_400_000))
      : null;

  const activeTab = tab ?? "dashboard";

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      {/* Onboarding toasts */}
      {(setup === "success" || onboard === "success") && (
        <div className="flex items-center gap-3 rounded-[10px] border border-ok/30 bg-ok-soft p-3 text-[13px] text-ok">
          <span className="text-[14px]">✓</span>
          {setup === "success" ? "Subscription activated!" : "Stripe Connect onboarding complete!"}
        </div>
      )}

      {/* Stripe Connect banner */}
      {!profile.payouts_enabled && (
        <div className="flex items-center justify-between gap-4 rounded-[10px] border border-bad/30 bg-bad-soft p-4">
          <p className="text-[13px] text-bad font-medium">
            Connect your Stripe account to receive payouts.
          </p>
          <a
            href="/api/reseller/connect"
            className="shrink-0 text-[13px] px-4 py-2 rounded-lg bg-bad text-white hover:bg-bad/90 transition-colors"
          >
            Connect Stripe
          </a>
        </div>
      )}

      {/* Trial banner */}
      {trialDaysLeft !== null && (
        <div className="flex items-center justify-between gap-4 rounded-[10px] border border-primary/30 bg-primary/5 p-3 text-[13px]">
          <p className="text-foreground">
            Free trial — <strong>{trialDaysLeft} day{trialDaysLeft !== 1 ? "s" : ""}</strong> remaining. Add a payment method to continue after trial.
          </p>
          <Link href="/reseller/setup" className="shrink-0 text-primary hover:underline text-[12px]">
            Manage billing →
          </Link>
        </div>
      )}

      {/* Vendor change alerts */}
      <AlertsBanner alerts={alerts} />

      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-border">
        {[
          { key: "dashboard", label: "Dashboard" },
          { key: "discover", label: `Discover (${catalog.length})` },
          { key: "comparison", label: "Comparison" },
        ].map(({ key, label }) => (
          <Link
            key={key}
            href={`/reseller${key !== "dashboard" ? `?tab=${key}` : ""}`}
            className={`px-3 py-2 text-[13px] border-b-2 -mb-px transition-colors ${
              activeTab === key
                ? "border-primary text-primary font-medium"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {label}
          </Link>
        ))}
      </div>

      {/* ── DASHBOARD TAB ── */}
      {activeTab === "dashboard" && (
        <>
          {/* KPI strip */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <KpiCard
              label="Storefront MRR"
              value={fmt(kpis.storefront_mrr_cents)}
              sub={`${kpis.active_offers} active offers`}
            />
            <KpiCard
              label="Markup earned"
              value={fmt(kpis.markup_earned_cents)}
              sub="After floor, before platform cut"
            />
            <KpiCard
              label="Active offers"
              value={kpis.active_offers}
              sub={`${rawOffers.length} total`}
            />
            <KpiCard
              label="Total buyers"
              value={kpis.total_buyers}
              sub="Active/trialing subscriptions"
            />
          </div>

          {/* Your offers */}
          <Section
            title={`Your offers (${rawOffers.length})`}
            action={
              isActive ? (
                <Link
                  href="/reseller/offers"
                  className="text-[12px] text-primary hover:underline"
                >
                  Manage →
                </Link>
              ) : null
            }
          >
            {!isActive && (
              <p className="text-[13px] text-warn mb-4">
                Your subscription has lapsed. New offers and new sales are paused until renewed.
              </p>
            )}
            <OffersGridV2
              offers={offers}
              analyticsMap={analyticsMap}
              appUrl={appUrl}
              resellerSlug={profile.slug ?? ""}
              onSimulate={markupSimulateAction}
            />
          </Section>

          {/* Payout history */}
          {payouts.length > 0 && (
            <Section title="Payout history">
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left px-3 py-2 text-muted-foreground font-medium">Date</th>
                      <th className="text-left px-3 py-2 text-muted-foreground font-medium">Amount</th>
                      <th className="text-left px-3 py-2 text-muted-foreground font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payouts.map((p) => (
                      <tr key={p.id} className="border-b border-border/40">
                        <td className="px-3 py-2 text-muted-foreground">
                          {new Date(p.arrival_date * 1000).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })}
                        </td>
                        <td className="px-3 py-2 tabular-nums font-medium">
                          {fmt(p.amount)} {p.currency.toUpperCase()}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${
                              p.status === "paid"
                                ? "bg-ok-soft text-ok"
                                : p.status === "pending"
                                ? "bg-warn-soft text-warn"
                                : "bg-muted text-muted-foreground"
                            }`}
                          >
                            {p.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          {/* WL fee transparency */}
          <KickbackCard />

          {/* Global branding status */}
          <Section title="Tier 1 global branding">
            {profile.wl_global_display_name ? (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 text-[13px]">
                  {profile.wl_global_logo_url && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={profile.wl_global_logo_url}
                      alt=""
                      className="w-7 h-7 rounded object-contain"
                    />
                  )}
                  {profile.wl_global_brand_color && (
                    <span
                      className="w-4 h-4 rounded-full border border-border"
                      style={{ backgroundColor: profile.wl_global_brand_color }}
                    />
                  )}
                  <span className="font-medium">{profile.wl_global_display_name}</span>
                  <span className="text-[11px] text-muted-foreground">
                    shown on all /r/ Tier 1 storefronts · Tier 2 offers can override per-offer
                  </span>
                </div>
                <Link href="/reseller/brand" className="text-[12px] text-primary hover:underline">
                  Edit →
                </Link>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <p className="text-[13px] text-muted-foreground">
                  No global branding set. Add a logo and brand color for your Tier 1 storefronts.
                </p>
                <Link href="/reseller/brand" className="text-[12px] text-primary hover:underline">
                  Set up →
                </Link>
              </div>
            )}
          </Section>
        </>
      )}

      {/* ── DISCOVER TAB ── */}
      {activeTab === "discover" && (
        <Section title="Resellable apps">
          <DiscoverSection apps={catalog} platformUrl={appUrl} />
        </Section>
      )}

      {/* ── COMPARISON TAB ── */}
      {activeTab === "comparison" && (
        <Section
          title="Offer comparison"
          tooltip="Side-by-side view of all your offers. Click headers to sort. Export to CSV for spreadsheet analysis."
        >
          <ComparisonTable rows={comparisonRows} />
        </Section>
      )}
    </div>
  );
}
