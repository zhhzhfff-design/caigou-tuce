# 商品采购图册

> 点图即达的本地采购工具。看到一个商品图，点一下就打开它的采购链接。

一个 Windows 桌面程序，用来管理商品图片和对应的采购链接。**不联网、不用服务器、数据全在自己电脑上。**

## 它解决什么问题

同一类商品往往有几十个变体，名字高度相似（"三合一数据线 A款 / B款 / C款"），但东西完全不一样。光看名字分不清，搜索也搜不准，**只有看图才能一眼认出是哪个**。

所以这个工具的设计原则是：**图片是唯一主角，文字全部退让**。

- 卡片默认不显示任何文字，只有商品图
- 鼠标移上去才浮出商品名、货号、"打开购买页"
- 点一下直接跳采购链接

## 功能

**浏览**
- 图墙模式：一屏 4~6 个大图卡片，卡片尺寸无级调节
- 列表模式：一屏 13 行，适合批量核对
- 无限滚动 + 图片懒加载，1000 条实测流畅

**导入（四种方式，全部在程序内自己操作）**
- 图片文件夹：整个文件夹一次导入，自动复制 + 生成缩略图
- 多选图片：按文件名排序
- 粘贴图片链接：从网页复制的图片地址，程序自动下载到本地
- Excel / CSV 表格：批量补商品名、链接、分类

**整理**
- 搜索（商品名 / 货号 / 备注 / 分类）
- 分类筛选
- 右键编辑、删除
- 清空全部

## 截图

深色极简界面：纯黑背景、白色圆角卡片、商品图居中留白。

> 截图待补充

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 桌面壳 | Electron 45 | 自带 Chromium，目标机器无需安装任何运行时 |
| 界面 | 原生 JS + CSS | 不用框架，启动快、体积小 |
| 表格 | SheetJS (xlsx) | Excel / CSV 读写 |
| 缩略图 | Electron `nativeImage` | 内置能力，不需要 sharp 编译 |
| 存储 | JSON + 文件系统 | 见下方「数据结构」 |

## 数据结构

```
data/
  items.json    所有商品元数据（约 300KB / 1000 条）
  images/       原图
  thumbs/       缩略图（最长边 620px，JPEG q84）
```

`items.json` 里每条的字段：

```json
{
  "id": "C0001",              // 唯一编号，也是文件名
  "orig": "A001.jpg",         // 原始文件名，表格按这个匹配
  "img": "C0001.jpg",         // data/images 里的文件名
  "thumb": "C0001.jpg",       // data/thumbs 里的文件名
  "name": "三合一数据线 1米",
  "sku": "DL-0001",
  "cat": "数据线",
  "url": "https://detail.1688.com/offer/xxx.html",
  "note": "",
  "ts": 1750000000000
}
```

**备份 = 复制整个 `data` 文件夹。迁移 = 整个程序文件夹拷走。**

## 开发

```bash
cd app
npm install
npm start
```

> 注意：如果环境变量里有 `ELECTRON_RUN_AS_NODE=1`（某些 IDE 注入），需要先清掉，否则 Electron 会以纯 Node 模式启动并报 `Cannot read properties of undefined (reading 'whenReady')`。
>
> ```bash
> env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS npx electron .
> ```

## 打包

```bash
cd app
npx electron-packager . "采购图册" --platform=win32 --arch=x64 \
  --out=../_build/pack --asar --icon=build/icon.ico \
  --app-version=1.0.0 --prune=true
```

> 打包前务必把 `dist/ release/ _build/` 这类产物目录移出源码目录，否则产物会被打进 `app.asar`，体积从 20MB 膨胀到 400MB+。

## 版本历史

| 版本 | 内容 |
|---|---|
| v1.0 | 首个可用版本：图墙浏览 + 四种导入 + 本地存储 + 右键编辑 |

## 目录说明

```
app/              Electron 程序源码
  main.js         主进程：文件读写、缩略图、表格解析、下载
  preload.js      安全桥接
  renderer/       界面层
proto/            最早期的网页原型（保留作设计参考）
_build/           打包产物（不进版本库）
```

## 已知限制

- 只支持 Windows x64
- 数据用 JSON 全量读写，1 万条以上会开始变慢（后续可换 SQLite）
- 图片缩略图在导入时生成，换电脑后需要重新导入才会重建
- 程序未做代码签名，首次运行可能触发 SmartScreen 提示

## License

MIT
