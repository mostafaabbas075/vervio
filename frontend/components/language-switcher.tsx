"use client";

import { useLocale } from "@/lib/i18n";

export function LanguageSwitcher() {
  const { locale, setLocale, t } = useLocale();

  return (
    <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
      <span className="sr-only">{t.languageSwitcher.label}</span>
      <select
        aria-label={t.languageSwitcher.label}
        className="min-h-10 rounded-md border border-input bg-background px-2.5 py-1 text-xs font-medium text-foreground shadow-sm outline-none transition hover:bg-accent/50 focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring sm:min-h-8"
        onChange={(event) => setLocale(event.target.value as "en" | "ar")}
        value={locale}
      >
        <option value="en">{t.languageSwitcher.english}</option>
        <option value="ar">{t.languageSwitcher.arabic}</option>
      </select>
    </label>
  );
}
