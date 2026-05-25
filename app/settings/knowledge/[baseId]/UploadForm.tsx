"use client";

import { useState } from "react";
import { ingestUrlAction } from "../actions";

export function UploadForm({ baseId }: { baseId: string }) {
  const [mode, setMode] = useState<"closed" | "url">("closed");

  if (mode === "closed") {
    return (
      <button
        onClick={() => setMode("url")}
        className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary/90"
      >
        + Add URL
      </button>
    );
  }

  return (
    <form action={ingestUrlAction} className="flex items-center gap-2">
      <input type="hidden" name="knowledge_base_id" value={baseId} />
      <input
        name="url"
        type="url"
        required
        placeholder="https://example.com/docs"
        className="rounded-md border px-3 py-1.5 text-sm w-72"
      />
      <button
        type="submit"
        className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary/90"
      >
        Add
      </button>
      <button
        type="button"
        onClick={() => setMode("closed")}
        className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
      >
        Cancel
      </button>
    </form>
  );
}
