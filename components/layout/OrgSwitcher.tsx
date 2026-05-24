"use client";

import { useTransition } from "react";
import { switchOrgAction } from "@/app/settings/organization/actions";

interface OrgOption {
  id: string;
  name: string;
  type: "personal" | "team";
  role: string;
}

interface OrgSwitcherProps {
  orgs: OrgOption[];
  currentOrgId: string;
}

export function OrgSwitcher({ orgs, currentOrgId }: OrgSwitcherProps) {
  const [pending, startTransition] = useTransition();

  if (orgs.length <= 1) {
    // Single org (most users): just show the name, no dropdown
    const current = orgs[0];
    if (!current) return null;
    return (
      <span className="hidden sm:inline-flex items-center gap-1 text-[12px] text-muted-foreground">
        <OrgIcon type={current.type} />
        {current.name}
      </span>
    );
  }

  const current = orgs.find((o) => o.id === currentOrgId) ?? orgs[0];

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const orgId = e.target.value;
    startTransition(async () => {
      const fd = new FormData();
      fd.append("org_id", orgId);
      await switchOrgAction(fd);
      window.location.reload();
    });
  }

  return (
    <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground cursor-pointer">
      <OrgIcon type={current?.type ?? "personal"} />
      <select
        value={currentOrgId}
        onChange={handleChange}
        disabled={pending}
        className="bg-transparent text-[12px] text-foreground border-none outline-none cursor-pointer"
      >
        {orgs.map((org) => (
          <option key={org.id} value={org.id}>
            {org.name} {org.type === "personal" ? "(Personal)" : `(${org.role})`}
          </option>
        ))}
      </select>
    </label>
  );
}

function OrgIcon({ type }: { type: "personal" | "team" }) {
  return type === "team" ? (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="4" cy="4" r="2" />
      <circle cx="8" cy="4" r="2" />
      <path d="M1 10c0-1.7 1.3-3 3-3h4c1.7 0 3 1.3 3 3" />
    </svg>
  ) : (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="6" cy="4" r="2.5" />
      <path d="M1.5 10.5c0-2.2 2-4 4.5-4s4.5 1.8 4.5 4" />
    </svg>
  );
}
