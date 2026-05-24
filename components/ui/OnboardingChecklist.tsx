"use client";

import { useState, ReactNode } from "react";
import { cn } from "./cn";

export interface ChecklistStep {
  id: string;
  label: string;
  description?: string;
  done: boolean;
  cta?: ReactNode;
}

interface OnboardingChecklistProps {
  title?: string;
  steps: ChecklistStep[];
  className?: string;
}

export function OnboardingChecklist({
  title = "Get started",
  steps,
  className,
}: OnboardingChecklistProps) {
  const [collapsed, setCollapsed] = useState(false);
  const doneCount = steps.filter((s) => s.done).length;
  const pct = Math.round((doneCount / steps.length) * 100);

  if (doneCount === steps.length) return null;

  return (
    <div
      className={cn(
        "bg-accent-soft border border-primary/20 rounded-xl overflow-hidden",
        className,
      )}
    >
      {/* Header */}
      <button
        type="button"
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-primary/5 transition-colors"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
      >
        <div className="flex items-center gap-3">
          <div className="relative w-8 h-8">
            <svg width="32" height="32" viewBox="0 0 32 32" aria-hidden="true">
              <circle cx="16" cy="16" r="13" fill="none" stroke="hsl(var(--primary))" strokeOpacity=".15" strokeWidth="2.5" />
              <circle
                cx="16" cy="16" r="13"
                fill="none" stroke="hsl(var(--primary))" strokeWidth="2.5"
                strokeDasharray={`${(pct / 100) * 81.68} 81.68`}
                strokeLinecap="round"
                style={{ transform: "rotate(-90deg)", transformOrigin: "center" }}
              />
            </svg>
            <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-primary">
              {pct}%
            </span>
          </div>
          <div className="text-left">
            <p className="text-xs font-semibold text-foreground">{title}</p>
            <p className="text-[11px] text-muted-foreground">{doneCount}/{steps.length} complete</p>
          </div>
        </div>
        <svg
          width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"
          className={cn("text-muted-foreground transition-transform", collapsed ? "rotate-180" : "")}
          aria-hidden="true"
        >
          <polyline points="2 5 7 10 12 5" />
        </svg>
      </button>

      {/* Steps */}
      {!collapsed && (
        <div className="border-t border-primary/10">
          {steps.map((step) => (
            <div
              key={step.id}
              className={cn(
                "flex items-start gap-3 px-4 py-3 border-b border-primary/5 last:border-0",
                step.done && "opacity-60",
              )}
            >
              <div className={cn(
                "mt-0.5 w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center",
                step.done
                  ? "bg-primary border-primary"
                  : "border-primary/30",
              )}>
                {step.done && (
                  <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="white" strokeWidth="1.5" aria-hidden="true">
                    <polyline points="1 4 3.5 6.5 7 2" />
                  </svg>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[12px] font-medium text-foreground">{step.label}</p>
                {step.description && (
                  <p className="text-[11px] text-muted-foreground mt-0.5">{step.description}</p>
                )}
                {!step.done && step.cta && <div className="mt-1.5">{step.cta}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
