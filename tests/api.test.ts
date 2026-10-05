import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, createApp, pickFreePort } from "../src/server.js";
import type { AddressInfo } from "node:net";

let base: string;
let closeServer: () => void;

const sceneBody = {
  name: "api-test",
  width: 4,
  height: 4,
  triangles: [
    { id: 1, vertices: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 4 }], color: { r: 10, g: 20, b: 30 }, depth: 3 },
    { id: 2, vertices: [{ x: 1, y: 1 }, { x: 3, y: 1 }, { x: 1, y: 3 }], color: { r: 40, g: 50, b: 60 }, depth: 1 },
  ],
};

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "trirast-api-"));
  const ctx = createContext(join(dir, "api.sqlite"));
  const app = createApp(ctx);
  const port = await pickFreePort();
  await new Promise<void>((resolve) => app.listen(port, "127.0.0.1", resolve));
  const addr = app.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
  closeServer = () => {
    app.close();
    ctx.store.close();
  };
});

after(() => closeServer());

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

test("健康检查", async () => {
  const r = await api("GET", "/api/health");
  assert.equal(r.status, 200);
  assert.equal(r.json.ruleVersion, "tl-2x-v1");
});

test("创建->校验->渲染->查询像素/矩阵/掩码/解释 全链路", async () => {
  const created = await api("POST", "/api/scenes", sceneBody);
  assert.equal(created.status, 201);
  const sceneId = created.json.id as string;

  const v = await api("POST", `/api/scenes/${sceneId}/validate`);
  assert.equal(v.json.valid, true);

  const rendered = await api("POST", `/api/scenes/${sceneId}/render`);
  assert.equal(rendered.status, 201);
  assert.equal(rendered.json.status, "succeeded");
  const stats = rendered.json.stats as { coveredPixels: number };
  assert.ok(stats.coveredPixels > 0);

  const px = await api("GET", `/api/scenes/${sceneId}/pixels/1/1`);
  assert.equal(px.json.winnerId, 2); // depth 1 胜

  const bg = await api("GET", `/api/scenes/${sceneId}/pixels/3/3`);
  assert.equal(bg.json.winnerId, null);
  assert.equal(bg.json.depth, null);

  const page = await api("GET", `/api/scenes/${sceneId}/matrix?offset=0&limit=5`);
  assert.equal((page.json.pixels as unknown[]).length, 5);
  assert.equal(page.json.hasMore, true);

  const mask = await api("GET", `/api/scenes/${sceneId}/triangles/1/mask`);
  assert.equal((mask.json.mask as string[]).length, 4);

  const ex = await api("GET", `/api/scenes/${sceneId}/explain/1/1`);
  assert.equal(ex.json.winnerId, 2);
  assert.equal(ex.json.occludedBy, 2);
  const loser = (ex.json.candidates as Array<{ reason: string | null }>).find(
    (c) => c.reason !== null,
  );
  assert.equal(loser!.reason, "depth-loser");

  const runs = await api("GET", `/api/scenes/${sceneId}/runs`);
  assert.equal((runs.json.runs as unknown[]).length, 1);
});

test("错误码与 HTTP 状态", async () => {
  const dup = await api("POST", "/api/scenes", {
    width: 4,
    height: 4,
    triangles: [
      sceneBody.triangles[0],
      sceneBody.triangles[0],
    ],
  });
  assert.equal(dup.status, 400);
  assert.equal((dup.json.error as { code: string }).code, "DUPLICATE_TRIANGLE_ID");

  const badColor = await api("POST", "/api/scenes", {
    width: 4,
    height: 4,
    triangles: [{ ...sceneBody.triangles[0], color: { r: 999, g: 0, b: 0 } }],
  });
  assert.equal((badColor.json.error as { code: string }).code, "INVALID_COLOR");

  const missing = await api("GET", "/api/scenes/nonexistent");
  assert.equal(missing.status, 404);
  assert.equal((missing.json.error as { code: string }).code, "SCENE_NOT_FOUND");

  const noRun = await api("POST", "/api/scenes");
  assert.equal(noRun.status, 400); // 空体
});
