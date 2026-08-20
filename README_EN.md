# dsh-diff-review

Per-turn **file-change diff review** for DeepSeek Harness (dsh) Web. After each conversation turn, the plugin scans the workspace for files that were **modified in place** (new/deleted files are ignored), builds a VS Code-style two-pane diff, and lets you **keep / revert / redo** each change.

> [中文文档](./README.md) · English README

## Features

- **Multi-workspace, multi-baseline**: each workspace gets its own baseline and change tracking; switching workspaces never cross-contaminates state (same file names or turn numbers do not collide).
- **Detects every modification source**: end-of-turn full version diff catches changes made by bash, editors, or write tools alike.
- **Optional realtime preview (v0.5)**: the detection mode can be switched between "end of turn" and "realtime preview" — realtime mode watches the workspace with `fs.watch` (Windows only) and shows a read-only "in-progress changes" preview while the conversation is running; it is folded into the formal review items when the turn ends (avoiding intermediate write states).
- **Always-visible review dock**: the "pending changes" bar sits above the composer even with zero changes (empty state), and shows progress while scanning.
- **Two-level grouping (workspace → session)**: the dock expands into per-session groups with the source turn tagged ("turn N"); multiple sessions in one workspace never cross-contaminate — a turn number is only unique within its session.
- **Real session titles**: session groups show the dsh conversation title (read from the `session/title` log event); before a title exists they fall back to a short session id (e.g. `#356424b9`).
- **Collapsible turn-tail panel**: each finished turn shows a "file changes in turn N" panel, collapsed by default (strictly scoped to the current session).
- **Diff view**: LCS line diff with character-level highlight; a "changed lines only" toggle folds unchanged lines into counts; **two-pane layout** (original | modified) with an independent horizontal scrollbar per pane for long lines.
- **Review actions**: keep / revert per item or per turn; reverts can be redone.
- **Open externally**: "Open with..." launches VS Code / VS2022 to open a file or show a diff (the original file is staged temporarily in the workspace), or **reveals the file in the file explorer** (Windows `explorer /select,` / macOS `open -R` / Linux `xdg-open`).
- **Standard settings integration**: editor paths are configured through `settings.yaml`; leaving them empty falls back to auto-detection.

## Install

### From npm (once published)

```bash
dsh plugin --profile web add dsh-diff-review@<version>
```

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
3. Optional: switch the detection mode to "realtime preview" in Settings → Diff Review Plugin; while a conversation is running you then see a read-only "in-progress changes (realtime preview)" block at the top of the dock (Windows only).
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

Values are stored in `~/.dsh/settings.yaml` under the `dsh-diff-review` namespace. Numeric items fall back to the default when set to `0` or an invalid value.

## How it works

- **Multi-baseline + session layer**: `STORES: Map<cwd, store>` keeps one independent state bucket per workspace (baseline / version snapshot / content cache / groups / items); `SESSIONS: Map<sessionId, {cwd, lastTurn, label}>` is the session registry; turn keys are `sessionId::turn` and item ids are `sessionId::turn::path`, so multiple sessions in one workspace never collide on equal turn numbers.
- **Scan timing**: `agent/turn-stopping` triggers a full `walkWorkspace` version comparison at the end of each turn (default, cross-platform). With `detectMode=live` the workspace is additionally watched with recursive `fs.watch`; events are debounced (600ms) before a per-file / full incremental comparison runs — the watcher is only a trigger, correctness still comes from version comparison, and the end-of-turn full scan remains as a fallback, so a missed watcher event only delays detection, never loses it. Realtime changes land in the read-only `store.live` preview bucket and are folded into the formal items when the turn ends.
- **In-place changes only**: new files are cached but never turned into review items; a version change is what produces a diff.
- **Transport (v0.4+)**: the host exposes services through the official **typert RPC** (`dsh-typert-protocol`) — the calling `agent` is injected by the runtime, so session binding cannot be forged and there is no HTTP attack surface; the client mounts the descriptors via `ctx.remote` and calls the namespace methods. The `webServer` HTTP route is kept as a **transitional fallback** and will be removed once the migration is fully verified.

## Permissions

This plugin is a **high-privilege local development tool**; please understand its actual capabilities before installing:

- **Reads current workspace file content**: to build a file-version baseline and detect changes, the plugin walks and pre-reads workspace text (sensitive files are excluded by default — `.env*`, `*.pem` / `*.key` / `*.p12` / `*.pfx` / `*.crt` / `*.keystore`, `credentials.*`, `secrets.*`, `config.local.*`, SSH private keys (`id_rsa`/`id_ed25519` and friends, no extension), `.netrc` / `.npmrc` / `.git-credentials` / `.pgpass` / `htpasswd`, and the `.ssh/` `.aws/` `.gnupg/` `.kube/` directories — **a best-effort list, not a security guarantee**);
- **Writes workspace files back**: "revert / redo" restores files to their pre-review versions (with version-conflict detection — a file modified externally is refused rather than overwritten);
- **Launches external processes**: "Open with..." starts the editor **you configured** (VS Code / VS2022) or the file explorer (`explorer.exe` / `open -R` / `xdg-open`) with full sandbox access (`danger-full-access`) — only on your explicit click;
- **Transport (v0.4)**: host/client communicate over the official **typert RPC** (`dsh-typert-protocol`; the agent is injected by the runtime, giving natural session binding and no HTTP attack surface). The `webServer` HTTP route is a **transitional fallback** (the client falls back to fetch while typert is unavailable); during the transition its trust boundary is the host's listening address (loopback `127.0.0.1` by default), and it will be deleted once the migration is complete.

**Threat model**: the plugin's trust boundary is the local loopback plus the host's listening address. The plugin **never uploads any data** — all communication is local browser ↔ host traffic.

## Risk disclosure

The plugin applies path-boundary, command-injection, TOCTOU/version-conflict protections (plus CSRF/DNS-rebinding and Host-allowlist guards on the **transitional** HTTP route), but the following **residual and conditional risks** should be understood:

- **Sensitive-file filtering is best-effort, not a security guarantee**: the default exclusion list matches file names/extensions. Keys without a standard suffix (e.g. a file literally named `secret` or `token`) or compressed/encoded credential files (e.g. `id_rsa.zip`, `cert.base64`) will not match and may be read into the baseline cache and shown as diffs. **Do not use this plugin in workspaces containing such files, or keep sensitive files outside the scanned scope.**
- **TOCTOU window in revert/redo**: `applyFileWrite` has a very short gap between path validation and the write; if a local malicious process swaps the target file for a symlink pointing outside the workspace exactly in that window, the write could escape. The threat source (a local malicious process) already has filesystem privileges, so the plugin cannot fully defend against it.
- **Temp-file permissions**: `dsh-dr-tmp-orig-*` files are isolated under `%TEMP%` (NTFS ACL) on Windows; however `chmod 600` is not guaranteed to take effect on Windows or networked filesystems, so on shared machines or SMB/NFS-mounted temp dirs other users may read these temp files containing source code. Files remain on disk while the editor has them open and are cleaned by the OS later.
- **Transitional HTTP route**: the `webServer` route stays until the typert migration is complete. During the transition, binding dsh's `webServer` to a non-loopback address (e.g. `0.0.0.0`) would expose that route's API — do not expose dsh to untrusted networks. **Once the migration completes, this route (and its CSRF/DNS-rebinding/Host/Origin guards) is deleted entirely and the attack surface goes to zero.**
- **Debug tool `drvw_debug`**: registered as a model tool (only **no-write-back** debug actions: `state`/`scan`; `revertAll` removed; cwd locked to the current session workspace; scan throttled to once per 2s and updates the plugin's own baseline/cache state). Prompt injection could still lure the model into calling it and expose current-workspace information to the model — the model already has workspace file access, so this risk is equivalent to using the fs/shell tools directly.
- **Resource usage**: scans and baseline caching are capped (`maxFiles` / `primeMaxFiles` / `primeMaxChars`, configurable), but raising the caps too far noticeably increases memory and scan time; pending review items keep original/modified/current copies in memory, so long sessions grow continuously.
- **Realtime preview (live mode) resources & reliability**: `detectMode=live` keeps one recursive `fs.watch` handle per workspace that has been visited (Windows), so handles accumulate when switching workspaces; watcher events are only triggers — missed events never lose changes (end-of-turn fallback), but a churn-heavy workspace incurs periodic incremental comparison cost (600ms debounce). This mode is Windows-only; other platforms fall back to turn mode automatically.
- **Git backfill**: to recover original content for files outside the baseline budget, the plugin runs a read-only `git show` through the host shell (10s timeout, paths containing glob characters are refused). This only reads; it never modifies files.

## Known limitations

- **Deletions / renames are not tracked**: only in-place modifications are reviewed. A deleted file cannot produce a review item (and cannot be reverted); a rename is seen as "old path deleted + new path added", neither of which enters review scope.
- **Huge-workspace truncation (configurable)**: walking stops at the `maxFiles` limit (default 20000); `getState` reports `truncated: true` and the dock shows a warning carrying the current limit. The baseline pre-read caps `primeMaxFiles` (default 6000) / `primeMaxChars` (default 48 MB) are also adjustable in Settings → Diff Review Plugin. Note that raising the caps too far can noticeably increase memory usage and scan time.
- **Temp originals**: opening an external diff writes the original content with a `dsh-dr-tmp-orig-*` prefix into the **system temp directory** (OS-managed cleanup; never pollutes the workspace or git). If the host sandbox forbids writing the system temp dir, it falls back to the workspace `.dsh-dr-tmp-orig/` subdirectory (add it to `.gitignore` in that case).
- **External editor permissions**: "Open with..." launches the external editor / file-explorer process with full sandbox access (`danger-full-access`) — this happens only on your explicit click, so GUI applications can run normally.
- **Transitional HTTP-route guards (removed after migration)**: `/dsh-diff-review` stays during the transition — write/dangerous actions validate `Origin` (CSRF), every request validates the loopback Host allowlist plus loopback client source (DNS rebinding and non-loopback exposure). Once the typert migration completes, the route and these guards are removed.
- **Path boundary guards**: both scanning and write-back validate that the resolved real path (after symlink resolution) stays inside the workspace root; out-of-root symlinks/junctions are skipped for comparison and revert/redo refuse to write back.
- **Editor path control-character check**: `saveEditorConfig` rejects paths containing newlines/control characters (paths end up inside PowerShell commands; this removes the script-injection surface).
- **Session titles depend on dsh**: session-group labels prefer the dsh conversation title (the `session/title` event); a brand-new session with no title yet shows a short-id placeholder and updates automatically once the title is generated.

## Development

```bash
npm run build   # generate lib/ from src/
npm test        # vitest unit tests (pure functions: path/boundary/sensitive-list/diff)
```

- `src/index.ts` is the host half (ESM `name`/`inject`/`apply`); `src/host/util.ts` holds pure, unit-testable helpers; `src/host/typert.ts` defines the typert descriptors (wire contract).
- `src/client/index.ts` is the client half (bundled into the `window.__ModuleLoader__.load` format); `scripts/build.mjs` turns the multi-file host plus the single-file client into `lib/`.

## License

MIT

## Notes from the author

Most of this project's code was written with AI assistance. The author is still learning by doing, with limited skill and energy. The plugin currently works for my own workflow, so I open-sourced it along the way. Testing has been far from thorough, so if you hit a bug, feel free to open an issue — but I may not have the ability or time to solve every complex problem. Contributions are very welcome: fork it, fix it, and submit a PR. This project is maintained on a best-effort basis. Thanks for your patience and understanding!

This is an early version: the code quality may not be great, and there are some god-function issues. Please bear with us!
