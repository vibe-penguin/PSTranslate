# Photoshop PSD 文字图层批量翻译工具

这个工具默认用一键脚本完成 Photoshop 文字图层翻译：

1. `photoshop_translate.jsx` 从当前 `activeDocument` 递归导出文字图层到临时 JSON。
2. `photoshop_translate.jsx` 自动调用 `ps_text_translate.py`，由 Python 调用 OpenAI-compatible Chat Completions API，把 `originalText` 翻译成目标语言并写回同一个 JSON。
3. `photoshop_translate.jsx` 按 `layerId` 找回文字图层，替换为 `translatedText`，并尽量把字体设置为微软雅黑。

也保留三个拆分脚本，方便排查问题：

1. `photoshop_export.jsx` 从当前 `activeDocument` 递归导出文字图层到临时 JSON。
2. `ps_text_translate.py` 调用 OpenAI-compatible Chat Completions API，把 `originalText` 翻译成目标语言并写回同一个 JSON。
3. `photoshop_apply.jsx` 按 `layerId` 找回文字图层，替换为 `translatedText`，并尽量把字体设置为微软雅黑。

默认临时文件位置：

```text
%TEMP%\PSTranslate\ps_text_layers.json
```

日志文件：

```text
logs\ps_text_translate.log
logs\photoshop_jsx.log
```

## 环境

- Windows 10 / Windows 11
- Photoshop 桌面版
- Python 3.8 或更新版本
- 一个兼容 OpenAI Chat Completions 的 LLM API

Python 只使用标准库，不需要安装第三方包。

## 配置

编辑 `config.json`：

```json
{
  "base_url": "https://api.example.com/v1",
  "api_key": "REPLACE_WITH_YOUR_API_KEY",
  "model": "your-model-name",
  "target_language": "简体中文",
  "temperature": 0.2,
  "timeout_seconds": 60,
  "batch_size": 40,
  "batch_max_chars": 12000,
  "max_retries": 2,
  "retry_delay_seconds": 2
}
```

`base_url` 填到 `/v1` 这一层即可，脚本会自动拼接 `/chat/completions`。如果不想把 key 写入文件，也可以把环境变量 `PST_LLM_API_KEY` 或 `OPENAI_API_KEY` 设为 API key。

`batch_size` 控制每次请求最多翻译多少个文字图层，`batch_max_chars` 控制单次请求里受保护文本的总字符数上限。默认值会尽量让常见 PSD 合并为更少请求，减少 API 往返。脚本不会对相同 `originalText` 去重，也不会使用翻译缓存；每个文字图层仍然会以自己的 `layerId` 独立进入批量请求。

## 一键使用步骤

1. 在 Photoshop 中打开要处理的 PSD。
2. 选择 `File > Scripts > Browse...`，运行 `photoshop_translate.jsx`。
3. 等待 Photoshop 内的 PSTranslate 进度窗口完成翻译。
4. 检查 PSD，确认无误后手动保存。

一键脚本会隐藏后台 Python/命令行执行窗口，并在 Photoshop 里显示覆盖导出、翻译、回写的全流程进度条、已处理图层数和预计剩余时间。Python 翻译阶段会根据真实进度和等待时间做平滑推进，第一批请求完成前预计时间可能显示为 `calculating`。

## 手动 Debug 步骤

如果一键脚本失败，或需要分段排查，可以继续使用旧的三步流程：

1. 在 Photoshop 中打开要处理的 PSD。
2. 选择 `File > Scripts > Browse...`，运行 `photoshop_export.jsx`。
3. 双击 `run_translate.bat`，或在命令行运行：

```bat
run_translate.bat
```

4. 回到 Photoshop，再次选择 `File > Scripts > Browse...`，运行 `photoshop_apply.jsx`。
5. 检查 PSD，确认无误后手动保存。

手动 Debug 流程中的 `run_translate.bat` 会按普通命令行方式运行，可能显示 cmd 窗口；无窗口运行只用于 `photoshop_translate.jsx` 一键流程。

## Debug 和 Dry-run

命令行 Debug 模式会保留临时 JSON，方便排查：

```bat
run_translate.bat --debug
```

Dry-run 模式只检查 JSON 和占位符保护，不调用 LLM，也不会修改 PSD：

```bat
run_translate.bat --dry-run --debug
```

一键脚本里的 `DEBUG` 和 `DRY_RUN` 默认是 `false`。需要临时调试时，可以打开 `photoshop_translate.jsx` 顶部修改：

```jsx
var DEBUG = true;
var DRY_RUN = true;
```

## 占位符保护

Python 会在发送给 LLM 前保护这些内容，并在返回后恢复：

- `%s`、`%d`、`%.2f` 等 printf 格式符
- `{0}`、`{name}` 这类占位符
- `\n`、`\t` 以及实际换行
- `<color=#fff>`、`</color>`、`<br/>` 等 HTML/XML-like 标签

如果模型返回时丢失了保护 token，该图层会重试；重试后仍失败则标记为 `error`，Photoshop 回写时会跳过该图层，不会中断整个 PSD。

纯数字、纯符号、只有占位符/换行/HTML-like 标签的文字图层会在 Python 阶段直接跳过，不发送给 LLM。

## 批量翻译

Python 会把多个文字图层合并到同一次 Chat Completions 请求中，并要求模型返回：

```json
{
  "translations": {
    "123": "翻译后的文本"
  }
}
```

回写仍然只按 `layerId` 匹配，不依赖返回顺序。Python 会使用紧凑的输入和输出 JSON，减少 prompt/response token。若某个批次返回格式不正确、缺少 `layerId` 或占位符丢失，脚本会先重试；仍失败时会自动把该批次拆成更小批次，最后只跳过失败图层。

## 重要说明

- 图层匹配使用 Photoshop `layerId`，不依赖图层名称或遍历顺序。
- 工具不会导出 txt，也不会按画面位置排序。
- 明显不需要翻译的图层会跳过，例如纯数字、纯符号、只有占位符或标签的文本。
- 回写时只设置文字内容和字体，不主动修改字号、颜色、位置或对齐方式。
- 如果原文字图层使用的字体缺失，脚本会先切换到可用字体并抑制 Photoshop 的 Replace 确认框，避免批量流程中断。
- 如果 Photoshop 找不到微软雅黑，会弹窗提示，并继续替换文字但不强行替换字体。
- 普通模式下，一键流程全成功后会删除临时 JSON；`--debug`、`--dry-run` 或任一图层失败时会保留 JSON。
- 建议在处理前备份 PSD，或在确认结果后再保存。
