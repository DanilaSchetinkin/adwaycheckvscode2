import * as fs from 'fs';
import * as path from 'path';

export type AssetKind = 'png' | 'jpg' | 'webp' | 'gif' | 'svg' | 'ico' | 'mp4' | 'webm' | 'mov';

export type ExtensionlessIssue = {
    /** Относительный путь от htmlDir (через /) */
    relPath: string;
    absPath: string;
    kind: AssetKind;
    /** Предлагаемое имя с расширением (тот же каталог) */
    suggestedRel: string;
};

export type ExtensionlessFixResult = {
    html: string;
    renamed: string[];
    /** Сколько замен путей в HTML/CSS */
    refsUpdated: number;
    cssFiles: string[];
    notes: string[];
};

const SKIP_DIRS = new Set([
    '.git',
    '.svn',
    '.hg',
    '.vscode',
    '.cursor',
    '.idea',
    'node_modules',
    'other'
]);

const SKIP_NAMES = new Set([
    'index.html',
    'order.php',
    'robots.txt',
    'favicon.ico',
    'thumbs.db',
    'desktop.ini'
]);

function toPosix(p: string): string {
    return p.replace(/\\/g, '/');
}

/** Определить тип файла по magic bytes / началу текста. */
export function detectAssetKind(absPath: string): AssetKind | null {
    let buf: Buffer;
    try {
        const fd = fs.openSync(absPath, 'r');
        try {
            buf = Buffer.alloc(64);
            const n = fs.readSync(fd, buf, 0, 64, 0);
            buf = buf.subarray(0, n);
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return null;
    }
    if (buf.length < 4) {
        return null;
    }

    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        return 'png';
    }
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
        return 'jpg';
    }
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
        return 'gif';
    }
    if (
        buf.length >= 12 &&
        buf.toString('ascii', 0, 4) === 'RIFF' &&
        buf.toString('ascii', 8, 12) === 'WEBP'
    ) {
        return 'webp';
    }
    if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) {
        return 'ico';
    }
    // ISO BMFF: ....ftyp
    if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') {
        const brand = buf.toString('ascii', 8, 12).toLowerCase();
        if (brand.startsWith('qt') || brand.includes('qt  ')) {
            return 'mov';
        }
        return 'mp4';
    }
    // WebM / Matroska
    if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
        return 'webm';
    }

    // SVG / XML+SVG
    const head = buf.toString('utf8').replace(/^\uFEFF/, '').trimStart();
    if (/^<svg[\s>]/i.test(head)) {
        return 'svg';
    }
    if (/^<\?xml/i.test(head)) {
        // дочитать чуть больше для <svg
        try {
            const more = fs.readFileSync(absPath, { encoding: 'utf8' }).slice(0, 4000);
            if (/<svg[\s>]/i.test(more)) {
                return 'svg';
            }
        } catch {
            // ignore
        }
    }
    return null;
}

function hasNoUsefulExtension(fileName: string): boolean {
    const ext = path.extname(fileName);
    if (!ext) {
        return true;
    }
    // странные «расширения» вроде uuid без точки уже покрыты; не трогаем .png/.js/…
    return false;
}

function uniqueDest(dir: string, baseName: string, ext: string): string {
    let dest = path.join(dir, baseName + ext);
    if (!fs.existsSync(dest)) {
        return dest;
    }
    let i = 1;
    while (fs.existsSync(dest)) {
        dest = path.join(dir, `${baseName}_${i}${ext}`);
        i += 1;
    }
    return dest;
}

function walkFiles(dir: string, out: string[], depth = 0): void {
    if (depth > 6) {
        return;
    }
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const e of entries) {
        if (e.name.startsWith('.')) {
            continue;
        }
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (SKIP_DIRS.has(e.name.toLowerCase())) {
                continue;
            }
            walkFiles(full, out, depth + 1);
            continue;
        }
        if (e.isFile()) {
            out.push(full);
        }
    }
}

/**
 * Найти локальные файлы без расширения, у которых по содержимому понятен тип (PNG/SVG/…).
 */
export function findExtensionlessAssets(htmlDir: string): ExtensionlessIssue[] {
    if (!htmlDir || !fs.existsSync(htmlDir)) {
        return [];
    }
    const files: string[] = [];
    walkFiles(htmlDir, files);
    const issues: ExtensionlessIssue[] = [];

    for (const abs of files) {
        const name = path.basename(abs);
        if (SKIP_NAMES.has(name.toLowerCase())) {
            continue;
        }
        if (!hasNoUsefulExtension(name)) {
            continue;
        }
        // пропускаем явно текстовые без расширений редко — magic решит
        let stat: fs.Stats;
        try {
            stat = fs.statSync(abs);
        } catch {
            continue;
        }
        if (stat.size === 0 || stat.size > 80 * 1024 * 1024) {
            continue;
        }

        const kind = detectAssetKind(abs);
        if (!kind) {
            continue;
        }

        const rel = toPosix(path.relative(htmlDir, abs));
        if (!rel || rel.startsWith('..')) {
            continue;
        }
        const dirRel = path.posix.dirname(rel);
        const suggestedRel =
            !dirRel || dirRel === '.' ? `${name}.${kind}` : `${dirRel}/${name}.${kind}`;

        issues.push({
            relPath: rel,
            absPath: abs,
            kind,
            suggestedRel
        });
    }

    return issues.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function collectLocalCssRels(html: string, htmlDir: string): string[] {
    const set = new Set<string>();
    const linkRe = /<link\b([^>]*)>/gi;
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(html)) !== null) {
        const href = m[1].match(/\bhref\s*=\s*(["'])([^"']*)\1/i);
        if (!href) {
            continue;
        }
        const u = href[2].replace(/^\.\//, '').split('?')[0].split('#')[0];
        if (!u || /^https?:/i.test(u) || u.startsWith('//') || !/\.css$/i.test(u)) {
            continue;
        }
        set.add(toPosix(u));
    }
    const cssDir = path.join(htmlDir, 'css');
    if (fs.existsSync(cssDir)) {
        try {
            for (const f of fs.readdirSync(cssDir)) {
                if (/\.css$/i.test(f)) {
                    set.add(`css/${f}`);
                }
            }
        } catch {
            // ignore
        }
    }
    return [...set];
}

function replaceRefsInText(text: string, fromRel: string, toRel: string): { text: string; count: number } {
    let next = text;
    let count = 0;
    const base = path.posix.basename(fromRel);
    const toBase = path.posix.basename(toRel);
    const variants: Array<{ from: string; to: string }> = [
        { from: fromRel, to: toRel },
        { from: `./${fromRel}`, to: `./${toRel}` }
    ];
    if (base !== fromRel) {
        variants.push({ from: base, to: toBase }, { from: `./${base}`, to: `./${toBase}` });
    }

    const seen = new Set<string>();
    for (const { from, to } of variants) {
        if (!from || seen.has(from) || from === to) {
            continue;
        }
        seen.add(from);
        // src="…", href="…", url(…)
        const attrRe = new RegExp(`(=["'])(${escapeRegExp(from)})(["'])`, 'g');
        next = next.replace(attrRe, (_m, a: string, _b: string, c: string) => {
            count += 1;
            return `${a}${to}${c}`;
        });
        const urlRe = new RegExp(`(url\\(\\s*["']?)${escapeRegExp(from)}(["']?\\s*\\))`, 'gi');
        next = next.replace(urlRe, (_m, a: string, c: string) => {
            count += 1;
            return `${a}${to}${c}`;
        });
    }
    return { text: next, count };
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Переименовать файлы без расширения и обновить ссылки в HTML + локальных CSS.
 */
export function fixExtensionlessAssets(html: string, htmlDir: string): ExtensionlessFixResult {
    const issues = findExtensionlessAssets(htmlDir);
    const notes: string[] = [];
    const renamed: string[] = [];
    let refsUpdated = 0;
    const cssFilesTouched = new Set<string>();
    let nextHtml = html;

    if (issues.length === 0) {
        return { html, renamed, refsUpdated: 0, cssFiles: [], notes: ['файлов без расширения не найдено'] };
    }

    // карта старый rel → новый rel (после реального rename)
    const map = new Map<string, string>();

    for (const issue of issues) {
        const dir = path.dirname(issue.absPath);
        const baseName = path.basename(issue.absPath);
        const destAbs = uniqueDest(dir, baseName, `.${issue.kind}`);
        const destRel = toPosix(path.relative(htmlDir, destAbs));
        try {
            fs.renameSync(issue.absPath, destAbs);
            map.set(issue.relPath, destRel);
            map.set(baseName, path.basename(destRel));
            renamed.push(`${issue.relPath} → ${destRel}`);
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            notes.push(`не переименован ${issue.relPath}: ${msg}`);
        }
    }

    if (map.size === 0) {
        return { html, renamed, refsUpdated: 0, cssFiles: [], notes };
    }

    // обновить HTML: длинные пути сначала
    const entries = [...map.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [from, to] of entries) {
        const r = replaceRefsInText(nextHtml, from, to);
        nextHtml = r.text;
        refsUpdated += r.count;
    }

    // CSS
    for (const cssRel of collectLocalCssRels(html, htmlDir)) {
        const cssAbs = path.join(htmlDir, cssRel.replace(/\//g, path.sep));
        if (!fs.existsSync(cssAbs)) {
            continue;
        }
        let cssText: string;
        try {
            cssText = fs.readFileSync(cssAbs, 'utf8');
        } catch {
            continue;
        }
        let nextCss = cssText;
        let localCount = 0;
        for (const [from, to] of entries) {
            const r = replaceRefsInText(nextCss, from, to);
            nextCss = r.text;
            localCount += r.count;
        }
        if (localCount > 0 && nextCss !== cssText) {
            try {
                fs.writeFileSync(cssAbs, nextCss, 'utf8');
                cssFilesTouched.add(cssRel);
                refsUpdated += localCount;
            } catch {
                notes.push(`не записан ${cssRel}`);
            }
        }
    }

    notes.push(`переименовано: ${renamed.length}, ссылок обновлено: ${refsUpdated}`);
    return {
        html: nextHtml,
        renamed,
        refsUpdated,
        cssFiles: [...cssFilesTouched],
        notes
    };
}
