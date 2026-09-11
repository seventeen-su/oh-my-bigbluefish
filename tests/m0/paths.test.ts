// `substrate/paths.ts` 契约测试（原先**零覆盖**——而它是制品索引越界读与线快照误删两处修复的
// 唯一裁决点，属于"路径包含关系"这类必须钉死边界的逻辑）。
//
// 为什么必须显式钉：这类函数的错误方向是**静默**的——宽了会越界读写别人的目录，窄了会漏掉该管
// 的路径；两者都不报错。故这里把"分隔符边界 / 大小写口径 / 根路径 / 盘根"四种边界逐一写死。
import { describe, expect, it } from 'vitest';
import { isPathUnder, isUnderTempDir, pathCaseInsensitive } from '../../substrate/paths.js';

describe('isPathUnder：分隔符边界（前缀命中必须落在分隔符上）', () => {
  it('相同路径 → true（"之下"含自身）', () => {
    expect(isPathUnder('/tmp/omb', '/tmp/omb', 'linux')).toBe(true);
    expect(isPathUnder('C:\\a\\b', 'C:\\a\\b', 'win32')).toBe(true);
  });

  it('真子路径 → true', () => {
    expect(isPathUnder('/tmp/omb/sub/f.txt', '/tmp/omb', 'linux')).toBe(true);
    expect(isPathUnder('C:\\a\\b\\c.txt', 'C:\\a\\b', 'win32')).toBe(true);
  });

  it('同名前缀但不是子路径 → false（`/tmp` 不吃 `/tmp2/omb`）', () => {
    // 这是修复过的真实缺陷面：无条件 startsWith 会把 /tmp2/omb 判为在 /tmp 之下
    expect(isPathUnder('/tmp2/omb', '/tmp', 'linux')).toBe(false);
    expect(isPathUnder('/tmp-other/sub', '/tmp', 'linux')).toBe(false);
    expect(isPathUnder('C:\\ab\\c', 'C:\\a', 'win32')).toBe(false);
    expect(isPathUnder('C:\\abc', 'C:\\ab', 'win32')).toBe(false);
  });

  it('尾分隔符不影响判定（两端都归一）', () => {
    expect(isPathUnder('/tmp/omb/sub', '/tmp/omb/', 'linux')).toBe(true);
    expect(isPathUnder('/tmp/omb/', '/tmp/omb', 'linux')).toBe(true);
    expect(isPathUnder('C:\\a\\b\\', 'C:\\a\\b\\', 'win32')).toBe(true);
  });

  it('Windows 上容忍另一种分隔符形态（git 可能写出 /）', () => {
    expect(isPathUnder('C:/a/b/c.txt', 'C:\\a\\b', 'win32')).toBe(true);
    expect(isPathUnder('C:\\a\\b\\c.txt', 'C:/a/b', 'win32')).toBe(true);
  });

  it('POSIX 上不把反斜杠当分隔符（\\ 在 Linux 是合法文件名字符）', () => {
    expect(isPathUnder('/tmp/omb\\sub', '/tmp/omb', 'linux')).toBe(false);
  });
});

describe('isPathUnder：根路径与盘根（回归护栏）', () => {
  // 曾经的实现写作 `r.endsWith(s) || c.startsWith(r + s)`：根以分隔符结尾时（`/`、`C:\`）
  // 前半句为真 → **无条件 true**，等于对根路径关闭了判定。下面把它钉住。
  it('POSIX 根 "/"：任意绝对路径都在其下，但不相关的相对路径不在', () => {
    expect(isPathUnder('/anything/at/all', '/', 'linux')).toBe(true);
    expect(isPathUnder('/tmp', '/', 'linux')).toBe(true);
    expect(isPathUnder('relative/path', '/', 'linux')).toBe(false);
  });

  it('Windows 盘根 "C:\\"：本盘路径在其下，"盘相对路径" C:foo 不在', () => {
    expect(isPathUnder('C:\\Users\\x', 'C:\\', 'win32')).toBe(true);
    // 关键边界：stripTrailingSeparators 会保留 `C:\`（否则退化成 `C:`，会把盘相对路径算进去）
    expect(isPathUnder('C:foo', 'C:\\', 'win32')).toBe(false);
    expect(isPathUnder('D:\\other', 'C:\\', 'win32')).toBe(false);
  });
});

describe('大小写口径按平台（Windows/macOS 不敏感，其余敏感）', () => {
  it('pathCaseInsensitive：win32/darwin 不敏感，linux 敏感', () => {
    expect(pathCaseInsensitive('win32')).toBe(true);
    expect(pathCaseInsensitive('darwin')).toBe(true);
    expect(pathCaseInsensitive('linux')).toBe(false);
  });

  it('Windows 上大小写差异不影响包含判定；Linux 上影响', () => {
    expect(isPathUnder('C:\\Users\\X\\f', 'c:\\users', 'win32')).toBe(true);
    expect(isPathUnder('/Tmp/omb', '/tmp', 'linux')).toBe(false);
    expect(isPathUnder('/Tmp/omb', '/tmp', 'darwin')).toBe(true);
  });
});

describe('isUnderTempDir：与 isPathUnder 同口径（线快照清理的误删面）', () => {
  it('系统临时目录下的路径 → true；同名前缀兄弟目录 → false', () => {
    expect(isUnderTempDir('/tmp/omb-worktree-1', '/tmp', 'linux')).toBe(true);
    expect(isUnderTempDir('/tmp2/omb-worktree-1', '/tmp', 'linux')).toBe(false);
  });
});
