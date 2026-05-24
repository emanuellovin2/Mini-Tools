import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { PageHeader } from "@/components/layout/PageHeader";
import {
  getNotificationPreferences,
  NOTIFICATION_TYPES,
} from "@/lib/services/notifications";
import NotificationPreferencesForm from "./_components/NotificationPreferencesForm";

export const metadata: Metadata = { title: "Notification Preferences — [PLATFORM]" };

export default async function NotificationsPage() {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  const role = profile?.role ?? "buyer";
  const savedPrefs = await getNotificationPreferences().catch(() => []);

  // Filter to types relevant for this role
  const relevantTypes = NOTIFICATION_TYPES.filter((t) => t.roles.includes(role));

  return (
    <div className="max-w-2xl mx-auto space-y-6 py-8 px-4">
      <PageHeader
        title="Notification preferences"
        description="Choose which events trigger in-app and email notifications."
      />
      <NotificationPreferencesForm
        types={relevantTypes}
        savedPrefs={savedPrefs}
      />
    </div>
  );
}
