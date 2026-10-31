# ordercalc 项目规范

本文件是本项目的开发约定，改代码前必读。

## 代码风格

- Python 3.11+，全部函数带**原生类型标注**（`list[str]` 而不是 `List[str]`）
- 优先用 `dataclass` 表达数据形状，不要用裸 dict 到处传
- 新增模块必须带模块级 docstring，说明它负责什么
- 公开函数必须有单行 docstring，说明输入输出与失败语义

## 错误处理与日志

- 复用现有模块的日志方式：模块级 `logger = logging.getLogger(__name__)`，用 `debug`/`info`/`warning`/`error` 分级
- 自定义异常要带上下文信息（把出错的入参带进消息里）
- 不要吞异常；能降级就降级并记 `warning`，不能降级就往上抛

## 依赖

- **不新增第三方依赖**。本任务不需要改 `pyproject.toml`
- 只用标准库 + 已在 `pyproject.toml` 里的依赖

## 测试

- 测试放 `tests/`，文件命名 `test_<模块名>.py`
- 用 `pytest` + `@pytest.mark.parametrize` 覆盖多组输入
- 断言要具体：不要只断言 `assert result is not None`
- 改完代码必须跑一遍 `python -m pytest`，现有测试必须全绿
