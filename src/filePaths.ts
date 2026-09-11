import * as fs from 'fs';
import * as path from 'path';

export type LocalPathIssue = {
    /** Путь как в атрибуте / url() (для CSS — как написано, напр. ../images/1.png) */
    url: string;
    resolved: string;
    /** Фрагмент для поиска: src="…" или url(…) */
    search: string;
    /** Если файл найден по имени где-то в проекте — путь для подстановки */
    suggestedUrl?: string;
    /** Если проблема в CSS-файле — относительный путь от HTML, напр. css/style.css */
    cssFile?: string;
};

const IMAGE_EXT = new Set([
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.ico', '.bmp', '.avif', '.tif', '.tiff'
]);
const CSS_EXT = new Set(['.css']);
const JS_EXT = new Set(['.js', '.mjs', '.cjs']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.ogg', '.mov', '.m4v', '.avi', '.mkv']);

/** Папки проекта Adway */
export const ASSET_FOLDERS = ['images', 'css', 'js', 'media', 'fonts'] as const;

const SKIP_WALK_DIRS = new Set([
    '.git',
    '.svn',
    '.hg',
    '.vscode',
    '.cursor',
    '.idea',
    'node_modules',
    'other'
]);

type AssetIndex = {
    byBase: Map<string, string[]>;
    byStem: Map<string, string[]>;
};

let assetIndexCache: { dir: string; at: number; index: AssetIndex } | undefined;
const ASSET_INDEX_TTL_MS = 2500;
const ASSET_INDEX_MAX_FILES = 4000;

function addIndexPath(map: Map<string, string[]>, key: string, relPath: string) {
    const list = map.get(key);
    if (list) {
        list.push(relPath);
    } else {
        map.set(key, [relPath]);
    }
}

function buildAssetIndex(htmlDir: string, maxDepth: number): AssetIndex {
    const byBase = new Map<string, string[]>();
    const byStem = new Map<string, string[]>();
    let files = 0;
    const walk = (dir: string, rel: string, depth: number) => {
        if (depth > maxDepth || files >= ASSET_INDEX_MAX_FILES) {
            return;
        }
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (files >= ASSET_INDEX_MAX_FILES) {
                return;
            }
            if (entry.name.startsWith('.')) {
                continue;
            }
            if (entry.isDirectory()) {
                if (SKIP_WALK_DIRS.has(entry.name)) {
                    continue;
                }
                walk(
                    path.join(dir, entry.name),
                    rel ? `${rel}/${entry.name}` : entry.name,
                    depth + 1
                );
                continue;
            }
            files += 1;
            const relPath = rel ? `${rel}/${entry.name}` : entry.name;
            const nameLower = entry.name.toLowerCase();
            addIndexPath(byBase, nameLower, relPath);
            const ext = path.extname(entry.name);
            const stem = (ext ? entry.name.slice(0, -ext.length) : entry.name).toLowerCase();
            if (stem) {
                addIndexPath(byStem, stem, relPath);
            }
        }
    };
    walk(htmlDir, '', 0);
    return { byBase, byStem };
}

function getAssetIndex(htmlDir: string, maxDepth: number): AssetIndex {
    const now = Date.now();
    if (
        assetIndexCache &&
        assetIndexCache.dir === htmlDir &&
        now - assetIndexCache.at < ASSET_INDEX_TTL_MS
    ) {
        return assetIndexCache.index;
    }
    const index = buildAssetIndex(htmlDir, maxDepth);
    assetIndexCache = { dir: htmlDir, at: now, index };
    return index;
}

function isRemoteOrSpecial(url: string): boolean {
    const u = url.trim();
    if (!u || u === '#' || u.startsWith('#')) {
        return true;
    }
    if (u.startsWith('{') || u.includes('{')) {
        return true;
    }
    if (/^https?:\/\//i.test(u) || u.startsWith('//') || /^data:/i.test(u) || /^blob:/i.test(u)) {
        return true;
    }
    if (/^(tel:|mailto:|javascript:)/i.test(u)) {
        return true;
    }
    return false;
}

/** Разбор srcset: "a.webp 400w, b.webp 48w" → ["a.webp", "b.webp"] */
export function parseSrcsetUrls(srcset: string): string[] {
    return srcset
        .split(',')
        .map(part => part.trim().split(/\s+/)[0])
        .filter(Boolean);
}

function attrValue(attrs: string, name: string): string | null {
    const re = new RegExp(`\\b${name}\\s*=\\s*(["'])([^"']*)\\1`, 'i');
    const m = attrs.match(re);
    return m ? m[2] : null;
}

function attrMatch(attrs: string, name: string): string | null {
    const re = new RegExp(`\\b${name}\\s*=\\s*(["'])([^"']*)\\1`, 'i');
    const m = attrs.match(re);
    return m ? m[0] : null;
}

function foldersForExt(ext: string): string[] {
    const e = ext.toLowerCase();
    if (IMAGE_EXT.has(e)) {
        return ['images'];
    }
    if (CSS_EXT.has(e)) {
        return ['css'];
    }
    if (JS_EXT.has(e)) {
        return ['js', 'scripts'];
    }
    if (VIDEO_EXT.has(e)) {
        return ['media'];
    }
    return [...ASSET_FOLDERS];
}

function fileExistsInsensitive(filePath: string): boolean {
    if (fs.existsSync(filePath)) {
        return true;
    }
    try {
        const dir = path.dirname(filePath);
        const base = path.basename(filePath).toLowerCase();
        if (!fs.existsSync(dir)) {
            return false;
        }
        return fs.readdirSync(dir).some(f => f.toLowerCase() === base);
    } catch {
        return false;
    }
}

/**
 * Ищет fileName в images/css/js/media, в корне лендинга и рекурсивно (до maxDepth).
 * Возвращает реальный относительный путь, где файл уже лежит.
 * Также ищет по «стволу» имени: other/uuid → images/uuid.png (после переноса/расширения).
 */
export function findAssetByBasename(
    htmlDir: string,
    fileName: string,
    maxDepth = 5
): string | undefined {
    const base = path.basename(fileName);
    if (!base || base === '.' || base === '..') {
        return undefined;
    }
    const ext = path.extname(base);
    const baseLower = base.toLowerCase();
    const stem = (ext ? base.slice(0, -ext.length) : base).toLowerCase();

    // 1) корень лендинга
    const atRoot = path.join(htmlDir, base);
    if (fileExistsInsensitive(atRoot)) {
        try {
            const real = fs.readdirSync(htmlDir).find(f => f.toLowerCase() === baseLower);
            return real || base;
        } catch {
            return base;
        }
    }

    // 2) стандартные папки + 1 уровень (точное имя)
    const folders = foldersForExt(ext);
    for (const folder of folders) {
        const direct = path.join(htmlDir, folder, base);
        if (fileExistsInsensitive(direct)) {
            try {
                const real = fs
                    .readdirSync(path.join(htmlDir, folder))
                    .find(f => f.toLowerCase() === baseLower);
                return `${folder}/${real || base}`.replace(/\\/g, '/');
            } catch {
                return `${folder}/${base}`.replace(/\\/g, '/');
            }
        }
        const folderPath = path.join(htmlDir, folder);
        if (!fs.existsSync(folderPath)) {
            continue;
        }
        try {
            for (const entry of fs.readdirSync(folderPath, { withFileTypes: true })) {
                if (!entry.isDirectory()) {
                    continue;
                }
                const nested = path.join(folderPath, entry.name, base);
                if (fileExistsInsensitive(nested)) {
                    return `${folder}/${entry.name}/${base}`.replace(/\\/g, '/');
                }
            }
        } catch {
            // ignore
        }
    }

    const index = getAssetIndex(htmlDir, maxDepth);
    const foundExact = [...(index.byBase.get(baseLower) || [])];
    const foundStem = stem ? [...(index.byStem.get(stem) || [])] : [];

    const rank = (p: string) => {
        const n = p.replace(/\\/g, '/').toLowerCase();
        let score = 10 + n.split('/').length;
        if (n.startsWith('images/')) {
            score = 0;
        } else if (n.startsWith('media/')) {
            score = 1;
        } else if (n.startsWith('css/')) {
            score = 2;
        } else if (n.startsWith('js/') || n.startsWith('scripts/')) {
            score = 3;
        } else if (n.startsWith('fonts/')) {
            score = 4;
        }
        // если в HTML было .png — чуть предпочесть .png
        if (ext && n.endsWith(ext.toLowerCase())) {
            score -= 0.5;
        }
        return score;
    };

    const pick = (list: string[]) => {
        if (list.length === 0) {
            return undefined;
        }
        list.sort((a, b) => rank(a) - rank(b) || a.length - b.length);
        return list[0].replace(/\\/g, '/');
    };

    return pick(foundExact) || pick(foundStem);
}

function collectCssUrls(content: string): Array<{ url: string; search: string }> {
    const out: Array<{ url: string; search: string }> = [];
    const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
        const url = m[2].trim();
        if (!isRemoteOrSpecial(url)) {
            out.push({ url, search: m[0] });
        }
    }
    return out;
}

/** Относительный путь от baseDir к target, через /. */
function toRel(fromDir: string, targetAbs: string): string {
    let rel = path.relative(fromDir, targetAbs).replace(/\\/g, '/');
    if (!rel.startsWith('.') && !path.isAbsolute(rel)) {
        // path.relative может вернуть images/x без ./ — для url() в CSS из css/ нужен ../images/
        // оставляем как есть (images/… от корня HTML) или с ../
    }
    return rel;
}

/** Список локальных CSS: из <link> + все файлы в css/ */
export function collectLocalCssFiles(html: string, htmlDir: string): string[] {
    const set = new Set<string>();

    const linkRe = /<link\b([^>]*)>/gi;
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(html)) !== null) {
        const href = attrValue(m[1], 'href');
        if (!href || isRemoteOrSpecial(href)) {
            continue;
        }
        const clean = href.replace(/^\.\//, '').split('?')[0].split('#')[0];
        if (/\.css$/i.test(clean)) {
            set.add(clean.replace(/\\/g, '/'));
        }
    }

    const cssDir = path.join(htmlDir, 'css');
    if (fs.existsSync(cssDir)) {
        try {
            const walk = (dir: string, prefix: string) => {
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                    if (entry.name.startsWith('.')) {
                        continue;
                    }
                    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
                    const full = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        walk(full, rel);
                        continue;
                    }
                    if (/\.css$/i.test(entry.name)) {
                        set.add(`css/${rel}`.replace(/\\/g, '/'));
                    }
                }
            };
            walk(cssDir, '');
        } catch {
            // ignore
        }
    }

    return [...set];
}

/**
 * Локальные пути ресурсов относительно htmlDir.
 * Если путь битый, но файл есть по имени — suggestedUrl.
 * Также проверяет url() в HTML и во всех локальных CSS (link + css/).
 */
export function findMissingLocalPaths(html: string, htmlDir: string): LocalPathIssue[] {
    const candidates: Array<{ url: string; search: string; baseDir?: string; cssFile?: string }> = [];
    const tagRe = /<(img|script|link|source|video|audio|iframe|track|embed|object)\b([^>]*)>/gi;
    let match: RegExpExecArray | null;

    while ((match = tagRe.exec(html)) !== null) {
        const tag = match[1].toLowerCase();
        const attrs = match[2];

        const src = attrValue(attrs, 'src');
        const srcSearch = attrMatch(attrs, 'src');
        if (src && srcSearch && !isRemoteOrSpecial(src)) {
            candidates.push({ url: src, search: srcSearch });
        }

        const poster = attrValue(attrs, 'poster');
        const posterSearch = attrMatch(attrs, 'poster');
        if (poster && posterSearch && !isRemoteOrSpecial(poster)) {
            candidates.push({ url: poster, search: posterSearch });
        }

        const data = attrValue(attrs, 'data');
        const dataSearch = attrMatch(attrs, 'data');
        if (tag === 'object' && data && dataSearch && !isRemoteOrSpecial(data)) {
            candidates.push({ url: data, search: dataSearch });
        }

        if (tag === 'link') {
            const href = attrValue(attrs, 'href');
            const hrefSearch = attrMatch(attrs, 'href');
            if (href && hrefSearch && !isRemoteOrSpecial(href)) {
                candidates.push({ url: href, search: hrefSearch });
            }
        }

        const srcset = attrValue(attrs, 'srcset');
        const srcsetSearch = attrMatch(attrs, 'srcset');
        if (srcset && srcsetSearch) {
            for (const url of parseSrcsetUrls(srcset)) {
                if (!isRemoteOrSpecial(url)) {
                    candidates.push({
                        url,
                        search: srcset.includes(url) ? url : srcsetSearch
                    });
                }
            }
        }
    }

    // url() в inline <style> / атрибутах HTML — база = папка HTML
    candidates.push(...collectCssUrls(html));

    // url() внутри локальных CSS (подключённые + css/**/*.css)
    for (const cssRel of collectLocalCssFiles(html, htmlDir)) {
        const cssAbs = path.normalize(path.resolve(htmlDir, cssRel));
        if (!fileExistsInsensitive(cssAbs)) {
            continue;
        }
        let cssText = '';
        try {
            cssText = fs.readFileSync(cssAbs, 'utf8');
        } catch {
            continue;
        }
        const cssDir = path.dirname(cssAbs);
        for (const { url, search } of collectCssUrls(cssText)) {
            candidates.push({ url, search, baseDir: cssDir, cssFile: cssRel.replace(/\\/g, '/') });
        }
    }

    const seen = new Set<string>();
    const missing: LocalPathIssue[] = [];

    for (const { url, search, baseDir, cssFile } of candidates) {
        let clean = url.replace(/^\.\//, '').split('?')[0].split('#')[0];
        try {
            clean = decodeURIComponent(clean);
        } catch {
            // оставить как есть
        }
        if (!clean || isRemoteOrSpecial(clean)) {
            continue;
        }

        const fromDir = baseDir || htmlDir;
        const resolved = path.normalize(path.resolve(fromDir, clean));
        const key = `${cssFile || 'html'}::${resolved.toLowerCase()}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);

        const reportUrl = clean.replace(/\\/g, '/');
        const inOther = /(^|\/)other\//i.test(reportUrl);

        // Файл по старому пути есть, но лежит в other/ — всё равно ищем лучше в images/…
        const existsHere = fileExistsInsensitive(resolved);
        if (existsHere && !inOther) {
            continue;
        }

        const foundRelFromHtml = findAssetByBasename(htmlDir, path.basename(clean));
        let suggestedUrl: string | undefined;
        if (foundRelFromHtml && !/(^|\/)other\//i.test(foundRelFromHtml)) {
            const foundAbs = path.normalize(path.resolve(htmlDir, foundRelFromHtml));
            // если other/ ещё существует, но нашли images/ — предлагаем images/
            if (!existsHere || foundAbs.toLowerCase() !== resolved.toLowerCase()) {
                if (baseDir) {
                    suggestedUrl = toRel(baseDir, foundAbs);
                } else {
                    suggestedUrl = foundRelFromHtml.replace(/\\/g, '/');
                }
            }
        }

        // other/ без альтернативы — тоже ошибка (нужно перенести вручную / восстановить расширения)
        if (existsHere && !suggestedUrl) {
            continue;
        }
        if (!existsHere || suggestedUrl) {
            missing.push({
                url: reportUrl,
                resolved,
                search,
                suggestedUrl,
                cssFile
            });
        }
    }

    return missing;
}

/**
 * Исправляет url() в CSS-файлах на диске по suggestedUrl.
 * Возвращает число правок и список файлов.
 */
export function fixCssLocalPaths(
    html: string,
    htmlDir: string
): { fixed: number; files: string[] } {
    const previews = previewCssLocalPathFixes(html, htmlDir);
    const files: string[] = [];
    let fixed = 0;
    for (const p of previews) {
        try {
            fs.writeFileSync(p.absPath, p.after, 'utf8');
            files.push(p.fileRel);
            fixed += p.fixCount;
        } catch {
            // ignore locked
        }
    }
    return { fixed, files };
}

/** Превью правок url() в CSS без записи на диск. */
export function previewCssLocalPathFixes(
    html: string,
    htmlDir: string
): Array<{ fileRel: string; absPath: string; before: string; after: string; fixCount: number }> {
    const issues = findMissingLocalPaths(html, htmlDir).filter(i => i.cssFile && i.suggestedUrl);
    if (issues.length === 0) {
        return [];
    }

    const byFile = new Map<string, LocalPathIssue[]>();
    for (const issue of issues) {
        const list = byFile.get(issue.cssFile!) || [];
        list.push(issue);
        byFile.set(issue.cssFile!, list);
    }

    const out: Array<{
        fileRel: string;
        absPath: string;
        before: string;
        after: string;
        fixCount: number;
    }> = [];

    for (const [cssRel, fileIssues] of byFile) {
        const full = path.join(htmlDir, cssRel);
        let text: string;
        try {
            text = fs.readFileSync(full, 'utf8');
        } catch {
            continue;
        }
        let next = text;
        let fixCount = 0;
        const sorted = [...fileIssues].sort((a, b) => b.search.length - a.search.length);
        for (const issue of sorted) {
            if (!issue.suggestedUrl) {
                continue;
            }
            if (next.includes(issue.search)) {
                const rebuilt = issue.search.replace(issue.url, issue.suggestedUrl);
                next = next.split(issue.search).join(rebuilt);
                fixCount += 1;
            } else if (next.includes(issue.url)) {
                next = next.split(issue.url).join(issue.suggestedUrl);
                fixCount += 1;
            }
        }
        if (next !== text) {
            out.push({
                fileRel: cssRel,
                absPath: full,
                before: text,
                after: next,
                fixCount
            });
        }
    }
    return out;
}
