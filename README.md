# Cxeify

A modern Spotify controller designed for Corsair Xeneon Edge displays, built with Electron.

## Features

- **Real-time Playback Control**: Play, pause, skip tracks, adjust volume, and seek through songs
- **Shuffle & Repeat**: Full control over playback modes directly from the interface
- **Touch-Optimized UI**: Large, responsive controls perfect for touch displays
- **Album Art Backgrounds**: Blurred album art creates an immersive visual experience
- **Customizable Appearance**: Choose your own accent color to match your setup
- **System Tray Integration**: Runs in the background with easy access from the system tray
- **Auto-Start Options**: Configure the app to launch on Windows startup and/or start the server automatically
- **iCUE Integration**: Embeds seamlessly into Corsair iCUE as an iFrame widget

## How It Works

Cxeify consists of two main components:

1. **Control Panel**: Electron desktop app for configuration and server management
2. **Player Interface**: Web-based UI that displays in your browser or iCUE

The app runs a local Express server that communicates with Spotify's Web API to control your playback. All data stays on your machine - no external services involved.

## Setup

### Prerequisites

- Spotify Premium account
- Spotify Developer App (free to create)

### First-Time Configuration

**Note**: A detailed step-by-step setup guide is available in the app under the **Setup Guide** tab.

1. Create a Spotify App at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
   - Set the redirect URI to: `http://localhost:3000/callback`
   - Note your Client ID and Client Secret

2. Open Cxeify and go to the **Settings** tab
3. Click **Start Server**
4. Click **Open Setup** and enter your Spotify credentials
5. Authorize the app with your Spotify account

### Adding to iCUE

1. In the Settings tab, copy the Player URL
2. Open Corsair iCUE and navigate to your Xeneon Edge settings
3. Add an iFrame widget and paste the URL
4. Adjust the size and position to your liking

## Tech Stack

- **Electron** - Desktop app framework
- **Express** - Local API server
- **Spotify Web API** - Playback control via OAuth 2.0 PKCE flow
- **Vanilla JavaScript** - No frontend frameworks, keeping it lightweight

---

## For Developers

### Building from Source

#### Prerequisites

- Node.js installed
- Git

#### Setup

1. Clone this repository
2. Run `npm install` to install dependencies
3. Run `npm start` to launch the app in development mode

#### Building an Installer

To create a Windows installer:

```bash
npm run build:win
```

The installer will be created in the `dist/` folder.

### Project Structure

- `electron-main.js` - Main Electron process (window management, system tray)
- `electron-ui.html` - Control Panel interface with setup guide and settings
- `server-standalone.js` - Express server handling Spotify API communication
- `server-wrapper.js` - Child process manager for the Express server
- `public/player.html` - Player UI for display in browser/iCUE
- `assets/` - Icons and images

### User Data Storage

The app stores user data in:
- **Windows**: `%APPDATA%/Roaming/spotify-controller/data/`

This includes:
- Spotify access tokens
- Spotify app credentials
- Last used device
- User settings (autostart, accent color)

## Credits

Made by Machinezr (Discord: machine666)
