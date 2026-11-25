"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { Icon } from "@/components/dashboard/icons";
import {
  type InterviewSession,
  getInterviewStatusBadgeClass,
} from "@/components/dashboard/interviews-workspace";
import { apiBaseUrl } from "@/lib/auth";
import { type Locale, useLocale } from "@/lib/i18n";

function formatDate(value: string, locale: Locale): string {
  try {
    return new Intl.DateTimeFormat(locale === "ar" ? "ar" : "en", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

type RecordingInfo = {
  id: string;
  content_type: string;
  byte_size: number;
  duration_seconds: number | null;
  status: string;
  created_at: string;
};

export function InterviewDetail() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const { direction, locale, t } = useLocale();
  const [session, setSession] = useState<InterviewSession | null>(null);
  const [error, setError] = useState("");
  const [recordingState, setRecordingState] = useState<"loading" | "empty" | "ready" | "error">("loading");
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);

  useEffect(() => {
    async function loadSession() {
      try {
        const response = await fetch(`${apiBaseUrl}/interviews/${sessionId}`, {
          credentials: "include",
          cache: "no-store",
        });
        if (!response.ok) {
          setError(t.interviews.loadFailed);
          return;
        }
        setSession((await response.json()) as InterviewSession);
      } catch {
        setError(t.interviews.loadFailed);
      }
    }

    void loadSession();
  }, [sessionId, t.interviews.loadFailed]);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;

    async function loadRecording() {
      try {
        setRecordingState("loading");
        const metadataResponse = await fetch(`${apiBaseUrl}/interviews/${sessionId}/recording`, {
          credentials: "include",
          cache: "no-store",
        });
        if (metadataResponse.status === 404) {
          if (active) {
            setRecordingState("empty");
          }
          return;
        }
        if (!metadataResponse.ok) {
          throw new Error("Recording metadata could not be loaded");
        }
        const metadata = (await metadataResponse.json()) as RecordingInfo;
        if (metadata.status !== "available") {
          throw new Error("Recording is not available");
        }
        const contentResponse = await fetch(
          `${apiBaseUrl}/interviews/${sessionId}/recording/content`,
          { credentials: "include", cache: "no-store" },
        );
        if (!contentResponse.ok) {
          throw new Error("Recording content could not be loaded");
        }
        objectUrl = URL.createObjectURL(await contentResponse.blob());
        if (active) {
          setRecordingUrl(objectUrl);
          setRecordingState("ready");
        }
      } catch {
        if (active) {
          setRecordingState("error");
        }
      }
    }

    void loadRecording();
    return () => {
      active = false;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [sessionId]);

  if (error) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-6 text-center text-xs text-destructive">
        <p>{error}</p>
        <Link
          className="mt-3 inline-flex min-h-10 items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium text-foreground shadow-sm transition hover:bg-accent"
          href="/dashboard/interviews"
        >
          {t.interviews.backToInterviews}
        </Link>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex min-h-60 items-center justify-center gap-2 rounded-xl border border-border bg-card p-8 text-xs text-muted-foreground shadow-sm">
        <span className="size-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        <span>{t.dashboard.loading}</span>
      </div>
    );
  }

  const candidateFullName = session.candidate
    ? `${session.candidate.given_name} ${session.candidate.family_name}`
    : "—";

  const statusKey = session.status === "in_progress" ? "inProgress" : session.status;
  const statusLabelText = (t.interviews as Record<string, string>)[statusKey] ?? session.status;

  return (
    <div className="space-y-6 sm:space-y-8">
      {/* Back button */}
      <div>
        <Link
          className="inline-flex min-h-10 items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium text-foreground shadow-sm transition hover:bg-accent hover:text-accent-foreground"
          href="/dashboard/interviews"
        >
          <Icon
            className={`size-3.5 ${direction === "rtl" ? "rotate-180" : ""}`}
            name="chevron"
          />
          <span>{t.interviews.backToInterviews}</span>
        </Link>
      </div>

      {/* Main Grid: Details + Room Action Card */}
      <div className="grid gap-6 xl:grid-cols-[1.25fr_0.75fr]">
        {/* Left Column: Session Info Card */}
        <section className="rounded-xl border border-border bg-card p-5 text-card-foreground shadow-sm sm:p-6">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
            <div className="flex items-center gap-3">
              <span className="grid size-9 place-items-center rounded-lg bg-primary/10 text-primary">
                <Icon className="size-5" name="interviews" />
              </span>
              <div>
                <h1 className="text-lg font-bold tracking-tight text-foreground sm:text-xl">
                  {candidateFullName}
                </h1>
                <p className="text-xs text-muted-foreground font-mono" dir="ltr">
                  {session.candidate?.email}
                </p>
              </div>
            </div>

            <span
              className={`w-fit rounded-md border px-2.5 py-1 text-xs font-medium ${getInterviewStatusBadgeClass(
                session.status,
              )}`}
            >
              {statusLabelText}
            </span>
          </div>

          <dl className="mt-6 divide-y divide-border/60">
            <div className="flex flex-col items-start gap-1 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-5">
              <dt className="text-xs font-medium text-muted-foreground">{t.interviews.candidate}</dt>
              <dd className="w-full break-words text-start text-xs font-semibold text-foreground sm:w-auto sm:text-end">
                {candidateFullName}
              </dd>
            </div>
            <div className="flex flex-col items-start gap-1 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-5">
              <dt className="text-xs font-medium text-muted-foreground">{t.interviews.status}</dt>
              <dd className="text-xs font-medium text-foreground">{statusLabelText}</dd>
            </div>
            <div className="flex flex-col items-start gap-1 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-5">
              <dt className="text-xs font-medium text-muted-foreground">{t.interviews.requiredLevel}</dt>
              <dd className="text-xs font-mono font-medium text-foreground">
                {session.required_german_level || t.interviews.notConfigured}
              </dd>
            </div>
            <div className="flex flex-col items-start gap-1 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-5">
              <dt className="text-xs font-medium text-muted-foreground">{t.interviews.created}</dt>
              <dd className="w-full text-start text-xs text-muted-foreground sm:w-auto sm:text-end">
                {formatDate(session.created_at, locale)}
              </dd>
            </div>
          </dl>

          {/* Recording Player Section */}
          <section className="mt-6 border-t border-border pt-6">
            <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
              <div>
                <h2 className="text-sm font-semibold text-foreground">
                  {t.interviews.recording}
                </h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t.interviews.recordingPrivate}
                </p>
              </div>
              <span
                className={`text-xs font-medium ${
                  recordingState === "ready"
                    ? "text-emerald-600 dark:text-emerald-400"
                    : recordingState === "error"
                      ? "text-destructive"
                      : "text-muted-foreground"
                }`}
              >
                {recordingState === "loading"
                  ? t.interviews.recordingLoading
                  : recordingState === "ready"
                    ? t.interviews.recordingAvailable
                    : recordingState === "error"
                      ? t.interviews.recordingLoadFailed
                      : t.interviews.recordingNotSaved}
              </span>
            </div>

            {recordingState === "ready" && recordingUrl ? (
              <div className="mt-4 overflow-hidden rounded-xl bg-black shadow-inner">
                <video
                  className="aspect-video w-full rounded-xl bg-black"
                  controls
                  playsInline
                  src={recordingUrl}
                />
              </div>
            ) : null}
          </section>
        </section>

        {/* Right Column: Interview Room Action Card */}
        <aside
          className={`flex flex-col justify-between rounded-xl border p-5 text-card-foreground shadow-sm sm:p-6 ${
            session.status === "completed" || session.has_recording
              ? "border-border bg-muted/20"
              : "border-primary/20 bg-primary/5 dark:bg-primary/10"
          }`}
        >
          <div>
            <span
              className={`grid size-10 place-items-center rounded-lg ${
                session.status === "completed" || session.has_recording
                  ? "bg-muted text-muted-foreground"
                  : "bg-primary/15 text-primary"
              }`}
            >
              <Icon
                className="size-5"
                name={session.status === "completed" || session.has_recording ? "interviews" : "sparkles"}
              />
            </span>
            <h2 className="mt-5 text-base font-semibold text-foreground">
              {session.status === "completed" || session.has_recording
                ? t.interviews.roomCompletedTitle
                : t.interviews.futureRoom}
            </h2>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              {session.status === "completed" || session.has_recording
                ? t.interviews.roomCompletedDescription
                : t.interviews.futureRoomDescription}
            </p>
          </div>

          <div className="mt-6 space-y-2.5">
            <Link
              className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90"
              href={`/interview/${session.id}`}
            >
              <Icon className="size-3.5" name="sparkles" />
              <span>{t.interviews.openRoom}</span>
            </Link>

            {session.status === "completed" || session.has_recording ? (
              <Link
                className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-input bg-background px-4 py-2 text-xs font-medium text-foreground shadow-sm transition hover:bg-accent hover:text-accent-foreground"
                href="/dashboard/recordings"
              >
                <Icon className="size-3.5 text-muted-foreground" name="folder" />
                <span>{t.navigation.recordings}</span>
              </Link>
            ) : null}
          </div>
        </aside>
      </div>
    </div>
  );
}
