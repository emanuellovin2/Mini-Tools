"use client";

import { useState, useTransition } from "react";
import type { AppReview } from "@/lib/services/apps";
import { createReviewAction } from "../actions";
import { StarRating, StarInput } from "@/app/marketplace/_components/StarRating";

interface ReviewSectionProps {
  appId: string;
  reviews: AppReview[];
  total: number;
  canReview: boolean;
  subscriptionId: string | null;
  userId: string | null;
}

export default function ReviewSection({
  appId,
  reviews,
  total,
  canReview,
  subscriptionId,
}: ReviewSectionProps) {
  const [rating, setRating] = useState(0);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (rating === 0) {
      setError("Please select a rating.");
      return;
    }
    if (!subscriptionId) return;

    setError(null);
    startTransition(async () => {
      const result = await createReviewAction({
        appId,
        subscriptionId,
        rating,
        title: title.trim() || undefined,
        body: body.trim() || undefined,
      });
      if ("error" in result) {
        setError(result.error);
      } else {
        setSubmitted(true);
      }
    });
  }

  return (
    <section className="mt-8">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">
          Reviews{total > 0 && <span className="text-muted-foreground font-normal text-sm ml-2">({total})</span>}
        </h2>
      </div>

      {/* Leave a review form */}
      {canReview && !submitted && (
        <div className="border border-border rounded-xl p-5 mb-6 bg-muted/30">
          <h3 className="text-sm font-semibold mb-3">Leave a review</h3>
          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">
                Rating <span className="text-destructive">*</span>
              </label>
              <StarInput value={rating} onChange={setRating} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">
                Title (optional)
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={120}
                placeholder="Summarise your experience"
                className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">
                Review (optional)
              </label>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                maxLength={2000}
                rows={3}
                placeholder="Tell others what you think…"
                className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
              />
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <button
              type="submit"
              disabled={isPending || rating === 0}
              className="bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {isPending ? "Submitting…" : "Submit review"}
            </button>
          </form>
        </div>
      )}

      {submitted && (
        <div className="border border-green-200 bg-green-50 rounded-xl p-4 mb-6 text-sm text-green-700">
          Thanks for your review!
        </div>
      )}

      {/* Review list */}
      {reviews.length === 0 ? (
        <p className="text-sm text-muted-foreground py-6 text-center border border-dashed border-border rounded-xl">
          No reviews yet.{" "}
          {canReview && !submitted && "Be the first to review this app."}
        </p>
      ) : (
        <div className="space-y-4">
          {reviews.map((review) => (
            <ReviewCard key={review.id} review={review} />
          ))}
        </div>
      )}
    </section>
  );
}

function ReviewCard({ review }: { review: AppReview }) {
  return (
    <div className="border border-border rounded-xl p-5 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 mb-0.5">
            <StarRating avg={review.rating} size="sm" />
            <span className="text-xs font-medium text-foreground">
              {review.display_name}
            </span>
            <span className="text-[10px] bg-green-50 text-green-700 border border-green-200 px-1.5 py-0.5 rounded-full">
              Verified purchase
            </span>
          </div>
          {review.title && (
            <p className="text-sm font-semibold">{review.title}</p>
          )}
        </div>
        <span className="text-[10px] text-muted-foreground shrink-0">
          {new Date(review.created_at).toLocaleDateString("en-US", {
            month: "short",
            year: "numeric",
            day: "numeric",
          })}
        </span>
      </div>

      {review.body && (
        <p className="text-sm text-muted-foreground leading-relaxed">
          {review.body}
        </p>
      )}

      {review.vendor_response && (
        <div className="mt-3 pl-4 border-l-2 border-primary/30">
          <p className="text-[10px] font-semibold text-primary mb-1">
            Developer response
          </p>
          <p className="text-xs text-muted-foreground">{review.vendor_response}</p>
        </div>
      )}
    </div>
  );
}
