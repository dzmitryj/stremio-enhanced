import { join } from "path";
import { mkdirSync, existsSync, writeFileSync, unlinkSync } from "fs";
import Updater from "./core/Updater";
import Properties from "./core/Properties";
import logger from "./utils/logger";
import { IPC_CHANNELS, URLS } from "./constants";

// Fix GTK 2/3 and GTK 4 conflict on Linux
import { app } from 'electron';
if (process.platform === 'linux') app.commandLine.appendSwitch('gtk-version', '3');

import { BrowserWindow, shell } from "electron";
import StreamingServer from "./utils/StreamingServer";
import Helpers from "./utils/Helpers";
import StremioService from "./utils/StremioService";
import { setupPluginSettingsAPI } from "./controllers/api/SettingsApiController";
import { setupPluginAlertAPI } from "./controllers/api/AlertApiController";
import { setupWindowControls } from "./controllers/windowController";
import { setupUpdater } from "./controllers/updaterController";
import { setupWindowTransparency } from "./controllers/transparencyController";
import { gpuController } from "./controllers/gpuController";
import { externalPlayerController } from "./controllers/externalPlayerController";

app.setName("stremio-enhanced");
const userDataPath = app.getPath('userData');

export let mainWindow: BrowserWindow | null;
const gotLock = app.requestSingleInstanceLock();
const transparencyFlagPath = join(app.getPath("userData"), "transparency");
const useStremioServiceFlagPath = join(app.getPath("userData"), "use_stremio_service_for_streaming");
const useServerJSFlagPath = join(app.getPath("userData"), "use_server_js_for_streaming");
const transparencyEnabled = existsSync(transparencyFlagPath);

app.commandLine.appendSwitch('disable-features', 'BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights');
app.commandLine.appendSwitch('ignore-connections-limit', 'localhost,127.0.0.1');
app.commandLine.appendSwitch('proxy-bypass-list', '127.0.0.1,localhost,::1');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('enable-quic');
app.commandLine.appendSwitch('enable-async-dns');

gpuController.setup(userDataPath);

if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', (_, argv) => {
        // Windows/Linux: protocol URL comes as a command line argument
        const url = argv.find(arg => arg.startsWith('stremio://'));
        if (url) handleStremioURL(url);
        
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });
}

async function createWindow() {
    mainWindow = new BrowserWindow({
        webPreferences: {
            preload: join(__dirname, "//preload/index.js"),
            // Security Note: These settings are required for the plugin/theme system
            // to work properly. The app loads web.stremio.com and needs to:
            // 1. Make cross-origin requests to local streaming server (webSecurity: false)
            // 2. Access Node.js APIs for file operations (nodeIntegration: true)
            webSecurity: false,
            nodeIntegration: true,
            contextIsolation: true,
            // Additional security hardening/performance settings
            allowRunningInsecureContent: false,
            experimentalFeatures: false,
            spellcheck: false,
            backgroundThrottling: false
        },
        width: 1500,
        height: 850,
        resizable: true,
        maximizable: true,
        fullscreenable: true,
        useContentSize: true,
        icon: "./images/icon.ico",
        frame: transparencyEnabled ? false : true,
        transparent: transparencyEnabled,
        hasShadow: false,
        visualEffectState: transparencyEnabled ? "active" : "followWindow",
        backgroundColor: "#00000000",
    });
    
    mainWindow.setMenu(null);
    mainWindow.loadURL(URLS.STREMIO_WEB);
        
    if (transparencyEnabled) {
        mainWindow.on('enter-full-screen', () => {
            mainWindow?.webContents.send(IPC_CHANNELS.FULLSCREEN_CHANGED, true);
        });
        
        mainWindow.on('leave-full-screen', () => {
            mainWindow?.webContents.send(IPC_CHANNELS.FULLSCREEN_CHANGED, false);
        });
    }
    
    // Opens links in external browser instead of opening them in the Electron app.
    mainWindow.webContents.setWindowOpenHandler((edata:any) => {
        shell.openExternal(edata.url);
        return { action: "deny" };
    });
    
    // Devtools flag
    if(process.argv.includes("--devtools")) { 
        logger.info("Developer tools flag detected. Opening DevTools in detached mode...");
        mainWindow.webContents.openDevTools({ mode: "detach" }); 
    }
    
    // mainWindow.on('closed', () => {
    //     if(!process.argv.includes("--no-stremio-service") && StremioService.isProcessRunning()) StremioService.terminate();
    // });
}

// Use Stremio Service for streaming
async function useStremioService() {
    if(await StremioService.isServiceInstalled()) {
        if (!await StremioService.hasWorkingFFprobe()) {
            const result = await Helpers.showAlert(
                "error",
                "Stremio Service is broken",
                "Stremio Service is installed, but its ffprobe.exe cannot start. This makes /hlsv2/probe fail for every stream. Reinstall Stremio Service, or use server.js directly.",
                ["Reinstall Stremio Service", "Use server.js"]
            );

            if (result === 0) {
                StremioService.terminate();
                await StremioService.downloadAndInstallService();
            } else {
                StremioService.terminate();
                if (existsSync(useStremioServiceFlagPath)) unlinkSync(useStremioServiceFlagPath);
                writeFileSync(useServerJSFlagPath, "1");
                await useServerJS();
            }
            return;
        }

        logger.info("Found usable installation of Stremio Service.");
        await StremioService.start();
    } else {
        const result = await Helpers.showAlert(
            "warning",
            "Stremio Service not found",
            `Stremio Service is required for streaming features. Do you want to download it now? ${process.platform == "linux" ? "This will install the service via Flatpak (if available)." : ""}`,
            ["YES", "NO"]
        );
        if (result === 0) {
            await StremioService.downloadAndInstallService();
        } else {
            logger.info("User declined to download Stremio Service.");
        }
    }
    
    Properties.isUsingStremioService = true;
}

app.on("ready", async () => {
    logger.info("Enhanced version: v" + Updater.getCurrentVersion());
    logger.info("Running on NodeJS version: " + process.version);
    logger.info("Running on Electron version: v" + process.versions.electron);
    logger.info("Running on Chromium version: v" + process.versions.chrome);
    
    logger.info("User data path: " + app.getPath("userData"));
    logger.info("Themes path: " + Properties.themesPath);
    logger.info("Plugins path: " + Properties.pluginsPath);
    
    try {
        const basePath = Properties.enhancedPath;
        
        if (!existsSync(basePath)) {
            mkdirSync(basePath, { recursive: true });
        }
        if (!existsSync(Properties.themesPath)) {
            mkdirSync(Properties.themesPath, { recursive: true });
        }
        if (!existsSync(Properties.pluginsPath)) {
            mkdirSync(Properties.pluginsPath, { recursive: true });
        }
    } catch (err) {
        logger.error("Failed to create necessary directories: " + err);
    }
    
    if(!process.argv.includes("--no-stremio-server")) {
        if(!await StremioService.isProcessRunning()) {
            let platform = process.platform;
            
            // If the user is on Windows, give the option to either use Stremio Service or server.js
            if(platform === "win32") {
                if(existsSync(useStremioServiceFlagPath)) {
                    await useStremioService();
                } else if(existsSync(useServerJSFlagPath)) {
                    await useServerJS();
                } else {
                    await chooseStreamingServer();
                }
                // For macOS and Linux, just give the instruction to use server.js
            } else if (platform === "darwin" || platform === "linux") {
                useServerJS();
            }
        } else {
            logger.info("Stremio Service is already running.");
            if (await StremioService.needsRestartWithFallbackBinaries()) {
                logger.warn("Restarting Stremio Service to use working FFmpeg/FFprobe binaries.");
                StremioService.terminate();
                await useStremioService();
            } else if (await StremioService.hasWorkingFFprobe()) {
                Properties.isUsingStremioService = true;
            } else {
                logger.error("Running Stremio Service has a broken ffprobe installation.");
                StremioService.terminate();
                await useStremioService();
            }
        }
    } else logger.info("Launching without Stremio streaming server.");
    
    // setup IPC and create window
    setupPluginSettingsAPI();
    setupPluginAlertAPI();
    createWindow();
    if(transparencyEnabled) setupWindowControls();
    setupUpdater();
    setupWindowTransparency(transparencyFlagPath);
    gpuController.initIPC(userDataPath);
    externalPlayerController.initIPC();

    // macOS: protocol URLs are sent via 'open-url'
    app.on('open-url', (event, url) => {
        event.preventDefault();
        handleStremioURL(url);
    });
    
    if (!app.isDefaultProtocolClient('stremio')) {
        app.setAsDefaultProtocolClient('stremio');
    }
    
    // Handle any URL passed on first launch (Windows/Linux)
    const launchUrl = process.argv.find(arg => arg.startsWith('stremio://'));
    if (launchUrl) handleStremioURL(launchUrl);
    
    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

// Handle the choice of streaming server on Windows. This is only used for Windows. macOS and Linux will always use server.js to avoid problems.
async function chooseStreamingServer() {
    const result = await Helpers.showAlert(
        "info",
        "Stremio Streaming Server",
        "Stremio Enhanced requires a Stremio Streaming Server for playback to function properly. You can either use the Stremio Service or set up a local streaming server manually.\nThis is a one-time setup. The option you choose will be saved for future app launches.\n\n" +
        "Would you like to use the Stremio Service for streaming?\n\n" +
        "Click 'No' to attempt using server.js directly",
        ["Yes, use Stremio Service (recommended on Windows)", "No, use server.js directly (manual setup required)"]
    );
    
    if(result === 0) {
        logger.info("User chose to use Stremio Service for streaming. User's choice will be saved for future launches.");
        await useStremioService();
        writeFileSync(useStremioServiceFlagPath, "1");
    } else if(result === 1) {
        logger.info("User chose to use server.js for streaming. User's choice will be saved for future launches.");
        useServerJS();
        writeFileSync(useServerJSFlagPath, "1");
    } else {
        logger.info("User closed the streaming server choice dialog. Closing app...");
        app.quit();
    }
}

async function useServerJS() {
    logger.info("Checking for streaming server files...");
    const filesStatus = await StreamingServer.ensureStreamingServerFiles();
    
    if(filesStatus === "ready") {
        logger.info("Running server.js directly...");
        StreamingServer.start();
    } else if(filesStatus === "missing_server_js") {
        logger.error("server.js could not be prepared.");
        await Helpers.showAlert("error", "Streaming Server Setup Failed", "Could not download or prepare server.js. The app will fall back to Stremio Service for this session.", ["OK"]);
        await useStremioService();
    } else {
        logger.info("Working FFmpeg/FFprobe binaries are not available. Falling back to Stremio Service...");
        await useStremioService();
    }
}

app.on("window-all-closed", () => {
    logger.info("Closing app...");
    
    if (process.platform !== "darwin") {
        app.quit();
    }
});

app.on('browser-window-created', (_, window) => {
    window.webContents.on('before-input-event', (event:any, input:any) => {
        switch (true) {
            // Opens Devtools on Ctrl + Shift + I
            case input.control && input.shift && input.key === 'I':
            window.webContents.toggleDevTools();
            event.preventDefault();
            break;
            
            // Toggles fullscreen on F11
            case input.key === 'F11':
            window.setFullScreen(!window.isFullScreen());
            event.preventDefault();
            break;
            
            // Implements zooming in/out using shortcuts (Ctrl + =, Ctrl + -)
            case input.control && input.key === '=':
            if (mainWindow) mainWindow.webContents.zoomFactor += 0.1;
            event.preventDefault();
            break;
            case input.control && input.key === '-':
            if (mainWindow) mainWindow.webContents.zoomFactor -= 0.1;
            event.preventDefault();
            break;
            
            // Implements reload on Ctrl + R
            case input.control && input.key === 'r':
            mainWindow?.reload();
            event.preventDefault();
            break;
        }
    });
});

function handleStremioURL(url: string) {
    try {
        console.log('Received stremio:// URL:', url);
        
        if (mainWindow && url.endsWith("/manifest.json")) {
            mainWindow.loadURL(URLS.STREMIO_WEB_ADD_ADDON + encodeURIComponent(url));
        }
    } catch (err) {
        console.error('Invalid stremio:// URL', err);
    }
}
