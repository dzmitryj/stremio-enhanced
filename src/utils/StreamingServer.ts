import { fork, execFileSync, execSync } from "child_process";
import { createWriteStream, existsSync, mkdirSync, chmodSync, unlinkSync } from "fs";
import { join } from "path";
import { getLogger } from "./logger";
import Properties from "../core/Properties";
import https from "https";
import { shell } from "electron";
import { FFMPEG_URLS, MACOS_FFPROBE_URLS, SERVER_JS_URL } from "../constants";

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

    private static isWorkingBinary(path: string): boolean {
        if (!existsSync(path)) return false;

        try {
            execFileSync(path, ["-version"], { stdio: "ignore" });
            return true;
        } catch {
            return false;
        }
    }

    private static getSystemBinaryPath(binary: "ffmpeg" | "ffprobe"): string | null {
        const command = process.platform === "win32" ? "where" : "which";

        try {
            const result = execSync(`${command} ${binary}`, { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
            for (const path of result.split(/\r?\n/).map(line => line.trim()).filter(Boolean)) {
                if (this.isWorkingBinary(path)) {
                    this.logger.info(`Using system ${binary}: ${path}`);
                    return path;
                }
            }
        } catch {
            // Binary is not on PATH.
        }

        return null;
    }

    private static getStremioInstallBinaryPath(binary: "ffmpeg" | "ffprobe"): string | null {
        if (process.platform !== "win32") return null;

        const localAppData = process.env.LOCALAPPDATA;
        if (!localAppData) return null;

        const path = join(localAppData, "Programs", "Stremio", `${binary}.exe`);
        if (this.isWorkingBinary(path)) {
            this.logger.info(`Using ${binary} from Stremio install: ${path}`);
            return path;
        }

        return null;
    }

    private static getDownloadedBinaryPath(binary: "ffmpeg" | "ffprobe"): string {
        return process.platform === "win32"
            ? join(this.streamingServerDir, `${binary}.exe`)
            : join(this.streamingServerDir, binary);
    }

    private static findWorkingBinary(binary: "ffmpeg" | "ffprobe"): string | null {
        return this.getSystemBinaryPath(binary)
            ?? this.getStremioInstallBinaryPath(binary)
            ?? (this.isWorkingBinary(this.getDownloadedBinaryPath(binary)) ? this.getDownloadedBinaryPath(binary) : null);
    }

    private static getFFmpegPath(): string {
        return this.findWorkingBinary("ffmpeg") ?? this.getDownloadedBinaryPath("ffmpeg");
    }

    private static getFFprobePath(): string {
        return this.findWorkingBinary("ffprobe") ?? this.getDownloadedBinaryPath("ffprobe");
    }

    private static async downloadFile(url: string, dest: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const file = createWriteStream(dest);

            const request = (downloadUrl: string) => {
                https.get(downloadUrl, { headers: { "User-Agent": "Stremio-Enhanced" } }, (res) => {
                    // Handle redirects (GitHub releases use redirects)
                    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        const redirectUrl = new URL(res.headers.location, downloadUrl).toString();
                        this.logger.info(`Following redirect to: ${redirectUrl}`);
                        request(redirectUrl);
                        return;
                    }

                    if (res.statusCode !== 200) {
                        file.close();
                        reject(new Error(`Failed to download ${url}: HTTP ${res.statusCode}`));
                        return;
                    }

                    res.pipe(file);
                    file.on("finish", () => {
                        file.close(() => resolve());
                    });
                    res.on("error", (err) => {
                        file.close();
                        reject(err);
                    });
                }).on("error", (err) => {
                    file.close();
                    reject(err);
                });
            };

            request(url);
        });
    }

    private static async ensureServerJS(): Promise<boolean> {
        if (existsSync(this.serverScriptPath)) return true;

        try {
            this.logger.info(`Downloading server.js from ${SERVER_JS_URL}...`);
            await this.downloadFile(SERVER_JS_URL, this.serverScriptPath);
            this.logger.info(`server.js downloaded to: ${this.serverScriptPath}`);
            return true;
        } catch (error) {
            this.logger.error(`Failed to download server.js: ${error}`);
            if (existsSync(this.serverScriptPath)) {
                try { unlinkSync(this.serverScriptPath); } catch {}
            }
            return false;
        }
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
                execSync(`powershell -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${this.streamingServerDir}' -Force"`, { encoding: "utf8" });

                const ps = `$dir = Get-ChildItem -Path '${this.streamingServerDir}' -Directory | Where-Object { $_.Name -like 'ffmpeg-*' } | Select-Object -First 1; if (-not $dir) { throw 'FFmpeg archive did not contain an ffmpeg-* directory' }; Move-Item -Path (Join-Path $dir.FullName 'bin\\*') -Destination '${this.streamingServerDir}' -Force; Remove-Item -Recurse -Force $dir.FullName`;
                execSync(`powershell -Command "${ps}"`, { encoding: "utf8" });

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

            if (!await this.ensureServerJS()) {
                return "missing_server_js";
            }

            if (!this.findWorkingBinary("ffmpeg") || !this.findWorkingBinary("ffprobe")) {
                this.logger.info("No working FFmpeg/FFprobe pair found. Downloading portable binaries...");
                const success = await this.downloadAndExtractFFmpeg();
                if (!success || !this.findWorkingBinary("ffmpeg") || !this.findWorkingBinary("ffprobe")) {
                    this.logger.error("Failed to prepare working FFmpeg/FFprobe binaries.");
                    return "missing_ffmpeg";
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
