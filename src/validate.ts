import type { SceneInput, TriInput } from "./types.ts";

/** 资源与精度限制：放大 2 倍后乘积需远小于 2^53，且防止巨大内存分配。 */
export const LIMITS = {
  MAX_DIMENSION: 2048,
  MAX_PIXELS: 4_000_000,
  MAX_COORD: 1_000_000,
  MAX_TRIANGLES: 10_000,
};

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status: number = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function fail(code: string, msg: string): never {
  throw new ApiError(code, msg);
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

export function validateScene(input: unknown): SceneInput {
  if (typeof input !== "object" || input === null) fail("BAD_SCENE", "场景必须是对象");
  const s = input as Record<string, unknown>;

  if (!isInt(s.width) || !isInt(s.height)) fail("BAD_SIZE", "width/height 必须是整数");
  const width = s.width as number;
  const height = s.height as number;
  if (width <= 0 || height <= 0) fail("BAD_SIZE", "width/height 必须为正");
  if (width > LIMITS.MAX_DIMENSION || height > LIMITS.MAX_DIMENSION)
    fail("SIZE_LIMIT", `画布边长超过上限 ${LIMITS.MAX_DIMENSION}`);
  if (width * height > LIMITS.MAX_PIXELS)
    fail("SIZE_LIMIT", `画布像素总数超过上限 ${LIMITS.MAX_PIXELS}`);

  if (!Array.isArray(s.triangles)) fail("BAD_TRIANGLES", "triangles 必须是数组");
  if (s.triangles.length > LIMITS.MAX_TRIANGLES)
    fail("SIZE_LIMIT", `三角形数量超过上限 ${LIMITS.MAX_TRIANGLES}`);

  const seen = new Set<number>();
  const triangles: TriInput[] = s.triangles.map((raw, i) => {
    if (typeof raw !== "object" || raw === null) fail("BAD_TRIANGLE", `三角形 #${i} 必须是对象`);
    const t = raw as Record<string, unknown>;

    if (!isInt(t.id)) fail("BAD_ID", `三角形 #${i} 的 id 必须是非负整数`);
    const id = t.id as number;
    if (id < 0) fail("BAD_ID", `三角形 #${i} 的 id 必须是非负整数`);
    if (seen.has(id)) fail("DUP_ID", `三角形编号 ${id} 重复`);
    seen.add(id);

    if (!Array.isArray(t.vertices) || t.vertices.length !== 3)
      fail("BAD_VERTICES", `三角形 ${id} 需要 3 个顶点`);
    const vertices = t.vertices.map((v, k) => {
      if (!Array.isArray(v) || v.length !== 2 || !isInt(v[0]) || !isInt(v[1]))
        fail("BAD_VERTICES", `三角形 ${id} 顶点 ${k} 必须是整数坐标对`);
      const [vx, vy] = v as [number, number];
      if (Math.abs(vx) > LIMITS.MAX_COORD || Math.abs(vy) > LIMITS.MAX_COORD)
        fail("COORD_LIMIT", `三角形 ${id} 顶点坐标超过 ±${LIMITS.MAX_COORD}`);
      return [vx, vy] as [number, number];
    }) as [[number, number], [number, number], [number, number]];

    if (!Array.isArray(t.color) || t.color.length !== 3 ||
        !t.color.every((c) => isInt(c) && (c as number) >= 0 && (c as number) <= 255))
      fail("BAD_COLOR", `三角形 ${id} 的 color 必须是 0-255 的 RGB 整数三元组`);

    if (typeof t.depth !== "number" || !Number.isFinite(t.depth))
      fail("BAD_DEPTH", `三角形 ${id} 的 depth 必须是有限数值`);

    return { id, vertices, color: t.color as [number, number, number], depth: t.depth };
  });

  return {
    name: typeof s.name === "string" ? s.name : undefined,
    width,
    height,
    triangles,
  };
}
