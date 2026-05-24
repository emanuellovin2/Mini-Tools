# Task #38 — Fee transparency layer (live calculators + "How fees work" page)

> **Before starting:** read `SPEC.md` §4, [lib/stripe/billing.ts](lib/stripe/billing.ts), [lib/stripe/transfers.ts](lib/stripe/transfers.ts), [build_prompts/31-design-system-v2.md](build_prompts/31-design-system-v2.md).
> **Definition of Done:** every role sees, BEFORE committing to a price, exactly what they'll pay/earn. Vendor app form has live fee calc. Reseller offer form has live margin calc with kickback math. Affiliate link generation shows projected earnings. Buyer optionally sees fee breakdown on checkout. One canonical "How fees work" page linked from everywhere. SPEC.md §4 updated.

**Phase 5 — Wave 8. Depends on: #31. Parallel with #32–#37.**

---

## Why this exists

Right now, fees are computed correctly server-side but invisible to users until after the fact. New vendors guess wrong on pricing; resellers don't know real margin; affiliates don't know per-app commission. Transparency wins trust and reduces support load.

## Where to surface

### 1. Vendor — App pricing form
Inline card next to price input:
```
At $49/month and current $3.2k net MRR (tier: 8%):
  Gross per sale:     $49.00
  Stripe fee (~2.9%): -$1.72
  Net:                $47.28
  Platform cut (8%):  -$3.78
  You receive:        $43.50

→ At $10k net MRR (tier 5%):
  You'd receive: $44.91 (+3.2%)
```
Recomputes live as price changes. Shows next tier projection.

### 2. Vendor — Direct sales transparency banner
On `/vendor` dashboard top:
"Platform takes 8% on direct sales this month (you're in the $1k–$3k tier). [How tiers work →]"

If admin override active: "Custom rate: 5% (set by admin). [Why →]"

### 3. Vendor — Reseller openness toggle
When viewing `closed → open_to_resellers → open_to_wl`, show projected impact:
```
open_to_resellers: vendor receives exact floor $X per reseller sale (status quo).
open_to_wl: vendor receives floor + 33% kickback from platform's reseller cut.
  At current 6 reseller sales/mo of avg $79: extra ~$7.90/mo kickback.
```

### 4. Reseller — Offer creation form
Live margin calculator:
```
SplitPay floor: $49
Your price: $79
  Gross per sale:        $79.00
  Stripe fee (~2.9%):   -$2.46
  Net:                   $76.54
  Vendor floor:         -$49.00
  Markup:                $27.54
  Platform cut (5%):    -$1.38   [Tier 1]
  Your margin:           $26.16

→ Upgrade to Tier 2 WL ($29/mo extra):
  Platform cut: 2.5% instead of 5%.
  Your margin: $26.85 (+$0.69 per sale).
  Break-even: 42 sales/mo.
```

If vendor is `open_to_wl`, also show: "Vendor gets 1.67% kickback (33% of platform's 5% Tier 1 / 2.5% Tier 2)."

### 5. Reseller — Tier 1 mini-brand page
Static text: "Tier 1 storefronts cost $0 extra. Branded path: `acme.platform.app/r/your-slug/...`. Platform branding visible. Upgrade per-offer to Tier 2 for $29/mo to get a subdomain + remove platform branding."

### 6. Affiliate — Link generation form
Before "Generate":
```
SplitPay commission rate: 50%
At $49/sale:
  Platform takes (5% net):  $2.39
  Affiliate (50% net):     $23.85
  Vendor keeps:            $20.50

Tier 1 (you): 20% commission
Your earnings: $9.54 per sale.

→ Reach $5k active MRR (Tier 2): 25% commission = $11.92 per sale (+25%).
→ Reach $20k active MRR (Tier 3): 30% commission = $14.31 per sale (+50%).
```

### 7. Affiliate — Apps to promote
Each app card shows: "50% commission, ~$X to you per $Y sale at your current tier".

### 8. Buyer — Checkout breakdown (optional)
Below the "Subscribe" button, collapsible "How this is split":
```
$49 / month:
  Vendor receives:    $43.50
  Platform fee:       $3.78
  Stripe fee:         $1.72
```
Off by default; toggle in settings. Reinforces that buyer's money goes mostly to vendor.

### 9. Canonical "How fees work" page (`/legal/fees`)
Single source of truth, plain language:
- 4-tier vendor commission with the exact table.
- Affiliate model (vendor-funded + platform 5%).
- Reseller model (markup-based, 5% Tier 1 / 2.5% Tier 2).
- WL kickback (33% to open_to_wl vendor).
- Refund policy (#19).
- Worked examples for each.
- Linked from every transparency widget via "[How fees work →]".

---

## Implementation

All calculators are **pure functions** in a new `lib/pricing/preview.ts`:

```ts
export function previewVendorDirect({ priceCents, currentNetMrrCents, overrideBps? }): VendorPreview
export function previewReseller({ floorCents, sellPriceCents, tier, vendorOpenness }): ResellerPreview
export function previewAffiliate({ priceCents, commissionBps, affiliateTier }): AffiliatePreview
export function previewBuyer({ priceCents, channel, ... }): BuyerPreview
```

Each returns `{ gross, stripeFee, net, parties: { vendor, platform, affiliate, reseller }, notes[] }`.

Test these with the same fuzz tests as the actual transfer math — invariant `vendor + platform + affiliate + reseller + stripe == gross`.

UI components: `<PricingPreview type="vendor|reseller|affiliate|buyer" {...inputs} />` reads from these functions and re-renders on input change.

---

## Acceptance criteria

- [ ] All preview functions match actual server-side splits (property-based test).
- [ ] Vendor app form shows live preview that updates on price change.
- [ ] Reseller offer form shows margin + Tier 2 comparison.
- [ ] Affiliate link form shows per-app commission projection.
- [ ] Buyer checkout has collapsible breakdown.
- [ ] `/legal/fees` page renders all tables + examples, linked from at least 5 places in the app.
- [ ] If vendor has admin override, vendor preview reflects override rate (not auto tier).
- [ ] Mobile-responsive previews.
- [ ] No floating-point drift — all math in integer cents and bps.
