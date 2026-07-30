import type { CheckResult } from './checker';

type PushFn = (
    results: CheckResult[],
    success: boolean | 'warning',
    text: string,
    html?: string,
    search?: string
) => void;

function stripComments(code: string): string {
    return code
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
        .trim();
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Имена function foo / window.foo = function / const foo = function */
function extractDeclaredFunctionNames(code: string): string[] {
    const names = new Set<string>();
    const patterns = [
        /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g,
        /\b(?:window|self|globalThis)\s*\.\s*([A-Za-z_$][\w$]*)\s*=\s*function\b/g,
        /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*function\b/g,
        /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*\([^)]*\)\s*=>/g
    ];
    for (const re of patterns) {
        let m: RegExpExecArray | null;
        while ((m = re.exec(code)) !== null) {
            names.add(m[1]);
        }
    }
    return [...names];
}

/** Сколько раз имя встречается как идентификатор во всём HTML. */
function countIdentifierOccurrences(name: string, haystack: string): number {
    const re = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'g');
    return (haystack.match(re) || []).length;
}

/**
 * Эвристика «мусорных» скриптов (warning):
 * - пустой / только комментарии inline <script>
 * - дублирующийся script[src]
 * - function объявлена и больше нигде не встречается (в т.ч. window.onload = onLoad)
 */
export function checkUnusedScripts(
    document: Document,
    results: CheckResult[],
    html: string,
    push: PushFn
): void {
    const scripts = Array.from(document.querySelectorAll('script'));

    const srcCounts = new Map<string, number>();
    for (const s of scripts) {
        const src = (s.getAttribute('src') || '').trim();
        if (!src || src.startsWith('data:')) {
            continue;
        }
        srcCounts.set(src, (srcCounts.get(src) || 0) + 1);
    }
    for (const [src, count] of srcCounts) {
        if (count > 1) {
            push(
                results,
                'warning',
                `⚠️ Дублирующийся скрипт (${count}×): <span class="value-highlight">"${src}"</span>`,
                html,
                src
            );
        }
    }

    const inlineEntries: Array<{ code: string; search: string; index: number }> = [];

    scripts.forEach((s, index) => {
        if (s.getAttribute('src')) {
            return;
        }
        const raw = s.textContent || '';
        const code = stripComments(raw);
        const search = raw.trim().slice(0, 40) || `<script`;

        if (!code) {
            push(
                results,
                'warning',
                `⚠️ Пустой <script> #${index + 1} (нет кода или только комментарии) — можно удалить`,
                html,
                search.length > 5 ? search : '<script'
            );
            return;
        }

        inlineEntries.push({ code, search, index });
    });

    for (const { code, search } of inlineEntries) {
        const names = extractDeclaredFunctionNames(code);
        for (const name of names) {
            if (name.length < 3 || /^(if|for|var|let|get|set)$/i.test(name)) {
                continue;
            }

            // >1: объявление + использование (onload = onLoad, onclick="onLoad()", вызов…)
            const occurrences = countIdentifierOccurrences(name, html);
            if (occurrences <= 1) {
                push(
                    results,
                    'warning',
                    `⚠️ Возможно неиспользуемая функция <span class="value-highlight">${name}()</span> в <script>`,
                    html,
                    search.includes(name) ? `function ${name}` : search
                );
            }
        }
    }
}
