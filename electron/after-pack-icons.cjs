const path = require('path')
const fs = require('fs')

module.exports = async function afterPackIcons(context) {
  if (context.electronPlatformName !== 'win32') return

  const productFilename = context.packager.appInfo.productFilename
  const exePath = path.join(context.appOutDir, `${productFilename}.exe`)
  const configuredIcon = context.packager.platformSpecificBuildOptions.icon
  const iconPath = configuredIcon
    ? path.resolve(context.packager.projectDir, configuredIcon)
    : path.resolve(context.packager.projectDir, 'electron', 'icon.ico')

  if (!fs.existsSync(exePath)) {
    throw new Error(`Cannot embed icon. Missing executable: ${exePath}`)
  }
  if (!fs.existsSync(iconPath)) {
    throw new Error(`Cannot embed icon. Missing icon: ${iconPath}`)
  }

  const { rcedit } = await import('rcedit')
  await rcedit(exePath, {
    icon: iconPath,
    'requested-execution-level': 'asInvoker',
  })
  console.log(`[afterPack] Embedded Windows icon: ${path.basename(iconPath)} -> ${path.basename(exePath)}`)
}
