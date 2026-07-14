import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import ps_text_translate as pst


def make_item(layer_id: str, text: str):
    layer = {
        "layerId": int(layer_id),
        "layerName": "Layer " + layer_id,
        "layerPath": "Group / Layer " + layer_id,
        "originalText": text,
        "translatedText": "",
        "status": "pending",
        "error": "",
    }
    return pst.prepare_translation_item(layer)


class PlaceholderTests(unittest.TestCase):
    def test_protect_and_restore_supported_placeholders(self):
        source = "HP %d {name}\\n<color=#fff>Text</color>"
        protected, placeholders = pst.protect_placeholders(source)

        self.assertNotEqual(source, protected)
        self.assertEqual(5, len(placeholders))
        pst.validate_placeholders(protected, placeholders)
        self.assertEqual(source, pst.restore_placeholders(protected, placeholders))

    def test_placeholder_token_does_not_collide_with_source_text(self):
        source = "Literal [[PST_PH_DEADBEEF_000]] and %s"
        protected, placeholders = pst.protect_placeholders(source)

        self.assertNotIn("[[PST_PH_DEADBEEF_000]]", protected)
        self.assertEqual(source, pst.restore_placeholders(protected, placeholders))

    def test_duplicate_placeholder_token_is_rejected(self):
        protected, placeholders = pst.protect_placeholders("Value: %s")
        token = next(iter(placeholders))

        with self.assertRaisesRegex(pst.TranslationError, "duplicated"):
            pst.validate_placeholders(protected + token, placeholders)


class ResponseTests(unittest.TestCase):
    def test_compact_response_maps_by_layer_id(self):
        item = make_item("123", "Hello %s")
        token = next(iter(item["placeholders"]))
        raw = json.dumps({"translations": {"123": "你好 " + token}}, ensure_ascii=False)

        results, errors = pst.parse_batch_response(raw, [item])

        self.assertEqual("你好 %s", results["123"])
        self.assertEqual({}, errors)

    def test_non_string_translation_is_rejected(self):
        item = make_item("123", "Hello")
        raw = json.dumps({"translations": {"123": None}})

        results, errors = pst.parse_batch_response(raw, [item])

        self.assertEqual({}, results)
        self.assertRegex(errors["123"], "must be a string")

    def test_empty_translation_is_rejected(self):
        item = make_item("123", "Hello")
        raw = json.dumps({"translations": {"123": ""}})

        results, errors = pst.parse_batch_response(raw, [item])

        self.assertEqual({}, results)
        self.assertRegex(errors["123"], "is empty")

    def test_added_terminal_punctuation_is_removed(self):
        item = make_item("123", "Hello")
        raw = json.dumps({"translations": {"123": "你好。"}}, ensure_ascii=False)

        results, errors = pst.parse_batch_response(raw, [item])

        self.assertEqual("你好", results["123"])
        self.assertEqual({}, errors)


class PayloadTests(unittest.TestCase):
    def test_duplicate_layer_ids_are_rejected(self):
        payload = {
            "layers": [
                {"layerId": 7, "originalText": "A"},
                {"layerId": 7, "originalText": "B"},
            ]
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "layers.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Duplicate layerId"):
                pst.load_json(path)

    def test_export_error_is_preserved_and_other_layers_continue(self):
        payload = {
            "layers": [
                {
                    "layerId": 1,
                    "originalText": "",
                    "translatedText": "",
                    "status": "export_error",
                    "error": "Photoshop read failed",
                },
                {
                    "layerId": 2,
                    "originalText": "123",
                    "translatedText": "",
                    "status": "pending",
                    "error": "",
                },
            ]
        }

        counts = pst.translate_payload(payload, {}, dry_run=False)

        self.assertEqual({"translated": 0, "skipped": 1, "failed": 1}, counts)
        self.assertEqual("export_error", payload["layers"][0]["status"])
        self.assertEqual("non_translatable", payload["layers"][1]["skipReason"])


class ConfigTests(unittest.TestCase):
    def write_config(self, directory: str, **overrides):
        config = {
            "base_url": "https://api.example.com/v1",
            "api_key": "file-key",
            "model": "test-model",
            "target_language": "简体中文",
        }
        config.update(overrides)
        path = Path(directory) / "config.json"
        path.write_text(json.dumps(config), encoding="utf-8")
        return path

    def test_environment_api_key_takes_precedence(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = self.write_config(temp_dir)
            with mock.patch.dict("os.environ", {"PST_LLM_API_KEY": "environment-key"}, clear=False):
                config = pst.load_config(path)

        self.assertEqual("environment-key", config["api_key"])

    def test_negative_retry_count_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = self.write_config(temp_dir, max_retries=-1)
            with self.assertRaisesRegex(ValueError, "max_retries"):
                pst.load_config(path)


class BatchTests(unittest.TestCase):
    def test_default_batch_size_splits_28_items_into_20_and_8(self):
        items = [make_item(str(index), "Text") for index in range(28)]

        batches = pst.build_batches(
            items,
            pst.DEFAULT_BATCH_SIZE,
            pst.DEFAULT_BATCH_MAX_CHARS,
        )

        self.assertEqual([20, 8], [len(batch) for batch in batches])

    def test_multilayer_timeout_splits_without_repeating_same_batch(self):
        items = [make_item(str(index), "Text") for index in range(4)]
        call_sizes = []

        def fake_translate(batch, config):
            call_sizes.append(len(batch))
            if len(batch) > 1:
                raise pst.TimeoutTranslationError("simulated timeout")
            return {batch[0]["layer_id"]: "译文"}, {}

        with mock.patch.object(pst, "translate_batch_once", side_effect=fake_translate):
            results, errors = pst.translate_batch_resilient(
                items,
                {},
                retries=2,
                retry_delay=0,
            )

        self.assertEqual([4, 2, 1, 1, 2, 1, 1], call_sizes)
        self.assertEqual(4, len(results))
        self.assertEqual({}, errors)

    def test_missing_layer_retries_only_missing_item(self):
        items = [make_item(str(index), "Text") for index in range(20)]
        requested_ids = []

        def fake_call(config, messages):
            request = json.loads(messages[1]["content"])
            layer_ids = [entry[0] for entry in request["items"]]
            requested_ids.append(layer_ids)
            response_ids = layer_ids[:-1] if len(requested_ids) == 1 else layer_ids
            return json.dumps(
                {"translations": {layer_id: "译文" for layer_id in response_ids}},
                ensure_ascii=False,
            )

        with mock.patch.object(pst, "call_chat_completion", side_effect=fake_call):
            results, errors = pst.translate_batch_resilient(
                items,
                {"target_language": "简体中文"},
                retries=2,
                retry_delay=0,
            )

        self.assertEqual([str(index) for index in range(20)], requested_ids[0])
        self.assertEqual(["19"], requested_ids[1])
        self.assertEqual(2, len(requested_ids))
        self.assertEqual(20, len(results))
        self.assertEqual({}, errors)

    def test_partial_retry_budget_is_bounded(self):
        items = [make_item(str(index), "Text") for index in range(4)]
        requested_ids = []

        def fake_call(config, messages):
            request = json.loads(messages[1]["content"])
            layer_ids = [entry[0] for entry in request["items"]]
            requested_ids.append(layer_ids)
            translations = {
                layer_id: "译文"
                for layer_id in layer_ids
                if layer_id != "3"
            }
            return json.dumps({"translations": translations}, ensure_ascii=False)

        with mock.patch.object(pst, "call_chat_completion", side_effect=fake_call):
            results, errors = pst.translate_batch_resilient(
                items,
                {"target_language": "简体中文"},
                retries=2,
                retry_delay=0,
            )

        self.assertEqual([["0", "1", "2", "3"], ["3"], ["3"]], requested_ids)
        self.assertEqual(3, len(results))
        self.assertRegex(errors["3"], "Missing layerId")

    def test_placeholder_failure_retries_only_invalid_item(self):
        items = [make_item("1", "Value %s"), make_item("2", "World")]
        requested_ids = []

        def fake_call(config, messages):
            request = json.loads(messages[1]["content"])
            requested_ids.append([entry[0] for entry in request["items"]])
            translations = {}
            for layer_id, protected_text in request["items"]:
                if layer_id == "1" and len(requested_ids) == 1:
                    translations[layer_id] = "值"
                elif layer_id == "1":
                    token = pst.PROTECTED_TOKEN_RE.search(protected_text).group(0)
                    translations[layer_id] = "值 " + token
                else:
                    translations[layer_id] = "世界"
            return json.dumps({"translations": translations}, ensure_ascii=False)

        with mock.patch.object(pst, "call_chat_completion", side_effect=fake_call):
            results, errors = pst.translate_batch_resilient(
                items,
                {"target_language": "简体中文"},
                retries=2,
                retry_delay=0,
            )

        self.assertEqual([["1", "2"], ["1"]], requested_ids)
        self.assertEqual("值 %s", results["1"])
        self.assertEqual("世界", results["2"])
        self.assertEqual({}, errors)

    def test_unparseable_json_retries_full_batch(self):
        items = [make_item(str(index), "Text") for index in range(3)]
        requested_ids = []

        def fake_call(config, messages):
            request = json.loads(messages[1]["content"])
            layer_ids = [entry[0] for entry in request["items"]]
            requested_ids.append(layer_ids)
            if len(requested_ids) == 1:
                return "not JSON"
            return json.dumps(
                {"translations": {layer_id: "译文" for layer_id in layer_ids}},
                ensure_ascii=False,
            )

        with mock.patch.object(pst, "call_chat_completion", side_effect=fake_call):
            results, errors = pst.translate_batch_resilient(
                items,
                {"target_language": "简体中文"},
                retries=2,
                retry_delay=0,
            )

        self.assertEqual([["0", "1", "2"], ["0", "1", "2"]], requested_ids)
        self.assertEqual(3, len(results))
        self.assertEqual({}, errors)


if __name__ == "__main__":
    unittest.main()
