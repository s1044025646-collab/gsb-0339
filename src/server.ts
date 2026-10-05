import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as netCreateServer } from "node:net";
import { join } from "node:path";
import { Store } from "./db/db.js";
import { RasterService } from "./core/service.js";
import { RasterError, RULE_VERSION } from "./core/types.js";

export interface AppContext {
  store: Store;
  service: RasterService;
}

export function createContext(dbPath: string): AppContext {
  const store = new Store(dbPath);
  return { store, service: new RasterService(store) };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(json);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 16 * 1024 * 1024) {
        reject(new RasterError("BODY_TOO_LARGE", "请求体超过 16MB"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf-8");
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new RasterError("INVALID_JSON", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: (
    ctx: AppContext,
    params: Record<string, string>,
    query: URLSearchParams,
    body: unknown,
  ) => { status: number; body: unknown };
}

function route(
  method: string,
  pathTpl: string,
  handler: Route["handler"],
): Route {
  const keys: string[] = [];
  const pattern = new RegExp(
    `^${pathTpl.replace(/:([A-Za-z]+)/g, (_, k: string) => {
      keys.push(k);
      return "([^/]+)";
    })}$`,
  );
  return { method, pattern, keys, handler };
}

function parseIntParam(v: string | null, name: string): number {
  if (v === null || !/^-?\d+$/.test(v)) {
    throw new RasterError("INVALID_QUERY", `查询参数 ${name} 必须是整数`);
  }
  return Number(v);
}

const routes: Route[] = [
  route("GET", "/api/health", () => ({
    status: 200,
    body: { ok: true, ruleVersion: RULE_VERSION },
  })),
  route("POST", "/api/scenes", (ctx, _p, _q, body) => {
    const name =
      body && typeof body === "object" && "name" in body && typeof (body as { name: unknown }).name === "string"
        ? ((body as { name: string }).name)
        : undefined;
    const scene = ctx.service.createScene(body, name);
    return {
      status: 201,
      body: {
        id: scene.id,
        name: scene.name,
        width: scene.width,
        height: scene.height,
        ruleVersion: scene.ruleVersion,
        triangles: scene.payload.triangles.map((t) => t.id),
      },
    };
  }),
  route("GET", "/api/scenes", (ctx) => ({
    status: 200,
    body: { scenes: ctx.store.listScenes() },
  })),
  route("GET", "/api/scenes/:sceneId", (ctx, p) => {
    const s = ctx.service.requireScene(p.sceneId!);
    return {
      status: 200,
      body: {
        id: s.id,
        name: s.name,
        width: s.width,
        height: s.height,
        ruleVersion: s.ruleVersion,
        payload: s.payload,
        createdAt: s.createdAt,
      },
    };
  }),
  route("POST", "/api/scenes/:sceneId/validate", (ctx, p) => {
    const s = ctx.service.requireScene(p.sceneId!);
    return { status: 200, body: { valid: true, triangleCount: s.payload.triangles.length } };
  }),
  route("POST", "/api/scenes/:sceneId/render", (ctx, p) => {
    const run = ctx.service.render(p.sceneId!);
    return {
      status: 201,
      body: {
        id: run.id,
        status: run.status,
        ruleVersion: run.ruleVersion,
        stats: JSON.parse(run.stats ?? "null"),
        diagnostics: JSON.parse(run.diagnostics ?? "[]"),
      },
    };
  }),
  route("GET", "/api/scenes/:sceneId/runs", (ctx, p) => ({
    status: 200,
    body: { runs: ctx.store.listRuns(p.sceneId!) },
  })),
  route("GET", "/api/scenes/:sceneId/runs/:runId", (ctx, p) => {
    const run = ctx.service.requireRun(p.sceneId!, p.runId!);
    return {
      status: 200,
      body: {
        ...run,
        stats: JSON.parse(run.stats ?? "null"),
        diagnostics: JSON.parse(run.diagnostics ?? "[]"),
      },
    };
  }),
  route("GET", "/api/scenes/:sceneId/pixels/:x/:y", (ctx, p, q) => {
    const run = ctx.service.requireRun(p.sceneId!, q.get("runId"));
    const pixel = ctx.store.getPixel(run.id, Number(p.x), Number(p.y));
    return { status: 200, body: pixel };
  }),
  route("GET", "/api/scenes/:sceneId/matrix", (ctx, p, q) => {
    const run = ctx.service.requireRun(p.sceneId!, q.get("runId"));
    const scene = ctx.service.requireScene(p.sceneId!);
    const total = scene.width * scene.height;
    const limit = Math.min(Math.max(parseIntParam(q.get("limit") ?? "512", "limit"), 1), 10000);
    const offset = Math.max(parseIntParam(q.get("offset") ?? "0", "offset"), 0);
    const rows = ctx.store.getPixelPage(run.id, offset, limit);
    return {
      status: 200,
      body: {
        runId: run.id,
        width: scene.width,
        height: scene.height,
        total,
        offset,
        limit,
        hasMore: offset + rows.length < total,
        pixels: rows,
      },
    };
  }),
  route("GET", "/api/scenes/:sceneId/triangles/:triId/mask", (ctx, p) => {
    const triId = parseIntParam(p.triId!, "triId");
    const { mask, width, height } = ctx.service.mask(p.sceneId!, triId);
    const rows: string[] = [];
    for (let y = 0; y < height; y++) {
      let s = "";
      for (let x = 0; x < width; x++) s += mask[y * width + x] ? "1" : "0";
      rows.push(s);
    }
    return { status: 200, body: { triId, width, height, mask: rows } };
  }),
  route("GET", "/api/scenes/:sceneId/explain/:x/:y", (ctx, p) => {
    const scene = ctx.service.requireScene(p.sceneId!);
    const x = parseIntParam(p.x!, "x");
    const y = parseIntParam(p.y!, "y");
    return { status: 200, body: ctx.store.explain(scene, x, y) };
  }),
];

export function createApp(ctx: AppContext): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const body = req.method === "POST" ? await readBody(req) : null;
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.pattern.exec(url.pathname);
        if (!m) continue;
        const params: Record<string, string> = {};
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
        const { status, body: out } = r.handler(ctx, params, url.searchParams, body);
        return send(res, status, out);
      }
      send(res, 404, { error: { code: "NOT_FOUND", message: `无此路由: ${req.method} ${url.pathname}` } });
    } catch (err) {
      if (err instanceof RasterError) {
        const status =
          err.code === "SCENE_NOT_FOUND" || err.code === "TRIANGLE_NOT_FOUND" ||
          err.code === "RUN_NOT_FOUND"
            ? 404
            : 400;
        return send(res, status, { error: { code: err.code, message: err.message, details: err.details ?? null } });
      }
      send(res, 500, {
        error: { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) },
      });
    }
  });
}

/** 请求系统分配空闲端口（端口 0）。 */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = netCreateServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error("无法获取空闲端口"));
      }
    });
  });
}

async function main(): Promise<void> {
  const dbPath = process.env.TRIRAST_DB ?? join(process.cwd(), "data", "trirast.sqlite");
  const ctx = createContext(dbPath);
  const app = createApp(ctx);
  const requested = process.env.PORT ? Number(process.env.PORT) : 0;
  const port = requested > 0 ? requested : await pickFreePort();
  app.listen(port, "127.0.0.1", () => {
    console.log(`[trirast] HTTP API: http://127.0.0.1:${port}`);
    console.log(`[trirast] 数据库: ${dbPath}`);
    console.log(`[trirast] 规则版本: ${RULE_VERSION}`);
  });
}

import { pathToFileURL } from "node:url";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
