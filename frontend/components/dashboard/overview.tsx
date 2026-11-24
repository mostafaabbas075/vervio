"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Icon, type IconName } from "@/components/dashboard/icons";
import { useDashboardSession } from "@/components/dashboard/dashboard-shell";
import { apiBaseUrl } from "@/lib/auth";
import { formatTranslation, type Locale, useLocale } from "@/lib/i18n";

export type CandidateSummary = {
  id: string;
  email: string;
  given_name: string;
  family_name: string;
  status: string;
  created_at: string;
};

export type InterviewSummary = {
  id: string;
  candidate: {
    id: string;
    email: string;
    given_name: string;
    family_name: string;
  };
  status: string;
  required_german_level?: string | null;
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  has_recording?: boolean;
};

export type OverviewKPIs = {
  totalCandidates: number;
  scheduledInterviews: number;
  completedInterviews: number;
  inProgressInterviews: number;
};

export function computeOverviewKPIs(
  candidates: CandidateSummary[],
  interviews: InterviewSummary[],
): OverviewKPIs {
  return {
    totalCandidates: candidates.length,
    scheduledInterviews: interviews.filter((i) => i.status === "scheduled").length,
    completedInterviews: interviews.filter((i) => i.status === "completed").length,
    inProgressInterviews: interviews.filter((i) => i.status === "in_progress").length,
  };
}

export function getStatusBreakdown(interviews: InterviewSummary[]): {
  completed: number;
  inProgress: number;
  scheduled: number;
  total: number;
} {
  const completed = interviews.filter((i) => i.status === "completed").length;
  const inProgress = interviews.filter((i) => i.status === "in_progress").length;
  const scheduled = interviews.filter((i) => i.status === "scheduled").length;
  return {
    completed,
    inProgress,
    scheduled,
    total: interviews.length,
  };
}

export function formatActivityDate(dateString: string, locale: Locale): string {
  try {
    return new Intl.DateTimeFormat(locale === "ar" ? "ar" : "en", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(dateString));
  } catch {
    return dateString;
  }
}

export function getInterviewStatusBadgeClass(status: string): string {
  switch (status.toLowerCase()) {
    case "completed":
      return "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "in_progress":
      return "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "scheduled":
      return "border-primary/20 bg-primary/10 text-primary";
    case "cancelled":
    default:
      return "border-border bg-muted/60 text-muted-foreground";
  }
}

type QuickLink = {
  href: string;
  icon: IconName;
  label: string;
};

export function Overview() {
  const { user } = useDashboardSession();
  const { locale, t } = useLocale();

  const [candidates, setCandidates] = useState<CandidateSummary[]>([]);
  const [interviews, setInterviews] = useState<InterviewSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const loadDashboardData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [candidatesRes, interviewsRes] = await Promise.allSettled([
        fetch(`${apiBaseUrl}/candidates`, { credentials: "include", cache: "no-store" }),
        fetch(`${apiBaseUrl}/interviews`, { credentials: "include", cache: "no-store" }),
      ]);

      if (candidatesRes.status === "fulfilled" && candidatesRes.value.ok) {
        const data = (await candidatesRes.value.json()) as CandidateSummary[];
        setCandidates(Array.isArray(data) ? data : []);
      }

      if (interviewsRes.status === "fulfilled" && interviewsRes.value.ok) {
        const data = (await interviewsRes.value.json()) as InterviewSummary[];
        setInterviews(Array.isArray(data) ? data : []);
      }
    } catch {
      // Gracefully retain existing state on error
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDashboardData();
  }, [loadDashboardData]);

  const kpis = useMemo(
    () => computeOverviewKPIs(candidates, interviews),
    [candidates, interviews],
  );

  const breakdown = useMemo(() => getStatusBreakdown(interviews), [interviews]);

  const quickLinks: QuickLink[] = useMemo(
    () => [
      { href: "/dashboard/candidates", icon: "candidates", label: t.overview.viewCandidates },
      { href: "/dashboard/interviews", icon: "interviews", label: t.overview.viewInterviews },
      { href: "/dashboard/recordings", icon: "recording", label: t.overview.viewRecordings },
    ],
    [t.overview.viewCandidates, t.overview.viewInterviews, t.overview.viewRecordings],
  );

  const recentInterviews = useMemo(
    () =>
      interviews
        .slice()
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .slice(0, 5),
    [interviews],
  );

  return (
    <div className="space-y-6 sm:space-y-8">
      {/* Header */}
      <div>
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {t.overview.eyebrow}
            </p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
              {formatTranslation(t.dashboard.welcome, { name: user.full_name })}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t.overview.description}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium text-foreground shadow-sm transition hover:bg-accent hover:text-accent-foreground"
              href="/dashboard/candidates"
            >
              <Icon className="size-3.5" name="candidates" />
              {t.overview.viewCandidates}
            </Link>
            <Link
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90"
              href="/dashboard/interviews"
            >
              <Icon className="size-3.5" name="interviews" />
              {t.overview.viewInterviews}
            </Link>
          </div>
        </div>
      </div>

      {/* KPI Cards Grid */}
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* Total Candidates */}
        <div className="rounded-xl border border-border bg-card p-5 text-card-foreground shadow-sm sm:p-6">
          <div className="flex items-center justify-between pb-2">
            <p className="text-xs font-medium tracking-tight text-muted-foreground">
              {t.overview.totalCandidates}
            </p>
            <span className="grid size-8 place-items-center rounded-md bg-primary/10 text-primary">
              <Icon className="size-4" name="candidates" />
            </span>
          </div>
          <div className="text-2xl font-bold tracking-tight text-foreground">
            {isLoading ? "…" : kpis.totalCandidates}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t.overview.activeCandidateProfiles}
          </p>
        </div>

        {/* Scheduled Interviews */}
        <div className="rounded-xl border border-border bg-card p-5 text-card-foreground shadow-sm sm:p-6">
          <div className="flex items-center justify-between pb-2">
            <p className="text-xs font-medium tracking-tight text-muted-foreground">
              {t.overview.scheduledInterviews}
            </p>
            <span className="grid size-8 place-items-center rounded-md bg-primary/10 text-primary">
              <Icon className="size-4" name="calendar" />
            </span>
          </div>
          <div className="text-2xl font-bold tracking-tight text-foreground">
            {isLoading ? "…" : kpis.scheduledInterviews}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t.overview.upcomingSessions}
          </p>
        </div>

        {/* Completed Interviews */}
        <div className="rounded-xl border border-border bg-card p-5 text-card-foreground shadow-sm sm:p-6">
          <div className="flex items-center justify-between pb-2">
            <p className="text-xs font-medium tracking-tight text-muted-foreground">
              {t.overview.completedInterviews}
            </p>
            <span className="grid size-8 place-items-center rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <Icon className="size-4" name="recording" />
            </span>
          </div>
          <div className="text-2xl font-bold tracking-tight text-emerald-600 dark:text-emerald-400">
            {isLoading ? "…" : kpis.completedInterviews}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t.overview.completedRecordings}
          </p>
        </div>

        {/* In-Progress Interviews */}
        <div className="rounded-xl border border-border bg-card p-5 text-card-foreground shadow-sm sm:p-6">
          <div className="flex items-center justify-between pb-2">
            <p className="text-xs font-medium tracking-tight text-muted-foreground">
              {t.overview.inProgress}
            </p>
            <span className="grid size-8 place-items-center rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400">
              <Icon className="size-4" name="activity" />
            </span>
          </div>
          <div className="text-2xl font-bold tracking-tight text-foreground">
            {isLoading ? "…" : kpis.inProgressInterviews}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t.overview.inProgressSessions}
          </p>
        </div>
      </section>

      {/* Main Content Grid: Recent Activity + Breakdown & Quick Access */}
      <section className="grid gap-6 lg:grid-cols-7">
        {/* Recent Activity (4 columns on lg) */}
        <article className="rounded-xl border border-border bg-card p-5 text-card-foreground shadow-sm sm:p-6 lg:col-span-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-foreground">
                {t.overview.recentActivity}
              </h2>
              <p className="text-xs text-muted-foreground">
                {t.overview.recentActivityDescription}
              </p>
            </div>
            <span className="grid size-8 place-items-center rounded-md bg-muted/60 text-muted-foreground">
              <Icon className="size-4" name="activity" />
            </span>
          </div>

          {isLoading ? (
            <div className="mt-6 flex min-h-44 items-center justify-center gap-2 rounded-lg border border-border bg-muted/20 p-6 text-xs text-muted-foreground">
              <span className="size-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <span>{t.dashboard.loading}</span>
            </div>
          ) : recentInterviews.length === 0 ? (
            <div className="mt-6 grid min-h-44 place-items-center rounded-lg border border-dashed border-border bg-muted/20 p-6 text-center text-xs text-muted-foreground">
              <div>
                <Icon className="mx-auto size-6 text-muted-foreground/60" name="clipboard" />
                <p className="mt-2">{t.overview.noActivity}</p>
              </div>
            </div>
          ) : (
            <div className="mt-5 divide-y divide-border/60">
              {recentInterviews.map((session) => {
                const candidateName = session.candidate
                  ? `${session.candidate.given_name} ${session.candidate.family_name}`
                  : "—";
                const candidateEmail = session.candidate?.email ?? "";
                const initials = session.candidate
                  ? `${session.candidate.given_name.charAt(0)}${session.candidate.family_name.charAt(0)}`
                  : "?";
                const statusKey =
                  session.status === "in_progress" ? "inProgress" : session.status;
                const statusLabel =
                  (t.interviews as Record<string, string>)[statusKey] ?? session.status;

                return (
                  <div
                    className="flex flex-col justify-between gap-3 py-3.5 first:pt-0 last:pb-0 sm:flex-row sm:items-center"
                    key={session.id}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                        {initials}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-xs font-medium text-foreground">
                          {candidateName}
                        </p>
                        <p className="truncate text-[11px] text-muted-foreground font-mono" dir="ltr">
                          {candidateEmail}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2.5 self-end sm:self-auto">
                      <span className="text-[11px] text-muted-foreground">
                        {formatActivityDate(session.created_at, locale)}
                      </span>
                      <span
                        className={`rounded-md border px-2 py-0.5 text-[11px] font-medium ${getInterviewStatusBadgeClass(
                          session.status,
                        )}`}
                      >
                        {statusLabel}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </article>

        {/* Right Column: Breakdown & Quick Access (3 columns on lg) */}
        <div className="space-y-6 lg:col-span-3">
          {/* Status Breakdown Card */}
          <article className="rounded-xl border border-border bg-card p-5 text-card-foreground shadow-sm sm:p-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold text-foreground">
                  {t.overview.interviewStatus}
                </h2>
                <p className="text-xs text-muted-foreground">
                  {breakdown.total > 0
                    ? `${breakdown.total} ${t.interviews.title.toLowerCase()}`
                    : t.overview.noData}
                </p>
              </div>
              <span className="grid size-8 place-items-center rounded-md bg-muted/60 text-muted-foreground">
                <Icon className="size-4" name="clipboard" />
              </span>
            </div>

            <div className="mt-5 space-y-3.5">
              {/* Completed */}
              <div>
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-foreground">{t.overview.completed}</span>
                  <span className="font-mono text-muted-foreground">
                    {isLoading ? "…" : breakdown.completed}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-emerald-500"
                    style={{
                      width: breakdown.total > 0 ? `${(breakdown.completed / breakdown.total) * 100}%` : "0%",
                    }}
                  />
                </div>
              </div>

              {/* In Progress */}
              <div>
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-foreground">{t.overview.inProgress}</span>
                  <span className="font-mono text-muted-foreground">
                    {isLoading ? "…" : breakdown.inProgress}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-amber-500"
                    style={{
                      width: breakdown.total > 0 ? `${(breakdown.inProgress / breakdown.total) * 100}%` : "0%",
                    }}
                  />
                </div>
              </div>

              {/* Scheduled */}
              <div>
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-foreground">{t.overview.scheduled}</span>
                  <span className="font-mono text-muted-foreground">
                    {isLoading ? "…" : breakdown.scheduled}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{
                      width: breakdown.total > 0 ? `${(breakdown.scheduled / breakdown.total) * 100}%` : "0%",
                    }}
                  />
                </div>
              </div>
            </div>
          </article>

          {/* Quick Access Card */}
          <article className="rounded-xl border border-border bg-card p-5 text-card-foreground shadow-sm sm:p-6">
            <div>
              <h2 className="text-base font-semibold text-foreground">
                {t.overview.quickAccess}
              </h2>
              <p className="text-xs text-muted-foreground">
                {t.overview.quickAccessDescription}
              </p>
            </div>

            <div className="mt-4 space-y-2">
              {quickLinks.map((link) => (
                <Link
                  className="group flex items-center justify-between rounded-lg border border-border bg-background p-2.5 text-xs font-medium text-foreground shadow-sm transition hover:bg-accent hover:text-accent-foreground"
                  href={link.href}
                  key={link.href}
                >
                  <span className="flex items-center gap-2.5">
                    <Icon className="size-4 text-primary" name={link.icon} />
                    <span>{link.label}</span>
                  </span>
                  <Icon
                    className="size-3.5 text-muted-foreground transition group-hover:text-foreground"
                    name="chevron"
                  />
                </Link>
              ))}
            </div>
          </article>
        </div>
      </section>
    </div>
  );
}
