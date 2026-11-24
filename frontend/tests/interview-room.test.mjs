import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const typescript = require("../../node_modules/typescript");

function loadInterviewRoomModule() {
  const source = readFileSync(
    new globalThis.URL("../components/interview-room/interview-room.tsx", import.meta.url),
    "utf8",
  );

  const output = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
      jsx: typescript.JsxEmit.ReactJSX,
    },
  }).outputText;

  const mockRequire = (specifier) => {
    if (specifier === "@/components/dashboard/icons") {
      return { Icon: () => null };
    }
    if (specifier === "@/components/language-switcher") {
      return { LanguageSwitcher: () => null };
    }
    if (specifier === "@/components/theme-switcher") {
      return { ThemeSwitcher: () => null };
    }
    if (specifier === "@/lib/auth") {
      return {
        apiBaseUrl: "http://localhost:8000",
        fetchSession: async () => ({ status: "authenticated", session: { csrf_token: "test" } }),
      };
    }
    if (specifier === "@/lib/gemini-audio-client") {
      return {
        GeminiAudioClient: class {
          start = async () => {};
          stop = async () => {};
        },
      };
    }
    if (specifier === "@/lib/interview-recorder") {
      return {
        createInterviewRecordingStream: (stream) => stream,
        InterviewRecorder: class {
          start = () => {};
          stop = async () => null;
          dispose = () => {};
        },
      };
    }
    if (specifier === "@/lib/i18n") {
      return {
        useLocale: () => ({
          direction: "ltr",
          locale: "en",
          t: {
            room: {},
            interviews: {},
            dashboard: {},
          },
        }),
      };
    }
    if (specifier === "next/navigation") {
      return {
        useParams: () => ({ sessionId: "session-123" }),
        useRouter: () => ({
          refresh: () => {},
          replace: () => {},
        }),
      };
    }
    if (specifier === "next/link") {
      return {
        default: ({ children }) => children,
      };
    }
    if (specifier === "react") {
      return {
        useCallback: (fn) => fn,
        useEffect: () => {},
        useMemo: (fn) => fn(),
        useRef: () => ({ current: null }),
        useState: (initial) => [initial, () => {}],
      };
    }
    if (specifier === "react/jsx-runtime") {
      return {
        jsx: () => null,
        jsxs: () => null,
      };
    }
    return require(specifier);
  };

  const module = { exports: {} };
  new Function("exports", "require", "module", output)(
    module.exports,
    mockRequire,
    module,
  );
  return module.exports;
}

function readInterviewRoomSource() {
  return readFileSync(
    new globalThis.URL("../components/interview-room/interview-room.tsx", import.meta.url),
    "utf8",
  );
}

const {
  DEMO_MAX_INTERVIEW_DURATION_SECONDS,
  formatElapsedTime,
  getRemainingSeconds,
  buildGeminiWebSocketUrl,
  canStartInterview,
  formatDate,
} = loadInterviewRoomModule();

test("DEMO_MAX_INTERVIEW_DURATION_SECONDS is strictly 120 seconds", () => {
  assert.equal(DEMO_MAX_INTERVIEW_DURATION_SECONDS, 120);
});

test("formatElapsedTime converts elapsed seconds to mm:ss format", () => {
  assert.equal(formatElapsedTime(0), "00:00");
  assert.equal(formatElapsedTime(9), "00:09");
  assert.equal(formatElapsedTime(60), "01:00");
  assert.equal(formatElapsedTime(75), "01:15");
  assert.equal(formatElapsedTime(120), "02:00");
  assert.equal(formatElapsedTime(-5), "00:00");
  assert.equal(formatElapsedTime(NaN), "00:00");
});

test("getRemainingSeconds computes accurate countdown against 120s limit", () => {
  assert.equal(getRemainingSeconds(0, 120), 120);
  assert.equal(getRemainingSeconds(90, 120), 30);
  assert.equal(getRemainingSeconds(120, 120), 0);
  assert.equal(getRemainingSeconds(130, 120), 0);
  assert.equal(getRemainingSeconds(-10, 120), 120);
});

test("Start Interview stays disabled until acknowledged camera and microphone preflight succeeds", () => {
  assert.equal(canStartInterview(true, true, false, false, false), true);
  assert.equal(canStartInterview(false, true, false, false, false), false);
  assert.equal(canStartInterview(true, false, false, false, false), false);
  assert.equal(canStartInterview(true, true, true, false, false), false);
  assert.equal(canStartInterview(true, true, false, true, false), false);
  assert.equal(canStartInterview(true, true, false, false, true), false);
});

test("buildGeminiWebSocketUrl creates a valid websocket URL pointing to session endpoint", () => {
  const wsUrl = buildGeminiWebSocketUrl("session-abc-456");
  assert.match(wsUrl, /^ws:\/\/localhost:8000\/interviews\/session-abc-456\/gemini\/ws$/);
});

test("formatDate handles valid ISO dates without crashing", () => {
  const formattedEn = formatDate("2026-11-20T10:00:00Z", "en");
  assert.ok(formattedEn.length > 0);
  const formattedAr = formatDate("2026-11-20T10:00:00Z", "ar");
  assert.ok(formattedAr.length > 0);
});

test("Interview Studio removes device toggles and preserves a single candidate stage", () => {
  const roomSource = readInterviewRoomSource();

  assert.match(roomSource, /data-testid="candidate-video-stage"/);
  assert.doesNotMatch(roomSource, /toggleMicrophone|toggleCamera|showSettings/);
  assert.doesNotMatch(roomSource, /turnOffMic|turnOnMic|turnOffCamera|turnOnCamera/);
  assert.doesNotMatch(roomSource, /AI Interviewer Tile|aiInterviewer/);
  assert.match(roomSource, /void startDeviceTest\(\);/);
  assert.match(roomSource, /setShowGuidelines\(true\)/);
  assert.match(roomSource, /guidelinesAcknowledgedRef\.current = true/);
});

test("Interview Studio protects exactly-once end, upload recovery, device loss, and audio lifecycle", () => {
  const roomSource = readInterviewRoomSource();

  assert.match(roomSource, /if \(endInFlightRef\.current\) \{\s+return;/);
  assert.match(roomSource, /endInFlightRef\.current = true/);
  assert.match(roomSource, /pendingRecordingRef\.current = recording/);
  assert.match(roomSource, /retryRecordingUpload/);
  assert.match(roomSource, /videoTrack\.onended/);
  assert.match(roomSource, /audioTrack\.onended/);
  assert.match(roomSource, /new GeminiAudioClient/);
  assert.match(roomSource, /new InterviewRecorder/);
  assert.match(roomSource, /createInterviewRecordingStream/);
});

test("i18n includes Interview Studio guidance and recovery translations in EN and AR", () => {
  const i18nSource = readFileSync(
    new globalThis.URL("../lib/i18n.tsx", import.meta.url),
    "utf8",
  );

  assert.ok(i18nSource.includes('guidelinesAcknowledge: "I understand — continue"'));
  assert.ok(i18nSource.includes('guidelineGermanOnly: "Speak German only throughout the interview."'));
  assert.ok(i18nSource.includes('guidelineTimeLimit: "The live interview lasts up to 120 seconds."'));
  assert.ok(i18nSource.includes('deviceLostDuringInterview:'));
  assert.ok(i18nSource.includes('retryRecordingUpload: "Retry secure upload"'));

  assert.ok(i18nSource.includes('guidelinesAcknowledge: "أفهم ذلك — متابعة"'));
  assert.ok(i18nSource.includes('guidelineGermanOnly: "تحدث بالألمانية فقط طوال المقابلة."'));
  assert.ok(i18nSource.includes('guidelineTimeLimit: "تستغرق المقابلة المباشرة حتى 120 ثانية."'));
  assert.ok(i18nSource.includes('retryRecordingUpload: "إعادة محاولة الرفع الآمن"'));
});
