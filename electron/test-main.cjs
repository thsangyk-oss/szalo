const e = require('electron');
console.log('typeof:', typeof e);
console.log('is string:', typeof e === 'string' ? e : '<not string>');
console.log('keys:', typeof e === 'object' && e ? Object.keys(e).slice(0,10).join(',') : 'none');
console.log('app type:', typeof e?.app);
console.log('ipcMain type:', typeof e?.ipcMain);
process.exit(0);
