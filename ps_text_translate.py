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


def build_messages(layer_id: str, protected_text: str, target_language: str) -> List[Dict[str, str]]:
    system_prompt = (
        "You are a careful translation engine for Photoshop text layers. "
        "Translate the user's text to the requested target language. "
        "Keep every protected token such as [[PST_PH_000]] exactly unchanged. "
        "Do not add explanations, Markdown, or extra fields. Return strict JSON only."
    )
    user_payload = {
        "layerId": layer_id,
        "targetLanguage": target_language,
        "text": protected_text,
        "returnSchema": {"layerId": layer_id, "translatedText": "string"},
    }
    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
    ]


def translate_one(layer: Dict[str, Any], config: Dict[str, Any], retries: int, retry_delay: float) -> str:
    layer_id = str(layer.get("layerId", ""))
    original_text = str(layer.get("originalText", ""))
    target_language = str(config["target_language"])
    protected_text, placeholders = protect_placeholders(original_text)
    messages = build_messages(layer_id, protected_text, target_language)
    last_error: Optional[Exception] = None

    for attempt in range(retries + 1):
        try:
            raw = call_chat_completion(config, messages)
            model_data = extract_json_object(raw)
            returned_id = str(model_data.get("layerId", ""))
            if returned_id != layer_id:
                raise TranslationError("LayerId mismatch: expected %s, got %s" % (layer_id, returned_id))
            translated = str(model_data.get("translatedText", ""))
            validate_placeholders(translated, placeholders)
            return restore_placeholders(translated, placeholders)
        except Exception as exc:
            last_error = exc
            logging.warning(
                "Layer %s translation attempt %s/%s failed: %s",
                layer_id,
                attempt + 1,
                retries + 1,
                exc,
            )
            if attempt < retries:
                time.sleep(retry_delay)

    raise TranslationError(str(last_error))


def iter_layers(payload: Dict[str, Any]) -> Iterable[Dict[str, Any]]:
    for item in payload.get("layers", []):
        if isinstance(item, dict):
            yield item


def translate_payload(payload: Dict[str, Any], config: Dict[str, Any], dry_run: bool) -> Dict[str, int]:
    retries = int(config.get("max_retries", 2))
    retry_delay = float(config.get("retry_delay_seconds", 2))
    counts = {"translated": 0, "skipped": 0, "failed": 0}

    for layer in iter_layers(payload):
        layer_id = str(layer.get("layerId", ""))
        original_text = str(layer.get("originalText", ""))

        if not original_text:
            layer["translatedText"] = ""
            layer["status"] = "skipped"
            layer["error"] = "Empty text layer."
            counts["skipped"] += 1
            continue

        if dry_run:
            protected_text, placeholders = protect_placeholders(original_text)
            validate_placeholders(protected_text, placeholders)
            layer["translatedText"] = original_text
            layer["status"] = "dry-run"
            layer["error"] = ""
            counts["skipped"] += 1
            logging.info("Dry-run checked layer %s (%s placeholder(s)).", layer_id, len(placeholders))
            continue

        try:
            translated = translate_one(layer, config, retries, retry_delay)
            layer["translatedText"] = translated
            layer["status"] = "translated"
            layer["error"] = ""
            counts["translated"] += 1
            logging.info("Translated layer %s.", layer_id)
        except Exception as exc:
            layer["translatedText"] = ""
            layer["status"] = "error"
            layer["error"] = str(exc)
            counts["failed"] += 1
            logging.error("Layer %s failed and will be skipped: %s", layer_id, exc)

    return counts


def parse_args(argv: List[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Translate Photoshop text-layer JSON.")
    parser.add_argument("--json", default=str(DEFAULT_JSON_PATH), help="Path to the temp JSON exported by Photoshop.")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG_PATH), help="Path to config.json.")
    parser.add_argument("--dry-run", action="store_true", help="Validate JSON and placeholder protection without calling the LLM.")
    parser.add_argument("--debug", action="store_true", help="Enable verbose logs and keep the temp JSON during Photoshop apply.")
    return parser.parse_args(argv)


def main(argv: List[str]) -> int:
    args = parse_args(argv)
    log_path = setup_logging(args.debug)
    json_path = Path(args.json).expanduser().resolve()
    config_path = Path(args.config).expanduser().resolve()

    logging.info("Log file: %s", log_path)
    logging.info("JSON file: %s", json_path)
    logging.info("Config file: %s", config_path)

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

    try:
        counts = translate_payload(payload, config, args.dry_run)
        meta["translationSummary"] = counts
        save_json(json_path, payload)
    except Exception as exc:
        logging.exception("Translation run failed before JSON could be saved: %s", exc)
        return 1

    logging.info(
        "Finished. translated=%s skipped=%s failed=%s",
        counts["translated"],
        counts["skipped"],
        counts["failed"],
    )
    return 0 if counts["failed"] == 0 else 3


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
