import { test } from "node:test";
import assert from "node:assert/strict";
import { rasterize, explainPixel, triangleMask } from "../src/core/raster.js";
import { parseScene } from "../src/core/validate.js";
import { RasterError, type SceneInput, type TriangleInput } from "../src/core/types.js";

function tri(
  id: number,
  verts: Array<[number, number]>,
  color = { r: 10, g: 20, b: 30 },
  depth = 0,
): TriangleInput {
  return {
    id,
    vertices: verts.map(([x, y]) => ({ x, y })) as TriangleInput["vertices"],
    color,
    depth,
  };
}

function winners(r: ReturnType<typeof rasterize>): number[][] {
  const out: number[][] = [];
  for (let y = 0; y < r.stats.height; y++) {
    const row: number[] = [];
    for (let x = 0; x < r.stats.width; x++) row.push(r.winner[y * r.stats.width + x]!);
    out.push(row);
  }
  return out;
}

test("手列直角三角形像素答案", () => {
  // 三角形 (0,0)(0,5)(5,0)：覆盖 x+y < 4（斜边 x+y=5，中心在线上时 x+y=4，归对侧）
  const scene = parseScene({
    width: 6,
    height: 6,
    triangles: [tri(1, [[0, 0], [0, 5], [5, 0]])],
  });
  const r = rasterize(scene);
  const expected = [
    [1, 1, 1, 1, -1, -1],
    [1, 1, 1, -1, -1, -1],
    [1, 1, -1, -1, -1, -1],
    [1, -1, -1, -1, -1, -1],
    [-1, -1, -1, -1, -1, -1],
    [-1, -1, -1, -1, -1, -1],
  ];
  assert.deepEqual(winners(r), expected);
  assert.equal(r.stats.coveredPixels, 10);
});

test("两三角形拼整数边界矩形：每个内部像素恰好覆盖一次，无重叠无空洞", () => {
  const scene = parseScene({
    width: 5,
    height: 5,
    triangles: [
      tri(1, [[0, 0], [0, 5], [5, 0]], { r: 1, g: 0, b: 0 }, 2),
      tri(2, [[0, 5], [5, 5], [5, 0]], { r: 0, g: 0, b: 1 }, 1),
    ],
  });
  const m1 = triangleMask(scene, 1);
  const m2 = triangleMask(scene, 2);
  let coverCount = 0;
  for (let i = 0; i < 25; i++) {
    // 恰好属于一侧
    assert.equal(m1[i]! + m2[i]!, 1, `像素 ${i} 出现重叠或空洞`);
    coverCount += m1[i]! + m2[i]!;
  }
  assert.equal(coverCount, 25);
  // 共享斜边像素中心 x+y=4 全部且仅属于三角形 2
  for (const [x, y] of [[0, 4], [1, 3], [2, 2], [3, 1], [4, 0]]) {
    assert.equal(m1[y! * 5 + x!], 0);
    assert.equal(m2[y! * 5 + x!], 1);
  }
});

test("反转顶点绕序不改变覆盖掩码", () => {
  const verts: Array<[number, number]> = [[1, 1], [7, 2], [3, 8]];
  const cw = parseScene({ width: 9, height: 9, triangles: [tri(1, verts)] });
  const ccw = parseScene({
    width: 9,
    height: 9,
    triangles: [tri(1, [...verts].reverse())],
  });
  assert.deepEqual(Array.from(triangleMask(cw, 1)), Array.from(triangleMask(ccw, 1)));
});

test("输入三角形重排不改变最终结果", () => {
  const t1 = tri(10, [[0, 0], [8, 0], [0, 8]], { r: 1, g: 0, b: 0 }, 3);
  const t2 = tri(30, [[2, 2], [7, 2], [2, 7]], { r: 0, g: 1, b: 0 }, 1);
  const t3 = tri(20, [[1, 1], [6, 1], [1, 6]], { r: 0, g: 0, b: 1 }, 2);
  const mk = (order: TriangleInput[]): SceneInput => ({
    width: 8,
    height: 8,
    triangles: order,
  });
  const a = rasterize(parseScene(mk([t1, t2, t3])));
  const b = rasterize(parseScene(mk([t3, t1, t2])));
  assert.deepEqual(winners(a), winners(b));
});

test("相等深度按三角形编号决胜，与输入顺序无关", () => {
  const mk = (order: number[]): SceneInput => ({
    width: 4,
    height: 4,
    triangles: order.map((id) =>
      tri(id, [[0, 0], [4, 0], [0, 4]], { r: id, g: 0, b: 0 }, 5),
    ),
  });
  const a = rasterize(parseScene(mk([9, 3])));
  const b = rasterize(parseScene(mk([3, 9])));
  assert.deepEqual(winners(a), winners(b));
  assert.equal(a.winner[0], 3);
  const e = explainPixel(parseScene(mk([9, 3])), 0, 0);
  assert.equal(e.winnerId, 3);
  assert.equal(e.candidates.find((c) => c.id === 9)!.reason, "tie-loser");
});

test("解释能区分几何未覆盖与被遮挡", () => {
  const scene = parseScene({
    width: 6,
    height: 6,
    triangles: [
      tri(1, [[0, 0], [6, 0], [0, 6]], { r: 1, g: 1, b: 1 }, 5),
      tri(2, [[1, 1], [5, 1], [1, 5]], { r: 2, g: 2, b: 2 }, 1),
    ],
  });
  const outside = explainPixel(scene, 5, 5);
  assert.equal(outside.covered, false);
  assert.equal(outside.winnerId, null);
  assert.equal(outside.candidates.length, 0);
  const blocked = explainPixel(scene, 1, 1);
  assert.equal(blocked.winnerId, 2);
  assert.equal(blocked.occludedBy, 2);
  assert.deepEqual(blocked.candidates.map((c) => c.id), [2, 1]);
  assert.equal(blocked.candidates[1]!.reason, "depth-loser");
});

test("退化三角形不覆盖并给诊断", () => {
  const scene = parseScene({
    width: 5,
    height: 5,
    triangles: [
      tri(1, [[0, 0], [4, 4], [2, 2]]),
      tri(2, [[1, 1], [1, 1], [3, 3]]),
    ],
  });
  const r = rasterize(scene);
  assert.equal(r.stats.coveredPixels, 0);
  assert.deepEqual(r.diagnostics.map((d) => d.code), ["DEGENERATE_TRIANGLE", "DEGENERATE_TRIANGLE"]);
});

test("画布外顶点只遍历画布内，判断依据原始顶点", () => {
  const scene = parseScene({
    width: 4,
    height: 4,
    triangles: [tri(1, [[-4, -4], [8, -2], [-2, 8]])],
  });
  const r = rasterize(scene);
  assert.ok(r.stats.coveredPixels > 0);
  assert.ok(r.stats.coveredPixels < 16);
});

test("校验错误码", () => {
  const expectCode = (raw: unknown, code: string) => {
    assert.throws(
      () => parseScene(raw),
      (e: unknown) => e instanceof RasterError && e.code === code,
      `期望错误码 ${code}`,
    );
  };
  expectCode({ width: 0, height: 4, triangles: [] }, "INVALID_DIMENSION");
  expectCode({ width: 5000, height: 4, triangles: [] }, "DIMENSION_TOO_LARGE");
  expectCode(
    { width: 4, height: 4, triangles: [tri(1, [[0.5, 0], [0, 0], [0, 0]])] },
    "VERTEX_NOT_INTEGER",
  );
  expectCode(
    { width: 4, height: 4, triangles: [tri(1, [[2e9, 0], [0, 0], [0, 0]])] },
    "COORD_OUT_OF_RANGE",
  );
  expectCode(
    { width: 4, height: 4, triangles: [{ ...tri(1, [[0, 0], [1, 0], [0, 1]]), color: { r: 300, g: 0, b: 0 } }] },
    "INVALID_COLOR",
  );
  expectCode(
    { width: 4, height: 4, triangles: [{ ...tri(1, [[0, 0], [1, 0], [0, 1]]), depth: NaN }] },
    "DEPTH_NOT_FINITE",
  );
  expectCode(
    {
      width: 4,
      height: 4,
      triangles: [tri(1, [[0, 0], [1, 0], [0, 1]]), tri(1, [[0, 0], [1, 0], [0, 1]])],
    },
    "DUPLICATE_TRIANGLE_ID",
  );
  expectCode({ width: 4, height: 4, triangles: "x" }, "INVALID_SHAPE");
});

test("边界像素：轴对齐共边（含竖直排除边）无重叠无裂缝", () => {
  // 矩形 [0,3]x[0,4] 沿竖直对角线… 改为沿竖直边 x=3 与另一个矩形拼接：
  // 三角形 1: (0,0)(3,0)(3,4)；三角形 2: (0,0)(3,4)(0,4)，共享斜边外的竖直边与画布齐平。
  const scene = parseScene({
    width: 3,
    height: 4,
    triangles: [
      tri(1, [[0, 0], [3, 0], [3, 4]]),
      tri(2, [[0, 0], [3, 4], [0, 4]]),
    ],
  });
  const m1 = triangleMask(scene, 1);
  const m2 = triangleMask(scene, 2);
  for (let i = 0; i < 12; i++) {
    assert.equal(m1[i]! + m2[i]!, 1, `矩形内像素 ${i} 重叠/裂缝`);
  }
  // 共享边为斜边 3y-4x=0；像素中心不落在其上时按符号严格分侧。
  // 额外验证水平共边：两个矩形上下拼接，边界像素中心恰好归一侧。
  const stacked = parseScene({
    width: 4,
    height: 6,
    triangles: [
      // 用退化不出洞：直接用两个矩形（各 2 三角形）沿 y=3 拼接，共 4 个三角形
      tri(1, [[0, 0], [4, 0], [0, 3]]),
      tri(2, [[4, 0], [4, 3], [0, 3]]),
      tri(3, [[0, 3], [4, 3], [0, 6]]),
      tri(4, [[4, 3], [4, 6], [0, 6]]),
    ],
  });
  const masks = [1, 2, 3, 4].map((id) => triangleMask(stacked, id));
  for (let i = 0; i < 24; i++) {
    const sum = masks.reduce((acc, m) => acc + m[i]!, 0);
    assert.equal(sum, 1, `拼接矩形像素 ${i} 重叠/空洞`);
  }
});
