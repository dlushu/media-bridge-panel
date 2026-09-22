'use strict';
/**
 * 猫源层模块（数据源层）
 *
 *   对外：/api/sources*（本地托管源增删启停）、/api/run*（运行中的源）、/api/base*（托管源代理）
 *         /website*（配置中心同源代理）
 *   依赖：无（它是最底层，自己不消费别人）
 */
const routes = require('./routes');
const store = require('./store');
const runner = require('./runner');
const configProxy = require('./config-proxy');
const autoUpdate = require('./auto-update');

module.exports = {
  id: 'source',
  /* 侧栏分组名：**不带品牌名**——它描述的是"这层管什么"（托管源），
   * 页名「猫源地址」才是**类别**（告诉用户该填什么源）。 */
  label: '源托管',
  apiPrefix: ['/api/sources', '/api/run', '/api/base'],
  upstream: null,

  settings: {
    /* 新建托管源时的默认值 + **自动更新**（见 auto-update.js）：
     * 前者是"每个源"的初值，后者是这个模块自己的两个开关（全局，不是每个源一份）。 */
    defaults: () => ({ port: 0, host: '0.0.0.0', autostart: false, autoUpdate: false, autoUpdateHours: 12 }),
    validate: (o) => {
      if (!(Number(o.port) >= 0 && Number(o.port) <= 65535)) return 'port 取值 0~65535';
      /* 间隔允许 1~168 小时（一周）；填 0 或空会被读成默认 12 —— 但保存时先拦下来，避免被理解成"不检查" */
      if (o.autoUpdateHours != null && !(Number(o.autoUpdateHours) >= 1 && Number(o.autoUpdateHours) <= 168)) {
        return '自动更新间隔取值 1~168 小时';
      }
      return null;
    },
  },

  /** 设置保存后按新配置重排定时器（见 auto-update.js 的 apply） */
  onSettingsChange: () => autoUpdate.apply(),

  /** 开机启动自动更新的计时（server.js 在面板起来后调一次；默认关就什么都不做） */
  startAutoUpdate: () => autoUpdate.start(),

  routes,

  /** 启动日志用 */
  autostartAll: async function autostartAll(log = console.log) {
    store.ensureDirs();
    for (const s of store.list().filter((x) => x.autostart)) {
      try {
        log(`  ↻ 自启源：${s.name} (${s.url})`);
        /* ⚠️ `awaitReady: true` = **等它真的监听上，再起下一个源**：
         * `start()` 默认"立刻返回、后台等就绪"，所以连着起两个源时，第二个的选端口跑在第一个绑定之前 ——
         * 实测两个源都拿到 9988，第二个被占后**只能靠源码包自己 +1**（douer/9280 会 +1，
         * 但 Lmentor 那种认 `DEV_HTTP_PORT` 的包会**直接报错退出**）。
         * 顺序等就绪后端口就是确定的 9988 / 9989…，与「聚合设置 · 源列表」里填的地址对得上。 */
        // eslint-disable-next-line no-await-in-loop
        await runner.start(
          Object.assign({}, s, { dir: store.sourceDir(s.id), runtimeDir: store.runtimeDir(s.id), awaitReady: true }),
          Object.assign({}, s, { awaitReady: true })
        );
      } catch (e) {
        log(`  ✗ 自启失败 ${s.name}：${e.message}`);
      }
    }
  },

  stopAll: () => runner.stopAll(),

  /**
   * **面板没人认领的路径**交给猫源层再问一次（配置中心的兜底转发）。
   *
   * 只有这一层知道"当前配置中心是哪个源"，而请求可能落在**面板的任何根路径**上
   * （源的配置中心前端写死了根路径，`/full-config` 就是实测撞上的那条），所以
   * server.js 在静态文件之后调这里，认领不了才 404。判定与理由见 `config-proxy.js` 顶部。
   */
  proxyConfigCenter: configProxy.fallback,
};
