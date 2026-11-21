/**
 * ダッシュボード（デザインの Main.dc.html の「ダッシュボード」）。
 * 人の判断を待っている Issue、処理中の Issue、稼働状況、列ごとの件数を出す。
 * 経過時間と次の確認までの秒数は now から計算する（画面は1秒ごとに新しい now で描き直す）。
 * ブラウザの globals（window など）には触らない（react-dom/server でも描ける）
 */
import type { CSSProperties, MouseEvent, ReactElement } from "react";
import type {
  DashboardActive,
  DashboardBlocked,
  DashboardData,
} from "../../src/dashboard-data.js";
import {
  formatAgo,
  formatDuration,
  formatInterval,
  formatSeconds,
  formatStamp,
  secondsSince,
  secondsUntil,
  stageKeyOf,
} from "./dashboard-format.js";
import {
  type Lang,
  type Messages,
  MESSAGES,
  STAGE_KEYS,
  statusLabel,
} from "./i18n.js";

export type { DashboardData } from "../../src/dashboard-data.js";

export interface DashboardProps {
  data: DashboardData;
  lang: Lang;
  /** 今の時刻。経過時間と次の確認までの秒数はこれから計算する */
  now: Date;
  onNavigate?: (path: string) => void;
}

const MONO = "'JetBrains Mono', ui-monospace, monospace";
const NONE = "—";

const STATUS_TONE: Readonly<Record<DashboardData["status"], string>> = {
  running: "green",
  idle: "blue",
  stopped: "red",
};

/** 列ごとの色（デザインの COL_TONE） */
function columnTone(index: number): string {
  return ["blue", "amber", "violet", "teal", "green", "red"][index] ?? "gray";
}

const PAGE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 24,
};

const TITLE_ROW: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: "8px 16px",
};

const H1: CSSProperties = {
  margin: 0,
  fontSize: 22,
  fontWeight: 600,
  letterSpacing: "-0.01em",
};

const BLOCKED: CSSProperties = {
  border: "1px solid var(--red-bd)",
  background: "var(--red-bg)",
  borderRadius: 12,
  padding: 16,
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const BLOCKED_HEAD: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "8px 10px",
  padding: "0 4px",
};

const BLOCKED_COUNT: CSSProperties = {
  height: 20,
  minWidth: 20,
  padding: "0 6px",
  boxSizing: "border-box",
  borderRadius: 10,
  background: "var(--red-fg)",
  color: "var(--panel)",
  fontSize: 12,
  fontWeight: 600,
  display: "grid",
  placeItems: "center",
};

const BLOCKED_ITEM: CSSProperties = {
  background: "var(--panel)",
  border: "1px solid var(--border)",
  borderRadius: 9,
  padding: "16px 18px",
  display: "flex",
  flexWrap: "wrap",
  gap: "12px 24px",
  alignItems: "flex-start",
};

const ROW: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 20,
  alignItems: "stretch",
};

const CARD: CSSProperties = {
  minWidth: 0,
  background: "var(--panel)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  boxShadow: "var(--shadow)",
  display: "flex",
  flexDirection: "column",
};

const CARD_HEAD: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "14px 20px",
  borderBottom: "1px solid var(--border)",
};

const H2: CSSProperties = {
  margin: 0,
  fontSize: 13,
  fontWeight: 600,
  color: "var(--muted)",
};

const MUTED_SMALL: CSSProperties = { fontSize: 12, color: "var(--muted)" };

const STAMP: CSSProperties = {
  color: "var(--fg)",
  fontVariantNumeric: "tabular-nums",
};

const STRONG_NUM: CSSProperties = {
  color: "var(--fg)",
  fontVariantNumeric: "tabular-nums",
  fontWeight: 500,
};

const ISSUE_NUMBER: CSSProperties = {
  fontFamily: MONO,
  fontSize: 14,
  color: "var(--muted)",
};

const ROLE_CHIP: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  height: 24,
  padding: "0 9px",
  borderRadius: 6,
  background: "var(--accentSoft)",
  color: "var(--accentText)",
  fontWeight: 500,
};

const STAGE_CHIP: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  height: 22,
  padding: "0 8px",
  borderRadius: 6,
  background: "var(--subtle)",
  border: "1px solid var(--border)",
  fontSize: 12,
  fontWeight: 500,
};

const PAUSED: CSSProperties = {
  margin: 0,
  padding: "10px 12px",
  borderRadius: 8,
  background: "var(--subtle)",
  color: "var(--muted)",
  fontSize: 13,
};

const PRIMARY_LINK: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  height: 32,
  padding: "0 12px",
  borderRadius: 7,
  background: "var(--fg)",
  color: "var(--bg)",
  fontSize: 13,
  fontWeight: 500,
  textDecoration: "none",
};

const SECONDARY_LINK: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  height: 32,
  padding: "0 12px",
  boxSizing: "border-box",
  borderRadius: 7,
  border: "1px solid var(--border2)",
  background: "var(--panel)",
  color: "var(--fg)",
  fontSize: 13,
  fontWeight: 500,
  textDecoration: "none",
};

const DL: CSSProperties = {
  margin: 0,
  display: "grid",
  gridTemplateColumns: "auto minmax(0, 1fr)",
  gap: "10px 16px",
  fontSize: 13,
};

const DT: CSSProperties = { color: "var(--muted)" };

const DD: CSSProperties = {
  margin: 0,
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
};

const COUNTS_GRID: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(150px, 100%), 1fr))",
  gap: 12,
};

const COUNT_CARD: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  padding: "14px 16px",
  borderRadius: 10,
  border: "1px solid var(--border)",
  background: "var(--panel)",
  boxShadow: "var(--shadow)",
};

function issueUrl(repo: string, issue: number): string {
  return `https://github.com/${repo}/issues/${issue}`;
}

function detailPath(issue: number): string {
  return `/tasks/${issue}`;
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

interface LinkProps {
  repo: string;
  issue: number;
  t: Messages;
  onNavigate: ((path: string) => void) | undefined;
}

/** 「GitHub で開く」と「詳細を見る」 */
function IssueLinks({ repo, issue, t, onNavigate }: LinkProps): ReactElement {
  const path = detailPath(issue);
  const navigate = (event: MouseEvent) => {
    if (onNavigate === undefined || !isPlainClick(event)) return;
    event.preventDefault();
    onNavigate(path);
  };
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      <a
        href={issueUrl(repo, issue)}
        target="_blank"
        rel="noopener"
        style={PRIMARY_LINK}
      >
        {t.openGitHub}
        <svg
          aria-hidden="true"
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M14 4h6v6" />
          <path d="M20 4l-9 9" />
          <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
        </svg>
      </a>
      <a href={path} onClick={navigate} style={SECONDARY_LINK}>
        {t.viewDetail}
      </a>
    </div>
  );
}

function blockedStamp(iso: string | undefined): string {
  if (iso === undefined) return NONE;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? NONE : formatStamp(new Date(t));
}

function BlockedItem(props: {
  item: DashboardBlocked;
  repo: string;
  t: Messages;
  onNavigate: ((path: string) => void) | undefined;
}): ReactElement {
  const { item, repo, t } = props;
  return (
    <article style={BLOCKED_ITEM}>
      <div
        style={{
          flex: "1 1 420px",
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "baseline",
            gap: "4px 10px",
          }}
        >
          <span style={{ ...ISSUE_NUMBER, fontSize: 13 }}>#{item.number}</span>
          <span style={{ fontSize: 15, fontWeight: 600 }}>{item.title}</span>
          {item.stage !== undefined && (
            <span style={STAGE_CHIP}>{t.stage[stageKeyOf(item.stage)]}</span>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span
            style={{ fontSize: 12, fontWeight: 500, color: "var(--muted)" }}
          >
            {t.blockedReason}
          </span>
          <p style={{ margin: 0, whiteSpace: "pre-line" }}>
            {item.reason ?? NONE}
          </p>
        </div>
      </div>
      <div
        style={{
          flex: "0 1 auto",
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          gap: 10,
        }}
      >
        <span style={MUTED_SMALL}>
          {t.stoppedAt}{" "}
          <span style={STAMP}>{blockedStamp(item.blockedAt)}</span>
        </span>
        <IssueLinks
          repo={repo}
          issue={item.number}
          t={t}
          onNavigate={props.onNavigate}
        />
      </div>
    </article>
  );
}

function BlockedSection(props: {
  data: DashboardData;
  t: Messages;
  onNavigate: ((path: string) => void) | undefined;
}): ReactElement {
  const { data, t } = props;
  return (
    <section aria-labelledby="blocked-h" style={BLOCKED}>
      <div style={BLOCKED_HEAD}>
        <h2
          id="blocked-h"
          style={{
            margin: 0,
            fontSize: 15,
            fontWeight: 600,
            color: "var(--red-fg)",
          }}
        >
          {t.blockedTitle}
        </h2>
        <span style={BLOCKED_COUNT}>{data.blocked.length}</span>
        <span
          style={{ fontSize: 13, color: "var(--muted)", marginLeft: "auto" }}
        >
          {t.blockedNote}
        </span>
      </div>
      {data.blocked.map((item) => (
        <BlockedItem
          key={item.number}
          item={item}
          repo={data.repo}
          t={t}
          onNavigate={props.onNavigate}
        />
      ))}
    </section>
  );
}

function stepDotStyle(done: boolean, current: boolean): CSSProperties {
  const on = done || current;
  return {
    width: 22,
    height: 22,
    boxSizing: "border-box",
    borderRadius: "50%",
    flex: "none",
    display: "grid",
    placeItems: "center",
    background: on ? "var(--accent)" : "var(--panel)",
    border: `1.5px solid ${on ? "var(--accent)" : "var(--border2)"}`,
    color: "#FFFFFF",
    boxShadow: current ? "0 0 0 4px var(--accentSoft)" : "none",
  };
}

function Progress(props: {
  active: DashboardActive;
  t: Messages;
  elapsed: string;
}): ReactElement {
  const { active, t, elapsed } = props;
  const currentIndex = STAGE_KEYS.indexOf(stageKeyOf(active.stage));
  return (
    <ol
      aria-label={t.progress}
      style={{
        listStyle: "none",
        margin: 0,
        padding: 0,
        display: "grid",
        gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
        gap: 0,
      }}
    >
      {STAGE_KEYS.map((key, i) => {
        const done = i < currentIndex;
        const current = i === currentIndex;
        return (
          <li
            key={key}
            aria-current={current ? "step" : undefined}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              minWidth: 0,
            }}
          >
            <span
              style={{
                fontSize: 13,
                fontWeight: current ? 600 : 500,
                color: done || current ? "var(--fg)" : "var(--muted)",
                paddingRight: 8,
              }}
            >
              {t.stage[key]}
            </span>
            <span
              aria-hidden="true"
              style={{ display: "flex", alignItems: "center" }}
            >
              <span style={stepDotStyle(done, current)} />
              <span
                style={{
                  flex: 1,
                  height: 2,
                  margin: "0 8px",
                  borderRadius: 1,
                  background: done ? "var(--accent)" : "var(--border2)",
                  opacity: i === STAGE_KEYS.length - 1 ? 0 : 1,
                }}
              />
            </span>
            {current && (
              <span
                style={{
                  ...MUTED_SMALL,
                  paddingRight: 8,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {elapsed}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function ActiveSection(props: {
  data: DashboardData;
  lang: Lang;
  t: Messages;
  now: Date;
  onNavigate: ((path: string) => void) | undefined;
}): ReactElement {
  const { data, lang, t, now } = props;
  const { active } = data;
  const since =
    active === undefined ? undefined : secondsSince(active.stageStartedAt, now);
  const elapsed = since === undefined ? NONE : formatDuration(since, lang);
  return (
    <section aria-labelledby="active-h" style={{ ...CARD, flex: "2 1 520px" }}>
      <div style={CARD_HEAD}>
        <h2 id="active-h" style={H2}>
          {t.activeTitle}
        </h2>
        {active !== undefined && (
          <span style={MUTED_SMALL}>
            {t.elapsed} <span style={STRONG_NUM}>{elapsed}</span>
          </span>
        )}
      </div>
      {active === undefined ? (
        <div
          style={{
            flex: 1,
            minHeight: 240,
            padding: "32px 24px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            textAlign: "center",
          }}
        >
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
            {t.emptyTitle}
          </h3>
          <p
            style={{
              margin: 0,
              maxWidth: 380,
              color: "var(--muted)",
              fontSize: 13,
            }}
          >
            {t.emptyBody}
          </p>
        </div>
      ) : (
        <div
          style={{
            padding: 20,
            display: "flex",
            flexDirection: "column",
            gap: 22,
            flex: 1,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "baseline",
                gap: "4px 10px",
              }}
            >
              <span style={ISSUE_NUMBER}>#{active.number}</span>
              <span
                style={{
                  fontSize: 18,
                  fontWeight: 600,
                  letterSpacing: "-0.01em",
                }}
              >
                {active.title}
              </span>
            </div>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: "8px 14px",
                fontSize: 13,
                color: "var(--muted)",
              }}
            >
              {active.role !== undefined && (
                <span style={ROLE_CHIP}>
                  <span
                    aria-hidden="true"
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: "currentColor",
                    }}
                  />
                  {t.roles[active.role]}
                </span>
              )}
              <span>
                {t.rejections}{" "}
                <span style={STRONG_NUM}>
                  {`${active.rejections}/${data.limits.rejections}`}
                </span>
              </span>
              <span>
                {t.objections}{" "}
                <span style={STRONG_NUM}>
                  {`${active.objections}/${data.limits.objections}`}
                </span>
              </span>
              {active.pr !== undefined && (
                <a
                  href={`https://github.com/${data.repo}/pull/${active.pr}`}
                  target="_blank"
                  rel="noopener"
                  style={{
                    color: "var(--accentText)",
                    textDecoration: "none",
                    fontWeight: 500,
                  }}
                >
                  {`PR #${active.pr}`}
                </a>
              )}
            </div>
          </div>
          <Progress active={active} t={t} elapsed={elapsed} />
          {data.status === "stopped" && <p style={PAUSED}>{t.pausedNote}</p>}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
              marginTop: "auto",
              paddingTop: 16,
              borderTop: "1px solid var(--border)",
            }}
          >
            <span style={MUTED_SMALL}>
              {t.branch}{" "}
              <span style={{ fontFamily: MONO, color: "var(--fg)" }}>
                {active.branch ?? NONE}
              </span>
            </span>
            <IssueLinks
              repo={data.repo}
              issue={active.number}
              t={t}
              onNavigate={props.onNavigate}
            />
          </div>
        </div>
      )}
    </section>
  );
}

const STATUS_HEAD: CSSProperties = {
  padding: "14px 20px",
  borderBottom: "1px solid var(--border)",
};

/** 前の確認から次の確認までの、どこまで進んだか（0〜100） */
function pollPercent(until: number | undefined, interval: number): number {
  if (until === undefined || interval <= 0) return 0;
  const percent = Math.round(((interval - until) / interval) * 100);
  return Math.min(100, Math.max(0, percent));
}

function StatusSection(props: {
  data: DashboardData;
  lang: Lang;
  t: Messages;
  now: Date;
}): ReactElement {
  const { data, lang, t, now } = props;
  const tone = STATUS_TONE[data.status];
  const ago = secondsSince(data.lastCheckedAt, now);
  const until =
    data.status === "stopped" ? undefined : secondsUntil(data.nextCheckAt, now);
  const percent = pollPercent(until, data.pollInterval);
  return (
    <section aria-labelledby="status-h" style={{ ...CARD, flex: "1 1 280px" }}>
      <div style={STATUS_HEAD}>
        <h2 id="status-h" style={H2}>
          {t.statusTitle}
        </h2>
      </div>
      <div
        style={{
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 18,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span
            aria-hidden="true"
            style={{
              width: 12,
              height: 12,
              borderRadius: "50%",
              background: `var(--${tone}-fg)`,
              boxShadow: `0 0 0 5px var(--${tone}-bg)`,
            }}
          />
          <span
            style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-0.01em" }}
          >
            {statusLabel(t, data.status)}
          </span>
        </div>
        <dl style={DL}>
          <dt style={DT}>{t.lastChecked}</dt>
          <dd style={DD}>{ago === undefined ? NONE : formatAgo(ago, lang)}</dd>
          <dt style={DT}>{t.nextCheck}</dt>
          <dd style={DD}>
            {until === undefined ? NONE : formatSeconds(until, lang)}
          </dd>
        </dl>
        <div
          aria-hidden="true"
          style={{
            height: 4,
            borderRadius: 2,
            background: "var(--subtle)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${percent}%`,
              background: "var(--accent)",
              borderRadius: 2,
              transition: "width 1s linear",
            }}
          />
        </div>
        <dl
          style={{
            ...DL,
            paddingTop: 14,
            borderTop: "1px solid var(--border)",
          }}
        >
          <dt style={DT}>{t.interval}</dt>
          <dd style={DD}>{formatInterval(data.pollInterval, lang)}</dd>
          <dt style={DT}>{t.mergeMode}</dt>
          <dd style={{ ...DD, fontFamily: MONO, fontSize: 12 }}>
            {data.merge}
          </dd>
        </dl>
      </div>
    </section>
  );
}

function CountsSection(props: {
  data: DashboardData;
  t: Messages;
}): ReactElement {
  const { data, t } = props;
  return (
    <section
      aria-labelledby="counts-h"
      style={{ display: "flex", flexDirection: "column", gap: 10 }}
    >
      <h2 id="counts-h" style={H2}>
        {t.countsTitle}
      </h2>
      <div style={COUNTS_GRID}>
        {data.counts.map((c, i) => (
          <div key={c.column} style={COUNT_CARD}>
            <span
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                fontSize: 12,
                fontWeight: 500,
                color: "var(--muted)",
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  background: `var(--${columnTone(i)}-fg)`,
                }}
              />
              {c.column}
            </span>
            <span
              style={{
                fontSize: 26,
                fontWeight: 600,
                letterSpacing: "-0.02em",
                fontVariantNumeric: "tabular-nums",
                color: c.count === 0 ? "var(--muted)" : "var(--fg)",
              }}
            >
              {c.count}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function Dashboard(props: DashboardProps): ReactElement {
  const { data, lang, now, onNavigate } = props;
  const t = MESSAGES[lang];
  return (
    <div style={PAGE}>
      <div style={TITLE_ROW}>
        <h1 style={H1}>{t.navDashboard}</h1>
      </div>
      {data.blocked.length > 0 && (
        <BlockedSection data={data} t={t} onNavigate={onNavigate} />
      )}
      <div style={ROW}>
        <ActiveSection
          data={data}
          lang={lang}
          t={t}
          now={now}
          onNavigate={onNavigate}
        />
        <StatusSection data={data} lang={lang} t={t} now={now} />
      </div>
      <CountsSection data={data} t={t} />
    </div>
  );
}
