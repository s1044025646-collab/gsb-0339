import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { RasterResult, RasterStats, SceneInput } from "./types.ts";
import { COORD_CONVENTION, RULE_VERSION } from "./types.ts";

/**
 * SQLite 持久化。
 * - scenes：场景快照（含坐标约定与规则版本）。
 * - runs：每次光栅化生成新运行；结果与完成状态在同一事务中原子发布，
 *   失败只写入 failed 状态，不留下半幅结果。
 */
export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS scenes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        triangles_json TEXT NOT NULL,
        coord_convention TEXT NOT NULL,
        rule_version TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scene_id INTEGER NOT NULL REFERENCES scenes(id),
        status TEXT NOT NULL,               -- running | completed | failed
        stats_json TEXT,
        result_json TEXT,                   -- 仅 completed 时非空
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  createScene(scene: SceneInput): number {
    const r = this.db
      .prepare(
        "INSERT INTO scenes (name, width, height, triangles_json, coord_convention, rule_version) VALUES (?,?,?,?,?,?)",
      )
      .run(scene.name ?? null, scene.width, scene.height, JSON.stringify(scene.triangles), COORD_CONVENTION, RULE_VERSION);
    return Number(r.lastInsertRowid);
  }

  getScene(id: number): (SceneInput & { id: number; coordConvention: string; ruleVersion: string }) | null {
    const row = this.db.prepare("SELECT * FROM scenes WHERE id = ?").get(id) as
      | { id: number; name: string | null; width: number; height: number; triangles_json: string; coord_convention: string; rule_version: string }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name ?? undefined,
      width: row.width,
      height: row.height,
      triangles: JSON.parse(row.triangles_json),
      coordConvention: row.coord_convention,
      ruleVersion: row.rule_version,
    };
  }

  listScenes(): unknown[] {
    return this.db
      .prepare("SELECT id, name, width, height, coord_convention, rule_version, created_at FROM scenes ORDER BY id")
      .all();
  }

  /** 执行光栅化并原子发布结果；失败记录 failed，不残留半成品。 */
  runRasterize(sceneId: number, compute: () => RasterResult): { runId: number; status: string; error?: string } {
    const runId = Number(
      this.db.prepare("INSERT INTO runs (scene_id, status) VALUES (?, 'running')").run(sceneId).lastInsertRowid,
    );
    let result: RasterResult;
    try {
      result = compute();
    } catch (err) {
      this.db
        .prepare("UPDATE runs SET status = 'failed', error = ? WHERE id = ?")
        .run(err instanceof Error ? err.message : String(err), runId);
      return { runId, status: "failed", error: err instanceof Error ? err.message : String(err) };
    }
    const payload = JSON.stringify(serializeResult(result));
    const stats = JSON.stringify(result.stats);
    // 单事务：结果与 completed 状态一起可见。
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE runs SET status = 'completed', result_json = ?, stats_json = ? WHERE id = ?")
        .run(payload, stats, runId);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      this.db.prepare("UPDATE runs SET status = 'failed', error = ? WHERE id = ?")
        .run(err instanceof Error ? err.message : String(err), runId);
      return { runId, status: "failed", error: String(err) };
    }
    return { runId, status: "completed" };
  }

  getRun(runId: number): { id: number; scene_id: number; status: string; stats: RasterStats | null; error: string | null } | null {
    const row = this.db.prepare("SELECT id, scene_id, status, stats_json, error FROM runs WHERE id = ?").get(runId) as
      | { id: number; scene_id: number; status: string; stats_json: string | null; error: string | null }
      | undefined;
    if (!row) return null;
    return { id: row.id, scene_id: row.scene_id, status: row.status, stats: row.stats_json ? JSON.parse(row.stats_json) : null, error: row.error };
  }

  latestCompletedRun(sceneId: number): { runId: number; result: RasterResult } | null {
    const row = this.db
      .prepare("SELECT id, result_json FROM runs WHERE scene_id = ? AND status = 'completed' ORDER BY id DESC LIMIT 1")
      .get(sceneId) as { id: number; result_json: string } | undefined;
    if (!row) return null;
    return { runId: row.id, result: deserializeResult(JSON.parse(row.result_json)) };
  }

  listRuns(sceneId: number): unknown[] {
    return this.db
      .prepare("SELECT id, status, stats_json, error, created_at FROM runs WHERE scene_id = ? ORDER BY id")
      .all(sceneId)
      .map((r) => {
        const row = r as { id: number; status: string; stats_json: string | null; error: string | null; created_at: string };
        return { id: row.id, status: row.status, stats: row.stats_json ? JSON.parse(row.stats_json) : null, error: row.error, created_at: row.created_at };
      });
  }
}

interface SerializedResult {
  width: number;
  height: number;
  winner: number[];
  depth: number[];
  color: number[];
  stats: RasterStats;
}

function serializeResult(r: RasterResult): SerializedResult {
  return {
    width: r.width,
    height: r.height,
    winner: Array.from(r.winner),
    depth: Array.from(r.depth, (d) => (Number.isFinite(d) ? d : null)) as unknown as number[],
    color: Array.from(r.color),
    stats: r.stats,
  };
}

function deserializeResult(s: SerializedResult): RasterResult {
  return {
    width: s.width,
    height: s.height,
    winner: Int32Array.from(s.winner),
    depth: Float64Array.from(s.depth, (d) => (d === null ? Number.POSITIVE_INFINITY : d)),
    color: Uint8Array.from(s.color),
    stats: s.stats,
  };
}
