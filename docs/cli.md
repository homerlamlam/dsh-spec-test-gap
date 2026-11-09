# 独立 CLI 使用

[项目首页](<../README.md>) · [Agent 审查契约](<agent-contract.md>)

CLI/core 版本为 **0.1.0**，与插件版本独立。要求 Python 3.11+、Git 2.31+；运行时没有第三方 Python 依赖。

## 安装与预设样例

在源码根目录安装；构建工具可能需要联网下载。已有 setuptools >=68 时可使用离线方式。

```sh
python -m pip install -e .
# Offline alternative when build tools are already present:
python -m pip install --no-index --no-deps --no-build-isolation -e .
python -m specgap --help
python -m specgap demo --out ../specgap-demo
python -m specgap status --run ../specgap-demo/run
python -m specgap report --run ../specgap-demo/run
```

输出目录必须尚不存在。样例的 3 个问题是预设结论，不调用模型。安装后 `specgap` 与 `python -m specgap` 等价。

## 离线审查自己的仓库

需求应独立于 diff；run 放在被审仓库外。以下命令在项目根目录执行，替换成自己的路径/ref。

```sh
specgap prepare --repo ../my-app --requirements ../acceptance.md --target main --head feature/example --policy examples/policy.json --out ../review-run
specgap template --run ../review-run --out ../candidate-review.json
```

将冻结 bundle、模板与 [Agent 契约](<agent-contract.md>)交给你的 coding agent。完成双向审查、人工检查后导入：

```sh
specgap import-review --run ../review-run --review ../candidate-review.json
specgap report --run ../review-run --out ../review-report.md
specgap status --run ../review-run
```

模板的 `unassessed` 故意不能导入；每个需求和变更都需要评估。允许零条问题，不能为了凑数量编造。成功导入后审查不可覆盖，修订须新建 run；导出也不覆盖已有文件。

## 人工澄清和复验

使用已冻结的[角色策略示例](<../examples/policy.json>)；每次 `--attest-local` 都明确表示本地自声明，不是登录认证。

```sh
specgap respond --run ../review-run --finding F-1 --actor dev --text "有意修改，但尚未获得产品批准" --attest-local
specgap decide --run ../review-run --finding F-1 --actor pm --outcome approve_intent_change --reason "接受范围变更；另行更新产品需求" --attest-local
specgap verify --run ../review-run --finding F-1 --actor qa --result passed --evidence ../manual-check.txt --note "实际人工步骤、预期和结果见附件" --attest-local
```

上面的复验命令只应用于确实完成验证的情况；工具不执行附件内容。新决议使旧复验不再是当前状态，新代码需要新快照。

## 单独显式启用兼容模型接口

这是 CLI 的传输路径，**不同于 DSH 插件的原生确认流程**。先检查冻结材料，以正常密钥管理方式设置 `SPECGAP_API_KEY`，不要把 key 放进命令行或仓库。

```sh
specgap analyze --run ../review-run --endpoint https://YOUR_PROVIDER/v1/chat/completions --model YOUR_MODEL --allow-network
```

接口需兼容 Chat Completions JSON mode。可用 `--api-key-env NAME` 指定其他环境变量；已有审查的 run 不重复请求。仅 HTTPS（回环除外），不跟随重定向或环境代理，无自动重试，不复用 Harness 凭据。

## 状态和退出码

- `needs_review`：还没有有效语义审查。
- `partial`：存在未覆盖、不支持材料或不确定分类。
- `ready_for_review`：完整度满足要求，**不是没有缺陷或允许发布**。

退出码：0 命令成功；2 输入/策略/完整性/配置错误；3 过期材料拒写；4 模型配置/传输/输出/未同意联网；130 中断。完整参数见各子命令 `--help`。

[安全边界](<../SECURITY.md>)与[技术原理](<architecture.md>)同样适用于 CLI，除非明确说明为插件专属能力。
