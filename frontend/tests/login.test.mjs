import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const typescript = require("../../node_modules/typescript");

function loadLoginModule() {
  const source = readFileSync(
    new globalThis.URL("../components/login-form.tsx", import.meta.url),
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
      return { apiBaseUrl: "http://localhost:8000" };
    }
    if (specifier === "@/lib/i18n") {
      return {
        useLocale: () => ({
          direction: "ltr",
          locale: "en",
          t: {
            login: {
              description: "Sign in to access information.",
              emailLabel: "Email address",
              eyebrow: "Vervio",
              formDescription: "Your access is managed by Vervio.",
              formTitle: "Sign in",
              hidePassword: "Hide password",
              invalidCredentials: "The email address or password is incorrect.",
              missingCredentials: "Enter your email address and password.",
              passwordLabel: "Password",
              showPassword: "Show password",
              submit: "Sign in",
              submitting: "Signing in…",
              title: "Secure access",
              unavailable: "Sign-in is unavailable right now.",
            },
          },
        }),
      };
    }
    if (specifier === "next/navigation") {
      return {
        useRouter: () => ({
          refresh: () => {},
          replace: () => {},
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

const { validateLoginInput } = loadLoginModule();

test("validateLoginInput rejects empty email or whitespace email", () => {
  const empty = validateLoginInput("", "password123");
  assert.equal(empty.isValid, false);
  assert.equal(empty.errorKey, "missingCredentials");

  const whitespace = validateLoginInput("   ", "password123");
  assert.equal(whitespace.isValid, false);
  assert.equal(whitespace.errorKey, "missingCredentials");
});

test("validateLoginInput rejects empty password", () => {
  const emptyPass = validateLoginInput("admin@vervio.com", "");
  assert.equal(emptyPass.isValid, false);
  assert.equal(emptyPass.errorKey, "missingCredentials");
});

test("validateLoginInput accepts valid email and password", () => {
  const valid = validateLoginInput("admin@vervio.com", "SecretPass123");
  assert.equal(valid.isValid, true);
  assert.equal(valid.errorKey, undefined);
});

test("i18n translations include password visibility and authentication strings in English and Arabic", () => {
  const i18nSource = readFileSync(
    new globalThis.URL("../lib/i18n.tsx", import.meta.url),
    "utf8",
  );

  assert.ok(i18nSource.includes("showPassword:"));
  assert.ok(i18nSource.includes("hidePassword:"));
  assert.ok(i18nSource.includes("Show password"));
  assert.ok(i18nSource.includes("إظهار كلمة المرور"));
  assert.ok(i18nSource.includes("Hide password"));
  assert.ok(i18nSource.includes("إخفاء كلمة المرور"));
});
