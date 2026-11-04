# ops/backup

The server backup of the PostgreSQL that holds real diaries ([server-backup-and-google-docs](../../docs/adr/2026-10-28-server-backup-and-google-docs.md) D2–D4). WAL-G archives WAL to Cloudflare R2, encrypted on the server, about every minute while there are changes. A daily backup keeps any minute of the last 30 days restorable, and the first backup of each month is kept for good. A weekly drill restores the latest backup into a throwaway container and checks it. Healthchecks.io emails the operator when a check-in is missing. Restoring is one command. Users do nothing.

The first-time setup and the restore runbook are below, in Chinese, for Ray.

## Public surface

| Entry | Contract |
| --- | --- |
| `Dockerfile` → image `between-pages-postgres-walg:3.0.9` | `postgres:18.6-alpine3.24` plus WAL-G v3.0.9 (commit `3e49318…`), built from source and statically linked with libsodium. It is Alpine because the existing data directory's libc collation (`en_US.utf8` under musl) must not change. |
| `compose.backup.yaml` | Overlay on `compose.yaml` for the real database: this image, `archive_mode=on`, `archive_command=wal-g wal-push %p`, `archive_timeout=60`, the env file `${BACKUP_ENV_FILE:-/etc/between-pages/backup.env}`, `restart: unless-stopped`. It uses the same `pgdata` volume as `compose.yaml`. |
| `node ops/backup/backup.ts` | Daily, from the systemd timer at 03:00. Steps: `backup-push` (a delta unless `WALG_DELTA_MAX_STEPS` calls for a full one); the first backup of a UTC month is `--full` and marked permanent; then `delete before FIND_FULL <now − 31 days>`; then a check that `pg_stat_archiver` has no failure newer than its last success. It pings `HC_BACKUP_URL` with start, success, or fail and the reason. |
| `node ops/backup/restore.ts --to latest\|"<time with zone>" [--volume <name>]` | Fetches the newest backup that finished before the target, replays WAL to it, promotes, runs `verify`, and shuts down cleanly. The volume must be new or empty. The result is an ordinary primary for compose to start. |
| `node ops/backup/drill.ts` | Weekly, Sundays at 04:00. Restores `latest` into a throwaway container with archiving **off**, runs `verify` against the live database, removes the container and the volume, and pings `HC_DRILL_URL`. |
| `verify(options)` (`verify.ts`) | Checks that every document's (diary or shared page) current version rebuilds with its stored sha256s, and that every visible character has an author binding and a write-time range. Optionally also checks that counts did not shrink since the last drill (`DRILL_STATE_FILE`) and that the restore reaches the live database's last commit older than five minutes. |
| `backup.env.example` | Every variable the scripts and the container read, with names only. |
| `systemd/` | Service and timer examples for the daily backup and the weekly drill. |

## Invariants

- Nothing leaves the server unencrypted: WAL-G encrypts with `WALG_LIBSODIUM_KEY` before upload. The Docker test greps the store for the diary text and finds nothing.
- A drill never writes to the bucket: its restore runs with `archive_mode=off`, so it adds no timeline. A real restore archives, so the new history continues in the bucket.
- Retention is WAL-G's own `delete before FIND_FULL`. Backups younger than 31 days and permanent backups are never deleted. No script deletes objects itself.
- Healthchecks hears success only when every step succeeded, and a failed ping never fails the job.
- The restore picks its backup by finish time and refuses a target without a time zone.

## Allowed dependencies

`verify.ts` reads the restored database through `apps/api`'s `createDb` and `createStore` (the same sha256-checked rebuild the app uses) and `@between-pages/collab`. Nothing in `apps/` or `packages/` imports from here.

## How to test

- `npx vitest run --project ops`: unit tests (backup choice, monthly, retention cutoff, `--to`, pings).
- `npm run test:backup` (Docker): the whole cycle through the real overlay plus `compose.test.yaml`, with WAL-G writing to a local directory instead of R2. It covers archive, daily backup, time-point and latest restore, checks, the delta after the monthly full backup, and the drill.

## Known limitations

- WAL segments are nominally 16 MB even when closed early after 60 s. Compressed size and R2 use still have to be measured on real writing, and `archive_timeout` raised if they are large.
- While archiving fails, unarchived WAL stays in `pg_wal` and the disk fills slowly. The daily ping turns `fail` the same day.
- The drill needs room for a second copy of the database for a few minutes.
- Schema changes need nothing here: the backup is of the whole cluster, so a backup from before a migration restores the schema of that time, and `npm run db:migrate` brings it up to the code. Two changes do need a fresh start: re-creating the database from scratch (a new cluster: point `WALG_S3_PREFIX` at a new path, or delete the old backups first) and a PostgreSQL major upgrade (make a new full backup right after).
- Restoring into the compose volume (`--volume between-pages_pgdata`) creates it outside compose. Compose may warn that it was not created by compose, and that is harmless.

---

## 首次配置（Ray 执行）

下面的步骤需要你的账号或密钥，只能由你来做。完成后，开发服务器上的真实数据库就开始备份了。

1. **生成备份加密密钥**：运行 `openssl rand -hex 32`，把输出存进密码管理器，标题例如"Between Pages 备份密钥"。**这个密钥丢了，所有备份都打不开。**
2. **Cloudflare R2**：
   1. 在 R2 里建一个存储桶，例如 `between-pages-backup`，位置自动即可。
   2. 在"管理 R2 API 令牌"里建一个令牌，权限选"对象读和写"，范围只选这个桶。记下 Access Key ID、Secret Access Key，以及 S3 接口地址 `https://<账号 ID>.r2.cloudflarestorage.com`。
3. **Healthchecks.io**：注册后建两个检查：
   - "每日备份"：周期 1 天，宽限 2 小时；
   - "每周演练"：周期 7 天，宽限 6 小时。

   通知渠道选你常看的邮箱或 Telegram，记下两个 ping 地址。
4. **服务器上的环境文件**：

   ```sh
   sudo mkdir -p /etc/between-pages /var/lib/between-pages
   sudo cp ops/backup/backup.env.example /etc/between-pages/backup.env
   sudo chmod 600 /etc/between-pages/backup.env
   ```

   按注释填入第 1～3 步的值。`LIVE_DATABASE_URL` 填应用 `.env` 里的 `DATABASE_URL`。`/var/lib/between-pages` 要让运行定时器的用户可写。
5. **切换数据库到带备份的镜像**（会重启数据库约十秒，数据卷不变）：

   ```sh
   cd ~/codebase/between-pages
   COMPOSE_FILE=compose.yaml:ops/backup/compose.backup.yaml docker compose up -d --build postgres
   ```

6. **立即做第一次备份**，看到 `backup ok: …(full, permanent)` 即可：

   ```sh
   sudo "$(nvm which 26)" --env-file=/etc/between-pages/backup.env ops/backup/backup.ts
   ```

7. **装定时器**：把 `systemd/` 里的四个文件复制到 `/etc/systemd/system/`，核对 `WorkingDirectory` 和 node 路径，然后运行：

   ```sh
   sudo systemctl daemon-reload && sudo systemctl enable --now between-pages-backup.timer between-pages-drill.timer
   ```

8. **立即演练一次**：`sudo systemctl start between-pages-drill.service`，再用 `journalctl -u between-pages-drill` 查看，出现 `drill ok` 即为成功，Healthchecks 上两个检查都应变绿。
9. **用密码管理器里的密钥演练一次**：把服务器上的 `WALG_LIBSODIUM_KEY` 换成从密码管理器复制的值，再跑一次第 8 步，确认存下来的密钥是对的。

## 恢复手册

**先判断**：服务器确实坏了，还是只是暂时连不上？只是卡住的话，先重启，不要恢复。恢复到哪个时间点：
- 硬盘坏了、机器没了：恢复到最新（`latest`）。
- 应用出 bug、在某个时刻写坏了数据：恢复到出事前一分钟，例如 `"2026-10-28 21:04 UTC"`。必须写时区。30 天以内可以选任意一分钟；更早的只能选每月 1 日那份完整备份的时刻。

**在新机器上：**

1. 装 Docker 和 Node 26，克隆仓库，执行 `npm ci`。
2. 按上面第 4 步放好 `/etc/between-pages/backup.env`。密钥从密码管理器复制，R2 令牌可以沿用，也可以新建一个。另外放好应用的 `.env`。
3. 构建镜像：`docker build -t between-pages-postgres-walg:3.0.9 ops/backup`。
4. 恢复到数据库卷，并检查：

   ```sh
   sudo "$(nvm which 26)" --env-file=/etc/between-pages/backup.env ops/backup/restore.ts --to latest --volume between-pages_pgdata
   ```

   成功时输出用了哪份备份、恢复到哪里、用了多少秒，以及用户数、日记数和提交数。检查不通过会列出问题并以失败退出。这时不要启动应用，先查原因。
5. 启动：`COMPOSE_FILE=compose.yaml:ops/backup/compose.backup.yaml docker compose up -d postgres`，然后照常启动 API 和后台进程。
6. 立即做一次备份（第 6 步），让新机器从这一刻起有完整备份。再按第 7 步装好定时器。
7. 告诉 TA：照常用 Google 登录就行，不需要做别的。

**恢复到出错前的时间点**（服务器还在，只是数据被写坏了）：
1. 先停掉 API 和后台进程，不要再写入。
2. 恢复到一个新卷：去掉 `--volume`，它会自动建一个新卷。确认输出无误后，停掉数据库，把 compose 的卷换成新卷，或者把旧卷改名留存，再启动。
3. 不要删除旧卷，确认一切正常一周以后再处理。
