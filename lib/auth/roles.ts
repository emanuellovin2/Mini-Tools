import type { Database } from "@/types/supabase";

export type UserRole = Database["public"]["Enums"]["user_role"];

export const ROLE_DASHBOARDS: Record<UserRole, string> = {
  admin: "/admin",
  vendor: "/vendor",
  buyer: "/buyer",
  affiliate: "/affiliate",
  reseller: "/reseller",
};

export function isValidRole(role: string): role is UserRole {
  return ["admin", "vendor", "buyer", "affiliate", "reseller"].includes(role);
}
