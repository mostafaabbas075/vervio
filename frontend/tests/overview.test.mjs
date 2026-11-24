import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const typescript = require("../../node_modules/typescript");

function loadOverviewModule() {
  const source = readFileSync(
    new globalThis.URL("../components/dashboard/overview.tsx", import.meta.url),
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
          user: { role: "admin", id: "admin-1", full_name: "Admin User", email: "admin@vervio.com" },
        }),
      };
    }
    if (specifier === "@/lib/auth") {
      return { apiBaseUrl: "http://localhost:8000" };
    }
    if (specifier === "@/lib/i18n") {
      return {
        formatTranslation: (template, vars) =>
          template.replace(/{(\w+)}/g, (_, k) => vars[k] ?? `{${k}}`),
        useLocale: () => ({
          direction: "ltr",
          locale: "en",
          t: {
            dashboard: { welcome: "Welcome, {name}" },
            interviews: { title: "Interviews", inProgress: "In progress", scheduled: "Scheduled", completed: "Completed" },
            navigation: {},
            overview: {
              activeCandidateProfiles: "Active candidate profiles",
              completed: "Completed",
              completedInterviews: "Completed interviews",
              completedRecordings: "Audio & transcripts ready",
              description: "Overview description",
              eyebrow: "Overview",
              inProgress: "In progress",
              inProgressSessions: "Currently active interviews",
              interviewStatus: "Interview status overview",
              noActivity: "No activity",
              noData: "No data",
              quickAccess: "Quick access",
              quickAccessDescription: "Go directly to areas",
              recentActivity: "Recent activity",
              recentActivityDescription: "Workspace updates",
              scheduled: "Scheduled",
              scheduledInterviews: "Scheduled interviews",
              totalCandidates: "Total candidates",
              upcomingSessions: "Upcoming sessions",
              viewCandidates: "Open candidates",
              viewEvaluations: "Open evaluations",
              viewInterviews: "Open interviews",
              viewRecordings: "Open recordings",
            },
          },
        }),
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
  computeOverviewKPIs,
  formatActivityDate,
  getInterviewStatusBadgeClass,
  getStatusBreakdown,
} = loadOverviewModule();

const mockCandidates = [
  { id: "c-1", given_name: "Youssef", family_name: "Ahmed", email: "y@example.com", status: "active", created_at: "2026-11-20T10:00:00Z" },
  { id: "c-2", given_name: "Sarah", family_name: "Miller", email: "s@example.com", status: "active", created_at: "2026-11-19T10:00:00Z" },
  { id: "c-3", given_name: "Karim", family_name: "Nabil", email: "k@example.com", status: "archived", created_at: "2026-11-18T10:00:00Z" },
];

const mockInterviews = [
  {
    id: "i-1",
    candidate: mockCandidates[0],
    status: "completed",
    created_at: "2026-11-20T12:00:00Z",
    has_recording: true,
  },
  {
    id: "i-2",
    candidate: mockCandidates[1],
    status: "scheduled",
    created_at: "2026-11-20T14:00:00Z",
    has_recording: false,
  },
  {
    id: "i-3",
    candidate: mockCandidates[2],
    status: "in_progress",
    created_at: "2026-11-20T15:00:00Z",
    has_recording: false,
  },
  {
    id: "i-4",
    candidate: mockCandidates[0],
    status: "completed",
    created_at: "2026-11-19T11:00:00Z",
    has_recording: true,
  },
];

test("computeOverviewKPIs computes total candidates and breakdown by interview status", () => {
  const kpis = computeOverviewKPIs(mockCandidates, mockInterviews);
  assert.equal(kpis.totalCandidates, 3);
  assert.equal(kpis.completedInterviews, 2);
  assert.equal(kpis.scheduledInterviews, 1);
  assert.equal(kpis.inProgressInterviews, 1);
});

test("computeOverviewKPIs handles empty candidates and interviews safely", () => {
  const kpis = computeOverviewKPIs([], []);
  assert.equal(kpis.totalCandidates, 0);
  assert.equal(kpis.completedInterviews, 0);
  assert.equal(kpis.scheduledInterviews, 0);
  assert.equal(kpis.inProgressInterviews, 0);
});

test("getStatusBreakdown computes counts and total accurately", () => {
  const breakdown = getStatusBreakdown(mockInterviews);
  assert.equal(breakdown.total, 4);
  assert.equal(breakdown.completed, 2);
  assert.equal(breakdown.scheduled, 1);
  assert.equal(breakdown.inProgress, 1);
});

test("formatActivityDate formats dates without throwing errors", () => {
  const formatted = formatActivityDate("2026-11-20T12:00:00Z", "en");
  assert.ok(typeof formatted === "string");
  assert.ok(formatted.length > 0);
});

test("getInterviewStatusBadgeClass assigns correct semantic classes for all statuses", () => {
  const completedClass = getInterviewStatusBadgeClass("completed");
  assert.ok(completedClass.includes("emerald"));

  const inProgressClass = getInterviewStatusBadgeClass("in_progress");
  assert.ok(inProgressClass.includes("amber"));

  const scheduledClass = getInterviewStatusBadgeClass("scheduled");
  assert.ok(scheduledClass.includes("primary"));

  const cancelledClass = getInterviewStatusBadgeClass("cancelled");
  assert.ok(cancelledClass.includes("muted"));
});
