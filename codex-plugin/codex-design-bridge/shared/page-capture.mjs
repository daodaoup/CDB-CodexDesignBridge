import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const CAPTURE_WIDTH = 1440;
const CAPTURE_HEIGHT = 900;

export async function capturePreviewPage({
  createBrowserWindow,
  previewUrl,
  rootDirectory,
}) {
  if (typeof createBrowserWindow !== "function") {
    throw new Error("A browser window factory is required.");
  }
  if (!previewUrl) {
    throw new Error("The preview URL is required.");
  }

  const captureWindow = createBrowserWindow({
    width: CAPTURE_WIDTH,
    height: CAPTURE_HEIGHT,
    useContentSize: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  try {
    captureWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    await captureWindow.loadURL(withCaptureRevision(previewUrl));
    await captureWindow.webContents.executeJavaScript(`
      Promise.all([
        document.fonts ? document.fonts.ready : Promise.resolve(),
        new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      ])
    `);
    const snapshot = await captureWindow.webContents.executeJavaScript(
      CAPTURE_PAGE_SCRIPT,
    );
    const manifest = createCapturedPageManifest(snapshot, {
      projectName: path.basename(path.resolve(rootDirectory)),
      previewUrl,
    });
    const pagesDirectory = path.join(path.resolve(rootDirectory), "pages");
    const filePath = path.join(
      pagesDirectory,
      `${manifest.pageId}.figma-page.json`,
    );
    await mkdir(pagesDirectory, { recursive: true });
    await writeFile(
      filePath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    return {
      filePath,
      manifest,
      nodeCount: countNodes(manifest.root),
    };
  } finally {
    if (!captureWindow.isDestroyed()) {
      captureWindow.destroy();
    }
  }
}

export function createCapturedPageManifest(
  snapshot,
  { projectName = "Frontend", previewUrl = "" } = {},
) {
  if (!snapshot?.root || snapshot.root.type !== "frame") {
    throw new Error("The preview did not produce a valid root frame.");
  }
  const safeProjectId = safeId(projectName);
  return {
    protocolVersion: 3,
    pageId: `preview-${safeProjectId}`,
    name: `${projectName} · 当前预览`,
    source: previewUrl ? { file: previewUrl } : undefined,
    root: snapshot.root,
  };
}

function safeId(value) {
  const normalized = String(value || "frontend")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z]+/, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return normalized || "frontend";
}

function countNodes(node) {
  if (!node) return 0;
  return (
    1 +
    (node.type === "frame"
      ? node.children.reduce((total, child) => total + countNodes(child), 0)
      : 0)
  );
}

function withCaptureRevision(url) {
  const value = new URL(url);
  value.searchParams.set("codexFigmaCapture", String(Date.now()));
  return value.toString();
}

export const CAPTURE_PAGE_SCRIPT = String.raw`
(async () => {
  const MAX_NODES = 480;
  const MAX_EXTERNAL_SVG_BYTES = 768 * 1024;
  const IGNORED_TAGS = new Set([
    "SCRIPT", "STYLE", "LINK", "META", "NOSCRIPT", "TEMPLATE", "BR"
  ]);
  const externalSvgByElement = new Map();
  const rasterImageByElement = new Map();
  const usedIds = new Set();
  let generatedId = 0;
  let nodeCount = 0;

  const round = (value) => Math.round(value * 100) / 100;
  const positive = (value) => Math.max(0.5, round(value));

  function isVisible(element) {
    if (!(element instanceof Element) || IGNORED_TAGS.has(element.tagName)) {
      return false;
    }
    const style = getComputedStyle(element);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number.parseFloat(style.opacity) === 0
    ) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0.5 && rect.height > 0.5;
  }

  function uniqueId(element, suffix = "") {
    const preferred =
      element?.getAttribute?.("data-codex-id") ||
      element?.id ||
      element?.tagName?.toLowerCase() ||
      "node";
    let base = String(preferred)
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[^A-Za-z]+/, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 90);
    if (!base) base = "node";
    let candidate = suffix ? (base + "-" + suffix) : base;
    while (usedIds.has(candidate)) {
      generatedId += 1;
      candidate = base + "-" + generatedId;
    }
    usedIds.add(candidate);
    return candidate;
  }

  function sourceRef(element) {
    const codexId = element?.getAttribute?.("data-codex-id");
    if (codexId) {
      return { selector: '[data-codex-id="' + codexId + '"]' };
    }
    if (element?.id) {
      return { selector: "#" + element.id };
    }
    return null;
  }

  function rgbaToHex(value, preserveTransparent = false) {
    if (!value || value === "transparent") {
      return preserveTransparent ? "#00000000" : null;
    }
    const match = value.match(
      /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i
    );
    if (!match) return null;
    const alphaValue = match[4];
    const alpha = alphaValue
      ? alphaValue.endsWith("%")
        ? Number.parseFloat(alphaValue) / 100
        : Number.parseFloat(alphaValue)
      : 1;
    if (!Number.isFinite(alpha) || alpha <= 0) {
      return preserveTransparent ? "#00000000" : null;
    }
    const channel = (number) =>
      Math.max(0, Math.min(255, Math.round(Number.parseFloat(number))))
        .toString(16)
        .padStart(2, "0")
        .toUpperCase();
    const alphaHex =
      alpha < 0.999
        ? Math.max(0, Math.min(255, Math.round(alpha * 255)))
            .toString(16)
            .padStart(2, "0")
            .toUpperCase()
        : "";
    return "#" + channel(match[1]) + channel(match[2]) + channel(match[3]) + alphaHex;
  }

  function splitCssLayers(value) {
    const layers = [];
    let start = 0;
    let depth = 0;
    for (let index = 0; index < value.length; index += 1) {
      const character = value[index];
      if (character === "(") depth += 1;
      else if (character === ")") depth = Math.max(0, depth - 1);
      else if (character === "," && depth === 0) {
        layers.push(value.slice(start, index).trim());
        start = index + 1;
      }
    }
    layers.push(value.slice(start).trim());
    return layers.filter(Boolean);
  }

  function normalizeGradientStops(stops) {
    if (stops.length < 2) return [];
    if (stops[0].position === null) stops[0].position = 0;
    if (stops[stops.length - 1].position === null) {
      stops[stops.length - 1].position = 1;
    }
    let anchor = 0;
    while (anchor < stops.length - 1) {
      let next = anchor + 1;
      while (next < stops.length && stops[next].position === null) next += 1;
      const from = stops[anchor].position;
      const to = stops[next].position;
      for (let index = anchor + 1; index < next; index += 1) {
        stops[index].position = from + ((to - from) * (index - anchor)) / (next - anchor);
      }
      anchor = next;
    }
    let previous = 0;
    return stops.slice(0, 16).map((stop) => {
      const position = Math.max(previous, Math.min(1, stop.position));
      previous = position;
      return { color: stop.color, position: round(position) };
    });
  }

  function gradientStop(token) {
    const colorMatch = token.match(/^(rgba?\([^)]*\)|#[0-9a-f]{3,8}|transparent)\s*(.*)$/i);
    if (!colorMatch) return [];
    const color = colorMatch[1].startsWith("#")
      ? colorMatch[1].toUpperCase()
      : rgbaToHex(colorMatch[1], true);
    if (!color) return [];
    const positions = Array.from(
      colorMatch[2].matchAll(/(-?\d*\.?\d+)(%|px)?/g),
      (match) => {
        const number = Number.parseFloat(match[1]);
        if (!Number.isFinite(number)) return null;
        if (match[2] === "%") return number / 100;
        return number >= 0 && number <= 1 ? number : number / 100;
      },
    ).filter((value) => value !== null);
    return (positions.length > 0 ? positions : [null]).map((position) => ({
      color,
      position,
    }));
  }

  function gradientAngle(token) {
    const angle = token.match(/^(-?\d*\.?\d+)deg$/i);
    if (angle) return Number.parseFloat(angle[1]);
    const directions = {
      "to top": 0,
      "to top right": 45,
      "to right": 90,
      "to bottom right": 135,
      "to bottom": 180,
      "to bottom left": 225,
      "to left": 270,
      "to top left": 315,
    };
    return directions[token.toLowerCase()];
  }

  function parseGradient(layer) {
    const match = layer.match(/^(linear-gradient|radial-gradient)\((.*)\)$/i);
    if (!match) return null;
    const type = match[1].toLowerCase();
    const parts = splitCssLayers(match[2]);
    let angle = 180;
    let center = { x: 0.5, y: 0.5 };
    if (type === "linear-gradient") {
      const parsedAngle = gradientAngle(parts[0] || "");
      if (parsedAngle !== undefined) {
        angle = parsedAngle;
        parts.shift();
      }
    } else {
      const descriptor = parts[0] || "";
      const centerMatch = descriptor.match(/\bat\s+(-?\d*\.?\d+)%\s+(-?\d*\.?\d+)%/i);
      if (centerMatch) {
        center = {
          x: Math.max(0, Math.min(1, Number.parseFloat(centerMatch[1]) / 100)),
          y: Math.max(0, Math.min(1, Number.parseFloat(centerMatch[2]) / 100)),
        };
      }
      if (/\b(circle|ellipse|closest|farthest|at)\b/i.test(descriptor)) {
        parts.shift();
      }
    }
    const stops = normalizeGradientStops(parts.flatMap(gradientStop));
    if (stops.length < 2) return null;
    return type === "linear-gradient"
      ? { type, angle: round(angle), stops }
      : { type, center, stops };
  }

  function parseBoxShadows(value) {
    if (!value || value === "none") return [];
    return splitCssLayers(value).flatMap((layer) => {
      if (/\binset\b/i.test(layer)) return [];
      const colorMatch = layer.match(/rgba?\([^)]*\)|#[0-9a-f]{3,8}|transparent/i);
      const color = colorMatch
        ? colorMatch[0].startsWith("#")
          ? colorMatch[0].toUpperCase()
          : rgbaToHex(colorMatch[0], true)
        : null;
      if (!color) return [];
      const numeric = layer
        .replace(colorMatch[0], "")
        .match(/-?\d*\.?\d+(?:px)?/gi) || [];
      const values = numeric.map(Number.parseFloat);
      if (values.length < 2 || values.some((value) => !Number.isFinite(value))) {
        return [];
      }
      return [{
        type: "drop-shadow",
        color,
        offsetX: round(values[0]),
        offsetY: round(values[1]),
        blur: Math.max(0, round(values[2] || 0)),
        spread: round(values[3] || 0),
      }];
    }).slice(0, 8);
  }

  function repeatedGridFallback(style, width, height) {
    if (!style.backgroundSize || /\bno-repeat\b/i.test(style.backgroundRepeat)) {
      return null;
    }
    const sizeMatch = style.backgroundSize.match(
      /^(\d*\.?\d+)px(?:\s+(\d*\.?\d+)px)?/i,
    );
    if (!sizeMatch) return null;
    const stepX = Number.parseFloat(sizeMatch[1]);
    const stepY = Number.parseFloat(sizeMatch[2] || sizeMatch[1]);
    if (!(stepX > 1 && stepY > 1)) return null;
    const layers = splitCssLayers(style.backgroundImage || "");
    const gradients = layers.map(parseGradient).filter(Boolean);
    if (
      gradients.length !== 2 ||
      gradients.some((gradient) => !gradient || gradient.type !== "linear-gradient")
    ) {
      return null;
    }
    const paths = [];
    for (const gradient of gradients) {
      const color = gradient.stops.find((stop) => !stop.color.endsWith("00"))?.color;
      if (!color) return null;
      const angle = ((gradient.angle % 180) + 180) % 180;
      if (Math.min(angle, 180 - angle) < 1) {
        const segments = [];
        for (let y = 0.5; y <= height; y += stepY) {
          segments.push("M0 " + round(y) + "H" + round(width));
        }
        paths.push('<path d="' + segments.join(" ") + '" stroke="' + color + '" fill="none"/>');
      } else if (Math.abs(angle - 90) < 1) {
        const segments = [];
        for (let x = 0.5; x <= width; x += stepX) {
          segments.push("M" + round(x) + " 0V" + round(height));
        }
        paths.push('<path d="' + segments.join(" ") + '" stroke="' + color + '" fill="none"/>');
      } else {
        return null;
      }
    }
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + round(width) +
      '" height="' + round(height) + '" viewBox="0 0 ' + round(width) + " " +
      round(height) + '">' + paths.join("") + "</svg>"
    );
  }

  function boxStyle(style, fallbackFill = null) {
    const result = {};
    const fill = rgbaToHex(style.backgroundColor) || fallbackFill;
    if (fill) result.fill = fill;

    const fills = splitCssLayers(style.backgroundImage || "")
      .map(parseGradient)
      .filter(Boolean)
      .slice(0, 4);
    if (fills.length > 0) result.fills = fills;

    const effects = parseBoxShadows(style.boxShadow);
    const backdropBlur = parseBackdropBlur(
      style.backdropFilter || style.webkitBackdropFilter,
    );
    if (backdropBlur) effects.push(backdropBlur);
    if (effects.length > 0) result.effects = effects;

    const borderWidths = {
      top: Number.parseFloat(style.borderTopWidth) || 0,
      right: Number.parseFloat(style.borderRightWidth) || 0,
      bottom: Number.parseFloat(style.borderBottomWidth) || 0,
      left: Number.parseFloat(style.borderLeftWidth) || 0,
    };
    const borderSides = ["top", "right", "bottom", "left"];
    const activeBorderSide = borderSides.find(
      (side) =>
        borderWidths[side] > 0 &&
        style[
          "border" + side[0].toUpperCase() + side.slice(1) + "Style"
        ] !== "none",
    );
    const borderColor = activeBorderSide
      ? rgbaToHex(
          style[
            "border" +
              activeBorderSide[0].toUpperCase() +
              activeBorderSide.slice(1) +
              "Color"
          ],
        )
      : null;
    if (activeBorderSide && borderColor) {
      result.stroke = borderColor;
      const roundedWidths = Object.fromEntries(
        Object.entries(borderWidths).map(([side, width]) => [side, round(width)]),
      );
      const uniqueWidths = new Set(Object.values(roundedWidths));
      if (uniqueWidths.size === 1) {
        result.strokeWidth = roundedWidths.top;
      } else {
        result.strokeWidths = roundedWidths;
      }
    }

    const radius = Number.parseFloat(style.borderTopLeftRadius);
    if (radius > 0) result.radius = round(radius);
    return result;
  }

  function cssPixels(value) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function borderMetrics(style) {
    return {
      top: cssPixels(style.borderTopWidth),
      right: cssPixels(style.borderRightWidth),
      bottom: cssPixels(style.borderBottomWidth),
      left: cssPixels(style.borderLeftWidth),
    };
  }

  function cssBoxSize(style) {
    const borders = borderMetrics(style);
    const declaredWidth = cssPixels(style.width);
    const declaredHeight = cssPixels(style.height);
    const borderBox = String(style.boxSizing || "").toLowerCase() === "border-box";
    return {
      width: borderBox
        ? declaredWidth
        : declaredWidth + borders.left + borders.right,
      height: borderBox
        ? declaredHeight
        : declaredHeight + borders.top + borders.bottom,
    };
  }

  function borderTriangle(style) {
    const borders = borderMetrics(style);
    const declaredWidth = cssPixels(style.width);
    const declaredHeight = cssPixels(style.height);
    const borderBox = String(style.boxSizing || "").toLowerCase() === "border-box";
    const hasEmptyContentBox =
      (declaredWidth <= 0.5 && declaredHeight <= 0.5) ||
      (borderBox &&
        declaredWidth <= borders.left + borders.right + 0.5 &&
        declaredHeight <= borders.top + borders.bottom + 0.5);
    if (!hasEmptyContentBox) return null;
    const sides = ["top", "right", "bottom", "left"];
    const colors = Object.fromEntries(
      sides.map((side) => {
        const property =
          "border" + side[0].toUpperCase() + side.slice(1) + "Color";
        return [side, rgbaToHex(style[property], true)];
      })
    );
    const opaqueSides = sides.filter(
      (side) =>
        borders[side] > 0 &&
        colors[side] &&
        !colors[side].endsWith("00")
    );
    if (opaqueSides.length !== 1) return null;
    const side = opaqueSides[0];
    const width = borders.left + borders.right;
    const height = borders.top + borders.bottom;
    if (width <= 0.5 || height <= 0.5) return null;
    const paths = {
      left: "M0 0L" + round(width) + " " + round(height / 2) + "L0 " + round(height) + "Z",
      right: "M" + round(width) + " 0L0 " + round(height / 2) + "L" + round(width) + " " + round(height) + "Z",
      top: "M0 0L" + round(width / 2) + " " + round(height) + "L" + round(width) + " 0Z",
      bottom: "M0 " + round(height) + "L" + round(width / 2) + " 0L" + round(width) + " " + round(height) + "Z",
    };
    return {
      width,
      height,
      svg:
        '<svg xmlns="http://www.w3.org/2000/svg" width="' + round(width) +
        '" height="' + round(height) + '" viewBox="0 0 ' + round(width) +
        " " + round(height) + '"><path d="' + paths[side] + '" fill="' +
        colors[side] + '"/></svg>',
    };
  }

  function pseudoExists(style) {
    const content = String(style.content || "").trim().toLowerCase();
    return content && content !== "none" && content !== "normal";
  }

  function pseudoOffset(style, hostWidth, hostHeight, width, height) {
    const left = String(style.left || "auto");
    const right = String(style.right || "auto");
    const top = String(style.top || "auto");
    const bottom = String(style.bottom || "auto");
    let x = left !== "auto"
      ? cssPixels(left)
      : right !== "auto"
        ? hostWidth - cssPixels(right) - width
        : 0;
    let y = top !== "auto"
      ? cssPixels(top)
      : bottom !== "auto"
        ? hostHeight - cssPixels(bottom) - height
        : 0;
    let rotation = 0;
    if (style.transform && style.transform !== "none") {
      try {
        const matrix = new DOMMatrixReadOnly(style.transform);
        x += matrix.e || 0;
        y += matrix.f || 0;
        rotation = round((Math.atan2(matrix.b, matrix.a) * 180) / Math.PI);
      } catch {}
    }
    return { x: round(x), y: round(y), rotation };
  }

  function pseudoDefinition(element, pseudo, hostWidth, hostHeight) {
    if (nodeCount >= MAX_NODES) return null;
    const style = getComputedStyle(element, pseudo);
    if (!pseudoExists(style) || style.display === "none" || style.visibility === "hidden") {
      return null;
    }
    const triangle = borderTriangle(style);
    const size = triangle || cssBoxSize(style);
    if (size.width <= 0.5 || size.height <= 0.5) return null;
    const kind = pseudo === "::before" ? "before" : "after";
    const offset = pseudoOffset(style, hostWidth, hostHeight, size.width, size.height);
    const common = {
      id: uniqueId(element, kind),
      name: (element.getAttribute("aria-label") || element.getAttribute("data-codex-id") || element.tagName.toLowerCase()) + " " + kind,
      sourceRef: null,
      width: positive(size.width),
      height: positive(size.height),
      x: offset.x,
      y: offset.y,
      opacity: Math.max(0, Math.min(1, Number.parseFloat(style.opacity) || 1)),
      rotation: offset.rotation,
      style: {},
    };
    if (triangle) {
      nodeCount += 1;
      return { ...common, type: "svg", svg: triangle.svg };
    }
    const decoration = boxStyle(style);
    if (Object.keys(decoration).length === 0) return null;
    nodeCount += 1;
    return {
      ...common,
      type: "frame",
      clipsContent: false,
      style: decoration,
      layout: {
        kind: "none",
        direction: "none",
        wrap: false,
        gap: 0,
        counterGap: 0,
        padding: { top: 0, right: 0, bottom: 0, left: 0 },
        align: "start",
        justify: "start",
        primarySizing: "fixed",
        counterSizing: "fixed",
      },
      children: [],
    };
  }

  function parseBackdropBlur(value) {
    if (!value || value === "none") return null;
    const match = String(value).match(/blur\(\s*([\d.]+)px\s*\)/i);
    if (!match) return null;
    const blur = Number.parseFloat(match[1]);
    return Number.isFinite(blur) && blur >= 0
      ? { type: "background-blur", blur: round(blur) }
      : null;
  }

  function fontStyle(style) {
    const numericWeight = Number.parseInt(style.fontWeight, 10);
    let weight = "Regular";
    if (numericWeight >= 700) weight = "Bold";
    else if (numericWeight >= 600) weight = "Semi Bold";
    else if (numericWeight >= 500) weight = "Medium";
    const italic = style.fontStyle === "italic" ? " Italic" : "";
    return weight + italic;
  }

  function textDefinition({
    id,
    name,
    text,
    rect,
    parentRect,
    style,
    ref = null,
    layoutItem = null,
  }) {
    const fontSize = Number.parseFloat(style.fontSize) || 16;
    const parsedLineHeight = Number.parseFloat(style.lineHeight);
    const letterSpacing = Number.parseFloat(style.letterSpacing);
    const fill = rgbaToHex(style.color) || "#000000";
    const textAlign =
      style.textAlign === "center" ||
      style.textAlign === "right" ||
      style.textAlign === "justify"
        ? style.textAlign === "justify"
          ? "justified"
          : style.textAlign
        : "left";
    const widthSafety = Math.min(
      12,
      Math.max(1, fontSize * 0.3, Math.abs(letterSpacing || 0)),
    );
    const width = positive(rect.width + widthSafety);
    const xAdjustment =
      textAlign === "right"
        ? widthSafety
        : textAlign === "center"
          ? widthSafety / 2
          : 0;
    return {
      id,
      type: "text",
      name,
      sourceRef: ref,
      width,
      height: positive(rect.height),
      x: round(rect.left - parentRect.left - xAdjustment),
      y: round(rect.top - parentRect.top),
      opacity: Math.max(0, Math.min(1, Number.parseFloat(style.opacity) || 1)),
      style: { fill },
      ...(layoutItem ? { layoutItem } : {}),
      text,
      font: {
        family: style.fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, "") || "Inter",
        style: fontStyle(style),
        size: positive(fontSize),
        lineHeight: positive(
          Number.isFinite(parsedLineHeight) ? parsedLineHeight : fontSize * 1.2
        ),
        letterSpacing: Number.isFinite(letterSpacing) ? round(letterSpacing) : 0,
      },
      textAlign,
    };
  }

  function cleanElementText(element) {
    return String(element.innerText || element.textContent || "")
      .replace(/\r/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .trim();
  }

  function directTextChildren(element, parentRect, style) {
    const definitions = [];
    let index = 0;
    for (const child of element.childNodes) {
      if (child.nodeType !== Node.TEXT_NODE || !child.textContent.trim()) {
        continue;
      }
      const range = document.createRange();
      range.selectNodeContents(child);
      const rect = range.getBoundingClientRect();
      range.detach();
      if (rect.width <= 0.5 || rect.height <= 0.5 || nodeCount >= MAX_NODES) {
        continue;
      }
      index += 1;
      nodeCount += 1;
      definitions.push(
        textDefinition({
          id: uniqueId(element, "text-" + index),
          name: element.tagName.toLowerCase() + " text",
          text: child.textContent.replace(/\s+/g, " ").trim(),
          rect,
          parentRect,
          style,
          ref: sourceRef(element),
        })
      );
    }
    return definitions;
  }

  function hasDecoration(style) {
    return Boolean(
      rgbaToHex(style.backgroundColor) ||
      (style.backgroundImage && style.backgroundImage !== "none") ||
      (style.boxShadow && style.boxShadow !== "none") ||
      (Number.parseFloat(style.borderTopWidth) > 0 &&
        style.borderTopStyle !== "none")
    );
  }

  function serializeSvg(element) {
    const clone = element.cloneNode(true);
    const sourceNodes = [element, ...element.querySelectorAll("*")];
    const cloneNodes = [clone, ...clone.querySelectorAll("*")];
    const attributes = [
      ["fill", "fill"],
      ["stroke", "stroke"],
      ["stroke-width", "strokeWidth"],
      ["stroke-linecap", "strokeLinecap"],
      ["stroke-linejoin", "strokeLinejoin"],
      ["stroke-dasharray", "strokeDasharray"],
      ["stroke-dashoffset", "strokeDashoffset"],
      ["fill-rule", "fillRule"],
      ["clip-rule", "clipRule"],
      ["fill-opacity", "fillOpacity"],
      ["stroke-opacity", "strokeOpacity"],
      ["opacity", "opacity"],
      ["stop-color", "stopColor"],
      ["stop-opacity", "stopOpacity"],
    ];
    for (let index = 0; index < sourceNodes.length; index += 1) {
      const computed = getComputedStyle(sourceNodes[index]);
      const target = cloneNodes[index];
      const resolvedColor = computed.color || "#000000";
      for (const [attribute, property] of attributes) {
        const computedValue = computed[property];
        const value = ["fill", "stroke", "stop-color"].includes(attribute)
          ? rgbaToHex(computedValue, true) || computedValue
          : computedValue;
        if (value && value !== "normal") {
          target.setAttribute(attribute, value.replace(/currentColor/gi, resolvedColor));
        }
      }
    }
    return clone.outerHTML.replace(/currentColor/gi, getComputedStyle(element).color || "#000000");
  }

  function transformedGeometry(element, rect, style) {
    if (!style.transform || style.transform === "none") {
      return { width: positive(rect.width), height: positive(rect.height), rotation: 0 };
    }
    const matrix = new DOMMatrixReadOnly(style.transform);
    const scaleX = Math.hypot(matrix.a, matrix.b) || 1;
    const scaleY = Math.hypot(matrix.c, matrix.d) || 1;
    const rotation = round((Math.atan2(matrix.b, matrix.a) * 180) / Math.PI);
    const baseWidth = element.offsetWidth || rect.width;
    const baseHeight = element.offsetHeight || rect.height;
    return {
      width: positive(baseWidth * scaleX),
      height: positive(baseHeight * scaleY),
      rotation,
    };
  }

  function projectFileFromUrl(url) {
    try {
      const decoded = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      return decoded && !decoded.split("/").includes("..") ? decoded : "";
    } catch {
      return "";
    }
  }

  function svgDimension(value) {
    const match = String(value || "").trim().match(/^(\d+(?:\.\d+)?)(?:px)?$/i);
    const parsed = match ? Number(match[1]) : 0;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  async function loadExternalSvg(element) {
    const source = element.currentSrc || element.getAttribute("src") || "";
    let url;
    try {
      url = new URL(source, document.baseURI);
    } catch {
      return null;
    }
    if (
      url.origin !== location.origin ||
      !url.pathname.toLowerCase().endsWith(".svg")
    ) {
      return null;
    }
    try {
      const response = await fetch(url.href, {
        credentials: "same-origin",
        cache: "no-store",
      });
      const responseUrl = new URL(response.url || url.href);
      if (!response.ok || responseUrl.origin !== location.origin) {
        return null;
      }
      const declaredLength = Number(response.headers.get("content-length") || 0);
      if (declaredLength > MAX_EXTERNAL_SVG_BYTES) {
        return null;
      }
      const svg = await response.text();
      if (
        !svg ||
        new TextEncoder().encode(svg).length > MAX_EXTERNAL_SVG_BYTES
      ) {
        return null;
      }
      const documentNode = new DOMParser().parseFromString(
        svg,
        "image/svg+xml"
      );
      const root = documentNode.documentElement;
      if (
        !root ||
        root.localName?.toLowerCase() !== "svg" ||
        documentNode.querySelector("parsererror")
      ) {
        return null;
      }
      const rect = element.getBoundingClientRect();
      if (!root.getAttribute("viewBox")) {
        const naturalWidth =
          svgDimension(root.getAttribute("width")) || element.naturalWidth;
        const naturalHeight =
          svgDimension(root.getAttribute("height")) || element.naturalHeight;
        if (naturalWidth > 0 && naturalHeight > 0) {
          root.setAttribute(
            "viewBox",
            "0 0 " + round(naturalWidth) + " " + round(naturalHeight)
          );
        }
      }
      root.setAttribute("width", String(positive(rect.width)));
      root.setAttribute("height", String(positive(rect.height)));
      return {
        file: projectFileFromUrl(url),
        svg: new XMLSerializer().serializeToString(root),
      };
    } catch {
      return null;
    }
  }

  async function loadRasterImage(element) {
    try {
      const url = new URL(element.currentSrc || element.src, location.href);
      if (url.origin !== location.origin || /\.svg(?:$|[?#])/i.test(url.href)) {
        return null;
      }
      const response = await fetch(url.href, {
        credentials: "same-origin",
        cache: "no-store",
      });
      const responseUrl = new URL(response.url || url.href);
      const mimeType = String(response.headers.get("content-type") || "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      if (
        !response.ok ||
        responseUrl.origin !== location.origin ||
        !["image/png", "image/jpeg", "image/webp"].includes(mimeType)
      ) {
        return null;
      }
      const declaredLength = Number(response.headers.get("content-length") || 0);
      if (declaredLength > 1024 * 1024) return null;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > 1024 * 1024) return null;
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 8192) {
        binary += String.fromCharCode(...bytes.slice(offset, offset + 8192));
      }
      return {
        file: projectFileFromUrl(url),
        mimeType,
        base64: btoa(binary),
      };
    } catch {
      return null;
    }
  }

  function pixelValue(value) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) && parsed >= 0 ? round(parsed) : 0;
  }

  function cssAlignment(value, fallback = "start") {
    return {
      "flex-start": "start",
      start: "start",
      center: "center",
      "flex-end": "end",
      end: "end",
      stretch: "stretch",
      baseline: "baseline",
      "space-between": "space-between",
    }[value] || fallback;
  }

  function layoutDefinition(element, style) {
    const display = String(style.display || "").toLowerCase();
    const padding = {
      top: pixelValue(style.paddingTop),
      right: pixelValue(style.paddingRight),
      bottom: pixelValue(style.paddingBottom),
      left: pixelValue(style.paddingLeft),
    };
    if (display === "flex" || display === "inline-flex") {
      const horizontal = !String(style.flexDirection || "row").startsWith("column");
      const primaryGap = horizontal ? style.columnGap : style.rowGap;
      const counterGap = horizontal ? style.rowGap : style.columnGap;
      return {
        kind: "flex",
        direction: horizontal ? "horizontal" : "vertical",
        wrap: style.flexWrap !== "nowrap",
        gap: pixelValue(primaryGap),
        counterGap: pixelValue(counterGap),
        padding,
        align: cssAlignment(style.alignItems),
        justify: cssAlignment(style.justifyContent),
        primarySizing: display === "inline-flex" ? "hug" : "fixed",
        counterSizing: display === "inline-flex" ? "hug" : "fixed",
      };
    }
    if (display === "grid" || display === "inline-grid") {
      return {
        kind: "grid",
        direction: "none",
        wrap: false,
        gap: pixelValue(style.columnGap),
        counterGap: pixelValue(style.rowGap),
        padding,
        align: cssAlignment(style.alignItems),
        justify: cssAlignment(style.justifyContent),
        primarySizing: display === "inline-grid" ? "hug" : "fixed",
        counterSizing: display === "inline-grid" ? "hug" : "fixed",
        grid: {
          columns: String(style.gridTemplateColumns || "none").slice(0, 500),
          rows: String(style.gridTemplateRows || "none").slice(0, 500),
        },
      };
    }
    return {
      kind: "none",
      direction: "none",
      wrap: false,
      gap: 0,
      counterGap: 0,
      padding,
      align: "start",
      justify: "start",
      primarySizing: "fixed",
      counterSizing: "fixed",
    };
  }

  function layoutItemDefinition(element, style, isRoot) {
    if (isRoot || !element.parentElement) return null;
    const parentStyle = getComputedStyle(element.parentElement);
    const parentDisplay = String(parentStyle.display || "").toLowerCase();
    const isFlex = parentDisplay === "flex" || parentDisplay === "inline-flex";
    const isGrid = parentDisplay === "grid" || parentDisplay === "inline-grid";
    if (!isFlex && !isGrid && style.position !== "absolute") return null;
    const grow = Number.parseFloat(style.flexGrow);
    const shrink = Number.parseFloat(style.flexShrink);
    const parentHorizontal = !String(parentStyle.flexDirection || "row").startsWith("column");
    return {
      align:
        style.alignSelf === "auto"
          ? "auto"
          : cssAlignment(style.alignSelf, "auto"),
      grow: Number.isFinite(grow) && grow >= 0 ? round(grow) : 0,
      shrink: Number.isFinite(shrink) && shrink >= 0 ? round(shrink) : 1,
      basis: String(style.flexBasis || "auto").slice(0, 80),
      order: Number.isFinite(Number.parseInt(style.order, 10))
        ? Number.parseInt(style.order, 10)
        : 0,
      positioning: style.position === "absolute" ? "absolute" : "auto",
      horizontalSizing:
        isFlex && parentHorizontal && grow > 0 ? "fill" : "fixed",
      verticalSizing:
        isFlex && !parentHorizontal && grow > 0 ? "fill" : "fixed",
      gridRow: isGrid ? String(style.gridRow || "auto").slice(0, 80) : "auto",
      gridColumn: isGrid
        ? String(style.gridColumn || "auto").slice(0, 80)
        : "auto",
    };
  }

  function buildNode(element, parentRect, isRoot = false) {
    if (!isVisible(element) || nodeCount >= MAX_NODES) return null;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const geometry = transformedGeometry(element, rect, style);
    const childElements = Array.from(element.children).filter(isVisible);
    const meaningfulChildren = childElements.filter(
      (child) => !IGNORED_TAGS.has(child.tagName)
    ).sort((left, right) => {
      const order =
        (Number.parseInt(getComputedStyle(left).order, 10) || 0) -
        (Number.parseInt(getComputedStyle(right).order, 10) || 0);
      return order || childElements.indexOf(left) - childElements.indexOf(right);
    });
    const text = cleanElementText(element);
    const id = uniqueId(element);
    const ref = sourceRef(element);
    const layoutItem = layoutItemDefinition(element, style, isRoot);
    nodeCount += 1;

    if (element.localName?.toLowerCase() === "svg") {
      return {
        id,
        type: "svg",
        name: element.getAttribute("aria-label") || id,
        sourceRef: ref,
        ...(layoutItem ? { layoutItem } : {}),
        width: geometry.width,
        height: geometry.height,
        x: round(rect.left - parentRect.left),
        y: round(rect.top - parentRect.top),
        opacity: Math.max(0, Math.min(1, Number.parseFloat(style.opacity) || 1)),
        rotation: geometry.rotation,
        style: {},
        svg: serializeSvg(element),
      };
    }

    const externalSvg = externalSvgByElement.get(element);
    if (externalSvg) {
      const resolvedColor = rgbaToHex(style.color) || "#000000";
      return {
        id,
        type: "svg",
        name:
          element.getAttribute("aria-label") ||
          element.getAttribute("alt") ||
          id,
        sourceRef: {
          ...(ref || {}),
          ...(externalSvg.file ? { file: externalSvg.file } : {}),
        },
        ...(layoutItem ? { layoutItem } : {}),
        width: geometry.width,
        height: geometry.height,
        x: round(rect.left - parentRect.left),
        y: round(rect.top - parentRect.top),
        opacity: Math.max(0, Math.min(1, Number.parseFloat(style.opacity) || 1)),
        rotation: geometry.rotation,
        style: {},
        svg: externalSvg.svg.replace(/currentColor/gi, resolvedColor),
      };
    }

    const rasterImage = rasterImageByElement.get(element);
    if (rasterImage) {
      return {
        id,
        type: "image",
        name:
          element.getAttribute("aria-label") ||
          element.getAttribute("alt") ||
          id,
        sourceRef: {
          ...(ref || {}),
          ...(rasterImage.file ? { file: rasterImage.file } : {}),
        },
        ...(layoutItem ? { layoutItem } : {}),
        width: geometry.width,
        height: geometry.height,
        x: round(rect.left - parentRect.left),
        y: round(rect.top - parentRect.top),
        opacity: Math.max(0, Math.min(1, Number.parseFloat(style.opacity) || 1)),
        rotation: geometry.rotation,
        style: {},
        objectFit: ["fill", "contain", "cover", "none", "scale-down"].includes(style.objectFit)
          ? style.objectFit
          : "cover",
        image: {
          mimeType: rasterImage.mimeType,
          base64: rasterImage.base64,
        },
      };
    }

    if (
      !isRoot &&
      meaningfulChildren.length === 0 &&
      text &&
      !hasDecoration(style)
    ) {
      return textDefinition({
        id,
        name: element.getAttribute("aria-label") || id,
        text,
        rect,
        parentRect,
        style,
        ref,
        layoutItem,
      });
    }

    let fallbackFill = null;
    if (isRoot) {
      const bodyFill = rgbaToHex(getComputedStyle(document.body).backgroundColor);
      const htmlFill = rgbaToHex(
        getComputedStyle(document.documentElement).backgroundColor
      );
      fallbackFill = bodyFill || htmlFill || "#FFFFFF";
    }
    const node = {
      id,
      type: "frame",
      name: element.getAttribute("aria-label") || id,
      sourceRef: ref,
      clipsContent:
        ["hidden", "clip"].includes(style.overflowX) ||
        ["hidden", "clip"].includes(style.overflowY),
      width: geometry.width,
      height: geometry.height,
      x: isRoot ? 0 : round(rect.left - parentRect.left),
      y: isRoot ? 0 : round(rect.top - parentRect.top),
      opacity: Math.max(0, Math.min(1, Number.parseFloat(style.opacity) || 1)),
      rotation: geometry.rotation,
      style: boxStyle(style, fallbackFill),
      ...(layoutItem ? { layoutItem } : {}),
      layout: layoutDefinition(element, style),
      children: [],
    };

    const triangle = borderTriangle(style);
    if (triangle) {
      delete node.style.stroke;
      delete node.style.strokeWidth;
      delete node.style.strokeWidths;
      if (nodeCount < MAX_NODES) {
        nodeCount += 1;
        node.children.push({
          id: uniqueId(element, "border-shape"),
          type: "svg",
          name: (element.getAttribute("aria-label") || id) + " border shape",
          sourceRef: null,
          width: positive(triangle.width),
          height: positive(triangle.height),
          x: 0,
          y: 0,
          opacity: 1,
          rotation: 0,
          style: {},
          svg: triangle.svg,
        });
      }
    }

    const before = pseudoDefinition(
      element,
      "::before",
      geometry.width,
      geometry.height,
    );
    if (before) node.children.push(before);

    const repeatedGrid = repeatedGridFallback(
      style,
      geometry.width,
      geometry.height,
    );
    const hasExplicitBackgroundSize = splitCssLayers(
      style.backgroundSize || "",
    ).some((size) => !/^auto(?:\s+auto)?$/i.test(size));
    if (hasExplicitBackgroundSize) {
      delete node.style.fills;
    }
    if (repeatedGrid && nodeCount < MAX_NODES) {
      nodeCount += 1;
      node.children.push({
        id: uniqueId(element, "background-grid"),
        type: "svg",
        name: (element.getAttribute("aria-label") || id) + " background grid",
        sourceRef: null,
        width: geometry.width,
        height: geometry.height,
        x: 0,
        y: 0,
        opacity: 1,
        rotation: 0,
        style: {},
        svg: repeatedGrid,
      });
    }

    for (const child of meaningfulChildren) {
      const definition = buildNode(child, rect, false);
      if (definition) node.children.push(definition);
    }
    node.children.push(...directTextChildren(element, rect, style));
    const after = pseudoDefinition(
      element,
      "::after",
      geometry.width,
      geometry.height,
    );
    if (after) node.children.push(after);
    return node;
  }

  const rootElement =
    document.querySelector("[data-codex-root]") ||
    document.querySelector('[data-codex-id="landing-root"]') ||
    document.querySelector("main") ||
    document.querySelector("#root > *") ||
    document.body;
  await Promise.all(
    Array.from(rootElement.querySelectorAll("img"))
      .filter(isVisible)
      .map(async (element) => {
        const externalSvg = await loadExternalSvg(element);
        if (externalSvg) {
          externalSvgByElement.set(element, externalSvg);
          return;
        }
        const rasterImage = await loadRasterImage(element);
        if (rasterImage) rasterImageByElement.set(element, rasterImage);
      })
  );
  const rootRect = rootElement.getBoundingClientRect();
  const root = buildNode(rootElement, rootRect, true);
  if (!root || root.type !== "frame") {
    throw new Error("No visible page root was found.");
  }
  return {
    title: document.title || "Frontend preview",
    root,
    nodeCount,
  };
})()
`;
