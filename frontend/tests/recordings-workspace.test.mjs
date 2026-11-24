import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const typescript = require("../../node_modules/typescript");

function loadRecordingsWorkspaceModule() {
  const source = readFileSync(
    new globalThis.URL("../components/dashboard/recordings-workspace.tsx", import.meta.url),
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
    if (specifier === "@/components/dashboard/dashboard-shell") {
      return {
        useDashboardSession: () => ({
          csrfToken: "mock-csrf-token",
          user: { role: "admin", id: "admin-1", email: "admin@vervio.com" },
        }),
      };
    }
    if (specifier === "@/lib/auth") {
      return { apiBaseUrl: "http://localhost:8000" };
    }
    if (specifier === "@/lib/i18n") {
      return {
        useLocale: () => ({
          direction: "ltr",
          locale: "en",
          t: { recordingsWorkspace: {}, interviews: {}, dashboard: {} },
        }),
      };
    }
    if (specifier === "react") {
      return {
        useCallback: (fn) => fn,
        useEffect: () => {},
        useMemo: (fn) => fn(),
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

const {
  filterCandidates,
  formatBytes,
  formatDate,
  formatDuration,
  formatMs,
  formatSegmentTimestamp,
  getAssessmentUrl,
  getAssessmentRetryUrl,
  getCriterionDisplay,
  getRecommendationBadgeClass,
  getRecordingStreamUrl,
  getRequirementUrl,
  getSpeakerLabel,
  getTranscriptUrl,
  recordingCountLabel,
  shouldPollAssessment,
} = loadRecordingsWorkspaceModule();

test("formatDuration formats seconds to mm:ss and returns null for invalid values", () => {
  assert.equal(formatDuration(null), null);
  assert.equal(formatDuration(undefined), null);
  assert.equal(formatDuration(0), null);
  assert.equal(formatDuration(-10), null);

  assert.equal(formatDuration(45), "00:45");
  assert.equal(formatDuration(65), "01:05");
  assert.equal(formatDuration(600), "10:00");
  assert.equal(formatDuration(3665), "61:05");
});

test("formatBytes formats byte size to megabytes and returns null for invalid values", () => {
  assert.equal(formatBytes(null), null);
  assert.equal(formatBytes(undefined), null);
  assert.equal(formatBytes(0), null);
  assert.equal(formatBytes(-100), null);

  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
  assert.equal(formatBytes(34235904), "32.6 MB");
});

test("recordingCountLabel handles singular, dual, and plural in English and Arabic", () => {
  const enLabels = {
    oneRecording: "1 recording",
    twoRecordings: "2 recordings",
    multipleRecordings: "{count} recordings",
  };

  assert.equal(recordingCountLabel(1, enLabels), "1 recording");
  assert.equal(recordingCountLabel(2, enLabels), "2 recordings");
  assert.equal(recordingCountLabel(5, enLabels), "5 recordings");

  const arLabels = {
    oneRecording: "تسجيل واحد",
    twoRecordings: "تسجيلان",
    multipleRecordings: "{count} تسجيلات",
  };

  assert.equal(recordingCountLabel(1, arLabels), "تسجيل واحد");
  assert.equal(recordingCountLabel(2, arLabels), "تسجيلان");
  assert.equal(recordingCountLabel(7, arLabels), "7 تسجيلات");
});

test("filterCandidates filters candidate folders by name and email case-insensitively", () => {
  const sampleCandidates = [
    {
      id: "c1",
      candidate_id: "c1",
      full_name: "Youssef Ahmed",
      email: "youssef@example.com",
      recording_count: 2,
    },
    {
      id: "c2",
      candidate_id: "c2",
      full_name: "Sarah Miller",
      email: "sarah.m@example.org",
      recording_count: 1,
    },
    {
      id: "c3",
      candidate_id: "c3",
      full_name: "Ahmed Hassan",
      email: "ahmed.h@example.com",
      recording_count: 3,
    },
  ];

  // Empty or whitespace returns all
  assert.equal(filterCandidates(sampleCandidates, "").length, 3);
  assert.equal(filterCandidates(sampleCandidates, "   ").length, 3);

  // Match by name
  const nameMatches = filterCandidates(sampleCandidates, "ahmed");
  assert.equal(nameMatches.length, 2);
  assert.equal(nameMatches[0].full_name, "Youssef Ahmed");
  assert.equal(nameMatches[1].full_name, "Ahmed Hassan");

  // Match by email domain / substring
  const emailMatches = filterCandidates(sampleCandidates, "example.org");
  assert.equal(emailMatches.length, 1);
  assert.equal(emailMatches[0].full_name, "Sarah Miller");

  // No match
  assert.equal(filterCandidates(sampleCandidates, "nonexistent").length, 0);
});

test("getRecordingStreamUrl constructs private authenticated backend playback endpoint", () => {
  const url = getRecordingStreamUrl("http://localhost:8000", "sess-1234");
  assert.equal(url, "http://localhost:8000/interviews/sess-1234/recording/content");

  // Ensures special characters are encoded
  const encodedUrl = getRecordingStreamUrl("http://localhost:8000", "sess/with+special#chars");
  assert.equal(
    encodedUrl,
    "http://localhost:8000/interviews/sess%2Fwith%2Bspecial%23chars/recording/content",
  );

  // Never returns or exposes an R2/S3 raw or public URL
  assert.ok(!url.includes(".r2.cloudflarestorage.com"));
  assert.ok(!url.includes("https://"));
});

test("formatDate handles valid ISO dates without crashing", () => {
  const formatted = formatDate("2026-11-19T14:30:00Z", "en");
  assert.ok(typeof formatted === "string");
  assert.ok(formatted.length > 0);
});

test("formatMs converts milliseconds to mm:ss strings", () => {
  assert.equal(formatMs(0), "00:00");
  assert.equal(formatMs(1500), "00:01");
  assert.equal(formatMs(65000), "01:05");
  assert.equal(formatMs(3665000), "61:05");
});

test("formatSegmentTimestamp formats timing and suppresses missing timing", () => {
  // Missing or non-positive timestamps return null (never falsely display 00:00 as accurate)
  assert.equal(formatSegmentTimestamp(null, null), null);
  assert.equal(formatSegmentTimestamp(undefined, undefined), null);
  assert.equal(formatSegmentTimestamp(0, 0), null);
  assert.equal(formatSegmentTimestamp(-100, -50), null);
  assert.equal(formatSegmentTimestamp(-100, 0), null);

  // Positive start with higher end
  assert.equal(formatSegmentTimestamp(1500, 3500), "00:01 – 00:03");
  assert.equal(formatSegmentTimestamp(65000, 72000), "01:05 – 01:12");

  // Zero start with positive end
  assert.equal(formatSegmentTimestamp(0, 2500), "00:00 – 00:02");

  // Equal positive timestamps
  assert.equal(formatSegmentTimestamp(5000, 5000), "00:05");
});

test("getTranscriptUrl constructs private authenticated backend transcript endpoint", () => {
  const url = getTranscriptUrl("http://localhost:8000", "sess-1234");
  assert.equal(url, "http://localhost:8000/interviews/sess-1234/transcript");

  // Encodes special characters in session ID
  const encodedUrl = getTranscriptUrl("http://localhost:8000", "sess/with+special#chars");
  assert.equal(
    encodedUrl,
    "http://localhost:8000/interviews/sess%2Fwith%2Bspecial%23chars/transcript",
  );

  // Never leaks storage keys or R2 endpoints
  assert.ok(!url.includes("r2.cloudflarestorage.com"));
});

test("getSpeakerLabel maps speaker identifiers to localized labels", () => {
  const enLabels = {
    candidateSpeaker: "Candidate",
    interviewerSpeaker: "AI Interviewer",
    systemSpeaker: "System",
  };

  assert.equal(getSpeakerLabel("interviewer", enLabels), "AI Interviewer");
  assert.equal(getSpeakerLabel("ai", enLabels), "AI Interviewer");
  assert.equal(getSpeakerLabel("ai_interviewer", enLabels), "AI Interviewer");
  assert.equal(getSpeakerLabel("AI_INTERVIEWER", enLabels), "AI Interviewer");

  assert.equal(getSpeakerLabel("candidate", enLabels), "Candidate");
  assert.equal(getSpeakerLabel("user", enLabels), "Candidate");
  assert.equal(getSpeakerLabel("Candidate", enLabels), "Candidate");

  assert.equal(getSpeakerLabel("system", enLabels), "System");
  assert.equal(getSpeakerLabel("guest_observer", enLabels), "guest_observer");

  const arLabels = {
    candidateSpeaker: "المرشح",
    interviewerSpeaker: "المحاور الذكي",
    systemSpeaker: "النظام",
  };

  assert.equal(getSpeakerLabel("interviewer", arLabels), "المحاور الذكي");
  assert.equal(getSpeakerLabel("candidate", arLabels), "المرشح");
  assert.equal(getSpeakerLabel("system", arLabels), "النظام");
});

test("getAssessmentUrl constructs private authenticated backend assessment endpoint", () => {
  const url = getAssessmentUrl("http://localhost:8000", "sess-555");
  assert.equal(url, "http://localhost:8000/interviews/sess-555/assessment");

  // Encodes special characters in session ID
  const encodedUrl = getAssessmentUrl("http://localhost:8000", "sess/with+special#chars");
  assert.equal(
    encodedUrl,
    "http://localhost:8000/interviews/sess%2Fwith%2Bspecial%23chars/assessment",
  );

  // Never leaks storage keys or external URLs
  assert.ok(!url.includes("r2.cloudflarestorage.com"));
});

test("getRequirementUrl constructs private authenticated backend requirement endpoint", () => {
  const url = getRequirementUrl("http://localhost:8000", "sess-777");
  assert.equal(url, "http://localhost:8000/interviews/sess-777/requirement");

  const encodedUrl = getRequirementUrl("http://localhost:8000", "sess/with+special#chars");
  assert.equal(
    encodedUrl,
    "http://localhost:8000/interviews/sess%2Fwith%2Bspecial%23chars/requirement",
  );
});

test("shouldPollAssessment polls only while assessment status is pending and stops on final states", () => {
  // Pending assessment triggers 5-second polling
  assert.equal(shouldPollAssessment("pending"), true);

  // Terminal states stop polling immediately
  assert.equal(shouldPollAssessment("completed"), false);
  assert.equal(shouldPollAssessment("insufficient_evidence"), false);
  assert.equal(shouldPollAssessment("failed"), false);
  assert.equal(shouldPollAssessment(undefined), false);
});

test("getCriterionDisplay formats evaluated scores and marks unavailable criteria as Not Assessed without fabricated scores", () => {
  // 1. Evaluated criterion with valid score
  const grammar = {
    criterion_code: "grammar",
    label: "Grammatik & Sprachrichtigkeit",
    status: "evaluated",
    score: 85.0,
    rationale: "Accurate syntax and proper modal verbs.",
  };
  const grammarDisplay = getCriterionDisplay(grammar);
  assert.equal(grammarDisplay.isEvaluated, true);
  assert.equal(grammarDisplay.isUnavailable, false);
  assert.equal(grammarDisplay.isInsufficient, false);
  assert.equal(grammarDisplay.scoreText, "85");
  assert.equal(grammarDisplay.reasonText, "Accurate syntax and proper modal verbs.");

  // 2. Unavailable criterion (such as pronunciation from transcript text alone)
  const pronunciation = {
    criterion_code: "pronunciation",
    label: "Aussprache & Intonation",
    status: "unavailable",
    score: null,
    unavailable_reason:
      "Audio acoustic analysis required — not assessed from transcript text alone.",
  };
  const pronDisplay = getCriterionDisplay(pronunciation);
  assert.equal(pronDisplay.isEvaluated, false);
  assert.equal(pronDisplay.isUnavailable, true);
  assert.equal(pronDisplay.isInsufficient, false);
  assert.equal(pronDisplay.scoreText, null); // Strictly null — NO fabricated score!
  assert.equal(
    pronDisplay.reasonText,
    "Audio acoustic analysis required — not assessed from transcript text alone.",
  );

  // 3. Insufficient evidence criterion
  const insufficientCrit = {
    criterion_code: "fluency",
    label: "Redefluss & Flüssigkeit",
    status: "insufficient_evidence",
    score: null,
    rationale: "Not enough connected speech.",
  };
  const insuffDisplay = getCriterionDisplay(insufficientCrit);
  assert.equal(insuffDisplay.isEvaluated, false);
  assert.equal(insuffDisplay.isUnavailable, false);
  assert.equal(insuffDisplay.isInsufficient, true);
  assert.equal(insuffDisplay.scoreText, null);
  assert.equal(insuffDisplay.reasonText, "Not enough connected speech.");

  // 4. Missing or undefined criterion
  const emptyDisplay = getCriterionDisplay(undefined);
  assert.equal(emptyDisplay.isEvaluated, false);
  assert.equal(emptyDisplay.isUnavailable, true);
  assert.equal(emptyDisplay.scoreText, null);
});

test("getRecommendationBadgeClass returns correct styling classes for all recommendation states", () => {
  const meets = getRecommendationBadgeClass("meets_requirement");
  assert.ok(meets.includes("emerald"));

  const below = getRecommendationBadgeClass("below_requirement");
  assert.ok(below.includes("amber"));

  const insuff = getRecommendationBadgeClass("insufficient_evidence");
  assert.ok(insuff.includes("amber"));

  const notCfg = getRecommendationBadgeClass("not_configured");
  assert.ok(notCfg.includes("slate"));

  const fallback = getRecommendationBadgeClass(undefined);
  assert.ok(fallback.includes("slate"));
});

test("Candidate claimed level from CV is isolated from demonstrated AI CEFR level", () => {
  const sampleAssessment = {
    assessment_status: "completed",
    estimated_cefr_level: "B2",
    overall_score: 84.5,
    candidate_claimed_level: "C2", // Claimed on CV
    required_german_level: "B2",
    recommendation: {
      recommendation_state: "meets_requirement",
      required_german_level: "B2",
      assessed_german_level: "B2",
      explanation: "Demonstrated B2 German meets the required B2 level.",
    },
  };

  // AI-assessed level must reflect demonstrated performance (B2), NOT CV claim (C2)
  assert.equal(sampleAssessment.estimated_cefr_level, "B2");
  assert.equal(sampleAssessment.candidate_claimed_level, "C2");
  assert.notEqual(sampleAssessment.estimated_cefr_level, sampleAssessment.candidate_claimed_level);

  // Recommendation must evaluate demonstrated level against required level, ignoring claimed level
  assert.equal(sampleAssessment.recommendation.assessed_german_level, "B2");
  assert.equal(sampleAssessment.recommendation.recommendation_state, "meets_requirement");
});

test("getAssessmentRetryUrl constructs correct retry endpoint URL", () => {
  const url = getAssessmentRetryUrl("http://localhost:8000", "session-123");
  assert.equal(url, "http://localhost:8000/interviews/session-123/assessment/retry");

  const urlEncoded = getAssessmentRetryUrl("http://localhost:8000", "session with spaces");
  assert.equal(urlEncoded, "http://localhost:8000/interviews/session%20with%20spaces/assessment/retry");
});

test("shouldPollAssessment returns true only for pending status", () => {
  assert.equal(shouldPollAssessment("pending"), true);
  assert.equal(shouldPollAssessment("completed"), false);
  assert.equal(shouldPollAssessment("insufficient_evidence"), false);
  assert.equal(shouldPollAssessment("failed"), false);
  assert.equal(shouldPollAssessment(undefined), false);
});

test("RecordingsWorkspace translations include user-friendly error explanation and retrying state", () => {
  const i18nSource = readFileSync(
    new globalThis.URL("../lib/i18n.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(i18nSource.includes("retryingAssessment:"));
  assert.ok(i18nSource.includes("failedExplanation:"));
  assert.ok(i18nSource.includes("The language evaluation could not be completed. You can safely retry the assessment."));
  assert.ok(i18nSource.includes("تعذر إكمال التقييم اللغوي. يمكنك إعادة محاولة التقييم بأمان."));
});

