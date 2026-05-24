"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { useToast } from "@/components/ui/Toast";
import { Card } from "@/components/ui/Card";
import {
  updateDisplayNameAction,
  updateEmailAction,
  updatePasswordAction,
  enrollTotpAction,
  requestDataExportAction,
} from "../actions";

interface Props {
  userId: string;
  email: string;
  displayName: string;
  role: string;
}

export default function AccountSettingsForm({ userId, email, displayName, role }: Props) {
  const [, startTransition] = useTransition();
  const addToast = useToast();

  const [name, setName] = useState(displayName);
  const [newEmail, setNewEmail] = useState("");
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [totpQr, setTotpQr] = useState<string | null>(null);

  function notify(message: string, type: "ok" | "bad" = "ok") {
    addToast(message, { type });
  }

  async function handleName(e: React.FormEvent) {
    e.preventDefault();
    const fd = new FormData(); fd.set("name", name);
    startTransition(async () => {
      const res = await updateDisplayNameAction(fd);
      notify(res.error ?? "Display name updated", res.error ? "bad" : "ok");
    });
  }

  async function handleEmail(e: React.FormEvent) {
    e.preventDefault();
    const fd = new FormData(); fd.set("email", newEmail);
    startTransition(async () => {
      const res = await updateEmailAction(fd);
      notify(res.error ?? "Verification email sent", res.error ? "bad" : "ok");
      if (!res.error) setNewEmail("");
    });
  }

  async function handlePassword(e: React.FormEvent) {
    e.preventDefault();
    const fd = new FormData(); fd.set("current", currentPw); fd.set("new", newPw);
    startTransition(async () => {
      const res = await updatePasswordAction(fd);
      notify(res.error ?? "Password updated", res.error ? "bad" : "ok");
      if (!res.error) { setCurrentPw(""); setNewPw(""); }
    });
  }

  async function handleEnrollTotp() {
    startTransition(async () => {
      const res = await enrollTotpAction();
      if (res.error) { notify(res.error, "bad"); return; }
      setTotpQr(res.qrCode ?? null);
      notify("Scan the QR code with your authenticator app, then verify a code to complete setup.");
    });
  }

  async function handleExport() {
    startTransition(async () => {
      const scope = role === "vendor" ? "vendor.subscriptions"
        : role === "affiliate" ? "affiliate.links"
        : role === "reseller" ? "reseller.offers"
        : "buyer.subscriptions";
      const res = await requestDataExportAction(scope);
      notify(res.error ?? "Export email will be sent to your address", res.error ? "bad" : "ok");
    });
  }

  return (
    <div className="space-y-6">
      {/* Display name */}
      <Card className="p-5 space-y-3">
        <h3 className="text-sm font-semibold text-foreground">Profile</h3>
        <form onSubmit={handleName} className="space-y-3">
          <div>
            <Label htmlFor="display-name">Display name</Label>
            <Input
              id="display-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1"
            />
          </div>
          <Button type="submit" size="sm">Save name</Button>
        </form>
      </Card>

      {/* Email */}
      <Card className="p-5 space-y-3">
        <h3 className="text-sm font-semibold text-foreground">Email</h3>
        <p className="text-[12px] text-muted-foreground">Current: <span className="font-mono">{email}</span></p>
        <form onSubmit={handleEmail} className="space-y-3">
          <div>
            <Label htmlFor="new-email">New email</Label>
            <Input
              id="new-email"
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="new@example.com"
              className="mt-1"
            />
          </div>
          <Button type="submit" size="sm">Send verification</Button>
        </form>
      </Card>

      {/* Password */}
      <Card className="p-5 space-y-3">
        <h3 className="text-sm font-semibold text-foreground">Password</h3>
        <form onSubmit={handlePassword} className="space-y-3">
          <div>
            <Label htmlFor="current-pw">Current password</Label>
            <Input
              id="current-pw"
              type="password"
              value={currentPw}
              onChange={(e) => setCurrentPw(e.target.value)}
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="new-pw">New password</Label>
            <Input
              id="new-pw"
              type="password"
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
              className="mt-1"
            />
          </div>
          <Button type="submit" size="sm">Update password</Button>
        </form>
      </Card>

      {/* 2FA */}
      <Card className="p-5 space-y-3">
        <h3 className="text-sm font-semibold text-foreground">Two-factor authentication (TOTP)</h3>
        <p className="text-[12px] text-muted-foreground">
          Use an authenticator app (Google Authenticator, Authy) for a second factor on login.
        </p>
        {totpQr ? (
          <div className="space-y-3">
            <img src={totpQr} alt="TOTP QR code" className="w-40 h-40 border rounded" />
            <p className="text-[11px] text-muted-foreground">
              Scan with your authenticator app. After scanning, your next login will require a TOTP code.
            </p>
          </div>
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={handleEnrollTotp}>
            Enable 2FA
          </Button>
        )}
      </Card>

      {/* Data export */}
      <Card className="p-5 space-y-3">
        <h3 className="text-sm font-semibold text-foreground">Data export (GDPR)</h3>
        <p className="text-[12px] text-muted-foreground">
          Request a CSV of your data. We&apos;ll email it to <span className="font-mono">{email}</span>.
        </p>
        <Button type="button" variant="outline" size="sm" onClick={handleExport}>
          Request export
        </Button>
      </Card>

      {/* suppress unused-vars for userId */}
      <input type="hidden" value={userId} />
    </div>
  );
}
