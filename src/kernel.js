/**
 * MemoryKernel —— 把各层接起来，并对宿主暴露能力面。
 *
 * 【R-152】对外能力面收敛为四组（平铺键保留为向后兼容别名，@deprecated）：
 *   kernel.memory     检索 / 取回 / 写入 / 抽取 / preStep / 流水层（transcript/inner/emotions/diary）/ 写管线
 *   kernel.lifecycle  dream / rebuild / forget / 配额消化 / 补嵌 / init / close
 *   kernel.domains    注册 / 路由 / 枚举
 *   kernel.health     三态诊断 / 状态聚合 / 审计摘要 / 任务视图 / 配置热补
 * 两条铁律（写死在门面，模块不得绕过）：
 *   写走管线——任何写必须过 write 层硬序 md→SQLite→索引；
 *   读过闸门——任何读必须过 admit/验签（R-153 access-gate 是唯一强制点）。
 * 适配层边界由 scripts/check-facade.mjs 静态断言把守（npm test 最后一环）。
 *
 * 宿主（DSH Host）只依赖这个门面；平台专有名词一律不进 core（C4）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, DEFAULTS } from './config.js';
import { applyConfigPatch } from './config-classes.js';
import { openDatabase, recreateVecTable } from './storage/db.js';
import { createAudit } from './storage/audit.js';
import { createFileStore } from './storage/files.js';
import { createDomainRegistry } from './core/domains.js';
import { createSecurity } from './core/security.js';
import { createAccessGate } from './core/access-gate.js';
import { createVec } from './core/vec.js';
import { createWritePipe } from './core/write.js';
import { createRetriever } from './core/retrieve.js';
import { createDream } from './core/dream.js';
import { createAssembler } from './core/assemble.js';
import { createTranscript } from './core/transcript.js';
import { createInner } from './core/inner.js';
import { createEmotions } from './core/emotion.js';
import { createDiary } from './core/diary.js';
import { rebuildAll } from './core/rebuild.js';
import { loadEntry } from './core/entry.js';
import { isSelfContained, classifyIntent } from './pure/ranking.js';
import { getVocab } from './core/vocab.js';
import { newUlid, setAttributeAliases, setSynonymGroups } from './pure/normalize.js';
import { detectVerified, updateTrustLogit } from './core/security.js';
import { createEmbeddingWorkerClient } from './core/embedding-client.js';
import { createLexVecEmbedder } from './adapters/lexvec-embedder.js';
import { createExtractor } from './core/extract.js';
import { createForgetter } from './core/forget.js';
import { statusStats } from './core/stats.js';
import { taskBacklog } from './core/tasks.js';
import { acquireWriterLock } from './storage/root-lock.js';
import { createLlmRouter } from './adapters/llm-router.js';

export async function createKernel(options = {}) {
  const cfg = loadConfig(options.config ?? {});
  setAttributeAliases(cfg.write.attributeAliases);   // 【冲突治理 §2.2】attribute 同义折叠表生效
  setSynonymGroups(cfg.retrieve.synonymGroups);       // 【检索增强】查询同义词典生效
  await fs.mkdir(cfg.storage.root, { recursive: true });
  await fs.mkdir(path.join(cfg.storage.root, 'domains'), { recursive: true });
  await fs.mkdir(path.join(cfg.storage.root, 'shared_core'), { recursive: true });


  const audit = createAudit(cfg.storage.root);

  // 【R-159】单写者契约（可选启用）：锁在 openDatabase 之前拿，失败即抛——
  // 第二个写实例不允许"开库后才发现"，那会留下"已打开但没归属"的 db 句柄。
  // 只读旁路实例（allowShared）并行允许；默认关闭以保持既有行为，宿主/CLI 显式开启。
  let writerLock = null;
  if (options.singleWriter) {
    writerLock = await acquireWriterLock(cfg.storage.root, {
      kernelVersion: options.kernelVersion ?? '0.1.0',
      allowShared: options.singleWriter === 'shared',
    });
    if (!writerLock.acquired && options.singleWriter === 'shared') writerLock = null;   // shared 探测到活锁 = 本实例只读
  }
  // shared 旁路在别的进程持锁时：读全放行，写动作（含 rebuild/forget/dream）明确报错，绝不静默降级
  const requireWriter = () => {
    if (options.singleWriter === 'shared' && !writerLock) {
      throw new Error('本实例以只读旁路打开（另一进程持有 writer.lock，R-159 单写者契约）：写入/rebuild/forget/dream 不可用');
    }
  };

  // 【故障注入审计 2026-11-01】rebuild 中途并发写防护：rebuild 会清空 files/entries 等表再从
  // md 快照重灌，期间任何写动作插进来都会"写入成功但 files 映射丢失"（新 md 不在扫描快照里，
  // 整表重建后 locateEntryPath 失效）——看似成功、实际不一致，正是故障注入审计要堵的中间态。
  // rebuild 运行期写入口（remember/forget/dream/append*）一律明确拒绝，完成后重试。
  // init 内的 bootstrap/dimMismatch rebuild 不需要此标志：那时 kernel 尚未返回，外部无入口。
  let rebuildRunning = false;
  const assertStableForWrite = () => {
    if (rebuildRunning) {
      throw new Error('rebuild 进行中：写入/遗忘被拒绝（防 files 映射撕裂）——等 rebuild 完成后重试');
    }
  };

  // 【R-159.1】构造期全路径资源守护：从锁获取成功到 kernel 对象完整构造之间，任何一步失败
  // 都必须回收已建资源（先收 embedder/worker，再关 db，最后释放写锁）——不留"半初始化"
  // 的资源，也不留一个阻挡新实例的自有锁（I10 全覆盖；此前只护住 openDatabase 一步）。
  let embedder = null;
  let closeDb = null;
  let closePromise = null;   // close 幂等标志（R-159.1）：声明必须在 return 之前
  let ignore;
  let domains;
  let security;
  let vec;
  let files;
  let llm;
  let write;
  let transcript;
  let inner;
  let emotions;
  let diary;
  let gate;
  let retrieve;
  let dream;
  let assembler;
  let extractor;
  let forgetter;
  let whenEmbeddingReady;
  let memory;
  let lifecycle;
  let domainsApi;
  let healthApi;
  let db;
  let vecInfo;
  try {
    // 【R-159.1 问题 1】git init / .gitignore 属 root 写操作，必须在锁获取之后执行——
    // 锁前只保留无害的目录准备（mkdir recursive 幂等）。锁的生效从启动第一步就开始。
    if (writerLock?.stale) await audit.write('root-lock', { event: 'stale-taken-over', previousHolder: writerLock.previousHolder ?? null });
    if (options.gitInit !== false) {
      await fs.access(path.join(cfg.storage.root, '.git')).catch(async () => {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        await promisify(execFile)('git', ['init', '-q'], { cwd: cfg.storage.root }).catch(() => {});
      });
    }
    // keys/ 与 *.db 不入 git
    ignore = path.join(cfg.storage.root, '.gitignore');
    await fs.access(ignore).catch(() =>
      fs.writeFile(ignore, 'keys/\n*.db\n*.db-wal\n*.db-shm\n', 'utf8'));
    // 【检索增强】嵌入后端 kernel 侧同源恢复：embedding-settings.json 是宿主自管落盘
    // （宿主 Config volatile 通道断），但只有宿主读它 = 旁路实例（导入器/CLI 等 headless
    // 内核）全部拿默认 hash/1024 维开库——对 lexvec 库就是 dimMismatch 全量重建，真向量
    // 被洗成空。headless 无注入 embedder 时在此恢复落盘值；宿主/测试的注入路径不受影响。
    if (!options.embedder && options.embeddingWorker === false) {
      try {
        const saved = JSON.parse(await fs.readFile(path.join(cfg.storage.root, 'embedding-settings.json'), 'utf8'));
        if (saved?.backend === 'lexvec') {
          cfg.embedding.backend = 'lexvec';
          if (saved.lexvecTablePath) cfg.embedding.lexvecTablePath = saved.lexvecTablePath;
        }
      } catch { /* 无文件/坏文件 = 默认后端，行为不变 */ }
    }

    // 嵌入模型只存在于 worker 线程（ADR-2 / 禁止项 20）；注入 embedder 时走注入的（测试/demo），
    // `embeddingWorker:false` 则完全关闭向量路（检索降级三路）。
    // backend=lexvec（宿主注入或上面恢复）→ 词向量表后端；外部词表在下面 loadExternalTable 统一加载。
    embedder = options.embedder
      ?? (cfg.embedding.backend === 'lexvec'
        ? createLexVecEmbedder({ tablePath: cfg.embedding.lexvecTablePath })
        : (options.embeddingWorker === false ? null : createEmbeddingWorkerClient({
          dim: cfg.embedding.dim,
          rpcTimeoutMs: cfg.embedding.rpcTimeoutMs,
          warmupTimeoutMs: cfg.embedding.warmupTimeoutMs,
          onEvent: (e) => { void audit.write('embedding', e); },
        })));

    // 外部词表加载必须在 openDatabase **之前**——dim 链最前端：
    // embedder.dim（种子 32 / fastText 300）→ openDatabase 的 dimMismatch 判定 → vec 表结构。
    // 晚了任何一环，就是 300 维向量灌 32 维表的 SqliteError。
    if (embedder?.loadExternalTable && cfg.embedding.lexvecTablePath) {
      await embedder.loadExternalTable(cfg.embedding.lexvecTablePath);
    }

    // 【R-158.6】bootstrap 注册显式 replace:false：options.domains 意外撞 id 直接炸，
    // 不允许悄悄覆盖（动态域运行时注册走 lib-index，有自己的 exists 闸门，保持默认覆盖）。
    // 放在 openDatabase **之前**：撞 id 炸在开库前，不留"已打开但没归属"的 db 句柄。
    domains = createDomainRegistry({ audit });
    for (const d of options.domains ?? []) domains.register(d, { replace: false });

    // 【故障注入审计 2026-11-01】openDatabase 失败（如 db 文件损坏 SqliteError）时必须释放
    // 已获取的写锁——createKernel 在此抛错后 kernel 对象不会生成，宿主拿不到 dispose，
    // 锁残留 = 同进程后续启动全部 fail-closed（持锁 pid 存活判定）。I10 锁生命周期无泄漏。
    ({ db, vec: vecInfo, close: closeDb } = openDatabase({
      dbPath: cfg.storage.dbPath,
      modelId: cfg.embedding.model,
      dim: embedder?.dim ?? cfg.embedding.dim,
      enableVec: options.enableVec !== false,
      busyTimeoutMs: cfg.storage.busyTimeoutMs,
    }));

    security = createSecurity({ cfg, audit });
    vec = createVec({ db, cfg, vec: vecInfo, embedder, audit });
    files = createFileStore({ db, cfg, audit });

    // 【LLM 接入 · R-127~R-130】transport 选路：显式注入优先（测试/demo），否则读 cfg.llm——
    // 关闭时返回 null，抽取器不构造，与接入前行为完全一致。host 档需要宿主把 ctx.llm 传进来
    // （options.hostLlm），headless 实例没有它 → 该档"调用即报错"，绝不静默降级到 custom。
    llm = options.llm ?? createLlmRouter({ cfg, hostLlm: options.hostLlm, audit });

    write = createWritePipe({ db, cfg, vec, files, audit, security, domains });
    // 【R-108】对话流水：纯 append 层，与 entries 同库不同表。检索侧只读本域（R-110）。
    transcript = createTranscript({ db, cfg, vec });   // 【R-141】vec 进来：原话向量路
    // 【R-139】内心活动流水（第一手：memory_inner 工具写入）+ 日记层（进真相源，永不衰减）。
    // diary 需要 inner/transcript/llm：日记 = 三者原料的合并提炼。
    inner = createInner({ db, cfg });
    // 【R-142】情绪日志：抽取顺带判定（extract 线）+ memory_inner 自述（self 线）。
    // 采集无条件；cfg.emotion.enabled 只在消费口（assemble/retrieve/diary 注入处）判。
    emotions = createEmotions({ db, cfg });
    diary = createDiary({
      db, cfg, domains, inner, transcript, llm, audit, rootDir: cfg.storage.root,
      // 日记向量路（R-141 同族）：借用 vec 的嵌入器；vec 关闭时 searchAsync 自动降级纯 FTS
      embed: vec?.enabled ? (async (text) => vec.embedTexts([text])) : null,
    });
    // 【R-153】Access Gate：读取权限的单文件强制入口（两条铁律见 access-gate.js 文件头）。
    // 检索（retrieve.admit 内部）与 context（admitContext 守卫链）共用同一份判定。
    gate = createAccessGate({ cfg });
    retrieve = createRetriever({
      db, cfg, vec, files, audit, security, domains, write, transcript, inner, diary, reranker: options.reranker, gate,
    });
    dream = createDream({ db, cfg, vec, files, audit, domains, write, llm, diary, inner, transcript, emotions });
    assembler = createAssembler({ db, cfg, audit, domains, emotions });

    // P0b：LLM 注入式接入（transport 见 adapters/llm-chat.js）。不注入就没有 extract 入口，
    // remember（手写候选）照常可用 —— 两条入口共用同一条落盘管线。
    extractor = llm
      ? createExtractor({ cfg, vec, audit, domains, write, llm, emotions })
      : null;

    // 【R-156】遗忘闭环：forget(entryId, {confirmId}) 六位置一次清（md/SQLite+FTS/向量+索引/links/冷存/git tombstone）。
    // 裁决权在人：无 confirmId、无批量、无 LLM 自动通道（红线见 forget.js 文件头）。
    forgetter = createForgetter({ db, cfg, vec, files, audit, write });

    let ready = false;
    let embReady = Promise.resolve(true);

    async function init() {
      // 冷启动分两档：就绪标志只等"骨架 + 索引"（<2s），模型加载单独计时（§6 / §11.1）
      const empty = db.prepare('SELECT COUNT(*) AS c FROM entries').get().c === 0;
      if (empty) {
        const result = await rebuildAll({ db, cfg, files, vec, vecInfo, audit, domains });
        await audit.dream({ event: 'bootstrap-rebuild', ...result });
      } else if (vecInfo.dimMismatch && !embedder) {
        // 无嵌入后端的旁路实例（导入器/CLI）撞上维度不匹配：**绝不能重建**——重建 = 把库里
        // 的真向量按错误维度洗成空（不可逆数据丢失）。降级为本实例禁用向量路（写入不带向量、
        // 检索走三路），mismatch 留给带正确后端的宿主实例处理。
        vecInfo.enabled = false;
        await audit.dream({ event: 'dim-mismatch-vec-disabled-headless', metaDim: vecInfo.dim });
      } else if (vecInfo.dimMismatch) {
        // 维度与 model_meta 不一致 → 拒绝服务并触发全量重建（§18）。
        // ⚠ 必须重建**表结构**（DROP+CREATE）：DELETE 只清数据，旧表的 vec0 维度声明还在，
        // 新维度向量灌进去直接 SqliteError（实测：1024 表 vs lexvec 32 维）。
        recreateVecTable(db, { dim: embedder?.dim ?? cfg.embedding.dim });
        db.exec('DELETE FROM vec_shards');
        const result = await rebuildAll({ db, cfg, files, vec, vecInfo, audit, domains });
        db.prepare('UPDATE model_meta SET model_id = ?, dim = ?, created_at = ? WHERE id = 1')
          .run(cfg.embedding.model, embedder?.dim ?? cfg.embedding.dim, Date.now());
        await audit.dream({ event: 'dim-mismatch-rebuild', ...result });
      }
      ready = true;

      // 【R-137】内存索引不可用的原因（usearch 装不上 / 配置关掉）在启动时落痕一次。
      // 它是纯性能层，失败了不影响正确性，所以只记一条、不阻断、不重试。
      if (vec.enabled && !vec.indexStats().enabled) {
        await audit.write('vec-index', {
          event: 'unavailable', reason: vec.indexStats().refusal, fallback: 'vec0-knn',
        });
      }

      // 预热"发出去就不管"：不 await、不阻塞就绪标志。期间 embed() 返回 null → 三路降级。
      // 预热成功后接着补嵌（§18）：把预热窗口里写进来、还没向量的条目补齐，仍是 fire-and-forget。
      if (embedder?.warmup) {
        embReady = embedder.warmup().then(async (ok) => {
          if (ok) {
            await sweepEmbeddings().catch(() => null);
            // 【R-141】启动回填：嵌入器就绪后，把历史上没有向量的原话补齐（后台跑，不挡启动）
            transcript.backfillVectors(1000).catch(() => null);
          }
          return ok;
        });
      }

      return { ready, vec: vecInfo, root: cfg.storage.root, embedding: embedder ? 'worker' : 'disabled' };
    }

    /**
     * §18 补嵌扫描，带最多 3 趟、间隔 150ms 的重扫。
     *
     * 为什么要多趟：预热完成那一瞬间，可能正卡在某次写入的「取完向量 → 还没落库」中间。
     * 那一条在当趟扫描时根本不在表里（pending 列也还没翻），扫完它才落进来。
     * 只扫一趟的实现，会把**冷启动头两秒写入的记忆**永久留在三路召回里 ——
     * 向量路"看起来在工作"（预热后一切正常），出问题的只是那几条，日志里干干净净。
     *
     * 收工条件是"这一趟扫到了东西"：没有 pending 时才值得再等一拍，否则白等。
     */
    async function sweepEmbeddings({ rounds = 3, gapMs = 150 } = {}) {
      let last = null;
      for (let i = 0; i < rounds; i++) {
        last = await write.backfillEmbeddings().catch(() => null);
        if (!last || last.scanned > 0) break;
        await new Promise((r) => setTimeout(r, gapMs));
      }
      return last;
    }

    /** 想等模型就绪的调用方（CLI / 单发脚本）等这个；宿主**不要**等（会拖长首次响应）。 */
    whenEmbeddingReady = () => embReady;

    /** P0a 入口：手写候选 JSON。`cfg.write.p0aBypassRouting` 为 true 时绕过四分类（仅 P0a）。 */
    async function remember(candidate) {
      requireWriter();
      // 【Fix · 参数可读性，人工评审 Bug3】缺 sourceRef/provenance 时，错误原本深埋在
      // serializeEntryBlock（`e.source_ref.adapter_id`）/ 签名序列化里以 TypeError 爆出，
      // 调用方无从定位。身份出身是写管线硬契约（I9：身份只来自宿主），入口给可读错误。
      if (!candidate || typeof candidate !== 'object') {
        throw new Error('remember：candidate 必须是对象');
      }
      for (const key of ['sourceRef', 'provenance']) {
        const v = candidate[key];
        if (v === undefined || v === null || typeof v !== 'object' || Array.isArray(v)) {
          throw new Error(`remember：缺少或非法的 ${key}（写管线身份/出身契约，见 INVARIANTS I9）——期望非空对象，实际 ${v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v}`);
        }
      }
      // 【Fix · 字段级校验，外审】对象类型过关只是底线——出处定位与身份链的核心字段
      // 缺失同样要在入口给可读错误（md 序列化与信任计算都消费这些字段）。
      if (typeof candidate.sourceRef.adapter_id !== 'string' || !candidate.sourceRef.adapter_id
        || typeof candidate.sourceRef.locator !== 'string' || !candidate.sourceRef.locator) {
        throw new Error('remember：sourceRef 需要非空的 adapter_id 与 locator 字符串（出处定位契约）');
      }
      if (typeof candidate.provenance.session_id !== 'string') {
        // 注意：空字符串是合法值——无宿主身份时写空出身是 I9 的 fail-closed 裁定（identity-trust 契约），
        // 这里只拒类型错误（number/null 之类会让下游签名与可见性配对走到未定义行为）。
        throw new Error('remember：provenance.session_id 必须是字符串（身份链核心，I9；空串 = 无宿主身份的合法 fail-closed 出身）');
      }
      const domain = candidate.domainId
        ? domains.get(candidate.domainId)
        : domains.routeDomain(candidate.sessionId);
      if (!domain) throw new Error(`unknown domain: ${candidate.domainId ?? candidate.sessionId}`);

      const route = cfg.write.p0aBypassRouting
        ? { kind: 'new' }
        : await write.classifyNovelty(candidate, domain);

      switch (route.kind) {
        case 'redundant': write.reinforceEntry(route.existingId); return { status: 'redundant', existingId: route.existingId };
        case 'update': return write.handleUpdate(candidate, route, domain);
        case 'uncertain': return write.handleUncertain(candidate, route, domain);
        default: return write.persistNewEntry(candidate, domain);
      }
    }

    /**
     * 【R-154】health() 三态：READY / DEGRADED / FAILED + 原因数组。
     * 纯查现算不缓存；数据源全部复用现有字段（db 连通、vec 就绪、sqlite-vec 加载、
     * 内存索引脏域、LLM 通道、配置自洽），不新增采集。分级语义：
     *   FAILED   核心读写不可用（db 连不上）——插件应当被视为不可服务；
     *   DEGRADED 核心可用但某辅助能力降级/缺失（向量路回落三路、LLM 缺席）——功能在，能力打折；
     *   READY    全绿。
     */
    function health() {
      try {
        db.prepare('SELECT 1').get();
      } catch (e) {
        return { state: 'FAILED', reasons: [`数据库不可用：${e.message}`], infos: [], checkedAt: Date.now() };
      }

      const reasons = [];
      const infos = [];
      if (!vec?.isReady?.()) reasons.push('嵌入模型未就绪：向量路降级三路召回（R-54 语义）');
      if (vecInfo?.enabled && !vecInfo?.version) reasons.push('sqlite-vec 扩展未加载：向量路降级');
      const st = vec?.indexStats?.();
      if (st?.enabled && st.dirtyDomains > 0) reasons.push(`${st.dirtyDomains} 个域的内存索引已脏：本轮查询回落 vec0 MATCH`);
      if (st && !st.enabled && cfg.retrieve?.memIndex?.enabled !== false) {
        reasons.push(`内存索引未启用：${st?.refusal ?? 'unknown'}`);
      }
      if (cfg.llm?.enabled && !llm?.available?.()) reasons.push('配置声明启用 LLM 但通道不可用（host 档 headless / 端点未就绪）：抽取/dream LLM 步骤将跳过');
      if (!cfg.llm?.enabled) infos.push('LLM 未接入（自动抽取/dream LLM 步骤关闭，属预期配置）');
      if (ready === false) reasons.push('内核 init 尚未完成');

      return { state: reasons.length ? 'DEGRADED' : 'READY', reasons, infos, checkedAt: Date.now() };
    }

    /**
     * P0b 入口：消息 → LLM 抽取 → 四分类 → 落盘（§12.1 runExtractTask）。
     * 没注入 llm 时给出能落地的报错，而不是"undefined is not a function"。
     */
    async function extract(input = {}) {
      requireWriter();
      if (!extractor) {
        throw new Error('kernel.extract 需要先打开 LLM 接入（cfg.llm.enabled + transport，见 adapters/llm-router.js），'
          + '或显式注入 createKernel({ llm })；手写候选请用 remember()');
      }
      return extractor.runExtractTask(input);
    }

    async function search(req = {}) {
      if (!ready) throw new Error('kernel not ready');
      const sessionId = req.sessionId ?? req.domain;
      const domain = domains.routeDomain(sessionId) ?? domains.get(req.domain);
      if (!domain) return { domain: null, entries: [], contexts: [], intent: 'factual', elapsedMs: 0, coldScanMs: 0, opsQuery: !!req.includeCold };
      return retrieve.retrieve({
        ...req,
        sessionId: req.sessionId ?? domain.id,
        requestId: req.requestId ?? newUlid(),
        query: req.query ?? '',
      });
    }

    /**
     * `memory_context(entry_id)`：取回条目 + 原始上下文。
     * 【R-153】准入链整体收进 access-gate.admitContext（铁律②）——kernel 不再自带一份
     * 守卫实现，gate 是唯一强制点；任何一步不过返回 null，不得降级放行。
     */
    async function context(entryId, request = {}) {
      const admitted = gate.admitContext({ entryId, request, domains, security, loadEntry: (id) => loadEntry(db, id) });
      if (!admitted) return null;
      const { entry: e } = admitted;
      const domain = domains.get(e.domain_id);
      let original = null;
      // sourceReaderIsLocal === false 表示这个域没有本地档案（或读一次要上百毫秒），
      // 与回读复核的规则一致：不参与、也不假装读过。授权和验签通过后才允许访问原始来源。
      if (domain?.sourceReader && domain.sourceReaderIsLocal !== false) {
        try {
          original = await domain.sourceReader.read(e.source_ref);
        } catch {
          original = null;
        }
      }
      return { entry: e, original };
    }

    /**
     * `agent/pre-step`：自包含短路（唯一判定点 [R-45]）→ 检索 → 三段组装。
     * 返回的 messages 已剥离历史动态段并注入本轮动态段。
     */
    async function preStep({ sessionId, messages, includeCold = false, minPersistence, topK }) {
      // 总开关闸门：**整条短路**，不是"只跳过检索"。guide + 稳定段里全是记忆，
      // 组装了再丢弃等于掩耳盗铃；历史轮里已注入的 <memory_context> 也必须剥掉，
      // 否则上外审漏进上下文的记忆在禁用后还在漏（验收：拼装结果里没有任何记忆相关字符串）。
      if (!cfg.plugin.enabled) {
        return { skipped: 'disabled', system: '', messages: assembler.stripHistoricalDynamic(messages) };
      }
      const query = lastUserText(messages);
      const domain = domains.routeDomain(sessionId);
      if (!domain) return { skipped: 'no-domain', system: '', messages };

      // 先剥离历史动态段，再算"工作记忆"——否则上外审的 `<memory_context>` 会被当成
      // 外审对话内容再抄进本轮动态段（上下文里出现嵌套的记忆块）。
      const stripped = assembler.stripHistoricalDynamic(messages);

      if (isSelfContained(query, cfg.routing.selfContainedMaxLen)) {
        // 短路只影响动态段；system prompt（guide + 稳定段）仍要注入
        return {
          skipped: 'self-contained',
          system: assembler.systemPrompt(domain.id),
          messages,
        };
      }

      const result = await retrieve.retrieve({
        sessionId, query, includeCold, minPersistence, topK, requestId: newUlid(),
      });
      const out = assembler.assemble({
        sessionId, messages: stripped, result, recentTurns: recentTurns(stripped),
      });
      return { ...out, result, skipped: null };
    }

    /**
     * `agent/post-step`：P1 只做两件事 —— 巩固信号 + （P2 才开）verified 绑定。
     * 命中**不**更新 trust（ADR-11）。
     */
    async function postStep({ sessionId, userMessage, requestId }) {
      // 闸门：禁用时巩固信号与 verified 绑定都不采样（identity 指标在 dream 第 10 步，由 dream 闸门覆盖）
      if (!cfg.plugin.enabled) return { updated: false, skipped: 'disabled' };
      const domain = domains.routeDomain(sessionId);
      if (!domain) return { updated: false };

      if (cfg.trust.verifiedEnabled && requestId && detectVerified(userMessage, cfg)) {
        const row = db.prepare('SELECT entry_ids FROM retrieval_log WHERE request_id = ?').get(requestId);
        if (row) {
          const [first] = JSON.parse(row.entry_ids);
          if (first) {
            const n = db.prepare(`SELECT COUNT(*) AS c FROM activation_events
                                  WHERE entry_id = ? AND kind = 'verified' AND at > ?`)
              .get(first, Date.now() - cfg.trust.verifiedWindowMs).c;
            if (n < cfg.trust.verifiedMaxPerWindow) {
              const e = loadEntry(db, first);
              if (e) {
                updateTrustLogit(e, 'verified', cfg);
                db.prepare('UPDATE entries SET trust_posterior_logit = ?, trust_updated_at = ? WHERE id = ?')
                  .run(e.trust_posterior_logit, e.trust_updated_at, e.id);
                db.prepare("INSERT INTO activation_events(entry_id, at, kind) VALUES (?, ?, 'verified')")
                  .run(e.id, Date.now());
                await audit.trustUpdate({ entryId: e.id, signal: 'verified', posterior: e.trust_posterior_logit });
              }
            }
          }
        }
      }
      return { updated: false };
    }

    function intentOf(query, sessionId) {
      const domain = domains.routeDomain(sessionId);
      if (!domain) return 'factual';
      return classifyIntent(query, getVocab(db, domain.id));
    }

    /**
     * 消费配额满时暂存的候选（FIFO，仍受配额约束）。
     * 挂在 dream 之后 + 提供手动入口：配额是"按本地日"切的，跨日后的第一次巩固就该把它放出来。
     */
    async function drainPending(domainId) {
      const targets = domainId ? [domains.get(domainId)].filter(Boolean) : domains.list();
      const out = {};
      for (const d of targets) {
        out[d.id] = await write.drainPending(d);
      }
      return out;
    }

    // 【R-143】以 boot 时刻起算（而不是 0）：0 会让 idle 路冷启动死锁——
    // `lastDreamAt > 0 &&` 意味着一次 dream 没跑过之前空闲触发永远为假
    let lastDreamAt = Date.now();

    /**
     * 设置页 watch 通道的落点（Phase 1 内核口子）：把宿主送来的补丁按类应用进活引用 cfg。
     * restart 类在补丁层就拒绝，不让 dim 之类的改动撞进 dimMismatch 守卫里炸。
     * retrieve.* 现在全是热键（R-137 之后不再有"烧在建表子句里"的向量配置），无需重算表级状态。
     */
    function applyPatch(patch) {
      const r = applyConfigPatch(cfg, patch, { defaults: DEFAULTS });
      if (r.applied.some((ap) => ap === 'write.attributeAliases')) setAttributeAliases(cfg.write.attributeAliases);
      if (r.applied.some((ap) => ap === 'retrieve.synonymGroups')) setSynonymGroups(cfg.retrieve.synonymGroups);
      void audit.write('config-patch', r).catch?.(() => {});
      return r;
    }

    // 【R-143 评审补】并发守卫：R-143 挂了 60s tick 后，dream（内部含 LLM 日记，实测几十秒）
    // 可能跑不完一个 tick 周期——lastDreamAt 要等完成才更新，下一 tick 的 idle 判定仍为真，
    // 两个 dream 会并发跑（衰减/快照/配额判断全乱）。检查与置位同步完成，单线程下无竞态。
    let dreamInFlight = false;
    async function runDream() {
      requireWriter();
      if (dreamInFlight) return { skipped: 'in-flight' };
      dreamInFlight = true;
      try {
        const r = await dream.run();
        const pending = await drainPending();
        const backfill = await write.backfillEmbeddings().catch(() => ({}));
        lastDreamAt = Date.now();
        return { ...r, pending, backfill };
      } finally {
        dreamInFlight = false;
      }
    }

    /**
     * §17.1 触发条件的实现：巩固信号加权分 ≥ 阈值，或空闲 ≥ idleMs。
     * 宿主把它挂在 `kernel/idle` / 定时器上即可；**这是唯一允许"什么都不做"的 dream 入口**。
     */
    async function maybeDream({ now = Date.now() } = {}) {
      // 闸门：禁用时不投 dream 任务，也不累计巩固信号（post-step 已闸，这里兜 idle 直接触发的路）
      if (!cfg.plugin.enabled) return { skipped: 'disabled' };
      const { score } = dream.pendingConsolidationScore();
      const hot = Object.values(score).some((s) => s >= cfg.dream.signalThreshold);
      const idle = lastDreamAt > 0 && now - lastDreamAt >= cfg.dream.idleMs;
      if (!hot && !idle) {
        return { skipped: 'below-threshold', score, lastDreamAt };
      }
      return { ...(await runDream()), triggeredBy: hot ? 'consolidation-signal' : 'idle' };
    }

    /**
     * P3+ 人工确认式再对齐（§7）：先 list，人（或上层 Agent）确认保留哪条，再 resolve。
     * **这里绝不自动合并**——自动合并错一次，抹掉的是用户的一条真实偏好。
     */
    function listIdentityForks(domainId) {
      return db.prepare(`
        SELECT t.domain_id, t.subject_key, t.attribute, COUNT(DISTINCT t.value) AS values_cnt,
               GROUP_CONCAT(e.id || ':' || replace(t.value, ',', '')) AS members
        FROM entry_triples t JOIN entries e ON e.id = t.entry_id
        WHERE t.domain_id = ? AND e.cold = 0 AND e.superseded_by IS NULL
        GROUP BY t.domain_id, t.subject_key, t.attribute
        HAVING values_cnt > 1
        ORDER BY values_cnt DESC, t.subject_key, t.attribute
      `).all(domainId).map((r) => ({
        ...r,
        members: r.members.split(',').map((s) => {
          const [id, ...rest] = s.split(':');
          return { entryId: id, value: rest.join(':') };
        }),
      }));
    }

    /** 确认保留哪条：其余同簇条目打上取代边（真相源先落），留 audit 供回溯。 */
    async function resolveIdentityFork({ domainId, subjectKey, attribute, keepEntryId }) {
      const alive = db.prepare(`
        SELECT e.id FROM entry_triples t JOIN entries e ON e.id = t.entry_id
        WHERE t.domain_id = ? AND t.subject_key = ? AND t.attribute = ?
          AND e.cold = 0 AND e.superseded_by IS NULL
      `).all(domainId, subjectKey, attribute).map((r) => r.id);
      if (!alive.length) throw new Error(`identity-fork: 未找到 (${subjectKey}, ${attribute}) 的存活条目`);
      if (!alive.includes(keepEntryId)) {
        throw new Error(`identity-fork: keepEntryId=${keepEntryId} 不在该簇的存活条目里 [${alive.join(', ')}]`);
      }

      const losers = alive.filter((id) => id !== keepEntryId);
      for (const id of losers) {
        const e = loadEntry(db, id);
        if (!e) continue;
        const patched = { ...e, superseded_by: keepEntryId };
        // 真相源先落（与 handleUpdate 同序）[R-82]：Markdown 的 state 块里有 superseded_by
        await write.writeMarkdownAtomic(patched, await files.locateEntryPath(e));
        db.prepare('UPDATE entries SET superseded_by = ? WHERE id = ?').run(keepEntryId, id);
      }
      await audit.write('identity-aligned', { domainId, subjectKey, attribute, keepEntryId, superseded: losers });
      return { aligned: losers.length, keepEntryId, superseded: losers };
    }

    // ─────────────── 【R-152】四组能力面（对外 API 的正式形态）───────────────
    // 铁律：写走管线（任何写必须过 write 层硬序 md→SQLite→索引）、读过闸门（任何读必须过 admit/验签）。
    // 平铺键保留为向后兼容别名（@deprecated，迁移指南见 MODULE-CONTRACTS 模组一）；
    // 适配层（src/index.js / dsh/ / bin/）一律用分组形态——静态断言 scripts/check-facade.mjs 管着。
    memory = {
      search, context,
      // 【故障注入审计】写入口在 rebuild 运行期一律拒绝（见 assertStableForWrite 注释）；
      // 读入口（search/context/transcript/inner/emotions/diary/extract 等）不受影响。
      remember: (c, opts) => { assertStableForWrite(); return remember(c, opts); },
      extract, preStep, postStep, intentOf,
      appendTranscript: (...a) => { assertStableForWrite(); return appendTranscript(...a); },
      appendInner: (...a) => { assertStableForWrite(); return appendInner(...a); },
      appendEmotionSelf: (...a) => { assertStableForWrite(); return appendEmotionSelf(...a); },
      transcript, inner, emotions, diary,
      write,   // 写管线本体（R-149 确认队列等治理动作经此）——"写走管线"铁律的管线就是它
    };
    lifecycle = {
      init, dream: (...a) => { assertStableForWrite(); return runDream(...a); }, maybeDream,
      rebuild: (opts) => rebuild(opts),
      forget: (entryId, opts = {}) => { assertStableForWrite(); return forgetter.forget(entryId, opts); },
      tombstonedIds: () => forgetter.tombstonedIds(),
      drainPending, backfillVectors: (limit) => write.backfillEmbeddings(limit),
      close: closeKernel, whenEmbeddingReady,
    };
    domainsApi = {
      get: (id) => domains.get(id),
      list: () => domains.list(),
      route: (sessionId) => domains.routeDomain(sessionId),
      routeDomain: (sessionId) => domains.routeDomain(sessionId),   // 平铺时代的方法名，别名保留
      register: (d, opts) => domains.register(d, opts),
    };
    // health 组：本体是可调用对象——kernel.health() 直接出三态（向后兼容），
    // 组员挂在函数属性上（kernel.health.stats() 等）。
    healthApi = () => health();
    Object.assign(healthApi, {
      stats: () => statusStats(db),
      taskBacklog: () => taskBacklog(db),
      auditSummary: (opts) => audit.summary(opts),
      audit,
      applyConfigPatch: applyPatch,
      listIdentityForks,
      resolveIdentityFork,
      // 向量子系统诊断（只读）：R-137 实际形态 / 分片计数 / model_meta
      vec: { stats: () => vec.indexStats(), shardCount: (id) => vec.shardCount(id), mode: (id) => vec.mode(id), info: vecInfo },
    });

    return {
      // ── R-152 四组 ──
      memory,
      lifecycle,
      domains: domainsApi,
      health: healthApi,

      // ── 平铺别名（@deprecated R-152：仅为存量测试与渐进迁移保留；新代码用上面的分组）──
      // 【故障注入审计】deprecated 别名同样是公开入口，写入口与分组同挡（rebuild 运行期拒绝）。
      cfg,
      db,
      vec,
      vecInfo,
      vectorMode: (domainId) => vec.mode(domainId),
      files,
      audit,
      write,
      retrieve,
      dream: (...a) => { assertStableForWrite(); return runDream(...a); },
      maybeDream,
      applyConfigPatch: applyPatch,
      listIdentityForks,
      resolveIdentityFork,
      drainPending,
      backfillVectors: async (limit) => write.backfillEmbeddings(limit),
      assemble: assembler.assemble,
      invalidateStable: assembler.invalidate,
      // 【R-108】对话流水：宿主钩子负责把每轮新消息丢进来（机械追加，无判断）
      transcript,
      appendTranscript: (...a) => { assertStableForWrite(); return appendTranscript(...a); },
      // 【R-139】内心活动：memory_inner 工具的唯一后端（机械追加，无判断——记的是她自述的动机）
      inner,
      appendInner: (...a) => { assertStableForWrite(); return appendInner(...a); },
      // 【R-142】felt 第一手：memory_inner 自述 → emotion_log(source='self')。
      // 不滤噪不推断；emotion 缺省 = 不写行（null 语义：未自述，绝不补 neutral）
      emotions,
      appendEmotionSelf: (...a) => { assertStableForWrite(); return appendEmotionSelf(...a); },
      diary,
      remember: (c, opts) => { assertStableForWrite(); return remember(c, opts); },
      extract,
      search,
      context,
      preStep,
      postStep,
      intentOf,
      // 【R-156】遗忘闭环：lifecycle 组的第三个写入口（与 dream/rebuild 并列）。confirmId 二次确认。
      forget: (entryId, opts = {}) => { requireWriter(); assertStableForWrite(); return forgetter.forget(entryId, opts); },
      tombstonedIds: () => forgetter.tombstonedIds(),
      init,
      whenEmbeddingReady,
      rebuild,
      close: closeKernel,
      get ready() { return ready; },
      // 【R-159】锁状态透出（诊断面）：{acquired, stale, holder, lockPath} | null
      get writerLock() { return writerLock; },
    };
  } catch (err) {
    // 清理顺序与 closeKernel 一致：先收 worker，再关库，最后放锁；清理自身失败不掩盖原错误。
    try { await embedder?.close?.(); } catch { /* 原错误优先 */ }
    try { closeDb?.(); } catch { /* 同上 */ }
    try { await writerLock?.release?.(); } catch (releaseErr) {
      // 【R-159.7 · 外审】原始构造错误优先上抛，但锁释放失败必须 console.error 留痕——
      // 否则"构造失败 + 释放失败"组合故障下，磁盘残留锁无任何信号（运维只看得到前者）。
      console.error('[dsh-memory-kernel] 构造失败回滚期间的锁释放错误（磁盘可能残留锁，需人工核查）：', releaseErr?.message ?? releaseErr);
    }
    writerLock = null;
    throw err;
  }

  /* ── R-152 之前的平铺定义（本函数体内各闭包的原始出处，实现语义不变）── */
  // 【R-159.1 问题 3】关闭路径分阶段清理 + 幂等：任一阶段失败都不阻断后续阶段——
  // 锁释放必须最终发生（finally 语义），同时保留首个阶段错误不静默吞；重复 close 复用首次结果。
  // （closePromise 声明在构造守护区：平铺定义区位于 return 之后，声明放那里会永久 TDZ。）
  async function closeKernel() {
    // 【R-159.7 · 外审】失败恢复语义：资源阶段（embedder/audit/db）幂等且只执行一次
    // （closePromise 缓存结果——重复清理已关闭的句柄需要阶段状态保护，评审明示不可简单重跑）；
    // 锁释放失败（如临时 EACCES）时**保留 writerLock 引用**（不置空），后续 close() 仅重试锁
    // 释放这一步——恢复入口与幂等语义并存。若锁释放成功则置空；此后再 close 复现首次结果。
    if (closePromise) {
      if (!writerLock) return closePromise;   // 无待重试的锁（已释放/本就无锁）：复现首次结果
      try {
        await writerLock.release();
        writerLock = null;
      } catch (e) {
        throw new Error(`close 重试：锁释放仍失败（${e?.message ?? e}）——残留锁继续 fail-closed 阻挡新实例`, { cause: e });
      }
      return;   // 锁释放恢复完成（首次 close 的资源阶段错误已在首次调用时抛出过）
    }
    closePromise = (async () => {
      const errors = [];
      try { await embedder?.close?.(); } catch (e) { errors.push(e); }   // 先收 worker，再关库（否则 RPC 回包可能打到已关的连接上）
      try { await audit.flush(); } catch (e) { errors.push(e); }
      try { closeDb(); } catch (e) { errors.push(e); }
      let lockErr = null;
      try { await writerLock?.release?.(); } catch (e) { lockErr = e; errors.push(e); }   // 【R-159】正常关闭释放写锁（只删自己写的）
      if (!lockErr) writerLock = null;   // 【R-159.7】释放失败保留引用，供后续 close 重试
      if (errors.length) throw errors[0];
    })();
    return closePromise;
  }
  function appendTranscript({ sessionId, domainId, messages, now }) {
    const d = domainId ?? domains.routeDomain(sessionId)?.id;
    if (!d) return { written: 0 };
    return transcript.append({ sessionId, domainId: d, messages, now });
  }
  function appendInner({ sessionId, domainId, notes, now }) {
    const d = domainId ?? domains.routeDomain(sessionId)?.id;
    if (!d) return { written: 0 };
    return inner.append({ sessionId, domainId: d, notes, now });
  }
  function appendEmotionSelf({ sessionId, domainId, emotion, note, now }) {
    const d = domainId ?? domains.routeDomain(sessionId)?.id;
    if (!d) return { written: 0 };
    return emotions.appendSelf({ sessionId, domainId: d, emotion, note, now });
  }
  async function rebuild(opts) {
    // 【R-137】rebuild 会 DELETE 全表再重灌、重排 id，内存索引必须先整体失效：
    // 留着旧 flat 的后果不是变慢，是**张冠李戴**（旧 id→下标 已与库脱节，查 A 返回 B 且不报错）。
    // 顺序是"先清再重建"：清掉之后 rebuild 里的 upsert 会因域未加载而跳过，正好。
    requireWriter();
    if (rebuildRunning) throw new Error('rebuild 已在进行中，拒绝重入');
    rebuildRunning = true;
    try {
      vec.resetIndex('rebuild');
      const r = await rebuildAll({ db, cfg, files, vec, vecInfo, audit, domains }, opts);
      // 【R-139】日记也是 md 真相源：表从 domains/*/diary/*.md 重灌（幂等，删行重插）
      try {
        let diaryN = 0;
        for (const d of domains.list()) diaryN += await diary.rebuildFromMd(d.id);
        if (diaryN) await audit.write('rebuild', { event: 'diary-replayed', count: diaryN });
      } catch { /* 日记重放失败不挡 entries 的 rebuild 结果 */ }
      return r;
    } finally {
      rebuildRunning = false;
    }
  }
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' || !messages[i].role) return String(messages[i].content ?? '');
  }
  return '';
}

function recentTurns(messages, n = 4) {
  return messages.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-1 - n, -1);
}
