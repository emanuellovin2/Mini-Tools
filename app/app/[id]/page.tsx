import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { getMarketplaceApp, listAppReviews, formatPrice } from "@/lib/services/apps";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import SubscribeButton from "./_components/SubscribeButton";
import ScreenshotGallery from "./_components/ScreenshotGallery";
import ReviewSection from "./_components/ReviewSection";
import { BuyerFeeBreakdown } from "@/components/ui/BuyerFeeBreakdown";
import { StarRating } from "@/app/marketplace/_components/StarRating";

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const app = await getMarketplaceApp(id);
  if (!app) return { title: "App not found — [PLATFORM]" };

  const ogImage = app.screenshot_urls[0];

  return {
    title: `${app.name} — [PLATFORM]`,
    description: app.description ?? `Subscribe to ${app.name} on [PLATFORM].`,
    openGraph: {
      title: app.name,
      description: app.description ?? undefined,
      type: "website",
      ...(ogImage ? { images: [{ url: ogImage, width: 1280, height: 800 }] } : {}),
    },
    twitter: {
      card: "summary_large_image",
      title: app.name,
      description: app.description ?? undefined,
      ...(ogImage ? { images: [ogImage] } : {}),
    },
  };
}

export default async function AppDetailPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { checkout } = await searchParams;

  const [app, reviewsResult] = await Promise.all([
    getMarketplaceApp(id),
    listAppReviews(id, { page: 1, pageSize: 10 }),
  ]);

  if (!app) notFound();

  // Resolve buyer state server-side
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let isBuyer = false;
  let hasActiveSub = false;
  let activeSubId: string | null = null;
  let hasReviewed = false;

  if (user) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();

    isBuyer = profile?.role === "buyer";

    if (isBuyer) {
      const { data: sub } = await supabase
        .from("subscriptions")
        .select("id, status")
        .eq("app_id", id)
        .in("status", ["active", "trialing", "canceled"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (sub) {
        hasActiveSub = sub.status === "active" || sub.status === "trialing";
        activeSubId = sub.id;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: existingReview } = await (supabase.from as any)("app_reviews")
          .select("id")
          .eq("app_id", id)
          .eq("buyer_id", user.id)
          .maybeSingle();

        hasReviewed = !!existingReview;
      }
    }
  }

  // Schema.org structured data
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: app.name,
    description: app.description ?? undefined,
    applicationCategory: app.category ?? "WebApplication",
    offers: {
      "@type": "Offer",
      price: (app.price_cents / 100).toFixed(2),
      priceCurrency: app.currency.toUpperCase(),
      priceSpecification: {
        "@type": "RecurringCharges",
        billingDuration: "P1M",
      },
    },
    ...(app.rating_count > 0
      ? {
          aggregateRating: {
            "@type": "AggregateRating",
            ratingValue: app.rating_avg.toFixed(1),
            reviewCount: app.rating_count,
            bestRating: 5,
            worstRating: 1,
          },
        }
      : {}),
    ...(app.screenshot_urls[0]
      ? { image: app.screenshot_urls[0] }
      : {}),
  };

  function renderCta() {
    if (checkout === "success") {
      return (
        <div className="text-right">
          <p className="text-sm font-medium text-green-600">Payment received</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Access activates once the payment confirms — usually within seconds.
          </p>
        </div>
      );
    }

    if (checkout === "cancel") {
      return (
        <div className="flex flex-col items-end gap-1">
          <p className="text-xs text-muted-foreground">Checkout cancelled.</p>
          <SubscribeButton appId={id} />
        </div>
      );
    }

    if (!user) {
      return (
        <Link
          href={`/login?next=/app/${id}`}
          className="bg-primary text-primary-foreground px-6 py-3 rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
        >
          Sign in to subscribe
        </Link>
      );
    }

    if (!isBuyer) {
      return (
        <span className="text-xs text-muted-foreground">
          Only buyer accounts can subscribe.
        </span>
      );
    }

    if (hasActiveSub) {
      return (
        <div className="text-right">
          <span className="text-sm font-medium text-green-600">Subscribed</span>
          <div>
            <Link href="/buyer" className="text-xs text-muted-foreground underline">
              Go to dashboard →
            </Link>
          </div>
        </div>
      );
    }

    return <SubscribeButton appId={id} />;
  }

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />

      <div className="max-w-2xl mx-auto px-4 py-10">
        <Link
          href="/marketplace"
          className="text-sm text-muted-foreground hover:text-foreground mb-6 inline-block"
        >
          ← Back to Marketplace
        </Link>

        {/* Screenshot gallery */}
        {app.screenshot_urls && app.screenshot_urls.length > 0 && (
          <ScreenshotGallery screenshots={app.screenshot_urls} />
        )}

        <div className="border border-border rounded-2xl p-8">
          <div className="flex items-start justify-between gap-4 mb-2">
            <h1 className="text-2xl font-bold leading-tight">{app.name}</h1>
            <div className="flex items-center gap-2 shrink-0">
              {app.has_free_trial && (
                <span className="text-xs font-medium bg-green-50 text-green-700 border border-green-200 px-2 py-0.5 rounded-full">
                  Free trial
                </span>
              )}
              {app.category && (
                <span className="text-sm bg-muted text-muted-foreground px-3 py-1 rounded-full">
                  {app.category}
                </span>
              )}
            </div>
          </div>

          {app.vendor_name && (
            <p className="text-sm text-muted-foreground mb-2">by {app.vendor_name}</p>
          )}

          {app.rating_count > 0 && (
            <div className="mb-4">
              <StarRating avg={app.rating_avg} count={app.rating_count} size="md" />
            </div>
          )}

          {app.affiliate_commission_bps != null && app.affiliate_commission_bps > 0 && (
            <p className="text-xs text-violet-600 mb-4">
              {Math.round(app.affiliate_commission_bps / 100)}% affiliate commission
            </p>
          )}

          {app.description && (
            <p className="text-muted-foreground leading-relaxed mb-8">
              {app.description}
            </p>
          )}

          <div className="border-t border-border pt-6 space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div>
                <span className="text-3xl font-bold">
                  {formatPrice(app.price_cents, app.currency)}
                </span>
                <span className="text-muted-foreground text-sm ml-1">/month</span>
              </div>
              {renderCta()}
            </div>
            {isBuyer && !hasActiveSub && checkout !== "success" && (
              <BuyerFeeBreakdown priceCents={app.price_cents} channel="direct" />
            )}
          </div>
        </div>

        {/* Reviews section */}
        <ReviewSection
          appId={id}
          reviews={reviewsResult.reviews}
          total={reviewsResult.total}
          canReview={isBuyer && (hasActiveSub || activeSubId !== null) && !hasReviewed}
          subscriptionId={activeSubId}
          userId={user?.id ?? null}
        />
      </div>
    </>
  );
}
