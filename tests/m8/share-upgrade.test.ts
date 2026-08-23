// T8.9 行为测试：共享协议原子化 + 冲突 + 签名（supervisor/share.ts 升级，架构 §13.2）。
// - manifest/blacklist/objects 原子写（tmp+rename，T6b.1 缓办项）——中断不半文件；
// - §13.2 冲突：同逻辑身份（name+version）双候选 Pareto branch——registry 允许双候选共存 + 标记；
// - 签名：从空串升级为格式校验 + 真实 Git 签名校验（SSH 签名实测：ssh-keygen 生成密钥 + git tag -s
//   gpg.format=ssh → git verify-tag 真实验签；伪造格式拒绝）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GIT } from '../helpers/git.js';
import { canonicalJson, makeImmutableId, type Fingerprint } from '../../kernel/schemas/base.js';
import type { EvolutionObject } from '../../kernel/schemas/m.js';
import {
  GitRegistry,
  validateSignatureFormat,
  verifyGitSignature,
  type ManifestEntry,
} from '../../supervisor/share.js';

const ENV: Fingerprint = { os: 'win32', node: 'v24', dsh_version: '0.8.0', project: 'omb-v2' };

/** 合法格式签名工厂（git:<signer>:<keyid-hex>:<base64>） */
function mkSig(seed: string): string {
  const keyid = seed.replace(/[^0-9a-f]/gi, '').padEnd(16, '0').slice(0, 16);
  return `git:omb:${keyid}:${Buffer.from(seed, 'utf8').toString('base64')}`;
}

let seq = 0;
function mkEvo(over: Partial<Omit<EvolutionObject, 'id'>> = {}): EvolutionObject {
  const ts = '2026-08-21T00:00:00.000Z';
  const body: Omit<EvolutionObject, 'id'> = {
    ir_version: '2.0', schema: 'omb/M4', scope: 'Project', lifecycle: 'active', immutable: true,
    owner: 'kernel', created: ts, updated: ts,
    provenance: {
      source: 'test/t8.9', event: `evolution/t89-${seq}`, actor: 't89', environment: ENV,
      runtime_snapshot: 'rs:snapshot', timestamp: ts, transformation_chain: [], verification: 'v',
    },
    refs: [], protocol_version: '2.0', parent: null,
    diff: `diff --git a/x b/x\n+line-${seq}`, compat: 'omb/2.0', bench: 'bench/frozen-001',
    spdx: 'MIT', verifications: ['cert/t8.9'], ...over,
  };
  seq += 1;
  return { ...body, id: makeImmutableId(canonicalJson(body)) };
}

function runGit(args: string[], cwd: string): string {
  try {
    return execFileSync(GIT, args, { cwd, encoding: 'utf8', windowsHide: true }).trimEnd();
  } catch (err) {
    const e = err as { status?: number; stderr?: Buffer | string };
    const detail = e.stderr ? String(e.stderr).trimEnd() : '(无 stderr)';
    throw new Error(`git ${args.join(' ')} 失败 (exit=${e.status ?? '?'}): ${detail}`);
  }
}

describe('T8.9 共享协议原子化（tmp+rename：中断不半文件）', () => {
  let base: string;
  let reg: GitRegistry;

  beforeEach(async () => {
    seq = 0;
    base = await mkdtemp(join(tmpdir(), 'omb-t89-'));
    reg = new GitRegistry(join(base, 'registry'));
    await reg.init();
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('多次发布/撤销/共识回传 → manifest/blacklist 始终为完整 JSON，无 tmp 残留（原子写）', async () => {
    for (let i = 0; i < 5; i++) {
      await reg.publish(mkEvo(), mkSig(`pub-${i}`));
    }
    const manifest = JSON.parse(await readFile(join(base, 'registry', 'manifest.json'), 'utf8')) as ManifestEntry[];
    expect(manifest).toHaveLength(5);
    // 黑名单操作后仍完整 JSON
    await reg.revoke(manifest[0]!.id, 'bench 污染');
    const blacklist = JSON.parse(await readFile(join(base, 'registry', 'blacklist.json'), 'utf8')) as Record<string, unknown>;
    expect(blacklist[manifest[0]!.id]).toBeDefined();
    // 无 tmp 残留（原子写不留下半成品）
    const files = await readdir(join(base, 'registry'));
    expect(files.some((f) => f.includes('.tmp'))).toBe(false);
  });
});

describe('T8.9 §13.2 冲突（同逻辑身份双候选 Pareto branch）', () => {
  let base: string;
  let reg: GitRegistry;

  beforeEach(async () => {
    seq = 0;
    base = await mkdtemp(join(tmpdir(), 'omb-t89c-'));
    reg = new GitRegistry(join(base, 'registry'));
    await reg.init();
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('同 name+version 双候选共存 + conflict 标记；不同 name → 无冲突', async () => {
    const a = mkEvo();
    const b = mkEvo(); // 不同内容 → 不同 id（双候选 Pareto branch）
    await reg.publish(a, mkSig('a'), { name: 'dual-candidate', version: '1.0.0' });
    await reg.publish(b, mkSig('b'), { name: 'dual-candidate', version: '1.0.0' });

    // 双候选共存（不互斥拒绝）
    const entries = await reg.list();
    const ea = entries.find((e) => e.id === a.id);
    const eb = entries.find((e) => e.id === b.id);
    expect(ea).toBeDefined();
    expect(eb).toBeDefined();
    // 冲突标记（Pareto branch：两者都标记，互相引用）
    expect(ea!.conflict_with).toContain(b.id);
    expect(eb!.conflict_with).toContain(a.id);
    // 内容寻址去重仍生效：同内容重复发布 → 拒绝（冲突 ≠ 去重）
    const dup = await reg.publish(a, mkSig('a2'), { name: 'dual-candidate', version: '1.0.0' });
    expect(dup.ok).toBe(false);
    expect(dup.duplicate).toBe(true);

    // 不同 name → 无冲突标记
    const c = mkEvo();
    await reg.publish(c, mkSig('c'), { name: 'other-candidate', version: '1.0.0' });
    const ec = (await reg.list()).find((e) => e.id === c.id);
    expect(ec!.conflict_with).toBeUndefined();
  });
});

describe('T8.9 签名：格式校验 + 真实 Git 签名校验', () => {
  it('validateSignatureFormat：合法 git/ssh 描述符通过；空串/伪造/乱码拒绝（格式门）', () => {
    expect(validateSignatureFormat(mkSig('valid-seed')).ok).toBe(true);
    expect(validateSignatureFormat(`ssh:${Buffer.from('sig').toString('base64')}`).ok).toBe(true);
    expect(validateSignatureFormat('').ok).toBe(false);
    expect(validateSignatureFormat('sig-ok').ok).toBe(false); // 旧占位符 → 伪造拒绝
    expect(validateSignatureFormat('garbage bytes').ok).toBe(false);
    expect(validateSignatureFormat('git:omb:short:!!!').ok).toBe(false); // keyid 非 hex / sig 非 base64
  });

  it('publish 签名格式门：非法格式签名 → 拒绝；verify 检出伪造签名 → ok:false（验收：伪造签名拒绝）', async () => {
    const base = await mkdtemp(join(tmpdir(), 'omb-t89v-'));
    const reg = new GitRegistry(join(base, 'registry'));
    await reg.init();

    // 非法格式 → publish 拒绝
    const forged = mkEvo();
    const r = await reg.publish(forged, 'forged-signature-string');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/签名|格式/);

    // 合法格式发布 → verify 通过；篡改 manifest 为非法格式 → verify 拒绝
    const ok = mkEvo();
    await reg.publish(ok, mkSig('ok'));
    expect((await reg.verify(ok.id)).ok).toBe(true);
    const manifestFile = join(base, 'registry', 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as ManifestEntry[];
    const entry = manifest.find((e) => e.id === ok.id);
    entry!.signature = 'forged';
    await writeFile(manifestFile, JSON.stringify(manifest), 'utf8');
    const reg2 = new GitRegistry(join(base, 'registry'));
    const v = await reg2.verify(ok.id);
    expect(v.ok).toBe(false);
    expect(v.detail).toMatch(/签名|格式/);
    await rm(base, { recursive: true, force: true });
  });

  it('真实 Git 签名校验（SSH 签名实测）：生成密钥 + git tag -s(gpg.format=ssh) → verifyGitSignature 真实验签通过；未签名 tag → 失败', async () => {
    const base = await mkdtemp(join(tmpdir(), 'omb-t89s-'));
    const repo = join(base, 'repo');
    await mkdir(repo);
    runGit(['init', '-b', 'main'], repo);
    runGit(['-c', 'user.name=T', '-c', 'user.email=t@local', 'config', 'user.name', 'T'], repo);
    runGit(['config', 'user.email', 't@local'], repo);
    // SSH 签名密钥
    const key = join(base, 'key');
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', key], { stdio: 'ignore' });
    runGit(['config', 'gpg.format', 'ssh'], repo);
    runGit(['config', 'user.signingkey', `${key}.pub`], repo);
    // SSH 签名验证需 allowedSignersFile（git verify-tag 依赖）：<principal> <keytype> <base64-pubkey>
    const pubFields = (await readFile(`${key}.pub`, 'utf8')).trim().split(/\s+/);
    const allowedSigners = join(base, 'allowed_signers');
    await writeFile(allowedSigners, `t@local ${pubFields[0]} ${pubFields[1]}\n`, 'utf8');
    runGit(['config', 'gpg.ssh.allowedSignersFile', allowedSigners], repo);
    // 提交 + 签名 tag
    await writeFile(join(repo, 'a.txt'), 'content\n', 'utf8');
    runGit(['add', '.'], repo);
    runGit(['-c', 'user.name=T', '-c', 'user.email=t@local', 'commit', '-m', 'init'], repo);
    runGit(['-c', 'user.name=T', '-c', 'user.email=t@local', 'tag', '-s', 'v1', '-m', 'signed'], repo);
    // 未签名 tag
    runGit(['-c', 'user.name=T', '-c', 'user.email=t@local', 'tag', 'v0', '-m', 'unsigned'], repo);

    // 真实验签：SSH 签名 tag → 通过（git verify-tag 真实验证）
    const okV = await verifyGitSignature({ signature: mkSig('real'), repoDir: repo, tag: 'v1', gitBin: GIT });
    expect(okV.ok).toBe(true);
    // 未签名 tag → 失败（真实路径：verify-tag 报错）
    const badV = await verifyGitSignature({ signature: mkSig('real2'), repoDir: repo, tag: 'v0', gitBin: GIT });
    expect(badV.ok).toBe(false);
    // 格式门：非法签名 → 不调 git，直接拒绝
    const fmt = await verifyGitSignature({ signature: 'junk', repoDir: repo, tag: 'v1', gitBin: GIT });
    expect(fmt.ok).toBe(false);
    await rm(base, { recursive: true, force: true });
  }, 30000);
});
