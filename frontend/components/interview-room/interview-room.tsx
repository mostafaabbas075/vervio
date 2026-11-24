"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { Icon } from "@/components/dashboard/icons";
import type { InterviewSession } from "@/components/dashboard/interviews-workspace";
import { LanguageSwitcher } from "@/components/language-switcher";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { apiBaseUrl, fetchSession } from "@/lib/auth";
import {
  GeminiAudioClient,
  type GeminiAudioClientState,
} from "@/lib/gemini-audio-client";
import {
  createInterviewRecordingStream,
  InterviewRecorder,
  type FinalizedInterviewRecording,
} from "@/lib/interview-recorder";
import { type Locale, useLocale } from "@/lib/i18n";

export type RoomState =
  | "loading"
  | "device_setup"
  | "ready"
  | "permission_denied"
  | "device_error"
  | "session_unavailable"
  | "already_completed";

export type RecordingState = "idle" | "recording" | "uploading" | "saved" | "error";

export const DEMO_MAX_INTERVIEW_DURATION_SECONDS = 120;

export function formatElapsedTime(elapsedSeconds: number): string {
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) {
    return "00:00";
  }
  const minutes = Math.floor(elapsedSeconds / 60).toString().padStart(2, "0");
  const seconds = (elapsedSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

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

export function buildGeminiWebSocketUrl(sessionId: string): string {
  const backendUrl = new URL(apiBaseUrl);
  backendUrl.protocol = backendUrl.protocol === "https:" ? "wss:" : "ws:";
  backendUrl.pathname = `${backendUrl.pathname.replace(/\/$/, "")}/interviews/${encodeURIComponent(sessionId)}/gemini/ws`;
  backendUrl.search = "";
  backendUrl.hash = "";
  return backendUrl.toString();
}

export function getRemainingSeconds(
  elapsedSeconds: number,
  maxDurationSeconds: number = DEMO_MAX_INTERVIEW_DURATION_SECONDS,
): number {
  return Math.max(0, maxDurationSeconds - Math.max(0, elapsedSeconds));
}

export function canStartInterview(
  devicesReady: boolean,
  guidelinesAcknowledged: boolean,
  isRequestingDevices: boolean,
  isEndingInterview: boolean,
  hasPendingRecording: boolean,
): boolean {
  return (
    devicesReady &&
    guidelinesAcknowledged &&
    !isRequestingDevices &&
    !isEndingInterview &&
    !hasPendingRecording
  );
}

export function InterviewRoom() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const router = useRouter();
  const { direction, locale, t } = useLocale();

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const geminiClientRef = useRef<GeminiAudioClient | null>(null);
  const recorderRef = useRef<InterviewRecorder | null>(null);
  const pendingRecordingRef = useRef<FinalizedInterviewRecording | null>(null);
  const recordingFinalizationRef = useRef<Promise<void> | null>(null);
  const endInFlightRef = useRef(false);
  const guidelinesAcknowledgedRef = useRef(false);
  const guidelinesAcknowledgeButtonRef = useRef<HTMLButtonElement>(null);

  const [session, setSession] = useState<InterviewSession | null>(null);
  const [roomState, setRoomState] = useState<RoomState>("loading");
  const [isRequestingDevices, setIsRequestingDevices] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);
  const [microphoneActive, setMicrophoneActive] = useState(false);
  const [microphoneLevel, setMicrophoneLevel] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [connectionState, setConnectionState] = useState<GeminiAudioClientState>("idle");
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [isAiSpeaking, setIsAiSpeaking] = useState(false);
  const [isCandidateSpeaking, setIsCandidateSpeaking] = useState(false);
  const [maximumDurationSeconds, setMaximumDurationSeconds] = useState<number | null>(null);
  const [recordingState, setRecordingState] = useState<RecordingState>("idle");
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [showGuidelines, setShowGuidelines] = useState(false);
  const [guidelinesAcknowledged, setGuidelinesAcknowledged] = useState(false);
  const [deviceLossMessage, setDeviceLossMessage] = useState<string | null>(null);
  const [isEndingInterview, setIsEndingInterview] = useState(false);

  const uploadRecording = useCallback(
    async (recording: FinalizedInterviewRecording) => {
      setRecordingState("uploading");
      const authResult = await fetchSession();
      if (authResult.status !== "authenticated") {
        throw new Error("The secure session is unavailable");
      }
      const response = await fetch(`${apiBaseUrl}/interviews/${sessionId}/recording`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": recording.contentType,
          "X-CSRF-Token": authResult.session.csrf_token,
        },
        body: recording.blob,
      });
      if (!response.ok) {
        throw new Error("The recording upload could not be completed");
      }
      pendingRecordingRef.current = null;
      setRecordingState("saved");
      setSession((prev) =>
        prev
          ? {
              ...prev,
              status: "completed",
              has_recording: true,
            }
          : prev,
      );
      setRoomState("already_completed");
    },
    [sessionId],
  );

  const stopRecording = useCallback(async () => {
    if (recordingFinalizationRef.current) {
      return recordingFinalizationRef.current;
    }
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (!recorder) {
      return;
    }
    const finalization = (async () => {
      try {
        const recording = await recorder.stop();
        if (recording) {
          pendingRecordingRef.current = recording;
          await uploadRecording(recording);
        }
      } catch {
        setRecordingState("error");
        setRecordingError(t.room.recordingUploadFailed);
      } finally {
        recorder.dispose();
      }
    })();
    recordingFinalizationRef.current = finalization;
    return finalization;
  }, [t.room.recordingUploadFailed, uploadRecording]);

  const endGeminiConnection = useCallback(async () => {
    const recordingFinalization = stopRecording();
    const client = geminiClientRef.current;
    geminiClientRef.current = null;
    if (client) {
      await client.stop();
    }
    await recordingFinalization;
  }, [stopRecording]);

  const releaseMedia = useCallback((updateState = true) => {
    const stream = streamRef.current;
    streamRef.current = null;

    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    if (audioContextRef.current) {
      void audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (updateState) {
      setCameraActive(false);
      setMicrophoneActive(false);
      setMicrophoneLevel(0);
      setElapsedSeconds(0);
      setIsCandidateSpeaking(false);
      setIsAiSpeaking(false);
      setRecordingState((current) => (current === "saved" || current === "error" ? current : "idle"));
    }
  }, []);

  const startMicrophoneMeter = useCallback((stream: MediaStream) => {
    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    const analyser = audioContext.createAnalyser();
    const mutedOutput = audioContext.createGain();
    analyser.fftSize = 256;
    mutedOutput.gain.value = 0;
    source.connect(analyser);
    analyser.connect(mutedOutput);
    mutedOutput.connect(audioContext.destination);
    audioContextRef.current = audioContext;

    const samples = new Uint8Array(analyser.fftSize);
    const updateMeter = () => {
      analyser.getByteTimeDomainData(samples);
      const average = samples.reduce((sum, sample) => sum + Math.abs(sample - 128), 0) / samples.length;
      setMicrophoneLevel(Math.min(100, Math.round(average * 4)));
      setIsCandidateSpeaking(average >= 2);
      animationFrameRef.current = window.requestAnimationFrame(updateMeter);
    };
    updateMeter();
  }, []);

  const startDeviceTest = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setRoomState("device_error");
      return;
    }

    setIsRequestingDevices(true);
    setDeviceLossMessage(null);
    await endGeminiConnection();
    releaseMedia();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const videoTrack = stream.getVideoTracks()[0];
      const audioTrack = stream.getAudioTracks()[0];
      if (!videoTrack || !audioTrack || !videoTrack.enabled || !audioTrack.enabled) {
        stream.getTracks().forEach((track) => track.stop());
        setRoomState("device_error");
        return;
      }

      streamRef.current = stream;
      videoTrack.onended = () => {
        if (streamRef.current === stream) {
          setDeviceLossMessage(t.room.deviceLostDuringInterview);
          void endGeminiConnection();
          releaseMedia(false);
          setCameraActive(false);
          setMicrophoneActive(false);
          setRoomState("device_error");
        }
      };
      audioTrack.onended = () => {
        if (streamRef.current === stream) {
          setDeviceLossMessage(t.room.deviceLostDuringInterview);
          void endGeminiConnection();
          releaseMedia(false);
          setCameraActive(false);
          setMicrophoneActive(false);
          setRoomState("device_error");
        }
      };
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        void videoRef.current.play().catch(() => undefined);
      }
      startMicrophoneMeter(stream);
      setCameraActive(true);
      setMicrophoneActive(true);
      setRoomState("ready");
      setRecordingState("idle");
      setRecordingError(null);
    } catch (error) {
      releaseMedia();
      const errorName = error instanceof DOMException ? error.name : "";
      setRoomState(
        errorName === "NotAllowedError" || errorName === "SecurityError"
          ? "permission_denied"
          : "device_error",
      );
    } finally {
      setIsRequestingDevices(false);
    }
  }, [
    endGeminiConnection,
    releaseMedia,
    startMicrophoneMeter,
    t.room.deviceLostDuringInterview,
  ]);

  useEffect(() => {
    let active = true;

    async function loadSession() {
      try {
        const authResult = await fetchSession();
        if (authResult.status === "unauthenticated") {
          router.replace("/login");
          return;
        }
        if (authResult.status !== "authenticated") {
          if (active) {
            setRoomState("session_unavailable");
          }
          return;
        }
        const response = await fetch(`${apiBaseUrl}/interviews/${sessionId}`, {
          credentials: "include",
          cache: "no-store",
        });
        if (response.status === 401) {
          router.replace("/login");
          return;
        }
        if (response.status === 403) {
          router.replace("/access-denied");
          return;
        }
        if (!response.ok) {
          if (active) {
            setRoomState("session_unavailable");
          }
          return;
        }
        if (active) {
          const sessionData = (await response.json()) as InterviewSession;
          setSession(sessionData);
          if (sessionData.status === "completed" || sessionData.has_recording) {
            setRoomState("already_completed");
            return;
          }
          setRoomState("device_setup");
          if (!guidelinesAcknowledgedRef.current) {
            setShowGuidelines(true);
            setGuidelinesAcknowledged(false);
          }
          void startDeviceTest();
        }
      } catch {
        if (active) {
          setRoomState("session_unavailable");
        }
      }
    }

    void loadSession();
    return () => {
      active = false;
    };
  }, [router, sessionId, startDeviceTest]);

  useEffect(() => {
    if (!navigator.mediaDevices?.addEventListener) {
      return undefined;
    }

    const handleDeviceChange = () => {
      const stream = streamRef.current;
      if (stream?.getTracks().some((track) => track.readyState !== "live")) {
        setDeviceLossMessage(t.room.deviceLostDuringInterview);
        void endGeminiConnection();
        releaseMedia(false);
        setCameraActive(false);
        setMicrophoneActive(false);
        setRoomState("device_error");
      }
    };
    navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);
    return () => navigator.mediaDevices.removeEventListener("devicechange", handleDeviceChange);
  }, [endGeminiConnection, releaseMedia, t.room.deviceLostDuringInterview]);

  useEffect(
    () => () => {
      void endGeminiConnection();
      releaseMedia(false);
    },
    [endGeminiConnection, releaseMedia],
  );

  const getGeminiErrorMessage = useCallback(
    (error: Error) => {
      const message = error.message.toLowerCase();
      if (message.includes("not configured")) {
        return t.room.serviceNotConfigured;
      }
      if (message.includes("timed out")) {
        return t.room.connectionTimedOut;
      }
      if (message.includes("1008") || message.includes("not authorized")) {
        return t.room.connectionNotAuthorized;
      }
      if (message.includes("audio playback")) {
        return t.room.audioPlaybackFailed;
      }
      return t.room.connectionFailedMessage;
    },
    [t.room],
  );

  const startInterview = useCallback(async () => {
    const stream = streamRef.current;
    const microphoneTrack = stream?.getAudioTracks()[0];
    const cameraTrack = stream?.getVideoTracks()[0];
    if (
      !session ||
      !stream ||
      !cameraTrack ||
      !microphoneTrack ||
      !cameraTrack.enabled ||
      microphoneTrack.readyState !== "live" ||
      !microphoneTrack.enabled ||
      cameraTrack.readyState !== "live"
    ) {
      setConnectionError(t.room.microphoneUnavailable);
      return;
    }
    if (!guidelinesAcknowledged) {
      setShowGuidelines(true);
      return;
    }
    if (session.status === "completed" || session.has_recording) {
      setConnectionError(t.room.alreadyRecordedError);
      return;
    }
    if (["connecting", "connected", "ending"].includes(connectionState)) {
      return;
    }

    setConnectionError(null);
    setRecordingState("idle");
    setRecordingError(null);
    pendingRecordingRef.current = null;
    recordingFinalizationRef.current = null;
    endInFlightRef.current = false;
    setIsEndingInterview(false);
    setElapsedSeconds(0);
    setMaximumDurationSeconds(null);

    // The device-test meter owns this context. Resume it in the Start button's
    // user gesture, then let the audio worklet reuse it for microphone capture.
    // This prevents a redesign-era suspended context from reporting a ready
    // microphone while delivering no PCM frames to the Live connection.
    try {
      if (audioContextRef.current?.state === "suspended") {
        await audioContextRef.current.resume();
      }
    } catch {
      setConnectionError(t.room.microphoneUnavailable);
      return;
    }
    const client = new GeminiAudioClient({
      stream,
      wsUrl: buildGeminiWebSocketUrl(sessionId),
      audioContext: audioContextRef.current ?? undefined,
      callbacks: {
        onStateChange: (state) => {
          setConnectionState(state);
          if (state === "failed" || state === "ended") {
            void stopRecording();
          }
        },
        onAssistantSpeakingChange: setIsAiSpeaking,
        onError: (error) => setConnectionError(getGeminiErrorMessage(error)),
        onRecordingAudioStreamReady: async (mixedAudioStream) => {
          const recorder = new InterviewRecorder();
          try {
            recorder.start(createInterviewRecordingStream(stream, mixedAudioStream));
            recorderRef.current = recorder;
            setRecordingState("recording");
          } catch (error) {
            recorder.dispose();
            setRecordingState("error");
            setRecordingError(t.room.recordingStartFailed);
            throw error;
          }
        },
      },
    });
    geminiClientRef.current = client;
    try {
      await client.start();
      if (geminiClientRef.current === client) {
        setMaximumDurationSeconds(DEMO_MAX_INTERVIEW_DURATION_SECONDS);
      }
    } catch {
      // The client reports a localized, user-safe error through its callback.
    }
  }, [
    connectionState,
    getGeminiErrorMessage,
    session,
    sessionId,
    stopRecording,
    t.room.alreadyRecordedError,
    guidelinesAcknowledged,
    t.room.microphoneUnavailable,
    t.room.recordingStartFailed,
  ]);

  const endInterview = useCallback(async () => {
    if (endInFlightRef.current) {
      return;
    }
    endInFlightRef.current = true;
    setIsEndingInterview(true);
    setConnectionState("ending");
    setRecordingState((current) => (current === "recording" ? "uploading" : current));
    try {
      await endGeminiConnection();
      releaseMedia();
      setRoomState((current) => (current === "already_completed" ? current : "device_setup"));
      setMaximumDurationSeconds(null);
      setIsAiSpeaking(false);
      setIsCandidateSpeaking(false);
    } finally {
      endInFlightRef.current = false;
      setIsEndingInterview(false);
    }
  }, [endGeminiConnection, releaseMedia]);

  const retryRecordingUpload = useCallback(async () => {
    const recording = pendingRecordingRef.current;
    if (!recording || isEndingInterview) {
      return;
    }
    setRecordingError(null);
    try {
      await uploadRecording(recording);
    } catch {
      setRecordingState("error");
      setRecordingError(t.room.recordingUploadFailed);
    }
  }, [isEndingInterview, t.room.recordingUploadFailed, uploadRecording]);

  useEffect(() => {
    if (showGuidelines) {
      guidelinesAcknowledgeButtonRef.current?.focus();
    }
  }, [showGuidelines]);

  useEffect(() => {
    if (connectionState !== "connected") {
      return undefined;
    }

    const startedAt = Date.now();
    setElapsedSeconds(0);
    const timer = window.setInterval(() => {
      const nextElapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
      setElapsedSeconds(nextElapsedSeconds);
      if (maximumDurationSeconds && nextElapsedSeconds >= maximumDurationSeconds) {
        void endInterview();
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [connectionState, endInterview, maximumDurationSeconds]);

  const isDeviceProblem = roomState === "permission_denied" || roomState === "device_error";
  const isConnectionActive = ["connecting", "connected", "ending"].includes(connectionState);
  const devicesReady = cameraActive && microphoneActive && !isDeviceProblem;

  const connectionLabels: Record<GeminiAudioClientState, string> = {
    idle: t.room.connectionIdle,
    connecting: t.room.connectionConnecting,
    connected: t.room.connectionConnected,
    ending: t.room.connectionEnding,
    ended: t.room.connectionEnded,
    failed: t.room.connectionFailed,
  };
  const connectionLabel = connectionLabels[connectionState];

  const recordingLabels: Record<RecordingState, string> = {
    idle: t.room.recordingReady,
    recording: t.room.recordingInProgress,
    uploading: t.room.recordingUploading,
    saved: t.room.recordingSaved,
    error: t.room.recordingFailed,
  };
  const recordingLabel = recordingLabels[recordingState];

  const remainingSeconds = getRemainingSeconds(
    elapsedSeconds,
    maximumDurationSeconds || DEMO_MAX_INTERVIEW_DURATION_SECONDS,
  );
  const isTimeRunningLow = connectionState === "connected" && remainingSeconds <= 30;
  const startIsAvailable = canStartInterview(
    devicesReady,
    guidelinesAcknowledged,
    isRequestingDevices,
    isEndingInterview,
    pendingRecordingRef.current !== null,
  );
  const assistantState =
    connectionState === "connecting"
      ? t.room.connectionConnecting
      : isAiSpeaking
        ? t.room.aiSpeaking
        : connectionState === "connected"
          ? t.room.aiListening
          : connectionLabel;

  if (roomState === "loading") {
    return (
      <main className="grid min-h-screen place-items-center bg-background px-6 text-foreground">
        <div className="flex flex-col items-center gap-4 text-center">
          <span className="grid size-12 place-items-center rounded-2xl bg-primary/10 text-primary animate-pulse">
            <Icon className="size-6" name="sparkles" />
          </span>
          <p className="text-sm font-medium text-muted-foreground">{t.room.loading}</p>
        </div>
      </main>
    );
  }

  if (roomState === "session_unavailable" || !session) {
    return (
      <main className="grid min-h-screen place-items-center bg-background px-6 text-foreground">
        <section className="max-w-md w-full rounded-2xl border border-destructive/20 bg-card p-8 text-center shadow-lg">
          <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-destructive/10 text-destructive">
            <Icon className="size-6" name="activity" />
          </span>
          <h1 className="mt-4 text-xl font-semibold text-foreground">{t.room.sessionUnavailable}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t.room.secureSessionUnavailable}</p>
          <Link
            className="mt-6 inline-flex items-center justify-center rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm transition hover:opacity-90"
            href="/dashboard/interviews"
          >
            {t.room.returnToDetails}
          </Link>
        </section>
      </main>
    );
  }

  if (roomState === "already_completed" && session) {
    return (
      <main className="grid min-h-screen place-items-center bg-background px-6 text-foreground">
        <section className="max-w-md w-full rounded-2xl border border-border bg-card p-8 text-center shadow-lg">
          <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-primary/10 text-primary">
            <Icon className="size-6" name="check" />
          </span>
          <h1 className="mt-4 text-xl font-semibold text-foreground">{t.room.alreadyCompletedTitle}</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {t.room.alreadyCompletedDescription}
          </p>
          <Link
            className="mt-6 inline-flex items-center justify-center rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm transition hover:opacity-90"
            href={`/dashboard/interviews/${session.id}`}
          >
            {t.room.returnToDetails}
          </Link>
        </section>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="border-b border-border/80 bg-card/80 px-4 py-3 backdrop-blur-md sm:px-6">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary text-sm font-bold text-primary-foreground shadow-sm">
              V
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold tracking-tight sm:text-base">
                {session.candidate.given_name} {session.candidate.family_name}
              </p>
              <p className="hidden text-xs text-muted-foreground sm:block">
                {formatDate(session.created_at, locale)}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            <div
              aria-label={t.room.interviewTimer}
              className={`rounded-full border px-3 py-1.5 font-mono text-xs font-semibold tabular-nums ${
                isTimeRunningLow
                  ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                  : connectionState === "connected"
                    ? "border-primary/20 bg-primary/10 text-primary"
                    : "border-border bg-muted/50 text-muted-foreground"
              }`}
            >
              {formatElapsedTime(elapsedSeconds)} / {formatElapsedTime(DEMO_MAX_INTERVIEW_DURATION_SECONDS)}
            </div>
            <ThemeSwitcher />
            <LanguageSwitcher />
            <Link
              className="inline-flex size-9 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground transition hover:bg-muted hover:text-foreground sm:w-auto sm:gap-1.5 sm:px-3"
              href={`/dashboard/interviews/${session.id}`}
              title={t.room.returnToDetails}
            >
              <Icon className={`size-4 ${direction === "rtl" ? "" : "rotate-180"}`} name="chevron" />
              <span className="hidden text-xs font-medium sm:inline">{t.room.returnToDetails}</span>
            </Link>
          </div>
        </div>
      </header>

      <section className="flex flex-1 px-4 py-5 sm:px-6 sm:py-8">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
          {deviceLossMessage || connectionError || recordingError ? (
            <div className="space-y-2" aria-live="polite">
              {deviceLossMessage ? (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/25 bg-destructive/10 px-4 py-3 text-sm text-destructive" role="alert">
                  <span>{deviceLossMessage}</span>
                  <button
                    className="rounded-lg border border-destructive/30 px-3 py-1.5 text-xs font-semibold transition hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={isRequestingDevices || isConnectionActive}
                    onClick={() => void startDeviceTest()}
                    type="button"
                  >
                    {t.room.retryDevices}
                  </button>
                </div>
              ) : null}
              {connectionError ? (
                <div className="flex items-center justify-between gap-3 rounded-xl border border-destructive/25 bg-destructive/10 px-4 py-3 text-sm text-destructive" role="alert">
                  <span>{connectionError}</span>
                </div>
              ) : null}
              {recordingError ? (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/25 bg-destructive/10 px-4 py-3 text-sm text-destructive" role="alert">
                  <span>{recordingError}</span>
                  {pendingRecordingRef.current ? (
                    <button
                      className="rounded-lg border border-destructive/30 px-3 py-1.5 text-xs font-semibold transition hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={isEndingInterview || recordingState === "uploading"}
                      onClick={() => void retryRecordingUpload()}
                      type="button"
                    >
                      {t.room.retryRecordingUpload}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          <section
            aria-label={t.room.candidatePreview}
            className={`relative isolate mx-auto flex w-full max-w-6xl flex-1 overflow-hidden rounded-[1.75rem] border bg-slate-950 shadow-2xl shadow-slate-950/15 dark:shadow-black/40 ${
              isCandidateSpeaking && microphoneActive ? "border-primary/70" : "border-border/60"
            }`}
            data-testid="candidate-video-stage"
          >
            <div className="aspect-[4/3] w-full sm:aspect-video">
              <video
                autoPlay
                className={`size-full object-cover transition-opacity duration-300 ${
                  cameraActive ? "opacity-100" : "opacity-0"
                }`}
                muted
                playsInline
                ref={videoRef}
              />
            </div>

            {!cameraActive ? (
              <div className="absolute inset-0 grid place-items-center bg-slate-950 px-6 text-center text-slate-200">
                <div className="max-w-sm">
                  <Icon className="mx-auto size-7 text-primary" name="video" />
                  <p className="mt-4 text-sm font-semibold">
                    {isRequestingDevices ? t.room.devicesPreparing : t.room.cameraOff}
                  </p>
                  <p className="mt-2 text-xs leading-5 text-slate-400">
                    {roomState === "permission_denied"
                      ? t.room.permissionDeniedDescription
                      : roomState === "device_error"
                        ? t.room.deviceErrorDescription
                        : t.room.deviceSetupDescription}
                  </p>
                  {!isRequestingDevices && isDeviceProblem ? (
                    <button
                      className="mt-5 rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground transition hover:opacity-90"
                      onClick={() => void startDeviceTest()}
                      type="button"
                    >
                      {t.room.retryDevices}
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}

            <div className="absolute start-4 top-4 flex items-center gap-2 rounded-full border border-white/15 bg-black/45 px-3 py-1.5 text-xs font-medium text-white backdrop-blur-md">
              <span className="size-1.5 rounded-full bg-emerald-400" />
              <span className="max-w-44 truncate sm:max-w-none">
                {session.candidate.given_name} {session.candidate.family_name}
              </span>
            </div>

            <div className="absolute end-4 top-4 flex items-center gap-2 rounded-full border border-white/15 bg-black/45 px-3 py-1.5 text-xs font-medium text-white backdrop-blur-md" aria-live="polite">
              <span className={`size-1.5 rounded-full ${isAiSpeaking ? "bg-primary animate-pulse" : "bg-emerald-400"}`} />
              <span>{assistantState}</span>
            </div>

            <div className="absolute bottom-4 start-4 end-4 flex flex-wrap items-end justify-between gap-3">
              <div className="rounded-xl border border-white/15 bg-black/45 px-3 py-2 text-xs text-white backdrop-blur-md">
                <div className="flex items-center gap-2">
                  <Icon className={`size-3.5 ${microphoneActive ? "text-emerald-300" : "text-rose-300"}`} name="mic" />
                  <span>{microphoneActive ? t.room.microphoneReady : t.room.microphoneUnavailable}</span>
                  <span className="h-1.5 w-14 overflow-hidden rounded-full bg-white/20" aria-hidden="true">
                    <span
                      className="block h-full rounded-full bg-emerald-400 transition-[width] duration-100"
                      style={{ width: `${microphoneActive ? microphoneLevel : 0}%` }}
                    />
                  </span>
                </div>
              </div>
              <div className="flex gap-2">
                <span className={`rounded-full border px-3 py-1.5 text-xs font-medium backdrop-blur-md ${
                  cameraActive
                    ? "border-emerald-300/30 bg-emerald-400/15 text-emerald-100"
                    : "border-rose-300/30 bg-rose-400/15 text-rose-100"
                }`}>
                  {cameraActive ? t.room.cameraReady : t.room.cameraOff}
                </span>
                <span className={`rounded-full border px-3 py-1.5 text-xs font-medium backdrop-blur-md ${
                  recordingState === "recording"
                    ? "border-rose-300/30 bg-rose-400/15 text-rose-100"
                    : "border-white/15 bg-black/45 text-white"
                }`}>
                  {recordingLabel}
                </span>
              </div>
            </div>
          </section>

          <footer className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-4 rounded-2xl border border-border bg-card/80 px-4 py-4 shadow-sm backdrop-blur-sm sm:flex-row sm:px-5">
            <div className="min-w-0 text-center sm:text-start">
              <p className="text-sm font-semibold text-foreground">
                {isEndingInterview ? t.room.interviewEnding : t.room.title}
              </p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {isConnectionActive ? assistantState : t.room.maxDurationNotice}
              </p>
              {!guidelinesAcknowledged ? (
                <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{t.room.guidelinesRequired}</p>
              ) : null}
            </div>

            {isConnectionActive ? (
              <button
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-destructive px-5 text-sm font-semibold text-destructive-foreground shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={isEndingInterview}
                onClick={() => void endInterview()}
                type="button"
              >
                <Icon className="size-4" name="phone-off" />
                <span>{isEndingInterview ? t.room.interviewEnding : t.room.endInterview}</span>
              </button>
            ) : pendingRecordingRef.current ? (
              <button
                className="inline-flex min-h-11 items-center justify-center rounded-xl bg-primary px-5 text-sm font-semibold text-primary-foreground shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={recordingState === "uploading" || isEndingInterview}
                onClick={() => void retryRecordingUpload()}
                type="button"
              >
                {t.room.retryRecordingUpload}
              </button>
            ) : (
              <button
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-primary px-5 text-sm font-semibold text-primary-foreground shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!startIsAvailable}
                onClick={() => void startInterview()}
                type="button"
              >
                <Icon className="size-4" name="sparkles" />
                <span>{t.room.startInterview}</span>
              </button>
            )}
          </footer>
        </div>
      </section>

      {showGuidelines ? (
        <div
          aria-describedby="guidelines-dialog-description"
          aria-labelledby="guidelines-dialog-title"
          aria-modal="true"
          className="fixed inset-0 z-50 grid place-items-center bg-slate-950/55 p-4 backdrop-blur-sm"
          role="dialog"
        >
          <section className="w-full max-w-lg rounded-3xl border border-border bg-card p-6 text-card-foreground shadow-2xl sm:p-8">
            <div className="flex items-center gap-3">
              <span className="grid size-10 place-items-center rounded-xl bg-primary/10 text-primary">
                <Icon className="size-5" name="clipboard" />
              </span>
              <div>
                <h1 className="text-lg font-semibold tracking-tight" id="guidelines-dialog-title">
                  {t.room.instructionsTitle}
                </h1>
                <p className="text-xs text-muted-foreground">{t.room.guidelines}</p>
              </div>
            </div>
            <p className="mt-6 text-sm leading-6 text-muted-foreground" id="guidelines-dialog-description">
              {t.room.instructions}
            </p>
            <ul className="mt-5 space-y-3 text-sm text-foreground">
              {[t.room.guidelineGermanOnly, t.room.guidelineTimeLimit, t.room.guidelineDevices, t.room.guidelineIndependent].map((guideline) => (
                <li className="flex gap-3" key={guideline}>
                  <Icon className="mt-0.5 size-4 shrink-0 text-primary" name="check" />
                  <span>{guideline}</span>
                </li>
              ))}
            </ul>
            <button
              className="mt-7 w-full rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground shadow-sm transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
              onClick={() => {
                guidelinesAcknowledgedRef.current = true;
                setGuidelinesAcknowledged(true);
                setShowGuidelines(false);
              }}
              ref={guidelinesAcknowledgeButtonRef}
              type="button"
            >
              {t.room.guidelinesAcknowledge}
            </button>
          </section>
        </div>
      ) : null}
    </main>
  );
}
