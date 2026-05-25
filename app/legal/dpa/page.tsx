import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Data Processing Agreement — [PLATFORM]",
  description:
    "DPA between [PLATFORM] (data processor) and partners (data controllers) covering agency, reseller, and vendor use of client personal data.",
};

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="space-y-4 scroll-mt-8">
      <h2 className="text-xl font-bold text-gray-900 border-b border-gray-200 pb-2">{title}</h2>
      {children}
    </section>
  );
}

export default function DpaPage() {
  return (
    <div className="max-w-3xl mx-auto py-12 px-4 space-y-10">
      <header className="space-y-2">
        <p className="text-sm text-gray-500 uppercase tracking-wide">Legal</p>
        <h1 className="text-3xl font-bold text-gray-900">Data Processing Agreement</h1>
        <p className="text-gray-500 text-sm">
          Effective date: 2026-06-03 · Part of the{" "}
          <Link href="/legal/fees" className="text-indigo-600 hover:underline">
            Platform Terms
          </Link>
        </p>
      </header>

      <Section id="overview" title="1. Overview and Roles">
        <p className="text-gray-700 text-sm leading-relaxed">
          This Data Processing Agreement (<strong>&quot;DPA&quot;</strong>) governs the processing of
          personal data that <strong>[PLATFORM]</strong> (&quot;Processor&quot;) handles on behalf of
          agencies, resellers, and vendors (&quot;Partners&quot; / &quot;Controllers&quot;) when those
          Partners use the platform to manage end-clients whose personal data is stored in
          [PLATFORM] systems.
        </p>
        <p className="text-gray-700 text-sm leading-relaxed">
          Partners are the <strong>data controllers</strong> — they determine the purpose and
          means of processing. [PLATFORM] is the <strong>data processor</strong> — it processes
          personal data only on Partners&apos; documented instructions (as set out in this DPA and
          the platform&apos;s technical documentation).
        </p>
      </Section>

      <Section id="scope" title="2. Scope of Processing">
        <p className="text-gray-700 text-sm leading-relaxed">
          [PLATFORM] processes the following categories of personal data on behalf of Partners:
        </p>
        <ul className="list-disc list-inside text-sm text-gray-700 space-y-1 ml-2">
          <li>Client identity data (name, email address, external reference IDs)</li>
          <li>Usage metrics and metering events linked to a client identity</li>
          <li>Workflow run inputs and outputs that may contain client content</li>
          <li>CRM metadata (tags, lifecycle stage, notes) entered by the Partner</li>
        </ul>
        <p className="text-gray-700 text-sm leading-relaxed mt-2">
          Payment card data is never stored by [PLATFORM]; it is processed exclusively by
          Stripe under Stripe&apos;s own DPA.
        </p>
      </Section>

      <Section id="instructions" title="3. Processing Instructions">
        <p className="text-gray-700 text-sm leading-relaxed">
          [PLATFORM] processes personal data solely to provide the platform services described
          in the Terms of Service. Partners may issue further instructions via:
        </p>
        <ul className="list-disc list-inside text-sm text-gray-700 space-y-1 ml-2">
          <li>
            The <strong>Client Data Requests</strong> panel in Partner settings
            (export and erasure requests)
          </li>
          <li>The platform API (<code className="text-xs bg-gray-100 px-1 rounded">/api/v1/partner-clients</code>)</li>
          <li>Written notice to the platform&apos;s data protection contact</li>
        </ul>
      </Section>

      <Section id="erasure" title="4. Data Subject Rights &amp; Erasure">
        <p className="text-gray-700 text-sm leading-relaxed">
          When a Partner raises an erasure request for a client:
        </p>
        <ol className="list-decimal list-inside text-sm text-gray-700 space-y-1 ml-2">
          <li>
            The client record is <strong>soft-deleted immediately</strong> — no new usage
            events, workflow runs, or connector activity can be attributed to that client.
          </li>
          <li>
            After a <strong>grace period</strong> (default 30 days), a background job fans
            out hard erasure across all stores: usage event linkage is anonymised; workflow
            run I/O is purged; connector payloads are deleted.
          </li>
          <li>
            Financial aggregate rows (settlement records) are <strong>retained</strong> for
            accounting and tax compliance; only the client identity linkage is removed.
          </li>
          <li>
            All erasure steps are written to an immutable audit log.
          </li>
        </ol>
        <p className="text-gray-700 text-sm leading-relaxed mt-2">
          Partners can also request a full <strong>data export</strong> (portability) for any
          client from the same settings panel. The export ZIP is scoped exclusively to that
          Partner&apos;s data — no cross-counterparty data is included.
        </p>
      </Section>

      <Section id="retention" title="5. Retention &amp; Purge Policy">
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="px-4 py-3 text-left font-semibold text-gray-700">Store</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-700">Retention</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-700">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {[
                ["Workflow run I/O (run_steps)", "90 days", "Content purged; run record kept for audit"],
                ["Analytics raw events", "90 days", "No PII; visitor_hash is salted HMAC"],
                ["Outcome metrics raw", "90 days", "Rollup retained indefinitely"],
                ["Soft-deleted client records", "30-day grace then hard-delete", "Grace window for recovery"],
                ["Financial / settlement rows", "7 years", "Tax & accounting requirement; identity linkage removed on erasure"],
                ["Audit log", "Indefinite", "Immutable; no UPDATE/DELETE"],
              ].map(([store, retention, notes]) => (
                <tr key={store}>
                  <td className="px-4 py-3 text-gray-900 font-mono text-xs">{store}</td>
                  <td className="px-4 py-3 text-gray-700">{retention}</td>
                  <td className="px-4 py-3 text-gray-500">{notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section id="subprocessors" title="6. Sub-processors">
        <p className="text-gray-700 text-sm leading-relaxed">
          [PLATFORM] uses the sub-processors listed on the{" "}
          <Link href="/legal/subprocessors" className="text-indigo-600 hover:underline">
            Sub-processors page
          </Link>
          . Partners will be notified of material changes at least 14 days in advance.
        </p>
      </Section>

      <Section id="security" title="7. Technical &amp; Organisational Measures">
        <ul className="list-disc list-inside text-sm text-gray-700 space-y-1 ml-2">
          <li>All data encrypted at rest (AES-256) and in transit (TLS 1.2+)</li>
          <li>Provider API keys stored with envelope encryption (per-record DEK wrapped by versioned master key)</li>
          <li>Row-Level Security enforced on every table — no cross-org data reads</li>
          <li>Access tokens never stored in plaintext; never appear in logs</li>
          <li>Immutable audit log for all admin mutations</li>
          <li>Automated daily retention purge cron</li>
        </ul>
      </Section>

      <Section id="contact" title="8. Contact">
        <p className="text-gray-700 text-sm leading-relaxed">
          For data subject requests, DPA queries, or to exercise Partner rights under this
          agreement, contact{" "}
          <a href="mailto:privacy@platform.local" className="text-indigo-600 hover:underline">
            privacy@platform.local
          </a>
          .
        </p>
      </Section>

      <div className="pt-4 border-t border-gray-200 text-xs text-gray-400 flex gap-6">
        <Link href="/legal/fees" className="hover:underline">Fee Schedule</Link>
        <Link href="/legal/subprocessors" className="hover:underline">Sub-processors</Link>
      </div>
    </div>
  );
}
