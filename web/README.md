# Sumi — Solid 2 + ui-sdk 重做

原 Next.js 15 + React 19 前端已由这套取代。后端从 Next App Router 换成 Hono，路由处理器一行未改。

## 结构

```
web/     Solid 2 + ui-sdk 前端（Vite）
server/  Hono 单进程：挂 23 个既有 route、发静态、透传 WS 升级
app/     原有 API 路由，现在由 server/ 直接 import，不再由 Next 提供
src/     Yjs、SSO、存储、事件总线，未改动
```

## 跑起来

```bash
pnpm --dir web install && pnpm --dir web build
pnpm --dir server install
SUMI_DATA_DIR=/tmp/sumi-data APP_PORT=8794 WS_PORT=1234 \
  npx --dir server tsx src/main.ts
```

`server` 需要与 `ws-server` 同进程组之外各自运行：Hono 只做静态与 API，协同仍走 `src/server/ws-server.ts`，`server` 把 WS 升级透传给它的端口。

## 与旧实现的行为差异

- **A2UI 下线。** `@json-render/*` 只支持 solid-js ^1.9，在 Solid 2 下没有官方支持。Agent 改为经 ui-sdk 的 `agent` / `observe` 直接读写页面组件，不再下发 spec JSON。
- **无 SSR。** 首屏由浏览器渲染。需要时用 `@solidjs/web` 的 `renderToStream` 补，不必上 SolidStart（0.3.11 仍锁 solid-js ^1.8.4）。
- **Y.Text 键名是 `content`。** ws-server 的 seed、`/doc`、`/replace`、待审编辑应用都读这个键；用别的键能正常同步，但服务端看不到。

## 验证

`scripts/e2e-solid.ts` 起隔离数据目录 + 自签 JWT，跑 22 项：HTTP 契约 11 项、浏览器 11 项，覆盖渲染、文件树、编辑器挂载、Yjs 落盘、页签切换、大纲、无控制台报错。

```bash
cd server && npx tsx ../scripts/e2e-solid.ts
```

## 尚未做

- 生产仍在跑旧的 Next 前端（8794），新前端未切换上线。
- 后端 `app/api` 目录仍留在 Next 的目录约定下，只是由 Hono 加载；真要彻底脱离，下一步是把它们搬到 `server/src/routes/`。
