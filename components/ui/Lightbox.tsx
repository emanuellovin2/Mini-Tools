"use client";

import { useEffect, useRef, useCallback } from "react";

interface LightboxProps {
  images: string[];
  currentIndex: number;
  onNavigate: (index: number) => void;
  onClose: () => void;
}

export function Lightbox({ images, currentIndex, onNavigate, onClose }: LightboxProps) {
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  const prev = useCallback(() => {
    onNavigate((currentIndex - 1 + images.length) % images.length);
  }, [currentIndex, images.length, onNavigate]);

  const next = useCallback(() => {
    onNavigate((currentIndex + 1) % images.length);
  }, [currentIndex, images.length, onNavigate]);

  useEffect(() => {
    closeBtnRef.current?.focus();

    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") prev();
      else if (e.key === "ArrowRight") next();
      else if (e.key === "Home") onNavigate(0);
      else if (e.key === "End") onNavigate(images.length - 1);
    }

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [prev, next, onClose, onNavigate, images.length]);

  // Prevent body scroll while open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/90"
      role="dialog"
      aria-modal="true"
      aria-label="Screenshot viewer"
    >
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-3 shrink-0">
        <span className="text-white/60 text-sm tabular-nums">
          {currentIndex + 1} / {images.length}
        </span>
        <button
          ref={closeBtnRef}
          type="button"
          onClick={onClose}
          className="text-white/70 hover:text-white text-sm px-3 py-1.5 rounded border border-white/20 hover:border-white/40 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
          aria-label="Close viewer (Esc)"
        >
          Close
        </button>
      </div>

      {/* Main image + nav */}
      <div className="flex-1 flex items-center gap-2 px-2 min-h-0">
        <button
          type="button"
          onClick={prev}
          disabled={images.length <= 1}
          className="shrink-0 text-white/60 hover:text-white w-10 h-10 flex items-center justify-center rounded-full hover:bg-white/10 disabled:opacity-20 transition-colors text-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
          aria-label="Previous (←)"
        >
          ←
        </button>

        <div className="flex-1 flex items-center justify-center h-full min-w-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={images[currentIndex]}
            alt={`Screenshot ${currentIndex + 1} of ${images.length}`}
            className="max-w-full max-h-full object-contain rounded-lg"
            loading="lazy"
          />
        </div>

        <button
          type="button"
          onClick={next}
          disabled={images.length <= 1}
          className="shrink-0 text-white/60 hover:text-white w-10 h-10 flex items-center justify-center rounded-full hover:bg-white/10 disabled:opacity-20 transition-colors text-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
          aria-label="Next (→)"
        >
          →
        </button>
      </div>

      {/* Thumbnail strip */}
      {images.length > 1 && (
        <div className="shrink-0 px-4 py-3 flex gap-2 overflow-x-auto justify-center">
          {images.map((img, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onNavigate(i)}
              className={`shrink-0 w-14 h-9 rounded overflow-hidden border-2 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50 ${
                i === currentIndex
                  ? "border-white"
                  : "border-transparent opacity-50 hover:opacity-80"
              }`}
              aria-label={`Go to screenshot ${i + 1}`}
              aria-current={i === currentIndex ? "true" : undefined}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img} alt="" className="w-full h-full object-cover" loading="lazy" />
            </button>
          ))}
        </div>
      )}

      {/* Backdrop — clicking outside the image closes */}
      <div
        className="absolute inset-0 -z-10"
        onClick={onClose}
        aria-hidden="true"
      />
    </div>
  );
}
