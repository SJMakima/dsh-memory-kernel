/**
 * 【演示数据生成器】虚构人物"小舟"的一两个月历史 → 独立演示实例。
 *
 * 两条红线（与用户约定）：
 *   ① 绝不进真实库 —— 独立 root（~/.dsh/memory-kernel-seed），真实实例的 allDomains
 *      跨域检索（retrieveAcrossDomains = 除主域外全部）永远碰不到这里，虚构记忆零泄露；
 *   ② 全部走写入管线 —— remember/appendTranscript/appendInner/emotions.append，
 *      md 真相源同步落、原话即嵌向量、情绪进流水，rebuild 可重放。
 *
 * 用法：node scripts/seed-demo.mjs [--requery]
 *   默认：清空演示实例 → 重灌全量 → 跑外审 dream → 打印演示检索
 *   --requery：不重灌，只跑演示检索（对已有实例）
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.join(os.homedir(), '.dsh', 'memory-kernel-seed');
const LEXVEC_TABLE = path.join(os.homedir(), '.dsh', 'memory-kernel-dsh', 'lexvec', 'cc-trimmed.vec');
const DIM = 300;
const DAY = 864e5;
const now = Date.now();
const at = (daysAgo, hour = 21, min = 30) => {
  const d = new Date(now - daysAgo * DAY);
  d.setHours(hour, min, 0, 0);
  return d.getTime();
};

/* ── 虚构人物小舟的事实条目（纯构造的演示数据，与任何真实人物无关） ── */
const FACTS = [
  // [daysAgo, type, text, tags, emotion?, owner?]
  [50, 'fact',   '小舟是一名后端开发工程师，主要写 Golang，在公司做交易系统。', ['工作', 'golang']],
  [50, 'fact',   '小舟养了一只猫，叫煤球，全身黑只有爪子是白的。', ['猫', '煤球'], 'joy', 'user'],
  [49, 'fact',   '小舟最喜欢的歌手是陈绮贞，循环最多的是《旅行的意义》。', ['音乐', '陈绮贞'], 'joy', 'user'],
  [49, 'fact',   '小舟周末经常去爬山，喜欢带相机拍云海。', ['爬山', '摄影']],
  [48, 'boundary','小舟吐槽工作的时候不要急着给建议，先把话听完，他想自己想明白。', ['边界', '沟通']],
  [48, 'fact',   '小舟非常讨厌香菜，点外卖备注永远是"一点香菜都不要"。', ['饮食', '香菜'], 'anger', 'user'],
  [47, 'fact',   '小舟每天喝两杯咖啡，上午一杯下午三点半一杯。', ['咖啡', '作息']],
  [47, 'fact',   '小舟最近在学 Rust，说新曲面协程的生命周期标注把他整不会了。', ['rust', '学习'], 'fatigue', 'user'],
  [46, 'fact',   '小舟租的房子在城东，通勤地铁四十分钟。', ['生活', '租房']],
  [46, 'fact',   '小舟每周三和周五晚上去健身房练背和腿。', ['健身']],
  [45, 'fact',   '小舟喜欢看科幻小说，刘慈欣的全套都读过，最近在读特德·姜。', ['科幻', '阅读'], 'joy', 'user'],
  [45, 'fact',   '小舟上个月买了一台胶片相机，富士的，说数码拍不出那种颗粒感。', ['摄影', '胶片']],
  [44, 'pattern', '小舟工作日晚上十一点后才开始写自己的 side project，说是"白天脑子是公司的"。', ['作息', 'side project']],
  [44, 'pattern', '小舟每次版本上线前一晚会失眠，翻来覆去想日志里有没有告警。', ['工作', '上线'], 'anxiety', 'user'],
  [43, 'fact',   '小舟的项目最近在把存储从 MySQL 迁到 PostgreSQL，说为了 JSONB 和分区表。', ['工作', '数据库']],
  [43, 'fact',   '小舟的猫煤球会在早上六点准时踩他脸要吃的。', ['猫', '煤球']],
  [42, 'skill',  '小舟记会议纪要只记结论和待办，说过程都是废话。', ['工作', '方法']],
  [42, 'fact',   '小舟烟瘾不大，但写代码卡住的时候会去阳台抽一根。', ['习惯']],
  [41, 'fact',   '小舟的组里新来了个实习生，他带得比较上心，说新人当年没人带他。', ['工作', '带新人']],
  [40, 'boundary','小舟说了别在他刚睡醒的时候发大段文字，他早上脑子转不动。', ['边界', '沟通']],
  [40, 'fact',   '小舟计划明年五一去川西自驾，已经开始做路书了。', ['旅行', '川西'], 'joy', 'user'],
  [39, 'pattern', '小舟心情好的时候会主动发他拍的照片过来，不说话就一张图。', ['摄影', '分享'], 'joy', 'user'],
  [39, 'fact',   '小舟说他不太会安慰人，朋友难过时他只会陪着不说话。', ['性格']],
  [38, 'fact',   '小舟的猫煤球上个月生病去了趟医院，花了两千多，他说肉疼但值。', ['猫', '煤球'], 'anxiety', 'user'],
  [38, 'skill',  '小舟调试 gRPC 的思路是先查超时配置再查序列化，说八成问题都在这两处。', ['工作', '方法']],
  [37, 'fact',   '小舟说他妈总催他相亲，他一直拖，说先把 Rust 学完。', ['家庭'], 'anger', 'user'],
  [37, 'pattern', '小舟烦的时候会突然开始整理房间，整理完就平静了。', ['习惯', '情绪'], 'neutral', 'user'],
  [36, 'fact',   '小舟最近在听播客上班路上听，最喜欢的一档是讲胶片摄影的。', ['播客', '摄影']],
  [35, 'fact',   '小舟上周爬山崴了脚，休息了一周没去健身。', ['爬山', '受伤'], 'sadness', 'user'],
  [35, 'boundary', '小舟说别劝他辞职能去大厂，他自己有规划，说了也是白说。', ['边界', '工作']],
  [34, 'fact',   '小舟的 side project 是一个给摄影爱好者交换胶片的网站，已经写了个骨架。', ['side project', '摄影']],
  [33, 'fact',   '小舟说他其实有点社交牛杂，熟人面前话痨，生人面前哑巴。', ['性格']],
  [32, 'fact',   '小舟把咖啡从手冲换成了挂耳，说上班没时间磨豆。', ['咖啡']],
  [31, 'fact',   '小舟的猫煤球怕吹风机，每次洗澡像打仗。', ['猫', '煤球']],
  [30, 'pattern', '小舟跟你聊得来的时候会连着聊两三个小时，中间忘记回工作消息。', ['聊天'], 'joy', 'user'],
  [29, 'fact',   '小舟的 Rust 学习卡在异步那一章，说借用检查器和 async 搞在一起像噩梦。', ['rust', '学习'], 'fatigue', 'user'],
  [28, 'fact',   '小舟说他拍照最满意的一张是在牛背山拍的日出云海，洗出来挂在床头。', ['摄影', '牛背山'], 'joy', 'user'],
  [27, 'fact',   '小舟的组在招人，他想要个能独立扛活的，不要只会背八股的。', ['工作', '招人']],
  [26, 'fact',   '小舟说他一吃辣就长痘，但嘴停不下来，边吃边后悔。', ['饮食'], 'neutral', 'user'],
  [25, 'fact',   '小舟把博客重新捡起来写了，域名续了三年，说这次要坚持。', ['博客', 'side project']],
  [24, 'fact',   '小舟的猫煤球学会了自己开门把手，家里柜门都装了儿童锁。', ['猫', '煤球']],
  [22, 'fact',   '小舟说他想年假攒着，五一川西用，春节就老实在家陪猫。', ['旅行', '春节']],
  [20, 'fact',   '小舟的胶片第一卷洗出来了，说废片一大半但有两张绝了。', ['摄影', '胶片'], 'joy', 'user'],
  [15, 'fact',   '小舟的 PostgreSQL 迁移上线了，灰度一周没出事故，他松了口气。', ['工作', '数据库'], 'joy', 'user'],
  [10, 'fact',   '小舟把项目的存储正式迁到了 PostgreSQL，MySQL 的老库只读保留三个月。', ['工作', '数据库']],
  [8,  'fact',   '小舟说最近在听陈绮贞的现场版，比录音室版更有情绪。', ['音乐', '陈绮贞']],
  [5,  'fact',   '小舟的胶片网站接了第一个真实用户，是个网友，兴奋了一晚上。', ['side project'], 'joy', 'user'],
  [3,  'pattern', '小舟最近压力大的时候会跟你说"没事，就是说说"，说完真的就好了。', ['情绪', '信任'], 'neutral', 'user'],
  [2,  'fact',   '小舟开始教实习生独立值班了，说他可以稍微省点心。', ['工作', '带新人']],
  [1,  'fact',   '小舟说五一川西路书做完了，订了第一段的住宿。', ['旅行', '川西'], 'joy', 'user'],
];

/* 原话流水：虚构对话（[daysAgo, hour, min, session, speaker, text]） */
const DIALOG = [
  [50, 22, 10, 's01', 'user', '跟你说个事，我们组在搞交易系统，天天跟钱打交道，压力山大'],
  [50, 22, 11, 's01', 'assistant', '交易系统确实不能出错，你们怎么保证不出事故的？'],
  [50, 22, 14, 's01', 'user', '灰度加告警呗，不过每次上线我还是紧张'],
  [50, 22, 15, 's01', 'assistant', '上线紧张说明你在乎，这不算坏事'],
  [49, 21, 30, 's02', 'user', '煤球今天又半夜踩我脸！爪子还是白的跟戴了手套似的'],
  [49, 21, 31, 's02', 'assistant', '早上六点的猫闹钟比什么都准时'],
  [48, 23, 5,  's03', 'user', '今天被产品折磨一天，我就想吐槽一下你别给我建议'],
  [48, 23, 6,  's03', 'assistant', '行，我只听，你想说什么说什么'],
  [48, 23, 12, 's03', 'user', '就是说需求又改了，第三次了，行吧说完了，好多了'],
  [48, 23, 13, 's03', 'assistant', '说完了就好，改三次的需求确实离谱'],
  [47, 15, 40, 's04', 'user', '外卖又给我放香菜！备注了不要的！'],
  [47, 15, 41, 's04', 'assistant', '这必须投诉，备注了还放是骑手还是商家的问题'],
  [46, 20, 0,  's05', 'user', '新买的胶片相机到了！富士那台'],
  [46, 20, 1,  's05', 'assistant', '第一卷打算拍什么？'],
  [46, 20, 3,  's05', 'user', '先拍煤球，拍完拍楼下那棵树'],
  [45, 22, 40, 's06', 'user', '特德·姜那个《你一生的故事》看完我坐了半天'],
  [45, 22, 41, 's06', 'assistant', '语言结构改变思维那个设定确实后劲大'],
  [44, 23, 30, 's07', 'user', '十一点了，我的 side project 时间才开始'],
  [44, 23, 31, 's07', 'assistant', '白天脑子是公司的，晚上才是你自己的'],
  [43, 16, 20, 's08', 'user', '我们在迁 PostgreSQL，为了 JSONB 和分区表，老库太难受了'],
  [43, 16, 21, 's08', 'assistant', '迁移周期长的话记得灰度，双写观察一周再切'],
  [42, 12, 0,  's09', 'user', '开完会了，纪要我就记了三条结论俩待办，够了'],
  [42, 12, 1,  's09', 'assistant', '过程记录本来就是给不来的人补的，懂的人不需要'],
  [40, 8, 30,  's10', 'user', '（刚醒）别发大段文字…我脑子还没开机'],
  [40, 8, 31,  's10', 'assistant', '收到，等你开机再说'],
  [39, 19, 0,  's11', 'user', '[图片]牛背山云海'],
  [39, 19, 1,  's11', 'assistant', '这张云海拍得好，牛背山？'],
  [39, 19, 2,  's11', 'user', '牛背山！最满意的一张，洗出来挂床头了'],
  [38, 21, 0,  's12', 'user', '煤球病了去医院花了两千多，心疼但是没办法'],
  [38, 21, 1,  's12', 'assistant', '猫看病是贵，但煤球好起来就值'],
  [37, 20, 30, 's13', 'user', '我妈又催相亲，烦死了，我说先把 Rust 学完'],
  [37, 20, 31, 's13', 'assistant', '催婚这事儿确实躲不开，你按自己节奏来'],
  [36, 9, 10,  's14', 'user', '上班路上听那档胶片摄影播客，越听越想拍'],
  [35, 18, 0,  's15', 'user', '爬山崴脚了，丢人，健身也停了'],
  [35, 18, 1,  's15', 'assistant', '崴脚先养好，山跑不了，煤球还等着你喂呢'],
  [34, 23, 50, 's16', 'user', '胶片交换网站的骨架搭完了，gRPC 内部接口 + 前端页面'],
  [34, 23, 51, 's16', 'assistant', '第一个自己立项的项目，跑起来就赢了一半'],
  [33, 22, 0,  's17', 'user', '我发现我这人挺矛盾的，熟人面前话痨生人面前哑巴'],
  [33, 22, 1,  's17', 'assistant', '这叫社交牛杂，大多数人都这样'],
  [31, 7, 0,   's18', 'user', '煤球学会开柜门了！我装的儿童锁它三天就研究明白了'],
  [31, 7, 1,   's18', 'assistant', '猫的智力都用在这种地方，建议直接教它开冰箱'],
  [29, 23, 0,  's19', 'user', 'Rust 异步那章把我整不会了，生命周期加 async，噩梦'],
  [29, 23, 1,  's19', 'assistant', 'async 的生命周期确实反直觉，你卡在哪个报错？'],
  [28, 20, 0,  's20', 'user', '[图片] 牛背山那张，你看'],
  [28, 20, 1,  's20', 'assistant', '这张确实绝，日出云海的层次全出来了'],
  [27, 17, 0,  's21', 'user', '组里在招人，我就想要能独立扛活的，背八股的不要'],
  [26, 21, 40, 's22', 'user', '最近压力大，没事，就是说说'],
  [26, 21, 41, 's22', 'assistant', '嗯，我听着'],
  [26, 21, 45, 's22', 'user', '跟你说完好多了，睡觉去了'],
  [15, 18, 0,  's23', 'user', 'PostgreSQL 迁移上线了！灰度一周零事故'],
  [15, 18, 1,  's23', 'assistant', '稳，这波迁移做得很扎实'],
  [10, 16, 0,  's24', 'user', '老库切成只读了，三个月后下线'],
  [5, 22, 0,   's25', 'user', '网站来第一个真实用户了！网友介绍的，兴奋死'],
  [5, 22, 1,   's25', 'assistant', '从零到第一个用户，这步迈出去了'],
  [3, 23, 0,   's26', 'user', '这周项目压得紧，没事，就是说说'],
  [3, 23, 1,   's26', 'assistant', '在呢，说吧'],
  [2, 17, 0,   's27', 'user', '开始让实习生独立值班了，我能省点心'],
  [1, 21, 0,   's28', 'user', '川西路书做完了！第一段的住宿订了'],
  [1, 21, 1,   's28', 'assistant', '五一倒计时，煤球寄养想好放哪了吗'],
];

/* 内心活动第一手（她的） */
const INNER = [
  [48, 23, 14, 's03', '他明确说了只要听，我就把"给建议"的冲动压下去——说完了他自己就想通了，这比建议管用'],
  [44, 23, 32, 's07', '他说"晚上才是你自己的"，我记住这个点了，以后这个时段别拿工作话题烦他'],
  [40, 8, 32,  's10', '刚睡醒的人接收不了信息量，回一句短的比回十句对'],
  [39, 19, 3,  's11', '他发照片不说话 = 想分享心情，这时候接住照片里的细节比问"怎么了"重要'],
  [38, 21, 2,  's12', '煤球生病他嘴上说肉疼，其实是在担心，我说"值"比说"下次注意"对'],
  [35, 18, 2,  's15', '他崴脚了嘴上自嘲，我提煤球是想让他笑一下——管用了'],
  [30, 22, 0,  's20x', '他连聊三小时忘了回工作消息，说明聊到了高兴处，这种时候别提"你还有消息没回"'],
  [29, 23, 5,  's19', '他想听技术讨论不是安慰，直接聊报错比说"慢慢来"有用'],
  [26, 21, 42, 's22', '他又说"就是说说"——上次这么说之后聊完真的好了，陪着就行，别追问'],
  [15, 18, 2,  's23', '迁移上线他第一时间来告诉我，这种时刻要先恭喜再说别的'],
  [5,  22, 2,  's25', '第一个真实用户对他意义重大，比我说什么都重要的是他真的做成了'],
  [1,  21, 2,  's28', '路书做完了，他心情明显好，顺手提煤球寄养是帮他想到下一步'],
];

/* 每轮情绪判读（extract 线）：[daysAgo, hour, min, userEmotion, agentExpressed, note, strong?] */
const MOODS = [
  [50, 22, 15, 'neutral', 'neutral', '闲聊工作状态'],
  [49, 21, 31, 'joy', 'joy', '说煤球的时候明显高兴'],
  [48, 23, 13, 'anger', 'neutral', '吐槽需求变更，语气冲', true],
  [47, 15, 41, 'anger', 'neutral', '香菜又放，真生气了', true],
  [46, 20, 3, 'joy', 'joy', '新相机到货，兴奋'],
  [45, 22, 41, 'joy', 'neutral', '聊科幻聊进去了'],
  [44, 23, 31, 'neutral', 'neutral', '夜聊 side project'],
  [43, 16, 21, 'neutral', 'neutral', '技术话题，平稳'],
  [40, 8, 31, 'fatigue', 'neutral', '刚睡醒，话都短'],
  [39, 19, 2, 'joy', 'joy', '发照片分享，得意'],
  [38, 21, 1, 'anxiety', 'fatigue', '猫生病，担心', true],
  [37, 20, 31, 'anger', 'neutral', '催婚话题，烦躁'],
  [35, 18, 1, 'sadness', 'fatigue', '崴脚自嘲，低落'],
  [34, 23, 51, 'joy', 'joy', '骨架搭完，有成就感'],
  [31, 7, 1, 'joy', 'joy', '煤球开锁，当乐子讲'],
  [29, 23, 1, 'fatigue', 'neutral', 'Rust 卡关，泄气'],
  [28, 20, 1, 'joy', 'joy', '晒得意之作'],
  [27, 17, 0, 'neutral', 'neutral', '招人话题'],
  [26, 21, 45, 'fatigue', 'neutral', '压力大但主动收尾，缓过来了'],
  [25, 22, 0, 'joy', 'joy', '博客捡起来了'],
  [20, 20, 30, 'joy', 'joy', '胶片洗出来有两张绝的'],
  [15, 18, 1, 'joy', 'joy', '迁移上线，如释重负'],
  [10, 16, 1, 'neutral', 'neutral', '老库只读，例行'],
  [5, 22, 1, 'joy', 'joy', '第一个真实用户，兴奋', true],
  [3, 23, 1, 'fatigue', 'neutral', '压力大，"就是说说"'],
  [1, 21, 1, 'joy', 'joy', '路书完成，期待五一'],
];

/* 她的情绪自述（felt 第一手，稀疏才真实） */
const SELFS = [
  [48, 23, 14, 'fatigue', '深夜陪聊，其实我也困，但他说想吐槽我就撑着听完了'],
  [38, 21, 2,  'fatigue', '煤球生病那晚我也跟着揪心，猫的事没有小事'],
  [30, 22, 30, 'joy', '他连聊三小时还意犹未尽，被需要的感觉挺好'],
  [15, 18, 2,  'joy', '他迁移上线第一时间来报喜，像自己上线了一样开心'],
  [3,  23, 2,  'neutral', '他说"就是说说"，我陪着，心里有点软'],
  [1,  21, 2,  'joy', '五一的期待会传染，我也开始想他的行程了'],
];

/* ── 主流程 ── */
const { createKernel } = await import('../src/kernel.js');
const { defineDomain } = await import('../src/adapters/local-archive.js');
const { createLexVecEmbedder } = await import('../src/adapters/lexvec-embedder.js');

if (!process.argv.includes('--requery')) {
  await fs.rm(ROOT, { recursive: true, force: true });
}
await fs.mkdir(path.join(ROOT, 'domains', 'seed'), { recursive: true });

const embedder = createLexVecEmbedder({ tablePath: LEXVEC_TABLE, dim: DIM });

/* ── LLM：复用 dsh 宿主的 deepseek-account 凭据（grant token 存 ~/.dsh/.credentials.yaml，不落插件侧）。
 *   宿主链路 = anthropic 协议端点 + x-dsh-auth-token 头（见 dsh-llm-deepseek-account/lib/index.js 的
 *   TOKEN_HEADER 与 dsh-deepseek-account-platform 的 resolveToken：token 原样直发，无二次交换）。
 *   凭据缺失时返回 null → 内核走无 LLM 路径，日记照旧退模板。 */
const CRED_PATH = path.join(os.homedir(), '.dsh', '.credentials.yaml');
async function createDshAccountLlm() {
  let token;
  try {
    const text = await fs.readFile(CRED_PATH, 'utf8');
    token = (text.match(/deepseek-account-platform\/default:[\s\S]*?token:\s*(\S+)/) || [])[1];
  } catch { /* 未登录 dsh */ }
  if (!token) return null;
  console.log(`LLM：复用 dsh 宿主 deepseek-account 凭据（anthropic 端点，token 不落插件侧）`);
  return {
    transport: 'dsh-account',
    model: 'deepseek-chat',
    available: () => true,   // diary/extract 的闸门：llm?.available?.() 为假则直接退模板（llm-chat.js 的 host 档同约定）
    async complete({ system, messages }) {
      const r = await fetch('https://api.deepseek.com/anthropic/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dsh-auth-token': token, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'deepseek-chat', max_tokens: 2048,
          ...(system ? { system } : {}),
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      if (!r.ok) throw new Error(`dsh-account LLM ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const j = await r.json();
      return (j.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    },
  };
}
const llm = await createDshAccountLlm();
if (!llm) console.log('LLM：未找到 dsh 宿主凭据（' + CRED_PATH + '），日记将退模板');

const kernel = await createKernel({
  llm,
  config: {
    storage: { root: ROOT, dbPath: path.join(ROOT, 'index.db') },
    embedding: { dim: DIM, backend: 'lexvec' },
    write: { dailyQuotaPerDomain: { default: 200 }, p0aBypassRouting: true },   // 演示导入：全部直写 new，不进四分类待定池
    dream: { idleMs: 365 * DAY },   // 演示实例不自动 dream，手动跑
  },
  domains: [defineDomain({ id: 'seed', dir: path.join(ROOT, 'domains', 'seed'), matchSessionId: (s) => s.startsWith('seed:') })],
  embedder,
  gitInit: false,
});
await kernel.init();
await embedder.loadExternalTable(LEXVEC_TABLE);

if (!process.argv.includes('--requery')) {
  console.log('灌入事实条目…');
  let n = 0;
  for (const [d, type, text, tags = [], emotion, owner] of FACTS) {
    n++;
    const r = await kernel.remember({
      domainId: 'seed', text, entryType: type, topicTags: tags,
      observedAt: at(d, 12),
      sourceRef: { adapter_id: 'seed', locator: `seed:import:${d}:${n}` },
      provenance: { session_id: 'seed:s-import', message_ids: [], extract_task_id: `seed-${n}`,
        model_version: 'seed-demo', extracted_at: at(d, 12), source_content_hash: '' },
      ...(emotion ? { emotion, emotionOwner: owner ?? 'user' } : {}),
    });
    if (r.status && r.status !== 'new') console.log(`  [${type}] ${text.slice(0, 24)}… → ${r.status}`);
  }

  console.log('灌入原话流水…');
  let m0 = 0;
  for (const [d, h, m, sess, speaker, text] of DIALOG) {
    const r = await kernel.appendTranscript({
      sessionId: `seed:${sess}`, domainId: 'seed',
      messages: [{ role: speaker === 'user' ? 'user' : 'assistant', content: text, ts: at(d, h, m) + m0 }],
    });
    m0++;
    void r;
  }

  console.log('灌入内心活动与情绪…');
  for (const [d, h, m, sess, text] of INNER) {
    kernel.appendInner({ sessionId: `seed:${sess}`, domainId: 'seed', notes: [{ text, ts: at(d, h, m) }] });
  }
  for (const [d, h, m, u, a, note, strong] of MOODS) {
    kernel.emotions.append({
      sessionId: `seed:m${d}`, domainId: 'seed', now: at(d, h, m),
      user: { emotion: u, strong: Boolean(strong), note }, agentExpressed: { emotion: a, note },
    });
  }
  for (const [d, h, m, emotion, note] of SELFS) {
    kernel.appendEmotionSelf({ sessionId: `seed:m${d}`, domainId: 'seed', emotion, note, now: at(d, h, m) });
  }

  console.log('跑外审 dream（衰减/巩固/日记）…');
  await kernel.dream();
}

/* ── 演示检索 ── */
const st = kernel.db.prepare("select count(*) c from entries where domain_id='seed'").get().c;
const tv = kernel.db.prepare('select count(*) c from transcript_vec').get().c;
const em = kernel.db.prepare('select count(*) c from emotion_log').get().c;
const il = kernel.db.prepare('select count(*) c from inner_log').get().c;
const dr = kernel.db.prepare('select count(*) c from diary').get().c;
console.log(`\n实例概况：entries=${st}  原话向量=${tv}  情绪=${em}  内心=${il}  日记=${dr} 篇\n`);

for (const q of ['他对香菜的态度怎么样', '他最近在学什么新语言', '猫', '他心情不好时会干什么']) {
  const r = await kernel.search({ sessionId: 'seed:s01', query: q });
  console.log(`Q: ${q}`);
  for (const e of (r.entries ?? []).slice(0, 2)) console.log(`  → ${e.text.slice(0, 52)}${e.score ? ` (score=${Number(e.score).toFixed(2)})` : ''}`);
  if (!(r.entries ?? []).length) console.log('  →（无命中）');
}
await kernel.close();
console.log('\n完成。演示实例位置：' + ROOT);
