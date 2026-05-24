import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "@/types/supabase";
import { ROLE_DASHBOARDS, type UserRole } from "@/lib/auth/roles";
import { visitorHash, isBot, isDnt } from "@/lib/analytics/hash";
import { recordEvent } from "@/lib/services/analytics";
import { RESERVED_SLUGS } from "@/lib/reserved-slugs";

// Single source of truth — import from lib/reserved-slugs.ts.
// Never inline reserved names here; add them to lib/reserved-slugs.ts instead.
const RESERVED_SUBDOMAINS = RESERVED_SLUGS;

// Paths accessible without authentication.
// Note: each prefix is matched with `startsWith`, so a bare "/r" would also match
// "/reseller" (the reseller dashboard) and silently bypass auth. Storefront URLs are
// always /r/<reseller-slug>/<offer-slug> so the trailing slash form is exact enough.
const PUBLIC_PATHS = ["/login", "/signup", "/api/auth", "/api/webhooks", "/api/verify", "/.well-known", "/marketplace", "/app", "/r/", "/affiliates", "/_wl/", "/invite/"];
const AUTH_ONLY_PUBLIC = ["/login", "/signup"];

// Capture ?aff=<code> on any public page visit and set an HTTP-only attribution cookie.
// Returns a modified response (or the original if no capture needed).
async function captureAffiliateCookie(
  request: NextRequest,
  response: NextResponse
): Promise<NextResponse> {
  const affCode = request.nextUrl.searchParams.get("aff");
  if (!affCode) return response;

  // Validate code format: 1–16 alphanumeric chars (base62)
  if (!/^[0-9A-Za-z]{1,16}$/.test(affCode)) return response;

  // Existence validation via the admin API would need a DB call — skip here for performance.
  // Invalid codes are silently ignored at subscribe time (validateAffiliateCode returns null).
  // Self-referral check happens at subscribe time where we have the buyer identity.
  response.cookies.set("aff_code", affCode, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 30, // 30 days
    path: "/",
    secure: process.env.NODE_ENV === "production",
  });

  // Capture affiliate click event (fire-and-forget — never block the response).
  const ua = request.headers.get("user-agent") ?? "";
  if (!isBot(ua)) {
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      request.headers.get("x-real-ip") ??
      "unknown";
    const hash = isDnt(request.headers) ? null : await visitorHash(ip, ua, request.headers);
    recordEvent({
      event_type: "click",
      entity_type: "affiliate_link",
      entity_id: affCode, // resolved to link.id at query time; affCode is the stable handle
      visitor_hash: hash,
      referrer: request.headers.get("referer") ?? null,
      country:
        request.headers.get("cf-ipcountry") ??
        request.headers.get("x-vercel-ip-country") ??
        null,
    }).catch(() => void 0);
  }

  return response;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // ── Subdomain routing for Tier 2 WL storefronts ──────────────────────────
  // <reseller-slug>.<base-host> → internal rewrite to /_wl/<slug>/<path>
  // Buyer dashboard (/buyer) is always redirected to canonical domain (anti-poaching).
  const baseHost = (() => {
    try {
      return new URL(process.env.NEXT_PUBLIC_APP_URL!).host;
    } catch {
      return "";
    }
  })();

  const requestHost = (request.headers.get("host") ?? "").toLowerCase().split(":")[0];

  // ── Custom domain routing (#54 §5) — Cloudflare for SaaS pattern ─────────
  // Agency sets organizations.custom_domain = 'portal.acme-agency.com'.
  // Cloudflare for SaaS routes the request here via fallback origin.
  // proxy.ts resolves the agency slug from the Host header, then rewrites
  // to /_client/<slug> (same rewrite logic as subdomain WL).
  // Feature-flagged — off by default until Cloudflare for SaaS is wired.
  if (
    process.env.CUSTOM_DOMAINS_ENABLED === "true" &&
    baseHost &&
    requestHost !== baseHost &&
    !requestHost.endsWith(`.${baseHost}`)
  ) {
    // Custom domain: Host doesn't match base or any subdomain.
    // Future: look up organizations.custom_domain = requestHost → get agency slug.
    // For now, stub: fall through to standard routing.
    // Implementation note: DB lookup here would add latency to every request on
    // custom domains — cache the custom_domain → slug mapping in Redis (5min TTL).
  }

  if (baseHost) {
    const host = requestHost;
    if (host !== baseHost && host.endsWith(`.${baseHost}`)) {
      const slug = host.slice(0, host.length - baseHost.length - 1);
      if (!RESERVED_SUBDOMAINS.has(slug)) {
        // Buyer dashboard must never be WL-branded (anti-poaching)
        if (pathname.startsWith("/buyer")) {
          const canonical = new URL(`https://${baseHost}${pathname}${request.nextUrl.search}`);
          return NextResponse.redirect(canonical);
        }
        // Rewrite to internal WL route
        const url = request.nextUrl.clone();
        url.pathname = `/_wl/${slug}${pathname === "/" ? "" : pathname}`;
        return NextResponse.rewrite(url);
      }
    }
  }

  // ── Standard path-based routing ──────────────────────────────────────────
  // Static public paths (JWKS, API callbacks)
  if (
    PUBLIC_PATHS.some((p) => pathname.startsWith(p)) &&
    !AUTH_ONLY_PUBLIC.some((p) => pathname.startsWith(p))
  ) {
    const res = await refreshSession(request);
    return captureAffiliateCookie(request, res);
  }

  // For /login and /signup: let unauthenticated through, redirect authenticated to dashboard
  if (AUTH_ONLY_PUBLIC.some((p) => pathname.startsWith(p))) {
    const { response, user } = await getSessionUser(request);
    if (user) {
      const role = user.role as UserRole;
      return NextResponse.redirect(
        new URL(ROLE_DASHBOARDS[role] ?? "/buyer", request.url)
      );
    }
    return captureAffiliateCookie(request, response);
  }

  const { response, user } = await getSessionUser(request);

  if (!user) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Role-aware routing: redirect / to role dashboard
  if (pathname === "/") {
    const role = user.role as UserRole;
    return NextResponse.redirect(new URL(ROLE_DASHBOARDS[role] ?? "/buyer", request.url));
  }

  // Guard role-specific routes
  const rolePrefix = Object.entries(ROLE_DASHBOARDS).find(([, path]) =>
    pathname.startsWith(path)
  );
  if (rolePrefix && rolePrefix[0] !== user.role) {
    return NextResponse.redirect(
      new URL(ROLE_DASHBOARDS[user.role as UserRole] ?? "/buyer", request.url)
    );
  }

  return captureAffiliateCookie(request, response);
}

async function getSessionUser(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet) => {
          toSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          toSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();

  if (!authUser) return { response, user: null };

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", authUser.id)
    .single();

  return {
    response,
    user: profile ? { ...authUser, role: profile.role } : null,
  };
}

async function refreshSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet) => {
          toSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          toSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  await supabase.auth.getUser();
  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
