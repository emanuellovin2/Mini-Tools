# Task #44 — Usage-product distribution across vendor / reseller / affiliate

> **Before starting:** read [build_prompts/40-usage-metering-billing.md](build_prompts/40-usage-metering-billing.md), [build_prompts/41-ai-gateway-byok.md](build_prompts/41-ai-gateway-byok.md), [build_prompts/42-workflow-engine.md](build_prompts/42-workflow-engine.md), `SPEC.md` §4 (affiliate/reseller economics), [build_prompts/37-marketplace-v2.md](build_prompts/37-marketplace-v2.md), [build_prompts/38-fee-transparency-layer.md](build_prompts/38-fee-transparency-layer.md).
> **Definition of Done:** the new metered products (gateway agents #41, workflow templates #42) are listable in the marketplace, resellable by resellers with a per-unit markup, and referable by affiliates for a recurring % of the platform fee — all settled through the #40 ledger. This is the layer that makes the 4 kitchens **profitable for every role**, with the platform always on a fixed margin.

**Phase 6 — Wave 9. Depends on: #40, #41, #47, (#42 for template products). Last of the wave — ties everything to the existing money model.**

> **Org ownership (#47):** metered products, reseller metered offers, and earnings all belong to **`org_id → organizations`**. Vendor/reseller/affiliate earnings + payouts are org-level. RLS uses `is_org_member`.

---

## Cost-to-owner principle
Distribution adds **no compute cost** — it routes attribution and splits already-metered usage (#40). Every role earns from the buyer's prepaid credits; the platform keeps a fixed `platform_fee_cents` per unit on top of (not instead of) what vendor/reseller/affiliate earn. More distribution = more usage = more fixed-margin revenue, zero added cost.

## How each role wins (make these explicit in the UI)
- **Vendor:** publishes a gateway agent or workflow template once → earns `vendor_unit_price_cents` on every call/run forever, no infra, no support of billing.
- **Reseller:** picks a vendor's metered product, sets a **per-unit markup** (same shape as the existing `sell_price` markup but on usage), keeps 95% of the markup, platform takes 5% (reuse `computeResellerSplit`). Storefront + WL tiers from #29 apply.
- **Affiliate:** refers a metered product via `?aff=` → earns a snapshotted % of the **platform fee** on every unit consumed, recurring, for the life of the subscription. Grows with consumption — far bigger than a one-time bounty.
- **Buyer:** transparent per-unit price with a live breakdown (vendor / reseller / platform / affiliate) — fee transparency layer (#38).

---

## Sections to build

### 1. Metered product model
Unify gateway agents + workflow templates under a listable product: extend `apps` with `product_kind` (`hosted|gateway|workflow_template`) OR add `metered_products` table linking to `usage_meters`. A metered product carries a `meter_id`, a `vendor_unit_price_cents`, optional `affiliate_commission_bps` (reuse 2000–8000 clamp), and `min_unit_price_cents` (reseller floor, analog of `min_price_cents`).

### 2. Reseller usage markup
Extend `reseller_offers` (or a parallel `reseller_metered_offers`) with `sell_unit_price_cents ≥ min_unit_price_cents` and `vendor_unit_floor_snapshot_cents`. At buyer subscribe/first-use, snapshot floor onto the subscription (reuse the existing snapshot pattern). `recordUsage` reads the snapshot to split per unit.

### 3. Affiliate recurring on usage
At subscribe time, snapshot `affiliate_commission_snapshot_bps` (clamped to the affiliate's MRR tier, SPEC §4a) onto the metered subscription. `computeUsageSplit` (#40) pays the affiliate that % of the platform fee per unit. Self-referral rejected (reuse existing guard).

### 4. Marketplace listing
Metered products appear in marketplace v2 (#37) with: unit + per-unit price, product kind badge (Agent / Workflow), screenshots (#30), "estimated cost per 1k units", and the standard Subscribe/Install CTA. Filter by product kind.

### 5. Role dashboards — usage earnings
- Vendor v2 (#32): "Usage revenue" panel — by product, by unit, trend (from `getUsageRevenue`).
- Reseller v2 (#34): per-offer usage markup earned + markup simulator on per-unit price.
- Affiliate v2 (#33): usage commission earned per referred product, recurring projection.

### 6. Fee transparency (#38 tie-in)
Live per-unit breakdown component reused in vendor pricing form, reseller markup form, and (optional) buyer product page. Canonical `/legal/fees` gains a "Usage-based products" section.

### 7. Attribution invariants
A metered subscription still obeys the SPEC §4 rule: **at most one** of `affiliate_id` / `reseller_id`. Reseller-sold takes priority over `?aff=` (reuse existing collision rule). CHECK constraints mirror `subscriptions`.

---

## Data layer additions
```ts
// extends lib/services/usage.ts + reseller.ts + affiliate.ts
publishMeteredProduct(vendorId, args): Product
createMeteredOffer(resellerId, productId, sellUnitPriceCents): Offer
getUsageEarnings(ownerId, role, days): { byProduct, totalCents }
estimateUnitCost(productId, attribution): { vendorCents, platformCents, resellerCents, affiliateCents }
```

## Acceptance criteria
- [ ] A vendor can publish a gateway agent and a workflow template as marketplace products with a per-unit price.
- [ ] A reseller can create a metered offer above the floor; per-unit split is correct (vendor floor + 95% markup to reseller + 5% platform).
- [ ] An affiliate referral earns the snapshotted % of the platform fee per unit, recurring.
- [ ] At most one of affiliate/reseller attribution per metered subscription (CHECK enforced); reseller wins collisions.
- [ ] Marketplace lists metered products with unit pricing + estimated cost-per-1k.
- [ ] Each role dashboard shows usage earnings sourced from #40.
- [ ] Live fee breakdown matches `computeUsageSplit` exactly; `/legal/fees` updated.
- [ ] Platform fee per unit is fixed and always ≥0 regardless of role stack (fuzz test).
- [ ] RLS: cross-role and cross-owner reads denied as in existing boundaries.
