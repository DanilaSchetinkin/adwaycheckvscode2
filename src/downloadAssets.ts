import * as crypto from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import * as path from 'path';
import { URL } from 'url';
import { collectLocalCssFiles } from './filePaths';

export type AssetKind = 'image' | 'font';

export type DownloadImageResult = {
    html: string;
    downloaded: number;
    /** Уже были локально — только подменили путь */
    reused: number;
    skipped: number;
    failed: string[];
    /** Почему не скачалось (для UI) */
    failedReasons?: Array<{ url: string; reason: string }>;
    /** Удалено дублей с тем же содержимым */
    deduped: number;
    /** Имена удалённых файлов в images/ */
    dedupedFiles: string[];
    replacements: Array<{ from: string; to: string }>;
    /** Сколько url() переписано в CSS */
    cssUrlsFixed?: number;
    /** CSS-файлы, в которых меняли пути */
    cssFiles?: string[];
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
    'image/tiff': '.tiff',
    'font/woff': '.woff',
    'font/woff2': '.woff2',
    'font/ttf': '.ttf',
    'font/otf': '.otf',
    'application/font-woff': '.woff',
    'application/font-woff2': '.woff2',
    'application/x-font-woff': '.woff',
    'application/x-font-ttf': '.ttf',
    'application/x-font-otf': '.otf',
    'application/vnd.ms-fontobject': '.eot'
};

const KNOWN_EXT = new Set([
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.ico', '.bmp', '.avif', '.tif', '.tiff'
]);

const FONT_EXT = new Set(['.woff', '.woff2', '.ttf', '.otf', '.eot']);

const BROWSER_HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,font/woff2,font/woff,font/*,*/*;q=0.8',
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

function localPath(fileName: string, kind: AssetKind = 'image'): string {
    const folder = kind === 'font' ? 'fonts' : 'images';
    return `${folder}/${fileName}`.replace(/\\/g, '/');
}

function guessAssetKind(url: string): AssetKind {
    const clean = url.split('?')[0].split('#')[0].toLowerCase();
    const ext = path.extname(clean);
    if (FONT_EXT.has(ext)) {
        return 'font';
    }
    return 'image';
}

function extFromContentType(contentType: string | undefined): string | undefined {
    if (!contentType) {
        return undefined;
    }
    const mime = contentType.split(';')[0].trim().toLowerCase();
    const ext = CONTENT_TYPE_EXT[mime];
    return ext || undefined;
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
        let referer = 'https://www.google.com/';
        try {
            referer = new URL(url).origin + '/';
        } catch {
            // keep default
        }
        const headers = {
            ...BROWSER_HEADERS,
            Referer: referer
        };
        const lib = url.startsWith('https') ? https : http;
        const req = lib.get(url, { timeout: timeoutMs, headers }, res => {
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

/** Уже есть в папке по имени из URL — не качаем. */
function findExistingByUrlName(dir: string, url: string, kind: AssetKind): string | undefined {
    let fallback: string | undefined;
    for (const name of expectedNamesFromUrl(url)) {
        const full = path.join(dir, name);
        if (!(fs.existsSync(full) && fs.statSync(full).isFile())) {
            continue;
        }
        if (!isNumberedDuplicateName(name)) {
            return localPath(name, kind);
        }
        if (!fallback) {
            fallback = localPath(name, kind);
        }
    }
    return fallback;
}

function buildHashIndex(dir: string, allowedExt: Set<string>): Map<string, string> {
    const map = new Map<string, string>();
    if (!fs.existsSync(dir)) {
        return map;
    }
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
    destDir: string,
    contentType: string | undefined,
    contentDisposition: string | undefined,
    buffer: Buffer,
    kind: AssetKind
): string {
    const fromCd = fileNameFromContentDisposition(contentDisposition);
    let stem: string;
    let urlExt = '';

    if (fromCd) {
        urlExt = path.extname(fromCd).toLowerCase();
        stem = path.basename(fromCd, path.extname(fromCd)) || (kind === 'font' ? 'font' : 'image');
    } else {
        let pathname = '';
        try {
            pathname = new URL(url).pathname;
        } catch {
            pathname = url.split('?')[0];
        }
        stem = path.basename(pathname) || (kind === 'font' ? 'font' : 'image');
        urlExt = path.extname(stem).toLowerCase();
        if (urlExt) {
            stem = path.basename(stem, path.extname(stem));
        }
    }

    if (urlExt === '.jpeg') {
        urlExt = '.jpg';
    }
    if (!stem || stem === '.' || stem === '..') {
        stem = kind === 'font' ? 'font' : 'image';
    }

    const allowed = kind === 'font' ? FONT_EXT : KNOWN_EXT;
    const ext =
        extFromContentType(contentType) ||
        (kind === 'image' ? extFromMagic(buffer) : undefined) ||
        (allowed.has(urlExt) ? urlExt : undefined) ||
        (kind === 'font' && urlExt === '.woff2' ? '.woff2' : undefined);

    if (!ext) {
        // CDN без расширения / странный content-type — для картинок пробуем magic, иначе .bin недопустим
        if (kind === 'image' && extFromMagic(buffer)) {
            // already handled above
        }
        throw new Error(
            kind === 'font'
                ? `unknown font type (${contentType || 'no content-type'}, ext=${urlExt || 'none'})`
                : `unknown image type (${contentType || 'no content-type'}, ext=${urlExt || 'none'})`
        );
    }

    const preferred = `${stem}${ext}`;
    const preferredPath = path.join(destDir, preferred);
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
    return uniqueFileName(destDir, preferred);
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

/** Собрать внешние URL из img[src], srcset и url() в локальных CSS (картинки + шрифты). */
export function collectExternalImageUrls(html: string, htmlDir?: string): string[] {
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
    if (htmlDir) {
        for (const a of collectLocalCssExternalAssets(html, htmlDir)) {
            if (a.kind === 'image' || a.kind === 'font') {
                urls.add(a.url);
            }
        }
    }
    return [...urls];
}

/** Внешний URL картинки из строки HTML / CSS / сообщения чекера. */
export function extractExternalImageUrlFromLine(line: string): string | undefined {
    const clean = (u: string) =>
        normalizeUrl(
            u
                .replace(/&amp;/g, '&')
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'")
                .replace(/[),.;]+$/g, '')
                .trim()
        );

    const src = line.match(/\bsrc\s*=\s*(["'])((?:(?!\1)[\s\S])*)\1/i);
    if (src && isExternalUrl(src[2])) {
        return clean(src[2]);
    }
    // сообщение чекера: img src="https://..."
    const fromMsg = line.match(/img\s+src=["']([^"']+)["']/i);
    if (fromMsg && isExternalUrl(fromMsg[1])) {
        return clean(fromMsg[1]);
    }
    // сообщение / CSS: url("https://...") или url(https://...)
    const fromUrlFn = line.match(
        /url\(\s*(['"]?)(https?:\/\/[^'")\s]+|\/\/[^'")\s]+)\1\s*\)/i
    );
    if (fromUrlFn && isExternalUrl(fromUrlFn[2])) {
        return clean(fromUrlFn[2]);
    }
    const quoted = line.match(/["'](https?:\/\/[^"']+)["']/i);
    if (quoted && isExternalUrl(quoted[1])) {
        return clean(quoted[1]);
    }
    const highlighted = line.match(/https?:\/\/[^\s"'<>]+/i);
    if (highlighted) {
        return clean(highlighted[0]);
    }
    const protoRel = line.match(/\/\/[^\s"'<>]+/);
    if (protoRel && isExternalUrl(protoRel[0])) {
        return clean(protoRel[0]);
    }
    return undefined;
}

/**
 * URL внешних картинок, которые чекер помечает ошибкой
 * (не whitelist / не jQuery CDN) — те же правила, что в checker.ts.
 * При htmlDir также смотрит url() в локальных CSS.
 */
export function collectFlaggedExternalImageUrls(
    html: string,
    whitelist: string[] = [],
    htmlDir?: string
): string[] {
    const urls = new Set<string>();
    const isFlagged = (src: string) => {
        if (src.startsWith('data:') || src.startsWith('{') || src.includes('{')) {
            return false;
        }
        if (!isExternalUrl(src)) {
            return false;
        }
        const normalized = normalizeUrl(src);
        const isWhitelisted =
            whitelist.some(domain => normalized.includes(domain)) ||
            normalized.includes('cdnjs.cloudflare.com');
        return !isWhitelisted;
    };

    const srcRe = /<img\b[^>]*\bsrc\s*=\s*(["'])((?:(?!\1)[\s\S])*)\1/gi;
    let m: RegExpExecArray | null;
    while ((m = srcRe.exec(html)) !== null) {
        const src = m[2].trim();
        if (isFlagged(src)) {
            urls.add(normalizeUrl(src));
        }
    }
    if (htmlDir) {
        for (const a of collectLocalCssExternalAssets(html, htmlDir)) {
            if ((a.kind === 'image' || a.kind === 'font') && isFlagged(a.url)) {
                urls.add(a.url);
            }
        }
    }
    return [...urls];
}

export type CssExternalAsset = {
    /** Нормализованный https URL */
    url: string;
    /** Как в файле (может быть //…) */
    rawUrl: string;
    cssFile: string;
    search: string;
    kind: 'image' | 'font' | 'other';
};

const CSS_IMAGE_EXT = /\.(jpe?g|png|gif|webp|svg|ico|bmp|avif|tiff?)([?#]|$)/i;
const CSS_FONT_EXT = /\.(woff2?|ttf|otf|eot)([?#]|$)/i;

function classifyCssAssetUrl(url: string): 'image' | 'font' | 'other' {
    if (CSS_FONT_EXT.test(url)) {
        return 'font';
    }
    if (CSS_IMAGE_EXT.test(url)) {
        return 'image';
    }
    if (/\.(css|js|mjs|cjs|map)([?#]|$)/i.test(url)) {
        return 'other';
    }
    // без расширения — часто CDN-картинка
    if (!path.extname(url.split('?')[0].split('#')[0])) {
        return 'image';
    }
    return 'other';
}

/** Внешние url() в локальных CSS (link + css/**). */
export function collectLocalCssExternalAssets(html: string, htmlDir: string): CssExternalAsset[] {
    const out: CssExternalAsset[] = [];
    const seen = new Set<string>();

    for (const cssRel of collectLocalCssFiles(html, htmlDir)) {
        const cssAbs = path.normalize(path.resolve(htmlDir, cssRel));
        if (!fs.existsSync(cssAbs)) {
            continue;
        }
        let text = '';
        try {
            text = fs.readFileSync(cssAbs, 'utf8');
        } catch {
            continue;
        }
        const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
            const raw = m[2].trim();
            if (!raw || raw.startsWith('data:') || raw.startsWith('{') || raw.includes('{')) {
                continue;
            }
            if (!isExternalUrl(raw)) {
                continue;
            }
            const url = normalizeUrl(raw);
            const key = `${cssRel}::${url}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            out.push({
                url,
                rawUrl: raw,
                cssFile: cssRel.replace(/\\/g, '/'),
                search: m[0],
                kind: classifyCssAssetUrl(url)
            });
        }
    }

    return out;
}

/** Путь к images|fonts/file относительно папки CSS-файла. */
export function cssRelativeAssetPath(cssFileRel: string, localFromHtmlRoot: string): string {
    const cssDir = path.dirname(cssFileRel.replace(/\\/g, '/'));
    const target = localFromHtmlRoot.replace(/\\/g, '/');
    let rel = path.relative(cssDir, target).replace(/\\/g, '/');
    if (!rel.startsWith('.')) {
        rel = './' + rel;
    }
    return rel;
}

/** @deprecated use cssRelativeAssetPath */
export function cssRelativeImagePath(cssFileRel: string, imageFileName: string): string {
    return cssRelativeAssetPath(cssFileRel, `images/${imageFileName}`);
}

function rewriteCssExternalUrls(
    html: string,
    htmlDir: string,
    urlToLocalFromHtml: Map<string, string>
): { fixed: number; files: string[] } {
    let fixed = 0;
    const files: string[] = [];

    for (const cssRel of collectLocalCssFiles(html, htmlDir)) {
        const cssAbs = path.normalize(path.resolve(htmlDir, cssRel));
        if (!fs.existsSync(cssAbs)) {
            continue;
        }
        let text = '';
        try {
            text = fs.readFileSync(cssAbs, 'utf8');
        } catch {
            continue;
        }
        const before = text;
        const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
        text = text.replace(re, (full, quote: string, rawUrl: string) => {
            const raw = rawUrl.trim();
            if (!isExternalUrl(raw)) {
                return full;
            }
            const norm = normalizeUrl(raw);
            const bare = norm.replace(/^https?:/, '');
            const htmlLocal =
                urlToLocalFromHtml.get(norm) ||
                urlToLocalFromHtml.get(raw) ||
                urlToLocalFromHtml.get(bare) ||
                (bare.startsWith('//') ? urlToLocalFromHtml.get('https:' + bare) : undefined);
            if (!htmlLocal) {
                return full;
            }
            const cssLocal = cssRelativeAssetPath(cssRel, htmlLocal);
            const q = quote || '';
            fixed += 1;
            return `url(${q}${cssLocal}${q})`;
        });
        if (text !== before) {
            try {
                fs.writeFileSync(cssAbs, text, 'utf8');
                files.push(cssRel.replace(/\\/g, '/'));
            } catch {
                // ignore locked
            }
        }
    }

    return { fixed, files };
}

export type ExternalImageClassified = {
    all: string[];
    /** Нет файла в images/ с подходящим именем — нужно качать */
    missing: string[];
    /** Файл уже есть — только подменить путь в HTML */
    reusable: Array<{ url: string; local: string }>;
};

export function classifyExternalImages(html: string, htmlDir: string): ExternalImageClassified {
    const all = collectExternalImageUrls(html, htmlDir);
    const missing: string[] = [];
    const reusable: Array<{ url: string; local: string }> = [];
    for (const url of all) {
        const kind = guessAssetKind(url);
        const dir = path.join(htmlDir, kind === 'font' ? 'fonts' : 'images');
        const local = findExistingByUrlName(dir, url, kind);
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
     * Обработать только эти URL (остальные внешние в HTML/CSS не трогаем).
     * Если не задано — все внешние из файла.
     */
    onlyUrls?: string[];
};

/**
 * Скачивает внешние img/srcset и url() из локальных CSS (картинки → images/, шрифты → fonts/).
 * По умолчанию не качает повторно, если файл с тем же именем уже есть.
 * В конце схлопывает байт-в-байт дубли в images/ и правит пути в HTML + CSS.
 */
export async function downloadExternalImages(
    html: string,
    htmlDir: string,
    options?: DownloadExternalImagesOptions
): Promise<DownloadImageResult> {
    const imagesDir = path.join(htmlDir, 'images');
    const fontsDir = path.join(htmlDir, 'fonts');
    if (!fs.existsSync(imagesDir)) {
        fs.mkdirSync(imagesDir, { recursive: true });
    }

    const allUrls = collectExternalImageUrls(html, htmlDir);
    // onlyUrls — качаем как есть (даже если collect их не нашёл в HTML/CSS-снимке)
    const urls = options?.onlyUrls?.length
        ? [...new Set(options.onlyUrls.map(u => normalizeUrl(u.trim())).filter(Boolean))]
        : allUrls;
    let current = html;
    let downloaded = 0;
    let reused = 0;
    let skipped = 0;
    const failed: string[] = [];
    const failedReasons: Array<{ url: string; reason: string }> = [];
    const replacements: Array<{ from: string; to: string }> = [];
    const urlToLocal = new Map<string, string>();
    const imageHashIndex = buildHashIndex(imagesDir, KNOWN_EXT);
    const fontHashIndex = fs.existsSync(fontsDir)
        ? buildHashIndex(fontsDir, FONT_EXT)
        : new Map<string, string>();

    for (const url of urls) {
        const kind = guessAssetKind(url);
        const destDir = kind === 'font' ? fontsDir : imagesDir;
        const hashIndex = kind === 'font' ? fontHashIndex : imageHashIndex;
        try {
            if (kind === 'font' && !fs.existsSync(fontsDir)) {
                fs.mkdirSync(fontsDir, { recursive: true });
            }

            const existing = findExistingByUrlName(destDir, url, kind);
            if (existing) {
                mapUrlVariants(urlToLocal, url, existing);
                reused += 1;
                replacements.push({ from: url, to: existing });
                continue;
            }

            const { buffer, contentType, contentDisposition } = await downloadBuffer(url);
            if (!buffer.length) {
                throw new Error('empty response');
            }
            if (kind === 'image') {
                if (looksLikeNonImage(buffer, contentType) && !extFromMagic(buffer)) {
                    // если в URL есть расширение картинки — всё равно пробуем сохранить
                    const urlExt = path.extname(url.split('?')[0]).toLowerCase();
                    if (!KNOWN_EXT.has(urlExt === '.jpeg' ? '.jpg' : urlExt)) {
                        throw new Error(
                            `not an image (${(contentType || 'no type').split(';')[0]})`
                        );
                    }
                }
            }

            const hash = fileHash(buffer);
            const byHash = hashIndex.get(hash);
            if (byHash) {
                const local = localPath(byHash, kind);
                mapUrlVariants(urlToLocal, url, local);
                reused += 1;
                replacements.push({ from: url, to: local });
                continue;
            }

            const fileName = buildLocalFileName(
                url,
                destDir,
                contentType,
                contentDisposition,
                buffer,
                kind
            );
            const dest = path.join(destDir, fileName);
            if (!fs.existsSync(dest)) {
                fs.writeFileSync(dest, buffer);
                downloaded += 1;
            } else {
                reused += 1;
            }
            hashIndex.set(hash, fileName);
            const local = localPath(fileName, kind);
            mapUrlVariants(urlToLocal, url, local);
            replacements.push({ from: url, to: local });
        } catch (e: unknown) {
            const reason = e instanceof Error ? e.message : String(e);
            failed.push(url);
            failedReasons.push({ url, reason });
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

    const cssRewrite = rewriteCssExternalUrls(current, htmlDir, urlToLocal);
    const dedupe = dedupeImagesFolder(current, htmlDir);

    return {
        html: dedupe.html,
        downloaded,
        reused,
        skipped,
        failed,
        failedReasons,
        deduped: dedupe.removed.length,
        dedupedFiles: dedupe.removed,
        replacements,
        cssUrlsFixed: cssRewrite.fixed,
        cssFiles: cssRewrite.files
    };
}
