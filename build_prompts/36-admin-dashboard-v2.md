# Task #36 — Admin dashboard v2 (system health + drill-downs + support tools)

> **Before starting:** read `SPEC.md` §7, §8, §11, §12, [lib/services/admin.ts](lib/services/admin.ts), [lib/services/reconciliation.ts](lib/services/reconciliation.ts), [app/admin/page.tsx](app/admin/page.tsx), `mockups/index.html` (admin view). Read [build_prompts/31-design-system-v2.md](build_prompts/31-design-system-v2.md).
> **Definition of Done:** admin sees platform health at a glance, can drill into any vendor/sub/reseller via drawer, has webhook health monitor, concentration risk visible, payout obligation surfaced, manual support tools available (refund, force-sync, suspend), JWT rotation visible, feature flag kill switches. Tests + SPEC.md §7 updated.

**Phase 5 — Wave 8. Depends on: #31. Parallel with #32–#35, #37.**

---

## Sections to build

### 1. System health row (NEW — sticky top)
Status chips with hover detail:
- Stripe API: latency, last successful call.
- Supabase: query latency, connection pool.
- Resend: queue depth, last delivery.
- Webhook lag: seconds since last received event (alarm if >60s).
- JWT key rotation: days until next rotation.
- Reconciliation drift: $ outstanding.

One bad → red banner top of page with details.

Service: `getSystemHealth()` — composite check.

### 2. KPI strip (UPGRADE existing 5)
GMV · Platform cut · Active vendors · Active subs · Reconciliation drift. Add sparklines + 90/12m time selector.

### 3. Take rate trend chart (NEW)
Line chart: %take rate per month over last 12 months. Calculated = platform_cut / gmv. Should hover ~7-10% based on tier mix. Spotting drift early matters.

### 4. Channel mix card (NEW)
GMV by channel: direct / affiliate / reseller. Stacked bar over 12 months. Identifies if one channel is dying.

### 5. Concentration risk card (NEW)
Top 5 vendors as % of GMV. Alarm if any single vendor >20%. Lists them with their % share.

### 6. Payout obligation card (NEW)
"Friday payout cycle: $X to N vendors + $Y to M affiliates + $Z to K resellers. Total $W obligation." Helps treasury planning.

### 7. Webhook health monitor (NEW — biggest gap)
- Events received/processed/failed (1h, 24h).
- Dead letter queue: failed events with retry count, click → drawer with payload + manual retry.
- Top failing event types.
- Webhook signature failures (security alert).

Service: `getWebhookStats()` reading from `webhook_events` table (add if missing).

### 8. Dispute/chargeback dashboard (NEW)
Platform-wide rate, open disputes by vendor, $ at-risk. Click → drawer per dispute.

### 9. Pending app approvals (KEEP, IMPROVE)
- Queue with SLA countdown (24h).
- Click → drawer with full app preview (screenshots, description, pricing, vendor reputation score).
- Approve/Reject in drawer with reason field; reason recorded in audit log.

### 10. Churn alerts (KEEP, IMPROVE)
- Add filter by severity.
- "Send digest now" button works.
- Threshold tunable via env (`CHURN_ALERT_THRESHOLD_BPS`).

### 11. Vendor commission overrides (KEEP, IMPROVE)
- Add "+ Add override" modal: vendor search → bps input (0-5000) → reason field → confirm.
- Edit existing → modal with current value + change reason.
- Audit log entry per change (per #27).

### 12. Vendor drill-down drawer (NEW)
Click any vendor anywhere in admin → drawer with: stats, apps, payouts, override history, audit trail, recent disputes, status (verified/banned), suspend button.

### 13. Inactive vendor queue (NEW)
"Vendors with 0 sales in last 14d" — re-engagement candidates. Email blast CTA.

### 14. Manual support tools (NEW)
Dedicated tab/section "Tools":
- Lookup subscription by id → full timeline → actions (force-refund, regenerate anon token, manual transfer reversal, force vendor Stripe re-sync).
- Lookup user by email/id → impersonate (audited!) or suspend.
- Resend invoice receipt.
- Cancel subscription manually (rare).

Every action writes to `audit_log` with admin id + reason.

### 15. Reconciliation runs (KEEP, IMPROVE)
- Click drift item → drawer with Stripe state vs DB state side-by-side + "Resolve" action that updates DB to match Stripe (with audit).
- Trigger run manually button.

### 16. Rate limiter / WAF events (NEW)
Counts per IP / per endpoint. Top abusers list. Block IP button.

### 17. Audit log (KEEP, IMPROVE)
- Filter by actor, action type, date range.
- Search.
- Export CSV.
- Each entry → drawer with full event JSON.

### 18. Feature flag kill switches (NEW)
Panel with toggles: WL Tier 2 signup, affiliate signup, reseller signup, new app submissions, payouts. For incident response.

Stored in `feature_flags` table. Read via cached getter, hot-reloadable.

### 19. JWT key rotation (NEW)
Card: current key id · age · days until rotation due. One-click "Rotate now" with confirmation (sets new key as active, old served via JWKS for 30d).

### 20. Tax/legal export (NEW)
Year-end button: "Generate 1099-K data for US vendors" → CSV with totals per vendor. EU VAT report. Out of scope for full impl, just the CSV.

---

## Data layer additions

```ts
// lib/services/admin.ts new exports
getSystemHealth(): SystemHealth
getTakeRateTrend(months): { month, gmv, cut, rate_bps }[]
getChannelMixTrend(months): { month, direct, affiliate, reseller }[]
getConcentrationRisk(): { top5, others, alarm }
getPayoutObligation(): { vendors, affiliates, resellers, total }
getWebhookStats(): { received1h, processed1h, failed1h, dlq[] }
getDisputeOverview(): { open, $atRisk, byVendor[] }
getVendorDrillDown(vendorId): VendorFullView
getInactiveVendors(daysIdle): VendorRow[]
getRateLimitEvents(opts): RateLimitEvent[]
forceRefund(chargeId, reason, adminId): void
regenerateAnonToken(subscriptionId, adminId): void
suspendUser(userId, reason, adminId): void
impersonate(userId, adminId): SessionToken
getFeatureFlags(): FeatureFlag[]
setFeatureFlag(name, enabled, adminId): void
rotateJwtKey(adminId): { oldKid, newKid }
exportTaxReport(year): CSVStream
```

New tables: `webhook_events` (id, type, received_at, processed_at, error, payload), `feature_flags` (name, enabled, updated_by, updated_at).

---

## Acceptance criteria

- [ ] System health row updates live (or every 30s).
- [ ] Webhook health shows actual events; DLQ retry works.
- [ ] Concentration risk alarm triggers >20%.
- [ ] Payout obligation matches Friday cron expected output.
- [ ] Drill-down drawer from any vendor row.
- [ ] Manual refund tool reverses Stripe charge + writes audit + adjusts MRR rollups.
- [ ] Impersonation session is time-limited (10min) + audited + banner shown "Impersonating X".
- [ ] Feature flag flips take effect within 60s (cache TTL).
- [ ] JWT rotation publishes new key id to JWKS, old key remains for 30d.
- [ ] Tax export CSV opens cleanly.
- [ ] Mobile (admin is desktop-first but should remain usable on tablet).
- [ ] RLS: every admin endpoint checks `role='admin'`.
