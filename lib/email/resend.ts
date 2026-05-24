/**
 * Resend email service.
 *
 * All public functions are "safe" — a Resend outage (network failure, bad API key,
 * rate limit) degrades to "logged but not sent" and never throws to the caller.
 * This ensures no webhook handler or cron job crashes due to an email failure.
 */

import { Resend } from "resend";
import { logEmail } from "@/lib/logger";

// Escape user-controlled strings before interpolating into the HTML body.
// Vendor-set fields (app names, etc.) reach buyers via these templates; without
// escaping, a vendor could inject markup into receipts and dunning notices.
function escapeHtml(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

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

// WL Tier 2 branding context for buyer emails. When set, subject prefix and header logo
// reflect the reseller's brand instead of the platform's. From address stays platform
// (per-reseller domain deferred to #30).
export interface WLEmailBranding {
  displayName: string;
  logoUrl: string;
  brandColor: string;
}

const PLATFORM_NAME = "[PLATFORM]";

function buildEmailHeader(wl?: WLEmailBranding): string {
  if (!wl) return "";
  const name = escapeHtml(wl.displayName);
  const color = escapeHtml(wl.brandColor);
  const logoUrl = escapeHtml(wl.logoUrl);
  return `
    <div style="background:${color};padding:12px 24px;display:flex;align-items:center;gap:12px;margin-bottom:24px;">
      <img src="${logoUrl}" alt="${name}" style="height:32px;width:auto;object-fit:contain;" />
      <span style="color:#fff;font-weight:bold;font-size:16px">${name}</span>
    </div>
  `;
}

function buildEmailFooter(wl?: WLEmailBranding): string {
  if (wl) {
    return `<p style="color:#aaa;font-size:11px;margin-top:24px">Hosted by ${PLATFORM_NAME}</p>`;
  }
  return `<p style="color:#aaa;font-size:11px;margin-top:24px">Powered by ${PLATFORM_NAME}</p>`;
}

export async function sendSubscriptionReceipt(opts: {
  buyerEmail: string;
  appName: string;
  amountCents: number;
  invoiceId: string;
  currency?: string;
  wlBranding?: WLEmailBranding;
}): Promise<boolean> {
  const currency = opts.currency ?? "usd";
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(opts.amountCents / 100);

  const appName = escapeHtml(opts.appName);
  const invoiceId = escapeHtml(opts.invoiceId);
  const formattedAmount = escapeHtml(formatted);

  const subjectPrefix = opts.wlBranding ? `[${opts.wlBranding.displayName}] ` : "";
  const header = buildEmailHeader(opts.wlBranding);
  const footer = buildEmailFooter(opts.wlBranding);

  return safeSend("subscription_receipt", (resend) =>
    resend.emails.send({
      from: fromAddress(),
      to: opts.buyerEmail,
      subject: `${subjectPrefix}Receipt — ${opts.appName} subscription`,
      html: `
        ${header}
        <p>Thanks for subscribing to <strong>${appName}</strong>.</p>
        <p>Payment of <strong>${formattedAmount}</strong> received.</p>
        <p style="color:#888;font-size:12px">Invoice ID: ${invoiceId}</p>
        ${footer}
      `,
    })
  );
}

export async function sendPaymentFailedNotice(opts: {
  buyerEmail: string;
  appName: string;
  amountDueCents: number;
  currency?: string;
  wlBranding?: WLEmailBranding;
}): Promise<boolean> {
  const currency = opts.currency ?? "usd";
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(opts.amountDueCents / 100);

  const appName = escapeHtml(opts.appName);
  const formattedAmount = escapeHtml(formatted);

  const subjectPrefix = opts.wlBranding ? `[${opts.wlBranding.displayName}] ` : "";
  const header = buildEmailHeader(opts.wlBranding);
  const footer = buildEmailFooter(opts.wlBranding);

  return safeSend("payment_failed", (resend) =>
    resend.emails.send({
      from: fromAddress(),
      to: opts.buyerEmail,
      subject: `${subjectPrefix}Action required — payment failed for ${opts.appName}`,
      html: `
        ${header}
        <p>We couldn't process your payment of <strong>${formattedAmount}</strong> for
        <strong>${appName}</strong>.</p>
        <p>Please update your payment method to keep access to the app.</p>
        <p>Your access has been suspended until the payment is resolved.</p>
        ${footer}
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
  const vendorLabelSafe = escapeHtml(vendorLabel);
  const monthSafe = escapeHtml(opts.month);

  return safeSend("churn_alert", (resend) =>
    resend.emails.send({
      from: fromAddress(),
      to,
      subject: `[PLATFORM] Churn alert — ${vendorLabel} (${ratePercent}% in ${opts.month})`,
      html: `
        <p>Vendor <strong>${vendorLabelSafe}</strong> exceeded the churn threshold in
        <strong>${monthSafe}</strong>.</p>
        <ul>
          <li>Cancellations: ${escapeHtml(opts.canceled)}</li>
          <li>Active at period start: ${escapeHtml(opts.activeAtStart)}</li>
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
        `<li><strong>${escapeHtml(d.type)}</strong> — ${escapeHtml(d.message)}${
          d.stripe_id ? ` (${escapeHtml(d.stripe_id)})` : ""
        }</li>`
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

  const runAtSafe = escapeHtml(opts.runAt);
  const dashboardUrl = encodeURI(
    `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/admin/reconciliation`
  );

  return safeSend("reconciliation_digest", (resend) =>
    resend.emails.send({
      from: fromAddress(),
      to,
      subject,
      html:
        opts.driftCount === 0
          ? `<p>Daily reconciliation run at ${runAtSafe} found no drift. ✅</p>`
          : `
        <p>Daily reconciliation run at <strong>${runAtSafe}</strong> found
        <strong>${opts.driftCount}</strong> drift item(s).</p>
        <ul>${itemRows}</ul>
        ${overflowNote}
        <p><a href="${dashboardUrl}">
          View reconciliation dashboard →</a></p>
      `,
    })
  );
}
