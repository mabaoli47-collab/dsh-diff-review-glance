# Security

dsh-diff-review is a **high-privilege local development tool** for the DeepSeek Harness (dsh) web UI. Read the permissions, threat model, risk disclosure and known-limitations sections of [README.md](README.md) before installing or reviewing this plugin.

## Capability summary

- **Reads the current workspace**: builds a file-version baseline and detects in-place modifications; sensitive files are excluded on a best-effort basis (name/suffix list).
- **Watches the workspace in live mode**: the host process listens to workspace filesystem events via `node:fs` `fs.watch` (Windows only). Events carry no file content and only trigger re-comparison; content reads go through the sandboxed fs service. This is a read-only bypass of the fs-service sandbox, documented in README.
- **Writes workspace files back**: revert / redo restore pre-review versions with version-conflict detection (a file changed externally is refused, not overwritten). When the opt-in setting `liveRevert` is enabled, realtime preview items can be reverted with the same protection.
- **Launches external processes**: configured editors (VS Code / VS2022) or the file explorer are started with full sandbox access (`danger-full-access`) only on explicit user click, from formal and live preview items alike.
- **Runs a read-only `git show`** for baseline backfill (10s timeout; glob characters refused; non-zero exit treated as failure so an empty string never unlocks a revert).
- **Registers one model tool** (`drvw_debug`) with read-only `state`/`scan` actions only; cwd is locked to the current session workspace and scans are throttled.

## Trust boundary

Local loopback plus the host's listening address. The plugin never uploads data — all communication is local browser ↔ host traffic.

Transport: the official **typert RPC** (`dsh-typert-protocol`), where the calling `agent` is injected by the runtime, so session binding cannot be forged. A `webServer` HTTP route is kept as a **transitional fallback** and is guarded against CSRF (Origin check), DNS rebinding (loopback Host allowlist) and non-loopback clients (remote-address check); it will be deleted once the typert migration is fully verified.

The realtime preview bucket (`live`) is workspace-level data (`sessionId='(live)'`): reads are not bound to the initiating session; writes (revert) come only from a same-origin local client and are gated by `liveRevert` plus version-conflict protection.

## Reporting

Open a GitHub issue or pull request. Given the plugin's local-only trust model, a meaningful report must demonstrate an attack that does not already require local filesystem or browser access to the host machine.

## Known residual risks

See "Risk disclosure" in [README.md](README.md): best-effort sensitive-file filtering, the revert/redo TOCTOU window, temp-file permissions on Windows/networked filesystems, the transitional HTTP route, the `drvw_debug` model tool, memory growth, and the two-writer race when `liveRevert` is enabled.
