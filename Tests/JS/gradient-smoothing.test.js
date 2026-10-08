"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");

const projectDirectory = path.resolve(__dirname, "../..");
const generator = fs.readFileSync(
  path.join(projectDirectory, "scripts/generate-icon-assets.mjs"),
  "utf8",
);
const dotHTML = fs.readFileSync(
  path.join(projectDirectory, "Resources/LegacyV11/dot.html"),
  "utf8",
);
const dotCSS = fs.readFileSync(
  path.join(projectDirectory, "Resources/LegacyV11/pet-status-dot.css"),
  "utf8",
);

assert.match(generator, /function smoothGradientAmount\(amount\)/);
assert.match(
  generator,
  /const starPoints = createStarPoints\(0\.5, 0\.5, 0\.24, 0\.072, -70\)/,
  "Logo and menu-bar glyphs must share the additional +10° clockwise four-point star tilt",
);
assert.match(
  generator,
  /mix\(start\[0\], end\[0\], smoothGradientAmount\(amount\)\)/,
);
assert.match(generator, /const ringHealthy = \[57, 218, 169\]/);
assert.match(generator, /const ringWatch = \[220, 190, 85\]/);
assert.match(generator, /const ringCritical = \[248, 115, 69\]/);
assert.match(generator, /const sparkleCenterAngle = 55 \* Math\.PI \/ 180/);
assert.match(generator, /0\.5 \+ sparkleCenterRadius \* Math\.sin\(sparkleCenterAngle\)/);
assert.match(generator, /0\.5 - sparkleCenterRadius \* Math\.cos\(sparkleCenterAngle\)/);
assert.match(generator, /smallSparkleOuterRadius = 0\.11/);
assert.match(generator, /smallSparkleInnerRadius = 0\.03/);
assert.match(generator, /const smallSparklePoints = createStarPoints\([\s\S]*?-70/);
assert.match(generator, /const ringOpeningStartDegrees = 31\.6/);
assert.match(generator, /const ringOpeningEndDegrees = 78\.4/);
assert.match(generator, /const healthGradientColor = \(amount\) =>/);
assert.match(generator, /const ringHealthProgress = \(progress\) =>/);
assert.match(dotHTML, /const healthPalettes = \{/);
assert.match(dotHTML, /const applyHealthColors = \(rawProgress\) =>/);

for (const gradient of ["time", "quota"]) {
  const pattern = new RegExp(
    `<linearGradient id="${gradient}-ring-gradient"[\\s\\S]*?` +
      `class="${gradient}-ring-gradient-start" offset="0"[\\s\\S]*?` +
      `class="${gradient}-ring-gradient-mid" offset="0\\.5"[\\s\\S]*?` +
      `class="${gradient}-ring-gradient-end" offset="1"`,
  );
  assert.match(dotHTML, pattern, `${gradient} gradient must have start/mid/end stops`);
}

for (const variable of [
  "--time-ring-mid: #49d7e9",
  "--quota-ring-mid: #45dda0",
  "--quota-ring-mid: #dfc666",
  "--quota-ring-mid: #df8962",
  "--quota-ring-mid: #86a9af",
]) {
  assert.match(dotCSS, new RegExp(variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

console.log("PASS gradient-smoothing");
