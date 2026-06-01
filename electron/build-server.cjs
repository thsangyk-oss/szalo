/**
 * Build server/index.ts into electron/server.cjs (bundled CommonJS).
 * Copies server/admin.html alongside the output so the runtime can serve it.
 *
 * Run: node electron/build-server.cjs
 */
const esbuild = require('esbuild')
const path = require('path')
const fs = require('fs')

const outFile = path.join(__dirname, 'server.cjs')
const adminSrc = path.join(__dirname, '..', 'server', 'admin.html')
const adminDst = path.join(__dirname, 'admin.html')

esbuild.build({
  entryPoints: [path.join(__dirname, '..', 'server', 'index.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  // sharp is native, must stay external. zca-js bundled inline so server.cjs is self-contained.
  external: ['sharp'],
  logLevel: 'info',
}).then(() => {
  fs.copyFileSync(adminSrc, adminDst)
  console.log('Server bundled to electron/server.cjs')
  console.log('Admin UI copied to electron/admin.html')
}).catch((err) => {
  console.error('Server bundle failed:', err)
  process.exit(1)
})
