"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { deleteAccountAction } from "../actions";

export default function DangerZone() {
  const [open, setOpen] = useState(false);
  const [, startTransition] = useTransition();

  function handleDelete() {
    startTransition(async () => {
      await deleteAccountAction();
      window.location.href = "/";
    });
  }

  return (
    <>
      <Card className="p-5 border-bad/30 space-y-3">
        <h3 className="text-sm font-semibold text-bad">Danger zone</h3>
        <p className="text-[12px] text-muted-foreground">
          Delete your account. This starts a 30-day grace period; during that window you can
          reactivate by signing in. After 30 days all data is permanently erased.
        </p>
        <Button variant="outline" size="sm" className="border-bad/40 text-bad hover:bg-bad/5"
          onClick={() => setOpen(true)}>
          Delete account
        </Button>
      </Card>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Delete account?"
        description="This starts a 30-day grace period. Type DELETE to confirm."
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={handleDelete}
      />
    </>
  );
}
