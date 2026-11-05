/**
 * 配置补丁的三分类与热应用（设置页 Phase 1 的内核口子）。
 *
 * 宿主设置页保存后（claimed: 需显式 watch，见 docs/host-compat-matrix.md Q4），
 * 收到的补丁不能无脑 deepMerge 进活引用——五十多个键分三类：
 *
 *   hot         值类旋钮。活引用上直接改，下一次读写就是新值（配额、阈值、路权重、dream 步开关…）。
 *   structural  改完必须 rebuild 才真正生效（rescore 索引建在 CREATE TABLE 上，无法原地改）。
 *               照常应用值 + 返回 structural 清单，由调用方置 mismatch / 提示 rebuild。
 *   restart     拒绝应用。模型/维度/存储路径/时区——进程内改了要么不生效要么直接炸
 *               （embedding.dim 改了会触发 dimMismatch 拒绝服务，不如一开始就拒）。
 *
 * 【下钻规则】沿 DEFAULTS 的形状走，直到确定"补丁单元"：
 *   - 两边都是对象且（DEFAULTS 该位置是分支 / 有子键级 OVERRIDES）→ 继续下钻，
 *     让 {embedding:{model,batchSize}} 里的两个键各归各类；
 *   - 否则整块作为一个单元：对象按**浅合并**应用（partial 的 {memIndex:{maxVectors}} 不会丢
 *     quantizer/minVectors，用户新域的配额也能整块并入 map），数组与标量整体替换。
 *   - 单元键在 DEFAULTS 里不存在 → 仅当父级是扁平 map（如 dailyQuotaPerDomain，合法扩域）
 *     才放行，其余一律按幽灵键拒绝——`write.intentK` 这种表单发明出来的键进不来。
 *
 * 【穷举纪律】所有 DEFAULTS 键都必须有归属：分区默认（SECTION_CLASS）+ 显式例外（OVERRIDES）。
 * test/config-schema.test.js 会锁三件事：遍历 DEFAULTS 全叶无 undefined、
 * OVERRIDES 路径必须真实存在（抓幽灵键）、UI schema 与 CONFIG_ONLY 双向覆盖。
 * 以后加新键忘了分类或改了结构，测试直接红。
 */

/** 分区默认类：没进 OVERRIDES 的键按所属分区归类。 */
export const SECTION_CLASS = {
  plugin: 'hot',         // 总开关：工具 + 钩子双闸的判定值，读一次判一次
  storage: 'hot',        // root/dbPath/timezone/busyTimeoutMs 在 OVERRIDES 里改判 restart
  embedding: 'restart',  // 模型与 RPC 客户端参数在构造期固化；batchSize 在 OVERRIDES 里改判 hot
  llm: 'restart',        // 【R-127】transport 与 provider/model 在 createKernel 期固化，改完重启才生效（UI 有提示）
  write: 'hot',
  retrieve: 'hot',       // 全部热生效：memIndex.enabled 改完下外审查询即用新值
  routing: 'hot',
  lifecycle: 'hot',
  trust: 'hot',
  security: 'hot',       // keyDir 在 OVERRIDES 里改判 restart
  dream: 'hot',          // 步开关下次 dream 触发时读新值就是新行为，异步天然热
  assemble: 'hot',
  transcript: 'hot',     // 【R-108】落盘与检索每次现读：enabled=false 立即停止追加与召回
  inner: 'hot',          // 【R-139】内心活动流水：同 transcript 的热语义
  emotion: 'hot',        // 【R-142】开关只控注入：改完下外审组装即用新值，采集不受影响
  diary: 'hot',          // 【R-139】日记：enabled 与摘录上限每次生成都现读
  privacy: 'hot',        // 【R-112/R-117】可见性判定在每次检索时读，改完下外审即生效
  domainAllowlist: 'hot',
};

/** 显式例外。**前缀匹配**：`retrieve.memIndex` 覆盖其全部子键。 */
export const OVERRIDES = {
  // —— restart：构造期固化的东西，改了也不生效 / 生效即炸 ——
  'embedding.model': 'restart',          // model_meta 锁了模型 id，换模型 = 全量重嵌
  'embedding.dim': 'restart',            // dimMismatch 守卫会拒绝服务，不如在补丁层就拒
  'embedding.rpcTimeoutMs': 'restart',   // RPC 客户端构造期固化
  'embedding.warmupTimeoutMs': 'restart',
  'embedding.prewarmOnStart': 'restart', // 只在 init 时刻有意义
  'embedding.batchSize': 'hot',          // 例外：批大小每次取数时现读
  'storage.root': 'restart',
  'storage.dbPath': 'restart',
  'storage.timezone': 'restart',         // 时区影响日切，改完当天的 quota 语义会变，重启最稳
  'storage.busyTimeoutMs': 'restart',    // pragma 在 openDatabase 时设置
  'security.keyDir': 'restart',          // 密钥在 security 构造期加载

  // —— structural：改完必须 rebuild ——
  'embedding.backend': 'structural',       // 【检索增强】换嵌入后端 = 向量语义全变，须 rebuild（分区默认 embedding:'restart' 会拒）
};

/**
 * 单键分类。前缀匹配 OVERRIDES → 分区默认 → undefined（未注册分区，测试会红）。
 * @param {string} path 点分路径，如 'write.dailyQuotaPerDomain'、'retrieve.memIndex.maxVectors'
 * @returns {'hot'|'structural'|'restart'|undefined}
 */
export function classifyConfigKey(path) {
  for (const [prefix, cls] of Object.entries(OVERRIDES)) {
    if (path === prefix || path.startsWith(`${prefix}.`)) return cls;
  }
  const dot = path.indexOf('.');
  if (dot < 0) return SECTION_CLASS[path];   // 裸分区（如 domainAllowlist 本身作为单元）
  return SECTION_CLASS[path.slice(0, dot)];
}

/**
 * 把宿主 watch 送来的补丁按类应用进活引用 cfg。
 * @returns {{ applied: string[], structural: string[], rejected: Array<{path, reason}> }}
 *   applied/structural 的值**已经写进 cfg**（structural 由调用方负责置 mismatch / 提示 rebuild）；
 *   rejected 不动 cfg。
 */
export function applyConfigPatch(cfg, patch, { defaults } = {}) {
  const out = { applied: [], structural: [], rejected: [] };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return out;
  walk(defaults ?? cfg, patch, '', cfg, defaults ?? cfg);
  return out;

  function walk(defNode, patchNode, prefix, liveParent) {
    // 该路径是否有子键级例外 → 必须下钻，否则 per-key 分类失效
    const mustDescend = Object.keys(OVERRIDES).some((p) => p.startsWith(`${prefix}.`));
    for (const [key, value] of Object.entries(patchNode)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const defHas = defNode != null && typeof defNode === 'object' && key in defNode;
      const patchObj = typeof value === 'object' && value !== null && !Array.isArray(value);
      const defIsBranch = defHas && typeof defNode[key] === 'object' && defNode[key] !== null
        && Object.values(defNode[key]).some((v) => typeof v === 'object' && v !== null);

      if (defHas && patchObj && (defIsBranch || mustDescend || hasChildOverride(path))) {
        walk(defNode[key], value, path, liveParent?.[key]);
        continue;
      }

      // —— 补丁单元 ——
      const cls = classifyConfigKey(path);
      if (!cls) { out.rejected.push({ path, reason: 'unclassified' }); continue; }
      if (cls === 'restart') { out.rejected.push({ path, reason: 'restart-required' }); continue; }
      if (!defHas) {
        // DEFAULTS 没有此键：只有"父级是扁平 map"（合法扩域，如配额加新域）才放行
        if (!isFlatMap(defNode)) {
          out.rejected.push({ path, reason: 'ghost-key (DEFAULTS 中不存在；用户 map 请整块发送)' });
          continue;
        }
      }
      const live = liveParent ?? getLive(cfg, prefix);
      if (patchObj) {
        const base = defHas && defNode[key] && typeof defNode[key] === 'object' ? defNode[key] : {};
        live[key] = Object.assign({}, base, value);   // 浅合并：partial 补丁不丢同组键
      } else {
        live[key] = value;
      }
      (cls === 'structural' ? out.structural : out.applied).push(path);
    }
  }
}

const hasChildOverride = (path) => Object.keys(OVERRIDES).some((p) => p.startsWith(`${path}.`));
const isFlatMap = (node) => node != null && typeof node === 'object'
  && Object.values(node).every((v) => typeof v !== 'object' || v === null);

function getLive(cfg, prefix) {
  if (!prefix) return cfg;
  let node = cfg;
  for (const part of prefix.split('.')) {
    if (typeof node[part] !== 'object' || node[part] === null) node[part] = {};
    node = node[part];
  }
  return node;
}
