/**
 * 【R-139】查询侧的日期表达式解析（纯函数）。
 *
 * 为什么不用 stripDateLike 的思路：那边日期是**噪声**（判重/嵌入里剥掉），
 * 这边日期是**信号**（"帮我回忆 10 月 1 号"——日期就是查询的主键）。
 * 两者不冲突：stripDateLike 服务向量/判重，本模块服务「当日档案」召回，
 * 检索侧先捕获日期再决定要不要附加日记段。
 *
 * 只认高置信形态，宁缺勿滥——误判一天会把不相关的日记塞进上下文：
 *   绝对日期：2026-10-01 / 2026/10/1 / 2026.10.1 / 2026年10月1日 / 10月1日 / 10月1号 / 10-01 / 10/1
 *   相对日期：今天 / 昨天 / 前天 / 大前天
 * 不认"上周三""上个月"这类需要周历语义的（歧义大，等真实需求再说）。
 */

const RELATIVE = { '今天': 0, '昨天': 1, '前天': 2, '大前天': 3 };

/** 本地时区的当天 0 点。 */
function startOfLocalDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayRange(dayStart) {
  return { start: dayStart, end: dayStart + 864e5 };
}

/** 月份天数（闰年-aware，仅用于校验）。 */
function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function validYmd(y, m, d) {
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= daysInMonth(y, m);
}

/**
 * @param {string} query 用户查询
 * @param {number} nowMs 当前时间（注入便于测试）
 * @returns {{ start: number, end: number, matched: string } | null}
 */
export function detectDayRange(query, nowMs = Date.now()) {
  const q = String(query ?? '');
  const today = startOfLocalDay(nowMs);
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  // ── 相对日期：先查（避免"昨天"里的"昨"被其它规则吃掉） ──
  for (const [word, ago] of Object.entries(RELATIVE)) {
    if (q.includes(word)) return { ...dayRange(today - ago * 864e5), matched: word };
  }

  // ── 带年：2026-10-01 / 2026/10/1 / 2026.10.1 / 2026年10月1日(号) ──
  let m = q.match(/(\d{4})[-/.年]\s*(\d{1,2})[-/.月]\s*(\d{1,2})[日号]?/);
  if (m) {
    const [, y, mo, d] = m;
    if (validYmd(+y, +mo, +d)) {
      const s = startOfLocalDay(new Date(+y, +mo - 1, +d).getTime());
      return { ...dayRange(s), matched: m[0] };
    }
  }

  // ── 不带年：10月1日(号) / 10-01 / 10/1 —— 年份按就近原则：今年的这一天还没到就是去年 ──
  m = q.match(/(?:^|[^\d])(\d{1,2})[月/.-]\s*(\d{1,2})[日号]?/);
  if (m) {
    const mo = +m[1]; const d = +m[2];
    if (validYmd(new Date(nowMs).getFullYear(), mo, d)) {
      const yr = new Date(nowMs).getFullYear();
      let s = startOfLocalDay(new Date(yr, mo - 1, d).getTime());
      if (s > today) s = startOfLocalDay(new Date(yr - 1, mo - 1, d).getTime());   // 今年还没到 → 归去年
      return { ...dayRange(s), matched: m[0].trim() };
    }
  }

  return null;
}

/* ─────────────── R-147：时间范围解析（temporal 意图的区间通道）─────────────── */

/** 中文数字（一~十/两）→ 阿拉伯；解析不了返回 null。 */
function cnNumber(s) {
  const digit = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  if (/^\d+$/.test(s)) return +s;
  if (s.length === 1) return digit[s] ?? null;
  if (s === '十') return 10;
  if (s.startsWith('十')) { const u = digit[s[1]]; return u ? 10 + u : null; }
  if (s.endsWith('十')) { const t = digit[s[0]]; return t ? t * 10 : null; }
  const m = s.match(/^(.)十(.)?$/);
  if (m) {
    const t = digit[m[1]];
    if (!t) return null;
    if (m[2] !== undefined && digit[m[2]] === undefined) return null;
    return t * 10 + (m[2] ? digit[m[2]] : 0);
  }
  return null;
}

const WEEKDAY = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };

/**
 * 【R-147】显式时间词 → 时间区间。只认高置信形态（宁缺勿滥——误判区间会把不相关
 * 的条目硬滤成空）：
 *   单日相对：今天 / 昨天 / 前天 / 大前天 / 上周X（上周的周X）
 *   周：上周（上周一 0 点 ~ 本周一 0 点）/ 本周·这周·最近一周（本周一 0 点 ~ 现在）
 *   月：上个月·上月（上月 1 日 ~ 本月 1 日）/ 这个月·本月（本月 1 日 ~ 现在）
 *   天数：N 天前（单日）/ 最近·过去·近 N 天（now-N ~ 现在）
 * "后来那次""上次说的"**不认**——那是 relational 的活（R-145 防坑）。
 * @returns {{ start: number, end: number, matched: string } | null} end 为排他上界
 */
export function parseTimeRange(query, nowMs = Date.now()) {
  const q = String(query ?? '');
  const today = startOfLocalDay(nowMs);

  // 单日相对（今天/昨天/前天/大前天）——复用 detectDayRange 的 RELATIVE 表
  const day = detectDayRange(q, nowMs);
  if (day) return day;

  // 上周X（上周的周X 单日）
  let m = q.match(/(?:上|去)\s*(?:周|礼拜|星期)\s*([一二三四五六日天])/);
  if (m) {
    const target = WEEKDAY[m[1]];
    if (target !== undefined) {
      const thisMonday = today - ((new Date(today).getDay() + 6) % 7) * 864e5;
      const lastMonday = thisMonday - 7 * 864e5;
      const d = lastMonday + ((target + 6) % 7) * 864e5;
      return { start: d, end: d + 864e5, matched: m[0] };
    }
  }

  // 上周：上周一 0 点 ~ 本周一 0 点
  if (/上周|上个礼拜|上星期/.test(q)) {
    const thisMonday = today - ((new Date(today).getDay() + 6) % 7) * 864e5;
    return { start: thisMonday - 7 * 864e5, end: thisMonday, matched: '上周' };
  }

  // 本周/这周/最近一周：本周一 0 点 ~ 现在
  if (/最近一?周|这一周|这周|本周|本礼拜|这个礼拜/.test(q)) {
    const thisMonday = today - ((new Date(today).getDay() + 6) % 7) * 864e5;
    return { start: thisMonday, end: nowMs + 864e5, matched: '本周' };
  }

  // 上个月：上月 1 日 ~ 本月 1 日
  if (/上个月|上月/.test(q)) {
    const n = new Date(nowMs);
    return { start: new Date(n.getFullYear(), n.getMonth() - 1, 1).getTime(), end: new Date(n.getFullYear(), n.getMonth(), 1).getTime(), matched: '上个月' };
  }

  // 本月/这个月：本月 1 日 ~ 现在
  if (/这个月|本月/.test(q)) {
    const n = new Date(nowMs);
    return { start: new Date(n.getFullYear(), n.getMonth(), 1).getTime(), end: nowMs + 864e5, matched: '本月' };
  }

  // N 天前（单日）
  m = q.match(/([一二两三四五六七八九十\d]+)\s*天前/);
  if (m) {
    const n = cnNumber(m[1]);
    if (n) return { ...dayRange(today - n * 864e5), matched: m[0] };
  }

  // 最近/过去/近 N 天：now-N ~ 现在
  m = q.match(/(?:最近|过去|近)\s*([一二两三四五六七八九十\d]+)\s*天/);
  if (m) {
    const n = cnNumber(m[1]);
    if (n) return { start: today - (n - 1) * 864e5, end: nowMs + 864e5, matched: m[0] };
  }

  return null;
}
