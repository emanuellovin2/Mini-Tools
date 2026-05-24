"use client";

import { useState, useRef } from "react";

type UploadState = "idle" | "uploading";

export default function ScreenshotUploader({
  initialUrls = [],
}: {
  initialUrls?: string[];
}) {
  const [urls, setUrls] = useState<string[]>(initialUrls);
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragSrcIdx, setDragSrcIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const MAX = 7;
  const isUploading = uploadState === "uploading";
  const canAdd = urls.length < MAX && !isUploading;

  async function handleFiles(files: FileList) {
    const toUpload = Array.from(files).slice(0, MAX - urls.length);
    if (toUpload.length === 0) return;
    setUploadState("uploading");
    setUploadError(null);
    try {
      const newUrls: string[] = [];
      for (const file of toUpload) {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/vendor/apps/screenshots", {
          method: "POST",
          body: fd,
        });
        const data = (await res.json()) as { url?: string; error?: string };
        if (!res.ok) throw new Error(data.error ?? "Upload failed");
        newUrls.push(data.url!);
      }
      setUrls((prev) => [...prev, ...newUrls]);
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploadState("idle");
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function handleDragStart(e: React.DragEvent, idx: number) {
    e.dataTransfer.setData("text/plain", String(idx));
    e.dataTransfer.effectAllowed = "move";
    setDragSrcIdx(idx);
  }

  function handleDragOver(e: React.DragEvent, idx: number) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverIdx(idx);
  }

  function handleDragLeave() {
    setDragOverIdx(null);
  }

  function handleDrop(e: React.DragEvent, dropIdx: number) {
    e.preventDefault();
    const srcIdx = Number(e.dataTransfer.getData("text/plain"));
    if (!isNaN(srcIdx) && srcIdx !== dropIdx && srcIdx < urls.length) {
      setUrls((prev) => {
        const next = [...prev];
        const [removed] = next.splice(srcIdx, 1);
        next.splice(dropIdx, 0, removed);
        return next;
      });
    }
    setDragSrcIdx(null);
    setDragOverIdx(null);
  }

  function handleDragEnd() {
    setDragSrcIdx(null);
    setDragOverIdx(null);
  }

  function removeUrl(idx: number) {
    setUrls((prev) => prev.filter((_, i) => i !== idx));
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-4 gap-2">
        {Array.from({ length: MAX }, (_, slotIdx) => {
          const url = urls[slotIdx];
          const isPreview = slotIdx === 0;
          const isDragSrc = dragSrcIdx === slotIdx;
          const isDragOver = dragOverIdx === slotIdx && dragSrcIdx !== slotIdx;

          if (url) {
            return (
              <div
                key={slotIdx}
                draggable
                onDragStart={(e) => handleDragStart(e, slotIdx)}
                onDragOver={(e) => handleDragOver(e, slotIdx)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, slotIdx)}
                onDragEnd={handleDragEnd}
                className={`relative aspect-video rounded-lg overflow-hidden border-2 cursor-grab active:cursor-grabbing select-none transition-all ${
                  isPreview
                    ? "ring-2 ring-indigo-500 border-indigo-300"
                    : isDragOver
                      ? "border-blue-400 scale-105"
                      : "border-gray-200"
                } ${isDragSrc ? "opacity-40" : ""}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={url}
                  alt={`Screenshot ${slotIdx + 1}`}
                  className="w-full h-full object-cover pointer-events-none"
                />
                {isPreview && (
                  <span className="absolute top-1 left-1 text-[10px] bg-indigo-600 text-white px-1.5 py-0.5 rounded font-medium pointer-events-none">
                    Preview
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => removeUrl(slotIdx)}
                  className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 text-white text-xs flex items-center justify-center hover:bg-black/80 transition-colors"
                  aria-label={`Remove screenshot ${slotIdx + 1}`}
                >
                  ×
                </button>
              </div>
            );
          }

          // Empty slot
          const isNextUpload = slotIdx === urls.length;
          return (
            <div
              key={slotIdx}
              onDragOver={(e) => handleDragOver(e, slotIdx)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, slotIdx)}
              className={`relative aspect-video rounded-lg border-2 border-dashed flex items-center justify-center transition-all ${
                isDragOver
                  ? "border-blue-400 bg-blue-50"
                  : isPreview
                    ? "border-indigo-200 bg-indigo-50/30"
                    : "border-gray-200 bg-gray-50"
              }`}
            >
              {isNextUpload && urls.length < MAX ? (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isUploading}
                  className="text-xs text-gray-500 hover:text-gray-700 transition-colors disabled:opacity-50"
                >
                  {isUploading ? "Uploading…" : "+ Add"}
                </button>
              ) : (
                <span className="text-xs text-gray-300">{slotIdx + 1}</span>
              )}
              {isPreview && slotIdx >= urls.length && (
                <span className="absolute top-1 left-1 text-[10px] text-indigo-300 font-medium">
                  Preview
                </span>
              )}
            </div>
          );
        })}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
        multiple
        className="sr-only"
        onChange={(e) => e.target.files && handleFiles(e.target.files)}
      />

      {/* Hidden inputs carry URLs into the FormData on submit */}
      {urls.map((url, i) => (
        <input key={i} type="hidden" name="screenshot_urls" value={url} />
      ))}

      <div className="flex items-center justify-between">
        <p
          className={`text-xs ${urls.length < 3 ? "text-amber-600 font-medium" : "text-gray-500"}`}
        >
          {urls.length}/7 screenshots
          {urls.length < 3 && " — min 3 required to submit"}
        </p>
        {urls.length > 0 && urls.length < MAX && (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
            className="text-xs text-blue-600 hover:text-blue-800 disabled:opacity-50 transition-colors"
          >
            + Add more
          </button>
        )}
      </div>

      {uploadError && <p className="text-red-500 text-xs">{uploadError}</p>}
    </div>
  );
}
