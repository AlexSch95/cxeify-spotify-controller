const Store = require('electron-store');
const { app } = require('electron');

// Initialize store for sensitive data (NOT encrypted to allow server access)
// Server process reads this file directly
const secureStore = new Store({
    name: 'secure-credentials',
    cwd: app.getPath('userData')
});

// Initialize regular store for non-sensitive settings
const settingsStore = new Store({
    name: 'settings',
    cwd: app.getPath('userData'),
    defaults: {
        autostart: true,
        accentColor: '#1DB954',
        appAutostart: false,
        startMinimized: false,
        port: 3000
    }
});

module.exports = {
    // Secure storage for tokens and credentials
    // Note: Stored in AppData with restricted file permissions
    secure: {
        get: (key) => secureStore.get(key),
        set: (key, value) => secureStore.set(key, value),
        delete: (key) => secureStore.delete(key),
        has: (key) => secureStore.has(key),
        clear: () => secureStore.clear()
    },
    
    // Regular storage for settings
    settings: {
        get: (key) => settingsStore.get(key),
        set: (key, value) => settingsStore.set(key, value),
        getAll: () => settingsStore.store,
        setAll: (data) => { settingsStore.store = data; }
    }
};
