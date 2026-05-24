import type { OrgRole } from "@/lib/services/org";

type Action =
  | "manage_billing"
  | "manage_members"
  | "create_product"
  | "manage_payouts"
  | "operate"
  | "view";

const PERMISSIONS: Record<Action, OrgRole[]> = {
  manage_billing:  ["owner"],
  manage_members:  ["owner", "admin"],
  create_product:  ["owner", "admin"],
  manage_payouts:  ["owner"],
  operate:         ["owner", "admin", "member"],
  view:            ["owner", "admin", "member"],
};

/** Pure: can a member with `role` perform `action`? */
export function can(role: OrgRole, action: Action): boolean {
  return PERMISSIONS[action].includes(role);
}
