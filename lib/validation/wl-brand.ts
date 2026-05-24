// Deny-list and homoglyph normalization for reseller WL brand names.
// Applied to BOTH global mini-branding (Tier 1) and per-offer branding (Tier 2).
// Auto-approval shifts liability to reseller for trademark infringement per TOS.

const BRAND_DENY_LIST = [
  // Payment / platform brands
  "stripe", "paypal", "square", "apple", "google", "microsoft", "meta", "facebook",
  "amazon", "aws", "vercel", "supabase", "cloudflare", "openai", "anthropic",
  "claude", "chatgpt", "gpt", "platform",
  // Generic risky terms
  "admin", "official", "support", "verify", "secure", "security", "billing", "payment",
  // Reserved subdomains
  "www", "api", "auth", "app", "dashboard", "staging", "dev", "test", "mail", "ftp",
];

function normalize(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")                    // decompose homoglyphs
    .replace(/[^a-z0-9]/g, "")           // strip spaces, punctuation, emojis
    .replace(/0/g, "o")
    .replace(/1/g, "i")
    .replace(/5/g, "s")
    .replace(/3/g, "e")
    .replace(/[Ѐ-ӿ]/g, "");             // strip remaining Cyrillic
}

export function validateWLBrand(displayName: string): { ok: true } | { ok: false; reason: string } {
  const trimmed = displayName.trim();
  if (trimmed.length < 2 || trimmed.length > 60) {
    return { ok: false, reason: "length must be 2–60 chars" };
  }

  const norm = normalize(trimmed);
  if (norm.length < 2) {
    return { ok: false, reason: "must contain at least 2 alphanumeric chars" };
  }

  for (const banned of BRAND_DENY_LIST) {
    if (norm.includes(normalize(banned))) {
      return { ok: false, reason: `display name resembles a reserved/blocked brand (${banned})` };
    }
  }

  return { ok: true };
}

export const WL_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;
