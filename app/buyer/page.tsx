import Link from "next/link";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { getBuyerSubscriptions, type BuyerSubscription } from "@/lib/services/buyer";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card, CardContent } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import CancelButton from "./_components/CancelButton";

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

function StatusBadge({ sub }: { sub: BuyerSubscription }) {
  if (sub.status === "incomplete") {
    return (
      <Badge variant="warning">
        <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse inline-block" />
        Pending
      </Badge>
    );
  }
  if (sub.status === "active" || sub.status === "trialing") {
    if (sub.cancel_at_period_end) {
      return <Badge variant="warning">Cancels {formatDate(sub.current_period_end)}</Badge>;
    }
    return (
      <Badge variant="success">
        <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
        {sub.status === "trialing" ? "Trial" : "Active"}
      </Badge>
    );
  }
  if (sub.status === "past_due") return <Badge variant="destructive">Suspended</Badge>;
  if (sub.status === "canceled") return <Badge variant="secondary">Expired</Badge>;
  return <Badge variant="secondary">{sub.status}</Badge>;
}

function SubscriptionCard({ sub }: { sub: BuyerSubscription }) {
  const isLaunchable = (sub.status === "active" || sub.status === "trialing");
  const isCancellable = (sub.status === "active" || sub.status === "trialing") && !sub.cancel_at_period_end;

  return (
    <Card>
      <CardContent className="pt-5">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-center gap-3 min-w-0">
            {sub.app_logo_url ? (
              <img
                src={sub.app_logo_url}
                alt=""
                className="w-10 h-10 rounded-lg object-cover shrink-0 border border-border"
              />
            ) : (
              <div className="w-10 h-10 rounded-lg bg-muted shrink-0" />
            )}
            <div className="min-w-0">
              <p className="font-semibold text-sm truncate">{sub.app_name}</p>
              <p className="text-xs text-muted-foreground">{sub.formatted_price}/mo</p>
            </div>
          </div>
          <StatusBadge sub={sub} />
        </div>

        {sub.status === "incomplete" && (
          <p className="text-xs text-yellow-700 bg-yellow-50 rounded-lg px-3 py-2 mb-3">
            Payment is being confirmed. Access will activate within seconds.
          </p>
        )}
        {sub.status === "past_due" && (
          <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2 mb-3">
            Payment failed. Update your payment method in Stripe to restore access.
          </p>
        )}
        {sub.cancel_at_period_end && (sub.status === "active" || sub.status === "trialing") && (
          <p className="text-xs text-muted-foreground mb-3">
            Access continues until <strong>{formatDate(sub.current_period_end)}</strong>.
          </p>
        )}
        {sub.status === "canceled" && sub.canceled_at && (
          <p className="text-xs text-muted-foreground mb-3">Expired on {formatDate(sub.canceled_at)}</p>
        )}

        <div className="flex items-center justify-between gap-2 pt-3 border-t border-border">
          {isLaunchable ? (
            <a href={`/api/launch/${sub.app_id}`}>
              <Button size="sm">Launch →</Button>
            </a>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-3">
            <Link href={`/app/${sub.app_id}`}>
              <Button variant="ghost" size="sm">Details</Button>
            </Link>
            {isCancellable && <CancelButton subscriptionId={sub.id} />}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default async function BuyerDashboard() {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, display_name")
    .eq("id", user.id)
    .single();

  if (profile?.role !== "buyer") redirect("/login");

  const subscriptions = await getBuyerSubscriptions(user.id);
  const active = subscriptions.filter((s) =>
    ["active", "trialing", "incomplete", "past_due"].includes(s.status)
  );
  const past = subscriptions.filter((s) =>
    ["canceled", "unpaid", "paused"].includes(s.status)
  );

  return (
    <DashboardShell nav={buyerNav} user={{ email: profile.display_name ?? user.email ?? "", role: "buyer" }}>
      <PageHeader
        title="My Apps"
        description={profile.display_name ?? user.email ?? undefined}
        action={
          <Link href="/marketplace">
            <Button variant="secondary" size="sm">Browse more →</Button>
          </Link>
        }
      />

      {subscriptions.length === 0 ? (
        <div className="text-center py-20 border border-dashed border-border rounded-xl text-muted-foreground">
          <p className="text-sm mb-3">No subscriptions yet.</p>
          <Link href="/marketplace">
            <Button>Browse apps</Button>
          </Link>
        </div>
      ) : (
        <>
          {active.length > 0 && (
            <section className="mb-8">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Active</h2>
              <div className="flex flex-col gap-3">
                {active.map((sub) => <SubscriptionCard key={sub.id} sub={sub} />)}
              </div>
            </section>
          )}
          {past.length > 0 && (
            <section className="opacity-60">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Past</h2>
              <div className="flex flex-col gap-3">
                {past.map((sub) => <SubscriptionCard key={sub.id} sub={sub} />)}
              </div>
            </section>
          )}
        </>
      )}
    </DashboardShell>
  );
}
