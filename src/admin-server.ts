/**
 * 管理画面の配信。conductor start と同じプロセスから、Node 標準の http で
 * 127.0.0.1 だけで待ち受ける（別の PC からは接続できない）。
 * 画面（web/ を Vite でビルドした dist/admin）をそのまま返し、稼働状態は SSE で push する。
 */
import { readFile, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** 稼働状態（動作中・待機中・停止中） */
export type AdminStatus = "running" | "idle" | "stopped";

export interface AdminServerOptions {
  /** config.github.repo */
  repo: string;
  /** config.github.project */
  project: number;
  /** 起動したときの稼働状態 */
  status: AdminStatus;
  log(text: string): void;
  /** 画面のビルド結果のフォルダ。省略したら同梱のもの（dist/admin） */
  assetsDir?: string;
}

export interface AdminServer {
  /** "http://127.0.0.1:<ポート>/" */
  url: string;
  port: number;
  /** 稼働状態を変える。変わったら開いている画面に SSE で push する */
  setStatus(status: AdminStatus): void;
  close(): Promise<void>;
}

const HOST = "127.0.0.1";
const NOT_BUILT = "管理画面がビルドされていません（npm run build）";

/** 同梱の画面。ビルドすると dist/admin-server.js の隣の dist/admin に入る */
export const DEFAULT_ASSETS_DIR = fileURLToPath(
  new URL("./admin/", import.meta.url),
);

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** ファイルの種類。知らない拡張子は application/octet-stream */
export function contentType(file: string): string {
  const type = CONTENT_TYPES[extname(file).toLowerCase()];
  return type ?? "application/octet-stream";
}

/**
 * 画面の URL か（/、/tasks、/tasks/12、/settings など）。
 * 拡張子の無いパスは画面として index.html を返す（直接開いても再読み込みしても 404 にしない）
 */
export function isScreenPath(pathname: string): boolean {
  if (pathname === "/api" || pathname.startsWith("/api/")) return false;
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  return !last.includes(".");
}

/** assetsDir の中のファイルの場所。assetsDir の外を指すパスなら undefined */
export function assetFile(
  assetsDir: string,
  pathname: string,
): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0")) return undefined;
  const root = resolve(assetsDir);
  const file = resolve(root, `.${decoded}`);
  return file.startsWith(root + sep) ? file : undefined;
}

/**
 * Host ヘッダーが 127.0.0.1 か localhost か。
 * ほかの名前で届いた要求（DNS rebinding など）には答えない
 */
export function isLocalHost(host: string | undefined, port: number): boolean {
  return host === `${HOST}:${port}` || host === `localhost:${port}`;
}

/** 画面に知らせる内容 */
export interface AdminInfo {
  status: AdminStatus;
  repo: string;
  project: number;
}

/** SSE で送る1件（data: に JSON を1行） */
export function statusEvent(info: AdminInfo): string {
  const { status, repo, project } = info;
  return `data: ${JSON.stringify({ status, repo, project })}\n\n`;
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

function sendText(res: ServerResponse, code: number, text: string): void {
  res.writeHead(code, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

async function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
): Promise<void> {
  const body = await readFile(file);
  const html = extname(file).toLowerCase() === ".html";
  res.writeHead(200, {
    "content-type": contentType(file),
    "content-length": body.length,
    // 画面（index.html）は毎回読み直させ、ビルドし直したときに古い画面が残らないようにする
    "cache-control": html ? "no-cache" : "public, max-age=3600",
    "x-content-type-options": "nosniff",
  });
  if (req.method === "HEAD") res.end();
  else res.end(body);
}

export async function startAdminServer(
  options: AdminServerOptions,
): Promise<AdminServer> {
  const assetsDir = options.assetsDir ?? DEFAULT_ASSETS_DIR;
  const { repo, project } = options;
  let status = options.status;
  let port = 0;
  const clients = new Set<ServerResponse>();

  const openEvents = (req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    // 開いた直後に今の状態を1件送る（画面はこれで最初の表示を決める）
    res.write(statusEvent({ status, repo, project }));
    clients.add(res);
    req.on("close", () => clients.delete(res));
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (!isLocalHost(req.headers.host, port)) {
      sendText(res, 403, "Forbidden");
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("allow", "GET, HEAD");
      sendText(res, 405, "Method Not Allowed");
      return;
    }
    const { pathname } = new URL(req.url ?? "/", `http://${HOST}`);
    if (pathname === "/api/events") {
      openEvents(req, res);
      return;
    }
    const file = assetFile(assetsDir, pathname);
    if (file !== undefined && (await isFile(file))) {
      await sendFile(req, res, file);
      return;
    }
    if (isScreenPath(pathname)) {
      const index = join(assetsDir, "index.html");
      if (!(await isFile(index))) {
        sendText(res, 500, NOT_BUILT);
        return;
      }
      await sendFile(req, res, index);
      return;
    }
    sendText(res, 404, "Not Found");
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (res.headersSent) res.end();
      else sendText(res, 500, "Internal Server Error");
    });
  });

  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(0, HOST, () => {
      server.off("error", fail);
      done();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("管理画面のポートを取得できませんでした");
  }
  port = address.port;
  const url = `http://${HOST}:${port}/`;
  options.log(`管理画面: ${url}`);

  let closing: Promise<void> | undefined;
  return {
    url,
    port,
    setStatus(next: AdminStatus) {
      if (next === status) return;
      status = next;
      const event = statusEvent({ status, repo, project });
      for (const res of clients) res.write(event);
    },
    close() {
      closing ??= new Promise<void>((done) => {
        for (const res of clients) res.end();
        clients.clear();
        server.close(() => done());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
