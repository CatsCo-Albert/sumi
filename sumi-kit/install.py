#!/usr/bin/env python3
"""
Install sumi-cli + sumi-* skills into a target agent repo.

Usage:
  python3 install.py [--target-root .] [--skills-dest .pi/skills] [--cli-dest bin]

For Pi-style layouts (skills in .pi/skills/, CLI in PATH):
  python3 install.py --target-root ~/my-agent

For pi-style layouts (skills in .pi/skills):
  python3 install.py --target-root . --skills-dest .pi/skills

For Claude Code-style layouts (.claude/skills):
  python3 install.py --target-root . --skills-dest .claude/skills
"""

from __future__ import annotations

import argparse
import os
import shutil
import stat
from pathlib import Path

IGNORE_DIRS = {"__pycache__", ".git"}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--target-root", default=".", help="Agent repo root")
    p.add_argument("--skills-dest", default=".pi/skills", help="Where to drop sumi-* skills")
    p.add_argument("--cli-dest", default="bin", help="Where to drop the `sumi` executable")
    p.add_argument("--dry-run", action="store_true")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    target_root = Path(args.target_root).expanduser().resolve()
    kit_root = Path(__file__).resolve().parent

    if not target_root.exists():
        raise SystemExit(f"target root missing: {target_root}")

    src_skills = kit_root / "skills"
    src_cli = kit_root / "cli" / "sumi"

    if not src_skills.exists() or not src_cli.exists():
        raise SystemExit("sumi-kit incomplete — need skills/ and cli/sumi")

    skills_dest = target_root / args.skills_dest
    cli_dest = target_root / args.cli_dest / "sumi"

    copied = []

    for skill_dir in sorted(src_skills.iterdir()):
        if not skill_dir.is_dir() or skill_dir.name in IGNORE_DIRS:
            continue
        dst_dir = skills_dest / skill_dir.name
        if args.dry_run:
            print(f"[dry-run] cp -r {skill_dir} {dst_dir}")
        else:
            shutil.copytree(skill_dir, dst_dir, dirs_exist_ok=True)
        copied.append(f"skill:{skill_dir.name}")

    if args.dry_run:
        print(f"[dry-run] cp {src_cli} {cli_dest}")
        print(f"[dry-run] chmod +x {cli_dest}")
    else:
        cli_dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src_cli, cli_dest)
        cli_dest.chmod(cli_dest.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    copied.append(f"cli:sumi")

    print(f"installed: {len(copied)} items")
    for c in copied:
        print(f"  - {c}")
    print()
    print(f"Next:")
    print(f"  - add {cli_dest.parent} to your agent's PATH (or invoke {cli_dest} directly)")
    print(f"  - ensure your agent loader scans {skills_dest}")
    print(f"  - export SUMI_BASE_URL + SUMI_API_KEY in your agent's env")


if __name__ == "__main__":
    main()
