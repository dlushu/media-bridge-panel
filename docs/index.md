# 文档

本目录按**读者**与**用途**组织（用途分类参考 Diátaxis 的四种类型：教程 / 操作指南 / 参考 / 原理）。

## 起点

| 目的 | 从这里开始 |
|---|---|
| 装上并使用 | [README.md](../README.md) |
| 修改代码 | [ARCHITECTURE.md](../ARCHITECTURE.md) → [develop.md](develop.md) |
| 编写首页插件 | [emby-home-plugin.md](emby-home-plugin.md) |
| 了解某个决定为什么这么做 | [adr/](adr/) |

## 全部文档

| 文档 | 内容 | 类型 |
|---|---|---|
| [README.md](../README.md) | 安装、首次使用、界面导览、常见问题 | 教程 + 操作指南 |
| [ARCHITECTURE.md](../ARCHITECTURE.md) | 分层与依赖方向、目录结构、模块清单、模块设置 | 参考 |
| [develop.md](develop.md) | 开发环境、新增模块、API 契约、面板鉴权、数据目录、实现要点 | 参考 |
| [emby-compat.md](emby-compat.md) | Emby 兼容层：端点清单、DTO 形状、失败语义、客户端差异 | 参考 |
| [emby-home-plugin.md](emby-home-plugin.md) | 首页插件规范、示例与调试方法 | 操作指南 |
| [adr/](adr/) | 设计决策记录（背景 / 决定 / 理由 / 备选 / 后果） | 原理 |
| [CHANGELOG.md](../CHANGELOG.md) | 版本变更 | 参考 |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | 贡献流程、提交约定、文档与注释的书写规范 | 操作指南 |
| [SECURITY.md](../SECURITY.md) | 安全边界、漏洞报告方式 | 参考 |

## 维护约定

- **用户向**内容只写在根 `README.md`；**开发者向**内容写在本文档目录。
- 注释与文档的书写规范见 [CONTRIBUTING.md](../CONTRIBUTING.md#文档与注释的书写规范)，
  由 `npm run check` 检查。
- 决策类内容不写在参考文档里：参考文档写"是什么、怎么用"，决策写进 [adr/](adr/)。
