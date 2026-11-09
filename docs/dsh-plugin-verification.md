# dsh-spec-test-gap 插件复现与分发验收

适用 **dsh-spec-test-gap 0.2.0-alpha.5**（需求与代码双向对照测试助手，首次正式公开预发布）；精确支持 DSH **0.2.2-rc.1**。CLI/core 仍为 0.1.0、桥接协议仍为 1。

[使用指南](<dsh-plugin.zh-CN.md>) · [本版验证记录](https://github.com/homerlamlam/dsh-spec-test-gap/blob/main/docs/verification.md)

本页提供可重复执行的复现与验收流程，实际执行结果、包摘要与未验证范围以本版验证记录为准。[实际生产组件离线截图](https://github.com/homerlamlam/dsh-spec-test-gap/blob/main/docs/screenshots.md)使用本版预设 fixture，不是 AI 发现或已登录 DSH 的完整端到端验收。alpha.4 仅有公开源码标签，无正式 Release；本版验证独立记录，不沿用旧版测试数量或包摘要。

## 证据层次

| 验证 | 能说明什么 | 不能说明什么 |
| --- | --- | --- |
| Python 核心与桥接测试 | 固定输入下的核心语义、文件/协议边界 | 模型准确率、浏览器可用性 |
| Node Host/Client 测试 | 状态、渲染、恢复、真实原生模块契约 | 全部浏览器交互或 HTTP 登录认证 |
| 独立构建、打包、解包、桥接样例 | 被测环境中分发自包含、精确文件清单与核心一致性 | 其他平台、已安装 GUI 或模型效果 |
| 实际生产组件离线截图 | 预设夹具中的组件布局与被展示的交互 | 已登录 DSH 的安装、原生 Host/侧栏或模型请求验收 |
| 实际已登录界面检查 | 被操作步骤在该版本/环境的实际表现 | 未操作功能、所有浏览器或模型效果 |
| 实际提供方与语义评测 | 需要另行设计和执行 | 不可用预设样例或合法 JSON 替代 |

测试使用隔离 Git 夹具和本地假模型服务，不读取生产密钥，不调用真实模型。缺少原生模块或能力导致的跳过必须报告，不作为通过。

## 源码复现

准备 Python >=3.11、Git >=2.31、Node >=24.9.0，并安装精确兼容的 DSH。构建锁定 esbuild 0.28.2。安装开发依赖可能运行其安装脚本；已安装插件不会执行此开发步骤。

Python 模块/CLI 命令 `specgap`、源码目录 `plugins/dsh-specgap`、数据/API 命名空间 `specgap` 保留为兼容内部标识；不要因品牌更名改写下面的脚本路径或 `SPECGAP_*` 环境变量。

```sh
git clone https://github.com/homerlamlam/dsh-spec-test-gap.git
cd dsh-spec-test-gap
npm ci --prefix plugins/dsh-specgap
```

从源码根目录执行 PowerShell；将占位路径替换成真实安装位置。`DSH_NATIVE_MODULES` 只读指向兼容 DSH 安装中的 `node_modules/@deepseek-ai` 目录，包含 cordis、dsh-llm 等原生模块，不能使用临时伪造模块。测试变量不配置已安装插件。

```powershell
$env:SPECGAP_TEST_PYTHON = (Get-Command python -CommandType Application).Source
$env:SPECGAP_TEST_GIT = (Get-Command git -CommandType Application).Source
$NODE = (Get-Command node -CommandType Application).Source
$env:SPECGAP_TEST_NPM = '<absolute path to npm/bin/npm-cli.js>'
$env:DSH_NATIVE_MODULES = '<absolute compatible DSH node_modules/@deepseek-ai directory>'
$env:PYTHONPATH = Join-Path $PWD 'src'
$env:PYTHONIOENCODING = 'utf-8'
& $NODE --version
& $env:SPECGAP_TEST_PYTHON --version
& $env:SPECGAP_TEST_GIT --version
& $NODE plugins/dsh-specgap/scripts/build.mjs
& $env:SPECGAP_TEST_PYTHON -m unittest discover -s tests -v
& $env:SPECGAP_TEST_PYTHON -m unittest discover -s plugins/dsh-specgap/tests -p 'test_*.py' -v
& $NODE --test --test-concurrency=4 'plugins/dsh-specgap/tests/*.test.mjs'
```

逐条检查退出码，任一失败即停止，不把最后一个成功命令当作整组成功。POSIX 下设置同名环境变量并用相同参数执行对应 Python/Node 路径。

### 独立顺序打包门禁

全部测试结束后，输出到**源码目录之外且尚不存在**的绝对路径。不要边构建边让测试读取同一生成目录。

```powershell
& $NODE plugins/dsh-specgap/scripts/accept-package.mjs --output '<new absolute acceptance directory>'
```

脚本会在 fresh stage 中构建、离线打包、独立解包，检查精确文件白名单、14 个核心模块逐文件哈希、bridge health、预设样例、读回和报告。样例应为 3 个预设问题，且 `release_approval` 为 `false`。

包包含 Host/Client 构建、桥接与核心、语言包、图标、Cordis 配置、许可证、说明和三份指南；不包含依赖目录、源码测试、源码脚本、截图或运行数据。不要直接上传共享开发目录中的旧 tgz。

**原始验收日志/manifest 含本机绝对路径，不应整体作为 Release 附件上传。** 本次预发布标签为 `plugin-v0.2.0-alpha.5`，公共安装附件名为 `dsh-spec-test-gap-0.2.0-alpha.5.tgz`，仅通过 GitHub Release 分发，不发布到 npm/PyPI。发布验收须单独检查包内名称、版本、文件摘要与脱敏结果；重打包后必须重新计算摘要，不得沿用旧包哈希。本次产物摘要见本版验证记录与 Release 校验清单。文件哈希证明内容一致，不是作者签名。

## 实际 GUI 手工检查

使用现有、已登录的 DSH 页面；不启动替代服务或绕过认证。记录实际安装版本、操作步骤和观察，不伪造“已验证”勾选。

1. 按 **插件 → 添加插件 → 包名或地址 → 安装 → 立即启用** 安装并启用经校验的本地包，核对包名 `dsh-spec-test-gap`、版本 `0.2.0-alpha.5`；刷新后检查 **dsh-spec-test-gap** 入口与中文副标题 **需求与代码双向对照测试助手**。
2. 创建离线样例：3 个预设问题，问题优先布局，需求/变更映射可切换。
3. 需求关联打开冻结原文，核对路径、行号和高亮，关闭后返回入口。
4. 代码前后文与冻结全文显示正确基线/分支；分页、定位引用、关闭与焦点恢复可操作。
5. 记录一条明确本地声明的回复，核对读回与历史；**不要捏造复验通过**。
6. 明确确认切换同工作区会话，在原生侧栏打开 Markdown；检查阅读/源码、JSON 树/检索、同步时间及实际错误。
7. 回到工作台检查审查和选择保留；窄屏检查滚动、来源阅读和弹窗可操作。
8. 在单独获准的真实模型试跑中检查准确请求确认、取消、导航/重启中断状态；没有运行则明确未验证。

## 模型效果需要另行评测

应使用独立需求、冻结真实 PR、隐藏正反例、人工裁决，并在同等工具/上下文/预算下比较有效发现与 QA/开发/产品总耗时。预设样例、合法 JSON、引用存在或一次请求成功都不能替代该评测。
