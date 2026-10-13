# Sumi

Real-time collaborative markdown/html editor substrate. Yjs sync + CatsCo SSO + agent-driven UI patches (A2UI).

Built for multi-actor collaboration — humans and bots share the same document surface with presence, edit locks, and structured UI commands.

## Stack

- **Frontend** — Next.js 15 + React 19 + Tailwind 4 + zustand + CodeMirror 6 + y-codemirror.next
- **Sync** — self-hosted `y-websocket` server, optional Redis persistence
- **Identity** — CatsCo SSO (JWT for humans, `cc_*` ApiKey for agents)
- **Event bus** — SSE → declarative UI patches
- **Persistence** — `node:sqlite` (subjects cache, projects, memberships, docs)

## What's inside

```
app/                          Next.js App Router
├── api/auth/me               whoami
├── api/projects              create / list
├── api/projects/[id]/{members,documents}
├── api/documents/content     persisted read/write
├── api/edits/apply           apply pending edit → ws-server
├── api/ui/events             SSE stream
├── api/ui/publish            emit UiPatch (internal)
├── layout.tsx + page.tsx + globals.css
components/
├── workspace-shell.tsx       Canvas + dim + floating omni dock
└── editor/
    ├── collaborative-editor.tsx
    ├── inline-diff-extension.ts
    ├── pending-edit-lock-extension.ts
    └── markdown-extensions.ts
stores/                       zustand — ui-store + edit-store
lib/                          hooks, http-auth, utils
src/                          portable substrate
├── server/ws-server.ts       Yjs WS + HTTP admin surface
├── server/yjs-persistence.ts Redis list-per-doc
├── server/edit-position-tracker.ts  RelPos math
├── auth/{catsco,actor,identity}.ts
├── a2ui/{schema,validate}.ts
├── ui-bus/{event-bus,sse-handler}.ts
├── storage/                  local FS
├── db/                       sqlite migrations
└── agent-client.ts           connectSumi() for external CLIs
tests/                        vitest + e2e scripts
```

## Identity model

Two principals, both minted by CatsCo:

| Principal | Credential | Resolution |
|---|---|---|
| **User** | `Bearer` JWT or `?token=` | verified locally with `OC_JWT_SECRET` |
| **Agent** | `ApiKey cc_*` or `?api_key=` | introspected via `POST /api/account/introspect` |

Sumi caches resolved subjects (`u{uid}` / `a{uid}`) so memberships have a stable key.

```bash
OC_JWT_SECRET=…             # shared with cats-company
CATSCO_BASE_URL=…
CATSCO_SERVICE_TOKEN=…      # scope: account.introspect
INTERNAL_API_SECRET=…       # /admin, /replace, /clear, /ui/publish
WS_PORT=1234
```

## Connect an agent

```ts
import { connectSumi } from "sumi/agent-client";

const conn = await connectSumi({
  wsUrl: "wss://sumi.example.com",
  apiKey: process.env.CATSCO_API_KEY,
  projectId: "prj_xxx",
  fileId: "notes/intro.md",
  displayName: "my-agent",
});

conn.ytext.insert(0, "hello\n");
conn.provider.awareness.setLocalStateField("vibeWriting", "notes/intro.md");
conn.close();
```

Raw URL form: `wss://sumi.example.com/prj_xxx-notes%2Fintro.md?api_key=cc_…`

## REST API

```
GET  /api/auth/me
POST /api/projects              { name }
GET  /api/projects
POST /api/projects/:id/members  { subjectId, role }
DELETE /api/projects/:id/members { subjectId }
GET  /api/projects/:id/members
POST /api/projects/:id/documents { fileId, title }
GET  /api/projects/:id/documents
GET  /api/documents/content?projectId&filePath
PUT  /api/documents/content  { projectId, filePath, content }
POST /api/edits/apply          { projectId, filePath, blocks }
POST /api/ui/publish           { userId, projectId, patch }
GET  /api/ui/events                                  → SSE
```

WS server mutating routes require `x-internal-secret`. Room naming: `{projectId}-{fileId}`.

## Quick start

```bash
pnpm install

# Terminal 1: Yjs server
OC_JWT_SECRET=… CATSCO_BASE_URL=… CATSCO_SERVICE_TOKEN=… \
INTERNAL_API_SECRET=… pnpm ws-server

# Terminal 2: Next.js
pnpm dev
```

Sign in at `/` with a CatsCo JWT, then open `?doc={projectId}-{fileId}`.

## License

MIT
