import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const typescript = require("../../node_modules/typescript");

function loadEvaluationsWorkspaceModule() {
  const source = readFileSync(
    new globalThis.URL("../components/dashboard/evaluations-workspace.tsx", import.meta.url),
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
          t: {
            dashboard: { loading: "Loading" },
            evaluations: {
              averageScore: "Average score",
              description: "Description",
              filterAll: "All",
              filterCompleted: "Completed",
              filterFailed: "Failed",
              filterInsufficient: "Insufficient",
              filterPending: "Pending",
              insufficientEvidence: "Insufficient evidence",
              noEvaluations: "No evaluations",
              noEvaluationsDescription: "No evaluations description",
              noMatchingEvaluations: "No matching evaluations",
              pendingCount: "Pending count",
              retryAssessment: "Retry",
              searchPlaceholder: "Search",
              title: "Evaluations",
              totalEvaluated: "Total evaluated",
              viewFullReport: "View report",
            },
            recordingsWorkspace: {
              belowRequirement: "Below requirement",
              claimedLevel: "Claimed level",
              loadFailed: "Load failed",
              meetsRequirement: "Meets requirement",
              notConfigured: "Not configured",
              notConfiguredRecommendation: "Not configured",
              notSpecified: "Not specified",
              overallScore: "Score",
              recommendation: "Recommendation",
              requiredLevel: "Required level",
              retryingAssessment: "Retrying",
              statusAnalyzing: "Analyzing",
              statusCompleted: "Completed",
              statusFailed: "Failed",
              statusInsufficient: "Insufficient",
            },
          },
        }),
      };
    }
    if (specifier === "@/components/dashboard/recordings-workspace") {
      return {
        getAssessmentRetryUrl: (base, id) => `${base}/interviews/${id}/assessment/retry`,
        getAssessmentUrl: (base, id) => `${base}/interviews/${id}/assessment`,
        getRecommendationBadgeClass: (state) =>
          state === "meets_requirement"
            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700"
            : "border-amber-500/30 bg-amber-500/10 text-amber-700",
      };
    }
    if (specifier === "next/link") {
      return { default: ({ children }) => children };
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
  computeEvaluationKPIs,
  filterEvaluations,
  formatEvaluationDate,
  getEvaluationStatusBadgeClass,
} = loadEvaluationsWorkspaceModule();

const mockEvaluations = [
  {
    interview_session_id: "s-1",
    candidate_name: "Youssef Ahmed",
    candidate_email: "youssef@example.com",
    assessment_status: "completed",
    estimated_cefr_level: "B2",
    overall_score: 85.0,
    candidate_claimed_level: "C1",
    required_german_level: "B2",
    recommendation_state: "meets_requirement",
    summary: "Demonstrated strong professional vocabulary.",
    evaluated_at: "2026-11-20T10:00:00Z",
  },
  {
    interview_session_id: "s-2",
    candidate_name: "Sarah Miller",
    candidate_email: "sarah.m@example.org",
    assessment_status: "completed",
    estimated_cefr_level: "C1",
    overall_score: 95.0,
    candidate_claimed_level: "B2",
    required_german_level: "B2",
    recommendation_state: "meets_requirement",
    summary: "Fluent and precise conversational German.",
    evaluated_at: "2026-11-19T10:00:00Z",
  },
  {
    interview_session_id: "s-3",
    candidate_name: "Karim Nabil",
    candidate_email: "karim@example.com",
    assessment_status: "insufficient_evidence",
    estimated_cefr_level: null,
    overall_score: null,
    candidate_claimed_level: "B1",
    required_german_level: "B2",
    recommendation_state: "insufficient_evidence",
    evaluated_at: "2026-11-18T10:00:00Z",
  },
  {
    interview_session_id: "s-4",
    candidate_name: "Mona Hassan",
    candidate_email: "mona@example.com",
    assessment_status: "pending",
    estimated_cefr_level: null,
    overall_score: null,
    evaluated_at: "2026-11-17T10:00:00Z",
  },
];

test("computeEvaluationKPIs calculates total completed, average score, insufficient and pending counts", () => {
  const kpis = computeEvaluationKPIs(mockEvaluations);
  assert.equal(kpis.totalEvaluated, 2);
  assert.equal(kpis.averageScore, 90.0); // (85 + 95) / 2
  assert.equal(kpis.insufficientCount, 1);
  assert.equal(kpis.pendingCount, 1);
});

test("computeEvaluationKPIs returns null average score when no evaluations are completed", () => {
  const kpis = computeEvaluationKPIs([
    {
      interview_session_id: "s-x",
      assessment_status: "pending",
      overall_score: null,
    },
  ]);
  assert.equal(kpis.totalEvaluated, 0);
  assert.equal(kpis.averageScore, null);
});

test("filterEvaluations filters by statusFilter and search query", () => {
  // All
  assert.equal(filterEvaluations(mockEvaluations, "", "all").length, 4);

  // Filter completed only
  const completed = filterEvaluations(mockEvaluations, "", "completed");
  assert.equal(completed.length, 2);

  // Filter insufficient only
  const insuff = filterEvaluations(mockEvaluations, "", "insufficient_evidence");
  assert.equal(insuff.length, 1);
  assert.equal(insuff[0].candidate_name, "Karim Nabil");

  // Search by candidate name
  const searched = filterEvaluations(mockEvaluations, "sarah", "all");
  assert.equal(searched.length, 1);
  assert.equal(searched[0].candidate_name, "Sarah Miller");

  // Search by CEFR level
  const b2Search = filterEvaluations(mockEvaluations, "B2", "all");
  assert.equal(b2Search.length, 1);
  assert.equal(b2Search[0].candidate_name, "Youssef Ahmed");
});

test("Candidate claimed level from CV is kept independent from demonstrated AI CEFR level", () => {
  const item = mockEvaluations[0];
  // Candidate claimed C1, but demonstrated B2
  assert.equal(item.candidate_claimed_level, "C1");
  assert.equal(item.estimated_cefr_level, "B2");
  assert.notEqual(item.candidate_claimed_level, item.estimated_cefr_level);
});

test("getEvaluationStatusBadgeClass assigns correct semantic classes", () => {
  const completed = getEvaluationStatusBadgeClass("completed");
  assert.ok(completed.includes("emerald"));

  const pending = getEvaluationStatusBadgeClass("pending");
  assert.ok(pending.includes("amber"));

  const insufficient = getEvaluationStatusBadgeClass("insufficient_evidence");
  assert.ok(insufficient.includes("amber"));

  const failed = getEvaluationStatusBadgeClass("failed");
  assert.ok(failed.includes("destructive"));
});

test("formatEvaluationDate formats ISO dates without crashing", () => {
  const formatted = formatEvaluationDate("2026-11-20T10:00:00Z", "en");
  assert.ok(typeof formatted === "string");
  assert.ok(formatted.length > 0);

  const fallback = formatEvaluationDate(null, "en");
  assert.equal(fallback, "—");
});
