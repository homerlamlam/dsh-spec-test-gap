# dsh-spec-test-gap 插件指南

**需求与代码双向对照测试助手**，以简体中文作为默认说明语言。

- [安装、体验、模型确认、恢复与排障](<dsh-plugin.zh-CN.md>)
- [源码复现与分发验收](<dsh-plugin-verification.md>)
- [公开仓库与功能截图](https://github.com/homerlamlam/dsh-spec-test-gap)

本次为首次正式公开预发布：**dsh-spec-test-gap 0.2.0-alpha.5**；精确支持 **DSH 0.2.2-rc.1**。安装附件为 `dsh-spec-test-gap-0.2.0-alpha.5.tgz`，标签为 `plugin-v0.2.0-alpha.5`，通过 [GitHub Release](https://github.com/homerlamlam/dsh-spec-test-gap/releases/tag/plugin-v0.2.0-alpha.5) 分发，不发布到 npm/PyPI。CLI/core 仍为 0.1.0，桥接协议为 1。

Python 模块/CLI 命令 `specgap`、源码目录 `plugins/dsh-specgap`、数据/API 命名空间 `specgap` 是保留的兼容内部标识，不随品牌更名替换。alpha.4 仅有公开源码标签，无正式 Release。[本版验证记录](https://github.com/homerlamlam/dsh-spec-test-gap/blob/main/docs/verification.md)与[实际组件离线截图](https://github.com/homerlamlam/dsh-spec-test-gap/blob/main/docs/screenshots.md)分别说明执行结果与预设样例展示边界，不把截图当作已登录 DSH 的完整端到端验收。

实验版不是自动测试运行器，不提供发布批准。预设样例不代表模型发现，引用校验不等于语义正确；没有明确确认，不向模型提供方发送源码。
