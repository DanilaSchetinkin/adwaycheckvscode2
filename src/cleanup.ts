/**
 * Cleanup лендинга: target, picture→img, normalize href.
 */

import { normalizeAnchorHrefs } from './normalizeHrefs';

export type CleanupOptions = {
    removeTarget?: boolean;
    removePictureSource?: boolean;
    normalizeHrefs?: boolean;
};

export type CleanupResult = {
    html: string;
    removedTargets: number;
    flattenedPictures: number;
    replacedHrefs: number;
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

export function cleanupLanding(html: string, options: CleanupOptions = {}): CleanupResult {
    const {
        removeTarget = true,
        removePictureSource = true,
        normalizeHrefs = true
    } = options;

    let current = html;
    let removedTargets = 0;
    let flattenedPictures = 0;
    let replacedHrefs = 0;

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

    return { html: current, removedTargets, flattenedPictures, replacedHrefs };
}
