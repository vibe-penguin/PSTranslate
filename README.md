# Photoshop PSD 文字图层批量翻译工具

PSTranslate 在 Photoshop 桌面版中递归读取当前 PSD 的文字图层，通过 OpenAI-compatible Chat Completions API 翻译，并按 Photoshop `layerId` 精确回写。

推荐直接运行 `photoshop_translate.jsx`。它会在一次执行中完成导出、翻译和回写，后台 Python/cmd 窗口保持隐藏，并在 Photoshop 内显示全流程进度和总耗时。

## 功能

- 递归处理当前 `activeDocument` 中所有文字图层。
- 使用 Photoshop `layerId` 建立映射，不依赖图层名称或遍历顺序。
- 支持 OpenAI-compatible `/chat/completions` API。
- 默认目标语言为简体中文，可在配置中修改。
- 保护 `%s`、`%d`、`{0}`、`{name}`、换行和 HTML/XML-like 标签。
- 不对相同原文去重，也不使用翻译缓存。
- 跳过纯数字、纯符号、纯占位符和纯标签文本，不发送给 LLM。
- 一个图层失败时只跳过该图层，其他图层继续处理。
- 回写前验证 PSD 身份、`layerId` 和译文类型。
- 尽量将所有可处理文字图层设置为微软雅黑。
- 不主动写回字号、颜色、位置、宽高或对齐属性。
- 隐藏缺失字体的 Replace 对话框；找不到微软雅黑时提示并停止强制换字体。
- 普通模式成功后删除临时 JSON；Debug、Dry-run 或存在错误时保留。

## 文件说明

| 文件 | 用途 |
| --- | --- |
| `photoshop_translate.jsx` | 推荐入口，一次完成导出、翻译和回写 |
| `photoshop_export.jsx` | 手动 Debug：导出文字图层 JSON |
| `json_compat.jsx` | 缺少原生 `JSON.parse` 时使用的严格 JSON 兼容解析器 |
| `ps_text_translate.py` | 调用 LLM、校验结果、写回 JSON |
| `run_translate.bat` | 手动 Debug：在命令行运行 Python |
| `photoshop_apply.jsx` | 手动 Debug：将 JSON 结果回写 Photoshop |
| `config.example.json` | 配置模板，不包含真实 API key |
| `tests/test_ps_text_translate.py` | Python 核心逻辑回归测试 |
| `tests/test_json_compat.js` | JSON 兼容解析器开发测试 |

## 环境要求

- Windows 10 或 Windows 11
- Photoshop 桌面版，支持 JSX / ExtendScript
- Python 3.8 或更新版本
- 一个兼容 OpenAI Chat Completions 的 LLM API

Python 只使用标准库，不需要安装第三方包。可在 PowerShell 或 cmd 中确认 Python：

```bat
py -3 --version
```

如果系统没有 `py` 启动器，脚本会尝试使用 `python`。

## 安装与配置

1. 下载或克隆本项目到本地目录。
2. 将 `config.example.json` 复制为 `config.json`。
3. 编辑 `config.json`，填写 API 地址、key 和模型名。
4. 保持 `photoshop_translate.jsx`、`json_compat.jsx`、`ps_text_translate.py` 和 `config.json` 位于同一目录。

配置示例：

```json
{
  "base_url": "https://api.example.com/v1",
  "api_key": "REPLACE_WITH_YOUR_API_KEY",
  "model": "your-model-name",
  "target_language": "简体中文",
  "temperature": 0.2,
  "timeout_seconds": 60,
  "batch_size": 20,
  "batch_max_chars": 6000,
  "max_retries": 2,
  "retry_delay_seconds": 2
}
```

配置字段：

| 字段 | 说明 |
| --- | --- |
| `base_url` | API 基础地址，通常填写到 `/v1`；也可以直接填写完整 `/chat/completions` 地址 |
| `api_key` | API key；`config.json` 已被 Git 忽略 |
| `model` | 服务商提供的模型标识 |
| `target_language` | 目标语言，例如 `简体中文` |
| `temperature` | 生成随机度，翻译建议保持较低值 |
| `timeout_seconds` | 单次 HTTP 请求超时秒数 |
| `batch_size` | 单次请求最多包含的文字图层数 |
| `batch_max_chars` | 单次请求内所有受保护文本的总字符上限，不是单层上限 |
| `max_retries` | 非超时错误的额外重试次数；多图层超时会直接拆小 batch |
| `retry_delay_seconds` | 重试间隔秒数 |
| `max_tokens` | 可选，限制模型最大输出 token |

默认 `batch_size=20` 是当前实测较稳定的速度/超时平衡点。`batch_max_chars=6000` 是极端长文本的安全阀；普通图层较短时通常不会触发，也不会额外拖慢请求。

环境变量 `PST_LLM_API_KEY` 或 `OPENAI_API_KEY` 会优先覆盖配置文件中的 `api_key`，适合不希望把 key 明文写入文件的用户。

## 一键使用

1. 在 Photoshop 中打开要处理的 PSD。
2. 选择 `File > Scripts > Browse...`。
3. 选择并运行 `photoshop_translate.jsx`。
4. 等待 PSTranslate 进度窗口结束。
5. 检查结果，确认无误后手动保存 PSD。

运行期间不要关闭 PSD、切换到其他文档或增删文字图层。工具不会自动保存 PSD，因此在确认结果前可以通过 Photoshop 历史记录撤销，或直接关闭且不保存。

一键流程为每次运行生成独立的临时 JSON、进度文件和退出码文件。即使之前强制结束过 Photoshop、旧 Python 仍在后台完成任务，也不会覆盖下一次运行的数据。

## 手动 Debug 流程

需要分段定位问题时：

1. 在 Photoshop 中运行 `photoshop_export.jsx`。
2. 双击 `run_translate.bat`，或在项目目录执行：

```bat
run_translate.bat
```

3. 回到导出时的同一个 PSD，运行 `photoshop_apply.jsx`。

手动流程使用固定临时文件：

```text
%TEMP%\PSTranslate\ps_text_layers.json
```

回写前会比较导出记录中的文档路径、名称或未保存文档 ID。如果当前 PSD 不匹配，脚本会停止，不会尝试用相同或碰巧重复的 `layerId` 回写其他文档。

## Debug 与 Dry-run

命令行 Debug 模式会保留临时 JSON 并输出更详细日志：

```bat
run_translate.bat --debug
```

Dry-run 只验证 JSON、图层映射数据和占位符，不调用 LLM，也不修改 PSD：

```bat
run_translate.bat --dry-run --debug
```

一键脚本的开关位于 `photoshop_translate.jsx` 顶部：

```jsx
var DEBUG = false;
var DRY_RUN = false;
```

临时排查时可改成 `true`。正式使用建议保持 `false`。

## 翻译与回写规则

发送给模型前，Python 会保护：

- `%s`、`%d`、`%.2f` 等 printf 格式符
- `%(name)s` 这类 Python 格式符
- `{0}`、`{name}` 等占位符
- `\n`、`\r\n`、`\t` 及实际换行/制表符
- `<color=#fff>`、`</color>`、`<br/>` 等标签

每个占位符都会替换为带文本摘要的唯一 token。模型返回后，脚本要求每个 token 恰好出现一次；缺失、重复或额外 token 都会视为失败，防止格式符悄悄损坏。

批量请求采用紧凑结构，并要求模型返回：

```json
{
  "translations": {
    "123": "翻译后的文本"
  }
}
```

Python 会验证：

- 输入 JSON 中每个 `layerId` 唯一且非空。
- 模型返回的每个 ID 都属于当前 batch，且没有缺失或重复。
- `translatedText` 必须是非空字符串。
- 所有占位符数量保持一致。
- 原文无结尾标点时，保守移除模型额外添加的结尾标点。

如果当前 Photoshop 的 ExtendScript 环境没有原生 `JSON.parse`，两个回写脚本会自动加载 `json_compat.jsx`。兼容解析器只解析标准 JSON，不使用 `eval`，也不会执行 JSON 中的表达式。

若整个 batch 返回异常，脚本会重试；多图层请求超时会立即二分拆小，避免在同一个过大请求上反复等待。最终失败的图层标记为 `error`，Photoshop 会跳过且继续处理其他图层。

无需翻译的文字图层不会调用 LLM。如果 Photoshop 找到微软雅黑，这些图层仍会执行仅换字体；翻译失败或读取失败的图层会完全跳过。

## 临时文件与日志

一键流程的临时文件位于：

```text
%TEMP%\PSTranslate\
```

文件名包含运行标识。普通模式全成功后删除对应临时 JSON；以下情况会保留：

- `DEBUG=true`
- Dry-run
- 任一导出、翻译或回写错误
- Photoshop 被强制结束

日志位于项目目录：

```text
logs\ps_text_translate.log
logs\photoshop_jsx.log
```

Python 日志达到约 2 MB 后自动轮转，最多保留 3 个备份。日志不记录 API key，但会记录模型错误摘要、layerId、batch 耗时和失败原因。

## Python 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 所有需要翻译的图层成功处理 |
| `1` | 翻译流程发生未处理错误，JSON 可能未完成 |
| `2` | JSON 或配置加载失败 |
| `3` | JSON 已完成，但至少一个图层失败；成功图层仍可回写 |

一键脚本会接受退出码 `3`，继续应用成功图层并保留临时 JSON。

## 常见问题

### 进度长时间停在某个 batch

先查看 `logs\ps_text_translate.log`。大 batch 超时后会自动拆分，因此一次超时不代表程序宕机。若单层也持续超时，可适当增加 `timeout_seconds`，或检查 API 服务状态。

### HTTP 401 / 403

检查 API key、模型权限和 `base_url`。如果设置了环境变量，它会覆盖 `config.json` 中的 key。

### HTTP 429

API 服务触发限流。保持顺序 batch，稍后重试，或增加 `retry_delay_seconds`。本工具默认不使用并发。

### 找不到微软雅黑

Photoshop 会弹窗提示。译文仍会回写，但脚本不会强行指定不存在的字体。请在 Windows/Photoshop 中安装并启用 Microsoft YaHei 后重试。

### 某些图层没有修改

查看最终统计和临时 JSON 中的 `status` / `error`。常见原因包括导出失败、模型返回不合法、占位符损坏、图层被删除、图层锁定或字体设置失败。

### 缺失字体弹出 Replace 对话框

当前脚本在修改内容前先设置微软雅黑，并临时使用 `DialogModes.NO`。如果仍出现对话框，请保留临时 JSON 和 `photoshop_jsx.log` 以便定位对应 Photoshop 版本或特殊文字图层。

## 测试

运行 Python 回归测试：

```bat
python -m unittest discover -s tests -v
```

测试不调用真实 LLM API，也不需要 Photoshop。Photoshop JSX 的最终行为仍应使用测试 PSD 在目标 Photoshop 版本中验证。

开发环境安装了 Node.js 时，还可以验证 JSON 兼容解析器：

```bat
node tests\test_json_compat.js
```

Node.js 仅用于这项开发测试，不是 PSTranslate 的运行依赖。

## 隐私与安全

- PSD 文件本身不会上传；只有文字图层内容、临时保护 token 和 `layerId` 会发送到配置的 API。
- `config.json`、日志、测试 PSD 和 `archive/` 默认被 Git 忽略。
- 不要把包含真实 API key 的配置或日志发送给不受信任的人。
- 使用第三方模型服务时，请按其隐私政策处理未公开文本。

## License

MIT，详见 `LICENSE`。
