# SpecGap · 需求与代码双向对照

**@specgap/dsh-plugin 0.2.0-alpha.4 · 实验性预发布**

原生 QA 证据工作台：冻结需求与 Git 实现，对照需求是否落实、变更是否有依据，再分别记录人工回复、决议与复验。不是自动发布门禁。

## 环境与安装

精确支持 **DSH 0.2.2-rc.1**；Node >=24.9.0、Python >=3.11、Git >=2.31。仅面向本机所有者和已注册工作区，无运行时第三方包依赖，内嵌 MIT Python core 0.1.0 / 协议 1。

在 [GitHub Release](https://github.com/homerlamlam/specgap/releases/tag/plugin-v0.2.0-alpha.4) 下载并校验本地 tgz，然后在 DSH **插件 → 添加插件 → 包名或地址** 填写 Host 本机绝对路径，点击 **安装 → 立即启用**，刷新同一页面后打开 **SpecGap**。本次不是 npm 发布，不要把仓库首页当安装包。

## 先试离线样例

选择工作区，点击 **创建离线样例**。3 个预设问题帮助体验完整流程，不会修改你的项目或调用模型，也不是准确率证明。

- 需求关联和双向映射支持冻结原文、路径、行号及高亮定位。
- 代码证据支持前后各 10 行、每页 200 行的冻结全文与定位引用；不读取后来修改的工作树。
- 三步准备、问题优先审查、人工处理、历史记录；中文内容与报告。
- 在原生会话右侧栏阅读 Markdown / 检索 JSON，下载不是前提。
- 模型分析需单独预览准确请求、路由和预算，再确认一次尝试；没有自动付费重试。

完整指南与截图见[公开项目文档](https://github.com/homerlamlam/specgap/blob/main/docs/dsh-plugin.zh-CN.md)。安装包内也包含中文使用及复现指南。

准确模型请求留存在插件私有逐次审计中，**不是原生 Session 日志**。本地角色不是企业认证；插件不执行被审项目测试。引用逐字正确不代表判断正确，真实模型效果未测量。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
