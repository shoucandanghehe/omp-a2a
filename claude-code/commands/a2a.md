---
description: omp-a2a status, connection, Projects, and history
argument-hint: "[status | connect <project> [--as <name>] | disconnect | peers | project list|create|delete <name> | history [--before <ref>|--after <ref>] [--limit <n>] [--from <name>]]"
---

The user ran `/a2a $ARGUMENTS`.

- If the arguments start with `history`, call the omp-a2a `a2a_history` tool with the matching `before`, `after`, `limit` (integer), and `from` options.
- Otherwise call the omp-a2a `a2a_control` tool with `command` set exactly to `$ARGUMENTS` (use `status` when empty).

Show the tool result to the user as-is and take no further action.
