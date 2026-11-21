/**
 * 全画面に共通する枠（デザインの Main.dc.html）。左にメニュー、上にヘッダーを出す。
 * ブラウザの globals（window など）には触らない（react-dom/server でも描ける）
 */
import type { CSSProperties, MouseEvent, ReactElement, ReactNode } from "react";
import type { AbortTarget, ControlKind, ControlState } from "./control.js";
import {
  fill,
  type Lang,
  type Messages,
  MESSAGES,
  type Status,
  statusLabel,
} from "./i18n.js";
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
  /** 出しているダイアログと知らせ */
  control?: ControlState;
  /** ヘッダーの「再起動」「停止」 */
  onAsk?: (kind: ControlKind) => void;
  /** ダイアログの「キャンセル」 */
  onCancel?: () => void;
  /** ダイアログの「再起動する」「停止する」 */
  onConfirm?: () => void;
  /** 各画面の中身 */
  children?: ReactNode;
}

const MONO = "'JetBrains Mono', ui-monospace, monospace";

const STATUS_TONE: Readonly<Record<Status, string>> = {
  running: "green",
  idle: "blue",
  stopping: "amber",
  stopped: "red",
};

const CONTROL_BUTTON: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  height: 32,
  padding: "0 12px",
  borderRadius: 7,
  border: "1px solid var(--border2)",
  background: "var(--panel)",
  color: "var(--fg)",
  font: "inherit",
  fontSize: 13,
  fontWeight: 500,
  cursor: "pointer",
};

const DIVIDER: CSSProperties = {
  width: 1,
  height: 20,
  background: "var(--border)",
  margin: "0 4px",
};

const TOAST: CSSProperties = {
  position: "absolute",
  top: 68,
  right: 32,
  zIndex: 20,
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "10px 14px",
  borderRadius: 9,
  background: "var(--fg)",
  color: "var(--bg)",
  fontSize: 13,
  fontWeight: 500,
  boxShadow: "var(--shadowLg)",
};

const OVERLAY: CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 30,
  background: "var(--overlay)",
};

const DIALOG: CSSProperties = {
  position: "absolute",
  top: 120,
  left: "50%",
  transform: "translateX(-50%)",
  width: 440,
  maxWidth: "calc(100% - 32px)",
  boxSizing: "border-box",
  background: "var(--panel)",
  color: "var(--fg)",
  border: "1px solid var(--border)",
  borderRadius: 14,
  boxShadow: "var(--shadowLg)",
  display: "flex",
  flexDirection: "column",
};

const DIALOG_HEAD: CSSProperties = {
  padding: "20px 22px 0",
  display: "flex",
  gap: 14,
  alignItems: "flex-start",
};

const DANGER_MARK: CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: 10,
  flex: "none",
  display: "grid",
  placeItems: "center",
  background: "var(--red-bg)",
  color: "var(--red-fg)",
  border: "1px solid var(--red-bd)",
};

const DIALOG_TEXT: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const DIALOG_TITLE: CSSProperties = {
  margin: 0,
  fontSize: 16,
  fontWeight: 600,
};

const DIALOG_BODY: CSSProperties = {
  margin: 0,
  color: "var(--muted)",
  fontSize: 13,
};

const DIALOG_ACTIONS: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  justifyContent: "flex-end",
  gap: 8,
  padding: "20px 22px",
};

const DIALOG_CANCEL: CSSProperties = {
  height: 34,
  padding: "0 14px",
  borderRadius: 7,
  border: "1px solid var(--border2)",
  background: "var(--panel)",
  color: "var(--fg)",
  font: "inherit",
  fontSize: 13,
  fontWeight: 500,
  cursor: "pointer",
};

function confirmStyle(danger: boolean): CSSProperties {
  return {
    ...DIALOG_CANCEL,
    border: 0,
    background: danger ? "var(--danger)" : "var(--accent)",
    color: "#FFFFFF",
  };
}

function stopButtonStyle(disabled: boolean): CSSProperties {
  return {
    ...CONTROL_BUTTON,
    color: "var(--red-fg)",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.45 : 1,
  };
}

/** ダイアログの文言 */
function dialogText(
  t: Messages,
  kind: ControlKind,
  target?: AbortTarget,
): { title: string; body: string; ok: string } {
  if (kind === "abort") {
    const role = target?.role === undefined ? t.someRole : t.roles[target.role];
    return {
      title: fill(t.abortTitle, { n: target?.issue ?? "" }),
      body: fill(t.abortBody, { role }),
      ok: t.abortOk,
    };
  }
  return kind === "restart"
    ? { title: t.restartTitle, body: t.restartBody, ok: t.restartOk }
    : { title: t.stopTitle, body: t.stopBody, ok: t.stopOk };
}

/** 知らせの文言 */
function toastText(
  t: Messages,
  kind: ControlKind,
  target: AbortTarget | undefined,
): string {
  if (kind === "abort") return fill(t.toastAbort, { n: target?.issue ?? "" });
  return kind === "restart" ? t.toastRestart : t.toastStop;
}

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

function RestartIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 12a8 8 0 1 1-2.34-5.66" />
      <path d="M20 4v5h-5" />
    </svg>
  );
}

function StopIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
    >
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

function CheckIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

function WarningIcon(): ReactElement {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

/** 再起動・停止・中断の確認のダイアログ */
function ControlDialog(props: {
  t: Messages;
  kind: ControlKind;
  target: AbortTarget | undefined;
  onCancel: (() => void) | undefined;
  onConfirm: (() => void) | undefined;
}): ReactElement {
  const { t, kind } = props;
  const text = dialogText(t, kind, props.target);
  const danger = kind === "stop" || kind === "abort";
  return (
    <div style={OVERLAY}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="control-dialog-title"
        style={DIALOG}
      >
        <div style={DIALOG_HEAD}>
          {danger && (
            <span aria-hidden="true" style={DANGER_MARK}>
              <WarningIcon />
            </span>
          )}
          <div style={DIALOG_TEXT}>
            <h2 id="control-dialog-title" style={DIALOG_TITLE}>
              {text.title}
            </h2>
            <p style={DIALOG_BODY}>{text.body}</p>
          </div>
        </div>
        <div style={DIALOG_ACTIONS}>
          <button
            type="button"
            onClick={() => props.onCancel?.()}
            style={DIALOG_CANCEL}
          >
            {t.cancel}
          </button>
          <button
            type="button"
            onClick={() => props.onConfirm?.()}
            style={confirmStyle(danger)}
          >
            {text.ok}
          </button>
        </div>
      </div>
    </div>
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
  const control = props.control ?? {};
  // 止めている・止まるのを待っている間は「停止」を押せない（「再起動」は押せる）
  const stopDisabled = status === "stopped" || status === "stopping";
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
            <button
              type="button"
              onClick={() => props.onAsk?.("restart")}
              style={CONTROL_BUTTON}
            >
              <RestartIcon />
              {t.restart}
            </button>
            <button
              type="button"
              disabled={stopDisabled}
              onClick={() => props.onAsk?.("stop")}
              style={stopButtonStyle(stopDisabled)}
            >
              <StopIcon />
              {t.stop}
            </button>
            <span aria-hidden="true" style={DIVIDER} />
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

      {control.toast !== undefined && (
        <div role="status" style={TOAST}>
          <CheckIcon />
          {toastText(t, control.toast, control.abort)}
        </div>
      )}

      {control.dialog !== undefined &&
        (control.dialog !== "abort" || control.abort !== undefined) && (
          <ControlDialog
            t={t}
            kind={control.dialog}
            target={control.abort}
            onCancel={props.onCancel}
            onConfirm={props.onConfirm}
          />
        )}
    </div>
  );
}
