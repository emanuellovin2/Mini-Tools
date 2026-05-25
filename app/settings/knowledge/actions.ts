"use server";

import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { getActiveOrg } from "@/lib/services/org";
import {
  createKnowledgeBase,
  ingestDocument,
  deleteDocument,
  deleteKnowledgeBase,
  enqueueReindex,
} from "@/lib/services/knowledge";

export async function createBaseAction(formData: FormData) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { org } = await getActiveOrg();
  const name = (formData.get("name") as string | null)?.trim();
  if (!name) throw new Error("Name is required");

  const visibility = (formData.get("visibility") as string | null) ?? "private";

  await createKnowledgeBase({
    orgId: org.id,
    name,
    visibility: visibility as "private" | "org" | "public",
    actorId: user.id,
  });

  redirect("/settings/knowledge");
}

export async function ingestUrlAction(formData: FormData) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { org } = await getActiveOrg();
  const knowledgeBaseId = formData.get("knowledge_base_id") as string;
  const url = (formData.get("url") as string | null)?.trim();
  if (!url || !knowledgeBaseId) throw new Error("URL and base ID are required");

  await ingestDocument({
    orgId: org.id,
    knowledgeBaseId,
    sourceType: "url",
    sourceRef: url,
    actorId: user.id,
  });

  redirect(`/settings/knowledge/${knowledgeBaseId}`);
}

export async function deleteDocumentAction(formData: FormData) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { org } = await getActiveOrg();
  const docId = formData.get("doc_id") as string;
  const baseId = formData.get("base_id") as string;

  await deleteDocument(docId, org.id, user.id);
  redirect(`/settings/knowledge/${baseId}`);
}

export async function deleteBaseAction(formData: FormData) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { org } = await getActiveOrg();
  const baseId = formData.get("base_id") as string;

  await deleteKnowledgeBase(baseId, org.id, user.id);
  redirect("/settings/knowledge");
}

export async function reindexAction(formData: FormData) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { org } = await getActiveOrg();
  const baseId = formData.get("base_id") as string;

  await enqueueReindex({ knowledgeBaseId: baseId, orgId: org.id, actorId: user.id });
  redirect(`/settings/knowledge/${baseId}`);
}
