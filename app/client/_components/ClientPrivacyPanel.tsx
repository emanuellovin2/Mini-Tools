export function ClientPrivacyPanel({ agencyName }: { agencyName: string | null }) {
  const who = agencyName ?? "your agency";

  return (
    <div className="rounded-xl border border-border p-5">
      <h2 className="text-sm font-semibold mb-4">What {who} can see</h2>

      <div className="space-y-2 text-sm">
        {[
          ["Deployment status", "Active, paused, or failed."],
          ["Outcome metrics", "Aggregated results for your deployments."],
          ["Credit balance", "How many credits remain in your wallet."],
        ].map(([label, note]) => (
          <div key={label} className="flex items-start gap-2">
            <span className="text-green-500 shrink-0 text-base leading-none mt-0.5">✓</span>
            <div>
              <p className="font-medium text-foreground">{label}</p>
              <p className="text-xs text-muted-foreground">{note}</p>
            </div>
          </div>
        ))}

        <div className="border-t border-border/50 pt-2 mt-2 space-y-2">
          {[
            ["Your email address", "Not shared with your agency."],
            ["Individual usage sessions", "Only aggregated metrics are shared."],
            ["Your payment details", "Handled exclusively by Stripe."],
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
