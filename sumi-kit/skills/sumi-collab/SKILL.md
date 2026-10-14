---
name: sumi-collab
description: Read and propose edits to a Sumi document. Use for all document reads, proposals for structural changes, and pending-edit status queries.
user-invocable: true
---

# Sumi Collaboration

## Golden rule

**Structural changes go through `propose-edit` — never write the whole file directly.** Humans review your diff inline in the Sumi editor (Keep/Reject per block, or Ctrl+Shift+Y for all).

Direct full-document writes (`PUT /api/documents/content`) are reserved for brand-new files or explicit human instruction.

## Common operations

### Co-edit a file locally (recommended for long sessions)

```bash
sumi co-edit --project prj_x --file notes/intro.md --local /tmp/work.md
# local ↔ remote syncs every 2s — you read/write /tmp/work.md,
# Sumi turns every save into a pending-edit proposal
```

**When to use co-edit vs propose-edit:**
- `co-edit` — you want a live read-write copy on disk, iterate locally, push changes as pending edits
- `propose-edit` — one-shot targeted change; you compute the diff yourself

`co-edit` initial pull: if `--local` is empty, remote fills it; if `--local` has content, it pushes once as a pending edit. Then it polls every `--interval` seconds (default 2) in both directions.

### Read a document

```bash
sumi read-doc --project prj_x --file notes/intro.md
sumi read-doc --project prj_x --file notes/intro.md --raw   # just the text
```

The `content` field is the live collaborative text (Yjs-resolved). It includes pending edits marked with `{{SUGGESTED:...}}` placeholders? No — pending edits are not yet applied; they exist only as proposals. `read-doc` gives you the baseline; `list-pending` gives you the proposals.

### Propose an edit (preferred for all changes)

```bash
sumi propose-edit --project prj_x --file notes/intro.md \
  --blocks '[{"startLine": 3, "endLine": 5, "updated": "## Introduction\n\nNew text here."}]' \
  --desc "rewrite intro to mention Sumi"
```

Each block is `{startLine, endLine, updated}` — 1-based inclusive lines to replace. Sumi attaches RelPos anchors automatically, so your edit stays anchored even if the human types elsewhere first.

You get back the created `PendingEdit` rows. Human reviewers see them as inline diffs in the editor.

### Check pending status

```bash
sumi list-pending --project prj_x
sumi pending-status --project prj_x     # one-line summary per block
```

Status values: `pending` | `applying` | `applied` | `rejected`

### Subscribe to live updates (recommended for long-running agents)

```bash
sumi watch --project prj_x              # SSE stream, auto-reconnect
sumi watch --project prj_x --compact    # drop ping frames
sumi watch --project prj_x --json       # pretty-printed JSON
```

Emits `ui_patch` events. Useful `patch.type` values:
- `pending_edit_changed` — a human/agent proposed, applied, or rejected an edit
- `doc_renamed`, `member_changed`, etc.

Keep the process alive in a background shell while you work; check `list-pending` for the full state when you wake up — SSE is a notification, not a ledger.

### Apply or reject (usually human-only)

```bash
sumi apply-edit --id pe_abc
sumi reject-edit --id pe_abc
```

Agents rarely need these — the point of pending edits is human review.

### List projects and members

```bash
sumi list-projects
sumi list-members --project prj_x
```

Look for other `a*` subjects — those are agents like you. `u*` subjects are humans.

## Shadow drafts —— 私密草稿区

Shadow docs let you iterate privately **before** anything becomes a pending edit. Nothing lands in the doc, nothing enters Yjs, no locks — just a scratch area keyed to `(project, file, you)`.

```bash
sumi shadows --project prj_x                          # everyone's drafts in the project
sumi shadows --project prj_x --mine                   # only yours
sumi shadow-create --project prj_x --file notes/intro.md \
  --from-file /tmp/draft.md --title "formal rewrite v1"
echo "draft text" | sumi shadow-create --project prj_x --file notes/intro.md
sumi shadow-promote --id shadow_xxx                   # → pending_edit for human review
sumi shadow-discard --id shadow_xxx                   # drop it
```

Use shadows when:
- **Comparing variants** — create 2-3 shadows, read them back, promote only the best
- **Multi-step work** — draft intermediate results; promote one final proposal instead of spamming the review queue
- **Answering an intent** — put the draft in shadow, reply with the shadow id, promote after feedback

Promotion diffs the shadow against the doc snapshot (or current file) and creates block-level pending edits — the human sees the same Keep/Reject inline diff as a normal `propose-edit`. `status` moves `draft → promoted` (or `discarded`).

## RelPos anchors (why propose-edit is safe)

When you propose `{startLine:3, endLine:5}`, Sumi converts those to `RelativePosition` — CRDT-stable IDs that track text even if lines shift above. If a human types a paragraph at the top before approving, your edit still lands on the right block. You never need to re-fetch-and-recompute.

## When to use which

- **Typo fix, single line** → `propose-edit` with one block
- **Restructure a section** → `propose-edit` with 1-3 blocks, `--desc` explaining the change
- **Brand-new section / new file** → `propose-edit` if doc exists; ask a human to create the file if it doesn't (or use `PUT /api/documents/content` with empty base if you're sure)
- **Many small typo fixes** → batch them into one `propose-edit` call with multiple blocks — one review pass for the human
- **Just reading / analyzing** → `read-doc`, don't propose

## Anti-patterns

- ❌ Don't `PUT /api/documents/content` to "fix a typo" — bypasses review
- ❌ Don't propose the same edit twice — check `list-pending` first
- ❌ Don't propose an edit to lines you haven't verified via `read-doc` — you may patch stale content
- ❌ Don't batch unrelated changes in one proposal — humans review per-proposal
