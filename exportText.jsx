#target photoshop

// Backward-compatible entry point for the old script name.
// The full implementation lives in photoshop_export.jsx.

(function () {
    var scriptFile = new File($.fileName);
    var exportFile = new File(scriptFile.parent.fsName + "/photoshop_export.jsx");
    if (!exportFile.exists) {
        alert("photoshop_export.jsx was not found next to exportText.jsx.");
        return;
    }
    $.evalFile(exportFile);
}());
