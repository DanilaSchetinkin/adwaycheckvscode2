/**
 * Заменяет href у <a> на "#".
 * Не трогает: <link>, {offer}, уже "#", tel:/mailto:.
 * javascript:… (в т.ч. с кавычками внутри) — заменяется на "#".
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
 * Только теги <a … href="…">.
 * Кавычки в значении (javascript:…('…')) обрабатываются корректно.
 */
export function normalizeAnchorHrefs(html: string): NormalizeHrefsResult {
    let replaced = 0;

    // (?!\2).)* — всё до закрывающей кавычки того же типа (не [^"']*)
    const next = html.replace(
        /<a\b([^>]*?)\bhref\s*=\s*(["'])((?:(?!\2)[\s\S])*)\2([^>]*)>/gi,
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
