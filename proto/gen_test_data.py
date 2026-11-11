# -*- coding: utf-8 -*-
"""生成 1000 条压测数据：名字高度相似、外观明显不同，模拟真实痛点"""
import random, os, json
from PIL import Image, ImageDraw, ImageFilter

random.seed(20261111)

W = H = 520
ROOT = os.path.dirname(os.path.abspath(__file__))
IMG_DIR = os.path.join(ROOT, "data", "images")
os.makedirs(IMG_DIR, exist_ok=True)

COLORS = [
    (28, 32, 40), (238, 240, 244), (108, 114, 126), (37, 99, 235), (212, 64, 64),
    (228, 118, 166), (24, 148, 104), (116, 74, 194), (192, 160, 100), (146, 153, 166),
    (22, 56, 112), (246, 194, 58), (86, 86, 94), (18, 18, 22), (200, 210, 225),
]
BACKS = [(255, 255, 255), (253, 253, 253), (250, 250, 251), (255, 255, 255), (248, 249, 250)]


def sh(c, k):
    return tuple(max(0, min(255, int(v * k))) for v in c)


def pick_colors():
    a = random.choice(COLORS)
    b = random.choice(COLORS)
    while b == a:
        b = random.choice(COLORS)
    return a, b


def center_box(w, h):
    return ((W - w) // 2, (H - h) // 2, (W + w) // 2, (H + h) // 2)


# ---------- 各类目绘制 ----------
def draw_cable(d, c1, c2):
    """数据线：弯曲的线 + 两端接头"""
    seg = random.choice([3, 3, 4, 5])
    x0, x1 = 70, W - 70
    y0, y1 = 90, H - 90
    pts = []
    for i in range(seg + 1):
        t = i / seg
        x = x0 + (x1 - x0) * t
        y = y0 + (y1 - y0) * t + (35 if i % 2 else -35) * random.uniform(0.4, 1.4)
        pts.append((x, y))
    w = random.choice([16, 20, 24, 28])
    d.line(pts, fill=c1, width=w, joint="curve")
    for p in (pts[0], pts[-1]):
        rw, rh = random.choice([(54, 34), (44, 44), (62, 30)])
        d.rounded_rectangle([p[0] - rw // 2, p[1] - rh // 2, p[0] + rw // 2, p[1] + rh // 2],
                            radius=7, fill=c2)
        d.rounded_rectangle([p[0] - rw // 2 + 8, p[1] - rh // 2 + 8, p[0] + rw // 2 - 8, p[1] + rh // 2 - 8],
                            radius=4, fill=sh(c2, 0.82))


def draw_charger(d, c1, c2):
    """充电器：圆角方块 + 插脚"""
    bw = random.choice([210, 240, 270])
    bh = random.choice([210, 235, 260])
    x, y = (W - bw) // 2, (H - bh) // 2 + 12
    rad = random.choice([28, 40, 56])
    d.rounded_rectangle([x, y, x + bw, y + bh], radius=rad, fill=c1)
    # 插脚
    pw = random.choice([16, 22, 28])
    gap = random.choice([40, 56, 72])
    py = y - random.choice([26, 34, 44])
    for dx in (-gap - pw // 2, gap - pw // 2):
        d.rounded_rectangle([x + bw // 2 + dx, py, x + bw // 2 + dx + pw, py + 34], radius=5, fill=c2)
    # 接口
    if random.random() < 0.7:
        uh = random.choice([14, 20, 26])
        d.rounded_rectangle([x + bw // 2 - 34, y + bh - uh - 16, x + bw // 2 + 34, y + bh - 16],
                            radius=6, fill=sh(c2, 0.9))


def draw_earphone(d, c1, c2):
    """耳机：两个单元 + 弧线"""
    r = random.choice([56, 66, 78])
    yy = H // 2 + random.randint(-30, 30)
    d.ellipse([W // 2 - 118 - r, yy - r, W // 2 - 118 + r, yy + r], fill=c1)
    d.ellipse([W // 2 + 118 - r, yy - r, W // 2 + 118 + r, yy + r], fill=c1)
    d.arc([W // 2 - 170, yy - 150, W // 2 + 170, yy + 60], 200, 340, fill=c2,
          width=random.choice([10, 14, 18]))
    if random.random() < 0.5:
        sr = random.choice([16, 22])
        d.ellipse([W // 2 - 118 - sr, yy - sr, W // 2 - 118 + sr, yy + sr], fill=sh(c1, 0.72))
        d.ellipse([W // 2 + 118 - sr, yy - sr, W // 2 + 118 + sr, yy + sr], fill=sh(c1, 0.72))


def draw_stand(d, c1, c2):
    """支架：三角底座 + 斜板"""
    base = random.choice([200, 240, 280])
    bx = (W - base) // 2
    by = H - 130
    d.polygon([(W // 2, by - random.choice([120, 150, 180])),
               (bx, by), (bx + base, by)], fill=c1)
    pw = random.choice([190, 220, 250])
    tilt = random.choice([-18, -14, 0, 12])
    d.rounded_rectangle([W // 2 - pw // 2 + tilt, by - 210, W // 2 + pw // 2 + tilt, by - 90],
                        radius=14, fill=c2)


def draw_case(d, c1, c2):
    """手机壳：大圆角矩形 + 摄像头开孔"""
    bw = random.choice([200, 220, 240])
    bh = int(bw * random.choice([1.9, 2.0, 2.05]))
    x, y = (W - bw) // 2, (H - bh) // 2
    d.rounded_rectangle([x, y, x + bw, y + bh], radius=random.choice([34, 44, 54]), fill=c1,
                        outline=sh(c1, 1.25), width=4)
    cw, ch = random.choice([(72, 72), (86, 62), (62, 86)])
    d.rounded_rectangle([x + 20, y + 20, x + 20 + cw, y + 20 + ch], radius=16, fill=sh(c2, 0.92))
    d.ellipse([x + 20 + cw // 2 - 14, y + 20 + ch // 2 - 14,
               x + 20 + cw // 2 + 14, y + 20 + ch // 2 + 14], fill=(26, 28, 32))
    if random.random() < 0.6:
        d.rounded_rectangle([x + 20, y + 20 + ch + 12, x + 20 + cw // 2, y + 20 + ch + 12 + 16],
                            radius=8, fill=sh(c2, 0.8))


DRAWERS = {"cable": draw_cable, "charger": draw_charger, "earphone": draw_earphone,
           "stand": draw_stand, "case": draw_case}

CATS = [
    ("数据线", "cable", "DL", ["三合一数据线", "6A快充数据线", "编织数据线", "Type-C数据线",
                            "磁吸数据线", "伸缩数据线", "双头数据线", "车载数据线"]),
    ("充电器", "charger", "CD", ["20W快充头", "氮化镓充电器", "多口充电器", "车载充电器",
                              "无线充电器", "折叠充电头", "PD快充头", "桌充充电站"]),
    ("蓝牙耳机", "earphone", "EJ", ["半入耳蓝牙耳机", "入耳降噪耳机", "挂脖蓝牙耳机",
                                "游戏低延迟耳机", "骨传导耳机", "运动蓝牙耳机"]),
    ("手机支架", "stand", "ZJ", ["桌面手机支架", "折叠支架", "磁吸支架", "床头支架",
                              "车载支架", "平板支架"]),
    ("手机壳", "case", "SH", ["液态硅胶手机壳", "透明防摔壳", "磨砂硬壳", "皮纹手机壳",
                            "磁吸手机壳", "气囊防摔壳"]),
]

LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
items = []
idx = 0
for cat_name, key, prefix, bases in CATS:
    per_cat = 1000 // len(CATS)  # 200
    for i in range(per_cat):
        idx += 1
        base = bases[i % len(bases)]
        letter = LETTERS[(i // len(bases)) % 26]
        variant = f"{letter}款" if random.random() < 0.8 else f"{letter}{random.choice(['款', '版', '型'])}"
        name = f"{base} {variant}"
        code = f"P{idx:04d}"
        fn = f"{code}.jpg"

        bgc = random.choice(BACKS)
        c1, c2 = pick_colors()

        # 先画在透明图层上，再缩小居中贴到白底，模拟真实电商主图
        tmp = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(tmp)
        DRAWERS[key](d, c1, c2)

        scale = random.uniform(0.68, 0.76)
        sw, shh = int(W * scale), int(H * scale)
        art = tmp.resize((sw, shh), Image.LANCZOS)
        ox, oy = (W - sw) // 2, (H - shh) // 2

        base = Image.new("RGBA", (W, H), bgc + (255,))
        alpha = art.split()[3]
        shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        shadow.paste((0, 0, 0, 58), (ox + 3, oy + 11), alpha)
        shadow = shadow.filter(ImageFilter.GaussianBlur(11))
        base = Image.alpha_composite(base, shadow)
        base.paste(art, (ox, oy), art)
        img = base.convert("RGB")
        img.save(os.path.join(IMG_DIR, fn), "JPEG", quality=86, optimize=True)

        items.append({
            "id": code,
            "img": fn,
            "name": name,
            "sku": f"{prefix}-{i + 1:04d}",
            "cat": cat_name,
            "url": f"https://detail.1688.com/offer/{1000000 + idx}.html",
            "note": "",
            "ts": 1750000000000 + idx * 60000,
        })

with open(os.path.join(ROOT, "data", "items.json"), "w", encoding="utf-8") as f:
    json.dump(items, f, ensure_ascii=False, indent=1)

print("生成完成:", len(items), "条, 图片目录:", IMG_DIR)
print("样例:", items[0]["name"], items[0]["sku"])
