import { ReactNode } from "react";
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getAgencyBrandingBySlug, encodeBrandingCookie, COOKIE_NAME, COOKIE_MAX_AGE } from "@/lib/services/client-portal";

interface Props {
  children: ReactNode;
  params: Promise<{ "agency-slug": string }>;
}

export default async function ClientBrandedLayout({ children, params }: Props) {
  const { "agency-slug": agencySlug } = await params;
  const branding = await getAgencyBrandingBySlug(agencySlug);
  if (!branding) notFound();

  // Set signed branding cookie so /client pages inherit branding without a DB call.
  const cookieStore = await cookies();
  const cookieValue = encodeBrandingCookie(branding);
  cookieStore.set(COOKIE_NAME, cookieValue, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: COOKIE_MAX_AGE,
    path: "/",
    secure: process.env.NODE_ENV === "production",
  });

  const brandColor = branding.brandColor;

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Agency branding header */}
      <header
        className="flex items-center gap-3 px-6 py-3 text-white"
        style={{ backgroundColor: brandColor }}
      >
        {branding.logoUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={branding.logoUrl}
            alt={branding.displayName}
            className="h-7 w-auto object-contain"
          />
        )}
        <span className="font-semibold">{branding.displayName}</span>
        <span className="ml-auto text-xs opacity-70">Hosted by [PLATFORM]</span>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="px-6 py-3 text-center text-xs text-muted-foreground border-t border-border/40">
        Hosted by [PLATFORM]
      </footer>
    </div>
  );
}
