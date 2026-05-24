import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { listVendorWebhooks } from "@/lib/services/vendor-webhooks";
import { PageHeader } from "@/components/layout/PageHeader";
import WebhooksManager from "./_components/WebhooksManager";

export const metadata: Metadata = { title: "Webhook Endpoints — [PLATFORM]" };

export default async function VendorWebhooksPage() {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "vendor") redirect("/vendor");

  const webhooks = await listVendorWebhooks().catch(() => []);

  return (
    <div className="max-w-3xl mx-auto space-y-6 py-8 px-4">
      <PageHeader
        title="Webhook endpoints"
        description="Receive real-time events at your backend when subscriptions change."
      />
      <WebhooksManager initialWebhooks={webhooks} />
    </div>
  );
}
