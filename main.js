'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, Menu, screen } = require('electron');
const {
    bottomRightBounds,
    draggedWindowBounds,
    isFinitePosition,
    scaledWindowSize
} = require('./src/window-utils');
const { scanModelDirectory } = require('./src/model-utils');

const APP_NAME = 'LumiPet';
const WINDOW_MARGIN = 18;
const PREVIEW_CAPTURE_PATH = process.env.PET_CAPTURE_PATH || '';
const BASE_WINDOW_SIZE = { width: 360, height: 520 };
const SCALE_PERCENTAGES = [50, 75, 100, 125, 150];

let petWindow = null;
let isQuitting = false;
let dragState = null;
let preferences = {
    launchAtLogin: true,
    scalePercent: 100,
    eyeTrackingEnabled: true,
    modelDirectory: '',
    selectedModel: ''
};
let modelCatalog = {
    directory: '',
    models: [],
    errors: []
};
let modelSelectionError = '';

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
    app.quit();
}

function preferencesPath() {
    return path.join(app.getPath('userData'), 'preferences.json');
}

function loadPreferences() {
    try {
        const stored = JSON.parse(fs.readFileSync(preferencesPath(), 'utf8'));
        const legacyScale = [75, 100, 125][stored.sizeIndex];
        const storedScale = SCALE_PERCENTAGES.includes(stored.scalePercent)
            ? stored.scalePercent
            : legacyScale;
        preferences = {
            launchAtLogin: stored.launchAtLogin !== false,
            scalePercent: SCALE_PERCENTAGES.includes(storedScale) ? storedScale : 100,
            eyeTrackingEnabled: stored.eyeTrackingEnabled !== false,
            modelDirectory: typeof stored.modelDirectory === 'string' ? stored.modelDirectory : '',
            selectedModel: typeof stored.selectedModel === 'string' ? stored.selectedModel : ''
        };
        savePreferences();
    } catch {
        savePreferences();
    }
}

function savePreferences() {
    try {
        fs.mkdirSync(path.dirname(preferencesPath()), { recursive: true });
        fs.writeFileSync(preferencesPath(), JSON.stringify(preferences, null, 2));
    } catch (error) {
        console.error('[preferences] Failed to save:', error.message);
    }
}

function selectedModel() {
    return modelCatalog.models.find((model) => model.id === preferences.selectedModel) || null;
}

function modelStateForRenderer() {
    const model = selectedModel();
    return {
        directory: modelCatalog.directory,
        models: modelCatalog.models.map(({ id, name, relativePath, url }) => ({
            id,
            name,
            relativePath,
            url
        })),
        selectedModel: model?.id || '',
        selectedModelName: model?.name || '',
        selectedModelUrl: model?.url || null,
        error: modelSelectionError || null
    };
}

function modelChangePayload() {
    const state = modelStateForRenderer();
    const model = selectedModel();
    return {
        model: model
            ? {
                id: model.id,
                name: model.name,
                relativePath: model.relativePath,
                url: model.url
            }
            : null,
        error: state.error
    };
}

function notifyModelChanged() {
    if (!petWindow || petWindow.isDestroyed()) return;
    petWindow.webContents.send('pet-model-changed', modelChangePayload());
}

function applyModelCatalog(catalog) {
    modelCatalog = catalog;
    preferences.modelDirectory = catalog.directory;
    if (!catalog.models.some((model) => model.id === preferences.selectedModel)) {
        preferences.selectedModel = catalog.models[0]?.id || '';
    }
    modelSelectionError = catalog.models.length
        ? ''
        : 'No valid Live2D model was found in the selected folder.';
    savePreferences();
}

function scanStoredModelDirectory() {
    if (!preferences.modelDirectory) return false;

    try {
        const catalog = scanModelDirectory(preferences.modelDirectory);
        if (!catalog.models.length) {
            modelSelectionError = 'No valid Live2D model was found in the saved folder.';
            return false;
        }
        applyModelCatalog(catalog);
        return true;
    } catch (error) {
        modelSelectionError = error.message;
        return false;
    }
}

function dialogParent() {
    return petWindow && !petWindow.isDestroyed() ? petWindow : undefined;
}

function showOpenDialog(options) {
    const parent = dialogParent();
    return parent
        ? dialog.showOpenDialog(parent, options)
        : dialog.showOpenDialog(options);
}

function showMessageBox(options) {
    const parent = dialogParent();
    return parent
        ? dialog.showMessageBox(parent, options)
        : dialog.showMessageBox(options);
}

async function chooseModelFolder() {
    const result = await showOpenDialog({
        title: '选择 Live2D 模型文件夹',
        buttonLabel: '选择文件夹',
        properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths[0]) return modelStateForRenderer();

    try {
        const catalog = scanModelDirectory(result.filePaths[0]);
        if (!catalog.models.length) {
            modelSelectionError = '所选文件夹中没有可用的 Live2D 模型。';
            const detail = catalog.errors.slice(0, 3)
                .map((entry) => `${entry.relativePath}: ${entry.message}`)
                .join('\n');
            await showMessageBox({
                type: 'warning',
                title: '没有找到可用模型',
                message: modelSelectionError,
                detail: detail || '请选择包含 .model3.json 及其资源文件的文件夹。'
            });
            return modelStateForRenderer();
        }

        applyModelCatalog(catalog);
        notifyModelChanged();
        return modelStateForRenderer();
    } catch (error) {
        modelSelectionError = error.message;
        await showMessageBox({
            type: 'error',
            title: '无法读取模型文件夹',
            message: error.message
        });
        return modelStateForRenderer();
    }
}

async function rescanModelFolder() {
    if (!modelCatalog.directory) return chooseModelFolder();

    try {
        const catalog = scanModelDirectory(modelCatalog.directory);
        if (!catalog.models.length) {
            applyModelCatalog(catalog);
            modelSelectionError = '当前文件夹中没有可用的 Live2D 模型。';
            await showMessageBox({
                type: 'warning',
                title: '没有找到可用模型',
                message: modelSelectionError
            });
        } else {
            applyModelCatalog(catalog);
        }
    } catch (error) {
        modelSelectionError = error.message;
        await showMessageBox({
            type: 'error',
            title: '无法扫描模型文件夹',
            message: error.message
        });
    }
    notifyModelChanged();
    return modelStateForRenderer();
}

function selectModel(modelId) {
    const model = modelCatalog.models.find((candidate) => candidate.id === modelId);
    if (!model) return false;
    preferences.selectedModel = model.id;
    modelSelectionError = '';
    savePreferences();
    notifyModelChanged();
    return true;
}

async function initializeModelSelection() {
    if (scanStoredModelDirectory()) return;
    await chooseModelFolder();
}

function syncLoginItem() {
    if (!['darwin', 'win32'].includes(process.platform) || !app.isPackaged) return;

    try {
        app.setLoginItemSettings({
            openAtLogin: preferences.launchAtLogin,
            openAsHidden: false,
            path: app.getPath('exe')
        });
    } catch (error) {
        console.error('[login-item] Failed to update:', error.message);
    }
}

function currentWindowSize() {
    return scaledWindowSize(
        BASE_WINDOW_SIZE.width,
        BASE_WINDOW_SIZE.height,
        preferences.scalePercent
    );
}

function movePetWindow(x, y, size = currentWindowSize()) {
    if (!petWindow || petWindow.isDestroyed() || !isFinitePosition(x, y)) return false;
    petWindow.setBounds({ x: Math.round(x), y: Math.round(y), ...size }, false);
    return true;
}

function moveToBottomRight() {
    if (!petWindow || petWindow.isDestroyed()) return;
    dragState = null;
    const display = screen.getPrimaryDisplay();
    const { width, height } = petWindow.getBounds();
    petWindow.setBounds(bottomRightBounds(display.workArea, width, height, WINDOW_MARGIN), false);
}

function resizePet(scalePercent) {
    if (!petWindow || petWindow.isDestroyed()) return;
    if (!SCALE_PERCENTAGES.includes(scalePercent)) return;
    preferences.scalePercent = scalePercent;
    savePreferences();
    dragState = null;

    const size = currentWindowSize();
    const display = screen.getDisplayMatching(petWindow.getBounds());
    petWindow.setBounds(
        bottomRightBounds(display.workArea, size.width, size.height, WINDOW_MARGIN),
        true
    );
    petWindow.webContents.send('pet-window-resized');
}

function quitApp() {
    isQuitting = true;
    app.quit();
}

function showPetMenu() {
    if (!petWindow || petWindow.isDestroyed()) return;

    const modelNameCounts = new Map();
    for (const model of modelCatalog.models) {
        modelNameCounts.set(model.name, (modelNameCounts.get(model.name) || 0) + 1);
    }
    const modelItems = modelCatalog.models.length
        ? modelCatalog.models.map((model) => ({
            label: modelNameCounts.get(model.name) > 1
                ? `${model.name} (${model.relativePath})`
                : model.name,
            type: 'radio',
            checked: preferences.selectedModel === model.id,
            click: () => selectModel(model.id)
        }))
        : [{ label: '尚未选择模型', enabled: false }];

    const menu = Menu.buildFromTemplate([
        {
            label: '模型',
            submenu: [
                ...modelItems,
                { type: 'separator' },
                {
                    label: '重新扫描模型',
                    enabled: Boolean(modelCatalog.directory),
                    click: () => { void rescanModelFolder(); }
                },
                {
                    label: '选择模型文件夹...',
                    click: () => { void chooseModelFolder(); }
                }
            ]
        },
        {
            label: '回到右下角',
            click: moveToBottomRight
        },
        {
            label: '显示比例',
            submenu: SCALE_PERCENTAGES.map((scalePercent) => ({
                label: `${scalePercent}%`,
                type: 'radio',
                checked: preferences.scalePercent === scalePercent,
                click: () => resizePet(scalePercent)
            }))
        },
        {
            label: '眼睛跟随鼠标',
            type: 'checkbox',
            checked: preferences.eyeTrackingEnabled,
            click: (item) => {
                preferences.eyeTrackingEnabled = item.checked;
                savePreferences();
                petWindow.webContents.send('pet-eye-tracking-changed', item.checked);
            }
        },
        {
            label: '开机启动',
            type: 'checkbox',
            checked: preferences.launchAtLogin,
            click: (item) => {
                preferences.launchAtLogin = item.checked;
                savePreferences();
                syncLoginItem();
            }
        },
        { type: 'separator' },
        {
            label: `退出 ${APP_NAME}`,
            accelerator: 'CommandOrControl+Q',
            click: quitApp
        }
    ]);

    menu.popup({ window: petWindow });
}

function createPetWindow() {
    if (petWindow && !petWindow.isDestroyed()) return petWindow;

    const size = currentWindowSize();
    const initialBounds = bottomRightBounds(
        screen.getPrimaryDisplay().workArea,
        size.width,
        size.height,
        WINDOW_MARGIN
    );

    petWindow = new BrowserWindow({
        ...initialBounds,
        title: APP_NAME,
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        hasShadow: false,
        roundedCorners: false,
        alwaysOnTop: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            backgroundThrottling: false
        }
    });

    petWindow.setAlwaysOnTop(true, process.platform === 'darwin' ? 'floating' : 'normal');
    if (process.platform === 'darwin') {
        petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        petWindow.setWindowButtonVisibility(false);
    }
    petWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    petWindow.once('ready-to-show', () => {
        moveToBottomRight();
        petWindow.showInactive();
    });

    petWindow.on('closed', () => {
        petWindow = null;
        if (!isQuitting) quitApp();
    });

    petWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    return petWindow;
}

function senderIsPetWindow(event) {
    return Boolean(
        petWindow &&
        !petWindow.isDestroyed() &&
        event.sender.id === petWindow.webContents.id
    );
}

ipcMain.handle('pet:get-window-bounds', (event) => {
    if (!senderIsPetWindow(event)) return null;
    return petWindow.getBounds();
});

ipcMain.handle('pet:move-window', (event, x, y) => {
    if (!senderIsPetWindow(event)) return false;
    return movePetWindow(x, y);
});

ipcMain.handle('pet:start-window-drag', (event) => {
    if (!senderIsPetWindow(event)) return false;
    dragState = {
        cursor: screen.getCursorScreenPoint(),
        bounds: petWindow.getBounds()
    };
    return true;
});

ipcMain.handle('pet:drag-window-to-cursor', (event) => {
    if (!senderIsPetWindow(event) || !dragState) return false;
    const size = currentWindowSize();
    const bounds = draggedWindowBounds(
        dragState.bounds,
        dragState.cursor,
        screen.getCursorScreenPoint(),
        size.width,
        size.height
    );
    return movePetWindow(bounds.x, bounds.y, { width: bounds.width, height: bounds.height });
});

ipcMain.handle('pet:end-window-drag', (event) => {
    if (!senderIsPetWindow(event)) return false;
    dragState = null;
    return true;
});

ipcMain.handle('pet:get-cursor-position', (event) => {
    if (!senderIsPetWindow(event)) return null;
    return screen.getCursorScreenPoint();
});

ipcMain.handle('pet:get-preferences', (event) => {
    if (!senderIsPetWindow(event)) return null;
    return {
        scalePercent: preferences.scalePercent,
        eyeTrackingEnabled: preferences.eyeTrackingEnabled
    };
});

ipcMain.handle('pet:get-model-state', (event) => {
    if (!senderIsPetWindow(event)) return null;
    return modelStateForRenderer();
});

ipcMain.handle('pet:choose-model-folder', async (event) => {
    if (!senderIsPetWindow(event)) return null;
    return chooseModelFolder();
});

ipcMain.handle('pet:rescan-model-folder', async (event) => {
    if (!senderIsPetWindow(event)) return null;
    return rescanModelFolder();
});

ipcMain.handle('pet:select-model', (event, modelId) => {
    if (!senderIsPetWindow(event)) return false;
    return selectModel(modelId);
});

ipcMain.on('pet:show-menu', (event) => {
    if (senderIsPetWindow(event)) showPetMenu();
});

ipcMain.on('pet:quit', (event) => {
    if (senderIsPetWindow(event)) quitApp();
});

ipcMain.on('pet:render-error', (event, message) => {
    if (senderIsPetWindow(event)) console.error('[renderer]', message);
});

ipcMain.on('pet:render-ready', async (event) => {
    if (!senderIsPetWindow(event)) return;
    console.log('[renderer] Live2D model is ready');

    if (!PREVIEW_CAPTURE_PATH) return;
    try {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const image = await petWindow.webContents.capturePage();
        fs.writeFileSync(path.resolve(PREVIEW_CAPTURE_PATH), image.toPNG());
        console.log(`[preview] Saved ${PREVIEW_CAPTURE_PATH}`);
        if (process.env.PET_CAPTURE_EXIT === '1') quitApp();
    } catch (error) {
        console.error('[preview] Capture failed:', error.message);
        if (process.env.PET_CAPTURE_EXIT === '1') quitApp();
    }
});

if (hasSingleInstanceLock) {
    app.on('second-instance', () => {
        if (!petWindow || petWindow.isDestroyed()) {
            createPetWindow();
            return;
        }
        moveToBottomRight();
        petWindow.showInactive();
    });

    app.whenReady().then(async () => {
        app.setName(APP_NAME);
        Menu.setApplicationMenu(null);
        if (process.platform === 'darwin' && app.dock) app.dock.hide();

        loadPreferences();
        await initializeModelSelection();
        syncLoginItem();
        createPetWindow();
    });
}

app.on('activate', () => {
    if (!petWindow || petWindow.isDestroyed()) createPetWindow();
});

app.on('before-quit', () => {
    isQuitting = true;
});

app.on('window-all-closed', () => {
    if (!isQuitting) quitApp();
});
