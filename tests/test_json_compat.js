const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const source = fs.readFileSync("json_compat.jsx", "utf8");
const context = {};
vm.createContext(context);
vm.runInContext(source, context, { filename: "json_compat.jsx" });

const parse = context.PSTranslateJSON.parse;
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

console.log("json_compat.jsx tests passed");
