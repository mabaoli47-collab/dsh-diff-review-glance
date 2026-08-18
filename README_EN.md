# dsh-diff-review

Per-turn **file-change diff review** for DeepSeek Harness (dsh) Web. After each conversation turn, the plugin scans the workspace for files that were **modified in place** (new/deleted files are ignored), builds a VS Code-style two-pane diff, and lets you **keep / revert / redo** each change.

> [中文文档](./README.md) · English README

## Features

- **Multi-workspace, multi-baseline**: each workspace gets its own baseline and change tracking; switching workspaces never cross-contaminates state (same file names or turn numbers do not collide).
- **Detects every modification source**: end-of-turn full version diff catches changes made by bash, editors, or write tools alike.
- **Always-visible review dock**: the "pending changes" bar sits above the composer even with zero changes (empty state), and shows progress while scanning.
- **Two-level grouping (workspace → session)**: the dock expands into per-session groups with the source turn tagged ("turn N"); multiple sessions in one workspace never cross-contaminate — a turn number is only unique within its session.
- **Real session titles**: session groups show the dsh conversation title (read from the `session/title` log event); before a title exists they fall back to a short session id (e.g. `#356424b9`).
- **Collapsible turn-tail panel**: each finished turn shows a "file changes in turn N" panel, collapsed by default (strictly scoped to the current session).
- **Diff view**: LCS line diff with character-level highlight; a "changed lines only" toggle folds unchanged lines into counts.
- **Review actions**: keep / revert per item or per turn; reverts can be redone.
- **Open in external editors**: "Open with..." launches VS Code / VS2022 to open a file or show a diff (the original file is staged temporarily in the workspace).
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
3. Click a file to expand its diff (toggle "changed lines only").
4. Keep or revert each change; "Open with..." opens the file or a diff in VS Code / VS2022.

## Configuration (Settings → Diff Review Plugin)

| Key | Description | Default |
|---|---|---|
| `code` | Path to the VS Code executable (`code` or `Code.exe`) | auto-detect when empty |
| `devenv` | Path to VS2022 `devenv.exe` | auto-detect when empty |
| `vsDiffMerge` | Path to VS2022 `vsDiffMerge.exe` (optional) | derived from the devenv side when empty |
| `maxFiles` | Max files walked per workspace (scan stops at this limit) | `20000` |
| `primeMaxFiles` | Max files pre-read into the baseline cache | `6000` |
| `primeMaxChars` | Baseline character budget (in MB) | `48` |

Values are stored in `~/.dsh/settings.yaml` under the `dsh-diff-review` namespace. Numeric items fall back to the default when set to `0` or an invalid value.

## How it works

- **Multi-baseline + session layer**: `STORES: Map<cwd, store>` keeps one independent state bucket per workspace (baseline / version snapshot / content cache / groups / items); `SESSIONS: Map<sessionId, {cwd, lastTurn, label}>` is the session registry; turn keys are `sessionId::turn` and item ids are `sessionId::turn::path`, so multiple sessions in one workspace never collide on equal turn numbers.
- **Scan timing**: `agent/turn-stopping` triggers a full `walkWorkspace` version comparison at the end of each turn.
- **In-place changes only**: new files are cached but never turned into review items; a version change is what produces a diff.
- **Transport**: the host exposes JSON APIs over a `webServer` route; the client calls them with `fetch`. The client reads `sessionId` from the slot's standard props and the host maps `sessionId → cwd` to locate the workspace bucket, so even a pure GUI workspace switch refreshes correctly; after a page refresh the session id is re-injected and recognition recovers automatically without losing the workspace.

## Permissions

This plugin is a **high-privilege local development tool**; please understand its actual capabilities before installing:

- **Reads current workspace file content**: to build a file-version baseline and detect changes, the plugin walks and pre-reads workspace text (sensitive files are excluded by default — `.env*`, `*.pem` / `*.key` / `*.p12` / `*.pfx` / `*.crt` / `*.keystore`, `credentials.*`, `secrets.*`, `config.local.*`, SSH private keys (`id_rsa`/`id_ed25519` and friends, no extension), `.netrc` / `.npmrc` / `.git-credentials` / `.pgpass` / `htpasswd`, and the `.ssh/` `.aws/` `.gnupg/` `.kube/` directories — **a best-effort list, not a security guarantee**);
- **Writes workspace files back**: "revert / redo" restores files to their pre-review versions (with version-conflict detection — a file modified externally is refused rather than overwritten);
- **Launches external processes**: "Open with..." starts the editor **you configured** (VS Code / VS2022) with full sandbox access (`danger-full-access`) — only on your explicit click;
- **Local HTTP API**: `/dsh-diff-review`'s trust boundary is **the host's listening address** (loopback `127.0.0.1` by default); write actions validate the request source (blocking browser CSRF and DNS rebinding) and every request validates the Host header. **If you bind dsh's webServer to a non-loopback address (e.g. `0.0.0.0`), this plugin's local API is exposed along with it — assess the risk yourself.**

**Threat model**: the plugin's trust boundary is the local loopback plus the host's listening address. The plugin **never uploads any data** — all communication is local browser ↔ host traffic.

## Risk disclosure

The plugin applies path-boundary, request-source (CSRF/DNS-rebinding), Host-allowlist, command-injection, and TOCTOU/version-conflict protections, but the following **residual and conditional risks** should be understood:

- **Sensitive-file filtering is best-effort, not a security guarantee**: the default exclusion list matches file names/extensions. Keys without a standard suffix (e.g. a file literally named `secret` or `token`) or compressed/encoded credential files (e.g. `id_rsa.zip`, `cert.base64`) will not match and may be read into the baseline cache and shown as diffs. **Do not use this plugin in workspaces containing such files, or keep sensitive files outside the scanned scope.**
- **TOCTOU window in revert/redo**: `applyFileWrite` has a very short gap between path validation and the write; if a local malicious process swaps the target file for a symlink pointing outside the workspace exactly in that window, the write could escape. The threat source (a local malicious process) already has filesystem privileges, so the plugin cannot fully defend against it.
- **Temp-file permissions**: `dsh-dr-tmp-orig-*` files are isolated under `%TEMP%` (NTFS ACL) on Windows; however `chmod 600` is not guaranteed to take effect on Windows or networked filesystems, so on shared machines or SMB/NFS-mounted temp dirs other users may read these temp files containing source code. Files remain on disk while the editor has them open and are cleaned by the OS later.
- **When the host binds a non-loopback address**: if dsh's `webServer` is bound to `0.0.0.0` or a LAN address, this plugin's local API (including read endpoints) is exposed along with it. The plugin cannot constrain the host's listening address — **do not expose dsh to untrusted networks**.
- **Debug tool `drvw_debug`**: registered as a model tool (read-only: `state`/`scan`; `revertAll` removed; cwd locked to the current session workspace; scan throttled to once per 2s). Prompt injection could still lure the model into calling it and expose current-workspace information to the model — the model already has workspace file access, so this risk is equivalent to using the fs/shell tools directly.
- **Resource usage**: scans and baseline caching are capped (`maxFiles` / `primeMaxFiles` / `primeMaxChars`, configurable), but raising the caps too far noticeably increases memory and scan time; pending review items keep original/modified/current copies in memory, so long sessions grow continuously.
- **Git backfill**: to recover original content for files outside the baseline budget, the plugin runs a read-only `git show` through the host shell (10s timeout, paths containing glob characters are refused). This only reads; it never modifies files.

## Known limitations

- **Deletions / renames are not tracked**: only in-place modifications are reviewed. A deleted file cannot produce a review item (and cannot be reverted); a rename is seen as "old path deleted + new path added", neither of which enters review scope.
- **Huge-workspace truncation (configurable)**: walking stops at the `maxFiles` limit (default 20000); `getState` reports `truncated: true` and the dock shows a warning carrying the current limit. The baseline pre-read caps `primeMaxFiles` (default 6000) / `primeMaxChars` (default 48 MB) are also adjustable in Settings → Diff Review Plugin. Note that raising the caps too far can noticeably increase memory usage and scan time.
- **Temp originals**: opening an external diff writes the original content with a `dsh-dr-tmp-orig-*` prefix into the **system temp directory** (OS-managed cleanup; never pollutes the workspace or git). If the host sandbox forbids writing the system temp dir, it falls back to the workspace `.dsh-dr-tmp-orig/` subdirectory (add it to `.gitignore` in that case).
- **External editor permissions**: "Open with..." launches the external editor process with full sandbox access (`danger-full-access`) — this happens only on your explicit click, so GUI applications can run normally.
- **Origin check on local route writes**: write/dangerous actions on `/dsh-diff-review` (revert, keep-all, open external editor, save config) validate the request `Origin`: cross-site origins are rejected (blocking browser-CSRF-triggered side effects), while same-origin requests and Origin-less local clients are unaffected.
- **Loopback Host allowlist + reads checked too**: every request (including `getState`/`getItem`) requires the `Host` header to be `localhost`/`127.0.0.1`/`[::1]` (or equal to the server's actual listening address) — this blocks DNS-rebinding attacks that would otherwise bypass the Origin check and silently read workspace file information.
- **Path boundary guards**: both scanning and write-back validate that the resolved real path (after symlink resolution) stays inside the workspace root; out-of-root symlinks/junctions are skipped for comparison and revert/redo refuse to write back.
- **Editor path control-character check**: `saveEditorConfig` rejects paths containing newlines/control characters (paths end up inside PowerShell commands; this removes the script-injection surface).
- **Session titles depend on dsh**: session-group labels prefer the dsh conversation title (the `session/title` event); a brand-new session with no title yet shows a short-id placeholder and updates automatically once the title is generated.

## Development

```bash
npm run build   # generate lib/ from src/
```

`src/index.ts` is the host half (ESM `name`/`inject`/`apply`); `src/client/index.ts` is the client half (bundled into the `window.__ModuleLoader__.load` format).

## License

MIT

## Notes from the author

Most of this project's code was written with AI assistance. The author is still learning by doing, with limited skill and energy. The plugin currently works for my own workflow, so I open-sourced it along the way. Testing has been far from thorough, so if you hit a bug, feel free to open an issue — but I may not have the ability or time to solve every complex problem. Contributions are very welcome: fork it, fix it, and submit a PR. This project is maintained on a best-effort basis. Thanks for your patience and understanding!

This is an early version: the code quality may not be great, and there are some god-function issues. Please bear with us!
