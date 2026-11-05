/**
 * §13.2 中文分词（bigram）+ §15.1 token 估算。
 *
 * 为什么必须在应用层切 bigram [R-3]：
 *   `tokenize='unicode61'` 对无空格中文会把整句当一个 token，`MATCH '中文'` 永不命中。
 * 为什么不用 `/[\u4e00-\u9fff]{2}/g` [R-35]：
 *   它是非重叠贪婪匹配，"用中文回复" 只切出 ["用中","文回"]，丢掉"中文""回复"。
 */
export function tokenizeBigram(s) {
  // 【与 §13.2 的一处故意偏差】文档那段先 `.replace(/\s+/g,'')`，对中文无影响，
  // 但会让 "Hi there" 变成单个 token "hithere" —— 英文查询只要词序/词数不同就永不命中。
  // 这里保留空格作为分段边界（正则本身已经把 CJK 连续段与拉丁词分开切），
  // 中文无空格场景的行为与文档完全一致。
  const norm = String(s ?? '').toLowerCase();
  const out = [];
  for (const seg of norm.match(/[\u4e00-\u9fff]+|[a-z0-9_]+/g) ?? []) {
    if (/[\u4e00-\u9fff]/.test(seg)) {
      if (seg.length === 1) out.push(seg);
      for (let i = 0; i < seg.length - 1; i++) out.push(seg.slice(i, i + 2));
    } else {
      out.push(seg);
    }
  }
  return out.join(' ');
}

/**
 * 保守估算：CJK 1 字 = 1 token（上界），拉丁 3 字符 = 1 token。
 * 宁可高估（多丢一条）也不要低估（撑爆 system prompt 固定 section）。
 */
export function estimateTokens(s) {
  let cjk = 0;
  let other = 0;
  for (const ch of String(s ?? '')) {
    if (/[\u3000-\u9fff\uff00-\uffef]/.test(ch)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 3);
}
