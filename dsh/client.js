/**
 * dsh-memory-kernel 的浏览器半（设置页"记忆-测试"页签）。
 *
 * 手写的 ModuleLoader bundle（与宿主内置 lib/client.js 同构，免去构建管线）。
 * v2：状态面板（轮询宿主管理 API）+ Dream/Rebuild 按钮 + 配置控件（写内核热生效）
 * + 身份分叉查看（人工确认式对齐）。
 *
 * 数据面：GET/POST /api/plugins/dsh-memory-kernel/*（宿主半注册的 webServer 路由，
 * cookie 鉴权）。配置写入走 kernel.applyConfigPatch 热生效；跨重启持久化请用
 * "插件"自动配置页（schemastery 表单，写 DSH 设置文档）。
 */
window.__ModuleLoader__.load({
	id: "dsh-memory-kernel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const h = react.createElement;

		// 客户端 exports.inject = cordis 服务名（等这些服务就绪才激活），不是 npm 包名——
		// 包名属于 package.json 的 dsh.client.inject（模块到达顺序），两回事。写错会
		// 整个 web boot 卡在 "waiting for service:@//..."（服务表里永远没有那个键）。
		const inject = ["slots"];
		const API = "/api/plugins/dsh-memory-kernel";

		const TOOLS = [
			["memory_search", "检索长期记忆（关键词 + 三元组 + 最近三路融合）"],
			["memory_remember", "写入一条记忆（自动判重，同三元组只 reinforce）"],
			["memory_context", "按 entry_id 取回完整内容与来源"],
			["memory_dream", "手动巩固：激活结算 / 冷存归档 / 一致性修复"],
			["memory_maybe_dream", "按信号与空闲判断要不要巩固（适合挂定时）"],
			["memory_forget", "物理删除一条记忆（不可逆；仅限用户明确要求，需二次确认）"],
		];

		const css = {
			wrap: { display: "flex", flexDirection: "column", gap: "14px", padding: "4px 2px", overflow: "auto", height: "100%", boxSizing: "border-box" },
			block: { border: "1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.35))", borderRadius: "8px", padding: "12px 14px", display: "flex", flexDirection: "column", gap: "8px" },
			title: { fontSize: "13px", fontWeight: 600, margin: "0 0 2px" },
			muted: { fontSize: "12px", opacity: 0.65, margin: 0 },
			row: { display: "flex", gap: "12px", alignItems: "center", lineHeight: "24px" },
			code: { flex: "none", fontSize: "12px", opacity: 0.85, fontFamily: "monospace" },
			grow: { flex: 1, fontSize: "13px", opacity: 0.9 },
			input: { flex: "none", width: "90px", fontSize: "13px", padding: "2px 6px", boxSizing: "border-box" },
			select: { fontSize: "13px", padding: "2px 6px" },
			btn: { fontSize: "13px", padding: "4px 14px", cursor: "pointer", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.35))", background: "transparent", color: "inherit" },
			btnDanger: { borderColor: "rgba(200,80,80,.6)" },
			flex1: { flex: 1 },
			warn: { fontSize: "12px", color: "rgba(220,160,60,.95)", margin: 0 },
			ok: { fontSize: "12px", color: "rgba(120,200,120,.95)", margin: 0 },
		};

		/** 帮助函数：分区块（标题 + 内容）与单行展示 */
		const block = (title, children) => h("div", { style: css.block },
			h("p", { style: css.title }, title),
			...(Array.isArray(children) ? children : [children]));

		const row = (name, desc) => h("div", { style: css.row, key: name },
			h("code", { style: css.code }, name),
			h("span", { style: css.grow }, desc));

		/** 极简 hooks：状态 + 轮询 */
		function useStatus() {
			const [state, setState] = react.useState(null);
			const [error, setError] = react.useState(null);
			const [tick, setTick] = react.useState(0);
			react.useEffect(() => {
				let alive = true;
				const load = async () => {
					try {
						const r = await fetch(`${API}/status`, { headers: { accept: "application/json" } });
						if (!r.ok) throw new Error(`HTTP ${r.status}`);
						const j = await r.json();
						if (alive) { setState(j); setError(null); }
					} catch (e) { if (alive) setError(String(e.message ?? e)); }
				};
				load();
				const timer = setInterval(load, 8000);
				return () => { alive = false; clearInterval(timer); };
			}, [tick]);
			return { state, error, reload: () => setTick((t) => t + 1) };
		}

		function useAction() {
			const [busy, setBusy] = react.useState(false);
			const [msg, setMsg] = react.useState(null);
			const run = async (action, body, confirmText) => {
				if (confirmText && !window.confirm(confirmText)) return null;
				setBusy(true);
				try {
					const r = await fetch(`${API}/actions/${action}`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body ?? {}),
					});
					const j = await r.json().catch(() => ({}));
					if (!r.ok) { setMsg(`${action} 失败：${j.error ?? r.status}`); return null; }
					setMsg(`${action} 完成`);
					return j;
				} catch (e) {
					setMsg(`${action} 失败：${String(e.message ?? e)}`);
					return null;
				} finally { setBusy(false); }
			};
			return { busy, msg, setMsg, run };
		}

		const Toggle = ({ label, value, onChange, note }) => h("div", { style: css.row },
			h("span", { style: css.grow }, label),
			note ? h("span", { style: css.muted }, note) : null,
			h("button", { style: { ...css.btn, opacity: value ? 1 : 0.55 }, onClick: () => onChange(!value) },
				value ? "开" : "关"));

		const NumInput = ({ label, value, onChange, step, min, max, note }) => h("div", { style: css.row },
			h("span", { style: css.grow }, label),
			note ? h("span", { style: css.muted }, note) : null,
			h("input", {
				style: css.input, type: "number", step: step ?? 1, value,
				min: min ?? undefined, max: max ?? undefined,
				onChange: (e) => {
					let v = Number(e.target.value);
					if (!Number.isFinite(v)) return;
					if (min !== undefined && v < min) v = min;
					if (max !== undefined && v > max) v = max;
					onChange(v);
				},
			}));

		const Select = ({ label, value, options, onChange, note }) => h("div", { style: css.row },
			h("span", { style: css.grow }, label),
			note ? h("span", { style: css.muted }, note) : null,
			h("select", { style: css.select, value, onChange: (e) => onChange(e.target.value) },
				options.map((o) => h("option", { key: o, value: o }, o))));

		function StatusPanel({ state, error }) {
			if (error) return block("运行状态", [h("p", { style: css.warn }, `管理 API 不可达：${error}（宿主半未启动或正在重启）`)]);
			if (!state) return block("运行状态", [h("p", { style: css.muted }, "加载中…")]);
			const s = state.stats ?? {};
			// 【R-154】health 三态横幅：READY 绿 / DEGRADED 黄（列出原因）/ FAILED 红
			const hp = state.health ?? null;
			const healthBanner = hp ? h("p", {
				style: {
					margin: 0, fontSize: "12px", padding: "4px 8px", borderRadius: "6px",
					color: hp.state === "READY" ? "rgba(120,200,120,.95)" : hp.state === "DEGRADED" ? "rgba(220,160,60,.95)" : "rgba(230,90,90,.95)",
					border: `1px solid ${hp.state === "READY" ? "rgba(120,200,120,.35)" : hp.state === "DEGRADED" ? "rgba(220,160,60,.45)" : "rgba(230,90,90,.5)"}`,
				},
			}, hp.state === "READY"
				? "● READY —— 全部能力正常"
				: `${hp.state === "DEGRADED" ? "◐ DEGRADED" : "✕ FAILED"} —— ${(hp.reasons ?? []).join("；") || "（原因缺失）"}`) : null;
			return block("运行状态", [
				healthBanner,
				row("条目总数", String(s.entries ?? "-")),
				row("来源分布", (s.sources ?? []).length
					? (s.sources ?? []).map((x) => `${x.id} ×${x.count}`).join(" · ")
					: "-"),
				row("类型分布", (s.entryTypes ?? []).length
					? (s.entryTypes ?? []).map((x) => `${x.type} ×${x.count}`).join(" · ")
					: "-"),
				row("待向量化", String(s.vecPending ?? "-")),
				// 【R-108】原话流水：这些是"对话原文"，不进条目表、不占配额
				row("原话流水", `${s.transcript?.count ?? 0} 条`
					+ (s.transcript?.lastAt ? `（最近 ${new Date(s.transcript.lastAt).toLocaleString("zh-CN")}）` : "")
					+ (state.transcriptEnabled === false ? " · 已关闭" : "")),
				// 【R-139】内心活动与日记：日记篇数是"写下了多少天"的耐久记忆计数
				row("内心活动", `${s.inner?.total ?? 0} 条`
					+ ((s.inner?.enabled === false || s.innerEnabled === false) ? " · 已关闭" : "")),
				row("情绪日志", `${s.emotions?.total ?? 0} 条`
					+ ((s.emotions?.byOwner ?? []).length
						? `（${s.emotions.byOwner.map((b) => `${b.owner === "agent" ? "她" : "你"}·${b.source === "self" ? "自述" : "判读"} ${b.c}`).join("、")}）`
						: "") + (s.emotions?.enabled === false ? " · 注入已关" : "")),
				row("日记", `${s.diary?.total ?? 0} 篇`
					+ (s.diary?.latest?.date ? `（最近 ${s.diary.latest.date}，${s.diary.latest.generated_by === "llm" ? "AI 写" : "模板"}）` : "")),
				// 【R-95】情绪分布：只统计非 neutral（R-152 起键名为 emotionDistribution）
				row("情绪标注", (s.emotionDistribution ?? []).length
					? (s.emotionDistribution ?? []).map((x) => `${x.emotion} ×${x.count}`).join(" · ")
					: "暂无"),
				row("隐私档位", (state.privacy?.ownerIds ?? []).length
					? `owner 白名单 ${state.privacy.ownerIds.length} 个 · 跨会话 private ${state.privacy.crossSessionSensitivity ? "开" : "关"}`
					: `未配 owner 白名单（单人会话）· 跨会话 private ${state.privacy?.crossSessionSensitivity ? "开" : "关"}`),
				row("嵌入", state.embeddingReady ? "就绪" : "未就绪"),
				// 【R-136】向量策略：不放开关键，只把"为什么现在是 brute-force"讲清楚
				// 【R-137】向量索引实际形态。原来是"配置 → 实际"的策略对照，但那个档位已证伪
				// （ann 依赖的 rescore 索引上游不存在），留两行对照只会让人以为"配错了"。
				row("向量索引", state.vector
					? `${state.vector.mode ?? "-"}`
						+ (state.vector.residentVectors ? `　常驻 ${state.vector.residentVectors} 条 / ${(state.vector.bytes / 1048576).toFixed(1)} MB` : "")
					: "-"),
				row("向量索引诊断", state.vector?.reason ?? "-"),
				row("身份分叉", String((state.forks ?? []).length)),
			]);
		}

		function ConfigPanel({ state, onPatch, reload }) {
			const cfg = state?.config;
			const [dictDraft, setDictDraft] = react.useState(null);
			const [nn, setNn] = react.useState(null);   // 近邻候选 {q, neighbors:[{word,sim,inDict}]}
			const [diagInput, setDiagInput] = react.useState("");   // 输入独立——打字不碰结果
			// 【LLM 接入 R-127~R-130】草稿 + 服务端状态：表单全走草稿（受控反模式踩过——直绑回显会吞键击），
			// 点保存才 POST；transport 在插件启动期构造，保存后必须重启 web。
			const [llm, setLlm] = react.useState(null);        // {settings, host:{available,providers}, env}
			const [llmDraft, setLlmDraft] = react.useState(null);
			const [llmMsg, setLlmMsg] = react.useState(null);
			react.useEffect(() => {
				let alive = true;
				(async () => {
					try {
						const j = await (await fetch(`${API}/actions/llm-status`)).json();
						if (!alive) return;
						setLlm(j); setLlmDraft(j.settings ?? null);
					} catch (e) { if (alive) setLlm({ error: String(e.message ?? e) }); }
				})();
				return () => { alive = false; };
			}, []);
			const saveLlm = async () => {
				if (!llmDraft) return;
				setLlmMsg({ text: "保存中…" });
				try {
					const r = await fetch(`${API}/actions/llm-settings`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(llmDraft),
					});
					const j = await r.json().catch(() => ({}));
					if (!r.ok) { setLlmMsg({ error: j.error ?? r.status }); return; }
					setLlmMsg({ ok: true, text: "已保存。transport 在插件启动时构造——重启 dsh web 后生效。" });
				} catch (e) { setLlmMsg({ error: String(e.message ?? e) }); }
			};
			const llmSet = (patch) => setLlmDraft((cur) => ({ ...(cur ?? {}), ...patch }));
			// 连通性自测：带草稿去测（restart 类补丁不进活 cfg，测 cfg 等于测旧值）
			const testLlm = async () => {
				setLlmMsg({ text: "测试中…（最长 60s）" });
				try {
					const r = await fetch(`${API}/actions/llm-test`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ settings: llmDraft }),
					});
					const j = await r.json().catch(() => ({}));
					if (!r.ok) { setLlmMsg({ error: j.error ?? r.status }); return; }
					if (j.ok) setLlmMsg({ ok: true, text: `✓ 通了（${j.transport}${j.model ? " / " + j.model : ""}，${j.ms}ms）：${j.text || ""}` });
					else setLlmMsg({ error: j.error ?? "未知错误" });
				} catch (e) { setLlmMsg({ error: String(e.message ?? e) }); }
			};
			const [diag, setDiag] = react.useState(null);   // 诊断结果 {query, expansionWords, enabled, error?}
			const runDiag = async () => {
				const q = diagInput.trim();
				if (!q) return;
				try {
					const r = await fetch(`${API}/actions/synonym-diag`, {
						method: "POST", headers: { "content-type": "application/json" },
						body: JSON.stringify({ query: q }),
					});
					const j = await r.json().catch(() => ({}));
					if (!r.ok) { setDiag({ error: j.error ?? r.status }); return; }
					setDiag(j);
				} catch (e) { setDiag({ error: String(e.message ?? e) }); }
			};
			// 【R-138】动态域：输入 + 新增。成功后 reload 刷新域列表。
			const [domainInput, setDomainInput] = react.useState("");
			const [domainMsg, setDomainMsg] = react.useState(null);
			const addDomain = async () => {
				const id = domainInput.trim();
				if (!id) return;
				if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(id)) {
					setDomainMsg({ error: "命名不合规则：英文开头，只能含英文字母/数字/下划线/连字符，最长 32 字符" });
					return;
				}
				try {
					const r = await fetch(`${API}/actions/domain-add`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ id }),
					});
					const j = await r.json().catch(() => ({}));
					if (!r.ok) { setDomainMsg({ error: `创建失败：${j.note ?? j.error ?? r.status}` }); return; }
					setDomainMsg({ text: `✓ 域 ${id} 已创建，即刻生效（已持久化，重启后仍在）。` });
					setDomainInput("");
					reload?.();
				} catch (e) { setDomainMsg({ error: `创建失败：${String(e.message ?? e)}` }); }
			};
			const patchBackend = async (v) => {
				try {
					const r = await fetch(`${API}/actions/config`, {
						method: "POST", headers: { "content-type": "application/json" },
						body: JSON.stringify({ "embedding.backend": v }),
					});
					const j = await r.json().catch(() => ({}));
					if (!r.ok) { window.alert(`切换失败：${j.error ?? r.status}`); return; }
					window.alert("已保存嵌入后端设置。嵌入器在进程启动时构造——请重启 DSH web 后生效，重启后再点「Rebuild 派生层」重建向量索引。");
				} catch (e) { window.alert(`切换失败：${String(e.message ?? e)}`); }
			};
			const findNeighbors = async () => {
				const w = (nn?.q ?? "").trim();
				if (!w) return;
				try {
					const r = await fetch(`${API}/actions/lexvec-neighbors`, {
						method: "POST", headers: { "content-type": "application/json" },
						body: JSON.stringify({ word: w, topK: 20 }),
					});
					const j = await r.json().catch(() => ({}));
					if (!r.ok) { setNn({ q: w, error: j.error ?? r.status, neighbors: [] }); return; }
					setNn({ q: w, neighbors: j.neighbors ?? [], vocabSize: j.vocabSize });
				} catch (e) { setNn({ q: w, error: String(e.message ?? e), neighbors: [] }); }
			};
			const addToDict = (word) => {
				const groups = (dictDraft ?? (cfg.synonymGroups ?? []).map((g) => g.join(", ")).join("\n")).split("\n")
					.map((line) => line.split(/[,，、]/).map((w) => w.trim()).filter(Boolean));
				const gi = groups.findIndex((g) => nn?.q && g.some((w2) => (nn.q).includes(w2) || w2.includes((nn.q))));
				if (gi >= 0) { if (!groups[gi].includes(word)) groups[gi].push(word); }
				else groups.push([word, nn?.q ?? word].filter(Boolean));
				setDictDraft(groups.map((g) => g.join(", ")).join("\n"));
				setNn((cur) => ({ ...cur, neighbors: (cur?.neighbors ?? []).map((n) => n.word === word ? { ...n, inDict: true } : n) }));
			};
			if (!cfg) return block("功能开关与配置", [h("p", { style: css.muted }, "等待状态加载…")]);
			const set = (path, value) => onPatch({ [path]: value });
			const baseBlock = block("功能开关与配置（即时生效；跨重启持久化请用 插件 自动配置页）", [
				h(Toggle, { label: "插件总开关", value: cfg.enabled, onChange: (v) => set("plugin.enabled", v) }),
				// 配额是 map 型字段（按域），default 域 = 全局缺省——按域写，浅合并不丢其他域
				h(NumInput, { label: "每日写入配额（每域）", value: cfg.dailyQuotaDefault, step: 1, min: 1, onChange: (v) => set("write.dailyQuotaPerDomain.default", v) }),
				h(NumInput, { label: "冷存阈值（持久度）", value: cfg.coldThreshold, step: 0.05, min: 0.05, max: 0.5, onChange: (v) => set("lifecycle.coldThreshold", v) }),
				h(NumInput, { label: "冷存闲置天数", value: cfg.coldIdleDays, step: 10, min: 7, onChange: (v) => set("lifecycle.coldIdleMs", v * 864e5) }),
				h(Toggle, { label: "verified 确认信号", value: cfg.verifiedEnabled, onChange: (v) => set("trust.verifiedEnabled", v) }),
				h(Toggle, { label: "查询扩展（同义词典）", value: cfg.queryExpansion !== false, onChange: (v) => set("retrieve.queryExpansion", v) }),
				h("p", { style: css.muted }, "query 命中组内任一词时，同组其他词自动并入检索（弥补字面变体盲区）。每行一组，组内用逗号分隔。编辑后点击输入框外任意处提交："),
				h("button", {
					style: { ...css.btn, flex: "none" },
					onClick: async () => {
						try {
							const r = await fetch(`${API}/actions/open-folder`, {
								method: "POST",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({ target: "root" }),
							});
							if (!r.ok) window.alert(`打开失败：${r.status}`);
						} catch (e) { window.alert(`打开失败：${String(e.message ?? e)}`); }
					},
				}, "打开词典文件夹（含 query-synonyms.json）"),
				// 词典编辑用「本地草稿 + 失焦提交」：value 直绑服务器回显会导致每个键击被
				// 异步回显覆盖（不足两词的半成品还会被过滤成空数组）——打字全被吞
				h("textarea", {
					// 固定高度 + 内部滚动：词典多了不占满屏；6 行起步，拖拽可调
					rows: 6,
					style: { ...css.input, width: "100%", fontFamily: "monospace", fontSize: "12px", resize: "vertical", overflow: "auto", ...(cfg.queryExpansion === false ? { opacity: 0.5 } : {}) },
					spellcheck: false,
					disabled: cfg.queryExpansion === false,
					placeholder: cfg.queryExpansion === false ? "查询扩展已关闭——打开开关后可编辑词典" : "喜欢, 爱好\n喝, 饮品",
					value: dictDraft ?? (cfg.synonymGroups ?? []).map((g) => g.join(", ")).join("\n"),
					onChange: (e) => setDictDraft(e.target.value),
					onBlur: () => {
						if (dictDraft === null) return;
						const groups = dictDraft.split("\n")
							.map((line) => line.split(/[,，、]/).map((w) => w.trim()).filter(Boolean))
							.filter((g) => g.length >= 2);
						set("retrieve.synonymGroups", groups);
						setDictDraft(null);   // 提交后回到跟随服务器回显
					},
				}),
				h("p", { style: { ...css.muted, marginTop: "8px" } }, "近邻候选推荐（词向量发现 → 人工确认 → 进词典）："),
				cfg.embedBackend === "lexvec" ? h("div", { style: { display: "flex", gap: "8px", alignItems: "center" } },
					h("input", {
						style: { ...css.input, width: "auto", flex: 1 },
						placeholder: "输入一个词，找它的向量近邻（同义词候选）",
						value: nn?.q ?? "",
						onChange: (e) => setNn({ q: e.target.value, neighbors: nn?.neighbors ?? [] }),
						onKeyDown: (e) => { if (e.key === "Enter") findNeighbors(); },
					}),
					h("button", { style: css.btn, onClick: findNeighbors }, "找近邻"),
				) : h("p", { style: css.muted }, "嵌入后端切到 lexvec 后，这里可以按词向量近邻自动发现同义词候选。"),
				(nn?.error ? h("p", { style: css.warn }, `查找失败：${nn.error}`) : null),
				(nn?.neighbors?.length ? h("div", { style: { maxHeight: "340px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "4px" } },
					nn.neighbors.map((n) => h("div", { key: n.word, style: css.row },
					h("span", { style: { ...css.grow } }, n.word),
					h("span", { style: css.muted }, `${Math.round(Math.max(0, n.sim) * 100)}%`),
						n.inDict ? h("span", { style: css.ok }, "已在词典")
							: h("button", { style: { ...css.btn, flex: "none" }, onClick: () => addToDict(n.word) }, "+ 词典"),
					)),
				) : null),
				h("p", { style: { ...css.muted, marginTop: "8px" } }, "词典生效诊断（输入一个查询，看检索时会扩展出哪些词）："),
				h("div", { style: { display: "flex", gap: "8px", alignItems: "center" } },
					h("input", {
						style: { ...css.input, width: "auto", flex: 1 },
						placeholder: "例：饮品偏好 / 想喝点什么 / 喜欢玩什么",
						value: diagInput,
						onChange: (e) => setDiagInput(e.target.value),
						onKeyDown: (e) => { if (e.key === "Enter") runDiag(); },
					}),
					h("button", { style: css.btn, onClick: runDiag }, "诊断"),
				),
				diag?.error ? h("p", { style: css.warn }, `诊断失败：${diag.error}`) : null,
				(diag && !diag.error) ? h("p", { style: css.ok },
					diag.enabled
						? (diag.expansionWords?.length
							? `✓ 生效：查询「${diag.query}」命中同义组，检索时并入这些词 → ${diag.expansionWords.join("、")}`
							: `○ 未命中同义组：「${diag.query}」按原词检索（词典里没有它涉及的词）`)
						: `✗ 查询扩展开关已关闭——词典不生效`) : null,
				// 【R-137】向量索引：只读诊断，不再是可选项。
				// 历史上这里是"向量策略 brute-force / ann"下拉，但 ann 依赖的 rescore 索引上游根本
				// 没有发布版（实测 300 维下即便有也只有 13% 收益），选它等于选了个必然降级的选项。
				// 现在固定走内存精确索引，这里报"实际走哪条路 + 为什么"，而不是"配置想要什么"。
				(() => {
					const vec = state?.vector;
					if (!vec) return h("p", { style: css.muted }, "向量索引：读取中…");
					const LABEL = {
						"mem-exact": "内存精确索引",
						"mem-lazy": "内存索引（待加载）",
						"vec0-knn": "vec0 分区 KNN",
						"domain-scan": "域内全量扫描",
						"per-domain": "每域一表",
						disabled: "已关闭（三路召回）",
					};
					const good = vec.mode === "mem-exact";
					return h("div", null,
						h("div", { style: css.row },
							h("span", { style: { ...css.grow, fontWeight: 600 } }, "向量索引"),
							h("span", { style: good ? css.ok : css.muted }, LABEL[vec.mode] ?? vec.mode ?? "—"),
						),
						h("p", { style: { ...css.muted, margin: "2px 0" } }, vec.reason ?? ""),
						vec.residentVectors > 0 ? h("p", { style: { ...css.muted, margin: "2px 0" } },
							`常驻 ${vec.residentVectors} 条 / ${(vec.bytes / 1048576).toFixed(1)} MB`
								+ `（${vec.loadedDomains} 个域，上限 ${vec.maxVectors}）`
								+ (vec.dirtyDomains ? `；⚠ ${vec.dirtyDomains} 个域待重灌` : "")) : null,
						h("p", { style: { ...css.muted, margin: "2px 0" } },
							`usearch ${vec.usearch ?? "—"}　sqlite-vec ${vec.sqliteVec ?? "—"}`),
					);
				})(),
				// ── 【R-138】记忆域：查看 + 新增 ──
				(() => {
					const doms = state?.domainsDetail ?? [];
					return h("div", { style: { marginTop: "10px", paddingTop: "8px", borderTop: "1px solid rgba(128,128,128,.25)" } },
						h("div", { style: css.row },
							h("span", { style: { ...css.grow, fontWeight: 600 } }, `记忆域（${doms.length}）`),
						),
						doms.length ? doms.map((d) => h("div", { key: d.id, style: css.row },
							h("span", { style: { ...css.grow } }, d.id),
							h("span", { style: css.muted }, `${d.entries} 条`),
							d.builtIn ? h("span", { style: css.muted }, "内置兜底")
								: h("span", { style: css.ok }, "自建"),
						)) : h("p", { style: css.muted }, "读取中…"),
						h("div", { style: { display: "flex", gap: "8px", marginTop: "6px" } },
							h("input", {
								style: { ...css.input, flex: 1 },
								placeholder: "新域名：英文开头，仅英文/数字/下划线/连字符（如 bilibili-dm）",
								value: domainInput,
								onChange: (e) => setDomainInput(e.target.value),
								onKeyDown: (e) => { if (e.key === "Enter") addDomain(); },
							}),
							h("button", { style: css.btn, onClick: addDomain }, "新增域"),
						),
						h("p", { style: { ...css.muted, marginTop: "4px" } },
							"创建后即刻生效，无需重启：新插件用「域名:会话ID」作 sessionId 发消息即路由进该域（如 bilibili-dm:u123）。"
							+ "写入配额默认 20 条/天，可在上方「每日写入配额」单独调；数据存 domains/<域名>/，Rebuild 会从那里重放。"
							+ "未匹配任何域的会话由内置 dsh 域兜底。命名只用英文是因为它会直接成为文件夹名、sessionId 前缀和配置键。"),
						domainMsg ? h("p", { style: domainMsg.error ? css.warn : css.ok }, domainMsg.error ?? domainMsg.text) : null,
					);
				})(),
				h(Select, {
					label: "嵌入后端", value: cfg.embedBackend ?? "hash",
					options: ["hash", "lexvec"],
					note: cfg.embedBackend === "lexvec"
						? "词向量表后端：纯查表语义（内置种子表）。切换后需 Rebuild。"
						: "hash=无语义（向量路关闭，三路召回）；lexvec=词向量表查表语义（零模型，推荐）",
					onChange: (v) => { if (v !== (cfg.embedBackend ?? "hash")) patchBackend(v); },
				}),
			]);
			// 注：LLM 卡片单独渲染（草稿态 + 保存按钮），追加到上面的块之后
			return h("div", null, baseBlock, h(LlmCard, { llm, draft: llmDraft, set: llmSet, save: saveLlm, test: testLlm, msg: llmMsg }));
		}

		/** 【R-127~R-130】LLM 接入卡片：总开关 + 三档 transport + 保存（transport 构造期固化，保存需重启）。 */
		function LlmCard({ llm, draft, setDraft, set, save, test, msg }) {
			if (!llm) return block("LLM 接入（抽取 / 对账 / 风格提炼的地基）", [h("p", { style: css.muted }, "读取中…")]);
			if (llm.error) return block("LLM 接入", [h("p", { style: css.warn }, `读取失败：${llm.error}`)]);
			const d = draft ?? {};
			const hostOk = llm.host?.available === true;
			const providers = llm.host?.providers ?? [];
			const transport = d.transport ?? "host";
			const field = (label, value, onChange, opts = {}) => h("div", { style: { ...css.row, marginTop: "4px" } },
				h("span", { style: { ...css.grow, minWidth: "120px" } }, label),
				h("input", {
					style: { ...css.input, width: "auto", flex: 2, ...(opts.disabled ? { opacity: 0.5 } : {}) },
					value: value ?? "",
					placeholder: opts.placeholder ?? "",
					type: opts.type ?? "text",
					disabled: opts.disabled === true,
					onChange: (e) => onChange(e.target.value),
				}));

			return block("LLM 接入（抽取 / 对账 / 风格提炼的地基）", [
				h(Toggle, {
					label: "打开 LLM 接入",
					value: d.enabled === true,
					onChange: (v) => set({ enabled: v }),
					note: "关闭时抽取管线维持「骨架在、不产候选」，并在审计里落 llm-disabled（不静默）",
				}),
				h(Select, {
					label: "通道",
					value: transport,
					options: ["host", "local", "custom"],
					note: transport === "host"
						? (hostOk ? "复用宿主通道（路径 B）：API key 留在宿主，插件只见服务" : "⚠ 当前实例没有宿主 llm 服务（headless / CLI）——请改用 local 或 custom")
						: transport === "local" ? "本地 OpenAI 兼容端点（Ollama / LM Studio / vLLM）" : "自定义云 API（key 优先读环境变量，其次文件值）",
					onChange: (v) => set({ transport: v }),
				}),
				transport === "host" ? h("div", null,
					providers.length ? h(Select, {
						label: "provider",
						value: d.host?.provider ?? "",
						options: [""].concat(providers.map((p) => p.id)),
						onChange: (v) => set({ host: { ...(d.host ?? {}), provider: v } }),
					}) : field("provider", d.host?.provider, (v) => set({ host: { ...(d.host ?? {}), provider: v } }), { placeholder: "如 deepseek" }),
					field("model", d.host?.model, (v) => set({ host: { ...(d.host ?? {}), model: v } }), { placeholder: "如 deepseek-chat（不写死，跟宿主现状）" }),
				) : null,
				transport === "local" ? h("div", null,
					field("baseUrl", d.local?.baseUrl, (v) => set({ local: { ...(d.local ?? {}), baseUrl: v } }), { placeholder: "http://127.0.0.1:11434/v1" }),
					field("model", d.local?.model, (v) => set({ local: { ...(d.local ?? {}), model: v } }), { placeholder: "如 qwen2.5:7b" }),
				) : null,
				transport === "custom" ? h("div", null,
					field("baseUrl", d.custom?.baseUrl, (v) => set({ custom: { ...(d.custom ?? {}), baseUrl: v } }), { placeholder: "https://api.deepseek.com/v1" }),
					field("model", d.custom?.model, (v) => set({ custom: { ...(d.custom ?? {}), model: v } }), { placeholder: "如 deepseek-chat" }),
					field("key 环境变量名", d.custom?.apiKeyEnv, (v) => set({ custom: { ...(d.custom ?? {}), apiKeyEnv: v } }), { placeholder: "DSH_MEMORY_LLM_API_KEY" }),
					field("或直接填 key", d.custom?.apiKey, (v) => set({ custom: { ...(d.custom ?? {}), apiKey: v } }), { placeholder: llm.env?.customKeyPresent ? "环境变量已提供，可留空" : "明文存盘，单机可用", type: "password" }),
				) : null,
				h("p", { style: css.muted }, `宿主通道：${hostOk ? "可用" : "不可用"}${providers.length ? `｜可配置 provider ${providers.length} 个` : ""}${llm.host?.error ? `｜探测错误：${llm.host.error}` : ""}`),
				h("div", { style: { ...css.row, marginTop: "8px", gap: "8px" } },
					h("button", { style: css.btn, onClick: save }, "保存 LLM 设置"),
					h("button", { style: css.btn, onClick: test }, "测试连接"),
					h("span", { style: css.muted }, "改完需重启 dsh web 生效（transport 在启动期构造）"),
				),
				msg?.error ? h("p", { style: css.warn }, `保存失败：${msg.error}`) : null,
				(msg && !msg.error && msg.text) ? h("p", { style: css.ok }, msg.text) : null,
			]);
		}

		function ActionPanel({ onAction, state }) {
			const { busy, msg, setMsg, run } = useAction();
			const [rb, setRb] = react.useState(null);   // rebuild 进度 {phase,done,total,running}
			const phaseText = { scan: "扫描 Markdown 文件", entries: "重建条目与三元组", fts: "重建全文索引", vec: "嵌入向量灌入", finalize: "收尾（词表失效/审计）" };
			const rebuild = async () => {
				if (!window.confirm("从 Markdown 重建派生层？\n重建期间检索不可用，完成后自动恢复。")) return;
				// 注意：useAction 不返回 setBusy——忙碌态从 rb 派生（rb 非空 = 重建进行中），
				// 否则 ReferenceError 点击无反应（作用域坑第三次：run/setBusy 各归各的闭包）
				setRb({ phase: "scan", done: 0, total: 0, running: true });
				// 进度轮询：与 rebuild 请求并行，500ms 一次
				const poll = setInterval(async () => {
					try {
						const j = await (await fetch(`${API}/rebuild-progress`)).json();
						setRb(j.running ? { ...j } : (cur) => cur);
					} catch { /* 瞬时失败忽略，下外审再试 */ }
				}, 500);
				try {
					const r = await fetch(`${API}/actions/rebuild`, { method: "POST" });
					const j = await r.json().catch(() => ({}));
					if (!r.ok) { setMsg(`rebuild 失败：${j.error ?? r.status}`); setRb(null); return; }
					setMsg(`rebuild 完成：${j.entries} 条 / ${j.files} 个文件 / ${(j.elapsedMs / 1000).toFixed(1)}s`);
					onAction();
				} catch (e) {
					setMsg(`rebuild 失败：${String(e.message ?? e)}`);
				} finally {
					clearInterval(poll);
					setRb(null);
				}
			};
			const working = Boolean(busy || rb);   // rb 非空即重建进行中
			const pct = rb && rb.total > 0 ? Math.min(100, Math.round((rb.done / rb.total) * 100)) : (rb ? 8 : 0);
			return block("操作", [
				h("div", { style: { display: "flex", gap: "10px" } },
					h("button", { style: css.btn, disabled: working, onClick: async () => { const r = await run("dream"); if (r) onAction(); } }, "执行 Dream"),
					h("button", {
						style: css.btn, disabled: working,
						onClick: async () => {
							const domain = (state?.domains ?? [])[0] ?? "dsh";
							await run("open-folder", { domain });
						},
					}, "打开 md 文件夹"),
					h("button", {
						style: { ...css.btn, ...css.btnDanger }, disabled: working,
						onClick: rebuild,
					}, rb ? "重建中…" : "Rebuild 派生层"),
				),
				rb ? h("div", { style: { marginTop: "8px" } },
					h("div", { style: { height: "6px", background: "rgba(128,128,128,.25)", borderRadius: "3px", overflow: "hidden" } },
						h("div", { style: { height: "100%", width: `${pct}%`, background: "#4a9eff", transition: "width .3s" } })),
					h("p", { style: css.muted },
						`${phaseText[rb.phase] ?? rb.phase}${rb.total > 0 ? `：${rb.done}/${rb.total}` : "…"}（${pct}%）`),
				) : null,
				msg ? h("p", { style: msg.includes("失败") ? css.warn : css.ok }, msg) : null,
				h("p", { style: css.muted }, "Rebuild = 从 Markdown 真相源重放派生层（向量索引随之整层重灌）；重建期间检索不可用。"),
			]);
		}

		function SessionPanel({ state, onAction }) {
			const recent = state?.recentSessions ?? [];
			const blocked = state?.blockedSessions ?? [];
			// 渲染集 = 最近活跃 ∪ 黑名单：手动加的会话（无调用记录）也要有解除按钮
			const sessions = [
				...recent,
				...blocked.filter((id) => !recent.some((r) => r.id === id)).map((id) => ({ id, lastAt: 0, calls: 0, blocked: true })),
			];
			const { busy, msg, setMsg, run } = useAction();
			const [manual, setManual] = react.useState('');
			const [open, setOpen] = react.useState(false);
			const [q, setQ] = react.useState('');
			const qLower = q.trim().toLowerCase();
			const filtered = qLower
				? sessions.filter((sess) => sess.id.toLowerCase().includes(qLower) || (sess.title ?? '').toLowerCase().includes(qLower))
				: sessions;
			const row = (sess) => h("div", { key: sess.id, style: css.row, title: sess.id },
				h("span", {
					style: { ...css.grow, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
					title: sess.id,
				}, sess.title ?? sess.id),
				...(sess.lastAt ? [h("span", { style: css.muted }, `${sess.calls} 次调用 · ${new Date(sess.lastAt).toLocaleTimeString()}`)] : []),
				h("button", {
					style: { ...css.btn, flex: "none", ...(sess.blocked ? css.btnDanger : {}) }, disabled: busy,
					onClick: async () => { const r = await run('session', { sessionId: sess.id, blocked: !sess.blocked }); if (r) onAction(); },
				}, sess.blocked ? "已屏蔽，点此恢复" : "屏蔽记忆"));
			return block(`会话记忆开关（${sessions.length} 个会话；名单内的会话不注入也不被记录，未列出的默认带记忆）`, [
				h("div", { style: css.row },
					h("button", { style: css.btn, onClick: () => setOpen(!open) },
						open ? `收起列表` : `展开列表（${qLower ? `${filtered.length} 匹配 / ` : ''}${sessions.length}）`),
					open ? h("input", {
						style: { ...css.input, width: "auto", flex: 1 },
						placeholder: "搜索会话名称或 id",
						value: q,
						onChange: (e) => setQ(e.target.value),
					}) : null,
				),
				...(open ? [
					...(filtered.length ? filtered.map(row) : [h("p", { style: css.muted }, qLower ? "没有匹配的会话。" : "还没有会话。")]),
					h("div", { style: { ...css.row, borderTop: "1px dashed rgba(128,128,128,.3)", paddingTop: "6px" } },
						h("input", {
							style: { ...css.input, width: "auto", flex: 1 },
							placeholder: "手动添加会话 id（可选）",
							value: manual,
							onChange: (e) => setManual(e.target.value),
						}),
						h("button", {
							style: css.btn, disabled: busy || !manual.trim(),
							onClick: async () => { const r = await run('session', { sessionId: manual.trim(), blocked: true }); if (r) { setManual(''); onAction(); } },
						}, "加入屏蔽名单"),
					),
					blocked.length ? h("p", { style: css.muted }, `当前屏蔽名单：${blocked.length} 个会话`) : null,
					msg ? h("p", { style: msg.includes("失败") ? css.warn : css.ok }, msg) : null,
				] : []),
			]);
		}

		function ForkPanel({ state }) {
			const forks = state?.forks ?? [];
			if (!forks.length) return block("身份分叉", [h("p", { style: css.muted }, "当前没有分叉（同一主体同一属性存在多个值的记忆）。")]);
			return block("身份分叉（人工确认式对齐，绝不自动合并）", forks.map((f) =>
				h("div", { key: `${f.subject_key}|${f.attribute}`, style: { borderTop: "1px dashed rgba(128,128,128,.3)", paddingTop: "6px" } },
					h("div", { style: css.row }, h("b", { style: css.grow }, `${f.subject_key} · ${f.attribute}`), h("span", { style: css.muted }, `${f.values_cnt} 个值`)),
					...f.members.map((m) => h("div", { key: m.entryId, style: css.row },
						h("span", { style: { ...css.grow, fontFamily: "monospace", fontSize: "12px" } }, m.value),
						h("button", {
							style: css.btn, disabled: false,
							onClick: async () => {
								if (!window.confirm(`保留「${m.value}」，其余同簇记忆将被取代边收口？`)) return;
								await fetch(`${API}/actions/align`, {
									method: "POST", headers: { "content-type": "application/json" },
									body: JSON.stringify({ subjectKey: f.subject_key, attribute: f.attribute, keepEntryId: m.entryId }),
								});
								window.location.reload();
							},
						}, "保留此条")))),
			));
		}

		/**
		 * 【R-149】候选确认池（human-in-the-loop）：低置信候选等用户裁决——
		 * 确认 = 走正常落盘管线 + reinforce 激活（比自动入库的更持久）；拒绝 = 删 + audit。
		 */
		function ConfirmPanel() {
			const [items, setItems] = react.useState(null);
			const [gate, setGate] = react.useState(false);
			const [msg, setMsg] = react.useState(null);
			const load = async () => {
				try {
					const j = await (await fetch(`${API}/confirm-queue`)).json();
					setItems(j.items ?? []);
					setGate(Boolean(j.gateEnabled));
				} catch (e) { setMsg(`读取失败：${e.message ?? e}`); }
			};
			react.useEffect(() => { load(); }, []);
			const act = async (action, id, note) => {
				try {
					const r = await fetch(`${API}/actions/${action}`, {
						method: "POST", headers: { "content-type": "application/json" },
						body: JSON.stringify({ id, note }),
					});
					const j = await r.json().catch(() => ({}));
					if (!r.ok || j.ok === false) { setMsg(`${action} 失败：${j.error ?? r.status}`); return; }
					setMsg(action === "confirm-approve" ? "已确认并入库（带 reinforce 加成）" : "已拒绝（留了 audit 痕迹）");
					load();
				} catch (e) { setMsg(`${action} 失败：${e.message ?? e}`); }
			};
			if (items === null) return block("候选确认池", [h("p", { style: css.muted }, "读取中…")]);
			if (!items.length) return block("候选确认池（R-149 human-in-the-loop）", [
				h("p", { style: css.muted }, `队列为空。确认闸门当前${gate ? "已开启（uncertain 候选会进这里等你裁决）" : "未开启（uncertain 走老的待定池双发行为）"}。`),
				msg ? h("p", { style: css.ok }, msg) : null,
			]);
			return block(`候选确认池（${items.length} 条等你裁决）`, [
				h("p", { style: css.muted }, "确认 = 正常落盘并带 reinforce 加成（更耐衰减）；拒绝 = 删除并留 audit 痕迹。过期未处理的会自动清掉（TTL）。"),
				...items.map((it) => h("div", { key: it.id, style: { borderTop: "1px dashed rgba(128,128,128,.3)", paddingTop: "6px" } },
					h("div", { style: css.row },
						h("span", { style: { ...css.grow, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: it.text }, it.text || "（无文本）"),
						h("span", { style: css.muted }, `${it.entryType || "?"} · ${new Date(it.enqueuedAt).toLocaleString()}`)),
					h("div", { style: { display: "flex", gap: "8px", marginTop: "4px" } },
						h("button", { style: css.btn, onClick: () => act("confirm-approve", it.id) }, "确认记住"),
						h("button", { style: { ...css.btn, ...css.btnDanger }, onClick: () => { if (window.confirm("拒绝记忆这条候选？")) act("confirm-reject", it.id); } }, "拒绝")))),
				msg ? h("p", { style: msg.includes("失败") ? css.warn : css.ok }, msg) : null,
			]);
		}

		/* R-63：人类可读的记忆检索视图——内核验证了半天，最后一步得让人看得见 */
		function SearchPanel() {
			const [q, setQ] = react.useState("");
			const [domain, setDomain] = react.useState("");
			const [domains, setDomains] = react.useState(null);
			const [items, setItems] = react.useState(null);
			const [meta, setMeta] = react.useState(null);
			const [msg, setMsg] = react.useState(null);
			react.useEffect(() => { (async () => {
				try {
					const j = await (await fetch(`${API}/status`)).json();
					const ds = (j.domainsDetail ?? []).map((d) => d.id);
					setDomains(ds);
					if (ds.length) setDomain(ds[0]);
				} catch { setDomains([]); }
			})(); }, []);
			const search = async () => {
				if (!q.trim() || !domain) return;
				setMsg(null); setItems(null); setMeta(null);
				try {
					const u = `${API}/memory-search?q=${encodeURIComponent(q)}&domain=${encodeURIComponent(domain)}&k=10`;
					const j = await (await fetch(u)).json();
					setItems(j.items ?? []);
					setMeta(j.note ?? null);
					if (!(j.items ?? []).length) setMsg(j.note === "domain-not-found" ? "域不存在" : "没有命中的记忆——可能真没有，也可能换了说法，换个关键词试试");
				} catch (e) { setMsg(`检索失败：${e.message ?? e}`); }
			};
			const tier = (t) => t === "trusted"
				? h("span", { style: { ...css.muted, color: "rgba(120,200,120,.95)", flex: "none" } }, "本域可信")
				: h("span", { style: { ...css.muted, color: "rgba(220,110,90,.95)", flex: "none", fontWeight: 600 } }, "未经确认");
			return block("记忆检索（R-63：人类可读视图）", [
				h("p", { style: css.muted }, "和 Agent 看到的是同一条检索管线、同一套信任判定——她说过的话，你可以自己来对账。"),
				h("div", { style: { display: "flex", gap: "8px" } },
					h("select", { style: css.select, value: domain, onChange: (e) => setDomain(e.target.value) },
						(domains ?? []).map((d) => h("option", { key: d, value: d }, d))),
					h("input", { style: { ...css.input, flex: 1, width: "auto" }, placeholder: "想核实哪条记忆？", value: q, onChange: (e) => setQ(e.target.value), onKeyDown: (e) => { if (e.key === "Enter") search(); } }),
					h("button", { style: css.btn, onClick: search }, "检索")),
				items === null ? null : items.map((it) => h("div", { key: it.id, style: { borderTop: "1px dashed rgba(128,128,128,.3)", paddingTop: "6px", display: "flex", flexDirection: "column", gap: "2px" } },
					h("div", { style: css.row },
						h("span", { style: { ...css.grow, opacity: it.cold ? 0.6 : 0.9 } }, it.text),
						tier(it.tier)),
					h("div", { style: css.muted },
						`${it.entryType ?? "?"} · 记于 ${it.observedAt ? new Date(it.observedAt).toLocaleDateString() : "?"} · 重要度 ${it.importance ?? "?"}${it.cold ? " · 已冷存" : ""}${it.source ? ` · 来源 ${it.source}` : ""} · ${it.id}`))),
				msg ? h("p", { style: css.muted }, msg) : null,
			]);
		}

		/* R-155：任务统一视图——四类积压只读聚合，数字与 SQL 直查同源（src/core/tasks.js） */
		function TasksPanel({ state }) {
			const t = state?.tasks ?? null;
			if (!t) return null;
			const fmtAge = (ts) => ts ? `最老 ${new Date(ts).toLocaleString()}` : "";
			return block("任务面板（R-155 只读聚合）", [
				row("待定池（自动消化）", `${t.pendingUncertain ?? 0} 条 ${fmtAge(t.pendingOldestAt)}`),
				row("确认池（等你裁决）", `${t.pendingConfirm ?? 0} 条`),
				row("待补嵌向量", `${t.embeddingPending ?? 0} 条 ${fmtAge(t.embeddingOldestAt)}`),
				row("检索日志（TTL 内）", `${t.retrievalLog ?? 0} 条 ${fmtAge(t.retrievalOldestAt)}`),
				h("p", { style: css.muted }, "只读展示：清理归各表自己的 TTL / drain / dream，面板不做任何操作。"),
			]);
		}

		/* 【R-156】遗忘面板：单条物理删除，六位置闭环 + git tombstone。裁决权在人——无批量、无自动。 */
		function ForgetPanel() {
			const [id, setId] = react.useState("");
			const [reason, setReason] = react.useState("");
			const [msg, setMsg] = react.useState(null);
			const forget = async () => {
				const eid = id.trim();
				if (!eid) return;
				if (!window.confirm(`确定要永久遗忘 ${eid} 吗？\n不可逆：真相源/索引/向量/连锁边/冷存一次清空，仅 git 留 tombstone 可追溯。`)) return;
				setMsg(null);
				try {
					const r = await fetch(`${API}/actions/forget`, {
						method: "POST", headers: { "content-type": "application/json" },
						body: JSON.stringify({ entryId: eid, confirm: eid, reason: reason.trim() || undefined }),
					});
					const j = await r.json().catch(() => ({}));
					if (!r.ok) { setMsg({ error: j.error ?? r.status }); return; }
					setMsg({ ok: j.forgotten, text: j.forgotten ? `✓ 已遗忘（md/SQLite/向量/links/冷存/tombstone 已清）` : "库里没有这条（可能已忘过），未做改动" });
					setId("");
				} catch (e) { setMsg({ error: String(e.message ?? e) }); }
			};
			return block("遗忘一条记忆（R-156：不可逆，慎用）", [
				h("p", { style: css.muted }, "先在上方「记忆检索」核实条目 id，再粘到这里删除。六个存储位置一次清空；重建/备份恢复都不会让它复活（tombstone）。"),
				h("div", { style: { display: "flex", gap: "8px" } },
					h("input", { style: { ...css.input, flex: 1, width: "auto", fontFamily: "monospace" }, placeholder: "entry_id（26 位 ULID）", value: id, onChange: (e) => setId(e.target.value), onKeyDown: (e) => { if (e.key === "Enter") forget(); } }),
					h("input", { style: { ...css.input, width: "auto", flex: "none", width: "180px" }, placeholder: "原因（可选，进审计）", value: reason, onChange: (e) => setReason(e.target.value) }),
					h("button", { style: { ...css.btn, ...css.btnDanger }, disabled: !id.trim(), onClick: forget }, "遗忘")),
				msg ? h("p", { style: msg.error ? css.warn : css.ok }, msg.error ?? msg.text) : null,
			]);
		}

		function MemorySection(props) {
			const { state, error, reload } = useStatus();
			// 配置改动：发 /actions/config（API 层展开扁平键 + 白名单），成功后刷新状态
			const patchConfig = async (patch) => {
				try {
					const r = await fetch(`${API}/actions/config`, {
						method: "POST", headers: { "content-type": "application/json" },
						body: JSON.stringify(patch),
					});
					const j = await r.json().catch(() => ({}));
					if (!r.ok) window.alert(`配置被拒绝：${(j.rejected ?? []).map((x) => `${x.path}（${x.reason}）`).join('；') || j.error || r.status}`);
				} catch (e) { window.alert(`配置写入失败：${String(e.message ?? e)}`); }
				reload();
			};
			return h("div", { style: css.wrap },
				h("div", { style: { fontSize: "12px", opacity: 0.65 } },
					"dsh-memory-kernel · 记忆库 ~/.dsh/memory-kernel-dsh · Markdown 真相源 + SQLite 派生层"),
				h(StatusPanel, { state, error }),
				h(ConfigPanel, { state, onPatch: patchConfig, reload }),
				h(ActionPanel, { onAction: reload, state }),
				h(SessionPanel, { state, onAction: reload }),
				h(SearchPanel, null),
				h(ForgetPanel, null),
				h(TasksPanel, { state }),
				h(ConfirmPanel, null),
				h(ForkPanel, { state }),
				block("记忆工具（在会话里对 Agent 说即可触发）", TOOLS.map(([n, d]) => row(n, d))),
			);
		}

		function apply(ctx) {
			// 现役形态（照抄 dsh-client-ui-settings-plugins）：经 slots.inject 把注册
			// 挂到 slot 依赖上（fiber 卸载自动反注册）；label 用函数（resolveSlotLabel
			// 两种都吃，但函数是被现役验证过的形态）。
			const doRegister = () => ctx.slots.register({
				name: "settings.section",
				id: "memory-test",
				order: 90,
				label: () => "记忆-测试",
			}, MemorySection);
			try {
				if (typeof ctx.slots?.inject === "function") {
					const d = ctx.slots.inject("settings.section", doRegister);
					return typeof d === "function" ? d : () => { try { doRegister && void 0; } catch { /* noop */ } };
				}
			} catch (e) { console.error("[dsh-memory-kernel] slots.inject 失败，退回直接注册:", e); }
			const dispose = doRegister();
			return () => { try { dispose(); } catch { /* 宿主已在卸载 */ } };
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
