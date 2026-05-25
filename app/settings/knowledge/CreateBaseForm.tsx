"use client";

import { useState } from "react";
import { createBaseAction } from "./actions";

export function CreateBaseForm({ orgId: _orgId }: { orgId: string }) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90"
      >
        + New Knowledge Base
      </button>
    );
  }

  return (
    <form action={createBaseAction} className="rounded-lg border p-4 space-y-3 bg-card">
      <div className="text-sm font-medium">New Knowledge Base</div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Name</label>
          <input
            name="name"
            required
            placeholder="e.g. Product Docs"
            className="w-full rounded-md border px-3 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Visibility</label>
          <select name="visibility" className="w-full rounded-md border px-3 py-1.5 text-sm">
            <option value="private">Private (org only)</option>
            <option value="org">Org (all members)</option>
            <option value="public">Public (marketplace-discoverable)</option>
          </select>
        </div>
      </div>
      <div className="flex gap-2">
        <button
          type="submit"
          className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-white hover:bg-primary/90"
        >
          Create
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md border px-4 py-1.5 text-sm hover:bg-muted"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
