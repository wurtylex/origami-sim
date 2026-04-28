#!/usr/bin/env python3
"""
svg-to-fold — convert color-encoded crease-pattern SVGs to FOLD files.

This script is a thin Python wrapper around Rabbit Ear (a JavaScript origami
library) running under Node. We use Rabbit Ear because face detection from a
planar graph is tricky to do from scratch, and there's no Python equivalent
with comparable quality.

Color conventions (Rabbit Ear's defaults, also used by Origami Simulator):
  red    → mountain fold
  blue   → valley fold
  black  → boundary / cut
  other  → unassigned

Usage:
  python convert.py pattern.svg               # writes pattern.fold next to it
  python convert.py pattern.svg out.fold      # explicit output path
  python convert.py *.svg                     # batch mode, one .fold per input

Setup (once):
  npm install rabbit-ear
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
NODE_SCRIPT = HERE / "convert.js"


def check_environment() -> None:
    """Bail early with a helpful message if Node or rabbit-ear is missing."""
    if shutil.which("node") is None:
        sys.exit(
            "error: 'node' not found on PATH.\n"
            "Install Node.js from https://nodejs.org or your package manager."
        )

    if not NODE_SCRIPT.exists():
        sys.exit(f"error: missing {NODE_SCRIPT.name} next to this script.")

    # Rabbit Ear can be installed in this folder OR globally. Check both.
    local = HERE / "node_modules" / "rabbit-ear"
    if local.exists():
        return

    # Try global — `node -e "require('rabbit-ear')"` exits 0 if found anywhere.
    probe = subprocess.run(
        ["node", "-e", "require('rabbit-ear')"],
        capture_output=True,
        cwd=HERE,
    )
    if probe.returncode != 0:
        sys.exit(
            "error: rabbit-ear not installed.\n"
            f"Run:  cd {HERE} && npm install rabbit-ear"
        )


def convert_one(svg_path: Path, out_path: Path) -> None:
    """Run convert.js with svg_path on stdin and out_path receiving stdout."""
    svg_text = svg_path.read_bytes()

    result = subprocess.run(
        ["node", str(NODE_SCRIPT)],
        input=svg_text,
        capture_output=True,
        cwd=HERE,
    )

    if result.returncode != 0:
        # Surface Node's stderr so the user sees the real error
        sys.stderr.write(result.stderr.decode("utf-8", errors="replace"))
        sys.exit(f"error: conversion failed for {svg_path}")

    out_path.write_bytes(result.stdout)
    print(f"  {svg_path}  →  {out_path}")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Convert color-encoded SVG crease patterns to FOLD files.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split("Usage:", 1)[1] if "Usage:" in (__doc__ or "") else "",
    )
    p.add_argument("inputs", nargs="+", type=Path, help="One or more .svg files")
    p.add_argument(
        "-o", "--output",
        type=Path,
        help="Output path (only valid with a single input). "
             "If omitted, writes alongside each input with a .fold extension.",
    )
    return p.parse_args()


def main() -> None:
    args = parse_args()
    check_environment()

    if args.output and len(args.inputs) > 1:
        sys.exit("error: --output cannot be used with multiple inputs.")

    for svg_path in args.inputs:
        if not svg_path.exists():
            sys.exit(f"error: {svg_path} does not exist")
        if svg_path.suffix.lower() != ".svg":
            print(f"warning: {svg_path} doesn't have a .svg extension", file=sys.stderr)

        out_path = args.output if args.output else svg_path.with_suffix(".fold")
        convert_one(svg_path, out_path)


if __name__ == "__main__":
    main()
