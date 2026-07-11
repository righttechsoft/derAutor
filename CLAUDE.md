# derAutor

Windows desktop app (Electron + TypeScript) that ghost-writes complete books with AI and exports FB2. The user gives a world description + starting premise; the app interviews them about the world, then runs a fully **hidden** pipeline (story backbone → per-chapter plans → reader prose → whole-book review) and optionally paints style-locked illustrations. **Zero spoilers**: the UI shows only progress metrics until the book is done.

## Commands

- `npm run dev` — electron-vite dev with HMR
- `npm run typecheck` — `tsc --noEmit` for both tsconfig.node.json (main/preload/shared/tests) and tsconfig.web.json (renderer)
- `npm test` — vitest (unit: FB2; e2e: full mock pipeline + kill-and-resume)
- `npm run build` — bundles to `out/` (what `electron .` and the packaged app run)
- `npx electron-builder --win` — NSIS installer + `dist/win-unpacked/`

**RULE: always ask the user to close the running app before `electron-builder` — they run `dist\win-unpacked\derAutor.exe`, which locks `dist\`. Never taskkill it.** Check with `tasklist //FI "IMAGENAME eq derAutor.exe"`.

Mock mode: `MOCK_LLM=1` runs the whole pipeline offline against deterministic fixtures (`src/main/llm/mock.ts`); `MOCK_LLM_DELAY_MS` slows steps for pause/kill tests; `DERAUTOR_FAST_RETRY=1` shrinks engine retry sleeps; `DERAUTOR_DB` overrides the database path.

Runtime files (packaged app): DB `%APPDATA%\der-autor\derautor.db`, log `%APPDATA%\der-autor\logs\derautor.log` (every LLM call with tokens/cost/stop reason, every step, all errors — read this first when debugging).

## Architecture

- **Main process owns everything**: SQLite state (`node:sqlite` built into Electron 43's Node 24 — deliberately NO native modules, so no ABI/rebuild pain), LLM layer, pipeline engine, FB2 export. Renderer (React + zustand) is a thin projection fed by typed IPC.
- `src/shared/ipc-contract.ts` is the single source of truth for IPC. `src/shared/schemas/` holds zod schemas for every structured LLM output.
- `src/main/services/spoilerGate.ts` enforces the spoiler boundary: artifact content is only readable after stage='done' + author's-room unlock (type the exact project title). Issue descriptions never leave main (UI gets counts only). Progress/activity events carry step keys and numbers, never content.
- Electron-free by design (for headless tests): `db/`, `services/settings.ts` (cipher injected from index.ts), `ipc/events.ts` (sink injected), whole pipeline. Only `index.ts`, `handlers.ts`, `saveAs.ts` touch electron.

### Pipeline (src/main/pipeline/)

Stages: `clarify` (interactive interview, IPC-driven, not a job) → `bible` (brief, world bible, characters, outline, style guide) → `chapters` (per chapter: plan → prose → summary+ledger, interleaved so chapter N's plan sees real summaries of N-1) → `review` (whole-book re-read → issues → rewrite flagged chapters → re-summarize; max 3 rounds) → `illustrate` (optional) → `export` (book meta; FB2 assembled on demand at save time) → `done`.

**Checkpointing (engine.ts)**: one LLM/image call ≈ one job keyed by `step_key` (`ch:07:prose`, `review:r2:read:c01`, `img:ch:07`). Artifact + sideEffect + job-done commit in ONE transaction. Resume skips jobs whose stored `input_hash` matches the recomputed hash — hashes must be **deterministic across resume** (e.g. chapter N's ledger input is filtered to entries from chapters < N; review read hashes round+model, NOT book text). `PROMPT_VERSION` in prompts.ts participates in every hash — bump it when changing templates to invalidate old checkpoints. Usage/cost rows are recorded per physical API call the moment it completes (`onUsage` → `makeUsageRecorder`), independent of job success, so retries never lose spend accounting.

Review reads go **chunked** above ~150k estimated tokens (output size is the binding constraint, not context), one checkpoint per 10-chapter chunk + a collect step. Reviewer severity/category are strings normalized on save (strict enums once threw away a whole $1 response over 3 bad fields).

**World reuse (pipeline/worldSeed.ts)**: a new project can continue the world of a finished one (`NewProjectInput.sourceProjectId`, projects column `source_project_id`, no FK). Everything needed from the source (world bible, characters JSON, style guide, raw ledger entries, chapter summaries, image style block, source book title) is snapshotted into ONE `world_seed` artifact **in the same transaction as project creation and never rewritten** — that invariant keeps the seeded/non-seeded branch and every seed-derived hash stable across resume, and makes source deletion harmless. Branch points: clarify (`clarifySequelSystem` + `seedPrefix`), bible (`bible:world` rewrites the bible to the post-previous-book state via `worldBibleUpdateUser`; `bible:characters` carries sheets over via `charactersSequelUser`, same schemaName so mock needs no new fixture; `bible:style` is a checkpointed no-LLM copy when languages match), illustrate (`img:style` copies the seed's style block). Post-world seeded steps use `seedBibleBase` (inherited bible/ledger dropped, premise KEPT — the outline step has no other premise source). Non-seeded hash shapes are byte-identical to before; no `PROMPT_VERSION` bump was needed (new prompt functions only).

### LLM layer (src/main/llm/)

Three providers behind one `LlmProvider` interface (`provider.ts` picks by settings): 
- `anthropic.ts` — API. **Raw streaming everywhere** (`stream:true` iterator for structured, MessageStream for prose): non-streaming times out on big outputs, and the SDK's `parse()`/stream-helper re-parses `output_config.format` JSON and throws away whole responses on truncation. Truncation (stop_reason `max_tokens` or bad JSON) auto-retries with doubled budget (structured cap 64k, prose cap 64k). Model rules: opus-4-6/4-7/4-8 + sonnet-5/4-6 get explicit `thinking:{type:'adaptive'}`; fable-5 must OMIT thinking; pre-4.6 opus and haiku get neither thinking nor effort (400s otherwise). No temperature ever. Prompt cache: `cache_control {type:'ephemeral', ttl:'1h'}` — pipeline steps are 5–15 min apart, the default 5-min TTL always missed.
- `claudeCode.ts` — Agent SDK (`@anthropic-ai/claude-agent-sdk`), bills the user's Claude subscription. `query()` with `maxTurns:1, allowedTools:[], settingSources:[]`, native `outputFormat:{type:'json_schema', schema: z.toJSONSchema(...)}` → `structured_output`. Usage-limit errors are non-retryable by message match in engine.
- `mock.ts` — fixtures dispatch on `schemaName` and parse parameters from the LAST user message only (prompts guarantee phrases there: "exactly N chapters", "approximately N words", "chapter N", "review round N" — keep those intact when editing prompts.ts).

Adaptive thinking shares the `max_tokens` budget with output — size structured budgets generously (review chunks start at 32k).

### Context strategy (contextPack.ts)

Byte-stable cached prefix for every post-bible call: role + world bible + characters + outline + style guide, cache breakpoint on the last block. NO timestamps/UUIDs anywhere in prefixes. Volatile context (summaries, ledger, prev-chapter tail) goes in user messages. Continuity ledger = JSON artifact of established facts, merged programmatically after each chapter summary.

### FB2 (src/main/export/fb2.ts)

xmlbuilder2; xlink namespace mandatory for `<image l:href>`; title-info element order matters (annotation before coverpage before lang); no CDATA; base64 binaries wrapped at 76 cols; UTF-8 no BOM; control chars stripped; markdown-lite (`*em*`, `**strong**`, `***both***`, `<br>`) mapped/sanitized. Author from settings `author_name` (default "Damien Knox") split into first-name/last-name. File built on demand in `saveAs.ts` — no LLM, so re-export picks up settings changes instantly.

## Gotchas

- Version pins: `vite@^7` + `@vitejs/plugin-react@^5` (electron-vite 5 rejects vite 8). TS 6: no `baseUrl` (use relative `paths`). React 19: no global `JSX` namespace.
- The packaged app's userData is `%APPDATA%\der-autor` (package.json `name`), not `derAutor`.
- `updateProject` builds SQL from a typed field allowlist — extend the Pick<> when adding columns.
- OpenAI gpt-image-2 (`openaiImages.ts`): jpeg native output (no sharp), cover = style anchor for all chapter images via `images.edit`. OpenAI's edge throws transient 520/`terminated` — engine retries cover it.
- Tests live under `tests/`; the e2e suite asserts zero duplicate llm_calls after kill-and-resume — any hash instability breaks it first.
