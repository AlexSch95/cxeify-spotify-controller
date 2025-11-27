const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const SpotifyServer = require('./server-wrapper');

let mainWindow = null;
let tray = null;
let spotifyServer = null;

const PORT = 3000;
const getTokenFilePath = () => path.join(app.getPath('userData'), 'data', '.spotify-token.json');
const getSettingsFilePath = () => path.join(app.getPath('userData'), 'settings.json');

// desc: Load user settings from disk with defaults
function loadSettings() {
    try {
        const settingsPath = getSettingsFilePath();
        if (fs.existsSync(settingsPath)) {
            return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        }
    } catch (error) {
        console.error('Error loading settings:', error);
    }
    return {
        autostart: true,
        accentColor: '#1DB954'
    };
}

// desc: Persist user settings to disk
function saveSettings(settings) {
    try {
        const settingsPath = getSettingsFilePath();
        const dir = path.dirname(settingsPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        console.log('Settings saved');
    } catch (error) {
        console.error('Error saving settings:', error);
    }
}

// desc: Start the Express server as child process
async function startServer() {
    if (!spotifyServer) {
        const userDataPath = path.join(app.getPath('userData'), 'data');
        if (!fs.existsSync(userDataPath)) {
            fs.mkdirSync(userDataPath, { recursive: true });
        }
        const settingsPath = getSettingsFilePath();
        spotifyServer = new SpotifyServer(userDataPath, settingsPath);
    }

    if (spotifyServer.getStatus().running) {
        return { success: false, message: 'Server läuft bereits' };
    }

    try {
        const result = await spotifyServer.start(PORT);
        console.log('Server started on port', PORT);

        if (mainWindow && mainWindow.webContents) {
            mainWindow.webContents.send('server-status', { running: true, port: PORT });
        }

        updateTrayMenu(true);
        return { success: true, message: `Server gestartet auf Port ${PORT}` };
    } catch (error) {
        console.error('Server start error:', error);
        return { success: false, message: error.message };
    }
}

// desc: Stop the Express server child process
async function stopServer() {
    if (!spotifyServer || !spotifyServer.getStatus().running) {
        return { success: false, message: 'Server is not running' };
    }

    try {
        await spotifyServer.stop();
        console.log('Server stopped');

        if (mainWindow && mainWindow.webContents) {
            mainWindow.webContents.send('server-status', { running: false });
        }

        updateTrayMenu(false);
        return { success: true, message: 'Server gestoppt' };
    } catch (error) {
        console.error('Server stop error:', error);
        return { success: false, message: error.message };
    }
}

// desc: Create main Electron window with custom titlebar
function createWindow() {
    const settings = loadSettings();

    mainWindow = new BrowserWindow({
        width: 500,
        height: 700,
        frame: false,
        show: !settings.startMinimized,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        icon: path.join(__dirname, 'assets', 'favicon.ico'),
        autoHideMenuBar: true,
        title: 'Cxeify',
        backgroundColor: '#1a1a2e'
    });

    mainWindow.loadFile('electron-ui.html');

    mainWindow.on('close', (event) => {
        if (!app.isQuitting) {
            event.preventDefault();
            mainWindow.hide();
        }
        return false;
    });
}

function updateTrayMenu(serverRunning) {
    if (!tray) return;

    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Cxeify',
            enabled: false
        },
        { type: 'separator' },
        {
            label: 'Open Control Panel',
            click: () => {
                mainWindow.show();
                mainWindow.focus();
            }
        },
        { type: 'separator' },
        {
            label: serverRunning ? 'Stop Server' : 'Start Server',
            click: async () => {
                if (serverRunning) {
                    await stopServer();
                } else {
                    await startServer();
                }
            }
        },
        {
            label: 'Open Player (Browser)',
            click: () => {
                shell.openExternal('http://127.0.0.1:3000/player.html');
            },
            enabled: serverRunning
        },
        {
            label: 'Open Setup (Browser)',
            click: () => {
                shell.openExternal('http://127.0.0.1:3000/setup');
            },
            enabled: serverRunning
        },
        { type: 'separator' },
        {
            label: serverRunning ? '● Server running' : '○ Server stopped',
            enabled: false
        },
        { type: 'separator' },
        {
            label: 'Quit',
            click: () => {
                app.isQuitting = true;
                app.quit();
            }
        }
    ]);

    tray.setContextMenu(contextMenu);
    tray.setToolTip(serverRunning ? 'Cxeify - Server running' : 'Cxeify - Server stopped');
}

// desc: Create system tray icon with context menu
function createTray() {
    const iconPath = path.join(__dirname, 'assets', 'favicon.ico');
    const icon = nativeImage.createFromPath(iconPath);

    if (icon.isEmpty()) {
        throw new Error('Tray icon not found at: ' + iconPath);
    }

    tray = new Tray(icon);

    updateTrayMenu(false);
    tray.setToolTip('Cxeify');

    tray.on('click', () => {
        mainWindow.show();
        mainWindow.focus();
    });

    tray.on('double-click', () => {
        mainWindow.show();
        mainWindow.focus();
    });
}

// desc: IPC handlers for window controls and server management
ipcMain.handle('window-minimize', () => {
    if (mainWindow) mainWindow.minimize();
});

ipcMain.handle('window-close', () => {
    if (mainWindow) mainWindow.hide();
});

ipcMain.handle('start-server', async () => {
    return await startServer();
});

ipcMain.handle('stop-server', async () => {
    return stopServer();
});

ipcMain.handle('get-server-status', async () => {
    const serverStatus = spotifyServer ? spotifyServer.getStatus() : { running: false };
    const credentialsPath = path.join(app.getPath('userData'), 'data', '.spotify-credentials.json');

    return {
        running: serverStatus.running,
        port: PORT,
        hasToken: fs.existsSync(getTokenFilePath()),
        hasCredentials: fs.existsSync(credentialsPath)
    };
}); ipcMain.handle('open-setup', async () => {
    shell.openExternal('http://127.0.0.1:3000/setup');
});

ipcMain.handle('open-player', async () => {
    shell.openExternal('http://127.0.0.1:3000/player.html');
});

ipcMain.handle('get-settings', async () => {
    return loadSettings();
});

ipcMain.handle('save-settings', async (event, settings) => {
    saveSettings(settings);
    return { success: true };
});

ipcMain.handle('set-app-autostart', async (event, enabled) => {
    try {
        app.setLoginItemSettings({
            openAtLogin: enabled,
            openAsHidden: false
        });
        return { success: true };
    } catch (error) {
        console.error('Error setting app autostart:', error);
        return { success: false, error: error.message };
    }
});

// desc: App lifecycle events
app.whenReady().then(() => {
    createWindow();
    createTray();

    const settings = loadSettings();

    // Sync Windows autostart setting
    if (settings.appAutostart) {
        app.setLoginItemSettings({
            openAtLogin: true,
            openAsHidden: false
        });
    }

    if (settings.autostart) {
        startServer();
    }
});

app.on('window-all-closed', (e) => {
    e.preventDefault();
});

app.on('before-quit', async () => {
    if (spotifyServer && spotifyServer.getStatus().running) {
        await stopServer();
    }
});

app.on('activate', () => {
    if (mainWindow === null) {
        createWindow();
    } else {
        mainWindow.show();
    }
});
