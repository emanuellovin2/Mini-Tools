"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { pauseSubscriptionAction, resumeSubscriptionAction } from "../actions";

function maxDate() {
  const d = new Date();
  d.setDate(d.getDate() + 90);
  return d.toISOString().split("T")[0];
}

function minDate() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split("T")[0];
}

export function PauseModal({
  subscriptionId,
  appName,
}: {
  subscriptionId: string;
  appName: string;
}) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    return d.toISOString().split("T")[0];
  });
  const [isPending, startTransition] = useTransition();
  const toast = useToast();

  function handleConfirm() {
    startTransition(async () => {
      const result = await pauseSubscriptionAction(subscriptionId, date);
      setOpen(false);
      if ("error" in result) {
        toast(result.error, { type: "bad" });
      } else {
        toast(
          `${appName} paused until ${new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}.`,
          { type: "ok" }
        );
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
        title={`Pause ${appName}`}
        description="Billing and access pause at the end of your current billing period. Resume any time before the date."
        confirmLabel={isPending ? "Pausing…" : "Confirm pause"}
        confirmVariant="default"
        onConfirm={handleConfirm}
        isPending={isPending}
      >
        <div className="mt-3 space-y-2">
          <label className="text-xs font-medium text-muted-foreground block">
            Resume on
          </label>
          <input
            type="date"
            value={date}
            min={minDate()}
            max={maxDate()}
            onChange={(e) => setDate(e.target.value)}
            className="border border-border rounded-lg px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 w-full"
          />
          <p className="text-xs text-muted-foreground">
            Max 90 days from today.
          </p>
        </div>
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
