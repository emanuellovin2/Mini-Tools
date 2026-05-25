import crypto from "crypto";
import { createAdminClient } from "@/lib/services/supabase";
import { writeAuditLog } from "@/lib/services/admin";
import { enforceQuota } from "@/lib/quotas/enforce";
import { getStripe } from "@/lib/stripe/client";

// New tables (client_relationships, organizations.type extension) are not in the
// generated Database type yet — cast via any until `npm run types` is run.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAdmin = any;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RelationshipStatus = "invited" | "active" | "paused" | "ended";
export type RelationshipEndReason = "client_cancelled" | "agency_dropped" | "admin_action";

export interface ClientRelationship {
  id: string;
  agency_org_id: string;
  client_org_id: string;
  status: RelationshipStatus;
  invited_at: string;
  accepted_at: string | null;
  ended_at: string | null;
  ended_reason: RelationshipEndReason | null;
  created_at: string;
}

export interface AgencyClient {
  relationship: ClientRelationship;
  client_name: string;
  client_slug: string | null;
  active_deployment_count: number;
  last_activity_at: string | null;
}

// ---------------------------------------------------------------------------
// Agency org creation
// ---------------------------------------------------------------------------

/** Creates an agency org and makes the user its owner. */
export async function createAgencyOrg(
  userId: string,
  name: string,
  slug?: string
): Promise<{ id: string; name: string; type: string }> {
  const admin = createAdminClient() as AnyAdmin;

  const { data: org, error: orgErr } = await admin
    .from("organizations")
    .insert({ name, type: "agency", slug: slug ?? null })
    .select("id, name, type")
    .single();
  if (orgErr) throw new Error(`createAgencyOrg: ${orgErr.message}`);

  const { error: memberErr } = await admin
    .from("org_members")
    .insert({ org_id: org.id, user_id: userId, role: "owner" });
  if (memberErr) throw new Error(`createAgencyOrg membership: ${memberErr.message}`);

  await writeAuditLog({
    actorId: userId,
    actorRole: "agency",
    action: "agency_org.created",
    entityType: "organization",
    entityId: org.id,
    actorOrgId: org.id,
  });

  return org;
}

// ---------------------------------------------------------------------------
// Client org creation (by agency on behalf of a client)
// ---------------------------------------------------------------------------

/**
 * Creates a client org on behalf of an agency and opens an invited relationship.
 * The acting agency member is added as admin of the new client org so they can
 * configure deployments immediately. The client receives an invite email.
 */
export async function createClientOrgForAgency(
  agencyOrgId: string,
  clientName: string,
  primaryEmail: string,
  actorUserId: string
): Promise<{ orgId: string; relationshipId: string; inviteToken: string }> {
  await enforceQuota(agencyOrgId, "clients");

  const admin = createAdminClient() as AnyAdmin;

  // Create client org
  const { data: clientOrg, error: orgErr } = await admin
    .from("organizations")
    .insert({ name: clientName, type: "client" })
    .select("id")
    .single();
  if (orgErr) throw new Error(`createClientOrgForAgency org: ${orgErr.message}`);

  // Add the acting agency member as admin of the client org
  const { error: memberErr } = await admin
    .from("org_members")
    .insert({ org_id: clientOrg.id, user_id: actorUserId, role: "admin" });
  if (memberErr) throw new Error(`createClientOrgForAgency member: ${memberErr.message}`);

  // Open the relationship in 'invited' status
  const { data: rel, error: relErr } = await admin
    .from("client_relationships")
    .insert({
      agency_org_id: agencyOrgId,
      client_org_id: clientOrg.id,
      status: "invited",
      invited_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (relErr) throw new Error(`createClientOrgForAgency relationship: ${relErr.message}`);

  // Create an org invitation so the client can claim ownership via email
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  const { error: invErr } = await admin.from("org_invitations").insert({
    org_id: clientOrg.id,
    email: primaryEmail,
    role: "owner",
    token_hash: tokenHash,
    invited_by: actorUserId,
  });
  if (invErr) throw new Error(`createClientOrgForAgency invite: ${invErr.message}`);

  await writeAuditLog({
    actorId: actorUserId,
    actorRole: "agency",
    action: "client_org.created",
    entityType: "organization",
    entityId: clientOrg.id,
    actorOrgId: agencyOrgId,
    metadata: { relationship_id: rel.id, primary_email: primaryEmail },
  });

  return { orgId: clientOrg.id, relationshipId: rel.id, inviteToken: token };
}

// ---------------------------------------------------------------------------
// Invite an existing client (by email) to an agency relationship
// ---------------------------------------------------------------------------

/**
 * Invites a client (identified by email) to be managed by the agency.
 * If no org exists for that email yet, creates a client org first.
 */
export async function inviteClient(
  agencyOrgId: string,
  clientEmail: string,
  prefilledName: string,
  actorUserId: string
): Promise<{ relationshipId: string; inviteToken: string }> {
  await enforceQuota(agencyOrgId, "clients");

  const admin = createAdminClient() as AnyAdmin;

  // Look up existing user by email
  const { data: { users } } = await admin.auth.admin.listUsers();
  const existingUser = users.find((u: { id: string; email?: string }) => u.email?.toLowerCase() === clientEmail.toLowerCase());

  let clientOrgId: string;

  if (existingUser) {
    // Find or create a personal/client org for this user
    const { data: membership } = await admin
      .from("org_members")
      .select("org_id, organizations!inner(type)")
      .eq("user_id", existingUser.id)
      .in("organizations.type", ["personal", "client"])
      .maybeSingle();

    if (membership) {
      clientOrgId = membership.org_id;
    } else {
      const { data: newOrg, error } = await admin
        .from("organizations")
        .insert({ name: prefilledName, type: "client" })
        .select("id")
        .single();
      if (error) throw new Error(`inviteClient org: ${error.message}`);
      await admin.from("org_members").insert({
        org_id: newOrg.id,
        user_id: existingUser.id,
        role: "owner",
      });
      clientOrgId = newOrg.id;
    }
  } else {
    // No user yet — create a placeholder client org
    const { data: newOrg, error } = await admin
      .from("organizations")
      .insert({ name: prefilledName, type: "client" })
      .select("id")
      .single();
    if (error) throw new Error(`inviteClient org: ${error.message}`);
    clientOrgId = newOrg.id;
  }

  // Check for existing relationship
  const { data: existingRel } = await admin
    .from("client_relationships")
    .select("id, status")
    .eq("agency_org_id", agencyOrgId)
    .eq("client_org_id", clientOrgId)
    .maybeSingle();

  if (existingRel && existingRel.status === "active") {
    throw new Error("This client already has an active relationship with your agency");
  }

  const { data: rel, error: relErr } = await admin
    .from("client_relationships")
    .insert({
      agency_org_id: agencyOrgId,
      client_org_id: clientOrgId,
      status: "invited",
      invited_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (relErr) throw new Error(`inviteClient relationship: ${relErr.message}`);

  // Org invitation for the client to accept
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  const { error: invErr } = await admin.from("org_invitations").insert({
    org_id: clientOrgId,
    email: clientEmail,
    role: "owner",
    token_hash: tokenHash,
    invited_by: actorUserId,
  });
  if (invErr) throw new Error(`inviteClient invite: ${invErr.message}`);

  await writeAuditLog({
    actorId: actorUserId,
    actorRole: "agency",
    action: "client_relationship.invited",
    entityType: "client_relationship",
    entityId: rel.id,
    actorOrgId: agencyOrgId,
    metadata: { client_org_id: clientOrgId, client_email: clientEmail },
  });

  return { relationshipId: rel.id, inviteToken: token };
}

// ---------------------------------------------------------------------------
// Accept agency invite (called by client owner)
// ---------------------------------------------------------------------------

/** Client owner accepts an agency invite. Transitions status: invited → active. */
export async function acceptAgencyInvite(
  token: string,
  userId: string
): Promise<{ relationshipId: string; agencyOrgId: string }> {
  const admin = createAdminClient() as AnyAdmin;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  // Resolve the org invitation to find which client org this is for
  const { data: invite, error: invErr } = await admin
    .from("org_invitations")
    .select("id, org_id, role, email, expires_at, accepted_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (invErr || !invite) throw new Error("Invalid or expired invite token");
  if (invite.accepted_at) throw new Error("Invite already accepted");
  if (new Date(invite.expires_at) < new Date()) throw new Error("Invite has expired");

  const { data: { user } } = await admin.auth.admin.getUserById(userId);
  if (!user || user.email?.toLowerCase() !== invite.email.toLowerCase()) {
    throw new Error("This invite was sent to a different email address");
  }

  // Find the relationship for this client org
  const { data: rel, error: relErr } = await admin
    .from("client_relationships")
    .select("id, agency_org_id, status")
    .eq("client_org_id", invite.org_id)
    .eq("status", "invited")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (relErr || !rel) throw new Error("No pending agency invite found for this org");

  // Add user as member of their client org if not already
  const { data: existing } = await admin
    .from("org_members")
    .select("id")
    .eq("org_id", invite.org_id)
    .eq("user_id", userId)
    .maybeSingle();

  if (!existing) {
    await admin.from("org_members").insert({
      org_id: invite.org_id,
      user_id: userId,
      role: invite.role,
    });
  }

  // Transition relationship to active
  const now = new Date().toISOString();
  await admin
    .from("client_relationships")
    .update({ status: "active", accepted_at: now })
    .eq("id", rel.id);

  // Mark invite as accepted
  await admin
    .from("org_invitations")
    .update({ accepted_at: now })
    .eq("id", invite.id);

  await writeAuditLog({
    actorId: userId,
    actorRole: "client",
    action: "client_relationship.accepted",
    entityType: "client_relationship",
    entityId: rel.id,
    actorOrgId: invite.org_id,
    metadata: { agency_org_id: rel.agency_org_id },
  });

  // Enqueue agency-branded welcome email (fire-and-forget; idempotent via rel.id key)
  void (async () => {
    try {
      const { enqueueJob } = await import("@/lib/jobs/queue");

      const { data: agencyOrg } = await admin
        .from("organizations")
        .select("name, slug, portal_branding")
        .eq("id", rel.agency_org_id)
        .maybeSingle();

      const pb = (agencyOrg?.portal_branding as Record<string, string> | null) ?? {};
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://localhost:3000";
      const agencySlug = (agencyOrg?.slug as string | null) ?? null;
      const portalUrl = agencySlug
        ? `${baseUrl}/_client/${agencySlug}/`
        : `${baseUrl}/client`;

      await enqueueJob(
        "client_welcome_email",
        {
          clientEmail: invite.email,
          clientName: invite.email.split("@")[0],
          agencyName: pb.display_name ?? agencyOrg?.name ?? null,
          agencyLogoUrl: pb.logo_url ?? null,
          agencyBrandColor: pb.brand_color ?? null,
          portalUrl,
        },
        {
          idempotencyKey: `client_welcome:${rel.id}`,
          orgId: rel.agency_org_id,
        }
      );
    } catch (e) {
      console.error(JSON.stringify({ event: "client_welcome_email.enqueue_failed", relId: rel.id, error: String(e) }));
    }
  })();

  return { relationshipId: rel.id, agencyOrgId: rel.agency_org_id };
}

// ---------------------------------------------------------------------------
// Pause / end relationship
// ---------------------------------------------------------------------------

export async function pauseRelationship(
  relId: string,
  actorOrgId: string,
  actorUserId: string
): Promise<void> {
  const admin = createAdminClient() as AnyAdmin;
  const { data: rel, error } = await admin
    .from("client_relationships")
    .select("id, agency_org_id, client_org_id, status")
    .eq("id", relId)
    .single();
  if (error || !rel) throw new Error("Relationship not found");

  if (rel.agency_org_id !== actorOrgId && rel.client_org_id !== actorOrgId) {
    throw new Error("Not authorized to pause this relationship");
  }
  if (rel.status !== "active") throw new Error(`Cannot pause a ${rel.status} relationship`);

  await admin
    .from("client_relationships")
    .update({ status: "paused" })
    .eq("id", relId);

  await writeAuditLog({
    actorId: actorUserId,
    actorRole: "agency",
    action: "client_relationship.paused",
    entityType: "client_relationship",
    entityId: relId,
    actorOrgId,
  });
}

export async function endRelationship(
  relId: string,
  reason: RelationshipEndReason,
  actorOrgId: string,
  actorUserId: string
): Promise<void> {
  const admin = createAdminClient() as AnyAdmin;
  const { data: rel, error } = await admin
    .from("client_relationships")
    .select("id, agency_org_id, client_org_id, status")
    .eq("id", relId)
    .single();
  if (error || !rel) throw new Error("Relationship not found");

  if (rel.agency_org_id !== actorOrgId && rel.client_org_id !== actorOrgId) {
    throw new Error("Not authorized to end this relationship");
  }
  if (rel.status === "ended") throw new Error("Relationship is already ended");

  const now = new Date().toISOString();
  await admin
    .from("client_relationships")
    .update({ status: "ended", ended_at: now, ended_reason: reason })
    .eq("id", relId);
  // Trigger cr_orphan_on_end fires on the DB side — active deployments become 'orphaned'.

  await writeAuditLog({
    actorId: actorUserId,
    actorRole: rel.agency_org_id === actorOrgId ? "agency" : "client",
    action: "client_relationship.ended",
    entityType: "client_relationship",
    entityId: relId,
    actorOrgId,
    metadata: { reason },
  });
}

// ---------------------------------------------------------------------------
// List clients for an agency
// ---------------------------------------------------------------------------

export async function listAgencyClients(agencyOrgId: string): Promise<AgencyClient[]> {
  const admin = createAdminClient() as AnyAdmin;

  const { data, error } = await admin
    .from("client_relationships")
    .select(`
      id, agency_org_id, client_org_id, status,
      invited_at, accepted_at, ended_at, ended_reason, created_at,
      organizations!client_org_id (name, slug)
    `)
    .eq("agency_org_id", agencyOrgId)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`listAgencyClients: ${error.message}`);

  // Fetch deployment counts per client in one query
  const clientIds = (data ?? []).map((r: { client_org_id: string }) => r.client_org_id);
  let deploymentCounts: Record<string, number> = {};

  if (clientIds.length) {
    const { data: counts } = await admin
      .from("solution_deployments")
      .select("client_org_id")
      .in("client_org_id", clientIds)
      .eq("agency_org_id", agencyOrgId)
      .eq("status", "active");

    for (const row of (counts ?? []) as { client_org_id: string }[]) {
      deploymentCounts[row.client_org_id] = (deploymentCounts[row.client_org_id] ?? 0) + 1;
    }
  }

  return (data ?? []).map((r: Record<string, unknown>) => {
    const org = r.organizations as unknown as { name: string; slug: string | null } | null;
    const clientOrgId = r.client_org_id as string;
    return {
      relationship: {
        id: r.id as string,
        agency_org_id: r.agency_org_id as string,
        client_org_id: clientOrgId,
        status: r.status as RelationshipStatus,
        invited_at: r.invited_at as string,
        accepted_at: (r.accepted_at as string | null) ?? null,
        ended_at: (r.ended_at as string | null) ?? null,
        ended_reason: (r.ended_reason as RelationshipEndReason | null) ?? null,
        created_at: r.created_at as string,
      },
      client_name: org?.name ?? "(unknown)",
      client_slug: org?.slug ?? null,
      active_deployment_count: deploymentCounts[clientOrgId] ?? 0,
      last_activity_at: null, // populated by #52 analytics join
    };
  });
}

// ---------------------------------------------------------------------------
// Adopt orphaned deployment (client takes over after agency departs)
// ---------------------------------------------------------------------------
export async function adoptOrphanedDeployment(
  deploymentId: string,
  clientOrgId: string,
  actorUserId: string
): Promise<void> {
  const admin = createAdminClient() as AnyAdmin;
  const { data: dep, error } = await admin
    .from("solution_deployments")
    .select("id, client_org_id, status")
    .eq("id", deploymentId)
    .single();

  if (error || !dep) throw new Error("Deployment not found");
  if (dep.client_org_id !== clientOrgId) throw new Error("Not authorized");
  if (dep.status !== "orphaned") throw new Error("Deployment is not orphaned");

  await admin
    .from("solution_deployments")
    .update({ agency_org_id: null, status: "active", activated_at: new Date().toISOString() })
    .eq("id", deploymentId);

  await writeAuditLog({
    actorId: actorUserId,
    actorRole: "client",
    action: "deployment.adopted",
    entityType: "solution_deployment",
    entityId: deploymentId,
    actorOrgId: clientOrgId,
  });
}

// ---------------------------------------------------------------------------
// #52 Agency health board
// ---------------------------------------------------------------------------

export interface ClientHealthScore {
  id: string;
  agency_org_id: string;
  client_org_id: string;
  relationship_id: string;
  client_name: string;
  client_slug: string | null;
  score: number;
  churn_risk: "low" | "medium" | "high";
  active_deployments: number;
  failed_deployments: number;
  orphaned_deployments: number;
  metric_events_7d: number;
  last_activity_at: string | null;
  credits_remaining_cents: number;
  days_since_accepted: number | null;
  computed_at: string;
}

export interface HealthBoardPage {
  items: ClientHealthScore[];
  next_cursor: string | null;
}

/**
 * Cursor-paginated (keyset on client_org_id) list of health scores for an agency.
 * Sorted by score ASC (most-at-risk first) then client_org_id ASC for stable paging.
 * Never uses OFFSET.
 */
export async function getAgencyHealthBoard(
  agencyOrgId: string,
  limit = 25,
  cursor?: string // last client_org_id from previous page
): Promise<HealthBoardPage> {
  const admin = createAdminClient() as AnyAdmin;

  let query = admin
    .from("client_health_scores")
    .select(`
      id, agency_org_id, client_org_id, relationship_id,
      score, churn_risk,
      active_deployments, failed_deployments, orphaned_deployments,
      metric_events_7d, last_activity_at, credits_remaining_cents, days_since_accepted,
      computed_at,
      organizations!client_org_id(name, slug)
    `)
    .eq("agency_org_id", agencyOrgId)
    .order("score", { ascending: true })
    .order("client_org_id", { ascending: true })
    .limit(limit + 1);

  if (cursor) {
    // Keyset: (score, client_org_id) > cursor row. We encode cursor as base64 "score:id".
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const [scoreStr, lastId] = decoded.split(":");
    const score = parseInt(scoreStr, 10);
    // Rows where score > pivot OR (score = pivot AND id > lastId)
    query = query.or(`score.gt.${score},and(score.eq.${score},client_org_id.gt.${lastId})`);
  }

  const { data, error } = await query;
  if (error) throw new Error(`getAgencyHealthBoard: ${error.message}`);

  const rows = (data ?? []) as (Record<string, unknown> & {
    organizations: { name: string; slug: string | null } | null;
  })[];

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  let next_cursor: string | null = null;
  if (hasMore) {
    const last = page[page.length - 1];
    const raw = `${last.score}:${last.client_org_id}`;
    next_cursor = Buffer.from(raw, "utf8").toString("base64url");
  }

  const items: ClientHealthScore[] = page.map((r) => ({
    id: r.id as string,
    agency_org_id: r.agency_org_id as string,
    client_org_id: r.client_org_id as string,
    relationship_id: r.relationship_id as string,
    client_name: r.organizations?.name ?? "(unknown)",
    client_slug: r.organizations?.slug ?? null,
    score: r.score as number,
    churn_risk: r.churn_risk as "low" | "medium" | "high",
    active_deployments: r.active_deployments as number,
    failed_deployments: r.failed_deployments as number,
    orphaned_deployments: r.orphaned_deployments as number,
    metric_events_7d: r.metric_events_7d as number,
    last_activity_at: (r.last_activity_at as string | null) ?? null,
    credits_remaining_cents: r.credits_remaining_cents as number,
    days_since_accepted: (r.days_since_accepted as number | null) ?? null,
    computed_at: r.computed_at as string,
  }));

  return { items, next_cursor };
}

/** Trigger an on-demand refresh of health scores for an agency org. */
export async function triggerHealthScoreRefresh(agencyOrgId: string): Promise<number> {
  const admin = createAdminClient() as AnyAdmin;
  const { data, error } = await admin.rpc("refresh_client_health_scores", {
    p_agency_org_id: agencyOrgId,
  });
  if (error) throw new Error(`triggerHealthScoreRefresh: ${error.message}`);
  return (data as number) ?? 0;
}

// ---------------------------------------------------------------------------
// #52 Stripe Connect balance + payouts (for the agency's own Connect account)
// ---------------------------------------------------------------------------

export interface AgencyBalance {
  connected: boolean;
  available_cents: number;
  pending_cents: number;
  currency: string;
  charges_enabled: boolean;
  payouts_enabled: boolean;
}

export interface AgencyPayout {
  id: string;
  amount_cents: number;
  currency: string;
  status: string;
  arrival_date: number;
  created: number;
}

export async function getAgencyBalance(agencyOrgId: string): Promise<AgencyBalance> {
  const admin = createAdminClient() as AnyAdmin;
  const { data: org } = await admin
    .from("organizations")
    .select("stripe_account_id, charges_enabled, payouts_enabled")
    .eq("id", agencyOrgId)
    .maybeSingle();

  if (!org?.stripe_account_id) {
    return {
      connected: false,
      available_cents: 0,
      pending_cents: 0,
      currency: "usd",
      charges_enabled: false,
      payouts_enabled: false,
    };
  }

  try {
    const stripe = getStripe();
    const balance = await stripe.balance.retrieve(
      {},
      { stripeAccount: org.stripe_account_id }
    );
    return {
      connected: true,
      available_cents: balance.available.reduce((s, b) => s + b.amount, 0),
      pending_cents: balance.pending.reduce((s, b) => s + b.amount, 0),
      currency: balance.available[0]?.currency ?? "usd",
      charges_enabled: org.charges_enabled ?? false,
      payouts_enabled: org.payouts_enabled ?? false,
    };
  } catch {
    return {
      connected: true,
      available_cents: 0,
      pending_cents: 0,
      currency: "usd",
      charges_enabled: org.charges_enabled ?? false,
      payouts_enabled: org.payouts_enabled ?? false,
    };
  }
}

export async function getAgencyPayouts(
  agencyOrgId: string,
  limit = 10
): Promise<AgencyPayout[]> {
  const admin = createAdminClient() as AnyAdmin;
  const { data: org } = await admin
    .from("organizations")
    .select("stripe_account_id")
    .eq("id", agencyOrgId)
    .maybeSingle();

  if (!org?.stripe_account_id) return [];

  try {
    const stripe = getStripe();
    const payouts = await stripe.payouts.list(
      { limit },
      { stripeAccount: org.stripe_account_id }
    );
    return payouts.data.map((p) => ({
      id: p.id,
      amount_cents: p.amount,
      currency: p.currency,
      status: p.status,
      arrival_date: p.arrival_date,
      created: p.created,
    }));
  } catch {
    return [];
  }
}
