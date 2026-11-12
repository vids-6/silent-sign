// Run from the project root:  node tests/suggest.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { partialWord, suggest } = require("../js/suggest.js");

// load the real word list the app ships
const src = fs.readFileSync(path.join(__dirname, "..", "js", "words.js"), "utf8");
const sandbox = { window: {} };
new Function("window", src)(sandbox.window);
const WORDS = sandbox.window.SILENT_SIGN_WORDS;

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok -", name); }

test("word list is uppercase letters only, no duplicates", () => {
  assert.ok(WORDS.length > 5000);
  assert.ok(WORDS.every((w) => /^[A-Z]{2,15}$/.test(w)));
  assert.strictEqual(new Set(WORDS).size, WORDS.length);
});
test("offensive words are filtered out", () => {
  for (const w of ["FUCK", "SHIT", "BITCH"]) assert.ok(!WORDS.includes(w), w);
});
test("partialWord takes the letters after the last space", () => {
  assert.strictEqual(partialWord("I NEED HE"), "HE");
  assert.strictEqual(partialWord("HELLO "), "");
  assert.strictEqual(partialWord(""), "");
});
test("suggestions start with the prefix and are longer than it", () => {
  const s = suggest(WORDS, "HE", 3);
  assert.strictEqual(s.length, 3);
  assert.ok(s.every((w) => w.startsWith("HE") && w.length > 2));
});
test("most frequent words come first", () => {
  assert.deepStrictEqual(suggest(WORDS, "TH", 2), ["THE", "THAT"]);
});
test("HELLO and THANKS are reachable", () => {
  assert.ok(suggest(WORDS, "HELL", 3).includes("HELLO"));
  assert.ok(suggest(WORDS, "THANK", 3).includes("THANKS"));
});
test("empty prefix or no match gives nothing", () => {
  assert.deepStrictEqual(suggest(WORDS, "", 3), []);
  assert.deepStrictEqual(suggest(WORDS, "QZX", 3), []);
});
console.log(`\n${passed} suggestion tests passed`);
