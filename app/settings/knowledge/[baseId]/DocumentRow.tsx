"use client";

import type { KnowledgeDocument } from "@/lib/services/knowledge";
import { deleteDocumentAction } from "../actions";

interface Props {
  doc: KnowledgeDocument;
  baseId: string;
  statusBadge: Record<string, string>;
}

export function DocumentRow({ doc, baseId, statusBadge }: Props) {
  const label = doc.title ?? doc.sourceRef ?? doc.id;
  const badgeCls = statusBadge[doc.status] ?? "bg-gray-100 text-gray-700";

  return (
    <tr className="group">
      <td className="py-2 pr-4 max-w-xs truncate" title={label}>
        {label}
      </td>
      <td className="py-2 pr-4 text-muted-foreground">{doc.sourceType}</td>
      <td className="py-2 pr-4 text-right tabular-nums">{doc.chunkCount}</td>
      <td className="py-2 pr-4 text-right">
        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${badgeCls}`}>
          {doc.status}
        </span>
        {doc.error && (
          <span className="ml-2 text-xs text-destructive" title={doc.error}>⚠</span>
        )}
      </td>
      <td className="py-2 text-right">
        <form action={deleteDocumentAction}>
          <input type="hidden" name="doc_id" value={doc.id} />
          <input type="hidden" name="base_id" value={baseId} />
          <button
            type="submit"
            className="text-xs text-destructive opacity-0 group-hover:opacity-100 hover:underline"
            onClick={(e) => {
              if (!confirm("Delete this document?")) e.preventDefault();
            }}
          >
            Delete
          </button>
        </form>
      </td>
    </tr>
  );
}
