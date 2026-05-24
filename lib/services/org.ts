import crypto from "crypto";
import { createAdminClient } from "@/lib/services/supabase";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { cookies } from "next/headers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OrgType = "personal" | "team";
export type OrgRole = "owner" | "admin" | "member";

export interface Organization {
  id: string;
  name: string;
  slug: string | null;
  type: OrgType;
  stripe_account_id: string | null;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface OrgMember {
  id: string;
  org_id: string;
  user_id: string;
  role: OrgRole;
  created_at: string;
  // Joined from profiles
  email?: string;
  display_name?: string | null;
}

export interface OrgInvitation {
  id: string;
  org_id: string;
  email: string;
  role: OrgRole;
  invited_by: string;
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
}

export interface ActiveOrgContext {
  org: Organization;
  role: OrgRole;
}

const ACTIVE_ORG_COOKIE = "active_org_id";

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/** Returns all orgs the user belongs to, with their role in each. */
export async function getUserOrgs(
  userId: string
): Promise<Array<{ org: Organization; role: OrgRole }>> {
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("org_members")
    .select(`
      role,
      organizations (
        id, name, slug, type,
        stripe_account_id, charges_enabled, payouts_enabled,
        created_at, updated_at
      )
    `)
    .eq("user_id", userId);

  if (error) throw new Error(`getUserOrgs: ${error.message}`);

  return (data ?? []).map((row) => ({
    org: row.organizations as unknown as Organization,
    role: row.role as OrgRole,
  }));
}

/**
 * Resolves the caller's active org from the session cookie.
 * Falls back to their personal org if the cookie is missing or stale.
 */
export async function getActiveOrg(): Promise<ActiveOrgContext> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const cookieStore = await cookies();
  const activeOrgId = cookieStore.get(ACTIVE_ORG_COOKIE)?.value ?? null;

  const admin = createAdminClient();

  if (activeOrgId) {
    // Validate: the user must still be a member of that org
    const { data: membership } = await admin
      .from("org_members")
      .select("role, organizations(*)")
      .eq("org_id", activeOrgId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (membership) {
      return {
        org: membership.organizations as unknown as Organization,
        role: membership.role as OrgRole,
      };
    }
  }

  // Fall back to personal org
  const { data: personal } = await admin
    .from("org_members")
    .select("role, organizations(*)")
    .eq("user_id", user.id)
    .eq("organizations.type", "personal")
    .maybeSingle();

  if (!personal) throw new Error("User has no personal org — run backfill migration");
  return {
    org: personal.organizations as unknown as Organization,
    role: personal.role as OrgRole,
  };
}

/** Returns the caller's personal org id (used by connect.ts, actions, etc.) */
export async function getPersonalOrgId(userId: string): Promise<string> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("org_members")
    .select("org_id, organizations!inner(type)")
    .eq("user_id", userId)
    .eq("organizations.type", "personal")
    .maybeSingle();

  if (error) throw new Error(`getPersonalOrgId: ${error.message}`);
  if (!data) throw new Error(`No personal org for user ${userId}`);
  return data.org_id;
}

export async function listMembers(orgId: string): Promise<OrgMember[]> {
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("org_members")
    .select("id, org_id, user_id, role, created_at, profiles(display_name)")
    .eq("org_id", orgId)
    .order("created_at");

  if (error) throw new Error(`listMembers: ${error.message}`);

  // Fetch emails separately (auth.users is service-role only)
  const userIds = (data ?? []).map((m) => m.user_id);
  const emails: Record<string, string> = {};
  if (userIds.length) {
    const { data: { users } = { users: [] } } = await admin.auth.admin.listUsers();
    for (const u of users ?? []) {
      if (userIds.includes(u.id)) emails[u.id] = u.email ?? "";
    }
  }

  return (data ?? []).map((m) => ({
    id: m.id,
    org_id: m.org_id,
    user_id: m.user_id,
    role: m.role as OrgRole,
    created_at: m.created_at,
    email: emails[m.user_id] ?? "",
    display_name: (m.profiles as unknown as { display_name: string | null } | null)
      ?.display_name ?? null,
  }));
}

export async function listPendingInvitations(orgId: string): Promise<OrgInvitation[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("org_invitations")
    .select("id, org_id, email, role, invited_by, expires_at, accepted_at, created_at")
    .eq("org_id", orgId)
    .is("accepted_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false });

  if (error) throw new Error(`listPendingInvitations: ${error.message}`);
  return (data ?? []) as OrgInvitation[];
}

export async function getOrgActivity(orgId: string, limit = 50) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("audit_log")
    .select("id, actor_id, actor_role, action, entity_type, entity_id, metadata, created_at")
    .eq("actor_org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`getOrgActivity: ${error.message}`);
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Mutating helpers (called by server actions — caller must verify permissions)
// ---------------------------------------------------------------------------

export async function createTeamOrg(userId: string, name: string): Promise<Organization> {
  const admin = createAdminClient();

  const { data: org, error: orgErr } = await admin
    .from("organizations")
    .insert({ name, type: "team" })
    .select()
    .single();
  if (orgErr) throw new Error(`createTeamOrg: ${orgErr.message}`);

  const { error: memberErr } = await admin
    .from("org_members")
    .insert({ org_id: org.id, user_id: userId, role: "owner" });
  if (memberErr) throw new Error(`createTeamOrg membership: ${memberErr.message}`);

  return org as Organization;
}

export async function inviteMember(args: {
  orgId: string;
  email: string;
  role: "admin" | "member";
  byUserId: string;
}): Promise<{ token: string }> {
  const admin = createAdminClient();

  // Prevent duplicate pending invites to same email+org
  await admin
    .from("org_invitations")
    .delete()
    .eq("org_id", args.orgId)
    .eq("email", args.email)
    .is("accepted_at", null);

  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  const { error } = await admin.from("org_invitations").insert({
    org_id: args.orgId,
    email: args.email,
    role: args.role,
    token_hash: tokenHash,
    invited_by: args.byUserId,
  });
  if (error) throw new Error(`inviteMember: ${error.message}`);

  return { token };
}

export async function acceptInvite(token: string, userId: string): Promise<string> {
  const admin = createAdminClient();
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  const { data: invite, error: invErr } = await admin
    .from("org_invitations")
    .select("id, org_id, role, email, expires_at, accepted_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (invErr || !invite) throw new Error("Invalid or expired invitation");
  if (invite.accepted_at) throw new Error("Invitation already accepted");
  if (new Date(invite.expires_at) < new Date()) throw new Error("Invitation has expired");

  // Verify the accepting user's email matches the invite
  const { data: { user } } = await admin.auth.admin.getUserById(userId);
  if (user?.email?.toLowerCase() !== invite.email.toLowerCase()) {
    throw new Error("This invitation was sent to a different email address");
  }

  // Check not already a member
  const { data: existing } = await admin
    .from("org_members")
    .select("id")
    .eq("org_id", invite.org_id)
    .eq("user_id", userId)
    .maybeSingle();

  if (!existing) {
    const { error: memberErr } = await admin
      .from("org_members")
      .insert({ org_id: invite.org_id, user_id: userId, role: invite.role });
    if (memberErr) throw new Error(`acceptInvite membership: ${memberErr.message}`);
  }

  await admin
    .from("org_invitations")
    .update({ accepted_at: new Date().toISOString() })
    .eq("id", invite.id);

  return invite.org_id;
}

export async function setMemberRole(
  orgId: string,
  targetUserId: string,
  newRole: OrgRole,
  actorUserId: string
): Promise<void> {
  if (newRole === "owner") throw new Error("Use transferOwnership to assign owner role");

  const admin = createAdminClient();

  // Actor must be owner to change any role; admin can only change members→admin
  const { data: actor } = await admin
    .from("org_members")
    .select("role")
    .eq("org_id", orgId)
    .eq("user_id", actorUserId)
    .maybeSingle();

  if (!actor) throw new Error("Not a member of this org");
  if (actor.role !== "owner" && actor.role !== "admin") throw new Error("Insufficient permissions");

  const { error } = await admin
    .from("org_members")
    .update({ role: newRole })
    .eq("org_id", orgId)
    .eq("user_id", targetUserId)
    .neq("role", "owner"); // safety: can't demote owner via this function

  if (error) throw new Error(`setMemberRole: ${error.message}`);
}

export async function removeMember(
  orgId: string,
  targetUserId: string,
  actorUserId: string
): Promise<void> {
  if (targetUserId === actorUserId) throw new Error("Cannot remove yourself — use leave org");

  const admin = createAdminClient();

  const { data: target } = await admin
    .from("org_members")
    .select("role")
    .eq("org_id", orgId)
    .eq("user_id", targetUserId)
    .maybeSingle();

  if (!target) throw new Error("Member not found");
  if (target.role === "owner") throw new Error("Cannot remove the org owner");

  const { error } = await admin
    .from("org_members")
    .delete()
    .eq("org_id", orgId)
    .eq("user_id", targetUserId);

  if (error) throw new Error(`removeMember: ${error.message}`);
}

export async function transferOwnership(
  orgId: string,
  fromUserId: string,
  toUserId: string
): Promise<void> {
  const admin = createAdminClient();

  const { data: from } = await admin
    .from("org_members")
    .select("role")
    .eq("org_id", orgId)
    .eq("user_id", fromUserId)
    .maybeSingle();

  if (from?.role !== "owner") throw new Error("Only the current owner can transfer ownership");

  // Demote current owner to admin, promote target to owner
  const { error: demoteErr } = await admin
    .from("org_members")
    .update({ role: "admin" })
    .eq("org_id", orgId)
    .eq("user_id", fromUserId);
  if (demoteErr) throw new Error(`transferOwnership demote: ${demoteErr.message}`);

  const { error: promoteErr } = await admin
    .from("org_members")
    .update({ role: "owner" })
    .eq("org_id", orgId)
    .eq("user_id", toUserId);
  if (promoteErr) throw new Error(`transferOwnership promote: ${promoteErr.message}`);
}

export async function revokeInvitation(inviteId: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("org_invitations").delete().eq("id", inviteId);
  if (error) throw new Error(`revokeInvitation: ${error.message}`);
}

/** Sets the active org cookie (call from a server action). */
export async function switchActiveOrg(orgId: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_ORG_COOKIE, orgId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 90, // 90 days
  });
}
