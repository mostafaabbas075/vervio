import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const typescript = require("../../node_modules/typescript");

function loadCandidatesWorkspaceModule() {
  const source = readFileSync(
    new globalThis.URL("../components/dashboard/candidates-workspace.tsx", import.meta.url),
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
          t: { candidates: {}, dashboard: {}, interviews: {}, navigation: {}, overview: {} },
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
  filterCandidatesList,
  formatCandidateDate,
  getCandidateInitials,
  getCandidateStatusBadgeClass,
} = loadCandidatesWorkspaceModule();

const mockCandidates = [
  {
    id: "c-1",
    given_name: "Youssef",
    family_name: "Ahmed",
    email: "youssef.ahmed@example.com",
    status: "active",
    created_at: "2026-11-20T10:30:00Z",
  },
  {
    id: "c-2",
    given_name: "Sarah",
    family_name: "Miller",
    email: "sarah.m@example.org",
    status: "active",
    created_at: "2026-11-19T14:15:00Z",
  },
  {
    id: "c-3",
    given_name: "Karim",
    family_name: "Nabil",
    email: "karim.n@example.com",
    status: "archived",
    created_at: "2026-11-18T09:00:00Z",
  },
];

test("filterCandidatesList returns all candidates when query is empty or whitespace", () => {
  assert.equal(filterCandidatesList(mockCandidates, "").length, 3);
  assert.equal(filterCandidatesList(mockCandidates, "   ").length, 3);
});

test("filterCandidatesList filters by given name or family name case-insensitively", () => {
  const matches = filterCandidatesList(mockCandidates, "youssef");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, "c-1");

  const miller = filterCandidatesList(mockCandidates, "MILLER");
  assert.equal(miller.length, 1);
  assert.equal(miller[0].id, "c-2");
});

test("filterCandidatesList filters by full name or email address substring", () => {
  const full = filterCandidatesList(mockCandidates, "Sarah Miller");
  assert.equal(full.length, 1);
  assert.equal(full[0].id, "c-2");

  const domain = filterCandidatesList(mockCandidates, "example.org");
  assert.equal(domain.length, 1);
  assert.equal(domain[0].id, "c-2");

  const none = filterCandidatesList(mockCandidates, "nonexistent-person");
  assert.equal(none.length, 0);
});

test("getCandidateInitials formats initials correctly", () => {
  assert.equal(getCandidateInitials("Youssef", "Ahmed"), "YA");
  assert.equal(getCandidateInitials("sarah", "miller"), "SM");
  assert.equal(getCandidateInitials("  Kareem ", "  Ali "), "KA");
  assert.equal(getCandidateInitials("", ""), "?");
});

test("formatCandidateDate formats ISO strings without throwing errors", () => {
  const enDate = formatCandidateDate("2026-11-20T10:30:00Z", "en");
  assert.ok(typeof enDate === "string");
  assert.ok(enDate.length > 0);

  const arDate = formatCandidateDate("2026-11-20T10:30:00Z", "ar");
  assert.ok(typeof arDate === "string");
  assert.ok(arDate.length > 0);
});

test("getCandidateStatusBadgeClass returns semantic badge styles", () => {
  const activeClass = getCandidateStatusBadgeClass("active");
  assert.ok(activeClass.includes("emerald"));

  const archivedClass = getCandidateStatusBadgeClass("archived");
  assert.ok(archivedClass.includes("muted"));
});
