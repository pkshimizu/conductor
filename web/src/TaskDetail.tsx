/**
 * タスク詳細（デザインの Main.dc.html の「タスク詳細」）。
 * 1件の Issue の番号・タイトル・列・PR・ブランチ・回数、進み具合（Blocked なら止まった段階と理由）、
 * 各役の結果の経過を出す。作業中の役の出力は出さず、作業中であることだけを示す。
 * ブラウザの globals（window など）には触らない（react-dom/server でも描ける）
 */
import type { CSSProperties, MouseEvent, ReactElement } from "react";
import type {
  TaskDetailData,
  TimelineEntry,
} from "../../src/task-detail-data.js";
import {
  formatDuration,
  formatStamp,
  secondsSince,
} from "./dashboard-format.js";
import {
  type Lang,
  type Messages,
  MESSAGES,
  type ResultKey,
  type RoleKey,
} from "./i18n.js";
import { isPlainClick } from "./navigation.js";
import { Progress } from "./Progress.js";
import { MENU_PATHS } from "./routes.js";
import {
  foldSummary,
  isLongSummary,
  orderTimeline,
  type TimelineOrder,
} from "./timeline.js";

export type { TaskDetailData } from "../../src/task-detail-data.js";

export interface TaskDetailProps {
  data: TaskDetailData;
  lang: Lang;
  /** 今の時刻（作業中の経過時間に使う） */
  now: Date;
  /** 経過の並び順 */
  order: TimelineOrder;
  /** 全文を出している経過。記録した順の番号（0 がいちばん古い記録）。並び順を変えても同じ番号 */
  expanded: number[];
  onOrder?: (order: TimelineOrder) => void;
  onToggle?: (index: number) => void;
  onNavigate?: (path: string) => void;
}

const MONO = "'JetBrains Mono', ui-monospace, monospace";
const NONE = "—";

/** 結果ごとの色（デザインの RESULT_TONE） */
const RESULT_TONE: Readonly<Record<ResultKey, string>> = {
  approved: "green",
  changes: "amber",
  objection: "violet",
  done: "blue",
  failed: "red",
  passed: "green",
};

/** 列ごとの色（デザインの COL_TONE。config の列の順） */
function columnTone(data: TaskDetailData): string {
  const index = data.columns.indexOf(data.column);
  return ["blue", "amber", "violet", "teal", "green", "red"][index] ?? "gray";
}

const ROLE_KEYS: readonly RoleKey[] = [
  "tester",
  "implementer",
  "ci",
  "reviewer",
  "merge",
  "specifier",
  "decomposer",
];

/** 役の文言。辞書に無い役（conductor・human など）はそのまま出す */
function roleLabel(t: Messages, role: string): string {
  const key = ROLE_KEYS.find((k) => k === role);
  return key === undefined ? role : t.roles[key];
}

function stampOf(iso: string | undefined): string {
  if (iso === undefined) return NONE;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? NONE : formatStamp(new Date(ms));
}

const PAGE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 20,
};

const BACK: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  height: 30,
  padding: "0 8px 0 4px",
  marginLeft: -4,
  borderRadius: 6,
  color: "var(--muted)",
  fontSize: 13,
  textDecoration: "none",
};

const DL: CSSProperties = {
  margin: 0,
  display: "flex",
  flexWrap: "wrap",
  gap: "10px 28px",
  fontSize: 13,
};

const DL_ITEM: CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "baseline",
};

const DT: CSSProperties = { color: "var(--muted)" };

const NUM: CSSProperties = {
  margin: 0,
  fontWeight: 500,
  fontVariantNumeric: "tabular-nums",
};

const LINK: CSSProperties = {
  color: "var(--accentText)",
  textDecoration: "none",
  fontWeight: 500,
};

const MERGED_CHIP: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  height: 20,
  padding: "0 6px",
  marginLeft: 6,
  borderRadius: 5,
  fontSize: 11,
  fontWeight: 500,
  background: "var(--violet-bg)",
  color: "var(--violet-fg)",
  border: "1px solid var(--violet-bd)",
};

const CARD: CSSProperties = {
  background: "var(--panel)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  boxShadow: "var(--shadow)",
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

const SORT_GROUP: CSSProperties = {
  display: "inline-flex",
  padding: 2,
  borderRadius: 8,
  background: "var(--subtle)",
  border: "1px solid var(--border)",
};

function sortStyle(selected: boolean): CSSProperties {
  return {
    height: 26,
    padding: "0 10px",
    border: 0,
    borderRadius: 6,
    font: "inherit",
    fontSize: 12,
    fontWeight: 500,
    cursor: "pointer",
    background: selected ? "var(--panel)" : "transparent",
    color: selected ? "var(--fg)" : "var(--muted)",
    boxShadow: selected ? "var(--shadow)" : "none",
  };
}

function ExternalIcon(): ReactElement {
  return (
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
  );
}

function issueUrl(data: TaskDetailData): string {
  return `https://github.com/${data.repo}/issues/${data.number}`;
}

function Header(props: { data: TaskDetailData; t: Messages }): ReactElement {
  const { data, t } = props;
  const tone = columnTone(data);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "8px 12px",
        }}
      >
        <span style={{ fontFamily: MONO, fontSize: 18, color: "var(--muted)" }}>
          {`#${data.number}`}
        </span>
        <h1
          style={{
            margin: 0,
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: "-0.01em",
          }}
        >
          {data.title}
        </h1>
        {data.column !== "" && (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              height: 24,
              padding: "0 9px",
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 500,
              background: `var(--${tone}-bg)`,
              color: `var(--${tone}-fg)`,
              border: `1px solid var(--${tone}-bd)`,
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 6,
                height: 6,
                borderRadius: 2,
                background: "currentColor",
              }}
            />
            {data.column}
          </span>
        )}
      </div>
      <dl style={DL}>
        <div style={DL_ITEM}>
          <dt style={DT}>PR</dt>
          <dd style={{ margin: 0 }}>
            {data.pr === undefined ? (
              <span style={{ color: "var(--muted)" }}>{NONE}</span>
            ) : (
              <>
                <a
                  href={`https://github.com/${data.repo}/pull/${data.pr}`}
                  target="_blank"
                  rel="noopener"
                  style={LINK}
                >
                  {`#${data.pr}`}
                </a>
                {data.merged === true && (
                  <span style={MERGED_CHIP}>{t.merged}</span>
                )}
              </>
            )}
          </dd>
        </div>
        <div style={DL_ITEM}>
          <dt style={DT}>{t.branch}</dt>
          <dd style={{ margin: 0, fontFamily: MONO, fontSize: 12 }}>
            {data.branch ?? NONE}
          </dd>
        </div>
        <div style={DL_ITEM}>
          <dt style={DT}>{t.rejections}</dt>
          <dd style={NUM}>{`${data.rejections}/${data.limits.rejections}`}</dd>
        </div>
        <div style={DL_ITEM}>
          <dt style={DT}>{t.objections}</dt>
          <dd style={NUM}>{`${data.objections}/${data.limits.objections}`}</dd>
        </div>
        <div style={DL_ITEM}>
          <dt style={DT}>Issue</dt>
          <dd style={{ margin: 0 }}>
            <a
              href={issueUrl(data)}
              target="_blank"
              rel="noopener"
              style={LINK}
            >
              {t.openGitHub}
            </a>
          </dd>
        </div>
      </dl>
    </div>
  );
}

function BlockedSection(props: {
  data: TaskDetailData;
  t: Messages;
}): ReactElement {
  const { data, t } = props;
  return (
    <section
      aria-label={t.blockedReason}
      style={{
        border: "1px solid var(--red-bd)",
        background: "var(--red-bg)",
        borderRadius: 12,
        padding: "16px 20px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "4px 12px",
          alignItems: "baseline",
        }}
      >
        <h2
          style={{
            margin: 0,
            fontSize: 15,
            fontWeight: 600,
            color: "var(--red-fg)",
          }}
        >
          {t.blockedTitle}
        </h2>
        <span style={{ fontSize: 12, color: "var(--muted)" }}>
          {t.stoppedAt}{" "}
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {stampOf(data.blockedAt)}
          </span>
        </span>
      </div>
      <span style={{ fontSize: 12, fontWeight: 500, color: "var(--muted)" }}>
        {t.blockedReason}
      </span>
      <p style={{ margin: 0, whiteSpace: "pre-line" }}>
        {data.blockedReason ?? NONE}
      </p>
      <div style={{ paddingTop: 4 }}>
        <a
          href={issueUrl(data)}
          target="_blank"
          rel="noopener"
          style={PRIMARY_LINK}
        >
          {t.openGitHub}
          <ExternalIcon />
        </a>
      </div>
    </section>
  );
}

function Working(props: {
  data: TaskDetailData;
  lang: Lang;
  t: Messages;
  now: Date;
}): ReactElement | null {
  const { data, lang, t, now } = props;
  if (data.working === undefined) return null;
  const since = secondsSince(data.stageStartedAt, now);
  return (
    <div
      role="status"
      style={{
        marginBottom: 16,
        padding: "10px 14px",
        borderRadius: 9,
        border: "1px dashed var(--border2)",
        display: "flex",
        flexWrap: "wrap",
        gap: "4px 12px",
        alignItems: "baseline",
      }}
    >
      <span style={{ fontWeight: 600 }}>{t.roles[data.working]}</span>
      <span
        style={{ fontSize: 12, color: "var(--accentText)", fontWeight: 500 }}
      >
        {since === undefined
          ? t.workingNow
          : `${t.workingNow} · ${formatDuration(since, lang)}`}
      </span>
      <span style={{ fontSize: 12, color: "var(--muted)", flexBasis: "100%" }}>
        {t.workingNote}
      </span>
    </div>
  );
}

function Entry(props: {
  entry: TimelineEntry;
  index: number;
  open: boolean;
  t: Messages;
  onToggle: ((index: number) => void) | undefined;
}): ReactElement {
  const { entry, index, open, t, onToggle } = props;
  const tone = entry.result === undefined ? "gray" : RESULT_TONE[entry.result];
  const long = isLongSummary(entry.text);
  const folded = long && !open;
  return (
    <article style={{ display: "flex", gap: 14, paddingBottom: 16 }}>
      <span
        aria-hidden="true"
        style={{
          width: 22,
          height: 22,
          flex: "none",
          borderRadius: "50%",
          background: `var(--${tone}-bg)`,
          border: `1px solid var(--${tone}-bd)`,
          color: `var(--${tone}-fg)`,
          display: "grid",
          placeItems: "center",
          boxSizing: "border-box",
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: "currentColor",
          }}
        />
      </span>
      <div
        style={{
          flex: 1,
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
            alignItems: "center",
            gap: "6px 10px",
          }}
        >
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
            {roleLabel(t, entry.role)}
          </h3>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              height: 22,
              padding: "0 8px",
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 500,
              background: `var(--${tone}-bg)`,
              color: `var(--${tone}-fg)`,
              border: `1px solid var(--${tone}-bd)`,
            }}
          >
            {entry.result === undefined
              ? entry.verdict
              : t.results[entry.result]}
          </span>
          <time
            dateTime={entry.at}
            style={{
              marginLeft: "auto",
              fontSize: 12,
              color: "var(--muted)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {stampOf(entry.at)}
          </time>
        </div>
        <div
          style={{
            borderRadius: 9,
            background: "var(--subtle)",
            border: "1px solid var(--border)",
            padding: "12px 14px",
          }}
        >
          <p
            style={{
              margin: 0,
              whiteSpace: "pre-line",
              fontSize: 13,
              lineHeight: 1.7,
              overflowWrap: "anywhere",
            }}
          >
            {folded ? foldSummary(entry.text) : entry.text}
          </p>
          {long && (
            <button
              type="button"
              aria-expanded={open ? "true" : "false"}
              onClick={() => onToggle?.(index)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                marginTop: 6,
                padding: 0,
                border: 0,
                background: "none",
                color: "var(--accentText)",
                font: "inherit",
                fontSize: 12,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              {open ? t.showLess : t.showMore}
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

function Timeline(props: TaskDetailProps & { t: Messages }): ReactElement {
  const { data, lang, t, now, order, expanded, onOrder, onToggle } = props;
  const entries = orderTimeline(data.timeline, order);
  const working = <Working data={data} lang={lang} t={t} now={now} />;
  const empty = data.timeline.length === 0 && data.working === undefined;
  return (
    <section aria-labelledby="tl-h" style={CARD}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          padding: "14px 20px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <h2 id="tl-h" style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
          {t.timeline}
        </h2>
        <div role="group" aria-label={t.sortOrder} style={SORT_GROUP}>
          {(["newest", "oldest"] as const).map((o) => (
            <button
              key={o}
              type="button"
              aria-pressed={o === order ? "true" : "false"}
              onClick={() => onOrder?.(o)}
              style={sortStyle(o === order)}
            >
              {t[o]}
            </button>
          ))}
        </div>
      </div>
      <div style={{ padding: "20px 20px 8px" }}>
        {order === "newest" && working}
        {entries.map(({ entry, index }) => (
          <Entry
            key={index}
            entry={entry}
            index={index}
            open={expanded.includes(index)}
            t={t}
            onToggle={onToggle}
          />
        ))}
        {order === "oldest" && working}
        {empty && (
          <p
            style={{
              margin: "0 0 16px",
              padding: 24,
              textAlign: "center",
              color: "var(--muted)",
            }}
          >
            {t.noTimeline}
          </p>
        )}
      </div>
    </section>
  );
}

export function TaskDetail(props: TaskDetailProps): ReactElement {
  const { data, lang, now, onNavigate } = props;
  const t = MESSAGES[lang];
  const back = MENU_PATHS.tasks;
  const goBack = (event: MouseEvent) => {
    if (onNavigate === undefined || !isPlainClick(event)) return;
    event.preventDefault();
    onNavigate(back);
  };
  const since =
    data.blocked === true ? undefined : secondsSince(data.stageStartedAt, now);
  return (
    <div style={PAGE}>
      <div>
        <a href={back} onClick={goBack} style={BACK}>
          <svg
            aria-hidden="true"
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M15 6l-6 6 6 6" />
          </svg>
          {t.back}
        </a>
      </div>
      <Header data={data} t={t} />
      {data.stage !== undefined && (
        <section style={{ ...CARD, padding: "18px 20px" }}>
          <Progress
            stage={data.stage}
            t={t}
            blocked={data.blocked === true}
            {...(since === undefined
              ? {}
              : { note: formatDuration(since, lang) })}
          />
        </section>
      )}
      {data.blocked === true && <BlockedSection data={data} t={t} />}
      <Timeline {...props} t={t} />
    </div>
  );
}
