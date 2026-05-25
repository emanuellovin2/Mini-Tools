"use client";

import type { BuyerSubscription } from "@/lib/services/buyer";
import { Card, CardContent } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { SubDrawer } from "./SubDrawer";
import { CancelModal } from "./CancelModal";
import { PauseModal, ResumeButton } from "./PauseModal";

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

export function SubscriptionCard({ sub }: { sub: BuyerSubscription }) {
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

  return <SubDrawer sub={sub} trigger={cardBody} />;
}
