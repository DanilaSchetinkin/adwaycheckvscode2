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
};

export type CleanupResult = {
    html: string;
    removedTargets: number;
    flattenedPictures: number;
    replacedHrefs: number;
    removedComments: number;
    movedLinks: number;
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
        moveLinksToHead: doMoveLinks = true
    } = options;

    let current = html;
    let removedTargets = 0;
    let flattenedPictures = 0;
    let replacedHrefs = 0;
    let removedComments = 0;
    let movedLinks = 0;

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
        movedLinks
    };
}
