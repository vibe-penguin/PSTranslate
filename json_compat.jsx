(function (root) {
    if (root.PSTranslateJSON && root.PSTranslateJSON.parse) {
        return;
    }

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

    root.PSTranslateJSON = {
        parse: parse
    };
}(typeof $ !== "undefined" && $.global ? $.global : this));
