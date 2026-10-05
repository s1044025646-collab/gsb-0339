import {
  RasterError,
  type EdgeEval,
  type PixelExplanation,
  type RenderResult,
  type RGB,
  type SceneInput,
  type TriangleDiagnostic,
  type TriangleInput,
} from "./types.js";

/** 放大 2 倍后的顶点。 */
interface ScaledTri {
  t: TriangleInput;
  /** 放大后顶点 [x0,y0,x1,y1,x2,y2]。 */
  sx: [number, number, number];
  sy: [number, number, number];
  /** sign(A2)：+1 CCW，-1 CW，0 退化。 */
  orient: number;
  /** 有向边增量 (dx,dy)（放大坐标），按 e0,e1,e2。 */
  dx: [number, number, number];
  dy: [number, number, number];
  /** 每条边是否为排除边。 */
  excluded: [boolean, boolean, boolean];
  /** 画布内包围盒（像素闭区间），与画布相交后；退化时 null。 */
  box: { minX: number; maxX: number; minY: number; maxY: number } | null;
}

function scaleTri(t: TriangleInput, width: number, height: number): ScaledTri {
  const sx = [t.vertices[0].x * 2, t.vertices[1].x * 2, t.vertices[2].x * 2] as [
    number,
    number,
    number,
  ];
  const sy = [t.vertices[0].y * 2, t.vertices[1].y * 2, t.vertices[2].y * 2] as [
    number,
    number,
    number,
  ];
  const dx = [sx[1] - sx[0], sx[2] - sx[1], sx[0] - sx[2]] as [number, number, number];
  const dy = [sy[1] - sy[0], sy[2] - sy[1], sy[0] - sy[2]] as [number, number, number];
  // A2 = w0(v2) = (v2-v0) cross (v1-v0)
  const a2 = (sx[2] - sx[0]) * (sy[1] - sy[0]) - (sy[2] - sy[0]) * (sx[1] - sx[0]);
  const orient = a2 > 0 ? 1 : a2 < 0 ? -1 : 0;
  const excluded = dy.map((d, i) => d < 0 || (d === 0 && dx[i]! < 0)) as [
    boolean,
    boolean,
    boolean,
  ];

  let box: ScaledTri["box"] = null;
  if (orient !== 0) {
    const minVx = Math.min(t.vertices[0].x, t.vertices[1].x, t.vertices[2].x);
    const maxVx = Math.max(t.vertices[0].x, t.vertices[1].x, t.vertices[2].x);
    const minVy = Math.min(t.vertices[0].y, t.vertices[1].y, t.vertices[2].y);
    const maxVy = Math.max(t.vertices[0].y, t.vertices[1].y, t.vertices[2].y);
    // 像素中心 x+0.5 落在 [minVx, maxVx] 内：
    //   下界 ceil(minVx - 0.5)，上界 floor(maxVx - 0.5)
    const minX = Math.max(0, Math.ceil(minVx - 0.5));
    const maxX = Math.min(width - 1, Math.floor(maxVx - 0.5));
    const minY = Math.max(0, Math.ceil(minVy - 0.5));
    const maxY = Math.min(height - 1, Math.floor(maxVy - 0.5));
    if (minX <= maxX && minY <= maxY) box = { minX, maxX, minY, maxY };
  }
  return { t, sx, sy, orient, dx, dy, excluded, box };
}

/** 单条边函数：w_i(p) = (px-vix)*dy_i - (py-viy)*dx_i，p 为放大坐标。 */
function edgeW(st: ScaledTri, i: number, px: number, py: number): number {
  return (px - st.sx[i]!) * st.dy[i]! - (py - st.sy[i]!) * st.dx[i]!;
}

export function evalEdges(st: ScaledTri, px: number, py: number): EdgeEval[] {
  const out: EdgeEval[] = [];
  for (let i = 0; i < 3; i++) {
    const w = edgeW(st, i, px, py);
    const side = w * st.orient;
    out.push({ edge: i, w, side, excluded: st.excluded[i]!, onEdge: side === 0 });
  }
  return out;
}

/** 严格按 top-left 规则判定覆盖。 */
export function covers(edges: EdgeEval[]): boolean {
  for (const e of edges) {
    if (e.side < 0) return false;
    if (e.side === 0 && e.excluded) return false;
  }
  return true;
}

/**
 * 深度遮挡选择：较小 depth 获胜；depth 相等时三角形编号（稳定 id，非输入顺序）较小者获胜。
 * 返回 < 0 表示 a 获胜，> 0 表示 b 获胜。
 */
export function depthCmp(a: TriangleInput, b: TriangleInput): number {
  if (a.depth < b.depth) return -1;
  if (a.depth > b.depth) return 1;
  return a.id - b.id;
}

export function rasterize(scene: SceneInput): RenderResult {
  const { width, height, triangles } = scene;
  const n = width * height;
  const winner = new Int32Array(n).fill(-1);
  const depth = new Float64Array(n);
  const color: Array<RGB | null> = new Array(n).fill(null);
  const diagnostics: TriangleDiagnostic[] = [];
  const perTri: Record<string, number> = {};

  const scaled: ScaledTri[] = [];
  for (const t of triangles) {
    const st = scaleTri(t, width, height);
    if (st.orient === 0) {
      diagnostics.push({
        id: t.id,
        code: "DEGENERATE_TRIANGLE",
        message: `三角形 ${t.id} 面积为 0（顶点共线或重合），不产生覆盖`,
      });
      continue;
    }
    scaled.push(st);
    perTri[String(t.id)] = 0;
  }

  let coveredPixels = 0;
  for (const st of scaled) {
    if (!st.box) continue;
    const { minX, maxX, minY, maxY } = st.box;
    for (let y = minY; y <= maxY; y++) {
      const py = 2 * y + 1;
      for (let x = minX; x <= maxX; x++) {
        const px = 2 * x + 1;
        const edges = evalEdges(st, px, py);
        if (!covers(edges)) continue;
        const idx = y * width + x;
        perTri[String(st.t.id)]!++;
        const curId = winner[idx];
        if (curId === -1) {
          winner[idx] = st.t.id;
          depth[idx] = st.t.depth;
          color[idx] = { ...st.t.color };
          coveredPixels++;
        } else {
          const cur = triangles.find((q) => q.id === curId)!;
          if (depthCmp(st.t, cur) < 0) {
            winner[idx] = st.t.id;
            depth[idx] = st.t.depth;
            color[idx] = { ...st.t.color };
          }
        }
      }
    }
  }

  return {
    winner,
    depth,
    color,
    stats: {
      width,
      height,
      totalPixels: n,
      coveredPixels,
      backgroundPixels: n - coveredPixels,
      perTriangleCoverage: perTri,
    },
    diagnostics,
  };
}

/** 单个三角形的覆盖掩码（画布内行优先布尔串），退化三角形返回全 0。 */
export function triangleMask(scene: SceneInput, triId: number): Uint8Array {
  const t = scene.triangles.find((q) => q.id === triId);
  if (!t) throw new RasterError("TRIANGLE_NOT_FOUND", `三角形 ${triId} 不存在`);
  const st = scaleTri(t, scene.width, scene.height);
  const mask = new Uint8Array(scene.width * scene.height);
  if (st.orient === 0 || !st.box) return mask;
  const { minX, maxX, minY, maxY } = st.box;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (covers(evalEdges(st, 2 * x + 1, 2 * y + 1))) {
        mask[y * scene.width + x] = 1;
      }
    }
  }
  return mask;
}

/** 解释单个像素：边值、是否落在排除边、候选、深度选择结果。 */
export function explainPixel(scene: SceneInput, x: number, y: number): PixelExplanation {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 ||
      x >= scene.width || y >= scene.height) {
    throw new RasterError("PIXEL_OUT_OF_RANGE", `像素坐标超出画布 ${scene.width}x${scene.height}`, {
      x,
      y,
    });
  }
  const px = 2 * x + 1;
  const py = 2 * y + 1;
  const cands: PixelExplanation["candidates"] = [];
  for (const t of scene.triangles) {
    const st = scaleTri(t, scene.width, scene.height);
    if (st.orient === 0) continue;
    const edges = evalEdges(st, px, py);
    if (!covers(edges)) continue;
    cands.push({
      id: t.id,
      depth: t.depth,
      color: { ...t.color },
      edges,
      winner: false,
      reason: null,
    });
  }
  // 与光栅化相同的选择规则
  cands.sort((a, b) =>
    a.depth < b.depth ? -1 : a.depth > b.depth ? 1 : a.id - b.id,
  );
  const win = cands[0] ?? null;
  let occludedBy: number | null = null;
  if (win) {
    win.winner = true;
    for (let i = 1; i < cands.length; i++) {
      const c = cands[i]!;
      c.reason = c.depth === win.depth ? "tie-loser" : "depth-loser";
    }
    if (cands.length > 1) occludedBy = win.id;
  }
  return {
    x,
    y,
    covered: win !== null,
    winnerId: win ? win.id : null,
    color: win ? win.color : null,
    depth: win ? win.depth : null,
    candidates: cands,
    occludedBy,
  };
}
