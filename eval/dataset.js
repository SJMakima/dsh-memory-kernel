/**
 * 合成标注评测集（P2）。
 *
 * 文档要求 50–100 条**真实**查询做校准；真实数据攒够之前，这里用**构造相关**的合成集
 * 把 harness 与指标先立起来：每条 query 的相关条目由构造保证（query 里的词就是从
 * 条目文本里来的），所以"检索不到 = 系统的问题"而不是"标注的问题"。
 *
 * 真实数据的格式（--dataset 加载，每行一个 JSON）：
 *   {"query": "...", "intent": "factual|explanatory|relational", "relevant": {"<entryId>": 3}}
 * grade：3 = 直接命中，1 = 相关，0 = 无关（省略即 0）。
 */

export const CORPUS = [
  // ── 偏好（fact）──
  { key: '咖啡', text: '用户喜欢喝咖啡，每天两杯', type: 'fact', tags: ['偏好'], triple: ['用户', '偏好', '咖啡'] },
  { key: '茶', text: '用户也喜欢喝茶，下午常泡绿茶', type: 'fact', tags: ['偏好'], triple: ['用户', '偏好', '绿茶'] },
  { key: '辣', text: '用户爱吃辣，无辣不欢', type: 'fact', tags: ['偏好'], triple: ['用户', '偏好', '辣'] },
  { key: '科幻', text: '用户喜欢看科幻电影', type: 'fact', tags: ['偏好'], triple: ['用户', '偏好', '科幻电影'] },
  { key: '爵士', text: '用户常听爵士乐', type: 'fact', tags: ['偏好'], triple: ['用户', '偏好', '爵士乐'] },
  { key: '跑步', text: '用户每周跑步三次', type: 'fact', tags: ['习惯'], triple: ['用户', '习惯', '跑步'] },
  { key: '猫', text: '用户养了一只猫，叫煤球', type: 'fact', tags: ['生活'], triple: ['用户', '宠物', '煤球'] },
  { key: '杭州', text: '用户住在杭州', type: 'fact', tags: ['生活'], triple: ['用户', '居住地', '杭州'] },
  // ── 边界（boundary）──
  { key: '中文', text: '用户要求一律用中文回复', type: 'boundary', tags: ['边界'], triple: ['用户', '边界', '中文回复'] },
  { key: '结论', text: '用户要求先给结论再补理由', type: 'boundary', tags: ['边界'], triple: ['用户', '边界', '结论先行'] },
  { key: '深夜', text: '用户要求深夜不要被打扰', type: 'boundary', tags: ['边界'], triple: ['用户', '边界', '免打扰'] },
  { key: '表情', text: '用户不喜欢回复里带表情包', type: 'boundary', tags: ['边界'], triple: ['用户', '边界', '无表情包'] },
  // ── 技能（skill）──
  { key: '评测', text: '用户会做检索系统的评测设计', type: 'skill', tags: ['技能'], triple: ['用户', '技能', '检索评测'] },
  { key: 'SQL', text: '用户会写 SQL 和调索引', type: 'skill', tags: ['技能'], triple: ['用户', '技能', 'SQL'] },
  { key: '剪辑', text: '用户会视频剪辑', type: 'skill', tags: ['技能'], triple: ['用户', '技能', '视频剪辑'] },
  // ── 模式（pattern）──
  { key: '晚睡', text: '用户习惯晚睡，凌晨还在活跃', type: 'pattern', tags: ['作息'], triple: ['用户', '作息', '晚睡'] },
  { key: '周报', text: '用户每周五写周报', type: 'pattern', tags: ['工作'], triple: ['用户', '工作', '周报'] },
  { key: '站会', text: '用户的团队每周一开站会', type: 'pattern', tags: ['工作'], triple: ['团队', '例会', '站会'] },
  // ── 事实 ──
  { key: 'windows', text: '用户的电脑是 Windows 系统', type: 'fact', tags: ['设备'], triple: ['用户', '设备', 'Windows'] },
  { key: '项目', text: '用户的项目代号叫灯塔', type: 'fact', tags: ['工作'], triple: ['项目', '代号', '灯塔'] },
];

export const QUERIES = [
  // factual（直接问值）
  { q: '用户平时喝什么咖啡', intent: 'factual', rel: ['咖啡'] },
  { q: '用户喝不喝茶', intent: 'factual', rel: ['茶'] },
  { q: '用户爱吃辣吗', intent: 'factual', rel: ['辣'] },
  { q: '用户喜欢什么电影', intent: 'factual', rel: ['科幻'] },
  { q: '用户听什么音乐', intent: 'factual', rel: ['爵士'] },
  { q: '用户每周运动几次', intent: 'factual', rel: ['跑步'] },
  { q: '用户养的宠物叫什么', intent: 'factual', rel: ['猫'] },
  { q: '用户住在哪个城市', intent: 'factual', rel: ['杭州'] },
  { q: '用户的电脑是什么系统', intent: 'factual', rel: ['windows'] },
  { q: '项目代号是什么', intent: 'factual', rel: ['项目'] },
  // explanatory（解释/怎么/如何/讲讲）
  { q: '怎么给用户推荐电影', intent: 'explanatory', rel: ['科幻'] },
  { q: '如何给用户安排音乐歌单', intent: 'explanatory', rel: ['爵士'] },
  { q: '讲讲用户的运动习惯', intent: 'explanatory', rel: ['跑步'] },
  { q: '给用户挑礼物有什么思路', intent: 'explanatory', rel: ['咖啡', '茶'] },
  { q: '怎么写周报能符合用户的习惯', intent: 'explanatory', rel: ['周报'] },
  { q: '介绍一下用户的技能', intent: 'explanatory', rel: ['评测', 'SQL', '剪辑'] },
  { q: '给用户做视频用什么工具好', intent: 'explanatory', rel: ['剪辑'] },
  { q: '怎么回复用户才能符合要求', intent: 'explanatory', rel: ['中文', '结论'] },
  // relational（关系/和/因为/上次）
  { q: '用户和宠物之间什么关系', intent: 'relational', rel: ['猫'] },
  { q: '用户的作息和运动习惯有什么关系', intent: 'relational', rel: ['晚睡', '跑步'] },
  { q: '因为用户说过偏好，回复时要注意什么', intent: 'relational', rel: ['中文', '结论', '表情'] },
  { q: '用户的技能里哪些和数据处理相关', intent: 'relational', rel: ['SQL', '评测'] },
  { q: '用户跟团队的例会是什么时候', intent: 'relational', rel: ['站会'] },
  { q: '用户的居住地和习惯有联系吗', intent: 'relational', rel: ['杭州'] },
  { q: '上次说的边界要求都有哪些', intent: 'relational', rel: ['中文', '结论', '深夜', '表情'] },
];

/** 标注好的 detectVerified 评测集：正例要能触发，负例一个都不该触发。 */
export const VERIFIED_SET = {
  positives: [
    '对，就是这个', '是的，没错', '你说的对，就是这条', '对，就是上次说的那个',
    '没错，记得这条', '是的没错，就是这个', '对，上面那个是正确的', '嗯，就是这个，没错',
    '这条记忆是对的', '你说的这条就是我要的', '对，确实是这个', '是的，就是它，没错',
    '没错，上面那个正确', '对，记得有这条', '你说的没错，就是这条记忆', '是的，刚才那个对了',
    '对，就是这条', '是的，你记得对', '没错就是它', '对，是正确的',
  ],
  negatives: [
    // 泛化应答（绝不能当确认）
    '好的', '嗯嗯', '知道了', '收到', '谢谢', '明白', '好的谢谢', '嗯，然后呢',
    // 否定（裸"对/没错"的反向用法）
    '这个不对', '你说的不对', '这条不对吧', '不是这个', '这个不是', '没错个头', '别对号入座',
    // 反问（带问号一律不算）
    '这个怎么用？', '你说的那个是什么意思？', '上面那个对吗？', '真的是这个吗？', '这条还记得吗？',
    // 泛指但无肯定词 / 肯定词但无指代
    '这个先放一边', '上次说的事就算了', '这个挺好玩的', '刚才那段挺长', '上面那个不错，还有别的吗',
    '今天天气不错', '我随便问问', '继续', '然后呢', '再说一次',
    // 长叙述（超长一律不算确认）
    '好的，那我们继续聊刚才说的那个项目的事情吧，我记得你之前提到了一些关于检索评测的内容，挺有意思的，可以展开讲讲',
    '对的，不过我想先问一下其他的事情，比如下次聚会的时间和地点，你能帮我看看日历上有没有空档吗',
    '这个说法听起来挺有道理的，不过我还是想再确认一下细节，毕竟上次讨论的时候有些地方没说清楚',
    '是的没错，但是另外还有一个问题想问你，就是关于数据导入的部分，格式上有没有什么限制需要注意的地方',
    // 无关闲聊
    '中午吃什么好呢', '最近有点累', '哈哈哈哈', '看看窗外', '这歌不错',
  ],
};

/** 真实数据集加载：JSONL，每行 {query, intent, relevant:{entryId: grade}}。 */
export async function loadDataset(file) {
  const { readFile } = await import('node:fs/promises');
  const lines = (await readFile(file, 'utf8')).split('\n').filter((l) => l.trim());
  return lines.map((l, i) => {
    const o = JSON.parse(l);
    if (!o.query || typeof o.relevant !== 'object') {
      throw new Error(`数据集第 ${i + 1} 行缺 query 或 relevant`);
    }
    return o;
  });
}
