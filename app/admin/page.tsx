import Link from "next/link";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import {
  getPlatformStats,
  getPendingApps,
  getVendors,
  getAllSubscriptions,
  getAuditLog,
  getChurnAlerts,
  dispatchChurnAlerts,
} from "@/lib/services/admin";
import { formatPrice } from "@/lib/services/apps";
import ApproveRejectButtons from "./_components/ApproveRejectButtons";
import SyncStripeButton from "./_components/SyncStripeButton";

export const metadata: Metadata = {
  title: "Admin — [PLATFORM]",
};

type Props = {
  searchParams: Promise<Record<string, string | undefined>>;
};

function cents(n: number) {
  return formatPrice(n, "usd");
}

function dateShort(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function StatusPill({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active: "bg-green-50 text-green-700 border-green-200",
    trialing: "bg-blue-50 text-blue-700 border-blue-200",
    incomplete: "bg-yellow-50 text-yellow-700 border-yellow-200",
    past_due: "bg-red-50 text-red-600 border-red-200",
    canceled: "bg-gray-100 text-gray-500 border-gray-200",
    approved: "bg-green-50 text-green-700 border-green-200",
    pending: "bg-yellow-50 text-yellow-700 border-yellow-200",
    rejected: "bg-red-50 text-red-600 border-red-200",
  };
  const cls = colors[status] ?? "bg-gray-100 text-gray-500 border-gray-200";
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded-full border font-medium ${cls}`}
    >
      {status}
    </span>
  );
}

export default async function AdminDashboard({ searchParams }: Props) {
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
  const auditPage = Math.max(1, Number(sp.audit_page ?? 1));
  const auditActorId = sp.actor_id;
  const auditEntityType = sp.entity_type;
  const auditSince = sp.since;
  const auditUntil = sp.until;
  const subPage = Math.max(1, Number(sp.sub_page ?? 1));

  const thresholdBps = Number(
    process.env.CHURN_ALERT_THRESHOLD_BPS ?? "2000"
  );

  const [stats, pendingApps, vendors, { subscriptions, total: subTotal, totalPages: subTotalPages }, { entries: auditEntries, total: auditTotal, totalPages: auditTotalPages }, churnAlerts] =
    await Promise.all([
      getPlatformStats(),
      getPendingApps(),
      getVendors(),
      getAllSubscriptions({ page: subPage }),
      getAuditLog({
        actorId: auditActorId,
        entityType: auditEntityType,
        since: auditSince,
        until: auditUntil,
        page: auditPage,
      }),
      getChurnAlerts(thresholdBps),
    ]);

  // Fire-and-forget: dispatch alerts for newly-flagged vendors
  dispatchChurnAlerts(churnAlerts).catch(console.error);

  function auditHref(overrides: Record<string, string | undefined>) {
    const p = new URLSearchParams();
    const merged = {
      actor_id: auditActorId,
      entity_type: auditEntityType,
      since: auditSince,
      until: auditUntil,
      audit_page: "1",
      ...overrides,
    };
    for (const [k, v] of Object.entries(merged)) {
      if (v) p.set(k, v);
    }
    return `/admin?${p.toString()}`;
  }

  return (
    <main className="max-w-6xl mx-auto px-4 py-10 space-y-12">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Admin Dashboard</h1>
        <div className="flex items-center gap-4">
          <Link
            href="/admin/reconciliation"
            className="text-sm text-gray-500 hover:text-gray-800 transition-colors"
          >
            Reconciliation →
          </Link>
          <form action="/api/auth/signout" method="POST">
            <button
              type="submit"
              className="text-sm text-gray-400 hover:text-red-500 transition-colors"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>

      {/* Stats */}
      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">
          Platform Stats
        </h2>
        <div className="grid grid-cols-3 gap-4">
          {[
            { label: "GMV", value: cents(stats.gmvCents) },
            { label: "MRR", value: cents(stats.mrrCents) },
            { label: "Cut Earned", value: cents(stats.cutCents) },
          ].map(({ label, value }) => (
            <div
              key={label}
              className="border border-gray-200 rounded-xl p-5 text-center"
            >
              <p className="text-xs text-gray-400 mb-1">{label}</p>
              <p className="text-2xl font-bold">{value}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Churn Alerts */}
      {churnAlerts.length > 0 && (
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">
            Churn Alerts — threshold {(thresholdBps / 100).toFixed(0)}%
          </h2>
          <div className="border border-red-200 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-red-50 text-left">
                <tr>
                  <th className="px-4 py-2 font-medium text-red-700">Vendor</th>
                  <th className="px-4 py-2 font-medium text-red-700">Rate</th>
                  <th className="px-4 py-2 font-medium text-red-700">Canceled</th>
                  <th className="px-4 py-2 font-medium text-red-700">Active at start</th>
                  <th className="px-4 py-2 font-medium text-red-700">Alert</th>
                </tr>
              </thead>
              <tbody>
                {churnAlerts.map((a) => (
                  <tr key={a.vendor_id} className="border-t border-red-100">
                    <td className="px-4 py-2 text-gray-700 font-medium">
                      {a.vendor_name ?? a.vendor_id.slice(0, 8)}
                    </td>
                    <td className="px-4 py-2 text-red-600 font-semibold">
                      {(a.rate_bps / 100).toFixed(1)}%
                    </td>
                    <td className="px-4 py-2">{a.canceled}</td>
                    <td className="px-4 py-2">{a.active_at_start}</td>
                    <td className="px-4 py-2 text-xs text-gray-400">
                      {a.already_alerted ? "Sent" : "Sending…"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Pending Apps */}
      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">
          Pending Apps ({pendingApps.length})
        </h2>
        {pendingApps.length === 0 ? (
          <p className="text-sm text-gray-400 border border-dashed border-gray-200 rounded-xl p-6 text-center">
            No apps awaiting review.
          </p>
        ) : (
          <div className="border border-gray-200 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left">
                <tr>
                  <th className="px-4 py-2 font-medium text-gray-500">App</th>
                  <th className="px-4 py-2 font-medium text-gray-500">Vendor</th>
                  <th className="px-4 py-2 font-medium text-gray-500">Price</th>
                  <th className="px-4 py-2 font-medium text-gray-500">Submitted</th>
                  <th className="px-4 py-2 font-medium text-gray-500">Actions</th>
                </tr>
              </thead>
              <tbody>
                {pendingApps.map((app) => (
                  <tr key={app.id} className="border-t border-gray-100">
                    <td className="px-4 py-3">
                      <p className="font-medium">{app.name}</p>
                      {app.description && (
                        <p className="text-xs text-gray-400 truncate max-w-xs">
                          {app.description}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <p>{app.vendor_name ?? "—"}</p>
                      {!app.vendor_charges_enabled && (
                        <p className="text-xs text-red-500">
                          Stripe not connected
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3">{app.formatted_price}/mo</td>
                    <td className="px-4 py-3 text-gray-400">
                      {dateShort(app.created_at)}
                    </td>
                    <td className="px-4 py-3">
                      <ApproveRejectButtons
                        appId={app.id}
                        chargesEnabled={app.vendor_charges_enabled}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Vendors */}
      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">
          Vendors ({vendors.length})
        </h2>
        <div className="border border-gray-200 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="px-4 py-2 font-medium text-gray-500">Name</th>
                <th className="px-4 py-2 font-medium text-gray-500">Connect</th>
                <th className="px-4 py-2 font-medium text-gray-500">Charges</th>
                <th className="px-4 py-2 font-medium text-gray-500">Payouts</th>
                <th className="px-4 py-2 font-medium text-gray-500">Joined</th>
                <th className="px-4 py-2 font-medium text-gray-500">Actions</th>
              </tr>
            </thead>
            <tbody>
              {vendors.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-6 text-center text-gray-400"
                  >
                    No vendors yet.
                  </td>
                </tr>
              ) : (
                vendors.map((v) => (
                  <tr key={v.id} className="border-t border-gray-100">
                    <td className="px-4 py-3 font-medium">
                      {v.display_name ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-400 font-mono">
                      {v.stripe_account_id
                        ? v.stripe_account_id.slice(0, 12) + "…"
                        : "—"}
                    </td>
                    <td className="px-4 py-3">
                      {v.charges_enabled ? (
                        <span className="text-green-600 text-xs">✓</span>
                      ) : (
                        <span className="text-red-500 text-xs">✗</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {v.payouts_enabled ? (
                        <span className="text-green-600 text-xs">✓</span>
                      ) : (
                        <span className="text-red-500 text-xs">✗</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-400">
                      {dateShort(v.created_at)}
                    </td>
                    <td className="px-4 py-3">
                      {v.stripe_account_id ? (
                        <SyncStripeButton vendorId={v.id} />
                      ) : (
                        <span className="text-xs text-gray-300">No account</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Subscriptions */}
      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">
          Subscriptions ({subTotal})
        </h2>
        <div className="border border-gray-200 rounded-xl overflow-hidden mb-3">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="px-4 py-2 font-medium text-gray-500">App</th>
                <th className="px-4 py-2 font-medium text-gray-500">Buyer ID</th>
                <th className="px-4 py-2 font-medium text-gray-500">Status</th>
                <th className="px-4 py-2 font-medium text-gray-500">Price</th>
                <th className="px-4 py-2 font-medium text-gray-500">Period end</th>
                <th className="px-4 py-2 font-medium text-gray-500">Created</th>
              </tr>
            </thead>
            <tbody>
              {subscriptions.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-6 text-center text-gray-400"
                  >
                    No subscriptions.
                  </td>
                </tr>
              ) : (
                subscriptions.map((s) => (
                  <tr key={s.id} className="border-t border-gray-100">
                    <td className="px-4 py-3 font-medium">{s.app_name}</td>
                    <td className="px-4 py-3 text-xs text-gray-400 font-mono">
                      {s.buyer_id.slice(0, 8)}…
                    </td>
                    <td className="px-4 py-3">
                      <StatusPill status={s.status} />
                      {s.cancel_at_period_end && (
                        <span className="ml-1 text-xs text-orange-500">
                          (cancels)
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">{s.formatted_price}/mo</td>
                    <td className="px-4 py-3 text-gray-400">
                      {dateShort(s.current_period_end)}
                    </td>
                    <td className="px-4 py-3 text-gray-400">
                      {dateShort(s.created_at)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {subTotalPages > 1 && (
          <div className="flex items-center gap-3 text-sm">
            {subPage > 1 && (
              <Link
                href={`/admin?sub_page=${subPage - 1}`}
                className="border border-gray-200 px-3 py-1 rounded-lg hover:bg-gray-50"
              >
                ← Prev
              </Link>
            )}
            <span className="text-gray-400">
              {subPage} / {subTotalPages}
            </span>
            {subPage < subTotalPages && (
              <Link
                href={`/admin?sub_page=${subPage + 1}`}
                className="border border-gray-200 px-3 py-1 rounded-lg hover:bg-gray-50"
              >
                Next →
              </Link>
            )}
          </div>
        )}
      </section>

      {/* Audit Log */}
      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">
          Audit Log ({auditTotal})
        </h2>

        {/* Filters */}
        <form method="get" action="/admin" className="flex flex-wrap gap-3 mb-4">
          <input type="hidden" name="sub_page" value={subPage} />
          <input
            name="actor_id"
            defaultValue={auditActorId}
            placeholder="Actor ID (uuid)"
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-black w-72"
          />
          <input
            name="entity_type"
            defaultValue={auditEntityType}
            placeholder="Entity type"
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-black w-40"
          />
          <input
            name="since"
            type="date"
            defaultValue={auditSince}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-black"
          />
          <input
            name="until"
            type="date"
            defaultValue={auditUntil}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-black"
          />
          <button
            type="submit"
            className="bg-black text-white px-4 py-1.5 rounded-lg text-sm hover:bg-gray-800"
          >
            Filter
          </button>
          {(auditActorId || auditEntityType || auditSince || auditUntil) && (
            <Link
              href="/admin"
              className="border border-gray-300 px-4 py-1.5 rounded-lg text-sm hover:bg-gray-50"
            >
              Clear
            </Link>
          )}
        </form>

        <div className="border border-gray-200 rounded-xl overflow-hidden mb-3">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="px-4 py-2 font-medium text-gray-500">When</th>
                <th className="px-4 py-2 font-medium text-gray-500">Actor</th>
                <th className="px-4 py-2 font-medium text-gray-500">Action</th>
                <th className="px-4 py-2 font-medium text-gray-500">Entity</th>
                <th className="px-4 py-2 font-medium text-gray-500">Entity ID</th>
              </tr>
            </thead>
            <tbody>
              {auditEntries.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-6 text-center text-gray-400"
                  >
                    No audit log entries match your filters.
                  </td>
                </tr>
              ) : (
                auditEntries.map((e) => (
                  <tr key={e.id} className="border-t border-gray-100">
                    <td className="px-4 py-2 text-xs text-gray-400 whitespace-nowrap">
                      {new Date(e.created_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-2 text-xs">
                      <span className="font-medium text-gray-600">
                        {e.actor_role ?? "system"}
                      </span>
                      {e.actor_id && (
                        <span className="text-gray-400 ml-1 font-mono">
                          ({e.actor_id.slice(0, 8)}…)
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-gray-700">
                      {e.action}
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-500">
                      {e.entity_type}
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-400 font-mono">
                      {e.entity_id
                        ? e.entity_id.length > 20
                          ? e.entity_id.slice(0, 12) + "…"
                          : e.entity_id
                        : "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {auditTotalPages > 1 && (
          <div className="flex items-center gap-3 text-sm">
            {auditPage > 1 && (
              <Link
                href={auditHref({ audit_page: String(auditPage - 1) })}
                className="border border-gray-200 px-3 py-1 rounded-lg hover:bg-gray-50"
              >
                ← Prev
              </Link>
            )}
            <span className="text-gray-400">
              {auditPage} / {auditTotalPages}
            </span>
            {auditPage < auditTotalPages && (
              <Link
                href={auditHref({ audit_page: String(auditPage + 1) })}
                className="border border-gray-200 px-3 py-1 rounded-lg hover:bg-gray-50"
              >
                Next →
              </Link>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
