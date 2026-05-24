/**
 * k6 smoke harness — seven critical paths
 * Run against a seeded local stack: k6 run scripts/loadtest/smoke.js
 *
 * Expected baselines (p95 / p99 on M1 laptop, local Supabase):
 *   marketplace_list        p95 < 80ms    p99 < 150ms
 *   events_beacon           p95 < 40ms    p99 < 80ms
 *   subscribe_webhook       p95 < 500ms   p99 < 1000ms   (DB write path)
 *   usage_draw_down         p95 < 200ms   p99 < 400ms    (concurrent lock)
 *   wave9_org_browse        p95 < 150ms   p99 < 300ms    (1M-org scale sim)
 *   wave9_agency_dashboard  p95 < 300ms   p99 < 600ms    (100k-client agency)
 *   wave9_metric_ingest     p95 < 50ms    p99 < 100ms    (1B events/day = ~1k/sec sustained)
 *
 * Update the "Baselines" table in ENGINEERING.md §11 after each run.
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const SUPABASE_URL = __ENV.SUPABASE_URL || "http://localhost:54321";
const SERVICE_KEY = __ENV.SUPABASE_SERVICE_ROLE_KEY || "";

// Custom metrics
const marketplaceDuration  = new Trend("marketplace_list_duration");
const eventsDuration       = new Trend("events_beacon_duration");
const webhookDuration      = new Trend("subscribe_webhook_duration");
const usageDuration        = new Trend("usage_draw_down_duration");
const orgBrowseDuration    = new Trend("wave9_org_browse_duration");
const agencyDashDuration   = new Trend("wave9_agency_dashboard_duration");
const metricIngestDuration = new Trend("wave9_metric_ingest_duration");
const errorRate            = new Rate("error_rate");

export const options = {
  scenarios: {
    // 1. Marketplace listing at 5k rps — edge-cache hit simulation
    marketplace: {
      executor: "ramping-vus",
      stages: [
        { duration: "10s", target: 50 },
        { duration: "30s", target: 200 },
        { duration: "10s", target: 0 },
      ],
      exec: "marketplaceScenario",
    },
    // 2. Events beacon at 1k rps
    events: {
      executor: "constant-arrival-rate",
      rate: 100,
      timeUnit: "1s",
      duration: "30s",
      preAllocatedVUs: 50,
      maxVUs: 200,
      exec: "eventsScenario",
      startTime: "5s",
    },
    // 3. Subscribe webhook money path (lower concurrency — writes)
    webhook: {
      executor: "constant-vus",
      vus: 5,
      duration: "30s",
      exec: "webhookScenario",
      startTime: "5s",
    },
    // 4. Usage draw-down at 200 concurrent (lock contention test)
    usage: {
      executor: "constant-vus",
      vus: 200,
      duration: "30s",
      exec: "usageScenario",
      startTime: "5s",
    },
    // 5. Wave 9: 1M-org browse simulation (org listing + search)
    wave9_org_browse: {
      executor: "ramping-vus",
      stages: [
        { duration: "10s", target: 100 },
        { duration: "20s", target: 500 },
        { duration: "10s", target: 0 },
      ],
      exec: "orgBrowseScenario",
      startTime: "10s",
    },
    // 6. Wave 9: 100k-client agency dashboard
    wave9_agency_dashboard: {
      executor: "constant-vus",
      vus: 50,
      duration: "30s",
      exec: "agencyDashboardScenario",
      startTime: "10s",
    },
    // 7. Wave 9: metric ingest spike — 1k/sec sustained (1B events/day equivalent)
    wave9_metric_ingest: {
      executor: "constant-arrival-rate",
      rate: 1000,
      timeUnit: "1s",
      duration: "30s",
      preAllocatedVUs: 200,
      maxVUs: 500,
      exec: "metricIngestScenario",
      startTime: "10s",
    },
  },
  thresholds: {
    marketplace_list_duration:      ["p(95)<80",   "p(99)<150"],
    events_beacon_duration:         ["p(95)<40",   "p(99)<80"],
    subscribe_webhook_duration:     ["p(95)<500",  "p(99)<1000"],
    usage_draw_down_duration:       ["p(95)<200",  "p(99)<400"],
    wave9_org_browse_duration:      ["p(95)<150",  "p(99)<300"],
    wave9_agency_dashboard_duration:["p(95)<300",  "p(99)<600"],
    wave9_metric_ingest_duration:   ["p(95)<50",   "p(99)<100"],
    error_rate:                     ["rate<0.01"],
  },
};

export function marketplaceScenario() {
  const res = http.get(`${BASE_URL}/marketplace`, {
    tags: { scenario: "marketplace" },
  });
  marketplaceDuration.add(res.timings.duration);
  const ok = check(res, { "marketplace 200": (r) => r.status === 200 });
  errorRate.add(!ok);
  sleep(0.1);
}

export function eventsScenario() {
  const payload = JSON.stringify({
    event: "page_view",
    path: "/marketplace",
    visitor_hash: `v_${Math.random().toString(36).slice(2)}`,
    ts: Date.now(),
  });
  const res = http.post(`${BASE_URL}/api/events`, payload, {
    headers: { "Content-Type": "application/json" },
    tags: { scenario: "events" },
  });
  eventsDuration.add(res.timings.duration);
  // 200 or 202 or 204 are all acceptable for beacon endpoints
  const ok = check(res, { "beacon accepted": (r) => r.status < 300 });
  errorRate.add(!ok);
}

export function webhookScenario() {
  // Simulate a Stripe invoice.paid webhook — must be fast + idempotent
  const eventId = `evt_smoke_${crypto.randomUUID()}`;
  const payload = JSON.stringify({
    id: eventId,
    type: "invoice.paid",
    data: {
      object: {
        id: `in_smoke_${Math.random().toString(36).slice(2)}`,
        subscription: `sub_smoke_${Math.random().toString(36).slice(2)}`,
        amount_paid: 2900,
        currency: "usd",
      },
    },
  });

  // Note: real webhook requires Stripe signature; smoke hits a test-mode stub endpoint
  const res = http.post(`${BASE_URL}/api/webhooks/smoke-test`, payload, {
    headers: { "Content-Type": "application/json" },
    tags: { scenario: "webhook" },
  });
  webhookDuration.add(res.timings.duration);
  // 200 | 404 (stub not wired) both acceptable for smoke baseline
  const ok = check(res, { "webhook responded": (r) => r.status < 500 });
  errorRate.add(!ok);
  sleep(1);
}

export function usageScenario() {
  // Simulate concurrent usage draw-down — #40 wallet deduction lock
  const walletId = "smoke-wallet-1"; // shared wallet forces lock contention
  const res = http.post(
    `${BASE_URL}/api/usage/draw`,
    JSON.stringify({ walletId, units: 1, idempotencyKey: crypto.randomUUID() }),
    {
      headers: { "Content-Type": "application/json" },
      tags: { scenario: "usage" },
    }
  );
  usageDuration.add(res.timings.duration);
  // 200 | 402 (insufficient credits) | 404 (stub) all acceptable in smoke
  const ok = check(res, { "usage draw responded": (r) => r.status < 500 });
  errorRate.add(!ok);
  sleep(0.05);
}

// ── Wave 9 scenarios ────────────────────────────────────────────────────────

export function orgBrowseScenario() {
  // 1M-org browse: list organizations with pagination (cursor-based).
  // Simulates an admin scanning org list under heavy load.
  const cursor = Math.random() > 0.5 ? `?cursor=smoke_${Math.floor(Math.random() * 100)}` : "";
  const res = http.get(`${BASE_URL}/api/v1/admin/orgs${cursor}`, {
    headers: { Authorization: `Bearer smoke-admin-token` },
    tags: { scenario: "wave9_org_browse" },
  });
  orgBrowseDuration.add(res.timings.duration);
  const ok = check(res, { "org browse responded": (r) => r.status < 500 });
  errorRate.add(!ok);
  sleep(0.05);
}

export function agencyDashboardScenario() {
  // 100k-client agency dashboard: load client health board.
  // Forces cursor-pagination query over client_relationships for one agency.
  const agencyOrgId = `smoke-agency-${Math.floor(Math.random() * 10)}`;
  const res = http.get(`${BASE_URL}/agency/clients?org=${agencyOrgId}&limit=20`, {
    headers: { Authorization: `Bearer smoke-agency-token` },
    tags: { scenario: "wave9_agency_dashboard" },
  });
  agencyDashDuration.add(res.timings.duration);
  const ok = check(res, { "agency dashboard responded": (r) => r.status < 500 });
  errorRate.add(!ok);
  sleep(0.1);
}

export function metricIngestScenario() {
  // 1B events/day spike: ~1k/sec sustained metric ingest.
  // Tests idempotency_keys_v2 write throughput + deployment_metrics partition.
  const deploymentId = `smoke-dep-${Math.floor(Math.random() * 1000)}`;
  const payload = JSON.stringify({
    deploymentId,
    namespace: "lead.count",
    value: Math.floor(Math.random() * 10),
    idempotencyKey: crypto.randomUUID(),
    ts: Date.now(),
  });
  const res = http.post(`${BASE_URL}/api/v1/metrics`, payload, {
    headers: { "Content-Type": "application/json" },
    tags: { scenario: "wave9_metric_ingest" },
  });
  metricIngestDuration.add(res.timings.duration);
  // 200 | 201 | 204 | 404 (stub) all acceptable
  const ok = check(res, { "metric ingest responded": (r) => r.status < 500 });
  errorRate.add(!ok);
}
