import crypto from "crypto";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { createAdminClient } from "@/lib/services/supabase";
import { acceptInviteAction } from "@/app/settings/organization/actions";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

interface Props {
  params: Promise<{ token: string }>;
}

export default async function InvitePage({ params }: Props) {
  const { token } = await params;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  const admin = createAdminClient();
  const { data: invite } = await admin
    .from("org_invitations")
    .select("id, org_id, email, role, expires_at, accepted_at, organizations(name)")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  // Invalid or expired token
  if (!invite) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Card className="p-8 max-w-md text-center space-y-4">
          <h1 className="text-[18px] font-semibold">Invalid invitation</h1>
          <p className="text-[13px] text-muted-foreground">
            This invite link is invalid, expired, or has already been used.
          </p>
          <a href="/login" className="text-primary text-[13px] hover:underline">
            Back to login →
          </a>
        </Card>
      </div>
    );
  }

  if (invite.accepted_at) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Card className="p-8 max-w-md text-center space-y-4">
          <h1 className="text-[18px] font-semibold">Already accepted</h1>
          <p className="text-[13px] text-muted-foreground">This invitation has already been accepted.</p>
          <a href="/settings/organization" className="text-primary text-[13px] hover:underline">
            Go to organization →
          </a>
        </Card>
      </div>
    );
  }

  const orgName = (invite.organizations as unknown as { name: string } | null)?.name ?? "Unknown";

  // Check auth
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    // Redirect to signup/login, preserving the invite URL as the `next` param
    const loginUrl = new URL("/login", process.env.NEXT_PUBLIC_APP_URL);
    loginUrl.searchParams.set("next", `/invite/${token}`);
    redirect(loginUrl.toString());
  }

  const isExpired = new Date(invite.expires_at) < new Date();

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <Card className="p-8 max-w-md space-y-6">
        <div className="space-y-1">
          <h1 className="text-[20px] font-semibold">You&apos;re invited</h1>
          <p className="text-[13px] text-muted-foreground">
            Join <strong>{orgName}</strong> as a <strong>{invite.role}</strong>.
          </p>
        </div>

        {isExpired ? (
          <p className="text-[13px] text-bad">
            This invitation expired on {new Date(invite.expires_at).toLocaleDateString()}.
            Ask the org admin to send a new one.
          </p>
        ) : (
          <form action={acceptInviteAction as unknown as (fd: FormData) => void}>
            <input type="hidden" name="token" value={token} />
            <Button type="submit" className="w-full">
              Accept invitation
            </Button>
          </form>
        )}

        <p className="text-[11px] text-muted-foreground">
          Signed in as {user.email}. Not you?{" "}
          <a href="/api/auth/signout" className="text-primary hover:underline">
            Sign out
          </a>
        </p>
      </Card>
    </div>
  );
}
