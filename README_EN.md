# dsh-diff-review-glance

Per-turn **file-change diff review** for DeepSeek Harness (dsh) Web. After each conversation turn, the plugin scans the workspace for files that were **modified in place** (new/deleted files are ignored), builds a VS Code-style two-pane diff, and lets you **keep / revert / redo** each change.

Current version: v0.16.4

> [中文文档](./README.md) · English README

## Contents

- [Features](#features)
- [Install](#install)
- [Usage](#usage)
- [Configuration (Settings → Diff Review Plugin)](#configuration-settings--diff-review-plugin)
- [How it works](#how-it-works)
- [Permissions](#permissions)
- [Risk disclosure](#risk-disclosure)
- [Known limitations](#known-limitations)
- [Development](#development)
- [Version history](#version-history)
- [License](#license)
- [Notes from the author](#notes-from-the-author)

## Features

- **Multi-workspace, multi-baseline**: each workspace gets its own baseline and change tracking; switching workspaces never cross-contaminates state (same file names or turn numbers do not collide).
- **Detects every modification source**: end-of-turn full version diff catches changes made by bash, editors, or write tools alike.
- **Optional realtime preview**: the detection mode can be switched between "end of turn" and "realtime preview" — realtime mode watches the workspace with `fs.watch` (Windows only; other platforms fall back to turn mode automatically) and shows an "in-progress changes" preview while the conversation is running; you can expand the diff or open it externally right away; **realtime revert is off by default** (setting `liveRevert`; when enabled, with version-conflict protection); it is folded into the formal review items when the turn ends (avoiding intermediate write states).
- **Always-visible review dock**: the "pending changes" bar sits above the composer even with zero changes (empty state), and shows progress while scanning.
- **Two-level grouping (workspace → session)**: the dock expands into per-session groups with the source turn tagged ("turn N"); multiple sessions in one workspace never cross-contaminate — a turn number is only unique within its session.
- **Real session titles**: session groups show the dsh conversation title (read from the `session/title` log event); before a title exists they fall back to a short session id (e.g. `#356424b9`).
- **Collapsible turn-tail panel**: each finished turn shows a "file changes in turn N" panel, collapsed by default (strictly scoped to the current session).
- **Diff view**: LCS line diff with character-level highlight; a "changed lines only" toggle folds unchanged lines into counts; **two-pane layout** (original | modified) with an independent horizontal scrollbar per pane for long lines.
- **Review actions**: keep / revert per item or per turn; reverts can be redone; a "clear reviewed" button removes the kept/reverted records as a manual cleanup outlet.
- **Open externally**: "Open with..." launches VS Code / VS2022 to open a file or show a diff (the original file is staged temporarily in the workspace), or **reveals the file in the file explorer** (Windows `explorer /select,` / macOS `open -R` / Linux `xdg-open`).
- **Standard settings integration**: editor paths are configured through `settings.yaml`; leaving them empty falls back to auto-detection.

## Install

### From GitHub

```bash
dsh plugin --profile web add github:mabaoli47-collab/dsh-diff-review
```

### From npm (not yet published)

> The plugin is **not yet published to npm**; the command below is not available yet (use the GitHub or local-path route above instead):

~~`dsh plugin --profile web add dsh-diff-review@<version>`~~

### From a local path

```bash
# Copy to a space-free temp dir when the path contains spaces
git clone <repo-url> %TEMP%\dsh-diff-review
dsh plugin --profile web add "file:%TEMP%\dsh-diff-review"
```

**Restart dsh after installing** — a running instance keeps its old composition until restarted.

## Usage

1. Chat and modify files however you like.
2. After a turn finishes:
   - A "pending changes" dock appears above the composer (click to expand → workspace header + per-session groups; the bar offers "keep all in workspace", each session group offers "keep all in session").
   - A "file changes in turn N" panel appears at the tail of that turn (click to expand).
3. Optional: switch the detection mode to "realtime preview" in Settings → Diff Review Plugin; while a conversation is running you then see an "in-progress changes (realtime preview)" block at the top of the dock (Windows only) — expand the diff or open it externally right away; for in-conversation revert, tick "allow realtime revert" (off by default).
4. Click a file to expand its diff (toggle "changed lines only").
5. Keep or revert each change; "Open with..." opens the file or a diff in VS Code / VS2022, or reveals it in the file explorer / Finder.

## Configuration (Settings → Diff Review Plugin)

| Key | Description | Default |
|---|---|---|
| `code` | Path to the VS Code executable (`code` or `Code.exe`) | auto-detect when empty |
| `devenv` | Path to VS2022 `devenv.exe` | auto-detect when empty |
| `vsDiffMerge` | Path to VS2022 `vsDiffMerge.exe` (optional) | derived from the devenv side when empty |
| `maxFiles` | Max files walked per workspace (scan stops at this limit) | `20000` |
| `primeMaxFiles` | Max files pre-read into the baseline cache | `6000` |
| `primeMaxChars` | Baseline character budget (in MB) | `48` |
| `detectMode` | Detection mode: `turn`=scan at end of each turn (default, cross-platform); `live`=realtime preview (`fs.watch`, Windows only; non-Windows falls back to `turn`) | `turn` |
| `liveRevert` | Allow reverting realtime preview items directly (off by default; when enabled live items show a revert button with version-conflict protection — in-progress files may still be rewritten by the AI, a two-writer race, so revert when the AI is not writing the file) | `false` |
| `respectGitignore` | Respect `.gitignore` (on by default: files ignored by the root **and every nested layer** plus user-configured ignore files are never read into the baseline, never turned into review items, never revertable; turning it off falls back to the name-list filter only) | `true` |
| `extraIgnoreFiles` | Custom ignore-file paths (one per line, may live outside the workspace; `.gitignore` format, applied as a low-priority base layer, read-only matching) | empty |
| `trackNewFiles` | Track newly created files (off by default; when enabled new files also produce review items — no pre-session original, so **keep-only, not revertable**) | `false` |

Values are stored in `~/.dsh/settings.yaml` under the `dsh-diff-review` namespace. Numeric items fall back to the default when set to `0` or an invalid value.

## How it works

- **Multi-baseline + session layer**: `STORES: Map<cwd, store>` keeps one independent state bucket per workspace (baseline / version snapshot / content cache / groups / items); `SESSIONS: Map<sessionId, {cwd, lastTurn, label}>` is the session registry; turn keys are `sessionId::turn` and item ids are `sessionId::turn::path`, so multiple sessions in one workspace never collide on equal turn numbers.
- **Session isolation model**: the operation scope is the **current agent's workspace** (the typert `agent` is injected by the runtime and unforgeable; `pickStore` locates the workspace store by session). Formal and live items of other sessions **within the same workspace** can be read and acted on (this is what makes the whole-workspace, per-session-grouped dock review work; "keep all in session" passes an explicit `targetSessionId` that must share the current agent's workspace). **Cross-workspace access is fully isolated.** The realtime preview bucket (live) is workspace-level data (`sessionId='(live)'`).
- **Scan timing**: `agent/turn-stopping` triggers a full `walkWorkspace` version comparison at the end of each turn (default, cross-platform). With `detectMode=live` the workspace is additionally watched with recursive `fs.watch`; events are debounced (600ms) — filenames accumulate into a set for per-file checks (falling back to a full walk on directory-level events or too many paths), correctness still comes from version comparison, the end-of-turn full scan remains as a fallback, an 8s silent-watcher fallback runs a full check when no event arrives, and idle backoff grows exponentially (5s → 80s). Realtime changes land in the `store.live` preview bucket and, **when `liveRevert` is enabled, can be reverted during the conversation** (`applyFileWrite` version-conflict protection refuses if the file was changed again; after a successful revert the item freezes and the file equals the session baseline, so the end-of-turn scan naturally skips it and no duplicate formal item is created); they are folded into the formal items when the turn ends.
- **In-place changes only**: new files are cached but never turned into review items; a version change is what produces a diff.
- **Original-content sources and non-revertable items**: an item's "original content" preferably comes from the session baseline cache; when a modified file falls outside the baseline budget, the original is backfilled by a read-only `git show HEAD:<relPath>` through the host shell (see "Git backfill" under Risk disclosure); content recovered from git is flagged `gitOriginal` — **display-only, never revertable/redoable** (reverting would roll back to HEAD and swallow pre-session uncommitted work); when both sources fail the item is flagged `originalMissing` and is keep-only.
- **Transport (v0.4+)**: the host exposes services through the official **typert RPC** (`dsh-typert-protocol`) — the calling `agent` is injected by the runtime, so session binding cannot be forged; the client mounts the descriptors via `ctx.remote` and calls the namespace methods. **Typert is the only channel** (the transitional `webServer` HTTP route was removed in v0.8), so there is no HTTP attack surface. **Call convention (fixed and pinned in v0.16.5)**: descriptor result/parameters must use strict codecs (the host client loader rejects src-json); namespace methods take (lookup parameter, business parameters...) and the client **passes the current sessionId explicitly as the lookup argument** (the official `ctx.remote.goals.edit(sessionId, ref, req)` pattern — a `(undefined, request)` placeholder misplaces the request and the host rejects it); results are a `RemoteResult` envelope (`{ok, value}`) whose business payload lives in `value` and must be unwrapped; host results must be plain JSON-safe (an `undefined` value is rejected by the gateway's boundary validation).

## Permissions

This plugin is a **high-privilege local development tool**; please understand its actual capabilities before installing:

- **Reads current workspace file content**: to build a file-version baseline and detect changes, the plugin walks and pre-reads workspace text. Sensitive files are excluded by default (a best-effort list, not a security guarantee): `.env*`, `*.pem` / `*.key` / `*.p12` / `*.pfx` / `*.crt` / `*.keystore`, `credentials.*`, `secrets.*`, `config.local.*`, SSH private keys (`id_rsa`/`id_dsa`/`id_ecdsa`/`id_ed25519`, no extension), `secret`/`token`/`api_key`/`apikey` (exact name or `.json`/`.yaml`/`.yml`/`.txt` variants), `.kdbx`, `.netrc` / `.npmrc` / `.git-credentials` / `.pgpass` / `htpasswd`; plus sensitive directories (`.ssh/` `.aws/` `.gnupg/` `.kube/`) and common dependency/build/IDE directories (the full list lives in `IGNORE_DIRS` in `src/host/util.ts`). Since v0.11, files ignored by `.gitignore` are excluded as well, and since v0.13 the **root and every nested `.gitignore`** (including those of nested repositories; each layer governs its own subtree, deeper layers win) are honored — files you explicitly declared untracked are never read into the baseline, never turned into review items, and can never be reverted; `extraIgnoreFiles` additionally allows **ignore files outside the workspace** (the read scope therefore extends to the paths you configure; parsed read-only, never displayed or executed);
- **Watches the workspace in real time (live mode)**: with `detectMode=live` the host process listens to workspace filesystem events directly via **`node:fs`'s `fs.watch`** — a read-only bypass of the dsh fs-service sandbox: the events carry no file content, they only trigger re-comparison, and content reads still go through the sandboxed fs service;
- **Writes workspace files back**: "revert / redo" (and **live preview revert** when `liveRevert` is enabled) restores files to their pre-review versions (with version-conflict detection — a file modified externally is refused rather than overwritten);
- **Launches external processes**: "Open with..." starts the editor **you configured** (VS Code / VS2022) or the file explorer (`explorer.exe` / `open -R` / `xdg-open`) with full sandbox access (`danger-full-access`) — triggerable from both formal and live preview items, only on your explicit click;
- **Transport (v0.4)**: host/client communicate **only** over the official **typert RPC** (`dsh-typert-protocol`; the agent is injected by the runtime, giving natural session binding and no HTTP attack surface). The transitional HTTP route was removed in v0.8 — typert is the only channel.

**Threat model**: the plugin's trust boundary is the dsh host process plus the local browser (typert is an internal host channel; no network listener). The plugin **never uploads any data** — all communication is local browser ↔ host traffic. The realtime preview bucket (live) is workspace-level data: reads/actions on it are not bound to the initiating session, but writes (revert) only happen from a same-origin local client and are gated by `liveRevert` plus version-conflict protection.

## Risk disclosure

The plugin applies path-boundary, command-injection and TOCTOU/version-conflict protections, but the following **residual and conditional risks** should be understood:

- **Sensitive-file filtering is best-effort, not a security guarantee**: the default exclusion list matches file names/extensions. Credential styles outside the list (e.g. `db_password`, `prod.env.bak`) or compressed/encoded variants (e.g. `id_rsa.zip`, `cert.base64`) will not match and may be read into the baseline cache and shown as diffs. **Hardening (v0.11/v0.13)**: with `respectGitignore` on, files ignored by **any `.gitignore` layer (including nested repositories' own)** are never read into the baseline or turned into review items — adding a custom sensitive file to any layer's `.gitignore` gives it equivalent protection; `extraIgnoreFiles` extends this to user-configured files outside the workspace (base layer, low priority). **Do not use this plugin in workspaces containing such files, or keep sensitive files outside the scanned scope.**
- **TOCTOU window in revert/redo**: `applyFileWrite` has a very short gap between path validation and the write; if a local malicious process swaps the target file for a symlink pointing outside the workspace exactly in that window, the write could escape. The threat source (a local malicious process) already has filesystem privileges, so the plugin cannot fully defend against it.
- **Temp-file permissions**: `dsh-dr-tmp-orig-*` files are isolated under `%TEMP%` (NTFS ACL) on Windows; however `chmod 600` is not guaranteed to take effect on Windows or networked filesystems, so on shared machines or SMB/NFS-mounted temp dirs other users may read these temp files containing source code. Files remain on disk while the editor has them open and are cleaned by the OS later; the plugin additionally registers them and attempts deletion **2 hours after creation** (failures while the editor still holds them are ignored and retried).
- **Debug tool `drvw_debug`**: registered as a model tool (only **read-only** debug actions: `state`/`scan`; `revertAll` removed; cwd locked to the current session workspace; scan throttled to once per 2s and is a **full dry-run** — it only counts changes, never writes items/groups/contentCache/baseline and never advances rev). Prompt injection could still lure the model into calling it and expose current-workspace information to the model — the model already has workspace file access, so this risk is equivalent to using the fs/shell tools directly.
- **Resource usage**: scans and baseline caching are capped (`maxFiles` / `primeMaxFiles` / `primeMaxChars`, configurable), but raising the caps too far noticeably increases memory and scan time; pending review items keep original/modified/current copies in memory, so long sessions grow continuously. **Automatic reclamation (v0.9)**: a 60s maintenance pass releases the fs.watch handle and timers of any workspace idle for over 10 minutes (no session activity — page closed / no conversation; rebuilt automatically on reactivation) and evicts the oldest `contentCache` entries once it exceeds 40000 (the affected files' later diffs fall back to git backfill or "original unknown").
- **Realtime preview (live mode) resources & reliability**: `detectMode=live` keeps one recursive `fs.watch` handle per workspace that has been visited (Windows; handles accumulate when switching workspaces and are released when the plugin unloads); watcher events are only triggers — debounce-window filenames accumulate into a set checked per file, directory-level events or too many paths (event-set cap 1000) fall back to a full walk, and an 8s silent-watcher fallback runs a full check, so missed events only delay detection, never lose it; a churn-heavy workspace incurs periodic incremental comparison cost. This mode is Windows-only; other platforms fall back to turn mode automatically.
- **Two-writer race when realtime revert is enabled (`liveRevert`)**: an in-progress file may still be rewritten by the AI — the AI's later writes can overwrite content you just reverted (version-conflict detection refuses a revert if the file was already changed, but cannot stop later AI writes). Revert when the AI is not writing that file.
- **Git backfill**: to recover original content for files outside the baseline budget, the plugin runs a read-only `git show HEAD:<relPath>` through the host shell (10s timeout). **Before the call it refuses filenames containing glob characters (`*` `?` `[` `]`), `$`, backticks, control characters (including newlines), or absolute paths**, and applies platform-aware single-quote escaping — eliminating path-interpretation ambiguity and command injection; a non-zero exit code, a `fatal:`/`ERR:`-prefixed output, or a result over 2MB is treated as failure and the backfill is abandoned (falls back to "original unknown"). This only reads; it never modifies files.

## Known limitations

- **Deletions / renames are not tracked**: only in-place modifications are reviewed. A deleted file cannot produce a review item (and cannot be reverted); a rename is seen as "old path deleted + new path added", neither of which enters review scope.
- **Realtime preview does not cover new files**: same as turn mode — new files are only cached, never turned into review items ("in-place changes only"); realtime preview likewise only produces items for tracked files whose version changed.
- **A realtime diff is a snapshot taken at expand time**: while the AI keeps writing the file, an already-expanded realtime diff does not auto-refresh — collapse and re-expand to see the latest.
- **Git-backfilled originals are not revertable**: content recovered from git HEAD (`gitOriginal`) is display-only; if there were uncommitted local edits before the session started, HEAD content ≠ the actual pre-session content, and reverting would swallow that work — so these items are **keep-only**.
- **Huge-workspace truncation (configurable)**: walking stops at the `maxFiles` limit (default 20000); `getState` reports `truncated: true` and the dock shows a warning carrying the current limit. The baseline pre-read caps `primeMaxFiles` (default 6000) / `primeMaxChars` (default 48 MB) are also adjustable in Settings → Diff Review Plugin. Raising the caps too far can noticeably increase memory usage and scan time. Files over 2MB are not read into the baseline and count toward the dock's "N files not included: too large / unreadable" hint (`skippedCount`).
- **Temp originals**: opening an external diff writes the original content with a `dsh-dr-tmp-orig-*` prefix into the **system temp directory** (OS-managed cleanup; never pollutes the workspace or git). If the host sandbox forbids writing the system temp dir, it falls back to the workspace `.dsh-dr-tmp-orig/` subdirectory (add it to `.gitignore` in that case).
- **External editor permissions**: "Open with..." launches the external editor / file-explorer process with full sandbox access (`danger-full-access`) — this happens only on your explicit click, so GUI applications can run normally.
- **Path boundary guards**: both scanning and write-back validate that the resolved real path (after symlink resolution) stays inside the workspace root; out-of-root symlinks/junctions are skipped for comparison and revert/redo refuse to write back.
- **Editor path control-character check**: `saveEditorConfig` rejects paths containing newlines/control characters (paths end up inside PowerShell commands; this removes the script-injection surface).
- **Session titles depend on dsh**: session-group labels prefer the dsh conversation title (the `session/title` event); a brand-new session with no title yet shows a short-id placeholder and updates automatically once the title is generated.

## Development

```bash
npm run build      # generate lib/ from src/ (including lib/types/index.d.ts)
npm test           # vitest unit tests (pure functions: path/boundary/sensitive-list/diff/gitignore; 39 cases)
npm run verify:pack # pack artifact gate: files manifest / syntax / client banner / host export shape / version consistency
npm pack --dry-run  # full publish chain (prepack = build + test + verify:pack)
```

- `src/index.ts` is the host half (ESM `name`/`inject`/`apply`); `src/host/util.ts` holds pure, unit-testable helpers; `src/host/typert.ts` defines the typert descriptors (wire contract).
- `src/client/index.ts` is the client half (bundled into the `window.__ModuleLoader__.load` format); `scripts/build.mjs` turns the multi-file host plus the single-file client into `lib/`.
- `src/types/index.d.ts` is a hand-written public type surface (the runtime source is unannotated plain JS) that build copies to `lib/types/`; `scripts/verify-pack.mjs` is the release gate (the counterpart of rich-file-review's `test:pack`).

## Version history

| Version | Highlights |
|---|---|
| v0.4.x | Transport migrated to the official **typert RPC** (agent injected, unforgeable session binding); HTTP route demoted to transitional fallback; hardening (fail-closed session isolation, redo guard, degraded large-file hint, fetchItem race fix) |
| v0.5.x | **Realtime preview** (`detectMode=live`: Windows `fs.watch` + incremental version comparison + silent-watcher fallback); live startup fix (first getState registers the session); event accumulation and 8s fallback |
| v0.6.x | Live items can expand diffs / open externally; live revert (v0.6.0); fixed live expansion stuck on "loading diff..." (getItem session-check exemption for live items) |
| v0.7.0 | Realtime revert becomes the opt-in setting **`liveRevert`** (off by default) |
| v0.8.0 | **Transitional HTTP route and client fetch fallback removed** — typert is the only channel, no HTTP attack surface (CSRF/DNS-rebinding guards removed with it) |
| v0.9.0 | **Automatic memory reclamation**: idle workspaces (10 min without activity) release their fs.watch handle and timers; `contentCache` evicts the oldest entries above 40000; git backfill refuses filenames containing `$`/backtick (defense in depth) |
| v0.10.0 | **Robustness**: realtime checks join the scanChain serial queue (no concurrency with turn scans); `removeLivePath` uses exact path matching (POSIX case-sensitive); external-diff temp files are cleaned after 2h; the live block is labeled "workspace-level" in the UI |
| v0.11.0 | **Sensitive hardening (`.gitignore`)**: files ignored by the workspace-root `.gitignore` are never read into the baseline, never turned into review items, never revertable (pure-function matcher with unit tests; root `.gitignore` only) |
| v0.11.1 | `.gitignore` exclusion becomes the setting **`respectGitignore`** (on by default, can be turned off) |
| v0.12.0 | **Review fixes**: cross-session actions unified to "current workspace" semantics (`reviewSession` accepts `targetSessionId` with same-workspace check; `getItem` returns an error object instead of stalling on "loading diff..."); live silent fallback now uses **exponential backoff** (idle workspaces no longer full-scan every 5s); explicit `agentSessionId`; debug scans use a dedicated session and do not advance the baseline; baseline failure can retry; state diff now covers `truncated`/`limits`; render-time side effects moved into effects; polling pauses while the page is hidden; dead code / stale copy cleaned |
| v0.13.0 | **Nested `.gitignore` + custom ignore files**: every layer's `.gitignore` is honored (each governs its own subtree, deeper layers win; parent layers also apply inside nested repositories — more conservative than git); new setting `extraIgnoreFiles` accepts user-configured ignore files outside the workspace (base layer, read-only matching) |
| v0.14.0 | **Review fixes**: `drvw_debug` scan is now a **full dry-run** (no longer overwrites contentCache so real-turn review items can't be silently skipped, no ghost items); gitignore parses line-by-line (broken lines dropped, rest applies) with a 5000-rule cap and `**/` root-level matching; revert/redo re-check the ignore rules; gitignore rule layers are TTL-cached and existence is read from entries (no wasted IO); baselineError cleared on retry, `_fallbackMs` reset, keepSession errors surfaced |
| v0.14.1 | **Review polish**: character-class length cap (ReDoS self-harm guard); session-isolation semantic change annotated with its version; `checkLiveFile` vs `walkWorkspace` gitignore equivalence documented |
| v0.15.0 | **Review fixes**: per-pattern length cap (1024) against regex stack-overflow DoS + try/catch around rule tests; **rule cap lowered from 5000 to 2000** (the length cap already contains the DoS, 2000 suffices for daily use); `realPathBlocked` checks only segments below the workspace root (workspaces under `build/` no longer fail wholesale) and folds case on Windows drive paths (`.SSH`/`NODE_MODULES` match); gitignore rule cache now version-checked (no 30s fail-open window) and symlinked `.gitignore` out of the workspace is skipped; `pickStore` dropped the last-active-workspace fallback (fail-closed); live event set capped at 1000 |
| v0.15.1 | **Match-result cache (R1 perf)**: repeated gitignore matching of the same file across walks/live/review is replaced by a per-file result cache (TTL 30s, cleared when rules change) — removes the repeated matching cost of the live fallback and end-of-turn full scans; rule cap stays at 2000 (not lowered, to avoid losing functionality) |
| v0.15.2 | **Review fixes (P2)**: `giCachedUpTo` checks the result cache first (zero FS cost on hit); `cachedGitignoreRules` accepts an external version (walk skips stat); dry-run scan reports `changedCount` and skips diff computation; per-pattern wildcard cap of 64 (closes the exponential-backtracking ReDoS); invalidation matrix completed (extraLayers/saveEditorConfig clear caches, unchanged version no longer clears the match cache), getItem null exit, idle release clears caches |
| v0.16.0 | **Functional iteration**: skipped-file observability (`skippedCount`, dock shows "N files not included: too large / unreadable"); new-file tracking (setting `trackNewFiles`, off by default, keep-only); conflict-refusal guidance; gitOriginal degradation hint; live option disabled up front on non-Windows; "clear reviewed" button (removes kept/reverted records as a manual cleanup outlet) |
| v0.16.1 | **Engineering (mirroring rich-file-review)**: TypeScript type declarations (`lib/types/index.d.ts`, exports gain a types field); `verify:pack` artifact gate (files manifest / syntax / banner / export shape / version consistency, the counterpart of its `test:pack`); prepack chain = build + test + verify |
| v0.16.2-0.16.4 | **Typert transport fix (first end-to-end RPC)**: since v0.4 the client used src-json codecs and single-argument calls, which the host client loader silently rejected — the v0.4.x HTTP fetch fallback masked it until v0.8 removed the fallback. Fixes: client logs the real error instead of swallowing it; descriptors use strict codecs (host `z.any()` / client duck-typed zod schema, same passthrough semantics). **After upgrading, hard-refresh / use an incognito window** |
| v0.16.5 | **Typert call-convention fix (actually usable end-to-end)**: v0.16.2-0.16.4 could connect, but the client call convention was wrong so every data call failed (dock permanently "unrecognized", settings never saved, while the host log looked healthy). Fixes: namespace methods take (lookup parameter, business parameters...) and the client **passes the sessionId explicitly as the lookup argument** (the official pattern; `(undefined, request)` misplaces the request and the host rejects it with "args fields do not match the descriptor"); the `RemoteResult` envelope is unwrapped (`.value`); host results must be plain JSON-safe (undefined values rejected by the gateway — itemFull fixed, verify-pack gained an undefined-field gate). **Verification discipline: a working RPC connection and rendered UI do NOT mean data calls succeed — inspect what the client actually receives** |

## License

MIT

## Notes from the author

Most of this project's code was written with AI assistance. The author is still learning by doing, with limited skill and energy. The plugin currently works for my own workflow, so I open-sourced it along the way. Testing has been far from thorough, so if you hit a bug, feel free to open an issue — but I may not have the ability or time to solve every complex problem. Contributions are very welcome: fork it, fix it, and submit a PR. This project is maintained on a best-effort basis. Thanks for your patience and understanding!

This is an early version: the code quality may not be great, and there are some god-function issues. Please bear with us!
