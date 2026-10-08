"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const {
  formatCompactCountdown,
  formatTrayQuotaLine,
  formatTrayTaskLine,
  createTrayIcon,
  trayIconPaths
} = require("../../ElectronApp/tray-icon");

const resourcesDirectory = path.resolve(__dirname, "../../Resources");
const trayPaths = trayIconPaths(resourcesDirectory);
const compactPaths = trayIconPaths(resourcesDirectory, "quota-star");
assert.equal(createTrayIcon(resourcesDirectory, "quota-star"), compactPaths.oneX);
assert.throws(() => trayIconPaths(resourcesDirectory, "unknown"), /Unknown/);

function pngSize(buffer) {
  assert.deepEqual([...buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
}

function alphaValues(buffer) {
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  assert.equal(buffer[24], 8, "tray PNG must use 8-bit channels");
  assert.equal(buffer[25], 6, "tray PNG must be RGBA");
  const chunks = [];
  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "IDAT") chunks.push(buffer.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(chunks));
  const rowBytes = width * 4;
  const decoded = Buffer.alloc(rowBytes * height);
  const paeth = (left, above, upperLeft) => {
    const estimate = left + above - upperLeft;
    const leftDistance = Math.abs(estimate - left);
    const aboveDistance = Math.abs(estimate - above);
    const upperLeftDistance = Math.abs(estimate - upperLeft);
    if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
    return aboveDistance <= upperLeftDistance ? above : upperLeft;
  };
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (rowBytes + 1)];
    for (let x = 0; x < rowBytes; x += 1) {
      const source = raw[y * (rowBytes + 1) + x + 1];
      const left = x >= 4 ? decoded[y * rowBytes + x - 4] : 0;
      const above = y > 0 ? decoded[(y - 1) * rowBytes + x] : 0;
      const upperLeft = y > 0 && x >= 4
        ? decoded[(y - 1) * rowBytes + x - 4]
        : 0;
      const predictor = filter === 1
        ? left
        : filter === 2
          ? above
          : filter === 3
            ? Math.floor((left + above) / 2)
            : filter === 4
              ? paeth(left, above, upperLeft)
              : 0;
      decoded[y * rowBytes + x] = (source + predictor) & 255;
    }
  }
  return {
    width,
    height,
    values: Array.from({ length: width * height }, (_, index) => decoded[index * 4 + 3]),
    alphaAt(x, y) {
      return decoded[(y * width + x) * 4 + 3];
    }
  };
}

function colorValues(buffer) {
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const chunks = [];
  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "IDAT") chunks.push(buffer.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(chunks));
  const rowBytes = width * 4;
  const decoded = Buffer.alloc(rowBytes * height);
  const paeth = (left, above, upperLeft) => {
    const estimate = left + above - upperLeft;
    const distances = [
      Math.abs(estimate - left),
      Math.abs(estimate - above),
      Math.abs(estimate - upperLeft)
    ];
    return distances[0] <= distances[1] && distances[0] <= distances[2]
      ? left
      : distances[1] <= distances[2] ? above : upperLeft;
  };
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (rowBytes + 1)];
    for (let x = 0; x < rowBytes; x += 1) {
      const source = raw[y * (rowBytes + 1) + x + 1];
      const left = x >= 4 ? decoded[y * rowBytes + x - 4] : 0;
      const above = y > 0 ? decoded[(y - 1) * rowBytes + x] : 0;
      const upperLeft = y > 0 && x >= 4
        ? decoded[(y - 1) * rowBytes + x - 4]
        : 0;
      const predictor = filter === 1
        ? left
        : filter === 2
          ? above
          : filter === 3
            ? Math.floor((left + above) / 2)
            : filter === 4
              ? paeth(left, above, upperLeft)
              : 0;
      decoded[y * rowBytes + x] = (source + predictor) & 255;
    }
  }
  return Array.from({ length: width * height }, (_, index) => [
    decoded[index * 4],
    decoded[index * 4 + 1],
    decoded[index * 4 + 2],
    decoded[index * 4 + 3]
  ]);
}

const trayArtwork = [
  fs.readFileSync(trayPaths.oneX),
  fs.readFileSync(trayPaths.twoX)
];
assert.equal(
  createTrayIcon(resourcesDirectory),
  trayPaths.oneX,
  "Electron must receive the base Template filename and associate its @2x representation"
);
assert.deepEqual(pngSize(trayArtwork[0]), [22, 22]);
assert.deepEqual(pngSize(trayArtwork[1]), [44, 44]);
for (const artwork of trayArtwork) {
  const alpha = alphaValues(artwork);
  const colors = colorValues(artwork);
  assert.equal(alpha.values[0], 0, "menu icon corner must be transparent");
  assert(alpha.values.some((value) => value >= 220), "menu icon must contain solid artwork");
  assert(
    alpha.values.filter((value) => value >= 128).length < alpha.values.length * 0.4,
    "menu icon must remain a compact transparent glyph without an app-icon tile"
  );
  assert(
    colors.every(([red, green, blue, alphaValue]) => alphaValue === 0 || (red === 0 && green === 0 && blue === 0)),
    "menu icon must be a monochrome macOS template mask"
  );
}
const retinaGlyph = alphaValues(trayArtwork[1]);
for (const [file, scale] of [[compactPaths.oneX, 1], [compactPaths.twoX, 2]]) {
  const data = fs.readFileSync(file);
  assert.deepEqual(pngSize(data), [9 * scale, 22 * scale]);
  const alpha = alphaValues(data);
  const colors = colorValues(data);
  assert.equal(alpha.values[0], 0);
  assert(alpha.values.filter(value => value >= 220).length >= 12 * scale * scale,
    "compact star must keep a solid, readable four-point silhouette");
  assert(colors.every(([r, g, b, a]) => a === 0 || (r === 0 && g === 0 && b === 0)),
    "compact star must use macOS template tinting");
  for (let y = 11 * scale; y < alpha.height; y += 1) {
    for (let x = 0; x < alpha.width; x += 1) {
      assert.equal(alpha.alphaAt(x, y), 0, "small star must stay at the quota's upper left");
    }
  }
}
const retinaColors = colorValues(trayArtwork[1]);
const retinaColorAt = (x, y) => retinaColors[y * 44 + x];
const centerPixel = retinaColorAt(22, 22);
assert(
  centerPixel[3] > 220
    && centerPixel[0] === 0
    && centerPixel[1] === 0
    && centerPixel[2] === 0,
  "menu icon must use the Logo's central AI star"
);
assert(
  retinaGlyph.alphaAt(24, 15) > 180
    && retinaGlyph.alphaAt(29, 24) > 180
    && retinaGlyph.alphaAt(19, 29) > 100
    && retinaGlyph.alphaAt(15, 19) > 180
    && retinaGlyph.alphaAt(22, 22) > 220
    && retinaGlyph.alphaAt(18, 17) === 0,
  "menu icon central AI star must use the broader additional +10° clockwise silhouette"
);
assert(
  retinaGlyph.alphaAt(21, 7) > 220,
  "menu 05 ring must remain continuous across the 12 o'clock origin"
);
assert(
  retinaGlyph.alphaAt(35, 8) === 0,
  "menu 05 ring must leave a clear upper-right opening"
);
assert(
  retinaGlyph.alphaAt(36, 20) > 180,
  "menu rotated ring must end with a precise clockwise-shifted cut"
);
assert(
  retinaGlyph.alphaAt(36, 22) > 220
    && retinaGlyph.alphaAt(22, 36) > 220
    && retinaGlyph.alphaAt(8, 22) > 120,
  "menu 05 ring must remain visible around the right, bottom, and left arcs"
);
assert(
  retinaGlyph.alphaAt(34, 14) > 220,
  "menu rotated glyph must include the midpoint bridge sparkle"
);
assert(
  retinaGlyph.alphaAt(32, 13) > 120
    && retinaGlyph.alphaAt(31, 18) > 60,
  "menu rotated bridge sparkle must remain visibly enlarged at 22pt"
);
assert(
  retinaColorAt(34, 14)[0] === 0
    && retinaColorAt(34, 14)[1] === 0
    && retinaColorAt(34, 14)[2] === 0,
  "menu rotated bridge sparkle must remain a template-safe monochrome mark"
);
const now = Date.UTC(2026, 7, 14, 0, 0, 0);
const resetAt = now + (5 * 24 + 15) * 3_600_000;
assert.equal(formatCompactCountdown(resetAt, now), "5d15h");
assert.equal(
  formatTrayQuotaLine({
    locale: "zh-CN",
    quotaAvailable: true,
    remainingPercent: 83,
    resetAt,
    now
  }),
  "额度：83%；倒计时：5d15h"
);
assert.equal(
  formatTrayTaskLine({ locale: "zh-CN", unreadCount: 2, runningCount: 1 }),
  "「2」待查看；「1」进行中；"
);

console.log("PASS tray-icon");
