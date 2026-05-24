"use client";

import { useState, useTransition } from "react";
import { cancelSubscriptionAction } from "../actions";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";

export default function CancelButton({ subscriptionId }: { subscriptionId: string }) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const toast = useToast();

  function handleConfirm() {
    startTransition(async () => {
      const result = await cancelSubscriptionAction(subscriptionId);
      setOpen(false);
      if ("error" in result) {
        toast(result.error, { type: "bad" });
      } else {
        toast("Subscription will cancel at the end of the billing period.", { type: "ok" });
      }
    });
  }

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}
        className="text-muted-foreground hover:text-destructive">
        Cancel subscription
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Cancel subscription?"
        description="You keep access until the end of your current billing period."
        confirmLabel="Yes, cancel"
        confirmVariant="destructive"
        onConfirm={handleConfirm}
        isPending={isPending}
      />
    </>
  );
}
