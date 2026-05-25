import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Sub-processors — [PLATFORM]",
  description:
    "List of third-party sub-processors used by [PLATFORM] when processing personal data on behalf of Partners.",
};

const SUBPROCESSORS = [
  {
    name: "Stripe",
    purpose: "Payment processing, Connect payouts, billing",
    location: "United States",
    dpa: "https://stripe.com/legal/dpa",
    data: "Payment card data, billing contact, payout details",
  },
  {
    name: "Supabase",
    purpose: "Managed Postgres database and authentication",
    location: "United States (AWS us-east-1)",
    dpa: "https://supabase.com/privacy",
    data: "All platform data stored in the Postgres database",
  },
  {
    name: "Vercel",
    purpose: "Application hosting and edge compute",
    location: "United States / global edge",
    dpa: "https://vercel.com/legal/dpa",
    data: "HTTP request metadata; server-rendered responses",
  },
  {
    name: "Resend",
    purpose: "Transactional email delivery",
    location: "United States",
    dpa: "https://resend.com/legal/dpa",
    data: "Recipient email addresses; email content for platform notifications",
  },
  {
    name: "Upstash (Redis)",
    purpose: "Distributed rate limiting and short-term cache",
    location: "United States",
    dpa: "https://upstash.com/trust/dpa.pdf",
    data: "Cache keys and values (TTL-limited, no long-term PII)",
  },
  {
    name: "OpenAI",
    purpose: "AI inference — managed-mode gateway solutions only",
    location: "United States",
    dpa: "https://openai.com/enterprise-privacy",
    data: "Prompt and completion content for solutions using managed AI",
    conditional: "Only when GATEWAY_ENABLED=true and cost_mode='managed'",
  },
  {
    name: "Anthropic",
    purpose: "AI inference — managed-mode gateway solutions only",
    location: "United States",
    dpa: "https://www.anthropic.com/legal/privacy",
    data: "Prompt and completion content for solutions using managed AI",
    conditional: "Only when GATEWAY_ENABLED=true and cost_mode='managed'",
  },
] as const;

export default function SubprocessorsPage() {
  return (
    <div className="max-w-3xl mx-auto py-12 px-4 space-y-8">
      <header className="space-y-2">
        <p className="text-sm text-gray-500 uppercase tracking-wide">Legal</p>
        <h1 className="text-3xl font-bold text-gray-900">Sub-processors</h1>
        <p className="text-gray-500 text-sm">
          Last updated: 2026-06-03 · Partners relying on the{" "}
          <Link href="/legal/dpa" className="text-indigo-600 hover:underline">DPA</Link>{" "}
          will be notified of material changes at least 14 days in advance.
        </p>
      </header>

      <p className="text-sm text-gray-700 leading-relaxed">
        [PLATFORM] engages the following third parties to process personal data on behalf of
        Partners. BYOK (Bring Your Own Key) solutions route AI inference directly through the
        Partner&apos;s own credentials — [PLATFORM] does not forward content to AI sub-processors
        in that mode.
      </p>

      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Sub-processor</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Purpose</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Location</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Data processed</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {SUBPROCESSORS.map((sp) => (
              <tr key={sp.name}>
                <td className="px-4 py-3 align-top">
                  <div className="font-semibold text-gray-900">{sp.name}</div>
                  {sp.dpa && (
                    <a
                      href={sp.dpa}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-indigo-600 hover:underline"
                    >
                      DPA ↗
                    </a>
                  )}
                </td>
                <td className="px-4 py-3 align-top text-gray-700">
                  {sp.purpose}
                  {"conditional" in sp && (
                    <div className="text-xs text-gray-400 mt-1">{sp.conditional}</div>
                  )}
                </td>
                <td className="px-4 py-3 align-top text-gray-600">{sp.location}</td>
                <td className="px-4 py-3 align-top text-gray-600 text-xs">{sp.data}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="pt-4 border-t border-gray-200 text-xs text-gray-400 flex gap-6">
        <Link href="/legal/dpa" className="hover:underline">Data Processing Agreement</Link>
        <Link href="/legal/fees" className="hover:underline">Fee Schedule</Link>
      </div>
    </div>
  );
}
