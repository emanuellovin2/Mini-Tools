"use client";

import { useState } from "react";
import {
  NotificationBell,
  type Notification,
} from "@/components/ui/NotificationBell";

interface Props {
  initialNotifications: Notification[];
}

export default function NotificationBellClient({ initialNotifications }: Props) {
  const [notifications, setNotifications] = useState(initialNotifications);

  async function handleMarkAllRead() {
    await fetch("/api/notifications/mark-read", { method: "POST", body: "{}" });
    setNotifications((n) => n.map((x) => ({ ...x, read: true })));
  }

  return (
    <NotificationBell
      notifications={notifications}
      onMarkAllRead={handleMarkAllRead}
    />
  );
}
