"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createBrowserSupabaseClient } from "@/lib/services/supabase-browser";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const supabase = createBrowserSupabaseClient();
    const { error: authError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (authError) {
      setError(authError.message);
      setLoading(false);
      return;
    }

    router.push("/");
    router.refresh();
  }

  return (
    <main className="min-h-screen flex items-center justify-center" style={{ background: "hsl(var(--background))" }}>
      <div className="w-full max-w-[400px] px-4">
        {/* Logo */}
        <div className="text-center mb-8">
          <span
            className="inline-flex items-center justify-center w-10 h-10 rounded-xl text-white text-lg font-bold mb-4"
            style={{ background: "hsl(var(--primary))" }}
          >
            P
          </span>
          <h1 className="text-2xl font-semibold tracking-tight" style={{ color: "hsl(var(--foreground))" }}>
            Sign in to your account
          </h1>
          <p className="mt-1 text-sm" style={{ color: "hsl(var(--muted-foreground))" }}>
            Welcome back
          </p>
        </div>

        {/* Card */}
        <div
          className="rounded-xl p-8"
          style={{
            background: "hsl(var(--surface))",
            boxShadow: "var(--shadow-card), 0 2px 8px rgba(10,14,39,.06)",
            border: "1px solid hsl(var(--border))",
          }}
        >
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label
                className="block text-xs font-medium mb-1.5"
                htmlFor="email"
                style={{ color: "hsl(var(--foreground))" }}
              >
                Email address
              </label>
              <input
                id="email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full rounded-lg px-3 py-2.5 text-sm transition-shadow outline-none"
                style={{
                  background: "hsl(var(--surface))",
                  border: "1px solid hsl(var(--border))",
                  color: "hsl(var(--foreground))",
                  boxShadow: "var(--shadow-sm)",
                }}
                onFocus={(e) => {
                  e.currentTarget.style.borderColor = "hsl(var(--primary))";
                  e.currentTarget.style.boxShadow = "0 0 0 3px hsl(var(--primary) / 0.12)";
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor = "hsl(var(--border))";
                  e.currentTarget.style.boxShadow = "var(--shadow-sm)";
                }}
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label
                  className="block text-xs font-medium"
                  htmlFor="password"
                  style={{ color: "hsl(var(--foreground))" }}
                >
                  Password
                </label>
                <Link
                  href="/forgot-password"
                  className="text-xs font-medium transition-colors"
                  style={{ color: "hsl(var(--primary))" }}
                >
                  Forgot password?
                </Link>
              </div>
              <input
                id="password"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full rounded-lg px-3 py-2.5 text-sm transition-shadow outline-none"
                style={{
                  background: "hsl(var(--surface))",
                  border: "1px solid hsl(var(--border))",
                  color: "hsl(var(--foreground))",
                  boxShadow: "var(--shadow-sm)",
                }}
                onFocus={(e) => {
                  e.currentTarget.style.borderColor = "hsl(var(--primary))";
                  e.currentTarget.style.boxShadow = "0 0 0 3px hsl(var(--primary) / 0.12)";
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor = "hsl(var(--border))";
                  e.currentTarget.style.boxShadow = "var(--shadow-sm)";
                }}
              />
            </div>

            {error && (
              <div
                className="flex items-start gap-2 rounded-lg px-3 py-2.5 text-xs"
                style={{
                  background: "hsl(var(--bad-soft))",
                  border: "1px solid hsl(var(--bad) / 0.2)",
                  color: "hsl(var(--bad))",
                }}
              >
                <svg className="w-3.5 h-3.5 mt-px shrink-0" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 4a.75.75 0 0 1 .75.75v2.5a.75.75 0 0 1-1.5 0v-2.5A.75.75 0 0 1 8 5zm0 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2z" />
                </svg>
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 rounded-lg text-sm font-medium transition-opacity disabled:opacity-60"
              style={{
                background: "hsl(var(--primary))",
                color: "hsl(var(--primary-foreground))",
                boxShadow: "0 1px 2px hsl(var(--primary) / 0.3)",
              }}
            >
              {loading ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </div>

        {/* Footer */}
        <p className="mt-6 text-center text-sm" style={{ color: "hsl(var(--muted-foreground))" }}>
          Don&apos;t have an account?{" "}
          <Link
            href="/signup"
            className="font-medium transition-colors"
            style={{ color: "hsl(var(--foreground))" }}
          >
            Sign up
          </Link>
        </p>
      </div>
    </main>
  );
}
