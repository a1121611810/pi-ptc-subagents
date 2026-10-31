"""facts 题自检正例：写出正确的父汇总 + 4 个子代理报告。

判分器要能看出三层信息：
  parent   = 父最终输出命中几条
  children = 子代理并集命中几条（每个子代理只说自己那 3 条）
  fidelity = 父汇总有没有编（幻觉）、有没有丢（子说对了但父没写）
"""

import json
from pathlib import Path

TRUTH = {
    "F1-1": 240,
    "F1-2": 15,
    "F1-3": 218.25,
    "F2-1": 36,
    "F2-2": 648,
    "F2-3": 466.56,
    "F3-1": 11,
    "F3-2": 3300,
    "F3-3": 300,
    "F4-1": 15,
    "F4-2": 440,
    "F4-3": 7.5,
}

root = Path.cwd()
(root / "final_answer.md").write_text(
    "\n".join(f"{key} = {value}" for key, value in TRUTH.items()), encoding="utf-8"
)

records_dir = root / ".pi" / "ptc-tasks" / "records"
records_dir.mkdir(parents=True, exist_ok=True)

# 汇报的两种形态都要覆盖：
#   summary 用自然语言（「每日名义产量 240 件」→ 靠值兜底匹配）
#   findings 用 id 格式（F1-1 = 240 → 靠 id 匹配）
NATURAL = {
    "F1": "每日名义产量 240 件，实际可生产时长 15 小时，每日合格产量 218.25 件。",
    "F2": "实际运行功率 36 千瓦，每日耗电量 648 度，每日电费 466.56 元。",
    "F3": "当日实际出勤 11 人，每日人力成本 3300 元，人均日成本 300 元。",
    "F4": "不补货可支撑 15 天，触发补货库存水位 440 件，补货批量相当于 7.5 天出库量。",
}

for index, topic in enumerate(["F1", "F2", "F3", "F4"], start=1):
    facts = {key: value for key, value in TRUTH.items() if key.startswith(topic)}
    record = {
        "id": f"child-{index}",
        "status": "succeeded",
        "label": f"topic-{index}",
        "task": f"你负责调研一份档案：materials/topic-{index}.md",
        "startedAt": 1,
        "finishedAt": 2,
        "report": {
            "summary": f"主题 {topic} 的 3 条事实已算出。{NATURAL[topic]}",
            "findings": [
                {"what": f"{key} = {value}", "evidence": f"materials/topic-{index}.md"}
                for key, value in facts.items()
            ],
            "files_touched": [],
            "usage": {"input": 0, "output": 0, "cost": 0, "turns": 1},
        },
    }
    (records_dir / f"child-{index}.json").write_text(
        json.dumps(record, ensure_ascii=False), encoding="utf-8"
    )
