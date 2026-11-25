"use client";

import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from "react";

import { Icon } from "@/components/dashboard/icons";
import { useDashboardSession } from "@/components/dashboard/dashboard-shell";
import { apiBaseUrl } from "@/lib/auth";
import { type Locale, useLocale } from "@/lib/i18n";

export type CandidateRecordingSummary = {
  id: string;
  candidate_id: string;
  full_name: string;
  email: string;
  recording_count: number;
};

export type RecordedInterviewEvaluation = {
  id: string;
  status: string;
  overall_score: number | null;
  assessed_german_level: string | null;
  summary: string | null;
  evaluated_at: string | null;
};

export type CandidateRecordedInterview = {
  interview_id: string;
  recording_id: string;
  candidate_id: string;
  date: string;
  storage_status: string;
  storage_provider?: string | null;
  duration_seconds?: number | null;
  byte_size?: number | null;
  content_type?: string | null;
  interview_status: string;
  evaluation_status: string;
  score?: number | null;
  evaluation?: RecordedInterviewEvaluation | null;
};

export type TranscriptSegmentItem = {
  id: string;
  interview_session_id: string;
  position: number;
  speaker: string;
  start_ms: number;
  end_ms: number;
  content: string;
  language: string;
  created_at?: string;
};

export type TranscriptData = {
  interview_session_id: string;
  language: string;
  segment_count: number;
  segments: TranscriptSegmentItem[];
};

export type CEFRLevel = "A1" | "A2" | "B1" | "B2" | "C1" | "C2";
export type AssessmentStatus = "pending" | "completed" | "insufficient_evidence" | "failed";
export type CriterionStatus = "evaluated" | "unavailable" | "insufficient_evidence";
export type LanguageRecommendationState =
  | "meets_requirement"
  | "below_requirement"
  | "insufficient_evidence"
  | "not_configured";

export type CriterionAssessmentItem = {
  criterion_code: string;
  label: string;
  status: CriterionStatus;
  score?: number | null;
  rationale?: string | null;
  unavailable_reason?: string | null;
};

export type GermanAssessmentCriteriaData = {
  grammar?: CriterionAssessmentItem;
  vocabulary?: CriterionAssessmentItem;
  comprehension?: CriterionAssessmentItem;
  fluency?: CriterionAssessmentItem;
  pronunciation?: CriterionAssessmentItem;
};

export type EvidenceItemData = {
  segment_position: number;
  speaker: string;
  quote: string;
  observation: string;
  criterion_code?: string | null;
  segment_id?: string | null;
};

export type GermanRecommendationData = {
  interview_session_id: string;
  required_german_level?: CEFRLevel | null;
  assessed_german_level?: CEFRLevel | null;
  recommendation_state: LanguageRecommendationState;
  explanation: string;
  candidate_id?: string | null;
  candidate_name?: string | null;
  candidate_claimed_level?: string | null;
  assessment_status: AssessmentStatus;
};

export type GermanAssessmentData = {
  id?: string | null;
  interview_session_id: string;
  assessment_status: AssessmentStatus;
  estimated_cefr_level?: CEFRLevel | null;
  overall_score?: number | null;
  summary?: string | null;
  criteria?: GermanAssessmentCriteriaData | null;
  strengths: string[];
  areas_for_improvement: string[];
  evidence: EvidenceItemData[];
  insufficient_evidence_reason?: string | null;
  evaluated_at?: string | null;
  candidate_id?: string | null;
  candidate_name?: string | null;
  candidate_claimed_level?: string | null;
  required_german_level?: CEFRLevel | null;
  recommendation?: GermanRecommendationData | null;
};

export const CRITERIA_KEYS = [
  "grammar",
  "vocabulary",
  "comprehension",
  "fluency",
  "pronunciation",
] as const;

export function formatDate(value: string, locale: Locale): string {
  try {
    return new Intl.DateTimeFormat(locale === "ar" ? "ar" : "en", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

export function formatDuration(seconds: number | null | undefined): string | null {
  if (typeof seconds !== "number" || seconds <= 0) {
    return null;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${remainingSeconds.toString().padStart(2, "0")}`;
}

export function formatBytes(bytes: number | null | undefined): string | null {
  if (typeof bytes !== "number" || bytes <= 0) {
    return null;
  }
  const megabytes = bytes / (1024 * 1024);
  return `${megabytes.toFixed(1)} MB`;
}

export function recordingCountLabel(
  count: number,
  labels: {
    oneRecording: string;
    twoRecordings: string;
    multipleRecordings: string;
  },
): string {
  if (count === 1) {
    return labels.oneRecording;
  }
  if (count === 2) {
    return labels.twoRecordings;
  }
  return labels.multipleRecordings.replace("{count}", String(count));
}

export function filterCandidates(
  candidates: CandidateRecordingSummary[],
  query: string,
): CandidateRecordingSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return candidates;
  }
  return candidates.filter(
    (candidate) =>
      candidate.full_name.toLowerCase().includes(q) ||
      candidate.email.toLowerCase().includes(q),
  );
}

export function getRecordingStreamUrl(baseUrl: string, interviewId: string): string {
  return `${baseUrl}/interviews/${encodeURIComponent(interviewId)}/recording/content`;
}

export function formatMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

export function formatSegmentTimestamp(
  startMs: number | null | undefined,
  endMs: number | null | undefined,
): string | null {
  const validStart = typeof startMs === "number" && !isNaN(startMs) && startMs >= 0 ? startMs : null;
  const validEnd = typeof endMs === "number" && !isNaN(endMs) && endMs >= 0 ? endMs : null;

  if ((validStart === null || validStart === 0) && (validEnd === null || validEnd === 0)) {
    return null;
  }

  const s = validStart ?? 0;
  const e = validEnd ?? s;

  if (e > s) {
    return `${formatMs(s)} – ${formatMs(e)}`;
  }
  return formatMs(s);
}

export function getTranscriptUrl(baseUrl: string, interviewId: string): string {
  return `${baseUrl}/interviews/${encodeURIComponent(interviewId)}/transcript`;
}

export function getSpeakerLabel(
  speaker: string,
  labels: {
    candidateSpeaker: string;
    interviewerSpeaker: string;
    systemSpeaker: string;
  },
): string {
  const norm = speaker.toLowerCase().trim();
  if (norm === "interviewer" || norm === "ai" || norm === "ai_interviewer") {
    return labels.interviewerSpeaker;
  }
  if (norm === "candidate" || norm === "user") {
    return labels.candidateSpeaker;
  }
  if (norm === "system") {
    return labels.systemSpeaker;
  }
  return speaker;
}

export function getAssessmentUrl(baseUrl: string, interviewId: string): string {
  return `${baseUrl}/interviews/${encodeURIComponent(interviewId)}/assessment`;
}

export function getAssessmentRetryUrl(baseUrl: string, interviewId: string): string {
  return `${baseUrl}/interviews/${encodeURIComponent(interviewId)}/assessment/retry`;
}

export function getRequirementUrl(baseUrl: string, interviewId: string): string {
  return `${baseUrl}/interviews/${encodeURIComponent(interviewId)}/requirement`;
}

export function shouldPollAssessment(status: AssessmentStatus | undefined): boolean {
  return status === "pending";
}

export function getCriterionDisplay(criterion: CriterionAssessmentItem | undefined): {
  isEvaluated: boolean;
  isUnavailable: boolean;
  isInsufficient: boolean;
  scoreText: string | null;
  reasonText: string | null;
} {
  if (!criterion) {
    return {
      isEvaluated: false,
      isUnavailable: true,
      isInsufficient: false,
      scoreText: null,
      reasonText: null,
    };
  }
  if (criterion.status === "insufficient_evidence") {
    return {
      isEvaluated: false,
      isUnavailable: false,
      isInsufficient: true,
      scoreText: null,
      reasonText: criterion.rationale ?? null,
    };
  }
  if (
    criterion.status === "unavailable" ||
    criterion.score === null ||
    criterion.score === undefined
  ) {
    return {
      isEvaluated: false,
      isUnavailable: true,
      isInsufficient: false,
      scoreText: null,
      reasonText: criterion.unavailable_reason ?? null,
    };
  }
  return {
    isEvaluated: true,
    isUnavailable: false,
    isInsufficient: false,
    scoreText: `${criterion.score.toFixed(0)}`,
    reasonText: criterion.rationale ?? null,
  };
}

export function getRecommendationBadgeClass(
  state: LanguageRecommendationState | undefined,
): string {
  switch (state) {
    case "meets_requirement":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "below_requirement":
      return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "insufficient_evidence":
      return "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-400";
    case "not_configured":
    default:
      return "border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-800/80 text-slate-700 dark:text-slate-300";
  }
}

function RecordingPlayerItem({
  item,
  locale,
}: {
  item: CandidateRecordedInterview;
  locale: Locale;
}) {
  const { csrfToken } = useDashboardSession();
  const { t } = useLocale();
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoadingVideo, setIsLoadingVideo] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoError, setVideoError] = useState(false);

  const [showTranscript, setShowTranscript] = useState(false);
  const [isLoadingTranscript, setIsLoadingTranscript] = useState(false);
  const [transcriptData, setTranscriptData] = useState<TranscriptData | null>(null);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);

  const [assessment, setAssessment] = useState<GermanAssessmentData | null>(null);
  const [isLoadingAssessment, setIsLoadingAssessment] = useState(true);
  const [assessmentError, setAssessmentError] = useState<string | null>(null);
  const [isRetryingAssessment, setIsRetryingAssessment] = useState(false);
  const [isUpdatingRequirement, setIsUpdatingRequirement] = useState(false);
  const [requirementError, setRequirementError] = useState<string | null>(null);
  const [showEvidence, setShowEvidence] = useState(true);

  const durationStr = formatDuration(item.duration_seconds);
  const fileSizeStr = formatBytes(item.byte_size);

  const fetchAssessment = useCallback(
    async (isPolling = false) => {
      if (!isPolling) {
        setIsLoadingAssessment(true);
      }
      setAssessmentError(null);
      try {
        const response = await fetch(getAssessmentUrl(apiBaseUrl, item.interview_id), {
          credentials: "include",
          cache: "no-store",
        });
        if (!response.ok) {
          throw new Error("Failed to load assessment");
        }
        const data = (await response.json()) as GermanAssessmentData;
        setAssessment(data);
        return data;
      } catch {
        setAssessmentError(t.recordingsWorkspace.assessmentLoadFailed);
        return null;
      } finally {
        if (!isPolling) {
          setIsLoadingAssessment(false);
        }
      }
    },
    [item.interview_id, t.recordingsWorkspace.assessmentLoadFailed],
  );

  useEffect(() => {
    let isMounted = true;
    let pollTimeout: ReturnType<typeof setTimeout> | null = null;

    if (!shouldPollAssessment(assessment?.assessment_status)) {
      return;
    }

    const runPoll = async () => {
      const data = await fetchAssessment(true);
      if (!isMounted) return;

      if (data && shouldPollAssessment(data.assessment_status)) {
        pollTimeout = setTimeout(() => {
          if (isMounted) {
            void runPoll();
          }
        }, 5000);
      }
    };

    pollTimeout = setTimeout(() => {
      if (isMounted) {
        void runPoll();
      }
    }, 5000);

    return () => {
      isMounted = false;
      if (pollTimeout) {
        clearTimeout(pollTimeout);
      }
    };
  }, [assessment?.assessment_status, fetchAssessment]);

  useEffect(() => {
    void fetchAssessment();
  }, [fetchAssessment]);

  const handleRetryAssessment = useCallback(async () => {
    if (isRetryingAssessment) {
      return;
    }
    setIsRetryingAssessment(true);
    setAssessmentError(null);

    // Optimistically update assessment status to pending so UI displays retrying/analyzing state immediately
    setAssessment((prev) =>
      prev
        ? { ...prev, assessment_status: "pending" }
        : {
            interview_session_id: item.interview_id,
            assessment_status: "pending",
            strengths: [],
            areas_for_improvement: [],
            evidence: [],
          },
    );

    try {
      const response = await fetch(getAssessmentRetryUrl(apiBaseUrl, item.interview_id), {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
      });

      if (response.ok) {
        const data = (await response.json()) as GermanAssessmentData;
        setAssessment(data);
      } else {
        await fetchAssessment();
      }
    } catch {
      await fetchAssessment();
    } finally {
      setIsRetryingAssessment(false);
    }
  }, [apiBaseUrl, csrfToken, fetchAssessment, isRetryingAssessment, item.interview_id]);

  const handleRequirementChange = useCallback(
    async (e: ChangeEvent<HTMLSelectElement>) => {
      const newLevel = e.target.value as CEFRLevel | "";
      setIsUpdatingRequirement(true);
      setRequirementError(null);
      try {
        const response = await fetch(getRequirementUrl(apiBaseUrl, item.interview_id), {
          method: "PATCH",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
          body: JSON.stringify({
            required_german_level: newLevel ? newLevel : null,
          }),
        });
        if (!response.ok) {
          throw new Error("Failed to update required level");
        }
        const updatedRecommendation = (await response.json()) as GermanRecommendationData;
        setAssessment((prev) =>
          prev
            ? {
                ...prev,
                required_german_level: updatedRecommendation.required_german_level ?? null,
                recommendation: updatedRecommendation,
              }
            : prev,
        );
      } catch {
        setRequirementError(t.recordingsWorkspace.updateRequirementFailed);
      } finally {
        setIsUpdatingRequirement(false);
      }
    },
    [csrfToken, item.interview_id, t.recordingsWorkspace.updateRequirementFailed],
  );

  const fetchTranscript = useCallback(async () => {
    setIsLoadingTranscript(true);
    setTranscriptError(null);
    try {
      const response = await fetch(
        getTranscriptUrl(apiBaseUrl, item.interview_id),
        { credentials: "include", cache: "no-store" },
      );
      if (!response.ok) {
        throw new Error("Failed to load transcript");
      }
      const data = (await response.json()) as TranscriptData;
      setTranscriptData(data);
    } catch {
      setTranscriptError(t.recordingsWorkspace.transcriptLoadFailed);
    } finally {
      setIsLoadingTranscript(false);
    }
  }, [item.interview_id, t.recordingsWorkspace.transcriptLoadFailed]);

  const handleToggleTranscript = useCallback(async () => {
    if (showTranscript) {
      setShowTranscript(false);
      return;
    }
    setShowTranscript(true);
    if (!transcriptData) {
      await fetchTranscript();
    }
  }, [fetchTranscript, showTranscript, transcriptData]);

  const handleTogglePlay = useCallback(async () => {
    if (isPlaying) {
      setIsPlaying(false);
      return;
    }

    if (videoUrl) {
      setIsPlaying(true);
      return;
    }

    setIsLoadingVideo(true);
    setVideoError(false);

    try {
      const response = await fetch(
        getRecordingStreamUrl(apiBaseUrl, item.interview_id),
        { credentials: "include", cache: "no-store" },
      );
      if (!response.ok) {
        throw new Error("Failed to load recording");
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      setVideoUrl(objectUrl);
      setIsPlaying(true);
    } catch {
      setVideoError(true);
    } finally {
      setIsLoadingVideo(false);
    }
  }, [isPlaying, item.interview_id, videoUrl]);

  useEffect(() => {
    return () => {
      if (videoUrl) {
        URL.revokeObjectURL(videoUrl);
      }
    };
  }, [videoUrl]);

  const assessmentStatus = assessment?.assessment_status;
  const isAssessmentCompleted = assessmentStatus === "completed";
  const isAssessmentPending = assessmentStatus === "pending";
  const isAssessmentInsufficient = assessmentStatus === "insufficient_evidence";
  const isAssessmentFailed = assessmentStatus === "failed";

  const interviewStatusKey =
    item.interview_status === "in_progress" ? "inProgress" : item.interview_status;
  const interviewStatusText =
    (t.interviews as Record<string, string>)[interviewStatusKey] ?? item.interview_status;

  return (
    <article className="rounded-xl border border-border bg-card p-5 text-card-foreground shadow-sm transition hover:border-border/80 sm:p-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-md border border-primary/20 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
              <Icon className="size-3.5" name="recording" />
              {item.storage_status === "available"
                ? t.interviews.recordingAvailable
                : item.storage_status}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
              <span className="size-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400" />
              {interviewStatusText}
            </span>
            {item.storage_provider ? (
              <span className="rounded-md border border-border bg-muted/60 px-2 py-0.5 text-[11px] font-mono text-muted-foreground">
                {item.storage_provider === "cloudflare_r2" ? "Cloudflare R2" : "Local Private"}
              </span>
            ) : null}
          </div>
          <p className="mt-2.5 text-sm font-medium text-foreground">
            {formatDate(item.date, locale)}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
            {durationStr ? <span>{t.recordingsWorkspace.duration}: {durationStr}</span> : null}
            {fileSizeStr ? <span>{t.recordingsWorkspace.fileSize}: {fileSizeStr}</span> : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            className="inline-flex items-center gap-2 rounded-md bg-primary px-3.5 py-2 text-xs font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={isLoadingVideo}
            onClick={() => void handleTogglePlay()}
            type="button"
          >
            <Icon className="size-4" name="recording" />
            {isLoadingVideo
              ? t.recordingsWorkspace.loadingVideo
              : isPlaying
                ? t.recordingsWorkspace.hideVideo
                : t.recordingsWorkspace.watchVideo}
          </button>
          <button
            className="inline-flex items-center gap-2 rounded-md border border-input bg-background px-3.5 py-2 text-xs font-medium text-foreground shadow-sm transition hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
            disabled={isLoadingTranscript}
            onClick={() => void handleToggleTranscript()}
            type="button"
          >
            <Icon className="size-4" name="transcript" />
            {isLoadingTranscript
              ? t.recordingsWorkspace.loadingTranscript
              : showTranscript
                ? t.recordingsWorkspace.hideTranscript
                : t.recordingsWorkspace.viewTranscript}
          </button>
        </div>
      </div>

      {videoError ? (
        <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
          {t.recordingsWorkspace.videoLoadFailed}
        </div>
      ) : null}

      {isPlaying && videoUrl ? (
        <div className="mt-5 overflow-hidden rounded-xl bg-black shadow-inner">
          <video
            autoPlay
            className="aspect-video w-full rounded-xl bg-black"
            controls
            playsInline
            src={videoUrl}
          />
        </div>
      ) : null}

      {/* German AI Language Assessment Section */}
      <div className="mt-6 border-t border-border pt-6">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
          <div className="flex items-center gap-2.5">
            <span className="grid size-7 place-items-center rounded-md bg-primary/10 text-primary">
              <Icon className="size-4" name="evaluations" />
            </span>
            <div>
              <h4 className="text-sm font-semibold text-foreground">
                {t.recordingsWorkspace.assessmentTitle}
              </h4>
              <p className="text-xs text-muted-foreground">
                {t.recordingsWorkspace.assessmentSubtitle}
              </p>
            </div>
          </div>

          <div>
            {isLoadingAssessment && !assessment ? (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/60 px-2.5 py-1 text-xs text-muted-foreground">
                <span className="size-3 animate-spin rounded-full border border-primary border-t-transparent" />
                {t.dashboard.loading}
              </span>
            ) : isRetryingAssessment ? (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-700 dark:text-amber-300">
                <span className="size-2 animate-ping rounded-full bg-amber-500" />
                {t.recordingsWorkspace.retryingAssessment}
              </span>
            ) : isAssessmentPending ? (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-700 dark:text-amber-300">
                <span className="size-2 animate-ping rounded-full bg-amber-500" />
                {t.recordingsWorkspace.statusAnalyzing}
              </span>
            ) : isAssessmentCompleted ? (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
                <span className="size-1.5 rounded-full bg-emerald-500" />
                {t.recordingsWorkspace.statusCompleted}
              </span>
            ) : isAssessmentInsufficient ? (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-700 dark:text-amber-300">
                {t.recordingsWorkspace.statusInsufficient}
              </span>
            ) : isAssessmentFailed ? (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1 text-xs font-medium text-destructive">
                {t.recordingsWorkspace.statusFailed}
              </span>
            ) : null}
          </div>
        </div>

        {assessmentError ? (
          <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 p-4 text-xs text-destructive">
            <p>{assessmentError}</p>
            <button
              className="mt-2 text-xs font-semibold text-primary underline hover:text-primary/80"
              onClick={() => void fetchAssessment()}
              type="button"
            >
              {t.recordingsWorkspace.retry}
            </button>
          </div>
        ) : null}

        {isAssessmentPending || isRetryingAssessment ? (
          <div className="mt-4 flex items-start gap-3 rounded-md border border-amber-500/20 bg-amber-500/5 p-4 text-xs text-amber-800 dark:text-amber-200">
            <span className="mt-0.5 size-4 shrink-0 animate-spin rounded-full border-2 border-amber-500 border-t-transparent" />
            <div>
              <p className="font-semibold text-amber-900 dark:text-amber-100">
                {isRetryingAssessment
                  ? t.recordingsWorkspace.retryingAssessment
                  : t.recordingsWorkspace.statusAnalyzing}
              </p>
              <p className="mt-0.5 text-amber-700/80 dark:text-amber-300/80">
                {t.recordingsWorkspace.pendingPollingHint}
              </p>
            </div>
          </div>
        ) : null}

        {isAssessmentInsufficient ? (
          <div className="mt-4 rounded-md border border-amber-500/20 bg-amber-500/5 p-4 text-xs text-amber-800 dark:text-amber-200">
            <p className="font-semibold text-amber-900 dark:text-amber-100">
              {t.recordingsWorkspace.insufficientEvidenceNotice}
            </p>
            {assessment?.insufficient_evidence_reason ? (
              <p className="mt-1 italic text-amber-700/90 dark:text-amber-300/90">
                {assessment.insufficient_evidence_reason}
              </p>
            ) : null}
          </div>
        ) : null}

        {isAssessmentFailed && !isRetryingAssessment ? (
          <div className="mt-4 rounded-md border border-destructive/20 bg-destructive/5 p-4 text-xs text-destructive">
            <p className="font-semibold">
              {t.recordingsWorkspace.failedNotice}
            </p>
            <p className="mt-1 text-destructive/90">
              {t.recordingsWorkspace.failedExplanation}
            </p>
            <button
              className="mt-2.5 inline-flex min-h-10 items-center gap-1.5 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-1 text-xs font-semibold text-destructive hover:bg-destructive/20 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={isRetryingAssessment}
              onClick={() => void handleRetryAssessment()}
              type="button"
            >
              {isRetryingAssessment ? (
                <>
                  <span className="size-3 animate-spin rounded-full border border-destructive border-t-transparent" />
                  {t.recordingsWorkspace.retryingAssessment}
                </>
              ) : (
                t.recordingsWorkspace.retry
              )}
            </button>
          </div>
        ) : null}

        {/* Level & Score Metric Cards: Claimed Level vs AI Assessed Level vs Score */}
        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {/* Candidate Claimed Level from CV */}
          <div className="rounded-xl border border-border bg-muted/30 p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {t.recordingsWorkspace.claimedLevel}
            </p>
            <div className="mt-1.5 flex items-baseline gap-2">
              <span className="font-mono text-xl font-bold text-foreground">
                {assessment?.candidate_claimed_level || t.recordingsWorkspace.notSpecified}
              </span>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {t.recordingsWorkspace.claimedLevelHint}
            </p>
          </div>

          {/* AI-Assessed CEFR Level */}
          <div className="rounded-xl border border-primary/20 bg-primary/5 dark:bg-primary/10 p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-primary">
              {t.recordingsWorkspace.assessedLevel}
            </p>
            <div className="mt-1.5 flex items-baseline gap-2">
              <span className="font-mono text-2xl font-bold text-primary">
                {assessment?.estimated_cefr_level ??
                  (isAssessmentInsufficient ? "—" : isAssessmentPending ? "…" : "—")}
              </span>
              {assessment?.estimated_cefr_level ? (
                <span className="text-xs text-muted-foreground">CEFR</span>
              ) : null}
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {t.recordingsWorkspace.assessedLevelHint}
            </p>
          </div>

          {/* Overall Score */}
          <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 dark:bg-emerald-500/10 p-4 sm:col-span-2 lg:col-span-1">
            <p className="text-[11px] font-medium uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
              {t.recordingsWorkspace.overallScore}
            </p>
            <div className="mt-1.5 flex items-baseline gap-2">
              {typeof assessment?.overall_score === "number" && !isNaN(assessment.overall_score) ? (
                <>
                  <span className="font-mono text-2xl font-bold text-emerald-600 dark:text-emerald-400">
                    {assessment.overall_score.toFixed(1)}
                  </span>
                  <span className="text-xs text-muted-foreground">/ 100</span>
                </>
              ) : (
                <span className="font-mono text-xl font-semibold text-muted-foreground">—</span>
              )}
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {isAssessmentCompleted
                ? t.recordingsWorkspace.statusCompleted
                : t.recordingsWorkspace.pendingEvaluation}
            </p>
          </div>
        </div>

        {/* Required Level Selector & Recommendation Card */}
        <div className="mt-4 rounded-xl border border-border bg-muted/20 p-4">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
            <div className="flex flex-wrap items-center gap-3">
              <label
                className="text-xs font-medium text-foreground"
                htmlFor={`req-select-${item.interview_id}`}
              >
                {t.recordingsWorkspace.requiredLevel}:
              </label>
              <select
                aria-label={t.recordingsWorkspace.requiredLevel}
                className="min-h-10 rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium text-foreground shadow-sm outline-none transition focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
                disabled={isUpdatingRequirement}
                id={`req-select-${item.interview_id}`}
                onChange={(e) => void handleRequirementChange(e)}
                value={assessment?.required_german_level ?? ""}
              >
                <option value="">{t.recordingsWorkspace.notConfigured}</option>
                <option value="A1">A1</option>
                <option value="A2">A2</option>
                <option value="B1">B1</option>
                <option value="B2">B2</option>
                <option value="C1">C1</option>
                <option value="C2">C2</option>
              </select>
              {isUpdatingRequirement ? (
                <span className="text-[11px] text-primary">
                  {t.recordingsWorkspace.updatingRequirement}
                </span>
              ) : null}
            </div>

            {/* Recommendation State Badge */}
            {assessment?.recommendation ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {t.recordingsWorkspace.recommendation}:
                </span>
                <span
                  className={`rounded-md border px-2.5 py-1 text-xs font-semibold ${getRecommendationBadgeClass(
                    assessment.recommendation.recommendation_state,
                  )}`}
                >
                  {assessment.recommendation.recommendation_state === "meets_requirement"
                    ? t.recordingsWorkspace.meetsRequirement
                    : assessment.recommendation.recommendation_state === "below_requirement"
                      ? t.recordingsWorkspace.belowRequirement
                      : assessment.recommendation.recommendation_state === "insufficient_evidence"
                        ? t.recordingsWorkspace.insufficientRecommendation
                        : t.recordingsWorkspace.notConfiguredRecommendation}
                </span>
              </div>
            ) : null}
          </div>

          {requirementError ? (
            <p className="mt-2 text-xs text-destructive">{requirementError}</p>
          ) : null}

          {assessment?.recommendation?.explanation ? (
            <p className="mt-3 border-t border-border/80 pt-2.5 text-xs text-foreground/90">
              {assessment.recommendation.explanation}
            </p>
          ) : null}
        </div>

        {/* Assessment Details: Summary, Strengths, Areas for Improvement, Criteria, Evidence */}
        {isAssessmentCompleted ? (
          <>
            {/* Evaluation Summary */}
            {assessment?.summary ? (
              <div className="mt-4 rounded-xl border border-border bg-muted/30 p-4 text-xs leading-relaxed text-foreground">
                <p className="font-semibold text-foreground">{t.recordingsWorkspace.summary}:</p>
                <p className="mt-1.5 italic text-muted-foreground">{assessment.summary}</p>
              </div>
            ) : null}

            {/* Strengths and Areas for Improvement */}
            {assessment &&
            (assessment.strengths.length > 0 || assessment.areas_for_improvement.length > 0) ? (
              <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                {assessment.strengths.length > 0 ? (
                  <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 dark:bg-emerald-950/20 p-4">
                    <h5 className="flex items-center gap-2 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
                      <span className="grid size-4 place-items-center rounded-full bg-emerald-500/20 text-emerald-600 dark:text-emerald-400">
                        ✓
                      </span>
                      {t.recordingsWorkspace.strengthsTitle}
                    </h5>
                    <ul className="mt-2.5 space-y-1.5 text-xs text-foreground/90">
                      {assessment.strengths.map((str, idx) => (
                        <li className="flex items-start gap-2" key={`str-${idx}`}>
                          <span className="mt-1 size-1.5 shrink-0 rounded-full bg-emerald-500" />
                          <span>{str}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {assessment.areas_for_improvement.length > 0 ? (
                  <div className="rounded-xl border border-primary/20 bg-primary/5 dark:bg-primary/10 p-4">
                    <h5 className="flex items-center gap-2 text-xs font-semibold text-primary">
                      <span className="grid size-4 place-items-center rounded-full bg-primary/20 text-primary">
                        →
                      </span>
                      {t.recordingsWorkspace.areasForImprovementTitle}
                    </h5>
                    <ul className="mt-2.5 space-y-1.5 text-xs text-foreground/90">
                      {assessment.areas_for_improvement.map((area, idx) => (
                        <li className="flex items-start gap-2" key={`area-${idx}`}>
                          <span className="mt-1 size-1.5 shrink-0 rounded-full bg-primary" />
                          <span>{area}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* Linguistic Criteria Grid */}
            {assessment?.criteria ? (
              <div className="mt-5 space-y-3">
                <h5 className="text-xs font-semibold uppercase tracking-wider text-foreground">
                  {t.recordingsWorkspace.criteriaTitle}
                </h5>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {CRITERIA_KEYS.map((key) => {
                    const criterion = assessment.criteria?.[key];
                    if (!criterion) return null;
                    const display = getCriterionDisplay(criterion);

                    return (
                      <div
                        className="flex flex-col justify-between rounded-xl border border-border bg-card p-4"
                        key={key}
                      >
                        <div>
                          <div className="flex items-start justify-between gap-2">
                            <span className="text-xs font-semibold text-card-foreground">
                              {criterion.label}
                            </span>
                            {display.isEvaluated && display.scoreText ? (
                              <span className="font-mono text-sm font-bold text-emerald-600 dark:text-emerald-400">
                                {display.scoreText}{" "}
                                <span className="text-[10px] text-muted-foreground">/ 100</span>
                              </span>
                            ) : display.isUnavailable ? (
                              <span className="rounded-md border border-border bg-muted/60 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                                {t.recordingsWorkspace.notAssessed}
                              </span>
                            ) : (
                              <span className="rounded-md border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                                {t.recordingsWorkspace.statusInsufficient}
                              </span>
                            )}
                          </div>

                          {display.isEvaluated &&
                          typeof criterion.score === "number" ? (
                            <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                              <div
                                className="h-full rounded-full bg-primary"
                                style={{
                                  width: `${Math.min(100, Math.max(0, criterion.score))}%`,
                                }}
                              />
                            </div>
                          ) : null}

                          <p className="mt-2.5 text-[11px] leading-relaxed text-muted-foreground">
                            {display.isUnavailable
                              ? display.reasonText ||
                                t.recordingsWorkspace.acousticAnalysisRequired
                              : display.reasonText || "—"}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {/* Transcript-Backed Evidence */}
            {assessment && assessment.evidence.length > 0 ? (
              <div className="mt-5 border-t border-border pt-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="grid size-6 place-items-center rounded-md bg-primary/10 text-primary">
                      <Icon className="size-3.5" name="clipboard" />
                    </span>
                    <h5 className="text-xs font-semibold text-foreground">
                      {t.recordingsWorkspace.evidenceTitle}
                    </h5>
                  </div>
                  <button
                    className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-2.5 py-1 text-[11px] font-medium text-foreground shadow-sm transition hover:bg-accent hover:text-accent-foreground"
                    onClick={() => setShowEvidence((prev) => !prev)}
                    type="button"
                  >
                    {showEvidence
                      ? t.recordingsWorkspace.hideEvidence
                      : t.recordingsWorkspace.showEvidence.replace(
                          "{count}",
                          String(assessment.evidence.length),
                        )}
                  </button>
                </div>

                {showEvidence ? (
                  <div className="mt-3.5 space-y-2.5">
                    {assessment.evidence.map((item, idx) => (
                      <div
                        className="rounded-xl border border-border bg-muted/20 p-3.5 transition hover:border-border/80"
                        key={`ev-${idx}`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="rounded-md border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-[11px] font-medium text-primary">
                              {t.recordingsWorkspace.turn} #{item.segment_position}
                            </span>
                            <span className="text-[11px] font-medium text-muted-foreground">
                              {getSpeakerLabel(item.speaker, t.recordingsWorkspace)}
                            </span>
                          </div>
                          {item.criterion_code ? (
                            <span className="rounded-md border border-border bg-muted/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                              {item.criterion_code}
                            </span>
                          ) : null}
                        </div>
                        <blockquote
                          className="mt-2.5 border-s-2 border-primary/60 ps-3 text-xs italic leading-relaxed text-foreground"
                          dir="ltr"
                          lang="de"
                        >
                          &ldquo;{item.quote}&rdquo;
                        </blockquote>
                        <p className="mt-2 text-xs text-foreground/90">
                          <span className="font-medium text-muted-foreground">
                            {t.recordingsWorkspace.observation}:{" "}
                          </span>
                          {item.observation}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      {showTranscript ? (
        <div className="mt-6 border-t border-border pt-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <span className="grid size-7 place-items-center rounded-md bg-primary/10 text-primary">
                <Icon className="size-4" name="transcript" />
              </span>
              <h4 className="text-sm font-semibold text-foreground">
                {t.recordingsWorkspace.transcriptTitle}
              </h4>
              <span className="rounded-md border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                {t.recordingsWorkspace.germanOriginal}
              </span>
            </div>
            {transcriptData && transcriptData.segments.length > 0 ? (
              <span className="rounded-full border border-border bg-muted/60 px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                {transcriptData.segments.length}{" "}
                {transcriptData.segments.length === 1 ? "turn" : "turns"}
              </span>
            ) : null}
          </div>

          {isLoadingTranscript ? (
            <div className="mt-4 flex items-center justify-center gap-2 rounded-xl border border-border bg-muted/30 p-6 text-xs text-muted-foreground">
              <span className="size-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <span>{t.recordingsWorkspace.loadingTranscript}</span>
            </div>
          ) : transcriptError ? (
            <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 p-4 text-xs text-destructive">
              <p>{transcriptError}</p>
              <button
                className="mt-2 text-xs font-semibold text-primary underline hover:text-primary/80"
                onClick={() => void fetchTranscript()}
                type="button"
              >
                {t.recordingsWorkspace.retry}
              </button>
            </div>
          ) : !transcriptData || transcriptData.segments.length === 0 ? (
            <div className="mt-4 rounded-xl border border-border bg-muted/30 p-6 text-center text-xs text-muted-foreground">
              <p>{t.recordingsWorkspace.noTranscript}</p>
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              {transcriptData.segments
                .slice()
                .sort((a, b) => a.position - b.position)
                .map((segment) => {
                  const isInterviewer =
                    segment.speaker.toLowerCase().trim() === "interviewer" ||
                    segment.speaker.toLowerCase().trim() === "ai" ||
                    segment.speaker.toLowerCase().trim() === "ai_interviewer";
                  const isCandidate =
                    segment.speaker.toLowerCase().trim() === "candidate" ||
                    segment.speaker.toLowerCase().trim() === "user";
                  const speakerLabel = getSpeakerLabel(segment.speaker, t.recordingsWorkspace);
                  const timestampStr = formatSegmentTimestamp(segment.start_ms, segment.end_ms);

                  return (
                    <div
                      className={`rounded-xl border p-4 transition ${
                        isInterviewer
                          ? "border-primary/20 bg-primary/5 dark:bg-primary/10"
                          : isCandidate
                            ? "border-emerald-500/20 bg-emerald-500/5 dark:bg-emerald-950/20"
                            : "border-border bg-muted/30"
                      }`}
                      key={segment.id || `seg-${segment.position}`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span
                          className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${
                            isInterviewer
                              ? "border border-primary/30 bg-primary/15 text-primary"
                              : isCandidate
                                ? "border border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                                : "border border-border bg-muted text-muted-foreground"
                          }`}
                        >
                          {speakerLabel}
                        </span>
                        {timestampStr ? (
                          <span className="font-mono text-[11px] text-muted-foreground">
                            {timestampStr}
                          </span>
                        ) : null}
                      </div>
                      <p
                        className="mt-2 text-sm leading-relaxed text-foreground"
                        dir="ltr"
                        lang="de"
                      >
                        {segment.content}
                      </p>
                    </div>
                  );
                })}
            </div>
          )}
        </div>
      ) : null}
    </article>
  );
}

export function RecordingsWorkspace() {
  const { direction, locale, t } = useLocale();
  const [candidates, setCandidates] = useState<CandidateRecordingSummary[]>([]);
  const [isLoadingCandidates, setIsLoadingCandidates] = useState(true);
  const [candidatesError, setCandidatesError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCandidate, setSelectedCandidate] = useState<CandidateRecordingSummary | null>(null);

  const [candidateRecordings, setCandidateRecordings] = useState<CandidateRecordedInterview[]>([]);
  const [isLoadingRecordings, setIsLoadingRecordings] = useState(false);
  const [recordingsError, setRecordingsError] = useState<string | null>(null);

  const loadCandidates = useCallback(async () => {
    setIsLoadingCandidates(true);
    setCandidatesError(null);
    try {
      const response = await fetch(`${apiBaseUrl}/recordings`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error("Failed to load recordings catalog");
      }
      const data = (await response.json()) as CandidateRecordingSummary[];
      setCandidates(Array.isArray(data) ? data : []);
    } catch {
      setCandidatesError(t.recordingsWorkspace.loadFailed);
    } finally {
      setIsLoadingCandidates(false);
    }
  }, [t.recordingsWorkspace.loadFailed]);

  useEffect(() => {
    void loadCandidates();
  }, [loadCandidates]);

  const loadFolderRecordings = useCallback(
    async (candidateId: string) => {
      setIsLoadingRecordings(true);
      setRecordingsError(null);
      try {
        const response = await fetch(`${apiBaseUrl}/recordings/${encodeURIComponent(candidateId)}`, {
          credentials: "include",
          cache: "no-store",
        });
        if (!response.ok) {
          throw new Error("Failed to load candidate recordings");
        }
        const data = (await response.json()) as CandidateRecordedInterview[];
        setCandidateRecordings(Array.isArray(data) ? data : []);
      } catch {
        setRecordingsError(t.recordingsWorkspace.folderLoadFailed);
      } finally {
        setIsLoadingRecordings(false);
      }
    },
    [t.recordingsWorkspace.folderLoadFailed],
  );

  const handleOpenFolder = useCallback(
    (candidate: CandidateRecordingSummary) => {
      setSelectedCandidate(candidate);
      void loadFolderRecordings(candidate.candidate_id || candidate.id);
    },
    [loadFolderRecordings],
  );

  const handleBackToFolders = useCallback(() => {
    setSelectedCandidate(null);
    setCandidateRecordings([]);
    setRecordingsError(null);
  }, []);

  const filteredCandidates = useMemo(
    () => filterCandidates(candidates, searchQuery),
    [candidates, searchQuery],
  );

  return (
    <div className="space-y-6 sm:space-y-8">
      <div>
        <div className="flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-lg bg-primary/10 text-primary">
            <Icon className="size-5" name="folder" />
          </span>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
              {t.recordingsWorkspace.title}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t.recordingsWorkspace.description}
            </p>
          </div>
        </div>
      </div>

      {selectedCandidate ? (
        <section className="space-y-6">
          <div className="flex flex-col justify-between gap-4 rounded-xl border border-border bg-card p-4 text-card-foreground shadow-sm sm:flex-row sm:items-center sm:p-5">
            <div className="flex items-center gap-3">
              <button
                className="inline-flex min-h-10 items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium text-foreground shadow-sm transition hover:bg-accent hover:text-accent-foreground"
                onClick={handleBackToFolders}
                type="button"
              >
                <Icon
                  className={`size-3.5 ${direction === "rtl" ? "rotate-180" : ""}`}
                  name="chevron"
                />
                {t.recordingsWorkspace.backToFolders}
              </button>
              <div>
                <h2 className="text-base font-semibold text-foreground">
                  {selectedCandidate.full_name}
                </h2>
                <p className="text-xs text-muted-foreground">{selectedCandidate.email}</p>
              </div>
            </div>

            <span className="w-fit rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
              {recordingCountLabel(selectedCandidate.recording_count, t.recordingsWorkspace)}
            </span>
          </div>

          {isLoadingRecordings ? (
            <div className="grid min-h-60 place-items-center rounded-xl border border-border bg-card/50 p-8 text-sm text-muted-foreground">
              <div className="flex items-center gap-3">
                <span className="size-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                {t.dashboard.loading}
              </div>
            </div>
          ) : recordingsError ? (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-8 text-center text-sm text-destructive">
              <p>{recordingsError}</p>
              <button
                className="mt-4 min-h-11 rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90"
                onClick={() =>
                  void loadFolderRecordings(selectedCandidate.candidate_id || selectedCandidate.id)
                }
                type="button"
              >
                {t.recordingsWorkspace.retry}
              </button>
            </div>
          ) : candidateRecordings.length === 0 ? (
            <div className="rounded-xl border border-border bg-card p-6 text-center shadow-sm sm:p-12">
              <span className="mx-auto grid size-12 place-items-center rounded-xl border border-border bg-muted/60 text-muted-foreground">
                <Icon className="size-6" name="folder" />
              </span>
              <h3 className="mt-4 text-base font-semibold text-foreground">
                {t.recordingsWorkspace.folderEmpty}
              </h3>
              <p className="mt-2 text-sm text-muted-foreground">
                {t.recordingsWorkspace.folderEmptyDescription}
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {candidateRecordings.map((recording) => (
                <RecordingPlayerItem
                  item={recording}
                  key={recording.recording_id}
                  locale={locale}
                />
              ))}
            </div>
          )}
        </section>
      ) : (
        <section className="space-y-6">
          <div className="relative max-w-md">
            <span className="pointer-events-none absolute inset-y-0 start-0 grid w-9 place-items-center text-muted-foreground">
              <Icon className="size-4" name="search" />
            </span>
            <input
              aria-label={t.recordingsWorkspace.searchPlaceholder}
              className="min-h-11 w-full rounded-md border border-input bg-background py-1.5 pe-4 ps-9 text-sm text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t.recordingsWorkspace.searchPlaceholder}
              type="text"
              value={searchQuery}
            />
          </div>

          {isLoadingCandidates ? (
            <div className="grid min-h-60 place-items-center rounded-xl border border-border bg-card/50 p-8 text-sm text-muted-foreground">
              <div className="flex items-center gap-3">
                <span className="size-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                {t.dashboard.loading}
              </div>
            </div>
          ) : candidatesError ? (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-8 text-center text-sm text-destructive">
              <p>{candidatesError}</p>
              <button
                className="mt-4 min-h-11 rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90"
                onClick={() => void loadCandidates()}
                type="button"
              >
                {t.recordingsWorkspace.retry}
              </button>
            </div>
          ) : candidates.length === 0 ? (
            <div className="rounded-xl border border-border bg-card p-6 text-center shadow-sm sm:p-12">
              <span className="mx-auto grid size-12 place-items-center rounded-xl border border-border bg-muted/60 text-muted-foreground">
                <Icon className="size-6" name="recording" />
              </span>
              <h3 className="mt-4 text-base font-semibold text-foreground">
                {t.recordingsWorkspace.noCandidatesWithRecordings}
              </h3>
              <p className="mt-2 text-sm text-muted-foreground">
                {t.recordingsWorkspace.noCandidatesDescription}
              </p>
            </div>
          ) : filteredCandidates.length === 0 ? (
            <div className="rounded-xl border border-border bg-card p-6 text-center shadow-sm sm:p-12">
              <span className="mx-auto grid size-12 place-items-center rounded-xl border border-border bg-muted/60 text-muted-foreground">
                <Icon className="size-6" name="search" />
              </span>
              <h3 className="mt-4 text-base font-semibold text-foreground">
                {t.recordingsWorkspace.noSearchResults}
              </h3>
              <p className="mt-2 text-sm text-muted-foreground">
                {t.recordingsWorkspace.noSearchResultsDescription}
              </p>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filteredCandidates.map((candidate) => (
                <button
                  className="group flex min-h-44 flex-col justify-between rounded-xl border border-border bg-card p-5 text-start text-card-foreground shadow-sm transition hover:border-border/80 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  key={candidate.candidate_id || candidate.id}
                  onClick={() => handleOpenFolder(candidate)}
                  type="button"
                >
                  <div className="flex w-full items-start justify-between gap-4">
                    <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-primary/20 bg-primary/10 text-primary transition group-hover:bg-primary group-hover:text-primary-foreground">
                      <Icon className="size-4" name="folder" />
                    </span>
                    <span className="rounded-full border border-border bg-secondary px-2.5 py-0.5 text-xs font-medium text-secondary-foreground">
                      {recordingCountLabel(candidate.recording_count, t.recordingsWorkspace)}
                    </span>
                  </div>

                  <div className="mt-5 w-full">
                    <h3 className="truncate text-base font-semibold text-card-foreground transition group-hover:text-primary">
                      {candidate.full_name}
                    </h3>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {candidate.email}
                    </p>
                  </div>

                  <div className="mt-5 flex w-full items-center justify-between border-t border-border/60 pt-3 text-xs font-medium text-muted-foreground group-hover:text-primary">
                    <span>{t.recordingsWorkspace.folderTitle}</span>
                    <Icon
                      className={`size-3.5 transition-transform group-hover:translate-x-1 ${
                        direction === "rtl" ? "rotate-180 group-hover:-translate-x-1" : ""
                      }`}
                      name="chevron"
                    />
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
