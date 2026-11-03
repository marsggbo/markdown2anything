'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const tests = fs.readdirSync(__dirname).filter(file => file.endsWith('.test.js')).sort();
for (const file of tests) {
  execFileSync(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' });
}
console.log(`✓ publishing logic suite (${tests.length} files)`);
