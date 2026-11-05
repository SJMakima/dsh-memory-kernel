/**
 * 【R-142】情绪序列的形状化（纯函数，便于单测）。
 *
 * 滤噪规则（消费层，**不动存储**——存的是原始判定，数据必须诚实）：
 *   - 连续 ≥2 个同档位（按 ts 排序、相邻同值）→ 一「段」；
 *   - 孤立单点 → 丢弃，**除非 strong=1**（用户原话第一人称明确表述的低频高强度信号，
 *     恰恰是最该被记住的——滤噪规则天然会滤掉它，这是例外存在的理由）；
 *   - source='self'（felt 第一手）**不参与滤噪**，全部保留——自述本身就是信号，
 *     频率低是它的天性，套用"连续才可信"会把第一手全滤光。
 *
 * 边界（2026-10-28 评审定稿）：
 *   - emotion 为 null 的行在进入这里之前就该被过滤（null = 未判出/未自述，不推断不填补）；
 *   - "段"是消费层概念，日记/参考段引用它，数据库里没有"段"这种东西。
 */

/**
 * **单轨函数**：传入的点必须是同一个人的（调用方先按 owner/source 分轨——
 * 混着喂会把两个人的情绪连成一个"段"，两个人的轨迹永远不该共享连续性）。
 *
 * @param {Array<{ts:number, emotion:string, strong?:number|boolean, source?:string}>} points
 * @returns {{ segments: Array<{kind:'segment', emotion:string, count:number, from:number, to:number}>,
 *             singles: Array<{kind:'single', emotion:string, ts:number, strong:boolean}> }}
 */
export function shapeEmotionSeries(points) {
  const sorted = [...(points ?? [])]
    .filter((p) => p && typeof p.emotion === 'string' && p.emotion && typeof p.ts === 'number')
    .sort((a, b) => a.ts - b.ts);

  const selfPoints = sorted.filter((p) => p.source === 'self');
  const judged = sorted.filter((p) => p.source !== 'self');   // extract 判定走滤噪

  const segments = [];
  const singles = [];

  let run = null;   // { emotion, count, from, to }
  const flush = () => {
    if (!run) return;
    if (run.count >= 2) segments.push({ kind: 'segment', ...run });
    else if (run.strong) singles.push({ kind: 'single', emotion: run.emotion, ts: run.from, strong: true });
    // 孤立且非 strong：丢弃（滤噪主体）
    run = null;
  };
  for (const p of judged) {
    const strong = Boolean(p.strong);
    if (run && run.emotion === p.emotion) {
      run.count += 1;
      run.to = p.ts;
      run.strong = run.strong || strong;
    } else {
      flush();
      run = { emotion: p.emotion, count: 1, from: p.ts, to: p.ts, strong };
    }
  }
  flush();

  for (const p of selfPoints) {
    singles.push({ kind: 'single', emotion: p.emotion, ts: p.ts, strong: false, self: true });
  }
  singles.sort((a, b) => a.ts - b.ts);

  return { segments, singles };
}

/**
 * 压缩成注入文本的紧凑编码行（评审 #6：保原始序列防 LLM 二次压缩失真）。
 * 例：`19:16 疲惫×2 / 19:18 低落（强） / 19:19 开心【自述】`
 */
export function compactEmotionLine(points, { strongMark = '（强）', selfMark = '【自述】' } = {}) {
  const { segments, singles } = shapeEmotionSeries(points);
  const zh = (e) => EMOTION_ZH[e] ?? e;
  const items = [];
  for (const seg of segments) items.push(`${hhmm(seg.from)} ${zh(seg.emotion)}×${seg.count}`);
  for (const s of singles) items.push(`${hhmm(s.ts)} ${zh(s.emotion)}${s.strong ? strongMark : ''}${s.self ? selfMark : ''}`);
  return items.join(' / ');
}

const hhmm = (ts) => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export const EMOTION_SET = new Set(['joy', 'sadness', 'anger', 'anxiety', 'fatigue', 'neutral']);

/** 档位中文（与 assembly.renderEmotionHint 同表，别处不要重复发明）。 */
export const EMOTION_ZH = { joy: '开心', sadness: '低落', anger: '不满', anxiety: '焦虑', fatigue: '疲惫', neutral: '平静' };
