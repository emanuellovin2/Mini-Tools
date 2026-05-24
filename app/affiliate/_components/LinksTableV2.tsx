"use client";

import { useState } from "react";
import { DenseTable, DenseRow, DenseCell } from "@/components/ui/DenseTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge } from "@/components/ui/Badge";
import LinkShareDrawer from "./LinkShareDrawer";
import type { AffiliateFunnel } from "@/lib/services/affiliate";

type Link = {
  id: string;
  code: string;
  app_id: string | null;
  created_at: string;
};

function convRate(funnel: AffiliateFunnel | undefined) {
  if (!funnel || funnel.total_attributed === 0) return "—";
  // Use active_30d as a proxy for "sticky conversions"
  const rate = (funnel.active_30d / funnel.total_attributed) * 100;
  return rate.toFixed(1) + "%";
}

function freshnessVariant(createdAt: string): "ok" | "warn" | "bad" {
  const days = (Date.now() - new Date(createdAt).getTime()) / 86_400_000;
  // Use creation date as proxy (in absence of last_sale_at tracking)
  if (days < 30) return "ok";
  if (days < 90) return "warn";
  return "bad";
}

export default function LinksTableV2({
  links,
  appUrl,
  appNames,
  funnelByCode,
}: {
  links: Link[];
  appUrl: string;
  appNames: Record<string, string>;
  funnelByCode: Record<string, AffiliateFunnel>;
}) {
  const [selected, setSelected] = useState<Link | null>(null);

  if (links.length === 0) {
    return (
      <EmptyState
        icon={<span>🔗</span>}
        title="No links yet"
        body="Generate your first referral link to start promoting apps."
        cta={<span className="text-[12px] text-muted-foreground">Use the generate form above.</span>}
      />
    );
  }

  return (
    <>
      <DenseTable cols={["Code", "App", "Active subs", "Sticky 30d", "Created"]}>
        {links.map((link) => {
          const funnel = funnelByCode[link.code];
          const appName = link.app_id ? (appNames[link.app_id] ?? link.app_id.slice(0, 8)) : "Generic";
          const fv = freshnessVariant(link.created_at);

          return (
            <DenseRow key={link.id} cols={5} onClick={() => setSelected(link)}>
              <DenseCell>
                <span className="font-mono text-[12px] text-primary">{link.code}</span>
              </DenseCell>
              <DenseCell>{appName}</DenseCell>
              <DenseCell align="right">{funnel?.currently_active ?? 0}</DenseCell>
              <DenseCell align="right">{convRate(funnel)}</DenseCell>
              <DenseCell>
                <Badge variant={fv}>
                  {new Date(link.created_at).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  })}
                </Badge>
              </DenseCell>
            </DenseRow>
          );
        })}
      </DenseTable>

      {selected && (
        <LinkShareDrawer
          link={selected}
          appUrl={appUrl}
          appName={
            selected.app_id
              ? (appNames[selected.app_id] ?? "App")
              : "the platform"
          }
          funnel={funnelByCode[selected.code] ?? null}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}
