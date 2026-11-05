/**
 * §13.3 内存向量索引（R-137）—— 第二派生层。
 *
 * 这层的失败模式全是"静默"的（召回少了、返回错条目、内存涨了），所以每条测试都盯着
 * 一个具体的静默错误，而不是"跑通就行"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createVecIndexStore, usearchAvailable, usearchLoadError } from '../src/core/vec-index.js';

const DIM = 8;
const skip = usearchAvailable() ? false : `usearch 不可用：${usearchLoadError()}`;

/** 确定性伪随机向量（不用 Math.random：失败要可复现）。 */
function vec(seed) {
  const v = new Float32Array(DIM);
  let s = seed * 2654435761 % 4294967296;
  for (let i = 0; i < DIM; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    v[i] = (s / 2147483648) * 2 - 1;
  }
  let n = 0;
  for (let i = 0; i < DIM; i++) n += v[i] * v[i];
  const m = Math.sqrt(n) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= m;
  return v;
}
const blob = (f) => Buffer.from(f.buffer, f.byteOffset, f.byteLength);
const rowsFor = (ids) => ids.map((id) => ({ id, embedding: blob(vec(Number(id.replace(/\D/g, '')) + 1)) }));

test('精确检索：与暴力余弦的结果完全一致（不是近似）', { skip }, () => {
  const store = createVecIndexStore({ dim: DIM });
  const ids = Array.from({ length: 200 }, (_, i) => `e${i}`);
  assert.equal(store.load('d1', rowsFor(ids)), true);

  const q = vec(7);
  const got = store.search('d1', q, 5);
  assert.equal(got.length, 5);

  // 独立算一遍真值
  const truth = ids
    .map((id, i) => {
      const v = vec(i + 1);
      let dot = 0, qn = 0, vn = 0;
      for (let k = 0; k < DIM; k++) { dot += q[k] * v[k]; qn += q[k] * q[k]; vn += v[k] * v[k]; }
      return { id, score: dot / (Math.sqrt(qn) * Math.sqrt(vn)) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  assert.deepEqual(got.map((h) => h.id), truth.map((h) => h.id), '顺序与真值一致（精确扫描，不是 ANN）');
  for (let i = 0; i < 5; i++) {
    assert.ok(Math.abs(got[i].score - truth[i].score) < 1e-6, `score 是余弦相似度（1 - distance 的同构），第 ${i} 位偏差过大`);
  }
});

test('swap-remove：删中间一条后，末尾那条的映射必须跟着改（否则查 A 返回 B）', { skip }, () => {
  const store = createVecIndexStore({ dim: DIM });
  const ids = ['a', 'b', 'c', 'd'];
  store.load('d1', ids.map((id, i) => ({ id, embedding: blob(vec(i + 1)) })));

  assert.equal(store.remove('d1', 'b'), 'ok');

  // b 必须消失
  const after = store.search('d1', vec(2), 10);
  assert.deepEqual(after.map((h) => h.id).sort(), ['a', 'c', 'd']);

  // 关键：删完之后剩下的每条都必须还能按自己的向量被查到（映射没串）
  for (const [id, seed] of [['a', 1], ['c', 3], ['d', 4]]) {
    const top = store.search('d1', vec(seed), 1);
    assert.equal(top[0].id, id, `删除后 ${id} 的 id→下标映射串了：查到 ${top[0].id}`);
  }
  assert.equal(store.stats().vectors, 3);
});

test('写入同步：原地覆盖不新增；未加载的域收到写入不报错', { skip }, () => {
  const store = createVecIndexStore({ dim: DIM });
  store.load('d1', [{ id: 'a', embedding: blob(vec(1)) }]);
  assert.equal(store.stats().vectors, 1);

  // 覆盖同一个 id
  assert.equal(store.upsert('d1', 'a', vec(9)), 'ok');
  assert.equal(store.stats().vectors, 1, '同 id 覆盖不能把向量数涨上去');
  const top = store.search('d1', vec(9), 1);
  assert.equal(top[0].id, 'a');
  assert.ok(top[0].score > 0.999, '覆盖后应当与自己的新向量完全一致');

  // 域没加载 → 什么都不做（下次加载时从 SQLite 读到的自然是新数据）
  assert.equal(store.upsert('never-loaded', 'x', vec(1)), 'skip-unloaded');
  assert.equal(store.search('never-loaded', vec(1), 1), null, '未加载的域必须返回 null 而不是 []');
});

test('脏标记：search 返回 null（不是 []），调用方才能正确降级', { skip }, () => {
  const store = createVecIndexStore({ dim: DIM });
  store.load('d1', [{ id: 'a', embedding: blob(vec(1)) }]);
  assert.notEqual(store.search('d1', vec(1), 1), null);

  store.markDirty('d1', 'test');
  assert.equal(store.search('d1', vec(1), 1), null,
    '脏了必须返回 null —— 返回 [] 会被上层读成"向量路没命中"，把召回静默吃掉');
  assert.equal(store.has('d1'), false, '脏域不算"已加载"，下次会触发重灌');

  // 重灌一次应当自愈
  store.load('d1', [{ id: 'b', embedding: blob(vec(2)) }]);
  const top = store.search('d1', vec(2), 1);
  assert.equal(top[0].id, 'b', '重灌后恢复可用，且只留重灌进来的那条');
});

test('维度不符的行跳过，不猜（换模型后的错维残留）', { skip }, () => {
  const store = createVecIndexStore({ dim: DIM });
  const ok = store.load('d1', [
    { id: 'good', embedding: blob(vec(1)) },
    { id: 'bad', embedding: Buffer.alloc(DIM * 4 + 4) },   // 维度不对
    { id: 'null', embedding: null },
  ]);
  assert.equal(ok, true);
  assert.equal(store.stats().vectors, 1, '只装得下维度对得上的那条');
  assert.deepEqual(store.search('d1', vec(1), 10).map((h) => h.id), ['good']);
});

test('容量增长：超过初始容量后数据不丢、不错位', { skip }, () => {
  const store = createVecIndexStore({ dim: DIM });
  const ids = Array.from({ length: 500 }, (_, i) => `e${i}`);
  store.load('d1', rowsFor(ids));
  assert.equal(store.stats().vectors, 500);

  // 逐条按自己的向量查回来：容量搬迁把 flat 拷错一位就会在这里炸
  for (const seed of [1, 100, 250, 499]) {
    const top = store.search('d1', vec(seed), 1);
    assert.equal(top[0].id, `e${seed - 1}`, `容量增长后第 ${seed - 1} 条错位了`);
    assert.ok(top[0].score > 0.999);
  }
});

test('maxVectors：超限拒绝整域（不留半截索引），且不改动已有域', { skip }, () => {
  const store = createVecIndexStore({ dim: DIM, limits: () => ({ enabled: true, maxVectors: 3 }) });
  assert.equal(store.load('d1', rowsFor(['e1', 'e2'])), true);
  assert.equal(store.load('d2', rowsFor(['e1', 'e2'])), false, '2+2 > 3 → 整域拒绝');
  assert.equal(store.search('d2', vec(1), 1), null, '被拒绝的域必须回落 vec0');
  assert.equal(store.stats().vectors, 2, '已有域的向量数不受影响');
});

test('开关：enabled=false 时整层不可用，判定要现读配置（不是构造期快照）', { skip }, () => {
  let on = true;
  const store = createVecIndexStore({ dim: DIM, limits: () => ({ enabled: on, maxVectors: 1000 }) });
  assert.equal(store.enabled, true);
  assert.equal(store.load('d1', rowsFor(['e1'])), true);

  on = false;   // 模拟热改配置
  assert.equal(store.enabled, false, '关掉之后必须立刻不可用 —— 否则就是个点了没反应的死开关');
  assert.equal(store.load('d2', rowsFor(['e1'])), false);
});

test('clear：整层丢弃后 stats 归零（rebuild 的唯一正确姿势）', { skip }, () => {
  const store = createVecIndexStore({ dim: DIM });
  store.load('d1', rowsFor(['e1', 'e2']));
  store.load('d2', rowsFor(['e3']));
  assert.equal(store.stats().domains, 2);
  assert.equal(store.stats().vectors, 3);

  store.clear('rebuild');
  const st = store.stats();
  assert.equal(st.domains, 0);
  assert.equal(st.vectors, 0);
  assert.equal(st.bytes, 0);
  assert.equal(store.search('d1', vec(1), 1), null, '清空后旧域必须不可用（绝不能用旧映射继续查）');
});

test('空域：load 不炸，search 返回 null 让调用方走 vec0', { skip }, () => {
  const store = createVecIndexStore({ dim: DIM });
  assert.equal(store.load('empty', []), false);
  assert.equal(store.search('empty', vec(1), 1), null);
  assert.equal(store.stats().domains, 0, '空域不该占一个索引位');
});
