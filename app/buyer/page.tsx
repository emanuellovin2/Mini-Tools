import Link from "next/link";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import {
  getBuyerSubscriptions,
  getBuyerUpcomingCharges,
  getBuyerPaymentMethods,
  getBuyerSpendHistory,
  getBuyerRecommendations,
  getBundleSuggestions,
  type BuyerSubscription,
} from "@/lib/services/buyer";
import { formatPrice } from "@/lib/services/apps";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card, CardContent } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { UpcomingTimeline } from "./_components/UpcomingTimeline";
import { SubDrawer } from "./_components/SubDrawer";
import { PaymentMethods } from "./_components/PaymentMethods";
import { SpendSparkline } from "./_components/SpendSparkline";
import { PrivacyPanel } from "./_components/PrivacyPanel";
import { CancelModal } from "./_components/CancelModal";
import { PauseModal, ResumeButton } from "./_components/PauseModal";

export const metadata: Metadata = {
  title: "My Apps — [PLATFORM]",
};

const buyerNav = [
  { label: "My Apps", href: "/buyer" },
  { label: "Marketplace", href: "/marketplace" },
];

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function isPaused(sub: BuyerSubscription) {
  return !!sub.paused_until && new Date(sub.paused_until) > new Date();
}

function StatusBadge({ sub }: { sub: BuyerSubscription }) {
  if (isPaused(sub)) {
    return (
      <Badge variant="warning">Paused until {formatDate(sub.paused_until!)}</Badge>
    );
  }
  if (sub.status === "incomplete") {
    return (
      <Badge variant="warning">
        <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse inline-block mr-1" />
        Pending
      </Badge>
    );
  }
  if (sub.status === "active" || sub.status === "trialing") {
    if (sub.cancel_at_period_end) {
      return (
        <Badge variant="warning">Cancels {formatDate(sub.current_period_end)}</Badge>
      );
    }
    return (
      <Badge variant="success">
        <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block mr-1" />
        {sub.status === "trialing" ? "Trial" : "Active"}
      </Badge>
    );
  }
  if (sub.status === "past_due")
    return <Badge variant="destructive">Suspended</Badge>;
  if (sub.status === "canceled") return <Badge variant="secondary">Expired</Badge>;
  return <Badge variant="secondary">{sub.status}</Badge>;
}

function ChannelBadge({ sub }: { sub: BuyerSubscription }) {
  if (sub.reseller_id)
    return (
      <span className="text-[9px] bg-blue-50 text-blue-700 border border-blue-200 px-1.5 py-0.5 rounded-full">
        via reseller
      </span>
    );
  if (sub.affiliate_id)
    return (
      <span className="text-[9px] bg-violet-50 text-violet-700 border border-violet-200 px-1.5 py-0.5 rounded-full">
        via affiliate
      </span>
    );
  return null;
}

function SubscriptionCard({ sub }: { sub: BuyerSubscription }) {
  const paused = isPaused(sub);
  const isActive = (sub.status === "active" || sub.status === "trialing") && !paused;
  const isLaunchable = isActive;
  const isPauseable = isActive && !sub.cancel_at_period_end;
  const isCancellable =
    (sub.status === "active" || sub.status === "trialing") &&
    !sub.cancel_at_period_end;

  const cardBody = (
    <Card className="hover:border-primary/40 transition-colors cursor-pointer">
      <CardContent className="pt-5">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-center gap-3 min-w-0">
            {sub.app_logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={sub.app_logo_url}
                alt=""
                className="w-10 h-10 rounded-lg object-cover shrink-0 border border-border"
              />
            ) : (
              <div className="w-10 h-10 rounded-lg bg-muted shrink-0" />
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <p className="font-semibold text-sm truncate">{sub.app_name}</p>
                <ChannelBadge sub={sub} />
              </div>
              <p className="text-xs text-muted-foreground">{sub.formatted_price}/mo</p>
            </div>
          </div>
          <StatusBadge sub={sub} />
        </div>

        {paused && (
          <p className="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2 mb-3">
            Access is paused. Billing resumes automatically on{" "}
            <strong>{formatDate(sub.paused_until!)}</strong>.
          </p>
        )}
        {sub.status === "incomplete" && (
          <p className="text-xs text-yellow-700 bg-yellow-50 rounded-lg px-3 py-2 mb-3">
            Payment is being confirmed. Access will activate within seconds.
          </p>
        )}
        {sub.status === "past_due" && (
          <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2 mb-3">
            Payment failed.{" "}
            <a href="/api/buyer/billing-portal" className="underline">
              Update your payment method →
            </a>
          </p>
        )}
        {sub.cancel_at_period_end &&
          (sub.status === "active" || sub.status === "trialing") && (
            <p className="text-xs text-muted-foreground mb-3">
              Access continues until{" "}
              <strong>{formatDate(sub.current_period_end)}</strong>.
            </p>
          )}
        {sub.status === "canceled" && sub.canceled_at && (
          <p className="text-xs text-muted-foreground mb-3">
            Expired on {formatDate(sub.canceled_at)}
          </p>
        )}

        <div className="flex items-center justify-between gap-2 pt-3 border-t border-border">
          {isLaunchable ? (
            <a href={`/api/launch/${sub.app_id}`} onClick={(e) => e.stopPropagation()}>
              <Button size="sm">Launch →</Button>
            </a>
          ) : (
            <span />
          )}
          <div
            className="flex items-center gap-2"
            onClick={(e) => e.stopPropagation()}
          >
            {paused && <ResumeButton subscriptionId={sub.id} />}
            {isPauseable && (
              <PauseModal subscriptionId={sub.id} appName={sub.app_name} />
            )}
            {isCancellable && (
              <CancelModal
                subscriptionId={sub.id}
                appName={sub.app_name}
                periodEnd={sub.current_period_end}
              />
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );

  return (
    <SubDrawer sub={sub} trigger={cardBody} />
  );
}

export default async function BuyerDashboard() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, display_name")
    .eq("id", user.id)
    .single();

  if (profile?.role !== "buyer") redirect("/login");

  const subscriptions = await getBuyerSubscriptions(user.id);

  const now = new Date();
  const active = subscriptions.filter((s) => {
    if (s.paused_until && new Date(s.paused_until) > now) return true;
    return ["active", "trialing", "incomplete", "past_due"].includes(s.status);
  });
  const past = subscriptions.filter((s) => {
    if (s.paused_until && new Date(s.paused_until) > now) return false;
    return ["canceled", "unpaid", "paused"].includes(s.status);
  });

  // Fetch enrichment data in parallel — all degrade gracefully on error
  const stripeCustomerId = subscriptions.find((s) => s.stripe_customer_id)?.stripe_customer_id;

  const [upcoming, paymentMethods, spendHistory, recommendations, bundles] =
    await Promise.all([
      active.length > 0
        ? getBuyerUpcomingCharges(user.id).catch(() => [])
        : Promise.resolve([]),
      stripeCustomerId
        ? getBuyerPaymentMethods(stripeCustomerId).catch(() => [])
        : Promise.resolve([]),
      getBuyerSpendHistory(user.id, 6).catch(() => []),
      active.length > 0
        ? getBuyerRecommendations(user.id, 3).catch(() => [])
        : Promise.resolve([]),
      active.length >= 2
        ? getBundleSuggestions(user.id).catch(() => [])
        : Promise.resolve([]),
    ]);

  // Total monthly spend
  const monthlyTotal = active
    .filter((s) => ["active", "trialing"].includes(s.status))
    .reduce((sum, s) => sum + s.price_cents, 0);
  const nextCharge = active
    .filter((s) => s.status === "active" && !s.cancel_at_period_end)
    .sort(
      (a, b) =>
        new Date(a.current_period_end).getTime() -
        new Date(b.current_period_end).getTime()
    )[0];

  // Fetch buyer's anon token (first active sub)
  const anonSub = active.find(
    (s) => s.status === "active" || s.status === "trialing"
  );
  let anonToken: string | null = null;
  if (anonSub) {
    const { data: subRow } = await supabase
      .from("subscriptions")
      .select("anon_user_id")
      .eq("id", anonSub.id)
      .single();
    anonToken = subRow?.anon_user_id ?? null;
  }

  return (
    <DashboardShell
      nav={buyerNav}
      user={{ email: profile.display_name ?? user.email ?? "", role: "buyer" }}
    >
      <PageHeader
        title="My Apps"
        description={profile.display_name ?? user.email ?? undefined}
        action={
          <Link href="/marketplace">
            <Button variant="secondary" size="sm">
              Browse more →
            </Button>
          </Link>
        }
      />

      {subscriptions.length === 0 ? (
        <EmptyState
          title="No subscriptions yet"
          body="Browse the marketplace to find your first app."
          cta={
            <Link href="/marketplace">
              <Button>Browse apps →</Button>
            </Link>
          }
          className="border border-dashed border-border rounded-xl py-24"
        />
      ) : (
        <div className="space-y-8">
          {/* Summary strip */}
          {active.length > 0 && (
            <div className="flex flex-wrap gap-4 text-sm">
              <div className="border border-border rounded-xl px-4 py-3">
                <p className="text-xs text-muted-foreground mb-0.5">Active</p>
                <p className="font-semibold">{active.length} app{active.length !== 1 ? "s" : ""}</p>
              </div>
              {monthlyTotal > 0 && (
                <div className="border border-border rounded-xl px-4 py-3">
                  <p className="text-xs text-muted-foreground mb-0.5">Monthly</p>
                  <p className="font-semibold">{formatPrice(monthlyTotal, "usd")}/mo</p>
                </div>
              )}
              {nextCharge && (
                <div className="border border-border rounded-xl px-4 py-3">
                  <p className="text-xs text-muted-foreground mb-0.5">Next charge</p>
                  <p className="font-semibold">{formatDate(nextCharge.current_period_end)}</p>
                </div>
              )}
            </div>
          )}

          {/* Spend sparkline */}
          {spendHistory.length > 0 && (
            <SpendSparkline history={spendHistory} />
          )}

          {/* Upcoming charges */}
          {upcoming.length > 0 && <UpcomingTimeline charges={upcoming} />}

          {/* Active subscriptions */}
          {active.length > 0 && (
            <section>
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                Active
              </h2>
              <div className="flex flex-col gap-3">
                {active.map((sub) => (
                  <SubscriptionCard key={sub.id} sub={sub} />
                ))}
              </div>
            </section>
          )}

          {/* Bundle suggestions */}
          {bundles.length > 0 && (
            <section>
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                Bundle suggestions
              </h2>
              <div className="flex flex-col gap-3">
                {bundles.map((b) => (
                  <div
                    key={b.vendor_id}
                    className="border border-primary/20 rounded-xl p-4 bg-primary/5"
                  >
                    <p className="text-sm font-medium mb-1">
                      You have {b.sub_names.join(" + ")} from{" "}
                      {b.vendor_name ?? "this vendor"}.
                    </p>
                    <p className="text-xs text-muted-foreground mb-3">
                      They also offer:
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {b.other_apps.map((app) => (
                        <Link
                          key={app.id}
                          href={`/app/${app.id}`}
                          className="text-xs border border-border rounded-lg px-3 py-1.5 hover:bg-muted transition-colors"
                        >
                          {app.name} — {formatPrice(app.price_cents, app.currency)}/mo
                        </Link>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Payment methods */}
          <PaymentMethods
            methods={paymentMethods}
            hasActiveSub={active.length > 0}
          />

          {/* Past subscriptions */}
          {past.length > 0 && (
            <section className="opacity-60">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                Past
              </h2>
              <div className="flex flex-col gap-3">
                {past.map((sub) => (
                  <SubscriptionCard key={sub.id} sub={sub} />
                ))}
              </div>
            </section>
          )}

          {/* Recommended apps */}
          {recommendations.length > 0 && (
            <section>
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                You might also like
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {recommendations.map((app) => (
                  <Link
                    key={app.id}
                    href={`/app/${app.id}`}
                    className="border border-border rounded-xl overflow-hidden hover:border-primary/40 transition-colors"
                  >
                    {app.screenshot_urls[0] ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={app.screenshot_urls[0]}
                        alt=""
                        className="w-full aspect-[16/10] object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-full aspect-[16/10] bg-muted" />
                    )}
                    <div className="p-3">
                      <p className="text-sm font-semibold">{app.name}</p>
                      {app.category && (
                        <p className="text-xs text-muted-foreground">{app.category}</p>
                      )}
                      <p className="text-xs font-medium mt-1">
                        {formatPrice(app.price_cents, app.currency)}/mo
                      </p>
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          )}

          {/* Privacy panel */}
          <PrivacyPanel anonToken={anonToken} />
        </div>
      )}
    </DashboardShell>
  );
}
