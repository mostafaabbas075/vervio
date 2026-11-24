export type UserRole = "admin" | "client_reviewer";

export type AuthenticatedUser = {
  id: string;
  email: string;
  full_name: string;
  role: UserRole;
  company_id: string | null;
};

export type SessionResponse = {
  user: AuthenticatedUser;
  csrf_token: string;
};

export type SessionFetchResult =
  | { status: "authenticated"; session: SessionResponse }
  | { status: "unauthenticated" }
  | { status: "error" };

export const apiBaseUrl =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

let activeSessionRequest: Promise<SessionFetchResult> | null = null;

export function fetchSession(): Promise<SessionFetchResult> {
  if (activeSessionRequest) {
    return activeSessionRequest;
  }

  activeSessionRequest = fetch(`${apiBaseUrl}/auth/me`, {
    credentials: "include",
    cache: "no-store",
  })
    .then(async (response): Promise<SessionFetchResult> => {
      if (response.status === 401) {
        return { status: "unauthenticated" };
      }
      if (!response.ok) {
        return { status: "error" };
      }
      return { status: "authenticated", session: (await response.json()) as SessionResponse };
    })
    .finally(() => {
      activeSessionRequest = null;
    });

  return activeSessionRequest;
}

