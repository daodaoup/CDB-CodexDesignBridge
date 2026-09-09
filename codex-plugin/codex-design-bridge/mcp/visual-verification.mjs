import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_REFERENCE_BYTES = 4 * 1024 * 1024;
const MAX_REFERENCE_DIMENSION = 4_096;

export function normalizeVisualReference(value, { designViewport = null } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw codedError("visual_reference_required", "Figma 页面缺少权威渲染图。");
  }
  if (value.mimeType !== "image/png") {
    throw codedError("visual_reference_type", "Figma 权威渲染图必须是 PNG。");
  }
  const width = positiveInteger(value.width, "width");
  const height = positiveInteger(value.height, "height");
  if (width > MAX_REFERENCE_DIMENSION || height > MAX_REFERENCE_DIMENSION) {
    throw codedError("visual_reference_dimensions", "Figma 权威渲染图尺寸超出验收上限。");
  }
  const bytes = decodeBase64(value.base64);
  if (bytes.length === 0 || bytes.length > MAX_REFERENCE_BYTES) {
    throw codedError("visual_reference_bytes", "Figma 权威渲染图大小无效。");
  }
  const decoded = decodePng(bytes);
  if (decoded.width !== width || decoded.height !== height) {
    throw codedError("visual_reference_dimensions", "Figma 权威渲染图声明尺寸与 PNG 不一致。");
  }
  if (designViewport?.width && designViewport?.height) {
    const expectedWidth = Math.max(1, Math.min(1_200, Math.round(designViewport.width)));
    const scale = expectedWidth / designViewport.width;
    const expectedHeight = Math.max(1, Math.round(designViewport.height * scale));
    if (width !== expectedWidth || height !== expectedHeight) {
      throw codedError(
        "visual_reference_viewport_mismatch",
        "Figma 权威渲染图尺寸与设计 viewport 不一致。",
      );
    }
  }
  return {
    mimeType: "image/png",
    base64: bytes.toString("base64"),
    width,
    height,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function verifyVisualReference({
  referenceImage,
  browserImage,
  channelThreshold = 32,
  maxDifferentPixelRatio = 0.12,
  maxMeanChannelError = 12,
} = {}) {
  const reference = normalizeVisualReference(referenceImage);
  const actualBytes = dataUrlBytes(browserImage?.dataUrl);
  const expected = decodePng(Buffer.from(reference.base64, "base64"));
  const actualDecoded = decodePng(actualBytes);
  const actual = actualDecoded.width === expected.width && actualDecoded.height === expected.height
    ? actualDecoded
    : resizeRgba(actualDecoded, expected.width, expected.height);
  let differentPixels = 0;
  let totalChannelError = 0;
  let maxChannelError = 0;
  for (let index = 0; index < expected.data.length; index += 4) {
    const expectedPixel = compositeOnWhite(expected.data, index);
    const actualPixel = compositeOnWhite(actual.data, index);
    let pixelDifferent = false;
    for (let channel = 0; channel < 3; channel += 1) {
      const error = Math.abs(expectedPixel[channel] - actualPixel[channel]);
      totalChannelError += error;
      maxChannelError = Math.max(maxChannelError, error);
      if (error > channelThreshold) pixelDifferent = true;
    }
    if (pixelDifferent) differentPixels += 1;
  }
  const totalPixels = expected.width * expected.height;
  const differentPixelRatio = differentPixels / totalPixels;
  const meanChannelError = totalChannelError / (totalPixels * 3);
  const passed =
    differentPixelRatio <= maxDifferentPixelRatio &&
    meanChannelError <= maxMeanChannelError;
  return {
    status: passed ? "passed" : "failed",
    expected: {
      width: expected.width,
      height: expected.height,
      sha256: reference.sha256,
    },
    actual: {
      width: actualDecoded.width,
      height: actualDecoded.height,
      sha256: createHash("sha256").update(actualBytes).digest("hex"),
      resizedForComparison:
        actualDecoded.width !== expected.width || actualDecoded.height !== expected.height,
    },
    thresholds: { channelThreshold, maxDifferentPixelRatio, maxMeanChannelError },
    differentPixels,
    totalPixels,
    differentPixelRatio,
    meanChannelError,
    maxChannelError,
  };
}

export function decodePng(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw codedError("invalid_png", "视觉验收图不是有效 PNG。");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  const compressed = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > bytes.length) throw codedError("invalid_png", "PNG 数据块不完整。");
    if (type === "IHDR") {
      width = bytes.readUInt32BE(start);
      height = bytes.readUInt32BE(start + 4);
      bitDepth = bytes[start + 8];
      colorType = bytes[start + 9];
      interlace = bytes[start + 12];
    } else if (type === "IDAT") {
      compressed.push(bytes.subarray(start, end));
    } else if (type === "IEND") {
      break;
    }
    offset = end + 4;
  }
  if (!width || !height || bitDepth !== 8 || interlace !== 0) {
    throw codedError("unsupported_png", "视觉验收只接受 8 位非交错 PNG。");
  }
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 })[colorType];
  if (!channels) throw codedError("unsupported_png", `不支持 PNG color type ${colorType}。`);
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(compressed));
  if (raw.length !== (stride + 1) * height) {
    throw codedError("invalid_png", "PNG 解压尺寸与图像声明不一致。");
  }
  const scanlines = Buffer.alloc(stride * height);
  let rawOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[rawOffset];
    rawOffset += 1;
    const rowOffset = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const encoded = raw[rawOffset + x];
      const left = x >= channels ? scanlines[rowOffset + x - channels] : 0;
      const up = y > 0 ? scanlines[rowOffset - stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? scanlines[rowOffset - stride + x - channels] : 0;
      scanlines[rowOffset + x] = unfilter(filter, encoded, left, up, upLeft);
    }
    rawOffset += stride;
  }
  const data = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const source = pixel * channels;
    const target = pixel * 4;
    if (colorType === 0) {
      data[target] = scanlines[source];
      data[target + 1] = scanlines[source];
      data[target + 2] = scanlines[source];
      data[target + 3] = 255;
    } else if (colorType === 2) {
      data[target] = scanlines[source];
      data[target + 1] = scanlines[source + 1];
      data[target + 2] = scanlines[source + 2];
      data[target + 3] = 255;
    } else if (colorType === 4) {
      data[target] = scanlines[source];
      data[target + 1] = scanlines[source];
      data[target + 2] = scanlines[source];
      data[target + 3] = scanlines[source + 1];
    } else {
      data[target] = scanlines[source];
      data[target + 1] = scanlines[source + 1];
      data[target + 2] = scanlines[source + 2];
      data[target + 3] = scanlines[source + 3];
    }
  }
  return { width, height, data };
}

function unfilter(filter, value, left, up, upLeft) {
  if (filter === 0) return value;
  if (filter === 1) return (value + left) & 255;
  if (filter === 2) return (value + up) & 255;
  if (filter === 3) return (value + Math.floor((left + up) / 2)) & 255;
  if (filter === 4) return (value + paeth(left, up, upLeft)) & 255;
  throw codedError("unsupported_png", `不支持 PNG filter ${filter}。`);
}

function paeth(left, up, upLeft) {
  const prediction = left + up - upLeft;
  const leftDistance = Math.abs(prediction - left);
  const upDistance = Math.abs(prediction - up);
  const diagonalDistance = Math.abs(prediction - upLeft);
  if (leftDistance <= upDistance && leftDistance <= diagonalDistance) return left;
  if (upDistance <= diagonalDistance) return up;
  return upLeft;
}

function resizeRgba(image, width, height) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(image.height - 1, Math.floor((y + 0.5) * image.height / height));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(image.width - 1, Math.floor((x + 0.5) * image.width / width));
      const sourceOffset = (sourceY * image.width + sourceX) * 4;
      const targetOffset = (y * width + x) * 4;
      data.set(image.data.subarray(sourceOffset, sourceOffset + 4), targetOffset);
    }
  }
  return { width, height, data };
}

function compositeOnWhite(data, offset) {
  const alpha = data[offset + 3] / 255;
  return [
    Math.round(data[offset] * alpha + 255 * (1 - alpha)),
    Math.round(data[offset + 1] * alpha + 255 * (1 - alpha)),
    Math.round(data[offset + 2] * alpha + 255 * (1 - alpha)),
  ];
}

function dataUrlBytes(value) {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/u.exec(String(value || ""));
  if (!match) throw codedError("invalid_browser_image", "浏览器验收截图不是 PNG data URL。");
  return decodeBase64(match[1]);
}

function decodeBase64(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw codedError("invalid_base64", "视觉验收图缺少 base64 数据。");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64").replace(/=+$/u, "") !== value.replace(/=+$/u, "")) {
    throw codedError("invalid_base64", "视觉验收图 base64 数据无效。");
  }
  return bytes;
}

function positiveInteger(value, field) {
  if (!Number.isInteger(value) || value <= 0) {
    throw codedError("visual_reference_dimensions", `视觉验收图 ${field} 必须是正整数。`);
  }
  return value;
}

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}
