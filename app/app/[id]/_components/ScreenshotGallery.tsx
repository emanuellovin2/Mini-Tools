"use client";

import { useState } from "react";
import { Lightbox } from "@/components/ui/Lightbox";

export default function ScreenshotGallery({
  screenshots,
}: {
  screenshots: string[];
}) {
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);

  if (screenshots.length === 0) return null;

  const [hero, ...rest] = screenshots;
  const visibleThumbs = rest.slice(0, 4);
  const hiddenCount = rest.length > 4 ? rest.length - 4 : 0;

  return (
    <>
      <div className="mb-6 space-y-2">
        {/* Hero image */}
        <button
          type="button"
          onClick={() => setLightboxIdx(0)}
          className="w-full rounded-xl overflow-hidden block cursor-zoom-in focus:outline-none focus-visible:ring-2 focus-visible:ring-black"
          aria-label="Open screenshot viewer"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={hero}
            alt="App screenshot 1"
            className="w-full aspect-video object-cover"
            loading="lazy"
          />
        </button>

        {/* Thumbnail grid */}
        {visibleThumbs.length > 0 && (
          <div className={`grid gap-2 grid-cols-${visibleThumbs.length}`}>
            {visibleThumbs.map((img, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setLightboxIdx(i + 1)}
                className="relative rounded-lg overflow-hidden aspect-video cursor-zoom-in focus:outline-none focus-visible:ring-2 focus-visible:ring-black"
                aria-label={`View screenshot ${i + 2}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img}
                  alt={`App screenshot ${i + 2}`}
                  className="w-full h-full object-cover"
                  loading="lazy"
                />
                {i === 3 && hiddenCount > 0 && (
                  <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                    <span className="text-white font-semibold text-sm">
                      +{hiddenCount} more
                    </span>
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {lightboxIdx !== null && (
        <Lightbox
          images={screenshots}
          currentIndex={lightboxIdx}
          onNavigate={setLightboxIdx}
          onClose={() => setLightboxIdx(null)}
        />
      )}
    </>
  );
}
