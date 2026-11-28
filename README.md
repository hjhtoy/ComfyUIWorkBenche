# Frameform · ComfyUI 视频工作台

用浏览器连接自托管 ComfyUI。开发版本使用原生 JavaScript ES Modules，发布版把程序、样式、图标和工作流内嵌在一个 HTML 文件里。

## 运行方式与数据保存

### 一键启动

macOS 双击 `start-mac.command`，Windows 双击 `start-windows.bat`。脚本会检查 Node.js 与 Python、首次运行时安装依赖并构建页面，然后启动工作区并自动打开 **http://127.0.0.1:8787**。关闭终端窗口或按 Ctrl+C 即停止服务。

两个可选环境变量：`PORT` 改变端口，`FRAMEFORM_DATA` 改变数据目录（默认 `~/FrameformData`，Windows 为 `%USERPROFILE%\FrameformData`）。修改源码后仍需先运行 `npm run build`。

### 手动启动

**推荐使用工作区模式，所有数据统一保存在本机磁盘，与浏览器无关。**

    npm ci
    npm run build
    pip install -r workspace/requirements.txt
    npm start

打开 **http://127.0.0.1:8787** 即可使用。草稿、素材库、工作流库、任务队列和生成结果全部保存在工作区目录（默认 `~/FrameformData`，可用 `python3 -m workspace serve --data <目录>` 修改）：元数据和任务存于 SQLite，媒体文件按 SHA-256 内容寻址存于 `assets/` 和 `outputs/`。

**「设置 → 当前工作流的结果保存」**可为每个工作流配置不同目录。点击「选择文件夹…」，在系统选择器中选定目录，再点击「保存」。工作区模式需在主机上打开 Frameform 来选择目录。「使用默认目录」会在保存后恢复主机的系统下载目录，启动参数 `python3 -m workspace --outputs <目录> serve` 可以调整这个默认值。结果仍会归档到工作区数据目录，供预览和备份使用。

直接打开 `dist/Frameform.html` 时，可在支持目录访问的浏览器中为当前工作流授权文件夹。未设置时由浏览器下载结果。删除已完成任务默认保留结果文件。勾选「同时删除本地结果文件」会清理工作区归档和工作台能识别并访问的保存文件。浏览器下载的副本以及远端服务自己的输出需在对应位置删除。

其他设备访问同一工作区时，在主机设置密码并绑定局域网地址（非本机绑定必须设置密码）：

    FRAMEFORM_PASSWORD=<密码> python3 -m workspace serve --host 0.0.0.0

也可以用 `--cert/--key` 启用 HTTPS。备份与恢复：

    python3 -m workspace backup backup.zip      # 或在工作区设置里点「备份工作区」
    python3 -m workspace restore backup.zip --data <新目录>

**直接打开 `dist/Frameform.html` 属于浏览器本地模式。** 此时数据只保存在当前浏览器的 localStorage/IndexedDB，换浏览器、换设备或换打开路径后数据不跟随。页面顶部会显示引导条，可跳转到工作区地址，或点「导出数据供迁移」得到 `.ffdata` 迁移包，然后在工作区主机导入：

    python3 -m workspace migrate Frameform-legacy.ffdata

迁移包包含草稿、素材、工作流库和任务记录；缺少本地副本的媒体会在清单中标注。浏览器本地模式的功能与工作区模式一致，仅数据保存位置不同。

## 构建

需要 Node.js 20+、npm 和 Python 3.10+。首次安装依赖后，运行构建命令即可从项目内的工作流生成页面与技能包。

    npm ci
    npm run build

- **dist/Frameform.html** 是统一工作台，内置 Pika H3 Flex。打开后可测试服务器地址，也可以导入并切换工作流。
- **dist/comfyui-api-workbench.zip** 是独立技能包。解压后的 **scripts/workbench.py** 支持 inspect 和 build，生成其他工作流时只需 Python。
- 如果浏览器提示跨域，请按页面内的连接帮助配置 ComfyUI。远端服务仍需安装工作流使用的模型和节点。

## 导入和切换工作流

1. 在 ComfyUI 导出 API 格式 JSON。在工作台顶部点击「导入工作流」，选择该 JSON 文件。
2. 核对输出节点和控件映射。可调整提示词、尺寸、步数和视频时长的候选字段。展开「节点参数」可按节点搜索并勾选高级字段。「检查服务器节点」可补充数值范围和枚举选项。
3. 点击「生成工作台」。新工作流会保存到当前浏览器，并在同一页面打开。顶部选择框可切换工作流，已打开工作流的任务继续跟踪。

各工作流的草稿、参数和任务按工作流区分。刷新会恢复工作流库和上次选择。与内置 Pika H3 Flex 完全相同的 JSON 在未勾选节点参数时打开原工作台，勾选后会创建可切换的自定义副本。

下拉框旁的「删除」将所选工作流移出列表。已提交的任务继续跟踪，重新导入相同工作流和参数映射可恢复其草稿和任务记录。

## 接入 RunningHub

RunningHub 的 `/proxy/<key>` 地址只有读接口可用（实测 `POST /prompt` 返回空对象且任务不执行），本项目改走它的**开放 API**：

1. 用工作区模式启动（`npm start`）。浏览器直连 RunningHub 会被跨域拦截，任务由服务端 Worker 提交。
2. 打开「设置 → RunningHub」，填入 API Key。Key 保存在工作区主机（`workspace.sqlite`），不回传到页面。
3. 服务器地址填 `https://www.runninghub.cn`（48G 实例不影响此方式；不要再带 `/proxy/<key>`）。
4. 在 RunningHub 网页端调通工作流，导出 **API 格式** JSON；在本项目导入时填写「RunningHub 工作流 ID」（平台地址 `/#/workflow/<id>` 里的数字），并核对提示词、尺寸、步数、时长映射。
5. 提交后由服务端依次调用 `/task/openapi/upload` 上传素材、`/task/openapi/create` 创建任务、`/task/openapi/outputs` 轮询状态与结果，再把 `fileUrl` 下载到工作区和输出目录。

注意：

- 本地导入的 JSON 必须与平台工作流节点一致，参数按节点 ID 通过 `nodeInfoList` 覆盖；
- 消费级会员 Key 支持工作流 API，但默认单任务并发，批量入队会在云端排队；
- 已导入的旧工作流需要删除后重新导入，才能填写工作流 ID；
- 「测试连接」对 RunningHub 只检查是否已配置 Key，不再请求 `/system_stats`。

## 手动与批量参数

- 在「添加素材」里可以新建目录、向当前目录导入文件，或多选素材后移动到其他目录。已有素材在「未分类」里。要在提示词中引用素材，输入 `@`，按目录和素材类型筛选，再点选素材。
- 手动和批量生成都可在「输出尺寸」选择常用分辨率。可映射宽高的工作流还支持「自定义宽高」，输入的像素值会随草稿和任务保存。工作流实际可执行的尺寸由远端模型和节点决定。
- 「从项目目录批量生成」弹窗有独立的画幅、尺寸、步数和「高级参数」。批量配置按工作流记忆。分镜优先使用 TXT 正文声明的时长，正文未声明时才读取文件名末尾的 `_24s.txt` 等时长标记。批量导入的素材会自动归入以项目目录命名的素材文件夹，同名文件夹直接复用。
- 分镜 TXT 里把素材名写在标签前即可绑定，中间的连接词不影响识别：`A10_长衫主顾_四视图.png <Picture 2>`、`A10_长衫主顾_四视图.png as <Picture 2>`、`E02_临街朝柜_取景板.png，见 <Picture 1>` 三种写法等价，生成时统一替换为 `<Picture N>`。
- 勾选范围是 API JSON 中已有的可编辑输入值。连线、素材入口、常用控件和用于计算的依赖字段在导入时显示对应说明。
- 每条任务记录保存自己的参数。打开详情可以查看高级参数改动，点击「同款参数创作」会把该任务的参数填入手动表单。
- 运行中的任务会显示当前节点和步数进度（例如「自定义采样器（高级） · 2 / 6 步」），数据来自 ComfyUI 的 `/ws`：托管模式由工作区后台连接，独立模式由浏览器直连。RunningHub 开放 API 只返回排队/执行状态，因此没有节点级进度。
- 提示词框下方的「导入分镜 TXT」可以上传单个分镜文案：按批量导入同样的规则解析素材名与 `<Picture N>`，把素材库里同名的图片直接插成 `@` 标签，并按正文里的时长设置视频时长；素材库里没有对应文件时会列出来，且不改动当前草稿（误替换可用 Ctrl+Z 还原）。素材库存在同名图片时，保留最近导入的一份并从素材库移除旧条目（原始文件仍留在工作区，旧草稿的引用照常可用）。

## 项目结构

以下列出 Git 跟踪的项目文件。构建产物在 `dist/`，依赖、缓存和本地备份目录不展开。

```text
ComfyUIWorkBenche/
├── .gitignore                       # 排除构建产物、依赖、虚拟环境、缓存和本地备份
├── README.md                        # 项目说明、目录导览、构建、升级和测试指引
├── package.json                     # 声明 Node.js 版本、esbuild 依赖和 npm 命令
├── package-lock.json                # 锁定 npm 依赖版本，供 npm ci 重复安装
├── start-mac.command                # macOS 一键启动：检查环境、安装依赖、构建并启动工作区
├── start-windows.bat                # Windows 一键启动，行为与 macOS 版本一致
├── scripts/                         # 工作台构建和技能打包
│   ├── build.mjs                    # 打包浏览器脚本、内嵌样式与图标、编排 HTML 和技能构建
│   ├── package_skill.py             # 按固定文件顺序和时间戳生成技能 ZIP
│   └── workbench.py                 # 检查 API 节点图、验证字段映射、生成独立 HTML
├── skill/                           # 技能说明与配置的源码
│   ├── SKILL.md                     # 说明如何从 ComfyUI API JSON 生成或更新工作台
│   ├── agents/
│   │   └── openai.yaml              # 定义技能在 Codex 中的显示名称和简介
│   └── references/
│       ├── profile.md               # 说明提示词、参数、素材槽位和输出字段的映射格式
│       └── verification.md          # 列出接口行为、浏览器兼容性和交付验收步骤
├── src/                             # 工作台与技能模板共用的浏览器源码
│   ├── batch/
│   │   ├── dialog.js                # 显示批量导入预检，准备素材并将有效分镜加入队列
│   │   └── project.js               # 读取 prompts 和 assets，解析分镜时长、素材标签及文件对应关系
│   ├── comfy/
│   │   ├── advanced.js              # 识别并校验可勾选的节点字段与参数值
│   │   ├── api.js                   # 规范化服务器地址，封装连接测试、HTTP 请求和结果访问地址
│   │   ├── config.js                # 读取内嵌的工作流与映射，提供默认值和尺寸、步数换算
│   │   ├── references.js            # 管理各类素材的标签、槽位和 H3 动态音视频输入节点
│   │   └── workflow.js              # 组装要提交的节点图，匹配服务端工作流并还原任务参数
│   ├── jobs/
│   │   ├── history.js               # 从本地记录和 ComfyUI 历史补全缺失的任务提示词与参数
│   │   ├── player.js                # 展示视频或图片、恢复任务详情并回填同款参数
│   │   ├── queue-view.js            # 渲染任务列表、计时和状态页签，处理选择、下载、删除及复制 ID
│   │   ├── runner.js                # 上传素材、提交任务、通过 WebSocket 和轮询跟踪进度及取消
│   │   └── state.js                 # 定义任务状态、标识、记录合并规则和耗时显示
│   ├── library/
│   │   ├── advanced.js              # 分组展示节点输入并记录高级字段勾选
│   │   ├── graph.js                 # 解析 API JSON、追踪节点连线并定位可写字段
│   │   ├── mapping.js               # 识别输出、提示词、采样、时长、尺寸和素材槽位
│   │   ├── panel.css                # 工作流切换器、导入弹窗与内嵌工作台布局
│   │   ├── panel.html               # 工作流库导航、文件选择和映射确认表单
│   │   ├── panel.js                 # 编排导入、节点检查、工作流的保存、切换与删除
│   │   ├── persistence.js           # 保存工作流库、去重、移除与恢复，并记住当前工作流
│   │   └── render.js                # 以共用模板和运行脚本组装内嵌工作台
│   ├── media/
│   │   ├── outputs.js               # 识别视频与首帧，处理缓存、保存到本机、下载和 ZIP 打包
│   │   └── types.js                 # 定义图片、视频和音频的扩展名、上传类型与存储键
│   ├── storage/
│   │   ├── browser.js               # 提供 LocalStorage 和 IndexedDB 读写及页面存储标识
│   │   ├── jobs.js                  # 保存与恢复任务记录，过滤已删除的任务
│   │   ├── material-folders.js      # 按工作台保存虚拟素材目录和归类关系
│   │   ├── transfer.js              # 导出浏览器旧数据为 .ffdata，或下载工作区备份
│   │   └── workspace.js             # 工作区 HTTP 存储接口、乐观锁写入与跨窗口版本同步
│   ├── ui/
│   │   ├── advanced-parameters.js   # 渲染高级参数弹窗和任务快照中的参数详情
│   │   ├── base.css                 # 定义基础布局、控件、任务行、模态窗口和响应式样式
│   │   ├── composer.js              # 管理提示词编辑、@ 素材库、草稿恢复和提交参数快照
│   │   ├── dom.js                   # 提供 DOM 查询、元素与按钮创建以及 ID 生成函数
│   │   ├── frameform.ico            # 工作台网页图标，构建时内嵌到 HTML
│   │   ├── material-picker.js       # 素材导入、目录管理和 @ 引用选择
│   │   ├── mentions.js              # 创建素材标签、清理编辑内容并渲染服务端提示词
│   │   ├── page.html                # 页面结构和控件模板，含脚本、样式和工作流数据占位
│   │   ├── parameters.js            # 控制比例、尺寸、视频时长和步数，并显示预计时长
│   │   ├── servers.js               # 管理多条服务器地址、当前服务器切换及连接状态
│   │   ├── settings.js              # 管理主题、视频缓存选项和本机保存目录
│   │   └── standalone.js            # 浏览器本地模式的工作区引导条、地址校验与迁移导出
│   │   └── themes.css               # 定义六套主题及其布局、色彩和控件样式
│   ├── main.js                      # 浏览器入口，启动工作台
│   └── workbench.js                 # 组装各模块，注册生成入口并恢复任务和草稿
├── tests/                           # 模拟 ComfyUI 的回归测试
│   ├── fixtures/
│   │   ├── h3-image-edit.api.json   # 修图工作流样本：提示词经文本生成链与素材槽位注入
│   │   ├── h3-image-text.api.json   # 文生图工作流样本：提示词经 StringReplace 模板注入
│   │   ├── image.api.json           # 文生图测试用 API 节点图
│   │   ├── image.profile.json       # 文生图测试用提示词、尺寸、步数和输出配置
│   │   ├── invalid-profile.json     # 无效映射样本，验证构建器能拦截错误配置
│   │   ├── preview.webm            # 固定视频样片，用于预览、缓存和下载测试
│   │   ├── resize.api.json          # 图像缩放测试用 API 节点图
│   │   ├── resize.profile.json      # 图像缩放工作台的素材槽位、尺寸和输出配置
│   │   ├── ui-workflow.json         # 编辑器格式样本，验证构建器能辨别 API 格式
│   │   ├── video.api.json           # 通用视频工作台测试用 API 节点图
│   │   └── video.profile.json       # 通用视频测试用时长、参考图、采样和输出配置
│   ├── browser-entry.js             # 测试专用浏览器入口，提供可供断言读取的内部状态
│   ├── requirements.txt             # 锁定 Playwright、Pillow 和 aiohttp 测试依赖
│   ├── run.py                       # 构建测试页面，运行指定场景并汇总结果
│   ├── support.py                   # 提供测试页面路径与 Chromium 启动配置
│   ├── test_generation.py           # 验证生成提交、WebSocket 进度、取消、刷新和结果预览
│   ├── test_h3_text_workflow.py     # 验证官方 H3 文生视频映射、布局、提交和旧工作流修复
│   ├── test_h3_prompt_chain.py      # 验证经文本生成链注入提示词的工作流能自动映射并提交用户输入
│   ├── test_image.py                # 验证图片工作流控件、参数提交、结果预览和回填
│   ├── test_job_actions.py          # 验证任务 ID 复制、单条和批量下载、删除及缓存清理
│   ├── test_material_library.py     # 验证多模态导入、分类计数、重复引用和素材恢复
│   ├── test_player_backdrop.py      # 验证播放器蒙版关闭、移动端布局和警告色
│   ├── test_project_batch.py        # 验证分镜目录预检、素材超限提示、混合标签和批量入队
│   ├── test_queue_sync.py           # 验证同工作流运行任务的导入、去重与后续轮询
│   ├── test_queue_tabs.py           # 验证状态筛选、任务计数、键盘操作与横线分隔
│   ├── test_recover_details.py      # 验证旧任务从服务器历史补全详情，以及刷新后保留详情
│   ├── test_server_themes.py        # 验证服务器切换、队列隔离、六套主题和草稿保持
│   ├── test_servers.py              # 验证服务器地址的新增、编辑、删除与跨标签页同步
│   ├── test_skill_package.py        # 解压并独立验证技能包构建、工作流样本与错误输入
│   ├── test_standalone_notice.py    # 验证本地模式引导条、地址校验、迁移导出与托管模式抑制
│   ├── test_storage_upgrade.py      # 在原路径替换新版，验证草稿、素材、设置和任务恢复
│   ├── test_task_details.py         # 验证失败、取消等任务的详情展示和同款参数回填
│   ├── test_workflow_library.py     # 验证实际工作流导入、映射、切换、后台跟踪和刷新恢复
│   └── test_workspace.py            # 验证双客户端协同、后台投递、崩溃对账、备份还原与旧数据迁移
├── workspace/                       # 本地工作区服务（aiohttp + SQLite）
│   ├── __main__.py                  # npm start 入口，提供 serve/backup/restore/migrate 子命令
│   ├── migration.py                 # 把浏览器导出的 .ffdata 迁移包导入工作区
│   ├── requirements.txt             # 工作区服务的 aiohttp 依赖
│   ├── server.py                    # HTTP 边界、页面快照注入、ComfyUI 代理与进程锁
│   ├── store.py                     # SQLite 仓储、内容寻址媒体保存、在线备份与恢复校验
│   └── worker.py                    # 后台任务提交、状态轮询与结果归档
└── workflows/
    ├── pika-h3.api.json             # Pika H3 Flex 原始 ComfyUI API 节点图
    └── pika-h3.profile.json         # H3 生成参数、参考素材槽位、首帧输出和旧版存储兼容配置
```

维护工作台或技能时在 src 内修改源码，再运行构建。要把其他 API JSON 转成单文件页面，先用技能构建器检查节点，再按技能的字段映射说明配置输出和控件。

## 升级已有工作台

原版 Frameform 的草稿、素材库索引和任务历史与 HTML 的打开路径绑定。请用新构建的文件覆盖原路径上的 HTML，并继续用原浏览器与用户配置打开。旧版技能生成的工作台还需沿用既有配置的 storageKey。直接打开 dist 下的文件适合单独测试。迁移到另一条文件路径或 HTTP 地址时，浏览器可能使用独立存储。

## 回归测试

测试使用 Python 3.11+。建议在虚拟环境安装测试依赖。默认使用 Playwright Chromium，macOS 可回退到已安装的 Chrome，也可用 FRAMEFORM_TEST_CHROME 指定可执行文件。

    python3 -m venv .venv
    . .venv/bin/activate
    python -m pip install -r tests/requirements.txt
    python -m playwright install chromium
    npm test

可以用 npm test -- project_batch 只跑批量导入测试。设置 FRAMEFORM_BATCH_PROJECT 可额外预检本机的变色龙 H3 分镜目录。设置 FRAMEFORM_PREVIOUS_HTML 可让升级测试先载入原版 HTML，再在同一路径运行新版。设置 FRAMEFORM_WORKFLOW_SAMPLES 可用包含「H3官方参考生视频.json」「qwen_img2_1文生图.json」和「Pika H3 Flex 加速.json」的目录测试工作流导入。设置 FRAMEFORM_H3_TEXT_WORKFLOW 可额外用官方 H3 文生视频 API JSON 验证导入和旧记录修复。默认测试全部使用本地模拟接口。
