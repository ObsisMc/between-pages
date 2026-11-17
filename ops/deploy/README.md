# ops/deploy

Running production on the existing server ([production-deployment](../../docs/adr/2026-11-05-production-deployment.md)): the images, the compose overlay, the one update command and the site's Caddy block. Backups stay in [ops/backup](../backup/README.md).

The go-live steps and the update are below, in Chinese, for Ray.

## Public surface

| Entry | Contract |
| --- | --- |
| `sudo ops/deploy/up.sh` | First start and every update: `docker compose up -d --build --wait` with the names in `backup.env` (`BACKUP_ENV_FILE` picks another file). Exits non-zero if anything fails to start. |
| `compose.production.yaml` | Overlay, last in `COMPOSE_FILE`: `postgres`, one-shot `migrate`, `api`, `worker`, `web`. Reads `POSTGRES_PASSWORD` and `APP_ENV_FILE` (default `/etc/between-pages/app.env`). |
| `Dockerfile` → image `between-pages-app` | API, worker and migrations, production dependencies only, `NODE_ENV=production`, runs as `node`. |
| `Dockerfile.web` → image `between-pages-web` | The built frontend behind Caddy on port 80. |
| `web.Caddyfile` | A file under `/srv` (the icons, the manifest, the fonts) is served as itself; any other path gets `index.html`, `no-cache`; files in `/assets/` are `immutable` for a year; a missing one is a 404. |
| `app.env.example` | Every variable the app containers read, with names only. |
| `/.dockerignore` | Keeps `.env`, `.git` and local files out of the build context. |

## Invariants

- `api` and `worker` start only after `migrate` exits 0, so a failed migration leaves the running version alone.
- Without `POSTGRES_PASSWORD`, compose refuses to start; it never falls back to the development password.
- Only `postgres` publishes a host port, on `127.0.0.1`. `postgres` is not on `between_pages_proxy`.
- Project, volume and port differ from development: `between-pages-prod`, `between-pages-prod_pgdata`, `54330`.
- Secrets live only in `/etc/between-pages`, never in an image or this repository.
- Every container's log rotates at 10 MB × 3.
- Both images copy every workspace's `package.json` (`apps/api`, `apps/web`, `packages/collab`, `packages/contracts`, `packages/time`) before `npm ci`, so the lockfile's workspace links resolve; a new workspace adds a line to both.

## Allowed dependencies

Docker and Compose on the host. The test may use `ops/backup/lib.ts` and its test overlay. Nothing in `apps/` or `packages/` imports this directory.

## How to test

`npm run test:deploy` (needs Docker; the first run builds WAL-G and takes about ten minutes). It starts the real overlay through `up.sh` as a disposable project with its own network and container names, so it is safe beside production. It covers a failed migration, a clean start from an empty volume, the web cache rules, the tab icon and manifest served as files with their own types, the log without query strings, an update that keeps data, and a real backup and drill on the production overlay. Run it after changing anything here.

## Known limitations

- An update drops every connection for a few seconds; clients reconnect on their own.
- Nothing alerts when the API is down: Healthchecks only watches backups.
- `sudo up.sh` needs the `between_pages_proxy` network to exist; compose stops with an error otherwise.
- The site's Caddy block and network entry live in `~/volumes/ray`, outside this repository; the block below is the copy to paste.
- Migrations only go forward. Going back to an older schema is a point-in-time restore.

---

## 上线步骤（Ray 执行）

要写入密钥和改 Caddy 的步骤都由你来做。第 1 步以后，AI 可以帮你核对结果，但不读 `/etc/between-pages` 里的值。

1. **克隆**（用确认过的 main 提交），并安装备份脚本的依赖：

   ```sh
   git clone https://github.com/ObsisMc/between-pages.git ~/volumes/between-pages
   cd ~/volumes/between-pages
   npm ci --omit=dev --ignore-scripts
   ```

2. **备份账号和 `backup.env`**：做完 [ops/backup/README.md](../backup/README.md) 首次配置的第 1～4 步。
3. **生成应用配置**：

   ```sh
   sudo cp ops/deploy/app.env.example /etc/between-pages/app.env
   sudo chmod 600 /etc/between-pages/app.env
   ```

   按注释填写。`DATABASE_URL` 里的 `<password>` 和 `backup.env` 的 `POSTGRES_PASSWORD` 相同。
4. **Google**：在原来的 Google Cloud 项目里新建一个 OAuth 客户端，按 ADR 的 D10 填来源和两个重定向地址，把它的 ID 和 secret 写进 `app.env`，再发布为正式版本。登录和 Drive 共用这一个客户端，开发环境继续用旧的。
5. **建网络并启动**：

   ```sh
   docker network create between_pages_proxy
   sudo ops/deploy/up.sh
   ```

6. **备份**：做完 [ops/backup/README.md](../backup/README.md) 首次配置的第 6～9 步。不通过就不要往下走。
7. **接入 Caddy**：

   ```sh
   docker network connect between_pages_proxy caddy
   ```

   在 `~/volumes/ray/docker-compose.yaml` 里给 caddy 加上 `between_pages_proxy`，并声明为 `external: true`，容器重建后才还在这个网络上。再把下面这段加进 `~/volumes/caddy/Caddyfile`：

   ```caddy
   missu.ruihaozhang.com {
       encode zstd gzip
       header Strict-Transport-Security "max-age=31536000"
       header X-Content-Type-Options nosniff

       handle /api/* {
           reverse_proxy between-pages-api:3000
       }
       handle {
           reverse_proxy between-pages-web:80
       }
   }
   ```

   然后重新加载，其他站点不会中断：

   ```sh
   docker exec caddy caddy reload --config /etc/caddy/Caddyfile
   ```

8. **验收**：打开 `https://missu.ruihaozhang.com/days/2026-11-05`，用 Google 登录，再对照 ADR 的“验收标准”逐项确认。

## 更新

1. `cd ~/volumes/between-pages`，切到确认过的 main 提交。
2. `sudo ops/deploy/up.sh`。
3. 打开站点确认能登录，再看一眼 `sudo docker compose --env-file /etc/between-pages/backup.env ps`。

更新时所有连接会断开几秒，客户端会自动重连。
