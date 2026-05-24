import Link from "next/link";
import { OnboardingChecklist } from "./OnboardingChecklist";
import type { OnboardingStep } from "@/lib/services/onboarding";

interface Props {
  steps: OnboardingStep[];
  className?: string;
}

/**
 * Server-renderable wrapper: converts OnboardingStep[] (which carry hrefs)
 * into ChecklistStep[] with Link CTAs and passes them to the client primitive.
 */
export function OnboardingCard({ steps, className }: Props) {
  const checklistSteps = steps.map((s) => ({
    id: s.id,
    label: s.label,
    description: s.description,
    done: s.done,
    cta: !s.done ? (
      <Link
        href={s.href}
        className="text-[11px] text-primary hover:underline"
      >
        Get started →
      </Link>
    ) : undefined,
  }));

  const allDone = steps.every((s) => s.done);
  if (allDone) return null;

  return <OnboardingChecklist steps={checklistSteps} className={className} />;
}
