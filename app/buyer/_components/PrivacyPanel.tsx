import Link from "next/link";

export function PrivacyPanel({ anonToken }: { anonToken: string | null }) {
  return (
    <div className="border border-border rounded-xl p-5">
      <div className="flex items-start justify-between gap-2 mb-4">
        <h2 className="text-sm font-semibold">What vendors see about you</h2>
        <Link
          href="/legal/fees"
          className="text-xs text-primary underline shrink-0"
        >
          Why →
        </Link>
      </div>

      <div className="space-y-2 text-sm">
        <div className="flex items-start gap-2">
          <span className="text-green-500 shrink-0 text-base leading-none mt-0.5">✓</span>
          <div>
            <p className="font-medium text-foreground">Anonymous token</p>
            {anonToken && (
              <p className="text-xs text-muted-foreground font-mono mt-0.5 truncate max-w-[200px]">
                {anonToken}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Stable identifier for your app session — stable across resubscriptions.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-2">
          <span className="text-green-500 shrink-0 text-base leading-none mt-0.5">✓</span>
          <div>
            <p className="font-medium text-foreground">Subscription start date</p>
            <p className="text-xs text-muted-foreground">
              When you first subscribed (for access provisioning).
            </p>
          </div>
        </div>

        <div className="border-t border-border/50 pt-2 mt-2 space-y-2">
          {[
            ["Your email address", "Never shared with vendors."],
            ["Your name", "Never shared with vendors."],
            ["Your card or payment details", "Handled exclusively by Stripe."],
            ["Your location or device", "Not collected or shared."],
          ].map(([label, note]) => (
            <div key={label} className="flex items-start gap-2">
              <span className="text-destructive shrink-0 text-base leading-none mt-0.5">✗</span>
              <div>
                <p className="font-medium text-foreground">{label}</p>
                <p className="text-xs text-muted-foreground">{note}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
