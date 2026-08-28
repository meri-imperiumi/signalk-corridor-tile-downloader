const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const { parseTargetCoordinate, targetLabel } = require("../public/target.js");

describe("parseTargetCoordinate", () => {
  test("parses valid decimal coordinates", () => {
    assert.deepEqual(parseTargetCoordinate("60.17", "24.94"), {
      lat: 60.17,
      lon: 24.94,
    });
  });

  test("accepts boundary and southern/eastern hemisphere values", () => {
    assert.deepEqual(parseTargetCoordinate("-90", "-180"), {
      lat: -90,
      lon: -180,
    });
    assert.deepEqual(parseTargetCoordinate("90", "180"), {
      lat: 90,
      lon: 180,
    });
    assert.deepEqual(parseTargetCoordinate("-18.85", "-159.78"), {
      lat: -18.85,
      lon: -159.78,
    });
  });

  test("tolerates surrounding whitespace", () => {
    assert.deepEqual(parseTargetCoordinate("  60.17  ", "  24.94"), {
      lat: 60.17,
      lon: 24.94,
    });
  });

  test("rejects out-of-range values", () => {
    assert.equal(parseTargetCoordinate("91", "0"), null);
    assert.equal(parseTargetCoordinate("-91", "0"), null);
    assert.equal(parseTargetCoordinate("0", "181"), null);
    assert.equal(parseTargetCoordinate("0", "-181"), null);
  });

  test("rejects missing or non-numeric input", () => {
    assert.equal(parseTargetCoordinate("", "24.94"), null);
    assert.equal(parseTargetCoordinate("60.17", ""), null);
    assert.equal(parseTargetCoordinate("abc", "24.94"), null);
    assert.equal(parseTargetCoordinate("NaN", "24.94"), null);
    assert.equal(parseTargetCoordinate(null, "24.94"), null);
    assert.equal(parseTargetCoordinate(undefined, undefined), null);
  });
});

describe("targetLabel", () => {
  test("formats a coordinate as a job name", () => {
    assert.equal(
      targetLabel({ lat: 60.17, lon: 24.94 }),
      "Target 60.1700, 24.9400",
    );
  });

  test("keeps sign for southern/western coordinates", () => {
    assert.equal(
      targetLabel({ lat: -18.85, lon: -159.78 }),
      "Target -18.8500, -159.7800",
    );
  });
});
