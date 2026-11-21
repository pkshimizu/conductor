/**
 * 設定（デザインの Main.dc.html の「設定」とその各タブ、差分の確認ダイアログ）。
 * .conductor/config.yaml の値をタブに分けて出し、変更点を確かめてから保存（PR の作成）を頼む。
 * 入力の点検は src/config.ts と同じ決まり（src/settings-rules.ts）で行う。
 * ブラウザの globals（window など）には触らない（react-dom/server でも描ける）
 */
import type {
  ChangeEvent,
  CSSProperties,
  KeyboardEvent,
  ReactElement,
  ReactNode,
} from "react";
import { type Role, ROLES } from "../../src/config-schema.js";
import type { SettingsData, SettingsForm } from "../../src/settings-data.js";
import {
  CHANNEL_KEYS,
  changedTabs,
  COLUMN_KEYS,
  COMMAND_KEYS,
  diffSettings,
  errorCounts,
  type SettingsChange,
  type SettingsErrorKind,
  type SettingsErrors,
  type SettingsTab,
  SETTINGS_TABS,
  validateSettings,
} from "../../src/settings-rules.js";
import { fill, type Lang, type Messages, MESSAGES } from "./i18n.js";
import {
  addDraft,
  cancelSettings,
  discardSettings,
  editForm,
  removeItem,
  reviewSettings,
  selectTab,
  setDraft,
  type SettingsState,
} from "./settings-state.js";

export type { SettingsData, SettingsForm } from "../../src/settings-data.js";

export interface SettingsProps {
  /** 読み込んだ値（変更の有無はこれと state.form を比べる） */
  data: SettingsData;
  state: SettingsState;
  lang: Lang;
  onState?: (state: SettingsState) => void;
  /** ダイアログの「保存して PR を作成」 */
  onSave?: () => void;
  /** 保存後の案内の「再起動」 */
  onRestart?: () => void;
}

const MONO = "'JetBrains Mono', ui-monospace, monospace";
const CONFIG_PATH = ".conductor/config.yaml";

/** 列の名前の欄の名前（GitHub Projects の既定の列名） */
const COLUMN_LABELS: Readonly<Record<(typeof COLUMN_KEYS)[number], string>> = {
  ready: "Ready",
  testing: "Testing",
  implementing: "Implementing",
  reviewing: "Reviewing",
  done: "Done",
  blocked: "Blocked",
};

const PAGE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 18,
};

const HEAD: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "flex-end",
  justifyContent: "space-between",
  gap: 12,
};

const H1: CSSProperties = {
  margin: 0,
  fontSize: 22,
  fontWeight: 600,
  letterSpacing: "-0.01em",
};

const SUB: CSSProperties = {
  margin: "6px 0 0",
  color: "var(--muted)",
  fontSize: 13,
};

const ACTIONS: CSSProperties = { display: "flex", gap: 8 };

function secondaryButton(disabled: boolean): CSSProperties {
  return {
    height: 32,
    padding: "0 12px",
    borderRadius: 7,
    border: "1px solid var(--border2)",
    background: "var(--panel)",
    color: "var(--fg)",
    font: "inherit",
    fontSize: 13,
    fontWeight: 500,
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.45 : 1,
  };
}

function primaryButton(disabled: boolean): CSSProperties {
  return {
    height: 32,
    padding: "0 14px",
    borderRadius: 7,
    border: 0,
    background: "var(--accent)",
    color: "#FFFFFF",
    font: "inherit",
    fontSize: 13,
    fontWeight: 500,
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.45 : 1,
  };
}

const TABS: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 4,
  padding: 3,
  borderRadius: 9,
  background: "var(--subtle)",
  border: "1px solid var(--border)",
  alignSelf: "flex-start",
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

const BADGE_ERR: CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  padding: "0 6px",
  borderRadius: 5,
  background: "var(--red-bg)",
  color: "var(--red-fg)",
  border: "1px solid var(--red-bd)",
};

const BADGE_CHANGED: CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  padding: "0 6px",
  borderRadius: 5,
  background: "var(--amber-bg)",
  color: "var(--amber-fg)",
  border: "1px solid var(--amber-bd)",
};

const CARD: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 12,
  background: "var(--panel)",
  boxShadow: "var(--shadow)",
  padding: "18px 20px",
  display: "flex",
  flexDirection: "column",
};

const H2: CSSProperties = { margin: 0, fontSize: 15, fontWeight: 600 };

const HELP: CSSProperties = { fontSize: 12, color: "var(--muted)" };

const ROW: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(180px, 260px) minmax(0, 1fr)",
  gap: "6px 24px",
  padding: "14px 0",
  borderTop: "1px solid var(--border)",
  alignItems: "start",
};

const ROW_LABEL: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const READONLY_BADGE: CSSProperties = {
  height: 20,
  padding: "0 7px",
  borderRadius: 5,
  background: "var(--subtle)",
  border: "1px solid var(--border)",
  color: "var(--muted)",
  fontSize: 11,
  fontWeight: 500,
  display: "inline-flex",
  alignItems: "center",
};

function inputStyle(
  width: string,
  mono: boolean,
  invalid: boolean,
): CSSProperties {
  return {
    width,
    maxWidth: "100%",
    height: 32,
    boxSizing: "border-box",
    padding: "0 10px",
    borderRadius: 7,
    border: `1px solid ${invalid ? "var(--red-fg)" : "var(--border2)"}`,
    background: "var(--panel)",
    color: "var(--fg)",
    font: "inherit",
    fontSize: 13,
    ...(mono ? { fontFamily: MONO } : {}),
  };
}

const ERROR_TEXT: CSSProperties = {
  display: "block",
  marginTop: 6,
  fontSize: 12,
  color: "var(--red-fg)",
};

const CHIP: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  height: 26,
  padding: "0 4px 0 8px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--subtle)",
  fontFamily: MONO,
  fontSize: 12,
};

const CHIP_REMOVE: CSSProperties = {
  width: 20,
  height: 20,
  border: 0,
  borderRadius: 4,
  background: "transparent",
  color: "var(--muted)",
  font: "inherit",
  cursor: "pointer",
};

const NOTICE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "8px 16px",
  padding: "12px 16px",
  borderRadius: 10,
  border: "1px solid var(--green-bd)",
  background: "var(--green-bg)",
  color: "var(--green-fg)",
  fontSize: 13,
};

const FAILED: CSSProperties = {
  ...NOTICE,
  border: "1px solid var(--red-bd)",
  background: "var(--red-bg)",
  color: "var(--red-fg)",
};

const OVERLAY: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 30,
  background: "var(--overlay)",
};

const DIALOG: CSSProperties = {
  position: "absolute",
  top: 100,
  left: "50%",
  transform: "translateX(-50%)",
  width: "min(640px, calc(100% - 32px))",
  maxHeight: "calc(100% - 140px)",
  overflowY: "auto",
  borderRadius: 12,
  border: "1px solid var(--border)",
  background: "var(--panel)",
  boxShadow: "var(--shadowLg)",
  padding: "20px 22px",
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const DIFF_LIST: CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: "none",
  border: "1px solid var(--border)",
  borderRadius: 8,
  fontFamily: MONO,
  fontSize: 12,
};

const DIFF_ITEM: CSSProperties = {
  padding: "8px 12px",
  borderTop: "1px solid var(--border)",
  display: "flex",
  flexWrap: "wrap",
  gap: "4px 10px",
};

const PRE: CSSProperties = {
  margin: 0,
  padding: "14px 16px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--subtle)",
  fontFamily: MONO,
  fontSize: 12,
  lineHeight: 1.6,
  whiteSpace: "pre-wrap",
  overflowX: "auto",
};

function errorText(t: Messages, kind: SettingsErrorKind): string {
  if (kind === "int") return t.errInt;
  if (kind === "poll") return t.errPoll;
  if (kind === "user") return t.errUser;
  if (kind === "minOne") return t.errMinOne;
  return t.errRequired;
}

function tabLabel(t: Messages, tab: SettingsTab): string {
  if (tab === "general") return t.tabGeneral;
  if (tab === "commands") return t.tabCommands;
  if (tab === "perms") return t.tabPerms;
  if (tab === "discord") return t.tabDiscord;
  return t.tabPrompts;
}

/** 画面の部品で共通に使うもの */
interface Ctx {
  t: Messages;
  state: SettingsState;
  errors: SettingsErrors;
  update: (state: SettingsState) => void;
}

function Section(props: {
  title: string;
  help?: string;
  children: ReactNode;
  aside?: ReactNode;
}): ReactElement {
  return (
    <section style={CARD}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 8,
          paddingBottom: 12,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <h2 style={H2}>{props.title}</h2>
          {props.help !== undefined && props.help !== "" && (
            <span style={HELP}>{props.help}</span>
          )}
        </div>
        {props.aside}
      </div>
      {props.children}
    </section>
  );
}

function Row(props: {
  label: string;
  help?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div style={ROW}>
      <div style={ROW_LABEL}>
        <span style={{ fontWeight: 500 }}>{props.label}</span>
        {props.help !== undefined && props.help !== "" && (
          <span style={HELP}>{props.help}</span>
        )}
      </div>
      <div>{props.children}</div>
    </div>
  );
}

/** 1つの値を入れる欄。誤りは欄の後ろに出す */
function TextField(props: {
  ctx: Ctx;
  field: string;
  label: string;
  value: string;
  edit: (form: SettingsForm, value: string) => void;
  width?: string;
  mono?: boolean;
  numeric?: boolean;
  unit?: string;
}): ReactElement {
  const { ctx, field, label, value } = props;
  const error = ctx.errors[field];
  const change = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.value;
    ctx.update(editForm(ctx.state, (f) => props.edit(f, next)));
  };
  return (
    <>
      <input
        type="text"
        aria-label={label}
        value={value}
        onChange={change}
        inputMode={props.numeric === true ? "numeric" : "text"}
        {...(error === undefined ? {} : { "aria-invalid": true })}
        style={inputStyle(
          props.width ?? "320px",
          props.mono === true,
          error !== undefined,
        )}
      />
      {props.unit !== undefined && (
        <span style={{ ...HELP, marginLeft: 8 }}>{props.unit}</span>
      )}
      {error !== undefined && (
        <span style={ERROR_TEXT}>{errorText(ctx.t, error)}</span>
      )}
    </>
  );
}

/** 値のリスト（protected・役ごとの追加許可・受け付ける人）。各要素に削除のボタン、最後に追加欄 */
function ListField(props: {
  ctx: Ctx;
  field: string;
  addLabel: string;
  list: (form: SettingsForm) => string[];
}): ReactElement {
  const { ctx, field, addLabel, list } = props;
  const { t, state } = ctx;
  const items = list(state.form);
  const error = ctx.errors[field];
  const draft = state.drafts?.[field] ?? "";
  const add = () => ctx.update(addDraft(state, field, list));
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    add();
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {items.length === 0 ? (
        <span style={HELP}>{t.none}</span>
      ) : (
        <ul
          style={{
            margin: 0,
            padding: 0,
            listStyle: "none",
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
          }}
        >
          {items.map((value) => (
            <li key={value} style={CHIP}>
              <span>{value}</span>
              <button
                type="button"
                aria-label={`${t.remove} ${value}`}
                onClick={() => ctx.update(removeItem(state, list, value))}
                style={CHIP_REMOVE}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div style={{ display: "flex", gap: 6 }}>
        <input
          type="text"
          aria-label={addLabel}
          placeholder={addLabel}
          value={draft}
          onChange={(event) =>
            ctx.update(setDraft(state, field, event.target.value))
          }
          onKeyDown={onKey}
          style={inputStyle("320px", true, false)}
        />
        <button
          type="button"
          onClick={add}
          style={secondaryButton(draft.trim() === "")}
        >
          {t.add}
        </button>
      </div>
      {error !== undefined && (
        <span style={ERROR_TEXT}>{errorText(t, error)}</span>
      )}
    </div>
  );
}

function ReadonlyValue(props: { t: Messages; value: string }): ReactElement {
  return (
    <span
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 8,
      }}
    >
      <span style={{ fontFamily: MONO, fontSize: 13 }}>{props.value}</span>
      <span style={READONLY_BADGE}>{props.t.readonly}</span>
    </span>
  );
}

function GeneralTab(props: { ctx: Ctx; data: SettingsData }): ReactElement {
  const { ctx, data } = props;
  const { t, state } = ctx;
  const f = state.form;
  const approvals = [
    ["auto", t.autoDesc],
    ["human", t.humanDesc],
  ] as const;
  return (
    <>
      <Section title="GitHub">
        <Row label={t.repo}>
          <ReadonlyValue t={t} value={data.repo} />
        </Row>
        <Row label={t.project}>
          <ReadonlyValue t={t} value={String(data.project)} />
        </Row>
        <Row label={t.notify} help={t.notifyHelp}>
          <TextField
            ctx={ctx}
            field="github.notify"
            label={t.notify}
            value={f.github.notify}
            edit={(form, v) => (form.github.notify = v)}
            width="220px"
            mono
          />
        </Row>
        <Row label={t.columns} help={t.columnsHelp}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns:
                "repeat(auto-fit, minmax(min(200px, 100%), 1fr))",
              gap: "12px 16px",
            }}
          >
            {COLUMN_KEYS.map((k) => (
              <div key={k}>
                <span style={{ ...HELP, display: "block", marginBottom: 4 }}>
                  {COLUMN_LABELS[k]}
                </span>
                <TextField
                  ctx={ctx}
                  field={`github.columns.${k}`}
                  label={COLUMN_LABELS[k]}
                  value={f.github.columns[k]}
                  edit={(form, v) => (form.github.columns[k] = v)}
                  width="100%"
                />
              </div>
            ))}
          </div>
        </Row>
      </Section>
      <Section title={t.secLimits}>
        <Row label={t.rejectLimit} help={`${t.dflt} 3`}>
          <TextField
            ctx={ctx}
            field="limits.rejections"
            label={t.rejectLimit}
            value={f.limits.rejections}
            edit={(form, v) => (form.limits.rejections = v)}
            width="96px"
            numeric
          />
        </Row>
        <Row label={t.objectLimit} help={`${t.dflt} 2`}>
          <TextField
            ctx={ctx}
            field="limits.objections"
            label={t.objectLimit}
            value={f.limits.objections}
            edit={(form, v) => (form.limits.objections = v)}
            width="96px"
            numeric
          />
        </Row>
        <Row label={t.concurrency} help={`${t.dflt} 3`}>
          <TextField
            ctx={ctx}
            field="limits.reviewers"
            label={t.concurrency}
            value={f.limits.reviewers}
            edit={(form, v) => (form.limits.reviewers = v)}
            width="96px"
            numeric
          />
        </Row>
        <Row label={t.approval} help={t.secMerge}>
          <div
            role="radiogroup"
            aria-label={t.approval}
            style={{
              display: "grid",
              gridTemplateColumns:
                "repeat(auto-fit, minmax(min(240px, 100%), 1fr))",
              gap: 10,
            }}
          >
            {approvals.map(([value, desc]) => (
              <label
                key={value}
                style={{
                  display: "flex",
                  gap: 10,
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: `1px solid ${f.merge.approval === value ? "var(--accent)" : "var(--border)"}`,
                  cursor: "pointer",
                }}
              >
                <input
                  type="radio"
                  name="merge.approval"
                  value={value}
                  checked={f.merge.approval === value}
                  onChange={() =>
                    ctx.update(
                      editForm(state, (form) => (form.merge.approval = value)),
                    )
                  }
                />
                <span style={{ display: "flex", flexDirection: "column" }}>
                  <span style={{ fontFamily: MONO, fontWeight: 500 }}>
                    {value}
                  </span>
                  <span style={HELP}>{desc}</span>
                </span>
              </label>
            ))}
          </div>
        </Row>
      </Section>
      <Section title={t.secBehavior}>
        <Row label={t.poll} help={`${t.pollHelp} · ${t.dflt} 90`}>
          <TextField
            ctx={ctx}
            field="poll_interval"
            label={t.poll}
            value={f.poll_interval}
            edit={(form, v) => (form.poll_interval = v)}
            width="96px"
            numeric
            unit={t.secUnit}
          />
        </Row>
        <Row label={t.language2}>
          <TextField
            ctx={ctx}
            field="language"
            label={t.language2}
            value={f.language}
            edit={(form, v) => (form.language = v)}
            width="200px"
          />
        </Row>
        <Row label={t.shots} help={t.shotsHelp}>
          <TextField
            ctx={ctx}
            field="screenshots"
            label={t.shots}
            value={f.screenshots}
            edit={(form, v) => (form.screenshots = v)}
            mono
          />
        </Row>
      </Section>
    </>
  );
}

function CommandsTab(props: { ctx: Ctx }): ReactElement {
  const { ctx } = props;
  const { t, state } = ctx;
  return (
    <>
      <Section title={t.secCommands}>
        {COMMAND_KEYS.map((k) => (
          <Row
            key={k}
            label={k}
            help={k === "format" ? t.optional : t.required}
          >
            <TextField
              ctx={ctx}
              field={`commands.${k}`}
              label={k}
              value={state.form.commands[k]}
              edit={(form, v) => (form.commands[k] = v)}
              width="360px"
              mono
            />
          </Row>
        ))}
      </Section>
      <Section title={t.secProtected} help={t.protectedHelp}>
        <ListField
          ctx={ctx}
          field="protected"
          addLabel={t.addGlob}
          list={(form) => form.protected}
        />
      </Section>
    </>
  );
}

function PermsTab(props: { ctx: Ctx }): ReactElement {
  const { ctx } = props;
  const { t } = ctx;
  return (
    <Section title={t.secPerms} help={t.permsHelp}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "repeat(auto-fit, minmax(min(380px, 100%), 1fr))",
          gap: 14,
        }}
      >
        {ROLES.map((r) => (
          <div
            key={r}
            style={{
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: "12px 14px",
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
              {t.roles[r]}
            </h3>
            <ListField
              ctx={ctx}
              field={`roles.${r}.allow`}
              addLabel={`${t.roles[r]}${t.addPerm}`}
              list={(form) => form.roles[r].allow}
            />
          </div>
        ))}
      </div>
    </Section>
  );
}

function DiscordTab(props: { ctx: Ctx; data: SettingsData }): ReactElement {
  const { ctx, data } = props;
  const { t, state } = ctx;
  const chat = state.form.chat;
  const channelLabels: Readonly<Record<(typeof CHANNEL_KEYS)[number], string>> =
    {
      requirements: t.chReq,
      questions: t.chQ,
      notices: t.chNotice,
    };
  const toggle = () =>
    ctx.update(
      editForm(state, (form) => (form.chat.enabled = !form.chat.enabled)),
    );
  return (
    <Section
      title={t.secDiscord}
      help={t.optional}
      aside={
        <button
          type="button"
          aria-pressed={chat.enabled}
          onClick={toggle}
          style={{
            ...secondaryButton(false),
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 28,
              height: 16,
              borderRadius: 8,
              background: chat.enabled ? "var(--accent)" : "var(--border2)",
              position: "relative",
            }}
          >
            <span
              style={{
                position: "absolute",
                top: 2,
                left: chat.enabled ? 14 : 2,
                width: 12,
                height: 12,
                borderRadius: 6,
                background: "#FFFFFF",
              }}
            />
          </span>
          {t.useDiscord}
        </button>
      }
    >
      {chat.enabled && (
        <>
          {CHANNEL_KEYS.map((k) => (
            <Row key={k} label={channelLabels[k]}>
              <TextField
                ctx={ctx}
                field={`chat.channels.${k}`}
                label={channelLabels[k]}
                value={chat.channels[k]}
                edit={(form, v) => (form.chat.channels[k] = v)}
                width="260px"
                mono
              />
            </Row>
          ))}
          <Row label={t.users}>
            <ListField
              ctx={ctx}
              field="chat.allowed_users"
              addLabel={t.users}
              list={(form) => form.chat.allowed_users}
            />
          </Row>
        </>
      )}
      <Row label={t.token} help={t.tokenHelp}>
        <span style={READONLY_BADGE}>
          {data.token === "set" ? t.tokenSet : t.tokenUnset}
        </span>
      </Row>
    </Section>
  );
}

function PromptsTab(props: { ctx: Ctx; data: SettingsData }): ReactElement {
  const { ctx, data } = props;
  const { t, state } = ctx;
  const role: Role = state.prompt?.role ?? ROLES[0];
  const files = data.prompts[role];
  const file = files.find((p) => p.name === state.prompt?.file) ?? files[0];
  const pick = (next: { role: Role; file?: string }) =>
    ctx.update({ ...state, prompt: next });
  return (
    <Section
      title={t.secPrompts}
      aside={
        <span style={HELP}>
          <span style={{ fontFamily: MONO }}>.conductor/&lt;role&gt;/*.md</span>
          {` · ${t.readonly}`}
        </span>
      }
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(160px, 220px) minmax(0, 1fr)",
          gap: 16,
        }}
      >
        <nav
          aria-label={t.role}
          style={{ display: "flex", flexDirection: "column", gap: 4 }}
        >
          {ROLES.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={r === role}
              onClick={() => pick({ role: r })}
              style={{
                ...tabStyle(r === role),
                justifyContent: "space-between",
              }}
            >
              <span>{t.roles[r]}</span>
              <span style={HELP}>{data.prompts[r].length}</span>
            </button>
          ))}
        </nav>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {files.length === 0 ? (
            <span style={HELP}>{t.noPrompts}</span>
          ) : (
            <>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {files.map((p) => (
                  <button
                    key={p.name}
                    type="button"
                    aria-pressed={p.name === file?.name}
                    onClick={() => pick({ role, file: p.name })}
                    style={{
                      ...tabStyle(p.name === file?.name),
                      fontFamily: MONO,
                    }}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
              {file !== undefined && <pre style={PRE}>{file.text}</pre>}
            </>
          )}
        </div>
      </div>
    </Section>
  );
}

function DiffValue(props: {
  value: string | undefined;
  tone: "before" | "after";
}) {
  const color = props.tone === "before" ? "var(--red-fg)" : "var(--green-fg)";
  return (
    <span style={{ color }}>
      {props.value === undefined || props.value === "" ? "—" : props.value}
    </span>
  );
}

function DiffDialog(props: {
  t: Messages;
  changes: readonly SettingsChange[];
  onCancel: () => void;
  onSave: (() => void) | undefined;
}): ReactElement {
  const { t, changes } = props;
  return (
    <div style={OVERLAY}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-diff-title"
        style={DIALOG}
      >
        <h2 id="settings-diff-title" style={{ ...H2, fontSize: 16 }}>
          {t.diffTitle}
        </h2>
        <p style={{ margin: 0, color: "var(--muted)", fontSize: 13 }}>
          {t.diffBody}
        </p>
        <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 600 }}>
          {CONFIG_PATH}
        </span>
        <ul style={DIFF_LIST}>
          {changes.map((c, i) => (
            <li
              key={c.path}
              style={{ ...DIFF_ITEM, ...(i === 0 ? { borderTop: 0 } : {}) }}
            >
              <span style={{ fontWeight: 600 }}>{c.path}</span>
              {c.removed === true ? (
                <span style={{ color: "var(--red-fg)" }}>{t.chatRemoved}</span>
              ) : (
                <>
                  <DiffValue value={c.before} tone="before" />
                  <span aria-hidden="true">→</span>
                  <DiffValue value={c.after} tone="after" />
                </>
              )}
            </li>
          ))}
        </ul>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "flex-end",
            gap: 8,
          }}
        >
          <button
            type="button"
            onClick={props.onCancel}
            style={secondaryButton(false)}
          >
            {t.cancel}
          </button>
          <button
            type="button"
            onClick={props.onSave}
            style={primaryButton(false)}
          >
            {t.diffOk}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Settings(props: SettingsProps): ReactElement {
  const { data, state, lang, onState, onSave, onRestart } = props;
  const t = MESSAGES[lang];
  const errors = validateSettings(state.form);
  const counts = errorCounts(errors);
  const changes = diffSettings(data.form, state.form);
  const changed = changedTabs(changes);
  const errorTotal = Object.keys(errors).length;
  const update = (next: SettingsState) => onState?.(next);
  const ctx: Ctx = { t, state, errors, update };
  const noChanges = changes.length === 0;
  const saveDisabled = noChanges || errorTotal > 0;

  return (
    <div style={PAGE}>
      <div style={HEAD}>
        <div>
          <h1 style={H1}>{t.navSettings}</h1>
          <p style={SUB}>{t.settingsSub}</p>
        </div>
        <div style={ACTIONS}>
          <button
            type="button"
            disabled={noChanges}
            onClick={() => update(discardSettings(state, data))}
            style={secondaryButton(noChanges)}
          >
            {t.discard}
          </button>
          <button
            type="button"
            disabled={saveDisabled}
            onClick={() => update(reviewSettings(state, data))}
            style={primaryButton(saveDisabled)}
          >
            {t.reviewAndSave}
          </button>
        </div>
      </div>

      {state.saved !== undefined && (
        <div role="status" style={NOTICE}>
          <strong>{fill(t.toastSaved, { n: state.saved.number })}</strong>
          <span>{t.postSaveNote}</span>
          <a
            href={state.saved.url}
            target="_blank"
            rel="noopener"
            style={{ color: "inherit", fontWeight: 500 }}
          >
            {`PR #${state.saved.number}`}
          </a>
          <button
            type="button"
            onClick={onRestart}
            style={secondaryButton(false)}
          >
            {t.restart}
          </button>
        </div>
      )}
      {state.failed === true && (
        <div role="alert" style={FAILED}>
          {t.saveFailed}
        </div>
      )}

      <div role="tablist" aria-label={t.navSettings} style={TABS}>
        {SETTINGS_TABS.map((tab) => {
          const selected = tab === state.tab;
          const count = counts[tab];
          return (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => update(selectTab(state, tab))}
              style={tabStyle(selected)}
            >
              {tabLabel(t, tab)}
              {count > 0 ? (
                <span style={BADGE_ERR}>{`${count}${t.tabErr}`}</span>
              ) : (
                changed.has(tab) && (
                  <span style={BADGE_CHANGED}>{t.tabChanged}</span>
                )
              )}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        style={{ display: "flex", flexDirection: "column", gap: 14 }}
      >
        {state.tab === "general" && <GeneralTab ctx={ctx} data={data} />}
        {state.tab === "commands" && <CommandsTab ctx={ctx} />}
        {state.tab === "perms" && <PermsTab ctx={ctx} />}
        {state.tab === "discord" && <DiscordTab ctx={ctx} data={data} />}
        {state.tab === "prompts" && <PromptsTab ctx={ctx} data={data} />}
      </div>

      {state.dialog === "diff" && (
        <DiffDialog
          t={t}
          changes={changes}
          onCancel={() => update(cancelSettings(state))}
          onSave={onSave}
        />
      )}
    </div>
  );
}
