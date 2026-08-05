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
export const ASSET_FOLDERS = ['images', 'css', 'js', 'media'] as const;

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

    // 1) корень лендинга (src="ava14.jpg" при файле рядом с HTML — тогда путь уже ок;
    //    здесь нужно, если в HTML другой путь, а файл лежит в корне)
    const atRoot = path.join(htmlDir, base);
    if (fileExistsInsensitive(atRoot)) {
        // вернуть фактическое имя файла с диска (регистр)
        try {
            const real = fs.readdirSync(htmlDir).find(f => f.toLowerCase() === baseLower);
            return real || base;
        } catch {
            return base;
        }
    }

    // 2) стандартные папки + 1 уровень
    const folders = foldersForExt(ext);
    for (const folder of folders) {
        const direct = path.join(htmlDir, folder, base);
        if (fileExistsInsensitive(direct)) {
            return `${folder}/${base}`.replace(/\\/g, '/');
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

    // 3) рекурсивный обход всего проекта
    const found: string[] = [];
    const walk = (dir: string, rel: string, depth: number) => {
        if (depth > maxDepth) {
            return;
        }
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
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
            if (entry.name.toLowerCase() === baseLower) {
                found.push(rel ? `${rel}/${entry.name}` : entry.name);
            }
        }
    };
    walk(htmlDir, '', 0);

    if (found.length === 0) {
        return undefined;
    }

    found.sort((a, b) => {
        const score = (p: string) => {
            const n = p.replace(/\\/g, '/').toLowerCase();
            if (
                n.startsWith('images/') ||
                n.startsWith('css/') ||
                n.startsWith('js/') ||
                n.startsWith('media/')
            ) {
                return 0;
            }
            return 1 + n.split('/').length;
        };
        return score(a) - score(b) || a.length - b.length;
    });

    return found[0].replace(/\\/g, '/');
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
function collectLocalCssFiles(html: string, htmlDir: string): string[] {
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

        if (fileExistsInsensitive(resolved)) {
            continue;
        }

        const foundRelFromHtml = findAssetByBasename(htmlDir, path.basename(clean));
        let suggestedUrl: string | undefined;
        if (foundRelFromHtml) {
            const foundAbs = path.normalize(path.resolve(htmlDir, foundRelFromHtml));
            if (baseDir) {
                // для CSS — путь относительно самого CSS-файла (../images/1.png)
                suggestedUrl = toRel(baseDir, foundAbs);
            } else {
                suggestedUrl = foundRelFromHtml.replace(/\\/g, '/');
            }
        }

        // в отчёте для CSS показываем путь как в url()
        const reportUrl = clean.replace(/\\/g, '/');

        missing.push({
            url: reportUrl,
            resolved,
            search,
            suggestedUrl,
            cssFile
        });
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
    const issues = findMissingLocalPaths(html, htmlDir).filter(i => i.cssFile && i.suggestedUrl);
    if (issues.length === 0) {
        return { fixed: 0, files: [] };
    }

    const byFile = new Map<string, LocalPathIssue[]>();
    for (const issue of issues) {
        const list = byFile.get(issue.cssFile!) || [];
        list.push(issue);
        byFile.set(issue.cssFile!, list);
    }

    let fixed = 0;
    const files: string[] = [];

    for (const [cssRel, fileIssues] of byFile) {
        const full = path.join(htmlDir, cssRel);
        let text: string;
        try {
            text = fs.readFileSync(full, 'utf8');
        } catch {
            continue;
        }
        let next = text;
        // длинные search сначала
        const sorted = [...fileIssues].sort((a, b) => b.search.length - a.search.length);
        for (const issue of sorted) {
            if (!issue.suggestedUrl) {
                continue;
            }
            // заменить url(...) целиком или только путь внутри
            if (next.includes(issue.search)) {
                const rebuilt = issue.search.replace(issue.url, issue.suggestedUrl);
                // если url без кавычек и путь с пробелами — обернуть
                next = next.split(issue.search).join(rebuilt);
                fixed += 1;
            } else if (next.includes(issue.url)) {
                next = next.split(issue.url).join(issue.suggestedUrl);
                fixed += 1;
            }
        }
        if (next !== text) {
            try {
                fs.writeFileSync(full, next, 'utf8');
                files.push(cssRel);
            } catch {
                // ignore locked
            }
        }
    }

    return { fixed, files };
}
