#target photoshop

(function () {
    var JSON_FILE_NAME = "ps_text_layers.json";
    var JSON_COMPAT_SCRIPT_NAME = "json_compat.jsx";

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
            file.writeln(isoNow() + " [apply] " + message);
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

        var globalObject = null;
        try {
            globalObject = $.global;
        } catch (globalError) {
            globalObject = this;
        }
        if (!globalObject) {
            globalObject = this;
        }

        if (!globalObject.PSTranslateJSON || !globalObject.PSTranslateJSON.parse) {
            var parserFile = new File(getScriptFolder().fsName + "/" + JSON_COMPAT_SCRIPT_NAME);
            if (!parserFile.exists) {
                throw new Error("JSON compatibility parser was not found: " + parserFile.fsName);
            }
            $.evalFile(parserFile);
        }

        if (!globalObject.PSTranslateJSON || !globalObject.PSTranslateJSON.parse) {
            throw new Error("Could not load the JSON compatibility parser.");
        }
        return globalObject.PSTranslateJSON.parse(text);
    }

    function readJson(file) {
        file.encoding = "UTF8";
        if (!file.open("r")) {
            throw new Error("Could not open JSON: " + file.fsName);
        }
        try {
            return parseJson(file.read());
        } finally {
            file.close();
        }
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

    function main() {
        if (!app.documents.length) {
            alert("No Photoshop document is open.");
            return;
        }

        var jsonFile = getDefaultJsonFile();
        if (!jsonFile.exists) {
            alert("Translation JSON was not found:\n" + jsonFile.fsName + "\n\nRun photoshop_export.jsx first, then run_translate.bat.");
            return;
        }

        var doc = app.activeDocument;
        var originalActiveLayer = doc.activeLayer;
        var payload;

        try {
            payload = readJson(jsonFile);
        } catch (e) {
            log("Failed reading JSON: " + e);
            alert("Could not read translation JSON:\n" + e);
            return;
        }

        var meta = payload.meta || {};
        try {
            assertDocumentMatches(meta, doc);
        } catch (documentError) {
            log("Document validation failed: " + documentError);
            alert("Translation JSON does not match the active document:\n" + documentError);
            return;
        }
        var debug = meta.debug === true;
        var dryRun = meta.dryRun === true;
        var yaHeiFontName = findMicrosoftYaHeiFont();

        if (!yaHeiFontName && !dryRun) {
            alert("Microsoft YaHei was not found in Photoshop fonts.\nTranslated text will be applied, but fonts will not be forced.");
            log("Microsoft YaHei font was not found. Font replacement disabled.");
        }

        var layerMap = {};
        try {
            collectTextLayerMap(doc, layerMap);
        } catch (e2) {
            log("Failed building layer map: " + e2);
            alert("Could not inspect Photoshop layers:\n" + e2);
            return;
        }

        var applied = 0;
        var fontOnly = 0;
        var skipped = 0;
        var failed = 0;
        var hadLayerErrors = false;
        var layers = payload.layers || [];
        var appliedLayerIds = {};
        var appliedTargetLayerIds = {};

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
                continue;
            }

            if (dryRun) {
                skipped++;
                item.status = "dry-run";
                continue;
            }

            if (!shouldApplyFontOnly && typeof item.translatedText !== "string") {
                failed++;
                hadLayerErrors = true;
                item.status = "apply_error";
                item.error = "translatedText must be a string.";
                log("Invalid translatedText for layer " + layerId + ".");
                continue;
            }

            var layer = layerMap[layerId];
            if (!layer) {
                failed++;
                hadLayerErrors = true;
                item.status = "apply_error";
                item.error = "Layer not found in active document.";
                log("Layer not found: " + layerId + " (" + item.layerPath + ")");
                continue;
            }

            var targetLayerId = "";
            try {
                targetLayerId = String(getLayerId(layer));
            } catch (targetIdError) {
                failed++;
                hadLayerErrors = true;
                item.status = "apply_error";
                item.error = "Could not verify target layerId: " + targetIdError;
                log("Could not verify target layerId for " + layerId + ": " + targetIdError);
                continue;
            }

            if (targetLayerId !== layerId) {
                failed++;
                hadLayerErrors = true;
                item.status = "apply_error";
                item.error = "Layer mapping mismatch. Expected layerId " + layerId + ", got " + targetLayerId + ".";
                log("Layer mapping mismatch: expected " + layerId + ", got " + targetLayerId + ".");
                continue;
            }

            if (appliedLayerIds[layerId] || appliedTargetLayerIds[targetLayerId]) {
                failed++;
                hadLayerErrors = true;
                item.status = "apply_error";
                item.error = "Duplicate layerId or target layer in translation JSON.";
                log("Duplicate layer mapping skipped: " + layerId + ".");
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
            } catch (e3) {
                failed++;
                hadLayerErrors = true;
                item.status = "apply_error";
                item.error = String(e3);
                log("Failed applying layer " + layerId + ": " + e3);
            }
        }

        meta.appliedAt = isoNow();
        meta.appliedCount = applied;
        meta.fontOnlyCount = fontOnly;
        meta.skippedCount = skipped;
        meta.applyErrorCount = failed;
        payload.meta = meta;

        try {
            writeJson(jsonFile, payload);
        } catch (e4) {
            log("Failed writing apply status JSON: " + e4);
        }

        try {
            doc.activeLayer = originalActiveLayer;
        } catch (ignored) {
        }

        if (!debug && !dryRun && failed === 0 && !hadLayerErrors) {
            try {
                if (jsonFile.exists && !jsonFile.remove()) {
                    log("Could not remove temp JSON: " + jsonFile.fsName);
                } else {
                    log("Removed temp JSON: " + jsonFile.fsName);
                }
            } catch (e5) {
                log("Temp JSON removal failed: " + e5);
            }
        } else {
            log("Kept temp JSON for debug/dry-run/errors: " + jsonFile.fsName);
        }

        log("Apply finished. Applied=" + applied + ", fontOnly=" + fontOnly +
            ", skipped=" + skipped + ", failed=" + failed);
        alert("Apply complete.\nApplied: " + applied + "\nFont-only updated: " + fontOnly +
            "\nSkipped: " + skipped + "\nFailed: " + failed);
    }

    main();
}());
