import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { PageHeader } from "@/components/layout/PageHeader";
import { getActiveOrg } from "@/lib/services/org";
import { listConnectorAccounts } from "@/lib/services/connectors";
import { listConnectorDefs } from "@/lib/services/connectors";
import ConnectionsList from "./_components/ConnectionsList";

export const metadata: Metadata = { title: "Connections — [PLATFORM]" };

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { org } = await getActiveOrg();
  const [accounts, defs] = await Promise.all([
    listConnectorAccounts(org.id),
    Promise.resolve(listConnectorDefs()),
  ]);

  const { connected, error } = await searchParams;

  return (
    <div className="max-w-3xl mx-auto space-y-8 py-8 px-4">
      <PageHeader
        title="Connections"
        description="Connect your tools — Gmail, Slack, Google Sheets, and more. Credentials are encrypted and never shared."
      />

      {connected && (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          Successfully connected <strong>{connected}</strong>.
        </div>
      )}
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          Connection failed: {decodeURIComponent(error)}
        </div>
      )}

      <ConnectionsList orgId={org.id} accounts={accounts} connectorDefs={defs} />
    </div>
  );
}
