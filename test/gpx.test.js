const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const gpxUrl = pathToFileURL(path.join(__dirname, "../public/gpx.js"));

/** Minimal document stub satisfying coordinatesFromDocument. */
function fakeDoc(tags) {
  return {
    getElementsByTagName: (tag) => tags[tag] || [],
  };
}

function fakePt(lat, lon) {
  return {
    getAttribute: (name) => (name === "lat" ? String(lat) : String(lon)),
  };
}

test("coordinatesFromDocument prefers trackpoints over waypoints", async () => {
  const { coordinatesFromDocument } = await import(gpxUrl);
  const doc = fakeDoc({
    trkpt: [fakePt(-18.85, -159.78), fakePt(-19.05, -169.85)],
    rtept: [fakePt(0, 0)],
    wpt: [fakePt(10, 10)],
  });
  const { coordinates, source } = coordinatesFromDocument(doc);
  assert.equal(source, "trkpt");
  assert.deepEqual(coordinates, [
    { lat: -18.85, lon: -159.78 },
    { lat: -19.05, lon: -169.85 },
  ]);
});

test("coordinatesFromDocument falls back to rtept then wpt", async () => {
  const { coordinatesFromDocument } = await import(gpxUrl);
  const rte = coordinatesFromDocument(
    fakeDoc({ rtept: [fakePt(1, 2)], wpt: [fakePt(3, 4)] }),
  );
  assert.equal(rte.source, "rtept");
  const wpt = coordinatesFromDocument(fakeDoc({ wpt: [fakePt(3, 4)] }));
  assert.equal(wpt.source, "wpt");
  assert.deepEqual(wpt.coordinates, [{ lat: 3, lon: 4 }]);
});

test("coordinatesFromDocument drops invalid coordinates", async () => {
  const { coordinatesFromDocument } = await import(gpxUrl);
  const doc = fakeDoc({
    trkpt: [
      fakePt(91, 0),
      fakePt(0, 200),
      fakePt("NaN", 5),
      fakePt(-18.85, -159.78),
    ],
  });
  const { coordinates, source } = coordinatesFromDocument(doc);
  assert.equal(source, "trkpt");
  assert.equal(coordinates.length, 1);
  assert.deepEqual(coordinates, [{ lat: -18.85, lon: -159.78 }]);
});

test("coordinatesFromDocument returns empty for an empty document", async () => {
  const { coordinatesFromDocument } = await import(gpxUrl);
  assert.deepEqual(coordinatesFromDocument(fakeDoc({})), {
    coordinates: [],
    source: null,
  });
});

test("parseGpxText throws without a DOMParser (Node) but validates in browsers", async () => {
  const { parseGpxText } = await import(gpxUrl);
  // In Node the native DOMParser is absent; the error must be a clean
  // rejection, not a silent wrong answer.
  await assert.rejects(() => parseGpxText("<gpx/>"));
});
