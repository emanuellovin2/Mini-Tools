"use client";

import { useState, useRef, ReactNode, useEffect } from "react";
import { cn } from "./cn";

interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
}

export function Tooltip({ content, children, side = "top", className }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function show() { timer.current = setTimeout(() => setVisible(true), 120); }
  function hide() { clearTimeout(timer.current); setVisible(false); }

  useEffect(() => () => clearTimeout(timer.current), []);

  const posClass = {
    top: "bottom-full left-1/2 -translate-x-1/2 mb-1.5",
    bottom: "top-full left-1/2 -translate-x-1/2 mt-1.5",
    left: "right-full top-1/2 -translate-y-1/2 mr-1.5",
    right: "left-full top-1/2 -translate-y-1/2 ml-1.5",
  }[side];

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {visible && (
        <span
          role="tooltip"
          className={cn(
            "absolute z-50 max-w-[200px] rounded-md px-2 py-1.5 text-[11px] leading-snug",
            "bg-foreground text-background shadow-md whitespace-normal pointer-events-none",
            posClass,
            className,
          )}
        >
          {content}
        </span>
      )}
    </span>
  );
}
