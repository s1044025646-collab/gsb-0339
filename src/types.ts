/** 共享类型与常量。坐标约定：画布原点在左上角，x 向右，y 向下（屏幕坐标）。 */
export const COORD_CONVENTION = "origin=top-left, x=right, y=down, sample=pixel-center";
export const RULE_VERSION = "top-left-v1";

export interface TriInput {
  id: number;
  vertices: [[number, number], [number, number], [number, number]];
  color: [number, number, number];
  depth: number;
}

export interface SceneInput {
  name?: string;
  width: number;
  height: number;
  triangles: TriInput[];
}

export interface EdgeDetail {
  edge: [number, number];
  value: number;
  isTopLeft: boolean;
  excludedByRule: boolean;
}

export interface TriExplain {
  id: number;
  depth: number;
  degenerate: boolean;
  edges: EdgeDetail[];
  covered: boolean;
  excludedReason: string | null;
  isWinner: boolean;
}

export interface PixelExplain {
  x: number;
  y: number;
  insideCanvas: boolean;
  background: boolean;
  winner: number | null;
  finalColor: [number, number, number] | null;
  finalDepth: number | null;
  reason: string;
  candidates: TriExplain[];
}

export interface RasterStats {
  width: number;
  height: number;
  totalPixels: number;
  coveredPixels: number;
  backgroundPixels: number;
  perTriangle: Record<number, number>;
  degenerateTriangles: number[];
}

export interface RasterResult {
  width: number;
  height: number;
  /** 行优先，长度 width*height；-1 表示背景（无所属三角形）。 */
  winner: Int32Array;
  depth: Float64Array;
  color: Uint8Array;
  stats: RasterStats;
}
