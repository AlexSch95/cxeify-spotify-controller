const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

let CLIENT_ID = null;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;

// desc: Determine data directory - use electron-store location
const getDataDir = () => {
    if (process.env.SPOTIFY_CONTROLLER_DATA) {
        return process.env.SPOTIFY_CONTROLLER_DATA;
    }
    return path.join(os.homedir(), 'AppData', 'Roaming', 'Cxeify');
};

const DATA_DIR = getDataDir();
const SECURE_STORE_FILE = path.join(DATA_DIR, 'secure-credentials.json');
const LAST_DEVICE_FILE = path.join(DATA_DIR, '.last-device.json');

let tokenData = null;
let lastDeviceId = null;

// desc: Get Spotify API headers
function getSpotifyHeaders(token) {
    return {
        'Authorization': `Bearer ${token}`
    };
}

// desc: Load encrypted secure store data
function loadSecureStore() {
    try {
        if (fs.existsSync(SECURE_STORE_FILE)) {
            // electron-store creates encrypted JSON, we just read it raw
            return JSON.parse(fs.readFileSync(SECURE_STORE_FILE, 'utf8'));
        }
    } catch (error) {
        console.error('Error loading secure store:', error);
    }
    return {};
}

// desc: Save to encrypted secure store
function saveToSecureStore(key, value) {
    try {
        const dir = path.dirname(SECURE_STORE_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        let store = loadSecureStore();
        store[key] = value;
        
        fs.writeFileSync(SECURE_STORE_FILE, JSON.stringify(store, null, 2));
        return true;
    } catch (error) {
        console.error(`Error saving ${key} to secure store:`, error);
        return false;
    }
}

// desc: Load Spotify API credentials from secure store
function loadCredentials() {
    try {
        const store = loadSecureStore();
        if (store.credentials) {
            CLIENT_ID = store.credentials.clientId;
            console.log('Credentials loaded from secure store');
            return true;
        }
    } catch (error) {
        console.error('Error loading credentials:', error);
    }
    return false;
}

// desc: Save Spotify API credentials to secure store
function saveCredentials(clientId) {
    const success = saveToSecureStore('credentials', { clientId });
    if (success) {
        CLIENT_ID = clientId;
    }
    return success;
}

function hasCredentials() {
    return CLIENT_ID !== null;
}

// desc: Load OAuth token from secure store
function loadToken() {
    try {
        const store = loadSecureStore();
        if (store.token) {
            tokenData = store.token;
            console.log('Token loaded from secure store');
        }
    } catch (error) {
        console.error('Error loading token:', error);
    }
}

// desc: Persist OAuth token to secure store
function saveToken(data) {
    saveToSecureStore('token', data);
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

app.use(express.json({ charset: 'utf-8' }));
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
    const { clientId } = req.body;

    if (!clientId) {
        return res.status(400).json({ error: 'Missing clientId' });
    }

    if (saveCredentials(clientId)) {
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
        // electron-store saves settings.json directly in DATA_DIR
        const settingsPath = path.join(DATA_DIR, 'settings.json');
        
        if (fs.existsSync(settingsPath)) {
            const fileContent = fs.readFileSync(settingsPath, 'utf8');
            const settings = JSON.parse(fileContent);
            res.json({ accentColor: settings.accentColor || '#1DB954' });
        } else {
            res.json({ accentColor: '#1DB954' });
        }
    } catch (error) {
        console.error('[ACCENT-COLOR] Error reading accent color:', error);
        res.json({ accentColor: '#1DB954' });
    }
});

// desc: Get all settings including viewer colors
app.get('/api/settings', (req, res) => {
    try {
        const settingsPath = path.join(DATA_DIR, 'settings.json');
        
        if (fs.existsSync(settingsPath)) {
            const fileContent = fs.readFileSync(settingsPath, 'utf8');
            const settings = JSON.parse(fileContent);
            res.json({
                accentColor: settings.accentColor || '#1DB954',
                viewerAccentColor: settings.viewerAccentColor || '#1DB954',
                viewerBgColor: settings.viewerBgColor || '#1a1a2e',
                viewerTextColor: settings.viewerTextColor || '#ffffff',
                viewerBgOpacity: settings.viewerBgOpacity !== undefined ? settings.viewerBgOpacity : 100
            });
        } else {
            res.json({
                accentColor: '#1DB954',
                viewerAccentColor: '#1DB954',
                viewerBgColor: '#1a1a2e',
                viewerTextColor: '#ffffff',
                viewerBgOpacity: 100
            });
        }
    } catch (error) {
        console.error('[SETTINGS] Error reading settings:', error);
        res.json({
            accentColor: '#1DB954',
            viewerAccentColor: '#1DB954',
            viewerBgColor: '#1a1a2e',
            viewerTextColor: '#ffffff',
            viewerBgOpacity: 100
        });
    }
});

// desc: Delete saved OAuth token for troubleshooting
app.post('/api/reset-token', (req, res) => {
    try {
        // Delete token from secure store
        let store = loadSecureStore();
        if (store.token) {
            delete store.token;
            fs.writeFileSync(SECURE_STORE_FILE, JSON.stringify(store, null, 2));
            tokenData = null;
            console.log('Token deleted from secure store');
            res.json({ success: true, message: 'Token reset successfully' });
        } else {
            res.json({ success: true, message: 'No token to delete' });
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
            headers: getSpotifyHeaders(token)
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
                }

                // Priority 3: Use first available device
                if (!device) {
                    device = devicesData.devices[0];
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

// desc: Get context details (playlist or album)
app.get('/api/context', async (req, res) => {
    try {
        const token = await ensureValidToken();
        
        // Get current playback to find context
        const playerResponse = await fetch('https://api.spotify.com/v1/me/player', {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (playerResponse.status === 204) {
            return res.json({ hasContext: false });
        }

        const playerData = await playerResponse.json();
        
        if (!playerData.context || !playerData.context.uri) {
            return res.json({ hasContext: false });
        }

        const contextUri = playerData.context.uri;
        const contextType = playerData.context.type; // playlist, album, artist, show
        const contextId = contextUri.split(':').pop();

        let contextData = null;

        // Fetch playlist or album details
        if (contextType === 'playlist') {
            const playlistResponse = await fetch(`https://api.spotify.com/v1/playlists/${contextId}`, {
                headers: getSpotifyHeaders(token)
            });
            
            if (playlistResponse.ok) {
                contextData = await playlistResponse.json();
            } else {
                const errorText = await playlistResponse.text();
                console.error('[CONTEXT] Failed to load playlist:', playlistResponse.status, errorText);
            }
        } else if (contextType === 'album') {
            const albumResponse = await fetch(`https://api.spotify.com/v1/albums/${contextId}`, {
                headers: getSpotifyHeaders(token)
            });
            
            if (albumResponse.ok) {
                contextData = await albumResponse.json();
            } else {
                console.error('[CONTEXT] Failed to load album:', albumResponse.status);
            }
        }

        // Fallback: Use track info if context data failed
        const name = contextData?.name || playerData.item?.album?.name || playerData.context?.external_urls?.spotify?.split('/').pop() || 'Spotify Playlist';
        const image = contextData?.images?.[0]?.url || playerData.item?.album?.images?.[0]?.url || '';
        const totalTracks = contextData?.tracks?.total || 0;

        res.json({
            hasContext: true,
            type: contextType,
            uri: contextUri,
            id: contextId,
            name: name,
            image: image,
            owner: contextData?.owner?.display_name || 'Spotify',
            totalTracks: totalTracks,
            currentTrackUri: playerData.item?.uri
        });
    } catch (error) {
        console.error('Error getting context:', error);
        res.status(500).json({ error: error.message });
    }
});

// desc: Get playlist or album tracks with lazy loading
app.get('/api/context/:contextId/tracks', async (req, res) => {
    try {
        const token = await ensureValidToken();
        const { contextId } = req.params;
        const { type, offset = 0, limit = 20 } = req.query;

        const offsetNum = parseInt(offset);
        const limitNum = parseInt(limit);

        if (type === 'playlist') {
            const response = await fetch(`https://api.spotify.com/v1/playlists/${contextId}/tracks?limit=${limitNum}&offset=${offsetNum}`, {
                headers: getSpotifyHeaders(token)
            });
            
            if (!response.ok) {
                console.error('[TRACKS] Failed to load playlist tracks:', response.status);
                const errorText = await response.text();
                console.error('[TRACKS] Error details:', errorText);
                
                // Forward Retry-After header for rate limiting (always in seconds)
                const retryAfter = response.headers.get('retry-after');
                if (retryAfter && response.status === 429) {
                    const waitSeconds = Math.max(1, parseInt(retryAfter));
                    const minutes = Math.round(waitSeconds / 60);
                    console.error(`[TRACKS] Rate limited by Spotify. Retry after: ${waitSeconds} seconds (${minutes} minutes)`);
                    res.set('Retry-After', waitSeconds.toString());
                }
                
                return res.status(response.status).json({ 
                    error: 'Cannot access this playlist. It may be a Spotify-generated playlist.',
                    items: [],
                    total: 0,
                    hasMore: false
                });
            }
            
            const data = await response.json();
            res.json({
                items: data.items || [],
                total: data.total || 0,
                hasMore: data.next !== null
            });
        } else if (type === 'album') {
            const response = await fetch(`https://api.spotify.com/v1/albums/${contextId}/tracks?limit=${limitNum}&offset=${offsetNum}`, {
                headers: getSpotifyHeaders(token)
            });
            
            if (!response.ok) {
                console.error('[TRACKS] Failed to load album tracks:', response.status);
                
                // Forward Retry-After header for rate limiting (always in seconds)
                const retryAfter = response.headers.get('retry-after');
                if (retryAfter && response.status === 429) {
                    const waitSeconds = Math.max(1, parseInt(retryAfter));
                    const minutes = Math.round(waitSeconds / 60);
                    console.error(`[TRACKS] Rate limited by Spotify. Retry after: ${waitSeconds} seconds (${minutes} minutes)`);
                    res.set('Retry-After', waitSeconds.toString());
                }
                
                return res.status(response.status).json({ 
                    error: 'Cannot access this album.',
                    items: [],
                    total: 0,
                    hasMore: false
                });
            }
            
            const data = await response.json();
            // Transform album tracks to match playlist format
            res.json({
                items: (data.items || []).map(track => ({ track })),
                total: data.total || 0,
                hasMore: data.next !== null
            });
        }
    } catch (error) {
        console.error('Error getting tracks:', error);
        res.status(500).json({ 
            error: error.message,
            items: [],
            total: 0,
            hasMore: false
        });
    }
});

// desc: Play specific track from context
app.post('/api/play-track', async (req, res) => {
    try {
        const token = await ensureValidToken();
        const { contextUri, trackUri } = req.body;

        // Get available devices
        const devicesResponse = await fetch('https://api.spotify.com/v1/me/player/devices', {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        const devicesData = await devicesResponse.json();

        if (!devicesData.devices || devicesData.devices.length === 0) {
            return res.status(404).json({ error: 'No active device found' });
        }

        // Find device (prefer last used or active)
        let device = devicesData.devices.find(d => d.id === lastDeviceId);
        if (!device) {
            device = devicesData.devices.find(d => d.is_active) || devicesData.devices[0];
        }

        // Start playback
        const playResponse = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${device.id}`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                context_uri: contextUri,
                offset: {
                    uri: trackUri
                }
            })
        });

        if (playResponse.status === 204 || playResponse.status === 200) {
            res.json({ success: true });
        } else {
            const error = await playResponse.text();
            res.status(playResponse.status).json({ error });
        }
    } catch (error) {
        console.error('Error playing track:', error);
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
