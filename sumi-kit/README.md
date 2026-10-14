# sumi-kit — Agent Integration Pack

One-shot install that gives any agent runtime (Pi, Claude Code, Codex, Cursor, etc.) a `sumi` CLI plus three skill files it can load.

## What agents get

- **`sumi` CLI** — one Python file, zero deps, works anywhere Python 3.8+ exists
- **3 skills** — `sumi-bootstrap` (auth check) · `sumi-collab` (read/propose edits) · `sumi-onboard` (rendered project prompt)

## Install into your agent

```bash
# From the sumi repo:
python3 sumi-kit/install.py --target-root ~/path/to/my-agent

# Dry-run to preview:
python3 sumi-kit/install.py --target-root . --dry-run
```

Defaults install to:
- CLI → `<target>/bin/sumi` (chmod +x)
- Skills → `<target>/.pi/skills/sumi-*/`

Adjust with `--skills-dest` and `--cli-dest` for your runtime layout.

## XiaoBa-CLI (verified)

XiaoBa loads skills from `<repo>/skills/<name>/SKILL.md` via `gray-matter` + `name/description` frontmatter — which is exactly what our SKILL.md files use. Install once:

```bash
python3 sumi-kit/install.py \
  --target-root ~/Developer/buildsense-ai/XiaoBa-CLI \
  --skills-dest skills \
  --cli-dest bin
```

Then in XiaoBa's agent env:

```bash
export SUMI_BASE_URL="http://localhost:3000"
export SUMI_API_KEY="cc_..."   # the bot's CatsCo ApiKey
./bin/sumi whoami
```

XiaoBa's `catsco skill list` will show the four sumi skills. When a task touches a Sumi doc, the agent reads `sumi-collab/SKILL.md` and picks up the correct command.

## Quick agent setup

```bash
# 1. Install (one time)
python3 sumi-kit/install.py --target-root .

# 2. Configure env
export SUMI_BASE_URL="http://localhost:3000"
export SUMI_API_KEY="cc_..."   # issued by a CatsCo admin for this agent

# 3. Verify
./bin/sumi whoami

# 4. Load skills in your agent — any loader that understands SKILL.md frontmatter will pick them up
```

## What agents should do

| Task | Command / Skill |
|---|---|
| Verify auth | `sumi-bootstrap` → `sumi whoami` |
| Get project context | `sumi-onboard` → `sumi get-onboard-prompt --project prj_x` |
| Read a doc | `sumi-collab` → `sumi read-doc --project prj_x --file ...` |
| Propose an edit (preferred) | `sumi-collab` → `sumi propose-edit --project ... --file ... --blocks '...'` |
| Check pending edits | `sumi-collab` → `sumi pending-status --project ...` |

## Auth modes

| Mode | Env vars | Use when |
|---|---|---|
| ApiKey | `SUMI_API_KEY=cc_*` | Default — agent uses a CatsCo ApiKey |
| JWT | `SUMI_TOKEN=eyJ...` | Rare — agent already has a Sumi session JWT |

## Philosophy

**No MCP.** Agents run wherever they already live (your Pi, Claude Code, Cursor, custom runner). Sumi exposes boring HTTP + WS; the CLI wraps it; skills teach the agent when to call what. The agent's own runtime handles the LLM, the reasoning, the tool-use — Sumi just provides the collaboration surface.

Want realtime bidirectional editing? `sumi connect` prints a y-py sync skeleton you can adapt.
