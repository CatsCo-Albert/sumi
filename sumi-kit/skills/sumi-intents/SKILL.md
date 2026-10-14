---
name: sumi-intents
description: Handle "ask an agent" intents from humans — poll open intents targeted at you, claim them, answer with text or a pending-edit, and keep threads going.
---

# Sumi Intents

Intents are how humans ask you to do something. Each is anchored to a doc + optional line selection, may be targeted at you specifically (`targetAgentId`), and may chain into threads for multi-turn work.

## Lifecycle

```
open ──(you PATCH claimed)──> claimed ──(you PATCH answered)──> answered
   └───────────────────────────────────────────> closed  (author-only)
```

- **open** — fresh, unclaimed. If `targetAgentId` is set, only that agent should claim it; otherwise any `a*` member can.
- **claimed** — you've acknowledged you're working. Other agents see it as taken.
- **answered** — your response is on file (text or pending_edit link). Thread stays open for follow-up.
- **closed** — author or project owner marked done. Don't touch.

## Discover intents

```bash
# All open intents in a project
sumi intents --project prj_x --status open --compact

# Just the ones aimed at you
sumi intents --project prj_x --status open --mine --compact

# Follow an existing thread
sumi intents --project prj_x --thread thr_abc123 --compact
```

Or stream live via `sumi watch --project prj_x` — `intent_created` events arrive as they happen.

## Work on one

```bash
# 1. Claim — marks it taken, blocks other agents
sumi claim-intent --id int_abc123

# 2. Read the document + selection
sumi read-doc --project prj_x --file notes/intro.md --raw

# 3. Work (your runtime does this — thinking, drafting, etc.)

# 4a. Answer with plain text (Q&A, comments)
sumi answer-intent --id int_abc123 --text "改完了，主要是把被动语态换成了主动。"

# 4b. Answer with a pending-edit (preferred for doc changes)
sumi propose-edit --project prj_x --file notes/intro.md \
  --blocks '[{"startLine":5,"endLine":8,"updated":"..."}]' \
  --desc "formalize tone per intent int_abc123"
# (capture the edit id from the output)
sumi answer-intent --id int_abc123 --edit edit_xyz --text "我把第 5-8 段改成了更正式的口吻 — 请审阅 pending diff"
```

## Follow-up

If the intent should become a conversation, create a follow-up with the same `threadId`:

```bash
sumi create-intent --project prj_x --file notes/intro.md \
  --prompt "再改一下第 10 行，把'我们'改成'本研究'" \
  --thread thr_abc123
```

## Rules

- ✅ Always `claim` before answering — prevents double-claiming when multiple agents are present
- ✅ If you can't do it, `answer-intent --text "做不到，因为…"` — better than silence
- ✅ Link pending_edits via `--edit` so the reviewer sees the diff + your explanation together
- ❌ Don't `claim` unless you're actually going to answer — a claimed-but-silent intent blocks others
- ❌ Don't answer an intent that targets a different `targetAgentId`
- ❌ Don't propose edits unrelated to the prompt — keep each answer scoped

## Anti-patterns

- ❌ `claim-intent` then forget — humans see "claimed" and wait forever. If you're stuck, close it or answer with an explanation.
- ❌ Answering without reading the doc — your edit won't land on the right lines.
- ❌ Creating a new intent instead of answering — intents are for asking, not for status updates.
