import { redirect } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { createAdminClient } from "@/lib/services/supabase";
import {
  getAffiliateLinks,
  getBadgeProgress,
  getAffiliateLeaderboardPosition,
  getAffiliateFunnel,
  getAffiliateEarningsByApp,
  getAffiliatePayouts,
  getAffiliatePendingEarnings,
  getAffiliateClawbacks,
  getAffiliateRetention,
  getPromotableApps,
} from "@/lib/services/affiliate";
import { getAffiliateCommissionBps } from "@/lib/stripe/transfers";
import { KpiCard } from "@/components/ui/KpiCard";
import { Tooltip } from "@/components/ui/Tooltip";
import HeroBanner from "./_components/HeroBanner";
import FunnelCard from "./_components/FunnelCard";
import EarningsByAppCard from "./_components/EarningsByAppCard";
import PromoteAppsSection from "./_components/PromoteAppsSection";
import LinksTableV2 from "./_components/LinksTableV2";
import GenerateLinkForm from "./_components/GenerateLinkForm";
import ProfileEditor from "./_components/ProfileEditor";
import PayoutHistoryCard from "./_components/PayoutHistoryCard";
import { PendingEarningsCard, ClawbacksCard } from "./_components/PendingEarningsCard";
import RetentionCard from "./_components/RetentionCard";
import type { AffiliateFunnel } from "@/lib/services/affiliate";
import { OnboardingCard } from "@/components/ui/OnboardingCard";
import { buildAffiliateSteps, getOnboardingState } from "@/lib/services/onboarding";

export const metadata: Metadata = { title: "Affiliate Dashboard — [PLATFORM]" };

function Section({
  title,
  tooltip,
  children,
}: {
  title: string;
  tooltip?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-surface rounded-[10px] border border-border shadow-[var(--shadow-card)] p-5">
      <div className="flex items-center gap-2 mb-4">
        <h2 className="text-[13px] font-semibold text-foreground">{title}</h2>
        {tooltip && (
          <Tooltip content={tooltip}>
            <span className="w-4 h-4 rounded-full bg-muted text-muted-foreground text-[10px] flex items-center justify-center cursor-default">
              ?
            </span>
          </Tooltip>
        )}
      </div>
      {children}
    </div>
  );
}

function BadgeGrid({
  badges,
}: {
  badges: Array<{
    id: string;
    display_name: string;
    description: string;
    icon_emoji: string | null;
    earned: boolean;
    threshold_kind: string;
    threshold_value: number;
  }>;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {badges.map((b) => (
        <Tooltip key={b.id} content={b.description}>
          <div
            className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] border transition-opacity ${
              b.earned
                ? "bg-primary/10 border-primary/30 text-primary font-medium"
                : "bg-muted border-border text-muted-foreground opacity-50"
            }`}
          >
            <span>{b.icon_emoji ?? "🏅"}</span>
            <span>{b.display_name}</span>
          </div>
        </Tooltip>
      ))}
    </div>
  );
}

export default async function AffiliateDashboardPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select(
      "role, stripe_account_id, charges_enabled, payouts_enabled, display_name, slug, affiliate_bio, affiliate_avatar_url, affiliate_active_mrr_cents, affiliate_lifetime_mrr_cents, created_at"
    )
    .eq("id", user.id)
    .single();

  if (profile?.role !== "affiliate") redirect("/buyer");

  const admin = createAdminClient();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const onboardingDone = profile.charges_enabled && profile.payouts_enabled;
  const activeMrr = profile.affiliate_active_mrr_cents ?? 0;
  const lifetimeMrr = profile.affiliate_lifetime_mrr_cents ?? 0;
  const affiliateCommBps = getAffiliateCommissionBps(activeMrr);

  const onboardingState = await getOnboardingState(user.id).catch(() => ({}));
  const onboardingSteps = buildAffiliateSteps(onboardingState, {
    hasStripe: !!(profile.stripe_account_id && profile.charges_enabled),
    hasSlug: !!profile.slug,
    hasLink: false, // will be updated after links load
  });

  const [
    links,
    badgesWithStatus,
    position,
    earningsByApp,
    payouts,
    pending,
    clawbacks,
    retention,
    promotableApps,
    funnel,
  ] = await Promise.all([
    getAffiliateLinks(user.id),
    getBadgeProgress(user.id),
    getAffiliateLeaderboardPosition(user.id),
    getAffiliateEarningsByApp(user.id),
    getAffiliatePayouts(user.id),
    getAffiliatePendingEarnings(user.id),
    getAffiliateClawbacks(user.id),
    getAffiliateRetention(user.id),
    getPromotableApps(),
    getAffiliateFunnel(user.id),
  ]);

  // Per-link funnels
  const funnelByCode: Record<string, AffiliateFunnel> = {};
  await Promise.all(
    links.map(async (link) => {
      funnelByCode[link.code] = await getAffiliateFunnel(user.id, link.code);
    })
  );

  // App names for links table
  const appIds = [...new Set(links.map((l) => l.app_id).filter(Boolean))] as string[];
  const appNames: Record<string, string> = {};
  if (appIds.length > 0) {
    const { data: apps } = await admin.from("apps").select("id, name").in("id", appIds);
    for (const app of apps ?? []) appNames[app.id] = app.name;
  }

  const totalEarnings = earningsByApp.reduce((s, r) => s + r.earnings_cents, 0);

  const nextPayoutDate = (() => {
    const d = new Date();
    const daysUntilFriday = (5 - d.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + daysUntilFriday);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  })();

  function fmtCents(cents: number) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
    }).format(cents / 100);
  }

  // Update link step with actual data
  const stepsWithLinks = buildAffiliateSteps(onboardingState, {
    hasStripe: !!(profile.stripe_account_id && profile.charges_enabled),
    hasSlug: !!profile.slug,
    hasLink: links.length > 0,
  });

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      {/* Onboarding checklist */}
      <OnboardingCard steps={stepsWithLinks} />

      {/* Stripe Connect banner */}
      {!onboardingDone && (
        <div className="flex items-center justify-between gap-4 rounded-[10px] border border-bad/30 bg-bad-soft p-4">
          <p className="text-[13px] text-bad font-medium">
            Connect your Stripe account to receive payouts.
          </p>
          <a
            href="/api/affiliate/onboard"
            className="shrink-0 text-[13px] px-4 py-2 rounded-lg bg-bad text-white hover:bg-bad/90 transition-colors"
          >
            Connect Stripe
          </a>
        </div>
      )}

      {/* Quick action bar */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] text-muted-foreground">
          Current commission tier: <strong>{(affiliateCommBps / 100).toFixed(0)}%</strong> of net
        </p>
        <Link href="/legal/fees" className="text-[13px] text-muted-foreground hover:text-foreground underline">
          How commissions work →
        </Link>
      </div>

      {/* Hero */}
      <HeroBanner
        activeMrrCents={activeMrr}
        lifetimeMrrCents={lifetimeMrr}
        rank={position?.active_rank ?? null}
      />

      {/* KPI strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          label="Est. earnings/mo"
          value={totalEarnings > 0 ? fmtCents(totalEarnings) : "$0"}
          sub={`${(affiliateCommBps / 100).toFixed(0)}% commission tier`}
        />
        <KpiCard
          label="Active referrals"
          value={funnel.currently_active}
          sub={`${funnel.total_attributed} all-time`}
        />
        <KpiCard
          label="Confirmed pending"
          value={fmtCents(pending.confirmed_cents)}
          sub="Past 30d clawback window"
        />
        <KpiCard
          label="Next payout"
          value={nextPayoutDate}
          sub={onboardingDone ? "Weekly Friday" : "Connect Stripe first"}
        />
      </div>

      {/* Conversion funnel */}
      <Section
        title="Conversion funnel"
        tooltip="Tracks subscribers from attribution through long-term retention milestones."
      >
        <FunnelCard funnel={funnel} />
      </Section>

      {/* Earnings per app */}
      <Section title="Earnings by app">
        <EarningsByAppCard rows={earningsByApp} />
        <p className="text-[11px] text-muted-foreground mt-3">
          Estimated from active subs × commission snapshot × list price. Actual payout uses net amount after Stripe fees.
        </p>
      </Section>

      {/* Pending earnings + clawbacks */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Section title="Pending earnings">
          <PendingEarningsCard pending={pending} />
        </Section>
        <Section title="Refund clawbacks (30d)">
          <ClawbacksCard clawbacks={clawbacks} />
        </Section>
      </div>

      {/* Payout history */}
      <Section title="Payout history">
        <PayoutHistoryCard payouts={payouts} />
      </Section>

      {/* Sticky referrals */}
      <Section
        title="Sticky referrals"
        tooltip="Of subscribers referred 6+ months ago, what % are still active? Measures traffic quality."
      >
        <RetentionCard retention={retention} />
      </Section>

      {/* Apps to promote */}
      <Section title="Apps to promote">
        <PromoteAppsSection apps={promotableApps} affiliateCommissionBps={affiliateCommBps} />
      </Section>

      {/* Referral links */}
      <Section title="Your referral links">
        <div className="mb-5">
          <GenerateLinkForm
            activeMrrCents={activeMrr}
            appCatalog={promotableApps
              .filter((a) => a.affiliate_commission_bps != null)
              .map((a) => ({
                id: a.id,
                name: a.name,
                price_cents: a.price_cents,
                affiliate_commission_bps: a.affiliate_commission_bps,
              }))}
          />
        </div>
        <LinksTableV2
          links={links}
          appUrl={appUrl}
          appNames={appNames}
          funnelByCode={funnelByCode}
        />
      </Section>

      {/* Badges */}
      {badgesWithStatus.length > 0 && (
        <Section title="Badges">
          <BadgeGrid badges={badgesWithStatus} />
          {position && (
            <p className="text-[12px] text-muted-foreground mt-3">
              <Link href="/affiliates/top" className="text-primary underline">
                #{position.active_rank} on active MRR leaderboard
              </Link>
              {position.lifetime_rank != null && (
                <span className="text-muted-foreground"> · #{position.lifetime_rank} lifetime</span>
              )}
            </p>
          )}
        </Section>
      )}

      {/* Public profile */}
      <Section title="Public profile">
        <ProfileEditor
          currentSlug={profile.slug ?? null}
          currentBio={profile.affiliate_bio ?? null}
          currentAvatarUrl={profile.affiliate_avatar_url ?? null}
        />
        {profile.slug ? (
          <p className="text-[12px] text-muted-foreground mt-3">
            Live at{" "}
            <Link href={`/affiliates/${profile.slug}`} className="text-primary underline" target="_blank">
              /affiliates/{profile.slug}
            </Link>
          </p>
        ) : (
          <p className="text-[12px] text-muted-foreground mt-3">
            Set a slug to appear on the leaderboard and get a public profile page.
          </p>
        )}
      </Section>
    </div>
  );
}
