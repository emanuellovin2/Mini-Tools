"use client";

import { useState, useTransition } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { DenseTable, DenseRow, DenseCell } from "@/components/ui/DenseTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { API_KEY_SCOPES, type ApiKey } from "@/lib/services/api-keys";

interface Props { initialKeys: ApiKey[] }

export default function ApiKeysManager({ initialKeys }: Props) {
  const [keys, setKeys] = useState(initialKeys);
  const [mode, setMode] = useState<"test" | "live">("test");
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["read:analytics"]);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const testKeys = keys.filter((k) => k.mode === "test" && !k.revoked_at);
  const liveKeys = keys.filter((k) => k.mode === "live" && !k.revoked_at);

  function toggleScope(s: string) {
    setScopes((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]
    );
  }

  function handleCreate() {
    if (!name.trim()) { setError("Name is required"); return; }
    if (scopes.length === 0) { setError("Select at least one scope"); return; }
    setError(null);
    startTransition(async () => {
      const res = await fetch("/api/settings/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), mode, scopes }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Failed"); return; }
      setKeys((k) => [data.key, ...k]);
      setNewKey(data.plaintext);
      setName("");
      setScopes(["read:analytics"]);
    });
  }

  function handleRevoke(id: string) {
    startTransition(async () => {
      await fetch(`/api/settings/api-keys/${id}`, { method: "DELETE" });
      setKeys((k) => k.map((x) => x.id === id ? { ...x, revoked_at: new Date().toISOString() } : x));
    });
  }

  return (
    <div className="space-y-6">
      {/* New key toast */}
      {newKey && (
        <div className="rounded-xl border border-ok/30 bg-ok/5 p-4 space-y-2">
          <p className="text-[12px] font-semibold text-ok">Key created — copy it now, it won&apos;t be shown again.</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded-md border border-border bg-surface px-3 py-2 text-[11px] font-mono break-all">
              {newKey}
            </code>
            <Button size="xs" variant="outline" onClick={() => { navigator.clipboard.writeText(newKey); }}>
              Copy
            </Button>
          </div>
          <Button size="xs" variant="outline" onClick={() => setNewKey(null)}>Dismiss</Button>
        </div>
      )}

      {/* Create form */}
      <Card className="p-5 space-y-4">
        <h3 className="text-sm font-semibold text-foreground">Create API key</h3>

        {/* Mode tabs */}
        <div className="flex gap-1 p-0.5 rounded-lg bg-muted w-fit">
          {(["test", "live"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`px-3 py-1 rounded-md text-[12px] font-medium transition-colors ${mode === m ? "bg-surface text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
            >
              {m === "test" ? "Test" : "Live"}
            </button>
          ))}
        </div>

        <div className="space-y-1">
          <Label htmlFor="key-name">Key name</Label>
          <Input
            id="key-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My integration"
            className="mt-1 max-w-xs"
          />
        </div>

        <div className="space-y-2">
          <Label>Scopes</Label>
          <div className="flex flex-wrap gap-2">
            {API_KEY_SCOPES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => toggleScope(s)}
                className={`px-2 py-1 rounded-md border text-[11px] transition-colors ${scopes.includes(s) ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary/40"}`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        {error && <p className="text-[11px] text-bad">{error}</p>}
        <Button size="sm" onClick={handleCreate}>Create key</Button>
      </Card>

      {/* Test keys */}
      <KeyList label="Test keys" keys={testKeys} onRevoke={handleRevoke} />
      {/* Live keys */}
      <KeyList label="Live keys" keys={liveKeys} onRevoke={handleRevoke} />
    </div>
  );
}

function KeyList({ label, keys, onRevoke }: { label: string; keys: ApiKey[]; onRevoke: (id: string) => void }) {
  return (
    <div className="space-y-2">
      <h4 className="text-[12px] font-semibold text-muted-foreground uppercase tracking-wide">{label}</h4>
      {keys.length === 0 ? (
        <EmptyState title={`No ${label.toLowerCase()}`} body="Create a key above to get started." />
      ) : (
        <Card className="overflow-hidden">
          <DenseTable cols={["Key", "Name", "Scopes", ""]} className="text-[12px]">
            {keys.map((k) => (
              <DenseRow key={k.id}>
                <DenseCell>
                  <code className="font-mono text-[11px] text-muted-foreground">{k.prefix}…</code>
                </DenseCell>
                <DenseCell>
                  <span className="text-foreground font-medium">{k.name}</span>
                  <div className="flex flex-wrap gap-1 mt-0.5">
                    {k.scopes.map((s) => (
                      <Badge key={s} variant="outline" className="text-[9px]">{s}</Badge>
                    ))}
                  </div>
                </DenseCell>
                <DenseCell>
                  <span className="text-muted-2 text-[11px]">
                    {k.last_used_at
                      ? `Used ${new Date(k.last_used_at).toLocaleDateString()}`
                      : "Never used"}
                  </span>
                </DenseCell>
                <DenseCell>
                  <Button size="xs" variant="outline" className="text-bad border-bad/30"
                    onClick={() => onRevoke(k.id)}>
                    Revoke
                  </Button>
                </DenseCell>
              </DenseRow>
            ))}
          </DenseTable>
        </Card>
      )}
    </div>
  );
}
