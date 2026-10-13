# Sumi

Collaborative markdown/html editor substrate, distilled from `~/Developer/paperanim`. Yjs sync engine + CatsCo-driven identity + A2UI event bus.

## Stack

- **Frontend**: Next.js 15 + React 19 + Tailwind 4 + zustand + CodeMirror 6 + y-codemirror.next
- **Sync**: self-hosted `y-websocket` server with optional Redis persistence
- **Auth**: **CatsCo SSO** — JWT (users) + `cc_*` ApiKey (bots/agents), no local user DB
- **Events**: SSE → `applyUiPatch`
- **Persistence**: `node:sqlite` for Sumi-local projections (subjects cache, projects, memberships, docs)

## Identity model

Sumi does not store users or passwords. Two principals, both minted by cats-company:

| Principal | Credential | Resolution |
|---|---|---|
| **User** | CatsCo JWT (`Bearer` or `?token=`) | verified locally with shared `OC_JWT_SECRET` |
| **Agent / Bot** | CatsCo ApiKey (`ApiKey cc_*` or `?api_key=`) | introspected via CatsCo `POST /api/account/introspect` |

Sumi caches subjects in `subjects` (subject_id = `u{uid}` / `a{uid}`) so project_members has a stable foreign key.

### Required env

```bash
OC_JWT_SECRET=…             # must match cats-company's secret
CATSCO_BASE_URL=http://localhost:8080
CATSCO_SERVICE_TOKEN=cats_svc_…   # service token w/ account.introspect scope
WS_PORT=1234
INTERNAL_API_SECRET=…       # for /replace /clear /admin + ui/publish
```

## For humans

1. Grab a JWT from cats-company (`GenerateToken` or `GeneratePersistentUserToken` for desktop).
2. Paste into the Sumi sign-in screen — stored in `sessionStorage`.
3. Editor + SSE send it as `?token=` / `Authorization: Bearer`.

## For XiaoBa-CLI (agents)

Use your existing `cc_*` ApiKey — no new credential needed:

```ts
import { connectSumi } from "sumi/xiaoba";

const conn = await connectSumi({
  wsUrl: "wss://sumi.example.com",
  apiKey: process.env.CATSCO_API_KEY,     // cc_…
  projectId: "prj_xxx",
  fileId: "notes/intro.md",
  displayName: "xiaoba",
});

conn.ytext.insert(0, "# hello\n");
conn.provider.awareness.setLocalStateField("vibeWriting", "notes/intro.md");
conn.close();
```

Or hit the raw URL:

```
wss://sumi.example.com/prj_xxx-notes%2Fintro.md?api_key=cc_…
```

## REST API

```
GET  /api/auth/me                                  → current actor

POST /api/projects              { name }           (human JWT only)
GET  /api/projects                                 → projects I can see
POST /api/projects/:id/members  { subjectId, role }
DELETE /api/projects/:id/members { subjectId }
GET  /api/projects/:id/members

POST /api/projects/:id/documents { fileId, title }
GET  /api/projects/:id/documents

GET  /api/documents/content?projectId&filePath
PUT  /api/documents/content  { projectId, filePath, content }

POST /api/edits/apply          { projectId, filePath, blocks }
                                                     → applies via ws-server

POST /api/ui/publish           { userId, projectId, patch }
GET  /api/ui/events                                  → SSE stream
```

## WS endpoints (unchanged from earlier pass)

`x-internal-secret` required for mutating routes. Doc rooms are `{projectId}-{fileId}`; connection requires either `?token=<jwt>` or `?api_key=<cc_…>` plus a `project_members` row.

## Tests

```bash
pnpm test            # 21 unit tests
pnpm typecheck
pnpm build

# E2E auth — seeded sqlite + mocked introspect
SUMI_DATA_DIR=/tmp/x WS_PORT=12346 pnpm ws-server &
SUMI_DATA_DIR=/tmp/x WS_PORT=12346 node tests/e2e-auth.mjs
```

## Not included

- CatsCo's own login UI — Sumi expects a JWT produced elsewhere
- Magic-link / password — CatsCo owns that
- SSO providers — CatsCo owns that too
- Agent runtime / LLM — transport only, AI is XiaoBa's job
