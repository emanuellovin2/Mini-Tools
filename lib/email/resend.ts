/**
 * Resend email service.
 *
 * All public functions are "safe" — a Resend outage (network failure, bad API key,
 * rate limit) degrades to "logged but not sent" and never throws to the caller.
 * This ensures no webhook handler or cron job crashes due to an email failure.
 */

import { Resend } from "resend";
import { logEmail } from "@/lib/logger";

let _client: Resend | null = null;

function getResend(): Resend | null {
  if (!process.env.RESEND_API_KEY) return null;
  if (!_client) _client = new Resend(process.env.RESEND_API_KEY);
  return _client;
}

function fromAddress(): string {
  return process.env.EMAIL_FROM ?? "noreply@platform.local";
}

function adminEmail(): string | null {
  return process.env.ADMIN_EMAIL ?? null;
}

/** Wrap any Resend call so a failure is logged but never propagated. */
async function safeSend(
  template: string,
  fn: (resend: Resend) => Promise<unknown>
): Promise<boolean> {
  const resend = getResend();
  if (!resend) {
    logEmail({ template, outcome: "skipped" });
    return false;
  }
  try {
    await fn(resend);
    logEmail({ template, outcome: "sent" });
    return true;
  } catch (err) {
    logEmail({
      template,
      outcome: "failed",
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Buyer emails
// ---------------------------------------------------------------------------

export async function sendSubscriptionReceipt(opts: {
  buyerEmail: string;
  appName: string;
  amountCents: number;
  invoiceId: string;
  currency?: string;
}): Promise<boolean> {
  const currency = opts.currency ?? "usd";
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(opts.amountCents / 100);

  return safeSend("subscription_receipt", (resend) =>
    resend.emails.send({
      from: fromAddress(),
      to: opts.buyerEmail,
      subject: `Receipt — ${opts.appName} subscription`,
      html: `
        <p>Thanks for subscribing to <strong>${opts.appName}</strong>.</p>
        <p>Payment of <strong>${formatted}</strong> received.</p>
        <p style="color:#888;font-size:12px">Invoice ID: ${opts.invoiceId}</p>
      `,
    })
  );
}

export async function sendPaymentFailedNotice(opts: {
  buyerEmail: string;
  appName: string;
  amountDueCents: number;
  currency?: string;
}): Promise<boolean> {
  const currency = opts.currency ?? "usd";
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(opts.amountDueCents / 100);

  return safeSend("payment_failed", (resend) =>
    resend.emails.send({
      from: fromAddress(),
      to: opts.buyerEmail,
      subject: `Action required — payment failed for ${opts.appName}`,
      html: `
        <p>We couldn't process your payment of <strong>${formatted}</strong> for
        <strong>${opts.appName}</strong>.</p>
        <p>Please update your payment method to keep access to the app.</p>
        <p>Your access has been suspended until the payment is resolved.</p>
      `,
    })
  );
}

// ---------------------------------------------------------------------------
// Admin emails
// ---------------------------------------------------------------------------

export async function sendChurnAlert(opts: {
  vendorName: string | null;
  vendorId: string;
  rateBps: number;
  canceled: number;
  activeAtStart: number;
  month: string; // "YYYY-MM"
}): Promise<boolean> {
  const to = adminEmail();
  if (!to) {
    logEmail({ template: "churn_alert", outcome: "skipped" });
    return false;
  }

  const ratePercent = (opts.rateBps / 100).toFixed(1);
  const vendorLabel = opts.vendorName ?? opts.vendorId;

  return safeSend("churn_alert", (resend) =>
    resend.emails.send({
      from: fromAddress(),
      to,
      subject: `[PLATFORM] Churn alert — ${vendorLabel} (${ratePercent}% in ${opts.month})`,
      html: `
        <p>Vendor <strong>${vendorLabel}</strong> exceeded the churn threshold in
        <strong>${opts.month}</strong>.</p>
        <ul>
          <li>Cancellations: ${opts.canceled}</li>
          <li>Active at period start: ${opts.activeAtStart}</li>
          <li>Cancellation rate: ${ratePercent}%</li>
        </ul>
        <p>Review the admin dashboard for details.</p>
      `,
    })
  );
}

export async function sendReconciliationDigest(opts: {
  runAt: string;
  driftCount: number;
  driftItems: Array<{
    type: string;
    stripe_id: string | null;
    message: string;
  }>;
}): Promise<boolean> {
  const to = adminEmail();
  if (!to) {
    logEmail({ template: "reconciliation_digest", outcome: "skipped" });
    return false;
  }

  const itemRows = opts.driftItems
    .slice(0, 20) // cap HTML size
    .map(
      (d) =>
        `<li><strong>${d.type}</strong> — ${d.message}${d.stripe_id ? ` (${d.stripe_id})` : ""}</li>`
    )
    .join("\n");

  const overflowNote =
    opts.driftItems.length > 20
      ? `<p>…and ${opts.driftItems.length - 20} more. Open the reconciliation view for full details.</p>`
      : "";

  const subject =
    opts.driftCount === 0
      ? `[PLATFORM] Reconciliation OK — ${opts.runAt.slice(0, 10)}`
      : `[PLATFORM] Reconciliation drift — ${opts.driftCount} item(s) — ${opts.runAt.slice(0, 10)}`;

  return safeSend("reconciliation_digest", (resend) =>
    resend.emails.send({
      from: fromAddress(),
      to,
      subject,
      html:
        opts.driftCount === 0
          ? `<p>Daily reconciliation run at ${opts.runAt} found no drift. ✅</p>`
          : `
        <p>Daily reconciliation run at <strong>${opts.runAt}</strong> found
        <strong>${opts.driftCount}</strong> drift item(s).</p>
        <ul>${itemRows}</ul>
        ${overflowNote}
        <p><a href="${process.env.NEXT_PUBLIC_APP_URL ?? ""}/admin/reconciliation">
          View reconciliation dashboard →</a></p>
      `,
    })
  );
}
