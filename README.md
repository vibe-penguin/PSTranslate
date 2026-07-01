# Photoshop PSD 文字图层批量翻译工具

这个工具把 Photoshop 文字图层翻译流程拆成三步：

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
  "max_retries": 2,
  "retry_delay_seconds": 2
}
```

`base_url` 填到 `/v1` 这一层即可，脚本会自动拼接 `/chat/completions`。如果不想把 key 写入文件，也可以把环境变量 `PST_LLM_API_KEY` 或 `OPENAI_API_KEY` 设为 API key。

## 使用步骤

1. 在 Photoshop 中打开要处理的 PSD。
2. 选择 `File > Scripts > Browse...`，运行 `photoshop_export.jsx`。
3. 双击 `run_translate.bat`，或在命令行运行：

```bat
run_translate.bat
```

4. 回到 Photoshop，再次选择 `File > Scripts > Browse...`，运行 `photoshop_apply.jsx`。
5. 检查 PSD，确认无误后手动保存。

## Debug 和 Dry-run

Debug 模式会保留临时 JSON，方便排查：

```bat
run_translate.bat --debug
```

Dry-run 模式只检查 JSON 和占位符保护，不调用 LLM，也不会修改 PSD：

```bat
run_translate.bat --dry-run --debug
```

## 占位符保护

Python 会在发送给 LLM 前保护这些内容，并在返回后恢复：

- `%s`、`%d`、`%.2f` 等 printf 格式符
- `{0}`、`{name}` 这类占位符
- `\n`、`\t` 以及实际换行
- `<color=#fff>`、`</color>`、`<br/>` 等 HTML/XML-like 标签

如果模型返回时丢失了保护 token，该图层会重试；重试后仍失败则标记为 `error`，Photoshop 回写时会跳过该图层，不会中断整个 PSD。

## 重要说明

- 图层匹配使用 Photoshop `layerId`，不依赖图层名称或遍历顺序。
- 工具不会导出 txt，也不会按画面位置排序。
- 回写时只设置文字内容和字体，不主动修改字号、颜色、位置或对齐方式。
- 如果 Photoshop 找不到微软雅黑，会弹窗提示，并继续替换文字但不强行替换字体。
- 普通模式下，`photoshop_apply.jsx` 完成后会删除临时 JSON；`--debug` 或 `--dry-run` 会保留 JSON。
- 建议在处理前备份 PSD，或在确认结果后再保存。
