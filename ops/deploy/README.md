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

## 开启邮件提醒（Ray 执行）

[邮件提醒 ADR](../../docs/adr/2026-11-17-email-reminders.md) 落地顺序第 3 步。没配 `RESEND_API_KEY` 时 worker 什么都不发，所以下面任何一步之前停下都不会有邮件出去。

1. **先更新网页**：确认过的 main（含 #94、#95、#97）按下面的“更新”部署，打开首页能看到"邮件提醒已开启，可在设置里关闭"，「设置 → 邮件提醒」能打开。这样两个人在收到第一封信之前已经知道这件事。
2. **Resend 账号与域名**：在 [resend.com](https://resend.com) 注册，在 Domains 里添加 `mail.ruihaozhang.com`（想用别的子域名也行，只影响下面的 `MAIL_FROM`）。Resend 会列出几条 DNS 记录（SPF 用的 MX 与 TXT、DKIM 的 TXT），逐条加到 Cloudflare 的 `ruihaozhang.com` 区域里，代理状态选"仅 DNS"（灰色云朵）。再加一条 DMARC：

   | 类型 | 名称 | 内容 |
   | --- | --- | --- |
   | TXT | `_dmarc.mail` | `v=DMARC1; p=none;` |

   等 Resend 显示 Verified 再往下走。主域名现有的邮件设置不受影响。
3. **API 密钥**：Resend → API Keys → Create，权限选 Sending access，域名限定为上面那个。只显示一次，存进密码管理器。
4. **退订签名密钥**：`openssl rand -base64 32`，同样存进密码管理器。以后换掉它，已发出邮件里的退订链接就失效了（设置页照常可用）。
5. **写进环境文件**：`sudoedit /etc/between-pages/app.env`，填上末尾三行（不用加引号）：

   ```sh
   RESEND_API_KEY=re_...
   MAIL_FROM=Between Pages <remind@mail.ruihaozhang.com>
   MAIL_TOKEN_KEY=...
   ```

   三个要一起填：只填 `RESEND_API_KEY` 时 api 和 worker 都会拒绝启动，并在日志里写出缺哪一个。
6. **重启**：`sudo ops/deploy/up.sh`，再看 worker 的日志里没有 "email reminders are off"：

   ```sh
   sudo docker compose --env-file /etc/between-pages/backup.env logs worker --since 10m
   ```

   之后每封信在日志里是一行 `notify: sent … mail <ID> to user <ID>`，只有 ID，没有邮箱和内容。Resend 拒绝时是 `notify: Resend refused mail … (<错误码>)`，常见的是域名验证失效或密钥被撤销。
7. **手动验收**（真实 Gmail，结果写进 `docs/validation/email-reminders-manual-<日期>.md`，不写真实日记内容）：
   - 搭档写一段日记，你一小时不打开应用，收到"…写了新内容"，带日期和约 50 字的预览；
   - 邮件在收件箱而不是垃圾箱（在垃圾箱就标为"非垃圾邮件"并记下）；
   - Gmail 网页版和手机 App 里显示正常，"去看看"打开对应的页面；
   - Gmail 发件人旁边的"退订"按一下，「设置 → 邮件提醒」里这一类变成关；页脚的"不再收到这类邮件"打开确认页，按了才关；
   - 设了作息后，睡觉时段里到期的提醒在醒来后的 15 分钟内收到；
   - 纪念日进入提醒期时收到一封，同一天不重复。

   全部通过后，ADR 的状态改为"已实现"，路线图记一笔。

**临时关掉**：把 `RESEND_API_KEY` 那一行注释掉，再 `sudo ops/deploy/up.sh`。关着的时候什么都不发；重新打开后，排队不到 24 小时的信先复查再发，超过 24 小时的直接放弃。

## 更新

1. `cd ~/volumes/between-pages`，切到确认过的 main 提交。
2. `sudo ops/deploy/up.sh`。
3. 打开站点确认能登录，再看一眼 `sudo docker compose --env-file /etc/between-pages/backup.env ps`。

更新时所有连接会断开几秒，客户端会自动重连。
