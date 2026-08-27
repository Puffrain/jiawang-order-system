import { asPipelineError, ErrorClass } from "../contracts/pipeline";

export interface ImageInfo {
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
  pixels: number;
  hasExif: boolean;
}

export interface ImageLimits {
  maxBytes?: number;
  maxWidth?: number;
  maxHeight?: number;
  maxPixels?: number;
}

export class ImageValidationError extends Error {
  readonly code: string;
  readonly class: ErrorClass = "image";
  readonly retryable = false;
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ImageValidationError";
    this.code = code;
    this.details = details;
  }
}

export function inspectImage(input: Uint8Array, limits: ImageLimits = {}): ImageInfo {
  const bytes = input.byteLength;
  if (limits.maxBytes !== undefined && bytes > limits.maxBytes) {
    throw new ImageValidationError("IMAGE_BYTES_LIMIT", `Image is ${bytes} bytes; limit is ${limits.maxBytes}`);
  }
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  let info: ImageInfo;
  if (isPng(view)) info = inspectPng(view);
  else if (isJpeg(view)) info = inspectJpeg(view);
  else if (isWebp(view)) info = inspectWebp(view);
  else throw new ImageValidationError("UNSUPPORTED_IMAGE", "Only JPEG, PNG and WebP images are accepted");
  enforceImageLimits(info, limits);
  return info;
}

export function enforceImageLimits(info: ImageInfo, limits: ImageLimits): void {
  if (limits.maxWidth !== undefined && info.width > limits.maxWidth) throw new ImageValidationError("IMAGE_WIDTH_LIMIT", `Image width exceeds ${limits.maxWidth}`, { width: info.width });
  if (limits.maxHeight !== undefined && info.height > limits.maxHeight) throw new ImageValidationError("IMAGE_HEIGHT_LIMIT", `Image height exceeds ${limits.maxHeight}`, { height: info.height });
  if (limits.maxPixels !== undefined && info.pixels > limits.maxPixels) throw new ImageValidationError("IMAGE_PIXELS_LIMIT", `Image has ${info.pixels} pixels; limit is ${limits.maxPixels}`);
}

function inspectPng(view: DataView): ImageInfo {
  if (view.byteLength < 33 || view.getUint32(12) !== 0x49484452) throw new ImageValidationError("BAD_PNG", "PNG is truncated or has no IHDR");
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (!width || !height) throw new ImageValidationError("BAD_IMAGE_DIMENSIONS", "PNG has zero dimensions");
  // eXIf is a standardized PNG chunk; tEXt/iTXt/zTXt can also leak source
  // metadata, so the derivative writer removes all ancillary chunks.
  let hasExif = false;
  let offset = 8;
  while (offset + 12 <= view.byteLength) {
    const length = view.getUint32(offset);
    const type = readAscii(view, offset + 4, 4);
    if (type === "eXIf") hasExif = true;
    offset += 12 + length;
    if (type === "IEND") break;
    if (length > view.byteLength || offset > view.byteLength) break;
  }
  return { mimeType: "image/png", width, height, pixels: safePixels(width, height), hasExif };
}

function inspectJpeg(view: DataView): ImageInfo {
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) throw new ImageValidationError("BAD_JPEG", "JPEG SOI marker is missing");
  let offset = 2;
  let hasExif = false;
  let width = 0;
  let height = 0;
  while (offset < view.byteLength) {
    // Fill bytes between markers are legal.
    while (offset < view.byteLength && view.getUint8(offset) === 0xff) offset += 1;
    if (offset >= view.byteLength) break;
    const marker = view.getUint8(offset++);
    if (marker === 0xd9 || marker === 0xda) break; // EOI/SOS (scan data follows)
    if (marker >= 0xd0 && marker <= 0xd7) continue; // restart marker, no length
    if (offset + 2 > view.byteLength) throw new ImageValidationError("BAD_JPEG", "JPEG segment length is truncated");
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > view.byteLength) throw new ImageValidationError("BAD_JPEG", "JPEG segment extends beyond file");
    if (marker === 0xe1 && length >= 8 && readAscii(view, offset + 2, 6) === "Exif\0\0") hasExif = true;
    // SOF0..SOF3, SOF5..SOF7, SOF9..SOF15 (excluding DHT/JPG)
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      if (length < 7) throw new ImageValidationError("BAD_JPEG", "JPEG SOF segment is truncated");
      height = view.getUint16(offset + 3);
      width = view.getUint16(offset + 5);
      if (!width || !height) throw new ImageValidationError("BAD_IMAGE_DIMENSIONS", "JPEG has zero dimensions");
    }
    offset += length;
  }
  if (!width || !height) throw new ImageValidationError("BAD_JPEG", "JPEG dimensions could not be found");
  return { mimeType: "image/jpeg", width, height, pixels: safePixels(width, height), hasExif };
}

function inspectWebp(view: DataView): ImageInfo {
  if (view.byteLength < 16 || readAscii(view, 0, 4) !== "RIFF" || readAscii(view, 8, 4) !== "WEBP") throw new ImageValidationError("BAD_WEBP", "WebP RIFF header is missing");
  let offset = 12;
  let width = 0;
  let height = 0;
  let hasExif = false;
  while (offset + 8 <= view.byteLength) {
    const type = readAscii(view, offset, 4);
    const length = view.getUint32(offset + 4, true);
    const data = offset + 8;
    if (data + length > view.byteLength) throw new ImageValidationError("BAD_WEBP", "WebP chunk extends beyond file");
    if (type === "EXIF" || type === "XMP ") hasExif = true;
    if (type === "VP8X" && length >= 10) {
      width = 1 + readU24LE(view, data + 4);
      height = 1 + readU24LE(view, data + 7);
    } else if (type === "VP8 " && length >= 10 && view.getUint8(data + 3) === 0x9d && view.getUint8(data + 4) === 0x01 && view.getUint8(data + 5) === 0x2a) {
      width = view.getUint16(data + 6, true) & 0x3fff;
      height = view.getUint16(data + 8, true) & 0x3fff;
    } else if (type === "VP8L" && length >= 5 && view.getUint8(data) === 0x2f) {
      const b1 = view.getUint8(data + 1), b2 = view.getUint8(data + 2), b3 = view.getUint8(data + 3), b4 = view.getUint8(data + 4);
      width = 1 + (((b2 & 0x3f) << 8) | b1);
      height = 1 + (((b4 & 0xf) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
    }
    offset = data + length + (length & 1);
  }
  if (!width || !height) throw new ImageValidationError("BAD_WEBP", "WebP dimensions could not be found");
  return { mimeType: "image/webp", width, height, pixels: safePixels(width, height), hasExif };
}

function safePixels(width: number, height: number): number {
  const pixels = BigInt(width) * BigInt(height);
  if (pixels > BigInt(Number.MAX_SAFE_INTEGER)) throw new ImageValidationError("IMAGE_PIXELS_OVERFLOW", "Image pixel count is not representable safely");
  return Number(pixels);
}

function readAscii(view: DataView, offset: number, length: number): string {
  let result = "";
  for (let i = 0; i < length; i += 1) result += String.fromCharCode(view.getUint8(offset + i));
  return result;
}
function readU24LE(view: DataView, offset: number): number {
  return view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
}
function isPng(view: DataView): boolean {
  return view.byteLength >= 8 && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a;
}
function isJpeg(view: DataView): boolean {
  return view.byteLength >= 2 && view.getUint16(0) === 0xffd8;
}
function isWebp(view: DataView): boolean {
  return view.byteLength >= 12 && readAscii(view, 0, 4) === "RIFF" && readAscii(view, 8, 4) === "WEBP";
}

export function imageErrorToPipeline(error: unknown) {
  return asPipelineError(error, "image", "IMAGE_INVALID");
}
