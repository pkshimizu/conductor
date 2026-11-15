/**
 * 役（テスト役・実装役・レビュー役）を Claude Code のヘッドレス実行（claude -p）で起動する。
 * - 役の決まり → --append-system-prompt-file、依頼文（Issue 本文・指摘）→ 標準入力
 * - 毎回新しいセッション（--resume は使わない）
 * - 結果は --json-schema で形を指定し、受け取った後にもう一度点検する
 * - --permission-mode dontAsk ＋ 許可リスト：リストにない操作は確認なしで拒否される
 * - 利用上限に達したら、リセット時刻まで待って同じ依頼をやり直す
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { commandExec, type Exec } from "./exec.js";

export type { Exec, ExecResult } from "./exec.js";

/** 判定：承認／差し戻し／異議 */
export const VERDICTS = ["approve", "reject", "objection"] as const;

export const findingSchema = z
  .object({
    file: z.string().describe("対象のファイル（リポジトリからの相対パス）"),
    line: z.number().int().nullable().describe("行番号。特定できなければ null"),
    message: z.string().describe("指摘の内容"),
  })
  .strict();
export type Finding = z.infer<typeof findingSchema>;

/** すべての役に共通の項目 */
export const commonOutputShape = {
  verdict: z
    .enum(VERDICTS)
    .describe("approve=承認、reject=差し戻し、objection=異議"),
  summary: z.string().describe("やったこと・判断の要約"),
  findings: z.array(findingSchema).describe("指摘の一覧。無ければ空配列"),
};

/** 共通の項目に役ごとの項目を足した、結果の形を作る */
export function roleOutput<T extends z.ZodRawShape>(extra: T) {
  return z.object({ ...commonOutputShape, ...extra }).strict();
}

export const commonOutputSchema = roleOutput({});
export type CommonOutput = z.infer<typeof commonOutputSchema>;

/** Claude Code に渡す JSON Schema */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = { ...(z.toJSONSchema(schema) as Record<string, unknown>) };
  delete json.$schema;
  return json;
}

export interface RoleRun<S extends z.ZodType> {
  /** 役の名前（記録とエラー表示用） */
  role: string;
  /** 作業するフォルダ（対象リポジトリ） */
  cwd: string;
  /** 役の決まり */
  systemPrompt: string;
  /** 依頼文 */
  prompt: string;
  schema: S;
  /** 許可する操作（例: "Read", "Bash(npm test)"） */
  allow: readonly string[];
  model?: string;
  /** 1回の実行の制限時間（ミリ秒） */
  timeoutMs?: number;
}

export interface RoleResult<T> {
  output: T;
  /** 拒否された操作 */
  denials: { tool: string; input: unknown }[];
  costUsd: number;
  turns: number;
  sessionId: string;
}

export interface ClaudeDeps {
  exec: Exec;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  /** 利用上限で待つ前に呼ぶ（中断点の記録に使う） */
  onLimit?: (info: {
    role: string;
    resumeAt: Date;
    message: string;
  }) => void | Promise<void>;
}

export class RoleError extends Error {
  constructor(
    readonly role: string,
    message: string,
    readonly detail?: string,
  ) {
    super(`${role}: ${message}`);
    this.name = "RoleError";
  }
}

/** claude -p の引数を組み立てる */
export function buildArgs(
  run: Pick<RoleRun<z.ZodType>, "schema" | "allow" | "model">,
  systemPromptFile: string,
): string[] {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--permission-mode",
    "dontAsk",
    "--append-system-prompt-file",
    systemPromptFile,
    "--json-schema",
    JSON.stringify(toJsonSchema(run.schema)),
  ];
  if (run.model) args.push("--model", run.model);
  // 許可リストが空なら道具を一切使わせない
  if (run.allow.length === 0) args.push("--tools", "");
  else args.push("--allowedTools", ...run.allow);
  return args;
}

const cliResultSchema = z.looseObject({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
  session_id: z.string().default(""),
  total_cost_usd: z.number().default(0),
  num_turns: z.number().default(0),
  api_error_status: z.union([z.number(), z.string()]).nullish(),
  permission_denials: z
    .array(z.looseObject({ tool_name: z.string(), tool_input: z.unknown() }))
    .default([]),
});

const LIMIT_PATTERN =
  /usage limit|hit your (?:usage )?limit|rate[_ ]limit|limit reached|out of extra usage/i;

/** 時刻が読み取れないときに待つ時間 */
export const DEFAULT_LIMIT_WAIT_MS = 15 * 60 * 1000;
/** リセット直後は混み合うので少し余裕を持たせる */
const LIMIT_MARGIN_MS = 60 * 1000;

/** 利用上限のメッセージなら、再開してよい時刻を返す。上限でなければ undefined */
export function detectLimit(text: string, now: Date): Date | undefined {
  if (!LIMIT_PATTERN.test(text)) return undefined;
  // 旧形式: "Claude AI usage limit reached|1763190000"
  const epoch = /\|(\d{10,13})\b/.exec(text);
  if (epoch) {
    const n = Number(epoch[1]);
    return new Date((n < 1e12 ? n * 1000 : n) + LIMIT_MARGIN_MS);
  }
  // 新形式: "resets 5pm (Asia/Tokyo)" / "resets 5:30am" / "resets 17:00"
  const m =
    /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i.exec(
      text,
    );
  if (m) {
    let hour = Number(m[1]);
    const minute = Number(m[2] ?? 0);
    const ampm = m[3]?.toLowerCase();
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    const at = nextTimeInZone(hour, minute, m[4], now);
    if (at) return new Date(at.getTime() + LIMIT_MARGIN_MS);
  }
  return new Date(now.getTime() + DEFAULT_LIMIT_WAIT_MS);
}

/** タイムゾーン tz（省略時はこの PC）で、now の後に来る最初の hour:minute */
function nextTimeInZone(
  hour: number,
  minute: number,
  tz: string | undefined,
  now: Date,
): Date | undefined {
  let offsetMs: number;
  try {
    offsetMs = zoneOffsetMs(tz, now);
  } catch {
    return undefined;
  }
  const local = new Date(now.getTime() + offsetMs); // tz での時刻を UTC の欄に置いたもの
  const candidate = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
    hour,
    minute,
  );
  let at = candidate - offsetMs;
  if (at <= now.getTime()) at += 24 * 60 * 60 * 1000;
  return new Date(at);
}

function zoneOffsetMs(tz: string | undefined, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** 利用上限で待つ回数の上限（無限に待ち続けないため） */
const MAX_LIMIT_WAITS = 10;

export async function runRole<S extends z.ZodType>(
  run: RoleRun<S>,
  deps: ClaudeDeps,
): Promise<RoleResult<z.infer<S>>> {
  const dir = await mkdtemp(join(tmpdir(), "conductor-role-"));
  const systemPromptFile = join(dir, `${run.role}.md`);
  try {
    await writeFile(systemPromptFile, run.systemPrompt, "utf8");
    const args = buildArgs(run, systemPromptFile);
    for (let waits = 0; ; waits++) {
      const res = await deps.exec(args, {
        cwd: run.cwd,
        input: run.prompt,
        ...(run.timeoutMs !== undefined && { timeoutMs: run.timeoutMs }),
      });
      const limitText = `${res.stdout}\n${res.stderr}`;
      const parsed = parseCliResult(res.stdout);
      const failed = res.code !== 0 || !parsed || parsed.is_error;
      if (failed) {
        const resumeAt =
          detectLimit(parsed?.result ?? limitText, deps.now()) ??
          (parsed && String(parsed.api_error_status) === "429"
            ? new Date(deps.now().getTime() + DEFAULT_LIMIT_WAIT_MS)
            : undefined);
        if (resumeAt) {
          if (waits >= MAX_LIMIT_WAITS) {
            throw new RoleError(run.role, "利用上限の待機が続いたので止めます");
          }
          await deps.onLimit?.({
            role: run.role,
            resumeAt,
            message: (parsed?.result ?? limitText).trim(),
          });
          await deps.sleep(
            Math.max(0, resumeAt.getTime() - deps.now().getTime()),
          );
          continue;
        }
        throw new RoleError(
          run.role,
          `claude の実行に失敗しました（終了コード ${String(res.code)}）`,
          (parsed?.result ?? `${res.stderr}\n${res.stdout}`).trim(),
        );
      }
      const output = run.schema.safeParse(parsed.structured_output);
      if (!output.success) {
        throw new RoleError(
          run.role,
          "結果が決めた形になっていません",
          `${z.prettifyError(output.error)}\n${JSON.stringify(parsed.structured_output)}`,
        );
      }
      return {
        output: output.data,
        denials: parsed.permission_denials.map((d) => ({
          tool: d.tool_name,
          input: d.tool_input,
        })),
        costUsd: parsed.total_cost_usd,
        turns: parsed.num_turns,
        sessionId: parsed.session_id,
      };
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function parseCliResult(stdout: string) {
  // 出力の最後の JSON 行を結果とみなす
  const lines = stdout.trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    try {
      const r = cliResultSchema.safeParse(JSON.parse(line));
      if (r.success) return r.data;
    } catch {
      // 次の行へ
    }
  }
  return undefined;
}

/** 本物の claude を子プロセスで起動する */
export function claudeExec(command = "claude"): Exec {
  return commandExec(command);
}

export const realDeps = (onLimit?: ClaudeDeps["onLimit"]): ClaudeDeps => ({
  exec: claudeExec(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => new Date(),
  ...(onLimit && { onLimit }),
});
