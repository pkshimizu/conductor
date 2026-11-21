/**
 * 配色（デザインの BASE と TONES）。外側の要素の inline style に CSS 変数（--bg など）と
 * color-scheme で入れ、中の要素は var(--bg) などで色を使う
 */
import type { CSSProperties } from "react";
import type { Scheme } from "./theme.js";

declare module "react" {
  interface CSSProperties {
    [variable: `--${string}`]: string | undefined;
  }
}

const BASE: Readonly<Record<Scheme, Readonly<Record<string, string>>>> = {
  light: {
    bg: "#FAFAFB",
    side: "#F4F4F6",
    panel: "#FFFFFF",
    subtle: "#F3F3F6",
    border: "#E5E5EA",
    border2: "#D1D1D9",
    fg: "#17171C",
    muted: "#5C5C68",
    accent: "#5652D6",
    accentText: "#4440C4",
    accentSoft: "#EFEEFD",
    overlay: "rgba(20, 20, 26, 0.38)",
    shadowLg: "0 18px 48px rgba(20, 20, 26, 0.20)",
    danger: "#C9252C",
  },
  dark: {
    bg: "#0C0C0F",
    side: "#0F0F13",
    panel: "#151519",
    subtle: "#1C1C22",
    border: "#26262D",
    border2: "#383842",
    fg: "#EDEDF2",
    muted: "#A2A2AE",
    accent: "#5652D6",
    accentText: "#ABA8FF",
    accentSoft: "#1F1E3B",
    overlay: "rgba(0, 0, 0, 0.62)",
    shadowLg: "0 18px 48px rgba(0, 0, 0, 0.55)",
    danger: "#D2343B",
  },
};

/** 色の組（背景・文字・枠） */
type Tone = readonly [bg: string, fg: string, bd: string];

const TONES: Readonly<Record<Scheme, Readonly<Record<string, Tone>>>> = {
  light: {
    gray: ["#F0F0F3", "#4A4A55", "#DCDCE2"],
    blue: ["#EAF1FF", "#1E4FD0", "#C9D9FB"],
    amber: ["#FFF4DE", "#8F5300", "#F2D9A6"],
    green: ["#E7F6EC", "#16773A", "#BFE5CC"],
    red: ["#FFECEB", "#BC2229", "#F5C3C0"],
  },
  dark: {
    gray: ["#202026", "#C2C2CC", "#30303A"],
    blue: ["#14213F", "#9BB8FF", "#24375F"],
    amber: ["#2C210F", "#F2C46E", "#4A3818"],
    green: ["#0F2819", "#74D69C", "#1D4A2E"],
    red: ["#371416", "#FF9C9C", "#5E2326"],
  },
};

/** 外側の要素に入れる、配色の CSS 変数と color-scheme */
export function themeStyle(scheme: Scheme): CSSProperties {
  const style: CSSProperties = {
    colorScheme: scheme,
    background: "var(--bg)",
    color: "var(--fg)",
  };
  for (const [name, value] of Object.entries(BASE[scheme])) {
    style[`--${name}`] = value;
  }
  for (const [name, [bg, fg, bd]] of Object.entries(TONES[scheme])) {
    style[`--${name}-bg`] = bg;
    style[`--${name}-fg`] = fg;
    style[`--${name}-bd`] = bd;
  }
  return style;
}
