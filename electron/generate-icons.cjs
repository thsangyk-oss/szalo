/**
 * Generate tray and app icons from the app icon.
 * Run: node electron/generate-icons.cjs
 */
const sharp = require('sharp')
const path = require('path')

const SOURCE_PATH = path.join(__dirname, '..', 'public', 'szalo-icon.png')
const OUTPUT_DIR = __dirname

async function generate() {
  // App icon (256x256)
  await sharp(SOURCE_PATH).resize(256, 256).png().toFile(path.join(OUTPUT_DIR, 'icon.png'))
  console.log('Generated icon.png (256x256)')

  // Tray icon (32x32)
  await sharp(SOURCE_PATH).resize(32, 32).png().toFile(path.join(OUTPUT_DIR, 'tray-icon.png'))
  console.log('Generated tray-icon.png (32x32)')

  // ICO source (256x256)
  await sharp(SOURCE_PATH).resize(256, 256).png().toFile(path.join(OUTPUT_DIR, 'icon.ico.png'))
  console.log('Generated icon.ico.png')
}

generate().catch(console.error)
