/**
 * §12.1 抽取任务（P0b）—— 把 runExtractTask 那条链接上。
 *
 *   消息上下文 ──┬─ llm.complete（抽取，可重试）
 *                └─ vec.embedTexts（prefetchEmbedding，给四分类的向量兜底暖缓存）
 *                     ↓
 *   候选清洗（ENTRY_SCHEMA）→ isUseful → classifyNovelty 四分类 → 落盘/强化/更新/挂起
 *
 * 边界约定：
 *   · schema、提示词、JSON 解析在这里；HTTP transport 在 adapters/llm-chat.js；
 *   · 抽取失败**不崩、不丢消息**：消息本体在宿主的档案里，这里只丢"这外审的记忆候选"，
 *     留 audit/extract-failed.log；
 *   · LLM 输出一律当不可信输入：清洗只收 schema 内的字段，多余的全扔。
 */
import { sha256, newUlid } from '../pure/normalize.js';
import { EMOTION_SET } from '../pure/emotion-shape.js';

/** 单任务候选上限：防止一次抽取灌进几十条把配额一口气吃光。不是 cfg 项，是防线。 */
const MAX_CANDIDATES = 8;
/** 解析失败重试次数。LLM 偶发不按格式回是常态，一次重试解决大半；再多就是模型本身不行。 */
const EXTRACT_RETRIES = 1;

const ENTRY_TYPES = new Set(['fact', 'pattern', 'boundary', 'skill']);

const SYSTEM_PROMPT = `你是记忆抽取器。从对话里提取"值得长期记住的事实"，并顺带判读这轮双方的情绪。只输出一个 JSON 对象，不要任何解释：
{
  "candidates": [
    {
      "text": "1-3 句的客观陈述，不超过 200 字，第三人称",
      "entry_type": "fact | pattern | boundary | skill",
      "topic_tags": ["1-5 个短标签"],
      "triples": [{"subject": "主体", "attribute": "属性", "value": "值"}],
      "links": [{"to": 0, "type": "support | causal | coexist"}]
    }
  ],
  "mood": {
    "user": "joy | sadness | anger | anxiety | fatigue | neutral | null",
    "user_strong": false,
    "agent": "joy | sadness | anger | anxiety | fatigue | neutral | null",
    "note": "一句话注脚（如：连说两次困，是真的熬不住了）；没有就 null"
  }
}
候选判定标准：
- fact：明确的事实（偏好、身份、约定）；boundary：用户划的边界/要求；pattern：重复出现的行为模式；skill：可复用的做法。
- 闲聊、问候、当下就会过时的内容（"我今天好累"）→ 不要输出进 candidates（但情绪照常判）。
- 没有值得记的就输出空数组。
- 只依据对话内容，不要推测；拿不准的宁可不输出。

候选间关系（links，可选）：
- to = 本批 candidates 数组里另一条的下标（从 0 起），type：causal=因果导致（A 直接引发了 B）、support=佐证支撑（B 的证据/例证）、coexist=同场景共现（一起发生但无因果）。
- 只链**确实可见**的关系，宁缺毋滥；没有就整个省略 links 字段。禁止自指（to 指向自己）。

情绪判读纪律（mood）：
- user = 用户这轮的情绪；agent = 助手回复语气里**表现出的**情绪（不是助手的内心——内心只有助手自己能记）。
- **拿不准就输出 null，绝不硬填**。null 表示"这轮判不出"，不是平静。
- user_strong 仅当用户**原话第一人称明确表述**了强烈情绪才为 true（如"我今天特别崩溃""真的很难过"）；
  反例："还行吧""没事"（克制表述不算）、你替用户总结出的情绪（不算）。
- 六档之外的词一律输出 null，不要发明新档位。`;

/** 从 LLM 回复里抠出 JSON 数组：剥 ``` 围栏、容忍裸对象、容忍前后废话。 */
export function parseCandidatesJson(raw) {
  if (typeof raw !== 'string') throw new Error('llm 返回的不是文本');
  // 【R-140】思考内联剥离：custom/local 档的模型可能把 <think>…</think> 直接混在正文里
  let s = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
    .replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

  const start = s.indexOf('[');
  const objStart = s.indexOf('{');
  if (start < 0 || (objStart >= 0 && objStart < start)) {
    // 裸对象或先 { 后 [：包成数组再走同一条路
    const o = s.indexOf('{');
    const oEnd = s.lastIndexOf('}');
    if (o < 0 || oEnd <= o) throw new Error('回复里没有 JSON');
    s = `[${s.slice(o, oEnd + 1)}]`;
  } else {
    const end = s.lastIndexOf(']');
    if (end <= start) throw new Error('JSON 数组不完整');
    s = s.slice(start, end + 1);
  }
  const parsed = JSON.parse(s);
  if (!Array.isArray(parsed)) throw new Error('顶层不是数组');
  return parsed;
}

const MOOD_KEYS = new Set(['joy', 'sadness', 'anger', 'anxiety', 'fatigue', 'neutral']);

/**
 * 【R-142】解析抽取输出：新协议是对象 {candidates, mood}，旧协议是裸数组（无 mood）。
 * 兼容旧协议不是客气——模型偶发回退到只给数组时，候选照收、mood 缺席（本轮无情绪记录，
 * 而不是"判成平静"）。mood 里非法枚举一律丢成 null，**不映射、不猜测**。
 */
export function parseExtractOutput(raw) {
  if (typeof raw !== 'string') throw new Error('llm 返回的不是文本');
  // 新协议主路：整体是对象 {candidates, mood}。**不能走 parseCandidatesJson**——
  // 它遇到"先 { 后 ["会把整个对象包进数组，candidates 就被洗成了空。
  if (/"candidates"/.test(raw)) {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        const obj = JSON.parse(m[0]);
        if (obj && typeof obj === 'object' && 'candidates' in obj) {
          const candidates = Array.isArray(obj.candidates) ? obj.candidates : [];
          let mood = null;
          const rawMood = obj.mood;
          if (rawMood && typeof rawMood === 'object') {
            const pick = (v) => (MOOD_KEYS.has(v) ? v : null);
            const user = pick(rawMood.user);
            mood = {
              user,
              // strong 只随 user 且 user 判出了情绪才有意义
              userStrong: Boolean(user) && Boolean(rawMood.user_strong),
              agentExpressed: pick(rawMood.agent),
              note: typeof rawMood.note === 'string' && rawMood.note.trim() ? rawMood.note.trim().slice(0, 200) : null,
            };
          }
          return { candidates, mood };
        }
      } catch { /* 新协议解析失败 → 落回旧协议解析，让重试机制兜底 */ }
    }
  }
  // 旧协议：裸数组（无 mood，本轮情绪缺席——缺席不是"判成平静"）
  return { candidates: parseCandidatesJson(raw), mood: null };
}

/** 只收 schema 内的字段；非法项丢弃而不是猜测（猜测 = 把模型的幻觉洗白成事实）。 */
export function sanitizeCandidates(rawList) {
  const out = [];
  for (const raw of rawList.slice(0, MAX_CANDIDATES)) {
    if (raw == null || typeof raw !== 'object') continue;
    const text = typeof raw.text === 'string' ? raw.text.trim() : '';
    if (!text) continue;

    const triples = [];
    for (const t of (Array.isArray(raw.triples) ? raw.triples : []).slice(0, 8)) {
      if (!t || typeof t !== 'object') continue;
      const subject = typeof t.subject === 'string' ? t.subject.trim() : '';
      const attribute = typeof t.attribute === 'string' ? t.attribute.trim() : '';
      const value = typeof t.value === 'string' ? t.value.trim() : '';
      if (subject && attribute && value) triples.push({ subject, attribute, value });
    }

    const observedAt = Number.isFinite(raw.observed_at) ? raw.observed_at : undefined;
    // 【连锁记忆】同批候选间关系声明：to 是本批数组下标（有效性在写入端按批大小复核）。
    // 类型枚举外的丢弃；只在此收 schema，解析成 EvidenceLink（entry_id）由 runExtractTask 两遍法完成。
    const LINK_TYPES = new Set(['support', 'causal', 'coexist']);
    const links = (Array.isArray(raw.links) ? raw.links : []).slice(0, 4)
      .map((l) => ({ to: Number(l?.to), type: l?.type }))
      .filter((l) => Number.isInteger(l.to) && LINK_TYPES.has(l.type));
    out.push({
      text,
      entryType: ENTRY_TYPES.has(raw.entry_type) ? raw.entry_type : 'fact',
      topicTags: (Array.isArray(raw.topic_tags) ? raw.topic_tags : [])
        .filter((t) => typeof t === 'string' && t.trim())
        .map((t) => t.trim()).slice(0, 5),
      triples,
      ...(links.length ? { links } : {}),
      ...(observedAt !== undefined ? { observedAt } : {}),
    });
  }
  return out;
}

export function createExtractor({ cfg, vec, audit, domains, write, llm, emotions }) {
  if (!llm?.complete) throw new Error('createExtractor: llm 必须提供 complete({system, messages})');

  const now = () => Date.now();

  async function extractWithRetry(messages, meta) {
    let lastErr = null;
    let lastRaw = null;   // 【R-140】原始返回落痕：没有它，"解析失败"永远归因不了是思考混入还是别
    for (let attempt = 0; attempt <= EXTRACT_RETRIES; attempt++) {
      try {
        const raw = await llm.complete({ system: SYSTEM_PROMPT, messages });
        lastRaw = raw;
        const { candidates, mood } = parseExtractOutput(raw);
        return { candidates: sanitizeCandidates(candidates), mood };
      } catch (err) {
        lastErr = err;
      }
    }
    await audit.write('extract-failed', {
      ...meta,
      error: String(lastErr?.message ?? lastErr),
      attempts: EXTRACT_RETRIES + 1,
      raw: typeof lastRaw === 'string' ? lastRaw.slice(0, 400) : null,
    });
    // 【R-142】返回形状与成功路径一致：调用方统一解构 {candidates, mood}
    return { candidates: [], mood: null };
  }

  /**
   * 入参：{ sessionId, text? , messages?, messageId?, observedAt? }
   * 出参：{ taskId, domain, candidates, results }，results 与 candidates 等长一一对应。
   */
  async function runExtractTask(input = {}) {
    const domain = domains.routeDomain(input.sessionId);
    if (!domain) return { skipped: 'no-domain', candidates: 0, results: [] };

    const messages = (input.messages ?? []).length
      ? input.messages
      : [{ role: 'user', content: String(input.text ?? '') }];
    if (!messages.length || !messages.some((m) => String(m.content ?? '').trim())) {
      return { skipped: 'empty-context', candidates: 0, results: [] };
    }
    const ctx = messages.slice(-4);                                    // recentContext(…, 4)
    const ctxText = ctx.map((m) => String(m.content ?? '')).join('\n');

    const taskId = newUlid(now());
    const taskTs = now();
    const meta = {
      taskId, domainId: domain.id, sessionId: input.sessionId,
      model: llm.model ?? 'unknown',
    };

    // 嵌入与抽取并行：prefetch 让 classifyNovelty 的向量兜底命中 embedding_cache，
    // 而不是在四分类里现算一次（R-79 的前提："四分类之前必须就绪"）
    const [{ candidates, mood }] = await Promise.all([
      extractWithRetry(ctx, meta),
      vec.enabled ? vec.embedTexts([ctxText]) : Promise.resolve([]),
    ]);

    // 【R-142】情绪落库：**在候选早退之前**——闲聊轮没有记忆候选是常事，
    // 但情绪判定每轮都有。采集不看出开关（评审 #3：开关只控消费口注入）。
    if (emotions && (mood?.user !== undefined || mood?.agentExpressed !== undefined)) {
      try {
        emotions.append({
          sessionId: input.sessionId, domainId: domain.id, now: taskTs,
          user: mood.user !== undefined
            ? { emotion: mood.user, strong: mood.userStrong, note: mood.note }
            : undefined,
          agentExpressed: mood.agentExpressed !== undefined
            ? { emotion: mood.agentExpressed, note: mood.note }
            : undefined,
        });
      } catch { /* 情绪路失败不影响抽取主线 */ }
    }

    if (!candidates.length) return { taskId, domain, candidates: 0, results: [] };

    const messageIds = ctx.map((m) => m.id).filter(Boolean);
    const locator = input.messageId ?? messageIds[0] ?? `extract:${taskId}`;
    const provenance = {
      session_id: input.sessionId ?? domain.id,
      message_ids: messageIds.length ? messageIds : [locator],
      extract_task_id: taskId,
      model_version: llm.model ?? 'unknown',
      extracted_at: taskTs,
      source_content_hash: sha256(ctxText),
    };

    const results = [];
    for (const c of candidates) {
      const observedAt = c.observedAt ?? input.observedAt;
      const candidate = {
        ...c,
        domainId: domain.id,
        sourceRef: { adapter_id: domain.id, locator },
        provenance,
        ...(observedAt !== undefined ? { observedAt } : {}),
      };

      const issue = write.usefulnessIssue(candidate);
      if (issue) {
        await write.stashLowUtility(candidate, domain, issue);
        results.push({ status: 'low-utility', reason: issue });
        continue;
      }

      // R-53：P0a 用 true 恒走 new；P0b 起必须是 false，否则四分类整条链是死的
      const route = cfg.write.p0aBypassRouting
        ? { kind: 'new' }
        : await write.classifyNovelty(candidate, domain);

      switch (route.kind) {
        case 'redundant':
          write.reinforceEntry(route.existingId);
          results.push({ status: 'redundant', existingId: route.existingId });
          break;
        case 'update':
          results.push(await write.handleUpdate(candidate, route, domain));
          break;
        case 'uncertain':
          results.push(await write.handleUncertain(candidate, route, domain));
          break;
        default:
          results.push(await write.persistNewEntry(candidate, domain));
      }
    }

    // 【连锁记忆·两遍法第二遍】同批 links 声明 → EvidenceLink 补写。
    // 必须等整批落库拿到 entry_id 才能解析 to 下标；update/uncertain 的 results 也带 entry
    // （handleUpdate 返回新条目），都能作为边的端点。低效用/待定池条目不建边——
    // 它们还没正式成为记忆，链上去等于引用不存在的东西。
    const idByIndex = candidates.map((_, i) => {
      const r = results[i];
      if (r?.status === 'written') return r.entry?.id;
      if (r?.entryId) return r.entryId;
      return r?.existingId ?? (r?.entry ? r.entry.id : null);
    });
    for (let i = 0; i < candidates.length; i++) {
      const links = candidates[i]?.links;
      if (!links?.length) continue;
      const evidence = links
        .filter((l) => l.to !== i && l.to >= 0 && l.to < candidates.length && idByIndex[l.to])
        .map((l) => ({ entry_id: idByIndex[l.to], type: l.type, valid_interval: null }));
      if (!evidence.length) continue;
      const selfId = idByIndex[i];
      if (selfId) await write.appendEvidenceLinks(selfId, evidence);
    }
    return { taskId, domain, candidates: candidates.length, results };
  }

  return { runExtractTask, systemPrompt: SYSTEM_PROMPT };
}
