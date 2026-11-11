# -*- coding: utf-8 -*-
"""真实交互测试：图墙 / 列表 / 搜索 / 缩放 / 无限滚动 / 点击跳转"""
import os, sys
from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:8765/index.html"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots")
os.makedirs(OUT, exist_ok=True)


def shot(pg, name):
    p = os.path.join(OUT, name)
    pg.screenshot(path=p)
    return p


with sync_playwright() as pw:
    b = pw.chromium.launch(headless=True)
    pg = b.new_page(viewport={"width": 1600, "height": 1000}, device_scale_factor=1)

    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("console", lambda m: errors.append("console." + m.type + ": " + m.text) if m.type == "error" else None)

    pg.goto(URL, wait_until="networkidle")
    pg.wait_for_function("window.__ready === true", timeout=20000)
    pg.wait_for_timeout(900)

    # ---- 1 图墙首屏 ----
    n_grid = pg.eval_on_selector_all(".card", "els => els.length")
    shot(pg, "1_grid.png")

    # ---- 2 列表模式 ----
    pg.click('button[data-view="list"]')
    pg.wait_for_timeout(700)
    n_row = pg.eval_on_selector_all(".row", "els => els.length")
    shot(pg, "2_list.png")

    # ---- 3 搜索 ----
    pg.click('button[data-view="grid"]')
    pg.wait_for_timeout(300)
    pg.fill("#q", "三合一")
    pg.wait_for_timeout(600)
    cnt_search = pg.text_content("#count").strip().replace("\n", " ")
    n_search = pg.eval_on_selector_all(".card", "els => els.length")
    shot(pg, "3_search.png")

    # ---- 4 搜索 + 分类联动 ----
    pg.click('#pills .pill[data-cat="充电器"]')
    pg.wait_for_timeout(500)
    cnt_cat = pg.text_content("#count").strip().replace("\n", " ")
    pg.click('#pills .pill[data-cat="__all__"]')
    pg.click("#clrBtn")
    pg.wait_for_timeout(400)

    # ---- 5 放大缩略图 ----
    pg.eval_on_selector("#zoom", "el => { el.value = 300; el.dispatchEvent(new Event('input',{bubbles:true})); }")
    pg.wait_for_timeout(700)
    shot(pg, "4_zoom_big.png")
    pg.eval_on_selector("#zoom", "el => { el.value = 150; el.dispatchEvent(new Event('input',{bubbles:true})); }")
    pg.wait_for_timeout(500)
    shot(pg, "5_zoom_small.png")
    pg.eval_on_selector("#zoom", "el => { el.value = 190; el.dispatchEvent(new Event('input',{bubbles:true})); }")
    pg.wait_for_timeout(400)

    # ---- 6 无限滚动 ----
    counts = []
    for i in range(4):
        pg.eval_on_selector("#scroller", "el => el.scrollTop = el.scrollHeight")
        pg.wait_for_timeout(900)
        counts.append(pg.eval_on_selector_all(".card", "els => els.length"))
    shot(pg, "6_scrolled.png")

    # ---- 7 点击卡片是否开新页 ----
    with pg.context.expect_page(timeout=4000) as newp:
        pg.click(".card")
    np = newp.value
    opened = np.url
    np.close()

    # ---- 8 无链接卡片的提示（造一条临时数据验证） ----
    pg.evaluate("""() => {
        const it = state.all[0];
        state.all[0] = {...it, url: '', img: ''};
        applyFilter();
    }""")
    pg.wait_for_timeout(500)
    shot(pg, "7_noimg.png")

    print("== 结果 ==")
    print("图墙首屏卡片:", n_grid)
    print("列表模式行数:", n_row)
    print("搜索『三合一』:", cnt_search, "| 卡片数:", n_search)
    print("分类『充电器』:", cnt_cat)
    print("滚动加载累计卡片:", counts)
    print("点击卡片打开:", opened)
    print("JS 错误:", errors if errors else "无")

    b.close()
