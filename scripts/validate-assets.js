'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const requiredLibraries = [
    'libs/live2dcubismcore.min.js',
    'libs/pixi.min.js',
    'libs/cubism4.min.js'
];

function assertFile(filePath) {
    if (!fs.statSync(filePath).isFile()) throw new Error(`Expected file: ${filePath}`);
}

for (const relativePath of requiredLibraries) assertFile(path.join(root, relativePath));
console.log(`Validated ${requiredLibraries.length} renderer libraries. Users provide Live2D models at first launch.`);
