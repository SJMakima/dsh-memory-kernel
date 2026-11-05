/**
 * 【R-142】情绪日志层（emotion_log）——双方情绪的独立流水，不再只当事实条目的附属标签。
 *
 * 两条采集线，绝不混：
 *   ① extract（判定）：抽取任务顺带输出 mood（零新增 LLM 调用）。owner=user 判用户；
 *      owner=agent 是 **expressed**——从她回复语气反推，有自我强化循环的风险
 *      （提示词让她活泼 → 判"开心" → 下轮参考"开心" → 更活泼），只作"她表现出的"记录；
 *   ② self（felt 第一手）：memory_inner 自述，唯一的诚实来源。评审 #1 定死：
 *      **felt 为空 = 本轮未自述，不推断、不填补、不默认 neutral**——
 *      消费层把空当"平静"读，等于编造她的内心。
 *
 * 隐私边界：全库隐私含量最高的数据之一——只本域、TTL 流水、不进真相源、不进 RRF。
 * **采集始终开（成本为零），cfg.emotion.enabled 只控消费口注入**（评审 #3：
 * 关采集的 A/B 是两组数据来源不同，比出来的差异全是噪声）。
 */
import { EMOTION_SET } from '../pure/emotion-shape.js';

export function createEmotions({ db, cfg }) {
  // 采集不看出开关：开关只出现在消费口（assemble / retrieve / diary 的注入判定处）
  const collect = () => true;

  function append({ sessionId, domainId, now = Date.now(), user, agentExpressed, note } = {}) {
    if (!collect() || !sessionId || !domainId) return { written: 0 };
    const ins = db.prepare(`
      INSERT INTO emotion_log(ts, session_id, domain_id, owner, emotion, strong, source, note)
      VALUES (?, ?, ?, ?, ?, ?, 'extract', ?)
    `);
    let written = 0;
    db.transaction(() => {
      // user：emotion 可为 null（判不出 = 不写值，NULL 语义见模块头），strong 只随 user
      if (user !== undefined) {
        ins.run(now, sessionId, domainId, 'user',
          user?.emotion ?? null, user?.strong ? 1 : 0, user?.note ?? note ?? null);
        written++;
      }
      // agent：expressed（语气判定）。felt 走 appendSelf，这里是两条线不混
      if (agentExpressed !== undefined) {
        ins.run(now, sessionId, domainId, 'agent',
          agentExpressed?.emotion ?? null, 0, agentExpressed?.note ?? note ?? null);
        written++;
      }
    })();
    return { written };
  }

  /** felt 第一手：memory_inner 自述写入。不滤噪、不判真假、emotion 缺省 = 不写行。 */
  function appendSelf({ sessionId, domainId, now = Date.now(), emotion, note } = {}) {
    if (!collect() || !sessionId || !domainId) return { written: 0 };
    if (!emotion || !EMOTION_SET.has(emotion)) return { written: 0 };   // 没自述出档位就不记，不猜
    db.prepare(`
      INSERT INTO emotion_log(ts, session_id, domain_id, owner, emotion, strong, source, note)
      VALUES (?, ?, ?, 'agent', ?, 0, 'self', ?)
    `).run(now, sessionId, domainId, emotion, note ?? null);
    return { written: 1 };
  }

  /** 时间窗内的本域情绪事件（消费口自己再做形状化/滤噪）。 */
  function range(domainId, start, end) {
    try {
      return db.prepare(`
        SELECT ts, owner, emotion, strong, source, note FROM emotion_log
        WHERE domain_id = ? AND ts >= ? AND ts < ? AND emotion IS NOT NULL
        ORDER BY ts
      `).all(domainId, start, end)
        .map((r) => ({ ...r, ts: Number(r.ts), strong: Boolean(r.strong) }));
    } catch { return []; }   // 老库无表：情绪路静默缺席，不阻塞检索
  }

  /** TTL 清理（dream 每轮调）。 */
  function prune(nowMs) {
    const days = Number(cfg.emotion?.retainDays ?? 180);
    if (!(days > 0)) return 0;
    try {
      return db.prepare('DELETE FROM emotion_log WHERE ts < ?').run(nowMs - days * 864e5).changes;
    } catch { return 0; }
  }

  function stats() {
    try {
      const total = db.prepare('SELECT COUNT(*) AS c FROM emotion_log').get().c;
      const byOwner = db.prepare("SELECT owner, source, COUNT(*) AS c FROM emotion_log GROUP BY owner, source").all();
      const latest = db.prepare('SELECT MAX(ts) AS t FROM emotion_log').get().t;
      return { total, byOwner, latest: latest ?? null };
    } catch { return { total: 0, byOwner: [], latest: null }; }
  }

  return { append, appendSelf, range, prune, stats };
}
