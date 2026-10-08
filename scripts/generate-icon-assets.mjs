import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.dirname(scriptDirectory);
const appIconDirectory = path.join(projectDirectory, "Resources", "AppIcon");
const trayIconDirectory = path.join(projectDirectory, "Resources", "TrayIcon");
const legacyRendererDirectory = path.join(projectDirectory, "Resources", "LegacyV11");
const iconsetDirectory = path.join(appIconDirectory, "CodexCompanion.iconset");

const TAU = Math.PI * 2;

function clamp(value, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, value));
}

function mix(start, end, amount) {
  return start + (end - start) * amount;
}

function smoothGradientAmount(amount) {
  const t = clamp(amount);
  // Keep the gradient tangent-flat at both ends so the ring does not show a
  // visible color jump where its open segment begins or ends.
  return t * t * (3 - 2 * t);
}

function mixColor(start, end, amount) {
  return [
    mix(start[0], end[0], smoothGradientAmount(amount)),
    mix(start[1], end[1], smoothGradientAmount(amount)),
    mix(start[2], end[2], smoothGradientAmount(amount)),
  ];
}

function composite(base, color, opacity) {
  const alpha = clamp(opacity);
  return [
    mix(base[0], color[0], alpha),
    mix(base[1], color[1], alpha),
    mix(base[2], color[2], alpha),
  ];
}

function smoothCoverage(signedDistance, antialiasWidth) {
  return clamp(0.5 - signedDistance / antialiasWidth);
}

function roundedRectangleDistance(x, y, centerX, centerY, halfWidth, halfHeight, radius) {
  const qx = Math.abs(x - centerX) - halfWidth + radius;
  const qy = Math.abs(y - centerY) - halfHeight + radius;
  return (
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
    + Math.min(Math.max(qx, qy), 0)
    - radius
  );
}

function ringCoverage(radius, targetRadius, width, antialiasWidth) {
  return smoothCoverage(Math.abs(radius - targetRadius) - width / 2, antialiasWidth);
}

function clockwiseProgress(x, y, centerX = 0.5, centerY = 0.5) {
  const angle = Math.atan2(y - centerY, x - centerX);
  return ((angle + Math.PI / 2 + TAU) % TAU) / TAU;
}

function polygonDistance(x, y, points) {
  let inside = false;
  let minimumDistanceSquared = Number.POSITIVE_INFINITY;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const [startX, startY] = points[previous];
    const [endX, endY] = points[index];
    if (
      (startY > y) !== (endY > y)
      && x < ((endX - startX) * (y - startY)) / (endY - startY) + startX
    ) {
      inside = !inside;
    }
    const segmentX = endX - startX;
    const segmentY = endY - startY;
    const lengthSquared = segmentX * segmentX + segmentY * segmentY;
    const projection = lengthSquared > 0
      ? clamp(
        ((x - startX) * segmentX + (y - startY) * segmentY) / lengthSquared,
      )
      : 0;
    const closestX = startX + projection * segmentX;
    const closestY = startY + projection * segmentY;
    minimumDistanceSquared = Math.min(
      minimumDistanceSquared,
      (x - closestX) ** 2 + (y - closestY) ** 2,
    );
  }
  const distance = Math.sqrt(minimumDistanceSquared);
  return inside ? -distance : distance;
}

function createStarPoints(centerX, centerY, outerRadius, innerRadius, rotationDegrees) {
  const rotation = rotationDegrees * Math.PI / 180;
  return Array.from({ length: 8 }, (_, index) => {
    const radius = index % 2 === 0 ? outerRadius : innerRadius;
    const angle = rotation + index * Math.PI / 4;
    return [
      centerX + Math.cos(angle) * radius,
      centerY + Math.sin(angle) * radius,
    ];
  });
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function encodePNG(width, height, pixels, dpi = 72) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const physical = Buffer.alloc(9);
  const pixelsPerMeter = Math.round(dpi / 0.0254);
  physical.writeUInt32BE(pixelsPerMeter, 0);
  physical.writeUInt32BE(pixelsPerMeter, 4);
  physical[8] = 1;
  const rowBytes = width * 4;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const destination = y * (rowBytes + 1);
    raw[destination] = 0;
    pixels.copy(raw, destination + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("pHYs", physical),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function drawLogo04Icon(
  size,
  {
    background = true,
    chromaBackground = false,
    monochrome = false,
    // The bridge sparkle is intentionally larger than the exploratory Figma
    // sample so it still reads as a star when the App Logo is rendered at
    // 44–64px and the template is rendered at 22pt.
    smallSparkleOuterRadius = 0.11,
    smallSparkleInnerRadius = 0.03,
    dpi = 72,
  } = {},
) {
  const pixels = Buffer.alloc(size * size * 4);
  const antialiasWidth = 1.15 / size;
  const ringRadius = 0.329;
  const ringWidth = 0.071;
  // Keep the opening width unchanged, but rotate its midpoint from 1:30 to
  // 1:50 (55° clockwise from 12 o'clock). This is the requested additional
  // clockwise 10° tilt for both the Logo and the menu-bar glyph.
  const ringOpeningStartDegrees = 31.6;
  const ringOpeningEndDegrees = 78.4;
  const gapStart = ringOpeningStartDegrees / 360;
  const gapEnd = ringOpeningEndDegrees / 360;
  // The selected 05 direction uses the quota-health language directly in the
  // Logo: healthy green, watch yellow, and warning orange. The two arc ends
  // meet across the upper-right opening, so the status sparkle can bridge the
  // orange → green transition instead of leaving a hard color seam.
  const ringHealthy = [57, 218, 169];
  const ringWatch = [220, 190, 85];
  const ringCritical = [248, 115, 69];
  const starColor = [225, 255, 244];
  // The sparkle stays at the opening midpoint, now rotated another 10°
  // clockwise to about 1:50. Derive its position from the previous bridge
  // radius so the distance to the center remains unchanged.
  const sparkleCenterRadius = Math.hypot(0.7175 - 0.5, 0.2825 - 0.5);
  const sparkleCenterAngle = 55 * Math.PI / 180;
  const sparkleCenter = [
    0.5 + sparkleCenterRadius * Math.sin(sparkleCenterAngle),
    0.5 - sparkleCenterRadius * Math.cos(sparkleCenterAngle),
  ];
  const sparkleColor = ringWatch;
  // The main star is now tilted +20° from vertical (10° more clockwise than
  // the previous +10° version). Its fuller inner notches keep the four-point
  // silhouette readable instead of collapsing into a cross when Finder scales
  // the Logo down. The bridge sparkle uses the exact same rotation so both
  // four-point stars read as one coherent symbol at 22px.
  const starPoints = createStarPoints(0.5, 0.5, 0.24, 0.072, -70);
  const smallSparklePoints = createStarPoints(
    sparkleCenter[0],
    sparkleCenter[1],
    smallSparkleOuterRadius,
    smallSparkleInnerRadius,
    -70,
  );

  const healthGradientColor = (amount) => {
    const progressAmount = clamp(amount);
    if (progressAmount <= 0.5) {
      return mixColor(
        ringHealthy,
        ringWatch,
        smoothGradientAmount(progressAmount * 2),
      );
    }
    return mixColor(
      ringWatch,
      ringCritical,
      smoothGradientAmount((progressAmount - 0.5) * 2),
    );
  };
  const visibleArcLength = 1 - (gapEnd - gapStart);
  const ringHealthProgress = (progress) => progress >= gapEnd
    ? (progress - gapEnd) / visibleArcLength
    : (progress + 1 - gapEnd) / visibleArcLength;

  for (let yPixel = 0; yPixel < size; yPixel += 1) {
    for (let xPixel = 0; xPixel < size; xPixel += 1) {
      const x = (xPixel + 0.5) / size;
      const y = (yPixel + 0.5) / size;
      const squircleDistance = roundedRectangleDistance(
        x,
        y,
        0.5,
        0.5,
        0.412,
        0.412,
        0.168,
      );
      const shapeAlpha = background
        ? smoothCoverage(squircleDistance, antialiasWidth)
        : 0;
      const offset = (yPixel * size + xPixel) * 4;

      if (background && shapeAlpha <= 0) {
        if (chromaBackground) {
          pixels[offset] = 255;
          pixels[offset + 1] = 0;
          pixels[offset + 2] = 255;
          pixels[offset + 3] = 255;
        }
        continue;
      }

      const dx = x - 0.5;
      const dy = y - 0.5;
      const radius = Math.hypot(dx, dy);
      const progress = clockwiseProgress(x, y);
      const ringVisible = progress < gapStart || progress >= gapEnd;
      const ringCoverageValue = ringCoverage(
        radius,
        ringRadius,
        ringWidth,
        antialiasWidth,
      );
      const baseColor = background
        ? [
          6 + 8 * clamp(1 - radius / 0.55) + 2 * clamp(1 - Math.hypot(dx, dy + 0.18) / 0.56),
          17 + 14 * clamp(1 - radius / 0.55) + 7 * clamp(1 - Math.hypot(dx, dy + 0.18) / 0.56),
          20 + 15 * clamp(1 - radius / 0.55) + 8 * clamp(1 - Math.hypot(dx, dy + 0.18) / 0.56),
        ]
        : [0, 0, 0];
      let color = baseColor;
      let alpha = shapeAlpha;

      if (ringVisible && ringCoverageValue > 0) {
        const ringColor = monochrome
          ? [0, 0, 0]
          : healthGradientColor(ringHealthProgress(progress));
        color = background
          ? composite(color, ringColor, ringCoverageValue)
          : ringColor;
        alpha = background
          ? shapeAlpha
          : Math.max(alpha, ringCoverageValue);
      }

      const starDistance = polygonDistance(x, y, starPoints);
      if (background && !monochrome) {
        const starGlow = Math.exp(-Math.max(0, starDistance) * size / 19) * 0.42;
        color = composite(color, [54, 238, 184], starGlow);
      }
      const starCoverage = smoothCoverage(starDistance, antialiasWidth);
      if (starCoverage > 0) {
        const star = monochrome ? [0, 0, 0] : starColor;
        color = background
          ? composite(color, star, starCoverage)
          : star;
        alpha = background
          ? shapeAlpha
          : Math.max(alpha, starCoverage);
      }

      const smallSparkleDistance = polygonDistance(x, y, smallSparklePoints);
      const smallSparkleCoverage = smoothCoverage(smallSparkleDistance, antialiasWidth);
      if (smallSparkleCoverage > 0) {
        const sparkle = monochrome ? [0, 0, 0] : sparkleColor;
        color = background
          ? composite(color, sparkle, smallSparkleCoverage)
          : sparkle;
        alpha = background
          ? shapeAlpha
          : Math.max(alpha, smallSparkleCoverage);
      }

      pixels[offset] = Math.round(clamp(color[0], 0, 255));
      pixels[offset + 1] = Math.round(clamp(color[1], 0, 255));
      pixels[offset + 2] = Math.round(clamp(color[2], 0, 255));
      pixels[offset + 3] = Math.round(alpha * 255);
    }
  }
  return encodePNG(size, size, pixels, dpi);
}

function drawAppIcon(size, chromaBackground = false) {
  return drawLogo04Icon(size, { background: true, chromaBackground });
}

function drawTrayIcon(size) {
  // Menu-bar artwork uses the same selected 05 star and 04 open-ring structure
  // without the app tile. A transparent, monochrome mask lets macOS tint it
  // for light/dark bars. Option 10 deliberately shares the enlarged bridge
  // sparkle with the app logo so its directional cue survives a 22pt render.
  return drawLogo04Icon(size, {
    background: false,
    monochrome: true,
  });
}

function drawQuotaStar(scale) {
  // Keep the native image's row height, but only reserve 9pt horizontally.
  // The +20° four-point silhouette is placed above the quota's baseline,
  // giving the native system title a small upper-left brand marker.
  const width = 9 * scale;
  const height = 22 * scale;
  const pixels = Buffer.alloc(width * height * 4);
  const points = createStarPoints(4.5, 6, 4.1, 1.85, -70);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const distance = polygonDistance((x + 0.5) / scale, (y + 0.5) / scale, points);
      pixels[(y * width + x) * 4 + 3] = Math.round(
        smoothCoverage(distance, 1 / scale) * 255,
      );
    }
  }
  return encodePNG(width, height, pixels, 72 * scale);
}

fs.mkdirSync(trayIconDirectory, { recursive: true });
fs.writeFileSync(path.join(trayIconDirectory, "CodexQuotaStarTemplate.png"), drawQuotaStar(1));
fs.writeFileSync(path.join(trayIconDirectory, "CodexQuotaStarTemplate@2x.png"), drawQuotaStar(2));
if (process.argv.includes("--quota-star-only")) {
  console.log("Generated compact quota star assets; existing Logo and full menu icon unchanged.");
  process.exit(0);
}

fs.mkdirSync(appIconDirectory, { recursive: true });
fs.mkdirSync(iconsetDirectory, { recursive: true });
fs.mkdirSync(trayIconDirectory, { recursive: true });
fs.mkdirSync(legacyRendererDirectory, { recursive: true });

const master = drawAppIcon(1024);
for (const name of [
  "AppIcon-source.png",
  "AppIcon-refined-alpha.png",
  "AppIcon-1024.png",
]) {
  fs.writeFileSync(path.join(appIconDirectory, name), master);
}
fs.writeFileSync(
  path.join(appIconDirectory, "AppIcon-refined-chroma.png"),
  drawAppIcon(1024, true),
);

const iconsetSizes = new Map([
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
]);
for (const [name, size] of iconsetSizes) {
  fs.writeFileSync(path.join(iconsetDirectory, name), drawAppIcon(size));
}

fs.writeFileSync(
  path.join(trayIconDirectory, "CodexCompanionTemplate.png"),
  drawTrayIcon(22),
);
fs.writeFileSync(
  path.join(trayIconDirectory, "CodexCompanionTemplate@2x.png"),
  drawLogo04Icon(44, {
    background: false,
    monochrome: true,
    dpi: 144,
  }),
);
fs.writeFileSync(
  path.join(legacyRendererDirectory, "app-icon.png"),
  drawAppIcon(128),
);

execFileSync(
  "/usr/bin/iconutil",
  [
    "-c",
    "icns",
    iconsetDirectory,
    "-o",
    path.join(appIconDirectory, "icon.icns"),
  ],
  { stdio: "inherit" },
);

console.log("Generated app and menu-bar icon assets.");
