/**
 * 進み具合（テスト→実装→CI→レビュー→マージ）。ダッシュボードとタスク詳細で使う。
 * 今の段階の <li> に aria-current="step" を付け、その下に note（経過時間など）を出す
 */
import type { CSSProperties, ReactElement } from "react";
import type { DashboardStage } from "../../src/dashboard-data.js";
import { stageKeyOf } from "./dashboard-format.js";
import { type Messages, STAGE_KEYS } from "./i18n.js";

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

export function Progress(props: {
  stage: DashboardStage;
  t: Messages;
  /** 今の段階の下に出す文（無ければ出さない） */
  note?: string;
  /** 止まっているなら true（今の段階を赤で示す） */
  blocked?: boolean;
}): ReactElement {
  const { stage, t, note, blocked = false } = props;
  const currentIndex = STAGE_KEYS.indexOf(stageKeyOf(stage));
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
        const dot = stepDotStyle(done, current);
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
              <span
                style={
                  current && blocked
                    ? {
                        ...dot,
                        background: "var(--red-fg)",
                        border: "1.5px solid var(--red-fg)",
                        boxShadow: "0 0 0 4px var(--red-bg)",
                      }
                    : dot
                }
              />
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
            {current && note !== undefined && (
              <span
                style={{
                  fontSize: 12,
                  color: "var(--muted)",
                  paddingRight: 8,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {note}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
