import { getUserNotifications } from "@/lib/services/notifications";
import { NotificationBell } from "@/components/ui/NotificationBell";
import NotificationBellClient from "./NotificationBellClient";

/**
 * Server component: fetches the last 20 notifications and passes them to the
 * client-side NotificationBell. The bell re-fetches via the client wrapper
 * when the user marks items read.
 */
export async function NotificationBellConnected() {
  const notifications = await getUserNotifications(20).catch(() => []);

  const mapped = notifications.map((n) => ({
    id: n.id,
    title: n.title,
    body: n.body ?? undefined,
    read: n.read,
    time: new Date(n.created_at).toLocaleDateString(),
    href: n.link ?? undefined,
  }));

  return <NotificationBellClient initialNotifications={mapped} />;
}
