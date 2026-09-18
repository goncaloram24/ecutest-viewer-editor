# ECU-TEST Viewer & Editor – installation

## Contents of the release zip

```
ecutest-viewer-editor-<version>.vsix   VS Code extension (includes the MCP server and the CLI)
tools/mcp.js                           MCP server (stdio) for LLM agents, no VS Code needed
tools/cli.js                           command line interface
tools/core.js, tools/generate.mjs      shared core and the dummy test.h generator
example/                               example project with .mcp.json (points at ../tools/mcp.js) and gen/test.h
README.md, INSTALL.md, LICENSE
```

Requirements: Node.js 18+ for the tools, VS Code 1.90+ for the extension.

## VS Code extension

```
code --install-extension ecutest-viewer-editor-<version>.vsix
```

Open a folder that contains a `.prj` file; the **ECU-TEST** icon appears in the activity bar.
Useful settings (`ecutest.*`): `projectGlob`, `project`, `packageBaseDirs` (if package references are relative
to a folder the tool cannot guess), `generatedDir` + `showGenerated` (compare with generated `test.h`),
`openInEditor`, `focusOnStartup`, `startupPath`, `ignoreGlobs`.

## MCP server for Claude Code and other agents

Easiest: run the VS Code command **ECU-TEST: Set Up MCP Server for Agents (.mcp.json)**. It writes a `.mcp.json`
into the workspace that references the MCP server inside the installed extension by absolute path.

Manually, put this `.mcp.json` next to your projects (adjust the paths):

```json
{
  "mcpServers": {
    "ecutest": {
      "command": "node",
      "args": ["/absolute/path/to/tools/mcp.js", "--root", "/absolute/path/to/workspace", "--generated-dir", "gen"]
    }
  }
}
```

Try it with the example: `cd example && claude` – the agent gets the `ecutest_*` tools immediately.

## CLI without the extension

```
node tools/cli.js --root example info
node tools/cli.js --root example tree --depth 3
node tools/cli.js --root example set /BodyControl/Lights/LowBeam/settleTime 1.5 --dry-run
node tools/cli.js --help
node tools/generate.mjs example example/gen        # dummy test.h generator
node tools/cli.js --root example --generated-dir gen diff
```

Elements are addressed by paths such as `/BodyControl/Lights/LowBeam/Switch on`, never by file names;
see README.md for the scheme and the full command list.
