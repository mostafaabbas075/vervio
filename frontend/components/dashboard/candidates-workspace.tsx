"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";

import { Icon } from "@/components/dashboard/icons";
import { useDashboardSession } from "@/components/dashboard/dashboard-shell";
import { apiBaseUrl } from "@/lib/auth";
import { type Locale, useLocale } from "@/lib/i18n";

export type Candidate = {
  id: string;
  email: string;
  given_name: string;
  family_name: string;
  status: string;
  created_at: string;
};

export function filterCandidatesList(candidates: Candidate[], query: string): Candidate[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return candidates;
  }
  return candidates.filter((c) => {
    const fullName = `${c.given_name} ${c.family_name}`.toLowerCase();
    return (
      fullName.includes(q) ||
      c.given_name.toLowerCase().includes(q) ||
      c.family_name.toLowerCase().includes(q) ||
      c.email.toLowerCase().includes(q)
    );
  });
}

export function getCandidateInitials(givenName: string, familyName: string): string {
  const g = givenName.trim().charAt(0);
  const f = familyName.trim().charAt(0);
  return `${g}${f}`.toUpperCase() || "?";
}

export function formatCandidateDate(dateString: string, locale: Locale): string {
  try {
    return new Intl.DateTimeFormat(locale === "ar" ? "ar" : "en", {
      dateStyle: "medium",
    }).format(new Date(dateString));
  } catch {
    return dateString;
  }
}

export function getCandidateStatusBadgeClass(status: string): string {
  switch (status.toLowerCase()) {
    case "active":
      return "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "archived":
      return "border-border bg-muted/60 text-muted-foreground";
    default:
      return "border-primary/20 bg-primary/10 text-primary";
  }
}

export function CandidatesWorkspace() {
  const { csrfToken } = useDashboardSession();
  const { locale, t } = useLocale();

  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [givenName, setGivenName] = useState("");
  const [familyName, setFamilyName] = useState("");
  const [email, setEmail] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState("");

  const loadCandidates = useCallback(async () => {
    setIsLoading(true);
    setError("");
    try {
      const response = await fetch(`${apiBaseUrl}/candidates`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!response.ok) {
        setError(t.candidates.loadFailed);
        return;
      }
      const data = (await response.json()) as Candidate[];
      setCandidates(Array.isArray(data) ? data : []);
    } catch {
      setError(t.candidates.loadFailed);
    } finally {
      setIsLoading(false);
    }
  }, [t.candidates.loadFailed]);

  useEffect(() => {
    void loadCandidates();
  }, [loadCandidates]);

  async function createCandidate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setIsCreating(true);

    try {
      const response = await fetch(`${apiBaseUrl}/candidates`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({
          email,
          given_name: givenName,
          family_name: familyName,
        }),
      });
      if (!response.ok) {
        setError(response.status === 409 ? t.candidates.emailExists : t.candidates.createFailed);
        return;
      }

      const candidate = (await response.json()) as Candidate;
      setCandidates((current) => [candidate, ...current]);
      setGivenName("");
      setFamilyName("");
      setEmail("");
    } catch {
      setError(t.candidates.createFailed);
    } finally {
      setIsCreating(false);
    }
  }

  const filteredCandidates = useMemo(
    () => filterCandidatesList(candidates, searchQuery),
    [candidates, searchQuery],
  );

  return (
    <div className="space-y-6 sm:space-y-8">
      {/* Page Header */}
      <div>
        <div className="flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-lg bg-primary/10 text-primary">
            <Icon className="size-5" name="candidates" />
          </span>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
              {t.candidates.title}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t.candidates.description}
            </p>
          </div>
        </div>
      </div>

      {/* Main Grid: Add Candidate + Candidate Directory */}
      <div className="grid gap-6 xl:grid-cols-[380px_1fr]">
        {/* Left Column: Add Candidate Card */}
        <section className="rounded-xl border border-border bg-card p-5 text-card-foreground shadow-sm sm:p-6">
          <div className="flex items-center gap-2.5">
            <span className="grid size-8 place-items-center rounded-md bg-primary/10 text-primary">
              <Icon className="size-4" name="user-plus" />
            </span>
            <h2 className="text-base font-semibold text-foreground">
              {t.candidates.addCandidate}
            </h2>
          </div>

          <form className="mt-5 space-y-4" onSubmit={createCandidate}>
            <div>
              <label className="block text-xs font-medium text-foreground" htmlFor="given-name">
                {t.candidates.givenName}
              </label>
              <input
                className="mt-1.5 h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                id="given-name"
                onChange={(event) => setGivenName(event.target.value)}
                required
                value={givenName}
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-foreground" htmlFor="family-name">
                {t.candidates.familyName}
              </label>
              <input
                className="mt-1.5 h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                id="family-name"
                onChange={(event) => setFamilyName(event.target.value)}
                required
                value={familyName}
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-foreground" htmlFor="candidate-email">
                {t.candidates.email}
              </label>
              <input
                autoComplete="email"
                className="mt-1.5 h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                dir="ltr"
                id="candidate-email"
                onChange={(event) => setEmail(event.target.value)}
                required
                type="email"
                value={email}
              />
            </div>

            {error ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                {error}
              </div>
            ) : null}

            <button
              className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={isCreating}
              type="submit"
            >
              {isCreating ? (
                <>
                  <span className="size-3 animate-spin rounded-full border border-primary-foreground border-t-transparent" />
                  {t.candidates.creating}
                </>
              ) : (
                <>
                  <Icon className="size-3.5" name="user-plus" />
                  {t.candidates.create}
                </>
              )}
            </button>
          </form>
        </section>

        {/* Right Column: Candidate Directory */}
        <section className="rounded-xl border border-border bg-card p-5 text-card-foreground shadow-sm sm:p-6">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
            <div className="flex items-center gap-2.5">
              <h2 className="text-base font-semibold text-foreground">
                {t.candidates.candidateList}
              </h2>
              <span className="rounded-full border border-border bg-secondary px-2.5 py-0.5 text-xs font-medium text-secondary-foreground">
                {t.candidates.totalCandidatesCount.replace("{count}", String(candidates.length))}
              </span>
            </div>

            {/* Search Input */}
            <div className="relative w-full sm:max-w-xs">
              <span className="pointer-events-none absolute inset-y-0 start-0 grid w-9 place-items-center text-muted-foreground">
                <Icon className="size-3.5" name="search" />
              </span>
              <input
                aria-label={t.candidates.searchPlaceholder}
                className="h-9 w-full rounded-md border border-input bg-background py-1.5 pe-4 ps-9 text-xs text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t.candidates.searchPlaceholder}
                type="text"
                value={searchQuery}
              />
            </div>
          </div>

          {isLoading ? (
            <div className="mt-6 flex min-h-60 items-center justify-center gap-2 rounded-lg border border-border bg-muted/20 p-8 text-xs text-muted-foreground">
              <span className="size-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <span>{t.dashboard.loading}</span>
            </div>
          ) : error && candidates.length === 0 ? (
            <div className="mt-6 rounded-lg border border-destructive/30 bg-destructive/5 p-8 text-center text-xs text-destructive">
              <p>{error}</p>
              <button
                className="mt-3 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90"
                onClick={() => void loadCandidates()}
                type="button"
              >
                {t.interviews.createFailed ? t.dashboard.loading : "Retry"}
              </button>
            </div>
          ) : candidates.length === 0 ? (
            <div className="mt-6 grid min-h-60 place-items-center rounded-lg border border-dashed border-border bg-muted/20 p-8 text-center text-xs text-muted-foreground">
              <div>
                <Icon className="mx-auto size-8 text-muted-foreground/50" name="candidates" />
                <p className="mt-2 text-sm font-medium text-foreground">{t.candidates.noCandidates}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t.candidates.description}</p>
              </div>
            </div>
          ) : filteredCandidates.length === 0 ? (
            <div className="mt-6 grid min-h-60 place-items-center rounded-lg border border-dashed border-border bg-muted/20 p-8 text-center text-xs text-muted-foreground">
              <div>
                <Icon className="mx-auto size-6 text-muted-foreground/50" name="search" />
                <p className="mt-2 text-sm font-medium text-foreground">{t.candidates.noSearchResults}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t.candidates.noSearchResultsDescription}</p>
              </div>
            </div>
          ) : (
            <div className="mt-6 overflow-x-auto">
              <div className="min-w-full divide-y divide-border/60">
                {/* Table Header (hidden on mobile) */}
                <div className="hidden grid-cols-12 gap-3 pb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground sm:grid">
                  <div className="col-span-5">{t.candidates.title}</div>
                  <div className="col-span-2">{t.interviews.status}</div>
                  <div className="col-span-3">{t.candidates.createdAt}</div>
                  <div className="col-span-2 text-end">{t.candidates.actions}</div>
                </div>

                {/* Candidate Rows */}
                {filteredCandidates.map((candidate) => {
                  const fullName = `${candidate.given_name} ${candidate.family_name}`;
                  const initials = getCandidateInitials(candidate.given_name, candidate.family_name);
                  const statusLabel =
                    candidate.status === "active" ? t.candidates.statusActive : candidate.status;

                  return (
                    <div
                      className="flex flex-col justify-between gap-3 py-3.5 sm:grid sm:grid-cols-12 sm:items-center sm:gap-3"
                      key={candidate.id}
                    >
                      {/* Name & Email */}
                      <div className="col-span-5 flex items-center gap-3 min-w-0">
                        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                          {initials}
                        </span>
                        <div className="min-w-0">
                          <p className="truncate text-xs font-medium text-foreground">
                            {fullName}
                          </p>
                          <p className="truncate text-[11px] text-muted-foreground font-mono" dir="ltr">
                            {candidate.email}
                          </p>
                        </div>
                      </div>

                      {/* Status */}
                      <div className="col-span-2">
                        <span
                          className={`inline-flex rounded-md border px-2 py-0.5 text-[11px] font-medium ${getCandidateStatusBadgeClass(
                            candidate.status,
                          )}`}
                        >
                          {statusLabel}
                        </span>
                      </div>

                      {/* Created At */}
                      <div className="col-span-3 text-[11px] text-muted-foreground">
                        {formatCandidateDate(candidate.created_at, locale)}
                      </div>

                      {/* Actions */}
                      <div className="col-span-2 flex items-center gap-1.5 self-end sm:self-auto sm:justify-end">
                        <Link
                          className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-2 py-1 text-[11px] font-medium text-foreground shadow-sm transition hover:bg-accent hover:text-accent-foreground"
                          href="/dashboard/recordings"
                          title={t.overview.viewRecordings}
                        >
                          <Icon className="size-3 text-muted-foreground" name="folder" />
                          <span className="hidden xl:inline">{t.navigation.recordings}</span>
                        </Link>
                        <Link
                          className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-2 py-1 text-[11px] font-medium text-foreground shadow-sm transition hover:bg-accent hover:text-accent-foreground"
                          href="/dashboard/interviews"
                          title={t.interviews.createSession}
                        >
                          <Icon className="size-3 text-primary" name="interviews" />
                          <span className="hidden xl:inline">{t.navigation.interviews}</span>
                        </Link>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
