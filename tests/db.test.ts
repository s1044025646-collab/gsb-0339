import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db/db.js";
import { parseScene } from "../src/core/validate.js";
import { RasterService } from "../src/core/service.js";
import { RasterError, MAX_DIMENSION } from "../src/core/types.js";

let dir: string;
let dbPath: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "trirast-"));
  dbPath = join(dir, "test.sqlite");
});

const sceneJson = {
  width: 4,
  height: 4,
  triangles: [
    { id: 1, vertices: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 4 }], color: { r: 255, g: 0, b: 0 }, depth: 1 },
    { id: 2, vertices: [{ x: 1, y: 1 }, { x: 3, y: 1 }, { x: 1, y: 3 }], color: { r: 0, g: 255, b: 0 }, depth: 0 },
  ],
};

test("渲染原子发布并可重启按像素查询", () => {
  let sceneId: string;
  let runId: string;
  {
    const store = new Store(dbPath);
    const service = new RasterService(store);
    const scene = service.createScene(sceneJson, "t");
    sceneId = scene.id;
    const run = service.render(sceneId!);
    runId = run.id;
    assert.equal(run.status, "succeeded");
    const px = store.getPixel(runId!, 0, 0);
    assert.equal(px!.winnerId, 1);
    store.close();
  }
  // 重启
  {
    const store = new Store(dbPath);
    const scene = store.getScene(sceneId!);
    assert.ok(scene);
    const run = store.latestRun(sceneId!);
    assert.equal(run!.id, runId);
    const blocked = store.getPixel(runId!, 1, 1);
    assert.equal(blocked!.winnerId, 2); // depth 0 胜出
    const bg = store.getPixel(runId!, 3, 3);
    assert.equal(bg!.winnerId, null); // 背景无三角形，且不写假深度
    assert.equal(bg!.depth, null);
    assert.equal(bg!.color, null);
    store.close();
  }
});

test("失败不留半成品像素：失败 run 无像素行，成功 run 不受影响", () => {
  const store = new Store(dbPath);
  const service = new RasterService(store);
  const good = service.createScene({ width: 2, height: 2, triangles: [] }, "ok");
  // 用重复 runId 强制在事务中途（INSERT run）失败
  const r1 = store.render(good, "fixed-run-id");
  assert.equal(r1.status, "succeeded");
  assert.throws(() => store.render(good, "fixed-run-id"));
  const run = store.getRun("fixed-run-id");
  assert.equal(run!.status, "succeeded"); // 第二次事务整体回滚，第一次未被破坏
  const n = store.db
    .prepare(`SELECT COUNT(*) AS c FROM pixels WHERE run_id = ?`)
    .get("fixed-run-id") as { c: number };
  assert.equal(n.c, 4);
  // 计算阶段失败：记录 failed run 且无像素
  const badScene = service.createScene({ width: 2, height: 2, triangles: [] }, "bad");
  const orig = store.db.prepare;
  // 模拟像素写入失败：让 INSERT pixels 在事务内抛错
  let toggle = false;
  store.db.prepare = function (this: unknown, sql: string) {
    const stmt = orig.call(this, sql) as { run: (...a: unknown[]) => unknown };
    if (sql.includes("INSERT INTO pixels")) {
      return {
        run: (...a: unknown[]) => {
          if (!toggle) {
            toggle = true;
            throw new Error("disk I/O simulated");
          }
          return stmt.run(...a);
        },
      } as never;
    }
    return stmt as never;
  } as never;
  assert.throws(() => store.render(badScene, "will-fail-run"));
  store.db.prepare = orig;
  const failed = store.getRun("will-fail-run");
  assert.equal(failed!.status, "failed");
  assert.equal(failed!.errorCode, "INTERNAL");
  const c = store.db
    .prepare(`SELECT COUNT(*) AS c FROM pixels WHERE run_id = ?`)
    .get("will-fail-run") as { c: number };
  assert.equal(c.c, 0); // 半幅画面被回滚
  store.close();
});

test("重新渲染生成新 run；修改顶点/深度产生新运行且旧 run 保留", () => {
  const store = new Store(dbPath);
  const service = new RasterService(store);
  const s1 = service.createScene(sceneJson, "v1");
  const run1 = service.render(s1.id);
  const s2 = service.createScene(
    {
      width: 4,
      height: 4,
      triangles: [
        { ...sceneJson.triangles[0], depth: 1 },
        { ...sceneJson.triangles[1], depth: 9 }, // 深度变了
      ],
    },
    "v2",
  );
  const run2 = service.render(s2.id);
  assert.notEqual(run1.id, run2.id);
  // 旧 run 仍可查询
  assert.equal(store.getRun(run1.id)!.status, "succeeded");
  assert.equal(store.getPixel(run2.id, 1, 1)!.winnerId, 1); // 现在 id1 赢
  store.close();
});

test("矩阵分页与解释分离：分页截短不影响渲染数据", () => {
  const store = new Store(dbPath);
  const service = new RasterService(store);
  const scene = service.createScene(sceneJson, "page");
  const run = service.render(scene.id);
  const p1 = store.getPixelPage(run.id, 0, 5);
  const p2 = store.getPixelPage(run.id, 5, 5);
  assert.equal(p1.length, 5);
  assert.equal(p2.length, 5);
  assert.equal(p1[0]!.x, 0);
  assert.equal(p2[0]!.x, 1);
  const ex = store.explain(scene, 1, 1);
  assert.equal(ex.winnerId, 2);
  store.close();
});

test("服务层错误码", () => {
  const store = new Store(dbPath);
  const service = new RasterService(store);
  assert.throws(
    () => service.requireScene("nope"),
    (e: unknown) => e instanceof RasterError && e.code === "SCENE_NOT_FOUND",
  );
  const s = service.createScene({ width: 2, height: 2, triangles: [] }, "empty");
  assert.throws(
    () => service.requireRun(s.id, null),
    (e: unknown) => e instanceof RasterError && e.code === "RUN_NOT_FOUND",
  );
  assert.equal(MAX_DIMENSION, 4096);
  store.close();
});

after(() => {
  // 临时目录由系统清理；仅确保连接关闭
});
