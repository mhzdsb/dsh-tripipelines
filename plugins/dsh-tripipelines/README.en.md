# dsh-tripipelines · Pipeline

> **中文文档：** see [README.md](README.md) (the canonical copy; this file mirrors it).

> **Tiered collaboration, a right-sized model for every job.** Split big work into pieces each model can actually chew — money spent where it matters, code that survives the next decade.

A **native DeepSeek Harness (DSH) plugin**: Level 1 (the model you picked for this chat) plans and accepts; Level 2 (a configured model, overridable per module) writes module code; Level 3 does the grunt work — a local engine over HTTP, a cloud provider in agent mode, or switched off entirely. Strict adjacency between tiers, per-task acceptance criteria, pausable and resumable throughout.

Pure Node built-ins. Zero external npm dependencies. It never touches your DSH source.

```
user ──talks only to L1──▶ L1 (your chat model) ◀──reports/re-anchor──▶ L2 (module lead) ──forced dispatch──▶ L3 (local engine / cloud agent)
       plan · accept · no code      re-anchor · report on exceptions   decompose · write · review   whole files · retry a few times · escalate when stuck
       strict adjacency: L1 ↔ L2 ↔ L3 — same-tier and skip-level calls are forbidden

┌────────────── GUI board (sidebar card in the Web UI, polls every 2.5 s, invisible to models) ──────────────┐
│ RUN run-1730… active    ▓▓▓▓▓▓░░  milestones 2/3 · tasks 7/9                                               │
│ M1 skeleton+data ✔accepted   M2 API routes ●done awaiting acceptance   M3 frontend ○in progress           │
│ L1 context ▓▓▓░░░ 41K/64K measured       L2 api-auth ▓▓▓▓░ 63K/32K est (qwen3.7-plus)                       │
│           (grey = past sweet spot, advisory only · proxies inflate pressure vs real context — v127)        │
│ L3 subtasks done 21 · failed 2 (retrying) · tokens 182K / budget 500K                                      │
└────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Why you need it

One **big model writing everything start to finish**: smart, but expensive, slow, and its context gets mushy as you go — by file 30 it no longer remembers file 1's interfaces.

**Handing it all to a tiny local model**: cheap, but wrong; the rework costs more than the savings.

The **pipeline** spends the two kinds of money where each belongs:

| Tier | Who | Does | Cost |
|---|---|---|---|
| L1 | the model you picked in the chat UI | splits tasks, sets acceptance, final review, talks to the user only | premium, spent where it counts |
| L2 | configured model (overridable per module) | module lead: writes whole files, runs quality gates | main labor |
| L3 | local engine (usually cheapest) or cloud agent | single functions / small snippets, checks acceptance assertions | grunt work |

Plus three design choices that keep this line from running away: a one-time activation confirmation, budget guardrails (tokens / wall-clock / file count pause the run automatically), and hard milestone acceptance (nothing silently skipped).

## 30-second fit check

**Good fit**
- Medium/large multi-file projects (≥ 3 modules)
- Development where you want to cut token cost without cutting quality
- An OpenAI-compatible inference engine on your machine/LAN (llama.cpp / vLLM / Ollama all work) — or a cloud model to run Level 3 in agent mode
- Work that runs tens of minutes and must be stoppable mid-flight

**Not a fit**
- One-off scripts, single-file tweaks (just let the main agent write them)
- "give me all the code in one message" micro-tasks

---

## Quick start (3 minutes)

Install the plugin → say your first sentence. The onboarding dialog prints the models actually available on *your* machine; pick nothing and defaults apply; with no local engine there are still two paths (cloud agent / two-tier). Full walkthrough: **[QUICKSTART.md](QUICKSTART.md)**.

```bash
# 1. Install (A once published to npm / market; link for local dev)
dsh plugin --profile <profile> add dsh-tripipelines        # npm / market
plugin_manager install_bundle('link:C:/path/to/dsh-tripipelines')  # local / dev

# 2. Make sure the services are alive
/pipe-selftest

# 3. Say one sentence (you don't split modules yourself)
"build me a todo app with login and a task list"
```

The main agent then walks the four phases — onboarding → requirement interview → fit assessment → adaptive scheduling: it asks a few key questions and locks the requirement, splits modules, spawns L2 leads, pushes work down to L3, reports node by node, and pops a dialog at every milestone for your acceptance.

## How it works

### Four phases
1. **Onboarding**: on a brand-new workspace one merged dialog asks "enable the pipeline here? + pick models" (since v125 these are no longer two consecutive popups); answers persist to `.dsh/pipeline/activation.json`.
2. **Requirement interview**: popup questions on the essentials (framework / database / auth / testing expectations…), locked into `requirement_lock.json`.
3. **Fit assessment**: if the task is too simple the agent says so — "no three tiers needed", never force-fitted.
4. **Adaptive scheduling**: split modules (natural seams + load balance) → spawn L2 → L2 decomposes L3 subtasks → batch execute → quality gate → milestone acceptance → checkpoint.

### Four hard constraints (not model self-discipline)
| Constraint | How it is enforced |
|---|---|
| **Strict adjacency** | dual layer: agent messaging rules + `tools.guard` — L1 may only call L1 tools; cross-tier calls from L2/L3 are refused outright |
| **Milestone acceptance** | while a milestone is done-but-unaccepted, spawn/send hit a hard gate; tool results carry live progress footers |
| **Budget guardrails** | any of tokens / duration / files touched exceeding limits → the run pauses itself, execution tools refuse |
| **Stop anytime** | `/pipe-stop` freezes only (disk state kept), `/pipe-resume` continues, `/pipe-off` reverts to plain single-agent |

## Core features

| Capability | Notes |
|---|---|
| **Three-tier model routing** | L1 = the model you picked in the UI (main agent; not necessarily a pro), L2 = configured model (long-lived subagent, per-module override available; not necessarily flash), L3 = any OpenAI-compatible local engine, cloud provider, or off |
| **Strict adjacency** | enforced twice (agent layer + `tools.guard`); same-tier and skip-level calls forbidden |
| **Long-lived L2** | module leads are continuable subagents — reused, never respawned, context accumulates |
| **Per-task acceptance criteria** | every dispatched task carries acceptance written by the dispatching tier, scored by the quality gate |
| **Bounded failure + cannot-do** | L3 escalates explicitly when stuck; after `maxLevel3Retries` failures L2 takes over |
| **Batched L3 execution** | `pipeline_execute_batch` submits N subtasks at once, serial inside, one return — saves N× inference tokens |
| **Quality gate actually runs code** | assertions like `fn(args)==expected` really execute (JS/TS via node, Python via a controlled subprocess); **all assertions must pass**. File-shaped tasks use `cmd: <command>` integration checks at workspace root (v119, exit-code judged). Keyword scoring only as fallback |
| **Report-on-exception + no polling** | L1/L2 never poll the board; push-based reporting slashes token burn |
| **GUI board (v92/v94)** | a sidebar card in the Web UI, same family as the balance card: run status / milestones / per-tier load bars (green inside the sweet spot, neutral grey past it — advisory only, amber approaching the danger line, red past it = time to consider a checkpoint; under compression proxies the pressure reading overstates real context, so colours are hints not verdicts — v127. `测`=host-measured, `估`=estimated — v126. Models with an unknown window show "未知" and no fake scale — v128) / active L2s and their models / token budget — invisible to models, always visible to you |
| **Isolated working dir per L2 (v92)** | `scopeDir` on `pipeline_spawn_module_lead` gives each lead a real `cwd`; parallel leads never step on files |
| **Per-L2 model choice (v94)** | pass `provider` / `model` per lead — throw a stronger model at the hard module, keep the rest cheap |
| **Milestone state machine** | done → acceptance dialog → persisted; unaccepted blocks advance; cold-start auto-restores |
| **Budget guardrails** | `maxTotalTokensPerRun` / `maxDurationPerRun` / `maxFilesPerRun` (0 = unlimited) |
| **One-time activation gate** | asked once per new workspace; since v125 merged into the model-pick dialog, remembered per workspace |
| **Health self-test** | `/pipe-selftest` checks the subagents API, llm service, L3 pairing/engine; a non-blocking ping also runs at startup |
| **Modular internals** | 15 modules (largest ≈ 600 lines); `npm test` chains 19 smoke suites shipped inside the package — clone anywhere and verify |
| **Four-phase workflow** | model onboarding (v121) → requirement interview → fit assessment → adaptive scheduling |

> Full feature history: [CHANGELOG.md](CHANGELOG.md); architecture details: [docs/agent-lifecycle-design.md](docs/agent-lifecycle-design.md).

## Installation

### Prerequisites
1. **DSH** running.
2. **Any usable L2 model is enough to start**: default `deepseek-official` / `deepseek-flash`; any model behind a provider already configured in DSH (custom Token Plans included) works — the onboarding dialog auto-pairs the provider.
3. **Level 3 is optional** (three routes, see QUICKSTART step 0): a local OpenAI-compatible engine (`/pipe-config level3Endpoint <url>` + `level3Model <id>`); or a cloud model in agent mode (`/pipe-config level3Model <id> mode=agent`, no endpoint needed); or `/pipe-config level3Mode off` for pure two-tier.

### Install methods
This plugin ships as a directory bundle (`package.json` + `cordis.patch.yml` + `lib/` + `skills/`):

- **Method A (recommended)**: the DSH plugin-manager GUI, or `plugin_manager install_bundle` pointing at the package name or a directory.
- **Method B**: `dsh plugin add <absolute path>` (requires pnpm).
- **Method C (manual)**: junction/symlink into `profiles/<profile>/node_modules/dsh-tripipelines` and append to the profile's `cordis.patch.yml`:
  ```yaml
  - insert:
      - id: pipeline
        name: 'dsh-tripipelines'
  ```

### Verify
In a fresh session type `/pipe-config` — you should see the config listing; `listTools` showing `pipeline_*` tools means success. Fuller check: `/pipe-selftest`.

### ⚠️ During development, edited code requires reinstall (Electron cache)

**Regular upgrades are unaffected**: install a new version from the market/npm and open a new session. The note below applies only to hacking on `lib/*` locally — Electron caches imports by real module path and cannot load non-builtin deps, so **every edit to `lib/*`** needs copying to a **fresh directory** + reinstall (removing the old bundle), otherwise you keep running stale code. The `-vNN` snapshot directories you see in releases are an artifact of this rule, not a usage prerequisite.

## Configuration (`/pipe-config`)

```text
/pipe-config                    # show everything
/pipe-config <key>              # read one key
/pipe-config <key> <value>      # set one key
/pipe-config list               # list configurable keys
/pipe-config reset              # restore defaults
```

| Key | Default | Notes |
|---|---|---|
| `level1Model` | `deepseek-pro` | L1 model (only used to look up the sweet-spot profile; does not switch your actual chat model) |
| `level2Provider` / `level2Model` | `deepseek-official` / `deepseek-flash` | L2 model |
| `level3Model` / `level3Provider` / `level3Endpoint` | per config / `ninfer-local` / **empty** (executor mode must set it explicitly) | L3 model; `executor` mode speaks OpenAI protocol against the endpoint (`/pipe-config level3Endpoint http://127.0.0.1:8080/v1`); `agent` mode runs through a provider subagent (the provider label just follows your config) |
| `level3Mode` | `auto` | L3 execution mode (v123/v124): `auto` decides by model source (engine model → executor, cloud → agent) / `executor` = one-shot local endpoint / `agent` = DSH subagent (required for cloud models) / `off` = no third tier, L1+L2 only (leads write their own code) |
| `level3Engine` | `auto` | engine hint (auto/ollama/vllm/llamacpp/openai-compat/other) |
| `maxCodeLines` | `100` | max delivered code lines per L3 task |
| `maxLevel3Retries` | `5` | L3 retries before L2 takes over |
| `maxLevel3Concurrency` | `1` | concurrent L3 slots (serial on a single local instance) |
| `maxLevel2Retries` | `3` | L2 attempts before escalating to L1 |
| `maxLevel2Agents` | `10` | cap on module leads |
| `level2ContextBudget` | `250000` | L2 context budget (auto-retuned from the model profile since v129; module sizing reference) |
| `level2SweetSpotRatio` | `0.25` | L2 sweet spot as a fraction of window (recomputed on model change) |
| `level2HandoffTtlMs` | `300000` | handoff survival window for retired leads (drain forced after) |
| `level1ContextBudget` | `500000` | L1 sweet spot (checkpoint suggested when approaching; auto-retuned from the live session window since v129/v130) |
| `level1SweetSpotRatio` | `0.5` | L1 sweet-spot fraction of window |
| `level1ContextWarnRatio` | `0.8` | L1 warning ratio |
| `autoTuneSweetSpot` | `true` | auto-retune budgets when models change |
| `devDir` | `dev` | process-docs directory (kept separate from production files) |
| `level3TimeoutMs` | `900000` | L3 subtask timeout (= 15 min) |
| `commandAcceptanceTimeoutMs` | `120000` | `cmd:` acceptance timeout in ms (v119) |
| `level3InputBudget` | `1200` | input-token cap per L3 subtask (auto-compressed above) |
| `level3MaxOutputTokens` | `4096` | output-token cap |
| `semanticGateThreshold` | `0.7` | quality-gate threshold; keyword-only scores cap at 0.5, so `pipeline_plan` rejects "threshold > 0.5 with non-executable acceptance" plans up front (v119) |
| `mode` | `auto` | `auto` = per-project assessment / `on` = force three tiers / `off` = single agent |
| `activationGate` | `true` | one-time activation question per new workspace |
| `maxTotalTokensPerRun` | `500000` | token budget per run (0 = unlimited) |
| `maxDurationPerRun` | `7200000` | wall-clock limit per run in ms (2 h, 0 = unlimited) |
| `maxFilesPerRun` | `200` | files-touched limit per run (0 = unlimited) |

**Config layering**: `DEFAULT_CONFIG` < passed config < global `~/.dsh/pipeline/config.json` < project `<devDir>/pipeline-project.json`. Different `devDir`s never pollute each other.

**Model onboarding (v121)**: on every project's first step, L1 calls `pipeline_model_setup`, which pastes every L2/L3 model actually available on your machine together with copyable `/pipe-config ...` lines, and asks once. Choose nothing → defaults land (L2 `deepseek-flash`, L3 = first model in the local engine's `/models`). Choices are recorded in `<stateDir>/model-setup.json`; the same project never asks again; `pipeline_lock_requirements` returns `modelSetupHint` until a setup exists. Since v125 this same dialog also carries the one-time activation confirmation — no more two consecutive popups.

**Tests ship in the package (v125)**: all 19 smoke suites live in `test/smoke/` inside the package — after installing, `npm test` verifies the plugin from any directory; no repo layout required.

**Cross-provider model picks (v122/v123)**: a model id is only valid under the provider that serves it (e.g. `qwen3.7-plus` belongs to `qwen-token-plan-cn` in a Qwen Token Plan). Now `/pipe-config level2Model <id>` with the bare model name is enough: the command auto-pairs the provider and prints `🔧 已自动配套 level2Provider=…`; the onboarding list groups models by provider with copyable provider lines. One more safety net runs before dispatch (`providerNote`); explicit `provider` arguments are never rewritten, only warned about.

**Cloud L3 / modes (v123)**: L3 need not be local. `/pipe-config level3Model <id> mode=agent` runs that model as a DSH subagent through its own provider (no `level3Endpoint` needed); `mode=executor` keeps the one-shot OpenAI-compatible endpoint path; `mode=auto` (default) decides by source — engine model → executor, cloud model → agent. `pipeline_model_setup`'s `apply:'custom'` flips a cloud L3 to agent automatically and pairs the provider. In `agent` mode `execute_local/batch` refuse; in `executor` mode `spawn_local_executor` refuses — a cloud id can never be sent to the wrong endpoint.

**Turning L3 off (v124)**: `/pipe-config level3Mode off` switches to two-tier — L1 keeps planning/dispatching/accepting, L2 leads write all their own code (then `pipeline_register_output` + `pipeline_review` through the quality gate). All three L3 dispatch entries (`execute_local` / `execute_batch` / `spawn_local_executor`) are refused with an explicit straight-write path; editing `level3Model` while off never secretly re-enables L3 — restoring requires an explicit `/pipe-config level3Mode auto` (or `mode=auto` riding a model change). The onboarding list and question reflect the closed state and offer the recovery commands.

**Sweet-spot auto-tuning (fixed in v128, re-calibrated in v129)**: changing `level1Model`/`level2Model` recomputes budgets automatically — built-in `MODEL_PROFILES` first (window × ratio), then the model's real context window reported by the host (`llm.resolveModelInfo`) with default ratios (sweet 25% / danger 75%). Only when neither knows the window do you get a manual-set hint, and the board marks that meter "窗口未知" (window unknown) instead of painting a fake scale. Before v128, any model missing from the profiles (e.g. a 1M-window Token Plan model) silently kept flash's stale 32K/96K/128K numbers. **v129 also corrected the profiles themselves**: the DeepSeek V4 family ships a 1M-token window per its model card, so flash's sweet spot moved from 32K to 250K (L1: 500K sweet / 750K danger) — the old 128K-generation assumption is gone. **v130: L1 follows the live chat session** — L1 isn't a config key but the model picked for this conversation (v95); when it has no built-in profile (e.g. qwen3.8-flash), any model command retunes the three level1 values from the session-reported real window and persists them, instead of staying on the `level1Model` display fallback.

## Usage

Open a fresh session and just describe what you want (a few sentences — no manual module splitting). The main agent walks the four phases.

- **Model onboarding (v121)**: for every new project L1 first calls `pipeline_model_setup` and posts every local L2/L3 model with copyable `/pipe-config ...` lines; no choice → defaults (L2 `deepseek-flash`, L3 = local `/models` #1).
- Don't want three tiers: say "skip the pipeline" or `/pipe-config mode off`.
- Status: `/pipe-config` or (for L1) `pipeline_status`.
- Pause/resume: `/pipe-stop` / `/pipe-resume`; kill entirely: `/pipe-off`.
- Stuck thinking: `/pipe-research <topic>` generates a 7-step deliberation skeleton (see Knowledge layer).
- At milestones: the main agent pops "I'm satisfied / I have feedback"; after satisfaction old leads hand off unconditionally and retire, new leads continue the next stretch.

## Tool surface

| Tool | Tier | Purpose |
|---|---|---|
| `pipeline_model_setup` | L1 | pick models first: lists every local L2/L3 model + copyable commands, lands defaults or custom (v121) |
| `pipeline_lock_requirements` | L1 | lock requirements, open a run (may carry `activation`) |
| `pipeline_plan` | L1 | record the TaskPlan (dependency DAG + cycle check + milestone declarations; acceptance must be assertions / `cmd:` / keyword score ≤ 0.5 threshold, v119) |
| `pipeline_spawn_module_lead` | L1→L2 | spawn a long-lived module lead (configured model; optional `scopeDir` isolation, `provider`/`model` override) |
| `pipeline_send_to_lead` | L1↔L2 | follow-up tasks to a reused lead |
| `pipeline_drain_leads` | L1 | release old leads after milestone recreation |
| `pipeline_checkpoint` | L1 | write the 10-section handoff doc + cold-start prompt |
| `pipeline_accept_milestone` | L1 | record the user's milestone acceptance |
| `pipeline_selftest` | L1 | health check (subagents / llm / L3 pairing & engine) |
| `pipeline_classify` | L1 | capability-fit classification (L1/L2/L3) |
| `pipeline_status` | L1 | status panel / trace / token accounting |
| `pipeline_decompose` | L2 | split a module into L3 subtasks |
| `pipeline_execute_local` | L2→L3 | synchronous single L3 dispatch |
| `pipeline_execute_batch` | L2→L3 | N subtasks in one call, serial inside, one return (token saver) |
| `pipeline_spawn_local_executor` | L2→L3 | agent-style L3 dispatch (optional heavier path) |
| `pipeline_review` | L2/L1 | quality gate (assertions > `cmd:` > keyword score; JSON + DoD; accepts `filePath`) |
| `pipeline_register_output` | L2 | backfill the board after L2 straight-writes code |
| `pipeline_scan` | L1 | scan the repo into the knowledge base (index.md skeleton + map.json symbol table + one page per module) |
| `pipeline_ledger` | L1 | extract decision/conclusion candidates from handoff docs, flag missing fields |
| `pipeline_recall` | L1 | keyword search over the knowledge base; returns `file:line` + excerpts, honestly says "no hits" |

## Knowledge layer (v98): L1 stops brute-reading source

In large projects L1's biggest waste isn't writing code — it's reading the entire repo just to understand it. The knowledge layer turns that into one scan plus on-demand recall:

```
pipeline_scan(root=".")      # one mechanical scan → .dsh/pipeline/knowledge/
pipeline_scan(check=true)    # staleness only: changed files/pages, no rewrite
pipeline_recall(query="how does the backtest engine call the core")   # excerpt hits only
pipeline_ledger()            # decision candidates from handoff docs
```

- `index.md`: one-page skeleton (repo size, module inventory + line counts, roles, giant files, TODO counts, start commands, recent commits) — **read this first on cold start** (~1.6K tokens measured on a stock repo).
- `modules/<module>.md`: one page per module (role, entry files, public interfaces, dependencies, signals).
- `map.json`: symbol table (sha1 prefix, size, lines per code file) powering later stale-detection.
- No hits → "no hits", never fabrication — this layer is mechanical extraction, not semantic judgment.

### Topic deliberation (`/pipe-research`): a grounded meeting when you're stuck

The knowledge base isn't a static snapshot — it grows with the project: every `pipeline_scan` refreshes `index.md` and module pages, `pipeline_ledger` distills decisions from handoffs, `pipeline_recall` lets a new session recover context in a few lines. The bigger and older the project, the more valuable this layer.

When genuinely stuck (architecture wobble, two-way choice, repeated rework at one spot, performance/compat trade-offs), don't grind by "reading the code again":

```
/pipe-research which path do we invest in next
```

It writes a 7-step deliberation skeleton to `<workspace>/.dsh/pipeline/knowledge/research/<date>-<topic>.md` **and, in the same turn, asks step 1's questions in chat** (v120; before v119 it only dropped an empty skeleton):

1. **Charter** — the problem, success criteria (so errors surface early), budget
2. **Evidence** — every item with a `file:line` or ledger `#n` pointer
3. **Candidates** — ≥2, otherwise it isn't a decision
4. **Opposition** — hardest counter-reason per candidate + evidence
5. **Minimal experiment** — the one that discriminates candidates
6. **Recommendation** — with confidence; reasons must carry numbers or pointers
7. **Record** — "how would being wrong surface", plus ledger entries to write back

Three built-in tripwires: reasons without numbers get deleted or numbered; fewer than 3 pointer-backed evidence items → run `pipeline_recall` first; no "how would being wrong surface" answer → it cannot serve as a decision basis. Conclusions write back to `decisions.md` (or the checkpoint's decisions section), and since v117 `pipeline_recall` searches `research/*.md` by default — the same topic never argues from zero again.

### Isolation contract and recall semantics (v118)

The knowledge layer inherently reads projects and writes a knowledge base, so v118 wrote the boundaries as a contract and locked them with tests:

- **Writes only inside the current workspace**: `root` on scan/ledger, `path` on checkpoint, `resumeFrom`/`scopeDir` on spawn, and the `devDir` config all accept workspace-relative paths only; absolute or `..` escapes error out — project B never receives project A's content.
- **Never touches the project repo**: the plugin creates no `decisions.md`, writes no `dev/`, makes no decisions for the project; a project-owned `dev/decisions.md` is searched read-only.
- **Recall results carry evidence grade**: every hit has `kind` (`code` / `decision` / `candidate` / `research`) plus `coverage` (scan / modules / candidates / decisions / researchFilled / researchDrafts), `partial`, `generatedAt` (from scan's `hashes.json`, not file mtime), `rootMismatch` (warns when the knowledge base belongs to another workspace).
- **Unfinished deliberations are not searchable**: only `research/*.md` files with body text in section 7 count as filled; template skeletons are never treated as conclusions.
- **No workspace guessing**: without a session cwd / workspace root the tools error immediately instead of falling back to the process cwd and writing state into the DSH profile directory.

## Versioning

- **Package version** (`package.json`): semantic `x.y.z`, used for market/npm releases.
- **Iteration tag** (`vN`): local deployment number appearing in snapshot dirs and internal docs (Electron's cache forces fresh dirs when editing code locally — see the install note; regular users never notice this).
- Full history: [CHANGELOG.md](CHANGELOG.md) (older entries in [CHANGELOG-archive.md](CHANGELOG-archive.md)).

## Robustness: anti-blockage and single points

- **L1 must respond**: every L2 report gets a reply (one word "continue" or a re-anchor) — leads never wait forever.
- **Self-contained reports**: "what got done + next step + decisions needed", so a late L1 reply loses no progress.
- **Persistence as the floor**: board / trace / `l2_state.md` all on disk; anything stuck is recoverable.

> Honest note: if L1 is **completely unavailable** (model dead / session dropped) there is no substitute — that is the inherent single point of "L1 is the only coordinator", covered by manual user intervention or reopening the session. Everything else neither blocks nor loses progress.

## Known limitations

1. **Desktop hosts can't load non-builtin deps**: a visual settings page would need `schemastery`; use the `/pipe-config` command instead.
2. **`deepseek-v4.1-flash` does not exist**; the correct id is `deepseek-flash`.
3. **Agent Teams teammates cannot pick a model** (they inherit the parent's), so long-lived L2 leads use **continuable subagents**.
4. The quality gate order is "assertions > `cmd:` commands > keyword score", and assertions are **fail-closed**: no usable runner, code blocked by the static safety gate, or any failing assertion → judged failed, never rescued by keyword scoring. Semantic-only scores cap at 0.5, so under the default 0.7 threshold they cannot pass alone — `pipeline_plan` now rejects such acceptance at planning time (v119) instead of sentencing it at review.
5. **Both JS/TS and Python supported**: JS via a `node` subprocess, Python via AST static-safety gate + subprocess; host execution can be disabled wholesale with `allowCodeExecution=false` (then assertions and `cmd:` acceptance never pass). `cmd:` is integration acceptance executed at workspace root (`pytest` / sync-check scripts), separate from the import/IO-forbidden assertion sandbox (v119).
6. **The right way to accept file-shaped tasks**: write `cmd: python dev/check_sync.py` (the script reads files, compares, `sys.exit(nonzero)`), rather than making model code `import pathlib` through the assertion sandbox.

## Security statement (read before enabling)

This plugin orchestrates code execution. Know the boundaries:

1. **The assertion gate is not an OS-level sandbox.** JS/TS assertions run in a `node` subprocess behind a regex static blacklist (`require` / `child_process` / `process.` / `eval(` / `Function(` / network APIs, etc.); blacklists are raise-the-cost defenses, not isolation. **Python** adds an AST walk (banned imports/names/attrs) but shares that posture and needs `python` on PATH — without it assertions fail closed with a diagnostic.
2. **`cmd:` acceptance executes arbitrary commands at workspace root** (`shell:true`, 120 s default timeout). That is by design for integration checks (`pytest`, build scripts); turn it off if you do not trust the input.
3. **Master switch**: `/pipe-config allowCodeExecution false` stops all assertion and `cmd:` execution (judged failed, fail-closed); the pipeline still runs on semantic/manual review.
4. **Recommended trust posture**: enable auto-execution only in trusted workspaces with trusted requirement text; keep the L3 engine endpoint on loopback (no endpoint → execution refused). The board route registers only on the host's localhost web server; the default snapshot omits absolute paths (debug block requires explicit `?debug=1`).
5. **Where data lands**: per-workspace state under `<workspace>/.dsh/pipeline/` (board / trace / activation), global config at `~/.dsh/pipeline/config.json`. Knowledge writes pass one redaction gate (`sk-…`, AKIA, GitHub/Slack tokens, `password=` forms → `[redacted]`); `.env`/key-like files are recorded by path only, never read.


## Directory layout

```
dsh-tripipelines/
├── package.json                          # manifest (dsh.bundle.patch → cordis.patch.yml; dsh.client → web status card)
├── cordis.patch.yml                      # bundle patch (inserts the plugin row)
├── client.js                             # Web UI board card (sidebar bottom, polls /pipeline/board every 2.5 s)
├── lib/
│   ├── plugin.js                         # thin entry: name / inject / apply wiring, tool dispatch (~360 lines)
│   ├── workspaces.js                     # workspace registry: root normalization / session resolution / board picker
│   ├── config.js                         # model profiles / config keys / layered merge & migration / /pipe-config
│   ├── store.js                          # board + run state machine + budgets + activation (all persisted)
│   ├── gates.js                          # quality gate: assertion runner / DoD / semantic score / task validation
│   ├── prompts.js                        # tier protocols / L2 prompt / L3 prompt / skill body (SKILL_BODY)
│   ├── util.js                           # pure helpers: text / token estimate / compression / semantic scoring
│   ├── dsh-compat.js                     # DSH version adapters (session / tokenMeter / engine probing)
│   ├── board-route.js                    # host read-only route GET /pipeline/board (board data snapshot)
│   ├── guards.js                         # strict adjacency / milestone hard gate / budget guardrail
│   ├── knowledge/                        # scan (mechanical index) / ledger (decision candidates) / recall (keyword search)
│   └── tools/
│       ├── l1.js                         # L1 tools: lock/plan/status/spawn/send/drain/checkpoint/classify/selftest/accept/model_setup
│       ├── l2l3.js                       # L2/L3 tools: decompose/execute_local/execute_batch/review/register/local_executor
│       └── knowledge.js                  # pipeline_scan / pipeline_ledger / pipeline_recall
├── test/smoke/                           # 19 regression suites (shipped in the package; npm test runs them directly)
├── skills/pipeline-orchestration/SKILL.md  # the orchestration skill
├── docs/agent-lifecycle-design.md        # architecture spec
├── examples/                             # one-sentence requirement examples (paste straight into DSH)
├── QUICKSTART.md                         # 3-minute onboarding
├── README.md                             # Chinese README (canonical)
├── README.en.md                          # this file
├── TUTORIAL.md                           # usage & configuration tutorial
└── CHANGELOG.md                          # version log (pre-v109 in CHANGELOG-archive.md)
```

`npm test` (works from any checkout of this package — the suites live in `test/smoke/`) chains 19 regressions: config/project layering 82 assertions, control plane 49, tool-factory assembly probe, board/dir isolation, knowledge layer 15, knowledge hardening 32 (redaction + recall path fencing), skill byte-sync check, workspace isolation 50 (board follows current workspace, switcher & collapse sync, default snapshot redacts the debug block), quality gate & role matrix 34, lifecycle 16, audit fixes 28, v112 regression 40 (measured metering / protocol slimming / off surface), v118 isolation 45, v119 gate exits 41, v120 research handoff 20, v121 model onboarding 52 (discovery order/fallback / copyable commands / defaults / lock hints / project record / custom validation / merged activation gate), v122 cross-provider pairing 33 (grouped list & provider lines / bare model command self-pairs / custom auto-pair / spawn auto-correct / explicit provider respected / selftest degraded / v128 host-window sweet-spot retune persisted), v123 L3 modes 23, v124 L3-off 29, v125 marketplace hardening (board redaction by default / merged dialog / in-package test paths), v128 sweet-spot numbers follow the host window (profile → host → unknown, no fake scale).

---

**Made with ❤️ by merhentz**
