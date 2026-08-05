import * as fs from 'fs';
import * as path from 'path';

export type ScriptAssetIssue = {
    kind: 'missing' | 'unconnected';
    /** Путь как в HTML или относительный путь файла */
    path: string;
    /** Для поиска строки в HTML (script src=…) */
    search?: string;
};

function isRemoteOrSpecial(url: string): boolean {
    const u = url.trim();
    if (!u || u.startsWith('#') || u.startsWith('{') || u.includes('{')) {
        return true;
    }
    if (/^https?:\/\//i.test(u) || u.startsWith('//') || /^data:/i.test(u) || /^blob:/i.test(u)) {
        return true;
    }
    return false;
}

function listJsFiles(dir: string, prefix: string, out: string[]): void {
    if (!fs.existsSync(dir)) {
        return;
    }
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            listJsFiles(full, rel, out);
            continue;
        }
        const ext = path.extname(entry.name).toLowerCase();
        if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
            out.push(rel.replace(/\\/g, '/'));
        }
    }
}

function collectLocalScriptSrcs(html: string): Array<{ url: string; search: string }> {
    const out: Array<{ url: string; search: string }> = [];
    const re = /<script\b([^>]*)>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
        const attrs = m[1];
        const srcM = attrs.match(/\bsrc\s*=\s*(["'])([^"']*)\1/i);
        if (!srcM) {
            continue;
        }
        const url = srcM[2].trim();
        if (isRemoteOrSpecial(url)) {
            continue;
        }
        out.push({ url, search: srcM[0] });
    }
    return out;
}

function normalizeLocal(url: string): string {
    let clean = url.replace(/^\.\//, '').split('?')[0].split('#')[0];
    try {
        clean = decodeURIComponent(clean);
    } catch {
        // keep
    }
    return clean.replace(/\\/g, '/');
}

/**
 * - script[src] на локальный файл, которого нет → missing
 * - файл в js/ (и scripts/), не подключён в HTML → unconnected
 */
export function checkScriptAssets(html: string, htmlDir: string): ScriptAssetIssue[] {
    const issues: ScriptAssetIssue[] = [];
    const linked = new Set<string>();

    for (const { url, search } of collectLocalScriptSrcs(html)) {
        const clean = normalizeLocal(url);
        if (!clean) {
            continue;
        }
        linked.add(clean.toLowerCase());
        linked.add(path.basename(clean).toLowerCase());
        const resolved = path.normalize(path.resolve(htmlDir, clean));
        if (!fs.existsSync(resolved)) {
            issues.push({ kind: 'missing', path: clean, search });
        }
    }

    const diskFiles: string[] = [];
    listJsFiles(path.join(htmlDir, 'js'), 'js', diskFiles);
    listJsFiles(path.join(htmlDir, 'scripts'), 'scripts', diskFiles);

    for (const rel of diskFiles) {
        const base = path.basename(rel).toLowerCase();
        if (linked.has(rel.toLowerCase()) || linked.has(base)) {
            continue;
        }
        // jquery с CDN обычно не лежит локально — локальный jquery.min.js без ссылки всё равно unconnected
        issues.push({ kind: 'unconnected', path: rel });
    }

    return issues;
}

/** Удалить тег <script src="…"> целиком (самозакрывающийся или с </script>). */
export function removeScriptSrcTag(html: string, srcPath: string): { html: string; removed: number } {
    const escaped = srcPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(
        `<script\\b[^>]*\\bsrc\\s*=\\s*(["'])(?:\\./)?${escaped}\\1[^>]*>\\s*(?:</script>)?`,
        'gi'
    );
    let removed = 0;
    const next = html.replace(re, () => {
        removed += 1;
        return '';
    });
    return { html: next, removed };
}

/** Вставить <script src="…"></script> перед </body> (или в конец). */
export function insertScriptSrcTag(html: string, srcPath: string): string {
    const tag = `<script src="${srcPath}"></script>\n`;
    if (/<\/body>/i.test(html)) {
        return html.replace(/<\/body>/i, `${tag}</body>`);
    }
    return html + tag;
}
