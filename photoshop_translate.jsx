#target photoshop

(function () {
    var TOOL_NAME = "PSTranslate";
    var JSON_FILE_NAME = "ps_text_layers.json";
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

    function getDefaultJsonFile() {
        return new File(getDataFolder().fsName + "/" + JSON_FILE_NAME);
    }

    function getExitCodeFile() {
        return new File(getDataFolder().fsName + "/python_exit_code.txt");
    }

    function getProgressFile() {
        return new File(getDataFolder().fsName + "/python_progress.json");
    }

    function getRunnerBatFile() {
        return new File(getDataFolder().fsName + "/run_ps_text_translate.bat");
    }

    function getRunnerVbsFile() {
        return new File(getDataFolder().fsName + "/run_ps_text_translate.vbs");
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

    function parseJson(text) {
        if (typeof JSON !== "undefined" && JSON.parse) {
            return JSON.parse(text);
        }
        return eval("(" + text + ")");
    }

    function readTextFile(file) {
        file.encoding = "UTF8";
        if (!file.open("r")) {
            throw new Error("Could not open file: " + file.fsName);
        }
        var text = file.read();
        file.close();
        return text;
    }

    function readJson(file) {
        return parseJson(readTextFile(file));
    }

    function writeJson(file, payload) {
        file.encoding = "UTF8";
        if (!file.open("w")) {
            throw new Error("Could not open JSON for writing: " + file.fsName);
        }
        file.write(jsonStringify(payload));
        file.close();
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
        file.write(text);
        file.close();
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

    function exportDocumentText(doc, jsonFile, progressWindow, totalTextLayers) {
        var layers = [];
        var progressState = {
            count: 0,
            total: totalTextLayers || 0
        };
        collectTextLayers(doc, [], layers, progressWindow, progressState);

        var payload = {
            meta: {
                schemaVersion: 1,
                tool: TOOL_NAME,
                documentName: doc.name,
                documentPath: getDocumentPath(doc),
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

    function captureTextItemState(textItem) {
        var state = {};
        try {
            state.size = textItem.size;
            state.hasSize = true;
        } catch (e1) {
        }
        try {
            state.color = textItem.color;
            state.hasColor = true;
        } catch (e2) {
        }
        try {
            state.position = textItem.position;
            state.hasPosition = true;
        } catch (e3) {
        }
        try {
            state.justification = textItem.justification;
            state.hasJustification = true;
        } catch (e4) {
        }
        try {
            state.width = textItem.width;
            state.hasWidth = true;
        } catch (e5) {
        }
        try {
            state.height = textItem.height;
            state.hasHeight = true;
        } catch (e6) {
        }
        return state;
    }

    function restoreTextItemState(textItem, state) {
        try {
            if (state.hasSize) {
                textItem.size = state.size;
            }
        } catch (e1) {
            log("Could not restore text size: " + e1);
        }
        try {
            if (state.hasColor) {
                textItem.color = state.color;
            }
        } catch (e2) {
            log("Could not restore text color: " + e2);
        }
        try {
            if (state.hasJustification) {
                textItem.justification = state.justification;
            }
        } catch (e3) {
            log("Could not restore text justification: " + e3);
        }
        try {
            if (state.hasWidth) {
                textItem.width = state.width;
            }
        } catch (e4) {
        }
        try {
            if (state.hasHeight) {
                textItem.height = state.height;
            }
        } catch (e5) {
        }
        try {
            if (state.hasPosition) {
                textItem.position = state.position;
            }
        } catch (e6) {
            log("Could not restore text position: " + e6);
        }
    }

    function applyText(layer, translatedText, yaHeiFontName) {
        var textItem = layer.textItem;
        var state = captureTextItemState(textItem);

        var originalDisplayDialogs = app.displayDialogs;
        try {
            app.displayDialogs = DialogModes.NO;

            if (yaHeiFontName) {
                try {
                    textItem.font = yaHeiFontName;
                } catch (fontError) {
                    log("Could not set Microsoft YaHei before editing text: " + fontError);
                }
            }

            textItem.contents = String(translatedText);
        } finally {
            restoreTextItemState(textItem, state);
            app.displayDialogs = originalDisplayDialogs;
        }
    }

    function runPythonTranslation(jsonFile, progressWindow) {
        var scriptFolder = getScriptFolder();
        var pythonScript = new File(scriptFolder.fsName + "/" + PYTHON_SCRIPT_NAME);
        var configFile = new File(scriptFolder.fsName + "/" + CONFIG_FILE_NAME);
        var exitCodeFile = getExitCodeFile();
        var progressFile = getProgressFile();
        var runnerBatFile = getRunnerBatFile();
        var runnerVbsFile = getRunnerVbsFile();

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
        batLines.push("  python " + pythonArgs);
        batLines.push("  set \"PST_EXIT=%ERRORLEVEL%\"");
        batLines.push("  goto done");
        batLines.push(":use_py");
        batLines.push("  py -3 " + pythonArgs);
        batLines.push("  set \"PST_EXIT=%ERRORLEVEL%\"");
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
        var skipped = 0;
        var failed = 0;
        var hadLayerErrors = false;
        var layers = payload.layers || [];

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

            if (item.status !== "translated") {
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

            var layer = layerMap[layerId];
            if (!layer) {
                failed++;
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

            try {
                applyText(layer, item.translatedText, yaHeiFontName);
                item.status = "applied";
                item.error = "";
                applied++;
            } catch (e) {
                failed++;
                item.status = "apply_error";
                item.error = String(e);
                log("Failed applying layer " + layerId + ": " + e);
            }
            setProgressTarget(
                progressWindow,
                mapRange(i + 1, 0, layers.length, PROGRESS_APPLY_START, PROGRESS_APPLY_END),
                "Replacing text layer: " + (item.layerName || layerId),
                i + 1,
                layers.length,
                null,
                false
            );
        }

        meta.appliedAt = isoNow();
        meta.appliedCount = applied;
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
        var jsonFile = getDefaultJsonFile();
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
                alert("No text layers were found in the active document.");
                return;
            }

            var pythonExitCode = runPythonTranslation(jsonFile, progressWindow);
            if (!jsonFile.exists) {
                throw new Error("Translation JSON disappeared after Python run: " + jsonFile.fsName);
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
