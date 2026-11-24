"use client";

import { Icon, type IconName } from "@/components/dashboard/icons";
import { useLocale } from "@/lib/i18n";

type Section = "evaluations" | "settings";

const sectionIcons: Record<Section, IconName> = {
  evaluations: "evaluations",
  settings: "settings",
};

export function SectionPlaceholder({ section }: { section: Section }) {
  const { t } = useLocale();
  const content = t.emptyStates[section];

  return (
    <section className="relative overflow-hidden rounded-xl border border-border bg-card px-6 py-16 text-card-foreground shadow-sm sm:px-10">
      <div className="relative mx-auto max-w-lg text-center">
        <span className="mx-auto grid size-12 place-items-center rounded-xl bg-primary/10 text-primary">
          <Icon className="size-6" name={sectionIcons[section]} />
        </span>
        <h2 className="mt-5 text-lg font-semibold tracking-tight text-foreground sm:text-xl">
          {content.title}
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{content.description}</p>
      </div>
    </section>
  );
}
