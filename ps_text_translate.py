#!/usr/bin/env python3
"""Translate Photoshop text-layer JSON with an OpenAI-compatible chat API."""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Match, Optional, Tuple


DEFAULT_JSON_PATH = Path(tempfile.gettempdir()) / "PSTranslate" / "ps_text_layers.json"
SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG_PATH = SCRIPT_DIR / "config.json"


PLACEHOLDER_RE = re.compile(
    r"(<[^<>\r\n]+>)"
    r"|(\\r\\n|\\n|\\r|\\t)"
    r"|(\r\n|\n|\r|\t)"
    r"|(%%|%(?:\d+\$)?[-+#0 ]*(?:\*|\d+)?(?:\.(?:\*|\d+))?[hlL]?[diuoxXfFeEgGcs])"
    r"|(%\([A-Za-z_][A-Za-z0-9_]*\)[-+#0 ]*(?:\*|\d+)?(?:\.(?:\*|\d+))?[hlL]?[diuoxXfFeEgGcs])"
    r"|(\{(?:\d+|[A-Za-z_][A-Za-z0-9_]*)\})"
)


class TranslationError(RuntimeError):
    """Raised when one layer cannot be translated safely."""


class ProgressReporter:
    def __init__(self, path: Optional[Path], total: int) -> None:
        self.path = path
        self.total = max(0, total)
        self.current = 0
        self.started = time.time()
        if self.path:
            self.path.parent.mkdir(parents=True, exist_ok=True)

    def write(self, stage: str, message: str, done: bool = False) -> None:
        if not self.path:
            return

        elapsed = max(0.0, time.time() - self.started)
        percent = 100.0 if self.total <= 0 else min(100.0, (self.current / float(self.total)) * 100.0)
        eta: Optional[float] = None
        if self.current > 0 and self.total > self.current and not done:
            eta = (elapsed / float(self.current)) * float(self.total - self.current)
        elif done:
            eta = 0.0

        payload = {
            "stage": stage,
            "message": message,
            "current": self.current,
            "total": self.total,
            "percent": round(percent, 2),
            "elapsedSeconds": round(elapsed, 1),
            "etaSeconds": None if eta is None else round(eta, 1),
            "done": bool(done),
            "updatedAt": utc_now(),
        }

        temp_path = self.path.with_suffix(self.path.suffix + ".tmp")
        with temp_path.open("w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(temp_path, self.path)

    def advance(self, count: int, stage: str, message: str) -> None:
        self.current = min(self.total, self.current + max(0, count))
        self.write(stage, message)


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def setup_logging(debug: bool) -> Path:
    log_dir = SCRIPT_DIR / "logs"
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        log_dir = Path(tempfile.gettempdir()) / "PSTranslate"
        log_dir.mkdir(parents=True, exist_ok=True)

    log_path = log_dir / "ps_text_translate.log"
    level = logging.DEBUG if debug else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[
            logging.FileHandler(log_path, encoding="utf-8"),
            logging.StreamHandler(sys.stdout),
        ],
    )
    return log_path


def load_json(path: Path) -> Dict[str, Any]:
    with path.open("r", encoding="utf-8-sig") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError("Top-level JSON must be an object.")
    if "layers" not in data or not isinstance(data["layers"], list):
        raise ValueError("JSON must contain a layers array.")
    return data


def save_json(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    with temp_path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(temp_path, path)


def load_config(path: Path) -> Dict[str, Any]:
    with path.open("r", encoding="utf-8-sig") as f:
        config = json.load(f)
    required = ["base_url", "api_key", "model", "target_language"]
    missing = [key for key in required if not str(config.get(key, "")).strip()]
    env_key = os.environ.get("PST_LLM_API_KEY") or os.environ.get("OPENAI_API_KEY")
    if "api_key" in missing and env_key:
        config["api_key"] = env_key
        missing.remove("api_key")
    if missing:
        raise ValueError("Missing config value(s): " + ", ".join(missing))
    return config


def normalize_chat_url(base_url: str) -> str:
    base = base_url.strip().rstrip("/")
    if base.endswith("/chat/completions"):
        return base
    return base + "/chat/completions"


def protect_placeholders(text: str) -> Tuple[str, Dict[str, str]]:
    placeholders: Dict[str, str] = {}

    def replace(match: Match[str]) -> str:
        token = "[[PST_PH_%03d]]" % len(placeholders)
        placeholders[token] = match.group(0)
        return token

    return PLACEHOLDER_RE.sub(replace, text), placeholders


def restore_placeholders(text: str, placeholders: Dict[str, str]) -> str:
    restored = text
    for token, value in placeholders.items():
        restored = restored.replace(token, value)
    return restored


def validate_placeholders(text: str, placeholders: Dict[str, str]) -> None:
    missing = [token for token in placeholders if token not in text]
    if missing:
        raise TranslationError("Missing protected token(s): " + ", ".join(missing[:5]))


def content_to_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: List[str] = []
        for item in content:
            if isinstance(item, dict):
                parts.append(str(item.get("text", "")))
            else:
                parts.append(str(item))
        return "".join(parts)
    return str(content)


def call_chat_completion(config: Dict[str, Any], messages: List[Dict[str, str]]) -> str:
    url = normalize_chat_url(str(config["base_url"]))
    timeout = int(config.get("timeout_seconds", 60))
    payload = {
        "model": config["model"],
        "messages": messages,
        "temperature": float(config.get("temperature", 0.2)),
    }
    if "max_tokens" in config:
        payload["max_tokens"] = int(config["max_tokens"])

    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={
            "Authorization": "Bearer " + str(config["api_key"]),
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            response_body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace")
        raise TranslationError("HTTP %s: %s" % (exc.code, error_body[:1000])) from exc
    except urllib.error.URLError as exc:
        raise TranslationError("Network error: %s" % exc) from exc

    try:
        data = json.loads(response_body)
        return content_to_text(data["choices"][0]["message"]["content"])
    except (KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
        raise TranslationError("Unexpected API response: " + response_body[:1000]) from exc


def extract_json_object(text: str) -> Dict[str, Any]:
    cleaned = text.strip()
    fence = re.match(r"^```(?:json)?\s*(.*?)\s*```$", cleaned, flags=re.IGNORECASE | re.DOTALL)
    if fence:
        cleaned = fence.group(1).strip()

    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start < 0 or end < start:
        raise TranslationError("Model did not return a JSON object: " + text[:300])

    try:
        data = json.loads(cleaned[start : end + 1])
    except json.JSONDecodeError as exc:
        raise TranslationError("Could not parse model JSON: " + text[:300]) from exc
    if not isinstance(data, dict):
        raise TranslationError("Model JSON response must be an object.")
    return data


def build_batch_messages(items: List[Dict[str, Any]], target_language: str) -> List[Dict[str, str]]:
    system_prompt = (
        "You are a careful translation engine for Photoshop text layers. "
        "Translate every input item to the requested target language. "
        "Keep every protected token such as [[PST_PH_000]] exactly unchanged. "
        "Return exactly one translation for every input item. "
        "Do not deduplicate repeated text. "
        "Preserve each layerId exactly. "
        "Do not add explanations, Markdown, or extra fields. Return strict JSON only."
    )
    user_payload = {
        "targetLanguage": target_language,
        "items": [
            {"layerId": item["layer_id"], "text": item["protected_text"]}
            for item in items
        ],
        "returnSchema": {
            "translations": [
                {"layerId": "same layerId from input item", "translatedText": "string"}
            ]
        },
    }
    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
    ]


def parse_batch_response(raw: str, items: List[Dict[str, Any]]) -> Dict[str, str]:
    model_data = extract_json_object(raw)
    translations = model_data.get("translations")
    if not isinstance(translations, list):
        raise TranslationError("Model JSON must contain a translations array.")

    expected = {item["layer_id"]: item for item in items}
    results: Dict[str, str] = {}

    for entry in translations:
        if not isinstance(entry, dict):
            raise TranslationError("Each translation entry must be an object.")

        layer_id = str(entry.get("layerId", ""))
        if layer_id not in expected:
            raise TranslationError("Unexpected layerId in model response: %s" % layer_id)
        if layer_id in results:
            raise TranslationError("Duplicate layerId in model response: %s" % layer_id)

        translated = str(entry.get("translatedText", ""))
        placeholders = expected[layer_id]["placeholders"]
        validate_placeholders(translated, placeholders)
        results[layer_id] = restore_placeholders(translated, placeholders)

    missing = [layer_id for layer_id in expected if layer_id not in results]
    if missing:
        raise TranslationError("Missing layerId(s) in model response: " + ", ".join(missing[:10]))

    return results


def translate_batch_once(items: List[Dict[str, Any]], config: Dict[str, Any]) -> Dict[str, str]:
    target_language = str(config["target_language"])
    messages = build_batch_messages(items, target_language)
    raw = call_chat_completion(config, messages)
    return parse_batch_response(raw, items)


def translate_batch_with_retries(
    items: List[Dict[str, Any]],
    config: Dict[str, Any],
    retries: int,
    retry_delay: float,
) -> Dict[str, str]:
    layer_ids = [item["layer_id"] for item in items]
    last_error: Optional[Exception] = None

    for attempt in range(retries + 1):
        try:
            return translate_batch_once(items, config)
        except Exception as exc:
            last_error = exc
            logging.warning(
                "Batch [%s] translation attempt %s/%s failed: %s",
                ", ".join(layer_ids),
                attempt + 1,
                retries + 1,
                exc,
            )
            if attempt < retries:
                time.sleep(retry_delay)

    raise TranslationError(str(last_error))


def translate_batch_resilient(
    items: List[Dict[str, Any]],
    config: Dict[str, Any],
    retries: int,
    retry_delay: float,
) -> Tuple[Dict[str, str], Dict[str, str]]:
    try:
        return translate_batch_with_retries(items, config, retries, retry_delay), {}
    except Exception as exc:
        if len(items) == 1:
            return {}, {items[0]["layer_id"]: str(exc)}

        midpoint = max(1, len(items) // 2)
        logging.warning(
            "Batch [%s] failed after retries; splitting into %s and %s item(s).",
            ", ".join(item["layer_id"] for item in items),
            midpoint,
            len(items) - midpoint,
        )
        left_results, left_errors = translate_batch_resilient(items[:midpoint], config, retries, retry_delay)
        right_results, right_errors = translate_batch_resilient(items[midpoint:], config, retries, retry_delay)
        left_results.update(right_results)
        left_errors.update(right_errors)
        return left_results, left_errors


def iter_layers(payload: Dict[str, Any]) -> Iterable[Dict[str, Any]]:
    for item in payload.get("layers", []):
        if isinstance(item, dict):
            yield item


def positive_int(config: Dict[str, Any], key: str, default: int) -> int:
    try:
        value = int(config.get(key, default))
    except (TypeError, ValueError):
        value = default
    return max(1, value)


def prepare_translation_item(layer: Dict[str, Any]) -> Dict[str, Any]:
    original_text = str(layer.get("originalText", ""))
    protected_text, placeholders = protect_placeholders(original_text)
    return {
        "layer": layer,
        "layer_id": str(layer.get("layerId", "")),
        "protected_text": protected_text,
        "placeholders": placeholders,
        "char_count": len(protected_text),
    }


def build_batches(items: List[Dict[str, Any]], batch_size: int, batch_max_chars: int) -> List[List[Dict[str, Any]]]:
    batches: List[List[Dict[str, Any]]] = []
    current: List[Dict[str, Any]] = []
    current_chars = 0

    for item in items:
        item_chars = max(1, int(item.get("char_count", 0)))
        should_flush = bool(current) and (
            len(current) >= batch_size or current_chars + item_chars > batch_max_chars
        )
        if should_flush:
            batches.append(current)
            current = []
            current_chars = 0

        current.append(item)
        current_chars += item_chars

    if current:
        batches.append(current)

    return batches


def translate_payload(
    payload: Dict[str, Any],
    config: Dict[str, Any],
    dry_run: bool,
    progress: Optional[ProgressReporter] = None,
) -> Dict[str, int]:
    retries = int(config.get("max_retries", 2))
    retry_delay = float(config.get("retry_delay_seconds", 2))
    batch_size = positive_int(config, "batch_size", 20)
    batch_max_chars = positive_int(config, "batch_max_chars", 6000)
    counts = {"translated": 0, "skipped": 0, "failed": 0}
    pending_items: List[Dict[str, Any]] = []

    if progress:
        progress.write("preparing", "Preparing text layers for translation.")

    for layer in iter_layers(payload):
        layer_id = str(layer.get("layerId", ""))
        original_text = str(layer.get("originalText", ""))

        if not original_text:
            layer["translatedText"] = ""
            layer["status"] = "skipped"
            layer["error"] = "Empty text layer."
            counts["skipped"] += 1
            if progress:
                progress.advance(1, "preparing", "Skipped empty layer %s." % layer_id)
            continue

        if dry_run:
            protected_text, placeholders = protect_placeholders(original_text)
            validate_placeholders(protected_text, placeholders)
            layer["translatedText"] = original_text
            layer["status"] = "dry-run"
            layer["error"] = ""
            counts["skipped"] += 1
            logging.info("Dry-run checked layer %s (%s placeholder(s)).", layer_id, len(placeholders))
            if progress:
                progress.advance(1, "dry-run", "Dry-run checked layer %s." % layer_id)
            continue

        pending_items.append(prepare_translation_item(layer))

    if dry_run or not pending_items:
        if progress:
            progress.write("complete", "No translation requests were needed.", done=True)
        return counts

    batches = build_batches(pending_items, batch_size, batch_max_chars)
    logging.info(
        "Translating %s text layer(s) in %s batch(es). batch_size=%s, batch_max_chars=%s. "
        "Deduplication and cache are disabled.",
        len(pending_items),
        len(batches),
        batch_size,
        batch_max_chars,
    )

    if progress:
        progress.write(
            "translating",
            "Translating %s text layer(s) in %s batch(es)." % (len(pending_items), len(batches)),
        )

    for index, batch in enumerate(batches, start=1):
        batch_message = "Translating batch %s/%s (%s layer(s))." % (index, len(batches), len(batch))
        if progress:
            progress.write("translating", batch_message)
        logging.info(
            "Translating batch %s/%s with %s layer(s): %s",
            index,
            len(batches),
            len(batch),
            ", ".join(item["layer_id"] for item in batch),
        )

        translations, errors = translate_batch_resilient(batch, config, retries, retry_delay)

        for item in batch:
            layer = item["layer"]
            layer_id = item["layer_id"]
            if layer_id in translations:
                layer["translatedText"] = translations[layer_id]
                layer["status"] = "translated"
                layer["error"] = ""
                counts["translated"] += 1
                logging.info("Translated layer %s.", layer_id)
                if progress:
                    progress.advance(1, "translating", "Translated layer %s." % layer_id)
            else:
                layer["translatedText"] = ""
                layer["status"] = "error"
                layer["error"] = errors.get(layer_id, "Batch translation failed.")
                counts["failed"] += 1
                logging.error("Layer %s failed and will be skipped: %s", layer_id, layer["error"])
                if progress:
                    progress.advance(1, "translating", "Layer %s failed and will be skipped." % layer_id)

    if progress:
        progress.write("complete", "Translation complete.", done=True)

    return counts


def parse_args(argv: List[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Translate Photoshop text-layer JSON.")
    parser.add_argument("--json", default=str(DEFAULT_JSON_PATH), help="Path to the temp JSON exported by Photoshop.")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG_PATH), help="Path to config.json.")
    parser.add_argument("--progress", default="", help="Optional path to a progress JSON file for Photoshop UI polling.")
    parser.add_argument("--dry-run", action="store_true", help="Validate JSON and placeholder protection without calling the LLM.")
    parser.add_argument("--debug", action="store_true", help="Enable verbose logs and keep the temp JSON during Photoshop apply.")
    return parser.parse_args(argv)


def main(argv: List[str]) -> int:
    args = parse_args(argv)
    log_path = setup_logging(args.debug)
    json_path = Path(args.json).expanduser().resolve()
    config_path = Path(args.config).expanduser().resolve()
    progress_path = Path(args.progress).expanduser().resolve() if args.progress else None

    logging.info("Log file: %s", log_path)
    logging.info("JSON file: %s", json_path)
    logging.info("Config file: %s", config_path)
    if progress_path:
        logging.info("Progress file: %s", progress_path)

    try:
        payload = load_json(json_path)
        config = load_config(config_path)
    except Exception as exc:
        logging.error("Startup failed: %s", exc)
        return 2

    meta = payload.get("meta")
    if not isinstance(meta, dict):
        meta = {}
        payload["meta"] = meta
    meta["translatedAt"] = utc_now()
    meta["debug"] = bool(args.debug)
    meta["dryRun"] = bool(args.dry_run)
    meta["targetLanguage"] = config.get("target_language", "")
    meta["model"] = config.get("model", "")
    meta["batchSize"] = positive_int(config, "batch_size", 20)
    meta["batchMaxChars"] = positive_int(config, "batch_max_chars", 6000)
    meta["deduplication"] = False
    meta["cache"] = False
    progress = ProgressReporter(progress_path, len(payload.get("layers", [])))
    progress.write("starting", "Starting translation.")

    try:
        counts = translate_payload(payload, config, args.dry_run, progress)
        meta["translationSummary"] = counts
        save_json(json_path, payload)
    except Exception as exc:
        logging.exception("Translation run failed before JSON could be saved: %s", exc)
        progress.write("error", str(exc), done=True)
        return 1

    progress.write("complete", "Translation JSON updated.", done=True)
    logging.info(
        "Finished. translated=%s skipped=%s failed=%s",
        counts["translated"],
        counts["skipped"],
        counts["failed"],
    )
    return 0 if counts["failed"] == 0 else 3


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
