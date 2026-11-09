"""A generated Git fixture with scripted semantic judgments, not a model benchmark."""

import os
import subprocess
from pathlib import Path

from .errors import SpecGapError
from .report import render_report
from .review import review_template
from .snapshot import prepare
from .store import create_run, load_events
from .util import physical_lines, safe_path, write_json
from .workflow import import_review, record_response

REQUIREMENTS = """# 独立示例验收标准

[REQ-1] 重试次数最多为 3 次。

[REQ-2] 用户名不能为空。

[REQ-3] 每次重试失败都必须写入审计日志。
"""
BASE = "from helpers import valid_name\n\ndef retry_limit():\n    return 3\n\ndef allowed_name(name):\n    return valid_name(name)\n"
HEAD = "from helpers import valid_name\n\ndef retry_limit():\n    return 5\n\ndef allowed_name(name):\n    return valid_name(name) and name != 'guest'\n"
HELPER = "def valid_name(name):\n    return bool(name)\n"


def _git(repo, *args):
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith("GIT_")}
    env.update(GIT_TERMINAL_PROMPT="0", GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)
    command = ["git", "-c", "init.templateDir=", "-c", "core.autocrlf=false",
               "-c", "core.hooksPath=" + str(repo.parent / "no-hooks"),
               "-c", "user.name=SpecGap Demo", "-c", "user.email=demo@example.invalid",
               "-c", "commit.gpgsign=false", "-C", str(repo), *args]
    try:
        subprocess.run(command, env=env, capture_output=True, check=True, timeout=30)
    except (OSError, subprocess.SubprocessError) as exc:
        raise SpecGapError("Demo Git setup failed; requires Git 2.31+ and a writable new directory") from exc


def _scripted_review(bundle):
    def cite(side, start, end=None, path="app.py"):
        source = next(s for s in bundle["sources"] if s["side"] == side and s["path"] == path)
        end = start if end is None else end
        return {"side": side, "path": path, "start_line": start, "end_line": end,
                "quote": "\n".join(physical_lines(source["content"])[start - 1:end])}

    review = review_template(bundle)
    review["requirements"] = [
        {"id": "REQ-1", "assessment": "contradicted", "reason": "脚本化候选问题：变更后的返回值为 5，超过上限 3。", "evidence": [cite("head", 4)]},
        {"id": "REQ-2", "assessment": "supported", "reason": "未修改的辅助函数会拒绝空用户名，变更后的代码仍调用它。这是静态支持证据，并非执行结果。",
         "evidence": [cite("head", 2, path="helpers.py"), cite("head", 7)]},
        {"id": "REQ-3", "assessment": "no_evidence", "reason": "采集的两个源文件中未发现审计行为。这仅表示有限范围内缺少证据，不能据此断言整个系统都未实现。", "evidence": []}]
    change_id = bundle["changes"][0]["id"]
    review["changes"] = [{"id": change_id, "assessment": "behavior_changed", "summary": "重试上限从 3 次改为 5 次，并新增了对非空访客用户名的拒绝规则。",
                          "requirement_ids": ["REQ-1", "REQ-2"], "evidence": [cite("base", 3, 7), cite("head", 3, 7)]}]
    review["findings"] = [
        {"id": "F-1", "kind": "contradiction", "title": "重试次数超出需求上限", "description": "脚本化静态候选问题：实现返回 5，而需求规定最多为 3。",
         "severity": "medium", "requirement_ids": ["REQ-1"], "change_ids": [change_id], "evidence": [cite("head", 4)],
         "question": "这是实现缺陷，还是已经获得授权的需求变更？", "suggested_role": "product",
         "test_ideas": ["触发连续失败并统计重试次数，同时明确首次尝试是否计入上限。"]},
        {"id": "F-2", "kind": "undocumented_change", "title": "新增访客用户名限制", "description": "本次变更新增了独立需求中未说明的限制；开发者有意这样实现，并不等于产品已经批准。",
         "severity": "medium", "requirement_ids": ["REQ-2"], "change_ids": [change_id], "evidence": [cite("base", 7), cite("head", 7)],
         "question": "拒绝证据中所示非空访客用户名的规则，由谁授权？", "suggested_role": "product", "test_ideas": ["分别输入空用户名、证据所示的访客用户名和普通非空用户名，对比行为。"]},
        {"id": "F-3", "kind": "no_evidence", "title": "审计需求缺少已采集证据", "description": "即使没有对应的代码差异，从需求出发审查仍能发现证据缺口。",
         "severity": "medium", "requirement_ids": ["REQ-3"], "change_ids": [], "evidence": [],
         "question": "审计功能是在本次采集范围之外实现的，还是尚未实现？", "suggested_role": "developer", "test_ideas": ["触发一次重试失败，观察审计日志是否记录该事件。"]}]
    return review


def create_demo(out):
    out = safe_path(out)
    if out.exists():
        raise SpecGapError("Demo output must be a new directory; nothing is overwritten")
    out.mkdir(parents=True, exist_ok=False)
    repo = out / "repo"
    repo.mkdir()
    _git(repo, "init", "-b", "main")
    (repo / "app.py").write_text(BASE, encoding="utf-8", newline="\n")
    (repo / "helpers.py").write_text(HELPER, encoding="utf-8", newline="\n")
    _git(repo, "add", "--", "app.py", "helpers.py")
    _git(repo, "commit", "-m", "demo baseline")
    _git(repo, "switch", "-c", "feature")
    (repo / "app.py").write_text(HEAD, encoding="utf-8", newline="\n")
    _git(repo, "add", "--", "app.py")
    _git(repo, "commit", "-m", "demo retry and restriction changes")
    requirements = out / "requirements.md"
    requirements.write_text(REQUIREMENTS, encoding="utf-8", newline="\n")
    policy = {"actors": {"dev": ["developer"], "pm": ["product"], "qa": ["qa"], "sec": ["security"]}}
    write_json(out / "policy.json", policy)
    bundle = prepare(repo, requirements, target="main")
    run = out / "run"
    create_run(run, bundle, policy)
    review = _scripted_review(bundle)
    write_json(out / "scripted-review.json", review)
    import_review(run, review)
    record_response(run, "F-2", "dev", "脚本化示例回复：访客用户名限制是有意加入的，但尚未获得产品批准。", attest_local=True)
    report = "脚本化示例，不代表模型效果评估。\n\n" + render_report(bundle, review, load_events(run))
    (out / "report.md").write_text(report, encoding="utf-8", newline="\n")
    return run


def run_demo(out):
    run = create_demo(out)
    return {"run": str(run), "report": str(run.parent / "report.md"),
            "semantic_review": "scripted_fixture_not_model_evaluation", "release_approval": False}
