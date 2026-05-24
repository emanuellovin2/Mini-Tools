import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Image from "next/image";
import { getWLStorefrontOffers } from "@/lib/services/reseller";

interface Params {
  "reseller-slug": string;
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { "reseller-slug": slug } = await params;
  const result = await getWLStorefrontOffers(slug);
  if (!result) return { title: "Not Found" };
  const name = (result.reseller as Record<string, unknown>).wl_global_display_name as string | null;
  return { title: name ?? slug };
}

export default async function WLStorefrontLandingPage({ params }: { params: Promise<Params> }) {
  const { "reseller-slug": slug } = await params;
  const result = await getWLStorefrontOffers(slug);
  if (!result) notFound();

  const { offers } = result;

  function formatCents(cents: number) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0 }).format(cents / 100);
  }

  return (
    <main className="min-h-screen bg-gray-50 px-4 py-12">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-2xl font-bold mb-6">Available Apps</h1>
        {offers.length === 0 ? (
          <p className="text-sm text-gray-700">No apps currently available.</p>
        ) : (
          <div className="space-y-4">
            {offers.map((offer) => {
              const app = (offer as Record<string, unknown>).apps as Record<string, unknown> | null;
              const offerSlug = (offer as Record<string, unknown>).slug as string;
              const displayName = (offer as Record<string, unknown>).wl_display_name as string | null;
              const logoUrl = (offer as Record<string, unknown>).wl_logo_url as string | null;
              const brandColor = (offer as Record<string, unknown>).wl_brand_color as string | null;
              const sellPrice = (offer as Record<string, unknown>).sell_price_cents as number;

              return (
                <a
                  key={offerSlug}
                  href={`/${offerSlug}`}
                  className="flex items-center gap-4 p-4 bg-white border border-gray-200 rounded-2xl hover:shadow-md transition-shadow"
                  style={brandColor ? { borderLeftColor: brandColor, borderLeftWidth: 4 } : undefined}
                >
                  {logoUrl ? (
                    <Image src={logoUrl} alt={displayName ?? "App"} width={48} height={48} className="rounded-xl object-cover" />
                  ) : app?.logo_url ? (
                    <Image src={app.logo_url as string} alt={app.name as string} width={48} height={48} className="rounded-xl object-cover" />
                  ) : (
                    <div className="w-12 h-12 rounded-xl bg-gray-100" />
                  )}
                  <div>
                    <p className="font-semibold">{displayName ?? (app?.name as string)}</p>
                    <p className="text-sm text-gray-700">{formatCents(sellPrice)}/mo</p>
                  </div>
                </a>
              );
            })}
          </div>
        )}
        <p className="text-xs text-gray-700 mt-8">Hosted by [PLATFORM]</p>
      </div>
    </main>
  );
}
