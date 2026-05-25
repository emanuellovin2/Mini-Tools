"use client";

import { useState, useTransition } from "react";
import type { ConnectorDef } from "@/lib/connectors/registry";
import { revokeAccountAction } from "../actions";

interface Account {
  id: string;
  connector_id: string;
  label: string;
  scopes: string[];
  expires_at: string | null;
  external_id: string | null;
  created_at: string;
}

interface Props {
  orgId: string;
  accounts: Account[];
  connectorDefs: ConnectorDef[];
}

export default function ConnectionsList({ orgId, accounts, connectorDefs }: Props) {
  const [localAccounts, setLocalAccounts] = useState(accounts);
  const [isPending, startTransition] = useTransition();
  const [revokingId, setRevokingId] = useState<string | null>(null);

  function handleRevoke(accountId: string) {
    setRevokingId(accountId);
    startTransition(async () => {
      await revokeAccountAction(orgId, accountId);
      setLocalAccounts((prev) => prev.filter((a) => a.id !== accountId));
      setRevokingId(null);
    });
  }

  const connectedIds = new Set(localAccounts.map((a) => a.connector_id));

  return (
    <div className="space-y-6">
      {/* Available connectors */}
      <section>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          Available Connectors
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {connectorDefs.map((def) => (
            <div
              key={def.id}
              className="flex items-center justify-between rounded-lg border border-border p-4"
            >
              <div>
                <p className="font-medium text-sm">{def.name}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {def.auth === "none" ? "No authentication required" : "OAuth 2.0"}
                </p>
              </div>
              {def.auth === "oauth2" ? (
                <a
                  href={`/api/connectors/${def.id}/connect?org_id=${orgId}`}
                  className="text-xs rounded-md bg-primary text-white px-3 py-1.5 hover:opacity-90 transition-opacity"
                >
                  {connectedIds.has(def.id) ? "Add another" : "Connect"}
                </a>
              ) : (
                <span className="text-xs text-muted-foreground italic">
                  Used in workflow steps
                </span>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Connected accounts */}
      {localAccounts.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
            Connected Accounts
          </h2>
          <div className="space-y-2">
            {localAccounts.map((account) => {
              const def = connectorDefs.find((d) => d.id === account.connector_id);
              const expired =
                account.expires_at !== null &&
                new Date(account.expires_at).getTime() < Date.now();

              return (
                <div
                  key={account.id}
                  className="flex items-center justify-between rounded-lg border border-border px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium truncate">
                        {account.label || (def?.name ?? account.connector_id)}
                      </p>
                      {expired && (
                        <span className="text-xs rounded-full bg-yellow-100 text-yellow-800 px-2 py-0.5">
                          Expired
                        </span>
                      )}
                    </div>
                    {account.external_id && (
                      <p className="text-xs text-muted-foreground truncate">
                        {account.external_id}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 ml-4">
                    {expired && def?.auth === "oauth2" && (
                      <a
                        href={`/api/connectors/${account.connector_id}/connect?org_id=${orgId}&label=${encodeURIComponent(account.label)}`}
                        className="text-xs text-primary hover:underline"
                      >
                        Reconnect
                      </a>
                    )}
                    <button
                      onClick={() => handleRevoke(account.id)}
                      disabled={isPending && revokingId === account.id}
                      className="text-xs text-destructive hover:underline disabled:opacity-50"
                    >
                      {revokingId === account.id ? "Revoking…" : "Revoke"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {localAccounts.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No connections yet. Connect a tool above to use it in your workflow steps.
        </p>
      )}
    </div>
  );
}
