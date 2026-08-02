const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

let CLIENT_ID = null;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;

const REQUIRED_SCOPES = [
    'user-read-playback-state',
    'user-modify-playback-state',
    'user-read-currently-playing',
    'user-library-read',
    'user-library-modify',
    'user-read-recently-played'
];
const SCOPE_STRING = REQUIRED_SCOPES.join(' ');

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
let authState = { valid: true, reason: null };

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

// Any mutating control request invalidates the /api/current cache so the next
// poll reflects the new state immediately instead of waiting for TTL.
app.use((req, res, next) => {
    if ((req.method === 'POST' || req.method === 'PUT') && req.path.startsWith('/api/')) {
        invalidateCurrentCache();
    }
    next();
});

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

    const forceDialog = req.query.force === '1';
    const authUrl = `https://accounts.spotify.com/authorize?` +
        `client_id=${CLIENT_ID}` +
        `&response_type=code` +
        `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
        `&code_challenge_method=S256` +
        `&code_challenge=${codeChallenge}` +
        `&scope=${encodeURIComponent(SCOPE_STRING)}` +
        (forceDialog ? `&show_dialog=true` : '');

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
                expires_at: Date.now() + (data.expires_in * 1000),
                scope: data.scope || ''
            };
            saveToken(tokenData);
            authState = { valid: true, reason: null };
            console.log('[AUTH] Token granted with scopes:', data.scope || '(not reported)');
            res.redirect('/setup-complete.html');
        } else {
            res.status(400).send('Failed to get access token: ' + JSON.stringify(data));
        }
    } catch (error) {
        console.error('Error during token exchange:', error);
        res.status(500).send('Error during authentication');
    }
});

// desc: Exchange refresh_token for a new access token; returns true on success
async function refreshAccessToken() {
    if (!tokenData || !tokenData.refresh_token) return false;
    try {
        const response = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
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
            if (data.refresh_token) tokenData.refresh_token = data.refresh_token;
            if (data.scope) tokenData.scope = data.scope;
            saveToken(tokenData);
            authState = { valid: true, reason: null };
            return true;
        }

        console.error('[AUTH] Refresh failed:', data);
        authState = { valid: false, reason: data.error || 'refresh_failed' };
        return false;
    } catch (error) {
        console.error('[AUTH] Refresh request error:', error);
        authState = { valid: false, reason: 'network_error' };
        return false;
    }
}

// desc: Ensure OAuth token is valid, refresh if expired. Throws a REAUTH_REQUIRED
// error when the refresh token is revoked or otherwise unusable, so endpoints can
// surface a clear signal to the client instead of silently making an expired call.
async function ensureValidToken() {
    if (!tokenData) {
        const err = new Error('Not authenticated');
        err.code = 'NOT_AUTHENTICATED';
        throw err;
    }

    if (Date.now() >= tokenData.expires_at - 60000) {
        const ok = await refreshAccessToken();
        if (!ok) {
            const err = new Error('Re-authorization required');
            err.code = 'REAUTH_REQUIRED';
            err.reason = authState.reason || 'refresh_failed';
            throw err;
        }
    }

    return tokenData.access_token;
}

// desc: Map auth errors to a 401 response; returns true if handled
function handleAuthError(err, res) {
    if (err && (err.code === 'REAUTH_REQUIRED' || err.code === 'NOT_AUTHENTICATED')) {
        res.status(401).json({
            error: err.code === 'NOT_AUTHENTICATED' ? 'not_authenticated' : 'reauth_required',
            reason: err.reason || null
        });
        return true;
    }
    return false;
}

// desc: Report whether re-auth is needed (token revoked, missing scopes, or not authenticated)
app.get('/api/scope-status', async (req, res) => {
    if (!tokenData) {
        return res.json({
            authenticated: false,
            ok: false,
            missing: REQUIRED_SCOPES,
            reason: 'not_authenticated'
        });
    }

    // Legacy tokens from earlier builds didn't save the scope field. Probe via
    // refresh so we don't mis-report them as missing every scope. Also detects
    // revoked refresh tokens as a side effect.
    if (!tokenData.scope && tokenData.refresh_token) {
        await refreshAccessToken();
    }

    if (!authState.valid) {
        return res.json({
            authenticated: true,
            ok: false,
            missing: [],
            reason: authState.reason || 'refresh_failed'
        });
    }

    const granted = (tokenData.scope || '').split(' ').filter(Boolean);
    const missing = REQUIRED_SCOPES.filter(s => !granted.includes(s));
    res.json({
        authenticated: true,
        ok: missing.length === 0,
        granted,
        missing,
        reason: missing.length ? 'missing_scopes' : null
    });
});

// In-memory cache for /me/player — multiple client instances (iCUE widget,
// preview pane, browser tabs) all share one upstream Spotify call per window.
const CURRENT_CACHE_TTL = 2500;
let currentCache = { expiresAt: 0, status: 0, body: null, rateLimited: false, retryAfter: 0 };
function invalidateCurrentCache() { currentCache.expiresAt = 0; }

// desc: Get current Spotify playback state
app.get('/api/current', async (req, res) => {
    try {
        // Serve from cache if fresh
        if (Date.now() < currentCache.expiresAt) {
            if (currentCache.rateLimited) {
                res.set('Retry-After', String(currentCache.retryAfter));
                return res.status(429).json({ error: 'rate_limited', retryAfter: currentCache.retryAfter });
            }
            if (currentCache.status === 204) return res.json({ playing: false });
            return res.json(currentCache.body);
        }

        const token = await ensureValidToken();
        const response = await fetch('https://api.spotify.com/v1/me/player', {
            headers: getSpotifyHeaders(token)
        });

        if (response.status === 204) {
            currentCache = { expiresAt: Date.now() + CURRENT_CACHE_TTL, status: 204, body: null, rateLimited: false, retryAfter: 0 };
            return res.json({ playing: false });
        }

        if (response.status === 401) {
            // Access token rejected by Spotify even though our refresh said OK
            // (can happen if the token was revoked server-side). Flag for re-auth.
            authState = { valid: false, reason: 'token_revoked' };
            return res.status(401).json({ error: 'reauth_required', reason: 'token_revoked' });
        }

        if (response.status === 429) {
            const retryAfter = parseInt(response.headers.get('retry-after') || '10', 10);
            // Cache the rate-limit state for the full retry window so every client
            // shares the same backoff and we don't hammer Spotify further.
            currentCache = { expiresAt: Date.now() + retryAfter * 1000, status: 429, body: null, rateLimited: true, retryAfter };
            res.set('Retry-After', String(retryAfter));
            return res.status(429).json({ error: 'rate_limited', retryAfter });
        }

        const data = await response.json();

        // Save device if currently playing
        if (data && data.device && data.device.id) {
            saveLastDevice(data.device.id, data.device.name);
        }

        currentCache = { expiresAt: Date.now() + CURRENT_CACHE_TTL, status: response.status, body: data, rateLimited: false, retryAfter: 0 };
        res.json(data);
    } catch (error) {
        if (handleAuthError(error, res)) return;
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
            // Changed from /tracks to /items per Spotify API February 2026 update
            const response = await fetch(`https://api.spotify.com/v1/playlists/${contextId}/items?limit=${limitNum}&offset=${offsetNum}`, {
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
            // Normalize response: Spotify renamed 'track' to 'item' in Feb 2026
            // Map back to 'track' for frontend backward compatibility
            const normalizedItems = (data.items || []).map(item => ({
                ...item,
                track: item.item || item.track  // Support both old and new format
            }));
            res.json({
                items: normalizedItems,
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

// desc: Check if a track is saved in user's library (uses Feb 2026 /me/library endpoint)
app.get('/api/track-saved/:id', async (req, res) => {
    try {
        const token = await ensureValidToken();
        const { id } = req.params;
        const uri = `spotify:track:${id}`;
        const response = await fetch(`https://api.spotify.com/v1/me/library/contains?uris=${encodeURIComponent(uri)}`, {
            headers: getSpotifyHeaders(token)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('[TRACK-SAVED] Failed:', response.status, errorText);
            return res.status(response.status).json({ error: 'Failed to check saved status' });
        }

        const data = await response.json();
        res.json({ saved: Array.isArray(data) ? data[0] === true : false });
    } catch (error) {
        console.error('Error checking saved track:', error);
        res.status(500).json({ error: error.message });
    }
});

// desc: Save or remove a track from user's library (uses Feb 2026 /me/library endpoint)
app.put('/api/track-saved', async (req, res) => {
    try {
        const { id, saved } = req.body;
        if (!id) {
            return res.status(400).json({ error: 'Missing track id' });
        }

        const token = await ensureValidToken();
        const uri = `spotify:track:${id}`;
        const method = saved ? 'PUT' : 'DELETE';
        const response = await fetch(`https://api.spotify.com/v1/me/library?uris=${encodeURIComponent(uri)}`, {
            method,
            headers: getSpotifyHeaders(token)
        });

        if (!response.ok && response.status !== 200 && response.status !== 204) {
            const errorText = await response.text();
            console.error('[TRACK-SAVED] Toggle failed:', response.status, errorText);
            return res.status(response.status).json({ error: 'Failed to toggle saved status' });
        }

        res.json({ success: true, saved: !!saved });
    } catch (error) {
        console.error('Error toggling saved track:', error);
        res.status(500).json({ error: error.message });
    }
});

// desc: Get the current user's playback queue
app.get('/api/queue', async (req, res) => {
    try {
        const token = await ensureValidToken();
        const response = await fetch('https://api.spotify.com/v1/me/player/queue', {
            headers: getSpotifyHeaders(token)
        });

        if (response.status === 204) {
            return res.json({ currently_playing: null, queue: [] });
        }

        if (!response.ok) {
            const errorText = await response.text();
            console.error('[QUEUE] Failed:', response.status, errorText);
            return res.status(response.status).json({ error: 'Failed to load queue', queue: [] });
        }

        const data = await response.json();
        res.json({
            currently_playing: data.currently_playing || null,
            queue: data.queue || []
        });
    } catch (error) {
        console.error('Error getting queue:', error);
        res.status(500).json({ error: error.message, queue: [] });
    }
});

// desc: Get the user's recently played tracks
app.get('/api/recently-played', async (req, res) => {
    try {
        const token = await ensureValidToken();
        const limit = Math.min(50, parseInt(req.query.limit || '30', 10));
        const response = await fetch(`https://api.spotify.com/v1/me/player/recently-played?limit=${limit}`, {
            headers: getSpotifyHeaders(token)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('[RECENT] Failed:', response.status, errorText);
            return res.status(response.status).json({ error: 'Failed to load recently played', items: [] });
        }

        const data = await response.json();
        res.json({ items: data.items || [] });
    } catch (error) {
        console.error('Error getting recently played:', error);
        res.status(500).json({ error: error.message, items: [] });
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

// Windows SMTC fallback — reads the system's currently-playing media via a
// PowerShell subprocess that talks to Windows.Media.Control. Used by the
// player UI when Spotify rate-limits us so the widget keeps showing live info.
const SMTC_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName 'System.Runtime.WindowsRuntime' | Out-Null
    $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
    })[0]
    function Await($task, $resultType) {
        $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
        $netTask = $asTask.Invoke($null, @($task))
        $netTask.Wait(-1) | Out-Null
        $netTask.Result
    }
    [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime] | Out-Null
    $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    $session = $mgr.GetCurrentSession()
    if ($null -eq $session) { '{}'; exit }
    [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType=WindowsRuntime] | Out-Null
    $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $info = $session.GetPlaybackInfo()
    $timeline = $session.GetTimelineProperties()
    $out = @{
        title = $props.Title
        artist = $props.Artist
        album = $props.AlbumTitle
        isPlaying = ($info.PlaybackStatus -eq 'Playing')
        appId = $session.SourceAppUserModelId
        position = [int]$timeline.Position.TotalMilliseconds
        duration = [int]$timeline.EndTime.TotalMilliseconds
        positionReportedAt = [int64]$timeline.LastUpdatedTime.ToUnixTimeMilliseconds()
    }
    $out | ConvertTo-Json -Compress
} catch {
    @{ error = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;

let smtcCache = { expiresAt: 0, data: null };
const SMTC_CACHE_TTL = 2500;

function getSystemMedia() {
    if (Date.now() < smtcCache.expiresAt) return Promise.resolve(smtcCache.data);
    return new Promise((resolve) => {
        const encoded = Buffer.from(SMTC_SCRIPT, 'utf16le').toString('base64');
        const proc = spawn('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-EncodedCommand', encoded
        ], { windowsHide: true });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => { try { proc.kill(); } catch (_) {} }, 2500);
        proc.stdout.on('data', (d) => stdout += d);
        proc.stderr.on('data', (d) => stderr += d);
        proc.on('close', () => {
            clearTimeout(timer);
            let data;
            try {
                data = JSON.parse((stdout || '{}').trim());
            } catch (e) {
                data = { error: 'parse_failed' };
            }
            smtcCache = { expiresAt: Date.now() + SMTC_CACHE_TTL, data };
            resolve(data);
        });
        proc.on('error', (e) => {
            clearTimeout(timer);
            resolve({ error: e.message });
        });
    });
}

// desc: Read the system's currently-playing media (Windows SMTC fallback)
app.get('/api/system-media', async (req, res) => {
    const data = await getSystemMedia();
    res.json(data);
});

const SMTC_COMMAND_METHODS = {
    play_pause: 'TryTogglePlayPauseAsync',
    next: 'TrySkipNextAsync',
    previous: 'TrySkipPreviousAsync'
};

// Shared Core Audio PowerShell shim — used for GET/SET system volume. Cost is
// ~700ms per invocation because of the C# Add-Type compile; acceptable for
// user-initiated volume changes, not for polling.
const AUDIO_SHIM = `
Add-Type -TypeDefinition @"
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
    int f(); int g(); int h(); int i();
    int SetMasterVolumeLevelScalar(float fLevel, System.Guid pguidEventContext);
    int j();
    int GetMasterVolumeLevelScalar(out float pfLevel);
    int k(); int l(); int m(); int n();
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, System.Guid pguidEventContext);
    int GetMute(out bool pbMute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    int Activate(ref System.Guid id, int clsCtx, int activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object aev);
}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    int f();
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
public class Audio {
    static IAudioEndpointVolume Vol() {
        var e = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
        IMMDevice dev = null;
        Marshal.ThrowExceptionForHR(e.GetDefaultAudioEndpoint(0, 1, out dev));
        System.Guid g = typeof(IAudioEndpointVolume).GUID;
        object o;
        Marshal.ThrowExceptionForHR(dev.Activate(ref g, 23, 0, out o));
        return (IAudioEndpointVolume)o;
    }
    public static float Get() { float v = 0; Marshal.ThrowExceptionForHR(Vol().GetMasterVolumeLevelScalar(out v)); return v; }
    public static void Set(float v) { Marshal.ThrowExceptionForHR(Vol().SetMasterVolumeLevelScalar(v, System.Guid.Empty)); }
    public static void SetMute(bool m) { Marshal.ThrowExceptionForHR(Vol().SetMute(m, System.Guid.Empty)); }
}
"@ -Language CSharp | Out-Null
`;

function runPowerShell(scriptText, timeoutMs = 3500) {
    return new Promise((resolve) => {
        const encoded = Buffer.from(scriptText, 'utf16le').toString('base64');
        const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true });
        let stdout = '';
        const timer = setTimeout(() => { try { proc.kill(); } catch (_) {} }, timeoutMs);
        proc.stdout.on('data', (d) => stdout += d);
        proc.on('close', () => {
            clearTimeout(timer);
            try { resolve(JSON.parse((stdout || '{}').trim())); }
            catch (e) { resolve({ success: false, error: 'parse_failed', raw: stdout }); }
        });
        proc.on('error', (e) => { clearTimeout(timer); resolve({ success: false, error: e.message }); });
    });
}

// desc: Read current system volume via Core Audio (slow ~900ms, user-triggered only)
app.get('/api/system-volume', async (req, res) => {
    const script = AUDIO_SHIM + `\n@{ volume = [int]([Audio]::Get() * 100) } | ConvertTo-Json -Compress`;
    const result = await runPowerShell(script);
    res.json(result);
});

// desc: Set system volume (0-100) via Core Audio. Mutes when volume reaches 0,
// unmutes otherwise — matches what users expect when dragging a slider.
app.post('/api/system-volume', async (req, res) => {
    const volume = Math.max(0, Math.min(100, parseInt(req.body && req.body.volume, 10)));
    if (Number.isNaN(volume)) return res.status(400).json({ error: 'invalid_volume' });
    const muteFlag = volume === 0 ? '$true' : '$false';
    const script = AUDIO_SHIM + `\n[Audio]::Set(${volume / 100}); [Audio]::SetMute(${muteFlag}); @{ success = $true; volume = ${volume}; muted = ${muteFlag} } | ConvertTo-Json -Compress`;
    const result = await runPowerShell(script);
    res.json(result);
});

function runSMTCCommand(method) {
    return new Promise((resolve) => {
        const script = `
$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName 'System.Runtime.WindowsRuntime' | Out-Null
    $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
    })[0]
    function Await($task, $resultType) {
        $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
        $netTask = $asTask.Invoke($null, @($task))
        $netTask.Wait(-1) | Out-Null
        $netTask.Result
    }
    [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime] | Out-Null
    $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    $session = $mgr.GetCurrentSession()
    if ($null -eq $session) { @{ success = $false; error = 'no_session' } | ConvertTo-Json -Compress; exit }
    $result = Await ($session.${method}()) ([bool])
    @{ success = [bool]$result } | ConvertTo-Json -Compress
} catch {
    @{ success = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}`;
        const encoded = Buffer.from(script, 'utf16le').toString('base64');
        const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true });
        let stdout = '';
        const timer = setTimeout(() => { try { proc.kill(); } catch (_) {} }, 3000);
        proc.stdout.on('data', (d) => stdout += d);
        proc.on('close', () => {
            clearTimeout(timer);
            try { resolve(JSON.parse((stdout || '{}').trim())); }
            catch (e) { resolve({ success: false, error: 'parse_failed' }); }
        });
        proc.on('error', (e) => { clearTimeout(timer); resolve({ success: false, error: e.message }); });
    });
}

// desc: Send a play/pause/next/previous command to the system media session
app.post('/api/system-media/:action', async (req, res) => {
    if (req.params.action === 'seek') {
        const positionMs = Math.max(0, parseInt(req.body && req.body.position, 10));
        if (Number.isNaN(positionMs)) return res.status(400).json({ error: 'invalid_position' });
        const ticks = positionMs * 10000; // 100-nanosecond units
        const script = `
$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName 'System.Runtime.WindowsRuntime' | Out-Null
    $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
    })[0]
    function Await($task, $resultType) {
        $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
        $netTask = $asTask.Invoke($null, @($task))
        $netTask.Wait(-1) | Out-Null
        $netTask.Result
    }
    [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime] | Out-Null
    $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    $session = $mgr.GetCurrentSession()
    if ($null -eq $session) { @{ success = $false; error = 'no_session' } | ConvertTo-Json -Compress; exit }
    $result = Await ($session.TryChangePlaybackPositionAsync(${ticks})) ([bool])
    @{ success = [bool]$result } | ConvertTo-Json -Compress
} catch {
    @{ success = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}`;
        const result = await runPowerShell(script);
        smtcCache.expiresAt = 0;
        return res.json(result);
    }

    const method = SMTC_COMMAND_METHODS[req.params.action];
    if (!method) return res.status(400).json({ error: 'unknown_action' });
    const result = await runSMTCCommand(method);
    // invalidate the SMTC read cache so the next fetch reflects the new state
    smtcCache.expiresAt = 0;
    res.json(result);
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
