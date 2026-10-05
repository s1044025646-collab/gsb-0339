import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Server } from "node:http";
import { Store } from "./db.ts";
import { rasterize, explainPixel, triangleMask } from "./raster.ts";
import { validateScene, ApiError } from "./validate.ts";
import { COORD_CONVENTION, RULE_VERSION } from "./types.ts";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(data);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError("BAD_JSON", "请求体不是合法 JSON");
  }
}

export function createApp(store: Store): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/") {
        return sendJson(res, 200, { service: "tri-raster", coordConvention: COORD_CONVENTION, ruleVersion: RULE_VERSION });
      }

      // POST /scenes 创建场景
      if (method === "POST" && url.pathname === "/scenes") {
        const scene = validateScene(await readBody(req));
        const id = store.createScene(scene);
        return sendJson(res, 201, { sceneId: id });
      }

      if (method === "GET" && url.pathname === "/scenes") {
        return sendJson(res, 200, { scenes: store.listScenes() });
      }

      if (parts[0] === "scenes" && parts.length >= 2) {
        const sceneId = Number(parts[1]);
        if (!Number.isInteger(sceneId)) throw new ApiError("BAD_ID", "场景 id 非法");
        const scene = store.getScene(sceneId);
        if (!scene) throw new ApiError("NOT_FOUND", `场景 ${sceneId} 不存在`, 404);
        const sub = parts[2];

        // POST /scenes/:id/validate 校验
        if (method === "POST" && sub === "validate") {
          validateScene({ width: scene.width, height: scene.height, triangles: scene.triangles });
          return sendJson(res, 200, { ok: true });
        }

        // POST /scenes/:id/rasterize 执行光栅化（生成新运行）
        if (method === "POST" && sub === "rasterize") {
          const out = store.runRasterize(sceneId, () => rasterize(scene.width, scene.height, scene.triangles));
          const run = store.getRun(out.runId);
          if (out.status !== "completed") return sendJson(res, 500, { code: "RASTER_FAILED", runId: out.runId, error: out.error });
          return sendJson(res, 200, { runId: out.runId, status: out.status, stats: run?.stats });
        }

        // GET /scenes/:id/runs
        if (method === "GET" && sub === "runs") {
          return sendJson(res, 200, { runs: store.listRuns(sceneId) });
        }

        // GET /scenes/:id/pixels?page=&pageSize= 完整矩阵分页
        if (method === "GET" && sub === "pixels") {
          const latest = store.latestCompletedRun(sceneId);
          if (!latest) throw new ApiError("NO_RUN", "尚无完成的光栅化运行", 409);
          const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
          const pageSize = Math.min(100000, Math.max(1, Number(url.searchParams.get("pageSize") ?? 4096)));
          const total = scene.width * scene.height;
          const start = (page - 1) * pageSize;
          const end = Math.min(total, start + pageSize);
          const pixels = [];
          for (let i = start; i < end; i++) {
            const x = i % scene.width;
            const y = Math.floor(i / scene.width);
            const w = latest.result.winner[i];
            pixels.push({
              x, y, covered: w !== -1, triangleId: w === -1 ? null : w,
              color: w === -1 ? null : [latest.result.color[i * 3], latest.result.color[i * 3 + 1], latest.result.color[i * 3 + 2]],
              depth: w === -1 ? null : latest.result.depth[i],
            });
          }
          return sendJson(res, 200, { runId: latest.runId, page, pageSize, totalPixels: total, pixels });
        }

        // GET /scenes/:id/pixel?x=&y= 单像素查询
        if (method === "GET" && sub === "pixel") {
          const latest = store.latestCompletedRun(sceneId);
          if (!latest) throw new ApiError("NO_RUN", "尚无完成的光栅化运行", 409);
          const x = Number(url.searchParams.get("x"));
          const y = Number(url.searchParams.get("y"));
          if (!Number.isInteger(x) || !Number.isInteger(y)) throw new ApiError("BAD_PIXEL", "x/y 必须是整数");
          if (x < 0 || x >= scene.width || y < 0 || y >= scene.height)
            throw new ApiError("BAD_PIXEL", "像素在画布外");
          const i = y * scene.width + x;
          const w = latest.result.winner[i];
          return sendJson(res, 200, {
            runId: latest.runId, x, y, covered: w !== -1, triangleId: w === -1 ? null : w,
            color: w === -1 ? null : [latest.result.color[i * 3], latest.result.color[i * 3 + 1], latest.result.color[i * 3 + 2]],
            depth: w === -1 ? null : latest.result.depth[i],
          });
        }

        // GET /scenes/:id/explain?x=&y= 像素解释（独立端点，与矩阵分页分开）
        if (method === "GET" && sub === "explain") {
          const x = Number(url.searchParams.get("x"));
          const y = Number(url.searchParams.get("y"));
          if (!Number.isInteger(x) || !Number.isInteger(y)) throw new ApiError("BAD_PIXEL", "x/y 必须是整数");
          return sendJson(res, 200, explainPixel(scene.width, scene.height, scene.triangles, x, y));
        }

        // GET /scenes/:id/triangles/:tid/mask 三角形覆盖掩码
        if (method === "GET" && sub === "triangles" && parts[3] !== undefined && parts[4] === "mask") {
          const tid = Number(parts[3]);
          const tri = scene.triangles.find((t) => t.id === tid);
          if (!tri) throw new ApiError("NOT_FOUND", `三角形 ${tid} 不存在`, 404);
          const mask = triangleMask(scene.width, scene.height, tri);
          const rows: string[] = [];
          for (let y = 0; y < scene.height; y++) {
            rows.push(Array.from(mask.subarray(y * scene.width, (y + 1) * scene.width)).join(""));
          }
          return sendJson(res, 200, { triangleId: tid, width: scene.width, height: scene.height, rows });
        }

        // GET /scenes/:id/export 导出颜色矩阵
        if (method === "GET" && sub === "export") {
          const latest = store.latestCompletedRun(sceneId);
          if (!latest) throw new ApiError("NO_RUN", "尚无完成的光栅化运行", 409);
          const r = latest.result;
          const matrix: ([number, number, number] | null)[][] = [];
          for (let y = 0; y < r.height; y++) {
            const row: ([number, number, number] | null)[] = [];
            for (let x = 0; x < r.width; x++) {
              const i = y * r.width + x;
              row.push(r.winner[i] === -1 ? null : [r.color[i * 3], r.color[i * 3 + 1], r.color[i * 3 + 2]]);
            }
            matrix.push(row);
          }
          return sendJson(res, 200, { runId: latest.runId, width: r.width, height: r.height, background: null, colors: matrix });
        }
      }

      throw new ApiError("NOT_FOUND", `未知路由 ${method} ${url.pathname}`, 404);
    } catch (err) {
      if (err instanceof ApiError) return sendJson(res, err.status, { code: err.code, error: err.message });
      return sendJson(res, 500, { code: "INTERNAL", error: err instanceof Error ? err.message : String(err) });
    }
  });
}

/** 启动服务；port 传 0 时选择空闲端口（默认）。 */
export function serve(store: Store, port = 0, host = "127.0.0.1"): Promise<{ server: Server; port: number }> {
  const app = createApp(store);
  return new Promise((resolve) => {
    app.listen(port, host, () => {
      const addr = app.address();
      const p = typeof addr === "object" && addr ? addr.port : port;
      resolve({ server: app, port: p });
    });
  });
}
