# Code Intelligence (Semantic Search + Code Graph) Design

**Goal:** Give the bug-triage agent two new capabilities — semantic code search and a
call/reference graph — so it locates relevant code and computes blast radius from real
data instead of blind exploration and model guesswork, cutting per-run cost and improving
fix accuracy.

**Architecture:** One indexing pipeline, run offline (once, incrementally re-runnable),
builds a single SQLite file at `agent/lib/code-intelligence.sqlite`, committed to the
repo alongside the other data-layer modules in `agent/lib/`. The file holds embedded
code chunks (via the sqlite-vec extension) and a call graph (via plain relational
tables), covering the Vikunja fork's Go, TypeScript/JavaScript, and Vue source. Two new
agent tools query this file at run time. No external database, no persistent server, no
service to provision — the file deploys with the agent as a bundled asset, exactly like
any other repo file.

**Tech Stack:** CocoIndex + Voyage AI (`voyage-code-4`) for embeddings, sqlite-vec for
vector storage/search, `golang.org/x/tools/go/callgraph` (Go) + `ts-morph` (TS/JS/Vue
`<script>` blocks) for call-graph extraction, `better-sqlite3` for runtime queries from
the agent's Node.js tools.

## Global Constraints

- Free tier only: Voyage AI's free embedding allowance (200M tokens), no paid database
  or hosting service.
- No persistent server for this subsystem — the prior LiteLLM/Railway attempt this
  session failed on exactly that (a persistent process exceeding a free-tier memory
  limit); this design must not repeat that shape.
- Code graph covers Go, TypeScript/JavaScript, and Vue (`.vue` `<script>` blocks) — full
  scope, not limited to where the two seeded bugs happen to live.
- The built SQLite file is committed to the `bug-triage-agent` repo and deploys as a
  bundled, read-only asset. Only the offline indexing script ever writes to it.
- Indexing is incremental: re-running the indexer only re-embeds/re-parses files whose
  content hash changed since the last run.

---

## Components

### 1. Indexing pipeline (offline, not part of the deployed agent)

A standalone script under `indexing/` in the `bug-triage-agent` repo, run manually
against a local clone of the seeded Vikunja fork (`/Users/shlomi.hassan/projects/vikunja`).
Not bundled into the Vercel deployment — its only output is the committed SQLite file.

**Semantic indexing sub-step:**
1. Walk the repo, filtering to source files (`.go`, `.ts`, `.js`, `.vue`), skipping
   `vendor/`, `node_modules/`, generated files, and test fixtures.
2. Chunk each file at function/method/component boundaries (via the same parsers used
   for the code graph, so chunk boundaries and symbol boundaries agree).
3. For each chunk, compute a content hash. Compare against a `chunk_manifest` table in
   the SQLite file; skip embedding if the hash is unchanged from the prior run.
4. Embed new/changed chunks via Voyage AI's `voyage-code-4` model.
5. Upsert into a sqlite-vec virtual table, keyed by a stable chunk ID (`filePath:startLine-endLine`),
   with metadata (file path, line range, language).

**Graph indexing sub-step:**
1. **Go**: run `golang.org/x/tools/go/callgraph` (static algorithm) over the Go module,
   producing function definitions and static call edges.
2. **TypeScript/JavaScript/Vue**: use `ts-morph` to parse `.ts`/`.js` files and the
   `<script>`/`<script setup>` blocks extracted from `.vue` files (via `@vue/compiler-sfc`),
   extracting function/method definitions and call-expression edges.
3. Normalize both languages' output into two tables: `symbols` (id, name, kind, file,
   start_line, end_line) and `edges` (from_symbol_id, to_symbol_id, kind: `"calls"`).
4. Upsert by symbol ID (`file:name:startLine`), so a re-run only touches changed files.

### 2. `agent/tools/search_codebase_semantic.ts`

A new eve tool. Input: `{ query: string, topK?: number }`. Embeds the query via Voyage
AI, runs a sqlite-vec similarity search against the committed file (bundled read-only
in the sandbox/deployment), returns the top-K chunks as `{ filePath, startLine, endLine,
snippet, score }`.

### 3. `agent/tools/query_code_graph.ts`

A new eve tool. Input: `{ symbolName: string, direction: "callers" | "callees", depth?: number }`.
Runs a `WITH RECURSIVE` SQL query over the `edges` table starting from the matching
symbol(s), walking the requested direction up to `depth` hops (default 2), returns the
matched symbols with their file/line locations — this is the blast-radius data,
computed from real call structure rather than inferred by the model.

### 4. `agent/instructions.md` updates

Add explicit guidance: before broad file reads, call `search_codebase_semantic` to
locate candidate code; before editing a function, call `query_code_graph` with
`direction: "callers"` to see what depends on it, and feed that into the existing
`assess_blast_radius` tool's reasoning instead of relying on it to infer impact
unaided.

---

## Data flow

**Offline (run manually by the developer, not by the deployed agent):**
```
vikunja repo (local clone)
  -> [chunk + hash] -> [embed via Voyage] -> sqlite-vec table  \
  -> [parse via go/callgraph + ts-morph] -> symbols/edges tables >  agent/lib/code-intelligence.sqlite
                                                                  /
commit agent/lib/code-intelligence.sqlite to bug-triage-agent repo, deploy
```

**At run time (inside a live bug-triage session):**
```
agent needs to locate code
  -> search_codebase_semantic({query}) -> embed query (Voyage) -> sqlite-vec search -> ranked chunks

agent is about to edit a function
  -> query_code_graph({symbolName, direction: "callers"}) -> recursive SQL -> caller list -> feeds assess_blast_radius
```

## Schema (single SQLite file, `agent/lib/code-intelligence.sqlite`)

- `chunks_vec` — sqlite-vec virtual table: chunk id, embedding vector, file path, start/end line, language.
- `chunk_manifest` — chunk id, content hash (for incremental re-indexing).
- `symbols` — id, name, kind (`function`|`method`|`type`), file, start_line, end_line, language.
- `edges` — from_symbol_id, to_symbol_id, kind (`calls`).

## Error handling

- Runtime tool calls (embedding the query via Voyage) can fail (network, rate limit): the
  tool returns a clear error/empty result rather than throwing, so the agent falls back
  to its existing grep/read capability — a code-intelligence failure never blocks a run.
- The indexing script is idempotent (content-hash-based upserts), so an interrupted run
  can be safely re-run without duplicating or corrupting data.
- If `agent/lib/code-intelligence.sqlite` is missing or unreadable at run time (e.g., not yet
  built), both new tools report that clearly and the agent proceeds with its existing
  exploration tools — this subsystem is additive, not a hard dependency.

## Testing

- Unit tests for the indexing script's pure logic: chunk-boundary detection, content
  hashing, and the incremental skip-if-unchanged behavior.
- Unit tests for both new tools' request/response shaping against a small fixture
  SQLite file (a handful of known chunks/symbols/edges), covering: a semantic query
  that should match a known chunk, a graph query that should find a known caller chain,
  and the empty/missing-file fallback behavior.
- Manual end-to-end verification: build the index against the real Vikunja fork, confirm
  `search_codebase_semantic` surfaces `task_attachment_permissions.go`'s `CanDelete` for
  a query like "permission check for deleting task attachments", confirm
  `query_code_graph` returns `CanDelete`'s real callers, then trigger a live bug-triage
  run and compare token usage/cost against the existing $5.91 baseline run.
