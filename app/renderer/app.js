"use strict";

/* ================= 状态 ================= */
const PAGE = 40;
const state = {
  all: [], view: [], rendered: 0,
  cat: "__all__", kw: "", mode: "grid", thumb: 300,
  dataDir: "", ctxItem: null, editing: null, busy: false,
  selectMode: false, selected: new Set()
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
  { cat: "灯饰", keys: ["壁灯", "吊灯", "台灯", "吸顶灯", "射灯", "筒灯", "灯带", "落地灯", "氛围灯", "灯泡", "led灯"] },
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

/* 价格两位小数，去掉多余零 */
function fmtPrice(v) {
  const n = parseFloat(v);
  if (!isFinite(n)) return String(v || "");
  return n.toFixed(2).replace(/\.?0+$/, "");
}

/* 重量统一按克显示，超过 1000 转 kg */
function fmtWeight(w) {
  const n = parseFloat(w);
  if (!isFinite(n) || n <= 0) return "";
  if (n >= 1000) {
    const kg = n / 1000;
    return (kg % 1 === 0 ? kg.toFixed(0) : kg.toFixed(2)) + "kg";
  }
  return Math.round(n) + "g";
}

/* 清洗商品名：过滤「3个起批」这类备注和自动生成的文件名 */
const NOISE_NAME = /^(?:\d+\s*个?起批|起批|包邮|现货|一件代发|混批|批发|量大从优|支持定制)[，,。\s]*$/;

function cleanName(v) {
  const t = String(v || "").trim();
  if (!t) return "";
  if (NOISE_NAME.test(t)) return "";
  if (/^ex_[A-Za-z0-9]+$/i.test(t)) return "";      // 嵌入图的临时文件名
  if (/^[A-Za-z0-9_\-]+\.(?:jpe?g|png|webp|gif)$/i.test(t)) return "";  // 纯文件名
  return t;
}

/* 长标题截短：优先取第一个逗号前的部分 */
function shortTitle(t) {
  const s = String(t || "").trim();
  if (!s) return "";
  const cut = s.split(/[，,]/)[0].trim();
  return cut.length > 40 ? cut.slice(0, 40) + "…" : cut;
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
  const cost = String(it.cost || "").trim();
  const weight = String(it.weight || "").trim();
  const subParts = [];
  if (cost) subParts.push("¥" + fmtPrice(cost));
  if (weight) subParts.push(fmtWeight(weight));
  const sub = subParts.filter(Boolean).join(" · ");
  const picked = state.selected.has(it.id);
  return `<article class="card${picked ? " picked" : ""}" data-id="${esc(it.id)}" style="--i:${idx % 24}">
    <div class="ck">${picked ? CHECK_SVG : ""}</div>
    <div class="thumb">
      ${src
        ? `<img src="${src}" alt="" loading="lazy" onload="this.classList.add('loaded');this.parentNode.classList.add('loaded')" onerror="imgFail(this)">`
        : `<div class="ph">暂无图片</div>`}
      ${(price || sub) ? `<div class="tagbox">
        ${price ? `<span class="tp">€${esc(fmtPrice(price))}</span>` : ""}
        ${sub ? `<span class="ts">${esc(sub)}</span>` : ""}
      </div>` : ""}
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
  const picked = state.selected.has(it.id);
  return `<div class="row${picked ? " picked" : ""}" data-id="${esc(it.id)}">
    <div class="ck">${picked ? CHECK_SVG : ""}</div>
    ${src ? `<img class="rt" src="${src}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : `<div class="rt"></div>`}
    <div class="rn">
      <span class="t">${esc(it.name || it.orig || "未命名商品")}</span>
      <span class="s">${esc(it.sku || it.id)}</span>
    </div>
    <div class="rc">${esc(it.cat || "未分类")}</div>
    <div class="rp">${it.price ? "€" + esc(fmtPrice(it.price)) : ""}</div>
    <div class="rq">${it.cost ? "¥" + esc(fmtPrice(it.cost)) : ""}</div>
    <div class="rw">${it.weight ? esc(fmtWeight(it.weight)) : ""}</div>
    <div class="rl ${hasLink ? "ok" : "no"}">${hasLink ? "已关联" : "无链接"}</div>
    <div class="go">打开 ↗</div>
  </div>`;
}

const CHECK_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"></path></svg>';

const LIST_HEAD = `<div class="lhead">
  <div class="h1"></div><div class="h2">商品名称 / 货号</div>
  <div class="h3">分类</div><div class="h6">售价</div><div class="h6">成本</div><div class="h7">重量</div><div class="h4">链接</div><div class="h5"></div>
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
      (it.cat || "") + " " + (it.id || "") + " " + (it.orig || "") + " " + (it.price || "") + " " + (it.cost || "") + " " + (it.weight || "") + " " + (it.spec || ""))
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
  // imgUrl 必须排在 img 前面，否则「图片链接」会被「图片」抢先匹配
  ["imgUrl", ["图片链接", "图片地址", "图片url", "imgurl", "imageurl", "原图地址", "原图链接"]],
  ["img", ["图片文件名", "图片名", "本地图片", "图片", "照片", "主图", "文件名", "image", "filename", "img", "file"]],
  ["url", ["采购链接", "商品链接", "链接地址", "链接", "采购地址", "地址", "url", "link"]],
  ["sku", ["货号", "编号", "sku", "编码", "款号", "型号", "code"]],
  ["cost", ["价格(¥)", "价格(元)", "采购价", "成本价", "进价", "1688价格", "成本", "人民币", "cost"]],
  ["price", ["售价", "跟卖价", "最低价", "卖价", "零售价", "price"]],
  ["weight", ["重量(G)", "重量(g)", "重量(KG)", "重量(kg)", "克重", "毛重", "重量", "weight"]],
  ["spec", ["规格", "规格型号", "尺寸", "款式", "容量", "spec", "size"]],
  ["category", ["分类", "类目", "品类", "category", "cat"]],
  ["name", ["商品名称", "商品名", "产品名称", "名称", "品名", "title", "name"]],
  ["note", ["备注", "说明", "note", "remark", "memo"]]
];

function detectHeader(row) {
  const map = {}, used = new Set();
  const clean = v => String(v || "").trim().toLowerCase().replace(/[\s_\-]/g, "");
  for (const [key, words] of HEADER_WORDS) {
    let idx = -1;
    // 精确匹配时按关键词优先级走，而不是按列顺序
    for (const w of words) {
      for (let i = 0; i < row.length; i++) {
        if (used.has(i)) continue;
        if (clean(row[i]) === w) { idx = i; break; }
      }
      if (idx >= 0) break;
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

async function applyTable(rows, images) {
  images = images || {};
  if (!rows || !rows.length) return toast("表格是空的");

  const head = detectHeader(rows[0]);
  const hasHeader = head.name !== undefined || head.url !== undefined || head.img !== undefined;
  const start = hasHeader ? 1 : 0;

  // 没识别到表头就按默认列序
  const col = hasHeader ? head : { img: 0, name: 1, url: 2, category: 3, sku: 4, note: 5 };

  const get = (r, k) => (col[k] !== undefined && r[col[k]] !== undefined ? String(r[col[k]]).trim() : "");

  const byOrig = new Map();
  const byCombo = new Map();   // 「链接 + 图片」组合键，同一链接下多个商品不会被吞掉
  const comboKey = (u, im) => (u && im ? norm(u) + "||" + norm(im) : "");
  state.all.forEach(it => {
    if (it.orig) byOrig.set(norm(it.orig), it);
    if (it.name) byOrig.set(norm(it.name), it);
    if (it.img) byOrig.set(norm(it.img), it);
    const k1 = comboKey(it.url, it.img);
    const k2 = comboKey(it.url, it.imgUrl);
    if (k1) byCombo.set(k1, it);
    if (k2) byCombo.set(k2, it);
  });

  let maxSeq = 0;
  state.all.forEach(it => {
    const m = /(\d+)/.exec(it.id || "");
    if (m) maxSeq = Math.max(maxSeq, parseInt(m[1], 10));
  });

  let updated = 0, created = 0, createdWithImg = 0, updatedWithImg = 0;
  const touched = new Set();
  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r.some(c => String(c || "").trim() !== "")) continue;

    const rawImg = get(r, "img");
    let embedded = null;
    // 导出表里本地图片写的是 images/xxx.jpg，这里只取文件名
    let imgName = rawImg ? String(rawImg).split(/[\\/]/).pop() : "";
    let cellImgUrl = "";   // 照片列里填的直接是图片地址

    // 整行扫一遍找嵌入图片标记（表格里可能没有"图片"这一列）
    for (let ci = 0; ci < r.length; ci++) {
      const cellV = String(r[ci] == null ? "" : r[ci]);
      const tag = /^__IMG__:(ID_[A-Za-z0-9]+)$/.exec(cellV);
      if (tag) { embedded = images[tag[1]] || null; break; }
      // 只在「照片/图片」列里找，别把 1688 商品页链接当图片
      const inImgCol = col.img !== undefined ? ci === col.img : true;
      if (!cellImgUrl && inImgCol && /^https?:\/\//i.test(cellV)) {
        const looksImg = /\.(jpe?g|png|webp|gif|avif)(\?|#|$)/i.test(cellV) ||
                         /\/(mkp|img|image|images|photo|photos|media|pic|picture)\//i.test(cellV);
        const isPage = /\.html?($|\?)/i.test(cellV) || /\/offer\//i.test(cellV) || /\/produits?\//i.test(cellV);
        if (looksImg && !isPage) cellImgUrl = cellV;
      }
    }
    const imTag = /^__IMG__:(ID_[A-Za-z0-9]+)$/.exec(rawImg);
    if (imTag) {
      if (!embedded) embedded = images[imTag[1]] || null;
      imgName = embedded ? embedded.file : "";
    } else if (/^https?:\/\//i.test(rawImg)) {
      // 照片列写的是图片地址，不是文件名
      cellImgUrl = rawImg;
      imgName = "";
    }
    const name = get(r, "name");
    const url = get(r, "url");
    const cat = get(r, "category");
    const sku = get(r, "sku");
    const note = get(r, "note");
    const price = get(r, "price");
    const cost = get(r, "cost");
    let imgUrl = get(r, "imgUrl");
    if (!imgUrl && cellImgUrl) imgUrl = cellImgUrl;
    const spec = get(r, "spec");
    let weight = get(r, "weight");
    // 如果重量列的单位是 KG，统一换算成克
    if (weight && col.weight !== undefined) {
      const colName = String(rows[0][col.weight] || "");
      if (/kg/i.test(colName)) {
        const n = parseFloat(weight);
        if (isFinite(n)) weight = String(Math.round(n * 1000));
      }
    }

    // 依次用 文件名 / 商品名 / 链接+图片 认人，避免重复建条目
    const rowImg = embedded ? embedded.file : (imgUrl || "");
    const combo = comboKey(url, rowImg);
    const hit = (imgName ? byOrig.get(norm(imgName)) : null)
             || (name ? byOrig.get(norm(name)) : null)
             || (combo ? byCombo.get(combo) : null)
             || null;

    if (hit) {
      const cleanN = cleanName(name);
      if (cleanN) hit.name = cleanN;
      else if (hit.name && !cleanName(hit.name)) hit.name = "";
      if (url) hit.url = url;
      if (cat) hit.cat = cat;
      if (sku) hit.sku = sku;
      if (note) hit.note = note;
      if (price) hit.price = price;
      if (cost) hit.cost = cost;
      if (weight) hit.weight = weight;
      if (imgUrl) hit.imgUrl = imgUrl;
      if (spec) hit.spec = spec;
      if (embedded && !hit.img) { hit.img = embedded.file; hit.thumb = embedded.thumb; delete hit.pending; updatedWithImg++; }
      if (!hit.name && embedded && embedded.title) hit.name = shortTitle(cleanName(embedded.title));
      touched.add(hit.id);
      updated++;
    } else {
      const finalName = shortTitle(cleanName(name) || cleanName(embedded && embedded.title) || "") || "";
      const item = {
        id: "C" + String(++maxSeq).padStart(4, "0"),
        orig: imgName || "",
        img: embedded ? embedded.file : "",
        thumb: embedded ? embedded.thumb : "",
        name: finalName,
        sku, url, note, price, cost, weight, imgUrl, spec,
        cat: cat || autoCategorize(finalName),
        pending: !embedded,
        ts: Date.now()
      };
      state.all.push(item);
      if (imgName) byOrig.set(norm(imgName), item);
      const nk1 = comboKey(item.url, item.img);
      const nk2 = comboKey(item.url, item.imgUrl);
      if (nk1) byCombo.set(nk1, item);
      if (nk2) byCombo.set(nk2, item);
      touched.add(item.id);
      created++;
      if (embedded) createdWithImg++;
    }
  }

  await window.api.saveItems(state.all);
  await reload();

  // 表格里只有链接、没有图片的，自动去下载
  const need = state.all.filter(x => touched.has(x.id) && (x.imgUrl || x.url) && !x.img);
  let dl = { ok: 0, fail: [] };
  if (need.length) {
    closePanels();
    dl = await fetchMissingImages(need);
    await reload();
  }

  const autoN = await autoCategorizeAll();
  if (autoN) await reload();

  let msg = [];
  if (updated) msg.push(`更新 ${updated} 条`);
  if (created) msg.push(createdWithImg ? `新增 ${created} 条（含 ${createdWithImg} 张图）` : `新增 ${created} 条`);
  if (dl.ok) msg.push(`按链接下载 ${dl.ok} 张图`);
  if (autoN) msg.push(`自动归类 ${autoN} 条`);
  toast("表格导入完成：" + (msg.join("，") || "没有变化"), 3600);

  if (dl.fail.length) showDlFail(dl.fail);
}

/* 表格导入后按链接批量补图：并发 3，带进度 */
async function fetchMissingImages(list) {
  const total = list.length;
  let done = 0, ok = 0, idx = 0;
  const fail = [];
  showProgress(true, `正在按链接下载图片 0/${total}`, 0);

  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= total) break;
      const t = list[i];
      let r;
      try { r = await window.api.downloadOne({ id: t.id, url: t.imgUrl || t.url }); }
      catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
      if (r && r.ok) ok++;
      else fail.push({ name: t.name || t.sku || t.id, url: t.url, error: (r && r.error) || "未知原因" });
      done++;
      showProgress(true, `正在按链接下载图片 ${done}/${total}`, Math.round(done / total * 100));
    }
  }

  const workers = [];
  for (let k = 0; k < Math.min(3, total); k++) workers.push(worker());
  await Promise.all(workers);
  showProgress(false);
  return { ok, fail };
}

/* 下载失败的明细弹窗 */
let lastDlFail = [];
function showDlFail(list) {
  lastDlFail = list;
  const box = $("dlFail");
  if (!box) return;
  box.innerHTML = `
    <div class="dfl">
      <b>有 ${list.length} 张图没下载成功</b>
      <p>常见原因：链接是商品页被反爬拦了、需要登录、或者那张图本身有防盗链。<br>
      可以点下面的「复制失败链接」，去浏览器里打开页面手动右键存图，再拖进程序。</p>
      <div class="dfitems">${list.slice(0, 40).map(x =>
        `<div class="dfi"><span class="dfn">${esc(x.name)}</span><span class="dfe">${esc(x.error)}</span></div>`
      ).join("")}${list.length > 40 ? `<div class="dfi"><span class="dfn">…还有 ${list.length - 40} 条</span></div>` : ""}</div>
      <div class="dfbtns">
        <button class="btn" id="dfCopy">复制失败链接</button>
        <button class="btn pri" data-close>知道了</button>
      </div>
    </div>`;
  openPanel("dlFail");
  const c = $("dfCopy");
  if (c) c.addEventListener("click", () => {
    const txt = lastDlFail.map(x => x.url).join("\n");
    navigator.clipboard.writeText(txt).then(() => toast("已复制 " + lastDlFail.length + " 个链接"));
  });
}

$("optTable").addEventListener("click", async () => {
  const r = await window.api.pickTable();
  if (!r.ok) { if (r.error) toast("读取失败：" + r.error, 4000); return; }
  closePanels();
  await applyTable(r.rows, r.images);
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

$("optExportPack").addEventListener("click", async () => {
  if (!state.all.length) return toast("还没有商品可导出");
  closePanels();
  showProgress(true, "正在导出图片和清单…", 2);
  try {
    const r = await window.api.exportPack(state.all);
    showProgress(false);
    if (!r.ok) {
      if (r.error) toast("导出失败：" + r.error, 4000);
      return;
    }
    let msg = `导出完成：${r.copied} 张图`;
    if (r.missing) msg += `，${r.missing} 张找不到文件`;
    toast(msg + "，共 " + r.mb + " MB", 5000);
    state.lastExportDir = r.dir;
    const box = $("dlFail");
    if (box) {
      box.innerHTML = `
        <div class="dfl">
          <b>导出完成</b>
          <p>文件夹里有三样：<br>
          · <b>看货清单.html</b> —— 双击用浏览器打开，一屏看完所有图和价格（推荐先看这个）<br>
          · <b>清单.xlsx</b> —— 表格，图片链接列可以直接点开<br>
          · <b>images</b> 文件夹 —— ${r.copied} 张真实图片，文件名和表格一一对应</p>
          <div class="dfitems"><div class="dfi"><span class="dfn">${esc(r.dir)}</span></div></div>
          <div class="dfbtns">
            <button class="btn" id="dfOpen">打开文件夹</button>
            <button class="btn pri" data-close>知道了</button>
          </div>
        </div>`;
      openPanel("dlFail");
      const openDir = () => window.api.openUrl("file:///" + r.dir.replace(/\\/g, "/"));
      const ob = $("dfOpen");
      if (ob) ob.addEventListener("click", openDir);
      setTimeout(openDir, 500);
    }
  } catch (err) {
    showProgress(false);
    toast("导出出错：" + err.message, 4500);
  }
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
    if (r.ok) await applyTable(r.rows, r.images);
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
  $("edCost").value = it.cost || "";
  $("edWeight").value = it.weight || "";
  if ($("edSpec")) $("edSpec").value = it.spec || "";
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
  it.cost = $("edCost").value.trim();
  it.weight = $("edWeight").value.trim();
  if ($("edSpec")) it.spec = $("edSpec").value.trim();
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
  await deleteItems([it], "已删除 1 件");
  closePanels();
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
      await deleteItems([it], "已删除 1 件");
    }
  }
});

/* ================= 粘贴图片 ================= */
/* 反爬网站（1688、乐华梅兰）抓不到图时，截图或右键复制图片，直接 Ctrl+V */
document.addEventListener("paste", async e => {
  const dt = e.clipboardData;
  if (!dt) return;
  const blobs = [];
  for (const item of dt.items || []) {
    if (item.kind === "file" && /^image\//.test(item.type)) {
      const f = item.getAsFile();
      if (f) blobs.push(f);
    }
  }
  if (!blobs.length) return;
  e.preventDefault();

  // 编辑面板开着 → 替换当前商品的图
  if ($("editPanel").classList.contains("show") && state.editing) {
    const buf = await blobs[0].arrayBuffer();
    const r = await window.api.replaceImage({ id: state.editing.id, buffer: Array.from(new Uint8Array(buf)) });
    if (r && r.ok) {
      await reload();
      state.editing = state.all.find(x => x.id === state.editing.id);
      openEdit(state.editing);
      toast("图片已替换");
    } else {
      toast("替换失败：" + ((r && r.error) || "未知原因"), 4000);
    }
    return;
  }

  // 否则当作新商品加进来
  showProgress(true, `正在加入 ${blobs.length} 张图片…`, 10);
  let okN = 0;
  for (const f of blobs) {
    const buf = await f.arrayBuffer();
    const r = await window.api.addImageBuffer({ data: Array.from(new Uint8Array(buf)) });
    if (r && r.ok) okN++;
  }
  await reload();
  const autoN = await autoCategorizeAll();
  if (autoN) await reload();
  showProgress(false);
  toast(okN ? `已加入 ${okN} 张图片${autoN ? "，自动归类 " + autoN + " 条" : ""}` : "没加进来", 3200);
});

/* ================= 删除（保持视角不跳） ================= */
/* 直接从列表和 DOM 里摘掉，不整页重建，滚动位置原样保留 */
function dropFromView(ids) {
  const set = new Set(ids);
  if (!set.size) return;

  const top = scroller.scrollTop;
  let removedInDom = 0;
  grid.querySelectorAll("[data-id]").forEach(el => {
    if (set.has(el.dataset.id)) { el.remove(); removedInDom++; }
  });

  state.all = state.all.filter(x => !set.has(x.id));
  state.view = state.view.filter(x => !set.has(x.id));
  state.rendered = Math.max(0, state.rendered - removedInDom);

  if (!state.view.length) {
    resetRender();
    return;
  }
  renderPills();
  updateCount();
  // 恢复原视角（浏览器可能因内容变短做过钳制，这里再压回原值）
  scroller.scrollTop = Math.min(top, scroller.scrollHeight);
}

async function deleteItems(list, tip) {
  const ids = list.map(x => x.id);
  if (!ids.length) return;
  await window.api.deleteMany(ids);
  dropFromView(ids);
  toast(tip || `已删除 ${ids.length} 件`, 2400);
}

/* ================= 主题与亮度 ================= */
const THEMES = [
  { id: "dark",  name: "暗夜", bg: "#0A0A0A", panel: "#141414", accent: "#FFFFFF" },
  { id: "light", name: "纯白", bg: "#F3F5F9", panel: "#FFFFFF", accent: "#1F3864" },
  { id: "candy", name: "糖果", bg: "#FFF3F8", panel: "#FFE9F2", accent: "#FF6FA5" },
  { id: "cyber", name: "赛博", bg: "#06040F", panel: "#1B1438", accent: "#00E5FF" },
  { id: "pink",  name: "少女", bg: "#FFF0F5", panel: "#FFE3EE", accent: "#FF4D8D" },
  { id: "toon",  name: "搞怪", bg: "#FFF8D6", panel: "#FFF0A8", accent: "#7C3AED" }
];

function renderThemes(cur) {
  $("themeList").innerHTML = THEMES.map(t => `
    <div class="thm${t.id === cur ? " on" : ""}" data-t="${t.id}">
      <div class="sw" style="background:${t.bg}">
        <i style="background:${t.panel};box-shadow:inset 0 0 0 1px rgba(128,128,128,.3)"></i>
        <i style="background:${t.accent}"></i>
      </div>
      <div class="nm">${t.name}</div>
    </div>`).join("");
}

function applyTheme(id) {
  document.body.dataset.theme = id;
  try { localStorage.setItem("cg_theme", id); } catch (e) {}
  renderThemes(id);
}

function applyLum(v) {
  let color = "#000000", alpha = 0;
  if (v < 100) alpha = ((100 - v) / 100) * 0.55;
  else if (v > 100) { color = "#FFFFFF"; alpha = ((v - 100) / 100) * 0.4; }
  document.body.style.setProperty("--ov-color", color);
  document.body.style.setProperty("--ov-alpha", alpha.toFixed(3));
  $("lumVal").textContent = v + "%";
  try { localStorage.setItem("cg_lum", String(v)); } catch (e) {}
}

$("btnTheme").addEventListener("click", () => openPanel("themePanel"));
$("themeList").addEventListener("click", e => {
  const el = e.target.closest(".thm");
  if (el) applyTheme(el.dataset.t);
});
$("lum").addEventListener("input", e => applyLum(+e.target.value));

(function initTheme() {
  let t = "dark", l = 100;
  try {
    t = localStorage.getItem("cg_theme") || "dark";
    l = parseInt(localStorage.getItem("cg_lum") || "100", 10);
    if (!isFinite(l)) l = 100;
  } catch (e) {}
  if (!THEMES.some(x => x.id === t)) t = "dark";
  document.body.dataset.theme = t;
  renderThemes(t);
  $("lum").value = String(l);
  applyLum(l);
})();

/* ================= 批量选择 ================= */
function updateSelBar() {
  $("selCount").textContent = String(state.selected.size);
}

function togglePick(it, el) {
  const ck = el.querySelector(".ck");
  if (state.selected.has(it.id)) {
    state.selected.delete(it.id);
    el.classList.remove("picked");
    if (ck) ck.innerHTML = "";
  } else {
    state.selected.add(it.id);
    el.classList.add("picked");
    if (ck) ck.innerHTML = CHECK_SVG;
  }
  updateSelBar();
}

function toggleSelectMode(on) {
  state.selectMode = on;
  document.body.classList.toggle("selmode", on);
  $("selbar").classList.toggle("show", on);
  $("btnSelect").classList.toggle("on", on);
  if (!on) state.selected.clear();
  const canZoom = !on && state.mode === "grid";
  $("zoomWrap").style.opacity = canZoom ? "1" : ".25";
  $("zoomWrap").style.pointerEvents = canZoom ? "auto" : "none";
  syncPicks();
}

$("btnSelect").addEventListener("click", () => toggleSelectMode(!state.selectMode));
$("selCancel").addEventListener("click", () => toggleSelectMode(false));

/* 就地刷新勾选状态，不重建卡片（大批量时快得多，也不跳位置） */
function syncPicks() {
  grid.querySelectorAll("[data-id]").forEach(el => {
    const on = state.selected.has(el.dataset.id);
    el.classList.toggle("picked", on);
    const ck = el.querySelector(".ck");
    if (ck) ck.innerHTML = on ? CHECK_SVG : "";
  });
  updateSelBar();
}

$("selAll").addEventListener("click", () => {
  if (!state.view.length) return;
  const allPicked = state.view.every(it => state.selected.has(it.id));
  if (allPicked) state.view.forEach(it => state.selected.delete(it.id));
  else state.view.forEach(it => state.selected.add(it.id));
  syncPicks();
});

$("selInv").addEventListener("click", () => {
  if (!state.view.length) return;
  state.view.forEach(it => {
    if (state.selected.has(it.id)) state.selected.delete(it.id);
    else state.selected.add(it.id);
  });
  syncPicks();
});

$("selDel").addEventListener("click", async () => {
  const n = state.selected.size;
  if (!n) return toast("还没选东西呢");
  if (!confirm(`确定删除选中的 ${n} 件商品？\n\n对应的图片和缩略图会一起删掉，不能恢复。`)) return;
  const ids = [...state.selected];
  const picked = state.all.filter(x => state.selected.has(x.id));
  $("selDel").textContent = "删除中…";
  await window.api.deleteMany(ids);
  $("selDel").textContent = "删除选中";
  state.selected.clear();
  toggleSelectMode(false);
  dropFromView(ids);
  toast(`已删除 ${n} 件商品`, 2600);
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

let lastPickIdx = -1;
let clickTimer = null;

grid.addEventListener("click", e => {
  const el = e.target.closest("[data-id]");
  if (!el) return;
  const it = state.all.find(x => x.id === el.dataset.id);
  if (!it) return;

  // 选择模式：立即响应，支持 Shift 连选
  if (state.selectMode) {
    const idx = state.view.findIndex(x => x.id === it.id);
    if (e.shiftKey && lastPickIdx >= 0 && idx >= 0) {
      const a = Math.min(lastPickIdx, idx), b = Math.max(lastPickIdx, idx);
      for (let i = a; i <= b; i++) state.selected.add(state.view[i].id);
      syncPicks();
    } else {
      togglePick(it, el);
    }
    lastPickIdx = idx;
    return;
  }

  const act = e.target.closest("[data-act]");
  if (act && act.dataset.act === "edit") {
    e.stopPropagation();
    openEdit(it);
    return;
  }

  // 单击延迟 220ms，给双击留判断时间
  if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }
  clickTimer = setTimeout(() => {
    clickTimer = null;
    if (it.url && it.url.trim()) {
      window.api.openUrl(it.url);
      toast("已打开 · " + (it.sku || it.name || it.id));
    } else {
      openEdit(it);
    }
  }, 220);
});

grid.addEventListener("dblclick", e => {
  if (state.selectMode) return;
  const el = e.target.closest("[data-id]");
  if (!el) return;
  if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
  const it = state.all.find(x => x.id === el.dataset.id);
  if (it) openLightbox(it);
});

/* ================= 大图预览 ================= */
let lbList = [], lbIndex = 0;

function renderLightbox() {
  const it = lbList[lbIndex];
  if (!it) return;
  const src = imgUrl(it);
  const img = $("lbImg");
  if (src) { img.src = src; img.style.display = "block"; } else { img.style.display = "none"; }
  $("lbName").textContent = it.name || it.orig || "未命名商品";
  $("lbSku").textContent = it.sku || it.id;
  const bits = [];
  if (it.price) bits.push("€" + fmtPrice(it.price));
  if (it.cost) bits.push("¥" + fmtPrice(it.cost));
  if (it.weight) bits.push(fmtWeight(it.weight));
  $("lbPrice").textContent = bits.join("  ·  ");
  $("lbPrice").style.display = bits.length ? "inline-block" : "none";
  $("lbIdx").textContent = (lbIndex + 1) + " / " + lbList.length;
  $("lbOpen").style.display = (it.url && it.url.trim()) ? "inline-flex" : "none";
}

function openLightbox(it) {
  lbList = state.view.length ? state.view : [it];
  lbIndex = lbList.findIndex(x => x.id === it.id);
  if (lbIndex < 0) { lbList = [it]; lbIndex = 0; }
  renderLightbox();
  $("lightbox").classList.add("show");
}

function moveLightbox(step) {
  if (lbList.length < 2) return;
  lbIndex = (lbIndex + step + lbList.length) % lbList.length;
  renderLightbox();
}

function closeLightbox() {
  $("lightbox").classList.remove("show");
  $("lbImg").removeAttribute("src");
}

$("lbClose").addEventListener("click", closeLightbox);
$("lbPrev").addEventListener("click", e => { e.stopPropagation(); moveLightbox(-1); });
$("lbNext").addEventListener("click", e => { e.stopPropagation(); moveLightbox(1); });
$("lightbox").addEventListener("click", e => {
  const t = e.target;
  if (t.id === "lightbox" || t.id === "lbStage") closeLightbox();
});
$("lbOpen").addEventListener("click", () => {
  const it = lbList[lbIndex];
  if (it && it.url) window.api.openUrl(it.url);
});
document.addEventListener("keydown", e => {
  if (!$("lightbox").classList.contains("show")) return;
  if (e.key === "Escape") closeLightbox();
  else if (e.key === "ArrowLeft") moveLightbox(-1);
  else if (e.key === "ArrowRight") moveLightbox(1);
});

document.addEventListener("keydown", e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault(); $("q").focus(); $("q").select();
  }
});

const io = new IntersectionObserver(entries => {
  if (entries[0].isIntersecting) renderMore();
}, { root: scroller, rootMargin: "500px" });
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
