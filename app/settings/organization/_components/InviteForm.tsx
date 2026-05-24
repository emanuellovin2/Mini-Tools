"use client";

import { useState, useTransition } from "react";
import { inviteMemberAction } from "../actions";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

export function InviteForm() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    const fd = new FormData(e.currentTarget);
    startTransition(async () => {
      const result = await inviteMemberAction(fd);
      if ("error" in result) {
        setError(result.error);
      } else {
        setSuccess(true);
        (e.target as HTMLFormElement).reset();
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-end gap-3 flex-wrap">
      <div className="flex-1 min-w-[200px]">
        <label className="block text-[12px] text-muted-foreground mb-1">Email</label>
        <Input
          name="email"
          type="email"
          placeholder="colleague@example.com"
          required
          disabled={pending}
          className="h-8 text-[13px]"
        />
      </div>
      <div>
        <label className="block text-[12px] text-muted-foreground mb-1">Role</label>
        <select
          name="role"
          defaultValue="member"
          disabled={pending}
          className="h-8 rounded-md border border-border bg-background px-2 text-[13px]"
        >
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
      </div>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Sending…" : "Send invite"}
      </Button>
      {error && <p className="w-full text-[12px] text-bad">{error}</p>}
      {success && <p className="w-full text-[12px] text-ok">Invitation sent.</p>}
    </form>
  );
}
