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

The dsh host process plus the local browser. The plugin never uploads data — all communication is local browser ↔ host traffic.

Transport: the official **typert RPC** (`dsh-typert-protocol`), where the calling `agent` is injected by the runtime, so session binding cannot be forged. **Typert is the only channel** (v0.8 removed the transitional `webServer` HTTP route and the client fetch fallback), so there is no HTTP attack surface.

The operation scope is the **current agent's workspace**: the typert `agent` is injected by the runtime and unforgeable, and `pickStore` locates the workspace store by session, so cross-workspace access is impossible. Within a workspace, formal and live items of any session can be read and acted on (the per-session groups in the dock are UI organization); "keep all in session" passes an explicit `targetSessionId` that must share the current agent's workspace, and live writes are gated by `liveRevert` plus version-conflict protection.

## Reporting

Open a GitHub issue or pull request. Given the plugin's local-only trust model, a meaningful report must demonstrate an attack that does not already require local filesystem or browser access to the host machine.

## Known residual risks

See "Risk disclosure" in [README.md](README.md): best-effort sensitive-file filtering, the revert/redo TOCTOU window, temp-file permissions on Windows/networked filesystems, the `drvw_debug` model tool, memory growth, and the two-writer race when `liveRevert` is enabled.
