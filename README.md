# Mnemosyne — long-term memory for DeepSeek Harness

> A DSH plugin that gives your agent a memory that works like yours: it learns,
> forgets, filters, and slowly tunes itself to you.

[中文说明](./README.zh.md)

Most "memory" plugins are a vector store with a `save` button. Mnemosyne models
the four things that actually make human memory useful — and the loop that ties
them together:

| Human ability | What Mnemosyne does |
| --- | --- |
| **Memory** | Learns from every completed turn (preferences, facts, decisions, lessons, successful commands) and persists to one atomic JSON file. Nothing is lost on restart. |
| **Learning** | Standing preferences become a subject-keyed profile. Restating reinforces; revising *supersedes* the old statement instead of piling up contradictions. |
| **Forgetting** | Ebbinghaus decay with a longer half-life for important and rehearsed memories. Consolidation compresses old turns into digests. Memories under the floor are *forgotten* (inactive, recoverable) — not deleted. |
| **Selection** | Before each turn, a bounded working set is injected: standing preferences, the few memories that are relevant right now, and the recent thread. Habituation keeps the same memory from being repeated every turn. |
| **Self-upgrade** | After each injected turn, a closed loop judges whether the memory was accepted or corrected, and re-tunes the recall gate, half-life and injection size within hard bounds. The longer it runs, the better it fits. |

## Install

Mnemosyne is a DSH **bundle**: installing it adds a row to your profile's
config, so it loads in every session of that profile.

```bash
# from a local checkout
dsh plugin --profile web add file:/absolute/path/to/dsh-mnemosyne

# or install the git repo directly
dsh plugin --profile web add github:EMUMUI/dsh-mnemosyne
```

Restart DSH (or reload the app) afterwards. The plugin needs no other services,
has no runtime dependencies, and works with Node 22.19+ / 24+.

Check that it is alive:

```
mnemosyne_stats       # counts, file path, tuning values
mnemosyne_health      # is it fitting you? what would it change?
```

## How it behaves in a session

Before the first step of every turn, and only when there is something worth
saying, a single user-role message is appended:

```
[M]
【Mnemosyne 长期记忆 · plugin:mnemosyne】
以下是你对这个用户的长期记忆（由 Mnemosyne 自动维护）。它不是用户本次说的话；
与当前任务无关时请忽略，不要向用户复述本段，也不要说"根据我的记忆"。
若记忆与用户当前要求冲突，以当前要求为准，并可用 mnemosyne_remember 更新记忆。

【长期偏好 · 用户明确设定，优先遵守】
- [sema-0688e679] 以后所有回复都用中文，简洁一点。

【相关记忆 · 可能相关，仅供参考】
- [epis-508748b8] 部署脚本在 scripts/deploy.ps1，服务器是 Windows。

【最近对话脉络】
- [recent-1767225600000] 安装依赖，然后跑一下构建。
```

It is a real, logged message with `source: { kind: 'plugin:mnemosyne' }`, so it
appears in the session log and the GUI labels it as coming from this plugin —
never confused with something you typed. It is bounded by `workingSetMaxChars`.

A short section is also added to the system prompt telling the agent *how* to
use memory: prefer the current request over memory, call `mnemosyne_remember`
when you hear a durable preference, `mnemosyne_recall` when asked about the
past, and never store secrets.

## Tools

| Tool | Purpose |
| --- | --- |
| `mnemosyne_remember` | Save a preference, fact, decision, lesson or command. Same-subject statements supersede each other; near-duplicates reinforce. |
| `mnemosyne_recall` | Search memory by meaning-ish terms. `includeForgotten: true` digs up faded memories. |
| `mnemosyne_profile` | The durable picture of you: standing preferences, pinned facts, behaviour fit. |
| `mnemosyne_update` | Rewrite, pin, re-weight, forget, discard or restore a memory by id. |
| `mnemosyne_forget` | Forget (recoverable) or discard (permanent) — by id or by query. |
| `mnemosyne_consolidate` | Run a "sleep" cycle now; `preview: true` dry-runs it. |
| `mnemosyne_health` | Fit, weak spots, and what self-tuning would change. |
| `mnemosyne_sessions` | Recent turn activity from the learning journal. |
| `mnemosyne_commands` | Command patterns learned from successful shell calls. |
| `mnemosyne_stats` | Counters, file path, current tuning. |

```jsonc
// example: teach it a standing rule
{ "content": "所有代码注释用英文，但我看的文档请用中文", "kind": "preference" }
```

## The memory model, briefly

- **Strength** grows with every meaningful encounter, with diminishing returns
  (`gain / (1 + 0.6·hits)`) and a cap, so nothing can dominate forever.
- **Decay** is exponential. Effective half-life =
  `halfLifeDays × (1 + 2·salience) × 1.55^log2(strength+1)`: important things
  and rehearsed things last longer (the spacing effect).
- **Forgetting** happens when decayed strength falls below `salienceFloor`.
  Pinned memories are exempt. Forgotten items leave the active store but stay on
  record for `keepForgottenDays`, so an explicit recall can still recover them.
- **Consolidation** (the "sleep" cycle) compresses pending turns into a digest
  memory, runs decay, and enforces capacity limits.
- **Selection** ranks by relevance (0.55) + importance (0.25) + strength (0.2),
  with a habituation penalty for memories that were just injected.
- **Self-tuning** moves `recallThreshold`, `halfLifeDays`, `salienceFloor`,
  `reinforceGainMul` and `learnedInject` inside hard bounds, from the observed
  ratio of accepted to corrected injections. Every change is logged with the
  observation that caused it.

## Configuration

Every option is documented in [`cordis.patch.yml`](./cordis.patch.yml); nothing
needs to be set. The ones you are most likely to touch:

| Key | Default | Meaning |
| --- | --- | --- |
| `autoLearn` | `true` | Learn from turns automatically. |
| `halfLifeDays` | `21` | Base half-life; `0` never forgets. |
| `workingSetMaxChars` | `2200` | Injection budget. |
| `privacyMode` | `'excerpt'` | `'excerpt'` \| `'excerpt-free'` \| `'full'`. |
| `redactSecrets` | `true` | Strip credentials before storing. |
| `perProjectPreferences` | `false` | Keep preferences per repository. |
| `memoryFile` | `~/.dsh/mnemosyne/<profile>.json` | Where the brain lives. |

## Privacy

- User turns are **never** stored verbatim by default; a redacted excerpt is.
- Credentials (`ghp_…`, `github_pat_…`, `sk-…`, AWS keys, JWTs, `api-key`/`password`
  assignments, private-key blocks) are redacted at the storage boundary, so they
  cannot enter the brain through any path.
- Everything is one local file, created with mode `0600`. Delete it and the
  memory is gone.

## Development

```bash
node --test "tests/**/*.test.js"   # 48 unit tests, no dependencies
node scripts/demo.mjs              # narrated 3-month run of the memory model
```

Layout:

```
index.js            plugin entry: config, brain, host, tools, prompt section
lib/host.js         session observation, turn lifecycle, injection, feedback
lib/render.js       the injected block, the system section, status line
lib/writer.js       one saving writer per brain file (HMR / double-mount safe)
src/brain.js        high-level operations shared by tools, hooks and tests
src/tools.js        the ten tool definitions
src/config.js       defaults, validation, path resolution
src/core/           text, decay, store, patterns, learn, recall, self
vendor/             a minimal local `defineTool` (out-of-tree plugins cannot
                    import @deepseek-ai/dsh-tools)
```

## License

MIT © EMUMUI
