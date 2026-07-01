#target photoshop

(function () {
    var TOOL_NAME = "PSTranslate";
    var JSON_FILE_NAME = "ps_text_layers.json";
    var PYTHON_SCRIPT_NAME = "ps_text_translate.py";
    var CONFIG_FILE_NAME = "config.json";

    var DEBUG = false;
    var DRY_RUN = false;

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

    function getRunnerBatFile() {
        return new File(getDataFolder().fsName + "/run_ps_text_translate.bat");
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

    function collectTextLayers(container, pathParts, result) {
        for (var i = 0; i < container.layers.length; i++) {
            var layer = container.layers[i];
            if (layer.typename === "LayerSet") {
                var nextPath = [];
                for (var p = 0; p < pathParts.length; p++) {
                    nextPath.push(pathParts[p]);
                }
                nextPath.push(layer.name);
                collectTextLayers(layer, nextPath, result);
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

    function exportDocumentText(doc, jsonFile) {
        var layers = [];
        collectTextLayers(doc, [], layers);

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
        textItem.contents = String(translatedText);
        if (yaHeiFontName) {
            textItem.font = yaHeiFontName;
        }
        restoreTextItemState(textItem, state);
    }

    function runPythonTranslation(jsonFile) {
        var scriptFolder = getScriptFolder();
        var pythonScript = new File(scriptFolder.fsName + "/" + PYTHON_SCRIPT_NAME);
        var configFile = new File(scriptFolder.fsName + "/" + CONFIG_FILE_NAME);
        var exitCodeFile = getExitCodeFile();
        var runnerBatFile = getRunnerBatFile();

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
        } catch (removeOldExitCodeError) {
            log("Could not remove old exit-code file: " + removeOldExitCodeError);
        }

        var pythonArgs = quoteArg(pythonScript.fsName) +
            " --json " + quoteArg(jsonFile.fsName) +
            " --config " + quoteArg(configFile.fsName);

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

        var command = "cmd.exe /c " + quoteArg(runnerBatFile.fsName);
        log("Running Python translation via: " + runnerBatFile.fsName);

        app.system(command);

        if (!waitForFile(exitCodeFile, 5000)) {
            log("Python exit-code file was not created: " + exitCodeFile.fsName);
            return 1;
        }

        var exitText = readTextFile(exitCodeFile).replace(/^\s+|\s+$/g, "");
        var exitCode = Number(exitText);
        if (isNaN(exitCode)) {
            log("Could not parse Python exit code: " + exitText);
            return 1;
        }

        try {
            exitCodeFile.remove();
        } catch (removeExitCodeError) {
            log("Could not remove exit-code file: " + removeExitCodeError);
        }
        try {
            runnerBatFile.remove();
        } catch (removeRunnerError) {
            log("Could not remove runner bat file: " + removeRunnerError);
        }

        log("Python translation exit code: " + exitCode);
        return exitCode;
    }

    function applyTranslatedText(doc, jsonFile) {
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

        for (var i = 0; i < layers.length; i++) {
            var item = layers[i];
            var layerId = String(item.layerId);

            if (item.status !== "translated") {
                skipped++;
                if (item.status === "error" || item.status === "apply_error" || item.error) {
                    hadLayerErrors = true;
                }
                continue;
            }

            if (dryRun) {
                skipped++;
                item.status = "dry-run";
                continue;
            }

            var layer = layerMap[layerId];
            if (!layer) {
                failed++;
                item.status = "apply_error";
                item.error = "Layer not found in active document.";
                log("Layer not found: " + layerId + " (" + item.layerPath + ")");
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

    function buildSummaryMessage(exportedCount, pythonExitCode, applyResult, jsonFile) {
        var lines = [];
        lines.push("PSTranslate complete.");
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

        try {
            app.preferences.rulerUnits = Units.PIXELS;

            var exportedCount = exportDocumentText(doc, jsonFile);
            if (exportedCount === 0) {
                alert("No text layers were found in the active document.");
                return;
            }

            var pythonExitCode = runPythonTranslation(jsonFile);
            if (!jsonFile.exists) {
                throw new Error("Translation JSON disappeared after Python run: " + jsonFile.fsName);
            }
            if (pythonExitCode !== 0 && pythonExitCode !== 3) {
                throw new Error("Python translation failed before usable layer results were produced. Exit code: " + pythonExitCode);
            }

            var applyResult = applyTranslatedText(doc, jsonFile);
            log("One-click finished. Exported=" + exportedCount +
                ", pythonExitCode=" + pythonExitCode +
                ", applied=" + applyResult.applied +
                ", skipped=" + applyResult.skipped +
                ", failed=" + applyResult.failed);
            alert(buildSummaryMessage(exportedCount, pythonExitCode, applyResult, jsonFile));
        } catch (e) {
            log("One-click failed: " + e);
            alert("PSTranslate failed:\n" + e + "\n\nTemporary JSON, if created:\n" + jsonFile.fsName + "\n\nLog:\n" + getLogFile().fsName);
        } finally {
            try {
                doc.activeLayer = originalActiveLayer;
            } catch (ignored) {
            }
            app.preferences.rulerUnits = originalRulerUnits;
        }
    }

    main();
}());
