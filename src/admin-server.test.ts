import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AdminInfo,
  type AdminServer,
  assetFile,
  contentType,
  isLocalHost,
  isScreenPath,
  startAdminServer,
  statusEvent,
} from "./admin-server.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const INFO: AdminInfo = { status: "idle", repo: "o/r", project: 1 };
const INDEX = { "index.html": "<p>hi</p>" };

async function serve(files: Record<string, string>): Promise<AdminServer> {
  const dir = await mkdtemp(join(tmpdir(), "conductor-admin-unit-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), body);
  }
  const server = await startAdminServer({
    ...INFO,
    log: () => {},
    assetsDir: dir,
  });
  cleanups.push(() => server.close());
  return server;
}

type Reply = { status: number; body: string };

/** Host ヘッダーを指定して1回要求する（fetch は Host を変えられないため） */
function get(port: number, path: string, host: string): Promise<Reply> {
  const options = { host: "127.0.0.1", port, path, headers: { host } };
  return new Promise((resolve, reject) => {
    const req = request(options, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function statusOf(server: AdminServer, path: string): Promise<number> {
  const res = await fetch(new URL(path, server.url));
  return res.status;
}

describe("isScreenPath", () => {
  it("拡張子の無いパスは画面、ファイルと /api は画面ではない", () => {
    expect(isScreenPath("/")).toBe(true);
    expect(isScreenPath("/tasks/12")).toBe(true);
    expect(isScreenPath("/settings")).toBe(true);
    expect(isScreenPath("/assets/app.js")).toBe(false);
    expect(isScreenPath("/api/events")).toBe(false);
    expect(isScreenPath("/api")).toBe(false);
  });
});

describe("assetFile", () => {
  it("assetsDir の外を指すパスは返さない", () => {
    const dir = join(tmpdir(), "assets-root");
    const want = join(dir, "assets", "app.js");
    expect(assetFile(dir, "/assets/app.js")).toBe(want);
    expect(assetFile(dir, "/../secret.txt")).toBeUndefined();
    expect(assetFile(dir, "/%2e%2e/secret.txt")).toBeUndefined();
    expect(assetFile(dir, "/%E0%A4%A")).toBeUndefined();
    expect(assetFile(dir, "/")).toBeUndefined();
  });
});

describe("contentType", () => {
  it("拡張子からファイルの種類を決める", () => {
    expect(contentType("a.js")).toMatch(/^text\/javascript/);
    expect(contentType("a.CSS")).toMatch(/^text\/css/);
    expect(contentType("a.bin")).toBe("application/octet-stream");
  });
});

describe("isLocalHost", () => {
  it("127.0.0.1 と localhost の、そのポートだけを受け付ける", () => {
    expect(isLocalHost("127.0.0.1:8080", 8080)).toBe(true);
    expect(isLocalHost("localhost:8080", 8080)).toBe(true);
    expect(isLocalHost("evil.example:8080", 8080)).toBe(false);
    expect(isLocalHost("127.0.0.1:9090", 8080)).toBe(false);
    expect(isLocalHost(undefined, 8080)).toBe(false);
  });
});

describe("statusEvent", () => {
  it("data: に稼働状態・リポジトリ・Project を JSON で入れる", () => {
    const want = 'data: {"status":"idle","repo":"o/r","project":1}\n\n';
    expect(statusEvent(INFO)).toBe(want);
  });
});

describe("startAdminServer", () => {
  it("ほかの名前の Host で届いた要求には答えない", async () => {
    const server = await serve(INDEX);
    const ok = await get(server.port, "/", `localhost:${server.port}`);
    expect(ok).toEqual({ status: 200, body: "<p>hi</p>" });
    const ng = await get(server.port, "/", `evil.example:${server.port}`);
    expect(ng.status).toBe(403);
  });

  it("無いファイルと、知らない /api は 404 にする", async () => {
    const server = await serve(INDEX);
    expect(await statusOf(server, "/assets/none.js")).toBe(404);
    expect(await statusOf(server, "/api/none")).toBe(404);
  });

  it("GET と HEAD のほかは受け付けない", async () => {
    const server = await serve(INDEX);
    const post = await fetch(server.url, { method: "POST" });
    expect(post.status).toBe(405);
    const head = await fetch(server.url, { method: "HEAD" });
    expect(head.status).toBe(200);
  });

  it("画面がビルドされていなければ、そのことを示す", async () => {
    const server = await serve({});
    const res = await fetch(server.url);
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("npm run build");
  });

  it("SSE は開いた直後に今の状態を送り、同じ状態では送り直さない", async () => {
    const server = await serve(INDEX);
    const controller = new AbortController();
    cleanups.push(async () => controller.abort());
    const url = new URL("/api/events", server.url);
    const res = await fetch(url, { signal: controller.signal });
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    const first = await reader.read();
    expect(first.value).toBe(statusEvent(INFO));
    server.setStatus("idle");
    server.setStatus("running");
    const second = await reader.read();
    expect(second.value).toBe(statusEvent({ ...INFO, status: "running" }));
  });

  it("閉じたあとは接続できない。2回閉じてもよい", async () => {
    const server = await serve(INDEX);
    await server.close();
    await server.close();
    await expect(fetch(server.url)).rejects.toThrow();
  });
});
