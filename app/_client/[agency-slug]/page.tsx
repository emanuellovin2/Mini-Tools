import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAgencyBrandingBySlug } from "@/lib/services/client-portal";

interface Params {
  "agency-slug": string;
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { "agency-slug": agencySlug } = await params;
  const branding = await getAgencyBrandingBySlug(agencySlug);
  if (!branding) return { title: "Not Found" };
  return { title: `${branding.displayName} — Client Portal` };
}

export default async function ClientBrandedLandingPage({ params }: { params: Promise<Params> }) {
  const { "agency-slug": agencySlug } = await params;
  const branding = await getAgencyBrandingBySlug(agencySlug);
  if (!branding) notFound();

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-4 text-center">
      {branding.logoUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={branding.logoUrl}
          alt={branding.displayName}
          className="h-16 w-auto object-contain mb-6"
        />
      )}
      <h1 className="text-2xl font-bold text-foreground mb-2">
        {branding.displayName} Client Portal
      </h1>
      <p className="text-sm text-muted-foreground mb-8 max-w-xs">
        Sign in to view your deployments, outcome metrics, and account details.
      </p>
      <div className="flex flex-col gap-3 w-full max-w-[220px]">
        <Link
          href="/login?next=/client"
          className="block w-full rounded-lg py-2.5 text-sm font-medium text-white text-center"
          style={{ backgroundColor: branding.brandColor }}
        >
          Sign in
        </Link>
        <Link
          href="/client"
          className="block w-full rounded-lg py-2.5 text-sm font-medium text-foreground text-center border border-border hover:bg-muted transition-colors"
        >
          Go to portal
        </Link>
      </div>
    </div>
  );
}
