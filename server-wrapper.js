const path = require('path');
const { fork } = require('child_process');

// desc: Wrapper class to manage Express server as child process
class SpotifyServer {
    constructor(userDataPath, settingsPath) {
        this.serverProcess = null;
        this.isRunning = false;
        this.userDataPath = userDataPath;
        this.settingsPath = settingsPath;
    }

    // desc: Start server as forked child process
    start(port = 3000) {
        return new Promise((resolve, reject) => {
            if (this.isRunning) {
                return reject(new Error('Server is already running'));
            }

            let errorMessage = '';
            let hasResolved = false;

            try {
                this.serverProcess = fork(
                    path.join(__dirname, 'server-standalone.js'),
                    [],
                    {
                        env: {
                            ...process.env,
                            PORT: port,
                            SPOTIFY_CONTROLLER_DATA: this.userDataPath,
                            SPOTIFY_SETTINGS_PATH: this.settingsPath
                        },
                        stdio: ['pipe', 'pipe', 'pipe', 'ipc']
                    }
                );

                this.serverProcess.stdout.on('data', (data) => {
                    console.log(`Server: ${data.toString().trim()}`);
                });

                this.serverProcess.stderr.on('data', (data) => {
                    errorMessage += data.toString();
                    console.error(`Server Error: ${data.toString().trim()}`);
                });

                this.serverProcess.on('message', (msg) => {
                    if (msg.type === 'started' && !hasResolved) {
                        hasResolved = true;
                        this.isRunning = true;
                        resolve({ success: true, port: msg.port });
                    }
                });

                this.serverProcess.on('error', (error) => {
                    if (!hasResolved) {
                        hasResolved = true;
                        this.isRunning = false;
                        reject(error);
                    }
                });

                this.serverProcess.on('exit', (code) => {
                    this.isRunning = false;
                    console.log(`Server process exited with code ${code}`);

                    if (!hasResolved && code !== 0) {
                        hasResolved = true;
                        const error = errorMessage.includes('EADDRINUSE')
                            ? new Error('Port 3000 is already in use. Please stop other applications on this port.')
                            : new Error(`Failed to start server (Exit Code: ${code})\n${errorMessage}`);
                        reject(error);
                    }
                });

                setTimeout(() => {
                    if (!hasResolved) {
                        hasResolved = true;
                        this.stop();
                        const error = errorMessage.includes('EADDRINUSE')
                            ? new Error('Port 3000 ist bereits belegt. Schließe andere Anwendungen die Port 3000 nutzen.')
                            : new Error(`Server start timeout - keine Antwort nach 5 Sekunden\n${errorMessage}`);
                        reject(error);
                    }
                }, 5000);

            } catch (error) {
                if (!hasResolved) {
                    reject(error);
                }
            }
        });
    }

    // desc: Stop server child process gracefully
    stop() {
        return new Promise((resolve) => {
            if (!this.isRunning || !this.serverProcess) {
                this.isRunning = false;
                return resolve({ success: true });
            }

            this.serverProcess.once('exit', () => {
                this.isRunning = false;
                this.serverProcess = null;
                resolve({ success: true });
            });

            this.serverProcess.kill();
        });
    }

    getStatus() {
        return {
            running: this.isRunning,
            pid: this.serverProcess ? this.serverProcess.pid : null
        };
    }
}

module.exports = SpotifyServer;
