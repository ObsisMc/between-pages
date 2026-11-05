# 生产环境用 Docker 跑在现有服务器上，由现有 Caddy 接入，数据与开发环境完全分开

- 状态：已采纳
- 日期：2026-11-05
- 决策者：Ray
- 范围：技术栈
- 关联：依赖 ADR-0003；依赖 ADR-0006；依赖 authentication-and-sessions；依赖 diary-collaboration-kernel；依赖 server-backup-and-google-docs

Between Pages 部署到现有的美国 ARM 服务器：一个独立的 Docker compose 项目运行 PostgreSQL（带 WAL-G 备份）、一次性迁移、API、worker 和只发前端文件的 web 容器，公网请求先经过 Cloudflare 代理，再到服务器上已有的 Caddy，由它负责到源站的 HTTPS，把 `/api/*` 转给 API、其余转给 web。生产的目录、compose 项目、数据卷、端口和密码都与开发环境分开。更新是人工执行的一条命令，迁移失败时新版 API 不启动。本文回答路线图留给部署 ADR 的四件事：子域名、静态网页由谁提供、生产数据库放在哪里、Google 应用发布为正式。

本文不负责：邮件通知与发信域名（阶段 4 另写 ADR）；手机支持；多实例与零停机更新（kernel 已决定首版单实例）；Caddy 与服务器本身的运维。

## 背景与问题

应用目前只在开发环境运行。仓库里只有备份相关的生产配置（`ops/backup/`），没有应用镜像、生产 compose 和部署手册，API 也不提供前端文件。server-backup-and-google-docs、authentication-and-sessions 和路线图都把生产数据库的位置、HTTPS 地址和 Google 应用发布留给本文。

服务器上已有 6 个站点，由 Docker 里的 Caddy 接入，配置在仓库之外（`~/volumes/caddy/Caddyfile`、`~/volumes/ray/docker-compose.yaml`），每个应用通过自己的 `*_proxy` 网络只与 Caddy 互通。开发环境也在这台机器上，`~/codebase/between-pages` 和各 worktree 都在用，其 compose 项目名 `between-pages` 正是 `ops/backup/backup.env.example` 的默认值。

2026-11-05 在这台服务器上确认：只装生产依赖（`npm ci --omit=dev --ignore-scripts`，`node_modules` 270 MB）后，API 能在 `node:26.12.1-alpine3.24`（arm64）里直接运行 TypeScript，`/api/health` 返回 200，根路径返回 404；`npm run build` 通过，产物 7.2 MB，其中字体 6 MB，JS 单文件约 1 MB。

同一天还确认了一个问题：API 的请求日志记录完整 URL，访问 `/api/auth/callback/google?code=…&state=…` 时，`code` 和 `state` 会原样写进日志。

## 决策依据

1. 这是两个人的私密日记：数据不丢、不泄露优先于高可用和部署便利。
2. 现有服务器和 Caddy 已经在跑，部署不能打断其他站点，也不重复搭建 HTTPS。
3. 备份、恢复和演练已按 compose 与 WAL-G 写好并有 Docker 测试（server-backup-and-google-docs D2–D4），不为部署重写。
4. 真实日记与开发、测试数据必须隔离：开发环境的任何日常操作都碰不到生产数据。
5. 首版单实例，更新时所有连接断开几秒，客户端重连补同步（kernel），两个人使用可以接受。
6. 前端与 API 同源（ADR-0006、architecture），会话 cookie 和 WebSocket 的 Origin 校验都依赖这一点。
7. 能用现有东西解决就不加新东西：不加 npm 依赖、不加 registry、不加部署平台。
8. 生产配置要让常见的错误启动不了，而不是悄悄运行：开发登录、开发密码、漏设的生产模式。

## 决策

### D1：生产是现有服务器上一个独立的 compose 项目

| 项目 | 生产 | 开发（不变） |
| --- | --- | --- |
| 目录 | `~/volumes/between-pages`，main 的干净克隆，只用于部署；不放 `~/deploy`，它挂载在 OpenClaw 容器里 | `~/codebase/between-pages` 与各 worktree |
| compose 项目名 | `between-pages-prod` | `between-pages` 或 worktree 名 |
| 数据卷 | `between-pages-prod_pgdata` | `between-pages_pgdata` 等 |
| 数据库端口 | `127.0.0.1:54330` | `127.0.0.1:54320` 等 |
| 密钥 | `/etc/between-pages/app.env`、`backup.env`（root，600） | 仓库目录下的 `.env` |

compose 文件在基础上叠加，备份脚本继续按 `COMPOSE_FILE` 工作：

```text
COMPOSE_FILE=compose.yaml:ops/backup/compose.backup.yaml:ops/deploy/compose.production.yaml
COMPOSE_PROJECT_NAME=between-pages-prod
```

| 服务 | 镜像 | 运行内容 | 重启 |
| --- | --- | --- | --- |
| `postgres` | `between-pages-postgres-walg:3.0.9` | 数据库与持续归档 | `unless-stopped` |
| `migrate` | 应用镜像 | `node apps/api/scripts/migrate.ts`，跑完退出 | 不重启 |
| `api` | 应用镜像 | `node apps/api/src/server.ts` | `unless-stopped` |
| `worker` | 应用镜像 | `node apps/api/src/worker/main.ts` | `unless-stopped` |
| `web` | web 镜像 | 只发前端文件 | `unless-stopped` |

`api` 依赖 `postgres` 健康且 `migrate` 成功结束；`worker` 同样。`api` 和 `worker` 设 `init: true`：Node 作为容器 1 号进程时不响应默认的 SIGTERM，`server.ts` 也没有处理它，没有 init 每次更新都要等到被强杀。

理由：依据 3、4。`backup.env.example` 的默认项目名要在生产配置里改掉，否则备份和恢复操作的是开发数据卷。

### D2：子域名接到现有 Caddy，不经过 Authelia

Caddyfile 增加一个站点。它在仓库之外，手册写明这一段由 Ray 粘贴：

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

- 不写 `import auth`。这个站点有自己的 Google 登录，对方也没有 Authelia 账号，经过它就进不来了。
- 不写 `log`，Caddy 默认不记访问日志，这里保持不记。
- `encode` 必须写：Caddy 默认不压缩，1 MB 的 JS 跨国传输会明显变慢。
- WebSocket 走 `/api/*`，`reverse_proxy` 不用额外配置；Caddy 传递 `Origin` 和 `X-Forwarded-For`，同源校验和 Better Auth 的限流都能工作。
- 服务器的 80/443 只放行 Cloudflare（`/etc/cf-origin-lock`），现有 Caddy 已信任它的 IP 段，并从 `CF-Connecting-IP` 取访客真实 IP，这里不用改。Cloudflare 默认按响应头缓存静态文件，所以 D3 的缓存头同样决定它的行为。

子域名是 `missu.ruihaozhang.com`，`PUBLIC_ORIGIN=https://missu.ruihaozhang.com`。理由：依据 2、6。

### D3：前端文件由独立的 web 容器提供

web 镜像分两段：先在 Node 镜像里 `npm run build`，再把 `apps/web/dist` 放进 `caddy:2.11.2-alpine`。这个容器只监听 80 端口，由站点 Caddy 转发，不处理 HTTPS。

- 找不到文件的路径返回 `index.html`，直接打开或刷新 `/days/2026-11-05` 这样的地址才能进入应用。`/assets/*` 除外：旧页面请求已不存在的文件时返回 404，否则 HTML 会以这个文件名被缓存一年。
- `/assets/*` 文件名带内容哈希，设一年 `immutable` 缓存；其余文件（`index.html`、字体）每次向服务器确认，新版本更新后不会卡在旧页面上。

理由：依据 2、7。站点 Caddy 自己发文件需要加挂载，也就要重建容器，所有站点一起中断；API 发文件要加依赖，还多一项与它无关的职责。

### D4：两个 Docker 网络，Caddy 碰不到数据库

| 网络 | 成员 | 用途 |
| --- | --- | --- |
| `between_pages_proxy` | Caddy、`api`、`web` | Caddy 转发请求 |
| `between-pages-prod_internal` | `postgres`、`migrate`、`api`、`worker` | 应用访问数据库 |

- `between_pages_proxy` 延续现有 `*_proxy` 的做法，只有 Caddy 这一个外部成员，其他应用连不到这里。
- 先手动 `docker network create between_pages_proxy`，再用 `docker network connect between_pages_proxy caddy` 接入，Caddy 不用重启。同时在 `~/volumes/ray/docker-compose.yaml` 里声明为 `external`，容器重建后仍在这个网络里。
- `api` 和 `web` 设固定的 `container_name`（`between-pages-api`、`between-pages-web`）。Caddy 同时在多个网络里，`api`、`web` 这样的服务名不够明确。
- 内部网络不设 `internal: true`：worker 要访问 Google，`postgres` 里的 WAL-G 要访问 R2，这个选项会切断出网。
- `api`、`web`、`worker` 不发布宿主机端口。`postgres` 只发布 `127.0.0.1:54330`，因为每周演练在宿主机上运行，要用 `LIVE_DATABASE_URL` 连生产库比对。

理由：依据 1、2。Caddy 被攻破或配置写错时，也没有直达数据库的路径。

### D5：生产库在同一台机器，从第一天起持续备份

生产数据库沿用 `ops/backup` 的 WAL-G 镜像和归档设置，第一次启动前就准备好 R2 和 `backup.env`。没有可用的 R2 时不开归档：WAL 传不出去，会堆在 `pg_wal` 里。

- compose 服务名 `postgres`、用户名和库名 `between_pages` 不变，备份脚本写死了这些名字。
- `compose.production.yaml` 用 `${POSTGRES_PASSWORD:?}` 覆盖 `compose.yaml` 的开发密码，未设置时 compose 拒绝启动。这个密码只在数据卷首次初始化时生效，以后要改只能用 `ALTER ROLE`。
- `POSTGRES_PASSWORD` 用 `openssl rand -hex 24` 生成，只含十六进制字符，放进连接地址不用转义。
- `backup.env` 增加 `POSTGRES_PASSWORD`、`DB_PORT=54330`，`COMPOSE_PROJECT_NAME` 和 `COMPOSE_FILE` 改成 D1 的值，`LIVE_DATABASE_URL` 指向 `127.0.0.1:54330`；`app.env` 的 `DATABASE_URL` 指向 `postgres:5432`。
- systemd 单元的 `WorkingDirectory` 改为 `~/volumes/between-pages`，恢复时 `--volume` 用 `between-pages-prod_pgdata`。`ops/backup/README.md` 随之更新。
- 生产库从空库开始，开发库的数据不迁移。开发库的账号来自开发登录，到生产换成 Google 登录后也对不上。

理由：依据 1、3、4。备份加密、保留和恢复规则都不变，仍以 server-backup-and-google-docs 为准。

### D6：应用镜像在服务器上构建，不编译 TypeScript

`ops/deploy/Dockerfile` 基于 `node:26.12.1-alpine3.24`，用 `npm ci --omit=dev --ignore-scripts` 安装依赖，`ENV NODE_ENV=production`，与开发一样由 Node 直接运行 TypeScript。`api`、`worker`、`migrate` 共用这一个镜像，只是命令不同。

- 启动命令直接写 `node …`，不用 `npm run start`：后者会读仓库里的 `.env`，并让 npm 夹在中间转发信号。
- `NODE_ENV=production` 写在镜像里，而不是靠环境文件：启动脚本不设它，漏掉时不报错，只是登录限流悄悄不启用。
- 仓库根目录的 `.dockerignore` 排除 `.env`、`node_modules`、`.git` 和本地构建产物，密钥进不了镜像。
- 镜像在服务器上构建，不用 registry。ARM 架构天然一致。

理由：依据 7、8。

### D7：配置集中在两个环境文件

`/etc/between-pages/app.env` 供 `api`、`worker`、`migrate` 使用，`ops/deploy/app.env.example` 列出全部变量名：

| 变量 | 生产值 |
| --- | --- |
| `HOST`、`PORT` | `0.0.0.0`、`3000`（容器内） |
| `DATABASE_URL` | `postgresql://between_pages:<密码>@postgres:5432/between_pages` |
| `PUBLIC_ORIGIN` | `https://missu.ruihaozhang.com` |
| `AUTH_PROVIDER` | `google` |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` |
| `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` | D10 的生产客户端，登录和 Drive 共用 |
| `GOOGLE_TOKEN_KEY` | `openssl rand -base64 32` |

`GOOGLE_DRIVE_TESTING`、`HISTORY_IDLE_MS` 不设。`/etc/between-pages` 下的文件只有 root 能读，所以部署命令用 `sudo` 运行。理由：依据 1、8。

### D8：请求日志不记录查询串

API 的请求日志只记路径，不记 `?` 之后的内容。这在 `apps/api/src/server.ts` 的 logger 配置里实现，开发和生产相同，`apps/api/README.md` 同步说明。

原因见背景：Google 的 `code` 虽然只能用一次、很快失效，但它和 `state` 都不该进日志，AGENTS.md 也要求令牌不进日志。其余接口把敏感内容放在请求体里，路径本身可以保留。

所有容器的日志设 `json-file`，`max-size: 10m`、`max-file: 3`。Docker 默认不轮转，长期运行会占满磁盘。理由：依据 1。

### D9：更新是一条人工执行的命令

`ops/deploy/up.sh` 载入 `backup.env`，运行 `docker compose up -d --build --wait`，由 `depends_on` 保证先迁移、后启动新版 API。更新步骤：

1. 在 `~/volumes/between-pages` 切到 Ray 确认过的 main 提交。
2. `sudo ops/deploy/up.sh`。
3. 打开站点确认能登录，看 `docker compose ps`。

不做 CI 自动部署：合并到 main 不等于要上线，Ray 要先验过再更新。迁移只向前，发布后要回到旧数据结构时，走恢复手册的时间点恢复。理由：依据 5、6、8。

### D10：Google 应用在部署时发布为正式

同一个 Google Cloud 项目，新建一个生产用的 OAuth 客户端（类型 Web application），开发继续用原来的客户端，两边的 secret 互不影响（Ray 于 2026-11-05 决定）。生产客户端配置这些地址：

- 已获授权的 JavaScript 来源：`https://missu.ruihaozhang.com`
- 重定向 URI：`https://missu.ruihaozhang.com/api/auth/callback/google`、`https://missu.ruihaozhang.com/backup/google/callback`
- OAuth 同意屏幕发布为“正式版”，Drive 授权不再 7 天过期，`GOOGLE_DRIVE_TESTING` 不设。

`drive.file` 是 Google 列为非敏感的权限（server-backup-and-google-docs），预计不用审核；发布时要填写什么，以控制台提示为准。继续使用同一个 Google Cloud 项目：`drive.file` 按项目生效，同一项目下换客户端不受影响，换项目后应用读不到已有的 Doc。同意屏幕属于项目，发布后开发客户端也一起变成正式状态。理由：依据 1。

## 失败与恢复

| 情况 | 结果 | 恢复 |
| --- | --- | --- |
| 迁移失败 | `api`、`worker` 不启动新版，`up.sh` 报错 | 看 `migrate` 日志；能修就修复后重跑，不能修就走时间点恢复 |
| 新版 API 启动失败 | 配置错误时进程拒绝启动并指出变量，`up.sh` 报错 | 改 `app.env` 或切回上一个提交后重跑 |
| `api` 崩溃 | Docker 重启，客户端断开后自动重连补同步；未确认的文字留在本机 | 无需操作 |
| `worker` 停止 | 写日记不受影响，Google 副本和链接预览暂停，恢复后续传 | 看日志，重启 |
| Caddy 重载或重启 | WebSocket 断开，客户端重连 | 无需操作 |
| R2 不可用 | 归档失败，WAL 暂存在磁盘；当天 Healthchecks 报失败 | 修好后自动补传；时间长要看磁盘 |
| 磁盘写满 | PostgreSQL 写入失败，界面不显示"已保存" | 清理磁盘后重启 |
| 服务器损坏 | 服务中断 | 走恢复手册，新机器恢复到 `latest`，改 DNS 或换服务器 |

## 不变量

1. 生产 `api` 和 `worker` 以 `NODE_ENV=production`、`AUTH_PROVIDER=google` 运行。
2. 未设 `POSTGRES_PASSWORD` 时，生产 compose 拒绝启动，不会回落到 `local-dev-only`。
3. 生产 compose 里只有 `postgres` 发布宿主机端口，且只绑 `127.0.0.1`。
4. `postgres` 不在 `between_pages_proxy` 网络上，Caddy 无法直连数据库。
5. 生产站点的 `/api/*` 只转给 API，其余只转给 web，不经过 Authelia。
6. 生产的 compose 项目名和数据卷名与开发环境不同。
7. 迁移失败时，新版 `api` 和 `worker` 不启动。
8. web 容器对未知路径返回 `index.html`，`index.html` 不被长期缓存。
9. 密钥只存放在 `/etc/between-pages`，不进镜像、不进仓库、不进日志。
10. 请求日志不包含查询串。
11. 写入真实日记之前，生产库已完成首次备份和一次演练。

## 备选方案

| 方案 | 优势 | 否决理由 |
| --- | --- | --- |
| **Fly、Render 等托管平台** | 不用管机器，自带 HTTPS 和部署 | 要另付费，WAL-G 的 `archive_command` 和宿主机演练都要重写，违背依据 3、7；现有服务器已能承载 |
| **Neon、Supabase 等托管 PostgreSQL** | 备份和时间点恢复由对方负责 | 日记明文存到第三方，违背依据 1；已写好并测试的加密备份用不上，违背依据 3 |
| **直接把开发库当生产库** | 最省事，现有数据不用动 | 开发环境的 `docker compose down -v` 就能删掉真实日记，密码写在仓库里，违背依据 1、4 |
| **Caddy 直接发前端文件** | 少一个容器 | 要给 Caddy 加挂载并重建容器，所有站点一起中断，违背依据 2；每次更新还要改它的目录 |
| **API 用 `@fastify/static` 发前端文件** | 一个进程管全部 | 加依赖，也让 API 多一项职责，违背依据 7 |
| **宿主机 systemd 跑 API，不用 Docker** | 少一层容器，日志直接进 journal | 服务器默认 Node 是 24，要和开发环境共用 nvm；Caddy 在容器里连不到宿主机的 `127.0.0.1`，要另开通路，违背依据 2 |
| **所有服务放一个网络** | 少几行配置 | Caddy 能直连数据库，多一个暴露面；多写一个网络几乎没有成本，违背依据 1 |
| **CI 合并后自动部署** | 更新不用登录服务器 | Ray 要先验过才上线；还得把服务器凭据交给 CI，违背依据 1 |
| **新开一台专用服务器** | 与开发工具彻底隔离 | 要多付费，也要重搭 HTTPS，违背依据 2、7；作为下面风险的退路保留 |

## 风险与代价

- **生产和开发在同一台机器**：`ubuntu` 用户有 Docker 权限和免密 sudo，这台机器上以它运行的所有进程，包括 AI 编程工具，实际上都能读到生产库和密钥。root 600 只防普通误操作。Ray 于 2026-11-05 确认接受这一风险。缓解：生产目录和数据都与开发分开，开发工作不进入 `~/volumes/between-pages`；开始写真实日记后，如果担心这一点，再迁到专用服务器。
- **Cloudflare 能看到明文**：HTTPS 在 Cloudflare 边缘解密，再加密转发到源站，所以日记正文、登录 cookie 和 OAuth 回调都经过它的内存。备份的加密管不到这一段。服务器的其他站点也一样，不走代理就要放开源站锁，影响其他六个站点并暴露服务器 IP。Ray 于 2026-11-05 决定继续走代理。
- **Cloudflare 可能断开空闲的 WebSocket**：协议没有心跳，没人写字时连接上没有流量。客户端约 1 秒后重连并补齐内容，写入不会丢。状态行只看保存结果，所以空闲时断开用户看不出来；只有恰好在重连期间写字，才会短暂显示“暂时无法同步，已保存在本机”。Cloudflare 文档查到的超时数字不一致，以上线时实测为准；如果影响使用，再给协议加心跳。
- **单点**：一台服务器坏了，服务就中断，靠恢复手册在新机器上恢复，备份和恢复时间由演练保证。
- **没有可用性告警**：Healthchecks 只盯备份，API 挂了不会主动通知，要靠自己发现或看 beszel。两个人使用先接受。
- **更新时有几秒中断**：所有连接断开，客户端自动重连。迁移期间旧版 API 还在运行，迁移如果不兼容旧版，这几秒里的写入可能报错，但不会误报"已保存"。
- **Caddy 用 `latest`**：它的升级可能影响这个站点，这属于服务器运维，本文不改。
- **未设内容安全策略（CSP）**：心愿链接的预览图来自外部，策略要先梳理，首版不加。

## 未解决的问题

- **上线的内容**：默认是 Ray 确认过的 main 提交。#76–#79 的共享页面在修完已知缺口并合并后，按 D9 正常更新上线。
- **WAL 的实际用量**：`archive_timeout` 保持 60 秒，真实写作一段时间后按 server-backup-and-google-docs 的要求实测 R2 占用。

## 落地顺序

**阶段 1：配置（AI，一个 PR）**

新增 `ops/deploy/`：`Dockerfile`、`Dockerfile.web`、`web.Caddyfile`、`compose.production.yaml`、`up.sh`、`app.env.example` 和 `README.md`（部署手册、Caddy 站点配置、Ray 的逐步操作），并在仓库根目录新增 `.dockerignore`。同一个 PR 实现 D8 的请求日志，更新 `ops/backup` 的示例与手册。

完成条件：本地用测试密钥构建两个镜像，在一个临时 compose 项目里跑通迁移、`api`、`worker`、`web`，用 `docker compose config` 的结果和请求测试覆盖不变量 2–4、6–8、10。

**阶段 2：账号与密钥（Ray）**

| 步骤 | 谁做 | 做完后 AI 检查什么 |
| --- | --- | --- |
| 1. 子域名 `missu.ruihaozhang.com` 走 Cloudflare 代理（DNS 记录已于 2026-11-05 配好） | Ray | 已解析到 Cloudflare；上线后不再返回 525 |
| 2. 按 `ops/backup/README.md` 准备 R2、Healthchecks 和备份加密密钥 | Ray | 示例里的每个变量都有值（只查变量名） |
| 3. 生成其余密钥，写入 `/etc/between-pages/` | Ray | 文件权限；不读取内容 |
| 4. 按 D10 配置 Google 并发布 | Ray | 回调地址与本文一致（看截图） |

**阶段 3：上线（Ray 确认后，AI 或 Ray 执行）**

1. 克隆到 `~/volumes/between-pages`，建 `between_pages_proxy` 网络，`sudo ops/deploy/up.sh`：确认归档成功，表已建好。
2. 按 `ops/backup/README.md` 做首次备份，装定时器，演练一次。
3. 把 Caddy 接入网络，加站点，`caddy reload`：其他站点不受影响，HTTPS 证书签发成功。
4. 做认证 ADR 阶段 4 的真实 Google 联调（第 1–6 步）。
5. 两个账号绑定，一起写一篇日记，连接 Google Drive。

**阶段 4：发布前补做（路线图阶段 4 已列出）**

空环境恢复演练、真实输入法与剪贴板验证、书页手动验收、Google 副本清单。

**自主实现约定**：预先批准新增 `ops/deploy/` 目录、把它加进 `checks/modules.json`、在 AGENTS.md 的 Layout 表和 architecture.md 的模块表各加一行。不新增 npm 依赖。服务器上的任何改动（`~/volumes/between-pages`、`/etc/between-pages`、Caddy、Docker 网络）都要 Ray 确认后才做。不读取、不输出 `/etc/between-pages` 里的值。

## 验收标准

- 从空数据卷开始，一条 `sudo ops/deploy/up.sh` 把全部服务跑起来，第二次运行时数据不变、迁移跳过。
- 不设 `POSTGRES_PASSWORD` 时，compose 报错并拒绝启动。
- 从公网访问 `https://missu.ruihaozhang.com/days/2026-11-05` 能进入应用，`/api/health` 返回 200；公网和 `between_pages_proxy` 上都连不到数据库。
- 登录回调请求之后，日志里没有 `code=`、`state=`。
- 其他 6 个站点在上线前后都能正常访问。
- 真实 Google 登录通过：cookie 带 `Secure` 和 `__Secure-` 前缀，退出后旧 cookie 返回 401（AUTH-01、AUTH-05）。
- 两个账号同时写同一天的日记，WebSocket 经 Caddy 正常工作，手动断网再恢复后文字不丢。
- `backup ok` 和 `drill ok` 都出现，Healthchecks 两项变绿（RELEASE-04）。
- 打开日记后 10 分钟不操作，WebSocket 仍在线，或断开后自动恢复且内容不丢；再继续写能正常保存。

## 补充信息

- 重新评估条件：出现第二个 API 实例的需求；开始有两人以外的用户；服务器磁盘或内存明显吃紧；对生产数据和开发工具同机不放心时，迁到专用服务器。
- 证据：本文“背景与问题”里的实测，2026-11-05 在这台服务器上完成。
- 相关：[服务器备份手册](../../ops/backup/README.md)、[认证 ADR 的阶段 4](./2026-10-24-authentication-and-sessions.md)。
