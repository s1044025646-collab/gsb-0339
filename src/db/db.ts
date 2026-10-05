import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { RULE_VERSION, type RGB, type SceneInput } from "../core/types.js";
import { rasterize, explainPixel } from "../core/raster.js";

export interface StoredScene {
  id: string;
  name: string;
  width: number;
  height: number;
  ruleVersion: string;
  payload: SceneInput;
  createdAt: string;
}

export interface RunRecord {
  id: string;
  sceneId: string;
  status: "running" | "succeeded" | "failed";
  ruleVersion: string;
  stats: string | null;
  diagnostics: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface PixelRow {
  x: number;
  y: number;
  winnerId: number | null;
  depth: number | null;
  color: RGB | null;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS scenes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  rule_version TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  scene_id TEXT NOT NULL REFERENCES scenes(id),
  status TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  stats TEXT,
  diagnostics TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_scene ON runs(scene_id, created_at);
CREATE TABLE IF NOT EXISTS pixels (
  run_id TEXT NOT NULL REFERENCES runs(id),
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  winner_id INTEGER,
  depth REAL,
  r INTEGER,
  g INTEGER,
  b INTEGER,
  PRIMARY KEY (run_id, x, y)
);
`;

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  createScene(id: string, name: string, payload: SceneInput): StoredScene {
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO scenes (id, name, width, height, rule_version, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        name,
        payload.width,
        payload.height,
        RULE_VERSION,
        JSON.stringify(payload),
        createdAt,
      );
    return {
      id,
      name,
      width: payload.width,
      height: payload.height,
      ruleVersion: RULE_VERSION,
      payload,
      createdAt,
    };
  }

  getScene(id: string): StoredScene | null {
    const row = this.db.prepare(`SELECT * FROM scenes WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      name: row.name as string,
      width: row.width as number,
      height: row.height as number,
      ruleVersion: row.rule_version as string,
      payload: JSON.parse(row.payload as string) as SceneInput,
      createdAt: row.created_at as string,
    };
  }

  listScenes(): Array<{ id: string; name: string; width: number; height: number; createdAt: string }> {
    return this.db
      .prepare(`SELECT id, name, width, height, created_at FROM scenes ORDER BY created_at`)
      .all()
      .map((r) => {
        const row = r as Record<string, unknown>;
        return {
          id: row.id as string,
          name: row.name as string,
          width: row.width as number,
          height: row.height as number,
          createdAt: row.created_at as string,
        };
      });
  }

  listRuns(sceneId: string): RunRecord[] {
    return this.db
      .prepare(`SELECT * FROM runs WHERE scene_id = ? ORDER BY created_at`)
      .all(sceneId)
      .map(mapRun);
  }

  latestRun(sceneId: string): RunRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM runs WHERE scene_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(sceneId) as Record<string, unknown> | undefined;
    return row ? mapRun(row) : null;
  }

  getRun(runId: string): RunRecord | null {
    const row = this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(runId) as
      | Record<string, unknown>
      | undefined;
    return row ? mapRun(row) : null;
  }

  /**
   * 光栅化并原子发布：先在事务外完成全部计算，再用单个事务写入
   * run(succeeded) 与全部像素；任何失败只写 run(failed)，不留半成品像素。
   */
  render(scene: StoredScene, runId: string): RunRecord {
    const createdAt = new Date().toISOString();
    let result;
    try {
      result = rasterize(scene.payload);
    } catch (err) {
      this.recordFailure(scene.id, runId, createdAt, err);
      throw err;
    }
    const { width, height } = scene.payload;
    const insertRun = this.db.prepare(
      `INSERT INTO runs (id, scene_id, status, rule_version, stats, diagnostics,
                         error_code, error_message, created_at)
       VALUES (?, ?, 'succeeded', ?, ?, ?, NULL, NULL, ?)`,
    );
    const insertPixel = this.db.prepare(
      `INSERT INTO pixels (run_id, x, y, winner_id, depth, r, g, b)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    try {
      this.db.exec("BEGIN IMMEDIATE");
      insertRun.run(
        runId,
        scene.id,
        RULE_VERSION,
        JSON.stringify(result.stats),
        JSON.stringify(result.diagnostics),
        createdAt,
      );
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = y * width + x;
          const wid = result.winner[idx]!;
          const c = result.color[idx];
          insertPixel.run(
            runId,
            x,
            y,
            wid === -1 ? null : wid,
            wid === -1 ? null : result.depth[idx]!,
            c ? c.r : null,
            c ? c.g : null,
            c ? c.b : null,
          );
        }
      }
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* 事务可能已结束 */
      }
      this.recordFailure(scene.id, runId, new Date().toISOString(), err);
      throw err;
    }
    return this.getRun(runId)!;
  }

  private recordFailure(sceneId: string, runId: string, createdAt: string, err: unknown): void {
    const code =
      err instanceof Error && "code" in err
        ? String((err as { code: unknown }).code)
        : "INTERNAL";
    const message = err instanceof Error ? err.message : String(err);
    this.db
      .prepare(
        `INSERT INTO runs (id, scene_id, status, rule_version, stats, diagnostics,
                           error_code, error_message, created_at)
         VALUES (?, ?, 'failed', ?, NULL, NULL, ?, ?, ?)`,
      )
      .run(runId, sceneId, RULE_VERSION, code, message, createdAt);
  }

  getPixel(runId: string, x: number, y: number): PixelRow | null {
    const row = this.db
      .prepare(`SELECT * FROM pixels WHERE run_id = ? AND x = ? AND y = ?`)
      .get(runId, x, y) as Record<string, unknown> | undefined;
    return row ? mapPixel(row) : null;
  }

  /** 分页读取像素矩阵；背景 winnerId 为 null，与任何合法深度值区分。 */
  getPixelPage(runId: string, offset: number, limit: number): PixelRow[] {
    return this.db
      .prepare(
        `SELECT x, y, winner_id, depth, r, g, b FROM pixels
         WHERE run_id = ? ORDER BY y, x LIMIT ? OFFSET ?`,
      )
      .all(runId, limit, offset)
      .map((r) => mapPixel(r as Record<string, unknown>));
  }

  /** 基于不可变场景快照实时计算解释，不随结果矩阵分页而截断。 */
  explain(scene: StoredScene, x: number, y: number) {
    return explainPixel(scene.payload, x, y);
  }
}

function mapRun(row: Record<string, unknown>): RunRecord {
  return {
    id: row.id as string,
    sceneId: row.scene_id as string,
    status: row.status as RunRecord["status"],
    ruleVersion: row.rule_version as string,
    stats: (row.stats as string | null) ?? null,
    diagnostics: (row.diagnostics as string | null) ?? null,
    errorCode: (row.error_code as string | null) ?? null,
    errorMessage: (row.error_message as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}

function mapPixel(row: Record<string, unknown>): PixelRow {
  const color =
    row.r === null || row.r === undefined
      ? null
      : { r: row.r as number, g: row.g as number, b: row.b as number };
  return {
    x: row.x as number,
    y: row.y as number,
    winnerId: (row.winner_id as number | null) ?? null,
    depth: (row.depth as number | null) ?? null,
    color,
  };
}
