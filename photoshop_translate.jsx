#target photoshop

(function () {
    var TOOL_NAME = "PSTranslate";
    var JSON_FILE_NAME = "ps_text_layers.json";
    var jsonCompatParser = null;
    var PYTHON_SCRIPT_NAME = "ps_text_translate.py";
    var CONFIG_FILE_NAME = "config.json";

    var DEBUG = false;
    var DRY_RUN = false;
    var PROGRESS_SCAN_END = 2;
    var PROGRESS_EXPORT_START = 2;
    var PROGRESS_EXPORT_END = 12;
    var PROGRESS_TRANSLATE_START = 12;
    var PROGRESS_TRANSLATE_END = 85;
    var PROGRESS_APPLY_START = 85;
    var PROGRESS_APPLY_END = 100;

    function pad2(value) {
        return value < 10 ? "0" + value : String(value);
    }

    function isoNow() {
        var d = new Date();
        return d.getUTCFullYear() + "-" +
            pad2(d.getUTCMonth() + 1) + "-" +
            pad2(d.getUTCDate()) + "T" +
            pad2(d.getUTCHours()) + ":" +
            pad2(d.getUTCMinutes()) + ":" +
            pad2(d.getUTCSeconds()) + "Z";
    }

    function ensureFolder(folder) {
        if (!folder.exists && !folder.create()) {
            throw new Error("Could not create folder: " + folder.fsName);
        }
        return folder;
    }

    function getDataFolder() {
        return ensureFolder(new Folder(Folder.temp.fsName + "/PSTranslate"));
    }

    function createRunToken() {
        return String(new Date().getTime()) + "_" + String(Math.floor(Math.random() * 1000000));
    }

    function getRunFile(stem, extension, runToken) {
        var suffix = runToken ? "_" + runToken : "";
        return new File(getDataFolder().fsName + "/" + stem + suffix + extension);
    }

    function getDefaultJsonFile(runToken) {
        if (!runToken) {
            return new File(getDataFolder().fsName + "/" + JSON_FILE_NAME);
        }
        return getRunFile("ps_text_layers", ".json", runToken);
    }

    function getExitCodeFile(runToken) {
        return getRunFile("python_exit_code", ".txt", runToken);
    }

    function getProgressFile(runToken) {
        return getRunFile("python_progress", ".json", runToken);
    }

    function getRunnerBatFile(runToken) {
        return getRunFile("run_ps_text_translate", ".bat", runToken);
    }

    function getRunnerVbsFile(runToken) {
        return getRunFile("run_ps_text_translate", ".vbs", runToken);
    }

    function getScriptFolder() {
        try {
            if ($.fileName) {
                return new File($.fileName).parent;
            }
        } catch (e) {
        }
        return getDataFolder();
    }

    function getLogFile() {
        var logFolder = new Folder(getScriptFolder().fsName + "/logs");
        try {
            ensureFolder(logFolder);
            return new File(logFolder.fsName + "/photoshop_jsx.log");
        } catch (e) {
            return new File(getDataFolder().fsName + "/photoshop_jsx.log");
        }
    }

    function log(message) {
        try {
            var file = getLogFile();
            file.encoding = "UTF8";
            file.open("a");
            file.writeln(isoNow() + " [translate] " + message);
            file.close();
        } catch (e) {
        }
    }

    function repeatChar(ch, count) {
        var s = "";
        for (var i = 0; i < count; i++) {
            s += ch;
        }
        return s;
    }

    function jsonEscape(value) {
        var s = String(value);
        var out = "";
        for (var i = 0; i < s.length; i++) {
            var c = s.charAt(i);
            var code = s.charCodeAt(i);
            if (c === "\"") {
                out += "\\\"";
            } else if (c === "\\") {
                out += "\\\\";
            } else if (c === "\b") {
                out += "\\b";
            } else if (c === "\f") {
                out += "\\f";
            } else if (c === "\n") {
                out += "\\n";
            } else if (c === "\r") {
                out += "\\r";
            } else if (c === "\t") {
                out += "\\t";
            } else if (code < 32) {
                var hex = code.toString(16);
                out += "\\u" + repeatChar("0", 4 - hex.length) + hex;
            } else {
                out += c;
            }
        }
        return out;
    }

    function jsonStringify(value) {
        if (value === null) {
            return "null";
        }
        var t = typeof value;
        if (t === "string") {
            return "\"" + jsonEscape(value) + "\"";
        }
        if (t === "number") {
            return isFinite(value) ? String(value) : "null";
        }
        if (t === "boolean") {
            return value ? "true" : "false";
        }
        if (value instanceof Array) {
            var items = [];
            for (var i = 0; i < value.length; i++) {
                items.push(jsonStringify(value[i]));
            }
            return "[" + items.join(",") + "]";
        }
        var pairs = [];
        for (var k in value) {
            if (value.hasOwnProperty && !value.hasOwnProperty(k)) {
                continue;
            }
            pairs.push("\"" + jsonEscape(k) + "\":" + jsonStringify(value[k]));
        }
        return "{" + pairs.join(",") + "}";
    }

    // PST_JSON_COMPAT_START
    function createJsonCompatParser() {
        function parse(text) {
            var source = String(text);
            var index = 0;
            var length = source.length;

            function fail(message) {
                throw new Error("Invalid JSON at character " + index + ": " + message);
            }

            function isWhitespace(ch) {
                if (!ch) {
                    return false;
                }
                return ch === " " || ch === "\t" || ch === "\r" || ch === "\n" ||
                    ch.charCodeAt(0) === 0xFEFF;
            }

            function skipWhitespace() {
                while (index < length && isWhitespace(source.charAt(index))) {
                    index++;
                }
            }

            function parseString() {
                if (source.charAt(index) !== "\"") {
                    fail("Expected string.");
                }
                index++;

                var result = "";
                while (index < length) {
                    var ch = source.charAt(index++);
                    if (ch === "\"") {
                        return result;
                    }
                    if (ch === "\\") {
                        if (index >= length) {
                            fail("Unterminated escape sequence.");
                        }
                        var escape = source.charAt(index++);
                        if (escape === "\"" || escape === "\\" || escape === "/") {
                            result += escape;
                        } else if (escape === "b") {
                            result += "\b";
                        } else if (escape === "f") {
                            result += "\f";
                        } else if (escape === "n") {
                            result += "\n";
                        } else if (escape === "r") {
                            result += "\r";
                        } else if (escape === "t") {
                            result += "\t";
                        } else if (escape === "u") {
                            if (index + 4 > length) {
                                fail("Incomplete Unicode escape.");
                            }
                            var hex = source.substr(index, 4);
                            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
                                fail("Invalid Unicode escape.");
                            }
                            result += String.fromCharCode(parseInt(hex, 16));
                            index += 4;
                        } else {
                            fail("Invalid escape sequence.");
                        }
                    } else {
                        if (ch.charCodeAt(0) < 32) {
                            fail("Unescaped control character in string.");
                        }
                        result += ch;
                    }
                }

                fail("Unterminated string.");
            }

            function parseNumber() {
                var match = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+\-]?[0-9]+)?/.exec(
                    source.substring(index)
                );
                if (!match) {
                    fail("Invalid number.");
                }
                index += match[0].length;
                var value = Number(match[0]);
                if (!isFinite(value)) {
                    fail("Number is outside the supported range.");
                }
                return value;
            }

            function parseLiteral(literal, value) {
                if (source.substr(index, literal.length) !== literal) {
                    fail("Expected " + literal + ".");
                }
                index += literal.length;
                return value;
            }

            function parseArray() {
                var result = [];
                index++;
                skipWhitespace();
                if (source.charAt(index) === "]") {
                    index++;
                    return result;
                }

                while (index < length) {
                    result.push(parseValue());
                    skipWhitespace();
                    var ch = source.charAt(index++);
                    if (ch === "]") {
                        return result;
                    }
                    if (ch !== ",") {
                        fail("Expected comma or closing bracket.");
                    }
                    skipWhitespace();
                }

                fail("Unterminated array.");
            }

            function parseObject() {
                var result = {};
                var keys = [];
                index++;
                skipWhitespace();
                if (source.charAt(index) === "}") {
                    index++;
                    return result;
                }

                while (index < length) {
                    var key = parseString();
                    if (key === "__proto__" || key === "prototype" || key === "constructor") {
                        fail("Unsafe object key.");
                    }
                    for (var i = 0; i < keys.length; i++) {
                        if (keys[i] === key) {
                            fail("Duplicate object key: " + key);
                        }
                    }
                    keys.push(key);

                    skipWhitespace();
                    if (source.charAt(index++) !== ":") {
                        fail("Expected colon after object key.");
                    }
                    result[key] = parseValue();

                    skipWhitespace();
                    var ch = source.charAt(index++);
                    if (ch === "}") {
                        return result;
                    }
                    if (ch !== ",") {
                        fail("Expected comma or closing brace.");
                    }
                    skipWhitespace();
                }

                fail("Unterminated object.");
            }

            function parseValue() {
                skipWhitespace();
                if (index >= length) {
                    fail("Unexpected end of input.");
                }

                var ch = source.charAt(index);
                if (ch === "\"") {
                    return parseString();
                }
                if (ch === "{") {
                    return parseObject();
                }
                if (ch === "[") {
                    return parseArray();
                }
                if (ch === "t") {
                    return parseLiteral("true", true);
                }
                if (ch === "f") {
                    return parseLiteral("false", false);
                }
                if (ch === "n") {
                    return parseLiteral("null", null);
                }
                if (ch === "-" || (ch >= "0" && ch <= "9")) {
                    return parseNumber();
                }

                fail("Unexpected token.");
            }

            var result = parseValue();
            skipWhitespace();
            if (index !== length) {
                fail("Unexpected trailing content.");
            }
            return result;
        }

        return {
            parse: parse
        };
    }
    // PST_JSON_COMPAT_END

    function parseJson(text) {
        if (typeof JSON !== "undefined" && JSON.parse) {
            return JSON.parse(text);
        }
        if (!jsonCompatParser) {
            jsonCompatParser = createJsonCompatParser();
        }
        return jsonCompatParser.parse(text);
    }

    function readTextFile(file) {
        file.encoding = "UTF8";
        if (!file.open("r")) {
            throw new Error("Could not open file: " + file.fsName);
        }
        try {
            return file.read();
        } finally {
            file.close();
        }
    }

    function readJson(file) {
        return parseJson(readTextFile(file));
    }

    function writeJson(file, payload) {
        file.encoding = "UTF8";
        if (!file.open("w")) {
            throw new Error("Could not open JSON for writing: " + file.fsName);
        }
        try {
            file.write(jsonStringify(payload));
        } finally {
            file.close();
        }
    }

    function quoteArg(value) {
        return "\"" + String(value).replace(/"/g, "\\\"") + "\"";
    }

    function quoteVbsString(value) {
        return "\"" + String(value).replace(/"/g, "\"\"") + "\"";
    }

    function writeTextFile(file, text) {
        file.encoding = "UTF8";
        if (!file.open("w")) {
            throw new Error("Could not open file for writing: " + file.fsName);
        }
        try {
            file.write(text);
        } finally {
            file.close();
        }
    }

    function waitForFile(file, timeoutMs) {
        var started = new Date().getTime();
        while (!file.exists) {
            if (new Date().getTime() - started > timeoutMs) {
                return false;
            }
            $.sleep(250);
        }
        return true;
    }

    function formatDuration(seconds) {
        if (seconds === null || typeof seconds === "undefined" || isNaN(Number(seconds))) {
            return "calculating";
        }
        var value = Math.max(0, Math.round(Number(seconds)));
        var minutes = Math.floor(value / 60);
        var remainder = value % 60;
        if (minutes <= 0) {
            return remainder + "s";
        }
        return minutes + "m " + (remainder < 10 ? "0" + remainder : remainder) + "s";
    }

    function elapsedSecondsSince(startedAt) {
        return Math.max(0, (new Date().getTime() - startedAt) / 1000);
    }

    function createProgressWindow(total) {
        var win = new Window("palette", "PSTranslate");
        win.orientation = "column";
        win.alignChildren = "fill";
        win.margins = 14;

        var title = win.add("statictext", undefined, "Processing text layers...");
        var bar = win.add("progressbar", undefined, 0, 100);
        bar.preferredSize = [420, 18];
        var detail = win.add("statictext", undefined, "Starting...");
        var eta = win.add("statictext", undefined, "Progress: 0% | Elapsed: 0s | ETA: calculating");

        win.show();
        win.update();

        return {
            window: win,
            title: title,
            bar: bar,
            detail: detail,
            eta: eta,
            startedAt: new Date().getTime(),
            displayPercent: 0,
            targetPercent: 0,
            message: "Starting...",
            current: 0,
            total: total || 0,
            etaSeconds: null
        };
    }

    function renderProgressWindow(progressWindow) {
        if (!progressWindow) {
            return;
        }

        var percent = Number(progressWindow.displayPercent);
        if (isNaN(percent)) {
            percent = 0;
        }
        percent = Math.max(0, Math.min(100, percent));

        var lines = [];
        if (progressWindow.total > 0) {
            lines.push("Items: " + progressWindow.current + "/" + progressWindow.total);
        }
        lines.push("Progress: " + Math.round(percent) + "%");
        lines.push("Elapsed: " + formatDuration(elapsedSecondsSince(progressWindow.startedAt)));
        lines.push("ETA: " + formatDuration(progressWindow.etaSeconds));

        progressWindow.bar.value = percent;
        progressWindow.detail.text = progressWindow.message || "Working...";
        progressWindow.eta.text = lines.join(" | ");
        progressWindow.window.update();
    }

    function tickProgressWindow(progressWindow, force) {
        if (!progressWindow) {
            return;
        }

        var target = Math.max(0, Math.min(100, Number(progressWindow.targetPercent)));
        if (isNaN(target)) {
            target = 0;
        }

        if (force) {
            progressWindow.displayPercent = target;
        } else if (progressWindow.displayPercent < target) {
            var gap = target - progressWindow.displayPercent;
            var step = Math.max(0.25, Math.min(6, gap * 0.25));
            progressWindow.displayPercent = Math.min(target, progressWindow.displayPercent + step);
        } else if (progressWindow.displayPercent > target) {
            progressWindow.displayPercent = target;
        }

        renderProgressWindow(progressWindow);
    }

    function setProgressTarget(progressWindow, percent, message, current, total, etaSeconds, force) {
        if (!progressWindow) {
            return;
        }

        var target = Number(percent);
        if (isNaN(target)) {
            target = progressWindow.targetPercent;
        }
        target = Math.max(0, Math.min(100, target));

        if (force || target > progressWindow.targetPercent) {
            progressWindow.targetPercent = target;
        }
        if (message) {
            progressWindow.message = String(message);
        }
        if (typeof current !== "undefined" && current !== null && !isNaN(Number(current))) {
            progressWindow.current = Math.max(0, Math.round(Number(current)));
        }
        if (typeof total !== "undefined" && total !== null && !isNaN(Number(total))) {
            progressWindow.total = Math.max(0, Math.round(Number(total)));
        }
        progressWindow.etaSeconds = etaSeconds;
        tickProgressWindow(progressWindow, force);
    }

    function closeProgressWindow(progressWindow) {
        if (!progressWindow) {
            return;
        }
        try {
            progressWindow.window.close();
        } catch (closeError) {
            log("Could not close progress window: " + closeError);
        }
    }

    function readProgress(progressFile) {
        try {
            if (!progressFile.exists) {
                return null;
            }
            return readJson(progressFile);
        } catch (e) {
            log("Could not read progress JSON: " + e);
            return null;
        }
    }

    function countTextLayersInJsonFile(jsonFile) {
        try {
            var payload = readJson(jsonFile);
            if (payload && payload.layers && payload.layers.length) {
                return payload.layers.length;
            }
        } catch (e) {
            log("Could not read text layer count: " + e);
        }
        return 0;
    }

    function mapRange(value, sourceStart, sourceEnd, targetStart, targetEnd) {
        var ratio = 0;
        if (sourceEnd !== sourceStart) {
            ratio = (value - sourceStart) / (sourceEnd - sourceStart);
        }
        ratio = Math.max(0, Math.min(1, ratio));
        return targetStart + (targetEnd - targetStart) * ratio;
    }

    function pythonCreepPercent(waitStartedAt) {
        var elapsed = elapsedSecondsSince(waitStartedAt);
        var ratio = Math.min(0.65, (elapsed / 180) * 0.65);
        return PROGRESS_TRANSLATE_START +
            (PROGRESS_TRANSLATE_END - PROGRESS_TRANSLATE_START) * ratio;
    }

    function updatePythonProgress(progressWindow, progress, waitStartedAt) {
        if (!progressWindow || !progress) {
            return;
        }

        var percent = Number(progress.percent);
        if (isNaN(percent)) {
            percent = 0;
        }
        var globalPercent = mapRange(
            percent,
            0,
            100,
            PROGRESS_TRANSLATE_START,
            PROGRESS_TRANSLATE_END
        );
        if (!progress.done) {
            globalPercent = Math.max(globalPercent, pythonCreepPercent(waitStartedAt));
        } else {
            globalPercent = PROGRESS_TRANSLATE_END;
        }

        setProgressTarget(
            progressWindow,
            globalPercent,
            progress.message || progress.stage || "Translating text layers...",
            progress.current,
            progress.total,
            progress.etaSeconds,
            false
        );
    }

    function waitForPythonProcess(exitCodeFile, progressFile, progressWindow) {
        var started = new Date().getTime();
        var sawProgress = false;
        var loggedMissingProgress = false;
        var progress;

        while (!exitCodeFile.exists) {
            progress = readProgress(progressFile);
            if (progress) {
                sawProgress = true;
                updatePythonProgress(progressWindow, progress, started);
            } else if (progressWindow) {
                setProgressTarget(
                    progressWindow,
                    pythonCreepPercent(started),
                    "Waiting for Python translation...",
                    progressWindow.current,
                    progressWindow.total,
                    null,
                    false
                );
            }

            if (!sawProgress && !loggedMissingProgress && new Date().getTime() - started > 60000) {
                loggedMissingProgress = true;
                log("No Python progress file update after 60 seconds; continuing to wait for exit code.");
            }

            if (!sawProgress && new Date().getTime() - started > 120000) {
                throw new Error("Python did not create a progress file within 2 minutes.");
            }

            if (new Date().getTime() - started > 21600000) {
                throw new Error("Python translation timed out after 6 hours.");
            }

            $.sleep(500);
        }

        progress = readProgress(progressFile);
        if (progress) {
            updatePythonProgress(progressWindow, progress, started);
        }
    }

    function removeTempFile(file, description) {
        try {
            if (file.exists) {
                file.remove();
            }
        } catch (e) {
            log("Could not remove " + description + ": " + e);
        }
    }

    function cleanupPythonRunnerFiles(exitCodeFile, runnerBatFile, runnerVbsFile, progressFile) {
        removeTempFile(exitCodeFile, "Python exit-code file");
        removeTempFile(runnerBatFile, "runner bat file");
        removeTempFile(runnerVbsFile, "runner vbs file");
        if (!DEBUG) {
            removeTempFile(progressFile, "progress file");
        }
    }

    function getLayerId(layer) {
        try {
            if (typeof layer.id !== "undefined") {
                return Number(layer.id);
            }
        } catch (e) {
        }

        var doc = app.activeDocument;
        var oldLayer = doc.activeLayer;
        try {
            doc.activeLayer = layer;
            var ref = new ActionReference();
            ref.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
            var desc = executeActionGet(ref);
            return desc.getInteger(stringIDToTypeID("layerID"));
        } finally {
            try {
                doc.activeLayer = oldLayer;
            } catch (ignored) {
            }
        }
    }

    function makeLayerPath(parts, layerName) {
        var copy = [];
        for (var i = 0; i < parts.length; i++) {
            copy.push(parts[i]);
        }
        copy.push(layerName);
        return copy.join(" / ");
    }

    function countTextLayers(container) {
        var count = 0;
        for (var i = 0; i < container.layers.length; i++) {
            var layer = container.layers[i];
            if (layer.typename === "LayerSet") {
                count += countTextLayers(layer);
            } else if (layer.typename === "ArtLayer" && layer.kind === LayerKind.TEXT) {
                count++;
            }
        }
        return count;
    }

    function updateExportProgress(progressWindow, progressState, layerName) {
        if (!progressWindow || !progressState || progressState.total <= 0) {
            return;
        }
        var percent = mapRange(
            progressState.count,
            0,
            progressState.total,
            PROGRESS_EXPORT_START,
            PROGRESS_EXPORT_END
        );
        setProgressTarget(
            progressWindow,
            percent,
            "Reading text layer: " + layerName,
            progressState.count,
            progressState.total,
            null,
            false
        );
    }

    function collectTextLayers(container, pathParts, result, progressWindow, progressState) {
        for (var i = 0; i < container.layers.length; i++) {
            var layer = container.layers[i];
            if (layer.typename === "LayerSet") {
                var nextPath = [];
                for (var p = 0; p < pathParts.length; p++) {
                    nextPath.push(pathParts[p]);
                }
                nextPath.push(layer.name);
                collectTextLayers(layer, nextPath, result, progressWindow, progressState);
            } else if (layer.typename === "ArtLayer" && layer.kind === LayerKind.TEXT) {
                var layerInfo = {
                    layerId: getLayerId(layer),
                    layerName: layer.name,
                    layerPath: makeLayerPath(pathParts, layer.name),
                    originalText: "",
                    translatedText: "",
                    status: "pending",
                    error: ""
                };
                try {
                    layerInfo.originalText = layer.textItem.contents;
                } catch (e) {
                    layerInfo.status = "export_error";
                    layerInfo.error = String(e);
                    log("Failed reading text for layer " + layerInfo.layerId + ": " + e);
                }
                result.push(layerInfo);
                if (progressState) {
                    progressState.count++;
                    updateExportProgress(progressWindow, progressState, layer.name);
                }
            }
        }
    }

    function collectTextLayerMap(container, result) {
        for (var i = 0; i < container.layers.length; i++) {
            var layer = container.layers[i];
            if (layer.typename === "LayerSet") {
                collectTextLayerMap(layer, result);
            } else if (layer.typename === "ArtLayer" && layer.kind === LayerKind.TEXT) {
                result[String(getLayerId(layer))] = layer;
            }
        }
    }

    function getDocumentPath(doc) {
        try {
            return doc.fullName.fsName;
        } catch (e) {
            return "";
        }
    }

    function getDocumentId(doc) {
        try {
            if (typeof doc.id !== "undefined") {
                return Number(doc.id);
            }
        } catch (e1) {
        }
        try {
            var ref = new ActionReference();
            ref.putProperty(charIDToTypeID("Prpr"), stringIDToTypeID("documentID"));
            ref.putEnumerated(charIDToTypeID("Dcmn"), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
            var desc = executeActionGet(ref);
            return desc.getInteger(stringIDToTypeID("documentID"));
        } catch (e2) {
            return null;
        }
    }

    function normalizeDocumentPath(value) {
        return String(value || "").replace(/\//g, "\\").toLowerCase();
    }

    function assertDocumentMatches(meta, doc) {
        var expectedPath = String(meta.documentPath || "");
        var actualPath = getDocumentPath(doc);
        var expectedName = String(meta.documentName || "");
        var expectedId = meta.documentId;
        var actualId = getDocumentId(doc);

        if (expectedPath) {
            if (!actualPath || normalizeDocumentPath(expectedPath) !== normalizeDocumentPath(actualPath)) {
                throw new Error("Translation JSON belongs to a different Photoshop document: " + expectedPath);
            }
        } else if (expectedId !== null && typeof expectedId !== "undefined" &&
                actualId !== null && String(expectedId) !== String(actualId)) {
            throw new Error("Translation JSON belongs to a different unsaved Photoshop document.");
        }

        if (expectedName && toLowerText(expectedName) !== toLowerText(doc.name)) {
            throw new Error("Translation JSON document name does not match the active document.");
        }
    }

    function exportDocumentText(doc, jsonFile, progressWindow, totalTextLayers) {
        var layers = [];
        var progressState = {
            count: 0,
            total: totalTextLayers || 0
        };
        collectTextLayers(doc, [], layers, progressWindow, progressState);

        var payload = {
            meta: {
                schemaVersion: 2,
                tool: TOOL_NAME,
                documentName: doc.name,
                documentPath: getDocumentPath(doc),
                documentId: getDocumentId(doc),
                exportedAt: isoNow(),
                tempJson: jsonFile.fsName,
                debug: DEBUG,
                dryRun: DRY_RUN,
                oneClick: true,
                photoshopVersion: app.version
            },
            layers: layers
        };

        writeJson(jsonFile, payload);
        setProgressTarget(
            progressWindow,
            PROGRESS_EXPORT_END,
            "Text layer export complete.",
            layers.length,
            totalTextLayers || layers.length,
            null,
            true
        );
        log("Exported " + layers.length + " text layer(s) to " + jsonFile.fsName);
        return layers.length;
    }

    function toLowerText(value) {
        try {
            return String(value).toLowerCase();
        } catch (e) {
            return "";
        }
    }

    function getFontField(font, fieldName) {
        try {
            return String(font[fieldName]);
        } catch (e) {
            return "";
        }
    }

    function fontMatchesYaHei(font, exactOnly) {
        var name = getFontField(font, "name");
        var family = getFontField(font, "family");
        var postScriptName = getFontField(font, "postScriptName");
        var hay = toLowerText(name + " " + family + " " + postScriptName);
        var hasYaHei = hay.indexOf("microsoft yahei") >= 0 ||
            hay.indexOf("microsoftyahei") >= 0 ||
            hay.indexOf("微软雅黑") >= 0;
        if (!hasYaHei) {
            return false;
        }
        if (!exactOnly) {
            return true;
        }
        return hay.indexOf("microsoft yahei ui") < 0 && hay.indexOf("microsoftyaheiui") < 0;
    }

    function findMicrosoftYaHeiFont() {
        var fallback = null;
        for (var pass = 0; pass < 2; pass++) {
            for (var i = 0; i < app.fonts.length; i++) {
                var font = app.fonts[i];
                if (!fontMatchesYaHei(font, pass === 0)) {
                    continue;
                }
                var postScriptName = getFontField(font, "postScriptName");
                var name = getFontField(font, "name");
                var style = toLowerText(getFontField(font, "style") + " " + name + " " + postScriptName);
                var candidate = postScriptName || name;
                if (!candidate) {
                    continue;
                }
                if (style.indexOf("regular") >= 0 || style.indexOf("normal") >= 0) {
                    return candidate;
                }
                if (fallback === null) {
                    fallback = candidate;
                }
            }
        }
        return fallback;
    }

    function applyText(layer, translatedText, yaHeiFontName) {
        var textItem = layer.textItem;
        var originalDisplayDialogs = app.displayDialogs;
        try {
            app.displayDialogs = DialogModes.NO;

            // Do not write size/color/position/alignment back here. In some PSDs,
            // Photoshop recomposes transformed type layers when those setters run.
            if (yaHeiFontName) {
                textItem.font = yaHeiFontName;
            }

            textItem.contents = String(translatedText);
        } finally {
            app.displayDialogs = originalDisplayDialogs;
        }
    }

    function applyFontOnly(layer, yaHeiFontName) {
        var originalDisplayDialogs = app.displayDialogs;
        try {
            app.displayDialogs = DialogModes.NO;
            layer.textItem.font = yaHeiFontName;
        } finally {
            app.displayDialogs = originalDisplayDialogs;
        }
    }

    function runPythonTranslation(jsonFile, progressWindow, runToken) {
        var scriptFolder = getScriptFolder();
        var pythonScript = new File(scriptFolder.fsName + "/" + PYTHON_SCRIPT_NAME);
        var configFile = new File(scriptFolder.fsName + "/" + CONFIG_FILE_NAME);
        var exitCodeFile = getExitCodeFile(runToken);
        var progressFile = getProgressFile(runToken);
        var runnerBatFile = getRunnerBatFile(runToken);
        var runnerVbsFile = getRunnerVbsFile(runToken);

        if (!pythonScript.exists) {
            throw new Error("Python script was not found: " + pythonScript.fsName);
        }
        if (!configFile.exists) {
            throw new Error("config.json was not found: " + configFile.fsName);
        }

        try {
            if (exitCodeFile.exists) {
                exitCodeFile.remove();
            }
            if (progressFile.exists) {
                progressFile.remove();
            }
        } catch (removeOldExitCodeError) {
            log("Could not remove old temp status file: " + removeOldExitCodeError);
        }

        var pythonArgs = quoteArg(pythonScript.fsName) +
            " --json " + quoteArg(jsonFile.fsName) +
            " --config " + quoteArg(configFile.fsName) +
            " --progress " + quoteArg(progressFile.fsName);

        if (DEBUG) {
            pythonArgs += " --debug";
        }
        if (DRY_RUN) {
            pythonArgs += " --dry-run";
        }

        var batLines = [];
        batLines.push("@echo off");
        batLines.push("setlocal");
        batLines.push("cd /d " + quoteArg(scriptFolder.fsName));
        batLines.push("where py >nul 2>nul");
        batLines.push("if \"%ERRORLEVEL%\"==\"0\" goto use_py");
        batLines.push("where python >nul 2>nul");
        batLines.push("if not \"%ERRORLEVEL%\"==\"0\" goto no_python");
        batLines.push("  python " + pythonArgs);
        batLines.push("  set \"PST_EXIT=%ERRORLEVEL%\"");
        batLines.push("  goto done");
        batLines.push(":use_py");
        batLines.push("  py -3 " + pythonArgs);
        batLines.push("  set \"PST_EXIT=%ERRORLEVEL%\"");
        batLines.push("  goto done");
        batLines.push(":no_python");
        batLines.push("  set \"PST_EXIT=9009\"");
        batLines.push(":done");
        batLines.push("echo %PST_EXIT% > " + quoteArg(exitCodeFile.fsName));
        batLines.push("exit /b %PST_EXIT%");

        writeTextFile(runnerBatFile, batLines.join("\r\n") + "\r\n");

        var vbsLines = [];
        vbsLines.push("Set shell = CreateObject(\"WScript.Shell\")");
        vbsLines.push("shell.Run \"\"\"\" & " + quoteVbsString(runnerBatFile.fsName) + " & \"\"\"\", 0, False");
        writeTextFile(runnerVbsFile, vbsLines.join("\r\n") + "\r\n");

        var command = "wscript.exe " + quoteArg(runnerVbsFile.fsName);
        log("Running hidden Python translation via: " + runnerVbsFile.fsName);

        try {
            setProgressTarget(
                progressWindow,
                PROGRESS_TRANSLATE_START,
                "Starting Python translation...",
                0,
                countTextLayersInJsonFile(jsonFile),
                null,
                true
            );
            app.system(command);

            waitForPythonProcess(exitCodeFile, progressFile, progressWindow);

            var exitText = readTextFile(exitCodeFile).replace(/^\s+|\s+$/g, "");
            var exitCode = Number(exitText);
            if (isNaN(exitCode)) {
                log("Could not parse Python exit code: " + exitText);
                return 1;
            }

            log("Python translation exit code: " + exitCode);
            return exitCode;
        } finally {
            cleanupPythonRunnerFiles(exitCodeFile, runnerBatFile, runnerVbsFile, progressFile);
        }
    }

    function applyTranslatedText(doc, jsonFile, progressWindow) {
        var payload = readJson(jsonFile);
        var meta = payload.meta || {};
        assertDocumentMatches(meta, doc);
        var debug = meta.debug === true;
        var dryRun = meta.dryRun === true;
        var yaHeiFontName = findMicrosoftYaHeiFont();

        if (!yaHeiFontName && !dryRun) {
            alert("Microsoft YaHei was not found in Photoshop fonts.\nTranslated text will be applied, but fonts will not be forced.");
            log("Microsoft YaHei font was not found. Font replacement disabled.");
        }

        var layerMap = {};
        collectTextLayerMap(doc, layerMap);

        var applied = 0;
        var fontOnly = 0;
        var skipped = 0;
        var failed = 0;
        var hadLayerErrors = false;
        var layers = payload.layers || [];
        var appliedLayerIds = {};
        var appliedTargetLayerIds = {};

        setProgressTarget(
            progressWindow,
            PROGRESS_APPLY_START,
            "Preparing to replace text layers...",
            0,
            layers.length,
            null,
            true
        );

        for (var i = 0; i < layers.length; i++) {
            var item = layers[i];
            var layerId = String(item.layerId);
            var shouldApplyFontOnly = item.status === "skipped" && !dryRun && !!yaHeiFontName &&
                (item.skipReason === "empty_text" || item.skipReason === "non_translatable");

            if (item.status !== "translated" && !shouldApplyFontOnly) {
                skipped++;
                if (item.status === "error" || item.status === "apply_error" || item.error) {
                    hadLayerErrors = true;
                }
                setProgressTarget(
                    progressWindow,
                    mapRange(i + 1, 0, layers.length, PROGRESS_APPLY_START, PROGRESS_APPLY_END),
                    "Skipping text layer: " + (item.layerName || layerId),
                    i + 1,
                    layers.length,
                    null,
                    false
                );
                continue;
            }

            if (dryRun) {
                skipped++;
                item.status = "dry-run";
                setProgressTarget(
                    progressWindow,
                    mapRange(i + 1, 0, layers.length, PROGRESS_APPLY_START, PROGRESS_APPLY_END),
                    "Dry-run checked text layer: " + (item.layerName || layerId),
                    i + 1,
                    layers.length,
                    null,
                    false
                );
                continue;
            }

            if (!shouldApplyFontOnly && typeof item.translatedText !== "string") {
                failed++;
                hadLayerErrors = true;
                item.status = "apply_error";
                item.error = "translatedText must be a string.";
                log("Invalid translatedText for layer " + layerId + ".");
                setProgressTarget(
                    progressWindow,
                    mapRange(i + 1, 0, layers.length, PROGRESS_APPLY_START, PROGRESS_APPLY_END),
                    "Skipping invalid translation: " + (item.layerName || layerId),
                    i + 1,
                    layers.length,
                    null,
                    false
                );
                continue;
            }

            var layer = layerMap[layerId];
            if (!layer) {
                failed++;
                hadLayerErrors = true;
                item.status = "apply_error";
                item.error = "Layer not found in active document.";
                log("Layer not found: " + layerId + " (" + item.layerPath + ")");
                setProgressTarget(
                    progressWindow,
                    mapRange(i + 1, 0, layers.length, PROGRESS_APPLY_START, PROGRESS_APPLY_END),
                    "Text layer not found: " + (item.layerName || layerId),
                    i + 1,
                    layers.length,
                    null,
                    false
                );
                continue;
            }

            var targetLayerId = "";
            try {
                targetLayerId = String(getLayerId(layer));
            } catch (targetIdError) {
                failed++;
                item.status = "apply_error";
                item.error = "Could not verify target layerId: " + targetIdError;
                hadLayerErrors = true;
                log("Could not verify target layerId for " + layerId + " (" + item.layerPath + "): " + targetIdError);
                setProgressTarget(
                    progressWindow,
                    mapRange(i + 1, 0, layers.length, PROGRESS_APPLY_START, PROGRESS_APPLY_END),
                    "Skipping unverifiable text layer: " + (item.layerName || layerId),
                    i + 1,
                    layers.length,
                    null,
                    false
                );
                continue;
            }
            if (targetLayerId !== layerId) {
                failed++;
                item.status = "apply_error";
                item.error = "Layer mapping mismatch. Expected layerId " + layerId + ", got " + targetLayerId + ".";
                hadLayerErrors = true;
                log("Layer mapping mismatch: expected " + layerId + ", got " + targetLayerId + " (" + item.layerPath + ")");
                setProgressTarget(
                    progressWindow,
                    mapRange(i + 1, 0, layers.length, PROGRESS_APPLY_START, PROGRESS_APPLY_END),
                    "Skipping mismatched text layer: " + (item.layerName || layerId),
                    i + 1,
                    layers.length,
                    null,
                    false
                );
                continue;
            }

            if (appliedLayerIds[layerId]) {
                failed++;
                item.status = "apply_error";
                item.error = "Duplicate layerId was already applied in this run.";
                hadLayerErrors = true;
                log("Duplicate layerId skipped during apply: " + layerId + " (" + item.layerPath + ")");
                setProgressTarget(
                    progressWindow,
                    mapRange(i + 1, 0, layers.length, PROGRESS_APPLY_START, PROGRESS_APPLY_END),
                    "Skipping duplicate text layer: " + (item.layerName || layerId),
                    i + 1,
                    layers.length,
                    null,
                    false
                );
                continue;
            }

            if (appliedTargetLayerIds[targetLayerId]) {
                failed++;
                item.status = "apply_error";
                item.error = "Target Photoshop layer was already applied in this run.";
                hadLayerErrors = true;
                log("Duplicate target layer skipped during apply: " + targetLayerId + " (" + item.layerPath + ")");
                setProgressTarget(
                    progressWindow,
                    mapRange(i + 1, 0, layers.length, PROGRESS_APPLY_START, PROGRESS_APPLY_END),
                    "Skipping duplicate target layer: " + (item.layerName || layerId),
                    i + 1,
                    layers.length,
                    null,
                    false
                );
                continue;
            }

            try {
                if (shouldApplyFontOnly) {
                    applyFontOnly(layer, yaHeiFontName);
                    item.status = "font_applied";
                    fontOnly++;
                } else {
                    applyText(layer, item.translatedText, yaHeiFontName);
                    item.status = "applied";
                    applied++;
                }
                item.error = "";
                appliedLayerIds[layerId] = true;
                appliedTargetLayerIds[targetLayerId] = true;
            } catch (e) {
                failed++;
                hadLayerErrors = true;
                item.status = "apply_error";
                item.error = String(e);
                log("Failed applying layer " + layerId + ": " + e);
            }
            setProgressTarget(
                progressWindow,
                mapRange(i + 1, 0, layers.length, PROGRESS_APPLY_START, PROGRESS_APPLY_END),
                (shouldApplyFontOnly ? "Updating font: " : "Replacing text layer: ") +
                    (item.layerName || layerId),
                i + 1,
                layers.length,
                null,
                false
            );
        }

        meta.appliedAt = isoNow();
        meta.appliedCount = applied;
        meta.fontOnlyCount = fontOnly;
        meta.skippedCount = skipped;
        meta.applyErrorCount = failed;
        payload.meta = meta;

        try {
            writeJson(jsonFile, payload);
        } catch (writeError) {
            log("Failed writing apply status JSON: " + writeError);
        }

        if (!debug && !dryRun && failed === 0 && !hadLayerErrors) {
            try {
                if (jsonFile.exists && !jsonFile.remove()) {
                    log("Could not remove temp JSON: " + jsonFile.fsName);
                } else {
                    log("Removed temp JSON: " + jsonFile.fsName);
                }
            } catch (removeError) {
                log("Temp JSON removal failed: " + removeError);
            }
        } else {
            log("Kept temp JSON for debug/dry-run/errors: " + jsonFile.fsName);
        }

        return {
            applied: applied,
            fontOnly: fontOnly,
            skipped: skipped,
            failed: failed,
            hadLayerErrors: hadLayerErrors,
            translationSummary: meta.translationSummary || null
        };
    }

    function buildSummaryMessage(exportedCount, pythonExitCode, applyResult, jsonFile, totalSeconds) {
        var lines = [];
        lines.push("PSTranslate complete.");
        lines.push("Total time: " + formatDuration(totalSeconds));
        lines.push("Exported text layers: " + exportedCount);
        lines.push("Python exit code: " + pythonExitCode);

        if (applyResult.translationSummary) {
            lines.push("Translated: " + applyResult.translationSummary.translated);
            lines.push("Translation skipped: " + applyResult.translationSummary.skipped);
            lines.push("Translation failed: " + applyResult.translationSummary.failed);
        }

        lines.push("Applied: " + applyResult.applied);
        lines.push("Font-only updated: " + applyResult.fontOnly);
        lines.push("Apply skipped: " + applyResult.skipped);
        lines.push("Apply failed: " + applyResult.failed);

        if (DEBUG || DRY_RUN || applyResult.failed > 0 || applyResult.hadLayerErrors || pythonExitCode !== 0) {
            lines.push("");
            lines.push("Temporary JSON was kept:");
            lines.push(jsonFile.fsName);
            lines.push("");
            lines.push("Logs:");
            lines.push(getLogFile().fsName);
            lines.push(new File(getScriptFolder().fsName + "/logs/ps_text_translate.log").fsName);
        }

        return lines.join("\n");
    }

    function main() {
        if (!app.documents.length) {
            alert("No Photoshop document is open.");
            return;
        }

        var doc = app.activeDocument;
        var originalRulerUnits = app.preferences.rulerUnits;
        var originalActiveLayer = doc.activeLayer;
        var runToken = createRunToken();
        var jsonFile = getDefaultJsonFile(runToken);
        var startedAt = new Date().getTime();
        var progressWindow = null;

        try {
            app.preferences.rulerUnits = Units.PIXELS;

            progressWindow = createProgressWindow(0);
            setProgressTarget(progressWindow, 0, "Scanning active document...", 0, 0, null, true);
            var totalTextLayers = countTextLayers(doc);
            setProgressTarget(
                progressWindow,
                PROGRESS_SCAN_END,
                "Found " + totalTextLayers + " text layer(s).",
                0,
                totalTextLayers,
                null,
                true
            );

            var exportedCount = exportDocumentText(doc, jsonFile, progressWindow, totalTextLayers);
            if (exportedCount === 0) {
                closeProgressWindow(progressWindow);
                progressWindow = null;
                removeTempFile(jsonFile, "empty translation JSON");
                alert("No text layers were found in the active document.");
                return;
            }

            var pythonExitCode = runPythonTranslation(jsonFile, progressWindow, runToken);
            if (!jsonFile.exists) {
                throw new Error("Translation JSON disappeared after Python run: " + jsonFile.fsName);
            }
            if (pythonExitCode === 9009) {
                throw new Error("Python 3 was not found. Install Python 3.8 or newer and try again.");
            }
            if (pythonExitCode !== 0 && pythonExitCode !== 3) {
                throw new Error("Python translation failed before usable layer results were produced. Exit code: " + pythonExitCode);
            }

            var applyResult = applyTranslatedText(doc, jsonFile, progressWindow);
            var totalSeconds = elapsedSecondsSince(startedAt);
            setProgressTarget(
                progressWindow,
                PROGRESS_APPLY_END,
                "PSTranslate complete.",
                exportedCount,
                exportedCount,
                0,
                true
            );
            $.sleep(300);
            closeProgressWindow(progressWindow);
            progressWindow = null;
            log("One-click finished. Exported=" + exportedCount +
                ", pythonExitCode=" + pythonExitCode +
                ", applied=" + applyResult.applied +
                ", fontOnly=" + applyResult.fontOnly +
                ", skipped=" + applyResult.skipped +
                ", failed=" + applyResult.failed +
                ", elapsed=" + formatDuration(totalSeconds));
            alert(buildSummaryMessage(exportedCount, pythonExitCode, applyResult, jsonFile, totalSeconds));
        } catch (e) {
            var failureSeconds = elapsedSecondsSince(startedAt);
            if (progressWindow) {
                setProgressTarget(progressWindow, progressWindow.displayPercent, "PSTranslate failed.", 0, 0, 0, true);
                $.sleep(150);
                closeProgressWindow(progressWindow);
                progressWindow = null;
            }
            log("One-click failed after " + formatDuration(failureSeconds) + ": " + e);
            alert("PSTranslate failed:\n" + e +
                "\n\nElapsed: " + formatDuration(failureSeconds) +
                "\n\nTemporary JSON, if created:\n" + jsonFile.fsName +
                "\n\nLog:\n" + getLogFile().fsName);
        } finally {
            closeProgressWindow(progressWindow);
            try {
                doc.activeLayer = originalActiveLayer;
            } catch (ignored) {
            }
            app.preferences.rulerUnits = originalRulerUnits;
        }
    }

    main();
}());
