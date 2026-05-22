import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "@/types/supabase";
import { ROLE_DASHBOARDS, type UserRole } from "@/lib/auth/roles";

// Paths accessible without authentication
const PUBLIC_PATHS = ["/login", "/signup", "/api/auth", "/api/webhooks", "/api/verify", "/.well-known", "/marketplace", "/app"];
const AUTH_ONLY_PUBLIC = ["/login", "/signup"];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Static public paths (JWKS, API callbacks)
  if (
    PUBLIC_PATHS.some((p) => pathname.startsWith(p)) &&
    !AUTH_ONLY_PUBLIC.some((p) => pathname.startsWith(p))
  ) {
    return refreshSession(request);
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
    return response;
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

  return response;
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
