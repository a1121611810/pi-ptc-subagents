"""几何形状：面积与周长。"""

from dataclasses import dataclass


@dataclass
class Shape:
    """一个形状的度量结果。"""

    area: float
    perimeter: float


def rectangle_area(width: float, height: float) -> float:
    """矩形面积。"""
    return width * height


def circle_area(radius: float) -> float:
    """圆面积。"""
    return 3.14159 * radius * radius


def shape_summary(width: float, height: float, radius: float) -> Shape:
    """把矩形与圆的度量并成一条摘要。"""
    return Shape(
        area=rectangle_area(width, height) + circle_area(radius),
        perimeter=2 * (width + height),
    )
