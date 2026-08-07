import { createHash } from "node:crypto";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

const ELEMENT_NODE = 1;
const SAFE_ROOT_CHILDREN = new Set([
  "circle",
  "ellipse",
  "g",
  "line",
  "path",
  "polygon",
  "polyline",
  "rect",
  "text",
]);
const NON_VISUAL_ROOT_CHILDREN = new Set(["defs", "desc", "metadata", "style", "title"]);
const REJECTED_ELEMENTS = new Set([
  "embed",
  "filter",
  "foreignobject",
  "iframe",
  "image",
  "marker",
  "object",
  "pattern",
  "script",
]);

export class SvgValidationError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = "SvgValidationError";
    this.details = details;
  }
}

export function computeHash(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function prepareSvgAsset({
  svg,
  assetId,
  sourcePath,
  requireTargets = true,
}) {
  if (typeof svg !== "string" || svg.trim() === "") {
    throw new SvgValidationError("SVG content is empty.");
  }
  if (Buffer.byteLength(svg, "utf8") > 5 * 1024 * 1024) {
    throw new SvgValidationError("SVG exceeds the 5 MB MVP limit.");
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(svg)) {
    throw new SvgValidationError("DOCTYPE and ENTITY declarations are not allowed.");
  }

  const parseErrors = [];
  const document = new DOMParser({
    errorHandler: {
      warning: () => {},
      error: (message) => parseErrors.push(message),
      fatalError: (message) => parseErrors.push(message),
    },
  }).parseFromString(svg, "image/svg+xml");

  if (parseErrors.length > 0) {
    throw new SvgValidationError("SVG XML is malformed.", parseErrors);
  }

  const root = document.documentElement;
  if (!root || tagName(root) !== "svg") {
    throw new SvgValidationError("The document root must be an <svg> element.");
  }

  const elements = collectElements(root);
  validateSafeElements(elements);
  const ids = validateUniqueIds(elements);
  const targets = selectTargets(root, elements);

  if (requireTargets && targets.length === 0) {
    throw new SvgValidationError(
      'No sync targets found. Add id and data-figma-sync="target" to reviewable SVG elements.',
    );
  }
  for (const target of targets) {
    if (!target.getAttribute("id")) {
      throw new SvgValidationError('Every data-figma-sync="target" element needs a stable id.');
    }
    if (hasTargetAncestor(target, root)) {
      throw new SvgValidationError(
        `Nested sync target "${target.getAttribute("id")}" is not supported.`,
      );
    }
  }

  const dimensions = readDimensions(root);
  const serializer = new XMLSerializer();
  const sharedDefinitions = directElementChildren(root)
    .filter((element) => NON_VISUAL_ROOT_CHILDREN.has(tagName(element)))
    .map((element) => serializer.serializeToString(element))
    .join("");
  const rootOpeningTag = serializeOpeningTag(root, { ensureXmlns: true });

  const preparedTargets = targets.map((target) => {
    const ancestors = [];
    let current = target.parentNode;
    while (current && current !== root) {
      if (current.nodeType === ELEMENT_NODE) {
        ancestors.unshift(current);
      }
      current = current.parentNode;
    }

    const opening = ancestors.map((element) => serializeOpeningTag(element)).join("");
    const closing = ancestors
      .slice()
      .reverse()
      .map((element) => `</${element.tagName}>`)
      .join("");
    const targetMarkup = serializer.serializeToString(target);

    return {
      elementId: target.getAttribute("id"),
      tagName: tagName(target),
      fragment: `${rootOpeningTag}${sharedDefinitions}${opening}${targetMarkup}${closing}</svg>`,
    };
  });

  return {
    protocolVersion: 2,
    assetId,
    sourcePath,
    sourceHash: computeHash(svg),
    svg,
    width: dimensions.width,
    height: dimensions.height,
    viewBox: dimensions.viewBox,
    elementIds: preparedTargets.map((target) => target.elementId),
    targets: preparedTargets,
    idCount: ids.size,
    preparedAt: new Date().toISOString(),
  };
}

function collectElements(root) {
  const result = [];
  const visit = (node) => {
    if (node.nodeType !== ELEMENT_NODE) {
      return;
    }
    result.push(node);
    for (const child of Array.from(node.childNodes ?? [])) {
      visit(child);
    }
  };
  visit(root);
  return result;
}

function validateSafeElements(elements) {
  for (const element of elements) {
    const elementName = tagName(element);
    if (REJECTED_ELEMENTS.has(elementName)) {
      throw new SvgValidationError(`<${element.tagName}> is not supported by the safe SVG profile.`);
    }

    for (const attribute of Array.from(element.attributes ?? [])) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();

      if (name.startsWith("on")) {
        throw new SvgValidationError(`Event handler attribute "${attribute.name}" is not allowed.`);
      }
      if (/javascript\s*:/i.test(value)) {
        throw new SvgValidationError(`Unsafe URL in attribute "${attribute.name}".`);
      }
      if (name === "href" || name === "xlink:href") {
        if (value !== "" && !value.startsWith("#")) {
          throw new SvgValidationError("Only local #fragment href references are allowed.");
        }
      }
      for (const match of value.matchAll(/url\(([^)]+)\)/gi)) {
        const url = match[1].trim().replace(/^['"]|['"]$/g, "");
        if (!url.startsWith("#")) {
          throw new SvgValidationError("Only local url(#fragment) references are allowed.");
        }
      }
      if (name === "style" && /@import/i.test(value)) {
        throw new SvgValidationError("CSS @import is not allowed.");
      }
    }

    if (elementName === "style") {
      const css = element.textContent ?? "";
      if (/@import|javascript\s*:/i.test(css)) {
        throw new SvgValidationError("Unsafe SVG CSS is not allowed.");
      }
      for (const match of css.matchAll(/url\(([^)]+)\)/gi)) {
        const url = match[1].trim().replace(/^['"]|['"]$/g, "");
        if (!url.startsWith("#")) {
          throw new SvgValidationError("Only local CSS url(#fragment) references are allowed.");
        }
      }
    }
  }
}

function validateUniqueIds(elements) {
  const ids = new Set();
  for (const element of elements) {
    const id = element.getAttribute?.("id");
    if (!id) {
      continue;
    }
    if (ids.has(id)) {
      throw new SvgValidationError(`Duplicate SVG id "${id}".`);
    }
    ids.add(id);
  }
  return ids;
}

function selectTargets(root, elements) {
  const explicit = elements.filter(
    (element) => element.getAttribute?.("data-figma-sync") === "target",
  );
  if (explicit.length > 0) {
    return explicit;
  }

  return directElementChildren(root).filter((element) => {
    const name = tagName(element);
    return SAFE_ROOT_CHILDREN.has(name) && Boolean(element.getAttribute("id"));
  });
}

function hasTargetAncestor(target, root) {
  let current = target.parentNode;
  while (current && current !== root) {
    if (
      current.nodeType === ELEMENT_NODE &&
      current.getAttribute?.("data-figma-sync") === "target"
    ) {
      return true;
    }
    current = current.parentNode;
  }
  return false;
}

function directElementChildren(node) {
  return Array.from(node.childNodes ?? []).filter((child) => child.nodeType === ELEMENT_NODE);
}

function readDimensions(root) {
  const viewBoxRaw = root.getAttribute("viewBox");
  let viewBox = null;
  if (viewBoxRaw) {
    const values = viewBoxRaw
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) {
      throw new SvgValidationError("viewBox must contain four finite numbers.");
    }
    if (values[2] <= 0 || values[3] <= 0) {
      throw new SvgValidationError("viewBox width and height must be positive.");
    }
    viewBox = values;
  }

  const width = parseDimension(root.getAttribute("width")) ?? viewBox?.[2];
  const height = parseDimension(root.getAttribute("height")) ?? viewBox?.[3];
  if (!width || !height) {
    throw new SvgValidationError("SVG needs positive width/height or a valid viewBox.");
  }

  return {
    width,
    height,
    viewBox: viewBox ?? [0, 0, width, height],
  };
}

function parseDimension(value) {
  if (!value) {
    return null;
  }
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(?:px)?$/i);
  if (!match) {
    return null;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function serializeOpeningTag(element, { ensureXmlns = false } = {}) {
  const attributes = Array.from(element.attributes ?? []).map(
    (attribute) => `${attribute.name}="${escapeAttribute(attribute.value)}"`,
  );
  if (
    ensureXmlns &&
    !attributes.some((attribute) => attribute.toLowerCase().startsWith("xmlns="))
  ) {
    attributes.unshift('xmlns="http://www.w3.org/2000/svg"');
  }
  return `<${element.tagName}${attributes.length ? ` ${attributes.join(" ")}` : ""}>`;
}

function escapeAttribute(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function tagName(element) {
  return (element.localName || element.tagName || "").toLowerCase();
}
