import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/utils/rate-limit";
import { recordEventsBatch, type AnalyticsEvent, type EventType, type EntityType } from "@/lib/services/analytics";
import { visitorHash, isBot, isDnt } from "@/lib/analytics/hash";

const VALID_EVENT_TYPES = new Set<EventType>([
  "impression", "view", "click", "signup",
  "checkout_start", "checkout_complete", "launch",
  "storefront_visit", "marketplace_view",
]);
const VALID_ENTITY_TYPES = new Set<EntityType>([
  "app", "offer", "affiliate_link", "storefront",
  "agent", "workflow", "marketplace",
]);

// Batch limit: max 20 events per request.
const MAX_BATCH = 20;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown";
  const ua = req.headers.get("user-agent") ?? "";

  // Bot filter
  if (isBot(ua)) {
    return NextResponse.json({ ok: true, skipped: "bot" });
  }

  // Rate limit: 60 events/minute per IP (batches counted as 1 call)
  const { allowed } = await checkRateLimit(`events:${ip}`, 60, 60_000);
  if (!allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const rawEvents = Array.isArray(body) ? body : [body];
  if (rawEvents.length > MAX_BATCH) {
    return NextResponse.json({ error: "batch_too_large" }, { status: 400 });
  }

  const dnt = isDnt(req.headers);
  const hash = dnt ? null : await visitorHash(ip, ua, req.headers);

  const country = (req.headers.get("cf-ipcountry") ?? req.headers.get("x-vercel-ip-country") ?? null);

  const events: AnalyticsEvent[] = [];
  for (const raw of rawEvents) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    const event_type = e.event_type as EventType;
    const entity_type = e.entity_type as EntityType;
    const entity_id = typeof e.entity_id === "string" ? e.entity_id : null;

    if (!VALID_EVENT_TYPES.has(event_type) || !VALID_ENTITY_TYPES.has(entity_type) || !entity_id) {
      continue;
    }

    events.push({
      event_type,
      entity_type,
      entity_id,
      owner_org_id: typeof e.owner_org_id === "string" ? e.owner_org_id : null,
      affiliate_id: typeof e.affiliate_id === "string" ? e.affiliate_id : null,
      reseller_id: typeof e.reseller_id === "string" ? e.reseller_id : null,
      visitor_hash: hash,
      session_id: typeof e.session_id === "string" ? e.session_id.slice(0, 64) : null,
      referrer: typeof e.referrer === "string" ? e.referrer.slice(0, 512) : null,
      utm: e.utm && typeof e.utm === "object" && !Array.isArray(e.utm)
        ? (e.utm as Record<string, string>)
        : null,
      country,
    });
  }

  if (events.length > 0) {
    await recordEventsBatch(events);
  }

  return NextResponse.json({ ok: true, recorded: events.length });
}
