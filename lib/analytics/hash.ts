// Salted daily-rotating visitor hash — no raw IP, no durable fingerprint, no PII.
// Salt rotates every UTC day so hashes are not linkable across days.
// DNT / GPC respected: returns null when the header is set.

const SALT_SECRET = process.env.ANALYTICS_SALT_SECRET ?? "dev-salt-not-for-production";

// Returns null when the caller signals Do-Not-Track.
export function isDnt(headers: Headers): boolean {
  return headers.get("dnt") === "1" || headers.get("sec-gpc") === "1";
}

// Derive a salted daily-rotating hash for the given fingerprint material.
// Result is a 16-hex-char prefix — enough entropy for cardinality, not re-ID.
export async function visitorHash(
  ip: string,
  ua: string,
  headers: Headers
): Promise<string | null> {
  if (isDnt(headers)) return null;

  const date = new Date().toISOString().slice(0, 10); // e.g. "2026-05-24"
  const material = `${SALT_SECRET}:${date}:${ip}:${ua}`;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(SALT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(material));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex.slice(0, 16);
}

// Known bot patterns — coarse filter to avoid polluting funnels.
const BOT_PATTERN =
  /bot|crawl|spider|slurp|mediapartners|lighthouse|headless|prerender|wget|curl|python-requests|go-http-client/i;

export function isBot(ua: string): boolean {
  return BOT_PATTERN.test(ua);
}
