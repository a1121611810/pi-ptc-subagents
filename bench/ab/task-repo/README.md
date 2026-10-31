# ordercalc

订单计价内核。纯标准库实现，不含第三方运行时依赖。

```
src/ordercalc/
  __init__.py
  models.py      # 数据形状（dataclass）
  pricing.py     # 小计 / 会员折扣 / 合计
  coupons.py     # 优惠券校验（待实现）
tests/
  test_pricing.py
```

## 开发

```bash
uv run pytest        # 跑测试
uv run python -c "import ordercalc; print(ordercalc.__all__)"
```

改代码前先读 `CLAUDE.md`（项目规范）。
