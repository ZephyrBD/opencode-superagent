# AGENTS.md

Research prototype of a proactive coding agent for one GitHub repository, packaged as a bundle (cordis plugin set) for DeepSeek Harness (DSH). Domain concepts (Trigger, Ticket, Mandate, Session, Source, Policy) are defined in `docs/001-domain.md`; `docs/007-architecture.md` is the developer code index.

## Commands

- Install: `pnpm install` (pnpm@11.7.0; Node `^22.19.0 || >=24.0.0`).
- Full verification: `pnpm check` = `pnpm typecheck && pnpm test && pnpm build` (tsdown → `lib/`).
- Single test file: `pnpm vitest run tests/policy.spec.ts` (only `tests/**/*.spec.{ts,tsx}` are picked up).
- Typecheck only: `pnpm typecheck` (`tsc --noEmit`).

## TypeScript conventions

- ESM with `NodeNext`; relative imports use explicit `.ts` extensions (rewritten at build time).
- `strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`: use `import type` for types and handle possibly-undefined index access.
- Config schemas use zod `.strict()` objects (see `src/sources/github.ts`).

## Docs and locale are tested

Several tests fail when related files are inconsistent — update them together:

- `tests/docs.spec.ts`: docs must be numbered consecutively from `000-`, all relative links in `README.md`/`SETUP.md`/`docs/*.md` must resolve, and files referenced in the tables of `docs/007-architecture.md` must exist.
- `tests/class-docs.spec.ts`: class/interface doc comments must match expectations (keep JSDoc on core classes in sync).
- `tests/locales.spec.ts` / `tests/prompts.spec.ts`: `locale/*.json` keys and `prompts/*.md` are validated; adding UI strings means adding them to every locale file.
- `tests/bundle-patch.spec.ts` validates `cordis.patch.yml` structure.

## Layout

- `src/core/` — pure domain: Engine, model, `ports.ts` interfaces (Policy, SourceScope, Assessor, Executor, Outbox). No DSH imports.
- `src/app/` — glue: `runtime.ts` constructs everything (`Runtime` owns startup/shutdown; the Executor and Assessor receive getters to break construction cycles), settings, store, outbox, effects, HTTP routes.
- `src/client/` — React web panel (React 18; vitest config dedupes react/react-dom across DSH client packages).
- `src/sources/` — Source kinds (GitHub, Feishu). Adding one: follow `docs/008-cookbook.md` and model it on `src/sources/github.ts` (split trigger/channel/polling modules like Feishu when it grows). Trigger/Thread ids are persisted — choose stable mappings first.
- `src/executor/` — DshExecutor; runs each Ticket in its own DSH Session.
- `cordis.patch.yml` — bundle layer: inserts plugins and the agent presets (worker preset config lives here; presets use 5 s shell background timeout on the worker, 60 s for subagents under `standard`). `examples/profile.cordis.patch.yml` shows the profile side (stateDir is required or the plugin refuses to start).
- `prompts/` — agent prompt fragments (orchestrator, worker, admission, replies…).
- `skills/`, `scripts/dsh-superagent` — shipped as package `files` alongside `lib/`, `locale/`, `prompts/`.

## Gotchas

- Peer deps are `@deepseek-ai/dsh-*` alpha packages pinned to the same version; bump them together.
- Setup is done interactively by walking the operator through `SETUP.md` (`src/setup.ts`, `SETUP_FIELDS`); new Source config fields that need setup checks should be added there.
- `.env` and `lib/` are gitignored; nothing in the repo reads real credentials — tests run without GitHub/Feishu access.
