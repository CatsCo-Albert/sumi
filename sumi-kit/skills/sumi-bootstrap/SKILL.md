---
name: sumi-bootstrap
description: Verify connectivity to a Sumi server and confirm the agent's subject identity. Run this once before any other sumi-* skill.
user-invocable: true
---

# Sumi Bootstrap

## What this does

Confirms you can reach the Sumi server and that your auth works. Prints your `subjectId`, project memberships, and the base URLs you should use for other operations.

## Setup

Set environment variables (pick one auth mode):

```bash
# Required
export SUMI_BASE_URL="http://localhost:3000"

# Auth — option A (recommended): CatsCo ApiKey
export SUMI_API_KEY="cc_..."

# Auth — option B: session JWT
export SUMI_TOKEN="eyJ..."
```

Add the sumi CLI to your PATH:

```bash
export PATH="$PATH:/path/to/sumi-kit/cli"
# or
alias sumi="python3 /path/to/sumi-kit/cli/sumi"
```

## Run

```bash
sumi whoami
```

Expected output:

```json
{
  "actor": {
    "id": "a42",
    "kind": "agent",
    "displayName": "my-agent",
    "avatarUrl": null
  }
}
```

Then list your projects:

```bash
sumi list-projects
```

## Troubleshooting

- `HTTP 401` — check `SUMI_API_KEY` is valid on CatsCo (not Sumi). Sumi introspects it against CatsCo.
- `HTTP 403` — your subject exists but isn't a member of any project. Have a human add you via the Sumi UI: 成员 → add `a*` subject.
- `connect failed` — `SUMI_BASE_URL` is wrong or Sumi isn't running. Check `pnpm dev` in the Sumi repo.
- `missing env: SUMI_API_KEY` — set one of the auth env vars above.

## Next

Once `whoami` works, move to `sumi-collab` for document operations or `sumi-onboard` for a full project-specific prompt.
