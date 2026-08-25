// S2（2026-08-25-verification-contract 第二阶段裁决 S2）：可控性分类测试（kernel/controllability.ts）。
// 覆盖：
//   ① classifyControllability 全映射（network/permission/captcha/environment → external；
//      tool/model → controllable；user → partially_controllable；unknown → unknown）
//   ② classifyFromText 关键词矩阵（超时/权限/验证码/语法/参数/未命中）——机械规则表（裁决 S2 第 8 点）
//   ③ 大小写不敏感（英文关键词大写/混写）
import { describe, expect, it } from 'vitest';
import {
  CAUSE_VALUES,
  CONTROLLABILITY_VALUES,
  classifyControllability,
  classifyFromText,
} from '../../kernel/controllability.js';

describe('① classifyControllability 全映射（规则表）', () => {
  it('network/permission/captcha/environment → external（外部不可控——失败不污染能力评分）', () => {
    for (const cause of ['network', 'permission', 'captcha', 'environment'] as const) {
      expect(classifyControllability(cause)).toEqual({ controllability: 'external', cause });
    }
  });

  it('tool/model → controllable（工具参数错误/代码错误——内部可控面可修复）', () => {
    for (const cause of ['tool', 'model'] as const) {
      expect(classifyControllability(cause)).toEqual({ controllability: 'controllable', cause });
    }
  });

  it('user → partially_controllable；unknown → unknown', () => {
    expect(classifyControllability('user')).toEqual({ controllability: 'partially_controllable', cause: 'user' });
    expect(classifyControllability('unknown')).toEqual({ controllability: 'unknown', cause: 'unknown' });
  });

  it('枚举穷举：CAUSE_VALUES × CONTROLLABILITY_VALUES 与导出一致', () => {
    for (const cause of CAUSE_VALUES) {
      const r = classifyControllability(cause);
      expect(CONTROLLABILITY_VALUES).toContain(r.controllability);
      expect(r.cause).toBe(cause);
    }
  });
});

describe('② classifyFromText 关键词矩阵（机械规则表——裁决 S2 第 8 点）', () => {
  it('网络：超时/timeout/network/网络/ETIMEDOUT/ECONN → network/external', () => {
    for (const text of ['请求超时', 'timeout 重试', 'network error', '网络错误', 'ETIMEDOUT', 'ECONNREFUSED']) {
      expect(classifyFromText(text)).toEqual({ controllability: 'external', cause: 'network' });
    }
  });

  it('权限：权限/denied/EACCES/EPERM/permission → permission/external', () => {
    for (const text of ['权限不足', 'permission denied', 'EACCES 拒绝', 'EPERM', '无 permission']) {
      expect(classifyFromText(text)).toEqual({ controllability: 'external', cause: 'permission' });
    }
  });

  it('验证码：验证码/captcha → captcha/external', () => {
    for (const text of ['需要验证码', 'captcha required', '页面出现验证码']) {
      expect(classifyFromText(text)).toEqual({ controllability: 'external', cause: 'captcha' });
    }
  });

  it('模型：语法/syntax/代码错误/compile error → model/controllable（代码可修——内部可控）', () => {
    for (const text of ['语法错误', 'syntax error', '代码错误', 'compile error 失败']) {
      expect(classifyFromText(text)).toEqual({ controllability: 'controllable', cause: 'model' });
    }
  });

  it('工具：参数/argument/invalid → tool/controllable（参数可改——内部可控）', () => {
    for (const text of ['参数无效', 'invalid argument', 'argument 缺失', '参数类型错误']) {
      expect(classifyFromText(text)).toEqual({ controllability: 'controllable', cause: 'tool' });
    }
  });

  it('未命中（含空文本）→ unknown/unknown（诚实——不臆造可控性）', () => {
    expect(classifyFromText('')).toEqual({ controllability: 'unknown', cause: 'unknown' });
    expect(classifyFromText('一切正常，无错误信息')).toEqual({ controllability: 'unknown', cause: 'unknown' });
    expect(classifyFromText('process/schedule: 测试降级')).toEqual({ controllability: 'unknown', cause: 'unknown' });
  });
});

describe('③ 大小写不敏感', () => {
  it('英文关键词大写/混写命中', () => {
    expect(classifyFromText('TIMEOUT')).toEqual({ controllability: 'external', cause: 'network' });
    expect(classifyFromText('CAPTCHA')).toEqual({ controllability: 'external', cause: 'captcha' });
    expect(classifyFromText('Permission')).toEqual({ controllability: 'external', cause: 'permission' });
    expect(classifyFromText('SYNTAX')).toEqual({ controllability: 'controllable', cause: 'model' });
    expect(classifyFromText('Invalid')).toEqual({ controllability: 'controllable', cause: 'tool' });
  });
});
