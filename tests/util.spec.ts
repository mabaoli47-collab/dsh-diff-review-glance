// Unit tests for the pure host utilities (src/host/util.ts).
// 覆盖路径规范化、边界校验、敏感文件名单与 diff 算法等纯函数。
import { describe, expect, it } from 'vitest'
import { canonCwd, relOf, withinRoot, isSensitiveFile, realPathBlocked, turnKey, shortSessionId, splitLines, computeDiff, parseGitignore, gitignoreMatch } from '../src/host/util.js'

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
})
