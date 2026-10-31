#!/usr/bin/env python3
"""facts 题判分器：父汇总准确率 + 子代理准确率 + 汇总保真度。

输入（都在工作区 cwd 下）：
  truth.json                       ground truth（台架在模型跑完之后才拷进来，不泄题）
  final_answer.md                  父会话的最终输出
  .pi/ptc-tasks/records/*.json     子代理报告（summary + findings）

输出：最后一行 JSON
  {passed, failed, error, details, parent, children, fidelity}
  - passed/failed 口径 = 父最终输出里命中/未命中的事实条数（硬判分，分母固定 = 事实总数）
  - children       = 子代理并集命中（子代理自己说对了几条）
  - fidelity       = 父汇总的保真度：幻觉（父说有、子代理没说）与丢失（子代理说对、父没写）

数值比对口径：四舍五入到 2 位小数后必须完全相等（题面材料无歧义，算错就是错）。
"""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TRUTH_PATH = ROOT / "truth.json"
ANSWER_PATH = ROOT / "final_answer.md"
RECORDS_DIR = ROOT / ".pi" / "ptc-tasks" / "records"

# F<主题>-<序号> = 数值；允许前导列表符号/表格竖线、分隔符（= : ： | 空白）、可选反引号、千分位逗号
# 分隔符只允许一个（避免「F1-1 的值是 240」这类散文被误匹配成命中）
FACT_RE = re.compile(
    r"^\s*[-*|]?\s*`?\s*(F\d-\d)\s*`?\s*[=:：|]?\s*[–—]?\s*(-?\d[\d,]*(?:\.\d+)?)",
    re.MULTILINE,
)


def parse_facts(text):
    """文本 → {fact_id: 最后一个出现的数值}（同名多值取最后的，模型改口以最后一次为准）"""
    out = {}
    for fid, raw in FACT_RE.findall(text):
        try:
            out[fid] = float(raw.replace(",", ""))
        except ValueError:
            continue
    return out


def is_correct(fid, value, truth):
    if fid not in truth:
        return False
    return round(value, 2) == round(float(truth[fid]), 2)


def value_appears(value, text):
    """正确值是否以任何形式出现在文本里（子代理通常写自然语言：「实际运行功率36千瓦」）。

    机械正则只认 `F2-1 = 36` 这种带 id 的格式 → 子代理用自然语言汇报时会被整段漏掉，
    父的正确结果就会被误判成「幻觉」。所以子代理侧要按**值**兜底匹配。
    """
    number = float(value)
    candidates = {f"{number:g}"}
    if number == int(number):
        candidates.add(str(int(number)))
    for candidate in candidates:
        if re.search(rf"(?<![\d.]){re.escape(candidate)}(?![\d])", text):
            return True
    return False


def child_hits(text, truth, candidates):
    """子代理文本命中的事实集合：先按 id 格式匹配，再按「正确值出现在文本里」兜底。

    candidates = 该子代理**负责**的事实集合（按主题归属限定），
    否则值兜底会把别的主题的同值也算进来（例如 F1-2=15 与 F4-1=15 同值）。
    """
    parsed = parse_facts(text)
    hits = set()
    for fid in candidates:
        value = truth[fid]
        if fid in parsed and is_correct(fid, parsed[fid], truth):
            hits.add(fid)
        elif value_appears(value, text):
            hits.add(fid)
    return hits


def extract_topic(label, task, text):
    """这个子代理负责哪个主题（F<topic>-<序号>）。

    优先看派发任务文本里的材料路径（题面要求一个子代理只读一份档案），
    退回 label，再退回报告正文。
    """
    for haystack in (task or "", label or "", text[:600]):
        match = re.search(r"topic[-_ ]?(\d)", haystack)
        if match:
            return f"F{match.group(1)}"
    return None


def child_output_text(record):
    """孩子最终正文（父在任务面实际读到的就是这份 text）。

    报告通道（record.report）是**可选**的：孩子没按契约交报告块时，父仍拿到完整正文，
    事实也真实存在。此前只从 report 取值 → 报告一丢，孩子说对的事实全被记成「幻觉」
    （2026-10-31 实测：判分 12/12 全对，幻觉却记 12 条）。
    """
    path = record.get("outputPath")
    if not path:
        return ""
    try:
        raw = Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    chunks = []
    for line in raw.split("\n"):
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except Exception:
            continue
        message = event.get("message") or {}
        if event.get("type") != "message_end" or message.get("role") != "assistant":
            continue
        for block in message.get("content") or []:
            if isinstance(block, dict) and block.get("type") == "text":
                chunks.append(str(block.get("text") or ""))
    return "\n".join(chunks)


def child_texts():
    """每个子代理的事实来源（报告正文 + 孩子最终正文）与它收到的任务"""
    texts = []
    if not RECORDS_DIR.is_dir():
        return texts
    for path in sorted(RECORDS_DIR.glob("*.json")):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        report = record.get("report") or {}
        parts = [str(report.get("summary") or "")]
        for finding in report.get("findings") or []:
            if isinstance(finding, dict):
                parts.append(str(finding.get("what") or ""))
                parts.append(str(finding.get("evidence") or ""))
        parts.append(child_output_text(record))
        texts.append((record.get("label"), str(record.get("task") or ""), "\n".join(parts)))
    return texts


def main():
    truth = json.loads(TRUTH_PATH.read_text(encoding="utf-8")) if TRUTH_PATH.is_file() else {}
    total = len(truth)
    if total == 0:
        print(json.dumps({"passed": 0, "failed": 0, "error": 1, "details": ["truth.json 缺失或为空"]}))
        return

    answer = ANSWER_PATH.read_text(encoding="utf-8") if ANSWER_PATH.is_file() else ""
    parent_facts = parse_facts(answer)
    parent_hit = {fid for fid, val in parent_facts.items() if is_correct(fid, val, truth)}

    # 子代理：按主题归属限定候选事实，再取并集
    children = []
    child_hit_union = set()
    for label, task, text in child_texts():
        topic = extract_topic(label, task, text)
        candidates = (
            [fid for fid in truth if fid.startswith(topic)] if topic else list(truth)
        )
        hits = child_hits(text, truth, candidates)
        child_hit_union |= hits
        children.append(
            {"label": label, "topic": topic, "hit": len(hits), "facts": sorted(hits)}
        )

    details = []
    for fid in sorted(truth):
        if fid not in parent_facts:
            details.append(f"缺失 {fid}（应为 {truth[fid]}）")
        elif fid not in parent_hit:
            details.append(f"错误 {fid} = {parent_facts[fid]}（应为 {truth[fid]}）")
    # 父输出里出现、但 ground truth 里根本没有的事实 id = 编造（不占分母，但必须报出来）
    fabricated = sorted(set(parent_facts) - set(truth))
    for fid in fabricated:
        details.append(f"编造事实 id {fid}（ground truth 里没有这条事实）")
    for fid in sorted(parent_hit - child_hit_union):
        details.append(f"幻觉 {fid}：父汇总里有，子代理没说")
    for fid in sorted(child_hit_union - parent_hit):
        details.append(f"丢失 {fid}：子代理说对了，父汇总没写")

    result = {
        "passed": len(parent_hit),
        "failed": total - len(parent_hit),
        "error": 0,
        "details": details[:30],
        "parent": {"hit": len(parent_hit), "total": total, "accuracy": round(len(parent_hit) / total, 4)},
        "children": {
            "count": len(children),
            "hit": len(child_hit_union),
            "total": total,
            "accuracy": round(len(child_hit_union) / total, 4),
            "per_child": children,
        },
        "fidelity": {
            "hallucinated": sorted(parent_hit - child_hit_union),
            "dropped": sorted(child_hit_union - parent_hit),
            "preserved": len(parent_hit & child_hit_union),
            "fabricated": fabricated,
        },
    }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
