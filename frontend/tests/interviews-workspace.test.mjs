import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const typescript = require("../../node_modules/typescript");

function loadInterviewsWorkspaceModule() {
  const source = readFileSync(
    new globalThis.URL("../components/dashboard/interviews-workspace.tsx", import.meta.url),
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
            candidates: { actions: "Actions" },
            dashboard: { loading: "Loading" },
            interviews: {
              candidate: "Candidate",
              completed: "Completed",
              created: "Created",
              createSession: "Create session",
              description: "Description",
              details: "Details",
              inProgress: "In progress",
              notConfigured: "Not configured",
              requiredLevel: "Required level",
              scheduled: "Scheduled",
              searchPlaceholder: "Search",
              selectCandidate: "Select candidate",
              status: "Status",
              title: "Interviews",
              totalSessions: "{count} sessions",
              viewDetails: "View details",
            },
            navigation: {},
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
  filterInterviewSessions,
  formatSessionDate,
  getInterviewStatusBadgeClass,
} = loadInterviewsWorkspaceModule();

const mockSessions = [
  {
    id: "sess-1",
    candidate: { id: "c-1", given_name: "Youssef", family_name: "Ahmed", email: "youssef@example.com", status: "active", created_at: "2026-11-20T10:00:00Z" },
    status: "completed",
    required_german_level: "B2",
    created_at: "2026-11-20T11:00:00Z",
  },
  {
    id: "sess-2",
    candidate: { id: "c-2", given_name: "Sarah", family_name: "Miller", email: "sarah.m@example.org", status: "active", created_at: "2026-11-19T10:00:00Z" },
    status: "scheduled",
    required_german_level: "C1",
    created_at: "2026-11-20T12:00:00Z",
  },
  {
    id: "sess-3",
    candidate: { id: "c-3", given_name: "Karim", family_name: "Nabil", email: "karim@example.com", status: "active", created_at: "2026-11-18T10:00:00Z" },
    status: "in_progress",
    required_german_level: null,
    created_at: "2026-11-20T13:00:00Z",
  },
];

test("filterInterviewSessions returns all sessions when query is empty or whitespace", () => {
  assert.equal(filterInterviewSessions(mockSessions, "").length, 3);
  assert.equal(filterInterviewSessions(mockSessions, "   ").length, 3);
});

test("filterInterviewSessions filters by candidate name case-insensitively", () => {
  const matches = filterInterviewSessions(mockSessions, "youssef");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, "sess-1");

  const miller = filterInterviewSessions(mockSessions, "MILLER");
  assert.equal(miller.length, 1);
  assert.equal(miller[0].id, "sess-2");
});

test("filterInterviewSessions filters by status or required level", () => {
  const scheduled = filterInterviewSessions(mockSessions, "scheduled");
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].id, "sess-2");

  const b2 = filterInterviewSessions(mockSessions, "B2");
  assert.equal(b2.length, 1);
  assert.equal(b2[0].id, "sess-1");
});

test("formatSessionDate formats valid date without crashing", () => {
  const enDate = formatSessionDate("2026-11-20T11:00:00Z", "en");
  assert.ok(typeof enDate === "string");
  assert.ok(enDate.length > 0);

  const arDate = formatSessionDate("2026-11-20T11:00:00Z", "ar");
  assert.ok(typeof arDate === "string");
  assert.ok(arDate.length > 0);
});

test("getInterviewStatusBadgeClass assigns correct semantic classes", () => {
  const completed = getInterviewStatusBadgeClass("completed");
  assert.ok(completed.includes("emerald"));

  const inProgress = getInterviewStatusBadgeClass("in_progress");
  assert.ok(inProgress.includes("amber"));

  const scheduled = getInterviewStatusBadgeClass("scheduled");
  assert.ok(scheduled.includes("primary"));

  const failed = getInterviewStatusBadgeClass("failed");
  assert.ok(failed.includes("destructive"));
});
