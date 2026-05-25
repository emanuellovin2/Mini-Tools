import { ReactNode } from "react";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { getActiveOrg } from "@/lib/services/org";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { NotificationBellConnected } from "@/components/layout/NotificationBellConnected";
import {
  getClientAgencyBranding,
  decodeBrandingCookie,
  COOKIE_NAME,
} from "@/lib/services/client-portal";

const CLIENT_NAV = [
  { label: "Dashboard",   href: "/client" },
  { label: "Deployments", href: "/client/deployments" },
  { label: "Account",     href: "/settings/account" },
];

export default async function ClientLayout({ children }: { children: ReactNode }) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { org } = await getActiveOrg();
  if (org.type !== "client") redirect("/login");

  // Resolve branding: prefer valid signed cookie, refresh if stale/missing.
  const cookieStore = await cookies();
  const rawCookie = cookieStore.get(COOKIE_NAME)?.value ?? null;
  let branding = rawCookie ? decodeBrandingCookie(rawCookie) : null;

  if (!branding) {
    branding = await getClientAgencyBranding(org.id);
    // Cookie will be set in the response headers via a route handler redirect;
    // for SSR layouts we set it inline via the cookies API when available.
    // In Next.js App Router, cookies() is read-only in layouts — the branding
    // is fetched fresh per layout render (cheap: one DB query per 1h per user).
  }

  const agencyName = branding?.displayName ?? null;
  const brandColor = branding?.brandColor ?? "#635bff";

  return (
    <DashboardShell
      nav={CLIENT_NAV}
      user={{ email: user.email ?? "", role: "client" }}
      testMode={process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_") ?? false}
      notificationBell={<NotificationBellConnected />}
    >
      {/* Agency branding strip */}
      {agencyName && (
        <div
          className="flex items-center gap-3 px-6 py-2 text-white text-xs font-medium"
          style={{ backgroundColor: brandColor }}
        >
          {branding?.logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={branding.logoUrl}
              alt={agencyName}
              className="h-5 w-auto object-contain"
            />
          )}
          <span>{agencyName}</span>
          <span className="ml-auto opacity-70">Hosted by [PLATFORM]</span>
        </div>
      )}

      {children}

      {!agencyName && (
        <footer className="px-6 py-3 text-xs text-muted-foreground text-center border-t border-border/40">
          Hosted by [PLATFORM]
        </footer>
      )}
    </DashboardShell>
  );
}
