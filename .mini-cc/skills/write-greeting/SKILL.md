---
name: write-greeting
description: Write a greeting to a file at a caller-specified path.
when_to_use: The user asks you to create a greeting file or to use the "write-greeting" skill.
---

# write-greeting

You have been invoked with the following arguments: `$ARGUMENTS`

Your job is to use the `Write` tool to create a text file. The caller may
pass arguments in either of two forms:

1. Just a file path (e.g. `/tmp/hello.txt`) — write the exact text
   `Hello from mini-claw!` into it (no trailing whitespace, no extra lines).

2. A path followed by a name (e.g. `/tmp/hello.txt Alice`) — write the exact
   text `Hello, Alice!` into it.

After Write succeeds, validate the result by running this via the Bash tool:

  bash "$SKILL_DIR/validate.sh" "<the path you wrote>"

If validate.sh exits zero, respond with a single short sentence confirming
what you wrote and where. Do not quote the file contents back.

If validate.sh exits non-zero, report the diagnostic it printed on stderr
and stop. Do not retry, do not edit the file.

Allowed tools: `Write`, `Bash`. Do not call any other tools. Do not create
directories. If the parent directory does not exist, let the Write tool's
error surface and report it.
