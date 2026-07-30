import * as fs from 'fs';
import * as path from 'path';

export type LocalPathIssue = {
    /** Путь как в HTML */
    url: string;
    resolved: string;
    /** Фрагмент атрибута для поиска строки, напр. src="…" */
    search: string;
    /** Если файл найден в images/css/js по имени */
    suggestedUrl?: string;
};

const IMAGE_EXT = new Set([
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.ico', '.bmp', '.avif', '.tif', '.tiff'
]);
const CSS_EXT = new Set(['.css']);
const JS_EXT = new Set(['.js', '.mjs', '.cjs']);

/** Папки проекта Adway (как в initProjectStructure) */
export const ASSET_FOLDERS = ['images', 'css', 'js'] as const;

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
        return ['js'];
    }
    return [...ASSET_FOLDERS];
}

function fileExistsInsensitive(filePath: string): boolean {
    if (fs.existsSync(filePath)) {
        return true;
    }
    // Windows уже case-insensitive; на прочих — лёгкий fallback по имени в папке
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
 * Ищет fileName в images/css/js (и на 1 уровень вложенности).
 * Возвращает относительный путь от htmlDir со слешами `/`.
 */
export function findAssetByBasename(htmlDir: string, fileName: string): string | undefined {
    const base = path.basename(fileName);
    if (!base || base === '.' || base === '..') {
        return undefined;
    }
    const ext = path.extname(base);
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

    return undefined;
}

/**
 * Локальные пути ресурсов относительно htmlDir.
 * Если путь битый, но файл есть в images/css/js по имени — suggestedUrl.
 */
export function findMissingLocalPaths(html: string, htmlDir: string): LocalPathIssue[] {
    const candidates: Array<{ url: string; search: string }> = [];
    const tagRe = /<(img|script|link|source|video|audio|iframe)\b([^>]*)>/gi;
    let match: RegExpExecArray | null;

    while ((match = tagRe.exec(html)) !== null) {
        const tag = match[1].toLowerCase();
        const attrs = match[2];

        const src = attrValue(attrs, 'src');
        const srcSearch = attrMatch(attrs, 'src');
        if (src && srcSearch && !isRemoteOrSpecial(src)) {
            candidates.push({ url: src, search: srcSearch });
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

    const seen = new Set<string>();
    const missing: LocalPathIssue[] = [];

    for (const { url, search } of candidates) {
        let clean = url.replace(/^\.\//, '').split('?')[0].split('#')[0];
        try {
            clean = decodeURIComponent(clean);
        } catch {
            // оставить как есть
        }
        if (!clean || isRemoteOrSpecial(clean)) {
            continue;
        }
        const resolved = path.normalize(path.resolve(htmlDir, clean));
        const key = resolved.toLowerCase();
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);

        if (fileExistsInsensitive(resolved)) {
            continue;
        }

        const suggestedUrl = findAssetByBasename(htmlDir, clean);
        missing.push({ url: clean, resolved, search, suggestedUrl });
    }

    return missing;
}
