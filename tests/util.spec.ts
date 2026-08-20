// Unit tests for the pure host utilities (src/host/util.ts).
// 覆盖路径规范化、边界校验、敏感文件名单与 diff 算法等纯函数。
import { describe, expect, it } from 'vitest'
import { canonCwd, relOf, withinRoot, isSensitiveFile, realPathBlocked, turnKey, shortSessionId, splitLines, computeDiff, parseGitignore, gitignoreMatch, gitignoreMatchLayered } from '../src/host/util.js'

describe('canonCwd', () => {
  it('normalizes separators and trailing slashes', () => {
    expect(canonCwd('C:\\proj\\sub\\')).toBe('c:/proj/sub')
    expect(canonCwd('/home/user/proj/')).toBe('/home/user/proj')
  })
  it('resolves . and ..', () => {
    expect(canonCwd('C:/proj/./sub/../sub')).toBe('c:/proj/sub')
    expect(canonCwd('/a/./b/../b')).toBe('/a/b')
  })
  it('keeps the drive-root trailing slash', () => {
    expect(canonCwd('C:/')).toBe('c:/')
    expect(canonCwd('C:')).toBe('c:')
  })
  it('lowercases Windows drive letters only', () => {
    expect(canonCwd('C:/Proj')).toBe('c:/proj')
    expect(canonCwd('/home/User/Proj')).toBe('/home/User/Proj') // POSIX 保持大小写
  })
})

describe('relOf', () => {
  const s = { cwd: 'c:/project' }
  it('returns relative path for children', () => {
    expect(relOf('C:/project/src/a.ts', s)).toBe('src/a.ts')
    expect(relOf('c:/project/src/a.ts', s)).toBe('src/a.ts')
  })
  it('returns "." for the root itself', () => {
    expect(relOf('c:/project', s)).toBe('.')
  })
  it('returns the absolute path for outside paths (fallback)', () => {
    expect(relOf('d:/other/x.ts', s)).toBe('d:/other/x.ts')
  })
})

describe('withinRoot', () => {
  it('accepts descendants (drive-letter case-insensitive)', () => {
    expect(withinRoot('c:/project', 'C:/project/src/a.ts')).toBe(true)
    expect(withinRoot('c:/project', 'c:/project/src/a.ts')).toBe(true)
  })
  it('rejects siblings and prefixes', () => {
    expect(withinRoot('c:/project', 'c:/project2/x.ts')).toBe(false)
    expect(withinRoot('c:/project', 'd:/project/x.ts')).toBe(false)
    expect(withinRoot('/home/a/proj', '/home/a/project/x')).toBe(false)
  })
  it('POSIX stays case-sensitive', () => {
    expect(withinRoot('/home/a/Proj', '/home/a/proj/x')).toBe(false)
    expect(withinRoot('/home/a/Proj', '/home/a/Proj/x')).toBe(true)
  })
})

describe('isSensitiveFile', () => {
  it('matches env/keys/credentials patterns', () => {
    expect(isSensitiveFile('.env')).toBe(true)
    expect(isSensitiveFile('.env.local')).toBe(true)
    expect(isSensitiveFile('id_rsa')).toBe(true)
    expect(isSensitiveFile('credentials.json')).toBe(true)
    expect(isSensitiveFile('.npmrc')).toBe(true)
  })
  it('does not over-match plain code files', () => {
    expect(isSensitiveFile('token.js')).toBe(false)
    expect(isSensitiveFile('token.ts')).toBe(false)
    expect(isSensitiveFile('config.ts')).toBe(false)
  })
  it('still matches extensionless secret names', () => {
    expect(isSensitiveFile('secret')).toBe(true)
    expect(isSensitiveFile('api-key.yaml')).toBe(true)
  })
})

describe('realPathBlocked', () => {
  it('blocks ignored directory segments in the real path', () => {
    expect(realPathBlocked('c:/proj/node_modules/pkg/x.js')).toBe(true)
    expect(realPathBlocked('c:/proj/.ssh/config')).toBe(true)
    expect(realPathBlocked('c:/proj/src/x.js')).toBe(false)
  })
})

describe('turnKey / shortSessionId', () => {
  it('builds session-scoped turn keys', () => {
    expect(turnKey('s1', 3)).toBe('s1::3')
  })
  it('strips the session- prefix for short ids', () => {
    expect(shortSessionId('session-356424b9-0b7d')).toBe('356424b9')
    expect(shortSessionId('abc')).toBe('abc')
  })
})

describe('splitLines / computeDiff', () => {
  it('splitLines handles CRLF and trailing newline', () => {
    expect(splitLines('a\r\nb\nc\n')).toEqual(['a', 'b', 'c'])
  })
  it('computeDiff reports adds/dels and hunks', () => {
    const d = computeDiff('line1\nline2\nline3\n', 'line1\nline2 changed\nline3\n')
    expect(d.stats.adds).toBe(1)
    expect(d.stats.dels).toBe(1)
    expect(d.hunks.length).toBeGreaterThanOrEqual(1)
  })
  it('computeDiff returns empty for identical text', () => {
    const d = computeDiff('a\nb\n', 'a\nb\n')
    expect(d.stats.adds).toBe(0)
    expect(d.stats.dels).toBe(0)
    expect(d.hunks.length).toBe(0)
  })
  it('computeDiff marks degraded when LCS cell cap is exceeded', () => {
    // 超过 MAX_LCS_CELLS（4M）时退化为全删+全增：3000×2000 = 6M > 4M
    const bigA = Array.from({ length: 3000 }, (_, i) => 'old line ' + i).join('\n')
    const bigB = Array.from({ length: 2000 }, (_, i) => 'new line ' + i).join('\n')
    const d = computeDiff(bigA, bigB)
    expect(d.degraded).toBe(true)
    expect(d.stats.dels).toBe(3000)
    expect(d.stats.adds).toBe(2000)
    // 常规规模不标记退化
    expect(computeDiff('a\nb\nc\n', 'a\nb x\nc\n').degraded).toBe(false)
  })
})

describe('gitignore matching', () => {
  it('ignores basename patterns at any depth', () => {
    const rules = parseGitignore('*.log\n')
    expect(gitignoreMatch(rules, 'a/b/x.log')).toBe(true)
    expect(gitignoreMatch(rules, 'x.log')).toBe(true)
    expect(gitignoreMatch(rules, 'a/b/x.txt')).toBe(false)
  })
  it('ignores directory patterns including their contents', () => {
    const rules = parseGitignore('dist/\n')
    expect(gitignoreMatch(rules, 'dist', true)).toBe(true)
    expect(gitignoreMatch(rules, 'dist/a/b.js', false)).toBe(true)
    expect(gitignoreMatch(rules, 'src/a.js', false)).toBe(false)
    // 目录模式不匹配同名文件本体
    expect(gitignoreMatch(rules, 'dist', false)).toBe(false)
  })
  it('anchored patterns match only the repo root', () => {
    const rules = parseGitignore('/build\n')
    expect(gitignoreMatch(rules, 'build')).toBe(true)
    expect(gitignoreMatch(rules, 'a/build')).toBe(false)
  })
  it('negation re-includes files', () => {
    const rules = parseGitignore('*.log\n!keep.log\n')
    expect(gitignoreMatch(rules, 'x.log')).toBe(true)
    expect(gitignoreMatch(rules, 'keep.log')).toBe(false)
  })
  it('slash patterns match relative paths and their children', () => {
    const rules = parseGitignore('foo/bar\n')
    expect(gitignoreMatch(rules, 'foo/bar')).toBe(true)
    expect(gitignoreMatch(rules, 'foo/bar/baz.ts')).toBe(true)
    expect(gitignoreMatch(rules, 'foo/x.ts')).toBe(false)
  })
  it('ignores comments and blank lines', () => {
    const rules = parseGitignore('# comment\n\n*.tmp\n')
    expect(rules.length).toBe(1)
    expect(gitignoreMatch(rules, 'a.tmp')).toBe(true)
  })
  it('skips a single broken line instead of failing the whole file', () => {
    // [z-a] 是非法字符类：坏行被丢弃，其余规则继续生效（拒绝整文件 fail-open）
    const rules = parseGitignore('*.log\n[z-a]\n*.tmp\n')
    expect(gitignoreMatch(rules, 'a.log')).toBe(true)
    expect(gitignoreMatch(rules, 'a.tmp')).toBe(true)
    expect(rules.length).toBe(2)
  })
  it('**/ matches the root level too', () => {
    const rules = parseGitignore('**/foo\n')
    expect(gitignoreMatch(rules, 'foo')).toBe(true)
    expect(gitignoreMatch(rules, 'a/foo')).toBe(true)
    expect(gitignoreMatch(rules, 'a/b/foo')).toBe(true)
    expect(gitignoreMatch(rules, 'foo2')).toBe(false)
  })
  it('caps rule count per file', () => {
    const rules = parseGitignore(Array.from({ length: 6000 }, (_, i) => 'x' + i + '.tmp').join('\n') + '\n')
    expect(rules.length).toBeLessThanOrEqual(5000)
  })
})

describe('layered gitignore matching', () => {
  it('applies each layer only to its own subtree', () => {
    // 模拟 a->b,c,d; b->e,f，其中 a(根)/b/d/e 各有 .gitignore
    const layers = [
      { base: '', rules: parseGitignore('*.log\n') },          // a（根）
      { base: 'b', rules: parseGitignore('secret.txt\n') },    // b
      { base: 'b/e', rules: parseGitignore('*.tmp\n') },       // e
      { base: 'd', rules: parseGitignore('data.bin\n') },      // d
    ]
    // 根规则作用于整棵子树
    expect(gitignoreMatchLayered(layers, 'a/x.log', false)).toBe(true)
    expect(gitignoreMatchLayered(layers, 'b/e/y.log', false)).toBe(true)
    expect(gitignoreMatchLayered(layers, 'd/z.log', false)).toBe(true)
    // b 的规则只作用于 b 子树
    expect(gitignoreMatchLayered(layers, 'b/secret.txt', false)).toBe(true)
    expect(gitignoreMatchLayered(layers, 'd/secret.txt', false)).toBe(false)
    // e 的规则作用于 b/e 子树
    expect(gitignoreMatchLayered(layers, 'b/e/x.tmp', false)).toBe(true)
    expect(gitignoreMatchLayered(layers, 'b/x.tmp', false)).toBe(false)
    // d 的规则只作用于 d 子树
    expect(gitignoreMatchLayered(layers, 'd/data.bin', false)).toBe(true)
    expect(gitignoreMatchLayered(layers, 'b/data.bin', false)).toBe(false)
  })
  it('deeper negation overrides a shallower ignore', () => {
    const layers = [
      { base: '', rules: parseGitignore('*.log\n') },
      { base: 'b', rules: parseGitignore('!keep.log\n') },
    ]
    expect(gitignoreMatchLayered(layers, 'b/keep.log', false)).toBe(false)
    expect(gitignoreMatchLayered(layers, 'b/x.log', false)).toBe(true)
    expect(gitignoreMatchLayered(layers, 'keep.log', false)).toBe(true)
  })
  it('deeper layer ignores a file the root allows', () => {
    const layers = [
      { base: '', rules: parseGitignore('*.txt\n!b/special.txt\n') },
      { base: 'b', rules: parseGitignore('special.txt\n') },
    ]
    expect(gitignoreMatchLayered(layers, 'b/special.txt', false)).toBe(true)
    // 根下的 special.txt 未被 b 层覆盖，仍被根层 *.txt 忽略
    expect(gitignoreMatchLayered(layers, 'special.txt', false)).toBe(true)
  })
  it('directory patterns apply per layer', () => {
    const layers = [
      { base: '', rules: parseGitignore('') },
      { base: 'b', rules: parseGitignore('dist/\n') },
    ]
    expect(gitignoreMatchLayered(layers, 'b/dist', true)).toBe(true)
    expect(gitignoreMatchLayered(layers, 'b/dist/a.js', false)).toBe(true)
    expect(gitignoreMatchLayered(layers, 'dist/a.js', false)).toBe(false)
  })
})
