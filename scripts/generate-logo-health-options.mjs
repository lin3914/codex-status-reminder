import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.dirname(scriptDirectory);
const outputDirectory = path.join(
  projectDirectory,
  "design",
  "logo-health-gradient-options",
);

const TAU = Math.PI * 2;
const clamp = (value, minimum = 0, maximum = 1) =>
  Math.max(minimum, Math.min(maximum, value));
const mix = (start, end, amount) => start + (end - start) * amount;
const smoothstep = (amount) => {
  const t = clamp(amount);
  return t * t * (3 - 2 * t);
};
const mixColor = (start, end, amount) => [
  mix(start[0], end[0], amount),
  mix(start[1], end[1], amount),
  mix(start[2], end[2], amount),
];

function composite(base, color, opacity) {
  const alpha = clamp(opacity);
  return [
    mix(base[0], color[0], alpha),
    mix(base[1], color[1], alpha),
    mix(base[2], color[2], alpha),
  ];
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

function smoothCoverage(distance, antialiasWidth) {
  return clamp(0.5 - distance / antialiasWidth);
}

function ringCoverage(radius, targetRadius, width, antialiasWidth) {
  return smoothCoverage(
    Math.abs(radius - targetRadius) - width / 2,
    antialiasWidth,
  );
}

function clockwiseProgress(x, y) {
  const angle = Math.atan2(y - 0.5, x - 0.5);
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

function encodePNG(width, height, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
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
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function healthColor(amount, option) {
  const green = option.healthy;
  const yellow = option.watch;
  const orange = option.critical;
  if (amount <= 0.5) {
    return mixColor(green, yellow, smoothstep(amount * 2));
  }
  return mixColor(yellow, orange, smoothstep((amount - 0.5) * 2));
}

function starPoints(outerRadius, innerRadius) {
  return [
    [0.5, 0.5 - outerRadius],
    [0.5 + innerRadius, 0.5 - innerRadius],
    [0.5 + outerRadius, 0.5],
    [0.5 + innerRadius, 0.5 + innerRadius],
    [0.5, 0.5 + outerRadius],
    [0.5 - innerRadius, 0.5 + innerRadius],
    [0.5 - outerRadius, 0.5],
    [0.5 - innerRadius, 0.5 - innerRadius],
  ];
}

function drawLogo(size, option) {
  const pixels = Buffer.alloc(size * size * 4);
  const antialiasWidth = 1.25 / size;
  const star = starPoints(option.starOuter, option.starInner);
  const gapStart = 0.06;
  const gapEnd = 0.19;
  const visibleArcLength = 1 - (gapEnd - gapStart);
  for (let yPixel = 0; yPixel < size; yPixel += 1) {
    for (let xPixel = 0; xPixel < size; xPixel += 1) {
      const x = (xPixel + 0.5) / size;
      const y = (yPixel + 0.5) / size;
      const dx = x - 0.5;
      const dy = y - 0.5;
      const radius = Math.hypot(dx, dy);
      const shapeDistance = roundedRectangleDistance(
        x,
        y,
        0.5,
        0.5,
        0.412,
        0.412,
        option.cornerRadius,
      );
      const shapeAlpha = smoothCoverage(shapeDistance, antialiasWidth);
      const offset = (yPixel * size + xPixel) * 4;
      if (shapeAlpha <= 0) continue;

      const light = clamp(1 - Math.hypot(dx, dy + 0.18) / 0.62);
      let color = [
        option.background[0] + option.backgroundLift[0] * light,
        option.background[1] + option.backgroundLift[1] * light,
        option.background[2] + option.backgroundLift[2] * light,
      ];
      const progress = clockwiseProgress(x, y);
      const ringVisible = progress < gapStart || progress >= gapEnd;
      const ringCoverageValue = ringCoverage(
        radius,
        option.ringRadius,
        option.ringWidth,
        antialiasWidth,
      );
      if (ringVisible && ringCoverageValue > 0) {
        const gradientAmount = progress >= gapEnd
          ? (progress - gapEnd) / visibleArcLength
          : (progress + 1 - gapEnd) / visibleArcLength;
        const ringColor = healthColor(gradientAmount, option);
        color = composite(color, ringColor, ringCoverageValue);
        const glow = Math.exp(-Math.max(0, Math.abs(radius - option.ringRadius)) * size / 16)
          * option.ringGlow;
        color = composite(color, ringColor, clamp(glow * 0.18));
      }

      const starDistance = polygonDistance(x, y, star);
      const starCoverage = smoothCoverage(starDistance, antialiasWidth);
      if (starCoverage > 0) {
        const starColor = option.starColor;
        const glow = Math.exp(-Math.max(0, starDistance) * size / 16)
          * option.starGlow;
        color = composite(color, [61, 235, 191], clamp(glow * 0.28));
        color = composite(color, starColor, starCoverage);
      }

      const dotDistance = Math.hypot(x - 0.7175, y - 0.2825) - option.dotRadius;
      const dotCoverage = smoothCoverage(dotDistance, antialiasWidth);
      if (dotCoverage > 0) {
        color = composite(color, option.dotColor, dotCoverage);
      }

      pixels[offset] = Math.round(clamp(color[0], 0, 255));
      pixels[offset + 1] = Math.round(clamp(color[1], 0, 255));
      pixels[offset + 2] = Math.round(clamp(color[2], 0, 255));
      pixels[offset + 3] = Math.round(shapeAlpha * 255);
    }
  }
  return pixels;
}

const options = [
  {
    id: "01",
    label: "健康青绿主导",
    description: "绿色停留时间更长，黄色与橙色只在健康度恶化时逐步出现。",
    background: [5, 22, 27], backgroundLift: [5, 15, 17],
    healthy: [73, 224, 172], watch: [222, 205, 102], critical: [244, 132, 92],
    starOuter: 0.235, starInner: 0.075, ringWidth: 0.069, ringRadius: 0.329,
    ringGlow: 0.9, starGlow: 1.0, starColor: [231, 255, 244], dotColor: [101, 230, 239],
    dotRadius: 0.043, cornerRadius: 0.168,
  },
  {
    id: "02",
    label: "均衡三段渐变",
    description: "青绿、浅黄、橙色各自承担一段明确但平滑的健康度变化。",
    background: [7, 25, 31], backgroundLift: [6, 16, 18],
    healthy: [70, 218, 182], watch: [230, 200, 103], critical: [241, 137, 89],
    starOuter: 0.225, starInner: 0.07, ringWidth: 0.082, ringRadius: 0.326,
    ringGlow: 0.8, starGlow: 0.9, starColor: [236, 255, 247], dotColor: [110, 230, 236],
    dotRadius: 0.045, cornerRadius: 0.168,
  },
  {
    id: "03",
    label: "青绿高对比",
    description: "绿色更清透，进入关注区后用更高饱和度的橙色拉开差异。",
    background: [3, 17, 24], backgroundLift: [8, 17, 20],
    healthy: [68, 232, 177], watch: [232, 201, 83], critical: [248, 117, 75],
    starOuter: 0.245, starInner: 0.065, ringWidth: 0.061, ringRadius: 0.332,
    ringGlow: 1.1, starGlow: 1.1, starColor: [229, 255, 241], dotColor: [96, 227, 238],
    dotRadius: 0.041, cornerRadius: 0.168,
  },
  {
    id: "04",
    label: "浅色柔和过渡",
    description: "降低警示颜色的攻击性，适合长时间停留在桌面的应用 Logo。",
    background: [11, 28, 31], backgroundLift: [10, 17, 17],
    healthy: [105, 224, 181], watch: [235, 210, 128], critical: [238, 156, 111],
    starOuter: 0.23, starInner: 0.08, ringWidth: 0.075, ringRadius: 0.327,
    ringGlow: 0.7, starGlow: 0.8, starColor: [235, 255, 245], dotColor: [113, 226, 231],
    dotRadius: 0.044, cornerRadius: 0.168,
  },
  {
    id: "05",
    label: "橙色警示明确",
    description: "健康区仍然青绿，越过关注阈值后快速而连续地靠近橙色。",
    background: [14, 21, 30], backgroundLift: [9, 18, 20],
    healthy: [57, 218, 169], watch: [220, 190, 85], critical: [248, 115, 69],
    starOuter: 0.24, starInner: 0.06, ringWidth: 0.071, ringRadius: 0.329,
    ringGlow: 0.9, starGlow: 1.0, starColor: [240, 255, 245], dotColor: [103, 225, 237],
    dotRadius: 0.044, cornerRadius: 0.168,
  },
  {
    id: "06",
    label: "厚环仪表感",
    description: "更厚的色带提升小尺寸识别度，健康度变化仍由连续渐变表达。",
    background: [10, 19, 24], backgroundLift: [7, 14, 19],
    healthy: [77, 221, 170], watch: [226, 203, 96], critical: [243, 126, 77],
    starOuter: 0.22, starInner: 0.09, ringWidth: 0.094, ringRadius: 0.321,
    ringGlow: 0.6, starGlow: 0.9, starColor: [226, 255, 240], dotColor: [105, 226, 236],
    dotRadius: 0.046, cornerRadius: 0.168,
  },
  {
    id: "07",
    label: "薄荷到琥珀",
    description: "以薄荷绿为健康基准，以琥珀橙作为关注与警示的统一终点。",
    background: [5, 27, 29], backgroundLift: [5, 16, 13],
    healthy: [88, 229, 187], watch: [230, 204, 105], critical: [244, 145, 87],
    starOuter: 0.235, starInner: 0.07, ringWidth: 0.067, ringRadius: 0.33,
    ringGlow: 1.0, starGlow: 1.0, starColor: [234, 255, 246], dotColor: [104, 232, 234],
    dotRadius: 0.042, cornerRadius: 0.168,
  },
  {
    id: "08",
    label: "冷暖分区最清晰",
    description: "青绿到黄色的冷暖切换更明显，橙色终点保留柔和的红橙感。",
    background: [8, 23, 34], backgroundLift: [8, 15, 21],
    healthy: [55, 211, 181], watch: [235, 205, 90], critical: [244, 122, 83],
    starOuter: 0.245, starInner: 0.075, ringWidth: 0.064, ringRadius: 0.33,
    ringGlow: 0.8, starGlow: 1.15, starColor: [236, 255, 250], dotColor: [96, 224, 240],
    dotRadius: 0.043, cornerRadius: 0.168,
  },
  {
    id: "09",
    label: "极简稳重",
    description: "压低背景与光晕，依靠加粗星芒和渐变色带传递状态。",
    background: [14, 18, 22], backgroundLift: [6, 11, 13],
    healthy: [78, 216, 170], watch: [219, 193, 101], critical: [236, 133, 92],
    starOuter: 0.23, starInner: 0.095, ringWidth: 0.072, ringRadius: 0.329,
    ringGlow: 0.4, starGlow: 0.65, starColor: [244, 255, 247], dotColor: [105, 224, 234],
    dotRadius: 0.043, cornerRadius: 0.168,
  },
  {
    id: "10",
    label: "警示端点最强",
    description: "从健康青绿平滑推进到高辨识度橙色，适合强调风险的产品定位。",
    background: [6, 20, 26], backgroundLift: [6, 16, 18],
    healthy: [65, 225, 176], watch: [227, 194, 83], critical: [250, 105, 65],
    starOuter: 0.25, starInner: 0.065, ringWidth: 0.08, ringRadius: 0.325,
    ringGlow: 1.0, starGlow: 1.2, starColor: [236, 255, 244], dotColor: [103, 230, 237],
    dotRadius: 0.044, cornerRadius: 0.168,
  },
];

const digitGlyphs = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["110", "001", "010", "100", "111"],
  "3": ["110", "001", "010", "001", "110"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "110", "001", "110"],
  "6": ["011", "100", "111", "101", "111"],
  "7": ["111", "001", "010", "010", "010"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "110"],
};

function blendPixel(pixels, width, x, y, color, opacity = 1) {
  if (x < 0 || y < 0 || x >= width) return;
  const offset = (y * width + x) * 4;
  const alpha = clamp(opacity);
  pixels[offset] = Math.round(mix(pixels[offset], color[0], alpha));
  pixels[offset + 1] = Math.round(mix(pixels[offset + 1], color[1], alpha));
  pixels[offset + 2] = Math.round(mix(pixels[offset + 2], color[2], alpha));
  pixels[offset + 3] = Math.max(pixels[offset + 3], Math.round(alpha * 255));
}

function drawNumber(pixels, width, number, x, y, scale = 3) {
  const glyphColor = [222, 232, 232];
  const shadowColor = [0, 0, 0];
  for (let characterIndex = 0; characterIndex < number.length; characterIndex += 1) {
    const glyph = digitGlyphs[number[characterIndex]];
    if (!glyph) continue;
    const originX = x + characterIndex * (4 * scale);
    for (let row = 0; row < glyph.length; row += 1) {
      for (let column = 0; column < glyph[row].length; column += 1) {
        if (glyph[row][column] !== "1") continue;
        for (let sy = 0; sy < scale; sy += 1) {
          for (let sx = 0; sx < scale; sx += 1) {
            blendPixel(pixels, width, originX + column * scale + sx + 1, y + row * scale + sy + 1, shadowColor, 0.6);
            blendPixel(pixels, width, originX + column * scale + sx, y + row * scale + sy, glyphColor, 0.95);
          }
        }
      }
    }
  }
}

fs.mkdirSync(outputDirectory, { recursive: true });
const tileSize = 320;
const gap = 24;
const margin = 24;
const columns = 5;
const rows = 2;
const contactWidth = margin * 2 + columns * tileSize + (columns - 1) * gap;
const contactHeight = margin * 2 + rows * tileSize + (rows - 1) * gap;
const contactPixels = Buffer.alloc(contactWidth * contactHeight * 4);
for (let index = 0; index < options.length; index += 1) {
  const option = options[index];
  const logo = drawLogo(tileSize, option);
  const column = index % columns;
  const row = Math.floor(index / columns);
  const xOffset = margin + column * (tileSize + gap);
  const yOffset = margin + row * (tileSize + gap);
  for (let y = 0; y < tileSize; y += 1) {
    logo.copy(
      contactPixels,
      ((yOffset + y) * contactWidth + xOffset) * 4,
      y * tileSize * 4,
      (y + 1) * tileSize * 4,
    );
  }
  drawNumber(contactPixels, contactWidth, option.id, xOffset + 18, yOffset + 18, 4);
  fs.writeFileSync(
    path.join(outputDirectory, `logo-health-gradient-${option.id}.png`),
    encodePNG(512, 512, drawLogo(512, option)),
  );
}
fs.writeFileSync(
  path.join(outputDirectory, "logo-health-gradient-options-01-10.png"),
  encodePNG(contactWidth, contactHeight, contactPixels),
);
fs.writeFileSync(
  path.join(outputDirectory, "options.json"),
  `${JSON.stringify(options.map(({ id, label, description, starOuter, starInner, ringWidth }) => ({
    id, label, description, starOuter, starInner, ringWidth,
  })), null, 2)}\n`,
);
console.log(`Generated ${options.length} Logo health-gradient design options.`);
