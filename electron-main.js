const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage } = require('electron');
const path = require('path');
const SpotifyServer = require('./server-wrapper');
const storage = require('./secure-storage');

let mainWindow = null;
let tray = null;
let spotifyServer = null;

// desc: Load user settings from electron-store
function loadSettings() {
    return storage.settings.getAll();
}

// desc: Persist user settings to electron-store
function saveSettings(settings) {
    storage.settings.setAll(settings);
    console.log('Settings saved');
}

// desc: Get configured port from settings
function getPort() {
    const settings = loadSettings();
    return settings.port || 3000;
}

// desc: Start the Express server as child process
async function startServer() {
    if (!spotifyServer) {
        const userDataPath = app.getPath('userData');
        spotifyServer = new SpotifyServer(userDataPath, userDataPath);
    }

    if (spotifyServer.getStatus().running) {
        return { success: false, message: 'Server is already running' };
    }

    const PORT = getPort();

    try {
        const result = await spotifyServer.start(PORT);
        console.log('Server started on port', PORT);

        if (mainWindow && mainWindow.webContents) {
            mainWindow.webContents.send('server-status', { running: true, port: PORT });
        }

        updateTrayMenu(true);
        return { success: true, message: `Server started on port ${PORT}` };
    } catch (error) {
        console.error('Server start error:', error);
        // Check if error is due to port already in use
        if (error.message && (error.message.includes('EADDRINUSE') || error.message.includes('port') || error.message.includes('listen'))) {
            return { success: false, message: `Port ${PORT} is already in use. Please kill running server instances via "Troubleshooting".` };
        }
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
        return { success: true, message: 'Server stopped' };
    } catch (error) {
        console.error('Server stop error:', error);
        return { success: false, message: error.message };
    }
}

// desc: Create main Electron window with custom titlebar
function createWindow() {
    const settings = loadSettings();

    mainWindow = new BrowserWindow({
        width: 1000,
        height: 700,
        frame: false,
        show: !settings.startMinimized,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        },
        icon: path.join(__dirname, 'assets', 'favicon.ico'),
        autoHideMenuBar: true,
        title: 'Cxeify',
        backgroundColor: '#1a1a2e'
    });

    mainWindow.loadFile('electron-ui.html');

    let hasShownTrayNotification = false;

    mainWindow.on('close', (event) => {
        if (!app.isQuitting) {
            event.preventDefault();
            
            const { dialog } = require('electron');
            
            const result = dialog.showMessageBoxSync(mainWindow, {
                type: 'question',
                title: 'Minimize to Tray?',
                message: 'Cxeify is still running',
                detail: 'Do you want to minimize to the system tray or close the application completely?',
                buttons: ['Minimize to Tray', 'Close Completely'],
                defaultId: 0,
                cancelId: 0,
                noLink: true
            });
            
            if (result === 0) {
                // Minimize to tray
                mainWindow.hide();
            } else {
                // Close completely
                app.isQuitting = true;
                if (tray) {
                    tray.destroy();
                    tray = null;
                }
                // Stop server before quitting
                if (spotifyServer && spotifyServer.getStatus().running) {
                    stopServer().then(() => {
                        mainWindow.destroy();
                        app.quit();
                    });
                } else {
                    mainWindow.destroy();
                    app.quit();
                }
            }
        }
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
                const PORT = getPort();
                shell.openExternal(`http://127.0.0.1:${PORT}/player.html`);
            },
            enabled: serverRunning
        },
        {
            label: 'Open Setup (Browser)',
            click: () => {
                const PORT = getPort();
                shell.openExternal(`http://127.0.0.1:${PORT}/setup`);
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
            click: async () => {
                app.isQuitting = true;
                if (tray) {
                    tray.destroy();
                    tray = null;
                }
                if (spotifyServer && spotifyServer.getStatus().running) {
                    await stopServer();
                }
                if (mainWindow) {
                    mainWindow.destroy();
                }
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
    if (mainWindow) mainWindow.close();
});

ipcMain.handle('start-server', async () => {
    return await startServer();
});

ipcMain.handle('stop-server', async () => {
    return stopServer();
});

ipcMain.handle('get-server-status', async () => {
    const serverStatus = spotifyServer ? spotifyServer.getStatus() : { running: false };
    const PORT = getPort();

    return {
        running: serverStatus.running,
        port: PORT,
        hasToken: storage.secure.has('token'),
        hasCredentials: storage.secure.has('credentials')
    };
}); ipcMain.handle('open-setup', async () => {
    const PORT = getPort();
    shell.openExternal(`http://127.0.0.1:${PORT}/setup`);
});

ipcMain.handle('open-player', async () => {
    const PORT = getPort();
    shell.openExternal(`http://127.0.0.1:${PORT}/player.html`);
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

ipcMain.handle('force-kill-server', async () => {
    try {
        const { execSync } = require('child_process');
        // Kill any process using port 3000 on Windows
        try {
            const output = execSync('netstat -ano | findstr :3000', { encoding: 'utf8' });
            
            const lines = output.split('\n').filter(line => line.trim().length > 0);
            
            const pids = new Set();
            lines.forEach(line => {
                const parts = line.trim().split(/\s+/);
                const pid = parts[parts.length - 1];
                if (pid && !isNaN(pid) && pid !== '0') {
                    pids.add(pid);
                }
            });
            
            if (pids.size > 0) {
                let killedCount = 0;
                pids.forEach(pid => {
                    try {
                        execSync(`taskkill /F /PID ${pid}`, { encoding: 'utf8' });
                        killedCount++;
                    } catch (err) {
                        console.error(`Failed to kill process ${pid}:`, err.message);
                    }
                });
                
                // Reset server state
                if (spotifyServer) {
                    spotifyServer.isRunning = false;
                    spotifyServer.serverProcess = null;
                }
                
                updateTrayMenu(false);
                return { success: true, message: `Killed ${killedCount} server instance(s)` };
            } else {
                return { success: true, message: 'No running server instances found on port 3000' };
            }
        } catch (err) {
            console.error('Netstat error:', err);
            if (err.status === 1) {
                // netstat found nothing - no processes on port 3000
                return { success: true, message: 'No running server instances found on port 3000' };
            }
            throw err;
        }
    } catch (error) {
        console.error('Error force killing server:', error);
        return { success: false, message: 'Error terminating server instances: ' + error.message };
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

app.on('window-all-closed', () => {
    if (app.isQuitting) {
        app.quit();
    }
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
