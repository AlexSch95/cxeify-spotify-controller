const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
    // Window controls
    minimizeWindow: () => ipcRenderer.invoke('window-minimize'),
    closeWindow: () => ipcRenderer.invoke('window-close'),
    
    // Server management
    startServer: () => ipcRenderer.invoke('start-server'),
    stopServer: () => ipcRenderer.invoke('stop-server'),
    getServerStatus: () => ipcRenderer.invoke('get-server-status'),
    
    // Navigation
    openSetup: () => ipcRenderer.invoke('open-setup'),
    openPlayer: () => ipcRenderer.invoke('open-player'),
    
    // Settings
    getSettings: () => ipcRenderer.invoke('get-settings'),
    saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
    
    // App autostart
    setAppAutostart: (enabled) => ipcRenderer.invoke('set-app-autostart', enabled),
    
    // Force kill server
    forceKillServer: () => ipcRenderer.invoke('force-kill-server'),
    
    // Server status listener
    onServerStatus: (callback) => {
        ipcRenderer.on('server-status', (event, data) => callback(data));
    }
});
