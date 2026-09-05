const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  hemisphereText,
  parseTargetCoordinate,
  targetLabel,
} = require("../public/target.js");

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

  test("rejects partial parses and stray characters instead of truncating", () => {
    // parseFloat would silently accept these as truncated numbers,
    // targeting the wrong point on the chart
    assert.equal(parseTargetCoordinate("1.2.3", "24.94"), null);
    assert.equal(parseTargetCoordinate("60.17abc", "24.94"), null);
    assert.equal(parseTargetCoordinate("60,17", "24.94"), null);
    assert.equal(parseTargetCoordinate("60.17 ", "24 94"), null);
  });

  test("accepts exponent-free decimals in every plain shape", () => {
    assert.deepEqual(parseTargetCoordinate(".5", ".75"), {
      lat: 0.5,
      lon: 0.75,
    });
    assert.deepEqual(parseTargetCoordinate("60.", "24."), {
      lat: 60,
      lon: 24,
    });
    assert.deepEqual(parseTargetCoordinate("+60.17", "+24.94"), {
      lat: 60.17,
      lon: 24.94,
    });
    assert.equal(parseTargetCoordinate("1e2", "0"), null);
  });
});

describe("hemisphereText", () => {
  test("combines an unsigned magnitude with the hemisphere toggle", () => {
    assert.equal(hemisphereText("18.85", true), "-18.85");
    assert.equal(hemisphereText(" 24.94 ", false), "24.94");
    assert.equal(hemisphereText(" 159.78 ", true), "-159.78");
  });

  test("feeds parseTargetCoordinate from the toggled inputs", () => {
    assert.deepEqual(
      parseTargetCoordinate(
        hemisphereText("18.85", true),
        hemisphereText("159.78", true),
      ),
      { lat: -18.85, lon: -159.78 },
    );
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
