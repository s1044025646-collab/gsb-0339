import {
  MAX_ABS_DEPTH,
  MAX_COORD,
  MAX_DIMENSION,
  MAX_TRIANGLES,
  RasterError,
  type IntPoint,
  type RGB,
  type SceneInput,
  type TriangleInput,
} from "./types.js";

function isInt(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n);
}

function isFiniteNum(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function asObject(v: unknown, ctx: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new RasterError("INVALID_SHAPE", `${ctx} 必须是对象`, { got: typeof v });
  }
  return v as Record<string, unknown>;
}

export function parsePoint(v: unknown, ctx: string): IntPoint {
  const o = asObject(v, ctx);
  if (!isInt(o.x) || !isInt(o.y)) {
    throw new RasterError("VERTEX_NOT_INTEGER", `${ctx} 的坐标必须是安全整数`, o);
  }
  if (Math.abs(o.x) > MAX_COORD || Math.abs(o.y) > MAX_COORD) {
    throw new RasterError("COORD_OUT_OF_RANGE", `${ctx} 坐标超出上限 ±${MAX_COORD}`, o);
  }
  return { x: o.x, y: o.y };
}

export function parseColor(v: unknown, ctx: string): RGB {
  const o = asObject(v, ctx);
  for (const k of ["r", "g", "b"] as const) {
    if (!isInt(o[k]) || (o[k] as number) < 0 || (o[k] as number) > 255) {
      throw new RasterError("INVALID_COLOR", `${ctx} 的颜色 ${k} 必须是 0..255 的整数`, o);
    }
  }
  return { r: o.r as number, g: o.g as number, b: o.b as number };
}

export function parseTriangle(v: unknown): TriangleInput {
  const o = asObject(v, "三角形");
  if (!isInt(o.id)) {
    throw new RasterError("INVALID_ID", "三角形 id 必须是安全整数", o.id);
  }
  if (!Array.isArray(o.vertices) || o.vertices.length !== 3) {
    throw new RasterError("INVALID_SHAPE", "三角形 vertices 必须是长度 3 的数组", o.id);
  }
  const vertices = [
    parsePoint(o.vertices[0], `三角形 ${o.id} 顶点0`),
    parsePoint(o.vertices[1], `三角形 ${o.id} 顶点1`),
    parsePoint(o.vertices[2], `三角形 ${o.id} 顶点2`),
  ] as [IntPoint, IntPoint, IntPoint];
  const color = parseColor(o.color, `三角形 ${o.id}`);
  if (!isFiniteNum(o.depth)) {
    throw new RasterError("DEPTH_NOT_FINITE", `三角形 ${o.id} 的 depth 必须是有限数`, o.depth);
  }
  if (Math.abs(o.depth) > MAX_ABS_DEPTH) {
    throw new RasterError("DEPTH_OUT_OF_RANGE", `三角形 ${o.id} 的 depth 超出 ±${MAX_ABS_DEPTH}`, o.depth);
  }
  return { id: o.id, vertices, color, depth: o.depth };
}

/**
 * 解析并校验场景。重复编号 / 非法颜色 / 非有限深度 / 非整数顶点 /
 * 尺寸上限等均抛出明确错误码。退化三角形不报错，留给光栅化阶段出诊断。
 */
export function parseScene(raw: unknown): SceneInput {
  const o = asObject(raw, "场景");
  if (!isInt(o.width) || !isInt(o.height)) {
    throw new RasterError("INVALID_DIMENSION", "width / height 必须是整数");
  }
  if (o.width <= 0 || o.height <= 0) {
    throw new RasterError("INVALID_DIMENSION", "width / height 必须为正", {
      width: o.width,
      height: o.height,
    });
  }
  if (o.width > MAX_DIMENSION || o.height > MAX_DIMENSION) {
    throw new RasterError(
      "DIMENSION_TOO_LARGE",
      `画布边长不得超过 ${MAX_DIMENSION}（防止精度与内存问题）`,
      { width: o.width, height: o.height },
    );
  }
  if (!Array.isArray(o.triangles)) {
    throw new RasterError("INVALID_SHAPE", "triangles 必须是数组");
  }
  if (o.triangles.length > MAX_TRIANGLES) {
    throw new RasterError("TOO_MANY_TRIANGLES", `三角形数量不得超过 ${MAX_TRIANGLES}`);
  }
  const triangles = o.triangles.map(parseTriangle);
  const seen = new Set<number>();
  for (const t of triangles) {
    if (seen.has(t.id)) {
      throw new RasterError("DUPLICATE_TRIANGLE_ID", `三角形编号 ${t.id} 重复`, t.id);
    }
    seen.add(t.id);
  }
  return { width: o.width, height: o.height, triangles };
}
