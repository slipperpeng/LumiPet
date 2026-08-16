'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const requiredLibraries = [
    'libs/live2dcubismcore.min.js',
    'libs/pixi.min.js',
    'libs/cubism4.min.js'
];
const requiredIcons = [
    'build/icon.svg',
    'build/icon.png',
    'build/icon.ico'
];

function assertFile(filePath) {
    if (!fs.statSync(filePath).isFile()) throw new Error(`Expected file: ${filePath}`);
}

for (const relativePath of requiredLibraries) assertFile(path.join(root, relativePath));
for (const relativePath of requiredIcons) assertFile(path.join(root, relativePath));
console.log(`Validated ${requiredLibraries.length} renderer libraries and ${requiredIcons.length} application icons. Users provide Live2D models at first launch.`);
