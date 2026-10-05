# 三角形光栅覆盖与深度遮挡核验后端

纯本地离线运行的后端服务：TypeScript + Node.js（≥22，推荐 25）+ SQLite（Node 内置 `node:sqlite`）。
只做 API 与 CLI，无网页画布、无外部服务依赖。

## 核心约定

- **坐标系**：画布原点左上，x 向右，y 向下；像素 `(x,y)` 的采样点为中心 `(x+0.5, y+0.5)`。
- **精确整数运算**：所有坐标放大 2 倍（顶点 `2v`，采样点 `2x+1`），边函数全部整数计算，**不使用 epsilon**。
- **边函数**：`E(a,b,p) = (bx-ax)(py-ay) - (by-ay)(px-ax)`；顶点绕序统一规范化为 `area2 > 0`，
  顺时针/逆时针输入结果一致。
- **top-left 共边规则**：方向 `(dx,dy)` 的边是纳入边当且仅当 `dy > 0 或 (dy == 0 且 dx < 0)`。
  共享边在两个相邻三角形中方向相反，该谓词对正反向恰好一个为真，
  因此边上的像素中心**恰好归属一侧**：无重叠、无裂缝。
- **深度**：值小者胜；深度相等时**三角形编号小者胜**（与输入顺序无关）。
- **背景**：`winner = -1`、深度为 `null`，不与任何合法深度值混淆。
- **退化三角形**（面积为 0）：不产生覆盖，统计与解释中给出诊断。
- **画布外顶点**：遍历范围裁到画布内，覆盖判断仍依据原始顶点，不生成裁剪多边形。

## 快速开始

```powershell
npm install        # 仅安装 typescript / @types/node（开发依赖）
npm run build      # 编译到 dist/
npm test           # 运行全部测试（node:test，直接跑 TypeScript）
npm start          # 启动 API 服务（默认自动选择空闲端口，--port=8080 可指定）
npm run demo       # 运行全部演示场景并保存到 data/raster.db
```

## CLI

```
node src/cli.ts serve [--port=N]     启动 API 服务（默认空闲端口）
node src/cli.ts create <scene.json>  创建场景
node src/cli.ts validate <scene.json> 校验场景文件
node src/cli.ts rasterize <sceneId>  光栅化并打印字符网格
node src/cli.ts pixel <sceneId> <x> <y>   查询像素
node src/cli.ts mask <sceneId> <triId>    三角形覆盖掩码（0/1 网格）
node src/cli.ts explain <sceneId> <x> <y> 像素判定解释（边值/top-left/深度竞争）
node src/cli.ts export <sceneId> <out>    导出 <out>.json 与 <out>.ppm 图片
node src/cli.ts demo                 演示：共边矩形、遮挡、等深、画布外、退化
```

数据目录为项目内 `data/`（可用环境变量 `TRI_RASTER_DB` 覆盖数据库路径）。

## API（默认 `http://127.0.0.1:<空闲端口>`）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/scenes` | 创建场景（校验后入库） |
| GET | `/scenes` | 场景列表 |
| POST | `/scenes/:id/validate` | 重新校验场景快照 |
| POST | `/scenes/:id/rasterize` | 执行光栅化，生成新运行 |
| GET | `/scenes/:id/runs` | 运行历史与统计 |
| GET | `/scenes/:id/pixels?page=&pageSize=` | 完整像素矩阵（分页） |
| GET | `/scenes/:id/pixel?x=&y=` | 单像素查询 |
| GET | `/scenes/:id/explain?x=&y=` | 像素解释（边值、排除边、候选、遮挡原因） |
| GET | `/scenes/:id/triangles/:tid/mask` | 三角形覆盖掩码 |
| GET | `/scenes/:id/export` | 导出颜色矩阵（背景为 `null`） |

### 场景格式

```json
{
  "name": "demo",
  "width": 4,
  "height": 4,
  "triangles": [
    { "id": 0, "vertices": [[0,0],[4,0],[4,4]], "color": [255,0,0], "depth": 1 }
  ]
}
```

### 错误码

`BAD_SCENE` `BAD_SIZE` `SIZE_LIMIT` `BAD_TRIANGLES` `BAD_ID` `DUP_ID` `BAD_VERTICES`
`COORD_LIMIT` `BAD_COLOR` `BAD_DEPTH` `BAD_JSON` `BAD_PIXEL` `NOT_FOUND` `NO_RUN`
`RASTER_FAILED` `INTERNAL`。错误响应形如 `{ "code": "DUP_ID", "error": "..." }`。

## 持久化与原子性

- SQLite 保存场景快照（含坐标约定 `origin=top-left, x=right, y=down, sample=pixel-center`
  与规则版本 `top-left-v1`）、每次运行的统计与完整结果。
- 修改顶点或深度后重新 `rasterize` 会生成**新运行**，旧结果仍可查询。
- 结果与 `completed` 状态在**同一事务**中发布；失败只写入 `failed` 状态，
  不留下半幅成功画面，也不覆盖旧的完成结果。
- 重启后可按像素查询旧场景（见测试「持久化：失败回滚不留半成品，重启后可查询旧场景」）。

## 资源限制（`src/validate.ts` 的 `LIMITS`）

- 画布边长 ≤ 2048，总像素 ≤ 4,000,000，三角形 ≤ 10,000。
- 顶点坐标 |v| ≤ 1,000,000（放大后边函数乘积远低于 2^53，整数精确）。
- 顶点必须为整数；颜色为 0–255 整数；深度必须为有限数值。

## 测试

`npm test` 覆盖：共享斜边逐像素恰好覆盖一次且无空洞、手列直角三角形像素答案、
顶点绕序反转不变、输入重排不变、深度遮挡、等深编号决胜、画布外顶点、退化诊断、
背景像素、参数校验与资源限制、失败回滚与重启查询、API 端到端。

## 限制

- 仅研究边界覆盖与不透明深度遮挡：不做透视、纹理、抗锯齿、光照、网格建模。
- 深度在单个三角形内部恒定。
- 导出图片为 PPM（P6）格式，可用常见看图工具打开；核心计算不依赖任何外部图形程序。
- `node:sqlite` 在 Node 25 中标记为 experimental（仅警告，功能可用）。
