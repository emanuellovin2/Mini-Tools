# Graph Report - .  (2026-05-21)

## Corpus Check
- 4 files · ~7,727 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 56 nodes · 64 edges · 9 communities (7 shown, 2 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 1 edges (avg confidence: 0.85)
- Token cost: 14,000 input · 5,000 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Auth & Token Access (anon_user_id + JWT + state machine)|Auth & Token Access (anon_user_id + JWT + state machine)]]
- [[_COMMUNITY_Pricing, Tiers & Billing Cron|Pricing, Tiers & Billing Cron]]
- [[_COMMUNITY_Schema, RLS & Security Hardening|Schema, RLS & Security Hardening]]
- [[_COMMUNITY_Roles & Marketplace Surface|Roles & Marketplace Surface]]
- [[_COMMUNITY_Build Plan Documents|Build Plan Documents]]
- [[_COMMUNITY_Webhook Pipeline & Idempotency|Webhook Pipeline & Idempotency]]
- [[_COMMUNITY_Anti-Poaching & Churn Detection|Anti-Poaching & Churn Detection]]
- [[_COMMUNITY_Money Flow & Reconciliation|Money Flow & Reconciliation]]
- [[_COMMUNITY_Boot-time Env Validation|Boot-time Env Validation]]

## God Nodes (most connected - your core abstractions)
1. `profiles table` - 8 edges
2. `Hybrid pricing tiers` - 6 edges
3. `subscriptions table` - 6 edges
4. `Status → access state machine` - 5 edges
5. `[PLATFORM] Marketplace` - 4 edges
6. `Separate Charges & Transfers` - 4 edges
7. `Anonymous token access model` - 4 edges
8. `RLS as real enforcement layer` - 4 edges
9. `Anti-poaching data boundary` - 4 edges
10. `Reseller role (Phase 2)` - 3 edges

## Surprising Connections (you probably didn't know these)
- `Money as integer cents + bps` --implements--> `Hybrid pricing tiers`  [EXTRACTED]
  ENGINEERING.md → SPEC.md
- `RLS as real enforcement layer` --implements--> `Anti-poaching data boundary`  [EXTRACTED]
  ENGINEERING.md → SPEC.md
- `RLS as real enforcement layer` --implements--> `Role escalation guard (RLS)`  [EXTRACTED]
  ENGINEERING.md → SPEC.md
- `Monthly billing cron (1st @ 01:00 UTC)` --implements--> `Hybrid pricing tiers`  [EXTRACTED]
  BUILD_PROMPTS.md → SPEC.md
- `Refund cash-basis accounting` --conceptually_related_to--> `Monthly billing cron (1st @ 01:00 UTC)`  [EXTRACTED]
  SPEC.md → BUILD_PROMPTS.md

## Hyperedges (group relationships)
- **Anti-poaching enforcement (token + view + RLS)** — anon_token_model, anon_user_id_reuse, vendor_subscription_stats, anti_poaching, rls_enforcement [EXTRACTED 1.00]
- **Money flow (Separate Charges & Transfers + idempotency + reversal)** — separate_charges_transfers, idempotency, raw_body_verify, refund_reverse_transfer, default_tier1_helper, schema_vendor_billing [EXTRACTED 1.00]
- **Entitlement (state machine + verify + webhook + DB txn)** — state_machine, verify_api, schema_webhook_events, db_transactions, schema_subscriptions [EXTRACTED 1.00]

## Communities (9 total, 2 thin omitted)

### Community 0 - "Auth & Token Access (anon_user_id + JWT + state machine)"
Cohesion: 0.18
Nodes (11): Anonymous token access model, anon_user_id reuse-on-resub logic, CSRF guidance, NEXT_PUBLIC_APP_URL env var, JWKS endpoint + RS256 JWT, RS256 key generation procedure, Status → access state machine, status: incomplete_expired (access=false) (+3 more)

### Community 1 - "Pricing, Tiers & Billing Cron"
Cohesion: 0.24
Nodes (10): Refund cash-basis accounting, Default Tier 1 cut_bps helper, Hybrid pricing tiers, Money as integer cents + bps, Monthly billing cron (1st @ 01:00 UTC), Refund/dispute reverse_transfer, vendor_billing table, Tier 1 (<$500, 2000 bps, $0 fee) (+2 more)

### Community 2 - "Schema, RLS & Security Hardening"
Cohesion: 0.31
Nodes (9): Magic-byte upload validation, RLS as real enforcement layer, Role escalation guard (RLS), apps table, profiles table, subscriptions table, Manual 'Sync Stripe status' button, account.updated webhook (+1 more)

### Community 3 - "Roles & Marketplace Surface"
Cohesion: 0.33
Nodes (7): profiles.display_name, [PLATFORM] Marketplace, Admin role, Buyer role, Reseller role (Phase 2), Vendor role, referrals + referral_attributions (Phase 2)

### Community 5 - "Webhook Pipeline & Idempotency"
Cohesion: 0.40
Nodes (5): DB transactions for multi-table writes, Idempotency everywhere, Webhook raw-body signature verification, audit_log table, webhook_events table

### Community 6 - "Anti-Poaching & Churn Detection"
Cohesion: 0.50
Nodes (4): Anti-poaching data boundary, Churn detection job, CHURN_ALERT_THRESHOLD_BPS env var, vendor_subscription_stats view

### Community 7 - "Money Flow & Reconciliation"
Cohesion: 0.67
Nodes (3): Daily reconciliation cron (02:00 UTC), 3-way split (70/10/20), Separate Charges & Transfers

## Knowledge Gaps
- **24 isolated node(s):** `Admin role`, `Buyer role`, `Tier 2 ($500-$2000, 1000 bps, $49 fee)`, `Tier 3 (>=$2000, 500 bps, $99 fee)`, `RS256 key generation procedure` (+19 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `profiles table` connect `Schema, RLS & Security Hardening` to `Pricing, Tiers & Billing Cron`, `Roles & Marketplace Surface`?**
  _High betweenness centrality (0.347) - this node is a cross-community bridge._
- **Why does `subscriptions table` connect `Schema, RLS & Security Hardening` to `Auth & Token Access (anon_user_id + JWT + state machine)`, `Money Flow & Reconciliation`?**
  _High betweenness centrality (0.239) - this node is a cross-community bridge._
- **Why does `profiles.display_name` connect `Roles & Marketplace Surface` to `Schema, RLS & Security Hardening`?**
  _High betweenness centrality (0.150) - this node is a cross-community bridge._
- **What connects `Admin role`, `Buyer role`, `Tier 2 ($500-$2000, 1000 bps, $49 fee)` to the rest of the system?**
  _24 weakly-connected nodes found - possible documentation gaps or missing edges._