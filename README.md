# Pi Rewind

[简体中文](./README.zh-CN.md)

A git-free rewind extension for [Pi](https://github.com/badlogic/pi-mono) coding agent.

## Commands

- `/rewind` — rewind to any tree node with scope options:
  - conversation + file changes
  - conversation only  
  - file changes only
- `/rewind-undo` — undo the last rewind
- `/rewind-clean` — remove rewind snapshots for current session

## Why

Pi's tree navigation can jump between nodes, but does not natively support "rewind / undo / undo-the-undo" for files in non-git workspaces. This extension fills that gap.

## Install

```bash
pi install https://github.com/jeanchristophe13v/pi-rewind
```

Project-local install:
```bash
pi install https://github.com/jeanchristophe13v/pi-rewind -l
```

Then restart Pi or run `/reload`.

## Usage

- Run `/rewind`, pick a target node, choose rewind scope
- Run `/rewind-undo` to revert the last rewind
- Run `/rewind-clean` to clean session snapshots

## Notes

- Works without git
- Tracks Pi `write` and `edit` tool calls
- Snapshots stored at `.pi/rewind/snapshots/<session-id>/`
- `/rewind` and `/rewind-undo` require interactive mode

## License

MIT
