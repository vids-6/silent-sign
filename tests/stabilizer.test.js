// Run from the project root:  node tests/stabilizer.test.js
const assert = require("assert");
const Stabilizer = require("../js/stabilizer.js");

const FPS = 8, DT = 1000 / FPS;
function run(s, frames, t0 = 0) {
  const commits = []; let t = t0, last;
  for (const f of frames) { last = s.update(f, t); if (last.committed) commits.push(last.committed); t += DT; }
  return { commits, t, last };
}
const sign = (label, n, conf = true) => Array(n).fill({ hands: 1, label, accepted: conf });
const none = (n) => Array(n).fill({ hands: 0, label: null, accepted: false });
let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok -", name); }

test("steady hold commits exactly once", () => {
  const { commits } = run(new Stabilizer(), sign("A", 40));   // 5 s hold
  assert.deepStrictEqual(commits, ["A"]);
});
test("short flicker does not commit", () => {
  const { commits } = run(new Stabilizer(), sign("A", 4));    // 0.5 s
  assert.deepStrictEqual(commits, []);
});
test("uncertain frames never commit", () => {
  const { commits } = run(new Stabilizer(), sign("A", 40, false));
  assert.deepStrictEqual(commits, []);
});
test("repeat letter requires lowering hands", () => {
  const s = new Stabilizer();
  const { commits } = run(s, [...sign("L", 12), ...none(6), ...sign("L", 12)]);
  assert.deepStrictEqual(commits, ["L", "L"]);
});
test("a brief dropout shorter than release does not repeat", () => {
  const s = new Stabilizer();
  const { commits } = run(s, [...sign("L", 12), ...none(2), ...sign("L", 12)]);
  assert.deepStrictEqual(commits, ["L"]);
});
test("switching letters directly after a long hold is fast", () => {
  const s = new Stabilizer();
  const r1 = run(s, sign("A", 40));
  const frames = sign("B", 40); let t = r1.t, commitAt = null;
  frames.forEach((f, i) => { const o = s.update(f, t); if (o.committed) commitAt = i; t += DT; });
  assert.ok(commitAt !== null && commitAt * DT <= 1600, `B committed after ${commitAt * DT} ms`);
});
test("noisy but dominant stream still commits once", () => {
  const frames = [];
  for (let i = 0; i < 40; i++) frames.push(i % 5 === 4 ? { hands: 1, label: "Q", accepted: true } : { hands: 1, label: "D", accepted: true });
  const { commits } = run(new Stabilizer(), frames);
  assert.deepStrictEqual(commits, ["D"]);
});
test("an evenly split stream commits nothing", () => {
  const frames = [];
  for (let i = 0; i < 40; i++) frames.push({ hands: 1, label: i % 2 ? "M" : "N", accepted: true });
  assert.deepStrictEqual(run(new Stabilizer(), frames).commits, []);
});
test("hold time setting is respected", () => {
  const s = new Stabilizer({ holdMs: 1500 });
  assert.deepStrictEqual(run(s, sign("A", 10)).commits, []);   // 1.25 s
  assert.deepStrictEqual(run(new Stabilizer({ holdMs: 1500 }), sign("A", 16)).commits, ["A"]);
});
console.log(`\n${passed} stabilizer tests passed`);
