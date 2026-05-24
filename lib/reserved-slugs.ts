// ---------------------------------------------------------------------------
// Single source of truth for reserved identifiers.
//
// Imported by:
//   - proxy.ts           (subdomain routing guard)
//   - reseller signup    (#29 slug validation)
//   - affiliate signup   (#25 vanity slug validation)
//   - agency slug create (#50)
//   - custom domain val  (#54 §5)
//
// Adding a reserved name = one line edit here. Impossible to forget a surface.
// ---------------------------------------------------------------------------

// Operational subdomain names — these run platform infrastructure
const OPERATIONAL = [
  "www", "api", "admin", "auth", "app", "dashboard",
  "support", "help", "mail", "email", "ftp",
  "ns1", "ns2", "staging", "dev", "test", "prod",
  "portal", "clients", "billing", "legal", "status",
];

// Reserved business-function names — would cause brand confusion
const BUSINESS = [
  "platform", "security", "abuse", "postmaster", "hostmaster",
  "webmaster", "affiliate", "reseller", "agency", "vendor",
  "marketplace", "store", "shop", "checkout", "payment",
  "docs", "blog", "news", "press", "careers", "jobs",
];

export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  ...OPERATIONAL,
  ...BUSINESS,
]);

/**
 * Returns true if the slug is reserved and cannot be used.
 * Applies homoglyph normalisation (reuses wl-brand logic) to catch lookalikes.
 */
export function isReservedSlug(slug: string): boolean {
  const norm = normalizeSlug(slug);
  for (const reserved of RESERVED_SLUGS) {
    if (norm === normalizeSlug(reserved)) return true;
  }
  return false;
}

/** NFKD + lower + strip non-alnum — matches wl-brand normalisation */
function normalizeSlug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]/g, "")
    .replace(/0/g, "o")
    .replace(/1/g, "i")
    .replace(/5/g, "s")
    .replace(/3/g, "e");
}
