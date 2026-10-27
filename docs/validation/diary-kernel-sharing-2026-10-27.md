# 日记内核共享集成实测

日期：2026-10-27。本文记录[协作内核 ADR](../adr/2026-10-26-diary-collaboration-kernel.md) 阶段 4 中需要实测的指标：K18（多篇开放）。数字来自仓库内可复跑的脚本与正式代码，不是临时原型；项目进度只见[开发路线](../roadmap.md)。

## K18：1000 篇日记一次开放

### 方法

脚本 [`apps/api/scripts/measure-share-open.ts`](../../apps/api/scripts/measure-share-open.ts) 直接调用正式的 `sharing`、`bindings`、`commit` 服务与 `store`，对一次性 PostgreSQL 运行：

```sh
bash scripts/with-test-postgres.sh node apps/api/scripts/measure-share-open.ts 1000 3
```

每轮新建 A、B 两个账号并绑定（不设范围），为 A 建 1000 篇私人日记，每篇三次提交：写入约 280 字，插入一段私人文字，再删掉其中 50 字，所以每篇的干净基线都要清理已删除内容。然后：

1. 第一阶段：`sharing.prepare(A, 全部日期)`，一个只读快照内为 1000 篇构建并自检干净基线，不加锁、不写入。
2. 两阶段之间：向其中 10 篇各提交一次新文字，并新建 5 篇（A 尚未确认范围，所以新建时仍是私人日记）。
3. 第二阶段：一个事务内按 users → space → policy → 日记行的锁序确认范围并调用 `sharing.apply`，锁住 1005 篇日记、复查版本与起点、在锁内重建有变化的篇，写入起点、seq 0 基线提交、共享轮次与备份任务。
4. 第二阶段写完、提交前，另一连接向其中一篇提交一次编辑（旧起点），测量它等锁的时间与结果。
5. 把范围改为空，一个事务内冻结全部 1005 个共享轮次，与解绑走同一冻结写入。

### 环境

Node v26.12.1、PostgreSQL 18.6（一次性 `postgres:18-alpine` Docker 容器，同机）、4 核 ARM Neoverse-N1，连续 3 轮。

### 结果

| 轮次 | 日记篇数 | 第一阶段 | 第二阶段（持有日记锁） | 锁内重建 | 写入的轮次 / 基线提交 | 竞争提交 | 竞争提交等待 | 全部冻结 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1005 | 3204 ms | 1002 ms | 15 | 1005 / 1005 | `STALE_CONTEXT` | 64 ms | 115 ms |
| 2 | 1005 | 3010 ms | 836 ms | 15 | 1005 / 1005 | `STALE_CONTEXT` | 62 ms | 127 ms |
| 3 | 1005 | 3079 ms | 858 ms | 15 | 1005 / 1005 | `STALE_CONTEXT` | 64 ms | 104 ms |

原始输出（每轮一行 JSON）：

```text
{"node":"v26.12.1","cpus":4,"cpu":"Neoverse-N1"}
{"run":1,"diaries":1005,"phase1Ms":3204,"phase2ApplyMs":994,"phase2Ms":1002,"opened":1005,"rebuilt":15,"epochsWritten":1005,"baselineCommitsWritten":1005,"frozen":1005,"freezeMs":115,"racingCommit":"STALE_CONTEXT","racingCommitWaitMs":64}
{"run":2,"diaries":1005,"phase1Ms":3010,"phase2ApplyMs":831,"phase2Ms":836,"opened":1005,"rebuilt":15,"epochsWritten":1005,"baselineCommitsWritten":1005,"frozen":1005,"freezeMs":127,"racingCommit":"STALE_CONTEXT","racingCommitWaitMs":62}
{"run":3,"diaries":1005,"phase1Ms":3079,"phase2ApplyMs":850,"phase2Ms":858,"opened":1005,"rebuilt":15,"epochsWritten":1005,"baselineCommitsWritten":1005,"frozen":1005,"freezeMs":104,"racingCommit":"STALE_CONTEXT","racingCommitWaitMs":62}
```

### 结论

- 第二阶段持有日记锁约 0.84～1.0 秒，低于提交的 5 秒 `lock_timeout`：开放期间到达的保存只排队约 1 秒，不会因超时变成 `INTERNAL` 重试。锁内重建的篇数正好等于两阶段之间被写入的 10 篇加新建的 5 篇，其余 990 篇使用第一阶段的基线。
- 第一版逐篇写入时，第二阶段为 3.4～4.0 秒，接近 5 秒的提交锁超时；改为每 500 篇一条多行语句后降到上表的数值。这是本次实测带来的唯一代码调整。
- 第二阶段未设 `lock_timeout`（ADR：实测前不设低于 60 秒的值）。实测锁等待只来自同一主人的提交，由提交自己的 5 秒超时约束，暂不需要另设。
- 竞争提交在开放事务提交后取得锁，发现起点已切换，返回 `STALE_CONTEXT`：它既不进入旧起点，也不进入新基线，由客户端按 D7 对账后转恢复草稿（客户端对账在阶段 4.4 接入）。
- 第一阶段约 3 秒，期间不持有锁；用户看到的是"正在准备"，不影响任何写入。

### 其他 K18 证据（自动化测试）

| 要求 | 测试 |
| --- | --- |
| 任一篇失败整体不开放，并返回失败日期 | `apps/api/src/app.sharing.db.test.ts`："one diary without a clean baseline opens nothing and stores no range"、"a failed baseline at binding leaves the two unbound"；`apps/api/src/app.spaces.db.test.ts`："answers SHARE_OPEN_FAILED with the failing dates and stores nothing"（经路由，检查 409 与 `error.dates`） |
| COMMIT 后、回复前崩溃，用 requestId 查回原结果 | `app.sharing.db.test.ts`："a retried request returns its first result and opens nothing twice"；路由层的同一 requestId 重试见 `app.spaces.db.test.ts` 的既有用例 |
| 第一阶段期间的写入在锁内重建，不丢字 | `app.sharing.db.test.ts`："rebuilds under the lock a diary committed to after phase 1, keeping that text" |
| 第一阶段期间新建的日记 | 本脚本步骤 2：新建的 5 篇在第二阶段被一起开放（计入锁内重建） |
