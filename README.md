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
WS_PORT=12345
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
GET  /api/projects/:id
DELETE /api/projects/:id                                  (owner only, cascades)
POST /api/projects/:id/members  { subjectId, role }
DELETE /api/projects/:id/members { subjectId }
GET  /api/projects/:id/members
POST /api/projects/:id/documents { fileId, title }
GET  /api/projects/:id/documents
DELETE /api/projects/:id/documents { fileId }
GET  /api/projects/:id/agent-setup?subjectId=a42&fileId=… → copy-paste agent onboarding
GET  /api/documents/content?projectId&filePath          → { content, contentHash }
PUT  /api/documents/content  { projectId, filePath, content, baseContentHash? }
     → 200 { contentHash }  |  409 { errorCode: "FILE_CONFLICT", currentHash }
POST /api/edits/apply          { projectId, filePath, blocks, editId? }
POST /api/pending-edits        { projectId, fileId, blocks, targetUserId?, description? }
GET  /api/pending-edits?projectId&fileId                  → reviewer's pending queue
DELETE /api/pending-edits      { editId }                                       (reviewer only)
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

## Status

Working:
- Yjs sync (markdown/html) — binary, awareness, offline buffer
- Auth — CatsCo JWT (local verify) + `cc_*` ApiKey via CatsCo introspect
- A2UI bridge — agents patch workspace UI via `POST /api/ui/publish` → SSE
- Project/doc browser — `/` lists projects, creates docs
- Members — owner adds `u{uid}`/`a{uid}` with `viewer|editor` role
- Project/doc delete — cascades via `ON DELETE CASCADE`
- Doc rename — `PATCH /api/projects/:id/documents` updates `fileId`/`title` and moves the storage file
- Editor — CodeMirror + yCollab + awareness carets; autosaves canonical markdown to `/api/documents/content` (2s debounce)
- Offline — `y-indexeddb` mirrors every doc locally; edits survive reload + reconnect
- Preview — source / split / rendered markdown toggle in the editor chrome
- Selection → AI — `⌘K` on a selection pushes it into the omni dock as a queued prompt
- Optimistic concurrency — `baseContentHash` guards the canonical blob; 409 → client re-GETs hash and retries once
- Pending edits — agents `POST /api/pending-edits` with line-number blocks; each row is broadcast via SSE (`pending_edit_changed`), lands in `useEditStore`, renders as inline diff decorations with 保留/撤销 buttons. Accept → `POST /api/edits/apply` pushes into Yjs + marks row applied. Reject → DELETE marks row rejected.
- Agent onboarding — `GET /api/projects/:id/agent-setup` returns copy-pasteable instructions (`connectSumi()` + Y.Text edit API + env vars); UI exposes it from the member panel

Stubbed / missing:
- Agent invocation from the Omni dock — `src/agent-client.ts` is a CLI scaffold; needs a real LLM pipeline
- Snapshot/restore — Redis optional, no version history UI
- Visual diff — `inline-diff-extension` renders pending edits but no accept/reject UI
- Doc delete / rename

## License

MIT
