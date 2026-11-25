"use client";

import { Icon } from "@/components/dashboard/icons";
import { useLocale } from "@/lib/i18n";
import { useTheme, type Theme } from "@/lib/theme";

export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  const { t } = useLocale();

  const options: { value: Theme; label: string; icon: "sun" | "moon" | "laptop" }[] = [
    { value: "light", label: t.theme.light, icon: "sun" },
    { value: "dark", label: t.theme.dark, icon: "moon" },
    { value: "system", label: t.theme.system, icon: "laptop" },
  ];

  return (
    <div
      aria-label={t.theme.label}
      className="inline-flex items-center rounded-lg border border-border bg-muted/60 p-0.5 text-xs shadow-sm"
      role="group"
    >
      {options.map((opt) => {
        const isActive = theme === opt.value;
        return (
          <button
            aria-label={opt.label}
            aria-pressed={isActive}
            className={`flex min-h-9 min-w-9 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
              isActive
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:bg-background/50 hover:text-foreground"
            }`}
            key={opt.value}
            onClick={() => setTheme(opt.value)}
            title={opt.label}
            type="button"
          >
            <Icon className="size-3.5" name={opt.icon} />
            <span className="hidden sm:inline">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
