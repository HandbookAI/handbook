# Examples

Two offline scripts, both powered by the bundled mock LLM server — **no API key needed**.
The mock is repo-agnostic: stages are derived from the analyzed repo's directories and
every file is assigned by directory match, so the handbook STRUCTURE always mirrors the
real codebase. The PROSE, however, is canned placeholder text — the mock is a contract
stub, not a language model. For real narration, point `OPENAI_*` at a real endpoint.

## 1. Fixture demo — `run-demo.sh`

```bash
bash examples/run-demo.sh
```

Runs the complete toolchain against `demo-project/` (a tiny bundled Python + TypeScript +
Shell repo — NOT this monorepo; that's why its handbook mentions `app/main.py` etc.).

## 2. Self handbook — `run-self.sh`

```bash
bash examples/run-self.sh
```

Generates this monorepo's own handbook from `packages/` — open
`examples/work/self/handbook/html/overview.html` to browse the real package/file/function
structure (with mock prose).

Steps performed: `analyze` → `generate --phase 2,3 --detail deep` → `render --html
--html-single --agent-site` → `skill` → `validate`. Outputs land in `examples/work/demo/`:

- `handbook/overview.md`, `index.md`, `register.md`, `stage-*.md` — the markdown handbook
- `handbook/html/overview.html` — the multi-page HTML site
- `handbook/handbook.html` — the single-file site
- `handbook/agent/` — the agent locator index
- `skill/` — the packaged SKILL (validated with content-hash coverage)

## Using the mock server directly

```bash
node examples/mock-llm-server.mjs 8090 &
export OPENAI_BASE_URL=http://127.0.0.1:8090/v1 OPENAI_API_KEY=EMPTY
node packages/cli/dist/main.js generate --source <repo> --work work/x --phase 2,3
```

The mock recognizes each pipeline prompt by its instruction header and answers with
schema-correct, prompt-derived JSON — useful for CI and for developing new pipeline
passes without spending tokens. It is intentionally *not* a language model: prose
quality in its output is canned.
