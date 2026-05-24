import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Image from "next/image";
import { getWLStorefrontOffer } from "@/lib/services/reseller";
import SubscribeButton from "@/app/r/[reseller-slug]/[offer-slug]/_components/SubscribeButton";

interface Params {
  "reseller-slug": string;
  "offer-slug": string;
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { "reseller-slug": resellerSlug, "offer-slug": offerSlug } = await params;
  const result = await getWLStorefrontOffer(resellerSlug, offerSlug);
  if (!result) return { title: "Not Found" };
  const displayName = result.offer.wl_display_name as string | null;
  return { title: displayName ?? offerSlug };
}

export default async function WLStorefrontPage({ params }: { params: Promise<Params> }) {
  const { "reseller-slug": resellerSlug, "offer-slug": offerSlug } = await params;
  const result = await getWLStorefrontOffer(resellerSlug, offerSlug);
  if (!result) notFound();

  const { offer } = result;
  const app = offer.apps as Record<string, unknown> | null;

  if (!app) notFound();

  const displayName = offer.wl_display_name as string | null;
  const logoUrl = offer.wl_logo_url as string | null;
  const brandColor = (offer.wl_brand_color as string | null) ?? "#6366f1";
  const sellPrice = offer.sell_price_cents as number;
  const offerId = offer.id as string;

  function formatCents(cents: number) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(cents / 100);
  }

  return (
    <main className="min-h-screen bg-gray-50 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        {/* WL brand header */}
        <div style={{ background: brandColor }} className="px-8 py-4 flex items-center gap-3">
          {logoUrl ? (
            <Image src={logoUrl} alt={displayName ?? "Brand"} width={32} height={32} className="rounded object-contain" />
          ) : null}
          {displayName && (
            <span className="text-white font-bold text-lg">{displayName}</span>
          )}
        </div>

        {/* App header */}
        <div className="p-8 border-b border-gray-100">
          <div className="flex items-center gap-4 mb-4">
            {app.logo_url ? (
              <Image src={app.logo_url as string} alt={app.name as string} width={56} height={56} className="rounded-xl object-cover" />
            ) : (
              <div className="w-14 h-14 rounded-xl bg-gray-100" />
            )}
            <div>
              <h1 className="text-xl font-bold">{app.name as string}</h1>
              {!!app.category && (
                <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">
                  {app.category as string}
                </span>
              )}
            </div>
          </div>
          {!!app.description && (
            <p className="text-sm text-gray-600">{app.description as string}</p>
          )}
        </div>

        {/* Offer details */}
        <div className="p-8">
          <div className="mb-6">
            <p className="text-3xl font-bold">
              {formatCents(sellPrice)}
              <span className="text-base font-normal text-gray-500">/mo</span>
            </p>
          </div>

          <SubscribeButton offerId={offerId} />

          <p className="text-xs text-center text-gray-400 mt-4">
            By subscribing you agree to our Terms of Service. Cancel anytime.
          </p>
          <p className="text-xs text-center text-gray-300 mt-2">Hosted by [PLATFORM]</p>
        </div>
      </div>
    </main>
  );
}
