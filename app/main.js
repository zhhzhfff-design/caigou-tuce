const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");
const zlib = require("zlib");
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
/* items.json 的读-改-写必须串行，否则并发下载会互相覆盖对方的结果 */
let DB_LOCK = Promise.resolve();
function withDbLock(fn) {
  const run = DB_LOCK.then(fn, fn);
  DB_LOCK = run.then(() => {}, () => {});
  return run;
}

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

/* ---------------- 网络请求：带解压、带浏览器头 ---------------- */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function httpGet(url, extraHeaders = {}, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 6) return reject(new Error("重定向太多次"));
    let u;
    try { u = new URL(url); } catch { return reject(new Error("链接格式不对")); }
    const lib = u.protocol === "https:" ? https : http;
    const headers = Object.assign({
      "User-Agent": UA,
      "Accept": "image/png,image/jpeg,image/apng,image/*;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,fr;q=0.7,es;q=0.6,it;q=0.5",
      "Accept-Encoding": "gzip, deflate",
      "Cache-Control": "no-cache"
    }, extraHeaders);

    const req = lib.get(u, { headers, timeout: 22000 }, res => {
      const code = res.statusCode;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, u).toString(); } catch { return reject(new Error("跳转地址异常")); }
        return httpGet(next, extraHeaders, depth + 1).then(resolve, reject);
      }
      if (code !== 200) {
        res.resume();
        const e = new Error("HTTP " + code);
        e.status = code;
        return reject(e);
      }
      const chunks = [];
      let size = 0;
      res.on("data", c => {
        chunks.push(c);
        size += c.length;
        if (size > 24 * 1024 * 1024) req.destroy(new Error("返回内容太大"));
      });
      res.on("end", () => {
        let buf = Buffer.concat(chunks);
        const enc = String(res.headers["content-encoding"] || "").toLowerCase();
        try {
          if (enc === "gzip") buf = zlib.gunzipSync(buf);
          else if (enc === "deflate") buf = zlib.inflateSync(buf);
          else if (enc === "br") buf = zlib.brotliDecompressSync(buf);
        } catch { /* 解压失败就按原样用 */ }
        resolve({ buf, type: String(res.headers["content-type"] || ""), finalUrl: u.toString() });
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("连接超时")));
    req.on("error", reject);
  });
}

/* 按文件头判断是不是真图片，返回扩展名；不是图片返回 null */
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return ".png";
  if (buf.slice(0, 3).toString("ascii") === "GIF") return ".gif";
  if (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP") return ".webp";
  if (buf[0] === 0x42 && buf[1] === 0x4d) return ".bmp";
  if (buf.slice(4, 8).toString("ascii") === "ftyp") {
    const brand = buf.slice(8, 12).toString("ascii").toLowerCase();
    if (brand.startsWith("avi")) return ".avif";
  }
  return null;
}

/* 图片内容校验：太小或解不开的一律当无效（很多 CDN 用 1x1 占位图冒充成功） */
function validateImageBuf(buf, ext) {
  if (!buf || buf.length < 1024) {
    return { ok: false, reason: "拿到的图片只有 " + (buf ? buf.length : 0) + " 字节，是网站返回的占位图，不是真图" };
  }
  const img = nativeImage.createFromBuffer(buf);
  if (img.isEmpty()) {
    // webp 这类格式 Electron 解不了，但浏览器能显示，照样存下来
    if (ext === ".webp" || ext === ".avif") return { ok: true, width: 0, height: 0, noThumb: true };
    return { ok: false, reason: "图片解不开，格式可能不受支持" };
  }
  const { width, height } = img.getSize();
  if (!width || !height) return { ok: true, width: 0, height: 0 };
  if (width < 80 || height < 80) {
    return { ok: false, reason: `拿到的图只有 ${width}×${height}，是占位图` };
  }
  return { ok: true, width, height };
}

/* 从商品页 HTML 里挖主图地址（1688 / 乐华梅兰 / 亚马逊等通用） */
function extractPageImage(html, pageUrl) {
  const picks = [];
  const push = u => {
    if (!u) return;
    let s = String(u).trim().replace(/&amp;/g, "&");
    if (!s || s.startsWith("data:")) return;
    try { s = new URL(s, pageUrl).toString(); } catch { return; }
    if (!picks.includes(s)) picks.push(s);
  };

  const metaRules = [
    /<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]+itemprop=["']image["'][^>]*content=["']([^"']+)["']/i,
    /<link[^>]+rel=["']image_src["'][^>]*href=["']([^"']+)["']/i
  ];
  for (const re of metaRules) {
    const m = re.exec(html);
    if (m) push(m[1]);
  }

  // JSON 里的主图字段（1688/Amazon/LM 常见）
  const jsonRules = [
    /"imageUrl"\s*:\s*"([^"]+)"/i,
    /"mainImage"\s*:\s*"([^"]+)"/i,
    /"images?"\s*:\s*\[\s*"([^"]+)"/i,
    /"large"\s*:\s*"([^"]+\.(?:jpe?g|png|webp))"/i,
    /"zoom"\s*:\s*"([^"]+\.(?:jpe?g|png|webp))"/i
  ];
  for (const re of jsonRules) {
    const m = re.exec(html);
    if (m) push(m[1]);
  }

  // 兜底：直接找 CDN 上的图片地址
  const cdnRules = [
    /https?:\/\/cbu01\.alicdn\.com\/[^"'\s\\]+\.(?:jpe?g|png|webp)/i,
    /https?:\/\/[^"'\s\\]*alicdn\.com\/[^"'\s\\]+\.(?:jpe?g|png|webp)/i,
    /https?:\/\/(?:media|cdn|static)\.[^"'\s\\]*leroymerlin[^"'\s\\]+\.(?:jpe?g|png|webp)/i,
    /https?:\/\/[^"'\s\\]+\.(?:jpe?g|png|webp)(?:\?[^"'\s\\]*)?/i
  ];
  for (const re of cdnRules) {
    const m = re.exec(html);
    if (m) push(m[0]);
  }

  return picks;
}

/* 各平台的防盗链要求不同，按域名给对应站点 Referer */
function siteReferer(host) {
  const h = String(host || "").toLowerCase();
  if (/leroymerlin\.fr$/.test(h)) return "https://www.leroymerlin.fr/";
  if (/leroymerlin\.es$/.test(h)) return "https://www.leroymerlin.es/";
  if (/leroymerlin\.it$/.test(h)) return "https://www.leroymerlin.it/";
  if (/leroymerlin/.test(h)) return "https://www.leroymerlin.fr/";
  if (/manomano/.test(h)) return "https://www.manomano.fr/";
  if (/alicdn\.com$/.test(h) || /1688\.com$/.test(h)) return "https://detail.1688.com/";
  if (/alicdn/.test(h)) return "https://www.taobao.com/";
  if (/amazon/.test(h) || /media-amazon/.test(h)) return "https://www.amazon.fr/";
  return null;
}

/* 判断这个链接是不是图片直链 */
function isDirectImageUrl(u) {
  const s = String(u || "");
  if (/\.(jpe?g|png|webp|gif|bmp)(\?|#|$)/i.test(s)) return true;
  if (/\/(?:image|img|pic|photo|media|thumb)[^?]*\?/i.test(s)) return false;
  return false;
}

/* 统一入口：给一个链接，想办法拿到一张真图片的 buffer
   返回 { buf, ext } ；失败抛错（错误信息给用户看） */
async function resolveImage(rawUrl) {
  const url = String(rawUrl || "").trim();
  if (!url) throw new Error("链接是空的");
  if (!/^https?:\/\//i.test(url)) throw new Error("链接要以 http:// 或 https:// 开头");

  let host = "";
  try { host = new URL(url).hostname; } catch { throw new Error("链接格式不对"); }

  // Referer 轮换：站点专属 → 自己域名 → 不带 → 搜索引擎
  const referers = [];
  const siteRef = siteReferer(host);
  if (siteRef) referers.push(siteRef);
  referers.push("origin", "", "https://www.google.com/");

  // 第一步：直接请求这个链接
  let res = null, lastErr = null;
  for (const ref of referers) {
    const h = {};
    if (ref === "origin") h.Referer = "https://" + host + "/";
    else if (ref) h.Referer = ref;
    try {
      res = await httpGet(url, h);
      break;
    } catch (e) {
      lastErr = e;
      // 404/410 换 Referer 也没用，直接报
      if (e.status === 404 || e.status === 410) break;
    }
  }
  if (!res) {
    const st = lastErr && lastErr.status;
    if (st === 403 || st === 401) throw new Error("网站拒绝访问（防盗链）。改用「右键复制图片 / 截图后 Ctrl+V 粘贴」");
    if (st === 404) throw new Error("链接打不开（404），检查一下地址对不对");
    throw new Error((lastErr && lastErr.message) || "网络请求失败");
  }

  // 情况一：确实是图片
  let ext = sniffImage(res.buf);
  if (ext) {
    if (ext === ".avif") throw new Error("网站给的是 AVIF 格式，程序存不了，换 jpg/png 的图链接");
    const v = validateImageBuf(res.buf, ext);
    if (!v.ok) throw new Error(v.reason);
    return { buf: res.buf, ext };
  }

  // 情况二：是个网页，去里面挖主图
  const isHtml = /html/i.test(res.type) || /^\s*<(!doctype|html)/i.test(res.buf.slice(0, 200).toString("utf8"));
  if (!isHtml) throw new Error("这个地址不是图片（是网页或下载页）。请右键商品图选「复制图片地址」");

  const html = res.buf.toString("utf8");
  const cands = extractPageImage(html, url);
  if (!cands.length) {
    throw new Error("商品页里找不到主图，被反爬拦了。改用「截图后 Ctrl+V 粘贴」最快");
  }

  // 逐个候选图试
  for (const c of cands.slice(0, 6)) {
    try {
      const r2 = await httpGet(c, { Referer: url });
      const e2 = sniffImage(r2.buf);
      if (!e2 || e2 === ".avif") continue;
      const v = validateImageBuf(r2.buf, e2);
      if (!v.ok) continue;
      return { buf: r2.buf, ext: e2 };
    } catch { /* 换下一张 */ }
  }
  throw new Error("页面里找到图片地址了但拉不下来（防盗链）。改用「右键复制图片 / 截图后按 Ctrl+V 粘贴」");
}

/* 下载网络图片到指定路径（保留旧签名，内部走 resolveImage） */
async function downloadImage(url, dest) {
  const { buf, ext } = await resolveImage(url);
  fs.writeFileSync(dest, buf);
  return dest;
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
    let tmp = "";
    try {
      const got = await resolveImage(url);
      const ext = got.ext;
      tmp = path.join(IMG_DIR, "_tmp_" + id + ext);
      fs.writeFileSync(tmp, got.buf);

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
        imgUrl: url,
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
  const { id, src, url, buffer } = payload || {};
  const items = readItems();
  const it = items.find(x => x.id === id);
  if (!it) return { ok: false, error: "找不到这件商品" };
  try {
    let newPath = "", newOrig = "", tmpPath = "";

    if (src) {
      if (!isValidImageFile(src)) return { ok: false, error: "这个文件不是有效图片，或者图片已损坏" };
      newPath = src;
      newOrig = path.basename(src);
    } else if (buffer) {
      // 剪贴板粘贴进来的图片
      const buf = Buffer.from(buffer);
      const ext = sniffImage(buf);
      if (!ext) return { ok: false, error: "粘贴的内容不是图片" };
      const v = validateImageBuf(buf, ext);
      if (!v.ok) return { ok: false, error: v.reason };
      newPath = path.join(IMG_DIR, "_tmp_" + id + ext);
      fs.writeFileSync(newPath, buf);
      tmpPath = newPath;
      newOrig = "paste_" + id + ext;
    } else if (url) {
      const got = await resolveImage(url);
      newPath = path.join(IMG_DIR, "_tmp_" + id + got.ext);
      fs.writeFileSync(newPath, got.buf);
      tmpPath = newPath;
      newOrig = "url_" + id + got.ext;
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

/* 从剪贴板图片直接建商品（对付反爬网站：截图或右键复制图片即可） */
ipcMain.handle("add-image-buffer", async (e, payload) => {
  const data = payload && payload.data;
  const hintName = String((payload && payload.name) || "").trim();
  if (!data) return { ok: false, error: "没收到图片内容" };
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const ext = sniffImage(buf);
  if (!ext) return { ok: false, error: "剪贴板里的不是图片" };
  const v = validateImageBuf(buf, ext);
  if (!v.ok) return { ok: false, error: v.reason };

  return await withDbLock(() => {
    const items = readItems();
    const seqRef = { value: nextSeq(items) };
    const id = newId(seqRef.value);
    const imgName = id + ext;
    const dest = path.join(IMG_DIR, imgName);
    fs.writeFileSync(dest, buf);
    const item = {
      id,
      orig: "paste_" + id + ext,
      img: imgName,
      thumb: makeThumb(dest, id),
      name: hintName || "",
      sku: "",
      cat: "",
      url: "",
      note: "",
      ts: Date.now()
    };
    items.push(item);
    writeItems(items);
    return { ok: true, item };
  });
});

/* 给已有条目按链接补图（表格导入后调用） */
ipcMain.handle("download-one", async (e, payload) => {
  const { id, url } = payload || {};
  const useUrl = String(url || "").trim();

  // 先把链接取出来（不长期占锁）
  let target = useUrl;
  if (!target) {
    const cur = readItems().find(x => x.id === id);
    if (!cur) return { ok: false, error: "找不到这件商品" };
    target = String(cur.url || "").trim();
  }
  if (!target) return { ok: false, error: "这条没有链接" };
  if (!/^https?:\/\//i.test(target)) return { ok: false, error: "链接要以 http 开头" };

  try {
    // 下载阶段并发安全：每张图文件名带 id + 时间戳，不会撞
    const { buf, ext } = await resolveImage(target);
    const imgName = id + "_" + Date.now().toString(36) + ext;
    const dest = path.join(IMG_DIR, imgName);
    fs.writeFileSync(dest, buf);
    const th = makeThumb(dest, id);

    // 写记录阶段加锁，避免并发互相覆盖
    return await withDbLock(() => {
      const items = readItems();
      const it = items.find(x => x.id === id);
      if (!it) return { ok: false, error: "商品已被删除" };
      if (it.img && it.img !== imgName) {
        const old = path.join(IMG_DIR, it.img);
        if (fs.existsSync(old)) { try { fs.unlinkSync(old); } catch {} }
      }
      it.img = imgName;
      if (!it.url) it.url = target;   // 采购链接为空时，先用图片地址顶着
      it.imgUrl = target;             // 原图下载地址，导出时带上
      it.thumb = th || imgName;
      delete it.pending;
      writeItems(items);
      return { ok: true, img: imgName, thumb: th };
    });
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
ipcMain.handle("delete-many", (e, ids) => withDbLock(() => _deleteMany(ids)));

function _deleteMany(ids) {
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
}

/* 生成模板表格内容（用 xlsx 写，主进程存到临时目录并返回路径） */
/* 模板完全按用户 1688 表的结构来：列名、列序一模一样，方便直接复制粘贴 */
const TPL_HEADER = ["最低售价", "1688链接", "照片", "重量kg", "成本价", "商品名称", "规格", "分类"];
const TPL_COLS = [
  { wch: 11 }, { wch: 62 }, { wch: 44 }, { wch: 9 },
  { wch: 10 }, { wch: 40 }, { wch: 16 }, { wch: 10 }
];
const TPL_SAMPLE = [
  [14.18, "https://detail.1688.com/offer/1081921567398.html", "", 0.35, 16.5, "", "", ""],
  [19.9, "https://detail.1688.com/offer/1082171089832.html",
   "https://media.adeo.com/mkp/af2d1604d1fbaab71c286e96d0169374/media.jpg?width=650", 0.5, 25,
   "（上面两行是示例，填数据前删掉）", "20×30cm", "灯饰"]
];

ipcMain.handle("make-template", async (e, opts) => {
  const ws = XLSX.utils.aoa_to_sheet([TPL_HEADER, ...TPL_SAMPLE]);
  ws["!cols"] = TPL_COLS;
  ws["!freeze"] = { xSplit: 0, ySplit: 1 };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "商品清单");

  // 第二页：每列怎么填
  const guide = [
    ["列名", "怎么填", "必填"],
    ["最低售价", "欧洲站的最低跟卖价，填数字，单位欧元。例如 14.18", "建议填"],
    ["1688链接", "1688 商品页地址，或者任何采购页地址。一整串粘进来就行", "必填"],
    ["照片", "两种都可以：①直接粘贴图片（WPS 会变成嵌入图）②填图片网址", "选填"],
    ["重量kg", "填公斤数，例如 0.35。程序会自动换算成 350 克", "建议填"],
    ["成本价", "1688 采购价，填人民币数字。例如 16.5", "建议填"],
    ["商品名称", "不填也行，程序会从图片描述里自动取", "选填"],
    ["规格", "尺寸、容量、颜色之类的备注，方便自己看", "选填"],
    ["分类", "不填也行，程序会按商品名自动归类", "选填"]
  ];
  const ws2 = XLSX.utils.aoa_to_sheet(guide);
  ws2["!cols"] = [{ wch: 12 }, { wch: 64 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, ws2, "怎么填");

  let filePath = (opts && opts.targetFile) || "";
  if (!filePath) {
    const r = await dialog.showSaveDialog(mainWin, {
      title: "保存导入模板",
      defaultPath: path.join(app.getPath("desktop"), "1688商品表_模板.xlsx"),
      filters: [{ name: "Excel", extensions: ["xlsx"] }]
    });
    if (r.canceled || !r.filePath) return { ok: false };
    filePath = r.filePath;
  }
  XLSX.writeFile(wb, filePath);
  return { ok: true, file: filePath };
});

/* 导出当前清单 */
/* 导出表：前 8 列和用户的 1688 表同序同单位，后面追加图片与附加信息
   注意重量列必须写 kg（内部存的是克），否则再导入会放大 1000 倍 */
const EXPORT_HEADER = [
  "最低售价", "1688链接", "本地图片", "重量kg", "成本价",
  "商品名称", "规格", "分类", "图片链接", "货号", "备注"
];
const EXPORT_COLS = [
  { wch: 11 }, { wch: 58 }, { wch: 26 }, { wch: 9 }, { wch: 10 },
  { wch: 36 }, { wch: 16 }, { wch: 10 }, { wch: 46 }, { wch: 12 }, { wch: 20 }
];

/* 图片链接：优先记下来的原图地址，其次采购链接 */
function imageLinkOf(it) {
  return it.imgUrl || it.sourceUrl || "";
}

/* 内部重量是克，导出成 kg */
function weightInKg(w) {
  const n = parseFloat(w);
  if (!isFinite(n) || n <= 0) return "";
  const kg = n / 1000;
  return String(+kg.toFixed(3));
}

function buildExportRow(it, imgDirName) {
  return [
    it.price || "",
    it.url || "",
    it.img ? (imgDirName ? imgDirName + "/" + it.img : it.img) : "",
    weightInKg(it.weight),
    it.cost || "",
    it.name || "",
    it.spec || "",
    it.cat || "",
    imageLinkOf(it),
    it.sku || "",
    it.note || ""
  ];
}

/* 图片链接列做成可点击的：有网图地址就用网图，只有本地图就指向本地文件 */
/* relPrefix 有值（导包时）就用相对路径，整个文件夹拷走链接也不会坏 */
function linkColumn(ws, colIdx, items, relPrefix) {
  items.forEach((it, i) => {
    if (!it.img) return;
    const addr = XLSX.utils.encode_cell({ c: colIdx, r: i + 1 });
    const netUrl = it.imgUrl || it.sourceUrl || "";

    // 有网图地址：直接给网址
    if (netUrl) {
      ws[addr] = { t: "s", v: netUrl, l: { Target: netUrl, Tooltip: "点击用浏览器打开" } };
      return;
    }
    // 只有本地图：导包用相对路径，单表导出用本机绝对路径
    const target = relPrefix
      ? relPrefix + "/" + it.img
      : "file:///" + path.join(IMG_DIR, it.img).replace(/\\/g, "/");
    ws[addr] = { t: "s", v: it.img, l: { Target: target, Tooltip: "点击打开图片" } };
  });
}

/* 1688链接列也做成可点的 */
function linkUrlColumn(ws, colIdx, items) {
  items.forEach((it, i) => {
    const u = String(it.url || "").trim();
    if (!/^https?:\/\//i.test(u)) return;
    const addr = XLSX.utils.encode_cell({ c: colIdx, r: i + 1 });
    ws[addr] = { t: "s", v: u, l: { Target: u, Tooltip: "点击打开采购页" } };
  });
}

ipcMain.handle("export-list", async (e, items, opts) => {
  const body = items.map(it => buildExportRow(it, ""));
  const ws = XLSX.utils.aoa_to_sheet([EXPORT_HEADER, ...body]);
  ws["!cols"] = EXPORT_COLS;
  linkUrlColumn(ws, 1, items);
  linkColumn(ws, 8, items);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "商品清单");

  // 说明页
  const info1 = [
    ["导出时间", new Date().toLocaleString("zh-CN")],
    ["商品数量", items.length],
    ["", ""],
    ["模式", "只导出表格（不含图片文件）"],
    ["图片怎么查看", "「图片链接」列可以直接点击：有网图地址的用浏览器打开；只有本地图的指向本机文件"],
    ["想连图片一起要", "回到程序，点「导出图片 + 表格」，会给你一个文件夹，里面 images 全是真图"]
  ];
  const s1 = XLSX.utils.aoa_to_sheet(info1);
  s1["!cols"] = [{ wch: 16 }, { wch: 82 }];
  XLSX.utils.book_append_sheet(wb, s1, "导出说明");

  let filePath = (opts && opts.targetFile) || "";
  if (!filePath) {
    const r = await dialog.showSaveDialog(mainWin, {
      title: "导出商品清单",
      defaultPath: path.join(app.getPath("desktop"), "1688商品表_导出.xlsx"),
      filters: [{ name: "Excel", extensions: ["xlsx"] }]
    });
    if (r.canceled || !r.filePath) return { ok: false };
    filePath = r.filePath;
  }
  XLSX.writeFile(wb, filePath);
  return { ok: true, file: filePath };
});

/* 连图片一起导出：一个文件夹，里面 清单.xlsx + images/ */
/* 生成一个看图页：双击用浏览器打开，图和数据一屏看完 */
function buildGalleryHtml(items) {
  const esc = v => String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const card = it => {
    const kg = parseFloat(it.weight) > 0 ? (parseFloat(it.weight) / 1000).toFixed(2) + " kg" : "";
    const img = it.img
      ? `<img src="images/${esc(it.img)}" loading="lazy" alt="">`
      : `<div class="noimg">无图</div>`;
    return `<div class="c">
      <div class="iw"><a href="${esc(it.imgUrl || "images/" + (it.img || ""))}" target="_blank">${img}</a></div>
      <div class="body">
        <div class="n">${esc(it.name || "未命名")}</div>
        <div class="row">
          ${it.price ? `<span class="p">€${esc(it.price)}</span>` : ""}
          ${it.cost ? `<span class="cost">¥${esc(it.cost)}</span>` : ""}
          ${kg ? `<span class="w">${kg}</span>` : ""}
        </div>
        ${it.spec ? `<div class="spec">${esc(it.spec)}</div>` : ""}
        ${it.url ? `<a class="go" href="${esc(it.url)}" target="_blank">打开采购页 ↗</a>` : `<span class="go no">无采购链接</span>`}
      </div>
    </div>`;
  };

  const total = items.length;
  const withImg = items.filter(x => x.img).length;
  const stamp = new Date().toLocaleString("zh-CN");

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>看货清单 · ${total} 件</title>
<style>
*{box-sizing:border-box}
body{margin:0;padding:28px 32px 60px;background:#F3F5F9;color:#1B2230;
  font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
h1{font-size:20px;margin:0 0 6px}
.meta{color:#6B7280;font-size:12.5px;margin-bottom:22px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:16px}
.c{background:#fff;border-radius:14px;overflow:hidden;display:flex;flex-direction:column;
  box-shadow:0 1px 3px rgba(16,24,40,.07),0 8px 24px rgba(16,24,40,.05)}
.iw{aspect-ratio:1/1;display:grid;place-items:center;background:#FAFBFE;padding:10px;overflow:hidden}
.iw img{max-width:100%;max-height:100%;object-fit:contain;transition:transform .3s}
.c:hover .iw img{transform:scale(1.05)}
.noimg{color:#B4BCC8;font-size:12px}
.body{padding:12px 14px 14px;display:flex;flex-direction:column;gap:7px;flex:1}
.n{font-size:13px;font-weight:600;line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;
  -webkit-box-orient:vertical;overflow:hidden;min-height:38px}
.row{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap}
.p{font-size:15px;font-weight:700;color:#111}
.cost{font-size:12px;color:#7A7A7A}
.w{font-size:12px;color:#7A7A7A;background:#F1F4F9;border-radius:4px;padding:1px 6px}
.spec{font-size:11.5px;color:#8A94A6}
.go{font-size:12px;color:#1F3864;text-decoration:none;margin-top:auto;font-weight:600}
.go:hover{text-decoration:underline}
.go.no{color:#B4BCC8;font-weight:400}
@media(prefers-color-scheme:dark){
  body{background:#0E1116;color:#E6E9EE}
  .c{background:#171B22}
  .iw{background:#12161C}
  .n{color:#E6E9EE}
  .p{color:#fff}
  .cost,.w{color:#98A2B3}
  .w{background:#1F242D}
  .spec{color:#7C8698}
  .go{color:#7DB2FF}
}
</style></head><body>
<h1>看货清单</h1>
<div class="meta">共 ${total} 件 · 有图 ${withImg} 件 · 导出于 ${stamp}</div>
<div class="grid">${items.map(card).join("")}</div>
</body></html>`;
}

ipcMain.handle("export-pack", async (e, items, opts) => {
  if (!items || !items.length) return { ok: false, error: "没有商品可导出" };

  const stamp = new Date();
  const pad = n => String(n).padStart(2, "0");
  const folderName = `采购清单_${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}`;

  let baseDir = (opts && opts.targetDir) || "";
  if (!baseDir) {
    const pick = await dialog.showOpenDialog(mainWin, {
      title: "选择导出到哪个文件夹",
      properties: ["openDirectory", "createDirectory"],
      defaultPath: app.getPath("desktop")
    });
    if (pick.canceled || !pick.filePaths.length) return { ok: false };
    baseDir = pick.filePaths[0];
  }

  const outRoot = path.join(baseDir, folderName);
  const imgOut = path.join(outRoot, "images");
  fs.mkdirSync(imgOut, { recursive: true });

  let copied = 0, missing = 0, bytes = 0;
  const total = items.length;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.img) {
      const src = path.join(IMG_DIR, it.img);
      if (fs.existsSync(src)) {
        const dst = path.join(imgOut, it.img);
        try {
          fs.copyFileSync(src, dst);
          copied++;
          bytes += fs.statSync(dst).size;
        } catch { missing++; }
      } else missing++;
    }
    if (i % 5 === 0 || i === total - 1) {
      mainWin.webContents.send("import-progress", {
        phase: "export", done: i + 1, total, text: `导出图片 ${i + 1}/${total}`
      });
    }
  }

  const body = items.map(it => buildExportRow(it, "images"));
  const ws = XLSX.utils.aoa_to_sheet([EXPORT_HEADER, ...body]);
  ws["!cols"] = EXPORT_COLS;
  linkUrlColumn(ws, 1, items);
  linkColumn(ws, 8, items, "images");
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "商品清单");

  // 第二页：说明
  const info = [
    ["导出时间", stamp.toLocaleString("zh-CN")],
    ["商品数量", items.length],
    ["图片数量", copied],
    ["缺失图片", missing],
    ["", ""],
    ["模式", "导出图片 + 表格（图片是真文件）"],
    ["图片在哪", "本文件夹下的 images\\ 里，文件名与「本地图片」列一一对应"],
    ["图片链接", "「图片链接」列可点击：有网图地址的打开网图，只有本地图的打开本机文件"],
    ["想只要链接", "回到程序点「只导出表格（不含图片）」"]
  ];
  const ws2 = XLSX.utils.aoa_to_sheet(info);
  ws2["!cols"] = [{ wch: 14 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(wb, ws2, "导出说明");

  const xlsxPath = path.join(outRoot, "清单.xlsx");
  XLSX.writeFile(wb, xlsxPath);

  // 顺手生成一个浏览器能直接看的看图页
  try {
    fs.writeFileSync(path.join(outRoot, "看货清单.html"), buildGalleryHtml(items), "utf8");
  } catch (err) {
    console.error("看图页生成失败", err.message);
  }

  return {
    ok: true,
    dir: outRoot,
    xlsx: xlsxPath,
    copied,
    missing,
    mb: +(bytes / 1024 / 1024).toFixed(1)
  };
});
