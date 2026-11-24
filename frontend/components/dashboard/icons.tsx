import type { SVGProps } from "react";

export type IconName =
  | "activity"
  | "calendar"
  | "candidates"
  | "check"
  | "chevron"
  | "chevron-down"
  | "clipboard"
  | "evaluations"
  | "eye"
  | "eye-off"
  | "folder"
  | "interviews"
  | "laptop"
  | "menu"
  | "mic"
  | "mic-off"
  | "moon"
  | "overview"
  | "phone-off"
  | "recording"
  | "search"
  | "settings"
  | "sidebar"
  | "sparkles"
  | "sun"
  | "transcript"
  | "user-plus"
  | "video"
  | "video-off"
  | "x";

type IconProps = SVGProps<SVGSVGElement> & {
  name: IconName;
};

export function Icon({ name, ...props }: IconProps) {
  const commonProps = {
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: 1.8,
  };

  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" {...commonProps} {...props}>
      {name === "overview" ? (
        <>
          <rect height="6" rx="1" width="6" x="3" y="3" />
          <rect height="6" rx="1" width="6" x="15" y="3" />
          <rect height="6" rx="1" width="6" x="3" y="15" />
          <rect height="6" rx="1" width="6" x="15" y="15" />
        </>
      ) : null}
      {name === "candidates" ? (
        <>
          <circle cx="9" cy="8" r="3" />
          <path d="M3.5 20a5.5 5.5 0 0 1 11 0M17 11a2.5 2.5 0 1 0-1.8-4.2M16 14.5a4.6 4.6 0 0 1 4.5 4.5" />
        </>
      ) : null}
      {name === "interviews" ? (
        <>
          <path d="M7 5h10M7 9h10M7 13h6" />
          <path d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
        </>
      ) : null}
      {name === "evaluations" ? (
        <>
          <path d="M7 3h8l3 3v15H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h1Z" />
          <path d="M14 3v4h4M8 13l2.2 2.2L15.5 10" />
        </>
      ) : null}
      {name === "eye" ? (
        <>
          <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
          <circle cx="12" cy="12" r="3" />
        </>
      ) : null}
      {name === "eye-off" ? (
        <>
          <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
          <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
          <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
          <line x1="2" x2="22" y1="2" y2="22" />
        </>
      ) : null}
      {name === "settings" ? (
        <>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.12 2.12-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56v.08h-3v-.08A1.7 1.7 0 0 0 10.68 18.7 1.7 1.7 0 0 0 8.8 19l-.06.06-2.12-2.12.06-.06A1.7 1.7 0 0 0 7 15a1.7 1.7 0 0 0-1.56-1.03h-.08v-3h.08A1.7 1.7 0 0 0 7 9.94a1.7 1.7 0 0 0-.34-1.88L6.6 8 8.72 5.9l.06.06a1.7 1.7 0 0 0 1.88.34 1.7 1.7 0 0 0 1.03-1.56v-.08h3v.08a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06L19.78 8l-.06.06a1.7 1.7 0 0 0-.34 1.88 1.7 1.7 0 0 0 1.56 1.03h.08v3h-.08A1.7 1.7 0 0 0 19.4 15Z" />
        </>
      ) : null}
      {name === "activity" ? <path d="M3 12h4l2.5-7 5 14 2.5-7H21" /> : null}
      {name === "folder" ? (
        <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
      ) : null}
      {name === "mic" ? (
        <>
          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" x2="12" y1="19" y2="22" />
        </>
      ) : null}
      {name === "mic-off" ? (
        <>
          <line x1="2" x2="22" y1="2" y2="22" />
          <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" />
          <path d="M5 10v2a7 7 0 0 0 12 5" />
          <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
          <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
          <line x1="12" x2="12" y1="19" y2="22" />
        </>
      ) : null}
      {name === "phone-off" ? (
        <>
          <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
          <line x1="2" x2="22" y1="2" y2="22" />
        </>
      ) : null}
      {name === "video" ? (
        <>
          <path d="m22 8-6 4 6 4V8Z" />
          <rect height="12" rx="2" width="14" x="2" y="6" />
        </>
      ) : null}
      {name === "video-off" ? (
        <>
          <path d="M10.66 6H14a2 2 0 0 1 2 2v2.34l1 1L22 8v8" />
          <path d="M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2" />
          <line x1="2" x2="22" y1="2" y2="22" />
        </>
      ) : null}
      {name === "recording" ? (
        <>
          <path d="m22 8-6 4 6 4V8Z" />
          <rect height="12" rx="2" width="14" x="2" y="6" />
        </>
      ) : null}
      {name === "search" ? (
        <>
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </>
      ) : null}
      {name === "clipboard" ? (
        <>
          <rect height="17" rx="2" width="14" x="5" y="4" />
          <path d="M9 4V3h6v1M9 9h6M9 13h6M9 17h3" />
        </>
      ) : null}
      {name === "sparkles" ? (
        <>
          <path d="m12 3 1.3 4.7L18 9l-4.7 1.3L12 15l-1.3-4.7L6 9l4.7-1.3L12 3Z" />
          <path d="m19 15 .6 2.4L22 18l-2.4.6L19 21l-.6-2.4L16 18l2.4-.6L19 15Z" />
        </>
      ) : null}
      {name === "transcript" ? (
        <>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          <path d="M8 9h8M8 13h5" />
        </>
      ) : null}
      {name === "menu" ? <path d="M4 7h16M4 12h16M4 17h16" /> : null}
      {name === "x" ? <path d="m6 6 12 12M18 6 6 18" /> : null}
      {name === "chevron" ? <path d="m9 18 6-6-6-6" /> : null}
      {name === "chevron-down" ? <path d="m6 9 6 6 6-6" /> : null}
      {name === "check" ? <path d="m5 12 5 5L20 7" /> : null}
      {name === "sun" ? (
        <>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </>
      ) : null}
      {name === "moon" ? (
        <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
      ) : null}
      {name === "laptop" ? (
        <>
          <rect height="12" rx="2" width="18" x="3" y="4" />
          <path d="M2 20h20" />
        </>
      ) : null}
      {name === "calendar" ? (
        <>
          <rect height="18" rx="2" width="18" x="3" y="4" />
          <line x1="16" x2="16" y1="2" y2="6" />
          <line x1="8" x2="8" y1="2" y2="6" />
          <line x1="3" x2="21" y1="10" y2="10" />
        </>
      ) : null}
      {name === "user-plus" ? (
        <>
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <line x1="19" x2="19" y1="8" y2="14" />
          <line x1="22" x2="16" y1="11" y2="11" />
        </>
      ) : null}
      {name === "sidebar" ? (
        <>
          <rect height="18" rx="2" width="18" x="3" y="3" />
          <path d="M9 3v18" />
        </>
      ) : null}
    </svg>
  );
}
