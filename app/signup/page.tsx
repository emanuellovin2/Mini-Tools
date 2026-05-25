"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createBrowserSupabaseClient } from "@/lib/services/supabase-browser";
import { z } from "zod";

const signUpSchema = z.object({
  email: z.string().email("Invalid email"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  role: z.enum(["buyer", "vendor", "reseller"]),
});

const roles = [
  { value: "buyer", label: "Buy apps", desc: "Access SaaS tools & agents" },
  { value: "vendor", label: "Sell apps", desc: "List and monetize your SaaS" },
  { value: "reseller", label: "Resell apps", desc: "Run your own storefront" },
] as const;

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"buyer" | "vendor" | "reseller">("buyer");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const parsed = signUpSchema.safeParse({ email, password, role });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Validation error");
      return;
    }

    setLoading(true);
    const supabase = createBrowserSupabaseClient();
    const { error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { intended_role: role } },
    });

    if (authError) {
      setError(authError.message);
      setLoading(false);
      return;
    }

    router.push("/");
    router.refresh();
  }

  const inputStyle = {
    background: "hsl(var(--surface))",
    border: "1px solid hsl(var(--border))",
    color: "hsl(var(--foreground))",
    boxShadow: "var(--shadow-sm)",
  };

  function handleFocus(e: React.FocusEvent<HTMLInputElement>) {
    e.currentTarget.style.borderColor = "hsl(var(--primary))";
    e.currentTarget.style.boxShadow = "0 0 0 3px hsl(var(--primary) / 0.12)";
  }
  function handleBlur(e: React.FocusEvent<HTMLInputElement>) {
    e.currentTarget.style.borderColor = "hsl(var(--border))";
    e.currentTarget.style.boxShadow = "var(--shadow-sm)";
  }

  return (
    <main className="min-h-screen flex items-center justify-center py-12 px-4" style={{ background: "hsl(var(--background))" }}>
      <div className="w-full max-w-[420px]">
        {/* Logo */}
        <div className="text-center mb-8">
          <span
            className="inline-flex items-center justify-center w-10 h-10 rounded-xl text-white text-lg font-bold mb-4"
            style={{ background: "hsl(var(--primary))" }}
          >
            P
          </span>
          <h1 className="text-2xl font-semibold tracking-tight" style={{ color: "hsl(var(--foreground))" }}>
            Create your account
          </h1>
          <p className="mt-1 text-sm" style={{ color: "hsl(var(--muted-foreground))" }}>
            Get started in under a minute
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
            {/* Role selector */}
            <div>
              <label className="block text-xs font-medium mb-2" style={{ color: "hsl(var(--foreground))" }}>
                I want to…
              </label>
              <div className="grid grid-cols-3 gap-2">
                {roles.map((r) => {
                  const active = role === r.value;
                  return (
                    <button
                      key={r.value}
                      type="button"
                      onClick={() => setRole(r.value)}
                      className="flex flex-col items-center py-3 px-2 rounded-lg text-center transition-all"
                      style={{
                        border: active
                          ? "1px solid hsl(var(--primary))"
                          : "1px solid hsl(var(--border))",
                        background: active
                          ? "hsl(var(--accent-soft))"
                          : "hsl(var(--surface))",
                        color: active
                          ? "hsl(var(--primary))"
                          : "hsl(var(--muted-foreground))",
                        boxShadow: active ? "0 0 0 3px hsl(var(--primary) / 0.1)" : "none",
                      }}
                    >
                      <span className="text-[12px] font-semibold">{r.label}</span>
                      <span className="text-[10px] mt-0.5 opacity-75 leading-tight">{r.desc}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium mb-1.5" htmlFor="email" style={{ color: "hsl(var(--foreground))" }}>
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
                className="w-full rounded-lg px-3 py-2.5 text-sm outline-none transition-shadow"
                style={inputStyle}
                onFocus={handleFocus}
                onBlur={handleBlur}
              />
            </div>

            <div>
              <label className="block text-xs font-medium mb-1.5" htmlFor="password" style={{ color: "hsl(var(--foreground))" }}>
                Password
              </label>
              <input
                id="password"
                type="password"
                required
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Min. 8 characters"
                className="w-full rounded-lg px-3 py-2.5 text-sm outline-none transition-shadow"
                style={inputStyle}
                onFocus={handleFocus}
                onBlur={handleBlur}
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
              {loading ? "Creating account…" : "Create account"}
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-sm" style={{ color: "hsl(var(--muted-foreground))" }}>
          Already have an account?{" "}
          <Link href="/login" className="font-medium" style={{ color: "hsl(var(--foreground))" }}>
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
