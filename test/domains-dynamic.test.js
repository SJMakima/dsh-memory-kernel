/**
 * 【R-138】动态域：设置页新增域后的注册与路由语义。
 *
 * 这里的头号坑是**注册顺序**：内置 dsh 域是 `matchSessionId: () => true` 的恒真兜底，
 * 而 `routeDomain` 对多命中取**先注册者**（hits[0]）。动态域如果排在 dsh 之后，
 * 永远路由不到——而且不报错，只是所有数据静默落进 dsh（R-122 同款"静默"家族）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDomainRegistry } from '../src/core/domains.js';
import { defineDomain } from '../src/adapters/local-archive.js';

/** 与 dsh/lib-index.js 的 domain-add 校验保持同一把尺子（两边都要过，改一处必须同步另一处）。 */
export const isValidDomainId = (id) => /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(id);

test('命名规则：英文开头，仅英文/数字/下划线/连字符，≤32', () => {
  const ok = ['dsh', 'bilibili-dm', 'qq_group', 'a', 'WeChat2'];
  const bad = ['', '1abc', '中文域', 'has space', 'dot.name', 'x'.repeat(33), '-lead'];
  for (const id of ok) assert.ok(isValidDomainId(id), `${id} 应通过`);
  for (const id of bad) assert.ok(!isValidDomainId(id), `${id} 应拒绝`);
});

test('动态域在前：精确前缀命中动态域，而不是被恒真的 dsh 抢走', () => {
  const reg = createDomainRegistry({ audit: null });
  // 与 lib-index.js 启动注册同序：动态域在前、dsh 兜底在后
  reg.register(defineDomain({ id: 'bilibili-dm' }));
  reg.register(defineDomain({ id: 'dsh', matchSessionId: () => true }));

  assert.equal(reg.routeDomain('bilibili-dm:u123')?.id, 'bilibili-dm',
    '前缀命中的必须是动态域——落到 dsh 就是注册顺序 bug（静默，数据全进错域）');
  assert.equal(reg.routeDomain('bilibili-dm')?.id, 'bilibili-dm');
  assert.equal(reg.routeDomain('random-session')?.id, 'dsh', '未匹配会话由 dsh 兜底');
});

test('defineDomain 默认 matchSessionId：只认「id:」前缀，不做子串匹配', () => {
  const d = defineDomain({ id: 'bili' });
  assert.equal(d.matchSessionId('bili:u1'), true);
  assert.equal(d.matchSessionId('bili'), true);
  // 子串/别的域前缀不算：'bili-dm:x' 的 split(':')[0] 是 'bili-dm' ≠ 'bili'
  assert.equal(d.matchSessionId('bili-dm:x'), false);
  assert.equal(d.matchSessionId('xbili:1'), false);
});

test('重复注册是覆盖（registry 层不拦）——lib-index 的 exists 检查是唯一闸门', () => {
  const reg = createDomainRegistry({ audit: null });
  reg.register(defineDomain({ id: 'x' }));
  reg.register(defineDomain({ id: 'x', matchSessionId: () => true }));
  assert.equal(reg.list().length, 1, 'Map.set 语义：同 id 覆盖');
  assert.equal(reg.routeDomain('anything')?.id, 'x', '后注册的 matchSessionId 生效');
});
