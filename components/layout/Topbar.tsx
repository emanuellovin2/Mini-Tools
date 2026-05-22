import { ReactNode } from "react";

interface TopbarProps {
  user: { email: string; role: string };
  sidebarToggle?: ReactNode;
}

export function Topbar({ user, sidebarToggle }: TopbarProps) {
  return (
    <header className="h-14 border-b border-border bg-background flex items-center gap-3 px-4 shrink-0">
      {sidebarToggle}
      <div className="flex-1" />
      <span className="text-xs text-muted-foreground hidden sm:block">{user.email}</span>
      <form action="/api/auth/signout" method="POST">
        <button
          type="submit"
          className="text-xs text-muted-foreground hover:text-destructive transition-colors"
        >
          Sign out
        </button>
      </form>
    </header>
  );
}
