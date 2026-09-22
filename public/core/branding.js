'use strict';
/**
 * 面板的名字 —— **前端只有这一处**（后端那份与它成对：`server/core/branding.js`，两边的值要一致）。
 *
 * 为什么前端也要一份：网页标题 / 顶栏 / 登录页都在浏览器里渲染，而**登录页是未登录状态**
 * （不能指望带鉴权的接口把名字发下来）；两份常量比"多一个公开接口 + 异步补渲染"简单。
 *
 * ⚠️ 改名时：改这里 + `server/core/branding.js` + `package.json` 的 name +
 * `index.html` 里那份首屏兜底文本（见 server 那份的注释）。
 */
export const BRAND = {
  name: '媒体桥',
  /** Emby 客户端「服务器列表」里显示的默认名（带 Emby 后缀：客户端里一眼看出这是个 Emby 服务） */
  embyServerName: '媒体桥 Emby',
  panelName: '媒体桥面板',
  slug: 'media-bridge-panel',
  ua: 'MediaBridgePanel/1.0',
};

/**
 * 把品牌刷进外壳：网页标题 + 顶栏那行字。
 * `index.html` 里写的是**首屏兜底文本**（内联脚本之前的那一瞬），启动后由这里覆盖。
 */
export function paintBrand() {
  document.title = BRAND.panelName;
  const b = document.querySelector('.brand b');
  if (b) b.textContent = BRAND.panelName;
}
