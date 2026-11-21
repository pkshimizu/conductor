/**
 * タスク一覧（デザインの Main.dc.html の「タスク一覧」）。
 * Project のすべての Issue を表で出し、列と検索欄で絞り込む。行をクリックするとタスク詳細（/tasks/<番号>）を開く。
 * ブラウザの globals（window など）には触らない（react-dom/server でも描ける）
 */
import type {
  ChangeEvent,
  CSSProperties,
  MouseEvent,
  ReactElement,
} from "react";
import type { TaskRow, TasksData } from "../../src/tasks-data.js";
import { formatStamp, stageKeyOf } from "./dashboard-format.js";
import { type Lang, type Messages, MESSAGES } from "./i18n.js";
import { detailPath, isPlainClick } from "./navigation.js";
import { ALL_COLUMNS, columnOptions, filterTasks } from "./task-filter.js";

export type { TasksData } from "../../src/tasks-data.js";

export interface TaskListProps {
  data: TasksData;
  lang: Lang;
  /** 選んだ列。"all"（すべて）か列の名前 */
  filter: string;
  /** 検索欄の文字 */
  query: string;
  onFilter?: (filter: string) => void;
  onQuery?: (query: string) => void;
  onNavigate?: (path: string) => void;
}

const MONO = "'JetBrains Mono', ui-monospace, monospace";
const NONE = "—";

/** 列ごとの色（デザインの COL_TONE。config の列の順） */
function columnTone(data: TasksData, column: string): string {
  const index = data.columns.indexOf(column);
  return ["blue", "amber", "violet", "teal", "green", "red"][index] ?? "gray";
}

const PAGE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 18,
};

const H1: CSSProperties = {
  margin: 0,
  fontSize: 22,
  fontWeight: 600,
  letterSpacing: "-0.01em",
};

const TOOLBAR: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
};

const TABS: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 4,
  padding: 3,
  borderRadius: 9,
  background: "var(--subtle)",
  border: "1px solid var(--border)",
};

function tabStyle(selected: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    height: 28,
    padding: "0 10px",
    border: 0,
    borderRadius: 6,
    background: selected ? "var(--panel)" : "transparent",
    color: selected ? "var(--fg)" : "var(--muted)",
    boxShadow: selected ? "var(--shadow)" : "none",
    font: "inherit",
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
  };
}

const TAB_COUNT: CSSProperties = {
  fontSize: 11,
  fontVariantNumeric: "tabular-nums",
  color: "var(--muted)",
};

const SEARCH: CSSProperties = {
  position: "relative",
  display: "flex",
  alignItems: "center",
  flex: "0 1 300px",
  minWidth: 200,
};

const VISUALLY_HIDDEN: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
};

const SEARCH_INPUT: CSSProperties = {
  width: "100%",
  height: 34,
  boxSizing: "border-box",
  padding: "0 10px 0 32px",
  borderRadius: 8,
  border: "1px solid var(--border2)",
  background: "var(--panel)",
  color: "var(--fg)",
  font: "inherit",
  fontSize: 13,
};

const CARD: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 12,
  background: "var(--panel)",
  boxShadow: "var(--shadow)",
  overflowX: "auto",
};

const TABLE: CSSProperties = {
  width: "100%",
  minWidth: 980,
  borderCollapse: "collapse",
  tableLayout: "fixed",
};

const TH: CSSProperties = {
  height: 38,
  padding: "0 12px",
  textAlign: "left",
  fontSize: 12,
  fontWeight: 500,
  color: "var(--muted)",
  background: "var(--subtle)",
};

const TD: CSSProperties = {
  height: 48,
  padding: "0 12px",
  borderTop: "1px solid var(--border)",
  fontSize: 13,
};

/** 列の幅（デザインの grid-template-columns と同じ） */
const WIDTHS = [72, undefined, 132, 176, 92, 80, 96, 104] as const;

const ROW_LINK: CSSProperties = {
  color: "inherit",
  textDecoration: "none",
};

const COLUMN_CHIP_BASE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  height: 22,
  padding: "0 8px",
  borderRadius: 6,
  fontSize: 12,
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

const NO_RESULTS: CSSProperties = {
  borderTop: "1px solid var(--border)",
  padding: "40px 16px",
  textAlign: "center",
  color: "var(--muted)",
};

function stampOf(iso: string | undefined): string {
  if (iso === undefined) return NONE;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? NONE : formatStamp(new Date(t));
}

/** 途中の段階の文言。記録が無いか、完了の列なら出さない */
function stageText(row: TaskRow, data: TasksData, t: Messages): string {
  if (row.stage === undefined || row.column === data.doneColumn) return NONE;
  return t.stage[stageKeyOf(row.stage)];
}

function Row(props: {
  row: TaskRow;
  data: TasksData;
  t: Messages;
  onNavigate: ((path: string) => void) | undefined;
}): ReactElement {
  const { row, data, t, onNavigate } = props;
  const path = detailPath(row.number);
  const tone = columnTone(data, row.column);
  // 行のどこをクリックしてもタスク詳細を開く（リンクは新しいタブなどで開けるように残す）
  const openRow = () => onNavigate?.(path);
  const openLink = (event: MouseEvent) => {
    event.stopPropagation();
    if (onNavigate === undefined || !isPlainClick(event)) return;
    event.preventDefault();
    onNavigate(path);
  };
  const stopRow = (event: MouseEvent) => event.stopPropagation();
  const stage = stageText(row, data, t);
  return (
    <tr onClick={openRow} style={{ cursor: "pointer" }}>
      <td
        style={{
          ...TD,
          padding: "0 16px",
          fontFamily: MONO,
          color: "var(--muted)",
        }}
      >
        <a href={path} onClick={openLink} style={ROW_LINK}>
          {`#${row.number}`}
        </a>
      </td>
      <td
        style={{
          ...TD,
          fontWeight: 500,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        <a href={path} onClick={openLink} style={ROW_LINK}>
          {row.title}
        </a>
      </td>
      <td style={TD}>
        <span
          style={{
            ...COLUMN_CHIP_BASE,
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
          {row.column}
        </span>
      </td>
      <td
        style={{
          ...TD,
          color: stage === NONE ? "var(--muted)" : "var(--fg)",
        }}
      >
        {stage}
      </td>
      <td
        style={{
          ...TD,
          fontVariantNumeric: "tabular-nums",
          color: row.rejections > 0 ? "var(--amber-fg)" : "var(--muted)",
        }}
      >
        {`${row.rejections}/${data.limits.rejections}`}
      </td>
      <td
        style={{
          ...TD,
          fontVariantNumeric: "tabular-nums",
          color: row.objections > 0 ? "var(--violet-fg)" : "var(--muted)",
        }}
      >
        {`${row.objections}/${data.limits.objections}`}
      </td>
      <td style={{ ...TD, whiteSpace: "nowrap" }}>
        {row.pr === undefined ? (
          <span style={{ color: "var(--muted)" }}>{NONE}</span>
        ) : (
          <>
            <a
              href={`https://github.com/${data.repo}/pull/${row.pr}`}
              target="_blank"
              rel="noopener"
              onClick={stopRow}
              style={{
                color: "var(--accentText)",
                textDecoration: "none",
                fontWeight: 500,
              }}
            >
              {`#${row.pr}`}
            </a>
            {row.merged === true && <span style={MERGED_CHIP}>{t.merged}</span>}
          </>
        )}
      </td>
      <td
        style={{
          ...TD,
          padding: "0 16px 0 12px",
          fontSize: 12,
          color: "var(--muted)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {stampOf(row.updatedAt)}
      </td>
    </tr>
  );
}

export function TaskList(props: TaskListProps): ReactElement {
  const { data, lang, filter, query, onFilter, onQuery, onNavigate } = props;
  const t = MESSAGES[lang];
  const rows = filterTasks(data, filter, query);
  const options = columnOptions(data);
  const headers = [
    t.colIssue,
    t.colTitle,
    t.colColumn,
    t.colStage,
    t.colRej,
    t.colObj,
    "PR",
    t.colUpdated,
  ];
  const changeQuery = (event: ChangeEvent<HTMLInputElement>) =>
    onQuery?.(event.target.value);
  return (
    <div style={PAGE}>
      <h1 style={H1}>{t.navTasks}</h1>
      <div style={TOOLBAR}>
        <div role="group" aria-label={t.colColumn} style={TABS}>
          {options.map((o) => {
            const selected = o.value === filter;
            return (
              <button
                key={o.value}
                type="button"
                aria-pressed={selected}
                onClick={() => onFilter?.(o.value)}
                style={tabStyle(selected)}
              >
                {o.value === ALL_COLUMNS ? t.all : o.value}
                <span style={TAB_COUNT}>{o.count}</span>
              </button>
            );
          })}
        </div>
        <label style={SEARCH}>
          <span style={VISUALLY_HIDDEN}>{t.searchPh}</span>
          <svg
            aria-hidden="true"
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            style={{ position: "absolute", left: 10, color: "var(--muted)" }}
          >
            <circle cx="11" cy="11" r="6.5" />
            <path d="M20 20l-4.2-4.2" />
          </svg>
          <input
            type="search"
            value={query}
            onChange={changeQuery}
            placeholder={t.searchPh}
            style={SEARCH_INPUT}
          />
        </label>
      </div>
      <div style={CARD}>
        <table style={TABLE}>
          <colgroup>
            {WIDTHS.map((w, i) => (
              <col key={i} style={w === undefined ? {} : { width: w }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {headers.map((h, i) => (
                <th
                  key={i}
                  scope="col"
                  style={{
                    ...TH,
                    ...(i === 0 ? { padding: "0 16px" } : {}),
                    ...(i === headers.length - 1
                      ? { padding: "0 16px 0 12px" }
                      : {}),
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Row
                key={row.number}
                row={row}
                data={data}
                t={t}
                onNavigate={onNavigate}
              />
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <div style={NO_RESULTS}>{t.noResults}</div>}
      </div>
    </div>
  );
}
