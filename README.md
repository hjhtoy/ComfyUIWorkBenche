# Frameform · ComfyUI 视频工作台

用浏览器连接自托管 ComfyUI。开发版本使用原生 JavaScript ES Modules，发布版把程序、样式、图标和工作流内嵌在一个 HTML 文件里。

## 构建

需要 Node.js 20+、npm 和 Python 3.10+。首次安装依赖后，运行构建命令即可从项目内的工作流生成页面与技能包。

    npm ci
    npm run build

- **dist/Frameform.html** 是 Pika H3 Flex 工作台。打开文件后可测试 ComfyUI 服务器地址。
- **dist/comfyui-api-workbench.zip** 是独立技能包。解压后的 **scripts/workbench.py** 支持 inspect 和 build，生成其他工作流时只需 Python。
- 如果浏览器提示跨域，请按页面内的连接帮助配置 ComfyUI。远端服务仍需安装工作流使用的模型和节点。

## 项目结构

| 目录 | 职责 |
| --- | --- |
| src/ui | 页面、主题、提示词编辑器、参数与服务器设置 |
| src/comfy | HTTP API、工作流字段映射、输入素材槽位与工作流匹配 |
| src/jobs | 提交、进度、取消、历史恢复、队列和播放器 |
| src/batch | 分镜 TXT 和素材目录预检、批量入队 |
| src/media | 素材类型、预览缓存、下载和 ZIP |
| src/storage | 草稿与任务涉及的浏览器存储读写 |
| workflows | 原始 Pika H3 API 图和对应的参数配置 |
| scripts / skill | 构建器、技能说明和打包逻辑。项目与技能使用同一套运行代码 |
| tests | 模拟 ComfyUI 的浏览器回归测试、旧版存储升级和技能包验证 |

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

可以用 npm test -- project_batch 只跑批量导入测试。设置 FRAMEFORM_BATCH_PROJECT 可额外预检本机的变色龙 H3 分镜目录。设置 FRAMEFORM_PREVIOUS_HTML 可让升级测试先载入原版 HTML，再在同一路径运行新版。默认测试全部使用本地模拟接口。
