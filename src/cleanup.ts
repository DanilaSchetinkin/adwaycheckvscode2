/**
 * Cleanup лендинга: target, picture→img, normalize href, комментарии.
 */

import { normalizeAnchorHrefs } from './normalizeHrefs';

export type CleanupOptions = {
    removeTarget?: boolean;
    removePictureSource?: boolean;
    normalizeHrefs?: boolean;
    removeComments?: boolean;
};

export type CleanupResult = {
    html: string;
    removedTargets: number;
    flattenedPictures: number;
    replacedHrefs: number;
    removedComments: number;
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
        // убрать лишние пустые строки после вырезания
        next = next.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
    }
    return { html: next, removed };
}

export function cleanupLanding(html: string, options: CleanupOptions = {}): CleanupResult {
    const {
        removeTarget = true,
        removePictureSource = true,
        normalizeHrefs = true,
        removeComments = false
    } = options;

    let current = html;
    let removedTargets = 0;
    let flattenedPictures = 0;
    let replacedHrefs = 0;
    let removedComments = 0;

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

    return {
        html: current,
        removedTargets,
        flattenedPictures,
        replacedHrefs,
        removedComments
    };
}
