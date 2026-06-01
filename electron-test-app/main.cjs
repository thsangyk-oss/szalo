const fs = require('fs')
const os = require('os')
const path = require('path')
fs.writeFileSync(path.join(os.tmpdir(), 'electron-test.log'), `Started at ${new Date().toISOString()}\n`)

const { app, BrowserWindow } = require('electron')
fs.appendFileSync(path.join(os.tmpdir(), 'electron-test.log'), `electron module loaded: app=${typeof app}\n`)

app.on('ready', () => {
  fs.appendFileSync(path.join(os.tmpdir(), 'electron-test.log'), `App ready\n`)
  const win = new BrowserWindow({ width: 800, height: 600 })
  win.loadURL('https://www.google.com')
})
