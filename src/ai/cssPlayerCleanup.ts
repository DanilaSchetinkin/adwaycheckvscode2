import * as fs from 'fs';
import * as path from 'path';

/** Селекторы старых плееров / обёрток — ищем в CSS. */
export const DEFAULT_PLAYER_CSS_HINTS = [
    '.video-js',
    '.vjs-tech',
    '.vjs-control',
    '.embedpvideo',
    '.lv-wrapper',
    '.lv-overlay',
    '.section-video',
    '.hermes',
    '.plyr',
    '.jwplayer',
    '#my-player',
    '.mejs__'
];

const PROTECT = [
    '#container_video',
    '#video-overlay',
    '#open-video',
    '#popup',
    '#play',
    '#close',
    'body.noscroll'
];

export type CssRuleHit = {
    selector: string;
    full: string;
    start: number;
    end: number;
};

export type CssFileCleanup = {
    fileRel: string;
    absPath: string;
    before: string;
    after: string;
    removedSelectors: string[];
};

function attrValue(attrs: string, name: string): string | undefined {
    const re = new RegExp(`\\b${name}\\s*=\\s*(["'])([^"']*)\\1`, 'i');
    const m = attrs.match(re);
    return m ? m[2] : undefined;
}

function isRemote(href: string): boolean {
    return /^(https?:|\/\/|data:|blob:)/i.test(href.trim());
}

/** Локальные CSS: <link> + css/** */
export function collectLocalCssFiles(html: string, htmlDir: string): string[] {
    const set = new Set<string>();
    const linkRe = /<link\b([^>]*)>/gi;
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(html)) !== null) {
        const href = attrValue(m[1], 'href');
        if (!href || isRemote(href)) {
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

function normalizeHint(h: string): string {
    return h.trim().toLowerCase();
}

function selectorMatchesHints(selector: string, hints: string[]): boolean {
    const sel = selector.toLowerCase();
    if (PROTECT.some(p => sel.includes(p.toLowerCase()))) {
        // не трогаем правила Adway, даже если рядом video
        if (/#container_video|#video-overlay|#open-video\b|#popup\b|#play\b|#close\b|body\.noscroll/i.test(sel)) {
            return false;
        }
    }
    for (const h of hints) {
        const hint = normalizeHint(h);
        if (!hint) {
            continue;
        }
        const bare = hint.replace(/^[.#]/, '');
        if (hint.startsWith('.')) {
            if (new RegExp(`(^|[\\s,+>~])\\.${escapeRe(bare)}([\\s,#.:\\[>+~]|$)`, 'i').test(sel)) {
                return true;
            }
            if (sel.includes(hint)) {
                return true;
            }
        } else if (hint.startsWith('#')) {
            if (sel.includes(hint)) {
                return true;
            }
        } else if (sel.includes(hint)) {
            return true;
        }
    }
    // общие эвристики
    if (/\b(video-js|vjs-|embedpvideo|lv-wrapper|lv-overlay|section-video|hermes|jwplayer|plyr)\b/i.test(sel)) {
        return true;
    }
    return false;
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Плоский разбор CSS: top-level и внутри @media — правила selector { … }.
 */
export function extractCssRules(css: string): CssRuleHit[] {
    const hits: CssRuleHit[] = [];

    const scan = (text: string, baseOffset: number) => {
        let i = 0;
        while (i < text.length) {
            if (text.startsWith('/*', i)) {
                const end = text.indexOf('*/', i + 2);
                i = end < 0 ? text.length : end + 2;
                continue;
            }
            while (i < text.length && /\s/.test(text[i])) {
                i += 1;
            }
            if (i >= text.length) {
                break;
            }

            if (text[i] === '@') {
                const brace = text.indexOf('{', i);
                if (brace < 0) {
                    break;
                }
                const header = text.slice(i, brace).trim();
                const close = findMatchingBrace(text, brace);
                if (close < 0) {
                    break;
                }
                if (/^@media\b/i.test(header) || /^@supports\b/i.test(header)) {
                    scan(text.slice(brace + 1, close), baseOffset + brace + 1);
                }
                i = close + 1;
                continue;
            }

            const brace = text.indexOf('{', i);
            if (brace < 0) {
                break;
            }
            const selector = text.slice(i, brace).trim();
            if (!selector || selector.startsWith('@')) {
                i = brace + 1;
                continue;
            }
            const close = findMatchingBrace(text, brace);
            if (close < 0) {
                break;
            }
            const full = text.slice(i, close + 1);
            hits.push({
                selector,
                full,
                start: baseOffset + i,
                end: baseOffset + close + 1
            });
            i = close + 1;
        }
    };

    scan(css, 0);
    return hits;
}

function findMatchingBrace(text: string, openIdx: number): number {
    let depth = 0;
    for (let i = openIdx; i < text.length; i++) {
        if (text.startsWith('/*', i)) {
            const end = text.indexOf('*/', i + 2);
            i = end < 0 ? text.length : end + 1;
            continue;
        }
        const ch = text[i];
        if (ch === '{') {
            depth += 1;
        } else if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
                return i;
            }
        }
    }
    return -1;
}

export function findMatchingPlayerRules(css: string, hints: string[]): CssRuleHit[] {
    const merged = [...new Set([...DEFAULT_PLAYER_CSS_HINTS, ...hints].map(normalizeHint).filter(Boolean))];
    return extractCssRules(css).filter(r => selectorMatchesHints(r.selector, merged));
}

export function stripCssRules(css: string, rules: CssRuleHit[]): string {
    if (!rules.length) {
        return css;
    }
    const sorted = [...rules].sort((a, b) => b.start - a.start);
    let out = css;
    for (const r of sorted) {
        out = out.slice(0, r.start) + out.slice(r.end);
    }
    return out.replace(/\n{3,}/g, '\n\n').trimEnd() + (css.endsWith('\n') ? '\n' : '');
}

/**
 * Скан локальных CSS (кроме css/video.css — наш шаблон).
 */
export function scanAndCleanPlayerCss(
    html: string,
    htmlDir: string,
    hints: string[]
): CssFileCleanup[] {
    const files = collectLocalCssFiles(html, htmlDir);
    const result: CssFileCleanup[] = [];

    for (const fileRel of files) {
        if (/^css\/video\.css$/i.test(fileRel) || /\/video\.css$/i.test(fileRel)) {
            continue;
        }
        const absPath = path.join(htmlDir, fileRel.replace(/\//g, path.sep));
        if (!fs.existsSync(absPath)) {
            continue;
        }
        let before: string;
        try {
            before = fs.readFileSync(absPath, 'utf8');
        } catch {
            continue;
        }
        const rules = findMatchingPlayerRules(before, hints);
        if (!rules.length) {
            continue;
        }
        const after = stripCssRules(before, rules);
        if (after === before) {
            continue;
        }
        result.push({
            fileRel,
            absPath,
            before,
            after,
            removedSelectors: [...new Set(rules.map(r => r.selector.split('{')[0].trim()))].slice(0, 40)
        });
    }
    return result;
}
