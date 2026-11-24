"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { Icon } from "@/components/dashboard/icons";
import { apiBaseUrl } from "@/lib/auth";
import { useLocale } from "@/lib/i18n";

export function AdminSection({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { t } = useLocale();
  const [state, setState] = useState<"checking" | "allowed" | "unavailable">("checking");

  useEffect(() => {
    async function verifyAdministrationAccess() {
      try {
        const response = await fetch(`${apiBaseUrl}/auth/admin/access`, {
          credentials: "include",
          cache: "no-store",
        });
        if (response.status === 401) {
          router.replace("/login");
          return;
        }
        if (response.status === 403) {
          router.replace("/access-denied");
          return;
        }
        setState(response.ok ? "allowed" : "unavailable");
      } catch {
        setState("unavailable");
      }
    }

    void verifyAdministrationAccess();
  }, [router]);

  if (state === "allowed") {
    return <>{children}</>;
  }

  return (
    <section className="grid min-h-72 place-items-center rounded-xl border border-border bg-card px-6 text-center text-card-foreground shadow-sm">
      <div className="max-w-sm">
        <span className="mx-auto grid size-10 place-items-center rounded-lg bg-primary/10 text-primary">
          <Icon className="size-5" name={state === "checking" ? "sparkles" : "activity"} />
        </span>
        <p className="mt-4 text-sm leading-6 text-muted-foreground">
          {state === "checking" ? t.authorization.checking : t.authorization.unavailable}
        </p>
      </div>
    </section>
  );
}
