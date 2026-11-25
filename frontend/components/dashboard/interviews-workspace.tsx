"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";

import { Icon } from "@/components/dashboard/icons";
import { useDashboardSession } from "@/components/dashboard/dashboard-shell";
import type { Candidate } from "@/components/dashboard/candidates-workspace";
import { apiBaseUrl } from "@/lib/auth";
import { type Locale, useLocale } from "@/lib/i18n";

export type InterviewStatus = "scheduled" | "in_progress" | "completed" | "cancelled" | "failed";

export type InterviewSession = {
  id: string;
  candidate: Candidate;
  status: InterviewStatus;
  required_german_level?: string | null;
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  has_recording?: boolean;
};

export function filterInterviewSessions(
  sessions: InterviewSession[],
  query: string,
): InterviewSession[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return sessions;
  }
  return sessions.filter((s) => {
    const candidateName = `${s.candidate?.given_name ?? ""} ${s.candidate?.family_name ?? ""}`.toLowerCase();
    const candidateEmail = (s.candidate?.email ?? "").toLowerCase();
    const status = s.status.toLowerCase();
    const level = (s.required_german_level ?? "").toLowerCase();
    return (
      candidateName.includes(q) ||
      candidateEmail.includes(q) ||
      status.includes(q) ||
      level.includes(q)
    );
  });
}

export function getInterviewStatusBadgeClass(status: string): string {
  switch (status.toLowerCase()) {
    case "completed":
      return "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "in_progress":
      return "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "scheduled":
      return "border-primary/20 bg-primary/10 text-primary";
    case "failed":
      return "border-destructive/30 bg-destructive/10 text-destructive";
    case "cancelled":
    default:
      return "border-border bg-muted/60 text-muted-foreground";
  }
}

export function formatSessionDate(value: string, locale: Locale): string {
  try {
    return new Intl.DateTimeFormat(locale === "ar" ? "ar" : "en", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

export function InterviewsWorkspace() {
  const { csrfToken } = useDashboardSession();
  const { direction, locale, t } = useLocale();

  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [sessions, setSessions] = useState<InterviewSession[]>([]);
  const [candidateId, setCandidateId] = useState("");
  const [requiredGermanLevel, setRequiredGermanLevel] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState("");

  const loadWorkspace = useCallback(async () => {
    setIsLoading(true);
    setError("");
    try {
      const [candidatesResponse, sessionsResponse] = await Promise.all([
        fetch(`${apiBaseUrl}/candidates`, { credentials: "include", cache: "no-store" }),
        fetch(`${apiBaseUrl}/interviews`, { credentials: "include", cache: "no-store" }),
      ]);
      if (!candidatesResponse.ok || !sessionsResponse.ok) {
        setError(t.interviews.loadFailed);
        return;
      }
      setCandidates((await candidatesResponse.json()) as Candidate[]);
      setSessions((await sessionsResponse.json()) as InterviewSession[]);
    } catch {
      setError(t.interviews.loadFailed);
    } finally {
      setIsLoading(false);
    }
  }, [t.interviews.loadFailed]);

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  async function createSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!candidateId) {
      setError(t.interviews.noCandidates);
      return;
    }

    setError("");
    setIsCreating(true);
    try {
      const response = await fetch(`${apiBaseUrl}/interviews`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({
          candidate_id: candidateId,
          required_german_level: requiredGermanLevel || null,
        }),
      });
      if (!response.ok) {
        setError(t.interviews.createFailed);
        return;
      }

      const session = (await response.json()) as InterviewSession;
      setSessions((current) => [session, ...current]);
      setCandidateId("");
      setRequiredGermanLevel("");
    } catch {
      setError(t.interviews.createFailed);
    } finally {
      setIsCreating(false);
    }
  }

  const filteredSessions = useMemo(
    () => filterInterviewSessions(sessions, searchQuery),
    [sessions, searchQuery],
  );

  return (
    <div className="space-y-6 sm:space-y-8">
      {/* Page Header */}
      <div>
        <div className="flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-lg bg-primary/10 text-primary">
            <Icon className="size-5" name="interviews" />
          </span>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
              {t.interviews.title}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t.interviews.description}
            </p>
          </div>
        </div>
      </div>

      {/* Main Grid: Create Interview + Interview Sessions Directory */}
      <div className="grid gap-6 xl:grid-cols-[380px_1fr]">
        {/* Left Column: Create Interview Card */}
        <section className="rounded-xl border border-border bg-card p-5 text-card-foreground shadow-sm sm:p-6">
          <div className="flex items-center gap-2.5">
            <span className="grid size-8 place-items-center rounded-md bg-primary/10 text-primary">
              <Icon className="size-4" name="calendar" />
            </span>
            <h2 className="text-base font-semibold text-foreground">
              {t.interviews.createSession}
            </h2>
          </div>

          <form className="mt-5 space-y-4" onSubmit={createSession}>
            <div>
              <label
                className="block text-xs font-medium text-foreground"
                htmlFor="interview-candidate"
              >
                {t.interviews.candidate}
              </label>
              <select
                className="mt-1.5 min-h-11 w-full rounded-md border border-input bg-background px-3 py-1 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                disabled={candidates.length === 0 || isCreating}
                id="interview-candidate"
                onChange={(event) => setCandidateId(event.target.value)}
                required
                value={candidateId}
              >
                <option value="">{t.interviews.selectCandidate}</option>
                {candidates.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.given_name} {candidate.family_name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                className="block text-xs font-medium text-foreground"
                htmlFor="required-german-level"
              >
                {t.interviews.requiredLevel}
              </label>
              <select
                className="mt-1.5 min-h-11 w-full rounded-md border border-input bg-background px-3 py-1 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                disabled={isCreating}
                id="required-german-level"
                onChange={(event) => setRequiredGermanLevel(event.target.value)}
                value={requiredGermanLevel}
              >
                <option value="">{t.interviews.notConfigured}</option>
                <option value="A1">A1</option>
                <option value="A2">A2</option>
                <option value="B1">B1</option>
                <option value="B2">B2</option>
                <option value="C1">C1</option>
                <option value="C2">C2</option>
              </select>
            </div>

            {candidates.length === 0 && !isLoading ? (
              <p className="text-xs text-amber-700 dark:text-amber-300">{t.interviews.noCandidates}</p>
            ) : null}

            {error ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                {error}
              </div>
            ) : null}

            <button
              className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={candidates.length === 0 || isCreating}
              type="submit"
            >
              {isCreating ? (
                <>
                  <span className="size-3 animate-spin rounded-full border border-primary-foreground border-t-transparent" />
                  {t.interviews.creating}
                </>
              ) : (
                <>
                  <Icon className="size-3.5" name="calendar" />
                  {t.interviews.create}
                </>
              )}
            </button>
          </form>
        </section>

        {/* Right Column: Interview Sessions Directory */}
        <section className="rounded-xl border border-border bg-card p-5 text-card-foreground shadow-sm sm:p-6">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
            <div className="flex items-center gap-2.5">
              <h2 className="text-base font-semibold text-foreground">
                {t.interviews.details}
              </h2>
              <span className="rounded-full border border-border bg-secondary px-2.5 py-0.5 text-xs font-medium text-secondary-foreground">
                {t.interviews.totalSessions.replace("{count}", String(sessions.length))}
              </span>
            </div>

            {/* Search Input */}
            <div className="relative w-full sm:max-w-xs">
              <span className="pointer-events-none absolute inset-y-0 start-0 grid w-9 place-items-center text-muted-foreground">
                <Icon className="size-3.5" name="search" />
              </span>
              <input
                aria-label={t.interviews.searchPlaceholder}
                className="min-h-11 w-full rounded-md border border-input bg-background py-1.5 pe-4 ps-9 text-sm text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t.interviews.searchPlaceholder}
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
          ) : error && sessions.length === 0 ? (
            <div className="mt-6 rounded-lg border border-destructive/30 bg-destructive/5 p-8 text-center text-xs text-destructive">
              <p>{error}</p>
              <button
                className="mt-3 min-h-10 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90"
                onClick={() => void loadWorkspace()}
                type="button"
              >
                {t.dashboard.loading}
              </button>
            </div>
          ) : sessions.length === 0 ? (
            <div className="mt-6 grid min-h-60 place-items-center rounded-lg border border-dashed border-border bg-muted/20 p-8 text-center text-xs text-muted-foreground">
              <div>
                <Icon className="mx-auto size-8 text-muted-foreground/50" name="interviews" />
                <p className="mt-2 text-sm font-medium text-foreground">{t.interviews.noSessions}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t.interviews.description}</p>
              </div>
            </div>
          ) : filteredSessions.length === 0 ? (
            <div className="mt-6 grid min-h-60 place-items-center rounded-lg border border-dashed border-border bg-muted/20 p-8 text-center text-xs text-muted-foreground">
              <div>
                <Icon className="mx-auto size-6 text-muted-foreground/50" name="search" />
                <p className="mt-2 text-sm font-medium text-foreground">{t.interviews.noMatchingSessions}</p>
              </div>
            </div>
          ) : (
            <div className="mt-6 overflow-x-auto">
              <div className="min-w-full divide-y divide-border/60">
                {/* Table Header (hidden on mobile) */}
                <div className="hidden grid-cols-12 gap-3 pb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground sm:grid">
                  <div className="col-span-5">{t.interviews.candidate}</div>
                  <div className="col-span-2">{t.interviews.status}</div>
                  <div className="col-span-3">{t.interviews.created}</div>
                  <div className="col-span-2 text-end">{t.candidates.actions}</div>
                </div>

                {/* Session Rows */}
                {filteredSessions.map((session) => {
                  const candidateName = session.candidate
                    ? `${session.candidate.given_name} ${session.candidate.family_name}`
                    : "—";
                  const candidateEmail = session.candidate?.email ?? "";
                  const initials = session.candidate
                    ? `${session.candidate.given_name.charAt(0)}${session.candidate.family_name.charAt(0)}`
                    : "?";
                  const statusKey =
                    session.status === "in_progress" ? "inProgress" : session.status;
                  const statusLabelText =
                    (t.interviews as Record<string, string>)[statusKey] ?? session.status;

                  return (
                    <div
                      className="flex flex-col justify-between gap-3 py-3.5 sm:grid sm:grid-cols-12 sm:items-center sm:gap-3"
                      key={session.id}
                    >
                      {/* Candidate Name & Info */}
                      <div className="col-span-5 flex items-center gap-3 min-w-0">
                        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                          {initials}
                        </span>
                        <div className="min-w-0">
                          <p className="truncate text-xs font-semibold text-foreground">
                            {candidateName}
                          </p>
                          <div className="mt-0.5 flex flex-wrap items-center gap-2">
                            <span className="truncate text-[11px] text-muted-foreground font-mono" dir="ltr">
                              {candidateEmail}
                            </span>
                            {session.required_german_level ? (
                              <span className="rounded border border-primary/20 bg-primary/10 px-1.5 py-0.2 font-mono text-[10px] font-medium text-primary">
                                Req: {session.required_german_level}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </div>

                      {/* Status */}
                      <div className="col-span-2">
                        <span
                          className={`inline-flex rounded-md border px-2 py-0.5 text-[11px] font-medium ${getInterviewStatusBadgeClass(
                            session.status,
                          )}`}
                        >
                          {statusLabelText}
                        </span>
                      </div>

                      {/* Date Created */}
                      <div className="col-span-3 text-[11px] text-muted-foreground">
                        {formatSessionDate(session.created_at, locale)}
                      </div>

                      {/* Action */}
                      <div className="col-span-2 flex items-center justify-end">
                        <Link
                          className="inline-flex min-h-9 items-center gap-1 rounded-md border border-input bg-background px-2.5 py-1 text-[11px] font-medium text-foreground shadow-sm transition hover:bg-accent hover:text-accent-foreground"
                          href={`/dashboard/interviews/${session.id}`}
                        >
                          <span>{t.interviews.viewDetails}</span>
                          <Icon
                            className={`size-3 text-muted-foreground ${direction === "rtl" ? "rotate-180" : ""}`}
                            name="chevron"
                          />
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
