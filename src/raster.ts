import type { PixelExplain, RasterResult, TriExplain, TriInput } from "./types.ts";

/**
 * 核心光栅化器。
 *
 * 约定：
 * - 画布原点左上，x 向右，y 向下；像素 (x,y) 的采样点为其中心 (x+0.5, y+0.5)。
 * - 所有坐标放大 2 倍变为整数：顶点 (2vx,2vy)，采样点 (2x+1,2y+1)，
 *   边函数全部用整数精确计算，不使用任何 epsilon。
 * - 边函数 E(a,b,p) = (bx-ax)*(py-ay) - (by-ay)*(px-ax)。
 *   顶点绕序统一规范化为 area2 = E(v0,v1,v2) > 0（即内部点三条边均 >= 0）。
 * - top-left 规则：方向为 (dx,dy) 的边是“纳入边”当且仅当
 *   dy > 0 或 (dy == 0 且 dx < 0)。共享边在两个相邻三角形中方向相反，
 *   该谓词对 (dx,dy) 与 (-dx,-dy) 恰好一个为真，因此边上的像素中心
 *   恰好归属一侧：无重叠、无裂缝。
 * - 深度：值小者胜；深度相等时三角形编号小者胜（与输入顺序无关）。
 */

interface NormTri {
  id: number;
  color: [number, number, number];
  depth: number;
  /** 放大 2 倍后的顶点，已规范化为 area2 > 0。 */
  x: [number, number, number];
  y: [number, number, number];
  degenerate: boolean;
}

function edge(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}

/** top-left 纳入边判定（对反向边恰好互斥）。 */
function isTopLeft(dx: number, dy: number): boolean {
  return dy > 0 || (dy === 0 && dx < 0);
}

function normalize(t: TriInput): NormTri {
  const xs: [number, number, number] = [2 * t.vertices[0][0], 2 * t.vertices[1][0], 2 * t.vertices[2][0]];
  const ys: [number, number, number] = [2 * t.vertices[0][1], 2 * t.vertices[1][1], 2 * t.vertices[2][1]];
  const area2 = edge(xs[0], ys[0], xs[1], ys[1], xs[2], ys[2]);
  if (area2 === 0) {
    return { id: t.id, color: t.color, depth: t.depth, x: xs, y: ys, degenerate: true };
  }
  if (area2 < 0) {
    // 交换 v1/v2，使内部点三条边均 >= 0；顺时针/逆时针输入得到一致结果。
    [xs[1], xs[2]] = [xs[2], xs[1]];
    [ys[1], ys[2]] = [ys[2], ys[1]];
  }
  return { id: t.id, color: t.color, depth: t.depth, x: xs, y: ys, degenerate: false };
}

/** 像素中心是否被规范化后的三角形覆盖（含 top-left 规则）。 */
function covers(t: NormTri, px: number, py: number): { covered: boolean; edges: { value: number; isTopLeft: boolean; excluded: boolean }[] } {
  const edges = [];
  let covered = true;
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    const value = edge(t.x[i], t.y[i], t.x[j], t.y[j], px, py);
    const tl = isTopLeft(t.x[j] - t.x[i], t.y[j] - t.y[i]);
    const excluded = value < 0 || (value === 0 && !tl);
    edges.push({ value, isTopLeft: tl, excluded });
    if (excluded) covered = false;
  }
  return { covered, edges };
}

/** 深度竞争：深度小者胜，深度相等时编号小者胜。 */
function wins(depth: number, id: number, curDepth: number, curId: number): boolean {
  if (depth !== curDepth) return depth < curDepth;
  return id < curId;
}

export function rasterize(width: number, height: number, triangles: TriInput[]): RasterResult {
  const n = width * height;
  const winner = new Int32Array(n).fill(-1);
  const depthBuf = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
  const color = new Uint8Array(n * 3);
  const perTriangle: Record<number, number> = {};
  const degenerateTriangles: number[] = [];

  // 按编号排序处理，保证结果与输入顺序无关。
  const tris = triangles.map(normalize).sort((a, b) => a.id - b.id);

  for (const t of tris) {
    if (t.degenerate) {
      degenerateTriangles.push(t.id);
      perTriangle[t.id] = 0;
      continue;
    }
    // 遍历范围裁到画布内；覆盖判断仍用原始（放大后）顶点。
    const minX = Math.max(0, Math.floor((Math.min(t.x[0], t.x[1], t.x[2]) - 1) / 2));
    const maxX = Math.min(width - 1, Math.floor((Math.max(t.x[0], t.x[1], t.x[2]) - 1) / 2));
    const minY = Math.max(0, Math.floor((Math.min(t.y[0], t.y[1], t.y[2]) - 1) / 2));
    const maxY = Math.min(height - 1, Math.floor((Math.max(t.y[0], t.y[1], t.y[2]) - 1) / 2));
    let count = 0;
    for (let y = minY; y <= maxY; y++) {
      const py = 2 * y + 1;
      for (let x = minX; x <= maxX; x++) {
        const px = 2 * x + 1;
        if (!covers(t, px, py).covered) continue;
        const idx = y * width + x;
        if (winner[idx] === -1 || wins(t.depth, t.id, depthBuf[idx], winner[idx])) {
          winner[idx] = t.id;
          depthBuf[idx] = t.depth;
          color[idx * 3] = t.color[0];
          color[idx * 3 + 1] = t.color[1];
          color[idx * 3 + 2] = t.color[2];
        }
        count++; // 覆盖计数（含被遮挡），用于掩码与统计
      }
    }
    perTriangle[t.id] = count;
  }

  let coveredPixels = 0;
  for (let i = 0; i < n; i++) if (winner[i] !== -1) coveredPixels++;

  return {
    width,
    height,
    winner,
    depth: depthBuf,
    color,
    stats: {
      width,
      height,
      totalPixels: n,
      coveredPixels,
      backgroundPixels: n - coveredPixels,
      perTriangle,
      degenerateTriangles,
    },
  };
}

/** 单个三角形的覆盖掩码（不考虑遮挡），行优先 0/1。 */
export function triangleMask(width: number, height: number, tri: TriInput): Uint8Array {
  const t = normalize(tri);
  const mask = new Uint8Array(width * height);
  if (t.degenerate) return mask;
  const minX = Math.max(0, Math.floor((Math.min(t.x[0], t.x[1], t.x[2]) - 1) / 2));
  const maxX = Math.min(width - 1, Math.floor((Math.max(t.x[0], t.x[1], t.x[2]) - 1) / 2));
  const minY = Math.max(0, Math.floor((Math.min(t.y[0], t.y[1], t.y[2]) - 1) / 2));
  const maxY = Math.min(height - 1, Math.floor((Math.max(t.y[0], t.y[1], t.y[2]) - 1) / 2));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (covers(t, 2 * x + 1, 2 * y + 1).covered) mask[y * width + x] = 1;
    }
  }
  return mask;
}

/** 像素级解释：边值、top-left 排除、覆盖候选、深度选择、遮挡原因。 */
export function explainPixel(
  width: number,
  height: number,
  triangles: TriInput[],
  x: number,
  y: number,
): PixelExplain {
  const insideCanvas = x >= 0 && x < width && y >= 0 && y < height;
  const px = 2 * x + 1;
  const py = 2 * y + 1;
  const tris = triangles.map(normalize).sort((a, b) => a.id - b.id);

  const candidates: TriExplain[] = [];
  let winId: number | null = null;
  let winDepth = Number.POSITIVE_INFINITY;
  let winColor: [number, number, number] | null = null;

  for (const t of tris) {
    if (t.degenerate) {
      candidates.push({
        id: t.id, depth: t.depth, degenerate: true, edges: [], covered: false,
        excludedReason: "退化三角形：面积为 0，不产生覆盖", isWinner: false,
      });
      continue;
    }
    const { covered, edges } = covers(t, px, py);
    const edgeDetails = edges.map((e, i) => ({
      edge: [i, (i + 1) % 3] as [number, number],
      value: e.value,
      isTopLeft: e.isTopLeft,
      excludedByRule: e.value === 0 && !e.isTopLeft,
    }));
    let excludedReason: string | null = null;
    if (!covered) {
      const outside = edgeDetails.find((e) => e.value < 0);
      const onExcluded = edgeDetails.find((e) => e.excludedByRule);
      excludedReason = outside
        ? `边 ${outside.edge[0]}->${outside.edge[1]} 边值为负（在三角形外）`
        : onExcluded
          ? `落在边 ${onExcluded.edge[0]}->${onExcluded.edge[1]} 上且该边非 top-left 纳入边，按规则排除`
          : "未覆盖";
    }
    if (covered && (winId === null || wins(t.depth, t.id, winDepth, winId))) {
      winId = t.id;
      winDepth = t.depth;
      winColor = t.color;
    }
    candidates.push({
      id: t.id, depth: t.depth, degenerate: false, edges: edgeDetails, covered,
      excludedReason, isWinner: false,
    });
  }
  const winnerCand = candidates.find((c) => c.covered && c.id === winId);
  if (winnerCand) winnerCand.isWinner = true;

  const coveredAny = candidates.some((c) => c.covered);
  let reason: string;
  if (!insideCanvas) reason = "像素在画布外";
  else if (!coveredAny) reason = "背景：几何上未被任何三角形覆盖";
  else if (winId !== null) {
    const occluded = candidates.filter((c) => c.covered && !c.isWinner);
    reason = occluded.length > 0
      ? `三角形 ${winId} 覆盖并赢得深度竞争；被挡住的候选：${occluded.map((c) => c.id).join(", ")}`
      : `三角形 ${winId} 覆盖该像素且无竞争者`;
  } else reason = "未覆盖";

  return {
    x, y, insideCanvas,
    background: insideCanvas && winId === null,
    winner: winId,
    finalColor: winColor,
    finalDepth: winId === null ? null : winDepth,
    reason,
    candidates,
  };
}
