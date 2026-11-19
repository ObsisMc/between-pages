# between-pages

个人项目，不接受使用或贡献请求。

## 当前状态

更新日期：2026-11-19。进度见 [docs/roadmap.md](./docs/roadmap.md)。

## 本地开发

需要 Node.js 26（见 `.nvmrc`）和 Docker：

```sh
nvm use && npm ci
cp .env.example .env
npm run db:up && npm run db:migrate
npm run dev:oidc
npm run dev:api
npm run dev:web
```

检查命令见 [AGENTS.md](./AGENTS.md#commands)，文档索引见 [docs/README.md](./docs/README.md)。
