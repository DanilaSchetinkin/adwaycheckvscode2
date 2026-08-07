import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/** Подпапки внутри templatesPath (русские имена как у тебя + английские алиасы). */
export const TEMPLATE_CATEGORY_DIRS: Record<string, string[]> = {
    freePlayer: ['бесплатный плеер', 'free-player', 'free_player', 'video-free'],
    paidPlayer: ['платный плеер', 'paid-player', 'paid_player', 'video-paid'],
    landing: ['лэнд', 'lend', 'landing', 'land']
};

export type TemplatesStatus = {
    configured: boolean;
    path: string;
    exists: boolean;
    categories: Array<{ id: string; dir: string; htmlFiles: number }>;
    message: string;
};

export function getTemplatesPathSetting(): string {
    const cfg = vscode.workspace.getConfiguration('adway');
    return (cfg.get<string>('templatesPath', '') || '').trim();
}

/**
 * Абсолютный путь к папке шаблонов.
 * Пустая настройка → ищем ./шаблоны в корне workspace (если есть).
 */
export function resolveTemplatesRoot(): string | undefined {
    const raw = getTemplatesPathSetting();
    const folders = vscode.workspace.workspaceFolders;

    const tryPath = (p: string): string | undefined => {
        const abs = path.isAbsolute(p)
            ? p
            : folders?.[0]
              ? path.resolve(folders[0].uri.fsPath, p)
              : path.resolve(p);
        return fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? abs : undefined;
    };

    if (raw) {
        return tryPath(raw);
    }

    // дефолт: шаблоны / templates в корне воркспейса
    if (folders?.[0]) {
        for (const name of ['шаблоны', 'templates', 'Templates']) {
            const hit = tryPath(path.join(folders[0].uri.fsPath, name));
            if (hit) {
                return hit;
            }
        }
    }
    return undefined;
}

export function getTemplatesStatus(): TemplatesStatus {
    const configured = !!getTemplatesPathSetting();
    const root = resolveTemplatesRoot();
    if (!root) {
        return {
            configured,
            path: getTemplatesPathSetting() || '(не задан)',
            exists: false,
            categories: [],
            message: configured
                ? 'Путь к шаблонам указан, но папка не найдена'
                : 'Папка шаблонов не задана (опционально: adway.templatesPath или ./шаблоны)'
        };
    }

    const categories: TemplatesStatus['categories'] = [];
    for (const [id, names] of Object.entries(TEMPLATE_CATEGORY_DIRS)) {
        const dirName = names.find(n => fs.existsSync(path.join(root, n)));
        if (!dirName) {
            continue;
        }
        const full = path.join(root, dirName);
        const htmlFiles = countHtmlFiles(full);
        categories.push({ id, dir: dirName, htmlFiles });
    }

    return {
        configured,
        path: root,
        exists: true,
        categories,
        message: `Шаблоны: ${root} · ${categories.map(c => `${c.dir}(${c.htmlFiles})`).join(', ') || 'подпапок не найдено'}`
    };
}

function countHtmlFiles(dir: string, depth = 0): number {
    if (depth > 4) {
        return 0;
    }
    let n = 0;
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return 0;
    }
    for (const e of entries) {
        if (e.name.startsWith('.')) {
            continue;
        }
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            n += countHtmlFiles(full, depth + 1);
        } else if (/\.html?$/i.test(e.name)) {
            n += 1;
        }
    }
    return n;
}

function listHtmlFiles(dir: string, depth = 0, out: string[] = []): string[] {
    if (depth > 4) {
        return out;
    }
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const e of entries) {
        if (e.name.startsWith('.')) {
            continue;
        }
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            listHtmlFiles(full, depth + 1, out);
        } else if (/\.html?$/i.test(e.name)) {
            out.push(full);
        }
    }
    return out;
}

/** Вырезать из эталона полезный кусок (плеер / section-video / container_video). */
export function extractTemplateFragment(html: string, maxLen = 3500): string {
    const patterns = [
        /<section\b[^>]*class\s*=\s*["'][^"']*section-video[^"']*["'][^>]*>[\s\S]*?<\/section>/i,
        /<div\b[^>]*id\s*=\s*["']container_video["'][^>]*>[\s\S]*?<\/div>/i,
        /<div\b[^>]*(?:embedpvideo|video-js|data-hermes)[^>]*>[\s\S]{0,4000}?<\/div>/i
    ];
    for (const re of patterns) {
        const m = html.match(re);
        if (m?.[0] && m[0].length > 80) {
            return m[0].length > maxLen ? m[0].slice(0, maxLen) + '\n<!-- truncated -->' : m[0];
        }
    }
    // fallback: середина файла с video
    const idx = html.search(/video|player|hermes|container_video/i);
    if (idx >= 0) {
        const start = Math.max(0, idx - 200);
        return html.slice(start, start + maxLen);
    }
    return html.slice(0, Math.min(maxLen, html.length));
}

export type LoadedTemplateHint = {
    category: string;
    file: string;
    fragment: string;
};

/**
 * Загрузить 1–2 коротких фрагмента из категории для промпта ИИ.
 */
export function loadTemplateHints(
    category: keyof typeof TEMPLATE_CATEGORY_DIRS | 'freePlayer' | 'paidPlayer' | 'landing' = 'freePlayer',
    maxFiles = 2,
    maxEach = 3500
): LoadedTemplateHint[] {
    const root = resolveTemplatesRoot();
    if (!root) {
        return [];
    }
    const names = TEMPLATE_CATEGORY_DIRS[category] || TEMPLATE_CATEGORY_DIRS.freePlayer;
    const dirName = names.find(n => fs.existsSync(path.join(root, n)));
    if (!dirName) {
        return [];
    }
    const files = listHtmlFiles(path.join(root, dirName));
    // предпочесть имена с «норм», free, video
    files.sort((a, b) => {
        const score = (p: string) => {
            const n = path.basename(p).toLowerCase();
            if (/норм|normal|free|good|ok/.test(n)) {
                return 0;
            }
            if (/video|плеер|player/.test(n)) {
                return 1;
            }
            return 2;
        };
        return score(a) - score(b) || a.length - b.length;
    });

    const out: LoadedTemplateHint[] = [];
    for (const file of files.slice(0, maxFiles)) {
        let html: string;
        try {
            html = fs.readFileSync(file, 'utf8');
        } catch {
            continue;
        }
        if (html.length < 40) {
            continue;
        }
        out.push({
            category: String(category),
            file: path.basename(file),
            fragment: extractTemplateFragment(html, maxEach)
        });
    }
    return out;
}

/** Текст для system/user prompt Ollama. */
export function formatTemplateHintsForPrompt(hints: LoadedTemplateHint[]): string {
    if (!hints.length) {
        return '';
    }
    const parts = hints.map(
        (h, i) =>
            `### Example ${i + 1} (${h.category}: ${h.file}) — GOOD / reference structure\n${h.fragment}`
    );
    return (
        `\n\nUser-provided Adway templates (use as reference for what the FREE player / section SHOULD look like. ` +
        `Do NOT copy the whole example; only use it to recognize OLD players to remove and the target shape):\n\n` +
        parts.join('\n\n')
    );
}
