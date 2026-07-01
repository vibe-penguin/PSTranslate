#target photoshop

(function () {
    var TOOL_NAME = "PSTranslate";
    var JSON_FILE_NAME = "ps_text_layers.json";

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
            file.writeln(isoNow() + " [export] " + message);
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

    function getDocumentPath(doc) {
        try {
            return doc.fullName.fsName;
        } catch (e) {
            return "";
        }
    }

    function writeJson(file, payload) {
        file.encoding = "UTF8";
        if (!file.open("w")) {
            throw new Error("Could not open JSON for writing: " + file.fsName);
        }
        file.write(jsonStringify(payload));
        file.close();
    }

    function main() {
        if (!app.documents.length) {
            alert("No Photoshop document is open.");
            return;
        }

        var doc = app.activeDocument;
        var originalRulerUnits = app.preferences.rulerUnits;
        var originalActiveLayer = doc.activeLayer;

        try {
            app.preferences.rulerUnits = Units.PIXELS;

            var layers = [];
            collectTextLayers(doc, [], layers);

            var jsonFile = getDefaultJsonFile();
            var payload = {
                meta: {
                    schemaVersion: 1,
                    tool: TOOL_NAME,
                    documentName: doc.name,
                    documentPath: getDocumentPath(doc),
                    exportedAt: isoNow(),
                    tempJson: jsonFile.fsName,
                    debug: false,
                    dryRun: false,
                    photoshopVersion: app.version
                },
                layers: layers
            };

            writeJson(jsonFile, payload);
            log("Exported " + layers.length + " text layer(s) to " + jsonFile.fsName);
            alert("Export complete.\nText layers: " + layers.length + "\nJSON: " + jsonFile.fsName);
        } catch (e) {
            log("Export failed: " + e);
            alert("Export failed:\n" + e);
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
