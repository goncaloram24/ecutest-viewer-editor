# ECU-TEST Viewer & Editor

Navigate and edit tracetronic ECU-TEST (ecu.test) **projects (`.prj`)** and **packages (`.pkg`)** without opening
ECU-TEST. Both file types are XML and feed a generator that emits `test.h` files with the test-case functions
run by PC-based platform tests. One shared core serves three surfaces:

| Surface | For | Entry point |
|---|---|---|
| VS Code extension | humans: tree, visual editor, description panel | `dist/extension.js` |
| CLI | scripts and humans | `node dist/cli.js --root <dir> <command>` |
| MCP server (stdio) | LLM agents (Claude Code, …) | `node dist/mcp.js --root <dir>` |

The CLI and the MCP server are generated from one command table (`src/core/api.ts`), so they always have
identical capabilities; the extension exposes the same operations as commands, context menus and the visual editor.

## Addressing scheme

Every element has a stable **path**. Paths are the only argument type; file names are never used
(except by `add-package` / `new-project`, which create files).

```
/<project name>                                     the .prj (file name without extension)
/<project name>/<package path relative to prj>      a referenced .pkg (forward slashes, no extension)
/<project>/<package>/<step|parameter|mapping name>  inside the package, nested steps add more segments
<path>/@<FIELD or attribute>                        one field (leaf XML element) or attribute of an element
```

- Packages are always addressed directly below their project, whatever project folder they sit in:
  `/BodyControl/Lights/LowBeam` is `Lights\LowBeam.pkg`. Project folders are `/BodyControl/<folder name>`.
- Blocks are named by their title; other steps by their type (`TsWait`, `TsLoop`), read/write steps by
  type + mapping (`tsWrite LightSwitch`). Generic XML elements use their tag (`METRIC`, `ASSIGNMENT[param]`).
- Names that are not unique among siblings get `#2`, `#3`, …: `/…/TsLoop/TsWait#2`.
- `/` inside a name is written `%2F`, `#` as `%23`. Lookup is case-insensitive as a fallback.
- Packages that are only reached through package-call steps are listed below the project too (kind `package`).
- `search` returns paths; `tree` prints the last segment of every child so paths can be built by appending.

## CLI

```
npm install && npm run build
node dist/cli.js --root fixtures/example info
node dist/cli.js --root fixtures/example tree /BodyControl/Lights/LowBeam --depth 2
node dist/cli.js --root fixtures/example get "/BodyControl/Lights/LowBeam/Switch on" --depth 1
node dist/cli.js --root fixtures/example search IGN_STATE
node dist/cli.js --root fixtures/example schema /BodyControl/Lights/LowBeam
node dist/cli.js --root fixtures/example describe /BodyControl/Lights/LowBeam/LightSwitch
node dist/cli.js --root fixtures/example generate-preview "/BodyControl/Lights/LowBeam/Switch on"
node dist/cli.js --root fixtures/example --generated-dir gen diff

node dist/cli.js --root <dir> set /P/Pkg/settleTime 1.5 --dry-run        # prints the text edits only
node dist/cli.js --root <dir> set /P/Pkg/@ENABLED False
node dist/cli.js --root <dir> add-step "/P/Pkg/My block" TsWait --value 2 --after "/P/Pkg/My block/tsWrite X"
node dist/cli.js --root <dir> add-step /P/Pkg TsIfThenElse --value 'speed >= 10'
node dist/cli.js --root <dir> add-param /P/Pkg retries 3 --direction in
node dist/cli.js --root <dir> add-package /P Body/NewTest.pkg --name "New test"
node dist/cli.js --root <dir> rename /P/Pkg/settleTime settle_s          # also updates references in the package
node dist/cli.js --root <dir> move "/P/Pkg/Block B" --before "/P/Pkg/Block A"
node dist/cli.js --root <dir> delete "/P/Pkg/Block B"
node dist/cli.js --root <dir> new-project Smoke.prj
```

Global options: `--root <dir>` (default: cwd), `--project <name>` (restrict to one project),
`--generated-dir <dir>`, `--project-glob <glob>`, `--package-base-dirs a,b`, `--json`, `--help`.
All write commands accept `--dry-run` and are validated against the schema first.

## MCP tools

Start with `node dist/mcp.js --root <dir> [--generated-dir <dir>] [--project <name>]`. The server reloads the
files on every call, so it never serves stale data. Its instructions tell agents: start with `ecutest_info`,
navigate with `ecutest_tree`/`ecutest_search`, read with `ecutest_get`, check `ecutest_schema` before adding,
never edit the XML text directly.

| CLI command | MCP tool | Writes | Purpose |
|---|---|---|---|
| `info` | `ecutest_info` | no | START HERE. Lists the loaded projects, their packages (with paths), element counts and diagnostics such as missing packages. |
| `tree` | `ecutest_tree` | no | Navigate: prints the element tree below a path, one line per element ("segment [type] = value"). Append a segment to the parent path to address a child. |
| `get` | `ecutest_get` | no | Read one element as compact JSON: kind, type, name, value, fields, attributes, children and source file:line. |
| `search` | `ecutest_search` | no | Find elements by text (name, value, step type, field content or exact step id). Returns paths to use with the other tools. |
| `schema` | `ecutest_schema` | no | What is allowed at a path: step types that can be added, editable value/fields/attributes with their types and allowed values, and the operations that apply. Check this before adding or setting. |
| `describe` | `ecutest_describe` | no | Plain-language explanation of an element: what it does in ECU-TEST, allowed values, which test.h function it becomes and where it is referenced. |
| `generate-preview` | `ecutest_generate_preview` | no | Preview the C functions (void TC_<package>_<case>(void), with step skeleton) that the test.h generator emits for a project, package or block. |
| `diff` | `ecutest_diff` | no | Compare the current model with an existing generated test.h folder: functions that are missing, changed or no longer produced, with the path of the responsible element. |
| `set` | `ecutest_set_value` | yes | Set the value of an element (parameter default, wait time, comment text, loop count, written value, ...) or of one field/attribute via <path>/@NAME. Validated against the schema. |
| `add-step` | `ecutest_add_step` | yes | Add a test step to a package or container step (block, loop, Then/Else, case). Call schema on the parent first to see allowed types and what name/value mean for each type. |
| `add-param` | `ecutest_add_param` | yes | Add a variable to a package: a parameter (in), a return value (out) or a local variable, with a default value whose type is inferred. |
| `add-package` | `ecutest_add_package` | yes | Reference a package from a project (or project folder). Creates a minimal valid .pkg if the file does not exist yet. This is the only place a file name is used: it is relative to the project folder. |
| `rename` | `ecutest_rename` | yes | Rename a block, parameter/variable, mapping, folder or package test case. Renaming a variable or mapping also updates the references inside its package. |
| `delete` | `ecutest_delete` | yes | Delete an element (step with its children, parameter, mapping, folder, or a package reference; .pkg files are never deleted). |
| `move` | `ecutest_move` | yes | Reorder or re-parent an element: place it after (or before) another element of the same kind in the same file, e.g. a step after another step. |
| `new-project` | `ecutest_new_project` | yes | Create a new empty project file. The file name is relative to the root; afterwards it is addressed as /<file name without .prj>. |

A `.mcp.json` at the repo root points Claude Code at `dist/mcp.js --root fixtures/example`. In VS Code, the
command **ECU-TEST: Set Up MCP Server for Agents** writes one for your workspace.

## VS Code extension

- Activity bar container **ECU-TEST** with the views **Tests** (projects → folders/packages → parameters,
  mappings, steps) and **Description** (explanation of the selected element with clickable references).
- Badges: `!` missing package / problem, `G` generated `test.h` differs (when `ecutest.showGenerated` is on),
  `·` on ancestors.
- **Visual editor** (click an element): editable value, fields and attributes; the complete content below the
  element as a collapsible outline (variables, mappings, nested steps) with inline value editing, add / delete /
  move; navigation bar with back/forward, parent, first child, siblings
  (Alt+←/→, Alt+↑, Alt+↓, Alt+Shift+↑/↓), *Open source* (jumps to file:line) and *Reveal in tree*.
- Edits are applied as one undo-able `WorkspaceEdit` and saved. A file with unsaved manual changes is never edited.
- The output channel **ECU-TEST** logs every load; it is never revealed automatically. Problems raise one
  non-modal warning per distinct message with a **Show output** button.

| Setting | Default | Meaning |
|---|---|---|
| `ecutest.projectGlob` | `**/*.prj` | Where to look for projects |
| `ecutest.project` | `""` | Restrict to one project (name or relative path) |
| `ecutest.generatedDir` | `gen` | Folder with generated `test.h`, used by diff and the generated view |
| `ecutest.showGenerated` | `false` | Badges for outdated generated code, generated code in the Description view |
| `ecutest.packageBaseDirs` | `[]` | Extra folders for resolving package references |
| `ecutest.ignoreGlobs` | node_modules, .git, build, out, dist, gen, TestReports | Ignored during discovery |
| `ecutest.openInEditor` | `true` | Click opens the visual editor (off: jump to source) |
| `ecutest.focusOnStartup` | `false` | Focus the ECU-TEST view on startup |
| `ecutest.startupPath` | `""` | Element opened in the visual editor on startup |

UI-only features: the visual editor's navigation history, tree badges and `copyJson`/`reveal`/`setupMcp`.
Everything else is reachable from all three surfaces.

## Project discovery

Root = `--root` or the workspace folder. Projects are found with the glob. Every `packageTest` component
references a package (`PACKAGE-REF/PACKAGE-PATH`, Windows separators); references are resolved against, in order:
the project's folder, the root, `packageBaseDirs`, and every `Packages` folder at or above the project folder,
even above the opened root (ECU-TEST's workspace convention; this makes opening a sub folder of the workspace work).
A package referenced several times by one project is indexed once per reference (`/P/Mod/UT`, `/P/Mod/UT#2`), so
every reference shows the full contents; edits go to the one shared file. Absolute paths from another machine are matched by their longest existing
suffix. Packages called by `tsPackage` steps with a literal path are loaded as well. Missing packages become
diagnostics (`info`, tree badge), never errors. There is no variants-file mechanism.

## The test.h model (dummy generator)

`scripts/generate.mjs <root> [<out>]` is a stand-in for the real generator and defines what `generate-preview`,
`describe` and `diff` assume: for every **enabled** package test case, each **top-level block** becomes
`void TC_<package>_<block title>(void)`; steps outside blocks form `TC_<package>_main`; precondition and
postcondition blocks are emitted into every case. Each function carries a `/* @case <path> … */` header listing
its steps; `diff` matches functions by name and reports `missing`, `changed` and `extra` with the responsible path.

## Design notes

- **No DOM, no re-serialisation.** `parser.ts` scans the XML text once with a tag stack. Leaf elements are folded
  into their parent as *fields*; elements with structure become nodes. Every node records `start`/`end`, the
  inner content range, `line`, `file`; every value records the exact range of its text or attribute value.
- **Edits are text replacements at those offsets** (`TextEdit { file, start, end, text }`). Everything else in the
  file stays byte-identical, so ECU-TEST can reopen the files and git diffs are minimal. Offsets are string
  offsets into the text without BOM, the same coordinates VS Code uses; a BOM and CRLF line endings are
  preserved, XML entities are decoded/encoded, inserted XML copies the sibling's indentation (tabs or spaces).
- **Unknown elements are never dropped**: anything not recognised is shown generically (tag, attributes, fields)
  and is still editable through `<path>/@FIELD`.
- **Malformed input never crashes**: problems become diagnostics with `file:line` and loading continues.
- `src/core` has no `vscode` import; it is shared by the extension, CLI, MCP server and the tests.
- `src/core/api.ts` (one file more than the original architecture sketch) holds the shared command table.

## Element model and assumptions

The model was derived from 61 real files (ECU-TEST 8.1 … ecu.test 2026.2) found in public repositories, see
`samples/SOURCES.md`. Only the MIT-licensed tracetronic samples are committed; `npm run fetch-samples` downloads
the rest for local testing (`test/samples.test.ts` parses all of them, references each from a project and
verifies that edits change nothing else).

Assumptions to verify against your own files and ECU-TEST version:

- New steps are written in the shape observed in the samples (attribute order, `format-rev`, utility UUIDs, UUID
  or integer ids following the file's convention, block titles as `en_US` I18N text). Open a package edited by
  this tool in ECU-TEST once to confirm your version accepts them.
- Expressions entered through `add-step` are limited to a literal, a variable, or `<operand> <operator> <operand>`.
  Existing complex expressions are displayed (`isinstance(summary, list)`) and their parts stay editable.
- A parameter's new value must match its declared type; variables without a literal default get a `value`
  default with an inferred type (integer, float, boolean `True`/`False`, string). Files that carry `TEXTDATA`
  next to `DATA` (2025+) get both updated.
- `add-package` writes the reference relative to the ECU-TEST `Packages` folder when the project lives in such a
  workspace, else relative to the project folder.
- No sample sets package parameters at project level or references test configurations; such elements are shown
  generically.
- The real `test.h` generator is not available here; adapt `src/core/generate.ts` to its naming rules.

## Development

```
npm install
npm run build          # four esbuild bundles: extension, cli, mcp, core
npm run typecheck
npm test               # vitest (builds first); MCP server is tested end to end over stdio
npm run gen-example    # regenerate fixtures/example and its gen/test.h deterministically
npm run fetch-samples  # optional: real-world samples for test/samples.test.ts
npm run package        # .vsix
npm run bundle         # release/ecutest-viewer-editor-<version>.zip
```
