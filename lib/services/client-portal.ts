import crypto from "crypto";
import { Redis } from "@upstash/redis";
import { createAdminClient } from "@/lib/services/supabase";
import { getClientOutcomeSummary } from "@/lib/services/outcomes";
import { getUsageBalance } from "@/lib/services/usage";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAdmin = any;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgencyBranding {
  agencyOrgId: string;
  agencyName: string;
  displayName: string;
  logoUrl: string | null;
  brandColor: string;
  brandingVersion: number;
}

export interface ClientPortalData {
  clientOrgId: string;
  clientName: string;
  agencyBranding: AgencyBranding | null;
}

// ---------------------------------------------------------------------------
// Redis singleton
// ---------------------------------------------------------------------------

let _redis: Redis | null = null;
function getRedis(): Redis | null {
  if (_redis) return _redis;
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    _redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    });
  }
  return _redis;
}

// ---------------------------------------------------------------------------
// Branding — fetch + Redis version gate
// ---------------------------------------------------------------------------

/**
 * Returns the active agency's branding for a client org, or null if no active
 * relationship. Checks `branding_version:{clientOrgId}` in Redis to detect
 * stale cookies without issuing a full DB read on every request.
 */
export async function getClientAgencyBranding(
  clientOrgId: string
): Promise<AgencyBranding | null> {
  const admin = createAdminClient() as AnyAdmin;

  const { data: rel } = await admin
    .from("client_relationships")
    .select(`
      id,
      agency_org_id,
      organizations!agency_org_id(
        id, name, slug, portal_branding
      )
    `)
    .eq("client_org_id", clientOrgId)
    .eq("status", "active")
    .maybeSingle();

  if (!rel) return null;

  const agency = rel.organizations as {
    id: string;
    name: string;
    slug: string | null;
    portal_branding: Record<string, string> | null;
  } | null;
  if (!agency) return null;

  const branding = agency.portal_branding ?? {};
  return {
    agencyOrgId: agency.id,
    agencyName: agency.name,
    displayName: branding.display_name ?? agency.name,
    logoUrl: branding.logo_url ?? null,
    brandColor: branding.brand_color ?? "#635bff",
    brandingVersion: await getBrandingVersion(clientOrgId),
  };
}

/** Lookup agency branding by the agency's slug (for subdomain routing). */
export async function getAgencyBrandingBySlug(
  agencySlug: string
): Promise<AgencyBranding | null> {
  const admin = createAdminClient() as AnyAdmin;

  const { data: agency } = await admin
    .from("organizations")
    .select("id, name, slug, portal_branding")
    .eq("slug", agencySlug)
    .eq("type", "agency")
    .maybeSingle();

  if (!agency) return null;

  const branding = (agency.portal_branding as Record<string, string> | null) ?? {};
  return {
    agencyOrgId: agency.id,
    agencyName: agency.name,
    displayName: branding.display_name ?? agency.name,
    logoUrl: branding.logo_url ?? null,
    brandColor: branding.brand_color ?? "#635bff",
    brandingVersion: 0, // version not client-scoped at slug level
  };
}

/** Check the slug → org type (agency or not) with Redis cache (5 min). */
export async function resolveSlugOrgType(
  slug: string
): Promise<"agency" | "reseller" | null> {
  const redis = getRedis();
  const cacheKey = `slug_org_type:${slug}`;

  if (redis) {
    const cached = await redis.get<string>(cacheKey).catch(() => null);
    if (cached === "agency") return "agency";
    if (cached === "reseller") return "reseller";
    if (cached === "null") return null;
  }

  const admin = createAdminClient() as AnyAdmin;
  const { data: org } = await admin
    .from("organizations")
    .select("type")
    .eq("slug", slug)
    .eq("type", "agency")
    .maybeSingle();

  const result: "agency" | "reseller" | null = org ? "agency" : "reseller";

  if (redis) {
    await redis.set(cacheKey, result ?? "null", { ex: 300 }).catch(() => null);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Branding version (Redis counter for cookie invalidation)
// ---------------------------------------------------------------------------

const BRANDING_VERSION_TTL = 86_400 * 7; // 7 days

async function getBrandingVersion(clientOrgId: string): Promise<number> {
  const redis = getRedis();
  if (!redis) return 0;
  const v = await redis.get<number>(`branding_version:${clientOrgId}`).catch(() => null);
  return v ?? 0;
}

/** Call this whenever agency portal_branding is updated to invalidate client cookies. */
export async function bumpBrandingVersion(clientOrgId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis
    .incr(`branding_version:${clientOrgId}`)
    .then(() => redis.expire(`branding_version:${clientOrgId}`, BRANDING_VERSION_TTL))
    .catch(() => null);
}

// ---------------------------------------------------------------------------
// Signed branding cookie (HMAC-SHA256, 1h TTL)
// ---------------------------------------------------------------------------

const COOKIE_NAME = "cp_branding";
const COOKIE_MAX_AGE = 3600; // 1 hour

function getBrandingSecret(): string {
  return process.env.CLIENT_BRANDING_SECRET ?? "dev-cp-secret-not-for-production";
}

function signPayload(payload: string): string {
  return crypto
    .createHmac("sha256", getBrandingSecret())
    .update(payload)
    .digest("base64url");
}

export function encodeBrandingCookie(branding: AgencyBranding): string {
  const payload = JSON.stringify({
    a: branding.agencyOrgId,
    n: branding.displayName,
    l: branding.logoUrl,
    c: branding.brandColor,
    v: branding.brandingVersion,
    exp: Math.floor(Date.now() / 1000) + COOKIE_MAX_AGE,
  });
  const b64 = Buffer.from(payload).toString("base64url");
  const sig = signPayload(b64);
  return `${b64}.${sig}`;
}

export function decodeBrandingCookie(value: string): AgencyBranding | null {
  const dot = value.lastIndexOf(".");
  if (dot === -1) return null;
  const b64 = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (signPayload(b64) !== sig) return null;

  try {
    const obj = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
    if (typeof obj.exp !== "number" || obj.exp < Math.floor(Date.now() / 1000)) return null;
    return {
      agencyOrgId: obj.a,
      agencyName: obj.n,
      displayName: obj.n,
      logoUrl: obj.l ?? null,
      brandColor: obj.c ?? "#635bff",
      brandingVersion: obj.v ?? 0,
    };
  } catch {
    return null;
  }
}

export { COOKIE_NAME, COOKIE_MAX_AGE };

// ---------------------------------------------------------------------------
// Client portal data aggregation
// ---------------------------------------------------------------------------

export async function getClientPortalSummary(
  clientOrgId: string,
  userId: string
): Promise<{
  outcomeSummary: Awaited<ReturnType<typeof getClientOutcomeSummary>>;
  walletBalance: { balanceCents: number };
  deploymentCount: number;
}> {
  const admin = createAdminClient() as AnyAdmin;

  const [outcomeSummary, walletBalance, depResult] = await Promise.all([
    getClientOutcomeSummary(clientOrgId).catch(() => []),
    getUsageBalance(userId).catch(() => ({ balanceCents: 0 })),
    admin
      .from("solution_deployments")
      .select("id", { count: "exact", head: true })
      .eq("client_org_id", clientOrgId)
      .in("status", ["active", "pending_setup"]),
  ]);

  return {
    outcomeSummary,
    walletBalance,
    deploymentCount: (depResult.count as number | null) ?? 0,
  };
}
