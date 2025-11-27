const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

let CLIENT_ID = null;
let CLIENT_SECRET = null;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;

// desc: Determine data directory based on environment
const getDataDir = () => {
    if (process.env.SPOTIFY_CONTROLLER_DATA) {
        return process.env.SPOTIFY_CONTROLLER_DATA;
    }
    const devDataDir = path.join(__dirname, 'data');
    if (fs.existsSync(devDataDir) || !process.pkg) {
        return devDataDir;
    }
    return path.join(os.homedir(), 'AppData', 'Roaming', 'spotify-controller');
};

const DATA_DIR = getDataDir();
const TOKEN_FILE = path.join(DATA_DIR, '.spotify-token.json');
const CREDENTIALS_FILE = path.join(DATA_DIR, '.spotify-credentials.json');
const LAST_DEVICE_FILE = path.join(DATA_DIR, '.last-device.json');

let tokenData = null;
let lastDeviceId = null;

// desc: Load Spotify API credentials from disk
function loadCredentials() {
    try {
        if (fs.existsSync(CREDENTIALS_FILE)) {
            const data = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
            CLIENT_ID = data.clientId;
            CLIENT_SECRET = data.clientSecret;
            console.log('Credentials loaded from file');
            return true;
        }
    } catch (error) {
        console.error('Error loading credentials:', error);
    }
    return false;
}

// desc: Save Spotify API credentials to disk
function saveCredentials(clientId, clientSecret) {
    try {
        const dir = path.dirname(CREDENTIALS_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify({ clientId, clientSecret }, null, 2));
        CLIENT_ID = clientId;
        CLIENT_SECRET = clientSecret;
        console.log('Credentials saved to file');
        return true;
    } catch (error) {
        console.error('Error saving credentials:', error);
        return false;
    }
}

function hasCredentials() {
    return CLIENT_ID && CLIENT_SECRET;
}

// desc: Load OAuth token from disk
function loadToken() {
    try {
        if (fs.existsSync(TOKEN_FILE)) {
            tokenData = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
            console.log('Token loaded from file');
        }
    } catch (error) {
        console.error('Error loading token:', error);
    }
}

// desc: Persist OAuth token to disk
function saveToken(data) {
    try {
        const dir = path.dirname(TOKEN_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2));
        console.log('Token saved to file');
    } catch (error) {
        console.error('Error saving token:', error);
    }
}

// desc: Load last used Spotify device from disk
function loadLastDevice() {
    try {
        if (fs.existsSync(LAST_DEVICE_FILE)) {
            const data = JSON.parse(fs.readFileSync(LAST_DEVICE_FILE, 'utf8'));
            lastDeviceId = data.deviceId;
            console.log('Last device loaded:', data.deviceName);
        }
    } catch (error) {
        console.error('Error loading last device:', error);
    }
}

// desc: Remember last used Spotify device for auto-reconnect
function saveLastDevice(deviceId, deviceName) {
    try {
        const dir = path.dirname(LAST_DEVICE_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const data = { deviceId, deviceName, timestamp: Date.now() };
        fs.writeFileSync(LAST_DEVICE_FILE, JSON.stringify(data, null, 2));
        lastDeviceId = deviceId;
        console.log('Last device saved:', deviceName);
    } catch (error) {
        console.error('Error saving last device:', error);
    }
}

// PKCE helper functions
function generateCodeVerifier() {
    return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier) {
    return crypto.createHash('sha256').update(verifier).digest('base64url');
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let codeVerifier = '';

// desc: API status endpoint
app.get('/', (req, res) => {
    res.send('Cxeify API is running');
});

// desc: Serve setup wizard page
app.get('/setup', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'setup.html'));
});

// desc: Save user-provided Spotify API credentials
app.post('/api/save-credentials', (req, res) => {
    const { clientId, clientSecret } = req.body;

    if (!clientId || !clientSecret) {
        return res.status(400).json({ error: 'Client ID and Secret required' });
    }

    if (saveCredentials(clientId, clientSecret)) {
        res.json({ success: true });
    } else {
        res.status(500).json({ error: 'Failed to save credentials' });
    }
});

// desc: Check if credentials are configured
app.get('/api/credentials-status', (req, res) => {
    res.json({ hasCredentials: hasCredentials() });
});

// desc: Get custom accent color from Electron settings
app.get('/api/accent-color', (req, res) => {
    try {
        const settingsPath = process.env.SPOTIFY_SETTINGS_PATH || path.join(DATA_DIR, '..', 'settings.json');
        if (fs.existsSync(settingsPath)) {
            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            res.json({ accentColor: settings.accentColor || '#1DB954' });
        } else {
            res.json({ accentColor: '#1DB954' });
        }
    } catch (error) {
        console.error('Error reading accent color:', error);
        res.json({ accentColor: '#1DB954' });
    }
});

// desc: Delete saved OAuth token for troubleshooting
app.post('/api/reset-token', (req, res) => {
    try {
        if (fs.existsSync(TOKEN_FILE)) {
            fs.unlinkSync(TOKEN_FILE);
            tokenData = null;
            console.log('Token file deleted');
            res.json({ success: true, message: 'Token reset successfully' });
        } else {
            res.json({ success: true, message: 'No token file to delete' });
        }
    } catch (error) {
        console.error('Error deleting token:', error);
        res.status(500).json({ success: false, error: 'Failed to reset token' });
    }
});

// desc: Initiate Spotify OAuth PKCE flow
app.get('/auth/start', (req, res) => {
    if (!hasCredentials()) {
        return res.redirect('/setup');
    }

    codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    const scope = 'user-read-playback-state user-modify-playback-state user-read-currently-playing';
    const authUrl = `https://accounts.spotify.com/authorize?` +
        `client_id=${CLIENT_ID}` +
        `&response_type=code` +
        `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
        `&code_challenge_method=S256` +
        `&code_challenge=${codeChallenge}` +
        `&scope=${encodeURIComponent(scope)}`;

    res.redirect(authUrl);
});

// desc: Handle OAuth callback and exchange code for token
app.get('/callback', async (req, res) => {
    const code = req.query.code;

    if (!code) {
        return res.status(400).send('No authorization code received');
    }

    try {
        const response = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: REDIRECT_URI,
                code_verifier: codeVerifier
            })
        });

        const data = await response.json();

        if (data.access_token) {
            tokenData = {
                access_token: data.access_token,
                refresh_token: data.refresh_token,
                expires_at: Date.now() + (data.expires_in * 1000)
            };
            saveToken(tokenData);
            res.redirect('/setup-complete.html');
        } else {
            res.status(400).send('Failed to get access token: ' + JSON.stringify(data));
        }
    } catch (error) {
        console.error('Error during token exchange:', error);
        res.status(500).send('Error during authentication');
    }
});

// desc: Ensure OAuth token is valid, refresh if expired
async function ensureValidToken() {
    if (!tokenData) {
        throw new Error('No token available. Please run /setup first.');
    }

    if (Date.now() >= tokenData.expires_at - 60000) { // Refresh 1 minute before expiry
        try {
            const response = await fetch('https://accounts.spotify.com/api/token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: new URLSearchParams({
                    client_id: CLIENT_ID,
                    client_secret: CLIENT_SECRET,
                    grant_type: 'refresh_token',
                    refresh_token: tokenData.refresh_token
                })
            });

            const data = await response.json();

            if (data.access_token) {
                tokenData.access_token = data.access_token;
                tokenData.expires_at = Date.now() + (data.expires_in * 1000);
                if (data.refresh_token) {
                    tokenData.refresh_token = data.refresh_token;
                }
                saveToken(tokenData);
            }
        } catch (error) {
            console.error('Error refreshing token:', error);
            throw error;
        }
    }

    return tokenData.access_token;
}

// desc: Get current Spotify playback state
app.get('/api/current', async (req, res) => {
    try {
        const token = await ensureValidToken();
        const response = await fetch('https://api.spotify.com/v1/me/player', {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (response.status === 204) {
            return res.json({ playing: false });
        }

        const data = await response.json();

        // Save device if currently playing
        if (data && data.device && data.device.id) {
            saveLastDevice(data.device.id, data.device.name);
        }

        res.json(data);
    } catch (error) {
        console.error('Error getting current track:', error);
        res.status(500).json({ error: error.message });
    }
});

// desc: Toggle play/pause or resume playback on last device
app.post('/api/play-pause', async (req, res) => {
    try {
        const token = await ensureValidToken();

        // Get current playback state
        const stateResponse = await fetch('https://api.spotify.com/v1/me/player', {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (stateResponse.status === 204) {
            // No active device - try to find available devices and start playback
            const devicesResponse = await fetch('https://api.spotify.com/v1/me/player/devices', {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            const devicesData = await devicesResponse.json();

            if (devicesData.devices && devicesData.devices.length > 0) {
                let device = null;

                // Priority 1: Use last known device if available
                if (lastDeviceId) {
                    device = devicesData.devices.find(d => d.id === lastDeviceId);
                    if (device) {
                        console.log('Using last known device:', device.name);
                    }
                }

                // Priority 2: Use active device
                if (!device) {
                    device = devicesData.devices.find(d => d.is_active);
                    if (device) {
                        console.log('Using active device:', device.name);
                    }
                }

                // Priority 3: Use first available device
                if (!device) {
                    device = devicesData.devices[0];
                    console.log('Using first available device:', device.name);
                }

                // Start playback on the selected device
                const playResponse = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${device.id}`, {
                    method: 'PUT',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                });

                if (playResponse.status === 204 || playResponse.status === 200) {
                    saveLastDevice(device.id, device.name);
                    return res.json({ success: true, action: 'play', device: device.name });
                }
            }

            return res.status(404).json({ error: 'No active device found. Please start Spotify on any device.' });
        }

        const state = await stateResponse.json();
        const endpoint = state.is_playing ? 'pause' : 'play';

        const response = await fetch(`https://api.spotify.com/v1/me/player/${endpoint}`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        res.json({ success: true, action: endpoint });
    } catch (error) {
        console.error('Error toggling playback:', error);
        res.status(500).json({ error: error.message });
    }
});

// desc: Skip to next track
app.post('/api/next', async (req, res) => {
    try {
        const token = await ensureValidToken();
        await fetch('https://api.spotify.com/v1/me/player/next', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        res.json({ success: true });
    } catch (error) {
        console.error('Error skipping to next:', error);
        res.status(500).json({ error: error.message });
    }
});

// desc: Skip to previous track
app.post('/api/previous', async (req, res) => {
    try {
        const token = await ensureValidToken();
        await fetch('https://api.spotify.com/v1/me/player/previous', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        res.json({ success: true });
    } catch (error) {
        console.error('Error skipping to previous:', error);
        res.status(500).json({ error: error.message });
    }
});

// desc: Set playback volume
app.post('/api/volume', async (req, res) => {
    try {
        const { volume } = req.body;
        const token = await ensureValidToken();
        await fetch(`https://api.spotify.com/v1/me/player/volume?volume_percent=${volume}`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        res.json({ success: true });
    } catch (error) {
        console.error('Error setting volume:', error);
        res.status(500).json({ error: error.message });
    }
});

// desc: Seek to position in track
app.post('/api/seek', async (req, res) => {
    try {
        const { position } = req.body;
        const token = await ensureValidToken();
        await fetch(`https://api.spotify.com/v1/me/player/seek?position_ms=${position}`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        res.json({ success: true });
    } catch (error) {
        console.error('Error seeking:', error);
        res.status(500).json({ error: error.message });
    }
});

// desc: Toggle shuffle mode
app.post('/api/shuffle', async (req, res) => {
    try {
        const { state } = req.body;
        const token = await ensureValidToken();
        await fetch(`https://api.spotify.com/v1/me/player/shuffle?state=${state}`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        res.json({ success: true, shuffle: state });
    } catch (error) {
        console.error('Error toggling shuffle:', error);
        res.status(500).json({ error: error.message });
    }
});

// desc: Set repeat mode (off, context, track)
app.post('/api/repeat', async (req, res) => {
    try {
        const { state } = req.body;
        const token = await ensureValidToken();
        await fetch(`https://api.spotify.com/v1/me/player/repeat?state=${state}`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        res.json({ success: true, repeat: state });
    } catch (error) {
        console.error('Error setting repeat:', error);
        res.status(500).json({ error: error.message });
    }
});

// desc: Initialize server and load persisted data
loadCredentials();
loadToken();
loadLastDevice();

app.listen(PORT, '127.0.0.1', () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Setup URL: http://localhost:${PORT}/setup`);
    console.log(`Player URL: http://localhost:${PORT}/player.html`);

    if (hasCredentials()) {
        console.log('✓ Spotify Credentials loaded');
    } else {
        console.log('⚠ No Spotify Credentials found - please visit /setup');
    }

    if (process.send) {
        process.send({ type: 'started', port: PORT });
    }
});
