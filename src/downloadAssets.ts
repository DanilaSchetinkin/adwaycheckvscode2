import * as crypto from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import * as path from 'path';
import { URL } from 'url';

export type DownloadImageResult = {
    html: string;
    downloaded: number;
    /** Уже были в images/ — только подменили путь в HTML */
    reused: number;
    skipped: number;
    failed: string[];
    /** Удалено дублей с тем же содержимым */
    deduped: number;
    /** Имена удалённых файлов в images/ */
    dedupedFiles: string[];
    replacements: Array<{ from: string; to: string }>;
};

const CONTENT_TYPE_EXT: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'image/svg': '.svg',
    'image/x-icon': '.ico',
    'image/vnd.microsoft.icon': '.ico',
    'image/bmp': '.bmp',
    'image/x-ms-bmp': '.bmp',
    'image/avif': '.avif',
    'image/tiff': '.tiff'
};

const KNOWN_EXT = new Set([
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.ico', '.bmp', '.avif', '.tif', '.tiff'
]);

const BROWSER_HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9'
};

function isExternalUrl(url: string): boolean {
    return /^https?:\/\//i.test(url.trim()) || url.trim().startsWith('//');
}

function normalizeUrl(url: string): string {
    const u = url.trim();
    if (u.startsWith('//')) {
        return 'https:' + u;
    }
    return u;
}

function localPath(fileName: string): string {
    return `images/${fileName}`.replace(/\\/g, '/');
}

function fileHash(buf: Buffer): string {
    return crypto.createHash('sha1').update(buf).digest('hex');
}

function uniqueFileName(dir: string, baseName: string): string {
    const safe = baseName.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/\s+/g, '_') || 'image';
    let name = safe;
    let i = 1;
    while (fs.existsSync(path.join(dir, name))) {
        const ext = path.extname(safe);
        const stem = path.basename(safe, ext);
        name = `${stem}_${i}${ext}`;
        i += 1;
    }
    return name;
}

function extFromContentType(contentType: string | undefined): string | undefined {
    if (!contentType) {
        return undefined;
    }
    const mime = contentType.split(';')[0].trim().toLowerCase();
    return CONTENT_TYPE_EXT[mime];
}

function extFromMagic(buf: Buffer): string | undefined {
    if (buf.length < 12) {
        return undefined;
    }
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
        return '.jpg';
    }
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        return '.png';
    }
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
        return '.gif';
    }
    if (
        buf[0] === 0x52 &&
        buf[1] === 0x49 &&
        buf[2] === 0x46 &&
        buf[3] === 0x46 &&
        buf[8] === 0x57 &&
        buf[9] === 0x45 &&
        buf[10] === 0x42 &&
        buf[11] === 0x50
    ) {
        return '.webp';
    }
    if (buf[0] === 0x42 && buf[1] === 0x4d) {
        return '.bmp';
    }
    if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) {
        return '.ico';
    }
    const head = buf.slice(0, Math.min(512, buf.length)).toString('utf8').trimStart().toLowerCase();
    if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
        return '.svg';
    }
    return undefined;
}

/** Ответ не картинка (часто HTML-страница антибота / 404). */
function looksLikeNonImage(buf: Buffer, contentType: string | undefined): boolean {
    const mime = (contentType || '').split(';')[0].trim().toLowerCase();
    if (mime.startsWith('text/html') || mime.startsWith('application/json') || mime.startsWith('text/plain')) {
        if (mime.startsWith('text/plain') && extFromMagic(buf) === '.svg') {
            return false;
        }
        if (mime.startsWith('text/html') || mime.startsWith('application/json')) {
            return true;
        }
    }
    const head = buf.slice(0, Math.min(200, buf.length)).toString('utf8').trimStart().toLowerCase();
    if (head.startsWith('<!doctype html') || head.startsWith('<html')) {
        return true;
    }
    return false;
}

function fileNameFromContentDisposition(header: string | undefined): string | undefined {
    if (!header) {
        return undefined;
    }
    const star = header.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
    if (star) {
        try {
            return decodeURIComponent(star[1].trim().replace(/["']/g, ''));
        } catch {
            return star[1].trim().replace(/["']/g, '');
        }
    }
    const plain = header.match(/filename\s*=\s*("?)([^";]+)\1/i);
    if (plain) {
        return plain[2].trim();
    }
    return undefined;
}

function downloadBuffer(
    url: string,
    timeoutMs = 25000,
    redirectLeft = 8
): Promise<{ buffer: Buffer; contentType?: string; contentDisposition?: string }> {
    return new Promise((resolve, reject) => {
        if (redirectLeft <= 0) {
            reject(new Error('too many redirects'));
            return;
        }
        const lib = url.startsWith('https') ? https : http;
        const req = lib.get(url, { timeout: timeoutMs, headers: BROWSER_HEADERS }, res => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                const next = new URL(res.headers.location, url).href;
                res.resume();
                downloadBuffer(next, timeoutMs, redirectLeft - 1).then(resolve, reject);
                return;
            }
            if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                res.resume();
                reject(new Error(`HTTP ${res.statusCode || 0}`));
                return;
            }
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
                resolve({
                    buffer: Buffer.concat(chunks),
                    contentType: res.headers['content-type'],
                    contentDisposition: res.headers['content-disposition']
                });
            });
            res.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('timeout'));
        });
    });
}

function urlPathBasename(url: string): string {
    try {
        return path.basename(new URL(url).pathname) || '';
    } catch {
        return path.basename(url.split('?')[0]) || '';
    }
}

/** Имя файла, которое ожидаем от URL (до скачивания). */
function expectedNamesFromUrl(url: string): string[] {
    const base = urlPathBasename(url);
    if (!base || base === '.' || base === '..') {
        return [];
    }
    const names = new Set<string>([base]);
    const ext = path.extname(base).toLowerCase();
    const stem = path.basename(base, path.extname(base));
    if (ext === '.jpeg') {
        names.add(`${stem}.jpg`);
    }
    if (ext === '.jpg') {
        names.add(`${stem}.jpeg`);
    }
    // частые дубли прошлых скачиваний: name_1.png
    if (stem && ext) {
        for (let i = 1; i <= 20; i++) {
            names.add(`${stem}_${i}${ext}`);
            if (ext === '.jpeg') {
                names.add(`${stem}_${i}.jpg`);
            }
            if (ext === '.jpg') {
                names.add(`${stem}_${i}.jpeg`);
            }
        }
    }
    return [...names];
}

function isNumberedDuplicateName(name: string): boolean {
    const ext = path.extname(name);
    const stem = path.basename(name, ext);
    return /_\d+$/i.test(stem);
}

/** Уже есть в images/ по имени из URL — не качаем. */
function findExistingByUrlName(imagesDir: string, url: string): string | undefined {
    let fallback: string | undefined;
    for (const name of expectedNamesFromUrl(url)) {
        const full = path.join(imagesDir, name);
        if (!(fs.existsSync(full) && fs.statSync(full).isFile())) {
            continue;
        }
        if (!isNumberedDuplicateName(name)) {
            return localPath(name);
        }
        if (!fallback) {
            fallback = localPath(name);
        }
    }
    return fallback;
}

function buildHashIndex(imagesDir: string): Map<string, string> {
    const map = new Map<string, string>();
    if (!fs.existsSync(imagesDir)) {
        return map;
    }
    for (const name of fs.readdirSync(imagesDir)) {
        const full = path.join(imagesDir, name);
        try {
            if (!fs.statSync(full).isFile()) {
                continue;
            }
            if (!KNOWN_EXT.has(path.extname(name).toLowerCase())) {
                continue;
            }
            const hash = fileHash(fs.readFileSync(full));
            const prev = map.get(hash);
            if (!prev) {
                map.set(hash, name);
                continue;
            }
            // предпочитаем имя без суффикса _N
            const score = (n: string) => (/_\d+\.[^.]+$/i.test(n) ? 1 : 0) + n.length / 1000;
            if (score(name) < score(prev)) {
                map.set(hash, name);
            }
        } catch {
            // ignore unreadable
        }
    }
    return map;
}

function buildLocalFileName(
    url: string,
    imagesDir: string,
    contentType: string | undefined,
    contentDisposition: string | undefined,
    buffer: Buffer
): string {
    const fromCd = fileNameFromContentDisposition(contentDisposition);
    let stem: string;
    let urlExt = '';

    if (fromCd) {
        urlExt = path.extname(fromCd).toLowerCase();
        stem = path.basename(fromCd, path.extname(fromCd)) || 'image';
    } else {
        let pathname = '';
        try {
            pathname = new URL(url).pathname;
        } catch {
            pathname = url.split('?')[0];
        }
        stem = path.basename(pathname) || 'image';
        urlExt = path.extname(stem).toLowerCase();
        if (urlExt) {
            stem = path.basename(stem, path.extname(stem));
        }
    }

    if (urlExt === '.jpeg') {
        urlExt = '.jpg';
    }
    if (!stem || stem === '.' || stem === '..') {
        stem = 'image';
    }

    const ext =
        extFromContentType(contentType) ||
        extFromMagic(buffer) ||
        (KNOWN_EXT.has(urlExt) ? urlExt : undefined);

    if (!ext) {
        throw new Error('unknown image type');
    }

    const preferred = `${stem}${ext}`;
    const preferredPath = path.join(imagesDir, preferred);
    if (!fs.existsSync(preferredPath)) {
        return preferred;
    }
    // файл с таким именем есть — если содержимое то же, переиспользуем
    try {
        if (fileHash(fs.readFileSync(preferredPath)) === fileHash(buffer)) {
            return preferred;
        }
    } catch {
        // fall through
    }
    return uniqueFileName(imagesDir, preferred);
}

/**
 * Дубли с одинаковым содержимым в папке → один файл, остальные удалить.
 * pathMap: старый относительный путь → новый (folder/name).
 */
function dedupeOneFolder(
    htmlDir: string,
    folder: string,
    allowedExt: Set<string>
): { removed: string[]; kept: number; pathMap: Map<string, string> } {
    const dir = path.join(htmlDir, folder);
    const pathMap = new Map<string, string>();
    const removed: string[] = [];
    let kept = 0;

    if (!fs.existsSync(dir)) {
        return { removed, kept, pathMap };
    }

    const byHash = new Map<string, string[]>();
    for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        try {
            if (!fs.statSync(full).isFile()) {
                continue;
            }
            if (!allowedExt.has(path.extname(name).toLowerCase())) {
                continue;
            }
            const hash = fileHash(fs.readFileSync(full));
            const list = byHash.get(hash) || [];
            list.push(name);
            byHash.set(hash, list);
        } catch {
            // ignore
        }
    }

    const score = (n: string) => {
        const dup = /_\d+\.[^.]+$/i.test(n) ? 10 : 0;
        const copy = /copy|дубл| \(/i.test(n) ? 5 : 0;
        return dup + copy + n.length;
    };

    for (const names of byHash.values()) {
        if (names.length < 2) {
            kept += 1;
            continue;
        }
        names.sort((a, b) => score(a) - score(b) || a.localeCompare(b));
        const keeper = names[0];
        kept += 1;
        const keeperRel = `${folder}/${keeper}`.replace(/\\/g, '/');
        for (const dup of names.slice(1)) {
            const dupRel = `${folder}/${dup}`.replace(/\\/g, '/');
            pathMap.set(dupRel, keeperRel);
            try {
                fs.unlinkSync(path.join(dir, dup));
                removed.push(dupRel);
            } catch {
                // ignore locked files
            }
        }
    }

    return { removed, kept, pathMap };
}

/** Подмена путей в тексте (HTML / CSS). */
function rewriteAssetPaths(text: string, pathMap: Map<string, string>): string {
    if (pathMap.size === 0) {
        return text;
    }
    let current = text;
    // длинные пути сначала, чтобы не пересекаться
    const entries = [...pathMap.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [from, to] of entries) {
        if (current.includes(from)) {
            current = current.split(from).join(to);
        }
        const dotted = `./${from}`;
        if (current.includes(dotted)) {
            current = current.split(dotted).join(to);
        }
    }
    return current;
}

/** Переписать url()/пути внутри css/*.css после дедупа. */
function rewriteCssFilesOnDisk(htmlDir: string, pathMap: Map<string, string>): void {
    if (pathMap.size === 0) {
        return;
    }
    const cssDir = path.join(htmlDir, 'css');
    if (!fs.existsSync(cssDir)) {
        return;
    }
    for (const name of fs.readdirSync(cssDir)) {
        if (!/\.css$/i.test(name)) {
            continue;
        }
        const full = path.join(cssDir, name);
        try {
            if (!fs.statSync(full).isFile()) {
                continue;
            }
            const before = fs.readFileSync(full, 'utf8');
            const after = rewriteAssetPaths(before, pathMap);
            if (after !== before) {
                fs.writeFileSync(full, after, 'utf8');
            }
        } catch {
            // ignore
        }
    }
}

export type DedupeAssetsResult = {
    html: string;
    removed: string[];
    kept: number;
};

/**
 * Дубли по содержимому (SHA-1) в images/, css/, js/ (и scripts/, если есть).
 * Одинаковые файлы схлопываются; ссылки в HTML и в css/*.css обновляются.
 */
export function dedupeAssetFolders(
    html: string,
    htmlDir: string,
    folders: Array<'images' | 'css' | 'js' | 'scripts'> = ['images', 'css', 'js', 'scripts']
): DedupeAssetsResult {
    const allRemoved: string[] = [];
    let kept = 0;
    const pathMap = new Map<string, string>();

    const extsFor = (folder: string): Set<string> => {
        if (folder === 'images') {
            return KNOWN_EXT;
        }
        if (folder === 'css') {
            return new Set(['.css']);
        }
        return new Set(['.js', '.mjs', '.cjs']);
    };

    for (const folder of folders) {
        const part = dedupeOneFolder(htmlDir, folder, extsFor(folder));
        kept += part.kept;
        allRemoved.push(...part.removed);
        for (const [from, to] of part.pathMap) {
            pathMap.set(from, to);
        }
    }

    let current = rewriteAssetPaths(html, pathMap);
    rewriteCssFilesOnDisk(htmlDir, pathMap);

    return { html: current, removed: allRemoved, kept };
}

/**
 * Дубли только в images/ (после скачивания внешних картинок).
 */
export function dedupeImagesFolder(
    html: string,
    htmlDir: string
): { html: string; removed: string[]; kept: number } {
    const r = dedupeAssetFolders(html, htmlDir, ['images']);
    // для обратной совместимости — имена без префикса images/
    return {
        html: r.html,
        removed: r.removed.map(p => p.replace(/^images\//i, '')),
        kept: r.kept
    };
}

/** Собрать внешние URL из img[src] и srcset. */
export function collectExternalImageUrls(html: string): string[] {
    const urls = new Set<string>();
    const srcRe = /<img\b[^>]*\bsrc\s*=\s*(["'])((?:(?!\1)[\s\S])*)\1/gi;
    let m: RegExpExecArray | null;
    while ((m = srcRe.exec(html)) !== null) {
        const u = m[2].trim();
        if (isExternalUrl(u)) {
            urls.add(normalizeUrl(u));
        }
    }
    const srcsetRe = /\bsrcset\s*=\s*(["'])((?:(?!\1)[\s\S])*)\1/gi;
    while ((m = srcsetRe.exec(html)) !== null) {
        for (const part of m[2].split(',')) {
            const u = part.trim().split(/\s+/)[0];
            if (u && isExternalUrl(u)) {
                urls.add(normalizeUrl(u));
            }
        }
    }
    return [...urls];
}

/** Внешний URL картинки из строки HTML / сообщения чекера. */
export function extractExternalImageUrlFromLine(line: string): string | undefined {
    const src = line.match(/\bsrc\s*=\s*(["'])((?:(?!\1)[\s\S])*)\1/i);
    if (src && isExternalUrl(src[2])) {
        return normalizeUrl(src[2]);
    }
    // сообщение чекера: img src="https://..."
    const fromMsg = line.match(/img\s+src=["']([^"']+)["']/i);
    if (fromMsg && isExternalUrl(fromMsg[1])) {
        return normalizeUrl(fromMsg[1]);
    }
    const highlighted = line.match(/https?:\/\/[^\s"'<>]+/i);
    if (highlighted) {
        return normalizeUrl(highlighted[0]);
    }
    const protoRel = line.match(/\/\/[^\s"'<>]+/);
    if (protoRel && isExternalUrl(protoRel[0])) {
        return normalizeUrl(protoRel[0]);
    }
    return undefined;
}

/**
 * URL внешних картинок, которые чекер помечает ошибкой
 * (не whitelist / не jQuery CDN) — те же правила, что в checker.ts.
 */
export function collectFlaggedExternalImageUrls(html: string, whitelist: string[] = []): string[] {
    const urls = new Set<string>();
    const srcRe = /<img\b[^>]*\bsrc\s*=\s*(["'])((?:(?!\1)[\s\S])*)\1/gi;
    let m: RegExpExecArray | null;
    while ((m = srcRe.exec(html)) !== null) {
        const src = m[2].trim();
        if (src.startsWith('data:') || src.startsWith('{') || src.includes('{')) {
            continue;
        }
        if (!isExternalUrl(src)) {
            continue;
        }
        const normalized = normalizeUrl(src);
        const isWhitelisted =
            whitelist.some(domain => normalized.includes(domain)) ||
            normalized.includes('cdnjs.cloudflare.com');
        if (!isWhitelisted) {
            urls.add(normalized);
        }
    }
    return [...urls];
}

export type ExternalImageClassified = {
    all: string[];
    /** Нет файла в images/ с подходящим именем — нужно качать */
    missing: string[];
    /** Файл уже есть — только подменить путь в HTML */
    reusable: Array<{ url: string; local: string }>;
};

export function classifyExternalImages(html: string, htmlDir: string): ExternalImageClassified {
    const imagesDir = path.join(htmlDir, 'images');
    const all = collectExternalImageUrls(html);
    const missing: string[] = [];
    const reusable: Array<{ url: string; local: string }> = [];
    for (const url of all) {
        const local = findExistingByUrlName(imagesDir, url);
        if (local) {
            reusable.push({ url, local });
        } else {
            missing.push(url);
        }
    }
    return { all, missing, reusable };
}

function mapUrlVariants(urlToLocal: Map<string, string>, url: string, local: string): void {
    urlToLocal.set(url, local);
    if (url.startsWith('https:')) {
        urlToLocal.set(url.replace(/^https:/, ''), local);
    }
    if (url.startsWith('http:')) {
        urlToLocal.set(url.replace(/^http:/, 'https:'), local);
        urlToLocal.set(url.replace(/^http:/, ''), local);
    }
}

export type DownloadExternalImagesOptions = {
    /**
     * Обработать только эти URL (остальные внешние в HTML не трогаем).
     * Если не задано — все внешние из файла.
     */
    onlyUrls?: string[];
};

/**
 * Скачивает внешние img/srcset в images/.
 * По умолчанию не качает повторно, если файл с тем же именем уже есть.
 * В конце схлопывает байт-в-байт дубли в images/.
 */
export async function downloadExternalImages(
    html: string,
    htmlDir: string,
    options?: DownloadExternalImagesOptions
): Promise<DownloadImageResult> {
    const imagesDir = path.join(htmlDir, 'images');
    if (!fs.existsSync(imagesDir)) {
        fs.mkdirSync(imagesDir, { recursive: true });
    }

    const scope = new Set(
        (options?.onlyUrls ?? collectExternalImageUrls(html)).map(u => normalizeUrl(u))
    );
    const urls = collectExternalImageUrls(html).filter(u => scope.has(u));
    let current = html;
    let downloaded = 0;
    let reused = 0;
    let skipped = 0;
    const failed: string[] = [];
    const replacements: Array<{ from: string; to: string }> = [];
    const urlToLocal = new Map<string, string>();
    let hashIndex = buildHashIndex(imagesDir);

    for (const url of urls) {
        try {
            const existing = findExistingByUrlName(imagesDir, url);
            if (existing) {
                mapUrlVariants(urlToLocal, url, existing);
                reused += 1;
                replacements.push({ from: url, to: existing });
                continue;
            }

            const { buffer, contentType, contentDisposition } = await downloadBuffer(url);
            if (!buffer.length) {
                throw new Error('empty');
            }
            if (looksLikeNonImage(buffer, contentType) && !extFromMagic(buffer)) {
                throw new Error('not an image');
            }

            const hash = fileHash(buffer);
            const byHash = hashIndex.get(hash);
            if (byHash) {
                const local = localPath(byHash);
                mapUrlVariants(urlToLocal, url, local);
                reused += 1;
                replacements.push({ from: url, to: local });
                continue;
            }

            const fileName = buildLocalFileName(
                url,
                imagesDir,
                contentType,
                contentDisposition,
                buffer
            );
            const dest = path.join(imagesDir, fileName);
            if (!fs.existsSync(dest)) {
                fs.writeFileSync(dest, buffer);
                downloaded += 1;
            } else {
                reused += 1;
            }
            hashIndex.set(hash, fileName);
            const local = localPath(fileName);
            mapUrlVariants(urlToLocal, url, local);
            replacements.push({ from: url, to: local });
        } catch {
            failed.push(url);
            skipped += 1;
        }
    }

    const sorted = [...urlToLocal.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [from, to] of sorted) {
        if (current.includes(from)) {
            current = current.split(from).join(to);
        }
        const bare = from.replace(/^https?:/, '');
        if (bare.startsWith('//') && current.includes(bare)) {
            current = current.split(bare).join(to);
        }
    }

    const dedupe = dedupeImagesFolder(current, htmlDir);

    return {
        html: dedupe.html,
        downloaded,
        reused,
        skipped,
        failed,
        deduped: dedupe.removed.length,
        dedupedFiles: dedupe.removed,
        replacements
    };
}
