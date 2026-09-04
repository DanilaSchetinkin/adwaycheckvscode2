import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import { URL } from 'url';
import { JSDOM } from 'jsdom';

export type ImportParts = {
    header: boolean;
    footer: boolean;
};

export type HeaderFooterImportResult = {
    html: string;
    created: string[];
    notes: string[];
    warnings: string[];
};

const BROWSER_HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/*,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9'
};

const HEADER_SELECTORS = [
    'header',
    '[role="banner"]',
    '#header',
    '.header',
    '.site-header',
    '.page-header',
    '.main-header',
    '.who-header',
    '#masthead',
    '.masthead'
];

const FOOTER_SELECTORS = [
    'footer',
    '[role="contentinfo"]',
    '#footer',
    '.footer',
    '.site-footer',
    '.page-footer',
    '.main-footer',
    '.who-footer'
];

function fetchText(url: string, timeoutMs = 25000, redirectLeft = 8): Promise<string> {
    return new Promise((resolve, reject) => {
        if (redirectLeft <= 0) {
            reject(new Error('too many redirects'));
            return;
        }
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            reject(new Error(`Неверный URL: ${url}`));
            return;
        }
        const lib = parsed.protocol === 'https:' ? https : http;
        const req = lib.get(
            url,
            { timeout: timeoutMs, headers: BROWSER_HEADERS },
            res => {
                if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    const next = new URL(res.headers.location, url).href;
                    res.resume();
                    fetchText(next, timeoutMs, redirectLeft - 1).then(resolve, reject);
                    return;
                }
                if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                    res.resume();
                    reject(new Error(`HTTP ${res.statusCode || 0}`));
                    return;
                }
                const chunks: Buffer[] = [];
                res.on('data', (c: Buffer) => chunks.push(c));
                res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
                res.on('error', reject);
            }
        );
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('timeout'));
        });
    });
}

function fetchBuffer(
    url: string,
    timeoutMs = 25000,
    redirectLeft = 8
): Promise<{ buffer: Buffer; contentType?: string }> {
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
                fetchBuffer(next, timeoutMs, redirectLeft - 1).then(resolve, reject);
                return;
            }
            if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                res.resume();
                reject(new Error(`HTTP ${res.statusCode || 0}`));
                return;
            }
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () =>
                resolve({
                    buffer: Buffer.concat(chunks),
                    contentType: res.headers['content-type']
                })
            );
            res.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('timeout'));
        });
    });
}

function absUrl(base: string, maybe: string): string | undefined {
    const u = (maybe || '').trim();
    if (!u || u.startsWith('data:') || u.startsWith('javascript:') || u.startsWith('#')) {
        return undefined;
    }
    try {
        if (u.startsWith('//')) {
            return 'https:' + u;
        }
        return new URL(u, base).href;
    } catch {
        return undefined;
    }
}

function pickFirst(doc: Document, selectors: string[]): Element | null {
    for (const sel of selectors) {
        try {
            const el = doc.querySelector(sel);
            if (el && (el.textContent || '').trim().length + el.innerHTML.length > 40) {
                return el;
            }
        } catch {
            /* bad selector */
        }
    }
    return null;
}

function collectTokens(htmlFragment: string): Set<string> {
    const tokens = new Set<string>();
    const classRe = /\bclass\s*=\s*(["'])([^"']*)\1/gi;
    let m: RegExpExecArray | null;
    while ((m = classRe.exec(htmlFragment))) {
        for (const c of m[2].split(/\s+/)) {
            if (c && /^[a-zA-Z_%-][\w%-]*$/.test(c)) {
                tokens.add(c);
            }
        }
    }
    const idRe = /\bid\s*=\s*(["'])([^"']*)\1/gi;
    while ((m = idRe.exec(htmlFragment))) {
        const id = m[2].trim();
        if (id && /^[a-zA-Z_%-][\w%-]*$/.test(id)) {
            tokens.add(id);
        }
    }
    // tag names used
    const tagRe = /<\/?([a-zA-Z][\w-]*)\b/g;
    while ((m = tagRe.exec(htmlFragment))) {
        const t = m[1].toLowerCase();
        if (['header', 'footer', 'nav', 'svg', 'button', 'form'].includes(t)) {
            tokens.add(t);
        }
    }
    return tokens;
}

/** Грубая нарезка CSS на правила (достаточно для фильтра по классам). */
function splitCssRules(css: string): string[] {
    const rules: string[] = [];
    let i = 0;
    let start = 0;
    let depth = 0;
    let inStr: string | null = null;
    while (i < css.length) {
        const ch = css[i];
        if (inStr) {
            if (ch === inStr && css[i - 1] !== '\\') {
                inStr = null;
            }
            i += 1;
            continue;
        }
        if (ch === '"' || ch === "'") {
            inStr = ch;
            i += 1;
            continue;
        }
        if (ch === '{') {
            depth += 1;
            i += 1;
            continue;
        }
        if (ch === '}') {
            depth -= 1;
            i += 1;
            if (depth === 0) {
                const chunk = css.slice(start, i).trim();
                if (chunk) {
                    rules.push(chunk);
                }
                start = i;
            }
            continue;
        }
        i += 1;
    }
    return rules;
}

function ruleMatchesTokens(rule: string, tokens: Set<string>): boolean {
    const head = rule.split('{')[0] || '';
    // всегда оставляем :root / html / body с переменными — полезно для токенов WHO и т.п.
    if (/:(root)|^\s*html\b|^\s*body\b/i.test(head) && /--[a-zA-Z]/.test(rule)) {
        return true;
    }
    if (/@(font-face|keyframes)/i.test(head)) {
        // font-face оставим, если url скачаем отдельно — пока пропускаем тяжёлые
        return /@font-face/i.test(head) && tokens.size > 0 && /url\(/i.test(rule);
    }
    for (const t of tokens) {
        // .token или #token или [class~=token] приблизительно
        const re = new RegExp(`(^|[\\s,#>+~:\\[])(\\.|#)?${escapeRe(t)}(?![\\w%-])`, 'i');
        if (re.test(head)) {
            return true;
        }
    }
    return false;
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function filterCssForTokens(css: string, tokens: Set<string>): string {
    if (!tokens.size) {
        return '';
    }
    const cleaned = css
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/@charset[^;]+;/gi, '');
    const rules = splitCssRules(cleaned);
    const kept: string[] = [];
    for (const rule of rules) {
        if (/^@media\b/i.test(rule)) {
            const innerMatch = rule.match(/^(@media[^{]+)\{([\s\S]*)\}$/i);
            if (!innerMatch) {
                continue;
            }
            const innerRules = splitCssRules(innerMatch[2]);
            const innerKept = innerRules.filter(r => ruleMatchesTokens(r, tokens));
            if (innerKept.length) {
                kept.push(`${innerMatch[1].trim()} {\n${innerKept.join('\n\n')}\n}`);
            }
            continue;
        }
        if (ruleMatchesTokens(rule, tokens)) {
            kept.push(rule);
        }
    }
    return kept.join('\n\n');
}

function collectCssUrls(css: string, baseUrl: string): string[] {
    const out: string[] = [];
    const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(css))) {
        const abs = absUrl(baseUrl, m[2].trim());
        if (abs && /\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf)(\?|#|$)/i.test(abs)) {
            out.push(abs);
        }
    }
    return out;
}

function collectHtmlAssetUrls(fragment: string, baseUrl: string): string[] {
    const out: string[] = [];
    const attrRe = /\b(?:src|href|poster)\s*=\s*(["'])([^"']*)\1/gi;
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(fragment))) {
        const abs = absUrl(baseUrl, m[2]);
        if (abs && /\.(png|jpe?g|gif|webp|svg|ico)(\?|#|$)/i.test(abs)) {
            out.push(abs);
        }
    }
    const srcsetRe = /\bsrcset\s*=\s*(["'])([^"']*)\1/gi;
    while ((m = srcsetRe.exec(fragment))) {
        for (const part of m[2].split(',')) {
            const u = part.trim().split(/\s+/)[0];
            const abs = absUrl(baseUrl, u || '');
            if (abs && /\.(png|jpe?g|gif|webp|svg)(\?|#|$)/i.test(abs)) {
                out.push(abs);
            }
        }
    }
    return out;
}

function extFromUrlOrType(url: string, contentType?: string): string {
    try {
        const p = new URL(url).pathname;
        const ext = path.extname(p).toLowerCase();
        if (ext && ext.length <= 5) {
            return ext;
        }
    } catch {
        /* ignore */
    }
    const mime = (contentType || '').split(';')[0].trim().toLowerCase();
    const map: Record<string, string> = {
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/gif': '.gif',
        'image/webp': '.webp',
        'image/svg+xml': '.svg',
        'font/woff2': '.woff2',
        'font/woff': '.woff',
        'font/ttf': '.ttf'
    };
    return map[mime] || '.bin';
}

function uniqueName(dir: string, base: string): string {
    const safe = base.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/\s+/g, '_') || 'asset';
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

async function downloadAssets(
    urls: string[],
    imagesDir: string
): Promise<{ map: Map<string, string>; created: string[]; failed: string[] }> {
    if (!fs.existsSync(imagesDir)) {
        fs.mkdirSync(imagesDir, { recursive: true });
    }
    const map = new Map<string, string>();
    const created: string[] = [];
    const failed: string[] = [];
    const unique = [...new Set(urls)].slice(0, 80);

    for (const url of unique) {
        try {
            let basename = 'asset';
            try {
                basename = path.basename(new URL(url).pathname) || 'asset';
            } catch {
                /* keep */
            }
            if (!path.extname(basename)) {
                basename += '.bin';
            }
            // уже есть по имени
            const existing = path.join(imagesDir, basename);
            if (fs.existsSync(existing) && fs.statSync(existing).isFile()) {
                const local = `images/${basename}`.replace(/\\/g, '/');
                map.set(url, local);
                continue;
            }
            const { buffer, contentType } = await fetchBuffer(url);
            if (!buffer.length) {
                throw new Error('empty');
            }
            let name = basename;
            if (!path.extname(name) || path.extname(name) === '.bin') {
                name = path.basename(name, path.extname(name)) + extFromUrlOrType(url, contentType);
            }
            name = uniqueName(imagesDir, name);
            fs.writeFileSync(path.join(imagesDir, name), buffer);
            const local = `images/${name}`.replace(/\\/g, '/');
            map.set(url, local);
            created.push(local);
        } catch {
            failed.push(url);
        }
    }
    return { map, created, failed };
}

function rewriteUrlsInText(text: string, baseUrl: string, urlToLocal: Map<string, string>): string {
    let out = text;
    const sorted = [...urlToLocal.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [from, to] of sorted) {
        if (out.includes(from)) {
            out = out.split(from).join(to);
        }
    }
    // относительные в html/css → если резолвятся в known
    out = out.replace(
        /\b((?:src|href)\s*=\s*)(["'])([^"']+)\2/gi,
        (full, prefix: string, q: string, raw: string) => {
            const abs = absUrl(baseUrl, raw);
            if (abs && urlToLocal.has(abs)) {
                return `${prefix}${q}${urlToLocal.get(abs)}${q}`;
            }
            return full;
        }
    );
    out = out.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (full, q: string, raw: string) => {
        const abs = absUrl(baseUrl, raw.trim());
        if (abs && urlToLocal.has(abs)) {
            return `url(${q || ''}${urlToLocal.get(abs)}${q || ''})`;
        }
        return full;
    });
    return out;
}

function stripDangerous(fragment: string): { html: string; strippedScripts: number } {
    let n = 0;
    const html = fragment.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, () => {
        n += 1;
        return '';
    });
    return { html, strippedScripts: n };
}

function ensureLinkInHead(html: string, href: string): string {
    const link = `<link rel="stylesheet" href="${href}">`;
    if (html.includes(`href="${href}"`) || html.includes(`href='${href}'`)) {
        return html;
    }
    if (/<\/head>/i.test(html)) {
        return html.replace(/<\/head>/i, `  ${link}\n</head>`);
    }
    if (/<body\b/i.test(html)) {
        return html.replace(/<body\b[^>]*>/i, m => `${link}\n${m}`);
    }
    return `${link}\n${html}`;
}

function insertOrReplaceBlock(
    html: string,
    kind: 'header' | 'footer',
    block: string
): string {
    const commentOpen = `<!-- adway:${kind} -->`;
    const commentClose = `<!-- /adway:${kind} -->`;
    const wrapped = `${commentOpen}\n${block}\n${commentClose}`;

    const marked = new RegExp(
        `<!--\\s*adway:${kind}\\s*-->[\\s\\S]*?<!--\\s*/adway:${kind}\\s*-->`,
        'i'
    );
    if (marked.test(html)) {
        return html.replace(marked, wrapped);
    }

    if (kind === 'header') {
        const existing = html.match(/<header\b[^>]*>[\s\S]*?<\/header>/i);
        if (existing) {
            return html.replace(existing[0], wrapped);
        }
        if (/<body\b[^>]*>/i.test(html)) {
            return html.replace(/<body\b[^>]*>/i, m => `${m}\n${wrapped}\n`);
        }
        return `${wrapped}\n${html}`;
    }

    const existing = html.match(/<footer\b[^>]*>[\s\S]*?<\/footer>/i);
    if (existing) {
        return html.replace(existing[0], wrapped);
    }
    if (/<\/body>/i.test(html)) {
        return html.replace(/<\/body>/i, `${wrapped}\n</body>`);
    }
    return `${html}\n${wrapped}`;
}

async function collectPageCss(doc: Document, pageUrl: string, warnings: string[]): Promise<string> {
    const parts: string[] = [];
    for (const style of Array.from(doc.querySelectorAll('style'))) {
        const t = style.textContent || '';
        if (t.trim()) {
            parts.push(t);
        }
    }
    const links = Array.from(doc.querySelectorAll('link[rel="stylesheet"][href]'));
    let loaded = 0;
    for (const link of links.slice(0, 25)) {
        const href = link.getAttribute('href') || '';
        const abs = absUrl(pageUrl, href);
        if (!abs) {
            continue;
        }
        try {
            const css = await fetchText(abs);
            if (css.length > 1_500_000) {
                warnings.push(`CSS слишком большой, пропуск: ${abs}`);
                continue;
            }
            parts.push(`/* from ${abs} */\n${css}`);
            loaded += 1;
        } catch {
            warnings.push(`Не скачался CSS: ${abs}`);
        }
    }
    if (!loaded && !parts.length) {
        warnings.push('Стили на странице не найдены (возможен JS-рендер) — CSS будет минимальным');
    }
    return parts.join('\n\n');
}

/**
 * Скачать header/footer по URL и встроить в лендинг + css/hdr.css / css/ftr.css.
 * MVP: без headless-браузера — работает на статических/SSR страницах.
 */
export async function importHeaderFooterFromUrl(
    pageUrl: string,
    landingHtml: string,
    htmlDir: string,
    parts: ImportParts
): Promise<HeaderFooterImportResult> {
    const notes: string[] = [];
    const warnings: string[] = [];
    const created: string[] = [];

    let url = pageUrl.trim();
    if (!/^https?:\/\//i.test(url)) {
        url = 'https://' + url;
    }

    const pageHtml = await fetchText(url);
    const dom = new JSDOM(pageHtml, { url });
    const doc = dom.window.document;

    const headerEl = parts.header ? pickFirst(doc, HEADER_SELECTORS) : null;
    const footerEl = parts.footer ? pickFirst(doc, FOOTER_SELECTORS) : null;

    if (parts.header && !headerEl) {
        warnings.push('Header не найден (header / #header / .header / role=banner)');
    }
    if (parts.footer && !footerEl) {
        warnings.push('Footer не найден (footer / #footer / .footer / role=contentinfo)');
    }
    if (!headerEl && !footerEl) {
        throw new Error(
            'Не удалось найти header/footer в HTML. На SPA/JS-сайтах нужен Playwright — пока работает статическая разметка.'
        );
    }

    const pageCss = await collectPageCss(doc, url, warnings);
    const imagesDir = path.join(htmlDir, 'images');
    const cssDir = path.join(htmlDir, 'css');
    if (!fs.existsSync(cssDir)) {
        fs.mkdirSync(cssDir, { recursive: true });
    }

    let nextHtml = landingHtml;
    const allAssetUrls: string[] = [];

    type BlockJob = {
        kind: 'header' | 'footer';
        el: Element;
        cssFile: string;
        fragment: string;
        css: string;
    };
    const jobs: BlockJob[] = [];
    if (headerEl) {
        jobs.push({ kind: 'header', el: headerEl, cssFile: 'css/hdr.css', fragment: '', css: '' });
    }
    if (footerEl) {
        jobs.push({ kind: 'footer', el: footerEl, cssFile: 'css/ftr.css', fragment: '', css: '' });
    }

    for (const job of jobs) {
        let fragment = job.el.outerHTML;
        const stripped = stripDangerous(fragment);
        fragment = stripped.html;
        if (stripped.strippedScripts) {
            warnings.push(
                `${job.kind}: удалено script (${stripped.strippedScripts}) — меню/JS при необходимости добавьте вручную`
            );
        }

        const tokens = collectTokens(fragment);
        let css = filterCssForTokens(pageCss, tokens);
        if (!css.trim()) {
            css = `/* Adway: стили для ${job.kind} не удалось вырезать автоматически — проверьте исходный сайт */\n`;
            warnings.push(`${job.kind}: подходящие CSS-правила почти не найдены`);
        }

        allAssetUrls.push(...collectHtmlAssetUrls(fragment, url));
        allAssetUrls.push(...collectCssUrls(css, url));
        job.fragment = fragment;
        job.css = css;
    }

    const downloaded = await downloadAssets(allAssetUrls, imagesDir);
    created.push(...downloaded.created);
    if (downloaded.failed.length) {
        warnings.push(`Не скачалось ассетов: ${downloaded.failed.length}`);
    }
    notes.push(`Ассеты: скачано ${downloaded.created.length}, уже было/сопоставлено ${downloaded.map.size - downloaded.created.length}`);

    for (const job of jobs) {
        const j = job;
        let fragment = rewriteUrlsInText(j.fragment, url, downloaded.map);
        let css = rewriteUrlsInText(j.css, url, downloaded.map);

        // убрать внешние ссылки на чужие домены в href (оставить # / относительные / mailto)
        fragment = fragment.replace(/\bhref\s*=\s*(["'])(https?:\/\/[^"']+)\1/gi, (full, q, href) => {
            try {
                const host = new URL(url).host;
                const h = new URL(href).host;
                if (h === host || h.endsWith('.' + host) || host.endsWith('.' + h)) {
                    return `href=${q}#${q}`;
                }
            } catch {
                /* ignore */
            }
            return `href=${q}#${q}`;
        });

        const cssPath = path.join(htmlDir, j.cssFile.replace(/\//g, path.sep));
        const banner = `/* Adway import from ${url} — ${j.kind} */\n`;
        fs.writeFileSync(cssPath, banner + css + '\n', 'utf8');
        created.push(j.cssFile);
        notes.push(`${j.kind}: записан ${j.cssFile} (${css.length} символов)`);

        nextHtml = ensureLinkInHead(nextHtml, j.cssFile);
        nextHtml = insertOrReplaceBlock(nextHtml, j.kind, fragment);
        notes.push(`${j.kind}: вставлен в HTML`);
    }

    notes.push(
        'MVP без headless: если шапка пустая/без стилей — сайт рендерится через JS. Тогда нужен Playwright.'
    );

    return { html: nextHtml, created, notes, warnings };
}
