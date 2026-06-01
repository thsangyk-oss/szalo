/**
 * Build server/index.ts into electron/server.cjs (bundled CommonJS)
 * Run: node electron/build-server.cjs
 */
const esbuild = require('esbuild')
const path = require('path')

esbuild.build({
  entryPoints: [path.join(__dirname, '..', 'server', 'index.ts')],
  outfile: path.join(__dirname, 'server.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  // sharp is native, must stay external. zca-js bundled inline so server.cjs is self-contained.
  external: [
    'sharp',
  ],
  logLevel: 'info',
}).then(() => {
  console.log('Server bundled to electron/server.cjs')
}).catch((err) => {
  console.error('Server bundle failed:', err)
  process.exit(1)
})
