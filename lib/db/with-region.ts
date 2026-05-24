// ---------------------------------------------------------------------------
// Region router stub — routes DB connections to the correct regional cluster.
//
// Current impl: single region (us-east-1), pass-through.
// Future: when a second region is provisioned, route by organizations.region.
//
// Cross-region reads (agency in US managing EU client) are explicit + audited.
// ---------------------------------------------------------------------------

export type Region = "us-east-1" | "eu-west-1" | "ap-southeast-1";

export const DEFAULT_REGION: Region = "us-east-1";

export interface RegionContext {
  region: Region;
  crossRegion?: boolean;
}

/**
 * Resolves the DB region for a given org.
 * Single-region impl: always returns us-east-1.
 * Multi-region impl: look up organizations.region and route accordingly.
 */
export function resolveRegion(_orgId: string): Region {
  // Future: return await getOrgRegion(orgId);
  return DEFAULT_REGION;
}

/**
 * Whether a request crosses region boundaries (agent in US, client in EU).
 * When true, the access should be logged as `cross_region_read` in audit_log.
 */
export function isCrossRegion(actorRegion: Region, targetRegion: Region): boolean {
  return actorRegion !== targetRegion;
}
