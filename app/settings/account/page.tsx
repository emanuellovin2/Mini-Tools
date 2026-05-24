import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { PageHeader } from "@/components/layout/PageHeader";
import AccountSettingsForm from "./_components/AccountSettingsForm";
import SessionsPanel from "./_components/SessionsPanel";
import DangerZone from "./_components/DangerZone";

export const metadata: Metadata = { title: "Account Settings — [PLATFORM]" };

export default async function AccountSettingsPage() {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name, role")
    .eq("id", user.id)
    .single();

  return (
    <div className="max-w-2xl mx-auto space-y-8 py-8 px-4">
      <PageHeader title="Account" description="Profile, email, password, 2FA, and data." />

      {/* Profile */}
      <AccountSettingsForm
        userId={user.id}
        email={user.email ?? ""}
        displayName={profile?.display_name ?? ""}
        role={profile?.role ?? "buyer"}
      />

      {/* Sessions */}
      <SessionsPanel />

      {/* Danger zone */}
      <DangerZone />
    </div>
  );
}
