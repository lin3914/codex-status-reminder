"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

function decodeRGBA(buffer) {
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  assert.equal(buffer[24], 8);
  assert.equal(buffer[25], 6);
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
  const pixels = Buffer.alloc(rowBytes * height);
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
      const left = x >= 4 ? pixels[y * rowBytes + x - 4] : 0;
      const above = y > 0 ? pixels[(y - 1) * rowBytes + x] : 0;
      const upperLeft = y > 0 && x >= 4
        ? pixels[(y - 1) * rowBytes + x - 4]
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
      pixels[y * rowBytes + x] = (source + predictor) & 255;
    }
  }
  return {
    width,
    height,
    pixel(x, y) {
      const index = (y * width + x) * 4;
      return [...pixels.subarray(index, index + 4)];
    }
  };
}

function isVisibleRing([red, green, blue, alpha]) {
  return alpha > 240 && red + green + blue > 300;
}

function isBackground([red, green, blue, alpha]) {
  return alpha > 240 && red < 40 && green < 60 && blue < 70;
}

function isStar([red, green, blue, alpha]) {
  return alpha > 240 && red > 170 && green > 230 && blue > 220;
}

const iconPath = path.resolve(__dirname, "../../Resources/AppIcon/AppIcon-1024.png");
const icon = decodeRGBA(fs.readFileSync(iconPath));
assert.deepEqual([icon.width, icon.height], [1024, 1024]);

assert(
  isVisibleRing(icon.pixel(508, 175))
    && isVisibleRing(icon.pixel(512, 175))
    && isVisibleRing(icon.pixel(516, 175)),
  "rotated open ring must remain continuous across the 12 o'clock origin"
);
assert(
  isBackground(icon.pixel(730, 220)),
  "rotated open ring must leave a clear upper-right opening around the bridge star"
);
assert(
  isVisibleRing(icon.pixel(870, 460)),
  "rotated open ring must end with a precise clockwise-shifted cut"
);
assert(
  isVisibleRing(icon.pixel(850, 512))
    && isVisibleRing(icon.pixel(512, 849))
    && isVisibleRing(icon.pixel(175, 512)),
  "05 open ring must remain visible around the right, bottom, and left arcs"
);
assert(isStar(icon.pixel(512, 512)), "05 Logo must retain the central AI star");
assert(
  isStar(icon.pixel(594, 284))
    && isStar(icon.pixel(736, 592))
    && isStar(icon.pixel(430, 736))
    && isStar(icon.pixel(284, 429)),
  "Logo central AI star must retain the additional +10° clockwise tilt"
);
assert(
  icon.pixel(770, 331)[0] > 150
    && icon.pixel(770, 331)[1] > 130
    && icon.pixel(770, 331)[2] < 150,
  "Logo must place the same-direction bridge star at the rotated orange/green midpoint"
);
assert(
  icon.pixel(512, 175)[0] > icon.pixel(512, 175)[1],
  "05 Logo must show the orange end immediately to the left of the bridge"
);
assert(
  icon.pixel(850, 512)[1] > icon.pixel(850, 512)[0] + 100,
  "05 Logo must transition into green immediately to the right of the bridge"
);

console.log("PASS app-icon-direction");
