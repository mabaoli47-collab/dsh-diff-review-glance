// Build script: compile src/ TypeScript-ish sources into lib/ runtime JS.
// - lib/index.js  : host half (ESM, strips type-only imports/annotations)
// - lib/client.js : client half (wrapped in window.__ModuleLoader__.load)
//
// The sources are intentionally plain JavaScript with no type annotations
// (only optional `import type` lines). This script strips that type-only
// surface without a compiler and keeps the package dependency-free at build
// time. If a future source adds real TS syntax, switch this to tsc/esbuild.
// (A spawned `node --check` syntax gate is deliberately omitted: DSH's file
// sandbox blocks child-process output capture, and the sources are verified
// with `node --check` before publish.)
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const lib = join(root, 'lib')

// Clean stale outputs first so renamed sources never leave orphan files.
rmSync(lib, { recursive: true, force: true })
mkdirSync(lib, { recursive: true })

/** Read UTF-8 source, stripping a leading BOM if present. */
function readSource(path) {
  return readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
}

// ---- host (multi-file) ----
// src/index.ts 与 src/host/*.ts 逐文件转 lib/（保留相对 import，如 './host/util.js'；
// Node ESM 按显式 .js 扩展名解析）。import type 行剥离。
const hostFiles = ['src/index.ts', 'src/host/util.ts']
for (const rel of hostFiles) {
  const outRel = rel.replace(/^src\//, '').replace(/\.ts$/, '.js')
  const outPath = join(lib, outRel)
  mkdirSync(dirname(outPath), { recursive: true })
  const src = readSource(join(root, rel))
  const out = src.replace(/import\s+type\s+[^;]+;\s*/g, '')
  writeFileSync(outPath, out)
  console.log('[build] lib/' + outRel)
}

// ---- client ----
const clientSrc = readSource(join(root, 'src', 'client', 'index.ts'))

// The client body is inlined into a template literal below; backticks or
// `${` in the source would corrupt the wrapper, so reject them loudly.
if (clientSrc.includes('`') || clientSrc.includes('${')) {
  throw new Error('[build] src/client/index.ts contains a backtick or "${" which would corrupt the ModuleLoader wrapper; rewrite that string without template literals')
}

const clientBody = clientSrc.replace(/import\s+\*\s+as\s+React\s+from\s+'react'\s*;?\s*/g, "let React = require('react');\n")
const banner = `window.__ModuleLoader__.load({ id: 'dsh-diff-review', factory: (require) => {
  var module = { exports: {} };
  var exports = module.exports;
${clientBody}
  exports.inject = ['timer', 'slots'];
  exports.apply = apply;
  return module.exports;
} });
`
writeFileSync(join(lib, 'client.js'), banner)
console.log('[build] lib/client.js')
