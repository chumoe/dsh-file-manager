# dsh-file-manager

一个完整的文件管理器，用来替换 DeepSeek Harness（DSH）右侧边栏里的 **工作区文件** 面板 —— 浏览、预览、编辑、新建、重命名、复制、移动、删除、压缩、解压、上传、下载，并把文件作为**真正的输入框 chip** 交给对话。

自带的 `@deepseek-ai/dsh-client-ui-sidebar-files` 面板只能列出文件。本插件往**同一批插槽键上以 `priority: -10`** 注册了替代的面板主体与标题，因此只在本插件启用时生效。禁用插件，原面板立刻回来 —— 没有打补丁，也没有删改任何文件。

| | |
| --- | --- |
| 插件 id | `file-manager` |
| 包名 | `dsh-file-manager` |
| 宿主半 | `index.js`（4 条带鉴权的 Fetch 路由） |
| Web 半 | `client.js`（不依赖任何 Harness 客户端包） |
| Node | ≥ 22 |
| 系统工具 | `zip`、`unzip`、`tar`（仅压缩 / 解压 / 目录下载时用到） |

## 功能

**目录浏览**
- 一次只看一层目录：列表永远显示当前文件夹的子项，所以面包屑和列表内容不会互相矛盾。
- 双击、`Enter`、行首箭头或点面包屑都能进入文件夹；`ArrowLeft` 回到上级；单击只做选中，绝不会把指针底下的列表换掉。
- 用 `Ctrl` / `Cmd` 与 `Shift` 多选；选中后出现的操作条在**列表下方**，所以选中一行不会把行挪走，双击不会被自己的第一次点击打断。
- 搜索（放大镜）是唯一跨目录的模式：在已加载的所有目录里过滤，保留每个命中的祖先层级，并以缩进树的形式呈现。行元素带 `treeitem` / `aria-level` / `data-fm-path`。
- 目录排在前面，其余按自然序、忽略大小写排序。
- 工具栏里的**跳转菜单**可以把面板切换到另一个根目录：会话工作区、家目录、桌面 / 下载 / 文档、`/tmp` 以及 `/`。任何绝对路径都能用，所以面板不会被困在单一工作区里。

**预览与编辑**
- 图片、PDF、视频、音频、文本可内联预览；其他二进制回落到元信息加一个下载按钮。
- **Markdown 按文档渲染。** `.md`/`.markdown`/`.mdx` 走宿主自带的渲染器 —— 与对话正文同一个组件 —— 标题、列表、表格、任务清单、引用块与高亮代码围栏都和一条消息里长得一样。工具栏上的开关可把单个文件切回高亮源码；非 Markdown 的文本仍保持源码视图。相对路径的图片按该文件所在目录解析；超过 200 KB 的文档不渲染，直接停在源码视图，避免卡住面板。
- **HTML 在沙箱框架里渲染。** `.html`/`.htm` 打开在一个 `sandbox=""` 的框架里：样式和图片照常显示，脚本、表单和跳转被浏览器本身拒绝。相对的 `src`/`href`/`poster` 会被改写到带鉴权的下载路由、按该文件所在目录解析；根绝对路径保持原样。同一个开关可切回高亮源码；超过 200 KB 的文件停在源码视图。
- 预览带行号，文字滚动时行号一起滚动、不会错位。
- 预览与编辑都有语法高亮，且**不依赖任何第三方库**：内置分词器覆盖 C 系语言（JS/TS/JSX/Java/C/C++/Go/Rust/PHP…）、Python/Ruby/Shell/Lua、YAML/TOML/INI、SQL、CSS/SCSS/Less、JSON 与 HTML/XML/Vue/Svelte，另外还有 Markdown。配色使用主题别名，跟随明暗主题。超过 80 KB 的文件回退成纯文本，避免超大文件卡住面板。
- 在高亮层上直接编辑（透明 textarea + 滚动同步）。`Ctrl+S` 保存，`Tab` 插入两个空格，文件被外部改动时弹出冲突提示而不是静默覆盖，超过 2 MB 文本上限的文件以只读方式打开。
- 即便在带高亮的预览里，选词与选行的行为也与普通多行文本框一致：高亮会把每个 token 切成独立的 `<span>`，原生双击因此会在 token 边界停下 —— 双击会重新选中整个词、三击选中整行，且能跨 span 选中；双击在空白处时仍保留浏览器自己的间隙选择行为。

**文件操作**
- 新建文件、新建文件夹、重命名（`F2`）、删除（`Del`）、复制 / 剪切 / 粘贴（`Ctrl+C` / `X` / `V`）。
- 上传文件与整个文件夹（拖放也可以）。下载以 blob 方式取得并通过同源锚点保存，因此 Web UI 挂在网关前缀后面时也能用。
- 下载单个文件、整个文件夹（打包成 zip），或一次多选（打成一个 zip）。
- 压缩成 ZIP 或 `tar.gz`；在压缩包旁边解压 ZIP / tar / `tar.gz`。解压先落到工作区内的临时目录，再移动到唯一的最终名字，所以恶意压缩包无法写到目标之外。
- 隐藏文件开关：点文件默认隐藏，工具栏「更多操作」菜单可以切换。

**右键菜单**
- 目录树、预览、编辑器三处都有菜单。不适用项**直接不显示，绝不置灰**：没选中就没有复制，没选中文本就没有「加入所选文本」，剪贴板为空或不可读就没有粘贴，只读截断的文件就没有剪切 / 粘贴。
- 目录树菜单提供「复制相对路径」「复制绝对路径」「复制文件名」；预览与编辑器菜单也有「复制绝对路径」。多选时一行一个路径。

**加入对话：真正的 chip**
- 「加入对话」生成的是**真正的输入框 chip**，与用 `@` 选文件得到的一样。整篇草稿通过草稿快照（`{text, references}`）重写，这是让输入框重建 chip 节点的唯一途径。已有 chip 会被保留，偏移随编辑位移，所以先前加入的文件不会消失。
- 输入框给出的光标区间是 *detect* 坐标（一个 chip 只算 1 个字符），而已发布的 occurrences 用的是 *clipboard* 偏移（chip 展开成它的 mention 文本）。拼接之前会先做坐标换算；如果换算结果仍会被输入框拒绝，整次编辑会在草稿末尾重新规划一遍，所以第二次加入绝不可能插进第一个 chip 里面。
- mention 内联在光标处：前后不加换行，只有相邻字符本身不是空白时才补一个分隔空格。「加入所选文本」是唯一的块状插入（围栏代码片段），所以只在该侧缺少换行时借用一次换行。
- 目录树下方有一排 chip 风格标记，镜像当前已附加到对话的每个文件 / 文件夹。输入框把点击 chip 当作「打开文件」而不是「移除」，所以移除动作放在这里：点击标记即移除该文件（删掉 mention 区间并吞掉一个相邻空格），其余 chip 位置不变。

## 安装

需要 DSH `>= 0.2.1-rc.5` 与 Node `>= 22`。

**从本地目录安装**（一个 checkout 或解压出来的 release）。`--profile` 必填，且必须放在 `add` 之前：

```
dsh plugin --profile web add /absolute/path/to/dsh-file-manager
```

或者用插件管理工具，效果相同，并会顺带把 bundle 登记到 profile 里：

```
plugin_manager  action: install_bundle  target: /absolute/path/to/dsh-file-manager
```

**从 GitHub 安装** —— 先 clone，再加入 checkout 目录；本插件没有发布到任何 registry，所以 clone 路径就是安装路径：

```
git clone https://github.com/chumoe/dsh-file-manager.git
dsh plugin --profile web add "$PWD/dsh-file-manager"
```

两种方式都会加依赖**并**把 bundle 登记到 profile（`dsh.profile.bundles`），剩下只需重启。`dsh plugin` 不带 `--profile` 会直接报错，且 profile 必须是你实际在服务的那个 —— 浏览器界面是 `web`。

重启 Web UI（或让 HMR 接上），打开右侧边栏 → **工作区文件**。在插件列表里移除或禁用 `dsh-file-manager` 即可恢复自带面板。

## 配置

没有。没有任何设置项。

面板打开在会话的工作区目录，也可以从工具栏的 **更多操作 → 跳转到** 菜单指向任意其他目录：会话工作区、家目录、存在时的桌面 / 下载 / 文档，以及 `/tmp`、`/` 这类卷根目录。

服务端限额：

| 限额 | 值 |
| --- | --- |
| JSON 请求体 | 32 MB |
| 面板内可编辑文本 | 32 MB |
| 单次返回的目录条目 | 20000（超出会返回 `truncated`） |
| 上传 | 8 GB |

这些是防止面板意外卡死的护栏，不是安全边界 —— 全都刻意放得很宽。

## 安全模型

- **设计上就是本机优先。** DSH 通常跑在操作者自己的机器上，且这些路由本身已继承 Host 的登录 Cookie、Host 与 Origin 校验，所以面板刻意宽松：任何存在的绝对目录都能被打开为根目录 —— 正是这一点让它在 checkout、下载目录、日志目录这些工作区以外的场景里可用。`~` 会展开成家目录，工具栏菜单也提供跳转目标（工作区、家目录、桌面、下载、`/tmp`、`/`）。
- 根目录以下仍然受限：所有相对路径都会规范化（空、`.` 与 `..` 段一律拒绝，反斜杠统一，前导 `/` 剥掉），路径永远不能离开你正在看的那个根。
- 符号链接逃逸会被拒绝：目标最近的存在祖先会被 `realpath`，结果必须仍在根内。
- 上传自动取唯一文件名；写入是临时文件 + 原子 rename，并比对基准 mtime，把外部改动暴露成 `409 conflict`。
- 解压先落到工作区内的临时目录，之后才把条目移动到唯一的最终名字。
- 文本 / HTML / JS 下载强制 `text/plain` + `nosniff` 并加 `CSP: sandbox`；只有已知的图片 / PDF / 音频 / 视频类型才内联返回。
- 「加入对话」只会重写当前会话的输入框草稿（文本加 chip 引用），绝不提交、绝不上传文件、绝不碰别的会话。
- 所有路由都通过 `ctx.connection.fetch.register` 注册，因此继承 Host 的登录 Cookie、Origin 与 Host 校验。

## 目录结构

```
dsh-file-manager/
├── index.js          # 宿主半：4 条带鉴权的 Fetch 路由
├── client.js         # Web 半：面板、编辑器、高亮、菜单、输入框 chip
├── cordis.patch.yml  # 插入宿主插件行
├── locale/en.json    # 插件列表里显示的 meta.title / meta.description
├── locale/zh.json
├── icon.svg          # 插件图标
├── LICENSE
├── README.md
├── README.zh.md
└── package.json
```

`index.js` 注册的路由：

| 路由 | 方法 | 用途 |
| --- | --- | --- |
| `/api/fm/op` | POST | list、read、write、mkdir、rename、copy、move、delete、compress、extract、roots |
| `/api/fm/upload` | POST（流式） | 上传单个文件到目录 |
| `/api/fm/download` | GET | 流式返回文件，或打包目录后流式返回 |
| `/api/fm/zip` | POST | 把一次多选打成一个 zip 返回 |

面板的界面文案放在 `client.js` 内的 `zh` 与 `en` 两张表里；服务端错误信息是英文加稳定的 `code`，客户端翻译已知 code，因此中文界面不会出现原始的英文句子。

## 开发

没有构建步骤：`client.js` 就是一个普通的 `window.__ModuleLoader__.load({ id, factory })` 模块，只 import `react`。它不得 import Harness 客户端包，并且只用 `--dsw-alias-*` 主题 token 写样式（主题变量定义在 `body` 上而不是 `:root`；暗色模式是 `body[data-ds-dark-theme]`）。

发版前的检查：

```
node --check index.js
node --check client.js
node -e "JSON.parse(require('fs').readFileSync('package.json'))"
node -e "JSON.parse(require('fs').readFileSync('locale/en.json'))"
```

行为由宿主路由脚本与渲染脚本覆盖（四条路由用假 `ctx`，面板用带逐 fiber hook 的假 React）。仓库里暂时没有捆绑的测试运行器 —— 这些脚本刻意放在包外，否则 `files` 会把它们一起发给用户。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
