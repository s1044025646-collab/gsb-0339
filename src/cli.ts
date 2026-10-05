#!/usr/bin/env node
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { Store } from "./db/db.js";
import { RasterService } from "./core/service.js";
import { parseScene } from "./core/validate.js";
import { rasterize, explainPixel, triangleMask } from "./core/raster.js";
import { RasterError, type SceneInput } from "./core/types.js";
import { writeBmp } from "./core/bmp.js";

const DATA_DIR = join(process.cwd(), "data");

function demoScene(): SceneInput {
  // 10x8 画布，两个三角形沿斜线 x+y=5 拼接。
  return {
    width: 10,
    height: 8,
    triangles: [
      { id: 1, vertices: [{ x: 0, y: 0 }, { x: 0, y: 5 }, { x: 5, y: 0 }], color: { r: 220, g: 60, b: 60 }, depth: 2 },
      { id: 2, vertices: [{ x: 0, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 0 }], color: { r: 60, g: 90, b: 220 }, depth: 1 },
    ],
  };
}

function charGrid(result: ReturnType<typeof rasterize>): string {
  const { width, height } = result.stats;
  const lines: string[] = [];
  for (let y = 0; y < height; y++) {
    let s = "";
    for (let x = 0; x < width; x++) {
      const id = result.winner[y * width + x]!;
      s += id === -1 ? "." : id >= 10 ? String.fromCharCode(87 + id) : String(id);
    }
    lines.push(s);
  }
  return lines.join("\n");
}

function idGrid(result: ReturnType<typeof rasterize>): string {
  const { width, height } = result.stats;
  const lines: string[] = [];
  for (let y = 0; y < height; y++) {
    const cells: string[] = [];
    for (let x = 0; x < width; x++) {
      const id = result.winner[y * width + x];
      cells.push(id === -1 ? " ." : String(id).padStart(2, " "));
    }
    lines.push(cells.join(" "));
  }
  return lines.join("\n");
}

function explainTable(scene: SceneInput, coords: Array<[number, number]>): string {
  const out: string[] = [];
  for (const [x, y] of coords) {
    const e = explainPixel(scene, x, y);
    out.push(`像素 (${x},${y})  中心(${x + 0.5},${y + 0.5})`);
    if (!e.covered) {
      out.push("  几何未覆盖（background），无深度比较。");
      continue;
    }
    for (const c of e.candidates) {
      const ev = c.edges
        .map(
          (ed) =>
            `e${ed.edge}:w=${ed.w},side=${ed.side}` +
            (ed.onEdge ? "(onEdge)" : "") +
            (ed.excluded ? "[排除边]" : "[纳入边]"),
        )
        .join("  ");
      const tag = c.winner ? "★获胜" : c.reason === "tie-loser" ? "等深编号负" : "深度负";
      out.push(`  三角形 ${c.id} depth=${c.depth} ${tag}  ${ev}`);
    }
    if (e.occludedBy !== null) {
      const losers = e.candidates.filter((c) => !c.winner).map((c) => c.id);
      out.push(`  -> 三角形 [${losers.join(",")}] 几何覆盖但被前方三角形 ${e.occludedBy} 挡住。`);
    }
  }
  return out.join("\n");
}

function cmdDemo(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const store = new Store(join(DATA_DIR, "trirast.sqlite"));
  const service = new RasterService(store);

  console.log("=== 演示 1：两三角形沿 x+y=5 斜边拼接（像素中心落在共享边）===");
  const sceneRec = service.createScene(demoScene(), "demo-diagonal");
  const run = service.render(sceneRec.id);
  const scene = sceneRec.payload;
  const result = rasterize(scene);
  console.log("字符网格（. 为背景，数字为获胜三角形编号）：");
  console.log(charGrid(result));
  console.log("\n编号网格：");
  console.log(idGrid(result));
  console.log("\n共享边上的像素解释：");
  console.log(explainTable(scene, [[0, 0], [2, 3], [1, 4], [0, 5]]));
  console.log("\n统计：", run.stats);
  console.log("诊断：", run.diagnostics);
  writeBmp(join(DATA_DIR, "demo1-diagonal.bmp"), result);

  console.log("\n=== 演示 2：部分遮挡 + 相等深度按编号决胜 ===");
  const scene2: SceneInput = {
    width: 6,
    height: 6,
    triangles: [
      { id: 7, vertices: [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 0, y: 6 }], color: { r: 200, g: 200, b: 0 }, depth: 5 },
      { id: 3, vertices: [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 0, y: 6 }], color: { r: 0, g: 180, b: 0 }, depth: 5 },
      { id: 9, vertices: [{ x: 1, y: 1 }, { x: 5, y: 1 }, { x: 1, y: 5 }], color: { r: 0, g: 120, b: 200 }, depth: 2 },
    ],
  };
  const r2 = rasterize(scene2);
  console.log(charGrid(r2));
  console.log(
    explainTable(scene2, [
      [1, 1],
      [0, 0],
      [2, 2],
    ]),
  );

  console.log("\n=== 演示 3：画布外顶点 + 退化三角形诊断 ===");
  const scene3: SceneInput = {
    width: 5,
    height: 5,
    triangles: [
      { id: 4, vertices: [{ x: -3, y: -3 }, { x: 8, y: -1 }, { x: -1, y: 8 }], color: { r: 180, g: 0, b: 180 }, depth: 0 },
      { id: 5, vertices: [{ x: 0, y: 0 }, { x: 4, y: 4 }, { x: 2, y: 2 }], color: { r: 1, g: 1, b: 1 }, depth: 0 },
    ],
  };
  const r3 = rasterize(scene3);
  console.log(charGrid(r3));
  console.log("诊断：", JSON.stringify(r3.diagnostics, null, 2));

  console.log("\n=== 演示 4：单个三角形覆盖掩码（id=1）===");
  const mask = triangleMask(scene, 1);
  for (let y = 0; y < scene.height; y++) {
    console.log(
      Array.from({ length: scene.width }, (_, x) => (mask[y * scene.width + x] ? "#" : ".")).join(""),
    );
  }

  console.log("\n重启后查询（重新打开 SQLite）：");
  const store2 = new Store(join(DATA_DIR, "trirast.sqlite"));
  const px = store2.getPixel(run.id, 2, 3);
  console.log("旧场景像素 (2,3)：", px);
  store2.close();
  store.close();
  console.log(`\n演示完成，数据与 BMP 已写入 ${DATA_DIR}`);
}

async function readJson(path: string): Promise<unknown> {
  const text = await (await import("node:fs/promises")).readFile(path, "utf-8");
  return JSON.parse(text);
}

async function main(): Promise<void> {
  const [, , cmd, ...args] = process.argv;
  try {
    if (cmd === "demo") return cmdDemo();
    if (cmd === "create") {
      const path = args[0];
      if (!path) throw new RasterError("USAGE", "用法: cli create <scene.json> [name]");
      const store = new Store(join(DATA_DIR, "trirast.sqlite"));
      const service = new RasterService(store);
      const scene = service.createScene(await readJson(path), args[1]);
      console.log(JSON.stringify({ id: scene.id, width: scene.width, height: scene.height }, null, 2));
      store.close();
      return;
    }
    if (cmd === "render") {
      const store = new Store(join(DATA_DIR, "trirast.sqlite"));
      const service = new RasterService(store);
      const run = service.render(args[0]!);
      console.log(JSON.stringify({ id: run.id, status: run.status, stats: JSON.parse(run.stats ?? "null") }, null, 2));
      store.close();
      return;
    }
    if (cmd === "grid") {
      const store = new Store(join(DATA_DIR, "trirast.sqlite"));
      const scene = store.getScene(args[0]!);
      if (!scene) throw new RasterError("SCENE_NOT_FOUND", "场景不存在");
      console.log(charGrid(rasterize(scene.payload)));
      store.close();
      return;
    }
    if (cmd === "explain") {
      const [sceneId, xStr, yStr] = args;
      const store = new Store(join(DATA_DIR, "trirast.sqlite"));
      const scene = store.getScene(sceneId!);
      if (!scene) throw new RasterError("SCENE_NOT_FOUND", "场景不存在");
      console.log(explainTable(scene.payload, [[Number(xStr), Number(yStr)]]));
      store.close();
      return;
    }
    if (cmd === "mask") {
      const [sceneId, triId] = args;
      const store = new Store(join(DATA_DIR, "trirast.sqlite"));
      const scene = store.getScene(sceneId!);
      if (!scene) throw new RasterError("SCENE_NOT_FOUND", "场景不存在");
      const mask = triangleMask(scene.payload, Number(triId));
      for (let y = 0; y < scene.height; y++) {
        console.log(Array.from({ length: scene.width }, (_, x) => (mask[y * scene.width + x] ? "#" : ".")).join(""));
      }
      store.close();
      return;
    }
    if (cmd === "export-bmp") {
      const [sceneId, outPath] = args;
      const store = new Store(join(DATA_DIR, "trirast.sqlite"));
      const scene = store.getScene(sceneId!);
      if (!scene) throw new RasterError("SCENE_NOT_FOUND", "场景不存在");
      writeBmp(outPath!, rasterize(scene.payload));
      console.log(`已导出 ${outPath}`);
      store.close();
      return;
    }
    if (cmd === "validate") {
      const scene = parseScene(await readJson(args[0]!));
      console.log(`校验通过：${scene.width}x${scene.height}，${scene.triangles.length} 个三角形`);
      return;
    }
    if (cmd === "list") {
      const store = new Store(join(DATA_DIR, "trirast.sqlite"));
      console.log(JSON.stringify(store.listScenes(), null, 2));
      store.close();
      return;
    }
    console.log(
      [
        "用法: trirast <command> [args]",
        "  demo                     运行内置演示（共边/遮挡/等深/越界/退化）",
        "  create <scene.json> [name]  创建场景并返回 id",
        "  validate <scene.json>    仅校验场景 JSON",
        "  render <sceneId>         执行光栅化并原子保存",
        "  grid <sceneId>           打印字符网格",
        "  explain <sceneId> <x> <y> 像素解释表",
        "  mask <sceneId> <triId>   三角形覆盖掩码",
        "  export-bmp <sceneId> <out.bmp> 导出 24 位 BMP",
        "  list                     列出已保存场景",
      ].join("\n"),
    );
  } catch (err) {
    if (err instanceof RasterError) {
      console.error(`错误 [${err.code}] ${err.message}`);
      if (err.details !== undefined) console.error(JSON.stringify(err.details));
      process.exitCode = 1;
    } else {
      throw err;
    }
  }
}

main();

