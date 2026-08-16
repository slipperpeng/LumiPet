'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petAPI', {
    getWindowBounds: () => ipcRenderer.invoke('pet:get-window-bounds'),
    moveWindow: (x, y) => ipcRenderer.invoke('pet:move-window', x, y),
    getCursorPosition: () => ipcRenderer.invoke('pet:get-cursor-position'),
    getPreferences: () => ipcRenderer.invoke('pet:get-preferences'),
    getModelState: () => ipcRenderer.invoke('pet:get-model-state'),
    chooseModelFolder: () => ipcRenderer.invoke('pet:choose-model-folder'),
    rescanModelFolder: () => ipcRenderer.invoke('pet:rescan-model-folder'),
    selectModel: (modelId) => ipcRenderer.invoke('pet:select-model', String(modelId)),
    startWindowDrag: () => ipcRenderer.invoke('pet:start-window-drag'),
    dragWindowToCursor: () => ipcRenderer.invoke('pet:drag-window-to-cursor'),
    endWindowDrag: () => ipcRenderer.invoke('pet:end-window-drag'),
    showMenu: () => ipcRenderer.send('pet:show-menu'),
    quit: () => ipcRenderer.send('pet:quit'),
    reportReady: () => ipcRenderer.send('pet:render-ready'),
    reportError: (message) => ipcRenderer.send('pet:render-error', String(message)),
    onWindowResized: (callback) => {
        const listener = () => callback();
        ipcRenderer.on('pet-window-resized', listener);
        return () => ipcRenderer.removeListener('pet-window-resized', listener);
    },
    onEyeTrackingChanged: (callback) => {
        const listener = (_event, enabled) => callback(Boolean(enabled));
        ipcRenderer.on('pet-eye-tracking-changed', listener);
        return () => ipcRenderer.removeListener('pet-eye-tracking-changed', listener);
    },
    onModelChanged: (callback) => {
        const listener = (_event, payload) => callback(payload);
        ipcRenderer.on('pet-model-changed', listener);
        return () => ipcRenderer.removeListener('pet-model-changed', listener);
    }
});
