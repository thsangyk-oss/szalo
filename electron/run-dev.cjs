const { spawn } = require('child_process')
const electron = require('electron')

const child = spawn(electron, ['.'], {
  env: { ...process.env, NODE_ENV: 'development' },
  stdio: 'inherit',
})

child.on('exit', (code) => {
  process.exit(code ?? 0)
})
