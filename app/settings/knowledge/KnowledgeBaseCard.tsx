"use client";

import Link from "next/link";
import type { KnowledgeBase } from "@/lib/services/knowledge";
import { deleteBaseAction } from "./actions";

interface Props {
  base: KnowledgeBase;
  orgId: string;
}

const VISIBILITY_LABEL: Record<string, string> = {
  private: "Private",
  org: "Org",
  public: "Public",
};

export function KnowledgeBaseCard({ base, orgId: _orgId }: Props) {
  return (
    <div className="flex items-center justify-between rounded-lg border px-4 py-3 bg-card">
      <div className="space-y-0.5">
        <Link
          href={`/settings/knowledge/${base.id}`}
          className="text-sm font-medium hover:underline"
        >
          {base.name}
        </Link>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span>{VISIBILITY_LABEL[base.visibility] ?? base.visibility}</span>
          <span>{base.embeddingModel}</span>
          <span>shard {base.tenantShardId}</span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Link
          href={`/settings/knowledge/${base.id}`}
          className="rounded-md border px-3 py-1 text-xs hover:bg-muted"
        >
          Manage
        </Link>
        <form action={deleteBaseAction}>
          <input type="hidden" name="base_id" value={base.id} />
          <button
            type="submit"
            className="rounded-md border border-destructive/30 px-3 py-1 text-xs text-destructive hover:bg-destructive/10"
            onClick={(e) => {
              if (!confirm("Delete this knowledge base and all its documents?")) e.preventDefault();
            }}
          >
            Delete
          </button>
        </form>
      </div>
    </div>
  );
}
