# 三角形光栅覆盖与深度遮挡核验后端（trirast）

离线二维三角形光栅化服务：自行实现有向边函数覆盖判定、top-left 共边规则、不透明深度遮挡，
提供 HTTP API 与 CLI，结果持久化到 SQLite。只做后端，无网页画布、无透视/纹理/抗锯齿/光照。

## 运行环境

- Windows 本地（也适用于任何支持 Node.js 的平台）
- Node.js >= 22（开发验证版本：v25.5.0，使用内置 `node:sqlite`，无需任何原生模块编译）
- 不需要 Docker / WSL / 外部在线 API；运行时零第三方依赖（仅 TypeScript/tsx 为开发依赖）

## 构建 / 测试 / 启动 / 演示

```powershell
npm install
npm run build        # tsc 编译到 dist/
npm test             # node:test 全部 18 个测试（光栅/DB/API）
npm start            # 启动 HTTP API；默认自动选择空闲端口，输出实际地址
$env:PORT=7000; npm start          # 指定端口（cmd: set PORT=7000 && npm start）
npm run demo         # CLI 内置演示：共边、遮挡、等深、越界、退化
```

数据库与导出文件默认放在项目内 `data/`（`data/trirast.sqlite`）。
可用环境变量 `TRIRAST_DB` 覆盖数据库路径、`PORT` 覆盖端口。

## 坐标约定与光栅规则（规则版本 `tl-2x-v1`）

- 像素 `(x,y)` 的采样点是像素**中心** `(x+0.5, y+0.5)`；x 向右、y 向下。
- 为避免浮点和 epsilon，全部坐标**放大 2 倍**后用整数比较：
  顶点 `v → 2v`，像素中心 `(x+0.5,y+0.5) → (2x+1, 2y+1)`。
  坐标上限 ±1,000,000，放大后运算仍远在安全整数范围内。
- 对有向边 `e_i = v_i → v_{i+1}`：`w_i(p) = (p-v_i) × (v_{i+1}-v_i)`。
  面积符号 `sign(A2)` 区分顺/逆时针，统一 `side = w_i·sign(A2)`，
  覆盖要求每条边 `side >= 0` —— **反转顶点绕序不改变覆盖**。
- **Top-left 共边规则**。排除边（边上像素中心不属于本三角形）当且仅当：
  - top 边：`dy < 0`；
  - left 边：`dy == 0 且 dx < 0`。

  判据：`side > 0`，或 `side == 0 且该边不是排除边`。
  两三角形共享一条边时，该边对一侧为排除边、对另一侧为纳入边，
  像素中心恰好落边时**恰好归属一侧**，无重叠也无裂缝。
- 深度：较小 `depth` 优先；深度相等时按**稳定三角形编号**（不是输入顺序）较小者优先。
- 退化三角形（面积 0）不产生覆盖，渲染结果附带 `DEGENERATE_TRIANGLE` 诊断。
- 顶点可在画布外：遍历包围盒与画布求交，但覆盖始终按原始顶点判定。
- 背景像素 `winnerId/depth/color` 均为 `NULL`，不用任何合法深度值代表“未写入”。

## 原子性与版本

- 场景为不可变快照；修改顶点/深度需新建场景并产生新 run，旧 run 永久保留，重启可查。
- 一次渲染先在事务外完成全部计算，再在单事务内写入 run 与全部像素；
  失败写 `failed` run 并回滚，绝不留半幅画面。
- `runs` 表保存规则版本、覆盖统计、诊断、错误码、完成状态。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查与规则版本 |
| POST | `/api/scenes` | 创建场景（body 见 `examples/scene.json`） |
| GET | `/api/scenes` | 场景列表 |
| GET | `/api/scenes/:id` | 场景快照 |
| POST | `/api/scenes/:id/validate` | 校验 |
| POST | `/api/scenes/:id/render` | 执行光栅化（原子发布） |
| GET | `/api/scenes/:id/runs` / `/runs/:runId` | 运行列表 / 详情 |
| GET | `/api/scenes/:id/pixels/:x/:y?runId=` | 查像素（默认最新 run） |
| GET | `/api/scenes/:id/matrix?offset=&limit=&runId=` | 颜色/归属矩阵**分页** |
| GET | `/api/scenes/:id/triangles/:tid/mask` | 单三角形覆盖掩码（0/1 字符串行） |
| GET | `/api/scenes/:id/explain/:x/:y` | 像素解释：边值、onEdge、排除边、候选、深度选择 |

错误响应统一为 `{ "error": { "code", "message", "details" } }`。

### 错误码

`INVALID_SHAPE`、`INVALID_DIMENSION`、`DIMENSION_TOO_LARGE`、`TOO_MANY_TRIANGLES`、
`INVALID_ID`、`DUPLICATE_TRIANGLE_ID`、`VERTEX_NOT_INTEGER`、`COORD_OUT_OF_RANGE`、
`INVALID_COLOR`、`DEPTH_NOT_FINITE`、`DEPTH_OUT_OF_RANGE`、
`SCENE_NOT_FOUND`、`TRIANGLE_NOT_FOUND`、`RUN_NOT_FOUND`、`RUN_SCENE_MISMATCH`、
`RUN_NOT_SUCCEEDED`、`PIXEL_OUT_OF_RANGE`、`INVALID_QUERY`、`INVALID_JSON`、
`BODY_TOO_LARGE`、`NOT_FOUND`、`INTERNAL`，
以及作为渲染诊断（非错误）的 `DEGENERATE_TRIANGLE`。

### 快速调用示例（PowerShell）

```powershell
$body = Get-Content examples/scene.json -Raw
$sid = (Invoke-RestMethod -Method Post -Uri http://127.0.0.1:<端口>/api/scenes -ContentType 'application/json' -Body $body).id
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:<端口>/api/scenes/$sid/render"
Invoke-RestMethod -Uri "http://127.0.0.1:<端口>/api/scenes/$sid/explain/2/2"
Invoke-RestMethod -Uri "http://127.0.0.1:<端口>/api/scenes/$sid/matrix?offset=0&limit=16"
```

## CLI

```powershell
npm run demo
node dist/cli.js create examples/scene.json demo
node dist/cli.js validate examples/scene.json
node dist/cli.js list
node dist/cli.js render <sceneId>
node dist/cli.js grid <sceneId>
node dist/cli.js explain <sceneId> 2 2
node dist/cli.js mask <sceneId> 1
node dist/cli.js export-bmp <sceneId> data/out.bmp
```

`grid` 用字符显示获胜三角形编号（`.` 为背景）；`explain` 输出参与判断的三条边
`w/side`、是否 onEdge、是否排除边、候选列表及等深/深度落败原因；
`export-bmp` 自行写 24 位 BMP 文件头，不依赖任何外部图形程序。

## 资源限制

画布边长 ≤ 4096、三角形数 ≤ 100,000、顶点坐标 ≤ ±1,000,000、深度为有限数且 ≤ ±1e9，
请求体 ≤ 16MB。

## 已知限制

- `node:sqlite` 在当前 Node 版本标记为 experimental（运行时有一行实验性警告，不影响功能）。
- 仅支持不透明常量深度三角形；无半透明、无透视校正、无超采样/抗锯齿。
- 矩阵按像素分页（`limit` 最大 10,000），解释按单像素实时计算，二者互不影响。
