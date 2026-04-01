# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Dolos is a source code plagiarism detection tool. Monorepo with npm workspaces (TypeScript) + a Rails API. The pipeline: parse source files → tokenize with tree-sitter → hash k-grams → winnow fingerprints → compare pairs via shared fingerprints.

## Build Commands

All npm dependencies install from the root: `npm install`

Workspaces must be built in dependency order: **core → parsers → lib → cli/web**

```bash
npm run --workspace core build
npm run --workspace parsers build     # requires node-gyp / python3 / build-base
npm run --workspace lib build         # depends on core + parsers
npm run --workspace cli build         # depends on lib
npm run --workspace web build         # depends on core (analysis mode)
npm run --workspace web build:server  # server mode (connects to API)
```

## Test Commands

```bash
npm run --workspace core test         # AVA tests (core/src/test/*.test.ts)
npm run --workspace lib test          # AVA tests
npm run --workspace lib test:watch    # watch mode
```

Rails API tests (requires MariaDB):
```bash
cd api && bundle exec rails db:prepare && bundle exec rails test
```

## Lint

```bash
npm run --workspace core lint
npm run --workspace cli lint
npm run --workspace lib lint
npm run --workspace web lint          # also: npm run --workspace web check
cd api && bundle exec rubocop
```

## Docker

Three Docker images: CLI (`Dockerfile.cli`), Web (`Dockerfile.web`), API (`api/Dockerfile`).

Full stack via `docker-compose.yml` (db, api, web, worker). Requires `.env` with `DATABASE_*`, `API_EXTERNAL_*`, `FRONTEND_EXTERNAL_*`, `WEB_PROTOCOL`, `DOCKER_SOCKET` vars.

The **worker** service spawns CLI containers to analyze uploads. The CLI image name is hardcoded in `api/app/jobs/analyze_dataset_job.rb` as `DOLOS_IMAGE`.

To test local CLI changes in Docker:
```bash
docker build -f Dockerfile.cli -t ghcr.io/dodona-edu/dolos-cli:latest .
```

## Architecture

### Workspace dependency graph
```
core (algorithms, no deps)
  ↑
parsers (tree-sitter C++ bindings via node-gyp)
  ↑
lib (file I/O, zip extraction, tokenization, language detection)
  ↑
cli (command-line interface, serves web UI)
  ↑
web (Vue 3 + Vuetify + D3 frontend, uses core directly)
```

### Core (`@dodona/dolos-core`)
Pure algorithm layer. `FingerprintIndex` builds a hash index of winnowed k-grams across files, `Pair` computes similarity between two files, `SharedFingerprint` tracks which files share a hash. No file I/O.

### Lib (`@dodona/dolos-lib`)
- `Dataset` — reads input (ZIP/CSV/paths), extracts files, handles LMS zip structures with nested student submissions
- `LanguagePicker` — detects language from file extensions or explicit name
- `Dolos` — main entry: creates dataset → detects language → tokenizes → builds index → returns `Report`
- `Report` — wraps index results, `allPairs()` groups by `studentId` to skip intra-student comparisons

### CLI (`@dodona/dolos`)
- `commands/run.ts` — main `dolos run` command, calls `Dolos.analyzePaths()`
- `commands/serve.ts` — starts local web server to view results
- Views: web (launches browser), terminal, file (CSV output)

### Web (`@dodona/dolos-web`)
Vue 3 SPA with two modes: **analysis** (view single report JSON) and **server** (full app with API). Uses Pinia stores, D3 for graph/cluster visualization.

### API (Rails)
- `AnalyzeDatasetJob` — spawns Docker CLI containers with memory/time limits
- REST endpoints for dataset upload and report retrieval
- Background processing via Delayed Job
- MariaDB database

### Key data flow (Docker deployment)
1. User uploads ZIP via web UI → API stores dataset
2. Worker picks up job → spawns CLI Docker container with the ZIP mounted
3. CLI extracts files, tokenizes, compares, outputs CSV results
4. Worker reads results back, stores in DB, marks report as finished

## Supported Languages

27 languages via tree-sitter parsers: bash, c, cpp, c-sharp, python, java, javascript, typescript, tsx, php, go, rust, scala, sql, r, elm, groovy, modelica, ocaml, verilog. Plus `char` mode for plain text.

Language is auto-detected from file extensions or set explicitly with `-l`/`--language`.

## Known Issues

- `lib` build shows `Cannot find module 'tree-sitter'` type error in `codeTokenizer.ts` — JS output is still emitted since `noEmitOnError` is commented out in tsconfig
- BusyBox `unzip` (Alpine default) doesn't convert Windows backslash paths — `Dockerfile.cli` installs InfoZIP `unzip` to handle this
