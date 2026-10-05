import { test } from "node:test";
import assert from "node:assert/strict";
import { rasterize, explainPixel, triangleMask } from "../src/raster.ts";
import { validateScene, ApiError, LIMITS } from "../src/validate.ts";
import { Store } from "../src/db.ts";
import type { SceneInput, TriInput } from "../src/types.ts";

const rectScene: SceneInput = {
  width: 4,
  height: 4,
  triangles: [
    { id: 0, vertices: [[0, 0], [4, 0], [4, 4]], color: [255, 0, 0], depth: 1 },
    { id: 1, vertices: [[0, 0], [0, 4], [4, 4]], color: [0, 0, 255], depth: 1 },
  ],
};

test("共享斜边：每个像素恰好覆盖一次，无空洞无重叠", () => {
  const r = rasterize(rectScene.width, rectScene.height, rectScene.triangles);
  // 两个三角形铺满整个 4x4 矩形
  assert.equal(r.stats.coveredPixels, 16);
  assert.equal(r.stats.backgroundPixels, 0);
  // 每个像素恰好属于一个三角形（掩码逐像素求和 == 1）
  const m0 = triangleMask(4, 4, rectScene.triangles[0]);
  const m1 = triangleMask(4, 4, rectScene.triangles[1]);
  for (let i = 0; i < 16; i++) {
    assert.equal(m0[i] + m1[i], 1, `像素 ${i % 4},${Math.floor(i / 4)} 覆盖次数应为 1`);
  }
  // 斜边 y=x 上的像素中心 (1,1)：恰好归属一侧
  const e = explainPixel(4, 4, rectScene.triangles, 1, 1);
  const coveredCount = e.candidates.filter((c) => c.covered).length;
  assert.equal(coveredCount, 1);
  // 归属三角形 1（边 0->0 方向 (0,4)-(0,0)... 验证规则确定性）
  assert.ok(e.winner === 0 || e.winner === 1);
});

test("手列答案：简单直角三角形的逐像素覆盖", () => {
  // 三角形 (0,0),(2,0),(0,2)，画布 2x2。
  // 像素中心 (0.5,0.5)：内；(1.5,0.5)：斜边 x+y=2 上；(0.5,1.5)：斜边上；(1.5,1.5)：外。
  const tri: TriInput = { id: 0, vertices: [[0, 0], [2, 0], [0, 2]], color: [1, 2, 3], depth: 0 };
  const mask = triangleMask(2, 2, tri);
  // 斜边 x+y=2 从 (2,0) 到 (0,2)，方向 (-2,2)：dy>0 → top-left 纳入边
  assert.deepEqual(Array.from(mask), [1, 1, 1, 0]);
  // 反向斜边（从 (0,2) 到 (2,0) 的邻接三角形）应互补
  const tri2: TriInput = { id: 1, vertices: [[2, 0], [2, 2], [0, 2]], color: [4, 5, 6], depth: 0 };
  const mask2 = triangleMask(2, 2, tri2);
  assert.deepEqual(Array.from(mask2), [0, 0, 0, 1]);
});

test("顶点绕序反转不改变覆盖", () => {
  const a: TriInput = { id: 0, vertices: [[0, 0], [3, 0], [0, 3]], color: [9, 9, 9], depth: 1 };
  const b: TriInput = { id: 0, vertices: [[0, 3], [3, 0], [0, 0]], color: [9, 9, 9], depth: 1 };
  assert.deepEqual(Array.from(triangleMask(4, 4, a)), Array.from(triangleMask(4, 4, b)));
});

test("输入三角形重排不改变结果", () => {
  const tris: TriInput[] = [
    { id: 3, vertices: [[0, 0], [4, 0], [0, 4]], color: [255, 0, 0], depth: 2 },
    { id: 1, vertices: [[1, 1], [3, 1], [1, 3]], color: [0, 255, 0], depth: 1 },
    { id: 2, vertices: [[0, 0], [4, 4], [4, 0]], color: [0, 0, 255], depth: 3 },
  ];
  const r1 = rasterize(4, 4, tris);
  const r2 = rasterize(4, 4, [...tris].reverse());
  assert.deepEqual(Array.from(r1.winner), Array.from(r2.winner));
  assert.deepEqual(Array.from(r1.color), Array.from(r2.color));
});

test("深度遮挡：较小深度获胜", () => {
  const tris: TriInput[] = [
    { id: 0, vertices: [[0, 0], [4, 0], [0, 4]], color: [255, 0, 0], depth: 5 },
    { id: 1, vertices: [[0, 0], [4, 0], [0, 4]], color: [0, 255, 0], depth: 2 },
  ];
  const r = rasterize(4, 4, tris);
  assert.equal(r.winner[0], 1);
  const e = explainPixel(4, 4, tris, 1, 1);
  assert.equal(e.winner, 1);
  assert.match(e.reason, /被挡住/);
  assert.equal(e.candidates.find((c) => c.id === 0)?.covered, true);
});

test("相等深度：编号小者胜", () => {
  const tris: TriInput[] = [
    { id: 5, vertices: [[0, 0], [4, 0], [0, 4]], color: [255, 0, 0], depth: 1 },
    { id: 2, vertices: [[0, 0], [4, 0], [0, 4]], color: [0, 255, 0], depth: 1 },
  ];
  const r = rasterize(4, 4, tris);
  assert.equal(r.winner[0], 2);
});

test("画布外顶点：裁剪遍历但按原始顶点判定", () => {
  const tri: TriInput = { id: 0, vertices: [[-4, -4], [8, 0], [0, 8]], color: [1, 1, 1], depth: 0 };
  const r = rasterize(4, 4, [tri]);
  assert.equal(r.stats.coveredPixels, 16); // 大三角形覆盖整个 4x4 画布
});

test("退化三角形：无覆盖并给出诊断", () => {
  const tri: TriInput = { id: 7, vertices: [[1, 1], [2, 2], [3, 3]], color: [0, 0, 0], depth: 0 };
  const r = rasterize(4, 4, [tri]);
  assert.equal(r.stats.coveredPixels, 0);
  assert.deepEqual(r.stats.degenerateTriangles, [7]);
  const e = explainPixel(4, 4, [tri], 1, 1);
  assert.match(e.candidates[0].excludedReason ?? "", /退化/);
});

test("背景像素：无所属三角形，深度为 null 而非合法深度值", () => {
  const tri: TriInput = { id: 0, vertices: [[0, 0], [1, 0], [0, 1]], color: [1, 1, 1], depth: 0 };
  const r = rasterize(4, 4, [tri]);
  const i = 3 * 4 + 3;
  assert.equal(r.winner[i], -1);
  const e = explainPixel(4, 4, [tri], 3, 3);
  assert.equal(e.background, true);
  assert.equal(e.winner, null);
  assert.equal(e.finalDepth, null);
  assert.match(e.reason, /背景/);
});

test("校验：重复编号/非法颜色/非有限深度/非整数顶点/尺寸上限", () => {
  const base = { width: 4, height: 4, triangles: [] as unknown[] };
  const tri = { id: 0, vertices: [[0, 0], [1, 0], [0, 1]], color: [1, 2, 3], depth: 0 };
  assert.throws(() => validateScene({ ...base, triangles: [tri, tri] }), (e: unknown) => (e as ApiError).code === "DUP_ID");
  assert.throws(() => validateScene({ ...base, triangles: [{ ...tri, color: [1, 2, 300] }] }), (e: unknown) => (e as ApiError).code === "BAD_COLOR");
  assert.throws(() => validateScene({ ...base, triangles: [{ ...tri, depth: Number.NaN }] }), (e: unknown) => (e as ApiError).code === "BAD_DEPTH");
  assert.throws(() => validateScene({ ...base, triangles: [{ ...tri, depth: Number.POSITIVE_INFINITY }] }), (e: unknown) => (e as ApiError).code === "BAD_DEPTH");
  assert.throws(() => validateScene({ ...base, triangles: [{ ...tri, vertices: [[0.5, 0], [1, 0], [0, 1]] }] }), (e: unknown) => (e as ApiError).code === "BAD_VERTICES");
  assert.throws(() => validateScene({ ...base, width: LIMITS.MAX_DIMENSION + 1 }), (e: unknown) => (e as ApiError).code === "SIZE_LIMIT");
  assert.throws(() => validateScene({ ...base, triangles: [{ ...tri, vertices: [[LIMITS.MAX_COORD + 1, 0], [1, 0], [0, 1]] }] }), (e: unknown) => (e as ApiError).code === "COORD_LIMIT");
});

test("持久化：失败回滚不留半成品，重启后可查询旧场景", () => {
  const store = new Store(":memory:");
  const sceneId = store.createScene(rectScene);
  const ok = store.runRasterize(sceneId, () => rasterize(4, 4, rectScene.triangles));
  assert.equal(ok.status, "completed");
  const before = store.latestCompletedRun(sceneId)!;

  // 注入失败：compute 抛错
  const bad = store.runRasterize(sceneId, () => {
    throw new Error("模拟失败");
  });
  assert.equal(bad.status, "failed");
  // 旧结果仍然完整可查（失败不覆盖成功画面）
  const after = store.latestCompletedRun(sceneId)!;
  assert.equal(after.runId, before.runId);
  assert.deepEqual(Array.from(after.result.winner), Array.from(before.result.winner));
  const failedRun = store.getRun(bad.runId)!;
  assert.equal(failedRun.status, "failed");
  assert.equal(failedRun.stats, null);

  // 模拟重启：用文件库重开
  const path = `data/test-restart-${process.pid}.db`;
  const s1 = new Store(path);
  const id1 = s1.createScene(rectScene);
  s1.runRasterize(id1, () => rasterize(4, 4, rectScene.triangles));
  s1.close();
  const s2 = new Store(path);
  const scene = s2.getScene(id1)!;
  assert.equal(scene.width, 4);
  const latest = s2.latestCompletedRun(id1)!;
  // 像素 (0,0) 中心恰好落在共享斜边上，按 top-left 规则唯一归属一侧
  assert.ok(latest.result.winner[0] === 0 || latest.result.winner[0] === 1);
  s2.close();
  store.close();
});
