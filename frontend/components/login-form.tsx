"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormEvent } from "react";

import { Icon } from "@/components/dashboard/icons";
import { LanguageSwitcher } from "@/components/language-switcher";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { apiBaseUrl } from "@/lib/auth";
import { useLocale } from "@/lib/i18n";

export function validateLoginInput(
  email: string,
  password: string,
): { isValid: boolean; errorKey?: "missingCredentials" } {
  if (!email.trim() || !password) {
    return { isValid: false, errorKey: "missingCredentials" };
  }
  return { isValid: true };
}

export function LoginForm() {
  const router = useRouter();
  const { t } = useLocale();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    const validation = validateLoginInput(email, password);
    if (!validation.isValid) {
      setError(t.login.missingCredentials);
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await fetch(`${apiBaseUrl}/auth/login`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });

      if (!response.ok) {
        setError(t.login.invalidCredentials);
        return;
      }

      router.replace("/dashboard");
      router.refresh();
    } catch {
      setError(t.login.unavailable);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="relative min-h-screen bg-background text-foreground flex flex-col lg:grid lg:grid-cols-2">
      {/* Top Controls: ThemeSwitcher and LanguageSwitcher */}
      <div className="absolute top-4 end-4 z-20 flex items-center gap-2 sm:top-6 sm:end-6">
        <ThemeSwitcher />
        <LanguageSwitcher />
      </div>

      {/* Left Column: Vervio Branding & Highlights (Desktop only) */}
      <section className="relative hidden h-full flex-col justify-between border-e border-border bg-muted/30 p-10 lg:flex xl:p-14">
        {/* Brand Header */}
        <div className="flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground font-bold shadow-sm">
            V
          </span>
          <span className="text-xl font-bold tracking-tight text-foreground">
            Vervio
          </span>
        </div>

        {/* Value Proposition */}
        <div className="max-w-md space-y-6">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">
            {t.login.eyebrow}
          </p>
          <h1 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
            {t.login.title}
          </h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t.login.description}
          </p>

          {/* Key Platform Highlights */}
          <div className="space-y-3 pt-2">
            <div className="flex items-center gap-3 text-xs font-medium text-foreground">
              <span className="grid size-6 place-items-center rounded-full bg-primary/10 text-primary">
                <Icon className="size-3.5" name="interviews" />
              </span>
              <span>AI-led, candidate-focused German interview sessions</span>
            </div>
            <div className="flex items-center gap-3 text-xs font-medium text-foreground">
              <span className="grid size-6 place-items-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                <Icon className="size-3.5" name="evaluations" />
              </span>
              <span>Objective, evidence-based CEFR German evaluations</span>
            </div>
            <div className="flex items-center gap-3 text-xs font-medium text-foreground">
              <span className="grid size-6 place-items-center rounded-full bg-primary/10 text-primary">
                <Icon className="size-3.5" name="check" />
              </span>
              <span>Enterprise-grade secure recording & transcript access</span>
            </div>
          </div>
        </div>

        {/* Footer info */}
        <div className="text-xs text-muted-foreground">
          Vervio Platform · Secure German Interview Assessment
        </div>
      </section>

      {/* Right Column: Centered Login Form Card */}
      <section className="flex flex-1 items-center justify-center p-6 sm:p-10 lg:p-12">
        <div className="w-full max-w-[400px] space-y-6">
          {/* Mobile Brand Header */}
          <div className="flex items-center gap-2.5 lg:hidden">
            <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground font-bold shadow-sm">
              V
            </span>
            <span className="text-lg font-bold tracking-tight text-foreground">
              Vervio
            </span>
          </div>

          {/* Form Card */}
          <div className="rounded-xl border border-border bg-card p-6 shadow-sm sm:p-8 text-card-foreground">
            <div className="space-y-1.5">
              <h2 className="text-2xl font-bold tracking-tight text-foreground">
                {t.login.formTitle}
              </h2>
              <p className="text-xs text-muted-foreground">
                {t.login.formDescription}
              </p>
            </div>

            <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
              {/* Email Address */}
              <div>
                <label
                  className="block text-xs font-medium text-foreground"
                  htmlFor="email"
                >
                  {t.login.emailLabel}
                </label>
                <input
                  autoComplete="email"
                  className="mt-1.5 h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  dir="ltr"
                  id="email"
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="name@company.com"
                  required
                  type="email"
                  value={email}
                />
              </div>

              {/* Password */}
              <div>
                <label
                  className="block text-xs font-medium text-foreground"
                  htmlFor="password"
                >
                  {t.login.passwordLabel}
                </label>
                <div className="relative mt-1.5">
                  <input
                    autoComplete="current-password"
                    className="h-9 w-full rounded-md border border-input bg-background px-3 py-1 pe-10 text-sm text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    dir="ltr"
                    id="password"
                    onChange={(event) => setPassword(event.target.value)}
                    required
                    type={showPassword ? "text" : "password"}
                    value={password}
                  />
                  <button
                    aria-label={showPassword ? t.login.hidePassword : t.login.showPassword}
                    className="absolute inset-y-0 end-0 flex items-center pe-3 text-muted-foreground hover:text-foreground transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-e-md"
                    onClick={() => setShowPassword((prev) => !prev)}
                    tabIndex={0}
                    type="button"
                  >
                    <Icon className="size-4" name={showPassword ? "eye-off" : "eye"} />
                  </button>
                </div>
              </div>

              {/* Error Callout */}
              {error ? (
                <div
                  aria-live="polite"
                  className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive"
                  role="alert"
                >
                  {error}
                </div>
              ) : null}

              {/* Submit Button */}
              <button
                className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                disabled={isSubmitting}
                type="submit"
              >
                {isSubmitting ? (
                  <>
                    <span className="size-3.5 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent" />
                    <span>{t.login.submitting}</span>
                  </>
                ) : (
                  <span>{t.login.submit}</span>
                )}
              </button>
            </form>
          </div>
        </div>
      </section>
    </main>
  );
}
