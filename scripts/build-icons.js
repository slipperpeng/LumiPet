'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const root = path.resolve(__dirname, '..');
const sourcePath = path.join(root, 'build', 'icon.svg');
const pngPath = path.join(root, 'build', 'icon.png');
const icoPath = path.join(root, 'build', 'icon.ico');
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const generatorDataPath = path.join(root, 'dist', 'icon-generator-data');
const previewPath = path.join(root, 'dist', 'icon-previews');
const packagedExePath = path.join(root, 'dist', 'win-unpacked', 'LumiPet.exe');

function createIco(images) {
    const headerSize = 6;
    const entrySize = 16;
    const directory = Buffer.alloc(headerSize + entrySize * images.length);
    directory.writeUInt16LE(0, 0);
    directory.writeUInt16LE(1, 2);
    directory.writeUInt16LE(images.length, 4);

    let offset = directory.length;
    images.forEach(({ size, png }, index) => {
        const entryOffset = headerSize + index * entrySize;
        directory.writeUInt8(size === 256 ? 0 : size, entryOffset);
        directory.writeUInt8(size === 256 ? 0 : size, entryOffset + 1);
        directory.writeUInt8(0, entryOffset + 2);
        directory.writeUInt8(0, entryOffset + 3);
        directory.writeUInt16LE(1, entryOffset + 4);
        directory.writeUInt16LE(32, entryOffset + 6);
        directory.writeUInt32LE(png.length, entryOffset + 8);
        directory.writeUInt32LE(offset, entryOffset + 12);
        offset += png.length;
    });

    return Buffer.concat([directory, ...images.map(({ png }) => png)]);
}

app.setPath('userData', generatorDataPath);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.whenReady().then(async () => {
    const renderWindow = new BrowserWindow({
        width: 1024,
        height: 1024,
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        webPreferences: {
            offscreen: true
        }
    });
    const svg = fs.readFileSync(sourcePath, 'utf8');
    const html = `<!doctype html><style>html,body,svg{width:100%;height:100%;margin:0;display:block;background:transparent}</style>${svg}`;
    await renderWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const source = await renderWindow.webContents.capturePage({
        x: 0,
        y: 0,
        width: 1024,
        height: 1024
    });
    if (source.isEmpty()) throw new Error(`Unable to render ${sourcePath}`);

    const render = (size) => source.resize({ width: size, height: size, quality: 'best' }).toPNG();
    fs.writeFileSync(pngPath, render(1024));
    fs.writeFileSync(
        icoPath,
        createIco(icoSizes.map((size) => ({ size, png: render(size) })))
    );
    fs.mkdirSync(previewPath, { recursive: true });
    fs.writeFileSync(path.join(previewPath, 'icon-32.png'), render(32));
    fs.writeFileSync(path.join(previewPath, 'icon-48.png'), render(48));
    if (fs.existsSync(packagedExePath)) {
        const packagedIcon = await app.getFileIcon(packagedExePath, { size: 'large' });
        fs.writeFileSync(path.join(previewPath, 'packaged-exe-icon.png'), packagedIcon.toPNG());
    }

    renderWindow.destroy();
    console.log(`Generated ${path.relative(root, pngPath)} and ${path.relative(root, icoPath)}.`);
    app.quit();
}).catch((error) => {
    console.error(error.message);
    app.exit(1);
});
