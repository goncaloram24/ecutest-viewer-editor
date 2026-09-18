# Example project (generated)

Written by `scripts/gen-example.mjs`; do not edit by hand, run `npm run gen-example` instead.

- `BodyControl.prj` – project with two folders (Lights, Wipers) and one top-level test case.
- `Lights/LowBeam.pkg`, `HighBeam.pkg`, `Indicators.pkg` – blocks, pre/postcondition, loop, if/else, break, read/write/wait.
- `Wipers/WiperSpeed.pkg` – steps without blocks (one implicit `main` case), calculation.
- `Wipers/RainSensor.pkg` – disabled in the project, CRLF line endings, a variable without default value.
- `Lib/PowerOn.pkg` – only reached through package-call steps; starts with a BOM.
- `Diagnostics/ReadDtc.pkg` – smallest test case.
- `Lights\FogLight.pkg` is referenced by the project but deliberately missing (diagnostics demo).
- `gen/test.h` – output of the dummy generator (`node scripts/generate.mjs fixtures/example fixtures/example/gen`).
- `.mcp.json` – MCP server configuration for agents opened in this folder.
