/**
 * Cleanup лендинга: target, picture→img, normalize href, комментарии, link→head.
 */

import { normalizeAnchorHrefs } from './normalizeHrefs';

export type CleanupOptions = {
    removeTarget?: boolean;
    removePictureSource?: boolean;
    normalizeHrefs?: boolean;
    removeComments?: boolean;
    /** Перенести <link> из body (и вне head) в </head> */
    moveLinksToHead?: boolean;
    /** dtime_nums оставить/вставить, дату текстом убрать */
    fixDtimeDates?: boolean;
    /** @deprecated = fixDtimeDates */
    removeDtimeDates?: boolean;
};

export type CleanupResult = {
    html: string;
    removedTargets: number;
    flattenedPictures: number;
    replacedHrefs: number;
    removedComments: number;
    movedLinks: number;
    /** Сколько дат текстом убрано / заменено на dtime_nums */
    fixedDtimeDates: number;
    /** @deprecated alias */
    removedDtimeDates: number;
};

/** Удаляет атрибут target="…" / target='…' со всех тегов. */
export function removeTargetAttributes(html: string): { html: string; removed: number } {
    let removed = 0;
    const next = html.replace(/\s+target\s*=\s*(["'][^"']*["']|[^\s>]+)/gi, () => {
        removed += 1;
        return '';
    });
    return { html: next, removed };
}

/**
 * В <picture> удаляет все <source>, оставляет <img> (и прочий контент кроме source).
 * Сам тег <picture> сохраняется.
 */
export function flattenPictureSources(html: string): { html: string; flattened: number } {
    let flattened = 0;
    const next = html.replace(
        /<picture\b([^>]*)>([\s\S]*?)<\/picture>/gi,
        (full, attrs: string, inner: string) => {
            if (!/<source\b/i.test(inner)) {
                return full;
            }
            flattened += 1;
            const withoutSource = inner.replace(/<source\b[^>]*\/?>/gi, '');
            return `<picture${attrs}>${withoutSource}</picture>`;
        }
    );
    return { html: next, flattened };
}

/**
 * Удаляет HTML-комментарии <!-- … --> (в т.ч. закомментированные блоки кода).
 * Не трогает содержимое строк внутри <script>/<style> как JS/CSS — только разметку <!-- -->.
 */
export function removeHtmlComments(html: string): { html: string; removed: number } {
    let removed = 0;
    let next = html.replace(/<!--[\s\S]*?-->/g, () => {
        removed += 1;
        return '';
    });
    if (removed > 0) {
        next = next.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
    }
    return { html: next, removed };
}

/** Дата вида 7.8.2026 / 07.08.2026 */
const HARDCODED_DATE = /^\d{1,2}\.\d{1,2}\.\d{4}/;
const HARDCODED_DATE_GLOBAL = /\d{1,2}\.\d{1,2}\.\d{4}/g;

/** Стандартный вызов Adway (динамическая дата). */
export const DTIME_SCRIPT = '<script>dtime_nums(-8, true)</script>';

export type DtimeDateBlock = {
    start: number;
    end: number;
    text: string;
    hasDate: boolean;
    /** Только тег <script>…</script> без хвоста-даты */
    scriptHtml: string;
};

/**
 * Блоки <script>…dtime_nums(…)</script> и примыкающая дата (та же / следующая строка).
 * Примеры:
 *   <script>dtime_nums(-8, true)</script>07.08.2026
 *   <script>dtime_nums(-8, true)</script>\n07.08.2026
 */
export function findDtimeDateBlocks(html: string): DtimeDateBlock[] {
    const out: DtimeDateBlock[] = [];
    const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let m: RegExpExecArray | null;
    while ((m = scriptRe.exec(html)) !== null) {
        const body = m[2] || '';
        if (!/dtime_nums\s*\(/i.test(body)) {
            continue;
        }
        // не трогаем внешние <script src="…">
        if (/\bsrc\s*=/i.test(m[1] || '')) {
            continue;
        }
        const scriptHtml = m[0];
        let end = m.index + m[0].length;
        let hasDate = false;
        const after = html.slice(end);
        const ws = after.match(/^[\s\u00a0]*/);
        const wsLen = ws ? ws[0].length : 0;
        const dateMatch = after.slice(wsLen).match(HARDCODED_DATE);
        if (dateMatch) {
            end += wsLen + dateMatch[0].length;
            hasDate = true;
            const tail = html.slice(end).match(/^[ \t]+(?=\r?\n|$)/);
            if (tail) {
                end += tail[0].length;
            }
        }
        out.push({
            start: m.index,
            end,
            text: html.slice(m.index, end),
            hasDate,
            scriptHtml
        });
    }
    return out;
}

/**
 * Нужное поведение Adway:
 * - скрипт dtime_nums ОСТАВИТЬ / ВСТАВИТЬ
 * - дату текстом (07.08.2026) УДАЛИТЬ
 *
 * 1) `<script>dtime_nums(…)</script>07.08.2026` → оставить только script
 * 2) голая дата `07.08.2026` в тексте (не в теге/атрибуте) → заменить на dtime_nums
 */
export function fixDtimeDates(html: string): {
    html: string;
    /** Сколько правок (дат убрано / заменено) */
    fixed: number;
    datesRemoved: number;
    scriptsInserted: number;
} {
    let next = html;
    let datesRemoved = 0;
    let scriptsInserted = 0;

    // 1) у dtime_nums срезать только хвост-дату
    const blocks = findDtimeDateBlocks(next);
    for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i];
        if (!b.hasDate) {
            continue;
        }
        next = next.slice(0, b.start) + b.scriptHtml + next.slice(b.end);
        datesRemoved += 1;
    }

    // 2) голые даты в тексте → dtime_nums (не трогаем атрибуты, скрипты, стили, комментарии)
    const protectedRanges = findProtectedRanges(next);
    const replacements: Array<{ start: number; end: number }> = [];
    HARDCODED_DATE_GLOBAL.lastIndex = 0;
    let dm: RegExpExecArray | null;
    while ((dm = HARDCODED_DATE_GLOBAL.exec(next)) !== null) {
        const start = dm.index;
        const end = start + dm[0].length;
        if (protectedRanges.some(r => start >= r.start && end <= r.end)) {
            continue;
        }
        // уже сразу после dtime_nums — не дублировать (на случай остатков)
        const before = next.slice(Math.max(0, start - 80), start);
        if (/dtime_nums\s*\([^)]*\)\s*<\/script>\s*$/i.test(before.replace(/\s+/g, ' '))) {
            continue;
        }
        // не трогать куски внутри URL / длинных чисел
        const prev = start > 0 ? next[start - 1] : '';
        const nextCh = end < next.length ? next[end] : '';
        if (/\d/.test(prev) || /\d/.test(nextCh)) {
            continue;
        }
        replacements.push({ start, end });
    }

    for (let i = replacements.length - 1; i >= 0; i--) {
        const r = replacements[i];
        next = next.slice(0, r.start) + DTIME_SCRIPT + next.slice(r.end);
        datesRemoved += 1;
        scriptsInserted += 1;
    }

    if (datesRemoved || scriptsInserted) {
        next = next.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
    }

    return {
        html: next,
        fixed: datesRemoved,
        datesRemoved,
        scriptsInserted
    };
}

/** @deprecated используйте fixDtimeDates — больше не удаляет dtime_nums */
export function removeDtimeDates(html: string): { html: string; removed: number; withDate: number } {
    const r = fixDtimeDates(html);
    return { html: r.html, removed: r.fixed, withDate: r.datesRemoved };
}

function findProtectedRanges(html: string): Array<{ start: number; end: number }> {
    const ranges: Array<{ start: number; end: number }> = [];
    const addAll = (re: RegExp) => {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(html)) !== null) {
            ranges.push({ start: m.index, end: m.index + m[0].length });
        }
    };
    addAll(/<!--[\s\S]*?-->/g);
    addAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi);
    addAll(/<style\b[^>]*>[\s\S]*?<\/style>/gi);
    // целиком открывающие теги с атрибутами (даты в value= не трогаем)
    addAll(/<[a-zA-Z][^>]*>/g);
    return ranges;
}

function findHeadRange(html: string): { start: number; end: number } | null {
    const headOpen = html.match(/<head\b[^>]*>/i);
    const headCloseIdx = html.search(/<\/head>/i);
    if (!headOpen || headOpen.index === undefined || headCloseIdx < 0) {
        return null;
    }
    return {
        start: headOpen.index + headOpen[0].length,
        end: headCloseIdx
    };
}

/** Сколько <link> стоят вне <head>. */
export function countLinksOutsideHead(html: string): number {
    const head = findHeadRange(html);
    const linkRe = /<link\b[^>]*\/?>/gi;
    let n = 0;
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(html)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        const insideHead = head !== null && start >= head.start && end <= head.end;
        if (!insideHead) {
            n += 1;
        }
    }
    return n;
}

/**
 * Все <link …> вне <head> переносит перед </head>.
 * Порядок сохранён. Если <head> нет — создаёт минимальный перед <body> / в начале.
 */
export function moveLinksToHead(html: string): { html: string; moved: number } {
    const head = findHeadRange(html);
    const linkRe = /<link\b[^>]*\/?>/gi;
    const ranges: Array<{ start: number; end: number; tag: string }> = [];
    let m: RegExpExecArray | null;

    while ((m = linkRe.exec(html)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        const insideHead = head !== null && start >= head.start && end <= head.end;
        if (insideHead) {
            continue;
        }
        ranges.push({ start, end, tag: m[0] });
    }

    if (ranges.length === 0) {
        return { html, moved: 0 };
    }

    const toMove = ranges.map(r => r.tag);
    let next = html;
    for (let i = ranges.length - 1; i >= 0; i--) {
        const r = ranges[i];
        let cutEnd = r.end;
        if (next[cutEnd] === '\r') {
            cutEnd += 1;
        }
        if (next[cutEnd] === '\n') {
            cutEnd += 1;
        }
        next = next.slice(0, r.start) + next.slice(cutEnd);
    }

    const block = toMove.map(t => `  ${t}`).join('\n') + '\n';

    if (/<\/head>/i.test(next)) {
        next = next.replace(/<\/head>/i, `${block}</head>`);
    } else if (/<body\b/i.test(next)) {
        next = next.replace(/<body\b/i, `<head>\n${block}</head>\n<body`);
    } else {
        next = `<head>\n${block}</head>\n` + next;
    }

    return { html: next, moved: toMove.length };
}

export function cleanupLanding(html: string, options: CleanupOptions = {}): CleanupResult {
    const {
        removeTarget = true,
        removePictureSource = true,
        normalizeHrefs = true,
        removeComments = false,
        moveLinksToHead: doMoveLinks = true,
        fixDtimeDates: doFixDtimeOpt,
        removeDtimeDates: doRemoveDtimeLegacy
    } = options;
    const doFixDtime = doFixDtimeOpt ?? doRemoveDtimeLegacy ?? true;

    let current = html;
    let removedTargets = 0;
    let flattenedPictures = 0;
    let replacedHrefs = 0;
    let removedComments = 0;
    let movedLinks = 0;
    let fixedDtimeDates = 0;

    if (doFixDtime) {
        const r = fixDtimeDates(current);
        current = r.html;
        fixedDtimeDates = r.fixed;
    }

    if (removeComments) {
        const r = removeHtmlComments(current);
        current = r.html;
        removedComments = r.removed;
    }

    if (removeTarget) {
        const r = removeTargetAttributes(current);
        current = r.html;
        removedTargets = r.removed;
    }

    if (removePictureSource) {
        const r = flattenPictureSources(current);
        current = r.html;
        flattenedPictures = r.flattened;
    }

    if (normalizeHrefs) {
        const r = normalizeAnchorHrefs(current);
        current = r.html;
        replacedHrefs = r.replaced;
    }

    if (doMoveLinks) {
        const r = moveLinksToHead(current);
        current = r.html;
        movedLinks = r.moved;
    }

    return {
        html: current,
        removedTargets,
        flattenedPictures,
        replacedHrefs,
        removedComments,
        movedLinks,
        fixedDtimeDates,
        removedDtimeDates: fixedDtimeDates
    };
}
