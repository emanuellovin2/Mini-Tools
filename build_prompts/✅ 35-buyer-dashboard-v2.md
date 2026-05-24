# Task #35 — Buyer dashboard v2 (calendar + payment methods + invoice history + privacy panel)

> **Before starting:** read `SPEC.md` §5, §6, §9, [lib/services/buyer.ts](lib/services/buyer.ts), [app/buyer/page.tsx](app/buyer/page.tsx), `mockups/index.html` (buyer view). Read [build_prompts/31-design-system-v2.md](build_prompts/31-design-system-v2.md).
> **Definition of Done:** buyer has full control — upcoming charges calendar, payment method management, invoice history, per-sub drawer with detail, cancel reason capture, pause-until date picker, privacy panel reinforcing anti-poaching value. Tests + SPEC.md §5 updated.

**Phase 5 — Wave 8. Depends on: #31. Parallel with #32–#34, #36, #37.**

---

## Sections to build

### 1. Header + summary (KEEP, refine)
"My subscriptions" + N active · $X/month · next charge date.

### 2. Upcoming charges timeline (NEW)
Horizontal calendar/timeline 30 days forward. Each marker = invoice with app icon + amount + date. Hover shows full detail. Replaces guessing per-card. Critical for cash flow visibility.

Service: `getBuyerUpcomingCharges(buyerId)` — pull from Stripe upcoming invoices on each sub.

### 3. Subscription cards (KEEP, refine)
Existing card layout. Add:
- Click anywhere → drawer with full detail (currently goes to vendor page or nothing).
- Channel badge: "Bought direct" / "via affiliate" / "via reseller {slug}".
- Renewal/paused status with date.

### 4. Per-sub drawer (NEW)
Opens on card click. Sections:
- Header: app · price · status · started date.
- Timeline: events from this sub (paid, paused, resumed, failed retry, refunded).
- Invoice history: list with download PDF for each.
- Payment method for this sub (can change).
- Change plan (if vendor exposes multiple prices).
- Vendor contact (relayed messaging — only if vendor opted in; out of scope for now, placeholder).
- Cancel button → opens cancel modal with reason capture.

### 5. Payment methods card (NEW — biggest gap)
List of saved cards (last4, brand, expiry). Add new card via Stripe `SetupIntent`. Set default. Delete. Each sub can use different card.

Service: extend `getBuyerSubscriptions` or new `getBuyerPaymentMethods(buyerId)` calling Stripe customer payment methods.

### 6. Invoice / receipt history (NEW)
Dedicated section (or under each sub). List of all invoices ever — date · app · amount · status · PDF download · receipt email.

Service: `getBuyerInvoices(buyerId, {limit, after})` — paginated, Stripe list invoices.

### 7. Cancel flow with reason (NEW)
Modal on cancel button:
- Reason radios: "Too expensive" / "Not using" / "Switched product" / "Missing feature" / "Bug or quality" / "Other".
- Optional free-text comment.
- Choice: cancel immediately OR at period end (default).
- On submit: record reason in `subscription_cancel_reasons` table (new), anonymized to vendor in their churn alerts.

### 8. Pause-until date picker (NEW)
Replace generic "Pause" with modal: date picker, max 90 days forward. Uses Stripe `pause_collection` with `paused_until` per #23.

### 9. Privacy panel (NEW)
Card: "What vendors see about you" with explicit list:
- ✓ Anonymous token (`anon_82fd9c...`).
- ✓ Subscription start date.
- ✗ Your email, name, card, location.
- "Why →" link to SPEC §6 explainer.
Reinforces the differentiating value.

### 10. Spend trend (NEW small card)
Last 6 months total spend mini-chart. Just a number + sparkline.

### 11. Bundle suggestions (NEW)
If buyer has 2+ subs from same vendor or reseller, surface bundle suggestion: "Acme Labs offers Cohortly — 20% off if added".

### 12. Discover apps widget (NEW)
3 recommended apps based on buyer's existing subscription categories. Link to marketplace.

### 13. Saving callout (KEEP)
"You're saving $X via bundles" — already in mockup.

### 14. Empty state
First-time buyer (zero subs) → big CTA "Browse marketplace →" with featured apps.

---

## Data layer additions

```ts
// lib/services/buyer.ts new exports
getBuyerUpcomingCharges(buyerId): UpcomingCharge[]
getBuyerPaymentMethods(buyerId): StripePaymentMethod[]
attachPaymentMethod(buyerId, setupIntentId): void
setDefaultPaymentMethod(buyerId, pmId): void
detachPaymentMethod(buyerId, pmId): void
getBuyerInvoices(buyerId, opts): Invoice[]
recordCancelReason(subscriptionId, reason, comment): void
getBuyerSpendHistory(buyerId, months): { month, total }[]
getBuyerRecommendations(buyerId, limit): App[]
```

New table `subscription_cancel_reasons`: `subscription_id`, `reason_code`, `comment`, `created_at`. RLS: buyer write own, vendor reads anonymized aggregate only (no `buyer_id` exposure).

---

## Acceptance criteria

- [ ] Upcoming charges timeline shows next 30d with accurate amounts.
- [ ] Buyer can add a new card via Stripe Checkout SetupIntent.
- [ ] Default card change reflected in next billing cycle.
- [ ] Each invoice has working PDF download (Stripe hosted URL).
- [ ] Cancel modal records reason in DB; vendor sees anonymized counts (not buyer id).
- [ ] Pause-until date picker enforces ≤90d, sets `paused_until` correctly.
- [ ] Privacy panel matches actual data exposure boundaries (SPEC §6).
- [ ] Bundle suggestions only show when ≥2 subs from same vendor/reseller.
- [ ] Mobile responsive.
- [ ] RLS: buyer reads own subs/invoices only, vendor cannot read `subscription_cancel_reasons.buyer_id`.
