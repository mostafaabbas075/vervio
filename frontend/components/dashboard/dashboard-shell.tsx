"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { LanguageSwitcher } from "@/components/language-switcher";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { Icon, type IconName } from "@/components/dashboard/icons";
import { apiBaseUrl, fetchSession, type AuthenticatedUser } from "@/lib/auth";
import { useLocale } from "@/lib/i18n";

type DashboardContextValue = {
  user: AuthenticatedUser;
  csrfToken: string;
};

type NavigationItem = {
  href: string;
  icon: IconName;
  labelKey: "overview" | "candidates" | "interviews" | "recordings" | "evaluations" | "settings";
};

const DashboardContext = createContext<DashboardContextValue | null>(null);

const navigationItems: readonly NavigationItem[] = [
  { href: "/dashboard", icon: "overview", labelKey: "overview" },
  { href: "/dashboard/candidates", icon: "candidates", labelKey: "candidates" },
  { href: "/dashboard/interviews", icon: "interviews", labelKey: "interviews" },
  { href: "/dashboard/recordings", icon: "recording", labelKey: "recordings" },
  { href: "/dashboard/evaluations", icon: "evaluations", labelKey: "evaluations" },
  { href: "/dashboard/settings", icon: "settings", labelKey: "settings" },
];

function pageLabelKey(pathname: string): NavigationItem["labelKey"] {
  const item = navigationItems.find(
    (navigationItem) =>
      navigationItem.href === pathname || pathname.startsWith(`${navigationItem.href}/`),
  );
  return item?.labelKey ?? "overview";
}

export function useDashboardSession(): DashboardContextValue {
  const context = useContext(DashboardContext);
  if (!context) {
    throw new Error("useDashboardSession must be used inside DashboardShell.");
  }
  return context;
}

const SIDEBAR_COLLAPSED_STORAGE_KEY = "vervio-sidebar-collapsed";

function DashboardSidebar({
  isOpen,
  onClose,
  isCollapsed,
  onToggleCollapse,
  user,
}: {
  isOpen: boolean;
  onClose: () => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  user: AuthenticatedUser;
}) {
  const pathname = usePathname();
  const { direction, t } = useLocale();
  const visibleItems =
    user.role === "admin" ? navigationItems : navigationItems.filter((item) => item.href === "/dashboard");
  const closedPosition = direction === "rtl" ? "translate-x-full" : "-translate-x-full";

  const userInitials = useMemo(() => {
    if (!user.full_name) return "U";
    const parts = user.full_name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
    }
    return user.full_name.slice(0, 2).toUpperCase();
  }, [user.full_name]);

  return (
    <>
      {/* Mobile Backdrop */}
      {isOpen ? (
        <button
          aria-label={t.navigation.closeMenu}
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden"
          onClick={onClose}
          type="button"
        />
      ) : null}

      {/* Sidebar container */}
      <aside
        aria-label={t.navigation.workspace}
        className={`fixed inset-y-0 start-0 z-50 flex flex-col border-e border-border bg-card transition-all duration-200 lg:translate-x-0 ${
          isOpen ? "translate-x-0 shadow-2xl" : closedPosition
        } ${isCollapsed ? "w-64 lg:w-[68px]" : "w-64"} max-w-[calc(100vw-1.5rem)]`}
      >
        {/* Brand / Header */}
        <div className={`flex h-14 items-center border-b border-border px-3.5 ${isCollapsed ? "justify-center" : "justify-between"}`}>
          <Link
            className="flex items-center gap-2.5 overflow-hidden rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            href="/dashboard"
            onClick={onClose}
            title="Vervio"
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground shadow-sm">
              <Icon className="size-4" name="sparkles" />
            </span>
            {!isCollapsed || isOpen ? (
              <div className="flex flex-col">
                <span className="text-base font-bold tracking-tight text-foreground leading-none">
                  Vervio
                </span>
                <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mt-0.5">
                  Interviews
                </span>
              </div>
            ) : null}
          </Link>

          {/* Mobile close button */}
          <button
            aria-label={t.navigation.closeMenu}
            className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground lg:hidden"
            onClick={onClose}
            type="button"
          >
            <Icon className="size-4" name="x" />
          </button>
        </div>

        {/* Section title (expanded only) */}
        {!isCollapsed ? (
          <div className="px-4 pt-5 pb-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t.navigation.workspace}
            </p>
          </div>
        ) : (
          <div className="pt-3" />
        )}

        {/* Navigation list */}
        <nav className="flex-1 space-y-1 px-2.5 overflow-y-auto">
          {visibleItems.map((item) => {
            const isActive = pathname === item.href;
            const label = t.navigation[item.labelKey];

            return (
              <Link
                className={`group flex items-center rounded-lg text-xs font-medium transition-colors ${
                  isCollapsed
                    ? "w-full gap-3 px-3 py-2.5 lg:size-10 lg:justify-center lg:mx-auto lg:px-0"
                    : "min-h-10 gap-3 px-3 py-2.5"
                } ${
                  isActive
                    ? "bg-primary/10 text-primary font-semibold dark:bg-primary/15 dark:text-cyan-300"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                }`}
                href={item.href}
                key={item.href}
                onClick={onClose}
                title={isCollapsed ? label : undefined}
              >
                <Icon
                  className={`size-4 shrink-0 ${
                    isActive ? "text-primary dark:text-cyan-300" : "text-muted-foreground group-hover:text-foreground"
                  }`}
                  name={item.icon}
                />
                {!isCollapsed || isOpen ? <span className="truncate">{label}</span> : null}
              </Link>
            );
          })}
        </nav>

        {/* Sidebar Footer with User Details & Collapse Button */}
        <div className="border-t border-border p-2.5 space-y-2">
          {/* User card */}
          <div
            className={`flex items-center rounded-lg bg-muted/40 p-2 border border-border/60 ${
              isCollapsed ? "justify-center" : "gap-2.5"
            }`}
          >
            <span
              className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-primary font-semibold text-xs border border-primary/20 dark:bg-primary/20 dark:text-cyan-300"
              title={user.full_name}
            >
              {userInitials}
            </span>
            {!isCollapsed ? (
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-semibold text-foreground leading-tight">
                  {user.full_name}
                </p>
                <p className="truncate text-[11px] text-muted-foreground leading-tight mt-0.5" dir="ltr">
                  {user.email}
                </p>
                <span className="mt-1 inline-block rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium text-secondary-foreground">
                  {user.role === "admin" ? t.roles.admin : t.roles.clientReviewer}
                </span>
              </div>
            ) : null}
          </div>

          {/* Desktop collapse / expand toggle inside sidebar */}
          <button
            aria-label={isCollapsed ? t.navigation.expandSidebar : t.navigation.collapseSidebar}
            className={`hidden lg:flex items-center rounded-lg text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors ${
              isCollapsed ? "size-9 justify-center mx-auto" : "w-full gap-2 px-3 py-1.5"
            }`}
            onClick={onToggleCollapse}
            title={isCollapsed ? t.navigation.expandSidebar : t.navigation.collapseSidebar}
            type="button"
          >
            <Icon className="size-4 shrink-0" name="sidebar" />
            {!isCollapsed ? (
              <span className="text-[11px]">{t.navigation.collapseSidebar}</span>
            ) : null}
          </button>
        </div>
      </aside>
    </>
  );
}

function DashboardTopbar({
  onOpenNavigation,
  onToggleCollapse,
  isCollapsed,
  onLogout,
  isLoggingOut,
  user,
}: {
  onOpenNavigation: () => void;
  onToggleCollapse: () => void;
  isCollapsed: boolean;
  onLogout: () => void;
  isLoggingOut: boolean;
  user: AuthenticatedUser;
}) {
  const pathname = usePathname();
  const { t } = useLocale();
  const pageTitle = t.navigation[pageLabelKey(pathname)];

  return (
    <header className="sticky top-0 z-30 flex min-h-14 flex-wrap items-center justify-between gap-2 border-b border-border bg-background/95 px-3 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/60 sm:px-6 sm:py-0 lg:px-8">
      {/* Left: Sidebar triggers + Breadcrumbs */}
      <div className="flex min-w-0 flex-1 items-center gap-2.5 sm:gap-3">
        {/* Mobile menu toggle */}
        <button
          aria-label={t.navigation.menu}
          className="grid size-10 shrink-0 place-items-center rounded-md border border-input bg-background text-foreground shadow-sm hover:bg-accent hover:text-accent-foreground lg:hidden"
          onClick={onOpenNavigation}
          type="button"
        >
          <Icon className="size-4" name="menu" />
        </button>

        {/* Desktop sidebar toggle button */}
        <button
          aria-label={isCollapsed ? t.navigation.expandSidebar : t.navigation.collapseSidebar}
          className="hidden lg:grid size-10 shrink-0 place-items-center rounded-md border border-input bg-background text-foreground shadow-sm hover:bg-accent hover:text-accent-foreground transition-colors"
          onClick={onToggleCollapse}
          title={isCollapsed ? t.navigation.expandSidebar : t.navigation.collapseSidebar}
          type="button"
        >
          <Icon className="size-4" name="sidebar" />
        </button>

        {/* Breadcrumb typography */}
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium truncate">
          <span className="hidden sm:inline hover:text-foreground transition-colors">
            {t.navigation.workspace}
          </span>
          <span className="hidden sm:inline text-muted-foreground/60">/</span>
          <h1 className="text-sm font-semibold text-foreground truncate">
            {pageTitle}
          </h1>
        </nav>
      </div>

      {/* Right: Controls & Profile */}
      <div className="ms-auto flex max-w-full flex-wrap items-center justify-end gap-2 sm:gap-3">
        <ThemeSwitcher />
        <LanguageSwitcher />

        {/* User preview on desktop */}
        <div className="hidden min-w-0 border-s border-border ps-3 text-end md:block">
          <p className="truncate text-xs font-semibold text-foreground leading-tight">
            {user.full_name}
          </p>
          <p className="truncate text-[11px] text-muted-foreground leading-tight mt-0.5" dir="ltr">
            {user.email}
          </p>
        </div>

        {/* Sign out button */}
        <button
          className="inline-flex min-h-10 items-center rounded-md border border-input bg-background px-3 text-xs font-medium text-foreground shadow-sm hover:bg-accent hover:text-accent-foreground transition-colors disabled:cursor-not-allowed disabled:opacity-60"
          disabled={isLoggingOut}
          onClick={onLogout}
          type="button"
        >
          {isLoggingOut ? t.dashboard.loggingOut : t.dashboard.logout}
        </button>
      </div>
    </header>
  );
}

export function DashboardShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { t } = useLocale();
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const [csrfToken, setCsrfToken] = useState("");
  const [error, setError] = useState("");
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [isNavigationOpen, setIsNavigationOpen] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY);
      if (stored === "true") {
        setIsCollapsed(true);
      }
    } catch {
      // Storage access may fail in restricted browser contexts
    }
  }, []);

  const handleToggleCollapse = () => {
    setIsCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(next));
      } catch {
        // Storage access may fail in restricted browser contexts
      }
      return next;
    });
  };

  useEffect(() => {
    async function restoreSession() {
      try {
        const result = await fetchSession();
        if (result.status === "unauthenticated") {
          router.replace("/login");
          return;
        }
        if (result.status === "error") {
          setError(t.dashboard.sessionLoadFailed);
          setState("error");
          return;
        }

        setUser(result.session.user);
        setCsrfToken(result.session.csrf_token);
        setState("ready");
      } catch {
        setError(t.dashboard.connectionUnavailable);
        setState("error");
      }
    }

    void restoreSession();
  }, [router, t.dashboard.connectionUnavailable, t.dashboard.sessionLoadFailed]);

  async function logout() {
    if (!csrfToken) {
      setError(t.dashboard.sessionReloadRequired);
      return;
    }

    setIsLoggingOut(true);
    setError("");
    try {
      const response = await fetch(`${apiBaseUrl}/auth/logout`, {
        method: "POST",
        credentials: "include",
        headers: { "X-CSRF-Token": csrfToken },
      });
      if (response.status === 401 || response.ok) {
        setUser(null);
        setCsrfToken("");
        router.replace("/login");
        router.refresh();
        return;
      }
      setError(t.dashboard.logoutFailed);
    } catch {
      setError(t.dashboard.connectionUnavailable);
    } finally {
      setIsLoggingOut(false);
    }
  }

  const contextValue = useMemo(
    () => (user && csrfToken ? { user, csrfToken } : null),
    [csrfToken, user],
  );

  if (state === "loading" || !contextValue) {
    return (
      <main className="grid min-h-screen place-items-center bg-background px-6 text-sm text-muted-foreground">
        <div className="flex items-center gap-2.5">
          <span className="size-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <span>{t.dashboard.loading}</span>
        </div>
      </main>
    );
  }

  if (state === "error") {
    return (
      <main className="grid min-h-screen place-items-center bg-background px-6 text-foreground">
        <section className="w-full max-w-md rounded-xl border border-destructive/40 bg-card p-6 shadow-lg">
          <h1 className="text-lg font-semibold">{t.dashboard.accessUnavailable}</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{error}</p>
          <button
            className="mt-6 inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-xs font-semibold text-primary-foreground shadow hover:bg-primary/90 transition-colors"
            onClick={() => router.replace("/login")}
            type="button"
          >
            {t.dashboard.returnToLogin}
          </button>
        </section>
      </main>
    );
  }

  return (
    <DashboardContext.Provider value={contextValue}>
      <div className="min-h-[100dvh] bg-muted/30 text-foreground transition-colors dark:bg-background">
        <DashboardSidebar
          isCollapsed={isCollapsed}
          isOpen={isNavigationOpen}
          onClose={() => setIsNavigationOpen(false)}
          onToggleCollapse={handleToggleCollapse}
          user={contextValue.user}
        />
        <div
          className={`min-h-[100dvh] transition-all duration-200 ${
            isCollapsed ? "lg:ps-[68px]" : "lg:ps-64"
          }`}
        >
          <DashboardTopbar
            isCollapsed={isCollapsed}
            isLoggingOut={isLoggingOut}
            onLogout={logout}
            onOpenNavigation={() => setIsNavigationOpen(true)}
            onToggleCollapse={handleToggleCollapse}
            user={contextValue.user}
          />
          <main className="p-3 sm:p-6 lg:p-8">
            <div className="mx-auto max-w-7xl">{children}</div>
            {error ? (
              <p className="mx-auto mt-4 max-w-7xl text-sm text-destructive">{error}</p>
            ) : null}
          </main>
        </div>
      </div>
    </DashboardContext.Provider>
  );
}
