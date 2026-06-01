/**
 * Generate tray and app icons from the app icon.
 * Run: node electron/generate-icons.cjs
 */
const sharp = require('sharp')
const path = require('path')

const SOURCE_PATH = path.join(__dirname, '..', 'public', 'szalo-icon.png')
const OUTPUT_DIR = __dirname

function clamp(value) {
  return Math.max(0, Math.min(255, Math.round(value)))
}

async function generateRedServerIcon(size, outputName) {
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

  await sharp(data, {
    raw: {
      width: info.width,
      height: info.height,
      channels: info.channels,
    },
  }).png().toFile(path.join(OUTPUT_DIR, outputName))
}

async function generate() {
  // App icon (256x256)
  await sharp(SOURCE_PATH).resize(256, 256).png().toFile(path.join(OUTPUT_DIR, 'icon.png'))
  console.log('Generated icon.png (256x256)')

  // Tray icon (32x32)
  await sharp(SOURCE_PATH).resize(32, 32).png().toFile(path.join(OUTPUT_DIR, 'tray-icon.png'))
  console.log('Generated tray-icon.png (32x32)')

  // Server icons use red surfaces so they are distinct from the client tray.
  await generateRedServerIcon(256, 'server-icon.png')
  console.log('Generated server-icon.png (256x256)')

  await generateRedServerIcon(32, 'server-tray-icon.png')
  console.log('Generated server-tray-icon.png (32x32)')

  // ICO source (256x256)
  await sharp(SOURCE_PATH).resize(256, 256).png().toFile(path.join(OUTPUT_DIR, 'icon.ico.png'))
  console.log('Generated icon.ico.png')

  await generateRedServerIcon(256, 'server-icon.ico.png')
  console.log('Generated server-icon.ico.png')
}

generate().catch(console.error)
