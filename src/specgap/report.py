"""Render inert Chinese Markdown without rewriting original records or evidence."""

import re

from .review import review_state
from .util import physical_lines, safe_text


_VALUE_LABELS = {
    "supported": "已有支持证据", "partial": "部分符合", "contradicted": "与需求矛盾",
    "no_evidence": "未找到证据", "unclear": "尚不明确", "behavior_changed": "行为已改变",
    "implementation_only": "仅实现变化", "unknown": "未知", "contradiction": "与需求矛盾",
    "undocumented_change": "需求未说明的变更", "ambiguity": "存在歧义", "regression": "回归风险",
    "test_gap": "测试缺口", "low": "低", "medium": "中", "high": "高", "critical": "严重",
    "approved_change_locally_attested": "已批准变更（仅本地声明）", "unconfirmed": "未确认",
    "undecided": "尚未裁决", "unverified": "尚未验证", "confirm_defect": "确认缺陷",
    "not_an_issue": "非问题", "approve_intent_change": "批准意图变更", "accept_risk": "接受风险",
    "passed": "已通过（人工记录）", "failed": "未通过（人工记录）",
    "developer": "开发人员", "product": "产品人员", "qa": "测试人员", "security": "安全人员",
    "response": "回复", "decision": "裁决", "verification": "验证", "local_attestation": "本地声明",
    "base": "基线版本", "head": "变更后版本",
}
_DIAGNOSTICS = {
    "Static evidence only; tests not executed.": "仅提供静态证据，未执行测试。",
    "Static context only: no audited application or tests were executed.": "仅提供静态上下文：未执行被审查的应用或测试。",
    "Target integration/merge-result analysis was not performed.": "尚未分析目标分支的集成或合并结果。",
    "Secret filtering is best-effort: inspect all content before sharing with an agent/provider.": "敏感信息过滤不能保证完整；向智能体或模型服务分享前，请检查全部内容。",
    "Requirement paragraphs are intake units, not automatically approved semantic clauses.": "需求段落仅是采集单元，不代表已获批准的语义条款。",
    "Worktree status unknown: configured Git clean/process filters prevent safe status checking; uncommitted content is ignored.": "工作树状态未知：版本控制过滤器配置阻止了安全状态检查；未提交内容已忽略。",
    "Uncommitted/untracked worktree changes ignored; only committed B/H objects were read.": "未提交及未跟踪的工作树变更已忽略；仅读取已提交的基线与变更后对象。",
    "Repository location differs from frozen snapshot": "仓库位置与冻结快照不同。",
    "head ref moved since snapshot": "变更后版本的引用在快照创建后已移动。",
    "target ref moved since snapshot": "目标分支的引用在快照创建后已移动。",
    "base ref moved since snapshot": "基线版本的引用在快照创建后已移动。",
    "Repository or tracked ref unavailable; freshness unknown": "仓库或跟踪引用不可用，无法确认是否过期。",
    "Requirements content changed since snapshot": "需求内容在快照创建后已发生变化。",
    "Requirements unavailable; freshness unknown": "需求文件不可用，无法确认是否过期。",
}
_DIAGNOSTIC_PREFIXES = {
    "Python syntax/AST parse failed: ": "源文件语法或语法树解析失败：",
    "Python AST traversal limit; file-level fallback: ": "语法树遍历达到限制，已退回文件级分析：",
    "Not followed (symlink/submodule/non-regular): ": "未跟随符号链接、子模块或非常规文件：",
    "Potential secret path excluded: ": "已排除可能包含敏感信息的路径：",
    "Context budget omitted: ": "上下文预算不足，已省略：",
    "Binary source omitted: ": "已省略二进制源文件：",
    "Non-UTF-8 source omitted: ": "已省略编码不受支持的源文件：",
    "Unsupported language; file-level fallback only: ": "语言不受支持，仅进行文件级分析：",
}


def _code(value):
    text = str(value)
    # Longer than every backtick run, including hostile embedded closing fences.
    fence = "`" * max(3, 1 + max((len(m) for m in re.findall(r"`+", text)), default=0))
    ending = "" if text.endswith("\n") else "\n"
    return [f"{fence}text\n{text}{ending}{fence}"]


def _prose(value):
    text = str(value)
    # No translation or rewriting of imported/historical prose. Mixed-language
    # records with a non-Chinese line remain whole, rather than losing context.
    if all(not line.strip() or re.search(r"[\u3400-\u9fff]", line) for line in physical_lines(text)):
        return [safe_text(text)]
    return ["原文（未改写）：", *_code(text)]


def _value(label, value):
    if value in _VALUE_LABELS:
        return [f"{label}：{_VALUE_LABELS[value]}"]
    return [f"{label}（原始值）：", *_code(value)]


def _diagnostic(text):
    if text in _DIAGNOSTICS:
        return ["- " + _DIAGNOSTICS[text]]
    for prefix, label in _DIAGNOSTIC_PREFIXES.items():
        if text.startswith(prefix):
            return ["- " + label, *_code(text[len(prefix):])]
    return ["原始诊断（未改写）：", *_code(text)]


def finding_state(finding, events):
    related = [e for e in events if e.get("finding_id") == finding["id"]]
    decisions = [e for e in related if e["kind"] == "decision"]
    decision = decisions[-1] if decisions else None
    verifications = [e for e in related if e["kind"] == "verification"]
    verification = verifications[-1] if verifications else None
    # A later decision invalidates the displayed current verification, not its history.
    if verification and decision and verification.get("sequence", 0) < decision.get("sequence", 0):
        verification = None
    return {"assessment": finding["kind"],
            "intent": "approved_change_locally_attested" if decision and decision["outcome"] == "approve_intent_change" else "unconfirmed",
            "disposition": decision["outcome"] if decision else "undecided",
            "verification": verification["result"] if verification else "unverified",
            "responses": sum(e["kind"] == "response" for e in related)}


def render_report(bundle, review, events, stale=None) -> str:
    state = {"needs_review": "尚未审查", "partial": "审查不完整", "ready_for_review": "待人工审阅"}[review_state(bundle, review)]
    lines = ["# 需求与实现审查报告", "", f"**审查状态：** {state}",
             f"**时效状态：** {'已过期或无法确认' if stale else '最近检查时有效'}", "",
             "本报告仅辅助审查，不构成发布批准或正确性证明。",
             "精确引用已校验，但语义判断仍需人工审阅。模型输出不能授权需求或意图变更。",
             "人工记录仅为本地声明，不代表身份已经认证。人工提供的验证证据未由本工具独立执行。",
             "", "## 冻结范围"]
    for key, label in (("snapshot_id", "快照标识"), ("created_at", "创建时间")):
        lines.extend([f"{label}：", *_code(bundle[key])])
    for key, label in (("base_sha", "基线提交"), ("head_sha", "变更后提交"),
                       ("target_sha", "目标提交"), ("merge_base_sha", "共同祖先提交")):
        value = bundle["repo"].get(key)
        lines.extend([f"{label}：", *_code(value)] if value else [f"{label}：未提供"])
    lines.extend(["", "## 限制与警告"])
    for item in [*(stale or []), *bundle["limitations"], *bundle["warnings"]]:
        lines.extend(_diagnostic(item))
    if review is None:
        lines.extend(["", "尚无通过校验的审查结果。此处没有问题记录，不代表不存在缺口。"])
        return "\n".join(lines) + "\n"

    def evidence(citations):
        for cite in citations:
            lines.extend(["", *_value("证据版本", cite["side"]), "引用位置（路径与行号）：",
                          *_code(f"{cite['path']}:{cite['start_line']}–{cite['end_line']}"),
                          "证据原文（未改写）：", *_code(cite["quote"])])

    clauses = {r["id"]: r for r in bundle["requirements"]["clauses"]}
    lines.extend(["", "## 需求 → 实现"])
    for number, item in enumerate(review["requirements"], 1):
        lines.extend(["", f"### 需求 {number}", "需求标识：", *_code(item["id"]),
                      *_value("评估", item["assessment"]), "需求原文：", *_code(clauses[item["id"]]["text"]),
                      "", "评估理由：", *_prose(item["reason"])])
        evidence(item["evidence"])
    lines.extend(["", "## 行为变更 → 需求与授权"])
    for number, item in enumerate(review["changes"], 1):
        lines.extend(["", f"### 变更 {number}", "变更标识：", *_code(item["id"]),
                      *_value("评估", item["assessment"]), *_prose(item["summary"]),
                      "关联需求（不代表批准）："])
        lines.extend(_code(", ".join(item["requirement_ids"])) if item["requirement_ids"] else ["无"])
        evidence(item["evidence"])
    lines.extend(["", "## 问题与澄清"])
    if not review["findings"]:
        lines.append("未报告问题。这不代表正确性保证。")
    for number, finding in enumerate(review["findings"], 1):
        state = finding_state(finding, events)
        lines.extend(["", f"### 问题 {number}", "问题标识：", *_code(finding["id"]),
                      *_prose(finding["title"]), *_prose(finding["description"]), "",
                      *_value("严重程度", finding["severity"]), *_value("评估", state["assessment"]),
                      *_value("意图状态", state["intent"]), *_value("裁决状态", state["disposition"]),
                      *_value("验证状态", state["verification"]), "待澄清问题：", *_prose(finding["question"]),
                      *_value("建议回复角色", finding["suggested_role"])])
        evidence(finding["evidence"])
        lines.append("测试建议（未执行）：")
        for idea in finding["test_ideas"]:
            lines.extend(_prose(idea))
        lines.append("本地声明历史：")
        for event in events:
            if event.get("finding_id") != finding["id"]:
                continue
            lines.extend(["", "#### 人工记录"])
            for key, label in (("sequence", "序号"), ("kind", "操作"), ("actor", "声明人标识"),
                               ("created_at", "记录时间"), ("assurance", "身份保证"), ("text", "回复内容"),
                               ("outcome", "裁决"), ("reason", "裁决理由"), ("result", "验证结果"),
                               ("note", "验证说明"), ("evidence_sha256", "证据摘要")):
                if key not in event:
                    continue
                if key in ("kind", "assurance", "outcome", "result"):
                    lines.extend(_value(label, event[key]))
                elif key in ("text", "reason", "note"):
                    lines.extend([f"{label}：", *_prose(event[key])])
                else:
                    lines.extend([f"{label}：", *_code(event[key])])
    return "\n".join(lines) + "\n"
