/** Типы и лёгкие хелперы без vscode/jsdom — безопасно грузить при activate и в worker. */

/** true = ok, false = error, 'warning' = warning (как в Chrome) */
export type CheckSuccess = boolean | 'warning';

/** Совпадает с vscode.DiagnosticSeverity (Error=0, Warning=1) */
export const CHECK_SEVERITY_ERROR = 0;
export const CHECK_SEVERITY_WARNING = 1;

export interface CheckResult {
    success: CheckSuccess;
    text: string;
    /** 0-based line for Problems / jump */
    line?: number;
    /**
     * Относительный путь от папки HTML (напр. css/style.css).
     * Если задан — переход из панели открывает этот файл, а не HTML.
     */
    file?: string;
    severity?: number;
}

export interface SidValidationResult {
    ok: boolean;
    error?: string;
    expectedCountry?: string;
}

export interface CheckerOptions {
    whitelist?: string[];
    /** Если не задан — SID/Country через Sheets пропускается (шаг 2) */
    validateSidCountry?: (sid: string, country: string) => Promise<SidValidationResult>;
    /** Сериализуемая замена callback для child process */
    sidCountryMap?: Record<string, string>;
    /** Если не задан — глубокий разбор содержимого внешних CSS/JS пропускается */
    fetchResource?: (url: string) => Promise<string | null>;
    baseUrl?: string;
    /** Папка HTML-файла для проверки локальных путей */
    htmlDir?: string;
    /** Проверять существование локальных src/href/srcset */
    checkLocalPaths?: boolean;
    /** Варнинг на <picture> с <source> */
    warnPictureSource?: boolean;
    /** Эвристика неиспользуемых/пустых/дублирующихся скриптов */
    checkUnusedScripts?: boolean;
}

export const DEFAULT_LINK_WHITELIST = [
    'static.joxi.pro',
    'static.cloudflareinsights.com',
    'cloudflareinsights.com',
    'github.com',
    'www.w3.org',
    'converteai.net',
    'vturb.com'
];

export function stripHtml(text: string): string {
    return text
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&');
}

export type FormRange = { start: number; end: number };

/** Диапазоны <form>…</form> в исходном HTML (по порядку, с учётом вложенности). */
export function findFormRanges(html: string): FormRange[] {
    const ranges: FormRange[] = [];
    const re = /<\/?form\b[^>]*>/gi;
    const stack: number[] = [];
    let match: RegExpExecArray | null;
    while ((match = re.exec(html)) !== null) {
        const tag = match[0];
        if (/^<form\b/i.test(tag)) {
            stack.push(match.index);
        } else if (stack.length > 0) {
            const start = stack.pop()!;
            ranges.push({ start, end: match.index + tag.length });
        }
    }
    return ranges;
}
