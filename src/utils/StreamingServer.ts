import { fork, execSync } from "child_process";
import { createWriteStream, existsSync, mkdirSync, chmodSync, unlinkSync } from "fs";
import { join } from "path";
import { getLogger } from "./logger";
import Properties from "../core/Properties";
import https from "https";
import { shell } from "electron";
import { FFMPEG_URLS, MACOS_FFPROBE_URLS } from "../constants";

class StreamingServer {
    private static logger = getLogger("StreamingServer");

    // Use config directory instead of executable directory for cross-platform compatibility (especially AppImage)
    private static streamingServerDir = join(Properties.enhancedPath, "streamingserver");
    private static serverScriptPath = join(this.streamingServerDir, "server.js");
    private static logFilePath = join(Properties.enhancedPath, "stremio-server.log");

    private static getFFmpegUrl(): string {
        const platform =
            process.platform === "win32" || process.platform === "darwin"
                ? process.platform
                : "linux";

        if (process.arch !== "x64" && process.arch !== "arm64") throw new Error(`Unsupported architecture: ${process.arch}`);

        return FFMPEG_URLS[platform][process.arch];
    }

    private static getMacOSFFprobeUrl(): string {
        if (process.arch !== "x64" && process.arch !== "arm64") throw new Error(`Unsupported architecture: ${process.arch}`);
        return MACOS_FFPROBE_URLS[process.arch];
    }

    // Get the directory where server.js should be placed
    public static getStreamingServerDir(): string {
        return this.streamingServerDir;
    }

    // Check if server.js exists
    public static serverJsExists(): boolean {
        return existsSync(this.serverScriptPath);
    }

    // Open the streaming server directory in the file manager
    public static openStreamingServerDir(): void {
        if (!existsSync(this.streamingServerDir)) {
            mkdirSync(this.streamingServerDir, { recursive: true });
        }
        shell.openPath(this.streamingServerDir);
    }

    // Check if system ffmpeg/ffprobe are available and working
    private static getSystemBinaryPath(binary: string): string | null {
        try {
            const result = execSync(`which ${binary}`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
            const path = result.trim();
            if (path && existsSync(path)) {
                this.logger.info(`Found system ${binary} at: ${path}`);
                return path;
            }
        } catch {
            // which command failed, binary not found
        }
        return null;
    }

    // Get the best available ffmpeg path (prefer system, fallback to downloaded)
    private static getFFmpegPath(): string {
        // First, try system ffmpeg
        const systemFFmpeg = this.getSystemBinaryPath("ffmpeg");
        if (systemFFmpeg) {
            return systemFFmpeg;
        }

        // Fall back to downloaded version
        const downloadedPath = process.platform == "win32"
            ? join(this.streamingServerDir, "ffmpeg.exe")
            : join(this.streamingServerDir, "ffmpeg");
        return downloadedPath;
    }

    // Get the best available ffprobe path (prefer system, fallback to downloaded)
    private static getFFprobePath(): string {
        // First, try system ffprobe
        const systemFFprobe = this.getSystemBinaryPath("ffprobe");
        if (systemFFprobe) {
            return systemFFprobe;
        }

        // Fall back to downloaded version
        const downloadedPath = process.platform == "win32"
            ? join(this.streamingServerDir, "ffprobe.exe")
            : join(this.streamingServerDir, "ffprobe");
        return downloadedPath;
    }

    private static async downloadFile(url: string, dest: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const MAX_REDIRECTS = 5;
            let redirectCount = 0;

            const makeRequest = (downloadUrl: string) => {
                if (redirectCount >= MAX_REDIRECTS) {
                    reject(new Error(`Too many redirects downloading ${url}`));
                    return;
                }
                redirectCount++;

                const file = createWriteStream(dest);
                let downloadedSize = 0;
                let expectedSize = 0;

                https.get(downloadUrl, {
                    headers: {
                        "User-Agent": "Stremio-Enhanced",
                        "Accept": "application/octet-stream,application/zip,application/x-gzip,*/*"
                    }
                }, (res) => {
                    // Handle redirects
                    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        file.close();
                        const redirectUrl = new URL(res.headers.location, downloadUrl).toString();
                        this.logger.info(`Following redirect to: ${redirectUrl}`);
                        makeRequest(redirectUrl);
                        return;
                    }

                    if (res.statusCode !== 200) {
                        file.close();
                        try { unlinkSync(dest); } catch {}
                        reject(new Error(`Failed to download ${url}: HTTP ${res.statusCode}`));
                        return;
                    }

                    // Validate content type - reject HTML error pages
                    const contentType = res.headers["content-type"] || "";
                    if (contentType.includes("text/html")) {
                        file.close();
                        try { unlinkSync(dest); } catch {}
                        reject(new Error(`Download returned HTML page instead of binary file. The download URL may be invalid or the file may no longer be available.`));
                        return;
                    }

                    // Track expected size
                    if (res.headers["content-length"]) {
                        expectedSize = parseInt(res.headers["content-length"], 10);
                        this.logger.info(`Expected download size: ${expectedSize} bytes (${(expectedSize / 1024 / 1024).toFixed(1)} MB)`);
                    }

                    res.on("data", (chunk) => {
                        downloadedSize += chunk.length;
                    });

                    res.pipe(file);

                    file.on("finish", () => {
                        file.close(() => {
                            // Validate downloaded size matches expected
                            if (expectedSize > 0 && downloadedSize !== expectedSize) {
                                try { unlinkSync(dest); } catch {}
                                reject(new Error(`Download incomplete: expected ${expectedSize} bytes but got ${downloadedSize} bytes`));
                                return;
                            }

                            // Validate minimum size (ffmpeg should be at least 10MB)
                            const MIN_SIZE = 10 * 1024 * 1024; // 10MB
                            if (downloadedSize < MIN_SIZE) {
                                try { unlinkSync(dest); } catch {}
                                reject(new Error(`Downloaded file is too small (${downloadedSize} bytes). Expected at least ${MIN_SIZE} bytes. The file may be corrupted or an error page.`));
                                return;
                            }

                            this.logger.info(`Download complete: ${downloadedSize} bytes (${(downloadedSize / 1024 / 1024).toFixed(1)} MB)`);
                            resolve();
                        });
                    });

                    res.on("error", (err) => {
                        file.close();
                        try { unlinkSync(dest); } catch {}
                        reject(err);
                    });
                }).on("error", (err) => {
                    file.close();
                    try { unlinkSync(dest); } catch {}
                    reject(err);
                });
            };

            makeRequest(url);
        });
    }

    private static async downloadAndExtractFFmpeg(): Promise<boolean> {
        const archiveUrl = this.getFFmpegUrl();
        const archivePath = join(this.streamingServerDir, (process.platform == "win32" || process.platform == "darwin") ? "ffmpeg-release.zip" : "ffmpeg-release.tar.xz");
        
        const ffmpegPath = process.platform == "win32"
            ? join(this.streamingServerDir, "ffmpeg.exe")
            : join(this.streamingServerDir, "ffmpeg");
        const ffprobePath = process.platform == "win32"
            ? join(this.streamingServerDir, "ffprobe.exe")
            : join(this.streamingServerDir, "ffprobe");

        try {
            this.logger.info(`Downloading FFmpeg from ${archiveUrl}...`);
            await this.downloadFile(archiveUrl, archivePath);
            this.logger.info("FFmpeg archive downloaded. Extracting...");

            if (process.platform === "linux") {
                // Extract tar.xz archive
                // First, list contents to find the directory name
                const listOutput = execSync(`tar -tf "${archivePath}" | head -1`, { encoding: "utf8" });
                const extractDir = listOutput.trim().split("/")[0];

                // Extract the archive
                execSync(`tar -xf "${archivePath}" -C "${this.streamingServerDir}"`, { encoding: "utf8" });

                // Move ffmpeg and ffprobe to the streamingserver directory
                const extractedDir = join(this.streamingServerDir, extractDir);
                execSync(`mv "${join(extractedDir, "ffmpeg")}" "${ffmpegPath}"`, { encoding: "utf8" });
                execSync(`mv "${join(extractedDir, "ffprobe")}" "${ffprobePath}"`, { encoding: "utf8" });

                // Set executable permissions
                chmodSync(ffmpegPath, 0o755);
                chmodSync(ffprobePath, 0o755);

                // Cleanup: remove extracted directory and archive
                execSync(`rm -rf "${extractedDir}"`, { encoding: "utf8" });
                unlinkSync(archivePath);

                this.logger.info("FFmpeg and FFprobe extracted successfully.");
                return true;
            } else if (process.platform === "darwin") {
                // Handle macOS zip file
                execSync(`unzip -o "${archivePath}" -d "${this.streamingServerDir}"`, { encoding: "utf8" });
                chmodSync(ffmpegPath, 0o755);
                unlinkSync(archivePath);

                this.logger.info(`FFmpeg extracted successfully. Downloading FFprobe from ${this.getMacOSFFprobeUrl()}...`);

                const ffprobeArchivePath = join(this.streamingServerDir, "ffprobe-release.zip");
                await this.downloadFile(this.getMacOSFFprobeUrl(), ffprobeArchivePath);
                this.logger.info("FFprobe archive downloaded. Extracting...");
                
                // Extract ffprobe
                execSync(`unzip -o "${ffprobeArchivePath}" -d "${this.streamingServerDir}"`, { encoding: "utf8" });
                chmodSync(ffprobePath, 0o755);
                unlinkSync(ffprobeArchivePath);
                return true;
            } else if (process.platform === "win32") {
                // Handle Windows zip file
                // Extract the whole archive first
                execSync(`powershell -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${this.streamingServerDir}' -Force"`, { encoding: "utf8" });
                
                // Find the extracted directory dynamically (gyan.dev uses versioned folder names like "ffmpeg-7.1-essentials_build")
                // Sort by creation time to get the most recently extracted directory first
                const extractedItems = execSync(
                    `powershell -Command "Get-ChildItem -Path '${this.streamingServerDir}' -Directory | Sort-Object CreationTime -Descending | Select-Object -ExpandProperty Name"`,
                    { encoding: "utf8" }
                ).trim().split("\n").map(s => s.trim()).filter(s => s);
                
                // Find the ffmpeg build directory (should contain a 'bin' folder)
                const ffmpegDir = extractedItems.find(dir => {
                    const binPath = join(this.streamingServerDir, dir, "bin");
                    return existsSync(binPath);
                });
                
                if (!ffmpegDir) {
                    throw new Error("Could not find ffmpeg build directory in extracted archive. Expected a folder containing a 'bin' subdirectory.");
                }
                
                this.logger.info(`Found ffmpeg build directory: ${ffmpegDir}`);
                
                // Move bin folder contents to the streamingserver directory
                const binPath = join(this.streamingServerDir, ffmpegDir, "bin");
                execSync(`powershell -Command "Move-Item -Path '${binPath}\\*' -Destination '${this.streamingServerDir}' -Force"`, { encoding: "utf8" });
                
                // Cleanup: remove extracted directory
                execSync(`powershell -Command "Remove-Item -Recurse -Force '${join(this.streamingServerDir, ffmpegDir)}'"`, { encoding: "utf8" });

                unlinkSync(archivePath);
                return true;
            }

            return false;
        } catch (error) {
            this.logger.error(`Failed to download/extract FFmpeg: ${error}`);
            // Cleanup on failure
            if (existsSync(archivePath)) {
                try { unlinkSync(archivePath); } catch {}
            }
            return false;
        }
    }

    public static async ensureStreamingServerFiles(): Promise<"ready" | "missing_server_js" | "missing_ffmpeg"> {
        try {
            // Create directory if it doesn't exist
            if (!existsSync(this.streamingServerDir)) {
                this.logger.info(`Creating streaming server directory: ${this.streamingServerDir}`);
                mkdirSync(this.streamingServerDir, { recursive: true });
            }

            // Check if server.js exists (user must download manually)
            if (!existsSync(this.serverScriptPath)) {
                this.logger.warn("server.js not found. User needs to download it manually.");
                return "missing_server_js";
            }

            // Check if we need to download ffmpeg/ffprobe
            // Only download if system versions are not available
            const systemFFmpeg = this.getSystemBinaryPath("ffmpeg");
            const systemFFprobe = this.getSystemBinaryPath("ffprobe");

            if (systemFFmpeg && systemFFprobe) {
                this.logger.info("Using system ffmpeg and ffprobe.");
            } else {
                // Need to download ffmpeg binaries
                const downloadedFFmpeg = process.platform == "win32"
                    ? join(this.streamingServerDir, "ffmpeg.exe")
                    : join(this.streamingServerDir, "ffmpeg");
                const downloadedFFprobe = process.platform == "win32"
                    ? join(this.streamingServerDir, "ffprobe.exe")
                    : join(this.streamingServerDir, "ffprobe");

                if (!existsSync(downloadedFFmpeg) || !existsSync(downloadedFFprobe)) {
                    this.logger.info("System ffmpeg/ffprobe not found. Downloading...");
                    const success = await this.downloadAndExtractFFmpeg();
                    if (!success) {
                        this.logger.error("Failed to download FFmpeg binaries and system ffmpeg not available.");
                        return "missing_ffmpeg";
                    }
                }
            }

            this.logger.info("All streaming server files are ready.");
            return "ready";

        } catch (error) {
            this.logger.error(`Failed to ensure streaming server files: ${error}`);
            return "missing_ffmpeg";
        }
    }

    public static async streamingServerDirExists() {
        // Check if server.js exists and we have ffmpeg/ffprobe available (either system or downloaded)
        if (!existsSync(this.streamingServerDir) || !existsSync(this.serverScriptPath)) {
            return false;
        }

        const ffmpegPath = this.getFFmpegPath();
        const ffprobePath = this.getFFprobePath();

        if (!existsSync(ffmpegPath) || !existsSync(ffprobePath)) {
            return false;
        }

        return true;
    }

    public static start() {
        if (!existsSync(this.streamingServerDir)) {
            this.logger.warn(`Streaming server directory not found, creating: ${this.streamingServerDir}.`);
            mkdirSync(this.streamingServerDir);
        }

        if (!existsSync(this.serverScriptPath)) {
            this.logger.error("Server script not found: " + this.serverScriptPath);
            process.exit(1);
        }

        const ffmpegPath = this.getFFmpegPath();
        const ffprobePath = this.getFFprobePath();

        if (!existsSync(ffmpegPath)) {
            this.logger.error(`FFmpeg not found: ${ffmpegPath}`);
        }

        if (!existsSync(ffprobePath)) {
            this.logger.error(`FFprobe not found: ${ffprobePath}`);
        }

        this.logger.info(`Using FFmpeg: ${ffmpegPath}`);
        this.logger.info(`Using FFprobe: ${ffprobePath}`);

        const logStream = createWriteStream(this.logFilePath, { flags: "a" });

        setTimeout(() => {
            const child = fork(this.serverScriptPath, [], {
                stdio: ["ignore", "pipe", "pipe", "ipc"],
                env: {
                    ...process.env,
                    FFMPEG_BIN: ffmpegPath,
                    FFPROBE_BIN: ffprobePath,
                },
            });

            if (child.stdout) child.stdout.pipe(logStream);
            if (child.stderr) child.stderr.pipe(logStream);

            this.logger.info("Streaming server started with PID: " + child.pid);

            process.on("exit", () => {
                this.logger.info("Shutting down streaming server...");
                logStream.end();
                if (child && !child.killed) child.kill("SIGINT");
            });
        }, 0);
    }
}

export default StreamingServer;
