# 安全策略

## 报告漏洞

请**不要**通过公开 Issue 报告安全问题。使用本仓库的
[私密漏洞报告](https://docs.github.com/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
（仓库页 → Security → Report a vulnerability），或在仓库页面通过维护者的联系方式私下告知。

报告请包含：受影响的版本或提交、复现步骤、影响范围，以及（如果方便）修复建议。

## 部署时的安全边界

本项目自身不带鉴权体系，安全性取决于部署方式。以下几条是部署时必须遵守的前提：

| 项 | 说明 |
|---|---|
| **面板端口（默认 8099）** | 面板只有单一密码登录（默认 `123456`）。**首次登录后必须改密码**；需要外网访问时请置于反向代理之后，并启用 HTTPS。 |
| **源端口（默认 9988-9998）** | 由面板拉起的源子进程各自监听一个端口，**这些端口没有鉴权**。只应暴露在受信任的局域网内，不要映射到公网。 |
| **Emby 兼容接口** | 通过 token 鉴权（`X-Emby-Token` / `Authorization` / `api_key` 三种带法）。token 由 `POST /Users/AuthenticateByName` 下发，等同密码，不要外泄。 |
| **上游源** | 面板会以配置者的名义请求所配置的源地址。源地址由用户自行填写，其可信度由用户判断。 |

## 已知的、非漏洞的行为

- 未实现的 Emby 端点返回 `501`，并对未知请求记日志后按空数据响应 —— 这是设计行为，不是安全缺陷。
- 图片端点按签名校验（`tag` 内含签名），签名不匹配返回 `404`。
