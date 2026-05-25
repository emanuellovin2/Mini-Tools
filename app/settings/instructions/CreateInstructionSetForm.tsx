"use client";

import { useRef, useState } from "react";
import { actionCreateInstructionSet } from "./actions";
import { Button } from "@/components/ui/Button";

const SCOPE_OPTIONS = [
  { value: "global", label: "Global — org-wide default" },
  { value: "project", label: "Project — per solution/product" },
  { value: "client", label: "Client — per client org" },
  { value: "deployment", label: "Deployment — per deployment" },
] as const;

export function CreateInstructionSetForm() {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [scope, setScope] = useState<string>("global");
  const formRef = useRef<HTMLFormElement>(null);

  const needsRef = scope !== "global";

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    const fd = new FormData(e.currentTarget);
    try {
      await actionCreateInstructionSet(fd);
    } finally {
      setPending(false);
    }
  }

  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        + New instruction set
      </Button>
    );
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="rounded-lg border p-4 space-y-4 max-w-lg">
      <h3 className="font-semibold text-sm">New instruction set</h3>

      <div className="space-y-1">
        <label className="text-xs text-muted-foreground" htmlFor="is-name">Name</label>
        <input
          id="is-name"
          name="name"
          required
          placeholder="e.g. House voice"
          className="w-full rounded-md border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        />
      </div>

      <div className="space-y-1">
        <label className="text-xs text-muted-foreground" htmlFor="is-scope">Scope</label>
        <select
          id="is-scope"
          name="scope_level"
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          className="w-full rounded-md border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        >
          {SCOPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {needsRef && (
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground" htmlFor="is-ref">
            {scope === "project" ? "Solution / project ID" : scope === "client" ? "Client org ID" : "Deployment ID"}
          </label>
          <input
            id="is-ref"
            name="scope_ref_id"
            required={needsRef}
            placeholder="UUID"
            className="w-full rounded-md border bg-background px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
      )}

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Creating…" : "Create"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
