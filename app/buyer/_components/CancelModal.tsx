"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { cancelSubscriptionAction } from "../actions";

const REASONS = [
  { code: "too_expensive", label: "Too expensive" },
  { code: "not_using", label: "Not using it" },
  { code: "switched_product", label: "Switched to another product" },
  { code: "missing_feature", label: "Missing a feature I need" },
  { code: "bug_or_quality", label: "Bug or quality issue" },
  { code: "other", label: "Other" },
] as const;

type ReasonCode = (typeof REASONS)[number]["code"];

export function CancelModal({
  subscriptionId,
  appName,
  periodEnd,
}: {
  subscriptionId: string;
  appName: string;
  periodEnd: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ReasonCode | null>(null);
  const [comment, setComment] = useState("");
  const [immediate, setImmediate] = useState(false);
  const [isPending, startTransition] = useTransition();
  const toast = useToast();

  function handleConfirm() {
    startTransition(async () => {
      const result = await cancelSubscriptionAction({
        subscriptionId,
        reasonCode: reason ?? undefined,
        comment: comment.trim() || undefined,
        immediate,
      });
      setOpen(false);
      if ("error" in result) {
        toast(result.error, { type: "bad" });
      } else {
        toast(
          immediate
            ? `${appName} cancelled immediately.`
            : `${appName} will cancel on ${new Date(periodEnd).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}.`,
          { type: "ok" }
        );
      }
    });
  }

  const periodEndFormatted = new Date(periodEnd).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        className="text-destructive hover:text-destructive"
      >
        Cancel
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Cancel ${appName}?`}
        description={
          immediate
            ? "Access will stop immediately."
            : `Access continues until ${periodEndFormatted}.`
        }
        confirmLabel={isPending ? "Cancelling…" : "Confirm cancellation"}
        confirmVariant="destructive"
        onConfirm={handleConfirm}
        isPending={isPending}
      >
        <div className="space-y-4 mt-3">
          {/* Reason */}
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">
              Why are you cancelling? <span className="text-muted-foreground/60">(optional)</span>
            </p>
            <div className="flex flex-col gap-1">
              {REASONS.map((r) => (
                <label
                  key={r.code}
                  className="flex items-center gap-2 cursor-pointer text-sm py-1"
                >
                  <input
                    type="radio"
                    name="reason"
                    value={r.code}
                    checked={reason === r.code}
                    onChange={() => setReason(r.code)}
                    className="accent-primary"
                  />
                  {r.label}
                </label>
              ))}
            </div>
          </div>

          {/* Comment */}
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1">
              Anything else? <span className="text-muted-foreground/60">(optional)</span>
            </p>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              maxLength={500}
              rows={2}
              placeholder="Help us improve…"
              className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
            />
          </div>

          {/* Timing */}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setImmediate(false)}
              className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                !immediate
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:border-primary/40"
              }`}
            >
              Cancel at period end
              <span className="block text-[10px] font-normal mt-0.5 opacity-70">
                Access until {periodEndFormatted}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setImmediate(true)}
              className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                immediate
                  ? "border-destructive bg-destructive/10 text-destructive"
                  : "border-border text-muted-foreground hover:border-destructive/40"
              }`}
            >
              Cancel immediately
              <span className="block text-[10px] font-normal mt-0.5 opacity-70">
                Access stops now
              </span>
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
