// ==UserScript==
// @name         OCS 任务点为空 · 自动下一节
// @namespace    https://local.ocs.helper
// @version      3.14.4
// @description  当 OCS 提示「页面任务点数量为空! 请刷新重试!」时，自动把超星课程切换到下一节；一直跳到没有下一节为止。
// @author       YG
// @namespace    https://github.com/KoishiYU/chaoxing-auto-next
// @supportURL   https://github.com/KoishiYU/chaoxing-auto-next/issues
// @match        *://*.chaoxing.com/*
// @match        *://*.chaoxing.cn/*
// @match        *://*.edu.cn/*
// @match        *://*.org.cn/*
// @match        *://*.xueyinonline.com/*
// @grant        unsafeWindow
// @run-at       document-start
// @license      MIT
// @updateURL    https://raw.githubusercontent.com/KoishiYU/chaoxing-auto-next/main/ocs-auto-next.user.js
// @downloadURL  https://raw.githubusercontent.com/KoishiYU/chaoxing-auto-next/main/ocs-auto-next.user.js
// ==/UserScript==

(function () {
	'use strict';

	try {
		if (window.top !== window.self) return;
	} catch (e) {
		return;
	}

	const TAG = '[自动下一节]';
	const VERSION = '3.14.4';
	const STORE_KEY = 'ocs-auto-next:cfg:v3';
	const LAST_JUMP_KEY = 'ocs-auto-next:lastjump';
	const PENDING_KEY = 'ocs-auto-next:pending';
	const COUNT_KEY = 'ocs-auto-next:jumpcount';
	const RESET_KEY = 'ocs-auto-next:count-reset-3.13.1';

	/* ==========================================================
	 * 1. 配置
	 * ========================================================== */
	const DEFAULTS = {
		enabled: true,
		/** 两次跳节的最小间隔（毫秒）。跳完要留时间让 OCS 接手学习 */
		cooldown: 8000,
		/** 连续点击后章节都没变化，判定到头，自动停手 */
		maxFail: 3,
		/** 通道 B：监听 OCS 面板 closed shadow 内的提示文本 */
		useToastDetect: true,
		/** 方案 B：本节媒体任务点没完成时，脚本自己驱动播放，完成后再跳 */
		learn: true,
		/** 自己驱动播放时用的倍速 */
		rate: 2,
		/** 附件/文档型任务点：点开后停留多久（毫秒）才允许跳节 */
		attachWait: 10000,
		noMediaWait: 12000,
		/** 停留到上限仍显示未完成时，再多等几轮 */
		attachRounds: 1,
		/** 折叠状态 */
		minimized: false
	};

	let cfg = loadCfg();

	function loadCfg() {
		const base = Object.assign({}, DEFAULTS);
		try {
			const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
			delete saved.maxJumps;
			delete saved.strategy;
			delete saved.useStateDetect;
			// 旧默认值 90s 对小章节（基本内涵这类纯文档 tab）太久，一次性降到 10s
			if (Number(saved.attachWait) === 90000) saved.attachWait = DEFAULTS.attachWait;
			return Object.assign(base, saved || {});
		} catch (e) {
			return base;
		}
	}
	function saveCfg() {
		try {
			localStorage.setItem(STORE_KEY, JSON.stringify(cfg));
		} catch (e) {}
	}

	/* ==========================================================
	 * 2. 运行时状态
	 * ========================================================== */
	const rt = {
		jumpCount: 0,
		lastJumpAt: 0,
		busy: false,
		failCount: 0,
		lastChapterId: '',
		logs: [],
		autoPausedReason: '',
		endReached: false,
		/** 方案 B 用 */
		lastDriveAt: 0,
		lastDriveLogAt: 0,
		/** 当前锁定的一个播放目标（按 src 认）+ 它上一次的位置，用来判「推不动」 */
		mediaKey: '',
		mediaAt: 0,
		mediaCur: -1,
		/** 推不动的媒体：{src: 时间戳}，2 分钟内不再碰它 */
		deadMedia: {},
		noMediaSince: 0,
		mediaDoneAt: 0,
		mediaInfo: { total: 0, done: 0 },
		/** 附件任务点：当前停留的是哪一个 / 从何时开始 / 已重试几轮 */
		attachKey: '',
		attachSince: 0,
		attachRound: 0,
		attachPassed: false,
		attachInfo: { pending: 0 },
		/** 本节是否曾看到过任务点（判断渲染延迟用） */
		sawJobs: false,
		/** 本节已经切过的 tab 下标：{0:true, 1:true} */
		tabsSeen: {},
		/** tabsSeen 对应的 localStorage key（换节时变） */
		tabsKey: '',
		learnNote: ''
	};

	/* ==========================================================
	 * 3. 工具
	 * ========================================================== */
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const now = () => Date.now();

	function ts() {
		const d = new Date();
		const p = (n) => String(n).padStart(2, '0');
		return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
	}

	const LOG_STORE_KEY = 'ocs-auto-next:logs:' + location.host;

	function log(msg, type) {
		const line = { time: ts(), msg: String(msg), type: type || 'info' };
		rt.logs.push(line);
		if (rt.logs.length > 60) rt.logs.shift();
		const fn = type === 'error' ? console.error : type === 'warn' ? console.warn : console.log;
		fn.call(console, TAG, msg);
		renderLogs();
		saveLogsSoon();
	}

	/** 日志落 sessionStorage —— 跳节时页面一旦整体刷新，脚本重跑会把日志清空，
	 *  存一份就能在刷新后接着看，不用盯着屏幕抢。会话关闭自动失效。 */
	function saveLogsSoon() {
		if (saveLogsSoon.t) return;
		saveLogsSoon.t = setTimeout(() => {
			saveLogsSoon.t = 0;
			try {
				sessionStorage.setItem(LOG_STORE_KEY, JSON.stringify(rt.logs.slice(-60)));
			} catch (e) {}
		}, 400);
	}

	function loadStoredLogs() {
		try {
			const s = sessionStorage.getItem(LOG_STORE_KEY);
			if (!s) return;
			const arr = JSON.parse(s);
			if (Array.isArray(arr) && arr.length) {
				rt.logs = arr
					.filter((x) => x && x.msg)
					.map((x) => ({ time: x.time || '', msg: String(x.msg), type: x.type || 'info' }));
				rt.logs.push({ time: ts(), msg: '（以上是刷新前的日志）', type: 'info' });
			}
		} catch (e) {}
	}

	function throttle(fn, ms) {
		let last = 0;
		let timer = null;
		return function () {
			const t = now();
			if (t - last >= ms) {
				last = t;
				fn();
			} else {
				clearTimeout(timer);
				timer = setTimeout(() => {
					last = now();
					fn();
				}, ms - (t - last));
			}
		};
	}

	/* ==========================================================
	 * 4. 跨文档访问
	 * ========================================================== */
	function allDocs() {
		const docs = [document];
		const walk = (doc, depth) => {
			if (!doc || depth > 4) return;
			let frames = [];
			try {
				frames = Array.from(doc.querySelectorAll('iframe,frame'));
			} catch (e) {
				return;
			}
			frames.forEach((f) => {
				let d = null;
				try {
					d = f.contentDocument;
				} catch (e) {
					d = null;
				}
				if (d && d.documentElement) {
					docs.push(d);
					walk(d, depth + 1);
				}
			});
		};
		try {
			walk(document, 0);
		} catch (e) {}
		return docs;
	}

	function queryAll(selector) {
		const out = [];
		allDocs().forEach((doc) => {
			try {
				doc.querySelectorAll(selector).forEach((el) => out.push(el));
			} catch (e) {}
		});
		return out;
	}

	/* ==========================================================
	 * 5. 定位承载章节目录的学习页
	 *
	 *   实测结构（mooc2-ans 微专题页）：
	 *     top   : /mooc2-ans/mycourse/stu?microTopicId=...   ← 只有微专题的外壳
	 *     iframe: /mycourse/studentstudy?...                 ← 真正的章节页
	 *             ├ .posCatalog_select × 200（章节目录）
	 *             ├ .posCatalog_active × 1
	 *             ├ #curChapterId / #curCourseId / #curClazzId  ← 隐藏 input，最可靠的当前节标识
	 *             ├ #prev_tab .prev_ul li × 2（顶部分组 tab）
	 *             ├ PCount.next(count, chapterId, courseId, clazzId, "", true)  ← 官方跳节函数
	 *             └ #prevNextFocusNext「下一节」按钮
	 *     iframe: /knowledge/cards?...                       ← 任务点内容
	 *     iframe: /ananas/modules/video/index.html           ← 播放器
	 *
	 *    注意：这个皮肤里 [onclick^="getTeacherAjax"] 数量为 0，
	 *    所以 OCS 的 getChapterInfos() 返回空 → 它才会误报「任务点数量为空」。
	 * ========================================================== */
	function studyDoc() {
		const docs = allDocs();
		// 首选：带 #curChapterId 的（真正的章节页）
		for (let i = 0; i < docs.length; i++) {
			try {
				if (docs[i].querySelector('#curChapterId') && docs[i].querySelector('#curCourseId')) return docs[i];
			} catch (e) {}
		}
		// 次选：目录项很多的
		for (let i = 0; i < docs.length; i++) {
			try {
				if (docs[i].querySelectorAll('.posCatalog_select').length > 3) return docs[i];
			} catch (e) {}
		}
		return null;
	}

	function readIds() {
		const doc = studyDoc();
		if (!doc) return null;
		const val = (sel) => {
			try {
				const el = doc.querySelector(sel);
				return el ? String(el.value == null ? '' : el.value).trim() : '';
			} catch (e) {
				return '';
			}
		};
		const chapterId = val('#curChapterId');
		if (!chapterId) return null;

		let tabCount = 0;
		try {
			tabCount = doc.querySelectorAll('#prev_tab .prev_ul li').length;
		} catch (e) {}
		if (!tabCount) {
			try {
				tabCount = doc.querySelectorAll('.prev_ul li').length;
			} catch (e) {}
		}

		let activeIdx = -1;
		let total = 0;
		let activeLabel = '';
		try {
			const all = Array.from(doc.querySelectorAll('.posCatalog_select'));
			total = all.length;
			activeIdx = all.findIndex((el) => el.classList && el.classList.contains('posCatalog_active'));
			if (activeIdx >= 0) {
				activeLabel = (all[activeIdx].textContent || '').replace(/\s+/g, ' ').trim().slice(0, 26);
			}
		} catch (e) {}

		return {
			doc: doc,
			chapterId: chapterId,
			courseId: val('#curCourseId'),
			clazzId: val('#curClazzId'),
			href: (() => {
				try {
					return doc.location.href;
				} catch (e) {
					return '';
				}
			})(),
			tabCount: tabCount || 1,
			activeIdx: activeIdx,
			total: total,
			activeLabel: activeLabel,
			frameSig: frameSig(),
			// 真实内容指纹：跳节后 #prev_tab 的小节标签会换、#mainid 会重建
			tabText: (() => {
				try {
					const t = doc.querySelector('#prev_tab');
					return t ? (t.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90) : '';
				} catch (e) {
					return '';
				}
			})(),
			mainLen: (() => {
				try {
					const m = doc.querySelector('#mainid');
					return m ? m.innerHTML.length : 0;
				} catch (e) {
					return 0;
				}
			})()
		};
	}

	/**
	 * 各层 iframe / document 的 URL 里那些稳定的节标识（chapterId / knowledgeid…）。
	 * 站点跳节是局部替换 #mainid，隐藏 input #curChapterId 常常不更新，
	 * 但 cards 那个 iframe 的地址一定会换 —— 这是最可靠的真跳证据。
	 * 只取数字型参数，避免时间戳之类每轮都变造成假阳性。
	 */
	function frameSig() {
		const out = [];
		const grab = (u) => {
			if (!u) return;
			const s = String(u);
			const re = /[?&](chapterId|knowledgeid|nodeId|jobid)=(\d+)/gi;
			let m;
			while ((m = re.exec(s))) out.push(m[1].toLowerCase() + '=' + m[2]);
		};
		for (const d of allDocs()) {
			try {
				grab(d.location.href);
			} catch (e) {}
			try {
				const fs = d.querySelectorAll('iframe');
				for (let i = 0; i < fs.length; i++) {
					try {
						grab(fs[i].getAttribute('src'));
					} catch (e) {}
					try {
						grab(fs[i].src);
					} catch (e) {}
				}
			} catch (e) {}
		}
		return Array.from(new Set(out)).sort().join('|');
	}

	/** 微专题层的「下一个」按钮（章节跳完后的兜底） */
	function topicNextButton() {
		try {
			const cands = Array.from(document.querySelectorAll('a,div,span,button')).filter((el) => {
				const oc = el.getAttribute('onclick') || '';
				return /replaceTopicId/.test(oc);
			});
			if (!cands.length) return null;
			return cands.find((el) => /next/i.test(el.className || '') || /下一个|下一专题/.test(el.textContent || '')) || cands[0];
		} catch (e) {
			return null;
		}
	}

	function isVisible(el) {
		try {
			if (!el || !el.getClientRects) return false;
			// 注意：position:fixed 的元素 offsetParent 为 null，不能拿它当判据
			if (el.getClientRects().length === 0) return false;
			const st = el.ownerDocument.defaultView.getComputedStyle(el);
			if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
			return true;
		} catch (e) {
			return false;
		}
	}

	/* ==========================================================
	 * 6. 执行跳节
	 * ========================================================== */
	/** 不管可见性，硬点一个元素（#prevNextFocusNext 常在 position:fixed 的底栏里） */
	function clickForce(el) {
		if (!el) return false;
		try {
			el.click();
			return true;
		} catch (e) {
			log('直接点击失败：' + (e && e.message), 'info');
			return false;
		}
	}

	/** 在文档里按选择器顺序点第一个点得动的元素 */
	function clickFirst(doc, selectors) {
		for (const sel of selectors) {
			let el = null;
			try {
				el = doc.querySelector(sel);
			} catch (e) {}
			if (!el) continue;
			try {
				if (!isVisible(el)) continue;
				el.scrollIntoView && el.scrollIntoView({ block: 'center' });
				el.click();
				return true;
			} catch (e) {}
		}
		return false;
	}

	/** 调用站点自带的 PCount.next；argc=6 时带强制参数 true */
	function callPCount(info, argc) {
		const win = info && info.doc && info.doc.defaultView;
		if (!win || !win.PCount || typeof win.PCount.next !== 'function') return false;
		if (!info.chapterId || !info.courseId || !info.clazzId) return false;
		try {
			win._preChapterId = info.chapterId;
		} catch (e) {}
		/*
		 * 站点源码：
		 *   function (count, chapterId, courseId, clazzid, knowledgestr, checkType) {
		 *     if (checkUnsave()) return;
		 *     if (typeof checkType != "undefined" && checkType && !courseEnded && checkJob()) { showCheckDiv(true); return; }
		 *     cur = parseInt(cur); count = parseInt(count);
		 *     $("#jumpCount").val(count); $("#jumpType").val(1); $("#curcount").val(cur);
		 *     if (cur >= count) { ... jQuery.post(".../mycourse/changeCapter", {...}) }
		 *   }
		 * 两个关键：
		 *   1) checkType 传 true 会先弹「任务点未完成」确认框并 return —— 所以必须传 false/省略
		 *   2) 只有 cur >= count 才真正发请求。cur 是页面全局计数（通常 1），
		 *      之前传 tabCount(2) 时 1 >= 2 不成立，函数静默什么都不做 —— 这才是"点了没反应"的真因
		 * 所以第一个参数传 '0'，恒满足 cur >= 0。
		 */
		try {
			const count = '0';
			if (argc >= 6) {
				win.PCount.next(count, info.chapterId, info.courseId, info.clazzId, '', false);
			} else {
				win.PCount.next(count, info.chapterId, info.courseId, info.clazzId, '');
			}
			const after = (() => {
				try {
					const el = info.doc.querySelector('#curChapterId');
					return el ? String(el.value == null ? '' : el.value).trim() : '';
				} catch (e) {
					return '';
				}
			})();
			if (after && after !== info.chapterId) {
				log('PCount.next 现场就把 #curChapterId 改成了 ' + after, 'success');
			}
			return true;
		} catch (e) {
			log('PCount.next 抛错：' + (e && e.message), 'error');
			return false;
		}
	}

	/** 点掉「当前章节还有任务点未完成」的确认框 */
	function tryConfirmBox() {
		const info = readIds();
		if (!info) return false;
		const doc = info.doc;
		let cands = [];
		try {
			cands = Array.from(doc.querySelectorAll('.con03 a, .con03 input[type=button], a.jb_btn.jb_btn_92.fr'));
		} catch (e) {}
		for (const el of cands) {
			const txt = (el.textContent || el.value || '').trim();
			if (!/^下一节|^下一章/.test(txt)) continue;
			if (el.id === 'prevNextFocusNext') continue;
			if (!isVisible(el)) continue;
			try {
				el.click();
				return true;
			} catch (e) {}
		}
		return false;
	}

	/**
	 * 页面上的「下一节」按钮/弹窗里的「下一节」，onclick 都写成
	 *   PCount.next('2','CHAPTER_ID','COURSE_ID','CLAZZ_ID','',true)
	 * 其中的 chapterId 是渲染时写死的。页面前进过几节后它就和真实当前节对不上了，
	 * 点下去等于"从旧位置重新跳到当前节" → 原地打转。
	 * 这里先把 onclick 里的 chapterId 改成真实的当前章节，再点。
	 */
	function patchAndClickNext(info) {
		const doc = info.doc;
		const want = info.chapterId;
		let targets = [];
		try {
			const b = doc.querySelector('#prevNextFocusNext');
			if (b) targets.push(b);
		} catch (e) {}
		try {
			doc.querySelectorAll('.con03 a, a.bluebtn02.prebutton.nextChapter, a.jb_btn.jb_btn_92.fr').forEach((a) => targets.push(a));
		} catch (e) {}

		for (const el of targets) {
			const oc = el.getAttribute('onclick') || '';
			if (!/PCount\.next/.test(oc)) continue;
			const txt = (el.textContent || '').replace(/\s+/g, '').trim();
			if (el.id !== 'prevNextFocusNext' && !/^(下一节|下一章)/.test(txt)) continue;

			const m = oc.match(/PCount\.next\(\s*'([^']*)'\s*,\s*'([^']+)'/);
			if (!m) continue;
			const oldId = m[2];
			let fixed = oc;
			if (oldId !== want) {
				fixed = oc.replace(/(PCount\.next\(\s*'[^']*'\s*,\s*')([^']+)(')/, (mm, a, _b, c) => a + want + c);
				try {
					el.setAttribute('onclick', fixed);
					log('修正「' + (el.id || txt) + '」的 onclick：' + oldId + ' → ' + want, 'info');
				} catch (e) {}
			}
			try {
				el.click();
				return true;
			} catch (e) {}
		}
		return false;
	}

	/* ==========================================================
	 * 6.5 方案 B：自己把本节的媒体任务点播完
	 * ========================================================== */
	function safeHref(doc) {
		try {
			return (doc.location && doc.location.href) || '';
		} catch (e) {
			return '';
		}
	}

	function catalogList() {
		const info = readIds();
		if (!info) return { info: null, items: [], activeIdx: -1 };
		let items = [];
		try {
			items = Array.from(info.doc.querySelectorAll('.posCatalog_select'));
		} catch (e) {}
		let activeIdx = -1;
		try {
			activeIdx = items.findIndex((el) => el.classList && el.classList.contains('posCatalog_active'));
		} catch (e) {}
		return { info: info, items: items, activeIdx: activeIdx };
	}

	/**
	 * 点章节目录里的第 idx 项。
	 * 这套皮肤的目录项没有 inline onclick（所以 OCS 的 getTeacherAjax 选择器一个都匹配不到），
	 * 但它们是真能点的——事件绑在元素自身/父容器上，el.click() 会走到同一条路径。
	 */
	function clickCatalogItem(idx) {
		const c = catalogList();
		if (!c.items.length) return false;
		const el = c.items[idx];
		if (!el) return false;
		const name = el.querySelector('.posCatalog_name') || el;
		try {
			name.scrollIntoView && name.scrollIntoView({ block: 'center' });
		} catch (e) {}
		const fire = (node, type) => {
			try {
				const view = node.ownerDocument.defaultView || window;
				node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: view, button: 0 }));
				return true;
			} catch (e) {
				return false;
			}
		};
		fire(name, 'mousedown');
		fire(name, 'mouseup');
		if (!fire(name, 'click')) {
			try {
				name.click();
			} catch (e) {}
		}
		return true;
	}

	/** 扫描所有文档里的 video/audio，返回总数与已完成数 */
	/**
	 * 这个元素算不算"真实任务点"。
	 * 超星会在 knowledge/cards 页里塞一个 <audio>，src 指向 cards 的 HTML 地址，
	 * 一加载就 err=4(SRC_NOT_SUPPORTED) 且永远 ended 不了 —— 它是个进度钩子，不是任务点。
	 * 把它算进分母，本节就永远被判成"未完成"，方案 B 直接死锁。
	 *
	 * 注意：只能靠 error 判断。别再拿 src 的扩展名去猜 —— 超星的视频地址长这样：
	 *   https://s2.cldisk.com/sv-w9/video/6a/4e/7f/703c7d97cb4302025ef7c2baaf4
	 * 压根没有 .mp4 后缀，靠扩展名会把真视频一起误杀。
	 */
	function isRealMedia(v) {
		try {
			if (v.error) return false;
			const src = String(v.currentSrc || v.src || '');
			if (!src) return false;
			return true;
		} catch (e) {
			return false;
		}
	}

	/* ---------- 一节内的 tab（1 典型案例 / 2 基本内涵）---------- */
	/** 读 #prev_tab 里的分组 tab：每个 tab 是独立知识点，全都得学 */
	function tabState(doc) {
		if (!doc) return null;
		let ul = null;
		try {
			ul = doc.querySelector('#prev_tab .prev_ul') || doc.querySelector('.prev_ul');
		} catch (e) {}
		if (!ul) return null;
		let items = [];
		try {
			items = Array.from(ul.querySelectorAll('li'));
		} catch (e) {}
		if (items.length < 2) return null;
		const isOn = function (s) {
			return /(^|[\s_-])(active|current|cur|selected|on)([\s_-]|$)/i.test(String(s || ''));
		};
		let idx = -1;
		items.forEach(function (li, i) {
			let c = '';
			try {
				c = String(li.className || '');
			} catch (e) {}
			if (isOn(c)) idx = i;
		});
		if (idx < 0) {
			items.forEach(function (li, i) {
				let a = null;
				try {
					a = li.querySelector('a');
				} catch (e) {}
				if (a && isOn(a.className)) idx = i;
			});
		}
		return { ul: ul, items: items, idx: idx, total: items.length, keys: items.map(tabKey) };
	}

	/** tab 的稳定标识：优先 id(dct1/dct2)，其次 cardid，最后下标 */
	function tabKey(li, i) {
		let k = '';
		try {
			k = String(li.id || li.getAttribute('cardid') || '');
		} catch (e) {}
		return k || 'i' + i;
	}

	function tabLabel(li) {
		let t = '';
		try {
			t = String((li && li.textContent) || '');
		} catch (e) {}
		return t.replace(/\s+/g, ' ').trim().slice(0, 24);
	}

	function switchTab(tab, i) {
		const li = tab && tab.items && tab.items[i];
		if (!li) return false;
		// 优先直接调换页函数：onclick="changeDisplayContent(N,2,chapterId,courseId,clazzId,'')"
		let oc = '';
		try {
			oc = String(li.getAttribute('onclick') || '');
		} catch (e) {}
		const m = oc.match(/changeDisplayContent\(([^)]*)\)/);
		if (m) {
			try {
				const own = li.ownerDocument && li.ownerDocument.defaultView;
				const args = m[1].split(',').map(function (a) {
					a = a.trim();
					return /^['"]/.test(a) ? a.replace(/^['"]|['"]$/g, '') : Number(a);
				});
				const fns = [own, window, window.top];
				for (let k = 0; k < fns.length; k++) {
					try {
						if (fns[k] && typeof fns[k].changeDisplayContent === 'function') {
							fns[k].changeDisplayContent.apply(fns[k], args);
							return true;
						}
					} catch (e) {}
				}
			} catch (e) {}
		}
		let target = li;
		try {
			target = li.querySelector('a') || li;
		} catch (e) {}
		try {
			target.click();
			return true;
		} catch (e) {
			return false;
		}
	}

	/**
	 * 本节 tab 的已学记录持久化。整页刷新会把 JS 上下文连同 rt 一起清掉，
	 * 不存 localStorage 就会反复切同一个 tab、反复点开同一个附件。
	 * key 用 courseId|activeIdx（activeIdx 是节在目录里的下标，能区分同章的多个节）。
	 */
	function tabsKeyOf() {
		const info = readIds();
		if (!info) return '';
		return 'ocs-auto-next:tabs:' + info.courseId + '|' + info.activeIdx;
	}

	function syncTabsKey() {
		const k = tabsKeyOf();
		if (!k || rt.tabsKey === k) return;
		rt.tabsKey = k;
		try {
			rt.tabsSeen = JSON.parse(localStorage.getItem(k) || '{}') || {};
		} catch (e) {
			rt.tabsSeen = {};
		}
	}

	function saveTabsSeen() {
		if (!rt.tabsKey) return;
		try {
			localStorage.setItem(rt.tabsKey, JSON.stringify(rt.tabsSeen || {}));
		} catch (e) {}
	}

	function mediaDone() {
		const fin = finishedObjectIds();
		let total = 0;
		let done = 0;
		let preset = 0;
		for (const it of mediaList()) {
			total++;
			if (it.ended) {
				done++;
				continue;
			}
			// 已经学过的视频：加载后 currentTime 从头开始，但任务点标着"已完成"，不该重放
			if (srcIsFinished(it.srcFull, fin)) {
				done++;
				preset++;
				continue;
			}
			const dur = it.dur;
			if (dur && isFinite(dur) && dur > 0 && dur - it.cur < 1.5) done++;
		}
		return { total: total, done: done, preset: preset };
	}

	/* ---------- 附件 / 文档型任务点 ---------- */

	/**
	 * 超星把每个任务点标成 .ans-job-icon，已完成的再加 .ans-job-finished。
	 * 视频类带 .ans-job-video / .ans-job-audio，其余（文档、附件、阅读材料）就是要
	 * "打开并停留"才会被记录的那种。
	 */
	function jobPoints() {
		const out = [];
		for (const d of allDocs()) {
			let els = [];
			try {
				els = Array.from(d.querySelectorAll('.ans-job-icon'));
			} catch (e) {}
			for (const el of els) {
				let cls = '';
				try {
					cls = String(el.className || '');
				} catch (e) {}
				let pcls = '';
				try {
					pcls = el.parentElement ? String(el.parentElement.className || '') : '';
				} catch (e) {}
				out.push({
					el: el,
					cls: cls,
					parentCls: pcls,
					finished: jobStateOf(el),
					media: /ans-job-(video|audio)/i.test(cls)
				});
			}
		}
		return out;
	}

	/**
	 * 任务点状态。最可靠的是站点自己写的 aria-label：
	 *   <div class="ans-job-icon ans-job-video" aria-label="任务点未完成">
	 *   <div class="ans-job-icon ans-job-video" aria-label="任务点已完成">
	 * 其次是 .ans-job-finished 类，最后是旁边的「✓ 任务点已完成」文字。
	 */
	function jobStateOf(el) {
		let s = el;
		for (let i = 0; i < 3 && s; i++) {
			let al = '';
			try {
				al = String((s.getAttribute && s.getAttribute('aria-label')) || '');
			} catch (e) {}
			if (/任务点已完成/.test(al)) return true;
			if (/任务点未完成/.test(al)) return false;
			try {
				s = s.parentElement;
			} catch (e) {
				break;
			}
		}
		if (jobFinishedByClass(el)) return true;
		if (jobFinishedByText(el)) return true;
		return false;
	}

	/**
	 * 收集"已完成"任务点对应的 objectid，用来把 video 和它所属的任务点对上。
	 * 站点结构：
	 *   <div class="ans-attach-ct videoContainer">
	 *     <div class="ans-job-icon" aria-label="任务点已完成">
	 *     <iframe class="ans-attach-online ans-insertvideo-online"
	 *             data='{"objectid":"75962f4868ba0d499faac9b371087fb3",...}'>
	 * 而 video 的 currentSrc 里就带着同一个 objectid。
	 */
	function finishedObjectIds() {
		const ids = {};
		for (const d of allDocs()) {
			let ifs = [];
			try {
				ifs = Array.from(d.querySelectorAll('iframe[data]'));
			} catch (e) {
				continue;
			}
			for (const f of ifs) {
				let raw = '';
				try {
					raw = String(f.getAttribute('data') || '');
				} catch (e) {}
				const m = raw.match(/"objectid"\s*:\s*"([0-9a-zA-Z]+)"/);
				if (!m) continue;
				let ctn = null;
				try {
					ctn = f.parentElement;
				} catch (e) {}
				if (!ctn) continue;
				let icon = null;
				try {
					icon = ctn.querySelector('.ans-job-icon');
				} catch (e) {}
				if (!icon) continue;
				if (jobStateOf(icon)) ids[m[1]] = true;
			}
		}
		return ids;
	}

	/** 这个视频地址是不是属于一个已完成的任务点 */
	function srcIsFinished(src, ids) {
		const s = String(src || '');
		if (!s || !ids) return false;
		for (const id in ids) {
			if (id && s.indexOf(id) >= 0) return true;
		}
		return false;
	}

	/**
	 * 完成标记不在 .ans-job-icon 身上，而在它的父层 .ans-job-finished 上：
	 *   <div class="ans-attach-ct ans-job-finished">
	 *     <div class="ans-job-icon"></div>
	 *     <iframe src="/ananas/modules/pdf/index.html" ...>
	 *   </div>
	 */
	function jobFinishedByClass(el) {
		let s = el;
		for (let i = 0; i < 3 && s; i++) {
			let cls = '';
			try {
				cls = String(s.className || '');
			} catch (e) {}
			if (/ans-job-finished/i.test(cls)) return true;
			try {
				s = s.parentElement;
			} catch (e) {
				break;
			}
		}
		return false;
	}

	/**
	 * 这个皮肤的 .ans-job-icon 不带状态类，只用旁边一行绿字「✓ 任务点已完成」
	 * 表示完成，所以往上找 3 层看文本。
	 */
	function jobFinishedByText(el) {
		let scope = null;
		try {
			scope = el.parentElement;
		} catch (e) {
			return false;
		}
		for (let i = 0; i < 3 && scope; i++) {
			let t = '';
			try {
				t = String(scope.textContent || '');
			} catch (e) {}
			if (/任务点已完成/.test(t)) return true;
			if (/任务点未完成|去完成/.test(t)) return false;
			try {
				scope = scope.parentElement;
			} catch (e) {
				break;
			}
		}
		return false;
	}

	/** 未完成的非媒体任务点（附件查阅 / 文档阅读） */
	function pendingAttachJobs() {
		return jobPoints().filter(function (j) {
			return !j.finished && !j.media;
		});
	}

	function attachKeyOf(j) {
		let t = '';
		try {
			t = String((j.el.parentElement && j.el.parentElement.textContent) || '')
				.replace(/\s+/g, ' ')
				.trim()
				.slice(0, 60);
		} catch (e) {}
		return j.cls + '|' + t;
	}

	/** 把附件/文档任务点点开：先点图标本身，再找同一张卡片里的链接或内嵌 iframe */
	function openJobPoint(j) {
		let ok = false;
		try {
			j.el.click();
			ok = true;
		} catch (e) {}
		let scope = null;
		try {
			scope = j.el.closest('.ans-job-wrap, .task-condition, .ans-attach-ct, li, .card') || j.el.parentElement;
		} catch (e) {}
		if (scope) {
			let cand = null;
			try {
				cand = scope.querySelector('a[href]:not([href^="javascript:"]), [onclick], iframe, .ans-attach');
			} catch (e) {}
			if (cand) {
				try {
					if (String(cand.tagName).toUpperCase() === 'IFRAME') {
						cand.focus();
					} else {
						cand.click();
					}
					ok = true;
				} catch (e) {}
			}
		}
		return ok;
	}

	/** 采集所有 media 元素的实时状态 */
	function mediaReport() {
		const out = [];
		for (const d of allDocs()) {
			let vids = [];
			try {
				vids = Array.from(d.querySelectorAll('video, audio'));
			} catch (e) {}
			for (const v of vids) {
				try {
					out.push({
						el: v,
						tag: v.tagName.toLowerCase(),
						paused: !!v.paused,
						ended: !!v.ended,
						dur: v.duration,
						cur: v.currentTime,
						ready: v.readyState,
						muted: v.muted,
						src: String(v.currentSrc || v.src || '').slice(0, 70),
						srcFull: String(v.currentSrc || v.src || ''),
						err: v.error ? v.error.code : 0,
						pausedByErr: false
					});
				} catch (e) {}
			}
		}
		return out;
	}

	/**
	 * 去重后的媒体列表。
	 *
	 * 超星会给同一个视频塞两个 <video>：一个是真播放器（ready=4），一个是隐藏副本
	 * （ready=0、cur 走自己的）。实测诊断里两行同 src：
	 *   媒体#1 video cur=71 dur=114 ready=4
	 *   媒体#3 video cur=37 dur=NaN ready=0   ← 同一个 65994da06bf3...
	 * 不去重的话分母虚高（媒体 3/4 永远到不了 4/4），而且副本会把真播放器顶停。
	 * 按 src 合并，保留「更有信息量」的那个。
	 */
	function mediaList() {
		const byKey = new Map();
		const score = function (x) {
			return (x.ready > 0 ? 8 : 0) + (x.paused ? 0 : 4) + (x.cur > 0 ? 2 : 0) + (x.ended ? 16 : 0);
		};
		for (const it of mediaReport()) {
			if (!isRealMedia(it.el)) continue;
			it.key = it.srcFull;
			const prev = byKey.get(it.key);
			if (!prev || score(it) > score(prev)) byKey.set(it.key, it);
		}
		return Array.from(byKey.values());
	}

	/** 点播放器自己的播放按钮（超星 ananas / video.js，光 play() 往往推不动） */
	function clickPlayerButton(v) {
		let doc = null;
		try {
			doc = v.ownerDocument;
		} catch (e) {
			return false;
		}
		const sels = [
			'.vjs-big-play-button',
			'.vjs-play-control.vjs-paused',
			'.prism-big-play-btn',
			'.play-btn',
			'[class*="big-play"]',
			'div[class*="play"][onclick]',
			'button[class*="play"]'
		];
		for (const s of sels) {
			let el = null;
			try {
				el = doc.querySelector(s);
			} catch (e) {}
			if (el && isVisible(el)) {
				try {
					el.click();
					return true;
				} catch (e) {}
			}
		}
		return false;
	}

	/**
	 * 一页多个视频时，不要来回抢播放权。
	 *
	 * 旧逻辑每轮找「第一个没播完的」就 play()，于是：
	 *   OCS 切到任务点②、① 变 paused → 下一轮我们又 play ①
	 *   → 播放器单例把②顶停 → 再下一轮 play ② → 又顶停①
	 * 几个视频集体在原处踏步，日志里就是「播几秒第一个、又去第二个」。
	 *
	 * 新规则：
	 *   1. 已经有视频在播 → 只跟着它（调倍速/静音），绝不 play 别的
	 *   2. 都没在播 → 先接上次锁定的目标，其次挑 cur>0 未完成的，最后才挑新的
	 *   3. 锁定的目标 play 后 12 秒位置一动不动 → 判死，2 分钟内不再碰它
	 */
	function driveMedia() {
		const rate = Number(cfg.rate) || 2;
		const fin = finishedObjectIds();
		const list = mediaList().filter(function (it) {
			return !it.ended && !srcIsFinished(it.srcFull, fin);
		});
		if (!list.length) return false;

		const dead = rt.deadMedia || (rt.deadMedia = {});
		const isDead = function (k) {
			return !!dead[k] && now() - dead[k] < 120000;
		};
		const playable = function (it) {
			return !(it.dur && isFinite(it.dur) && it.dur > 0 && it.dur - it.cur < 1.5);
		};

		let target = null;
		let needPlay = false;

		// ① 有在播的 —— 跟随，不抢
		const playing = list.find(function (it) {
			return !it.paused;
		});
		if (playing) {
			target = playing;
		} else {
			// ② 都没播 —— 先看上次锁定的那个
			if (rt.mediaKey && !isDead(rt.mediaKey)) {
				const t = list.find(function (it) {
					return it.key === rt.mediaKey;
				});
				if (t && playable(t)) target = t;
			}
			// ③ 没有就挑：已开始未完成的优先，全新的其次
			if (!target) {
				const pool = list.filter(function (it) {
					return !isDead(it.key);
				});
				const src = pool.length ? pool : list;
				target =
					src.find(function (it) {
						return it.cur > 0 && playable(it);
					}) || src.find(playable) || null;
			}
			needPlay = !!target;
		}
		if (!target) return false;

		// 换目标时重置「推不动」计时，同一目标位置有变化就刷新
		if (target.key !== rt.mediaKey) {
			rt.mediaKey = target.key;
			rt.mediaAt = now();
			rt.mediaCur = target.cur;
		} else if (target.cur !== rt.mediaCur) {
			rt.mediaCur = target.cur;
			rt.mediaAt = now();
		}

		const v = target.el;
		try {
			v.muted = true; // 不静音浏览器不让自动播
		} catch (e) {}
		try {
			if (v.playbackRate !== rate) v.playbackRate = rate;
		} catch (e) {}

		if (needPlay) {
			if (target.ready === 0) clickPlayerButton(v);
			try {
				const p = v.play();
				if (p && p.catch) p.catch(function () {});
			} catch (e) {}
			// 12 秒推不动 → 判死，换下一个，别把整节卡在它身上
			if (now() - (rt.mediaAt || 0) > 12000 && Math.abs((target.cur || 0) - (rt.mediaCur || 0)) < 0.5) {
				dead[target.key] = now();
				rt.mediaKey = '';
				log(
					'媒体推不动，跳过：' + Math.round(target.cur || 0) + '/' + (isFinite(target.dur) ? Math.round(target.dur) : '?') + 's',
					'info'
				);
			}
		}

		// 节流：每 30 秒最多记一次，别把日志刷爆
		if (now() - (rt.lastDriveLogAt || 0) > 30000) {
			rt.lastDriveLogAt = now();
			log(
				(needPlay ? '驱动播放：' : '跟随播放：') +
					Math.round(target.cur || 0) +
					'/' +
					(isFinite(target.dur) ? Math.round(target.dur) : '?') +
					's（' +
					rate +
					'x，静音）',
				'info'
			);
		}
		return true;
	}

	/** 换节 / 换 tab 时清掉媒体锁定与判死记录，否则新页面的视频会被旧 key 挡住 */
	function resetMediaState() {
		rt.mediaKey = '';
		rt.mediaAt = 0;
		rt.mediaCur = -1;
		rt.deadMedia = {};
		rt.idleSince = 0;
		rt.mediaPassed = false;
	}

	/**
	 * 方案 B 主循环：
	 *   - cfg.learn（自己放视频）开着   → 自己 play() + 判断完成 + 跳节
	 *   - cfg.learn 关掉            → 不碰播放（让 OCS 放），但仍然判断“这节学完了没”，完成了就跳
	 * 关掉 learn 不等于关掉整个循环，否则「让 OCS 管播放、脚本管跳节」这个组合根本无法实现。
	 */
	function tickLearn() {
		if (!cfg.enabled || rt.busy) return;
		if (rt.endReached) return;
		if (now() - rt.lastJumpAt < 15000) return; // 刚跳完，等页面渲染

		const m = mediaDone();
		rt.mediaInfo = m;

		if (m.total > 0) rt.noMediaSince = 0;

		// 任务点标记比 video 元素的 ended 更可靠：页面刷新后 video 会重置成
		// cur=0 / ready=0 / dur=NaN，但 .ans-job-finished 还挂在父层上。
		// 实测（第 199 节）：4 个视频全是 ready=0，脚本却一直「接手驱动」0/?s 死循环。
		const allJobs = jobPoints();
		if (allJobs.length) rt.sawJobs = true;
		const jobsAllDone =
			allJobs.length > 0 &&
			allJobs.every(function (j) {
				return j.finished;
			});
		if (jobsAllDone && m.total > 0 && m.done < m.total) {
			rt.learnNote = '任务点已全部完成，忽略视频元素的 ready=0';
			log('任务点全部已完成，不再重播（视频元素状态不同步）', 'info');
		}

		// 有没有任何视频真的在播（决定该不该等 / 该不该接手）
		const playingNow = mediaReport().some(function (it) {
			return isRealMedia(it.el) && !it.paused;
		});
		if (playingNow) {
			rt.idleSince = 0;
		} else if (!rt.idleSince) {
			rt.idleSince = now();
		}
		// 90 秒一格没动、任务点又不是全绿 → 本节在这个页面上推不动了（多半是已经学过，
		// 只是任务点标记没刷新），别再耗着
		if (!playingNow && rt.idleSince && now() - rt.idleSince > 90000 && !rt.mediaPassed) {
			rt.mediaPassed = true;
			log('媒体 90 秒没有任何播放，本节可能已学过，放行跳节', 'warn');
		}

		// 有未完成的媒体 → 驱动播放，继续等
		if (m.total > 0 && m.done < m.total && !jobsAllDone && !rt.mediaPassed) {
			rt.learnNote =
				'媒体 ' +
				m.done +
				'/' +
				m.total +
				' 已完成，' +
				(playingNow ? '正在播放' : cfg.learn ? '正在推进' : '等 OCS 播放') +
				(m.preset ? '（跳过 ' + m.preset + ' 个已学）' : '');

			// 3 分钟一格不动就提醒
			let sum = 0;
			for (const it of mediaReport()) sum += it.cur || 0;
			if (Math.abs(sum - (rt.mediaSum || 0)) > 0.5) {
				rt.mediaSum = sum;
				rt.stallAt = now();
				rt.stallWarned = false;
			} else if (now() - (rt.stallAt || now()) > 180000 && !rt.stallWarned) {
				rt.stallWarned = true;
				log('媒体 3 分钟没有任何进度，点「诊断」看详情', 'warn');
			}

			if (cfg.learn) {
				if (now() - rt.lastDriveAt > 2500) {
					rt.lastDriveAt = now();
					driveMedia();
				}
			} else if (!playingNow && now() - rt.idleSince > 30000) {
				// 「让 OCS 管」不等于「永远不碰」：OCS 报完「任务点为空」就不再点播放了
				if (String(rt.learnNote || '').indexOf('脚本接手驱动') < 0) {
					log('30 秒没有视频在播，OCS 似乎放弃了本节，脚本接手', 'warn');
				}
				rt.learnNote = 'OCS 没在播放，脚本接手驱动';
				// 先点开未完成的媒体任务点，触发视频加载（ready=0 就是没人点过它）
				if (now() - (rt.lastPickAt || 0) > 8000) {
					rt.lastPickAt = now();
					const vjobs = allJobs.filter(function (j) {
						return !j.finished && j.media;
					});
					if (vjobs.length) openJobPoint(vjobs[0]);
				}
				if (now() - rt.lastDriveAt > 2500) {
					rt.lastDriveAt = now();
					driveMedia();
				}
			}
			return;
		}

		// 附件/文档型任务点：没有视频，但必须打开并停留够时间才算完成
		const jobs = jobPoints();
		if (jobs.length) rt.sawJobs = true;
		const attach = jobs.filter(function (j) {
			return !j.finished && !j.media;
		});
		rt.attachInfo = { pending: attach.length };
		if (attach.length) {
			const j = attach[0];
			const key = attachKeyOf(j);
			if (rt.attachKey !== key) {
				rt.attachKey = key;
				rt.attachSince = now();
				rt.attachRound = 0;
				rt.attachPassed = false;
				rt.noMediaSince = 0;
				openJobPoint(j);
				log(
					'发现 ' +
						attach.length +
						' 个未完成的附件/文档任务点，已点开，停留 ' +
						Math.round(cfg.attachWait / 1000) +
						' 秒',
					'warn'
				);
			}
			const waited = now() - (rt.attachSince || now());
			if (waited < cfg.attachWait) {
				rt.learnNote =
					'附件任务点查阅中 ' +
					Math.ceil((cfg.attachWait - waited) / 1000) +
					's（还剩 ' +
					attach.length +
					' 个未完成）';
				return;
			}
			if ((rt.attachRound || 0) < cfg.attachRounds) {
				rt.attachRound = (rt.attachRound || 0) + 1;
				rt.attachSince = now();
				openJobPoint(j);
				log('附件任务点仍未标记完成，再停留一轮（' + rt.attachRound + '/' + cfg.attachRounds + '）', 'warn');
				rt.learnNote = '附件任务点重试停留 ' + rt.attachRound + '/' + cfg.attachRounds;
				return;
			}
			log('附件任务点停留到上限仍显示未完成，放行跳节', 'warn');
			rt.attachPassed = true;
			rt.attachKey = '';
			rt.attachRound = 0;
		} else {
			rt.attachKey = '';
			rt.attachRound = 0;
		}

		// 既没媒体也没附件任务点：可能是纯文字节，也可能是任务点还没渲染出来
		if (m.total === 0 && !rt.attachPassed) {
			// 任务点在 iframe 里懒加载，实际要到十几秒后才出现，20 秒太短会误判成"无可学内容"
			const waitMs = Number(cfg.noMediaWait) || 12000;
			if (!rt.noMediaSince) {
				rt.noMediaSince = now();
				rt.learnNote = '本节暂未发现可学任务点，等 ' + Math.round(waitMs / 1000) + ' 秒确认';
				return;
			}
			if (now() - rt.noMediaSince < waitMs) {
				rt.learnNote =
					'本节暂未发现可学任务点，确认中 ' + Math.ceil((waitMs - (now() - rt.noMediaSince)) / 1000) + 's';
				return;
			}
		}

		// 本节可能有多个 tab（1 典型案例 / 2 基本内涵），每个 tab 是独立知识点
		const tab = tabState(studyDoc());
		if (tab) {
			syncTabsKey();
			if (tab.idx >= 0) rt.tabsSeen[tab.keys[tab.idx]] = true;
			let nextI = -1;
			for (let i = 0; i < tab.total; i++) {
				if (!rt.tabsSeen[tab.keys[i]]) {
					nextI = i;
					break;
				}
			}
			if (nextI >= 0 && switchTab(tab, nextI)) {
				rt.tabsSeen[tab.keys[nextI]] = true;
				saveTabsSeen();
				log('本节还有未学的 tab，切到第 ' + (nextI + 1) + '/' + tab.total + ' 个：' + tabLabel(tab.items[nextI]), 'warn');
				rt.learnNote = '切换到 tab ' + (nextI + 1) + '/' + tab.total;
				// 新 tab 的任务点从头计时
				rt.attachKey = '';
				rt.attachSince = 0;
				rt.attachRound = 0;
				rt.attachPassed = false;
				rt.noMediaSince = 0;
				resetMediaState();
				return;
			}
		}

		// 到这里：媒体全完成 / 附件已停留 / 所有 tab 已走完 / 确认本节没有任务点
		rt.tabsKey = '';
		rt.tabsSeen = {};
		rt.learnNote = '本节任务点已完成，准备跳下一节';
		log(
			'本节任务点完成（媒体 ' +
				m.done +
				'/' +
				m.total +
				(attach.length ? '，附件停留 ' + Math.round(cfg.attachWait / 1000) + 's' : '') +
				'），跳下一节',
			'success'
		);
		rt.noMediaSince = 0;
		rt.attachPassed = false;
		jumpOnce('本节任务点已完成');
	}

	/** 生成跳节尝试序列 */
	function buildPlan(info) {
		const doc = info.doc;
		// 顺序按实测有效性排：点目录项会整页刷新，这是确定能跳的那一种；
		// PCount.next 常被 checkUnsave()/checkJob() 挡住，退居第二。
		return [
			{
				name: '点章节目录的下一项',
				run: () => {
					const c = catalogList();
					if (c.activeIdx < 0 || !c.items.length) return false;
					if (c.activeIdx + 1 >= c.items.length) {
						log('当前已是目录最后一项（' + (c.activeIdx + 1) + '/' + c.items.length + '）', 'info');
						return false;
					}
					return clickCatalogItem(c.activeIdx + 1);
				}
			},
			{ name: 'PCount.next(显式 false)', run: () => callPCount(info, 6) },
			{ name: '修正 onclick 后点「下一节」', run: () => patchAndClickNext(info) },
			{
				name: '「下一节」链接',
				run: () => clickFirst(doc, ['a.bluebtn02.prebutton.nextChapter', 'a.nextChapter', 'a.nextbutton', '.nextbutton'])
			},
			{
				name: '微专题「下一个」',
				run: () => {
					const t = topicNextButton();
					if (!t) return false;
					t.click();
					return true;
				}
			}
		];
	}

	async function waitChapterChange(before, timeout) {
		const beforeId = before && before.chapterId ? before.chapterId : '';
		const beforeHref = before && before.href ? before.href : '';
		const beforeSig = (before && before.frameSig) || '';
		const beforeTab = (before && before.tabText) || '';
		const beforeLabel = (before && before.activeLabel) || '';
		const beforeLen = before && typeof before.mainLen === 'number' ? before.mainLen : 0;
		let deadline = now() + timeout;
		const hardDeadline = now() + timeout * 3; // 页面正在导航时最多再等这么久
		let sawLoading = false;

		while (now() < deadline) {
			await sleep(250);
			const info = readIds();
			if (!info) {
				// 学习页暂时消失 = 多半正在切页导航，别急着换下一级方式（会连跳两节）
				sawLoading = true;
				deadline = Math.min(Math.max(deadline, now() + 6000), hardDeadline);
				continue;
			}

			// 超星跳节的铁证：源码里写死了先 document.getElementById("mainid").innerHTML
			// = "…loading.gif…"，再 POST changeCapter 把内容填回来。抓到这个过程就是真跳了。
			if (info.mainLen > 0 && info.mainLen < 1600) sawLoading = true;
			if (sawLoading && info.mainLen > 3000) return { ok: true, why: 'mainid重建' };

			if (beforeId && info.chapterId !== beforeId) return { ok: true, why: 'chapterId' };
			if (beforeHref && info.href && info.href !== beforeHref) return { ok: true, why: 'href' };
			if (beforeSig && info.frameSig && info.frameSig !== beforeSig) {
				return { ok: true, why: 'frameSig' };
			}
			// #prev_tab 里的小节标签换了 = 真的换了一节
			if (beforeTab && info.tabText && info.tabText !== beforeTab) {
				return { ok: true, why: 'tabText' };
			}
			// 目录高亮那一项的标题换了（跨章/跨子节时一定变）
			if (beforeLabel && info.activeLabel && info.activeLabel !== beforeLabel) {
				return { ok: true, why: 'activeLabel' };
			}
			// #mainid 内容长度剧变（新节内容量不同）。放大阈值，避免小抖动误判。
			if (beforeLen > 2000 && info.mainLen > 0) {
				const ratio = Math.abs(info.mainLen - beforeLen) / beforeLen;
				if (ratio > 0.4) return { ok: true, why: 'mainLen' };
			}
		}
		return { ok: false };
	}

	/* ---- 两阶段提交：点目录项会让整页刷新，JS 上下文直接没了，
	 *      所以"是否跳成功"必须在刷新后的新页面里确认。 ---- */
	function setPendingJump(from, stepName) {
		try {
			localStorage.setItem(
				PENDING_KEY,
				JSON.stringify({
					t: Date.now(),
					fromIdx: from && typeof from.activeIdx === 'number' ? from.activeIdx : -1,
					fromLabel: (from && from.activeLabel) || '',
					fromChapterId: (from && from.chapterId) || '',
					step: stepName,
					total: rt.jumpCount
				})
			);
		} catch (e) {}
	}

	function clearPendingJump() {
		try {
			localStorage.removeItem(PENDING_KEY);
		} catch (e) {}
	}

	/** 页面刷新后调用：看上一次尝试到底跳没跳成 */
	function confirmPendingJump(retry) {
		retry = retry || 0;
		let p = null;
		try {
			p = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null');
		} catch (e) {}
		if (!p) return;

		if (Date.now() - (p.t || 0) > 180000) {
			clearPendingJump();
			return;
		}

		const info = readIds();
		if (!info) {
			// 页面还没就绪，别急着清 pending —— 清了证据就丢了
			if (retry < 10) {
				setTimeout(() => {
					try {
						confirmPendingJump(retry + 1);
						updatePanel();
					} catch (e) {}
				}, 1500);
			}
			return;
		}

		clearPendingJump();

		const moved =
			(p.fromIdx >= 0 && info.activeIdx >= 0 && info.activeIdx !== p.fromIdx) ||
			(p.fromLabel && info.activeLabel && info.activeLabel !== p.fromLabel) ||
			(p.fromChapterId && info.chapterId && info.chapterId !== p.fromChapterId);

		if (!moved) {
			log('刷新后确认：上一次「' + p.step + '」没跳成，仍在原节', 'warn');
			return;
		}

		rt.jumpCount = (p.total || 0) + 1;
		try {
			localStorage.setItem(COUNT_KEY, String(rt.jumpCount));
		} catch (e) {}

		log(
			'确认跳节成功（' + p.step + '，页面已刷新）→ 第 ' +
				(info.total ? info.activeIdx + 1 + '/' + info.total + ' 节 ' : '') +
				(info.activeLabel || '?') +
				'（累计 ' + rt.jumpCount + ' 次）',
			'success'
		);

		try {
			localStorage.setItem(
				LAST_JUMP_KEY,
				JSON.stringify({
					time: ts(),
					from: (p.fromLabel || '?') + (p.fromIdx >= 0 ? '（第 ' + (p.fromIdx + 1) + '）' : ''),
					to: (info.activeLabel || '?') + (info.total ? '（第 ' + (info.activeIdx + 1) + '/' + info.total + '）' : ''),
					why: '页面刷新',
					by: p.step,
					total: rt.jumpCount
				})
			);
		} catch (e) {}
	}

	async function jumpOnce(trigger) {
		if (rt.busy) return false;
		if (!cfg.enabled) return false;
		if (now() - rt.lastJumpAt < cfg.cooldown) return false;
		if (rt.endReached) return false;

		rt.busy = true;
		try {
			const info = readIds();
			if (!info) {
				const t = topicNextButton();
				if (t) {
					log('找不到学习页，改用微专题「下一个」', 'warn');
					t.click();
					rt.jumpCount++;
					return true;
				}
				// 页面可能还在加载：先不累计失败，超过 90 秒才算真失败
				if (!rt.noPageSince) rt.noPageSince = now();
				const waitedNoPage = now() - rt.noPageSince;
				if (waitedNoPage < 90000) {
					if (now() - (rt.lastNoPageLogAt || 0) > 20000) {
						rt.lastNoPageLogAt = now();
						log('还定位不到学习页（#curChapterId），等页面加载…已等 ' + Math.round(waitedNoPage / 1000) + 's', 'warn');
					}
					return false;
				}
				rt.noPageSince = 0;
				rt.failCount++;
				log('跳节失败：找不到学习页（#curChapterId）', 'error');
				if (rt.failCount >= cfg.maxFail) {
					rt.endReached = true;
					log('连续 ' + cfg.maxFail + ' 次定位不到学习页，已停止。', 'error');
				}
				return false;
			}
			rt.noPageSince = 0;

			const before = info;
			const fromText =
				(info.activeLabel || info.chapterId) + (info.total ? '（第 ' + (info.activeIdx + 1) + '/' + info.total + ' 节）' : '');
			log('开始跳节（' + trigger + '）：' + fromText, 'warn');

			for (const step of buildPlan(info)) {
				let launched = false;
				try {
					launched = step.run() !== false;
				} catch (e) {
					log(step.name + ' 异常：' + (e && e.message), 'error');
				}
				if (!launched) {
					log('「' + step.name + '」不可用，跳过', 'info');
					continue;
				}
				log('尝试：' + step.name, 'info');
				setPendingJump(before, step.name);
				// 点目录项会整页刷新，JS 会直接死掉 —— 等太久没意义，短等一下就换下一级
				const waitMs = /目录的下一项/.test(step.name) ? 6000 : 12000;
				const r = await waitChapterChange(before, waitMs);
				if (r.ok) {
					clearPendingJump();
					rt.failCount = 0;
					rt.jumpCount++;
					try {
						localStorage.setItem(COUNT_KEY, String(rt.jumpCount));
					} catch (e) {}
					// 换了新一节，方案 B 的计时全部重来
					rt.noMediaSince = 0;
					rt.lastDriveAt = 0;
					rt.lastDriveLogAt = 0;
					const after = readIds();
					rt.lastChapterId = after ? after.chapterId : '';
					log(
						'成功（' + step.name + ' / ' + r.why + '）→ 第 ' +
							(after && after.total ? (after.activeIdx + 1) + '/' + after.total + ' 节 ' : '') +
							(after && after.activeLabel ? after.activeLabel : '?') +
							'  chapterId ' + (before && before.chapterId ? before.chapterId : '?') +
							' → ' + (after ? after.chapterId : '?') +
							'（累计 ' + rt.jumpCount + ' 次）',
						'success'
					);
					// 记一条"上次跳节"，存 localStorage —— 跳节后页面整个刷新也能看到，
					// 不用盯着日志抢那一瞬间。
					try {
						localStorage.setItem(
							LAST_JUMP_KEY,
							JSON.stringify({
								time: ts(),
								from: (before.activeLabel || '?') + (before.total ? '（第 ' + (before.activeIdx + 1) + '/' + before.total + '）' : ''),
								to: (after && after.activeLabel ? after.activeLabel : '?') +
									(after && after.total ? '（第 ' + (after.activeIdx + 1) + '/' + after.total + '）' : ''),
								why: r.why,
								by: step.name,
								total: rt.jumpCount
							})
						);
					} catch (e) {}
					return true;
				}
				log('「' + step.name + '」没有让章节前进，换下一级', 'info');
			}

			rt.failCount++;
			log('所有方式都没生效（连续失败 ' + rt.failCount + '/' + cfg.maxFail + '）', 'error');
			if (rt.failCount >= cfg.maxFail) {
				rt.endReached = true;
				log('判定已到最后一节，自动跳节结束。切到别的课程或刷新页面会重新开始。', 'success');
			}
			return false;
		} catch (e) {
			log('跳节异常：' + (e && e.message), 'error');
			return false;
		} finally {
			rt.busy = false;
			rt.lastJumpAt = now();
			resetMediaState();
			updatePanel();
		}
	}

	function pause(reason) {
		cfg.enabled = false;
		rt.autoPausedReason = reason || '';
		saveCfg();
		log('已暂停：' + (reason || '手动关闭'), 'warn');
		updatePanel();
	}

	/* ==========================================================
	 * 7. 通道 B —— 监听 OCS 面板（closed shadow DOM）里的提示文本
	 *    OCS 面板用 attachShadow({mode:"closed"})，普通 DOM 查不到，只能 hook
	 * ========================================================== */
	let shadowHookInstalled = false;
	const shadowSeen = new WeakSet();
	let toastTriggeredAt = 0;

	function installShadowHook() {
		const targets = [];
		try {
			targets.push(window.Element);
		} catch (e) {}
		try {
			if (typeof unsafeWindow !== 'undefined' && unsafeWindow.Element !== window.Element) {
				targets.push(unsafeWindow.Element);
			}
		} catch (e) {}

		let hookedAny = false;
		targets.forEach((El) => {
			try {
				const proto = El && El.prototype;
				if (!proto || !proto.attachShadow || proto.__autoNextHooked) return;
				const orig = proto.attachShadow;
				proto.attachShadow = function (init) {
					const root = orig.call(this, init);
					try {
						if (root) watchShadowRoot(root);
					} catch (e) {}
					return root;
				};
				proto.__autoNextHooked = true;
				hookedAny = true;
			} catch (e) {}
		});

		shadowHookInstalled = hookedAny;
		if (!hookedAny) log('shadow 监听未安装（OCS 面板可能已先创建）', 'warn');
	}

	function watchShadowRoot(root) {
		try {
			if (!root || shadowSeen.has(root)) return;
			shadowSeen.add(root);
		} catch (e) {
			return;
		}

		const scan = throttle(() => {
			if (!cfg.enabled || !cfg.useToastDetect) return;
			let text = '';
			try {
				text = root.textContent || '';
			} catch (e) {
				return;
			}
			if (/页面任务点数量为空|任务点数量为空/.test(text)) onEmptyToast();
		}, 500);

		try {
			new MutationObserver(scan).observe(root, { childList: true, subtree: true, characterData: true });
		} catch (e) {}
	}

	function onEmptyToast() {
		if (now() - toastTriggeredAt < 2500) return;
		toastTriggeredAt = now();
		if (!cfg.enabled || rt.busy || rt.endReached) return;

		// OCS 报「任务点数量为空」只是说它解析不到章节目录，**不代表本节学完了**。
		// 实测（第 200 节）：视频 cur=24/161 还在播，OCS 一报错脚本就跳走，把学习打断。
		// 所以先看真实完成度，还有没播完的视频就不跳。
		const m = mediaDone();
		if (m.total > 0 && m.done < m.total) {
			const key = m.done + '/' + m.total;
			if (rt.toastWaitKey !== key) {
				rt.toastWaitKey = key;
				rt.toastWaitAt = now();
			}
			if (now() - (rt.toastWaitAt || now()) < 180000) {
				rt.learnNote =
					'OCS 报任务点为空，但本节还有 ' + (m.total - m.done) + ' 个视频没播完，等播完再跳';
				return;
			}
			log('媒体 3 分钟没进展，不再等，放行跳节', 'warn');
		}
		rt.toastWaitKey = '';
		jumpOnce('OCS 提示任务点为空');
	}

	/* ==========================================================
	 * 8. 面板
	 * ========================================================== */
	let ui = null;

	function buildUI() {
		if (ui) return;
		const host = document.createElement('div');
		host.id = 'ocs-auto-next-helper';
		host.style.cssText =
			'position:fixed;right:16px;bottom:16px;z-index:2147483646;font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;';
		const root = host.attachShadow({ mode: 'open' });

		const style = document.createElement('style');
		style.textContent = `
			*{box-sizing:border-box}
			.wrap{width:252px;background:rgba(22,25,31,.94);color:#e8ecf2;border:1px solid rgba(255,255,255,.10);
				border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.34);overflow:hidden;font-size:12px;backdrop-filter:blur(8px)}
			.head{display:flex;align-items:center;gap:6px;padding:8px 10px;background:rgba(255,255,255,.05)}
			.dot{width:7px;height:7px;border-radius:50%;background:#3ddc84;box-shadow:0 0 6px #3ddc84;flex:none}
			.dot.off{background:#8a8f98;box-shadow:none}
			.dot.busy{background:#ffb020;box-shadow:0 0 6px #ffb020}
			.title{flex:1;font-weight:600;letter-spacing:.3px}
			.mini{all:unset;cursor:pointer;color:#9aa3af;padding:0 4px;font-size:14px;line-height:1}
			.mini:hover{color:#fff}
			.body{padding:8px 10px 10px}
			.row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:7px}
			.row label{color:#aab2bd}
			input[type=number]{background:#2a2f38;color:#e8ecf2;border:1px solid rgba(255,255,255,.12);
				border-radius:6px;padding:3px 6px;font-size:12px;outline:none;width:70px}
			.sw{position:relative;width:34px;height:19px;border-radius:10px;background:#3a404a;cursor:pointer;transition:.15s;flex:none}
			.sw.on{background:#2f7d4f}
			.sw::after{content:"";position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;
				background:#fff;transition:.15s}
			.sw.on::after{left:17px}
			.btns{display:flex;gap:6px;margin:8px 0 6px}
			.btn{all:unset;flex:1;text-align:center;padding:5px 0;border-radius:7px;background:#2a2f38;color:#dfe5ee;
				cursor:pointer;border:1px solid rgba(255,255,255,.09);font-size:12px}
			.btn:hover{background:#343a45}
			.btn.primary{background:#2f6fd0;border-color:transparent}
			.btn.primary:hover{background:#3a7ee6}
			.status{padding:5px 7px;border-radius:7px;background:rgba(255,255,255,.05);color:#c2c9d4;
				margin-bottom:6px;line-height:1.5;word-break:break-all}
			.status b{color:#fff;font-weight:600}
			.lastjump{display:none;margin:-2px 0 6px;padding:3px 6px;border-radius:6px;
				background:rgba(61,220,132,.10);color:#7fe0a4;font-size:11px;line-height:1.45;word-break:break-all}
			.logbox{max-height:96px;overflow:auto;border-top:1px solid rgba(255,255,255,.08);padding-top:6px}
			.logline{color:#8d97a5;line-height:1.55;word-break:break-all}
			.logline.s{color:#5fd08a}
			.logline.w{color:#ffc14d}
			.logline.e{color:#ff6b6b}
			.hidden{display:none}
			.minbar{width:46px;height:46px;border-radius:50%;background:#2f7d4f;color:#fff;
				border:2px solid rgba(255,255,255,.55);display:flex;align-items:center;justify-content:center;
				cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.45),0 0 0 4px rgba(47,125,79,.28);
				font-size:19px;user-select:none;animation:mbPulse 2.4s ease-in-out infinite}
			.minbar:hover{background:#3a9a62;transform:scale(1.06)}
			@keyframes mbPulse{0%,100%{box-shadow:0 6px 20px rgba(0,0,0,.45),0 0 0 4px rgba(47,125,79,.28)}
				50%{box-shadow:0 6px 20px rgba(0,0,0,.45),0 0 0 9px rgba(47,125,79,.06)}}
		`;

		const wrap = document.createElement('div');
		wrap.className = 'wrap';
		wrap.innerHTML = `
			<div class="head">
				<div class="dot" id="dot"></div>
				<div class="title">自动下一节 <span style="font-weight:400;color:#7b8492">v${VERSION}</span></div>
				<button class="mini" id="min" title="折叠">—</button>
			</div>
			<div class="body" id="body">
				<div class="status" id="status">等待学习页…</div>
				<div class="lastjump" id="lastjump"></div>
				<div class="row"><label>启用</label><div class="sw on" id="sw-enable"></div></div>
				<div class="row"><label>自己驱动播放</label><div class="sw on" id="sw-learn"></div></div>
				<div class="row"><label>倍速</label><input type="number" id="inp-rate" min="1" max="16" step="0.5"></div>
				<div class="row"><label>间隔(ms)</label><input type="number" id="inp-cd" min="1000" max="60000" step="500"></div>
				<div class="row"><label>附件停留(s)</label><input type="number" id="inp-aw" min="5" max="600" step="5"></div>
				<div class="row"><label>空节确认(s)</label><input type="number" id="inp-nw" min="3" max="120" step="1"></div>
				<div class="btns">
					<button class="btn primary" id="btn-jump">跳一节</button>
					<button class="btn" id="btn-reset">清零</button>
					<button class="btn" id="btn-diagnose">诊断</button>
					<button class="btn" id="btn-probe">结构</button>
					<button class="btn" id="btn-upload">上传结构</button>
				</div>
				<div class="logbox" id="logbox"></div>
			</div>
			<div class="minbar hidden" id="minbar" title="展开">⏭</div>
		`;

		// 折叠条必须挂在 wrap 外面 —— wrap 一旦 display:none，里面的东西全跟着消失
		const minbarEl = wrap.querySelector('#minbar');
		if (minbarEl) wrap.removeChild(minbarEl);
		root.append(style, wrap);
		if (minbarEl) root.appendChild(minbarEl);
		document.documentElement.appendChild(host);

		ui = {
			host: host,
			root: root,
			dot: root.getElementById('dot'),
			body: root.getElementById('body'),
			wrap: wrap,
			minbar: root.getElementById('minbar'),
			status: root.getElementById('status'),
			lastjump: root.getElementById('lastjump'),
			logbox: root.getElementById('logbox'),
			swEnable: root.getElementById('sw-enable'),
			swLearn: root.getElementById('sw-learn'),
			inpRate: root.getElementById('inp-rate'),
			inpCd: root.getElementById('inp-cd'),
			inpAw: root.getElementById('inp-aw'),
			inpNw: root.getElementById('inp-nw')
		};

		ui.root.getElementById('min').addEventListener('click', () => setMinimized(true));
		ui.minbar.addEventListener('click', () => setMinimized(false));

		ui.swEnable.addEventListener('click', () => {
			cfg.enabled = !cfg.enabled;
			if (cfg.enabled) {
				rt.autoPausedReason = '';
				rt.jumpCount = 0;
				rt.failCount = 0;
				rt.lastJumpAt = 0;
				rt.endReached = false;
			}
			saveCfg();
			updatePanel();
			log(cfg.enabled ? '已启用' : '已关闭', 'info');
		});

		ui.inpCd.addEventListener('change', () => {
			const v = parseInt(ui.inpCd.value, 10);
			cfg.cooldown = !isNaN(v) && v >= 1000 ? v : 8000;
			ui.inpCd.value = cfg.cooldown;
			saveCfg();
		});

		ui.swLearn.addEventListener('click', () => {
			cfg.learn = !cfg.learn;
			saveCfg();
			updatePanel();
			log(cfg.learn ? '自己驱动播放：脚本 play + 判断完成 + 跳节' : '不碰播放：由 OCS 放，脚本只判断完成 + 跳节', 'info');
		});

		ui.inpRate.addEventListener('change', () => {
			const v = parseFloat(ui.inpRate.value);
			cfg.rate = !isNaN(v) && v >= 1 && v <= 16 ? v : 2;
			ui.inpRate.value = cfg.rate;
			saveCfg();
		});

		ui.inpAw.addEventListener('change', () => {
			const v = parseInt(ui.inpAw.value, 10);
			cfg.attachWait = !isNaN(v) && v >= 5 && v <= 600 ? v * 1000 : 10000;
			ui.inpAw.value = Math.round(cfg.attachWait / 1000);
			saveCfg();
		});

		ui.inpNw.addEventListener('change', () => {
			const v = parseInt(ui.inpNw.value, 10);
			cfg.noMediaWait = !isNaN(v) && v >= 3 && v <= 120 ? v * 1000 : 12000;
			ui.inpNw.value = Math.round(cfg.noMediaWait / 1000);
			saveCfg();
		});

		ui.root.getElementById('btn-jump').addEventListener('click', () => {
			rt.endReached = false;
			rt.lastJumpAt = 0;
			jumpOnce('手动');
		});

		ui.root.getElementById('btn-reset').addEventListener('click', () => {
			rt.jumpCount = 0;
			rt.failCount = 0;
			try {
				localStorage.removeItem(COUNT_KEY);
				localStorage.removeItem(LAST_JUMP_KEY);
				localStorage.setItem(RESET_KEY, '1');
			} catch (e) {}
			updatePanel();
			log('跳节计数已清零，从当前节重新数', 'info');
		});

		ui.root.getElementById('btn-diagnose').addEventListener('click', () => diagnose());
		ui.root.getElementById('btn-upload').addEventListener('click', () => sendProbe());
		ui.root.getElementById('btn-probe').addEventListener('click', () => {
			try {
				showProbe();
			} catch (e) {
				log('探针失败：' + (e && e.message), 'error');
			}
		});

		setMinimized(cfg.minimized && true);
		updatePanel();
		renderLogs();
	}

	function setMinimized(v) {
		cfg.minimized = !!v;
		saveCfg();
		if (!ui) return;
		ui.wrap.classList.toggle('hidden', !!v);
		ui.minbar.classList.toggle('hidden', !v);
	}

	function updatePanel() {
		if (!ui) return;
		const en = cfg.enabled;
		ui.dot.className = 'dot' + (rt.busy ? ' busy' : en ? '' : ' off');
		ui.swEnable.className = 'sw' + (en ? ' on' : '');
		ui.swLearn.className = 'sw' + (cfg.learn ? ' on' : '');
		const ae = (ui.root && ui.root.activeElement) || document.activeElement;
		if (ae !== ui.inpCd) ui.inpCd.value = cfg.cooldown;
		if (ae !== ui.inpRate) ui.inpRate.value = cfg.rate;
		if (ae !== ui.inpAw) ui.inpAw.value = Math.round(cfg.attachWait / 1000);
		if (Number(ui.inpNw.value) !== Math.round((Number(cfg.noMediaWait) || 12000) / 1000))
			ui.inpNw.value = Math.round((Number(cfg.noMediaWait) || 12000) / 1000);

		let s = '';
		if (!en) {
			s = '<b>已暂停</b>' + (rt.autoPausedReason ? '：' + rt.autoPausedReason : '');
		} else if (rt.busy) {
			s = '<b>正在跳节…</b>';
		} else if (rt.endReached) {
			s = '<b>已到最后一节</b>，跳节结束';
		} else {
			const info = readIds();
			if (!info) {
				s = '等待学习页加载…';
			} else {
				s =
					'当前：<b>' + (info.activeLabel || info.chapterId) + '</b>' +
					(info.total ? ' · 第 ' + (info.activeIdx + 1) + '/' + info.total + ' 节' : '') ;
			}
		}
		s += '<br>累计跳节 <b>' + rt.jumpCount + '</b> 次' + (rt.failCount ? ' · 失败 ' + rt.failCount : '');
		if (cfg.learn && rt.learnNote) s += '<br><span style="color:#8d97a5">' + escapeHtml(rt.learnNote) + '</span>';
		ui.status.innerHTML = s;

		// 上次跳节（localStorage 持久化）：跳节后页面整个刷新也能看到
		try {
			const lj = JSON.parse(localStorage.getItem(LAST_JUMP_KEY) || 'null');
			if (lj && lj.to) {
				ui.lastjump.textContent = '上次跳节 ' + (lj.time || '') + '：' + lj.from + ' → ' + lj.to + '（累计 ' + (lj.total || 0) + '）';
				ui.lastjump.style.display = 'block';
			} else {
				ui.lastjump.style.display = 'none';
			}
		} catch (e) {}
	}

	function renderLogs() {
		if (!ui) return;
		const html = rt.logs
			.slice(-30)
			.map((l) => {
				const cls = l.type === 'success' ? 's' : l.type === 'warn' ? 'w' : l.type === 'error' ? 'e' : '';
				return `<div class="logline ${cls}">${l.time} ${escapeHtml(l.msg)}</div>`;
			})
			.join('');
		ui.logbox.innerHTML = html;
		ui.logbox.scrollTop = ui.logbox.scrollHeight;
	}

	function escapeHtml(s) {
		return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
	}

	/* ==========================================================
	 * 9. 诊断 / 结构探针
	 * ========================================================== */
	/* ---------- 结构上报：把真实 DOM 传给本地服务，供离线分析 ---------- */
	function collectProbe() {
		const out = {
			version: VERSION,
			url: String(location.href),
			time: new Date().toISOString(),
			docs: [],
			jobs: [],
			jobTexts: [],
			media: [],
			ids: null
		};
		const squash = function (s, n) {
			return String(s || '')
				.replace(/\s+/g, ' ')
				.trim()
				.slice(0, n || 600);
		};
		const docs = allDocs();
		docs.forEach(function (d, i) {
			let href = '?';
			let title = '';
			try {
				href = String(d.location.href);
			} catch (e) {}
			try {
				title = String(d.title || '');
			} catch (e) {}
			out.docs.push({ i: i, href: href.slice(0, 300), title: title.slice(0, 80) });
		});
		docs.forEach(function (d, di) {
			let icons = [];
			try {
				icons = Array.from(d.querySelectorAll('.ans-job-icon'));
			} catch (e) {}
			icons.forEach(function (el, k) {
				const chain = [];
				let s = el;
				for (let up = 0; up < 6 && s; up++) {
					let html = '';
					try {
						html = squash(s.outerHTML, 900);
					} catch (e) {}
					chain.push({
						level: up,
						tag: String(s.tagName || ''),
						cls: squash(s.className, 200),
						text: squash(s.textContent, 200),
						html: html
					});
					try {
						s = s.parentElement;
					} catch (e) {
						break;
					}
				}
				out.jobs.push({ doc: di, index: k, cls: squash(el.className, 200), chain: chain });
			});

			let all = [];
			try {
				all = Array.from(d.querySelectorAll('body *'));
			} catch (e) {}
			for (const el of all) {
				let t = '';
				try {
					t = String(el.textContent || '');
				} catch (e) {}
				if (t.length > 200) continue;
				if (!/任务点|去完成/.test(t)) continue;
				let html = '';
				try {
					html = squash(el.outerHTML, 700);
				} catch (e) {}
				out.jobTexts.push({
					doc: di,
					tag: String(el.tagName || ''),
					cls: squash(el.className, 120),
					id: String(el.id || ''),
					text: squash(t, 160),
					html: html
				});
				if (out.jobTexts.length > 60) break;
			}
		});
		for (const it of mediaReport()) {
			out.media.push({
				tag: it.tag,
				paused: it.paused,
				dur: isFinite(it.dur) ? Math.round(it.dur) : null,
				cur: Math.round(it.cur || 0),
				ready: it.ready,
				err: it.err,
				src: it.src
			});
		}
		try {
			const info = readIds();
			if (info) {
				out.ids = {
					chapterId: info.chapterId,
					courseId: info.courseId,
					clazzId: info.clazzId,
					activeIdx: info.activeIdx,
					activeLabel: info.activeLabel,
					total: info.total,
					tabCount: info.tabCount
				};
			}
		} catch (e) {}
		try {
			const sdoc = studyDoc();
			const tab = tabState(sdoc);
			if (tab) {
				out.tabs = {
					idx: tab.idx,
					total: tab.total,
					ulCls: String((tab.ul && tab.ul.className) || ''),
					items: tab.items.map(function (li, i) {
						let html = '';
						try {
							html = squash(li.outerHTML, 400);
						} catch (e) {}
						return { i: i, cls: String(li.className || ''), text: tabLabel(li), html: html };
					})
				};
			}
		} catch (e) {}
		return out;
	}

	function sendProbe() {
		let body = '';
		try {
			body = JSON.stringify(collectProbe());
		} catch (e) {
			log('结构收集失败：' + e.message, 'error');
			return;
		}
		log('正在上传结构（' + Math.round(body.length / 1024) + ' KB）…', 'info');
		fetch('http://127.0.0.1:18080/probe', {
			method: 'POST',
			mode: 'cors',
			headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
			body: body
		})
			.then(function (r) {
				return r.json();
			})
			.then(function (j) {
				log('结构已上传 → ' + j.file, 'success');
			})
			.catch(function (e) {
				log('上传失败：' + e.message + '（本地服务没开？）', 'error');
			});
	}

	function diagnose() {
		const docs = allDocs();
		const info = readIds();
		log('—— 诊断 ——', 'info');
		log('可访问文档：' + docs.length + ' 个', 'info');
		if (!info) {
			log('没有找到含 #curChapterId 的学习页（可能在跨域 iframe 里）', 'error');
			return;
		}
		log('chapterId=' + info.chapterId + ' courseId=' + info.courseId + ' clazzId=' + info.clazzId, 'info');
		log('当前节：' + (info.activeLabel || '未识别') + '（第 ' + (info.activeIdx + 1) + '/' + info.total + ' 节，tab 数 ' + info.tabCount + '）', 'info');
		let pc = '不可用';
		let pkeys = '';
		let pargc = '';
		try {
			const w = info.doc.defaultView;
			if (w && w.PCount) {
				pc = typeof w.PCount.next === 'function' ? '可用' : '不可用';
				try {
					pkeys = Object.keys(w.PCount).join(',');
				} catch (e) {}
				try {
					pargc = typeof w.PCount.next === 'function' ? String(w.PCount.next.length) : '-';
				} catch (e) {}
			}
		} catch (e) {}
		log('PCount.next：' + pc + '；失败计数：' + rt.failCount + '；已到末尾：' + (rt.endReached ? '是' : '否'), 'info');
		if (pkeys) log('PCount 成员：' + pkeys, 'info');
		if (pargc) log('PCount.next 形参个数：' + pargc, 'info');
		const btn = (() => {
			try {
				return info.doc.querySelector('#prevNextFocusNext');
			} catch (e) {
				return null;
			}
		})();
		log('「下一节」按钮：' + (btn ? '存在，可见=' + (isVisible(btn) ? '是' : '否') : '不存在'), 'info');
		const boxEls = (() => {
			try {
				return info.doc.querySelectorAll('.con03 a').length;
			} catch (e) {
				return -1;
			}
		})();
		log('确认框 .con03 内链接数：' + boxEls, 'info');
		log('shadow 监听：' + (shadowHookInstalled ? '已安装' : '未安装'), 'info');
		try {
			const w = info.doc.defaultView;
			if (w && w.PCount && typeof w.PCount.next === 'function') {
				log('PCount.next 源码：' + String(w.PCount.next).replace(/\s+/g, ' ').slice(0, 900), 'info');
			}
		} catch (e) {}

		// 媒体状态：看 play() 到底卡在哪
		const rep = mediaReport();
		if (!rep.length) {
			log('媒体：没找到 video/audio 元素', 'warn');
		} else {
			rep.forEach((it, i) => {
				log(
					'媒体#' + i + ' <' + it.tag + '> paused=' + it.paused +
						' ended=' + it.ended +
						' cur=' + Math.round(it.cur || 0) +
						' dur=' + (isFinite(it.dur) ? Math.round(it.dur) : 'NaN') +
						' ready=' + it.ready +
						' muted=' + it.muted +
						' err=' + it.err,
					'info'
				);
				if (it.src) log('        src=' + it.src, 'info');
			});
			const uniq = mediaList();
			if (uniq.length !== rep.filter(function (x) { return isRealMedia(x.el); }).length) {
				log(
					'        去重后：' + uniq.length + ' 个不同视频（同 src 的隐藏副本已合并）',
					'info'
				);
			}
			log(
				'        当前锁定：' + (rt.mediaKey ? rt.mediaKey.slice(-12) : '无') +
					'；判死：' + Object.keys(rt.deadMedia || {}).length + ' 个',
				'info'
			);
		}
		// 任务点：区分视频型与附件/文档型
		const jobs = jobPoints();
		if (!jobs.length) {
			log('任务点：没找到 .ans-job-icon（这个皮肤可能只写文本）', 'warn');
			const txt = jobTextStatus();
			log('        文本兜底：已完成 ' + txt.done + ' 处、未完成 ' + txt.undone + ' 处', 'info');
		} else {
			const fin = jobs.filter((j) => j.finished).length;
			const att = jobs.filter((j) => !j.finished && !j.media).length;
			log('任务点：共 ' + jobs.length + ' 个，已完成 ' + fin + ' 个，待完成附件/文档 ' + att + ' 个', 'info');
			jobs.forEach((j, i) => {
				log(
					'  任务点#' +
						i +
						' ' +
						(j.finished ? '[已完成]' : '[未完成]') +
						' ' +
						(j.media ? '[媒体]' : '[附件/文档]') +
						' ' +
						j.cls +
						' < ' +
						(j.parentCls || '?'),
					'info'
				);
			});
		}
		const btnHit = (() => {
			try {
				const v = rep[0] && rep[0].el;
				if (!v) return '无';
				const d = v.ownerDocument;
				const n = d.querySelectorAll(
					'.vjs-big-play-button, .vjs-play-control, .prism-big-play-btn, [class*="big-play"]'
				).length;
				return String(n) + ' 个候选播放按钮';
			} catch (e) {
				return '探测失败';
			}
		})();
		log('播放按钮：' + btnHit, 'info');
	}

	function probe() {
		const L = [];
		const push = (s) => L.push(s);
		const clip = (s, n) =>
			String(s == null ? '' : s)
				.replace(/[\r\n\t]+/g, ' ')
				.replace(/\s+/g, ' ')
				.trim()
				.slice(0, n || 90);
		const desc = (el) => {
			if (!el || !el.tagName) return 'null';
			const tag = el.tagName.toLowerCase();
			const id = el.id ? '#' + el.id : '';
			let cls = '';
			if (typeof el.className === 'string' && el.className.trim()) {
				cls = '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.');
			}
			return tag + id + cls;
		};

		push('=== OCS 自动下一节 · 结构探针 v' + VERSION + ' ===');
		push('时间: ' + new Date().toLocaleString());
		push('URL: ' + location.href);

		const docs = allDocs();
		push('可访问 document 数: ' + docs.length);

		const info = readIds();
		if (info) {
			push('');
			push('【学习页定位成功】');
			push('  chapterId=' + info.chapterId + ' / courseId=' + info.courseId + ' / clazzId=' + info.clazzId);
			push('  目录项 ' + info.total + ' 个，当前索引 ' + (info.activeIdx + 1) + '，tab 数 ' + info.tabCount);
			push('  当前节：' + clip(info.activeLabel, 40));
			let w = null;
			try {
				w = info.doc.defaultView;
			} catch (e) {}
			push('  PCount.next = ' + (w && w.PCount && typeof w.PCount.next === 'function' ? '可用' : '不可用'));
			const btn = info.doc.querySelector('#prevNextFocusNext');
			push('  #prevNextFocusNext = ' + (btn ? '存在 onclick=' + clip(btn.getAttribute('onclick'), 90) : '不存在'));

			try {
				const items = info.doc.querySelectorAll('.posCatalog_select');
				if (items.length) {
					push('');
					push('【目录项前 3 个的属性（找 chapterId 藏在哪）】');
					for (let i = 0; i < Math.min(3, items.length); i++) {
						const el = items[i];
						const attrs = Array.from(el.attributes)
							.map((a) => a.name + '=' + clip(a.value, 70))
							.join(' | ');
						push('  [' + i + '] <' + el.tagName.toLowerCase() + '> ' + attrs);
						push('      text=' + clip(el.textContent, 60));
						push('      html=' + clip(el.innerHTML, 260));
					}
				}
			} catch (e) {}
		} else {
			push('');
			push('【学习页未定位】');
		}

		docs.forEach((doc, di) => {
			let href = '';
			try {
				href = (doc.location && doc.location.href) || '';
			} catch (e) {
				href = '(跨域)';
			}
			if (di > 3) return;
			push('');
			push('--- doc#' + di + ' ' + clip(href, 100) + ' ---');
			const cnt = (sel) => {
				try {
					return doc.querySelectorAll(sel).length;
				} catch (e) {
					return -1;
				}
			};
			push(
				'  posCatalog=' + cnt('.posCatalog_select') +
					' ; active=' + cnt('.posCatalog_active') +
					' ; curChapterId=' + cnt('#curChapterId') +
					' ; prevNextFocusNext=' + cnt('#prevNextFocusNext')
			);
		});

		const t = topicNextButton();
		if (t) {
			push('');
			push('微专题「下一个」控件：' + desc(t) + ' onclick=' + clip(t.getAttribute('onclick'), 80));
		}

		push('');
		push('=== 探针结束 ===');
		return L.join('\n');
	}

	function showProbe() {
		const text = probe();
		try {
			console.log(text);
		} catch (e) {}

		let host = document.getElementById('ocs-auto-next-probe');
		if (host) host.remove();
		host = document.createElement('div');
		host.id = 'ocs-auto-next-probe';
		host.style.cssText =
			'position:fixed;inset:0;z-index:2147483647;background:rgba(8,10,14,.86);display:flex;' +
			'align-items:center;justify-content:center;font-family:system-ui,"Microsoft YaHei",sans-serif;';
		const box = document.createElement('div');
		box.style.cssText =
			'width:min(900px,92vw);height:min(78vh,760px);display:flex;flex-direction:column;gap:10px;' +
			'background:#12151a;border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:14px;';
		box.innerHTML =
			'<div style="display:flex;align-items:center;gap:10px;color:#e8ecf2;font-size:14px">' +
			'<b style="flex:1">结构探针结果</b>' +
			'<span style="color:#8d97a5;font-size:12px">全选复制后发给开发者</span>' +
			'</div>';
		const ta = document.createElement('textarea');
		ta.value = text;
		ta.style.cssText =
			'flex:1;width:100%;resize:none;background:#0b0e13;color:#c8d2de;border:1px solid rgba(255,255,255,.10);' +
			'border-radius:8px;padding:10px;font:12px/1.6 Consolas,"Courier New",monospace;outline:none;';
		const btns = document.createElement('div');
		btns.style.cssText = 'display:flex;gap:8px';
		const mkBtn = (label, primary) => {
			const b = document.createElement('button');
			b.textContent = label;
			b.style.cssText =
				'all:unset;cursor:pointer;text-align:center;padding:8px 16px;border-radius:8px;font-size:13px;color:#fff;' +
				'background:' + (primary ? '#2f6fd0' : '#2a2f38') + ';border:1px solid ' + (primary ? 'transparent' : 'rgba(255,255,255,.10)');
			return b;
		};
		const bCopy = mkBtn('复制全部', true);
		bCopy.addEventListener('click', () => {
			ta.focus();
			ta.select();
			let ok = false;
			try {
				ok = document.execCommand('copy');
			} catch (e) {}
			if (!ok && navigator.clipboard) {
				navigator.clipboard.writeText(ta.value).catch(() => {});
			}
			bCopy.textContent = '已复制';
			setTimeout(() => (bCopy.textContent = '复制全部'), 1500);
		});
		const bClose = mkBtn('关闭', false);
		bClose.addEventListener('click', () => host.remove());
		btns.append(bCopy, bClose);
		box.append(ta, btns);
		host.appendChild(box);
		(document.documentElement || document.body).appendChild(host);
		setTimeout(() => {
			ta.focus();
			ta.select();
		}, 50);
	}

	/* ==========================================================
	 * 10. 启动
	 * ========================================================== */
	function start() {
		loadStoredLogs();
		// 3.13.1 之前把「页面自己刷新」也计成跳节，历史计数虚高（127 次对第 97 节），
		// 升级后一次性清零，之后每节只计一次真跳节。
		try {
			if (!localStorage.getItem(RESET_KEY)) {
				localStorage.removeItem(COUNT_KEY);
				localStorage.removeItem(LAST_JUMP_KEY);
				localStorage.setItem(RESET_KEY, '1');
			}
		} catch (e) {}
		try {
			const c = parseInt(localStorage.getItem(COUNT_KEY) || '0', 10);
			if (c > 0) rt.jumpCount = c;
		} catch (e) {}
		log('脚本已加载 v' + VERSION, 'success');

		installShadowHook();

		// 上一轮是不是刚点过「下一节」然后整页刷新了？在新页面里确认结果。
		setTimeout(() => {
			try {
				confirmPendingJump();
				updatePanel();
			} catch (e) {}
		}, 1600);

		const initUI = () => {
			try {
				buildUI();
			} catch (e) {
				console.error(TAG, e);
			}
		};
		if (document.readyState === 'loading') {
			document.addEventListener('DOMContentLoaded', initUI, { once: true });
		} else {
			initUI();
		}

		// 面板状态刷新
		setInterval(() => {
			try {
				updatePanel();
			} catch (e) {}
		}, 1000);

		// 方案 B 主循环
		setInterval(() => {
			try {
				tickLearn();
			} catch (e) {
				console.error(TAG, e);
			}
		}, 3000);

		// 只在换课时重置计数（URL 微变不算，跳节本身就会改 URL）
		let lastCourseKey = '';
		setInterval(() => {
			let info = null;
			try {
				info = readIds();
			} catch (e) {}
			const key = info ? info.courseId + '|' + info.clazzId : '';
			if (key && lastCourseKey && key !== lastCourseKey) {
				rt.jumpCount = 0;
				rt.failCount = 0;
				rt.lastJumpAt = 0;
				rt.lastChapterId = '';
				rt.endReached = false;
				try {
					localStorage.setItem(COUNT_KEY, '0');
					localStorage.removeItem(PENDING_KEY);
				} catch (e) {}
				log('换了课程，计数已重置', 'info');
			}
			if (key) lastCourseKey = key;
		}, 1500);
	}

	start();
})();
