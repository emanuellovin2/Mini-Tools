import type { SearchIndexHealth } from "@/lib/search/index";
import { getPostgresSolutionsHealth } from "@/lib/search/postgres/solutions";

// Admin dashboard calls this to surface index backlog + status.
// When flipped to external search, swap the impl below.
export async function getSolutionsIndexHealth(): Promise<SearchIndexHealth> {
  return getPostgresSolutionsHealth();
}

// Future: getSolutionsIndexHealth for agents / workflows declared here when #41/#42 land.
