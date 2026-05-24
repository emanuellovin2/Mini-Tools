"use client";

import { useState, useTransition } from "react";
import { pauseSubscriptionAction, resumeSubscriptionAction } from "../actions";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";

type PauseDays = 30 | 60 | 90;

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function pauseUntilDate(days: PauseDays): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return formatDate(d.toISOString());
}

export function PauseButton({
  subscriptionId,
  currentPeriodEnd,
}: {
  subscriptionId: string;
  currentPeriodEnd: string;
}) {
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState<PauseDays>(30);
  const [isPending, startTransition] = useTransition();
  const toast = useToast();

  function handleConfirm() {
    startTransition(async () => {
      const result = await pauseSubscriptionAction(subscriptionId, days);
      setOpen(false);
      if ("error" in result) {
        toast(result.error, { type: "bad" });
      } else {
        toast(`Subscription paused until ${pauseUntilDate(days)}.`, { type: "ok" });
      }
    });
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        className="text-muted-foreground"
      >
        Pause
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Pause subscription?"
        description={`Billing and access pause after ${formatDate(currentPeriodEnd)} (your current billing period). You can resume any time.`}
        confirmLabel={isPending ? "Pausing…" : `Pause for ${days} days`}
        confirmVariant="default"
        onConfirm={handleConfirm}
        isPending={isPending}
      >
        <div className="flex gap-2 mt-3">
          {([30, 60, 90] as PauseDays[]).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                days === d
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:border-primary/40"
              }`}
            >
              {d} days
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          Resumes automatically on {pauseUntilDate(days)}.
        </p>
      </Modal>
    </>
  );
}

export function ResumeButton({ subscriptionId }: { subscriptionId: string }) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const toast = useToast();

  function handleConfirm() {
    startTransition(async () => {
      const result = await resumeSubscriptionAction(subscriptionId);
      setOpen(false);
      if ("error" in result) {
        toast(result.error, { type: "bad" });
      } else {
        toast("Subscription resumed. Access restored.", { type: "ok" });
      }
    });
  }

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        Resume now
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Resume subscription?"
        description="Your billing will restart on the next cycle and access will be restored immediately."
        confirmLabel="Yes, resume"
        confirmVariant="default"
        onConfirm={handleConfirm}
        isPending={isPending}
      />
    </>
  );
}
