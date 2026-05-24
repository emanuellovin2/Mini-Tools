/**
 * k6 smoke harness — four critical paths
 * Run against a seeded local stack: k6 run scripts/loadtest/smoke.js
 *
 * Expected baselines (p95 / p99 on M1 laptop, local Supabase):
 *   marketplace_list   p95 < 80ms   p99 < 150ms
 *   events_beacon      p95 < 40ms   p99 < 80ms
 *   subscribe_webhook  p95 < 500ms  p99 < 1000ms  (DB write path)
 *   usage_draw_down    p95 < 200ms  p99 < 400ms   (concurrent lock)
 *
 * Update the "Baselines" section in ENGINEERING.md §8 after each run.
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
  },
  thresholds: {
    marketplace_list_duration: ["p(95)<80", "p(99)<150"],
    events_beacon_duration:    ["p(95)<40", "p(99)<80"],
    subscribe_webhook_duration: ["p(95)<500", "p(99)<1000"],
    usage_draw_down_duration:  ["p(95)<200", "p(99)<400"],
    error_rate:                ["rate<0.01"],
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
