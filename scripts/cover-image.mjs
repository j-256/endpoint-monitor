const PNG_SIGNATURE = Object.freeze([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
])
const IHDR = Object.freeze([0x49, 0x48, 0x44, 0x52])

export const COVER_HEIGHT = 1000
export const COVER_MAX_BYTES = 8 * 1024 * 1024
export const COVER_PATH = "docs/screenshots/cover.png"
export const COVER_SOURCE_PATH = "docs/screenshots/cover.html"
export const COVER_WIDTH = 1440

function matches(bytes, offset, expected) {
  return expected.every((byte, index) => bytes[offset + index] === byte)
}

function readUint32(bytes, offset) {
  return (
    bytes[offset] * 0x1000000
    + bytes[offset + 1] * 0x10000
    + bytes[offset + 2] * 0x100
    + bytes[offset + 3]
  )
}

export function coverDimensions(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 24) {
    throw new TypeError(`${COVER_PATH} is not a PNG image`)
  }
  if (!matches(bytes, 0, PNG_SIGNATURE) || !matches(bytes, 12, IHDR)) {
    throw new TypeError(`${COVER_PATH} is not a PNG image`)
  }
  return Object.freeze({
    height: readUint32(bytes, 20),
    width: readUint32(bytes, 16),
  })
}

export function validateCoverImage(bytes) {
  if (bytes.length === 0) throw new TypeError(`${COVER_PATH} is empty`)
  if (bytes.length > COVER_MAX_BYTES) {
    throw new TypeError(`${COVER_PATH} exceeds the size limit`)
  }
  const dimensions = coverDimensions(bytes)
  if (dimensions.width !== COVER_WIDTH || dimensions.height !== COVER_HEIGHT) {
    throw new TypeError(
      `${COVER_PATH} must be ${COVER_WIDTH}x${COVER_HEIGHT}, got `
      + `${dimensions.width}x${dimensions.height}`,
    )
  }
  return dimensions
}
