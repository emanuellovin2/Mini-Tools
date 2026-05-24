"use client";

import { useEffect, useState, useTransition } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { DenseTable, DenseRow, DenseCell } from "@/components/ui/DenseTable";
import { revokeSessionAction } from "../actions";

interface Session {
  id: string;
  created_at: string;
  updated_at: string;
  user_agent: string | null;
  ip: string | null;
}

export default function SessionsPanel() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  useEffect(() => {
    fetch("/api/settings/account/sessions")
      .then((r) => r.json())
      .then((d) => { setSessions(d.sessions ?? []); setCurrentId(d.currentId ?? null); })
      .catch(() => {});
  }, []);

  function revoke(sessionId: string) {
    startTransition(async () => {
      const fd = new FormData(); fd.set("sessionId", sessionId);
      await revokeSessionAction(fd);
      setSessions((s) => s.filter((x) => x.id !== sessionId));
    });
  }

  return (
    <Card className="p-5 space-y-3">
      <h3 className="text-sm font-semibold text-foreground">Active sessions</h3>
      {sessions.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">No other active sessions.</p>
      ) : (
        <DenseTable cols={["Device", "Last seen", ""]} className="text-[12px]">
          {sessions.map((s) => (
            <DenseRow key={s.id}>
              <DenseCell>
                <span className="text-muted-foreground">{s.user_agent?.slice(0, 40) ?? "Unknown"}</span>
                {s.id === currentId && (
                  <Badge variant="ok" className="ml-2 text-[10px]">current</Badge>
                )}
              </DenseCell>
              <DenseCell>
                <span className="text-muted-2 text-[11px]">
                  {new Date(s.updated_at).toLocaleDateString()}
                </span>
              </DenseCell>
              <DenseCell>
                {s.id !== currentId && (
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => revoke(s.id)}
                  >
                    Revoke
                  </Button>
                )}
              </DenseCell>
            </DenseRow>
          ))}
        </DenseTable>
      )}
    </Card>
  );
}
