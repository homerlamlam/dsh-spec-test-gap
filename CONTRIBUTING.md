# 参与贡献

欢迎改进证据质量和人工审查效率，不要用更多“通过”标签掩盖覆盖限制。

## 源码开发

Python 3.11+、Git 2.31+；插件另需 Node 24.9.0+ 和精确兼容的 DSH 0.2.2-rc.1。

```sh
python -m pip install -e .
python -m unittest discover -s tests -v
python -m specgap demo --out ../specgap-dev-demo
npm ci --prefix plugins/dsh-specgap
node plugins/dsh-specgap/scripts/build.mjs
```

样例和导出目录必须是新目录。开发依赖安装可能运行 esbuild 安装脚本；已安装插件本身不下载工具或依赖。插件的完整 Node/桥接测试需要真实 DSH 原生模块和显式工具路径，详见[复现与打包指南](<docs/dsh-plugin-verification.md>)。

不要在共享生成目录被测试读取时同时构建。发布包必须使用独立顺序打包验收，不直接上传旧 build 或任意 npm pack 结果。当前[CI](<.github/workflows/ci.yml>)只配置核心 Python 的 Ubuntu/Windows 矩阵，不覆盖全部插件原生行为。

## 修改约束

1. 先描述用户问题与边界，增加能复现的失败测试，再做最小修复。
2. 保留独立需求和双向审查，不用 AST 哈希或引用存在性代替语义结论。
3. 不执行、安装、导入或自动 fetch 被审项目；不绕过模型外发确认。
4. 外部 JSON、引用和文本始终视为不可信；协议变化必须明确版本兼容策略。
5. 保留回复、决议、复验之间的区别，以及新鲜度拒写、原请求恢复和本地声明提示。
6. 如实记录运行命令、失败、跳过和未验证项。假模型不是模型质量证据。
7. 只提交合成或脱敏样例，不提交私有源码、真实模型请求、凭据、运行数据或客户报告。

## 提交与反馈

PR 应说明动机、范围、测试、证据和已知限制。重要行为给出修复前失败、修复后通过的命令。不要上传含客户数据的截图。

参考[技术原理](<docs/architecture.md>)、[审查契约](<docs/agent-contract.md>)、[安全说明](<SECURITY.md>)。涉及漏洞请走安全说明中的私密渠道，不要在公开 Issue 中暴露可利用细节。
