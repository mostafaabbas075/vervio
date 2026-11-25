import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

function source(relativePath) {
  return readFileSync(new globalThis.URL(relativePath, import.meta.url), "utf8");
}

test("provider-specific Render Blueprint is removed while generic Docker assets remain", () => {
  const repositoryRoot = fileURLToPath(new globalThis.URL("../../", import.meta.url));
  const readme = readFileSync(new globalThis.URL("../../README.md", import.meta.url), "utf8");

  assert.equal(existsSync(`${repositoryRoot}render.yaml`), false);
  assert.match(readme, /## Generic Docker deployment/);
  assert.doesNotMatch(readme, /Render deployment|onrender\.com/i);
});

test("global mobile guards prevent page overflow and input zoom", () => {
  const styles = source("../app/globals.css");

  assert.match(styles, /min-width: 320px/);
  assert.match(styles, /overflow-x: clip/);
  assert.match(styles, /@media \(max-width: 639px\)/);
  assert.match(styles, /font-size: 1rem !important/);
  assert.match(styles, /safe-area-inset-top/);
});

test("authenticated workspace navigation wraps controls and retains a usable mobile drawer", () => {
  const shell = source("../components/dashboard/dashboard-shell.tsx");

  assert.match(shell, /w-64 lg:w-\[68px\]/);
  assert.match(shell, /max-w-\[calc\(100vw-1\.5rem\)\]/);
  assert.match(shell, /flex min-h-14 flex-wrap/);
  assert.match(shell, /max-w-full flex-wrap items-center justify-end/);
  assert.match(shell, /min-h-\[100dvh\]/);
});

test("login remains localized and usable on narrow screens", () => {
  const login = source("../components/login-form.tsx");
  const translations = source("../lib/i18n.tsx");

  assert.match(login, /min-h-\[100dvh\]/);
  assert.match(login, /px-4 pb-6 pt-20/);
  assert.match(login, /t\.login\.featureInterviews/);
  assert.match(login, /t\.login\.platformCaption/);
  assert.match(translations, /featureInterviews: "AI-led/);
  assert.match(translations, /featureInterviews: "مقابلات ألمانية/);
});

test("data workspaces stack on phones and reserve horizontal scrolling for tables", () => {
  const candidates = source("../components/dashboard/candidates-workspace.tsx");
  const interviews = source("../components/dashboard/interviews-workspace.tsx");
  const recordings = source("../components/dashboard/recordings-workspace.tsx");
  const evaluations = source("../components/dashboard/evaluations-workspace.tsx");

  assert.match(candidates, /flex flex-col justify-between gap-3 py-3\.5 sm:grid/);
  assert.match(candidates, /overflow-x-auto/);
  assert.match(interviews, /flex flex-col justify-between gap-3 py-3\.5 sm:grid/);
  assert.match(interviews, /overflow-x-auto/);
  assert.match(recordings, /grid gap-4 sm:grid-cols-2 lg:grid-cols-3/);
  assert.match(evaluations, /flex flex-wrap items-center gap-1\.5/);
});

test("Interview Studio keeps one responsive candidate stage and a scrollable mobile dialog", () => {
  const room = source("../components/interview-room/interview-room.tsx");

  assert.match(room, /data-testid="candidate-video-stage"/);
  assert.match(room, /aspect-\[3\/4\] w-full sm:aspect-video/);
  assert.match(room, /object-contain transition-opacity duration-300 sm:object-cover/);
  assert.match(room, /safe-area-top safe-area-inline/);
  assert.match(room, /max-h-\[calc\(100dvh-1\.5rem\)\] overflow-y-auto/);
  assert.match(room, /min-h-12 w-full items-center justify-center/);
  assert.doesNotMatch(room, /toggleMicrophone|toggleCamera|AI Interviewer Tile/);
});
