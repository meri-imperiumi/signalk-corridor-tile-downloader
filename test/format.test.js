const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const formatUrl = pathToFileURL(path.join(__dirname, "../public/format.js"));

test("formatSI scales values with ISO prefixes", async () => {
  const { formatSI } = await import(formatUrl);
  assert.equal(formatSI(45120000, "B"), "45.1 MB");
  assert.equal(formatSI(1200, "W"), "1.2 kW");
  assert.equal(formatSI(940), "940");
  assert.equal(formatSI(1500000, "Wh"), "1.5 MWh");
  assert.equal(formatSI(null), "—");
});

test("formatEta renders compact durations", async () => {
  const { formatEta } = await import(formatUrl);
  assert.equal(formatEta(null), "—");
  assert.equal(formatEta(42000), "42s");
  assert.equal(formatEta(754000), "12m 34s");
  assert.equal(formatEta(3900000), "1h 05m");
});

test("formatLocalTime renders local ship time without timezone", async () => {
  const { formatLocalTime } = await import(formatUrl);
  const d = new Date(2026, 8, 2, 14, 30);
  assert.equal(formatLocalTime(d), "2026-09-02 14:30");
  assert.equal(formatLocalTime(d.getTime()), "2026-09-02 14:30");
});
