import { describe, it, expect } from "vitest";
import { isValidRole, ROLE_DASHBOARDS } from "../roles";

describe("isValidRole", () => {
  it("returns true for valid roles", () => {
    expect(isValidRole("admin")).toBe(true);
    expect(isValidRole("vendor")).toBe(true);
    expect(isValidRole("buyer")).toBe(true);
    expect(isValidRole("affiliate")).toBe(true);
    expect(isValidRole("reseller")).toBe(true);
  });

  it("returns false for invalid roles", () => {
    expect(isValidRole("superuser")).toBe(false);
    expect(isValidRole("")).toBe(false);
    expect(isValidRole("ADMIN")).toBe(false);
  });
});

describe("ROLE_DASHBOARDS", () => {
  it("maps every valid role to a dashboard path", () => {
    const roles = ["admin", "vendor", "buyer", "affiliate", "reseller"] as const;
    roles.forEach((role) => {
      expect(ROLE_DASHBOARDS[role]).toMatch(/^\//);
    });
  });
});
