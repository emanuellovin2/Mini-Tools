"use client";

import { useState, useTransition } from "react";
import type { BuyerPaymentMethod } from "@/lib/services/buyer";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { useToast } from "@/components/ui/Toast";
import { setDefaultPaymentMethodAction, detachPaymentMethodAction } from "../actions";

const CARD_BRAND_LABELS: Record<string, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "Amex",
  discover: "Discover",
  jcb: "JCB",
  unionpay: "UnionPay",
  diners: "Diners",
};

export function PaymentMethods({
  methods,
  hasActiveSub,
}: {
  methods: BuyerPaymentMethod[];
  hasActiveSub: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const toast = useToast();

  function setDefault(pmId: string) {
    setPendingId(pmId);
    startTransition(async () => {
      const result = await setDefaultPaymentMethodAction(pmId);
      setPendingId(null);
      if ("error" in result) {
        toast(result.error, { type: "bad" });
      } else {
        toast("Default payment method updated.", { type: "ok" });
      }
    });
  }

  function detach(pmId: string) {
    setPendingId(pmId);
    startTransition(async () => {
      const result = await detachPaymentMethodAction(pmId);
      setPendingId(null);
      if ("error" in result) {
        toast(result.error, { type: "bad" });
      } else {
        toast("Card removed.", { type: "ok" });
      }
    });
  }

  if (methods.length === 0 && !hasActiveSub) return null;

  return (
    <div>
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
        Payment methods
      </h2>

      <div className="border border-border rounded-xl overflow-hidden">
        {methods.length === 0 ? (
          <p className="text-sm text-muted-foreground p-4">No cards on file.</p>
        ) : (
          <div className="divide-y divide-border">
            {methods.map((pm) => (
              <div
                key={pm.id}
                className="flex items-center justify-between gap-3 px-4 py-3"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-5 bg-muted rounded text-[9px] font-bold flex items-center justify-center text-muted-foreground uppercase tracking-wide">
                    {CARD_BRAND_LABELS[pm.brand] ?? pm.brand}
                  </div>
                  <div>
                    <p className="text-sm font-medium">
                      •••• {pm.last4}
                      {pm.is_default && (
                        <Badge variant="success" className="ml-2 text-[9px]">
                          Default
                        </Badge>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Expires {pm.exp_month}/{pm.exp_year}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-1">
                  {!pm.is_default && (
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={isPending && pendingId === pm.id}
                      onClick={() => setDefault(pm.id)}
                    >
                      Set default
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={isPending && pendingId === pm.id}
                    onClick={() => detach(pm.id)}
                    className="text-destructive hover:text-destructive"
                  >
                    Remove
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {hasActiveSub && (
          <div className="px-4 py-3 border-t border-border bg-muted/30">
            <p className="text-xs text-muted-foreground">
              To add a new card, go to your{" "}
              <a
                href="/api/buyer/billing-portal"
                className="text-primary underline"
              >
                billing portal →
              </a>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
