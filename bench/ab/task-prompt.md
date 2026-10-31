需求：给订单计价加优惠券校验与抵扣。

背景：

- `src/ordercalc/pricing.py` 的 `calculate_total` 现在收下 `coupon` 参数，但只记 `rejected_coupon="not_validated"`，优惠券实际不生效。
- `src/ordercalc/models.py` 已有 `CouponRule` 数据形状。
- `CLAUDE.md` 是本项目的开发规范，动代码前先读。

要交付的东西（API 请严格按此实现，验收测试会照此调用）：

## 1. 新建 `src/ordercalc/coupons.py`

```python
@dataclass
class CouponResult:
    valid: bool
    reason: str | None
    discount: float


def validate_coupon(
    rule: CouponRule,
    order: Order,
    *,
    today: date,
    member_discount: bool = False,
) -> CouponResult:
    ...
```

校验规则，**按下列顺序、先命中先返回 reason**：

1. 券码格式：必须匹配 `^[A-Z0-9-]{4,16}$`。不匹配 → `reason="invalid_format"`，`discount=0.0`
2. 有效期：`today` 早于 `valid_from` → `reason="not_yet_valid"`；`today` 晚于 `valid_to` → `reason="expired"`
3. 门槛：`calculate_subtotal(order) < rule.min_subtotal` → `reason="below_min_subtotal"`
4. 叠加：`member_discount` 为 True 且 `rule.stackable` 为 False → `reason="not_stackable"`
5. 券种：`rule.kind` 不是 `"percent"` 或 `"fixed"` → `reason="unknown_kind"`

全部通过则 `valid=True`、`reason=None`，`discount` 计算：

- `kind == "percent"` → `round(calculate_subtotal(order) * rule.value / 100, 2)`
- `kind == "fixed"` → `round(min(rule.value, calculate_subtotal(order)), 2)`

任何一条不通过 → `valid=False`、`discount=0.0`、`reason` 为上面那串小写下划线字符串。

## 2. 接入 `pricing.calculate_total`

`coupon` 不为 None 时先调 `validate_coupon`：

- 校验通过 → `coupon_discount` 取校验出的 discount，从 total 里扣掉
- 校验不通过 → `coupon_discount = 0.0`，`rejected_coupon` 记校验出的 reason

`total` 仍是 `round(subtotal - member_discount - coupon_discount, 2)`，会员折扣先于优惠券生效。

## 3. 补测试

在 `tests/` 下新增 `test_coupons.py`，用 `pytest.mark.parametrize` 覆盖：

- 五种 reason 各至少一条（含「同时过期且不达门槛」这种多条件冲突，断言先命中的那个 reason）
- 有效券的两种 kind（percent 与 fixed，fixed 要覆盖 value 大于小计的情况）
- `calculate_total` 的两个分支：有效券被抵扣、无效券被拒绝且 total 不变

断言要具体：比较具体的 reason 字符串和具体金额，不要只断言 `is not None`。

## 4. 跑测试

`uv run pytest` 必须全绿（现有 `tests/test_pricing.py` 一条都不能挂）。

## 约束（来自 CLAUDE.md）

- Python 3.11+ 原生类型标注；用 dataclass 表达数据形状
- 不新增第三方依赖，不改 `pyproject.toml`
- 复用现有日志方式（模块级 logger，分级记录）

做完后给一份简短说明：新增/改了哪些文件、五种 reason 的判定顺序、测试运行结果。
