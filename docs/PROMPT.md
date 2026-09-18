# Build "ECU-TEST Viewer & Editor": VS Code extension + CLI + MCP server

You are starting in an empty git repository. Build a complete, working, tested tool for navigating and editing
tracetronic ECU-TEST test projects (`.prj`) and packages (`.pkg`). Both file types are XML. They are consumed by a
generator that emits `test.h` files containing the test-case functions run by PC-based platform tests.
The tool must serve two audiences with the same core:

1. Humans, through a VS Code extension (tree, visual editor, description panel).
2. LLM agents, through an MCP server (stdio) and a CLI with identical capabilities.

Work autonomously end to end: scaffold, implement, generate an example project, write tests, run them, package,
and commit. Do not stop to ask questions; make sensible assumptions, state them in the README, and keep going.
When a real sample `.prj`/`.pkg` is present in the repo (look for `samples/`), derive the element model from it.
If no samples exist, build the model from public knowledge of the ECU-TEST format and design the parser so that
unknown elements are still displayed generically (tag name + attributes + text) instead of being dropped.

## Architecture (copy this exactly)

```
src/core/         pure TypeScript, NO `vscode` import anywhere (shared by extension, CLI, MCP, tests)
  model.ts        node types, spans, file index
  parser.ts       single-pass streaming XML indexer with byte offsets (see "Parsing")
  workspace.ts    loads a set of files, builds the merged tree + path index, reloadFile()
  project.ts      project discovery: find .prj files under a root, resolve the packages they reference
  schema.ts       what is allowed where (inferred from samples + built-in rules), used to validate edits
  describe.ts     human explanation of an element (what it is, allowed values, where used)
  ops.ts          high-level editing operations producing TextEdit[] (validated)
  edit.ts         TextEdit { file, start, end, text } + apply to a string
  generate.ts     the test.h generation model: which packages/steps become which C functions
  diff.ts         compare current model with a generated/built output folder
  json.ts         compact JSON views for CLI/MCP
src/index.ts      re-exports core (bundled to dist/core.js for scripts)
src/cli.ts        CLI over core (bundled to dist/cli.js, #!/usr/bin/env node)
src/mcp.ts        MCP server over core (bundled to dist/mcp.js), @modelcontextprotocol/sdk + zod
src/extension.ts  VS Code activation, command registration
src/vscode/       modelService.ts (owns loaded model, watchers, output channel), treeProvider.ts,
                  editorPanel.ts (webview visual editor), descriptionView.ts (webview)
media/            editor.css, editor.js, description.css (webview assets)
scripts/          gen-example.mjs (deterministic example project), generate.mjs (dummy test.h generator using dist/core.js),
                  bundle.mjs (release zip)
fixtures/example/ generated example project (committed), with a .mcp.json pointing at dist/mcp.js
test/             vitest: core.test.ts, ops.test.ts, mcp.test.ts (run against fixtures/example)
```

Tooling: TypeScript 5, esbuild (four bundles: extension cjs with `vscode` external, cli, mcp, core; node18 target,
sourcemaps), vitest, `@vscode/vsce` for packaging. `package.json` scripts:
`build`, `watch`, `typecheck` (tsc --noEmit), `test` (vitest run, with `pretest: npm run build`),
`package` (typecheck + build + vsce package --allow-missing-repository --readme-path INSTALL.md), `bundle`.
Runtime dependencies only `@modelcontextprotocol/sdk` and `zod`. Node 18+, VS Code ^1.90.

## Parsing (important design rule)

Do not use a DOM and do not re-serialise. Scan the XML text once, keep a tag stack, and materialise nodes only
for elements that matter for navigation and editing. Record for every node: `start`/`end` offsets of the element,
`valueSpan` (offset range of the editable text or attribute value), spans of structural child sections where
insertions go, `line`, and `file`. All edits are text replacements at those offsets, applied through VS Code's
WorkspaceEdit (undo-able) in the extension and through fs in CLI/MCP. This keeps ECU-TEST able to reopen the
files and keeps git diffs minimal. Decode/encode XML entities. Handle CRLF, BOM, and attribute-vs-element values.
Preserve indentation when inserting (copy the indentation of the sibling before the insertion point).

## Addressing scheme

Every element has a stable path usable as an argument by humans and LLMs. Use:

```
/<project name>                                   the .prj
/<project name>/<package path relative to prj>    a referenced .pkg (use forward slashes, no extension)
/<project>/<package>/<step|parameter|mapping name or ordinal>   inside the package
```

Rules: paths are the single argument type across CLI/MCP; never file paths. Provide a `search` that returns
paths. Where names are not unique, append `#<n>`. Document the scheme in README and in every MCP tool description.

## Project discovery

Root = the folder given with `--root` (CLI/MCP) or the workspace folder (extension). Find `.prj` files
(configurable glob, default `**/*.prj`, ignoring `node_modules`, `.git`, build/output folders). Each `.prj`
references packages; resolve them relative to the `.prj` folder, then the root, then configurable base folders.
Missing packages must be reported as diagnostics, never crash. There is NO variants-file mechanism in this
project; do not invent one. If several `.prj` exist, all are loaded and shown as separate roots; `--project`
/ setting `ecutest.project` restricts to one.

## Capabilities (identical across CLI and MCP; the extension exposes them as commands/context menus)

Read: `info` (projects, packages loaded, counts, diagnostics), `tree <path> --depth n` (one line per node,
"name = value" for parameters/attributes), `get <path> --depth n` (compact JSON incl. file:line), `search <text>`,
`schema <path>` (allowed children/attributes/values), `describe <path>` (plain-language explanation: what the
element does in ECU-TEST, allowed values, which test.h function it becomes, where it is referenced),
`generate-preview <path>` (the C function signature(s)/body skeleton that the test.h generator would emit for a
package or project), `diff <generated dir>` (compare the model with an existing generated test.h folder).

Write (all validated against schema, all with `--dry-run` returning the edits): `set <path> <value>`,
`add-step <parent> <type> [--after <path>]`, `add-param <package> <name> <value>`, `add-package <project> <file>`
(creates a minimal valid .pkg and references it from the .prj), `rename <path> <name>`, `delete <path>`,
`move <path> --after <path>` (reorder steps), `new-project <file>`.

MCP tools are named `ecutest_info`, `ecutest_tree`, `ecutest_get`, `ecutest_search`, `ecutest_schema`,
`ecutest_describe`, `ecutest_generate_preview`, `ecutest_diff`, `ecutest_set_value`, `ecutest_add_step`,
`ecutest_add_param`, `ecutest_add_package`, `ecutest_rename`, `ecutest_delete`, `ecutest_move`,
`ecutest_new_project`. Give every tool a description that tells an agent when to use it and the argument format
(paths, not files). The server takes `--root <dir>` and optional `--generated-dir <dir>`. Server instructions
must say: start with info, navigate with tree/search, read with get, check schema before adding, never edit the
XML text directly.

## VS Code extension

- Activity bar container "ECU-TEST" with two views: **Tests** (tree: projects → packages → steps/params) and
  **Description** (webview showing `describe` output for the selected node, with clickable links to referenced paths).
- Tree badges for diagnostics (missing package, invalid value) and for nodes that differ from the generated output.
- Visual editor webview (open on click, configurable): shows the node, its attributes/values as editable fields,
  children as a list with add/delete/move, a navigation bar (back/forward, parent, siblings, first child,
  Alt+arrow shortcuts), and an "Open source" action that jumps to file:line.
- Commands: refresh, showOutput, search, open, reveal (in tree), revealInSource, copyJson, setValue, addStep,
  addParam, addPackage, rename, delete, move, newProject, describe, toggleGeneratedView, setupMcp
  (writes a `.mcp.json` into the workspace pointing at the bundled MCP server with the correct `--root`).
- Settings (prefix `ecutest.`): `projectGlob`, `project`, `generatedDir`, `showGenerated`, `packageBaseDirs`,
  `ignoreGlobs`, `openInEditor`, `focusOnStartup`, `startupPath`.
- File watcher on `**/*.{prj,pkg}` plus onDidSaveTextDocument, debounced 300 ms. A changed `.pkg` that is already
  loaded is re-indexed alone; a `.prj` change reloads the project. Ignore saves of any other file type.
- Output channel "ECU-TEST" logs every load: files, counts, diagnostics. NEVER call `output.show()` automatically
  from a reload or watcher; it steals the panel from the user's terminal. Report problems once per distinct
  message with a non-modal warning notification that has a "Show output" button. Only the explicit
  showOutput command reveals the panel.
- Activation: `workspaceContains:**/*.prj`. Optional env `ECUTEST_DEV_COMMANDS="cmd1,cmd2"` executed 6 s after
  activation, for automated UI testing.
- The extension is packaged with the MCP server inside; `setupMcp` must reference the installed extension's
  `dist/mcp.js` by absolute path.

## Example project and dummy generator

`scripts/gen-example.mjs` deterministically writes `fixtures/example/`: one `.prj` referencing 6–10 `.pkg` files
in a couple of subfolders (with parameters, several step types, one package referencing another, one
deliberately missing reference for diagnostics), plus a README describing it. `scripts/generate.mjs` is a dummy
stand-in for the real test.h generator: it uses `dist/core.js` to emit `gen/test.h` with one C function per
test case (`void TC_<package>_<case>(void)`), with a comment header listing the steps. `diff` compares against
it. Regenerate the example as part of the build docs.

## Tests

vitest against `fixtures/example`: parsing offsets round-trip (applying an edit and re-parsing yields the
expected value and nothing else changed), project discovery and missing-package diagnostics, path addressing
and search, schema validation rejecting bad values, every ops function (dry-run edits and applied edits in a
temp copy, cleaned up in try/finally), generate preview, diff, and the MCP server end to end over stdio
(spawn dist/mcp.js, call each tool once). Tests must pass with `npm test` from a clean clone.

## Docs and release

- `README.md`: purpose, addressing scheme, CLI usage with examples, MCP tools table, settings table, design notes
  (offset edits, no DOM, no re-serialisation).
- `INSTALL.md`: contents of the release zip, installing the .vsix (`code --install-extension`), settings,
  `.mcp.json` snippet for Claude Code, CLI usage without the extension.
- `CLAUDE.md` (for agents working in this repo): the "core stays free of vscode" rule, how to build/test,
  and the instruction "Do NOT read or grep .prj/.pkg files directly; use the MCP tools or the CLI
  (`node dist/cli.js --root fixtures/example info`)", with the typical flow info → tree → get → schema → edit.
- `scripts/bundle.mjs`: typecheck, build, vsce package, copy `dist/{mcp,cli,core}.js` + `scripts/generate.mjs`
  to `tools/`, copy the example (with a `.mcp.json` re-pointed at `../tools/mcp.js`), INSTALL.md, README.md, then
  `zip -r release/ecutest-viewer-editor-<version>.zip`.
- `.mcp.json` at the repo root pointing at `dist/mcp.js --root fixtures/example`, so Claude Code in this repo gets
  the tools immediately.

## Quality bar and process

- Small, focused modules; total core under ~3k lines. No dead code, no TODO placeholders.
- Every feature reachable from all three surfaces (extension, CLI, MCP) or explicitly documented as UI-only.
- Never crash on malformed input: collect diagnostics with file:line and keep going.
- Commit in logical steps with clear messages. Finish with `npm run typecheck && npm test && npm run bundle` all
  green, and report what was built, what was assumed, and what should be verified against real ECU-TEST files.
