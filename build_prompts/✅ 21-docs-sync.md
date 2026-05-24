# Task #21 — Sync all docs after #15-#26

**Wave 6 — final pass. Depends on: ALL prior waves. Blocks: nothing.** See `00-EXECUTION-ORDER.md`. (Scope expanded from "after #15-#20" to "after #15-#26" — covers all 12 new tasks.)

## Context
Tasks #15-#20 change the economic model significantly. Three documents currently encode the OLD model and will be inconsistent until updated:
- `CLAUDE.md` — "Economics at a glance" + Guardrails
- `SPEC.md` — §3 (vendor tiers), §4a (affiliate), §4b (reseller), §8 (refunds), §11 (money flow)
- `BUILD_PROMPTS.md` — index of prompts (add #15-#21)

Doing this as a separate task prevents partial documentation drift while #15-#20 are in progress.

## Run last (after #15-#20 ship)

### CLAUDE.md — Economics section
Replace with:
- **Vendor (direct sale):** 12%/8%/5%/3% by monthly net tier ($0-$1k / $1k-$3k / $3k-$10k / $10k+). No flat fee.
- **Affiliate (referral):** vendor sets affiliate commission ≥ 20% (capped per affiliate's MRR tier: 20%/25%/30%). Platform takes 5% of net flat. Vendor share = net − platform 5% − affiliate %.
- **Reseller (storefront):** $19/month for platform access. Per sale: vendor gets `min_price` floor, platform takes **5% of markup**, reseller keeps the rest.
- **Refunds:** voluntary refund reverses vendor transfer only; platform & affiliate/reseller keep their cuts. Disputes reverse all transfers.
- **All commissions:** computed on NET (after Stripe processing fee), not gross.
- **Payouts:** weekly on Fridays via Stripe Connect.

### SPEC.md
Rewrite §3, §4a, §4b, §8, §11 per the new model. Update §7 schema with new columns:
- `apps.affiliate_commission_bps`
- `subscriptions.affiliate_commission_snapshot_bps`
- `profiles.affiliate_active_mrr_cents`
- `vendor_revenue_events.net_amount_cents`

### BUILD_PROMPTS.md
Add entries 15-21.

### tests
Confirm all `__tests__/` files now reflect new math. No test should still reference 2000 bps as tier-1 default.

## Verify
Read CLAUDE.md + SPEC.md end-to-end. Every mention of "20%" tier cut, "50% of platform cut", "5% of gross" for reseller, or "all transfers reversed" should be gone.
