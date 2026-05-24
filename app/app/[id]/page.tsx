import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { getMarketplaceApp, formatPrice } from "@/lib/services/apps";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import SubscribeButton from "./_components/SubscribeButton";
import ScreenshotGallery from "./_components/ScreenshotGallery";

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const app = await getMarketplaceApp(id);
  if (!app) return { title: "App not found — [PLATFORM]" };
  return {
    title: `${app.name} — [PLATFORM]`,
    description: app.description ?? undefined,
  };
}

export default async function AppDetailPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { checkout } = await searchParams;

  const app = await getMarketplaceApp(id);
  if (!app) notFound();

  // Resolve buyer state server-side
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let isBuyer = false;
  let hasActiveSub = false;

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
        .select("id")
        .eq("app_id", id)
        .in("status", ["active", "trialing"])
        .maybeSingle();
      hasActiveSub = !!sub;
    }
  }

  function renderCta() {
    if (checkout === "success") {
      return (
        <div className="text-right">
          <p className="text-sm font-medium text-green-600">Payment received</p>
          <p className="text-xs text-gray-700 mt-0.5">
            Access activates once the payment confirms — usually within seconds.
          </p>
        </div>
      );
    }

    if (checkout === "cancel") {
      return (
        <div className="flex flex-col items-end gap-1">
          <p className="text-xs text-gray-700">Checkout cancelled.</p>
          <SubscribeButton appId={id} />
        </div>
      );
    }

    if (!user) {
      return (
        <Link
          href={`/login?next=/app/${id}`}
          className="bg-black text-white px-6 py-3 rounded-lg text-sm font-medium hover:bg-gray-800 transition-colors"
        >
          Sign in to subscribe
        </Link>
      );
    }

    if (!isBuyer) {
      return (
        <span className="text-xs text-gray-700">
          Only buyer accounts can subscribe.
        </span>
      );
    }

    if (hasActiveSub) {
      return (
        <div className="text-right">
          <span className="text-sm font-medium text-green-600">Subscribed</span>
          <div>
            <Link href="/buyer" className="text-xs text-gray-700 underline">
              Go to dashboard →
            </Link>
          </div>
        </div>
      );
    }

    return <SubscribeButton appId={id} />;
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-10">
      <Link
        href="/marketplace"
        className="text-sm text-gray-700 hover:text-gray-900 mb-6 inline-block"
      >
        ← Back to Marketplace
      </Link>

      {/* Screenshot gallery (hero + thumbs + lightbox) */}
      {app.screenshot_urls && app.screenshot_urls.length > 0 && (
        <ScreenshotGallery screenshots={app.screenshot_urls} />
      )}

      <div className="border border-gray-200 rounded-2xl p-8">
        <div className="flex items-start justify-between gap-4 mb-2">
          <h1 className="text-2xl font-bold leading-tight">{app.name}</h1>
          {app.category && (
            <span className="shrink-0 text-sm bg-gray-100 text-gray-700 px-3 py-1 rounded-full">
              {app.category}
            </span>
          )}
        </div>

        {app.vendor_name && (
          <p className="text-sm text-gray-700 mb-5">by {app.vendor_name}</p>
        )}

        {app.description && (
          <p className="text-gray-600 leading-relaxed mb-8">{app.description}</p>
        )}

        <div className="border-t border-gray-100 pt-6 flex items-center justify-between gap-4">
          <div>
            <span className="text-3xl font-bold">
              {formatPrice(app.price_cents, app.currency)}
            </span>
            <span className="text-gray-700 text-sm ml-1">/month</span>
          </div>
          {renderCta()}
        </div>
      </div>
    </div>
  );
}
