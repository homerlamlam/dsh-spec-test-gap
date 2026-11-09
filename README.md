# SpecGap · 需求与代码双向对照

**需求有没有落实？代码是否改变了未被要求的行为？把判断落到可追溯的 Git 证据，再交给人确认。**

SpecGap 是 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的原生 QA 工作台，也提供独立 Python CLI。它把独立需求、已提交代码和人工处理记录放进同一次审查，避免只盯着 diff、或把“开发说是有意的”误当成“产品已经批准”。

[下载安装](https://github.com/homerlamlam/specgap/releases/tag/plugin-v0.2.0-alpha.4) · [完整使用指南](<docs/dsh-plugin.zh-CN.md>) · [功能截图](<docs/screenshots.md>) · [技术原理](<docs/architecture.md>) · [验证说明](<docs/verification.md>)

> **当前为实验性预发布：插件 0.2.0-alpha.4，CLI/core 0.1.0。** 可以体验流程，不能当自动发布门禁。离线样例中的 3 个问题是预设示例，不是模型发现；真实项目上的模型准确率、召回率尚未测量。

![发现列表与冻结证据](<docs/images/01-findings-evidence.png>)

*实际生产组件的离线浏览器演示；三个问题均为预设样例，不代表 AI 效果或已登录 DSH 的完整端到端验收。查看[全部截图及边界](<docs/screenshots.md>)。*

## 你能用它做什么

| 场景 | SpecGap 的做法 |
| --- | --- |
| 需求写了，但实现可能没改 | 从需求出发检查冻结的 head 上下文，也能引用未改动文件 |
| 分支改了需求没提的行为 | 从基线到 head 逐项审查变更，追问需求依据或产品意图 |
| 模型引用看起来很像真的 | 校验快照、需求/变更 ID、基线/分支、路径、行号和逐字引文 |
| 想看引用前后到底是什么 | 打开需求冻结原文，或查看代码前后各 10 行、每页 200 行的冻结全文 |
| 开发、产品和 QA 结论混在一起 | 分开记录回复、意图决议、缺陷处置和人工复验 |
| 不想下载文件才能看结果 | 在 DSH 原生会话右侧栏阅读 Markdown 报告或检索 JSON |

**证据引用准确 ≠ 推理正确；已回答 ≠ 已批准 ≠ 已验证。**

## 安装：先下载包，再在 DSH 启用

| 环境 | 要求 |
| --- | --- |
| DSH | **精确版本 0.2.2-rc.1**，其他版本未声明兼容 |
| Node.js | 24.9.0 或更新版本 |
| Python | 3.11 或更新版本，可被 DSH 进程找到 |
| Git | 2.31 或更新版本，可被 DSH 进程找到 |
| 运行方式 | 本机所有者、已注册的本地工作区；不支持 LiveShare |

1. 到 [Release](https://github.com/homerlamlam/specgap/releases/tag/plugin-v0.2.0-alpha.4) 下载插件安装包和 SHA-256 校验清单。**不需要另装 Python CLI。**
2. 校验下载包，确认名称与版本。PowerShell 示例：

   ```powershell
   Get-FileHash -LiteralPath 'C:\Downloads\specgap-dsh-plugin-0.2.0-alpha.4.tgz' -Algorithm SHA256
   ```

3. 在现有 DSH 页面左侧进入 **插件 → 添加插件**，在 **包名或地址** 填写下载包在 **DSH Host 所在机器**上的绝对路径，点击 **安装**。
4. 安装完成后点击 **立即启用**，检查实际版本与警告；刷新同一 DSH 页面，在导航中打开 **SpecGap**。

不要把仓库首页地址当作可安装包，也不要直接填写 npm 包名：**本次通过 GitHub Release 分发，不声称已发布 npm/PyPI。** 安装影响当前 profile 的全部会话；不应为了安装跳过版本兼容检查。排障、升级和卸载见[完整指南](<docs/dsh-plugin.zh-CN.md>)。

## 3 分钟体验

1. 在 SpecGap 选择一个已注册工作区，点击 **创建离线样例**。
2. 查看 3 个预设问题：重试次数与需求冲突、未声明的用户名限制、缺少审计日志实现证据。
3. 切换需求/变更映射，点击 **查看冻结原文** 或 **查看冻结全文**，核对路径、行号、基线/分支与引文。
4. 展开人工处理，记录回复；必要时由对应本地声明角色记录决议。插件不会替你执行测试。
5. 打开报告，明确确认切换到同工作区驻留会话，在原生右侧栏阅读。

离线样例在插件自己的存储中创建隔离仓库，不修改你的项目，也不调用模型。

## 审查自己的功能分支

1. **比较范围**：选择工作区内仓库和已有本地分支。通常设置目标分支与功能分支，使用共同祖先到功能分支的变化；没有目标/显式基线时仅比较 head 的第一父提交到 head，不等于整个功能分支。
2. **需求与参与者**：粘贴独立的产品/验收需求，或选择工作区内需求文件；设置开发、产品、QA 等本地角色。不要用 diff 反推一份“需求”再拿它验证同一个 diff。
3. **准备材料**：冻结需求和已提交 Git 对象，查看被忽略的未提交内容、上下文覆盖和遗漏。**准备材料本身不产生语义审查。**
4. **可选模型审查**：选择 DSH 中可用的模型，预览准确请求和预算，再明确确认一次外发。没有确认，不向提供方发送源码。
5. **人工确认**：检查双向判断、精确证据和问题；记录回复、决议及实际人工复验，代码变化后创建新快照。

一次确认只允许一次模型尝试，不自动付费重试。默认上下文 100 条/512 KiB，最大 2000 条/2 MiB；未纳入材料必须作为限制考虑。更多边界见[技术原理](<docs/architecture.md>)与[安全说明](<SECURITY.md>)。

## 不使用 DSH？独立 CLI 也能运行

要求 Python 3.11+、Git 2.31+。从源码安装：

```sh
git clone https://github.com/homerlamlam/specgap.git
cd specgap
python -m pip install -e .
python -m specgap demo --out ../specgap-demo
python -m specgap status --run ../specgap-demo/run
python -m specgap report --run ../specgap-demo/run
```

输出目录必须尚不存在。运行时没有第三方 Python 依赖；安装时可能下载构建工具。CLI 的离线导入、人工处理和显式联网命令见 [CLI 指南](<docs/cli.md>)。

## 原理与边界

```text
独立需求 + 冻结 Git 基线/head
              ↓
有界源码材料 + Python AST 结构定位
              ↓
所选模型双向判断（需要单独确认）
              ↓
严格 JSON / ID / 路径 / 行号 / 逐字引用校验
              ↓
人工回复 → 意图/处置决议 → 人工复验 → 中文报告
```

- 不是向量检索、通用调用图分析或形式化证明；Python AST 用来定位结构，不直接判断业务正确性。
- 只读已提交对象，不 checkout、不 fetch、不执行被审项目代码/测试，也不自动修复或合并。
- 本地角色是自声明，不是企业身份认证；哈希链用于发现完整性变化，不保证抵抗本机管理员篡改。
- 数据与准确模型请求审计保存在 profile 的插件私有存储中，不是原生 Session 日志。报告和截图可能包含源码，分享前自行检查。
- 当前验证分层、实际结果和未验证范围见[验证说明](<docs/verification.md>)。不要把单元测试、包校验或截图当成模型效果证明。

## 开发与反馈

[参与贡献](<CONTRIBUTING.md>) · [变更记录](<CHANGELOG.md>) · [安全报告](<SECURITY.md>) · [问题反馈](https://github.com/homerlamlam/specgap/issues)

采用 [MIT 许可](<LICENSE>)。独立实现；问题研究参考过 [cc-rsg](https://github.com/daishir0/cc-rsg)，未复制或内嵌其源码，见[来源说明](<docs/provenance.md>)。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
