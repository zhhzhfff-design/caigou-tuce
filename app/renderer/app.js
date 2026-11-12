"use strict";

/* ================= 状态 ================= */
const PAGE = 60;
const state = {
  all: [], view: [], rendered: 0,
  cat: "__all__", kw: "", mode: "grid", thumb: 300,
  dataDir: "", ctxItem: null, editing: null, busy: false
};

const $ = id => document.getElementById(id);
const grid = $("grid"), scroller = $("scroller"), loadingEl = $("loading");
const emptyEl = $("empty"), countEl = $("count"), sentinel = $("sentinel");

/* ================= 工具 ================= */
let toastTimer = null;
function toast(msg, ms) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms || 2200);
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fileUrl(p) { return "file:///" + encodeURI(String(p).replace(/\\/g, "/")); }
function imgUrl(it) {
  if (!state.dataDir) return "";
  if (it.thumb) return fileUrl(state.dataDir + "/thumbs/" + it.thumb);
  if (it.img) return fileUrl(state.dataDir + "/images/" + it.img);
  return "";
}
function norm(s) {
  return String(s || "").trim().toLowerCase().replace(/\.(jpe?g|png|webp|gif|bmp|avif)$/i, "");
}

/* 图片加载失败：显示占位，而不是一片白 */
window.imgFail = function (el) {
  el.style.display = "none";
  const box = el.parentNode;
  if (!box || box.querySelector(".ph")) return;
  const d = document.createElement("div");
  d.className = "ph";
  d.innerHTML = '图片损坏<br><span style="font-size:10px;color:#C0C0C0">右键可重新上传</span>';
  box.appendChild(d);
};

/* ================= 自动归类规则 ================= */
const CAT_RULES = [
  { cat: "数据线", keys: ["数据线", "充电线", "快充线", "usb线", "type-c线", "typec", "lightning", "延长线", "转接头", "otg", "cc线"] },
  { cat: "充电器", keys: ["充电器", "充电头", "适配器", "快充头", "氮化镓", "无线充", "电源适配", "插头"] },
  { cat: "充电宝", keys: ["充电宝", "移动电源", "powerbank", "power bank", "应急电源"] },
  { cat: "蓝牙耳机", keys: ["耳机", "耳麦", "蓝牙耳", "入耳", "半入耳", "骨传导", "airpods", "tws"] },
  { cat: "音箱", keys: ["音箱", "音响", "喇叭", "扬声器"] },
  { cat: "手机壳", keys: ["手机壳", "保护壳", "保护套", "皮套", "硅胶壳", "透明壳", "防摔壳"] },
  { cat: "钢化膜", keys: ["钢化膜", "贴膜", "保护膜", "屏幕膜"] },
  { cat: "手机支架", keys: ["支架", "托架", "懒人架", "车载架", "指环扣", "磁吸架"] },
  { cat: "键鼠外设", keys: ["键盘", "鼠标", "键鼠", "手柄"] },
  { cat: "存储", keys: ["u盘", "移动硬盘", "内存卡", "tf卡", "读卡器", "固态"] },
  { cat: "小家电", keys: ["风扇", "加湿器", "电煮锅", "榨汁", "净水", "吹风机", "剃须刀"] },
  { cat: "家居日用", keys: ["收纳", "挂钩", "置物架", "清洁", "抹布", "垃圾桶", "拖鞋", "毛巾"] },
  { cat: "厨房用品", keys: ["锅", "碗", "杯", "餐具", "刀具", "保鲜", "砧板"] },
  { cat: "美妆个护", keys: ["面膜", "洗发", "沐浴", "牙刷", "护肤", "香水", "口红"] },
  { cat: "服饰配件", keys: ["袜", "帽", "手套", "围巾", "腰带", "内衣"] },
  { cat: "玩具", keys: ["玩具", "积木", "拼图", "模型", "娃娃"] }
];

function autoCategorize(name) {
  const s = String(name || "").toLowerCase();
  if (!s) return "";
  for (const r of CAT_RULES) {
    if (r.keys.some(k => s.includes(k))) return r.cat;
  }
  return "";
}

async function autoCategorizeAll() {
  let n = 0;
  state.all.forEach(it => {
    if (!it.cat) {
      const c = autoCategorize(it.name || it.orig || "");
      if (c) { it.cat = c; n++; }
    }
  });
  if (n) await window.api.saveItems(state.all);
  return n;
}

/* ================= 渲染 ================= */
function cardHTML(it, idx) {
  const src = imgUrl(it);
  const hasLink = !!(it.url && it.url.trim());
  const price = String(it.price || "").trim();
  return `<article class="card" data-id="${esc(it.id)}" style="--i:${idx % 24}">
    <div class="thumb">
      ${src
        ? `<img src="${src}" alt="" loading="lazy" onload="this.classList.add('loaded');this.parentNode.classList.add('loaded')" onerror="imgFail(this)">`
        : `<div class="ph">暂无图片</div>`}
      ${price ? `<span class="price">${esc(price)}</span>` : ""}
    </div>
    <div class="info">
      <div class="n">${esc(it.name || it.orig || "未命名商品")}</div>
      <div class="m">
        <span class="sku">${esc(it.sku || it.id)}</span>
        <button class="iact" data-act="edit">编辑</button>
        <span class="go ${hasLink ? "" : "no"}">${hasLink ? "打开 ↗" : "无链接"}</span>
      </div>
    </div>
  </article>`;
}

function rowHTML(it) {
  const src = imgUrl(it);
  const hasLink = !!(it.url && it.url.trim());
  return `<div class="row" data-id="${esc(it.id)}">
    ${src ? `<img class="rt" src="${src}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : `<div class="rt"></div>`}
    <div class="rn">
      <span class="t">${esc(it.name || it.orig || "未命名商品")}</span>
      <span class="s">${esc(it.sku || it.id)}</span>
    </div>
    <div class="rc">${esc(it.cat || "未分类")}</div>
    <div class="rp">${it.price ? esc(it.price) : ""}</div>
    <div class="rl ${hasLink ? "ok" : "no"}">${hasLink ? "已关联" : "无链接"}</div>
    <div class="go">打开 ↗</div>
  </div>`;
}

const LIST_HEAD = `<div class="lhead">
  <div class="h1"></div><div class="h2">商品名称 / 货号</div>
  <div class="h3">分类</div><div class="h6">价格</div><div class="h4">链接</div><div class="h5"></div>
</div>`;

function renderMore() {
  if (state.rendered >= state.view.length) { loadingEl.classList.remove("show"); return; }
  loadingEl.classList.add("show");

  const slice = state.view.slice(state.rendered, state.rendered + PAGE);
  const buf = document.createElement("div");
  buf.innerHTML = state.mode === "grid"
    ? slice.map((it, i) => cardHTML(it, i)).join("")
    : slice.map(rowHTML).join("");

  if (state.mode === "grid") {
    const frag = document.createDocumentFragment();
    while (buf.firstElementChild) frag.appendChild(buf.firstElementChild);
    grid.appendChild(frag);
  } else {
    let listEl = grid.querySelector(".list");
    if (!listEl) {
      listEl = document.createElement("div");
      listEl.className = "list";
      listEl.innerHTML = LIST_HEAD;
      grid.appendChild(listEl);
    }
    while (buf.firstElementChild) listEl.appendChild(buf.firstElementChild);
  }
  grid.style.display = state.mode === "grid" ? "grid" : "block";
  state.rendered += slice.length;
  loadingEl.classList.toggle("show", state.rendered < state.view.length);
  updateCount();
}

function resetRender() {
  grid.innerHTML = "";
  grid.style.display = state.mode === "grid" ? "grid" : "block";
  state.rendered = 0;
  const has = state.view.length > 0;
  emptyEl.style.display = has ? "none" : "block";
  if (!has) {
    emptyEl.innerHTML = state.kw || state.cat !== "__all__"
      ? `<h3>没有找到匹配的商品</h3><p>换个关键词，或者点「全部」看看</p>`
      : `<h3>还没有商品</h3><p>把你的商品图片和表格导入进来<br>1000 张也能一次搞定</p>
         <button class="big" onclick="openPanel('importPanel')">
           <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
             <path d="M12 5v14M5 12h14"></path></svg>
           导入商品
         </button>`;
  }
  renderMore();
  updateCount();
}

function updateCount() {
  const t = state.view.length;
  countEl.textContent = state.kw ? `${t} 件匹配「${state.kw}」` : `共 ${t} 件商品`;
}

function applyFilter() {
  const kw = state.kw.trim().toLowerCase();
  state.view = state.all.filter(it => {
    if (state.cat !== "__all__" && (it.cat || "未分类") !== state.cat) return false;
    if (!kw) return true;
    return ((it.name || "") + " " + (it.sku || "") + " " + (it.note || "") + " " +
      (it.cat || "") + " " + (it.id || "") + " " + (it.orig || "") + " " + (it.price || ""))
      .toLowerCase().includes(kw);
  });
  resetRender();
}

function renderPills() {
  const map = new Map();
  state.all.forEach(it => {
    const c = it.cat || "未分类";
    map.set(c, (map.get(c) || 0) + 1);
  });
  const arr = [...map.entries()].sort((a, b) => b[1] - a[1]);
  let html = `<div class="pill ${state.cat === "__all__" ? "on" : ""}" data-cat="__all__">
      全部<span class="n">${state.all.length}</span></div>`;
  html += arr.map(([c, n]) =>
    `<div class="pill ${state.cat === c ? "on" : ""}" data-cat="${esc(c)}">${esc(c)}<span class="n">${n}</span></div>`
  ).join("");
  $("pills").innerHTML = html;
}

function refreshAll() {
  const cats = [...new Set(state.all.map(it => it.cat).filter(Boolean))].sort();
  $("catOptions").innerHTML = cats.map(c => `<option value="${esc(c)}">`).join("");
  renderPills();
  applyFilter();
}

/* ================= 面板 ================= */
function openPanel(id) {
  document.querySelectorAll(".panel").forEach(p => p.classList.remove("show"));
  $("mask").classList.add("show");
  const p = $(id);
  if (p) {
    p.classList.add("show");
    if (id === "urlPanel") setTimeout(() => $("urlInput").focus(), 220);
  }
}
function closePanels() {
  document.querySelectorAll(".panel").forEach(p => p.classList.remove("show"));
  $("mask").classList.remove("show");
  $("ctx").classList.remove("show");
}
$("mask").addEventListener("click", closePanels);
document.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", closePanels));
document.addEventListener("keydown", e => {
  if (e.key === "Escape") closePanels();
});

/* ================= 进度 ================= */
function showProgress(on, text, pct) {
  $("progress").classList.toggle("show", on);
  if (text != null) $("ptxt").textContent = text;
  if (pct != null) $("bar").style.width = pct + "%";
}
if (window.api && window.api.onProgress) {
  window.api.onProgress(d => {
    const pct = d.total ? Math.round(d.done / d.total * 100) : 0;
    showProgress(true, `处理中 ${d.done}/${d.total}${d.text ? " · " + d.text.slice(0, 28) : ""}`, pct);
  });
}

/* ================= 导入 ================= */
async function reload() {
  const res = await window.api.loadItems();
  state.all = res.items || [];
  state.dataDir = res.dataDir || state.dataDir;
  refreshAll();
}

async function doImportPaths(files) {
  if (!files || !files.length) return;
  closePanels();
  showProgress(true, `正在导入 ${files.length} 张图片…`, 3);
  state.busy = true;
  try {
    const r = await window.api.importPaths(files);
    await reload();
    const autoN = await autoCategorizeAll();
    if (autoN) await reload();
    showProgress(false);
    state.busy = false;
    let msg = `导入 ${r.added} 张`;
    if (r.skipped) msg += `，跳过 ${r.skipped} 张（已存在或读不了）`;
    if (autoN) msg += `，自动归类 ${autoN} 条`;
    toast(msg, 3600);
  } catch (e) {
    showProgress(false);
    state.busy = false;
    toast("导入失败：" + e.message, 4000);
  }
}

$("optFiles").addEventListener("click", async () => {
  const r = await window.api.pickImages();
  if (r.ok) doImportPaths(r.files);
});

$("optFolder").addEventListener("click", async () => {
  const r = await window.api.pickFolder();
  if (r.ok) {
    if (!r.files.length) return toast("这个文件夹里没有找到图片");
    doImportPaths(r.files);
  }
});

$("optUrl").addEventListener("click", () => openPanel("urlPanel"));

$("urlGo").addEventListener("click", async () => {
  const raw = $("urlInput").value;
  const urls = raw.split(/[\n\r]+/).map(s => s.trim()).filter(s => /^https?:\/\//i.test(s));
  if (!urls.length) return toast("没有识别到有效链接（要以 http 开头）");
  closePanels();
  showProgress(true, `正在下载 ${urls.length} 张图片…`, 2);
  try {
    const r = await window.api.importUrls(urls);
    await reload();
    showProgress(false);
    $("urlInput").value = "";
    let msg = `成功下载 ${r.added} 张`;
    if (r.failed && r.failed.length) msg += `，${r.failed.length} 张失败`;
    toast(msg, 3600);
  } catch (e) {
    showProgress(false);
    toast("下载失败：" + e.message, 4000);
  }
});

/* ---------- 表格导入 ---------- */
const HEADER_WORDS = [
  ["img", ["图片文件名", "图片名", "图片", "文件名", "主图", "image", "filename", "img", "file"]],
  ["url", ["采购链接", "商品链接", "链接地址", "链接", "采购地址", "地址", "url", "link"]],
  ["sku", ["货号", "编号", "sku", "编码", "款号", "型号", "code"]],
  ["price", ["价格", "跟卖价", "最低价", "售价", "报价", "单价", "金额", "price", "cost"]],
  ["category", ["分类", "类目", "品类", "category", "cat"]],
  ["name", ["商品名称", "商品名", "产品名称", "名称", "品名", "title", "name"]],
  ["note", ["备注", "说明", "note", "remark", "memo"]]
];

function detectHeader(row) {
  const map = {}, used = new Set();
  const clean = v => String(v || "").trim().toLowerCase().replace(/[\s_\-]/g, "");
  for (const [key, words] of HEADER_WORDS) {
    let idx = -1;
    for (let i = 0; i < row.length; i++) {
      if (used.has(i)) continue;
      if (words.includes(clean(row[i]))) { idx = i; break; }
    }
    if (idx < 0) {
      for (let i = 0; i < row.length; i++) {
        if (used.has(i)) continue;
        const s = clean(row[i]);
        if (s && words.some(w => s.includes(w))) { idx = i; break; }
      }
    }
    if (idx >= 0) { map[key] = idx; used.add(idx); }
  }
  return map;
}

async function applyTable(rows) {
  if (!rows || !rows.length) return toast("表格是空的");

  const head = detectHeader(rows[0]);
  const hasHeader = head.name !== undefined || head.url !== undefined || head.img !== undefined;
  const start = hasHeader ? 1 : 0;

  // 没识别到表头就按默认列序
  const col = hasHeader ? head : { img: 0, name: 1, url: 2, category: 3, sku: 4, note: 5 };

  const get = (r, k) => (col[k] !== undefined && r[col[k]] !== undefined ? String(r[col[k]]).trim() : "");

  const byOrig = new Map();
  state.all.forEach(it => {
    if (it.orig) byOrig.set(norm(it.orig), it);
    if (it.name) byOrig.set(norm(it.name), it);
    if (it.img) byOrig.set(norm(it.img), it);
  });

  let maxSeq = 0;
  state.all.forEach(it => {
    const m = /(\d+)/.exec(it.id || "");
    if (m) maxSeq = Math.max(maxSeq, parseInt(m[1], 10));
  });

  let updated = 0, created = 0;
  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r.some(c => String(c || "").trim() !== "")) continue;

    const imgName = get(r, "img");
    const name = get(r, "name");
    const url = get(r, "url");
    const cat = get(r, "category");
    const sku = get(r, "sku");
    const note = get(r, "note");
    const price = get(r, "price");

    const hit = imgName ? byOrig.get(norm(imgName)) : (name ? byOrig.get(norm(name)) : null);

    if (hit) {
      if (name) hit.name = name;
      if (url) hit.url = url;
      if (cat) hit.cat = cat;
      if (sku) hit.sku = sku;
      if (note) hit.note = note;
      if (price) hit.price = price;
      updated++;
    } else {
      const finalName = name || (imgName ? imgName.replace(/\.[^.]+$/, "") : "");
      const item = {
        id: "C" + String(++maxSeq).padStart(4, "0"),
        orig: imgName || "",
        img: "", thumb: "",
        name: finalName,
        sku, url, note, price,
        cat: cat || autoCategorize(finalName),
        pending: true,
        ts: Date.now()
      };
      state.all.push(item);
      if (imgName) byOrig.set(norm(imgName), item);
      created++;
    }
  }

  await window.api.saveItems(state.all);
  await reload();
  const autoN = await autoCategorizeAll();
  if (autoN) await reload();
  let msg = [];
  if (updated) msg.push(`更新 ${updated} 条`);
  if (created) msg.push(`新增 ${created} 条（等图片）`);
  if (autoN) msg.push(`自动归类 ${autoN} 条`);
  toast("表格导入完成：" + (msg.join("，") || "没有变化"), 3600);
}

$("optTable").addEventListener("click", async () => {
  const r = await window.api.pickTable();
  if (!r.ok) { if (r.error) toast("读取失败：" + r.error, 4000); return; }
  closePanels();
  await applyTable(r.rows);
});

$("optTpl").addEventListener("click", async () => {
  const r = await window.api.makeTemplate();
  if (r.ok) toast("模板已保存：" + r.file, 4000);
});

$("optExport").addEventListener("click", async () => {
  if (!state.all.length) return toast("还没有商品可导出");
  const r = await window.api.exportList(state.all);
  if (r.ok) toast("已导出：" + r.file, 4000);
});

$("optOpenDir").addEventListener("click", () => window.api.openDataDir());

$("optClear").addEventListener("click", async () => {
  if (!state.all.length) return toast("本来就是空的");
  if (!confirm(`确定清空全部 ${state.all.length} 件商品？\n\n图片文件和清单都会被删除，不可恢复。\n建议先「导出当前清单」备份一下。`)) return;
  if (!confirm("再确认一次：真的要全删掉吗？")) return;
  await window.api.clearAll();
  await reload();
  closePanels();
  toast("已清空");
});

/* ---------- 拖拽 ---------- */
const dropEl = $("drop");
["dragenter", "dragover"].forEach(ev => {
  document.addEventListener(ev, e => {
    e.preventDefault();
    if ($("importPanel").classList.contains("show")) dropEl.classList.add("over");
  });
});
["dragleave", "drop"].forEach(ev => {
  document.addEventListener(ev, e => {
    e.preventDefault();
    if (ev === "drop" || e.target === document.documentElement) dropEl.classList.remove("over");
  });
});
document.addEventListener("drop", async e => {
  e.preventDefault();
  const files = [...(e.dataTransfer.files || [])];
  if (!files.length) return;

  const paths = [];
  for (const f of files) {
    try {
      const p = window.api.getPathForFile ? window.api.getPathForFile(f) : (f.path || "");
      if (p) paths.push(p);
    } catch (err) { /* 忽略 */ }
  }
  if (!paths.length) return toast("没读到文件路径，请改用「选择图片」按钮");

  closePanels();

  // 拖进来的是表格？
  const table = paths.find(p => /\.(xlsx|xls|csv)$/i.test(p));
  const imgs = paths.filter(p => /\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(p));

  if (table) {
    const r = await window.api.readTableFile(table);
    if (r.ok) await applyTable(r.rows);
    else toast("表格读取失败：" + (r.error || ""), 4000);
  }
  if (imgs.length) await doImportPaths(imgs);
  if (!table && !imgs.length) toast("没识别到图片或表格文件");
});

/* ================= 编辑 ================= */
function openEdit(it) {
  state.editing = it;
  $("edTitle").textContent = it.pending ? "补全商品信息" : "编辑商品";
  const src = imgUrl(it);
  $("edImgBox").innerHTML = src
    ? `<img src="${src}" onerror="this.parentNode.innerHTML='<span class=\\'none\\'>图片丢失</span>'">`
    : `<span class="none">暂无图片</span>`;
  $("edName").value = it.name || "";
  $("edSku").value = it.sku || "";
  $("edPrice").value = it.price || "";
  $("edCat").value = it.cat || "";
  $("edUrl").value = it.url || "";
  $("edNote").value = it.note || "";
  openPanel("editPanel");
  setTimeout(() => $("edName").focus(), 250);
}

$("edSave").addEventListener("click", async () => {
  const it = state.editing;
  if (!it) return;
  it.name = $("edName").value.trim();
  it.sku = $("edSku").value.trim();
  it.price = $("edPrice").value.trim();
  it.cat = $("edCat").value.trim();
  it.url = $("edUrl").value.trim();
  it.note = $("edNote").value.trim();
  delete it.pending;

  await window.api.saveItems(state.all);
  closePanels();
  refreshAll();
  toast("已保存");
});

$("edDel").addEventListener("click", async () => {
  const it = state.editing;
  if (!it) return;
  if (!confirm(`确定删除「${it.name || it.orig || it.id}」？\n图片文件也会一起删掉，不可恢复。`)) return;
  await window.api.deleteItem(it);
  await reload();
  closePanels();
  toast("已删除");
});

$("edPickImg").addEventListener("click", async () => {
  const it = state.editing;
  if (!it) return;
  const r = await window.api.pickImages();
  if (!r.ok || !r.files.length) return;
  const rep = await window.api.replaceImage({ id: it.id, src: r.files[0] });
  if (rep.ok) { await reload(); state.editing = state.all.find(x => x.id === it.id); openEdit(state.editing); toast(rep.warn || "图片已更换"); }
  else toast("更换失败：" + (rep.error || ""));
});

$("edUrlImg").addEventListener("click", async () => {
  const it = state.editing;
  if (!it) return;
  const u = prompt("粘贴图片链接（http 开头）：", "");
  if (!u || !/^https?:\/\//i.test(u.trim())) return;
  const rep = await window.api.replaceImage({ id: it.id, url: u.trim() });
  if (rep.ok) { await reload(); state.editing = state.all.find(x => x.id === it.id); openEdit(state.editing); toast(rep.warn || "图片已更换"); }
  else toast("下载失败：" + (rep.error || ""));
});

/* ================= 右键菜单 ================= */
grid.addEventListener("contextmenu", e => {
  const el = e.target.closest("[data-id]");
  if (!el) return;
  e.preventDefault();
  const it = state.all.find(x => x.id === el.dataset.id);
  if (!it) return;
  state.ctxItem = it;
  const ctx = $("ctx");
  ctx.classList.add("show");
  const w = 160, h = 190;
  ctx.style.left = Math.min(e.clientX, window.innerWidth - w - 10) + "px";
  ctx.style.top = Math.min(e.clientY, window.innerHeight - h - 10) + "px";
});

document.addEventListener("click", e => {
  if (!e.target.closest("#ctx")) $("ctx").classList.remove("show");
});

$("ctx").addEventListener("click", async e => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const it = state.ctxItem;
  $("ctx").classList.remove("show");
  if (!it) return;

  if (b.dataset.act === "open") {
    if (it.url) window.api.openUrl(it.url);
    else toast("还没填采购链接");
  } else if (b.dataset.act === "edit") {
    openEdit(it);
  } else if (b.dataset.act === "copy") {
    if (it.url) { navigator.clipboard.writeText(it.url); toast("链接已复制"); }
    else toast("还没填采购链接");
  } else if (b.dataset.act === "del") {
    if (confirm(`确定删除「${it.name || it.orig || it.id}」？`)) {
      await window.api.deleteItem(it);
      await reload();
      toast("已删除");
    }
  }
});

/* ================= 交互 ================= */
$("btnAdd").addEventListener("click", () => openPanel("importPanel"));

$("pills").addEventListener("click", e => {
  const el = e.target.closest(".pill");
  if (!el) return;
  state.cat = el.dataset.cat;
  renderPills();
  applyFilter();
  scroller.scrollTop = 0;
});

let kwTimer = null;
$("q").addEventListener("input", e => {
  const v = e.target.value;
  $("searchWrap").classList.toggle("filled", !!v);
  clearTimeout(kwTimer);
  kwTimer = setTimeout(() => {
    state.kw = v;
    applyFilter();
    scroller.scrollTop = 0;
  }, 130);
});

$("clrBtn").addEventListener("click", () => {
  $("q").value = "";
  $("searchWrap").classList.remove("filled");
  state.kw = "";
  applyFilter();
  $("q").focus();
});

$("vt").addEventListener("click", e => {
  const b = e.target.closest("button[data-view]");
  if (!b) return;
  state.mode = b.dataset.view;
  [...$("vt").children].forEach(x => x.classList.toggle("on", x === b));
  $("zoomWrap").style.opacity = state.mode === "grid" ? "1" : ".25";
  $("zoomWrap").style.pointerEvents = state.mode === "grid" ? "auto" : "none";
  resetRender();
  scroller.scrollTop = 0;
});

$("zoom").addEventListener("input", e => {
  state.thumb = +e.target.value;
  document.documentElement.style.setProperty("--thumb", state.thumb + "px");
});

grid.addEventListener("click", e => {
  const el = e.target.closest("[data-id]");
  if (!el) return;
  const it = state.all.find(x => x.id === el.dataset.id);
  if (!it) return;

  const act = e.target.closest("[data-act]");
  if (act && act.dataset.act === "edit") {
    e.stopPropagation();
    openEdit(it);
    return;
  }

  if (it.url && it.url.trim()) {
    window.api.openUrl(it.url);
    toast("已打开 · " + (it.sku || it.name || it.id));
  } else {
    openEdit(it);
  }
});

document.addEventListener("keydown", e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault(); $("q").focus(); $("q").select();
  }
});

const io = new IntersectionObserver(entries => {
  if (entries[0].isIntersecting) renderMore();
}, { root: scroller, rootMargin: "700px" });
io.observe(sentinel);

/* ================= 启动 ================= */
async function boot() {
  if (!window.api) {
    document.body.innerHTML = '<div style="padding:60px;color:#888;font-family:sans-serif">请通过「采购图册.exe」启动，不要直接双击 html 文件。</div>';
    return;
  }
  await reload();
  window.__ready = true;
}
boot();
