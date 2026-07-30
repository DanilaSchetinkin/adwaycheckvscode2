/**
 * Заменяет href у <a> на "#".
 * Не трогает: <link>, {offer}, уже "#", tel:/mailto:.
 * javascript:void(0) и подобные — заменяются на "#".
 */

const PRESERVE_PREFIXES = ['tel:', 'mailto:'];

export function shouldPreserveHref(href: string): boolean {
    if (href === '#' || href === '{offer}') {
        return true;
    }
    return PRESERVE_PREFIXES.some(p => href === p || href.startsWith(p));
}

export type NormalizeHrefsResult = {
    html: string;
    replaced: number;
};

/**
 * Только теги <a … href="…">. <link rel="stylesheet" href="…"> и прочие не затрагиваются.
 */
export function normalizeAnchorHrefs(html: string): NormalizeHrefsResult {
    let replaced = 0;

    const next = html.replace(
        /<a\b([^>]*?)\bhref\s*=\s*(["'])([^"']*)\2([^>]*)>/gi,
        (full, before: string, quote: string, href: string, after: string) => {
            if (shouldPreserveHref(href)) {
                return full;
            }
            replaced += 1;
            return `<a${before}href=${quote}#${quote}${after}>`;
        }
    );

    return { html: next, replaced };
}
