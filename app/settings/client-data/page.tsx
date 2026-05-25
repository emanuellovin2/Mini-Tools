import { redirect } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { getActiveOrg } from "@/lib/services/org";
import { listPartnerClients, listDataRequests } from "@/lib/services/privacy";
import { PageHeader } from "@/components/layout/PageHeader";
import { exportClientAction, eraseClientAction } from "./actions";

export const metadata: Metadata = { title: "Client Data Requests — [PLATFORM]" };

const STATUS_BADGE: Record<string, string> = {
  pending:    "bg-yellow-100 text-yellow-800",
  processing: "bg-blue-100 text-blue-800",
  completed:  "bg-green-100 text-green-800",
  failed:     "bg-red-100 text-red-800",
};

export default async function ClientDataPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const activeCtx = await getActiveOrg();

  // Only agency / reseller / vendor orgs can raise client data requests
  const allowedTypes = ["agency", "team", "personal"];
  if (!allowedTypes.includes(activeCtx.org.type)) {
    redirect("/settings/account");
  }

  const params = await searchParams;

  const [{ clients }, requests] = await Promise.all([
    listPartnerClients(activeCtx.org.id, { limit: 100 }),
    listDataRequests(activeCtx.org.id),
  ]);

  return (
    <div className="max-w-3xl mx-auto space-y-8 py-8 px-4">
      <PageHeader
        title="Client Data Requests"
        description="Export or erase a client's personal data across all platform stores."
      />

      {params.exported === "1" && (
        <div className="rounded-lg bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800">
          Export requested — you&apos;ll receive a download link by email when ready.
        </div>
      )}
      {params.erased === "1" && (
        <div className="rounded-lg bg-orange-50 border border-orange-200 px-4 py-3 text-sm text-orange-800">
          Erasure initiated — the client has been soft-deleted immediately. Hard erasure runs after the grace period.
        </div>
      )}

      {/* Raise a new request */}
      <section className="space-y-4">
        <h2 className="text-base font-semibold text-gray-900">Raise a request</h2>
        {clients.length === 0 ? (
          <p className="text-sm text-gray-500">
            No clients found. Add clients via the{" "}
            <Link href="/agency" className="text-indigo-600 hover:underline">
              agency dashboard
            </Link>
            {" "}or the{" "}
            <code className="text-xs bg-gray-100 px-1 rounded">/api/v1/partner-clients</code> API.
          </p>
        ) : (
          <div className="rounded-lg border border-gray-200 divide-y divide-gray-100">
            {clients.map((client) => (
              <div key={client.id} className="flex items-center justify-between px-4 py-3 gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">
                    {client.display_name ?? client.email ?? client.external_ref ?? client.id}
                  </p>
                  {client.email && client.display_name && (
                    <p className="text-xs text-gray-500 truncate">{client.email}</p>
                  )}
                </div>
                <div className="flex gap-2 shrink-0">
                  <form action={exportClientAction}>
                    <input type="hidden" name="partnerClientId" value={client.id} />
                    <button
                      type="submit"
                      className="text-xs px-3 py-1.5 rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors"
                    >
                      Export
                    </button>
                  </form>
                  <form action={eraseClientAction}>
                    <input type="hidden" name="partnerClientId" value={client.id} />
                    <button
                      type="submit"
                      className="text-xs px-3 py-1.5 rounded-md border border-red-300 text-red-700 hover:bg-red-50 transition-colors"
                      onClick={(e) => {
                        // Progressive enhancement — confirmation in JS; form submits without it
                        if (typeof window !== "undefined") {
                          if (!window.confirm("Erase this client? This cannot be undone after the grace period.")) {
                            e.preventDefault();
                          }
                        }
                      }}
                    >
                      Erase
                    </button>
                  </form>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Request history */}
      {requests.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-base font-semibold text-gray-900">Request history</h2>
          <div className="rounded-lg border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="px-4 py-2 text-left font-medium text-gray-600">Client</th>
                  <th className="px-4 py-2 text-left font-medium text-gray-600">Type</th>
                  <th className="px-4 py-2 text-left font-medium text-gray-600">Status</th>
                  <th className="px-4 py-2 text-left font-medium text-gray-600">Raised</th>
                  <th className="px-4 py-2 text-left font-medium text-gray-600">Grace ends</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {requests.map((req) => {
                  const client = clients.find((c) => c.id === req.partner_client_id);
                  return (
                    <tr key={req.id}>
                      <td className="px-4 py-2 text-gray-900 truncate max-w-[160px]">
                        {client?.display_name ?? client?.email ?? req.partner_client_id.slice(0, 8) + "…"}
                      </td>
                      <td className="px-4 py-2 text-gray-700 capitalize">{req.request_type}</td>
                      <td className="px-4 py-2">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${STATUS_BADGE[req.status] ?? ""}`}>
                          {req.status}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-gray-500 text-xs">
                        {new Date(req.created_at).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-2 text-gray-500 text-xs">
                        {req.grace_ends_at
                          ? new Date(req.grace_ends_at).toLocaleDateString()
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <p className="text-xs text-gray-400">
        Read the{" "}
        <Link href="/legal/dpa" className="hover:underline text-indigo-500">
          Data Processing Agreement
        </Link>{" "}
        for retention periods, erasure mechanics, and sub-processor details.
      </p>
    </div>
  );
}
