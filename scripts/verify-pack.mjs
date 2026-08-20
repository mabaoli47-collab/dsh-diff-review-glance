// verify-pack: post-build artifact gate (mirrors rich-file-review's test:pack).
// Checks the npm files manifest, syntax of every lib artifact, the client
// ModuleLoader banner, the host export shape, version consistency, and the
// emitted type declarations. Exits non-zero on any failure.
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const errors = []
const ok = (cond, msg) => { if (!cond) errors.push(msg) }

// 1. files manifest existence (files field in package.json)
const manifestFiles = ['cordis.patch.yml', 'lib/index.js', 'lib/client.js', 'lib/host/util.js', 'lib/host/typert.js', 'README.md', 'README_EN.md', 'SECURITY.md', 'LICENSE', 'lib/types/index.d.ts']
for (const f of manifestFiles) ok(existsSync(join(root, f)), 'missing file: ' + f)

// 2. syntax check on every lib artifact.
//    node --check with stdio:'ignore' (the dsh file sandbox blocks child
//    output capture, so we take only the exit code; vm.Script can't parse
//    ESM, and SourceTextModule needs an experimental flag)
const artifacts = ['lib/index.js', 'lib/client.js', 'lib/host/util.js', 'lib/host/typert.js']
for (const f of artifacts) {
  const r = spawnSync(process.execPath, ['--check', join(root, f)], { stdio: 'ignore' })
  ok(r.status === 0, 'syntax error in ' + f)
}

// 3. host export shape (regex on the built file: format is stable, and
//    dynamic import would fail locally because peer deps are not installed)
const hostSrc = readFileSync(join(root, 'lib/index.js'), 'utf8')
ok(/export const name = 'dsh-diff-review'/.test(hostSrc), 'host missing name export')
ok(/export const inject = \[/.test(hostSrc), 'host missing inject export')
ok(/export function apply\(ctx\)/.test(hostSrc), 'host missing apply export')

// 4. client ModuleLoader banner + inject declaration
const clientSrc = readFileSync(join(root, 'lib/client.js'), 'utf8')
ok(clientSrc.includes('window.__ModuleLoader__'), 'client missing ModuleLoader banner')
ok(/exports\.inject\s*=\s*\[/.test(clientSrc), 'client missing exports.inject')

// 5. version consistency: host startup log carries the package version
ok(hostSrc.includes('v' + pkg.version), 'lib/index.js version mismatch: expected v' + pkg.version)

// 6. type declarations are non-empty
const typesSrc = readFileSync(join(root, 'lib/types/index.d.ts'), 'utf8')
ok(typesSrc.length > 50, 'lib/types/index.d.ts looks empty')

if (errors.length > 0) {
  console.error('[verify-pack] FAIL:\n- ' + errors.join('\n- '))
  process.exit(1)
}
console.log('[verify-pack] OK: ' + pkg.name + '@' + pkg.version)
