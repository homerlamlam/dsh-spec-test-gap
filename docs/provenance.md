# 来源与项目身份

SpecGap 是独立实现。问题研究参考过 [cc-rsg](https://github.com/daishir0/cc-rsg) 的提交 `a15fef37ae8a06d87da2ee3052bbd341a7e15874`（MIT），尤其关注候选问题、可核对证据、实际决议与验证行为之间的区别。

本分发没有内嵌 cc-rsg 的源码、包、提示词或资产，不是其 fork、受其背书的后继项目，也不声称通过端到端基准证明优于该项目。先前研究不是对上游最新版本的全面评价。

项目实现与合成夹具由 SpecGap 编写，使用 AI 辅助，采用 [MIT 许可](<../LICENSE>)。样例与测试数据为合成材料。

核心运行依赖为 Python 标准库和外部 Git；CLI 使用 setuptools 构建。插件另依赖受支持的 DSH/Node 运行环境，构建工具为 esbuild；没有新增运行时第三方 npm/Python 依赖。

公开仓库为 [homerlamlam/specgap](https://github.com/homerlamlam/specgap)。本次通过 GitHub 分发安装包，不声称已完成 npm/PyPI 发布或商标清查。通用贡献者名称不代表企业身份或背书。
