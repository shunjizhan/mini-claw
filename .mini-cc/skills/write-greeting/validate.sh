#!/usr/bin/env bash
#
# Validate that a write-greeting output file matches one of the two
# expected greeting forms:
#   1. "Hello from mini-claw!"             (default form)
#   2. "Hello, <name>!"                    (named form, name is non-empty)
#
# Exit 0 with a one-line confirmation on stdout when valid.
# Exit non-zero with a diagnostic on stderr otherwise. The skill body
# tells the model to surface the stderr text and stop on non-zero exit.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: validate.sh <path>" >&2
  exit 2
fi

path="$1"

if [[ ! -f "$path" ]]; then
  echo "validate: file does not exist: $path" >&2
  exit 1
fi

content=$(cat "$path")

case "$content" in
  "Hello from mini-claw!")
    echo "validate: ok (default form)"
    exit 0
    ;;
  "Hello, "*"!")
    inner="${content#Hello, }"
    inner="${inner%!}"
    if [[ -n "$inner" ]]; then
      echo "validate: ok (named form: $inner)"
      exit 0
    fi
    ;;
esac

echo "validate: file content does not match expected greeting form" >&2
echo "  expected either 'Hello from mini-claw!' or 'Hello, <name>!'" >&2
echo "  got: $(printf '%q' "$content")" >&2
exit 1
