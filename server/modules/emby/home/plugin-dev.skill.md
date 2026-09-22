---
name: catpaw-home-plugin
description: 给「媒体桥面板」写 Emby 首页插件 —— 单文件 JS，声明若干「行」，每行一个 async 函数返回影片条目，客户端首页上就是一个个媒体库。当用户要加/改首页行、做「热门 · 榜单 · 分类 · 平台 · 片单」这类首页内容，或要调 TMDB / 别的 HTTP 接口喂首页时，用这份。
---

# 写一个猫爪首页插件

## 本文档的内容

一个插件的**全部契约**：文件长什么样、能写哪些字段、能调哪些能力、哪些做法会被拒。
以最后一节的「最小可跑插件」为基础修改，即可得到第一个插件。

供 AI 助手使用：把这份文件存到 skills 目录下的 `catpaw-home-plugin/SKILL.md` 即可。

---

## 一、插件是什么

**一个文件 = 一个插件。** 面板上传后在**独立子进程**里执行，它：

- 用 `HomePlugin = {…}` 声明自己叫什么、有哪些「行（row）」；
- 每行配一个**顶层 async 函数**（handler），被调用时返回一批影片条目；
- 客户端首页里，**每个启用行 = 一个媒体库**，点进去就是那个函数给的条目。

```
插件（HomeItem[]） ──▶ 面板转成 Emby 的 BaseItemDto ──▶ 客户端首页
```

要点：

- 是**纯文本 JS**，不是模块 —— **不要** `require` / `module.exports` / `export` / IIFE；
- handler 必须是**顶层函数声明**（`async function foo(ctx) {}`），面板按名字找；
- 源码上限 **1MB**，行数 1~32。

---

## 二、最小可跑插件

```js
HomePlugin = {
  id: 'my.home.trending',          // 全局唯一，见 §三
  name: '示例首页插件',
  version: '1.0.0',
  description: '本周趋势',
  rows: [
    {
      id: 'trending_week',
      title: '本周趋势',            // 客户端里那个媒体库的名字
      functionName: 'loadTrending', // 下面那个函数名
      cacheDuration: 3600,          // 秒；1 小时内复用结果
      collectionType: 'mixed',      // 影剧混装
    },
  ],
};

async function loadTrending(ctx) {
  const body = await Catpaw.tmdb.get('trending/all/week');   // 注意：不带前导斜杠
  return body.results.map((m) => ({
    id: 'tmdb_' + m.id + '_' + (m.media_type === 'tv' ? 'tv' : 'movie'),
    type: m.media_type === 'tv' ? 'tv' : 'movie',
    title: m.title || m.name,
    year: Number(String(m.release_date || m.first_air_date || '').slice(0, 4)) || undefined,
    overview: m.overview,
    rating: m.vote_average,
    poster: Catpaw.tmdb.imageUrlOf('w500', m.poster_path),   // 同步，不要 await
    backdrop: Catpaw.tmdb.imageUrlOf('w780', m.backdrop_path),
  }));
}
```

---

## 三、清单字段（`HomePlugin`）

| 字段 | 必填 | 规则 |
|---|---|---|
| `id` | 是 | `/^[a-z0-9][a-z0-9._-]{2,63}$/i`，同一面板内唯一（上传重复 id 需勾「覆盖」） |
| `name` | 是 | 面板显示名（写 `title` 也认） |
| `version` | 是 | 非空字符串，建议语义化 |
| `rows` | 是 | 数组，1~32 个 |
| `author` / `description` | — | 字符串 |

> `example.tmdb` 是**内置示例的保留 id**，不能占用（会回 409）。

## 四、行字段（`rows[]`）

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 行内唯一，`/^[a-z0-9][a-z0-9._-]{0,63}$/i`；参数与缓存按它归档 |
| `title` | 是 | 行标题 = 客户端里那个库的名字 |
| `functionName` | 是 | 顶层 async 函数名 |
| `cacheDuration` | — | 结果缓存**秒数**，`0`/缺省 = 不缓存 |
| `timeoutMs` | — | 单次执行超时，默认 `15000`，上限 `60000` |
| `collectionType` | — | 这个库是什么库：`movies` / `tvshows` / `mixed` |
| `feed` | — | 接客户端哪类「推荐查询」，目前只有 `random`（见下） |
| `params` | — | 用户可配参数，最多 16 个 |

### `collectionType` 怎么填

面板取值顺序是：**行声明** → 按这行当前的 `type` 参数推（`movie`→`movies`、`tv`→`tvshows`）→ `mixed`。所以：

- 有 `type` 参数的行**故意不写** —— 用户把参数切成「剧集」，库就该跟着变；
- 没 `type` 参数、但内容类型确定的**要写**（例：只出剧的平台行 ⇒ `tvshows`）；
- 天生混装的写 `mixed`。

### `feed: 'random'` 是什么

有些客户端**要推荐时不给库 Id**，而是直接发一条 `SortBy=IsFavoriteOrLiked,Random`（已知 Rex 首页第一发就是它）——
它喂的是**客户端首页顶部的轮播图**。

声明 `feed: 'random'` 后，面板就把那条查询路由到这一行。**没有行声明就继续回空**（面板不会随便挑一行顶上）。
声明它的那行**同时也是普通库行**，不用另做适配。

---

## 五、参数（`params`）

| `type` | 面板控件 | 说明 |
|---|---|---|
| `input` | 文本框 | `value` 是默认值 |
| `enumeration` | 下拉框 | **必须**给 `enumOptions: [{title, value}, …]` |
| `count` | 数字框 | `value` 是默认值 |
| `constant` | 不显示 | 隐藏常量 |

```js
params: [
  { name: 'kind', title: '类型', type: 'enumeration', value: 'movie',
    enumOptions: [{ title: '电影', value: 'movie' }, { title: '剧集', value: 'tv' }] },
  { name: 'country', title: '国家/地区', type: 'input', value: 'CN' },
],
```

- 参数名要匹配 `/^[A-Za-z_][A-Za-z0-9_]*$/`，同一行内不能重名；
- 用户在面板里改的值按「行 id + 参数名」覆盖默认值，**改参数不用重新上传插件**；
- handler 里用 `ctx.params.country` 读。**`type: 'count'` 不保证返回数字** —— 面板存的是文本，需自行 `Number(...)`。

---

## 六、handler 契约

```js
async function loadXxx(ctx) {
  // ctx.params     ← 面板里配的参数（唯一来源）
  // ctx.startIndex ← 客户端要的起点（原样透传，缺省 0）
  // ctx.limit      ← 客户端要的条数（原样透传，0 = 客户端没指定）
  // ctx.signal     ← AbortSignal：超时会被 abort，用它收尾自己发的请求
  // ctx.log(...)   ← 打日志到面板「面板设置 → 日志」
  return [ /* HomeItem[] */ ];
}
```

**返回值两种都行**：

- 数组 —— 客户端认为"就这一屏"，翻不动；
- `{ items, total }` —— `total` 会成为客户端分页用的总数，**想让它能往下翻就必须给**。

**失败就 `throw`。** 该行会照实报错、不写缓存；**不要**用空数组假装成功（那是编假数据）。

### 分页：客户端给出窗口，由插件换算

面板**不切片**，`StartIndex`/`Limit` 原样传给插件。取哪一页、是否请求上游，由插件决定：

```js
async function loadTopRated(ctx) {
  const PER_PAGE = 20;                          // 上游一页 20 条
  const start = ctx.startIndex || 0;
  const page = Math.floor(start / PER_PAGE) + 1;
  const offset = start % PER_PAGE;              // 客户端窗口可能落在上游这一页中间
  const limit = ctx.limit > 0 ? ctx.limit : PER_PAGE;

  const body = await Catpaw.tmdb.get('movie/top_rated', { params: { page } });
  return { items: body.results.map(toItem).slice(offset, offset + limit), total: body.total_results };
}
```

---

## 七、条目字段（HomeItem）

**只保留下面这些，其余字段一律丢弃**（不是忽略，是丢掉）。

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 行内唯一键。**强烈建议**用 `tmdb_{id}_{movie\|tv}` —— 客户端点进这一条时会来问「详情/资源」，面板正是靠这个坐标去反查 TMDB 与源；自己编的 id 也能显示，但**点进去没资源** |
| `type` | 是 | `movie` \| `tv`（其它值整条丢弃） |
| `title` | 是 | 片名 |
| `year` | — | 数字；`0`/非法丢弃 |
| `overview` | — | 简介 |
| `rating` | — | 数字；`0`/非法丢弃 |
| `originalTitle` | — | 原名 |
| `poster` / `backdrop` | — | **完整 http(s) URL**（面板不拼图床，自己拼；用 TMDB 图床见 `Catpaw.tmdb.imageUrlOf`）。不给就是没图 |
| `genres` | — | 字符串数组，最多 20 个 |
| `providerIds` | — | 对象，如 `{ Tmdb: '550' }` |
| `catpaw` | — | `{ site, vodId }`，预留：把条目绑到猫源（播放链路用） |

每行最多 **200 条**，超出的丢弃；行内 `id` 重复只留第一条。

---

## 八、能用到的能力（全局 `Catpaw`）

就这四样 —— 插件的进程**没有网络、没有磁盘**，所有外部动作都由面板代做。

| API | 返回 | 同步/异步 |
|---|---|---|
| `Catpaw.http.get(url, opts)` | `{status, headers, data}` | **异步**（要 `await`） |
| `Catpaw.http.post(url, body, opts)` | 同上 | **异步** |
| `Catpaw.tmdb.get(api, opts)` | TMDB **响应体本体**（**没有** `.data` 包装） | **异步** |
| `Catpaw.tmdb.imageUrlOf(size, path)` | 图片 URL 字符串 | **同步**（不要 `await`） |
| `Catpaw.storage.get(key)` | 值 | **同步** |
| `Catpaw.storage.set(key, value)` | value（传 `undefined` 即删除该键） | **同步** |
| `Catpaw.log(...args)` | — | **同步**（同 `ctx.log`） |

细节：

- `Catpaw.http.*` 的 `opts`：`{ headers, params, timeoutMs }`；`post` 的 `body` 是对象时自动 JSON 序列化并加 `Content-Type`；
- `Catpaw.http.*` **非 2xx 会抛错**，错误上带 `err.status` 和 `err.data`（想读错误响应体就靠它）；
- `Catpaw.tmdb.get(api, opts)` 的 `api` **不带前导斜杠**（`trending/movie/week`，不是 `/trending/...`）；`opts` 只有 `{ params }`；`language` 默认取面板设置；
- `Catpaw.storage` 是**插件私有**的 JSON（单键 ≤512KB、总量 ≤2MB）。它是**跨进程复制的快照**：
  并发跑同一插件的不同行时各持一份、**后写者覆盖** —— 只当缓存用，不宜存放关键状态。
  ⚠️ **顶层代码里不要读 `Catpaw.storage`**：上传校验时面板还不知道插件 id，读到的是空对象。要读就放 handler 里。
- `Catpaw.tmdb.imageUrlOf` 是纯拼串（本地完成，不花 IPC），调用开销可忽略；其余走 IPC 的要过一次往返，**不要在循环里成千上万次地调用**。

**不提供**：`require` / `process` / `fs` / `global` / `fetch` / `Buffer` / `XMLHttpRequest` / `eval` / `new Function`。
**自带**：`console`（接到 `Catpaw.log`）、`setTimeout` / `clearTimeout`、`URL` / `URLSearchParams`、`TextEncoder` / `TextDecoder`、`AbortController`，以及 JS 内建（`Math` / `JSON` / `Date` / `Promise` / `Array`…）。

---

## 九、必须守的三条规矩

1. **不编假数据。** 上游失败、参数不合理 —— **照实抛错**，让这一行显示失败。不要返回假条目或空数组来掩盖失败。
2. **字段是严格的。** 表里没有的字段会被丢掉；缺 `id` / `title` / 合法 `type` 的条目直接丢（面板会报告丢弃与去重的条数）。
3. **同步/异步不要弄反。** `http.*` / `tmdb.get` 要 `await`；`imageUrlOf` / `storage.*` / `log` **不要** `await`。
   返回值里出现 Promise 会**直接报错**（面板会指出是哪个字段忘了 await），不会再静默丢字段。

**常见错误**

- 忘了 `await` 就 `.map()` → 报「字段 xxx 是 Promise」；
- 顶层写 `HomePlugin` 时加了 `const` / `let` → 面板找不到它（必须裸赋值）；
- handler 写成箭头函数或塞进对象里 → 上传被拒（必须是**顶层 `function` 声明**）；
- `id` 用了 `/`、空格、中文 → 上传被拒；
- 顶层写了死循环 → 加载超时 3 秒，上传被拒。

---

## 十、运行与调试

1. 面板 **Emby → 首页插件 → 上传插件**（选 `.js` 文件）；同 `id` 改动内容要勾「覆盖同 id 插件」（已启用状态与已填参数会保留）。
2. **运行**：逐行预览，可查看条目数 / 丢弃 / 去重 / 是否命中缓存 / 耗时，以及原始 JSON。这一步**不会**写缓存，可反复执行。
3. **保存参数**：只改这一行，不影响别的行。
4. **启用**：启用的行才会出现在客户端首页（客户端可能要重启或清缓存才刷新）。
5. 出错看 **面板设置 → 日志**（`[home:<插件id>]` 前缀就是插件的日志），或 `docker logs media-bridge-panel`。

预览里报的 `ms` 是**端到端墙钟**（含起子进程约 40ms 与 IPC），不是 handler 自己的耗时 —— 那才是「点一下要等多久」。

## 十一、插件跑在哪里

- 每次执行**新起一个子进程**跑，跑完即杀 —— 插件代码**不在面板进程里**，卡死/崩溃不拖累面板；
- 那个进程由 **Node 权限模型**（`node --permission`）约束：**只允许读它自己那两份运行时代码**，
  文件读写、网络、`child_process`、`worker` 一律没有 —— 所以插件既拿不到面板的凭证文件，也发不出请求；
- 插件代码还额外跑在一个 `vm` 上下文里（`eval` / `new Function` 被关掉、没注入 `require` / `process`），
  但**`vm` 本身不是安全边界**，逃逸是存在的；**边界是那个进程的权限** —— 逃逸出去也什么都不能做；
- 残留风险：同 OS 用户、无 seccomp/namespace，Node 官方说明权限模型**不是**抗定向攻击的硬沙箱；
  面板代做的能力是**真实的**（插件能借用面板的网络与 TMDB 凭证，只是读不走 token、也改不了目标地址）。
  要更强的隔离得靠容器或独立用户。
