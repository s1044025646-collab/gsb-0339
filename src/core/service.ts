import { randomUUID } from "node:crypto";
import { Store, type StoredScene } from "../db/db.js";
import { parseScene } from "./validate.js";
import { triangleMask } from "./raster.js";
import { RasterError } from "./types.js";

export class RasterService {
  constructor(private readonly store: Store) {}

 createScene(raw: unknown, name?: string): StoredScene {
    const payload = parseScene(raw);
    const scene = this.store.createScene(randomUUID(), name ?? "scene", payload);
    return scene;
  }

  requireScene(sceneId: string): StoredScene {
    const s = this.store.getScene(sceneId);
    if (!s) throw new RasterError("SCENE_NOT_FOUND", `场景 ${sceneId} 不存在`);
    return s;
  }

  requireRun(sceneId: string, runId: string | null) {
    this.requireScene(sceneId);
    const run = runId ? this.store.getRun(runId) : this.store.latestRun(sceneId);
    if (!run) throw new RasterError("RUN_NOT_FOUND", "尚无可查询的运行，请先执行光栅化");
    if (run.sceneId !== sceneId) {
      throw new RasterError("RUN_SCENE_MISMATCH", "该运行不属于指定场景");
    }
    if (run.status !== "succeeded") {
      throw new RasterError("RUN_NOT_SUCCEEDED", `运行状态为 ${run.status}，无结果可查`, {
        errorCode: run.errorCode,
        errorMessage: run.errorMessage,
      });
    }
    return run;
  }

  render(sceneId: string) {
    const scene = this.requireScene(sceneId);
    return this.store.render(scene, randomUUID());
  }

  mask(sceneId: string, triId: number) {
    const scene = this.requireScene(sceneId);
    if (!scene.payload.triangles.some((t) => t.id === triId)) {
      throw new RasterError("TRIANGLE_NOT_FOUND", `三角形 ${triId} 不存在`);
    }
    return { mask: triangleMask(scene.payload, triId), width: scene.width, height: scene.height };
  }
}
