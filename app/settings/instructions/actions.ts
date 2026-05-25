"use server";

import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { getActiveOrg } from "@/lib/services/org";
import {
  createInstructionSet,
  publishVersion,
  rollbackToVersion,
  type InstructionSet,
} from "@/lib/services/instructions";
import type { Block, ScopeLevel } from "@/lib/instructions/resolve";

export async function actionCreateInstructionSet(formData: FormData) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { org } = await getActiveOrg();

  const name = formData.get("name") as string;
  const scopeLevel = formData.get("scope_level") as ScopeLevel;
  const scopeRefId = (formData.get("scope_ref_id") as string | null) || null;

  if (!name?.trim()) throw new Error("Name is required");
  if (!["global", "project", "client", "deployment"].includes(scopeLevel)) {
    throw new Error("Invalid scope level");
  }

  const set = await createInstructionSet({
    orgId: org.id,
    scopeLevel,
    scopeRefId,
    name: name.trim(),
    actorUserId: user.id,
    actorOrgId: org.id,
  }) as InstructionSet;

  redirect(`/settings/instructions/${set.id}`);
}

export async function actionPublishVersion(
  instructionSetId: string,
  blocks: Block[],
  variables: Record<string, string>
) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { org } = await getActiveOrg();

  await publishVersion({
    instructionSetId,
    blocks,
    variables,
    actorUserId: user.id,
    actorOrgId: org.id,
  });
}

export async function actionRollback(
  instructionSetId: string,
  versionId: string
) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { org } = await getActiveOrg();

  await rollbackToVersion(instructionSetId, versionId, user.id, org.id);
}
