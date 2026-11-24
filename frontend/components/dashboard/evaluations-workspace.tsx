"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Icon } from "@/components/dashboard/icons";
import { useDashboardSession } from "@/components/dashboard/dashboard-shell";
import type { InterviewSession } from "@/components/dashboard/interviews-workspace";
import {
  type AssessmentStatus,
  type CEFRLevel,
  type GermanAssessmentData,
  type LanguageRecommendationState,
  getAssessmentRetryUrl,
  getAssessmentUrl,
  getRecommendationBadgeClass,
} from "@/components/dashboard/recordings-workspace";
import { apiBaseUrl } from "@/lib/auth";
import { type Locale, useLocale } from "@/lib/i18n";

export type EvaluationSummaryItem = {
  interview_session_id: string;
  candidate_id?: string | null;
  candidate_name?: string | null;
  candidate_email?: string | null;
  assessment_status: AssessmentStatus;
  estimated_cefr_level?: CEFRLevel | null;
  overall_score?: number | null;
  summary?: string | null;
  candidate_claimed_level?: string | null;
  required_german_level?: CEFRLevel | null;
  recommendation_state?: LanguageRecommendationState | null;
  recommendation_explanation?: string | null;
  evaluated_at?: string | null;
  insufficient_evidence_reason?: string | null;
};

export function filterEvaluations(
  evaluations: EvaluationSummaryItem[],
  query: string,
  statusFilter: string,
): EvaluationSummaryItem[] {
  const q = query.trim().toLowerCase();
  return evaluations.filter((item) => {
    // Status filter
    if (statusFilter !== "all" && item.assessment_status !== statusFilter) {
      return false;
    }
    // Search query filter
    if (!q) {
      return true;
    }
    const name = (item.candidate_name ?? "").toLowerCase();
    const email = (item.candidate_email ?? "").toLowerCase();
    const cefr = (item.estimated_cefr_level ?? "").toLowerCase();
    return name.includes(q) || email.includes(q) || cefr.includes(q);
  });
}

export function computeEvaluationKPIs(evaluations: EvaluationSummaryItem[]): {
  totalEvaluated: number;
  averageScore: number | null;
  insufficientCount: number;
  pendingCount: number;
} {
  const completed = evaluations.filter((e) => e.assessment_status === "completed");
  const scores = completed
    .map((e) => e.overall_score)
    .filter((s): s is number => typeof s === "number" && !isNaN(s));

  const averageScore =
    scores.length > 0 ? scores.reduce((sum, val) => sum + val, 0) / scores.length : null;

  return {
    totalEvaluated: completed.length,
    averageScore,
    insufficientCount: evaluations.filter((e) => e.assessment_status === "insufficient_evidence").length,
    pendingCount: evaluations.filter((e) => e.assessment_status === "pending").length,
  };
}

export function getEvaluationStatusBadgeClass(status: AssessmentStatus): string {
  switch (status) {
    case "completed":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "pending":
      return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "insufficient_evidence":
      return "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-400";
    case "failed":
      return "border-destructive/30 bg-destructive/10 text-destructive";
    default:
      return "border-border bg-muted/60 text-muted-foreground";
  }
}

export function formatEvaluationDate(value: string | null | undefined, locale: Locale): string {
  if (!value) return "—";
  try {
    return new Intl.DateTimeFormat(locale === "ar" ? "ar" : "en", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

export function EvaluationsWorkspace() {
  const { csrfToken } = useDashboardSession();
  const { direction, locale, t } = useLocale();

  const [evaluations, setEvaluations] = useState<EvaluationSummaryItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [retryingIds, setRetryingIds] = useState<Record<string, boolean>>({});

  const loadEvaluations = useCallback(async () => {
    setIsLoading(true);
    setError("");
    try {
      const interviewsResponse = await fetch(`${apiBaseUrl}/interviews`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!interviewsResponse.ok) {
        throw new Error("Failed to load interview sessions");
      }
      const sessions = (await interviewsResponse.json()) as InterviewSession[];

      // Filter sessions that have recordings or are completed
      const relevantSessions = sessions.filter(
        (s) => s.status === "completed" || s.has_recording,
      );

      // Fetch assessments for each relevant interview in parallel
      const assessmentResults = await Promise.allSettled(
        relevantSessions.map(async (session) => {
          const res = await fetch(getAssessmentUrl(apiBaseUrl, session.id), {
            credentials: "include",
            cache: "no-store",
          });
          if (!res.ok) {
            return null;
          }
          const assessment = (await res.json()) as GermanAssessmentData;
          const candidateName = session.candidate
            ? `${session.candidate.given_name} ${session.candidate.family_name}`
            : assessment.candidate_name ?? "—";
          const candidateEmail = session.candidate?.email ?? "";

          return {
            interview_session_id: session.id,
            candidate_id: session.candidate?.id ?? assessment.candidate_id,
            candidate_name: candidateName,
            candidate_email: candidateEmail,
            assessment_status: assessment.assessment_status,
            estimated_cefr_level: assessment.estimated_cefr_level ?? null,
            overall_score: assessment.overall_score ?? null,
            summary: assessment.summary ?? null,
            candidate_claimed_level: assessment.candidate_claimed_level ?? null,
            required_german_level:
              assessment.required_german_level ??
              (session.required_german_level as CEFRLevel | null) ??
              null,
            recommendation_state: assessment.recommendation?.recommendation_state ?? null,
            recommendation_explanation: assessment.recommendation?.explanation ?? null,
            evaluated_at: assessment.evaluated_at ?? session.completed_at ?? session.created_at,
            insufficient_evidence_reason: assessment.insufficient_evidence_reason ?? null,
          } as EvaluationSummaryItem;
        }),
      );

      const items: EvaluationSummaryItem[] = [];
      for (const res of assessmentResults) {
        if (res.status === "fulfilled" && res.value !== null) {
          items.push(res.value);
        }
      }

      setEvaluations(items);
    } catch {
      setError(t.recordingsWorkspace.loadFailed);
    } finally {
      setIsLoading(false);
    }
  }, [t.recordingsWorkspace.loadFailed]);

  useEffect(() => {
    void loadEvaluations();
  }, [loadEvaluations]);

  const handleRetryAssessment = useCallback(
    async (interviewId: string) => {
      setRetryingIds((prev) => ({ ...prev, [interviewId]: true }));
      try {
        const response = await fetch(getAssessmentRetryUrl(apiBaseUrl, interviewId), {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
        });
        if (response.ok) {
          const updated = (await response.json()) as GermanAssessmentData;
          setEvaluations((prev) =>
            prev.map((item) =>
              item.interview_session_id === interviewId
                ? {
                    ...item,
                    assessment_status: updated.assessment_status,
                    estimated_cefr_level: updated.estimated_cefr_level ?? null,
                    overall_score: updated.overall_score ?? null,
                    summary: updated.summary ?? null,
                  }
                : item,
            ),
          );
        }
      } catch {
        // Retain current state
      } finally {
        setRetryingIds((prev) => ({ ...prev, [interviewId]: false }));
      }
    },
    [csrfToken],
  );

  const kpis = useMemo(() => computeEvaluationKPIs(evaluations), [evaluations]);

  const filteredEvaluations = useMemo(
    () => filterEvaluations(evaluations, searchQuery, statusFilter),
    [evaluations, searchQuery, statusFilter],
  );

  return (
    <div className="space-y-6 sm:space-y-8">
      {/* Page Header */}
      <div>
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div className="flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-lg bg-primary/10 text-primary">
              <Icon className="size-5" name="evaluations" />
            </span>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
                {t.evaluations.title}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {t.evaluations.description}
              </p>
            </div>
          </div>

          <Link
            className="inline-flex items-center gap-1.5 self-start sm:self-auto rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium text-foreground shadow-sm transition hover:bg-accent hover:text-accent-foreground"
            href="/dashboard/recordings"
          >
            <Icon className="size-3.5 text-muted-foreground" name="folder" />
            <span>{t.recordingsWorkspace.title}</span>
          </Link>
        </div>
      </div>

      {/* KPI Cards Grid */}
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* Total Evaluated */}
        <div className="rounded-xl border border-border bg-card p-5 text-card-foreground shadow-sm sm:p-6">
          <div className="flex items-center justify-between pb-2">
            <p className="text-xs font-medium tracking-tight text-muted-foreground">
              {t.evaluations.totalEvaluated}
            </p>
            <span className="grid size-8 place-items-center rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <Icon className="size-4" name="check" />
            </span>
          </div>
          <div className="text-2xl font-bold tracking-tight text-foreground">
            {isLoading ? "…" : kpis.totalEvaluated}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t.recordingsWorkspace.statusCompleted}
          </p>
        </div>

        {/* Average Score */}
        <div className="rounded-xl border border-border bg-card p-5 text-card-foreground shadow-sm sm:p-6">
          <div className="flex items-center justify-between pb-2">
            <p className="text-xs font-medium tracking-tight text-muted-foreground">
              {t.evaluations.averageScore}
            </p>
            <span className="grid size-8 place-items-center rounded-md bg-primary/10 text-primary">
              <Icon className="size-4" name="evaluations" />
            </span>
          </div>
          <div className="text-2xl font-bold tracking-tight text-primary">
            {isLoading ? "…" : kpis.averageScore !== null ? `${kpis.averageScore.toFixed(1)} / 100` : "—"}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t.recordingsWorkspace.overallScore}
          </p>
        </div>

        {/* Insufficient Evidence */}
        <div className="rounded-xl border border-border bg-card p-5 text-card-foreground shadow-sm sm:p-6">
          <div className="flex items-center justify-between pb-2">
            <p className="text-xs font-medium tracking-tight text-muted-foreground">
              {t.evaluations.insufficientEvidence}
            </p>
            <span className="grid size-8 place-items-center rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400">
              <Icon className="size-4" name="clipboard" />
            </span>
          </div>
          <div className="text-2xl font-bold tracking-tight text-foreground">
            {isLoading ? "…" : kpis.insufficientCount}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t.recordingsWorkspace.statusInsufficient}
          </p>
        </div>

        {/* Pending / Analyzing */}
        <div className="rounded-xl border border-border bg-card p-5 text-card-foreground shadow-sm sm:p-6">
          <div className="flex items-center justify-between pb-2">
            <p className="text-xs font-medium tracking-tight text-muted-foreground">
              {t.evaluations.pendingCount}
            </p>
            <span className="grid size-8 place-items-center rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400">
              <Icon className="size-4" name="activity" />
            </span>
          </div>
          <div className="text-2xl font-bold tracking-tight text-foreground">
            {isLoading ? "…" : kpis.pendingCount}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t.recordingsWorkspace.statusAnalyzing}
          </p>
        </div>
      </section>

      {/* Filter Tabs and Search Bar */}
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        {/* Status filter tabs */}
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-muted/40 p-1">
          {[
            { id: "all", label: t.evaluations.filterAll },
            { id: "completed", label: t.evaluations.filterCompleted },
            { id: "pending", label: t.evaluations.filterPending },
            { id: "insufficient_evidence", label: t.evaluations.filterInsufficient },
            { id: "failed", label: t.evaluations.filterFailed },
          ].map((tab) => (
            <button
              className={`rounded-md px-3 py-1 text-xs font-medium transition ${
                statusFilter === tab.id
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              key={tab.id}
              onClick={() => setStatusFilter(tab.id)}
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Search Input */}
        <div className="relative w-full sm:max-w-xs">
          <span className="pointer-events-none absolute inset-y-0 start-0 grid w-9 place-items-center text-muted-foreground">
            <Icon className="size-3.5" name="search" />
          </span>
          <input
            aria-label={t.evaluations.searchPlaceholder}
            className="h-9 w-full rounded-md border border-input bg-background py-1.5 pe-4 ps-9 text-xs text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t.evaluations.searchPlaceholder}
            type="text"
            value={searchQuery}
          />
        </div>
      </div>

      {/* Evaluations Content */}
      {isLoading ? (
        <div className="flex min-h-60 items-center justify-center gap-2 rounded-xl border border-border bg-card p-8 text-xs text-muted-foreground shadow-sm">
          <span className="size-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <span>{t.dashboard.loading}</span>
        </div>
      ) : error ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-8 text-center text-xs text-destructive">
          <p>{error}</p>
          <button
            className="mt-3 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90"
            onClick={() => void loadEvaluations()}
            type="button"
          >
            {t.dashboard.loading}
          </button>
        </div>
      ) : evaluations.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-12 text-center shadow-sm">
          <span className="mx-auto grid size-12 place-items-center rounded-xl border border-border bg-muted/60 text-muted-foreground">
            <Icon className="size-6" name="evaluations" />
          </span>
          <h2 className="mt-4 text-base font-semibold text-foreground">
            {t.evaluations.noEvaluations}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {t.evaluations.noEvaluationsDescription}
          </p>
        </div>
      ) : filteredEvaluations.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-12 text-center shadow-sm">
          <span className="mx-auto grid size-12 place-items-center rounded-xl border border-border bg-muted/60 text-muted-foreground">
            <Icon className="size-6" name="search" />
          </span>
          <h2 className="mt-4 text-base font-semibold text-foreground">
            {t.evaluations.noMatchingEvaluations}
          </h2>
        </div>
      ) : (
        <div className="space-y-4">
          {filteredEvaluations.map((item) => {
            const isCompleted = item.assessment_status === "completed";
            const isPending = item.assessment_status === "pending";
            const isInsufficient = item.assessment_status === "insufficient_evidence";
            const isFailed = item.assessment_status === "failed";
            const isRetrying = retryingIds[item.interview_session_id] === true;

            const initials = item.candidate_name
              ? item.candidate_name
                  .split(" ")
                  .map((p) => p.charAt(0))
                  .join("")
                  .slice(0, 2)
                  .toUpperCase()
              : "?";

            const statusLabelText = isCompleted
              ? t.recordingsWorkspace.statusCompleted
              : isPending
                ? t.recordingsWorkspace.statusAnalyzing
                : isInsufficient
                  ? t.recordingsWorkspace.statusInsufficient
                  : isFailed
                    ? t.recordingsWorkspace.statusFailed
                    : item.assessment_status;

            return (
              <article
                className="rounded-xl border border-border bg-card p-5 text-card-foreground shadow-sm transition hover:border-border/80 sm:p-6"
                key={item.interview_session_id}
              >
                {/* Header row */}
                <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                  <div className="flex items-center gap-3">
                    <span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                      {initials}
                    </span>
                    <div>
                      <h3 className="text-base font-semibold text-foreground">
                        {item.candidate_name}
                      </h3>
                      <p className="text-xs text-muted-foreground font-mono" dir="ltr">
                        {item.candidate_email}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2.5">
                    <span className="text-xs text-muted-foreground">
                      {formatEvaluationDate(item.evaluated_at, locale)}
                    </span>
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium ${getEvaluationStatusBadgeClass(
                        item.assessment_status,
                      )}`}
                    >
                      {statusLabelText}
                    </span>
                  </div>
                </div>

                {/* Metric Cards Row */}
                <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
                  {/* Claimed Level (CV) */}
                  <div className="rounded-xl border border-border bg-muted/30 p-3.5">
                    <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                      {t.recordingsWorkspace.claimedLevel}
                    </p>
                    <div className="mt-1 flex items-baseline gap-1.5">
                      <span className="font-mono text-lg font-bold text-foreground">
                        {item.candidate_claimed_level || t.recordingsWorkspace.notSpecified}
                      </span>
                    </div>
                  </div>

                  {/* Demonstrated CEFR Level */}
                  <div className="rounded-xl border border-primary/20 bg-primary/5 dark:bg-primary/10 p-3.5">
                    <p className="text-[11px] font-medium uppercase tracking-wider text-primary">
                      {t.recordingsWorkspace.assessedLevel}
                    </p>
                    <div className="mt-1 flex items-baseline gap-1.5">
                      <span className="font-mono text-xl font-bold text-primary">
                        {item.estimated_cefr_level ?? (isInsufficient ? "—" : isPending ? "…" : "—")}
                      </span>
                      {item.estimated_cefr_level ? (
                        <span className="text-[11px] text-muted-foreground">CEFR</span>
                      ) : null}
                    </div>
                  </div>

                  {/* Demonstrated Score */}
                  <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 dark:bg-emerald-500/10 p-3.5">
                    <p className="text-[11px] font-medium uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                      {t.recordingsWorkspace.overallScore}
                    </p>
                    <div className="mt-1 flex items-baseline gap-1.5">
                      {typeof item.overall_score === "number" && !isNaN(item.overall_score) ? (
                        <>
                          <span className="font-mono text-xl font-bold text-emerald-600 dark:text-emerald-400">
                            {item.overall_score.toFixed(1)}
                          </span>
                          <span className="text-[11px] text-muted-foreground">/ 100</span>
                        </>
                      ) : (
                        <span className="font-mono text-lg font-semibold text-muted-foreground">—</span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Recommendation & Required Level */}
                {item.recommendation_state ? (
                  <div className="mt-3.5 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">
                        {t.recordingsWorkspace.requiredLevel}:
                      </span>
                      <span className="font-mono font-semibold text-foreground">
                        {item.required_german_level || t.recordingsWorkspace.notConfigured}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">
                        {t.recordingsWorkspace.recommendation}:
                      </span>
                      <span
                        className={`rounded-md border px-2 py-0.5 text-[11px] font-semibold ${getRecommendationBadgeClass(
                          item.recommendation_state,
                        )}`}
                      >
                        {item.recommendation_state === "meets_requirement"
                          ? t.recordingsWorkspace.meetsRequirement
                          : item.recommendation_state === "below_requirement"
                            ? t.recordingsWorkspace.belowRequirement
                            : item.recommendation_state === "insufficient_evidence"
                              ? t.recordingsWorkspace.insufficientRecommendation
                              : t.recordingsWorkspace.notConfiguredRecommendation}
                      </span>
                    </div>
                  </div>
                ) : null}

                {/* Rationale / Summary preview */}
                {item.summary ? (
                  <p className="mt-3 text-xs italic leading-relaxed text-muted-foreground">
                    &ldquo;{item.summary}&rdquo;
                  </p>
                ) : null}

                {item.insufficient_evidence_reason ? (
                  <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">
                    {item.insufficient_evidence_reason}
                  </p>
                ) : null}

                {/* Actions footer */}
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-3.5">
                  <Link
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
                    href="/dashboard/recordings"
                  >
                    <span>{t.evaluations.viewFullReport}</span>
                    <Icon
                      className={`size-3.5 ${direction === "rtl" ? "rotate-180" : ""}`}
                      name="chevron"
                    />
                  </Link>

                  {isFailed ? (
                    <button
                      className="inline-flex items-center gap-1.5 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-1 text-xs font-semibold text-destructive hover:bg-destructive/20 disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={isRetrying}
                      onClick={() => void handleRetryAssessment(item.interview_session_id)}
                      type="button"
                    >
                      {isRetrying ? (
                        <>
                          <span className="size-3 animate-spin rounded-full border border-destructive border-t-transparent" />
                          {t.recordingsWorkspace.retryingAssessment}
                        </>
                      ) : (
                        t.evaluations.retryAssessment
                      )}
                    </button>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
