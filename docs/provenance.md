# 来源与项目身份

dsh-spec-test-gap 是独立实现。问题研究参考过 [cc-rsg](https://github.com/daishir0/cc-rsg) 的提交 `a15fef37ae8a06d87da2ee3052bbd341a7e15874`（MIT），尤其关注候选问题、可核对证据、实际决议与验证行为之间的区别。

本分发没有内嵌 cc-rsg 的源码、包、提示词或资产，不是其 fork、受其背书的后继项目，也不声称通过端到端基准证明优于该项目。先前研究不是对上游最新版本的全面评价。

项目实现与合成夹具由 dsh-spec-test-gap 编写，使用 AI 辅助，采用 [MIT 许可](<../LICENSE>)。样例与测试数据为合成材料。

核心运行依赖为 Python 标准库和外部 Git；CLI 使用 setuptools 构建。插件另依赖受支持的 DSH/Node 运行环境，构建工具为 esbuild；没有新增运行时第三方 npm/Python 依赖。

公开品牌展示名与插件包名均为 **dsh-spec-test-gap**，中文副标题为 **需求与代码双向对照测试助手**；公开仓库为 [homerlamlam/dsh-spec-test-gap](https://github.com/homerlamlam/dsh-spec-test-gap)。首次正式公开预发布 **0.2.0-alpha.5** 使用标签 `plugin-v0.2.0-alpha.5`，通过 GitHub Release 分发 `dsh-spec-test-gap-0.2.0-alpha.5.tgz`。alpha.4 仅有公开源码标签，无正式 Release。

Python 模块/CLI 命令 `specgap`、源码目录 `plugins/dsh-specgap`、数据/API 命名空间 `specgap` 是保留的兼容内部标识，CLI/core 仍为 **0.1.0**、桥接协议仍为 **1**；并非遗漏更名。本次不发布到 npm/PyPI。项目不是自动测试运行器，不提供发布批准，也不声称已完成商标清查。通用贡献者名称不代表企业身份或背书。
