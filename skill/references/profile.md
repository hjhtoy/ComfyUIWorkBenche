# 工作流字段映射

配置是临时构建输入。字段地址统一形如 `["138", "value"]`，第一项是 JSON 节点 ID，第二项是 `inputs` 的精确键名。点号键保持原样。连接形如 `["122", 0]`，第二项是输出索引。以下示例 ID 只对应示例工作流。

## 必选

| 配置 | 值和验证方式 |
| --- | --- |
| `outputs` | 用于识别该工作流的保存型输出节点 ID 数组。选真正写出结果的节点，例如 `SaveImage`、`SaveVideo` 或 `VHS_VideoCombine`。如果工作流有额外的预览分支，选择能明确标识主输出的分支。 |

## 可选

| 配置 | 形状 |
| --- | --- |
| `prompt` | 正向提示词的字符串字段。若编码节点的输入来自上游字符串节点，映射上游字段。保留负向提示词和其他分支。仅接收输入图的工作流可省略。 |
| `title` | 页面上显示的工作流名称。缺省为源文件名。 |
| `seed` | 明确可随机化的整数字段。缺省保留工作流种子。 |
| `size` | `{mode:"preset", width:[id,key], height:[id,key], presets:[[w,h],...]}` 用于直接尺寸字段，原尺寸自动加入。或 `{mode:"selector", ratio:[id,key], megapixels:[id,key], multiple:32, ratios:{"16:9":"节点接受的完整字面值"}, megapixelsOptions:[...]}` 用于按兆像素和对齐倍数计算宽高的 `ResolutionSelector`。仅填写当前节点或模型支持的尺寸。可用 `commonMegapixels` 将常用值放入菜单的常用尺寸组。 |
| `steps` | `{mode:"integer", field:[id,key], min:1, max:30}` 映射整数步数。已验证支持的加速工作流可用 `mode:"sigmas"`，只在改步数后按原序列分段线性重采样。区间需包含原步数。可指定 `increment`。 |
| `duration` | `{field:[id,key], min:1, max:30}` 映射以秒为单位的数值。可设 `increment`。若已有帧对齐公式是向上对齐至 `base + period × k`，可加 `alignment:{base:5,period:17}` 和顶层 `fps` 以显示预计实际时长。其余规则单独适配。 |
| `fps` | 工作流的真实输出帧率。不要把展示值写回工作流。 |
| 直接帧数输入 | 当 `duration.field` 连接以帧为单位的长度时，可使用 `duration.unit="frames"` 和顶层 `fps`。`min`、`max`、`increment` 按帧填写并保留工作流原值。H3 使用从 5 帧起、每档 17 帧的序列。界面同时显示帧数及折算时长，分镜 TXT 仍按秒解析。 |
| `references` | 按用户所需选择顺序排列 `{kind:"image", file:[加载器ID,文件字段], targets:[[消费节点ID,连接字段],...], required:true}`。`kind` 可选 `image`、`video` 或 `audio`，旧配置缺省为图片。允许省略的动态槽可将 `required` 设为 false。遗漏可选参考图时仅解除对应连接及删去不再被引用的指定加载器。其他固定图像节点保持原状。 |
| `referenceTag` | 向后兼容的图片标签名，例如 `Picture`。 |
| `referenceTags` | 仅设置模型支持的类型标签，例如 `{"image":"Picture","video":"Video","audio":"Audio"}`。同类型各自从 1 开始编号。没有标签约定的类型只绑定文件节点。 |
| `h3ReferenceNode` | 已确认连接到生成路径的 `MiniMaxH3ReferenceToVideo` 节点 ID。为未显式映射的视频、音频类型启用 H3 点号槽位，最多各 3 项。使用前确认服务端有 Video Helper Suite 的 `VHS_LoadVideo` 和 ComfyUI 的 `LoadAudio`。视频以 24 fps 读取画面帧，音频通过 `LoadAudio` 单独绑定，所以嵌入声轨不会占用音频标签序号。 |
| `firstFrame` | 可选的已确认 IMAGE 帧批连接，如 `["122",0]`。构建后的工作流会动态分配节点 ID，额外保存第一帧 PNG。直接返回 VIDEO 对象的分支需自定义提帧方式，或沿用服务器返回的预览。 |
| `firstFrameIds`、`firstFramePrefix` | 可选。用于兼容旧项目指定的两个首帧节点 ID 和输出路径前缀。节点 ID 必须未被使用。 |
| `sampler`、`stages` | 采样节点 ID 和可选的 `{节点ID:中文阶段名}`，用于细化 WebSocket 进度。 |
| `matchIgnore` | 识别同工作流时排除比较的可变字段，如输出名前缀。配置中已暴露的字段自动忽略其值。保留对模型、核心连接和其他固定字段的比较。 |
| `storageKey` | 可选的短工作流标识。构建器缺省从图和配置派生。为同一工作台发布兼容更新时，复用既有标识与 HTML 路径，便于读取旧草稿。 |
| `advanced` | 可选节点字段列表，每项使用 `{field:[id,key],kind:"number",min:0,max:1,step:0.01}` 等形式。支持 text、boolean、integer、number 和带 options 的 enum。字段必须指向工作流中已有的字面输入。选中种子时，高级参数以节点原值为初始种子，可分别为手动和批量任务修改。 |

## 兼容已有 Frameform

项目随附的 H3 配置启用 `legacyFrameform`，用原版路径和存储键恢复浏览器草稿、任务记录和素材。它只用于升级原版独立 Frameform 页面。已有技能生成的工作台继续使用原来的 `storageKey`。

## 示例

典型文生图工作流的配置如下。实际尺寸、步数区间和节点地址从用户输入确认。

```json
{
  "title": "文生图",
  "prompt": ["6", "text"],
  "outputs": ["9"],
  "size": {"mode":"preset", "width":["5","width"], "height":["5","height"], "presets":[[768,512],[512,768]]},
  "steps": {"mode":"integer", "field":["3","steps"], "min":1, "max":40},
  "seed": ["3","seed"],
  "sampler": "3",
  "matchIgnore": [["9","filename_prefix"]]
}
```

此前的 Pika H3 Flex 工作流使用 `PrimitiveStringMultiline.value`（138）、`PrimitiveFloat.value`（132）、`ResolutionSelector`（115）及 `ManualSigmas.sigmas`（147）。图像链接位于 136 的 `ref_images.ref_image_0` 至 `ref_images.ref_image_8`，应读取实际连线取得各加载器 ID。输出为 152，视频解码 IMAGE 批在 122 的输出 0。时长表达式按 24 fps 转帧并向上对齐到 `5 + 17 × k`。仅在新 JSON 仍具有这些节点和表达式时沿用该映射。

若遇到多个正向提示词、非标准音视频适配链或特殊上传与输出协议，复制模板适配器到本次工作目录进行有针对性的扩展。保留工作流默认字面值，避免照搬旧模型的选项。
