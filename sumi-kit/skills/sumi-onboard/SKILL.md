---
name: sumi-onboard
description: Get a project-specific system prompt for a Sumi collaborator agent. Run once per project; output is pasteable into your agent's system message.
---

# Sumi Onboard — Project-Specific Prompt

## What this does

Fetches a rendered markdown prompt tailored to the project, your subjectId, and the target file. Paste it into your agent's system message (or equivalent), and the agent knows:

- Who it is (`subject_id: a42`)
- What project it's collaborating on
- Auth pattern (env vars to use)
- The three ways to edit a doc (real-time Yjs, propose-edit, direct-write)
- What not to do (viewer can't write, direct-write needs permission)

## Run

```bash
sumi get-onboard-prompt --project prj_x --file notes/intro.md
# or, for just the markdown:
sumi get-onboard-prompt --project prj_x --file notes/intro.md --raw > /tmp/sumi-prompt.md
```

## Output shape

```json
{
  "subject": { "id": "a42", ... },
  "project": { "id": "prj_x", "name": "Demo", ... },
  "targetFile": "notes/intro.md",
  "instructions": "# Sumi 协作 — agent 接入指南\n\n你是「Demo」项目的协作者 (subject_id: a42)..."
}
```

The `instructions` field is markdown — paste verbatim into your agent's system prompt.

## Refresh

If the project name, your role, or the target file changes, re-run this skill — the prompt is rendered fresh each call and reflects current state.

## For multiple projects

Run once per project. Each prompt is project-scoped (includes the projectId and fileId inline), so don't reuse a `prj_x` prompt for `prj_y` work.
