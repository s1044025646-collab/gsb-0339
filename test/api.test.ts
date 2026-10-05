import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/db.ts";
import { serve } from "../src/server.ts";

const rectScene = {
  name: "api-rect",
  width: 4,
  height: 4,
  triangles: [
    { id: 0, vertices: [[0, 0], [4, 0], [4, 4]], color: [255, 0, 0], depth: 1 },
    { id: 1, vertices: [[0, 0], [0, 4], [4, 4]], color: [0, 0, 255], depth: 1 },
  ],
};

test("API 端到端：创建→光栅化→查像素→解释→导出", async () => {
  const store = new Store(":memory:");
  const { server, port } = await serve(store, 0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const created = await (await fetch(`${base}/scenes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rectScene),
    })).json();
    assert.ok(created.sceneId > 0);
    const sid = created.sceneId;

    const run = await (await fetch(`${base}/scenes/${sid}/rasterize`, { method: "POST" })).json();
    assert.equal(run.status, "completed");
    assert.equal(run.stats.coveredPixels, 16);

    const px = await (await fetch(`${base}/scenes/${sid}/pixel?x=0&y=0`)).json();
    assert.equal(px.covered, true);
    assert.ok(px.triangleId === 0 || px.triangleId === 1);

    const exp = await (await fetch(`${base}/scenes/${sid}/explain?x=1&y=1`)).json();
    assert.equal(exp.candidates.filter((c: { covered: boolean }) => c.covered).length, 1);

    const mask = await (await fetch(`${base}/scenes/${sid}/triangles/0/mask`)).json();
    assert.equal(mask.rows.length, 4);

    const exp2 = await (await fetch(`${base}/scenes/${sid}/export`)).json();
    assert.equal(exp2.colors.length, 4);

    const page = await (await fetch(`${base}/scenes/${sid}/pixels?page=1&pageSize=8`)).json();
    assert.equal(page.pixels.length, 8);
    assert.equal(page.totalPixels, 16);

    // 错误码：重复编号
    const bad = await fetch(`${base}/scenes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...rectScene, triangles: [rectScene.triangles[0], rectScene.triangles[0]] }),
    });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, "DUP_ID");

    // 未光栅化的场景查像素 → 409
    const created2 = await (await fetch(`${base}/scenes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rectScene),
    })).json();
    const noRun = await fetch(`${base}/scenes/${created2.sceneId}/pixel?x=0&y=0`);
    assert.equal(noRun.status, 409);
    assert.equal((await noRun.json()).code, "NO_RUN");
  } finally {
    server.close();
    store.close();
  }
});
