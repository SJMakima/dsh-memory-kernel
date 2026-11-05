/**
 * §14 生命周期：惰性衰减 + 冷存判定（纯函数）。
 *
 * 【R-75】半衰期与 floor 都从配置读（P2 要校准）。唯一的例外是 boundary / skill 的
 * Infinity —— 那是**语义豁免**（这两类永不衰减），写进配置只会让"有人改成 30 天"变成合法操作。
 * ADR-3：读时惰性衰减，无调度器；每次检索一次浮点运算。
 */
export function halfLifeMs(type, cfg) {
  if (type === 'boundary' || type === 'skill') return Infinity;
  return (cfg.lifecycle.halfLifeDays[type] ?? cfg.lifecycle.halfLifeDays.fact) * 864e5;
}

export function persistenceFloor(type, cfg) {
  return cfg.lifecycle.floor[type] ?? cfg.lifecycle.floor.fact;
}

export function lazyPersistence(e, cfg, now = Date.now()) {
  const halfLife = halfLifeMs(e.entry_type, cfg);
  const gamma = Math.max(e.gamma_multiplier, 1e-9);
  const baseFloor = persistenceFloor(e.entry_type, cfg);

  // 【R-123】**∞ 半衰期是语义豁免，floor 不参与 γ 缩放**：boundary/skill 声明"不衰减"，
  // 若在这里除 γ，被取代过的 boundary（γ=3）floor 会从 0.6 掉到 0.2——比没被取代时还低，
  // 等于 γ 从侧门把 §14 承诺的"豁免不可配"绕过去了。γ 只该加速会衰减的类型。
  if (!isFinite(halfLife)) return Math.max(e.persistence_at_decay, baseFloor);

  const floor = baseFloor / gamma;                  // γ 加速：半衰期变短，floor 同步下移
  const effective = halfLife / gamma;
  const decayed = e.persistence_at_decay * Math.pow(0.5, (now - e.last_decay_at) / effective);
  return Math.max(decayed, floor);
}

export function shouldColdArchive(e, cfg, now = Date.now()) {
  // 【R-144】冷存豁免从"类型硬编码"升级为 importance 豁免线（≥0.8 不归档）：
  // boundary/skill 写入期就是 1.0，行为对旧数据等价；新语义下 confirm 加成 / 身份三元组
  // 的条目也能被豁免。旧行无 importance 字段时按类型推（rebuild 前的过渡态）。
  const importance = e.importance
    ?? ((e.entry_type === 'boundary' || e.entry_type === 'skill') ? 1.0 : 0.5);
  const floor = cfg.lifecycle.importanceFloor ?? 0.8;
  return !e.cold
    && importance < floor
    && lazyPersistence(e, cfg, now) < cfg.lifecycle.coldThreshold
    && e.last_activated_at != null
    && (now - e.last_activated_at) > cfg.lifecycle.coldIdleMs;
}

/** 激活回报：结算到 snapshotTs，返回新的 persistence 与本窗口 hits。 */
export function settleEntry(e, cfg, snapshotTs, hits) {
  const decayed = lazyPersistence(e, cfg, snapshotTs);
  const bonus = cfg.lifecycle.activationBonus * Math.min(hits, cfg.lifecycle.activationCap);
  return Math.min(cfg.lifecycle.maxPersistence, decayed + bonus);
}
