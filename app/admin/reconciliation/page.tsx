import Link from "next/link";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import {
  getReconciliationRuns,
  type ReconciliationRun,
  type DriftItem,
} from "@/lib/services/reconciliation";

export const metadata: Metadata = {
  title: "Reconciliation — Admin — [PLATFORM]",
};

type Props = {
  searchParams: Promise<Record<string, string | undefined>>;
};

function StatusBadge({ status }: { status: ReconciliationRun["status"] }) {
  const styles: Record<ReconciliationRun["status"], string> = {
    ok: "bg-green-50 text-green-700 border-green-200",
    drift_found: "bg-yellow-50 text-yellow-700 border-yellow-200",
    failed: "bg-red-50 text-red-600 border-red-200",
  };
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded-full border font-medium ${styles[status]}`}
    >
      {status === "ok" ? "✓ ok" : status === "drift_found" ? "⚠ drift" : "✕ failed"}
    </span>
  );
}

function DriftTypeBadge({ type }: { type: DriftItem["type"] }) {
  const styles: Record<DriftItem["type"], string> = {
    subscription_drift: "bg-orange-50 text-orange-700 border-orange-200",
    missing_transfer: "bg-red-50 text-red-600 border-red-200",
    stale_webhook: "bg-yellow-50 text-yellow-700 border-yellow-200",
  };
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded-full border font-mono ${styles[type]}`}
    >
      {type.replace(/_/g, " ")}
    </span>
  );
}

function dateShort(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

export default async function ReconciliationPage({ searchParams }: Props) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "admin") redirect("/login");

  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? 1));

  const { runs, total, totalPages } = await getReconciliationRuns({ page });

  // Which run is expanded (via ?run=<id>)
  const expandedRunId = sp.run ?? runs[0]?.id ?? null;
  const expandedRun = runs.find((r) => r.id === expandedRunId) ?? runs[0] ?? null;

  return (
    <main className="max-w-5xl mx-auto px-4 py-10 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <Link
            href="/admin"
            className="text-xs text-gray-700 hover:text-gray-900 mb-1 inline-block"
          >
            ← Admin dashboard
          </Link>
          <h1 className="text-2xl font-bold">Stripe ↔ DB Reconciliation</h1>
          <p className="text-sm text-gray-700 mt-1">
            Daily job (02:00 UTC) comparing Stripe state to the database.
          </p>
        </div>
      </div>

      {runs.length === 0 ? (
        <div className="border border-gray-200 rounded-xl p-8 text-center text-gray-700">
          No reconciliation runs yet. The cron runs daily at 02:00 UTC.
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Run list */}
          <div className="lg:col-span-1 space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-700 mb-3">
              Runs ({total})
            </h2>
            {runs.map((run) => (
              <Link
                key={run.id}
                href={`/admin/reconciliation?run=${run.id}&page=${page}`}
                className={`block border rounded-lg p-3 text-sm transition-colors ${
                  run.id === expandedRunId
                    ? "border-gray-400 bg-gray-50"
                    : "border-gray-200 hover:border-gray-300"
                }`}
              >
                <div className="flex items-center justify-between gap-2 mb-1">
                  <StatusBadge status={run.status} />
                  {run.drift_count > 0 && (
                    <span className="text-xs text-yellow-600 font-medium">
                      {run.drift_count} item{run.drift_count > 1 ? "s" : ""}
                    </span>
                  )}
                </div>
                <div className="text-xs text-gray-700">{dateShort(run.run_at)}</div>
              </Link>
            ))}

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex gap-2 pt-2">
                {page > 1 && (
                  <Link
                    href={`/admin/reconciliation?page=${page - 1}`}
                    className="text-xs text-gray-700 hover:text-gray-900"
                  >
                    ← prev
                  </Link>
                )}
                <span className="text-xs text-gray-700">
                  {page}/{totalPages}
                </span>
                {page < totalPages && (
                  <Link
                    href={`/admin/reconciliation?page=${page + 1}`}
                    className="text-xs text-gray-700 hover:text-gray-900"
                  >
                    next →
                  </Link>
                )}
              </div>
            )}
          </div>

          {/* Run detail */}
          <div className="lg:col-span-2">
            {expandedRun ? (
              <div className="border border-gray-200 rounded-xl p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <StatusBadge status={expandedRun.status} />
                    <span className="ml-2 text-sm text-gray-700">
                      {dateShort(expandedRun.run_at)}
                    </span>
                  </div>
                  <span className="text-xs text-gray-700 font-mono">
                    {expandedRun.id.slice(0, 8)}…
                  </span>
                </div>

                {expandedRun.error && (
                  <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
                    <strong>Error:</strong> {expandedRun.error}
                  </div>
                )}

                {expandedRun.drift_count === 0 && expandedRun.status === "ok" && (
                  <p className="text-sm text-green-700">
                    ✓ No drift detected — Stripe and DB are in sync.
                  </p>
                )}

                {expandedRun.drift_items.length > 0 && (
                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-700 mb-3">
                      Drift items ({expandedRun.drift_count})
                    </h3>
                    <ul className="space-y-3">
                      {expandedRun.drift_items.map((item, i) => (
                        <li
                          key={i}
                          className="border border-gray-100 rounded-lg p-3 text-sm space-y-1"
                        >
                          <div className="flex items-center gap-2">
                            <DriftTypeBadge type={item.type} />
                            {item.db_status && item.stripe_status && (
                              <span className="text-xs text-gray-700">
                                DB: <strong>{item.db_status}</strong> → Stripe:{" "}
                                <strong>{item.stripe_status}</strong>
                              </span>
                            )}
                          </div>
                          <p className="text-gray-700">{item.message}</p>
                          {item.stripe_id && (
                            <p className="text-xs text-gray-700 font-mono">
                              {item.stripe_id}
                            </p>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ) : (
              <div className="border border-gray-200 rounded-xl p-8 text-center text-gray-700 text-sm">
                Select a run to see details.
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
