/** 画面の言語と文言（デザインの辞書 ja・en のうち、共通の枠で使うもの） */
export type Lang = "ja" | "en";

/** 稼働状態（動作中・待機中・停止しています・停止中）。src/admin-server.ts の AdminStatus と同じ */
export type Status = "running" | "idle" | "stopping" | "stopped";

export interface Messages {
  menu: string;
  navDashboard: string;
  navTasks: string;
  navSettings: string;
  runsOn: string;
  project: string;
  language: string;
  restart: string;
  stop: string;
  cancel: string;
  restartTitle: string;
  restartBody: string;
  restartOk: string;
  stopTitle: string;
  stopBody: string;
  stopOk: string;
  toastRestart: string;
  toastStop: string;
  /** 処理中の Issue の欄の「この作業を中断」 */
  abort: string;
  /** 中断のダイアログの確認のボタン */
  abortOk: string;
  /** 中断のダイアログの見出し（{n} は Issue の番号） */
  abortTitle: string;
  /** 中断のダイアログの本文（{role} は動いている役） */
  abortBody: string;
  /** 動いている役がわからないときの {role} */
  someRole: string;
  /** 中断を受け付けたときの知らせ（{n} は Issue の番号） */
  toastAbort: string;
  stRunning: string;
  stIdle: string;
  stStopping: string;
  stStopped: string;
  blockedTitle: string;
  blockedNote: string;
  blockedReason: string;
  stoppedAt: string;
  openGitHub: string;
  viewDetail: string;
  activeTitle: string;
  elapsed: string;
  progress: string;
  branch: string;
  rejections: string;
  objections: string;
  pausedNote: string;
  emptyTitle: string;
  emptyBody: string;
  statusTitle: string;
  lastChecked: string;
  nextCheck: string;
  interval: string;
  mergeMode: string;
  countsTitle: string;
  all: string;
  searchPh: string;
  colIssue: string;
  colTitle: string;
  colColumn: string;
  colStage: string;
  colRej: string;
  colObj: string;
  colUpdated: string;
  noResults: string;
  merged: string;
  back: string;
  timeline: string;
  sortOrder: string;
  newest: string;
  oldest: string;
  showMore: string;
  showLess: string;
  workingNow: string;
  workingNote: string;
  noTimeline: string;
  // ---- 設定 ----
  settingsSub: string;
  discard: string;
  reviewAndSave: string;
  readonly: string;
  repo: string;
  notify: string;
  notifyHelp: string;
  columns: string;
  columnsHelp: string;
  secLimits: string;
  rejectLimit: string;
  objectLimit: string;
  concurrency: string;
  dflt: string;
  secMerge: string;
  approval: string;
  autoDesc: string;
  humanDesc: string;
  secBehavior: string;
  poll: string;
  pollHelp: string;
  secUnit: string;
  language2: string;
  shots: string;
  shotsHelp: string;
  secCommands: string;
  optional: string;
  required: string;
  secProtected: string;
  protectedHelp: string;
  addGlob: string;
  add: string;
  remove: string;
  added: string;
  none: string;
  secPerms: string;
  permsHelp: string;
  /** 「<役>に操作を追加」の後ろ */
  addPerm: string;
  secDiscord: string;
  useDiscord: string;
  chReq: string;
  chQ: string;
  chNotice: string;
  users: string;
  token: string;
  tokenSet: string;
  tokenUnset: string;
  tokenHelp: string;
  /** トークンが未設定で Discord を使うときの案内。間に環境変数の名前（等幅）を挟む */
  tokenNoticeBefore: string;
  tokenNoticeAfter: string;
  secPrompts: string;
  role: string;
  tabGeneral: string;
  tabCommands: string;
  tabPerms: string;
  tabDiscord: string;
  tabPrompts: string;
  /** タブの誤りの件数の後ろ（例: 「3件の誤り」） */
  tabErr: string;
  tabChanged: string;
  errInt: string;
  errPoll: string;
  errRequired: string;
  errUser: string;
  errMinOne: string;
  chatRemoved: string;
  diffTitle: string;
  diffBody: string;
  diffOk: string;
  /** 保存して PR を作ったときの知らせ（{n} は PR の番号） */
  toastSaved: string;
  /** 保存後の、再起動の案内 */
  postSaveNote: string;
  /** 保存に失敗したとき */
  saveFailed: string;
  /** 指示ファイルが無い役 */
  noPrompts: string;
  /** 指示ファイルの表示のしかた：整形 */
  viewRendered: string;
  /** 指示ファイルの表示のしかた：原文 */
  viewSource: string;
  /** 指示ファイルの表示のしかたのボタンの並び */
  viewMode: string;
  /** 役の結果 */
  results: Readonly<Record<ResultKey, string>>;
  /** 進み具合の段階 */
  stage: Readonly<Record<StageKey, string>>;
  /** 動いている役 */
  roles: Readonly<Record<RoleKey, string>>;
}

/** 進み具合の段階（テスト→実装→CI→レビュー→マージ） */
export const STAGE_KEYS = ["test", "impl", "ci", "review", "merge"] as const;
export type StageKey = (typeof STAGE_KEYS)[number];

/** 役の結果（src/task-detail-data.ts の TimelineResult と同じ） */
export type ResultKey =
  "approved" | "changes" | "objection" | "done" | "failed" | "passed";

/** 動いている役（src/loop.ts の ActiveRole と同じ） */
export type RoleKey =
  | "tester"
  | "implementer"
  | "ci"
  | "reviewer"
  | "merge"
  | "specifier"
  | "decomposer";

export const MESSAGES: Readonly<Record<Lang, Messages>> = {
  ja: {
    menu: "メニュー",
    navDashboard: "ダッシュボード",
    navTasks: "タスク一覧",
    navSettings: "設定",
    runsOn: "この PC で動作中（localhost）",
    project: "Project",
    language: "言語",
    restart: "再起動",
    stop: "停止",
    cancel: "キャンセル",
    restartTitle: "conductor を再起動しますか？",
    restartBody:
      "動作中の役はいったん止まります。設定の変更は再起動のあとに反映されます。",
    restartOk: "再起動する",
    stopTitle: "conductor を停止しますか？",
    stopBody:
      "GitHub の確認と役の実行を止めます。再開するには「再起動」を押してください。",
    stopOk: "停止する",
    toastRestart: "再起動しました",
    toastStop: "停止しました",
    abort: "この作業を中断",
    abortOk: "中断する",
    abortTitle: "#{n} の作業を中断しますか？",
    abortBody: "動作中の{role}を止め、Issue を Blocked 列に移します。",
    someRole: "役",
    toastAbort: "#{n} の作業を中断しました",
    stRunning: "動作中",
    stIdle: "待機中",
    stStopping: "停止しています",
    stStopped: "停止中",
    blockedTitle: "人の判断を待っています",
    blockedNote: "GitHub で内容を確認して判断してください",
    blockedReason: "止まった理由",
    stoppedAt: "止まった日時",
    openGitHub: "GitHub で開く",
    viewDetail: "詳細を見る",
    activeTitle: "処理中の Issue",
    elapsed: "経過",
    progress: "進み具合",
    branch: "ブランチ",
    rejections: "差し戻し",
    objections: "異議",
    pausedNote:
      "conductor を停止しているため、この作業は止まっています。再起動すると続きから動きます。",
    emptyTitle: "Ready の Issue を待っています",
    emptyBody:
      "GitHub Projects の「Ready」列に Issue を移すと、ここで処理が始まります。",
    statusTitle: "稼働状況",
    lastChecked: "最後に GitHub を確認",
    nextCheck: "次の確認まで",
    interval: "確認の間隔",
    mergeMode: "マージ",
    countsTitle: "列ごとの件数",
    all: "すべて",
    searchPh: "番号・タイトルで検索",
    colIssue: "Issue",
    colTitle: "タイトル",
    colColumn: "列",
    colStage: "途中の段階",
    colRej: "差し戻し",
    colObj: "異議",
    colUpdated: "更新日時",
    noResults: "該当する Issue はありません",
    merged: "マージ済み",
    back: "タスク一覧へ戻る",
    timeline: "経過",
    sortOrder: "並び順",
    newest: "新しい順",
    oldest: "古い順",
    showMore: "続きを表示",
    showLess: "折りたたむ",
    workingNow: "作業中",
    workingNote: "作業中の出力は表示しません。終わると結果がここに並びます。",
    noTimeline: "まだ経過はありません。",
    settingsSub:
      "対象リポジトリの .conductor/config.yaml を編集します。保存すると変更をコミットして PR を作ります。",
    discard: "変更を取り消す",
    reviewAndSave: "差分を確認して保存",
    readonly: "見るだけ",
    repo: "リポジトリ",
    notify: "Blocked のときに知らせる人",
    notifyHelp: "GitHub ユーザー名",
    columns: "列の名前",
    columnsHelp: "GitHub Projects の列名と合わせます",
    secLimits: "上限とマージ",
    rejectLimit: "差し戻しの上限",
    objectLimit: "異議の上限",
    concurrency: "レビュー役を同時に動かす数",
    dflt: "既定",
    secMerge: "マージ",
    approval: "承認のしかた",
    autoDesc: "レビュー役が承認したらすぐマージ",
    humanDesc: "人が PR にコメントしてからマージ",
    secBehavior: "動作",
    poll: "GitHub を確認する間隔",
    pollHelp: "10 秒以上",
    secUnit: "秒",
    language2: "役が書く文章の言語",
    shots: "画面の撮影を保存するフォルダ",
    shotsHelp: "空なら撮影しません",
    secCommands: "コマンド",
    optional: "任意",
    required: "必須",
    secProtected: "実装役に変えさせないファイル",
    protectedHelp:
      "glob で指定します。実装役はここに当てはまるファイルを変更できません。",
    addGlob: "glob を追加",
    add: "追加",
    remove: "削除",
    added: "追加",
    none: "なし",
    secPerms: "役ごとの追加許可",
    permsHelp:
      "役ごとに、追加で許可する操作を指定します（例: Bash(npm run lint)）",
    addPerm: "に操作を追加",
    secDiscord: "窓口（Discord）",
    useDiscord: "Discord を使う",
    chReq: "要件のチャンネル ID",
    chQ: "質問のチャンネル ID",
    chNotice: "お知らせのチャンネル ID",
    users: "受け付ける人のユーザー ID",
    token: "トークン",
    tokenSet: "設定済み",
    tokenUnset: "未設定",
    tokenHelp: "値は画面に表示しません",
    tokenNoticeBefore: "Discord のトークンが未設定です。環境変数 ",
    tokenNoticeAfter:
      " に設定し、conductor start を起動し直してください（管理画面の「再起動」では反映されません）。",
    secPrompts: "役ごとの指示ファイル",
    role: "役",
    tabGeneral: "基本",
    tabCommands: "コマンドとファイル",
    tabPerms: "役の許可",
    tabDiscord: "窓口（Discord）",
    tabPrompts: "指示ファイル",
    tabErr: "件の誤り",
    tabChanged: "変更あり",
    errInt: "1 以上の整数を入れてください",
    errPoll: "10 以上の整数を入れてください",
    errRequired: "入力してください",
    errUser: "GitHub のユーザー名を入れてください",
    errMinOne: "1件以上必要です",
    chatRemoved: "（まるごと削除）",
    diffTitle: "変更内容の確認",
    diffBody: "次の変更をコミットして PR を作ります。",
    diffOk: "保存して PR を作成",
    toastSaved: "PR #{n} を作りました",
    postSaveNote:
      "PR をマージしてから再起動してください。マージ前に再起動しても反映されません。",
    saveFailed: "保存できませんでした。conductor のログを確認してください。",
    noPrompts: "指示ファイルはありません",
    viewRendered: "整形",
    viewSource: "原文",
    viewMode: "表示のしかた",
    results: {
      approved: "承認",
      changes: "差し戻し",
      objection: "異議",
      done: "完了",
      failed: "失敗",
      passed: "成功",
    },
    stage: {
      test: "テスト",
      impl: "実装",
      ci: "CI",
      review: "レビュー",
      merge: "マージ",
    },
    roles: {
      tester: "テスト役",
      implementer: "実装役",
      ci: "CI",
      reviewer: "レビュー役",
      merge: "マージ",
      specifier: "仕様化役",
      decomposer: "分解役",
    },
  },
  en: {
    menu: "Menu",
    navDashboard: "Dashboard",
    navTasks: "Tasks",
    navSettings: "Settings",
    runsOn: "Running on this machine (localhost)",
    project: "Project",
    language: "Language",
    restart: "Restart",
    stop: "Stop",
    cancel: "Cancel",
    restartTitle: "Restart conductor?",
    restartBody:
      "Any running role will be stopped first. Config changes take effect after the restart.",
    restartOk: "Restart",
    stopTitle: "Stop conductor?",
    stopBody:
      "Polling GitHub and running roles will stop. Press “Restart” to resume.",
    stopOk: "Stop",
    toastRestart: "Restarted",
    toastStop: "Stopped",
    abort: "Abort this run",
    abortOk: "Abort run",
    abortTitle: "Abort the run for #{n}?",
    abortBody:
      "This stops the running {role} and moves the issue to the Blocked column.",
    someRole: "role",
    toastAbort: "Aborted the run for #{n}",
    stRunning: "Running",
    stIdle: "Idle",
    stStopping: "Stopping",
    stStopped: "Stopped",
    blockedTitle: "Waiting for your decision",
    blockedNote: "Review the issue on GitHub and decide how to proceed",
    blockedReason: "Why it stopped",
    stoppedAt: "Blocked at",
    openGitHub: "Open on GitHub",
    viewDetail: "View details",
    activeTitle: "In progress",
    elapsed: "Elapsed",
    progress: "Progress",
    branch: "Branch",
    rejections: "Rejections",
    objections: "Objections",
    pausedNote:
      "conductor is stopped, so this run is paused. It resumes from here after a restart.",
    emptyTitle: "Waiting for a Ready issue",
    emptyBody:
      "Move an issue to the “Ready” column in GitHub Projects and conductor will pick it up here.",
    statusTitle: "Status",
    lastChecked: "Last checked GitHub",
    nextCheck: "Next check in",
    interval: "Poll interval",
    mergeMode: "Merge",
    countsTitle: "Issues by column",
    all: "All",
    searchPh: "Search by number or title",
    colIssue: "Issue",
    colTitle: "Title",
    colColumn: "Column",
    colStage: "Current stage",
    colRej: "Rejections",
    colObj: "Objections",
    colUpdated: "Updated",
    noResults: "No matching issues",
    merged: "Merged",
    back: "Back to tasks",
    timeline: "Timeline",
    sortOrder: "Sort order",
    newest: "Newest first",
    oldest: "Oldest first",
    showMore: "Show more",
    showLess: "Show less",
    workingNow: "Working",
    workingNote:
      "Output from a running role is not shown. Its result appears here when it finishes.",
    noTimeline: "Nothing has happened yet.",
    settingsSub:
      "Edit .conductor/config.yaml in the target repository. Saving commits the change and opens a pull request.",
    discard: "Discard changes",
    reviewAndSave: "Review changes and save",
    readonly: "Read-only",
    repo: "Repository",
    notify: "Notify when an issue is blocked",
    notifyHelp: "GitHub username",
    columns: "Column names",
    columnsHelp: "Must match the column names in GitHub Projects",
    secLimits: "Limits and merge",
    rejectLimit: "Maximum rejections",
    objectLimit: "Maximum objections",
    concurrency: "Reviewers running at the same time",
    dflt: "Default",
    secMerge: "Merge",
    approval: "Approval mode",
    autoDesc: "Merge as soon as the reviewers approve",
    humanDesc: "Merge after a person comments on the PR",
    secBehavior: "Behavior",
    poll: "GitHub poll interval",
    pollHelp: "10 seconds or more",
    secUnit: "seconds",
    language2: "Language roles write in",
    shots: "Screenshot folder",
    shotsHelp: "Leave empty to turn screenshots off",
    secCommands: "Commands",
    optional: "Optional",
    required: "Required",
    secProtected: "Files the implementer must not change",
    protectedHelp:
      "Glob patterns. The implementer cannot modify any file that matches.",
    addGlob: "Add a glob",
    add: "Add",
    remove: "Remove",
    added: "New",
    none: "None",
    secPerms: "Extra permissions per role",
    permsHelp:
      "Additional operations each role is allowed to run (e.g. Bash(npm run lint))",
    addPerm: ": add an operation",
    secDiscord: "Intake (Discord)",
    useDiscord: "Use Discord",
    chReq: "Requirements channel ID",
    chQ: "Questions channel ID",
    chNotice: "Announcements channel ID",
    users: "Allowed user IDs",
    token: "Token",
    tokenSet: "Set",
    tokenUnset: "Not set",
    tokenHelp: "The value is never shown",
    tokenNoticeBefore:
      "The Discord token is not set. Set the environment variable ",
    tokenNoticeAfter:
      " and start conductor start again (the Restart button in this screen does not pick it up).",
    secPrompts: "Role instruction files",
    role: "Role",
    tabGeneral: "General",
    tabCommands: "Commands & files",
    tabPerms: "Role permissions",
    tabDiscord: "Intake (Discord)",
    tabPrompts: "Instruction files",
    tabErr: " errors",
    tabChanged: "Changed",
    errInt: "Enter a whole number of 1 or more",
    errPoll: "Enter a whole number of 10 or more",
    errRequired: "This field is required",
    errUser: "Enter a GitHub username",
    errMinOne: "At least one is required",
    chatRemoved: " (removed entirely)",
    diffTitle: "Review changes",
    diffBody:
      "These changes will be committed and a pull request will be opened.",
    diffOk: "Save and open PR",
    toastSaved: "Opened PR #{n}",
    postSaveNote:
      "Merge the pull request, then restart. Restarting before the merge will not apply the changes.",
    saveFailed: "Could not save. Check the conductor log.",
    noPrompts: "No instruction files",
    viewRendered: "Formatted",
    viewSource: "Source",
    viewMode: "View",
    results: {
      approved: "Approved",
      changes: "Changes requested",
      objection: "Objection",
      done: "Done",
      failed: "Failed",
      passed: "Passed",
    },
    stage: {
      test: "Test",
      impl: "Implement",
      ci: "CI",
      review: "Review",
      merge: "Merge",
    },
    roles: {
      tester: "Tester",
      implementer: "Implementer",
      ci: "CI",
      reviewer: "Reviewer",
      merge: "Merge",
      specifier: "Specifier",
      decomposer: "Decomposer",
    },
  },
};

/** 文言の {名前} を埋める */
export function fill(
  text: string,
  values: Readonly<Record<string, string | number>>,
): string {
  return text.replace(/\{(\w+)\}/g, (all, name: string) => {
    const v = values[name];
    return v === undefined ? all : String(v);
  });
}

/** 稼働状態の文言 */
export function statusLabel(t: Messages, status: Status): string {
  if (status === "running") return t.stRunning;
  if (status === "idle") return t.stIdle;
  if (status === "stopping") return t.stStopping;
  return t.stStopped;
}
