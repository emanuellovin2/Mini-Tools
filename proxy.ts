import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "@/types/supabase";
import { ROLE_DASHBOARDS, type UserRole } from "@/lib/auth/roles";

// Subdomains reserved for platform use — cannot be registered as reseller slugs.
const RESERVED_SUBDOMAINS = new Set([
  "www", "api", "admin", "auth", "app", "dashboard", "support", "help",
  "mail", "email", "ftp", "ns1", "ns2", "staging", "dev", "test", "prod",
]);

// Paths accessible without authentication.
// Note: each prefix is matched with `startsWith`, so a bare "/r" would also match
// "/reseller" (the reseller dashboard) and silently bypass auth. Storefront URLs are
// always /r/<reseller-slug>/<offer-slug> so the trailing slash form is exact enough.
const PUBLIC_PATHS = ["/login", "/signup", "/api/auth", "/api/webhooks", "/api/verify", "/.well-known", "/marketplace", "/app", "/r/", "/affiliates", "/_wl/"];
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
  if (baseHost) {
    const host = (request.headers.get("host") ?? "").toLowerCase().split(":")[0];
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
