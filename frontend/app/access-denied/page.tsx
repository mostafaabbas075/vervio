"use client";

import { useRouter } from "next/navigation";

import { LanguageSwitcher } from "@/components/language-switcher";
import { useLocale } from "@/lib/i18n";

export default function AccessDeniedPage() {
  const router = useRouter();
  const { t } = useLocale();

  return (
    <main className="relative grid min-h-screen place-items-center bg-slate-950 px-6 text-slate-100">
      <div className="absolute end-6 top-6">
        <LanguageSwitcher />
      </div>
      <section className="max-w-md rounded-2xl border border-amber-900 bg-slate-900 p-8 text-center">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-amber-300">Vervio</p>
        <h1 className="mt-4 text-2xl font-semibold">{t.accessDenied.title}</h1>
        <p className="mt-3 text-slate-300">{t.accessDenied.description}</p>
        <button
          className="mt-6 text-sm font-medium text-cyan-300 hover:text-cyan-200"
          onClick={() => router.replace("/dashboard")}
        >
          {t.accessDenied.returnToDashboard}
        </button>
      </section>
    </main>
  );
}
