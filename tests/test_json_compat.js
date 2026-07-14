const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const START_MARKER = "    // PST_JSON_COMPAT_START\n";
const END_MARKER = "    // PST_JSON_COMPAT_END";

function extractParser(filePath) {
    const source = fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
    const start = source.indexOf(START_MARKER);
    const end = source.indexOf(END_MARKER);
    assert.notStrictEqual(start, -1, `Parser start marker missing in ${filePath}`);
    assert.notStrictEqual(end, -1, `Parser end marker missing in ${filePath}`);
    return source.slice(start + START_MARKER.length, end).trim();
}

function loadParser(source, filePath) {
    const context = {};
    vm.createContext(context);
    vm.runInContext(
        source + "\nthis.PSTranslateJSON = createJsonCompatParser();",
        context,
        { filename: filePath }
    );
    return context.PSTranslateJSON.parse;
}

function testParser(parse) {
    const sample = "\uFEFF" + JSON.stringify({
        meta: {
            done: true,
            percent: 75.5,
            etaSeconds: null
        },
        layers: [
            {
                layerId: 123,
                translatedText: "中文\\n{0}\t\uD83D\uDE00"
            }
        ]
    });

    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(parse(sample))),
        JSON.parse(sample.slice(1))
    );
    assert.throws(() => parse('{"a":1,}'), /Invalid JSON/);
    assert.throws(() => parse('{"a":1,"a":2}'), /Duplicate object key/);
    assert.throws(() => parse('{"__proto__":{}}'), /Unsafe object key/);
    assert.throws(() => parse('{"value":(function(){return 1;}())}'), /Invalid JSON/);
}

const applyParser = extractParser("photoshop_apply.jsx");
const translateParser = extractParser("photoshop_translate.jsx");
assert.strictEqual(applyParser, translateParser, "Embedded JSON parsers must remain identical.");

testParser(loadParser(applyParser, "photoshop_apply.jsx"));
testParser(loadParser(translateParser, "photoshop_translate.jsx"));

console.log("embedded JSON compatibility parser tests passed");
