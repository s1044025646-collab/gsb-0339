/**
 * 坐标约定（RULE_VERSION = "tl-2x-v1"）：
 *
 * - 画布像素 (x, y)：x 向右增大，y 向下增大；像素中心为 (x+0.5, y+0.5)。
 * - 为避免浮点，所有坐标统一放大 2 倍：整数顶点 v -> 2*v；像素中心 -> (2x+1, 2y+1)。
 * - 有向边 e0=(v0->v1), e1=(v1->v2), e2=(v2->v0) 的边函数：
 *       w_i(p) = (p - v_i) cross (v_{i+1} - v_i)
 * - A2 = w0(v2)（放大坐标下为 8 倍面积）。A2>0 为 CCW，A2<0 为 CW。
 *   统一 side = w_i * sign(A2)，覆盖要求 side >= 0，与绕序无关。
 * - Top-Left 共边规则。排除边（边上点不属于本三角形）当且仅当：
 *       Top：dy < 0；Left：dy == 0 且 dx < 0
 *   覆盖判据：side > 0，或 (side == 0 且该边不是排除边)。
 */

export const RULE_VERSION = "tl-2x-v1";
export const MAX_DIMENSION = 4096;
export const MAX_COORD = 1_000_000;
export const MAX_TRIANGLES = 100_000;
export const MAX_ABS_DEPTH = 1e9;

export interface IntPoint {
  x: number;
  y: number;
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface TriangleInput {
  id: number;
  vertices: [IntPoint, IntPoint, IntPoint];
  color: RGB;
  depth: number;
}

export interface SceneInput {
  width: number;
  height: number;
  triangles: TriangleInput[];
}

export interface TriangleDiagnostic {
  id: number;
  code: string;
  message: string;
}

export interface EdgeEval {
  edge: number;
  /** 有向边函数原始值（放大 2 倍坐标系下）。 */
  w: number;
  /** 统一绕序后的值 w * sign(A2)；覆盖需 >= 0。 */
  side: number;
  /** 该边是否为排除边（top/left）。 */
  excluded: boolean;
  /** 像素中心是否恰好落在该边上（side == 0）。 */
  onEdge: boolean;
}

export interface CandidateEval {
  id: number;
  depth: number;
  color: RGB;
  edges: EdgeEval[];
  winner: boolean;
  reason: "depth-loser" | "tie-loser" | null;
}

export interface PixelExplanation {
  x: number;
  y: number;
  covered: boolean;
  winnerId: number | null;
  color: RGB | null;
  depth: number | null;
  candidates: CandidateEval[];
  /** 几何覆盖该像素但最终被遮挡时，指向获胜三角形编号；否则 null。 */
  occludedBy: number | null;
}

export interface RenderStats {
  width: number;
  height: number;
  totalPixels: number;
  coveredPixels: number;
  backgroundPixels: number;
  perTriangleCoverage: Record<string, number>;
}

export interface RenderResult {
  /** 长度 width*height，行优先（y * width + x）；背景为 -1。 */
  winner: Int32Array;
  depth: Float64Array;
  color: Array<RGB | null>;
  stats: RenderStats;
  diagnostics: TriangleDiagnostic[];
}

export class RasterError extends Error {
  readonly code: string;
  readonly details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "RasterError";
    this.code = code;
    this.details = details;
  }
}
