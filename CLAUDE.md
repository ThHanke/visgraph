# Project Guidelines

## Documentation

After adding or changing any user-facing feature, always check whether `README.md` needs updating. Ask: does this change affect setup, UI behaviour, URL parameters, MCP tools, or AI integration? If yes, update the relevant README section and keep the Table of Contents in sync.

## Demo videos

See [docs/demo-scripts/HOWTO.md](docs/demo-scripts/HOWTO.md) when recording or creating demo videos.

## OWUI relay sessions

See [docs/owui-relay-session.md](docs/owui-relay-session.md) for the full session setup guide (MCP browser tabs, auth, startup sequence, format enforcement, debug checklist).

## Background task output

Never write background task output to `/tmp`. Always tee to `logs/` in the repo:

```bash
some-long-running-command 2>&1 | tee logs/<descriptive-name>.log
```

Use a fixed, descriptive name (not timestamped) so the file is easy to find and `tail -f` works naturally. The `logs/` directory is git-ignored. Check `logs/` before `/tmp` when looking for recent run output.

## Documented Solutions

`docs/solutions/` — solutions to past problems (bugs, architecture patterns, workflow practices), organized by category with YAML frontmatter (`module`, `tags`, `problem_type`). Relevant when implementing or debugging in documented areas.
