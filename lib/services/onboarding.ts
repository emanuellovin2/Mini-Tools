/**
 * Onboarding checklist helpers.
 *
 * Progress is stored in `profiles.onboarding_state jsonb`.
 * Each role has a fixed set of step IDs. A step is "done" when:
 *   1. Its ID is present with `true` in onboarding_state, OR
 *   2. The corresponding condition can be inferred from the user's profile data.
 */
import { createAdminClient } from "@/lib/services/supabase";

export type OnboardingRole = "vendor" | "affiliate" | "reseller";

export interface OnboardingStep {
  id: string;
  label: string;
  description: string;
  href: string;
  done: boolean;
}

export type OnboardingState = Record<string, boolean>;

export function buildVendorSteps(
  state: OnboardingState,
  flags: {
    hasStripe: boolean;
    hasApp: boolean;
    hasScreenshots: boolean;
    hasMinPrice: boolean;
    hasResellerness: boolean;
    hasSubmitted: boolean;
  }
): OnboardingStep[] {
  return [
    {
      id: "connect_stripe",
      label: "Connect Stripe",
      description: "Required to receive payouts.",
      href: "/api/stripe/connect",
      done: flags.hasStripe || !!state.connect_stripe,
    },
    {
      id: "create_app",
      label: "Create your first app",
      description: "Add name, description, and at least 3 screenshots.",
      href: "/vendor",
      done: flags.hasApp || !!state.create_app,
    },
    {
      id: "set_price",
      label: "Set price & floor",
      description: "Set subscription price and optional reseller floor.",
      href: "/vendor",
      done: (flags.hasApp && flags.hasMinPrice) || !!state.set_price,
    },
    {
      id: "choose_openness",
      label: "Choose reseller openness",
      description: "Control who can resell your app.",
      href: "/vendor",
      done: flags.hasResellerness || !!state.choose_openness,
    },
    {
      id: "submit_review",
      label: "Submit for review",
      description: "Admin reviews before going live.",
      href: "/vendor",
      done: flags.hasSubmitted || !!state.submit_review,
    },
  ];
}

export function buildAffiliateSteps(
  state: OnboardingState,
  flags: { hasStripe: boolean; hasSlug: boolean; hasLink: boolean }
): OnboardingStep[] {
  return [
    {
      id: "connect_stripe",
      label: "Connect Stripe",
      description: "Required to receive commission payouts.",
      href: "/api/affiliate/onboard",
      done: flags.hasStripe || !!state.connect_stripe,
    },
    {
      id: "set_profile",
      label: "Set public profile",
      description: "Add a display name and public slug.",
      href: "/affiliate",
      done: flags.hasSlug || !!state.set_profile,
    },
    {
      id: "generate_link",
      label: "Generate your first link",
      description: "Browse apps and create a referral link.",
      href: "/affiliate",
      done: flags.hasLink || !!state.generate_link,
    },
    {
      id: "share_link",
      label: "Share your link",
      description: "Use the share kit to post your link.",
      href: "/affiliate",
      done: flags.hasLink || !!state.share_link,
    },
  ];
}

export function buildResellerSteps(
  state: OnboardingState,
  flags: {
    hasSubscription: boolean;
    hasStripe: boolean;
    hasBrand: boolean;
    hasOffer: boolean;
  }
): OnboardingStep[] {
  return [
    {
      id: "subscribe_plan",
      label: "Subscribe to platform plan",
      description: "$19/mo — 30-day free trial.",
      href: "/reseller/setup",
      done: flags.hasSubscription || !!state.subscribe_plan,
    },
    {
      id: "connect_stripe",
      label: "Connect Stripe",
      description: "Required to receive reseller payouts.",
      href: "/api/reseller/connect",
      done: flags.hasStripe || !!state.connect_stripe,
    },
    {
      id: "set_brand",
      label: "Set mini-brand",
      description: "Logo, color, and display name for your storefront.",
      href: "/reseller/brand",
      done: flags.hasBrand || !!state.set_brand,
    },
    {
      id: "create_offer",
      label: "Create your first offer",
      description: "Browse apps and set a price for your storefront.",
      href: "/reseller/offers",
      done: flags.hasOffer || !!state.create_offer,
    },
    {
      id: "share_storefront",
      label: "Share your storefront URL",
      description: "Send buyers to your branded storefront.",
      href: "/reseller",
      done: flags.hasOffer || !!state.share_storefront,
    },
  ];
}

export async function getOnboardingState(userId: string): Promise<OnboardingState> {
  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (admin as any)
    .from("profiles")
    .select("onboarding_state")
    .eq("id", userId)
    .single();
  return (data?.onboarding_state as OnboardingState) ?? {};
}

export async function markOnboardingStep(userId: string, stepId: string): Promise<void> {
  const admin = createAdminClient();
  const current = await getOnboardingState(userId);
  const updated = { ...current, [stepId]: true };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any)
    .from("profiles")
    .update({ onboarding_state: updated })
    .eq("id", userId);
}
