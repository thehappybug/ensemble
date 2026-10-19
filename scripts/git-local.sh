#!/bin/sh
# Only needed in the coding sandbox where .git is mounted read-only.
exec git --git-dir="$(dirname "$0")/../.ensemble-git" --work-tree="$(dirname "$0")/.." "$@"
