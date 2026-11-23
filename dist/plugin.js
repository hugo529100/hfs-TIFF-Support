'use strict';

exports.description = "TIFF/TIF cached server-side support for HFS - converts TIFF to JPG on the fly for preview with Show and generates thumbnails"
exports.version = 1.3
exports.apiRequired = 12.6
exports.repo = "hugo529100/hfs-TIFF-Support"

exports.preview = []


exports.config = {
    jpegQuality: {
        title: 'JPEG Quality',
        type: 'number',
        defaultValue: 50,
        min: 10,
        max: 100,
        step: 5,
        helperText: 'Quality of the converted JPEG images (10-100). Requires plugin restart to apply changes.',
        frontend: true
    },
    cacheAround: {
        title: 'Preconvert Files (Around)',
        type: 'number',
        defaultValue: 16,
        min: 0,
        max: 100,
        helperText: 'Number of TIFF files to preconvert before and after the current one (0 to disable)',
        frontend: true
    },
    cacheTTL: {
        title: 'Cache Time To Live (hours)',
        type: 'number',
        defaultValue: 24,
        min: 1,
        max: 720,
        helperText: 'Time in hours after which cache files will be automatically deleted (cleaning interval: one hour)',
        frontend: true
    },
    backgroundWorkersCount: {
        title: 'Background Workers Count',
        type: 'number',
        defaultValue: 1,
        min: 1,
        max: 8,
        helperText: 'Number of background workers for parallel preconversion (1-8). For maximum background preconversion speed, the number of workers should match the number of logical CPUs. Workers only read files; TIFF decoding is done by the Sharp plugin on the main thread.',
        frontend: true
    },
    generateThumbnails: {
        title: 'Generate Thumbnails',
        type: 'boolean',
        defaultValue: true,
        helperText: 'Generate 800px thumbnails via Sharp. When disabled, the embedded EXIF thumbnail is used instead.',
        frontend: true
    },
    thumbnailMaxSize: {
        title: 'Thumbnail Max File Size',
        type: 'number',
        defaultValue: 300,
        min: 0,
        max: 2048,
        unit: 'MB',
        helperText: 'Only applies to thumbnails and preconversion: TIFF files larger than this skip Sharp thumbnail generation (thumbnails fall back to the embedded EXIF thumbnail) and are not preconverted. Show preview (?convert=tiff) is NOT affected and always performs a full conversion. 0 disables the limit.',
        frontend: true
    }
};

let path, fs, util, crypto, Worker;
let cache = new Map();
let workerPool = [];
let inProgress = new Set();
let pendingBackgroundTasks = new Set();
let cleanupInterval;
let isUnloading = false;
let cacheDir;
let thumbCacheDir;

let jpegQuality = 1.0;
let cacheAround = 16;
let cacheTTL = 24 * 60 * 60 * 1000;
let backgroundWorkersCount = 1;
let generateThumbnails = false;
let thumbnailMaxSize = 100; // MB，0 = 不限制

let isInitializing = true;

const JPEG_START = Buffer.from([0xFF, 0xD8, 0xFF]);
const JPEG_END = Buffer.from([0xFF, 0xD9]);
const EXIF_HEAD_BYTES = 96 * 1024;

exports.init = function(api) {
    path = api.require('path');
    fs = api.require('fs');
    util = api.require('util');
    crypto = api.require('crypto');
    Worker = api.require('worker_threads').Worker;

    const pluginDir = __dirname;
    cacheDir = path.join(pluginDir, 'cache');
    thumbCacheDir = path.join(pluginDir, 'thumb-cache');
    const workerPath = path.join(pluginDir, 'worker.js');

    if (!fs.existsSync(thumbCacheDir)) {
        fs.mkdirSync(thumbCacheDir, { recursive: true });
    }

    const initialConfig = api.getConfig();
    updateConfig(initialConfig);

    api.subscribeConfig(['cacheAround', 'cacheTTL', 'backgroundWorkersCount', 'generateThumbnails', 'thumbnailMaxSize'], (newValues) => {
        if (isInitializing) {
            isInitializing = false;
            return;
        }

        const updatedConfig = { ...initialConfig, ...newValues };
        updateConfig(updatedConfig);

        if (newValues.backgroundWorkersCount !== undefined) {
            restartWorkers().catch(error => {
                api.log('Error restarting workers:', error);
            });
        }
    });

    function updateConfig(config) {
        cacheAround = typeof config.cacheAround !== 'undefined' ? config.cacheAround : 16;
        cacheTTL = (typeof config.cacheTTL !== 'undefined' ? config.cacheTTL : 24) * 60 * 60 * 1000;
        backgroundWorkersCount = typeof config.backgroundWorkersCount !== 'undefined' ?
            Math.max(1, Math.min(8, config.backgroundWorkersCount)) : 1;
        generateThumbnails = typeof config.generateThumbnails !== 'undefined' ? config.generateThumbnails : false;
        thumbnailMaxSize = typeof config.thumbnailMaxSize !== 'undefined' ?
            Math.max(0, config.thumbnailMaxSize) : 100;
    }

    /**
     * 缓存键：只对路径字符串做 hash，不读取文件内容。
     * 避免对超大 TIFF 每次检查都读整个文件算 md5。
     */
    function getPathHash(realPath) {
        return crypto.createHash('md5').update(realPath).digest('hex');
    }

    /**
     * 生成可读的缓存文件名：<原文件名不含扩展名>_<路径hash8>.jpg
     * 既能对应回图片名，又不会因不同目录同名文件冲突。
     */
    function getCacheBaseName(realPath) {
        const base = path.basename(realPath, path.extname(realPath))
            .replace(/[^\w.-]+/g, '_')
            .slice(0, 80);
        const hash8 = getPathHash(realPath).slice(0, 8);
        return `${base}_${hash8}`;
    }

    function getThumbCachePath(realPath) {
        return path.join(thumbCacheDir, `${getCacheBaseName(realPath)}_thumb.jpg`);
    }

    function getExifCachePath(realPath) {
        return path.join(thumbCacheDir, `${getCacheBaseName(realPath)}_exif.jpg`);
    }

    function getConvertCachePath(realPath) {
        return path.join(cacheDir, `${getCacheBaseName(realPath)}.jpg`);
    }

    /**
     * 超过 thumbnailMaxSize 的 TIFF 视为「超大文件」。
     * 0 表示不限制。
     * 注意：此限制只作用于缩略图（?get=thumbtiff）与预转换（preconvertNeighbors），
     * 不作用于 Show 预览的完整转换（?convert=tiff）。
     */
    async function isOversized(realPath) {
        if (!thumbnailMaxSize || thumbnailMaxSize <= 0) return false;
        try {
            const st = await fs.promises.stat(realPath);
            return st.size > thumbnailMaxSize * 1024 * 1024;
        } catch {
            return false;
        }
    }

    async function convertTiffBuffer(tiffBuffer, quality) {
        const sharpResults = api.customApiCall('sharp', tiffBuffer);
        if (!sharpResults || sharpResults.length === 0) {
            throw new Error('sharp plugin not available');
        }
        const sharp = sharpResults[0];
        return await sharp
            .jpeg({ quality: Math.round(quality * 100) })
            .toBuffer();
    }

    async function generateThumbnail(jpgBuffer, filePath) {
        if (!generateThumbnails) {
            return null;
        }

        try {
            const sharpResults = api.customApiCall('sharp', jpgBuffer);
            if (!sharpResults || sharpResults.length === 0) {
                return null;
            }

            const sharp = sharpResults[0];
            const thumbBuffer = await sharp
                .resize(800, 800, {
                    fit: 'inside',
                    withoutEnlargement: true
                })
                .jpeg({ quality: 80 })
                .toBuffer();

            const thumbPath = getThumbCachePath(filePath);
            await fs.promises.writeFile(thumbPath, thumbBuffer);

            return thumbBuffer;
        } catch (error) {
            api.log('Error generating thumbnail:', error);
            return null;
        }
    }

    async function checkThumbCache(realPath) {
        try {
            const thumbPath = getThumbCachePath(realPath);
            if (!fs.existsSync(thumbPath)) {
                return null;
            }

            const thumbStats = await fs.promises.stat(thumbPath);
            const fileStats = await fs.promises.stat(realPath);

            if (fileStats.mtimeMs > thumbStats.mtimeMs) {
                fs.unlinkSync(thumbPath);
                return null;
            }

            return await fs.promises.readFile(thumbPath);
        } catch (error) {
            api.log(`Error checking thumbnail cache for ${realPath}:`, error);
            return null;
        }
    }

    function readExifThumb(buffer) {
        if (!buffer || buffer.length < 4) return null;
        const start = buffer.indexOf(JPEG_START, 2);
        if (start < 0) return null;
        const end = buffer.indexOf(JPEG_END, start);
        if (end < 0) return null;
        return buffer.subarray(start, end + 2);
    }

    async function extractExifThumbFromFile(realPath) {
        let handle;
        try {
            handle = await fs.promises.open(realPath, 'r');
            const buf = Buffer.alloc(EXIF_HEAD_BYTES);
            const { bytesRead } = await handle.read(buf, 0, EXIF_HEAD_BYTES, 0);
            if (bytesRead <= 0) return null;
            return readExifThumb(buf.subarray(0, bytesRead));
        } catch (e) {
            api.log('EXIF thumbnail read failed:', e);
            return null;
        } finally {
            if (handle) await handle.close().catch(() => {});
        }
    }

    async function cacheExifThumbnail(realPath, exifThumb) {
        try {
            const thumbPath = getExifCachePath(realPath);
            await fs.promises.writeFile(thumbPath, exifThumb);
        } catch (e) {
            api.log('Failed to cache EXIF thumbnail:', e);
        }
    }

    async function checkExifThumbCache(realPath) {
        try {
            const thumbPath = getExifCachePath(realPath);
            if (!fs.existsSync(thumbPath)) {
                return null;
            }

            const thumbStats = await fs.promises.stat(thumbPath);
            const fileStats = await fs.promises.stat(realPath);

            if (fileStats.mtimeMs > thumbStats.mtimeMs) {
                fs.unlinkSync(thumbPath);
                return null;
            }

            return await fs.promises.readFile(thumbPath);
        } catch (error) {
            api.log(`Error checking EXIF thumbnail cache for ${realPath}:`, error);
            return null;
        }
    }

    async function restartWorkers() {
        if (isUnloading) return;

        await stopWorkers();

        immediateQueue.length = 0;
        backgroundQueue.length = 0;
        inProgress.clear();
        pendingBackgroundTasks.clear();

        workerPool = [];
        workerPool.push(createWorker(1, 'immediate'));

        for (let i = 2; i <= backgroundWorkersCount + 1; i++) {
            workerPool.push(createWorker(i, 'background'));
        }
    }

    async function stopWorkers() {
        if (workerPool.length === 0) return;

        const terminationPromises = workerPool.map(worker => {
            return new Promise(resolve => {
                if (worker && !worker.isTerminating) {
                    worker.isTerminating = true;

                    try {
                        worker.postMessage({ type: 'shutdown' });
                    } catch (error) {
                        api.log(`Error sending shutdown to worker ${worker.id}:`, error);
                    }

                    worker.removeAllListeners('message');
                    worker.removeAllListeners('error');

                    worker.once('exit', () => resolve());

                    setTimeout(() => {
                        if (worker.exitCode === null) {
                            worker.terminate();
                        }
                    }, 1000);
                } else {
                    resolve();
                }
            });
        });

        await Promise.race([
            Promise.all(terminationPromises),
            new Promise(resolve => setTimeout(resolve, 3000))
        ]);

        workerPool = [];
    }

    if (fs.existsSync(cacheDir)) {
        try {
            for (const file of fs.readdirSync(cacheDir)) {
                fs.unlinkSync(path.join(cacheDir, file));
            }
        } catch (error) {
            api.log('Error clearing cache on startup:', error);
        }
    } else {
        fs.mkdirSync(cacheDir, { recursive: true });
    }

    if (fs.existsSync(thumbCacheDir)) {
        try {
            for (const file of fs.readdirSync(thumbCacheDir)) {
                fs.unlinkSync(path.join(thumbCacheDir, file));
            }
        } catch (error) {
            api.log('Error clearing thumbnail cache on startup:', error);
        }
    }

    const cleanupOldCache = async () => {
        if (isUnloading) return;

        try {
            const now = Date.now();
            for (const dir of [cacheDir, thumbCacheDir]) {
                if (!fs.existsSync(dir)) continue;
                for (const file of fs.readdirSync(dir)) {
                    const filePath = path.join(dir, file);
                    try {
                        const stats = fs.statSync(filePath);
                        if (now - stats.mtimeMs > cacheTTL) {
                            fs.unlinkSync(filePath);
                            for (const [key, value] of cache.entries()) {
                                if (value.path === filePath) {
                                    cache.delete(key);
                                    break;
                                }
                            }
                        }
                    } catch (error) {
                        api.log(`Error processing cache file ${file}:`, error);
                    }
                }
            }

            await restartWorkers();
        } catch (error) {
            api.log('Error in cache cleanup:', error);
        }
    };

    cleanupInterval = setInterval(() => {
        cleanupOldCache().catch(error => {
            api.log('Error during scheduled cleanup:', error);
        });
    }, 60 * 60 * 1000);

    let lastRequestedFile = null;

    const createWorker = (id, role) => {
        const worker = new Worker(workerPath);
        worker.setMaxListeners(20);
        worker.isBusy = false;
        worker.id = id;
        worker.role = role;
        worker.isTerminating = false;

        worker.on('message', async (message) => {
            if (worker.isTerminating) return;

            worker.isBusy = false;
            if (message.filePath) {
                inProgress.delete(message.filePath);
            }

            if (message.success) {
                try {
                    const jpgBuffer = await convertTiffBuffer(message.buffer, jpegQuality);
                    await cacheConversion(message.filePath, jpgBuffer);

                    if (generateThumbnails) {
                        try {
                            await generateThumbnail(jpgBuffer, message.filePath);
                        } catch (thumbError) {
                            api.log('Thumbnail generation failed:', thumbError);
                        }
                    }

                    if (worker.role === 'immediate' && lastRequestedFile === message.filePath) {
                        const parentPath = path.dirname(message.filePath);
                        preconvertNeighbors(message.filePath, parentPath);
                    }
                } catch (convError) {
                    api.log(`Conversion error for ${message.filePath}:`, convError);
                }
            } else if (message.error) {
                api.log(`Worker ${worker.id} (${worker.role}) read error for ${message.filePath}:`, message.error);
            }

            processNextTask(worker);
        });

        worker.on('error', (error) => {
            if (worker.isTerminating) return;

            api.log(`Worker ${worker.id} (${worker.role}) error:`, error);
            worker.isBusy = false;
            if (worker.currentTask) {
                inProgress.delete(worker.currentTask.filePath);
                worker.currentTask = null;
            }
            processNextTask(worker);
        });

        worker.on('exit', (code) => {
            if (code !== 0 && !isUnloading && !worker.isTerminating) {
                const index = workerPool.findIndex(w => w.id === worker.id);
                if (index !== -1) {
                    workerPool[index] = createWorker(worker.id, worker.role);
                }
            }
        });

        return worker;
    };

    workerPool.push(createWorker(1, 'immediate'));
    for (let i = 2; i <= backgroundWorkersCount + 1; i++) {
        workerPool.push(createWorker(i, 'background'));
    }

    jpegQuality = (initialConfig.jpegQuality || 50) / 100;

    const immediateQueue = [];
    const backgroundQueue = [];

    const processNextTask = (worker) => {
        if (worker.isBusy || worker.isTerminating) return;

        let queue = worker.role === 'immediate' ? immediateQueue : backgroundQueue;
        if (queue.length === 0) return;

        const task = queue.shift();

        if (worker.role === 'background') {
            pendingBackgroundTasks.delete(task.filePath);
        }

        if (inProgress.has(task.filePath)) {
            processNextTask(worker);
            return;
        }

        worker.isBusy = true;
        worker.currentTask = task;
        inProgress.add(task.filePath);

        if (!worker.isTerminating) {
            worker.postMessage({
                type: 'read',
                filePath: task.filePath
            });
        }
    };

    /**
     * 入队前做超大文件检查。
     * force=true 时跳过 thumbnailMaxSize 检查（仅供 ?convert=tiff 完整转换使用）。
     * 预转换与缩图任务使用默认 force=false，仍受 thumbnailMaxSize 限制。
     */
    const addConversionTask = async (filePath, priority = false, force = false) => {
        if (isUnloading) return;

        if (inProgress.has(filePath)) {
            return;
        }

        if (!force && await isOversized(filePath)) {
            // 超大文件不进入预转换/缩图队列
            return;
        }

        if (priority) {
            lastRequestedFile = filePath;
            immediateQueue.length = 0;
            immediateQueue.push({ filePath, quality: jpegQuality });
            const immediateWorker = workerPool.find(w => w.role === 'immediate' && !w.isBusy && !w.isTerminating);
            if (immediateWorker) processNextTask(immediateWorker);
        } else {
            if (pendingBackgroundTasks.has(filePath)) {
                return;
            }
            backgroundQueue.push({ filePath, quality: jpegQuality });
            pendingBackgroundTasks.add(filePath);

            const backgroundWorkers = workerPool.filter(w =>
                w.role === 'background' && !w.isBusy && !w.isTerminating
            );
            backgroundWorkers.forEach(worker => processNextTask(worker));
        }
    };

    async function cacheConversion(realPath, outputBuffer) {
        try {
            if (!fs.existsSync(cacheDir)) {
                fs.mkdirSync(cacheDir, { recursive: true });
            }

            const cachePath = getConvertCachePath(realPath);
            await fs.promises.writeFile(cachePath, outputBuffer);
            cache.set(realPath, {
                path: cachePath,
                timestamp: Date.now()
            });
        } catch (error) {
            api.log('Error caching conversion:', error);
        }
    }

    async function checkCache(realPath) {
        try {
            if (!cache.has(realPath)) {
                return null;
            }

            const cacheInfo = cache.get(realPath);
            const cacheStats = await fs.promises.stat(cacheInfo.path);
            const fileStats = await fs.promises.stat(realPath);

            if (fileStats.mtimeMs > cacheStats.mtimeMs) {
                fs.unlinkSync(cacheInfo.path);
                cache.delete(realPath);
                return null;
            }

            return await fs.promises.readFile(cacheInfo.path);
        } catch (error) {
            api.log(`Error checking cache for ${realPath}:`, error);
            return null;
        }
    }

    async function preconvertNeighbors(realPath, parentPath) {
        if (cacheAround === 0) {
            return;
        }

        backgroundQueue.length = 0;
        pendingBackgroundTasks.clear();

        try {
            const files = await fs.promises.readdir(parentPath);
            const tiffFiles = files.filter(f =>
                f.toLowerCase().endsWith('.tif') || f.toLowerCase().endsWith('.tiff')
            ).sort();

            const currentIndex = tiffFiles.findIndex(f =>
                path.join(parentPath, f) === realPath
            );

            if (currentIndex === -1) return;

            const start = Math.max(0, currentIndex - cacheAround);
            const end = Math.min(tiffFiles.length - 1, currentIndex + cacheAround);

            const filesToConvert = [];

            for (let i = currentIndex + 1; i <= end; i++) {
                filesToConvert.push(path.join(parentPath, tiffFiles[i]));
            }
            for (let i = currentIndex - 1; i >= start; i--) {
                filesToConvert.push(path.join(parentPath, tiffFiles[i]));
            }

            if (filesToConvert.length > 0) {
                setTimeout(() => {
                    if (isUnloading) return;

                    filesToConvert.forEach(filePath => {
                        checkCache(filePath).then(cached => {
                            if (!cached && !isUnloading) {
                                addConversionTask(filePath, false);
                            }
                        });
                    });
                }, 500);
            }
        } catch (error) {
            api.log('Error in preconvertNeighbors:', error);
        }
    }

    setTimeout(() => {
        isInitializing = false;
    }, 100);

    return {
        middleware: ctx => async () => {
            const url = ctx.path.toLowerCase();

            // ===== Show 预览：完整转换，不受 thumbnailMaxSize 干预 =====
            if ((url.endsWith('.tif') || url.endsWith('.tiff')) && ctx.query.convert === 'tiff') {
                try {
                    if (!ctx.state.vfsNode) {
                        ctx.status = 404;
                        return ctx.stop();
                    }

                    const realPath = ctx.state.vfsNode.source;
                    if (!realPath) {
                        ctx.status = 404;
                        return ctx.stop();
                    }

                    const cachedData = await checkCache(realPath);
                    if (cachedData) {
                        ctx.type = 'image/jpeg';
                        ctx.set('Cache-Control', 'public, max-age=3600');
                        ctx.body = cachedData;

                        preconvertNeighbors(realPath, path.dirname(realPath));
                        return ctx.stop();
                    }

                    // 强制完整转换：force=true 绕过 thumbnailMaxSize
                    addConversionTask(realPath, true, true);

                    const waitForConversion = async (filePath, maxWait = 30000) => {
                        const startTime = Date.now();
                        while (Date.now() - startTime < maxWait) {
                            const cached = await checkCache(filePath);
                            if (cached) {
                                return cached;
                            }
                            await new Promise(resolve => setTimeout(resolve, 500));
                        }
                        return null;
                    };

                    const result = await waitForConversion(realPath);
                    if (result) {
                        ctx.type = 'image/jpeg';
                        ctx.set('Cache-Control', 'public, max-age=3600');
                        ctx.body = result;

                        preconvertNeighbors(realPath, path.dirname(realPath));
                    } else {
                        ctx.status = 202;
                        ctx.body = 'Conversion in progress, please wait and refresh';
                    }
                    return ctx.stop();
                } catch (error) {
                    api.log('Error processing conversion request:', error);
                    ctx.status = 500;
                    return ctx.stop();
                }
            }

            // ===== 缩略图：受 thumbnailMaxSize 限制，超限必走 EXIF 内嵌缩图 =====
            if ((url.endsWith('.tif') || url.endsWith('.tiff')) && ctx.query.get === 'thumbtiff') {
                try {
                    if (!ctx.state.vfsNode) {
                        ctx.status = 404;
                        return ctx.stop();
                    }

                    const realPath = ctx.state.vfsNode.source;
                    if (!realPath) {
                        ctx.status = 404;
                        return ctx.stop();
                    }

                    const oversized = await isOversized(realPath);

                    // 超限时清理可能残留的陈旧 Sharp 缩图，避免被误命中
                    if (oversized) {
                        const staleThumb = getThumbCachePath(realPath);
                        try {
                            if (fs.existsSync(staleThumb)) fs.unlinkSync(staleThumb);
                        } catch (e) {
                            api.log('Failed to remove stale thumbnail:', e);
                        }
                    }

                    // 1) Sharp 缩图缓存（超限文件不允许命中）
                    if (!oversized) {
                        const thumbData = await checkThumbCache(realPath);
                        if (thumbData) {
                            ctx.type = 'image/jpeg';
                            ctx.set('Cache-Control', 'public, max-age=3600');
                            ctx.body = thumbData;
                            return ctx.stop();
                        }
                    }

                    // 2) Sharp 路径：仅当启用且未超限
                    if (generateThumbnails && !oversized) {
                        const cachedData = await checkCache(realPath);
                        if (cachedData) {
                            const t = await generateThumbnail(cachedData, realPath);
                            if (t) {
                                ctx.type = 'image/jpeg';
                                ctx.set('Cache-Control', 'public, max-age=3600');
                                ctx.body = t;
                                return ctx.stop();
                            }
                        }

                        addConversionTask(realPath, true);

                        const waitForThumb = async (filePath, maxWait = 30000) => {
                            const startTime = Date.now();
                            while (Date.now() - startTime < maxWait) {
                                const t = await checkThumbCache(filePath);
                                if (t) return t;
                                await new Promise(resolve => setTimeout(resolve, 500));
                            }
                            return null;
                        };

                        const t = await waitForThumb(realPath);
                        if (t) {
                            ctx.type = 'image/jpeg';
                            ctx.set('Cache-Control', 'public, max-age=3600');
                            ctx.body = t;
                            return ctx.stop();
                        }
                    }

                    // 3) 超限（或 Sharp 关闭/失败）→ EXIF 内嵌缩图
                    const exifCached = await checkExifThumbCache(realPath);
                    if (exifCached) {
                        ctx.type = 'image/jpeg';
                        ctx.set('Cache-Control', 'public, max-age=3600');
                        ctx.body = exifCached;
                        return ctx.stop();
                    }

                    const exifThumb = await extractExifThumbFromFile(realPath);
                    if (exifThumb) {
                        await cacheExifThumbnail(realPath, exifThumb);
                        ctx.type = 'image/jpeg';
                        ctx.set('Cache-Control', 'public, max-age=3600');
                        ctx.body = exifThumb;
                        return ctx.stop();
                    }

                    ctx.status = 404;
                    return ctx.stop();
                } catch (error) {
                    api.log('Error processing thumbnail request:', error);
                    ctx.status = 500;
                    return ctx.stop();
                }
            }
        },

        frontend_js: 'frontend.js',

        unload: () => {
            isUnloading = true;
            isInitializing = false;

            if (cleanupInterval) {
                clearInterval(cleanupInterval);
            }

            try {
                [cacheDir, thumbCacheDir].forEach(dir => {
                    if (fs.existsSync(dir)) {
                        for (const file of fs.readdirSync(dir)) {
                            try {
                                fs.unlinkSync(path.join(dir, file));
                            } catch (error) {
                                api.log(`Error deleting cache file ${file}:`, error);
                            }
                        }
                    }
                });
            } catch (error) {
                api.log('Error clearing cache directories on unload:', error);
            }

            immediateQueue.length = 0;
            backgroundQueue.length = 0;
            inProgress.clear();
            pendingBackgroundTasks.clear();
            cache.clear();

            return stopWorkers().then(() => {});
        }
    };
};
