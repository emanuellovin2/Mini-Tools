"use client";

import { useEffect, useState, useCallback } from "react";
import { Command } from "cmdk";
import { cn } from "./cn";

export interface CommandGroup {
  heading: string;
  items: CommandItem[];
}

export interface CommandItem {
  id: string;
  label: string;
  shortcut?: string;
  onSelect: () => void;
}

interface CommandPaletteProps {
  groups: CommandGroup[];
  placeholder?: string;
}

export function CommandPalette({ groups, placeholder = "Search…" }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);

  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    },
    [],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [handleKey]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[18vh]"
      onClick={() => setOpen(false)}
      aria-label="Command palette backdrop"
    >
      <div
        className={cn(
          "w-full max-w-[520px] mx-4 rounded-xl bg-surface border border-border overflow-hidden",
          "shadow-[var(--shadow-overlay)]",
        )}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <Command className="[&_[cmdk-input-wrapper]]:border-b [&_[cmdk-input-wrapper]]:border-border">
          <Command.Input
            placeholder={placeholder}
            autoFocus
            className={cn(
              "w-full px-4 py-3.5 text-sm bg-transparent outline-none",
              "text-foreground placeholder:text-muted-foreground",
            )}
          />
          <Command.List className="max-h-72 overflow-y-auto py-1.5">
            <Command.Empty className="px-4 py-6 text-center text-[12px] text-muted-foreground">
              No results found
            </Command.Empty>
            {groups.map((group) => (
              <Command.Group
                key={group.heading}
                heading={group.heading}
                className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-muted-foreground"
              >
                {group.items.map((item) => (
                  <Command.Item
                    key={item.id}
                    value={item.label}
                    onSelect={() => { item.onSelect(); setOpen(false); }}
                    className={cn(
                      "flex items-center justify-between mx-1.5 px-2.5 py-2 rounded-md text-sm cursor-pointer",
                      "data-[selected=true]:bg-muted data-[selected=true]:text-foreground",
                      "text-foreground/80 hover:bg-muted/60 transition-colors",
                    )}
                  >
                    <span>{item.label}</span>
                    {item.shortcut && (
                      <kbd className="text-[10px] bg-muted border border-border rounded px-1 py-0.5 text-muted-foreground font-mono">
                        {item.shortcut}
                      </kbd>
                    )}
                  </Command.Item>
                ))}
              </Command.Group>
            ))}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
