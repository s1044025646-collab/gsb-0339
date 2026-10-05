import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "./db.ts";
import { rasterize, explainPixel, triangleMask } from "./raster.ts";
import { validateScene, ApiError } from "./validate.ts";
import { serve } from "./server.ts";
import type { RasterResult, SceneInput } from "./types.ts";

const DATA_DIR = join(process.cwd(), "data");
const DB_PATH = process.env.TRI_RASTER_DB ?? join(DATA_DIR, "raster.db");

function printJson(v: unknown): void {
  console.log(JSON.stringify(v, null, 2));
}

/** 字符网格：背景 '.'，三角形用编号字符（>35 用 '#'）。 */
export function charGrid(result: RasterResult): string {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const lines: string[] = [];
  for (let y = 0; y < result.height; y++) {
    let line = "";
    for (let x = 0; x < result.width; x++) {
      const w = result.winner[y * result.width + x];
      line += w === -1 ? "." : w < chars.length ? chars[w] : "#";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

/** 导出 PPM（P6）图片，纯 Node 写文件，不依赖外部图形程序。 */
export function exportPpm(result: RasterResult, path: string): void {
  const header = Buffer.from(`P6\n${result.width} ${result.height}\n255\n`, "ascii");
  writeFileSync(path, Buffer.concat([header, Buffer.from(result.color.buffer, result.color.byteOffset, result.color.byteLength)]));
}

function loadSceneFile(path: string): SceneInput {
  return validateScene(JSON.parse(readFileSync(path, "utf8")));
}

function demoScenes(): Record<string, SceneInput> {
  return {
    // 1. 两个三角形拼成 4x4 整数边界矩形，共享斜边 y=x 穿过像素中心
    rect: {
      name: "rect-split",
      width: 4,
      height: 4,
      triangles: [
        { id: 0, vertices: [[0, 0], [4, 0], [4, 4]], color: [220, 40, 40], depth: 1 },
        { id: 1, vertices: [[0, 0], [0, 4], [4, 4]], color: [40, 40, 220], depth: 1 },
      ],
    },
    // 2. 部分遮挡：近处小三角形挡住远处大三角形
    occlude: {
      name: "occlusion",
      width: 6,
      height: 4,
      triangles: [
        { id: 0, vertices: [[0, 0], [6, 0], [0, 4]], color: [200, 200, 200], depth: 5 },
        { id: 1, vertices: [[1, 1], [4, 1], [1, 3]], color: [40, 200, 40], depth: 2 },
      ],
    },
    // 3. 相等深度：编号小者胜
    equalDepth: {
      name: "equal-depth",
      width: 4,
      height: 4,
      triangles: [
        { id: 5, vertices: [[0, 0], [4, 0], [0, 4]], color: [255, 0, 0], depth: 1 },
        { id: 2, vertices: [[0, 0], [4, 0], [0, 4]], color: [0, 255, 0], depth: 1 },
      ],
    },
    // 4. 画布外顶点 + 退化三角形
    mixed: {
      name: "offcanvas-degenerate",
      width: 4,
      height: 4,
      triangles: [
        { id: 0, vertices: [[-2, -2], [6, 0], [0, 6]], color: [255, 200, 0], depth: 1 },
        { id: 1, vertices: [[1, 1], [2, 2], [3, 3]], color: [0, 0, 0], depth: 0 },
      ],
    },
  };
}

function printExplain(scene: SceneInput, x: number, y: number): void {
  const e = explainPixel(scene.width, scene.height, scene.triangles, x, y);
  console.log(`像素 (${x},${y}) 解释：${e.reason}`);
  for (const c of e.candidates) {
    if (c.degenerate) {
      console.log(`  三角形 ${c.id}: 退化，不产生覆盖`);
      continue;
    }
    const edgeStr = c.edges
      .map((ed) => `E${ed.edge[0]}${ed.edge[1]}=${ed.value}${ed.value === 0 ? (ed.isTopLeft ? "(top-left,纳入)" : "(排除边)") : ""}`)
      .join(" ");
    console.log(`  三角形 ${c.id}: depth=${c.depth} 覆盖=${c.covered}${c.isWinner ? " [胜者]" : ""} ${edgeStr}${c.excludedReason ? " -- " + c.excludedReason : ""}`);
  }
  console.log(`  最终: ${e.winner === null ? "背景(无三角形)" : `三角形 ${e.winner}, 颜色=${JSON.stringify(e.finalColor)}, 深度=${e.finalDepth}`}`);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const store = new Store(DB_PATH);

  try {
    switch (cmd) {
      case "serve": {
        const portArg = args.find((a) => a.startsWith("--port="));
        const port = portArg ? Number(portArg.split("=")[1]) : 0; // 默认空闲端口
        const { port: bound } = await serve(store, port);
        console.log(`API 服务已启动: http://127.0.0.1:${bound}  (数据库: ${DB_PATH})`);
        return; // 保持进程存活
      }

      case "create": {
        const scene = loadSceneFile(args[0]);
        const id = store.createScene(scene);
        console.log(`场景已创建: id=${id}`);
        break;
      }

      case "validate": {
        loadSceneFile(args[0]);
        console.log("校验通过");
        break;
      }

      case "rasterize": {
        const sceneId = Number(args[0]);
        const scene = store.getScene(sceneId);
        if (!scene) throw new ApiError("NOT_FOUND", `场景 ${sceneId} 不存在`, 404);
        const out = store.runRasterize(sceneId, () => rasterize(scene.width, scene.height, scene.triangles));
        if (out.status !== "completed") throw new ApiError("RASTER_FAILED", out.error ?? "光栅化失败", 500);
        const latest = store.latestCompletedRun(sceneId)!;
        console.log(`运行 ${out.runId} 完成。统计:`);
        printJson(latest.result.stats);
        console.log(charGrid(latest.result));
        break;
      }

      case "pixel": {
        const [sceneId, x, y] = args.map(Number);
        const scene = store.getScene(sceneId);
        if (!scene) throw new ApiError("NOT_FOUND", `场景 ${sceneId} 不存在`, 404);
        const latest = store.latestCompletedRun(sceneId);
        if (!latest) throw new ApiError("NO_RUN", "尚无完成的运行", 409);
        const i = y * scene.width + x;
        const w = latest.result.winner[i];
        printJson({ x, y, covered: w !== -1, triangleId: w === -1 ? null : w, depth: w === -1 ? null : latest.result.depth[i] });
        break;
      }

      case "mask": {
        const [sceneId, tid] = args.map(Number);
        const scene = store.getScene(sceneId);
        if (!scene) throw new ApiError("NOT_FOUND", `场景 ${sceneId} 不存在`, 404);
        const tri = scene.triangles.find((t) => t.id === tid);
        if (!tri) throw new ApiError("NOT_FOUND", `三角形 ${tid} 不存在`, 404);
        const mask = triangleMask(scene.width, scene.height, tri);
        for (let y = 0; y < scene.height; y++) {
          console.log(Array.from(mask.subarray(y * scene.width, (y + 1) * scene.width)).join(""));
        }
        break;
      }

      case "explain": {
        const [sceneId, x, y] = args.map(Number);
        const scene = store.getScene(sceneId);
        if (!scene) throw new ApiError("NOT_FOUND", `场景 ${sceneId} 不存在`, 404);
        printExplain(scene, x, y);
        break;
      }

      case "export": {
        const [sceneIdStr, outBase] = args;
        const sceneId = Number(sceneIdStr);
        const scene = store.getScene(sceneId);
        if (!scene) throw new ApiError("NOT_FOUND", `场景 ${sceneId} 不存在`, 404);
        const latest = store.latestCompletedRun(sceneId);
        if (!latest) throw new ApiError("NO_RUN", "尚无完成的运行", 409);
        const jsonPath = `${outBase}.json`;
        const ppmPath = `${outBase}.ppm`;
        writeFileSync(jsonPath, JSON.stringify({ width: scene.width, height: scene.height, winner: Array.from(latest.result.winner), color: Array.from(latest.result.color) }));
        exportPpm(latest.result, ppmPath);
        console.log(`已导出: ${jsonPath}, ${ppmPath}`);
        break;
      }

      case "demo": {
        const scenes = demoScenes();
        for (const [key, scene] of Object.entries(scenes)) {
          console.log(`\n=== 演示: ${key} (${scene.name}) ${scene.width}x${scene.height} ===`);
          const result = rasterize(scene.width, scene.height, scene.triangles);
          console.log(charGrid(result));
          console.log(`覆盖 ${result.stats.coveredPixels}/${result.stats.totalPixels}，逐三角形覆盖: ${JSON.stringify(result.stats.perTriangle)}${result.stats.degenerateTriangles.length ? `，退化: ${result.stats.degenerateTriangles}` : ""}`);
          const id = store.createScene(scene);
          store.runRasterize(id, () => rasterize(scene.width, scene.height, scene.triangles));
          console.log(`(已保存为场景 ${id})`);
        }
        // 共享斜边上的像素中心解释表演示
        console.log("\n=== 解释表演示：rect 场景斜边上的像素 (1,1) ===");
        printExplain(scenes.rect, 1, 1);
        console.log("\n=== 解释表演示：occlude 场景被遮挡像素 (2,1) ===");
        printExplain(scenes.occlude, 2, 1);
        break;
      }

      default:
        console.log(`用法: node src/cli.ts <命令>
  serve [--port=N]     启动 API 服务（默认自动选择空闲端口）
  create <scene.json>  创建场景
  validate <scene.json> 校验场景文件
  rasterize <sceneId>  执行光栅化并打印字符网格
  pixel <sceneId> <x> <y>   查询像素
  mask <sceneId> <triId>    查看三角形覆盖掩码
  explain <sceneId> <x> <y> 解释像素判定
  export <sceneId> <out>    导出 JSON 与 PPM 图片
  demo                 运行全部演示场景`);
    }
  } finally {
    if (cmd !== "serve") store.close();
  }
}

main().catch((err) => {
  if (err instanceof ApiError) {
    console.error(`错误 [${err.code}]: ${err.message}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
