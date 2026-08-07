import { computeHash, prepareSvgAsset } from "./svg.mjs";

const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_NODES = 500;
const NODE_TYPES = new Set(["frame", "image", "text", "svg"]);
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*$/;

export class PageValidationError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = "PageValidationError";
    this.details = details;
  }
}

export function preparePageManifest({ json, sourcePath }) {
  if (typeof json !== "string" || json.trim() === "") {
    throw new PageValidationError("Page manifest is empty.");
  }
  if (Buffer.byteLength(json, "utf8") > MAX_PAGE_BYTES) {
    throw new PageValidationError("Page manifest exceeds the 2 MB limit.");
  }

  let value;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new PageValidationError(`Page manifest JSON is invalid: ${error.message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PageValidationError("Page manifest must be an object.");
  }

  const pageId = requiredId(value.pageId, "pageId");
  if (!value.root || value.root.type !== "frame") {
    throw new PageValidationError("Page manifest root must be a frame.");
  }

  const ids = new Set();
  let nodeCount = 0;
  const normalizeNode = (node, path) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      throw new PageValidationError(`${path} must be an object.`);
    }
    if (!NODE_TYPES.has(node.type)) {
      throw new PageValidationError(
        `${path}.type must be one of: ${Array.from(NODE_TYPES).join(", ")}.`,
      );
    }
    const id = requiredId(node.id, `${path}.id`);
    if (ids.has(id)) {
      throw new PageValidationError(`Duplicate page node id "${id}".`);
    }
    ids.add(id);
    nodeCount += 1;
    if (nodeCount > MAX_NODES) {
      throw new PageValidationError(`Page manifest exceeds ${MAX_NODES} nodes.`);
    }

    const normalized = {
      id,
      type: node.type,
      name: optionalString(node.name, id, `${path}.name`, 120),
      sourceRef: normalizeSourceRef(node.sourceRef, `${path}.sourceRef`),
      width: positiveNumber(node.width, `${path}.width`),
      height: positiveNumber(node.height, `${path}.height`),
      x: finiteNumber(node.x, 0, `${path}.x`),
      y: finiteNumber(node.y, 0, `${path}.y`),
      rotation: finiteNumber(node.rotation, 0, `${path}.rotation`),
      visible: typeof node.visible === "boolean" ? node.visible : true,
      opacity: boundedNumber(node.opacity, 1, 0, 1, `${path}.opacity`),
      style: normalizeStyle(node.style, `${path}.style`),
    };
    if (node.layoutItem !== undefined) {
      normalized.layoutItem = normalizeLayoutItem(
        node.layoutItem,
        `${path}.layoutItem`,
      );
    }

    if (node.type === "frame") {
      normalized.layout = normalizeLayout(node.layout, `${path}.layout`);
      const children = node.children ?? [];
      if (!Array.isArray(children)) {
        throw new PageValidationError(`${path}.children must be an array.`);
      }
      normalized.children = children.map((child, index) =>
        normalizeNode(child, `${path}.children[${index}]`),
      );
    } else if (node.type === "text") {
      normalized.text = optionalString(node.text, "", `${path}.text`, 20_000);
      normalized.font = normalizeFont(node.font, `${path}.font`);
      normalized.textAlign =
        optionalEnum(
          node.textAlign,
          ["left", "center", "right", "justified"],
          "left",
          `${path}.textAlign`,
        );
    } else if (node.type === "image") {
      normalized.image = normalizeImage(node.image, `${path}.image`);
      normalized.objectFit = optionalEnum(
        node.objectFit,
        ["fill", "contain", "cover", "none", "scale-down"],
        "cover",
        `${path}.objectFit`,
      );
    } else {
      if (typeof node.svg !== "string" || node.svg.trim() === "") {
        throw new PageValidationError(`${path}.svg is required.`);
      }
      prepareSvgAsset({
        svg: node.svg,
        assetId: `${pageId}/${id}.svg`,
        sourcePath,
        requireTargets: false,
      });
      normalized.svg = node.svg;
    }

    return normalized;
  };

  const root = normalizeNode(value.root, "root");
  return {
    protocolVersion: 3,
    pageId,
    name: optionalString(value.name, pageId, "name", 120),
    sourcePath,
    sourceHash: computeHash(json),
    source: normalizeSourceRef(value.source, "source"),
    root,
    nodeIds: Array.from(ids),
    preparedAt: new Date().toISOString(),
  };
}

function normalizeImage(image, path) {
  if (!image || typeof image !== "object" || Array.isArray(image)) {
    throw new PageValidationError(`${path} must be an object.`);
  }
  if (!["image/png", "image/jpeg", "image/webp"].includes(image.mimeType)) {
    throw new PageValidationError(`${path}.mimeType is not supported.`);
  }
  if (
    typeof image.base64 !== "string" ||
    image.base64.length === 0 ||
    image.base64.length > 1536 * 1024 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.base64)
  ) {
    throw new PageValidationError(`${path}.base64 is invalid or too large.`);
  }
  return { mimeType: image.mimeType, base64: image.base64 };
}

function normalizeStyle(style, path) {
  if (style === undefined) {
    return {};
  }
  if (!style || typeof style !== "object" || Array.isArray(style)) {
    throw new PageValidationError(`${path} must be an object.`);
  }
  return {
    ...(style.fill !== undefined
      ? { fill: cssColor(style.fill, `${path}.fill`) }
      : {}),
    ...(style.stroke !== undefined
      ? { stroke: cssColor(style.stroke, `${path}.stroke`) }
      : {}),
    ...(style.strokeWidth !== undefined
      ? {
          strokeWidth: nonNegativeNumber(
            style.strokeWidth,
            `${path}.strokeWidth`,
          ),
        }
      : {}),
    ...(style.strokeWidths !== undefined
      ? {
          strokeWidths: normalizeStrokeWidths(
            style.strokeWidths,
            `${path}.strokeWidths`,
          ),
        }
      : {}),
    ...(style.radius !== undefined
      ? { radius: nonNegativeNumber(style.radius, `${path}.radius`) }
      : {}),
    ...(style.fills !== undefined
      ? { fills: normalizeGradientFills(style.fills, `${path}.fills`) }
      : {}),
    ...(style.effects !== undefined
      ? { effects: normalizeEffects(style.effects, `${path}.effects`) }
      : {}),
  };
}

function normalizeStrokeWidths(widths, path) {
  if (!widths || typeof widths !== "object" || Array.isArray(widths)) {
    throw new PageValidationError(`${path} must be an object.`);
  }
  return {
    top: nonNegativeNumber(widths.top, `${path}.top`),
    right: nonNegativeNumber(widths.right, `${path}.right`),
    bottom: nonNegativeNumber(widths.bottom, `${path}.bottom`),
    left: nonNegativeNumber(widths.left, `${path}.left`),
  };
}

function normalizeGradientFills(fills, path) {
  if (!Array.isArray(fills) || fills.length > 4) {
    throw new PageValidationError(`${path} must be an array of at most 4 gradients.`);
  }
  return fills.map((fill, index) => {
    const fillPath = `${path}[${index}]`;
    if (!fill || typeof fill !== "object" || Array.isArray(fill)) {
      throw new PageValidationError(`${fillPath} must be an object.`);
    }
    const type = optionalEnum(
      fill.type,
      ["linear-gradient", "radial-gradient"],
      "linear-gradient",
      `${fillPath}.type`,
    );
    if (!Array.isArray(fill.stops) || fill.stops.length < 2 || fill.stops.length > 16) {
      throw new PageValidationError(`${fillPath}.stops must contain 2 to 16 stops.`);
    }
    return {
      type,
      stops: fill.stops.map((stop, stopIndex) => {
        const stopPath = `${fillPath}.stops[${stopIndex}]`;
        if (!stop || typeof stop !== "object" || Array.isArray(stop)) {
          throw new PageValidationError(`${stopPath} must be an object.`);
        }
        return {
          color: cssColor(stop.color, `${stopPath}.color`),
          position: boundedNumber(
            stop.position,
            0,
            0,
            1,
            `${stopPath}.position`,
          ),
        };
      }),
      ...(type === "linear-gradient"
        ? { angle: finiteNumber(fill.angle, 180, `${fillPath}.angle`) }
        : {
            center: {
              x: boundedNumber(fill.center?.x, 0.5, 0, 1, `${fillPath}.center.x`),
              y: boundedNumber(fill.center?.y, 0.5, 0, 1, `${fillPath}.center.y`),
            },
          }),
    };
  });
}

function normalizeEffects(effects, path) {
  if (!Array.isArray(effects) || effects.length > 8) {
    throw new PageValidationError(`${path} must be an array of at most 8 effects.`);
  }
  return effects.map((effect, index) => {
    const effectPath = `${path}[${index}]`;
    if (!effect || typeof effect !== "object" || Array.isArray(effect)) {
      throw new PageValidationError(`${effectPath} must be an object.`);
    }
    const type = optionalEnum(
      effect.type,
      ["drop-shadow", "background-blur"],
      "drop-shadow",
      `${effectPath}.type`,
    );
    if (type === "background-blur") {
      return {
        type,
        blur: nonNegativeNumber(effect.blur ?? 0, `${effectPath}.blur`),
      };
    }
    return {
      type,
      color: cssColor(effect.color, `${effectPath}.color`),
      offsetX: finiteNumber(effect.offsetX, 0, `${effectPath}.offsetX`),
      offsetY: finiteNumber(effect.offsetY, 0, `${effectPath}.offsetY`),
      blur: nonNegativeNumber(effect.blur ?? 0, `${effectPath}.blur`),
      spread: finiteNumber(effect.spread, 0, `${effectPath}.spread`),
    };
  });
}

function normalizeLayout(layout, path) {
  if (layout === undefined) {
    return {
      kind: "none",
      direction: "none",
      gap: 0,
      counterGap: 0,
      padding: { top: 0, right: 0, bottom: 0, left: 0 },
      align: "start",
      justify: "start",
      wrap: false,
      primarySizing: "fixed",
      counterSizing: "fixed",
    };
  }
  if (!layout || typeof layout !== "object" || Array.isArray(layout)) {
    throw new PageValidationError(`${path} must be an object.`);
  }
  return {
    kind: optionalEnum(
      layout.kind,
      ["none", "flex", "grid"],
      layout.direction && layout.direction !== "none" ? "flex" : "none",
      `${path}.kind`,
    ),
    direction: optionalEnum(
      layout.direction,
      ["none", "horizontal", "vertical"],
      "none",
      `${path}.direction`,
    ),
    gap: nonNegativeNumber(layout.gap ?? 0, `${path}.gap`),
    counterGap: nonNegativeNumber(
      layout.counterGap ?? layout.gap ?? 0,
      `${path}.counterGap`,
    ),
    padding: normalizePadding(layout.padding, `${path}.padding`),
    align: optionalEnum(
      layout.align,
      ["start", "center", "end", "stretch", "baseline"],
      "start",
      `${path}.align`,
    ),
    justify: optionalEnum(
      layout.justify,
      ["start", "center", "end", "space-between"],
      "start",
      `${path}.justify`,
    ),
    wrap: typeof layout.wrap === "boolean" ? layout.wrap : false,
    primarySizing: optionalEnum(
      layout.primarySizing,
      ["fixed", "hug"],
      "fixed",
      `${path}.primarySizing`,
    ),
    counterSizing: optionalEnum(
      layout.counterSizing,
      ["fixed", "hug"],
      "fixed",
      `${path}.counterSizing`,
    ),
    ...(layout.kind === "grid"
      ? {
          grid: {
            columns: optionalString(
              layout.grid?.columns,
              "none",
              `${path}.grid.columns`,
              500,
            ),
            rows: optionalString(
              layout.grid?.rows,
              "none",
              `${path}.grid.rows`,
              500,
            ),
          },
        }
      : {}),
  };
}

function normalizeLayoutItem(layoutItem, path) {
  if (
    !layoutItem ||
    typeof layoutItem !== "object" ||
    Array.isArray(layoutItem)
  ) {
    throw new PageValidationError(`${path} must be an object.`);
  }
  const order = layoutItem.order ?? 0;
  if (!Number.isInteger(order) || Math.abs(order) > 10_000) {
    throw new PageValidationError(`${path}.order must be an integer.`);
  }
  return {
    align: optionalEnum(
      layoutItem.align,
      ["auto", "start", "center", "end", "stretch"],
      "auto",
      `${path}.align`,
    ),
    grow: boundedNumber(layoutItem.grow, 0, 0, 100, `${path}.grow`),
    shrink: boundedNumber(layoutItem.shrink, 1, 0, 100, `${path}.shrink`),
    basis: optionalString(
      layoutItem.basis,
      "auto",
      `${path}.basis`,
      80,
    ),
    order,
    positioning: optionalEnum(
      layoutItem.positioning,
      ["auto", "absolute"],
      "auto",
      `${path}.positioning`,
    ),
    horizontalSizing: optionalEnum(
      layoutItem.horizontalSizing,
      ["fixed", "hug", "fill"],
      "fixed",
      `${path}.horizontalSizing`,
    ),
    verticalSizing: optionalEnum(
      layoutItem.verticalSizing,
      ["fixed", "hug", "fill"],
      "fixed",
      `${path}.verticalSizing`,
    ),
    gridRow: optionalString(
      layoutItem.gridRow,
      "auto",
      `${path}.gridRow`,
      80,
    ),
    gridColumn: optionalString(
      layoutItem.gridColumn,
      "auto",
      `${path}.gridColumn`,
      80,
    ),
  };
}

function normalizePadding(value, path) {
  if (typeof value === "number") {
    const padding = nonNegativeNumber(value, path);
    return { top: padding, right: padding, bottom: padding, left: padding };
  }
  if (value === undefined) {
    return { top: 0, right: 0, bottom: 0, left: 0 };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PageValidationError(`${path} must be a number or object.`);
  }
  return {
    top: nonNegativeNumber(value.top ?? 0, `${path}.top`),
    right: nonNegativeNumber(value.right ?? 0, `${path}.right`),
    bottom: nonNegativeNumber(value.bottom ?? 0, `${path}.bottom`),
    left: nonNegativeNumber(value.left ?? 0, `${path}.left`),
  };
}

function normalizeFont(font, path) {
  if (font === undefined) {
    return {
      family: "Inter",
      style: "Regular",
      size: 16,
      lineHeight: 24,
      letterSpacing: 0,
    };
  }
  if (!font || typeof font !== "object" || Array.isArray(font)) {
    throw new PageValidationError(`${path} must be an object.`);
  }
  return {
    family: optionalString(font.family, "Inter", `${path}.family`, 120),
    style: optionalString(font.style, "Regular", `${path}.style`, 120),
    size: positiveNumber(font.size ?? 16, `${path}.size`),
    lineHeight: positiveNumber(
      font.lineHeight ?? (font.size ?? 16) * 1.5,
      `${path}.lineHeight`,
    ),
    letterSpacing: finiteNumber(
      font.letterSpacing,
      0,
      `${path}.letterSpacing`,
    ),
  };
}

function normalizeSourceRef(value, path) {
  if (value === undefined || value === null) {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PageValidationError(`${path} must be an object.`);
  }
  return {
    ...(value.file !== undefined
      ? { file: optionalString(value.file, "", `${path}.file`, 500) }
      : {}),
    ...(value.selector !== undefined
      ? {
          selector: optionalString(
            value.selector,
            "",
            `${path}.selector`,
            500,
          ),
        }
      : {}),
    ...(value.component !== undefined
      ? {
          component: optionalString(
            value.component,
            "",
            `${path}.component`,
            200,
          ),
        }
      : {}),
  };
}

function requiredId(value, path) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new PageValidationError(
      `${path} must match ${ID_PATTERN.toString()}.`,
    );
  }
  return value;
}

function optionalString(value, fallback, path, maxLength) {
  const result = value === undefined ? fallback : value;
  if (typeof result !== "string" || result.length > maxLength) {
    throw new PageValidationError(
      `${path} must be a string no longer than ${maxLength} characters.`,
    );
  }
  return result;
}

function optionalEnum(value, options, fallback, path) {
  const result = value === undefined ? fallback : value;
  if (!options.includes(result)) {
    throw new PageValidationError(`${path} must be one of: ${options.join(", ")}.`);
  }
  return result;
}

function positiveNumber(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new PageValidationError(`${path} must be a positive number.`);
  }
  return value;
}

function nonNegativeNumber(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new PageValidationError(`${path} must be a non-negative number.`);
  }
  return value;
}

function finiteNumber(value, fallback, path) {
  const result = value === undefined ? fallback : value;
  if (typeof result !== "number" || !Number.isFinite(result)) {
    throw new PageValidationError(`${path} must be a finite number.`);
  }
  return result;
}

function boundedNumber(value, fallback, minimum, maximum, path) {
  const result = value === undefined ? fallback : value;
  if (
    typeof result !== "number" ||
    !Number.isFinite(result) ||
    result < minimum ||
    result > maximum
  ) {
    throw new PageValidationError(
      `${path} must be between ${minimum} and ${maximum}.`,
    );
  }
  return result;
}

function cssColor(value, path) {
  if (
    typeof value !== "string" ||
    !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(value)
  ) {
    throw new PageValidationError(
      `${path} must be a #RRGGBB or #RRGGBBAA color.`,
    );
  }
  return value.toUpperCase();
}
