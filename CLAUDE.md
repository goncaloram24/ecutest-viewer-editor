# Working in this repository

ECU-TEST Viewer & Editor: VS Code extension + CLI + MCP server over one shared core. Read README.md for the
addressing scheme and design notes.

## Rules

- `src/core/` stays free of `vscode`: it is shared by the extension, the CLI, the MCP server and the tests.
  VS Code specific code lives in `src/extension.ts` and `src/vscode/`.
- Never use a DOM or re-serialise XML. All changes to `.prj`/`.pkg` files are `TextEdit`s at recorded offsets
  (`src/core/ops.ts` → `EditPlan`).
- New capabilities go into the command table `src/core/api.ts` so the CLI and MCP server stay identical; expose
  them in the extension too or document them as UI-only in README.md.
- Never call `output.show()` from a reload or watcher path (only the `ecutest.showOutput` command may).
- Do NOT read or grep `.prj`/`.pkg` files directly; use the MCP tools (`ecutest_*`, configured in `.mcp.json`) or
  the CLI: `node dist/cli.js --root fixtures/example info`.
  Typical flow: `info` → `tree` → `get` / `describe` → `schema` → edit (`set`, `add-step`, … with `--dry-run` first).
- `fixtures/example` is generated: change `scripts/gen-example.mjs` and run `npm run gen-example`, never edit it by hand.

## Build and test

```
npm install
npm run build         # esbuild: dist/extension.js, dist/cli.js, dist/mcp.js, dist/core.js
npm run typecheck
npm test              # vitest against fixtures/example (+ samples/ when fetched); builds first
npm run fetch-samples # optional real-world ECU-TEST files (see samples/SOURCES.md)
npm run bundle        # typecheck + build + vsix + release zip
```

Tests that write files must work on a temp copy (`withCopy` in `test/helpers.ts`), cleaned up in `finally`.
