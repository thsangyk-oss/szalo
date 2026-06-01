/**
 * Generate tray and app icons from the app icon.
 * Run: node electron/generate-icons.cjs
 */
const sharp = require('sharp')
const path = require('path')
const fs = require('fs')

const SOURCE_PATH = path.join(__dirname, '..', 'public', 'szalo-icon.png')
const OUTPUT_DIR = __dirname

function clamp(value) {
  return Math.max(0, Math.min(255, Math.round(value)))
}

async function renderClientIcon(size) {
  return sharp(SOURCE_PATH).resize(size, size).png().toBuffer()
}

async function renderRedServerIcon(size) {
  const { data, info } = await sharp(SOURCE_PATH)
    .resize(size, size)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    const a = data[i + 3]
    if (a === 0) continue

    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const chroma = max - min
    const isWhiteGlyph = min > 200 && chroma < 58
    const isColoredSurface = chroma > 28 && !isWhiteGlyph
    if (!isColoredSurface) continue

    const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
    const shade = Math.pow(luminance, 0.78)
    const isBadge = g > r && g >= b * 0.78
    const target = isBadge
      ? { r: 255, g: 78, b: 74 }
      : { r: 228, g: 24, b: 44 }

    data[i] = clamp(target.r * (0.58 + shade * 0.54))
    data[i + 1] = clamp(target.g * (0.45 + shade * 0.7))
    data[i + 2] = clamp(target.b * (0.48 + shade * 0.64))
  }

  return sharp(data, {
    raw: {
      width: info.width,
      height: info.height,
      channels: info.channels,
    },
  }).png().toBuffer()
}

async function writePng(bufferPromise, outputName) {
  const buffer = await bufferPromise
  fs.writeFileSync(path.join(OUTPUT_DIR, outputName), buffer)
}

async function writeIco(renderIcon, outputName) {
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const images = await Promise.all(sizes.map(async (size) => ({
    size,
    buffer: await renderIcon(size),
  })))
  const headerSize = 6
  const entrySize = 16
  const directorySize = headerSize + images.length * entrySize
  let offset = directorySize

  const header = Buffer.alloc(directorySize)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)

  images.forEach((image, index) => {
    const entryOffset = headerSize + index * entrySize
    header.writeUInt8(image.size >= 256 ? 0 : image.size, entryOffset)
    header.writeUInt8(image.size >= 256 ? 0 : image.size, entryOffset + 1)
    header.writeUInt8(0, entryOffset + 2)
    header.writeUInt8(0, entryOffset + 3)
    header.writeUInt16LE(1, entryOffset + 4)
    header.writeUInt16LE(32, entryOffset + 6)
    header.writeUInt32LE(image.buffer.length, entryOffset + 8)
    header.writeUInt32LE(offset, entryOffset + 12)
    offset += image.buffer.length
  })

  fs.writeFileSync(path.join(OUTPUT_DIR, outputName), Buffer.concat([
    header,
    ...images.map((image) => image.buffer),
  ]))
}

async function generate() {
  // App icon (256x256)
  await writePng(renderClientIcon(256), 'icon.png')
  console.log('Generated icon.png (256x256)')

  // Tray icon (32x32)
  await writePng(renderClientIcon(32), 'tray-icon.png')
  console.log('Generated tray-icon.png (32x32)')

  // Server icons use red surfaces so they are distinct from the client tray.
  await writePng(renderRedServerIcon(256), 'server-icon.png')
  console.log('Generated server-icon.png (256x256)')

  await writePng(renderRedServerIcon(32), 'server-tray-icon.png')
  console.log('Generated server-tray-icon.png (32x32)')

  // ICO source (256x256)
  await writePng(renderClientIcon(256), 'icon.ico.png')
  console.log('Generated icon.ico.png')

  await writePng(renderRedServerIcon(256), 'server-icon.ico.png')
  console.log('Generated server-icon.ico.png')

  await writeIco(renderClientIcon, 'icon.ico')
  console.log('Generated icon.ico')

  await writeIco(renderRedServerIcon, 'server-icon.ico')
  console.log('Generated server-icon.ico')
}

generate().catch(console.error)
