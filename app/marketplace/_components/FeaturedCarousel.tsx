"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import type { FeaturedApp } from "@/lib/services/apps";
import { formatPrice } from "@/lib/services/apps";
import { StarRating } from "./StarRating";

export function FeaturedCarousel({ apps }: { apps: FeaturedApp[] }) {
  const [idx, setIdx] = useState(0);

  const next = useCallback(
    () => setIdx((i) => (i + 1) % apps.length),
    [apps.length]
  );

  useEffect(() => {
    if (apps.length <= 1) return;
    const t = setInterval(next, 5000);
    return () => clearInterval(t);
  }, [apps.length, next]);

  if (apps.length === 0) return null;

  const app = apps[idx];

  return (
    <section className="relative rounded-2xl overflow-hidden mb-8 bg-gradient-to-br from-[hsl(var(--primary)/0.08)] to-[hsl(var(--primary)/0.03)] border border-[hsl(var(--primary)/0.15)]">
      <div className="flex flex-col md:flex-row gap-0">
        {/* Screenshot */}
        <div className="md:w-1/2 aspect-[16/10] md:aspect-auto overflow-hidden">
          {app.screenshot_urls[0] ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={app.screenshot_urls[0]}
              alt={`${app.name} screenshot`}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full min-h-[200px] bg-gradient-to-br from-gray-100 to-gray-200" />
          )}
        </div>

        {/* Info */}
        <div className="md:w-1/2 p-6 md:p-8 flex flex-col justify-between">
          <div>
            <div className="flex items-start justify-between gap-3 mb-2">
              <div>
                <span className="text-[10px] font-semibold tracking-widest text-primary uppercase mb-1 block">
                  Featured
                </span>
                <h2 className="text-xl font-bold leading-tight">{app.name}</h2>
              </div>
              {app.category && (
                <span className="shrink-0 text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded-full">
                  {app.category}
                </span>
              )}
            </div>

            {app.vendor_name && (
              <p className="text-xs text-muted-foreground mb-3">
                by {app.vendor_name}
              </p>
            )}

            {app.description && (
              <p className="text-sm text-muted-foreground line-clamp-3 mb-4">
                {app.description}
              </p>
            )}

            {app.rating_count > 0 && (
              <StarRating avg={app.rating_avg} count={app.rating_count} className="mb-4" />
            )}
          </div>

          <div className="flex items-center justify-between gap-3 mt-auto">
            <div>
              <span className="text-2xl font-bold">
                {formatPrice(app.price_cents, app.currency)}
              </span>
              <span className="text-muted-foreground text-sm ml-1">/mo</span>
            </div>
            <Link
              href={`/app/${app.id}`}
              className="bg-primary text-primary-foreground px-5 py-2 rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
            >
              View app →
            </Link>
          </div>
        </div>
      </div>

      {/* Dot nav */}
      {apps.length > 1 && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex gap-1.5">
          {apps.map((_, i) => (
            <button
              key={i}
              onClick={() => setIdx(i)}
              aria-label={`Go to featured app ${i + 1}`}
              className={`w-1.5 h-1.5 rounded-full transition-colors ${
                i === idx ? "bg-primary" : "bg-primary/30"
              }`}
            />
          ))}
        </div>
      )}
    </section>
  );
}
