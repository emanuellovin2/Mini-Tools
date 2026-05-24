import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "How Fees Work — [PLATFORM]",
  description:
    "Full fee schedule: vendor tiers, affiliate commissions, reseller markup splits, refund policy, and worked examples.",
};

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="space-y-4 scroll-mt-8">
      <h2 className="text-xl font-bold text-gray-900 border-b border-gray-200 pb-2">{title}</h2>
      {children}
    </section>
  );
}

function Table({ headers, rows }: { headers: string[]; rows: (string | React.ReactNode)[][] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-50 border-b border-gray-200">
            {headers.map((h) => (
              <th key={h} className="px-4 py-3 text-left font-semibold text-gray-700">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className={i % 2 === 0 ? "bg-white" : "bg-gray-50/50"}>
              {row.map((cell, j) => (
                <td key={j} className="px-4 py-3 text-gray-700">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Example({ title, rows }: { title: string; rows: { label: string; value: string; highlight?: boolean }[] }) {
  return (
    <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
      <p className="text-sm font-semibold text-gray-700 mb-3">{title}</p>
      <div className="space-y-1">
        {rows.map((row) => (
          <div
            key={row.label}
            className={`flex justify-between text-sm ${
              row.highlight ? "font-semibold text-gray-900" : "text-gray-600"
            }`}
          >
            <span>{row.label}</span>
            <span className="tabular-nums font-mono">{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function FeesPage() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-12 space-y-12">
      {/* Header */}
      <div>
        <Link
          href="/marketplace"
          className="text-sm text-gray-500 hover:text-gray-700 mb-4 inline-block"
        >
          ← Back to marketplace
        </Link>
        <h1 className="text-3xl font-bold text-gray-900">How Fees Work</h1>
        <p className="text-gray-600 mt-2">
          Plain-language breakdown of every fee on the platform. No hidden costs.
          All math is done in integer cents; percentages are approximate.
        </p>
        {/* Jump nav */}
        <nav className="mt-6 flex flex-wrap gap-2">
          {[
            ["#vendor", "Vendors"],
            ["#affiliate", "Affiliates"],
            ["#reseller", "Resellers"],
            ["#buyer", "Buyers"],
            ["#refunds", "Refunds"],
          ].map(([href, label]) => (
            <a
              key={href}
              href={href}
              className="text-sm px-3 py-1 rounded-full border border-gray-300 text-gray-700 hover:bg-gray-100 transition-colors"
            >
              {label}
            </a>
          ))}
        </nav>
      </div>

      {/* ── Vendor ─────────────────────────────────────────────────────── */}
      <Section id="vendor" title="Vendor fees (direct & affiliate sales)">
        <p className="text-gray-600 text-sm">
          Platform fees for direct sales are computed on the{" "}
          <strong>net amount</strong> — what arrives after Stripe&apos;s card processing fee
          (~2.9% + $0.30). Your tier is based on your trailing calendar-month net revenue.
        </p>

        <Table
          headers={["Tier", "Monthly net MRR", "Platform cut", "You keep (approx.)"]}
          rows={[
            ["Tier 1", "$0 – $1,000", "12%", "~85%"],
            ["Tier 2", "$1,000 – $3,000", "8%", "~89%"],
            ["Tier 3", "$3,000 – $10,000", "5%", "~92%"],
            ["Tier 4", "$10,000+", "3%", "~94%"],
          ]}
        />

        <Example
          title="Example: $49/month app at Tier 1"
          rows={[
            { label: "Gross subscription", value: "$49.00" },
            { label: "Stripe fee (~2.9% + $0.30)", value: "−$1.72" },
            { label: "Net amount", value: "$47.28" },
            { label: "Platform fee (12% of net)", value: "−$5.67" },
            { label: "You receive", value: "$41.61", highlight: true },
          ]}
        />

        <Example
          title="Example: $49/month app at Tier 4 ($10k+ net MRR)"
          rows={[
            { label: "Gross subscription", value: "$49.00" },
            { label: "Stripe fee (~2.9% + $0.30)", value: "−$1.72" },
            { label: "Net amount", value: "$47.28" },
            { label: "Platform fee (3% of net)", value: "−$1.42" },
            { label: "You receive", value: "$45.86", highlight: true },
          ]}
        />

        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800">
          <p>
            <strong>Affiliate sales:</strong> When a buyer comes via an affiliate link, the split changes.
            Platform takes <strong>5% flat</strong> of net. The affiliate earns their set commission
            (capped by their MRR tier). You keep the remainder. Your tier rate does{" "}
            <strong>not</strong> apply to affiliate sales.{" "}
            <a href="#affiliate" className="underline">
              See affiliate section →
            </a>
          </p>
        </div>

        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-800">
          <p>
            <strong>Reseller sales:</strong> You receive your floor price every time, regardless of
            what the reseller charges. If you opt into white-label (Tier 2), you also receive a
            33% kickback on the platform&apos;s reseller commission.{" "}
            <a href="#reseller" className="underline">
              See reseller section →
            </a>
          </p>
        </div>
      </Section>

      {/* ── Affiliate ──────────────────────────────────────────────────── */}
      <Section id="affiliate" title="Affiliate commissions">
        <p className="text-gray-600 text-sm">
          Affiliates earn a percentage of the net sale amount. The platform takes{" "}
          <strong>5% flat</strong> off the net; the affiliate earns their capped commission;
          the vendor keeps the rest. Your commission is capped at your current MRR tier.
        </p>

        <Table
          headers={["Affiliate tier", "Active MRR generated", "Commission cap"]}
          rows={[
            ["Tier 1", "$0 – $5,000", "20% of net"],
            ["Tier 2", "$5,000 – $20,000", "25% of net"],
            ["Tier 3", "$20,000+", "30% of net"],
          ]}
        />

        <p className="text-sm text-gray-600">
          The vendor sets a maximum commission per app (20–80%). Your actual commission is{" "}
          <code className="bg-gray-100 px-1 rounded text-xs">min(vendor_rate, your_tier_cap)</code>
          {" "}snapshotted at subscribe time. Tier upgrades apply to new subscriptions only.
        </p>

        <Example
          title="Example: $49/mo app, vendor offers 50%, affiliate at Tier 1 (20%)"
          rows={[
            { label: "Gross subscription", value: "$49.00" },
            { label: "Stripe fee", value: "−$1.72" },
            { label: "Net amount", value: "$47.28" },
            { label: "Platform fee (5% of net)", value: "−$2.36" },
            { label: "Affiliate (20% of net — Tier 1 cap)", value: "$9.46" },
            { label: "Vendor keeps", value: "$35.46" },
            { label: "Your earnings / subscription", value: "$9.46", highlight: true },
          ]}
        />

        <Example
          title="Reach Tier 3 ($20k+ MRR) — same app"
          rows={[
            { label: "Affiliate (30% of net — Tier 3 cap)", value: "$14.18" },
            { label: "Increase vs Tier 1", value: "+$4.72 / sub" },
            { label: "Your earnings at 100 subs", value: "$1,418/mo", highlight: true },
          ]}
        />
      </Section>

      {/* ── Reseller ───────────────────────────────────────────────────── */}
      <Section id="reseller" title="Reseller fees">
        <p className="text-gray-600 text-sm">
          Resellers pay <strong>$19/month</strong> for platform access (30-day free trial).
          On each sale, the vendor receives their floor price, the platform takes a cut of the
          markup, and the reseller keeps the rest.
        </p>

        <Table
          headers={["Tier", "Monthly fee", "Platform cut", "What you keep"]}
          rows={[
            ["Tier 1 (storefront)", "$0 (included in $19/mo plan)", "5% of markup", "Markup − 5%"],
            ["Tier 2 (white-label)", "+$29/mo per offer", "2.5% of markup", "Markup − 2.5%"],
          ]}
        />

        <p className="text-sm text-gray-600">
          <strong>Markup</strong> = your sell price − vendor floor − Stripe fee. Platform fee
          is computed on the markup only — not on the vendor&apos;s floor.
        </p>

        <Example
          title="Example: sell at $79, vendor floor $49 (Tier 1)"
          rows={[
            { label: "Your sell price", value: "$79.00" },
            { label: "Stripe fee (~2.9% + $0.30)", value: "−$2.59" },
            { label: "Net", value: "$76.41" },
            { label: "Vendor floor", value: "−$49.00" },
            { label: "Markup", value: "$27.41" },
            { label: "Platform fee (5% of markup)", value: "−$1.37" },
            { label: "Your margin per sale", value: "$26.04", highlight: true },
          ]}
        />

        <Example
          title="Same offer at Tier 2 WL (+$29/mo)"
          rows={[
            { label: "Platform fee (2.5% of markup)", value: "−$0.69" },
            { label: "Your margin per sale", value: "$26.72" },
            { label: "Extra margin vs Tier 1", value: "+$0.68 / sale" },
            { label: "Break-even at +$29/mo", value: "~43 sales/mo", highlight: true },
          ]}
        />

        <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-sm text-green-800">
          <p>
            <strong>WL kickback for vendors:</strong> When a vendor sets their openness to
            &quot;open to white-label,&quot; they receive a <strong>33% kickback</strong> on the
            platform&apos;s reseller commission. This applies at both Tier 1 and Tier 2. The
            kickback is factored into the platform split — your margin is not affected.
          </p>
        </div>
      </Section>

      {/* ── Buyer ──────────────────────────────────────────────────────── */}
      <Section id="buyer" title="What buyers pay">
        <p className="text-gray-600 text-sm">
          Buyers pay the listed price. On the app detail page and at checkout, you can
          optionally expand &quot;How this is split&quot; to see a breakdown of where your
          subscription fee goes.
        </p>
        <p className="text-gray-600 text-sm">
          No additional fees are charged to buyers beyond the listed subscription price.
          Stripe&apos;s card fee is absorbed from the gross amount before the platform and vendor
          splits are calculated.
        </p>
      </Section>

      {/* ── Refunds ────────────────────────────────────────────────────── */}
      <Section id="refunds" title="Refund & dispute policy">
        <Table
          headers={["Event", "Who absorbs the cost"]}
          rows={[
            [
              "Voluntary refund (charge.refunded)",
              "Vendor only — vendor transfer is reversed. Platform and affiliate/reseller keep their cuts.",
            ],
            [
              "Dispute lost (charge.dispute.closed, outcome=lost)",
              "All parties — all transfers for the invoice are reversed. Vendor, affiliate/reseller, and platform all lose their share.",
            ],
          ]}
        />

        <p className="text-sm text-gray-600">
          Affiliate commission tiers are based on <em>active</em> MRR. When a subscription is
          refunded or cancelled, the affiliate&apos;s active MRR decreases, which may affect
          future tier rates (not existing snapshotted commissions).
        </p>
      </Section>

      {/* Footer nav */}
      <div className="border-t border-gray-200 pt-8 flex flex-wrap gap-4 text-sm text-gray-500">
        <Link href="/marketplace" className="hover:text-gray-700">
          Marketplace
        </Link>
        <Link href="/vendor" className="hover:text-gray-700">
          Vendor dashboard
        </Link>
        <Link href="/affiliate" className="hover:text-gray-700">
          Affiliate dashboard
        </Link>
        <Link href="/reseller" className="hover:text-gray-700">
          Reseller dashboard
        </Link>
      </div>
    </div>
  );
}
