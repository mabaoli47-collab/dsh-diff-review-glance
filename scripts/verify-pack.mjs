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

// 7. README config tables must exactly cover the keys returned by
//    readConfig() (the `empty` defaults in src/index.ts). This guards the
//    docs/config drift that previously shipped: a README describing ~v0.8
//    while the code already exposed respectGitignore / extraIgnoreFiles /
//    trackNewFiles. Missing key => users never learn of the setting;
//    extra key => docs describe a setting the code does not implement.
const srcIndex = readFileSync(join(root, 'src/index.ts'), 'utf8')
const emptyMatch = srcIndex.match(/const empty = \{([^}]*)\}/)
if (!emptyMatch) {
  errors.push('cannot locate readConfig() `empty` defaults in src/index.ts')
} else {
  const codeKeys = [...new Set([...emptyMatch[1].matchAll(/([A-Za-z][A-Za-z0-9]*)\s*:/g)].map((m) => m[1]))]
  for (const readme of ['README.md', 'README_EN.md']) {
    const tableKeys = [...readFileSync(join(root, readme), 'utf8').matchAll(/^\| `([a-z][a-zA-Z0-9]*)` \|/gm)].map((m) => m[1])
    const missing = codeKeys.filter((k) => !tableKeys.includes(k))
    const extra = tableKeys.filter((k) => !codeKeys.includes(k))
    ok(missing.length === 0, readme + ' config table is missing keys: ' + missing.join(', '))
    ok(extra.length === 0, readme + ' config table lists unknown keys: ' + extra.join(', '))
  }
}

// 8. the shipped typert descriptor must expose clearReviewed (the current
//    wire contract); a regression to a stale descriptor would silently
//    drop the action from the client.
const typertSrc = readFileSync(join(root, 'lib/host/typert.js'), 'utf8')
ok(typertSrc.includes('clearReviewed'), 'lib/host/typert.js missing clearReviewed descriptor')

if (errors.length > 0) {
  console.error('[verify-pack] FAIL:\n- ' + errors.join('\n- '))
  process.exit(1)
}
console.log('[verify-pack] OK: ' + pkg.name + '@' + pkg.version)
