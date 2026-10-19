# 超星自动下一节

OCS 报「页面任务点数量为空」时，自动切到下一节。

![version](https://img.shields.io/badge/version-3.8.1-blue)
![license](https://img.shields.io/badge/license-MIT-lightgrey)

## 问题

超星新版课程皮肤把章节目录的 `onclick` 换成了事件委托，OCS 仍在用：

```js
top.document.querySelectorAll('[onclick^="getTeacherAjax"]')
```

返回空数组 → `chapters.length === 0` → 弹出「页面任务点数量为空！请刷新重试！」

刷新没用。不是空了，是它找不到。

## 方案

独立用户脚本，不修改 OCS：

1. **跨 iframe 定位** —— 学习页在第 2 层 iframe，按特征递归找
2. **判断本节是否学完** —— 视频播完 / 任务点完成 / 无媒体超时放行
3. **跳节并确认** —— 点目录项会整页刷新，所以点击前写 `localStorage`，新页面加载后比对当前节，成功才计数

内置「方案 B」：不装 OCS 也能跑，脚本自己按倍速驱动 `<video>`。

## 安装

1. 装脚本管理器 —— [ScriptCat](https://scriptcat.org/) 或 [Tampermonkey](https://www.tampermonkey.net/)
   （OCS Desktop 内置已带，无需安装）
2. 把 `ocs-auto-next.user.js` 拖进浏览器窗口 → 点「安装」
3. 打开课程学习页，点右下角绿色圆钮

## 使用

| 项 | 默认 | 说明 |
| --- | --- | --- |
| 启用 | 开 | 总开关 |
| 自己放视频 | 开 | 关掉则只判断、不驱动播放 |
| 倍速 | 2 | 建议 ≤ 2，超过容易触发风控 |
| 间隔 | 8000 | 跳节冷却（毫秒） |

按钮：`跳一节` 手动跳一次 · `诊断` 输出页面结构与媒体状态 · `结构` 探测目录 DOM。

## 工作原理

### iframe 层级

```
doc#0  mooc2-ans.chaoxing.com/mycourse/stu      外壳
doc#1  mooc1.chaoxing.com/mycourse/studentstudy 章节页
doc#2  knowledge/cards?...                      任务点
doc#3  ananas/modules/video/index.html          播放器
```

`mooc1` 与 `mooc2-ans` 都设了 `document.domain = "chaoxing.com"`，跨层可读。

### PCount.next 的坑

```js
if (cur >= count) { ...真正发 changeCapter 请求... }
```

| 传参 | 结果 |
| --- | --- |
| `count = 2`，全局 `cur = 1` | 条件为假，**静默什么都不做** |
| `checkType = true` | 反而弹确认框并 return |
| `count = '0'`，`checkType = false` | 正常跳转 |

### 跨刷新确认

点目录项是整页导航，JS 上下文随之销毁。所以：

```
点击前  localStorage['pending'] = { from, step, t }
        ↓  页面刷新
加载后  比对当前节 → 变了算成功，没变换下一级
```

### 方案 B 的两个坑

假 `<audio>`（`src` 指向 HTML 页面，`err=4`）永远播不完，会卡死进度分母：

```js
if (v.error) return false;
if (!(v.currentSrc || v.src)) return false;
```

同一节两个视频同时 `play()` 会互顶（播放器单例），改成每轮只驱动一个：

```js
const target = list.find(it => !(it.dur && it.dur - it.cur < 1.5));
```

## 兼容

- OCS Desktop 2.9.x（内置 Chrome 137 + ScriptCat 1.1.2）
- Chrome / Edge / Firefox + ScriptCat / Tampermonkey
- 皮肤：`mooc2-ans` 微专题、`studentstudy` 标准版

## FAQ

**媒体 0/0，二十秒就跳走** —— 视频没加载出来，刷新重试。
**没找到学习页** —— 未适配的皮肤，点「结构」输出结构。
**跳节后卡住** —— 间隔调到 15000。
**进度被清空** —— 触发风控。倍速降到 1，间隔 15000，停一天。

## License

MIT
