const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");
const XLSX = require("xlsx");

let mainWin = null;
let DATA_DIR = "", IMG_DIR = "", THUMB_DIR = "", ITEMS_FILE = "";

const IMG_RE = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;

/* ---------------- 初始化目录 ---------------- */
function initDirs() {
  const base = app.isPackaged
    ? path.join(path.dirname(app.getPath("exe")), "data")
    : path.join(__dirname, "data");
  DATA_DIR = base;
  IMG_DIR = path.join(base, "images");
  THUMB_DIR = path.join(base, "thumbs");
  ITEMS_FILE = path.join(base, "items.json");
  for (const d of [DATA_DIR, IMG_DIR, THUMB_DIR]) fs.mkdirSync(d, { recursive: true });
}

/* ---------------- 数据读写 ---------------- */
function readItems() {
  try {
    const raw = fs.readFileSync(ITEMS_FILE, "utf8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function writeItems(items) {
  const tmp = ITEMS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(items, null, 1), "utf8");
  fs.renameSync(tmp, ITEMS_FILE);
}
function nextSeq(items) {
  let max = 0;
  for (const it of items) {
    const m = /(\d+)\s*$/.exec(it.id || "");
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}
function newId(seq) {
  return "C" + String(seq).padStart(4, "0");
}

/* ---------------- 缩略图 ---------------- */
function makeThumb(imgPath, id) {
  try {
    const img = nativeImage.createFromPath(imgPath);
    if (img.isEmpty()) return "";
    const { width, height } = img.getSize();
    if (!width || !height) return "";
    const MAX = 620;
    let nw = width, nh = height;
    if (Math.max(width, height) > MAX) {
      const s = MAX / Math.max(width, height);
      nw = Math.max(1, Math.round(width * s));
      nh = Math.max(1, Math.round(height * s));
    }
    const out = img.resize({ width: nw, height: nh, quality: "good" });
    fs.writeFileSync(path.join(THUMB_DIR, id + ".jpg"), out.toJPEG(84));
    return id + ".jpg";
  } catch (e) {
    console.error("缩略图失败", imgPath, e.message);
    return "";
  }
}

/* ---------------- 单张导入 ---------------- */
function importOneFile(srcPath, items, seqRef) {
  const orig = path.basename(srcPath);
  const exist = items.find(it => it.orig === orig);
  if (exist) return { skip: true };

  const id = newId(seqRef.value++);
  const ext = (path.extname(srcPath) || ".jpg").toLowerCase();
  const imgName = id + ext;
  const dest = path.join(IMG_DIR, imgName);

  try {
    fs.copyFileSync(srcPath, dest);
  } catch (e) {
    return { skip: true, err: e.message };
  }

  const item = {
    id,
    orig,
    img: imgName,
    thumb: makeThumb(dest, id),
    name: path.basename(orig, path.extname(orig)),
    sku: "",
    cat: "",
    url: "",
    note: "",
    ts: Date.now()
  };
  items.push(item);
  return { item };
}

/* ---------------- 图片有效性校验 ---------------- */
function isValidImageFile(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size < 200) return false;
    const buf = Buffer.alloc(16);
    const fd = fs.openSync(p, "r");
    fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);
    const isJpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    const isGif = buf.slice(0, 3).toString("ascii") === "GIF";
    const isWebp = buf.slice(0, 4).toString("ascii") === "RIFF" &&
      buf.slice(8, 12).toString("ascii") === "WEBP";
    const isBmp = buf[0] === 0x42 && buf[1] === 0x4d;
    if (!(isJpg || isPng || isGif || isWebp || isBmp)) return false;
    const img = nativeImage.createFromPath(p);
    if (img.isEmpty()) return false;
    const s = img.getSize();
    return s.width > 0 && s.height > 0;
  } catch {
    return false;
  }
}

/* 按文件头判断真实图片格式 */
function detectImageExt(p) {
  const buf = Buffer.alloc(12);
  const fd = fs.openSync(p, "r");
  fs.readSync(fd, buf, 0, 12, 0);
  fs.closeSync(fd);
  if (buf[0] === 0x89 && buf[1] === 0x50) return ".png";
  if (buf.slice(0, 3).toString("ascii") === "GIF") return ".gif";
  if (buf.slice(8, 12).toString("ascii") === "WEBP") return ".webp";
  if (buf[0] === 0x42 && buf[1] === 0x4d) return ".bmp";
  return ".jpg";
}

/* ---------------- 下载网络图片 ---------------- */
function downloadImage(url, dest, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 4) return reject(new Error("重定向过多"));
    let u;
    try { u = new URL(url); } catch { return reject(new Error("链接格式不对")); }
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.get(u, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Referer": u.origin + "/",
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"
      },
      timeout: 25000
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, u).toString();
        return downloadImage(next, dest, depth + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error("HTTP " + res.statusCode));
      }
      const ws = fs.createWriteStream(dest);
      res.pipe(ws);
      ws.on("finish", () => ws.close(() => resolve(dest)));
      ws.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("下载超时")));
    req.on("error", reject);
  });
}

/* ---------------- 表格解析 ---------------- */
/* 提取 WPS 表格里的嵌入图片（DISPIMG） */
function extractCellImages(wb) {
  const out = {};
  const files = wb.files || {};
  const cellFile = files["xl/cellimages.xml"];
  const relFile = files["xl/_rels/cellimages.xml.rels"];
  if (!cellFile || !relFile) return out;

  const cellStr = cellFile.content ? cellFile.content.toString("utf8") : String(cellFile);
  const relStr = relFile.content ? relFile.content.toString("utf8") : String(relFile);

  const relMap = {};
  const relRe = /<Relationship\b[^>]*?Id="([^"]+)"[^>]*?Target="([^"]+)"/g;
  let m;
  while ((m = relRe.exec(relStr))) relMap[m[1]] = m[2];

  const cellRe = /<etc:cellImage>([\s\S]*?)<\/etc:cellImage>/g;
  let idx = 0;
  while ((m = cellRe.exec(cellStr))) {
    const blk = m[1];
    const nameM = /name="(ID_[^"]+)"/.exec(blk);
    const descrM = /descr="([^"]*)"/.exec(blk);
    const embedM = /r:embed="([^"]+)"/.exec(blk);
    if (!nameM || !embedM) continue;

    const target = relMap[embedM[1]];
    if (!target || target === "NULL") continue;
    const inner = "xl/" + target.replace(/^\.?\//, "");
    const f = files[inner];
    if (!f || !f.content) continue;

    idx++;
    // 同一个 ID 用固定文件名，重复导入会覆盖，不留垃圾
    const base = "ex_" + nameM[1].slice(3, 15);
    const ext = (path.extname(inner) || ".jpg").toLowerCase();
    const imgName = base + ext;
    const dest = path.join(IMG_DIR, imgName);

    try {
      fs.writeFileSync(dest, f.content);
      if (!isValidImageFile(dest)) { fs.unlinkSync(dest); continue; }
      out[nameM[1]] = {
        file: imgName,
        thumb: makeThumb(dest, base),
        title: descrM ? descrM[1].trim() : ""
      };
    } catch (e) {
      console.error("提取嵌入图片失败", nameM[1], e.message);
    }
  }
  return out;
}

function parseTableFile(filePath) {
  const wb = XLSX.readFile(filePath, { cellDates: false, raw: false, bookFiles: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return { rows: [], images: {} };
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: "" });

  // 把 =DISPIMG("ID_xxx",1) 换成标记，交给前端识别
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      const v = String(row[i] == null ? "" : row[i]);
      if (v.indexOf("DISPIMG") === -1) continue;
      const idm = /(ID_[A-Za-z0-9]+)/.exec(v);
      if (idm) row[i] = "__IMG__:" + idm[1];
    }
  }

  const images = extractCellImages(wb);
  return { rows, images };
}

/* ---------------- 主进程事件 ---------------- */
function createWindow() {
  mainWin = new BrowserWindow({
    width: 1560,
    height: 960,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: "#0A0A0A",
    show: false,
    autoHideMenuBar: true,
    title: "商品采购图册",
    icon: path.join(__dirname, "build", "icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  mainWin.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWin.once("ready-to-show", () => mainWin.show());
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(() => {
  initDirs();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

/* ---------------- IPC ---------------- */
ipcMain.handle("load-items", () => ({
  items: readItems(),
  dataDir: DATA_DIR
}));

ipcMain.handle("save-items", (e, items) => {
  writeItems(items);
  return { ok: true };
});

ipcMain.handle("open-url", (e, url) => {
  if (!url) return { ok: false };
  let u = String(url).trim();
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  shell.openExternal(u);
  return { ok: true };
});

ipcMain.handle("open-data-dir", () => {
  shell.openPath(DATA_DIR);
  return { ok: true };
});

/* 选图片文件（可多选） */
ipcMain.handle("pick-images", async () => {
  const r = await dialog.showOpenDialog(mainWin, {
    title: "选择商品图片（可多选）",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "图片", extensions: ["jpg", "jpeg", "png", "webp", "gif", "bmp", "avif"] }]
  });
  return { ok: !r.canceled, files: r.filePaths || [] };
});

/* 选图片文件夹 */
ipcMain.handle("pick-folder", async () => {
  const r = await dialog.showOpenDialog(mainWin, {
    title: "选择存放商品图片的文件夹",
    properties: ["openDirectory"]
  });
  if (r.canceled || !r.filePaths[0]) return { ok: false, files: [] };

  const dir = r.filePaths[0];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return { ok: false, files: [] }; }
  const files = names
    .filter(n => IMG_RE.test(n))
    .map(n => path.join(dir, n))
    .filter(p => { try { return fs.statSync(p).isFile(); } catch { return false; } })
    .sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));

  return { ok: true, files, dir };
});

/* 批量导入本地图片 */
ipcMain.handle("import-paths", async (e, files) => {
  const items = readItems();
  const seqRef = { value: nextSeq(items) };
  const added = [], skipped = [];
  const total = files.length;
  let done = 0;

  for (const f of files) {
    const r = importOneFile(f, items, seqRef);
    if (r.item) added.push(r.item); else skipped.push(path.basename(f));
    done++;
    if (total > 30 && (done % 5 === 0 || done === total)) {
      mainWin.webContents.send("import-progress", {
        phase: "images", done, total,
        text: path.basename(f)
      });
    }
  }
  writeItems(items);
  return { added: added.length, skipped: skipped.length, items: added, total: items.length };
});

/* 粘贴图片链接批量导入 */
ipcMain.handle("import-urls", async (e, urls) => {
  const items = readItems();
  const seqRef = { value: nextSeq(items) };
  const added = [], failed = [];
  const total = urls.length;
  let done = 0;

  for (const raw of urls) {
    const url = String(raw || "").trim();
    if (!url) continue;
    done++;
    const id = newId(seqRef.value);
    const tmp = path.join(IMG_DIR, "_tmp_" + id + ".jpg");
    try {
      await downloadImage(url, tmp);
      if (!isValidImageFile(tmp)) {
        throw new Error("下载到的不是有效图片（可能碰上了防盗链、需要登录，或链接本身不是图片）");
      }
      const ext = detectImageExt(tmp);

      const imgName = id + ext;
      const dest = path.join(IMG_DIR, imgName);
      fs.renameSync(tmp, dest);
      seqRef.value++;

      const item = {
        id,
        orig: "url_" + id + ext,
        img: imgName,
        thumb: makeThumb(dest, id),
        name: "",
        sku: "",
        cat: "",
        url: "",
        note: url.length > 300 ? url.slice(0, 300) : url,
        sourceUrl: url,
        ts: Date.now()
      };
      items.push(item);
      added.push(item);
    } catch (err) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
      failed.push({ url, msg: err.message });
    }
    if (total > 3) {
      mainWin.webContents.send("import-progress", { phase: "urls", done, total, text: url.slice(0, 60) });
    }
  }
  writeItems(items);
  return { added: added.length, failed, items: added, total: items.length };
});

/* 导入表格 */
ipcMain.handle("pick-table", async () => {
  const r = await dialog.showOpenDialog(mainWin, {
    title: "选择商品清单表格",
    properties: ["openFile"],
    filters: [{ name: "表格", extensions: ["xlsx", "xls", "csv"] }]
  });
  if (r.canceled || !r.filePaths[0]) return { ok: false };
  try {
    const { rows, images } = parseTableFile(r.filePaths[0]);
    return { ok: true, rows, images, file: path.basename(r.filePaths[0]) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/* 清空全部数据 */
ipcMain.handle("clear-all", () => {
  let n = 0;
  for (const dir of [IMG_DIR, THUMB_DIR]) {
    try {
      for (const f of fs.readdirSync(dir)) {
        try { fs.unlinkSync(path.join(dir, f)); n++; } catch {}
      }
    } catch {}
  }
  writeItems([]);
  return { ok: true, removed: n };
});

/* 读取指定表格文件（拖拽进来时用） */
ipcMain.handle("read-table-file", (e, p) => {
  try {
    const { rows, images } = parseTableFile(p);
    return { ok: true, rows, images };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/* 更换单张图片（本地文件或网络链接） */
ipcMain.handle("replace-image", async (e, payload) => {
  const { id, src, url } = payload || {};
  const items = readItems();
  const it = items.find(x => x.id === id);
  if (!it) return { ok: false, error: "找不到这件商品" };
  try {
    let newPath = "", newOrig = "", tmpPath = "";

    if (src) {
      if (!isValidImageFile(src)) return { ok: false, error: "这个文件不是有效图片，或者图片已损坏" };
      newPath = src;
      newOrig = path.basename(src);
    } else if (url) {
      tmpPath = path.join(IMG_DIR, "_tmp_" + id + ".download");
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
      await downloadImage(url, tmpPath);
      if (!isValidImageFile(tmpPath)) {
        try { fs.unlinkSync(tmpPath); } catch {}
        return { ok: false, error: "下载到的不是有效图片（可能防盗链、需要登录，或这个链接根本不是图片）" };
      }
      newPath = tmpPath;
      newOrig = "url_" + id + detectImageExt(tmpPath);
    } else {
      return { ok: false, error: "缺少图片来源" };
    }

    // 全部校验通过，才动原来的文件
    const ext = detectImageExt(newPath);
    // 文件名带时间戳：换图后路径变化，避免浏览器拿旧缓存显示坏图
    const imgName = id + "_" + Date.now().toString(36) + ext;
    const dest = path.join(IMG_DIR, imgName);

    if (it.img && it.img !== imgName) {
      const old = path.join(IMG_DIR, it.img);
      if (fs.existsSync(old)) { try { fs.unlinkSync(old); } catch {} }
    }
    if (path.resolve(newPath) !== path.resolve(dest)) {
      fs.copyFileSync(newPath, dest);
    }
    if (tmpPath && fs.existsSync(tmpPath)) { try { fs.unlinkSync(tmpPath); } catch {} }

    it.img = imgName;
    it.orig = newOrig;
    it.thumb = makeThumb(dest, id);
    writeItems(items);
    return { ok: true, thumb: it.thumb, warn: it.thumb ? "" : "缩略图生成失败，已改用原图显示" };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/* 删除单条 */
/* 删干净一件商品的图片和缩略图 */
function removeItemFiles(it) {
  try {
    if (it.img) {
      const p = path.join(IMG_DIR, it.img);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  } catch (err) { console.error("删原图失败", it.id, err.message); }
  try {
    // 缩略图文件名不一定等于 id（可能带时间戳或 ex_ 前缀），以记录为准
    const names = new Set();
    if (it.thumb) names.add(it.thumb);
    names.add(it.id + ".jpg");
    for (const n of names) {
      const tp = path.join(THUMB_DIR, n);
      if (fs.existsSync(tp)) fs.unlinkSync(tp);
    }
  } catch (err) { console.error("删缩略图失败", it.id, err.message); }
}

ipcMain.handle("delete-item", (e, it) => {
  if (!it || !it.id) return { ok: false };
  removeItemFiles(it);
  const items = readItems().filter(x => x.id !== it.id);
  writeItems(items);
  return { ok: true, total: items.length };
});

/* 批量删除 */
ipcMain.handle("delete-many", (e, ids) => {
  const set = new Set(Array.isArray(ids) ? ids : []);
  if (!set.size) return { ok: true, removed: 0, total: readItems().length };
  const all = readItems();
  const keep = [];
  let removed = 0;
  for (const it of all) {
    if (set.has(it.id)) { removeItemFiles(it); removed++; }
    else keep.push(it);
  }
  writeItems(keep);
  return { ok: true, removed, total: keep.length };
});

/* 生成模板表格内容（用 xlsx 写，主进程存到临时目录并返回路径） */
ipcMain.handle("make-template", async () => {
  const header = ["图片文件名", "商品名称", "采购链接", "分类", "货号", "价格", "备注"];
  const sample = [
    ["A001.jpg", "三合一数据线 1米", "https://detail.1688.com/offer/123456789.html", "数据线", "DL-0001", "20", "供应商A"],
    ["A002.jpg", "20W PD快充头", "https://detail.1688.com/offer/987654321.html", "充电器", "CD-0001", "15.5", ""]
  ];
  const ws = XLSX.utils.aoa_to_sheet([header, ...sample]);
  ws["!cols"] = [{ wch: 20 }, { wch: 28 }, { wch: 48 }, { wch: 12 }, { wch: 14 }, { wch: 24 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "商品清单");

  const r = await dialog.showSaveDialog(mainWin, {
    title: "保存导入模板",
    defaultPath: path.join(app.getPath("desktop"), "商品清单模板.xlsx"),
    filters: [{ name: "Excel", extensions: ["xlsx"] }]
  });
  if (r.canceled || !r.filePath) return { ok: false };
  XLSX.writeFile(wb, r.filePath);
  return { ok: true, file: r.filePath };
});

/* 导出当前清单 */
ipcMain.handle("export-list", async (e, items) => {
  const header = ["图片文件名", "商品名称", "采购链接", "分类", "货号", "价格", "备注"];
  const body = items.map(it => [
    it.orig || it.img || "",
    it.name || "",
    it.url || "",
    it.cat || "",
    it.sku || "",
    it.price || "",
    it.note || ""
  ]);
  const ws = XLSX.utils.aoa_to_sheet([header, ...body]);
  ws["!cols"] = [{ wch: 20 }, { wch: 28 }, { wch: 48 }, { wch: 12 }, { wch: 14 }, { wch: 10 }, { wch: 24 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "商品清单");

  const r = await dialog.showSaveDialog(mainWin, {
    title: "导出商品清单",
    defaultPath: path.join(app.getPath("desktop"), "商品清单.xlsx"),
    filters: [{ name: "Excel", extensions: ["xlsx"] }]
  });
  if (r.canceled || !r.filePath) return { ok: false };
  XLSX.writeFile(wb, r.filePath);
  return { ok: true, file: r.filePath };
});
