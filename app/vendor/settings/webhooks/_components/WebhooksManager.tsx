"use client";

import { useState, useTransition } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { EmptyState } from "@/components/ui/EmptyState";
import { Drawer } from "@/components/ui/Drawer";
import { DenseTable, DenseRow, DenseCell } from "@/components/ui/DenseTable";
import { V1_EVENTS, type VendorWebhook } from "@/lib/services/vendor-webhooks";

interface Props { initialWebhooks: VendorWebhook[] }

export default function WebhooksManager({ initialWebhooks }: Props) {
  const [webhooks, setWebhooks] = useState(initialWebhooks);
  const [, startTransition] = useTransition();
  const [newKey, setNewKey] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>([...V1_EVENTS]);
  const [error, setError] = useState<string | null>(null);
  const [drawerHook, setDrawerHook] = useState<VendorWebhook | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; status?: number; error?: string } | null>(null);
  const [deliveries, setDeliveries] = useState<{id: string; event_type: string; status_code: number | null; delivered_at: string | null}[]>([]);

  function toggleEvent(e: string) {
    setEvents((prev) =>
      prev.includes(e) ? prev.filter((x) => x !== e) : [...prev, e]
    );
  }

  function handleCreate() {
    if (!url.startsWith("https://")) { setError("URL must start with https://"); return; }
    if (events.length === 0) { setError("Select at least one event"); return; }
    setError(null);
    startTransition(async () => {
      const res = await fetch("/api/vendor/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, events }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error?.formErrors?.[0] ?? data.error ?? "Failed"); return; }
      setWebhooks((w) => [data.webhook, ...w]);
      setNewKey(data.signingSecret);
      setUrl("");
      setEvents([...V1_EVENTS]);
    });
  }

  function handleDelete(id: string) {
    startTransition(async () => {
      await fetch(`/api/vendor/webhooks/${id}`, { method: "DELETE" });
      setWebhooks((w) => w.filter((x) => x.id !== id));
      if (drawerHook?.id === id) setDrawerHook(null);
    });
  }

  function handleToggle(hook: VendorWebhook) {
    startTransition(async () => {
      await fetch(`/api/vendor/webhooks/${hook.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !hook.enabled }),
      });
      setWebhooks((w) =>
        w.map((x) => x.id === hook.id ? { ...x, enabled: !x.enabled } : x)
      );
    });
  }

  async function handleOpenDrawer(hook: VendorWebhook) {
    setDrawerHook(hook);
    setTestResult(null);
    const res = await fetch(`/api/vendor/webhooks/${hook.id}/deliveries`).catch(() => null);
    if (res?.ok) {
      const d = await res.json();
      setDeliveries(d ?? []);
    }
  }

  async function handleTest(hookId: string) {
    setTestResult(null);
    const res = await fetch(`/api/vendor/webhooks/${hookId}/test`, { method: "POST" });
    const data = await res.json();
    setTestResult(data);
  }

  async function handleRotate(hookId: string) {
    const res = await fetch(`/api/vendor/webhooks/${hookId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rotate_secret: true }),
    });
    const data = await res.json();
    if (data.signingSecret) setNewKey(data.signingSecret);
  }

  return (
    <div className="space-y-6">
      {/* New secret banner */}
      {newKey && (
        <div className="rounded-xl border border-ok/30 bg-ok/5 p-4 space-y-2">
          <p className="text-[12px] font-semibold text-ok">Signing secret — copy it now, it won&apos;t be shown again.</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded-md border border-border bg-surface px-3 py-2 text-[11px] font-mono break-all">{newKey}</code>
            <Button size="xs" variant="outline" onClick={() => navigator.clipboard.writeText(newKey)}>Copy</Button>
          </div>
          <Button size="xs" variant="outline" onClick={() => setNewKey(null)}>Dismiss</Button>
        </div>
      )}

      {/* Create form */}
      <Card className="p-5 space-y-4">
        <h3 className="text-sm font-semibold text-foreground">Add endpoint</h3>
        <div>
          <Label htmlFor="wh-url">HTTPS URL</Label>
          <Input
            id="wh-url"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/webhooks/platform"
            className="mt-1"
          />
        </div>
        <div className="space-y-2">
          <Label>Events to subscribe</Label>
          <div className="flex flex-wrap gap-2">
            {V1_EVENTS.map((ev) => (
              <button
                key={ev}
                type="button"
                onClick={() => toggleEvent(ev)}
                className={`px-2 py-1 rounded-md border text-[11px] transition-colors ${events.includes(ev) ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary/40"}`}
              >
                {ev}
              </button>
            ))}
          </div>
        </div>
        {error && <p className="text-[11px] text-bad">{error}</p>}
        <Button size="sm" onClick={handleCreate}>Add endpoint</Button>
      </Card>

      {/* List */}
      {webhooks.length === 0 ? (
        <EmptyState title="No endpoints" body="Add an HTTPS endpoint above to start receiving events." />
      ) : (
        <Card className="overflow-hidden">
          <DenseTable cols={["URL", "Status", "Failures", ""]} className="text-[12px]">
            {webhooks.map((h) => (
              <DenseRow key={h.id}>
                <DenseCell>
                  <button
                    type="button"
                    className="text-left text-primary hover:underline text-[12px] truncate max-w-xs"
                    onClick={() => handleOpenDrawer(h)}
                  >
                    {h.url}
                  </button>
                  {!h.enabled && h.disabled_reason && (
                    <p className="text-[10px] text-bad mt-0.5">{h.disabled_reason}</p>
                  )}
                </DenseCell>
                <DenseCell>
                  <Badge variant={h.enabled ? "ok" : "bad"}>
                    {h.enabled ? "active" : "disabled"}
                  </Badge>
                </DenseCell>
                <DenseCell>
                  <span className="text-[11px] text-muted-2">
                    {h.events.length} event{h.events.length !== 1 ? "s" : ""}
                  </span>
                </DenseCell>
                <DenseCell>
                  <div className="flex gap-1">
                    <Button size="xs" variant="outline" onClick={() => handleToggle(h)}>
                      {h.enabled ? "Disable" : "Enable"}
                    </Button>
                    <Button size="xs" variant="outline" className="text-bad border-bad/30"
                      onClick={() => handleDelete(h.id)}>
                      Delete
                    </Button>
                  </div>
                </DenseCell>
              </DenseRow>
            ))}
          </DenseTable>
        </Card>
      )}

      {/* Drawer: delivery log + test */}
      <Drawer open={!!drawerHook} title={drawerHook ? `Endpoint: ${drawerHook.url.slice(0, 50)}…` : ""} onClose={() => setDrawerHook(null)}>
        {drawerHook && (
          <div className="space-y-4 p-4">
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => handleTest(drawerHook.id)}>
                Send test event
              </Button>
              <Button size="sm" variant="outline" onClick={() => handleRotate(drawerHook.id)}>
                Rotate secret
              </Button>
            </div>
            {testResult && (
              <div className={`rounded-lg border px-4 py-3 text-[12px] ${testResult.ok ? "border-ok/30 bg-ok/5 text-ok" : "border-bad/30 bg-bad/5 text-bad"}`}>
                {testResult.ok ? `Test delivered (HTTP ${testResult.status})` : `Failed: ${testResult.error ?? `HTTP ${testResult.status}`}`}
              </div>
            )}
            <div>
              <h4 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">Recent deliveries</h4>
              {deliveries.length === 0 ? (
                <p className="text-[12px] text-muted-foreground">No deliveries yet.</p>
              ) : (
                <div className="space-y-1">
                  {deliveries.slice(0, 20).map((d) => (
                    <div key={d.id} className="flex items-center gap-3 text-[11px] py-1 border-b border-border-soft">
                      <Badge variant={d.delivered_at ? "ok" : "bad"} className="shrink-0">
                        {d.status_code ?? "–"}
                      </Badge>
                      <span className="text-muted-foreground">{d.event_type}</span>
                      <span className="ml-auto text-muted-2">
                        {d.delivered_at ? new Date(d.delivered_at).toLocaleTimeString() : "failed"}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}
