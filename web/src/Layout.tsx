/**
 * 全画面に共通する枠（デザインの Main.dc.html）。左にメニュー、上にヘッダーを出す。
 * ブラウザの globals（window など）には触らない（react-dom/server でも描ける）
 */
import type { CSSProperties, MouseEvent, ReactElement, ReactNode } from "react";
import { type Lang, MESSAGES, type Status, statusLabel } from "./i18n.js";
import { themeStyle } from "./palette.js";
import { type Menu, MENU_PATHS, menuOf } from "./routes.js";
import type { Scheme } from "./theme.js";

export interface LayoutProps {
  /** "/"・"/tasks"・"/tasks/12"・"/settings" */
  path: string;
  lang: Lang;
  scheme: Scheme;
  repo: string;
  project: number;
  status: Status;
  onLanguage?: (lang: Lang) => void;
  onNavigate?: (path: string) => void;
  /** 各画面の中身 */
  children?: ReactNode;
}

const MONO = "'JetBrains Mono', ui-monospace, monospace";

const STATUS_TONE: Readonly<Record<Status, string>> = {
  running: "green",
  idle: "blue",
  stopped: "red",
};

const ROOT: CSSProperties = {
  position: "relative",
  minHeight: "100vh",
  display: "flex",
  flexWrap: "wrap",
  alignItems: "stretch",
  fontFamily: "Inter, 'Noto Sans JP', system-ui, sans-serif",
  fontSize: 14,
  lineHeight: 1.55,
  WebkitFontSmoothing: "antialiased",
};

const NAV: CSSProperties = {
  flex: "1 1 232px",
  maxWidth: "100%",
  boxSizing: "border-box",
  background: "var(--side)",
  borderRight: "1px solid var(--border)",
  padding: "16px 12px",
  display: "flex",
  flexDirection: "column",
  gap: 20,
};

const BRAND: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "4px 8px",
};

const BRAND_MARK: CSSProperties = {
  width: 26,
  height: 26,
  borderRadius: 7,
  background: "var(--fg)",
  color: "var(--bg)",
  display: "grid",
  placeItems: "center",
  flex: "none",
};

const BRAND_NAME: CSSProperties = {
  fontWeight: 600,
  fontSize: 15,
  letterSpacing: "-0.01em",
};

const MENU_LIST: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const MENU_LABEL: CSSProperties = {
  flex: 1,
  minWidth: 0,
};

const RUNS_ON: CSSProperties = {
  marginTop: "auto",
  padding: 10,
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--panel)",
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 12,
  color: "var(--muted)",
};

const COMMAND: CSSProperties = {
  fontFamily: MONO,
  color: "var(--fg)",
};

const COLUMN: CSSProperties = {
  flex: "999 1 560px",
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  background: "var(--bg)",
};

const HEADER: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "12px 16px",
  minHeight: 56,
  padding: "10px 32px",
  boxSizing: "border-box",
  borderBottom: "1px solid var(--border)",
  background: "var(--panel)",
};

const HEADER_LEFT: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "10px 12px",
  minWidth: 0,
};

const HEADER_RIGHT: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 8,
  marginLeft: "auto",
};

const REPO: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  minWidth: 0,
};

const REPO_ICON: CSSProperties = {
  color: "var(--muted)",
  flex: "none",
};

const REPO_NAME: CSSProperties = {
  fontFamily: MONO,
  fontSize: 13,
  fontWeight: 500,
};

const PROJECT: CSSProperties = {
  fontSize: 13,
  color: "var(--muted)",
};

const LANGUAGES: CSSProperties = {
  display: "inline-flex",
  padding: 2,
  borderRadius: 8,
  background: "var(--subtle)",
  border: "1px solid var(--border)",
};

const MAIN: CSSProperties = {
  flex: 1,
  padding: "28px 32px 48px",
  boxSizing: "border-box",
  width: "100%",
  maxWidth: 1240,
};

function menuItemStyle(current: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 10,
    width: "100%",
    minHeight: 36,
    padding: "0 10px",
    boxSizing: "border-box",
    borderRadius: 7,
    background: current ? "var(--panel)" : "transparent",
    color: current ? "var(--fg)" : "var(--muted)",
    fontWeight: current ? 600 : 500,
    textDecoration: "none",
  };
}

function statusStyle(tone: string): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    height: 22,
    padding: "0 9px",
    borderRadius: 11,
    fontSize: 12,
    fontWeight: 500,
    background: `var(--${tone}-bg)`,
    color: `var(--${tone}-fg)`,
    border: `1px solid var(--${tone}-bd)`,
  };
}

function statusDotStyle(tone: string): CSSProperties {
  return {
    width: 7,
    height: 7,
    borderRadius: "50%",
    background: "currentColor",
    boxShadow: `0 0 0 3px var(--${tone}-bd)`,
  };
}

function languageStyle(on: boolean): CSSProperties {
  return {
    height: 26,
    padding: "0 10px",
    border: 0,
    borderRadius: 6,
    font: "inherit",
    fontSize: 12,
    fontWeight: 500,
    cursor: "pointer",
    background: on ? "var(--panel)" : "transparent",
    color: on ? "var(--fg)" : "var(--muted)",
    boxShadow: on ? "0 1px 2px rgba(0,0,0,0.12)" : "none",
  };
}

/** 修飾キーなしの左クリックか（それ以外はブラウザに任せ、新しいタブなどで開く） */
function isPlainClick(event: MouseEvent): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

function MenuIcon({ menu }: { menu: Menu }): ReactElement {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {menu === "dashboard" && (
        <>
          <rect x="3" y="3" width="7" height="9" rx="1.5" />
          <rect x="14" y="3" width="7" height="5" rx="1.5" />
          <rect x="14" y="12" width="7" height="9" rx="1.5" />
          <rect x="3" y="16" width="7" height="5" rx="1.5" />
        </>
      )}
      {menu === "tasks" && (
        <>
          <path d="M9 6h11" />
          <path d="M9 12h11" />
          <path d="M9 18h11" />
          <path d="M4 6h.01" />
          <path d="M4 12h.01" />
          <path d="M4 18h.01" />
        </>
      )}
      {menu === "settings" && (
        <>
          <path d="M4 7h10" />
          <path d="M18 7h2" />
          <circle cx="16" cy="7" r="2" />
          <path d="M4 17h4" />
          <path d="M12 17h8" />
          <circle cx="10" cy="17" r="2" />
        </>
      )}
    </svg>
  );
}

function BrandIcon(): ReactElement {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 18c4-1 6-5 8-9s4-6 8-6" />
      <circle cx="20" cy="3" r="0.5" />
      <path d="M4 21h16" />
    </svg>
  );
}

function RepoIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={REPO_ICON}
    >
      <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z" />
      <path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19" />
    </svg>
  );
}

export function Layout(props: LayoutProps): ReactElement {
  const { path, lang, scheme, repo, project, status } = props;
  const t = MESSAGES[lang];
  const current = menuOf(path);
  const tone = STATUS_TONE[status];
  const menus: [Menu, string][] = [
    ["dashboard", t.navDashboard],
    ["tasks", t.navTasks],
    ["settings", t.navSettings],
  ];
  const languages: [Lang, string][] = [
    ["ja", "日本語"],
    ["en", "English"],
  ];
  const navigate = (event: MouseEvent, href: string) => {
    if (props.onNavigate === undefined || !isPlainClick(event)) return;
    event.preventDefault();
    props.onNavigate(href);
  };

  return (
    <div lang={lang} style={{ ...themeStyle(scheme), ...ROOT }}>
      <nav aria-label={t.menu} style={NAV}>
        <div style={BRAND}>
          <span aria-hidden="true" style={BRAND_MARK}>
            <BrandIcon />
          </span>
          <span style={BRAND_NAME}>conductor</span>
        </div>
        <div style={MENU_LIST}>
          {menus.map(([menu, label]) => {
            const href = MENU_PATHS[menu];
            const isCurrent = menu === current;
            return (
              <a
                key={menu}
                href={href}
                aria-current={isCurrent ? "page" : undefined}
                onClick={(event) => navigate(event, href)}
                style={menuItemStyle(isCurrent)}
              >
                <MenuIcon menu={menu} />
                <span style={MENU_LABEL}>{label}</span>
              </a>
            );
          })}
        </div>
        <div style={RUNS_ON}>
          <span style={COMMAND}>conductor start</span>
          <span>{t.runsOn}</span>
        </div>
      </nav>

      <div style={COLUMN}>
        <header style={HEADER}>
          <div style={HEADER_LEFT}>
            <span style={REPO}>
              <RepoIcon />
              <span style={REPO_NAME}>{repo}</span>
            </span>
            <span style={PROJECT}>{`${t.project} #${project}`}</span>
            <span style={statusStyle(tone)}>
              <span aria-hidden="true" style={statusDotStyle(tone)} />
              {statusLabel(t, status)}
            </span>
          </div>
          <div style={HEADER_RIGHT}>
            <div role="group" aria-label={t.language} style={LANGUAGES}>
              {languages.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={value === lang}
                  onClick={() => props.onLanguage?.(value)}
                  style={languageStyle(value === lang)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </header>

        <main style={MAIN}>{props.children}</main>
      </div>
    </div>
  );
}
