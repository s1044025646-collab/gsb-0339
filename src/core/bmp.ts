import { writeFileSync } from "node:fs";
import type { RenderResult } from "./types.js";

/** 24 位 BMP（自写文件头，不依赖外部图形程序）。背景写黑色。 */
export function writeBmp(path: string, result: RenderResult, background = { r: 0, g: 0, b: 0 }): void {
  const { width, height } = result.stats;
  const rowSize = Math.floor((24 * width + 31) / 32) * 4;
  const pixelArraySize = rowSize * height;
  const fileSize = 54 + pixelArraySize;
  const buf = Buffer.alloc(fileSize);

  buf.write("BM", 0, "ascii");
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(pixelArraySize, 34);

  for (let y = 0; y < height; y++) {
    const srcY = height - 1 - y; // BMP 自下而上
    const rowStart = 54 + y * rowSize;
    for (let x = 0; x < width; x++) {
      const c = result.color[srcY * width + x] ?? background;
      const o = rowStart + x * 3;
      buf.writeUInt8(c.b, o);
      buf.writeUInt8(c.g, o + 1);
      buf.writeUInt8(c.r, o + 2);
    }
  }
  writeFileSync(path, buf);
}
