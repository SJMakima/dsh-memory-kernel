/**
 * P3+ 的 bili / douyin Adapter —— 与 qq 的 local-archive 同构，薄到只有三件事：
 * 域注册 / sourceReader / 敏感标记（C1：原项目存储只读；Adapter 不写记忆、不做检索决策）。
 *
 * 与 qq 的差异只在档案形态：
 *   bili   日记：`bili.jsonl`，每行 { id, text, at, title? }，locator 形如 `bili:<id>`
 *   douyin 报告：`douyin.jsonl`，每行 { id, text, at, author? }，locator 形如 `douyin:<id>`
 * 配额默认值在 cfg.write.dailyQuotaPerDomain 里（bili 5 / douyin 5，§19）。
 */

import path from 'node:path';
import { defineDomain, createLocalArchiveReader } from './local-archive.js';

export function createVideoArchiveReader(dir, platform) {
  const inner = createLocalArchiveReader(dir);
  return {
    async read(ref) {
      // 统一把 `<platform>:<id>` 归一到 local-archive 的 `msg:<id>` 语义
      const locator = String(ref.locator ?? '').replace(new RegExp(`^${platform}:`), 'msg:');
      return inner.read({ ...ref, locator });
    },
  };
}

/** bili-whale：B 站行为日记域。`matchSessionId` 认 `bili:*` 会话。 */
export function defineBiliDomain({ dir, ...rest } = {}) {
  return defineDomain({
    id: 'bili',
    matchSessionId: (sid) => String(sid).split(':')[0] === 'bili',
    ...(dir ? { sourceReader: createVideoArchiveReader(dir, 'bili') } : {}),
    ...rest,
  });
}

/** douyin-scroll：抖音报告域。`matchSessionId` 认 `douyin:*` 会话。 */
export function defineDouyinDomain({ dir, ...rest } = {}) {
  return defineDomain({
    id: 'douyin',
    matchSessionId: (sid) => String(sid).split(':')[0] === 'douyin',
    ...(dir ? { sourceReader: createVideoArchiveReader(dir, 'douyin') } : {}),
    ...rest,
  });
}

/** 便捷：按平台名取构造器（宿主按配置循环注册时用）。 */
export function defineVideoDomain(platform, opts = {}) {
  const dir = opts.dir ? path.join(opts.dir) : undefined;
  if (platform === 'bili') return defineBiliDomain({ dir, ...opts });
  if (platform === 'douyin') return defineDouyinDomain({ dir, ...opts });
  throw new Error(`defineVideoDomain: 未知平台 ${platform}（bili / douyin）`);
}
