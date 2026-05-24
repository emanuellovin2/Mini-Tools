import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Image from "next/image";
import { getStorefrontOffer } from "@/lib/services/reseller";
import SubscribeButton from "./_components/SubscribeButton";

interface Params {
  "reseller-slug": string;
  "offer-slug": string;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { "reseller-slug": resellerSlug, "offer-slug": offerSlug } = await params;
  const result = await getStorefrontOffer(resellerSlug, offerSlug);
  if (!result) return { title: "Not found" };
  const app = result.offer.apps as { name: string } | null;
  const resellerRecord = result.reseller as unknown as Record<string, unknown>;
  const wlName = resellerRecord.wl_global_display_name as string | null;
  const displayLabel = wlName ?? (resellerRecord.display_name as string | null) ?? resellerSlug;
  return { title: `${app?.name ?? "App"} — ${displayLabel}` };
}

export default async function StorefrontPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { "reseller-slug": resellerSlug, "offer-slug": offerSlug } = await params;
  const result = await getStorefrontOffer(resellerSlug, offerSlug);
  if (!result) notFound();

  const { reseller, offer } = result;
  const resellerRecord = reseller as unknown as Record<string, unknown>;
  const wlLogoUrl = resellerRecord.wl_global_logo_url as string | null;
  const wlBrandColor = resellerRecord.wl_global_brand_color as string | null;
  const wlDisplayName = resellerRecord.wl_global_display_name as string | null;
  const hasGlobalBranding = !!(wlLogoUrl && wlBrandColor && wlDisplayName);

  const app = offer.apps as {
    id: string;
    name: string;
    description: string | null;
    category: string | null;
    logo_url: string | null;
    profiles: { display_name: string | null } | null;
  } | null;

  if (!app) notFound();

  function formatCents(cents: number) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
    }).format(cents / 100);
  }

  return (
    <main className="min-h-screen bg-gray-50 flex items-center justify-center px-4 py-12">
      {/* Tier 1 global mini-branding band — shown only when reseller has set all 3 fields */}
      {hasGlobalBranding && (
        <div
          style={{ background: wlBrandColor!, position: "fixed", top: 0, left: 0, right: 0, zIndex: 50 }}
          className="flex items-center gap-3 px-6 py-2"
        >
          <Image src={wlLogoUrl!} alt={wlDisplayName!} width={24} height={24} className="rounded object-contain" />
          <span className="text-white font-medium text-sm">{wlDisplayName}</span>
        </div>
      )}
      <div className={`w-full max-w-md bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden${hasGlobalBranding ? " mt-10" : ""}`}>
        {/* App header */}
        <div className="p-8 border-b border-gray-100">
          <div className="flex items-center gap-4 mb-4">
            {app.logo_url ? (
              <Image
                src={app.logo_url}
                alt={app.name}
                width={56}
                height={56}
                className="rounded-xl object-cover"
              />
            ) : (
              <div className="w-14 h-14 rounded-xl bg-gray-100" />
            )}
            <div>
              <h1 className="text-xl font-bold">{app.name}</h1>
              {app.category && (
                <span className="text-xs bg-gray-100 text-gray-700 px-2 py-0.5 rounded-full">
                  {app.category}
                </span>
              )}
            </div>
          </div>
          {app.description && (
            <p className="text-sm text-gray-600">{app.description}</p>
          )}
        </div>

        {/* Offer details */}
        <div className="p-8">
          <div className="mb-6">
            <p className="text-3xl font-bold">
              {formatCents(offer.sell_price_cents)}
              <span className="text-base font-normal text-gray-700">/mo</span>
            </p>
            <p className="text-xs text-gray-700 mt-1">
              Sold by {wlDisplayName ?? (resellerRecord.display_name as string | null) ?? resellerSlug} · Powered by{" "}
              <a href="/marketplace" className="underline">
                [PLATFORM]
              </a>
            </p>
          </div>

          <SubscribeButton offerId={offer.id} />

          <p className="text-xs text-center text-gray-700 mt-4">
            By subscribing you agree to our Terms of Service. Cancel anytime.
          </p>
        </div>
      </div>
    </main>
  );
}
