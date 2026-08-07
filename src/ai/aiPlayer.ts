import {
    buildVideoHtmlBlock,
    describePreservedTexts,
    extractVideoBlockTexts
} from '../videoTemplates';
import { CssFileCleanup, scanAndCleanPlayerCss } from './cssPlayerCleanup';
import { checkOllamaAvailable, getOllamaConfig, ollamaChat } from './ollamaClient';
import { formatTemplateHintsForPrompt, loadTemplateHints } from './templatesLoader';

export type PlayerDetectResult = {
    /** Найденный фрагмент HTML (секция / обёртка целиком, если удалось расширить) */
    snippet: string;
    source: 'rules' | 'ai';
    reason: string;
    cssHints: string[];
    /** true если расширили внутренний блок до <section> / обёртки */
    expanded: boolean;
    wrapTag: string;
};

export type PlayerReplacePlan = {
    detect: PlayerDetectResult;
    htmlAfterReplace: string;
    htmlAfterDelete: string;
    cssCleanups: CssFileCleanup[];
    summaryLines: string[];
};

const SYSTEM = `You are an HTML assistant for Adway landing pages.
Find the OUTERMOST <section> (or major wrapper) that contains the OLD video player
(Hermes, VideoJS, embedpvideo, section-video, iframe player). Prefer a full <section>…</section>.
Do NOT select the Adway free player (#container_video with id="video").
Reply ONLY with valid JSON:
{"snippet":"<exact html substring — full section if possible>","reason":"short","cssHints":[".video-js",".embedpvideo"]}
snippet must be copied EXACTLY from the user HTML. If nothing: {"snippet":"","reason":"none","cssHints":[]}`;

/** Маркеры старого плеера в HTML */
const PLAYER_MARKERS =
    /embedpvideo|data-hermes-video|lv-wrapper|lv-overlay|section-video|video-js|\bvjs-|jwplayer|plyr\.|cdn\.jwplayer|player\.vimeo|youtube\.com\/embed|youtu\.be\//i;

const ADWAY_PLAYER = /id\s*=\s*["']container_video["']/i;

/**
 * Найти сбалансированный элемент по открывающему тегу в позиции openIdx.
 * Учитывает вложенность того же тега. Self-closing не считаем.
 */
export function findMatchingCloseTag(html: string, openIdx: number, tag: string): number | null {
    const openRe = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
    const closeRe = new RegExp(`</${tag}\\s*>`, 'gi');
    const voidClose = new RegExp(`<${tag}\\b[^>]*\\/\\s*>`, 'gi');

    openRe.lastIndex = openIdx;
    const first = openRe.exec(html);
    if (!first || first.index !== openIdx) {
        return null;
    }
    // <div ... /> — редко, но на всякий
    voidClose.lastIndex = openIdx;
    const vc = voidClose.exec(html);
    if (vc && vc.index === openIdx && vc[0].endsWith('/>')) {
        return openIdx + vc[0].length;
    }

    let depth = 1;
    let pos = openIdx + first[0].length;
    while (depth > 0 && pos < html.length) {
        openRe.lastIndex = pos;
        closeRe.lastIndex = pos;
        const nextOpen = openRe.exec(html);
        const nextClose = closeRe.exec(html);
        if (!nextClose) {
            return null;
        }
        if (nextOpen && nextOpen.index < nextClose.index) {
            depth += 1;
            pos = nextOpen.index + nextOpen[0].length;
        } else {
            depth -= 1;
            pos = nextClose.index + nextClose[0].length;
            if (depth === 0) {
                return pos;
            }
        }
    }
    return null;
}

/** Все сбалансированные вхождения <tag ...>...</tag> */
export function findBalancedElements(
    html: string,
    tag: string,
    openFilter?: (openTag: string) => boolean
): Array<{ start: number; end: number; openTag: string }> {
    const openRe = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
    const out: Array<{ start: number; end: number; openTag: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = openRe.exec(html)) !== null) {
        if (openFilter && !openFilter(m[0])) {
            continue;
        }
        const end = findMatchingCloseTag(html, m.index, tag);
        if (end === null) {
            continue;
        }
        out.push({ start: m.index, end, openTag: m[0] });
        // не прыгать внутрь — следующий openRe уже после текущего open;
        // чтобы не дублировать вложенные как «отдельные корни» — ок, вызывающий фильтрует
    }
    return out;
}

function sliceEl(html: string, el: { start: number; end: number }): string {
    return html.slice(el.start, el.end);
}

function isAdwayBlock(snippet: string): boolean {
    // чужие ленды часто ставят id="container_video" на <section> + VideoJS/Hermes
    if (/vjs-|video-js|embedpvideo|data-hermes-video|lv-wrapper/i.test(snippet)) {
        return false;
    }
    return (
        ADWAY_PLAYER.test(snippet) &&
        /id\s*=\s*["']video-overlay["']/i.test(snippet) &&
        /id\s*=\s*["']video["']/i.test(snippet)
    );
}

function hasPlayerMarker(text: string): boolean {
    return PLAYER_MARKERS.test(text) || /<video\b/i.test(text);
}

/**
 * Эвристики без ИИ: баланс тегов + расширение до секции.
 */
export function detectPlayerByRules(html: string): PlayerDetectResult | null {
    // 1) <section class="…section-video…"> целиком (баланс)
    for (const el of findBalancedElements(html, 'section', open =>
        /class\s*=\s*["'][^"']*section-video[^"']*["']/i.test(open)
    )) {
        const snippet = sliceEl(html, el);
        if (snippet.length > 40 && !isAdwayBlock(snippet)) {
            return finishDetect(html, snippet, 'section.section-video (balanced)', false, 'section');
        }
    }

    // 2) любая <section>, внутри которой маркеры старого плеера
    // берём самую маленькую section с маркером
    {
        const sections = findBalancedElements(html, 'section').filter(el => {
            const body = sliceEl(html, el);
            return hasPlayerMarker(body) && !isAdwayBlock(body) && body.length > 40;
        });
        sections.sort((a, b) => a.end - a.start - (b.end - b.start));
        if (sections.length) {
            const preferred =
                sections.find(el => /section-video|video|player|hermes/i.test(el.openTag)) ||
                sections[0];
            return finishDetect(
                html,
                sliceEl(html, preferred),
                'section with player markers (balanced)',
                false,
                'section'
            );
        }
    }

    // 3) div.embedpvideo / data-hermes-video — баланс, потом expand до section
    for (const el of findBalancedElements(
        html,
        'div',
        open => /embedpvideo|data-hermes-video/i.test(open)
    )) {
        const snippet = sliceEl(html, el);
        if (snippet.length > 20 && !isAdwayBlock(snippet)) {
            const expanded = expandToEnclosingSection(html, snippet);
            return finishDetect(
                html,
                expanded.snippet,
                expanded.expanded
                    ? `Hermes embedpvideo → <${expanded.wrapTag}>`
                    : 'Hermes embedpvideo (balanced)',
                expanded.expanded,
                expanded.wrapTag || 'div'
            );
        }
    }

    // 4) div.video-js / id=video + video-js
    for (const el of findBalancedElements(html, 'div', open => /video-js/i.test(open))) {
        const snippet = sliceEl(html, el);
        if (snippet.length > 20 && !isAdwayBlock(snippet)) {
            const expanded = expandToEnclosingSection(html, snippet);
            return finishDetect(
                html,
                expanded.snippet,
                expanded.expanded
                    ? `VideoJS → <${expanded.wrapTag}>`
                    : 'VideoJS wrapper (balanced)',
                expanded.expanded,
                expanded.wrapTag || 'div'
            );
        }
    }

    // 5) div.section-video (иногда не section-тег)
    for (const el of findBalancedElements(html, 'div', open =>
        /class\s*=\s*["'][^"']*section-video[^"']*["']/i.test(open)
    )) {
        const snippet = sliceEl(html, el);
        if (snippet.length > 40 && !isAdwayBlock(snippet)) {
            return finishDetect(html, snippet, 'div.section-video (balanced)', false, 'div');
        }
    }

    // 6) <video> не из Adway — expand до section
    {
        const videoRe = /<video\b[^>]*>/gi;
        let m: RegExpExecArray | null;
        while ((m = videoRe.exec(html)) !== null) {
            const end = findMatchingCloseTag(html, m.index, 'video');
            if (end === null) {
                continue;
            }
            // захватить возможный wrapper: от video вверх
            let snippet = html.slice(m.index, end);
            if (isAdwayBlock(html.slice(Math.max(0, m.index - 500), end + 50))) {
                // рядом container_video — пропуск
                continue;
            }
            const expanded = expandToEnclosingSection(html, snippet);
            snippet = expanded.snippet;
            if (snippet.length > 30) {
                return finishDetect(
                    html,
                    snippet,
                    expanded.expanded
                        ? `bare <video> → <${expanded.wrapTag}>`
                        : 'bare <video>',
                    expanded.expanded,
                    expanded.wrapTag || 'video'
                );
            }
        }
    }

    return null;
}

function finishDetect(
    _html: string,
    snippet: string,
    reason: string,
    expanded: boolean,
    wrapTag: string
): PlayerDetectResult {
    return {
        snippet,
        source: 'rules',
        reason,
        cssHints: guessCssHints(snippet),
        expanded,
        wrapTag
    };
}

/**
 * Расширить найденный кусок до окружающей <section>.
 * Предпочитаем OUTERMOST section с video-маркерами (но не >70% документа).
 */
export function expandToEnclosingSection(
    html: string,
    snippet: string
): { snippet: string; expanded: boolean; wrapTag: string } {
    const idx = html.indexOf(snippet);
    if (idx < 0) {
        return { snippet, expanded: false, wrapTag: '' };
    }
    const end = idx + snippet.length;
    const trimmed = snippet.trim();

    if (/^<section\b/i.test(trimmed) && /<\/section>\s*$/i.test(trimmed)) {
        // уже section, но возможно неполная из-за старого regex — перепроверим баланс
        const openMatch = trimmed.match(/^<section\b[^>]*>/i);
        if (openMatch) {
            const absOpen = idx + (snippet.indexOf(openMatch[0]));
            const bal = findMatchingCloseTag(html, absOpen, 'section');
            if (bal && bal > end) {
                const full = html.slice(absOpen, bal);
                return { snippet: full, expanded: true, wrapTag: 'section' };
            }
        }
        return { snippet, expanded: false, wrapTag: 'section' };
    }

    // Все section, которые полностью содержат [idx, end)
    const wrapping = findBalancedElements(html, 'section').filter(
        el => el.start <= idx && el.end >= end
    );
    if (wrapping.length) {
        const withMarker = wrapping.filter(el => hasPlayerMarker(sliceEl(html, el)));
        const pool = withMarker.length ? withMarker : wrapping;
        // самая маленькая подходящая секция (не page-wrap, если внутри есть меньше)
        const byVideoClass = pool
            .filter(el => /section-video|video|player|hermes/i.test(el.openTag))
            .sort((a, b) => a.end - a.start - (b.end - b.start));
        const chosen =
            byVideoClass[0] ||
            [...pool].sort((a, b) => a.end - a.start - (b.end - b.start))[0];
        const full = sliceEl(html, chosen);
        if (full !== snippet) {
            return { snippet: full, expanded: true, wrapTag: 'section' };
        }
        return { snippet, expanded: false, wrapTag: 'section' };
    }

    // div-обёртка с video-классами — самая маленькая, которая содержит фрагмент
    const divs = findBalancedElements(html, 'div', open =>
        /section-video|embedpvideo|video-js|hermes|player|lv-wrapper/i.test(open)
    ).filter(el => el.start <= idx && el.end >= end);

    if (divs.length) {
        divs.sort((a, b) => a.end - a.start - (b.end - b.start));
        const full = sliceEl(html, divs[0]);
        if (full !== snippet) {
            return { snippet: full, expanded: true, wrapTag: 'div' };
        }
        return { snippet, expanded: false, wrapTag: 'div' };
    }

    return { snippet, expanded: false, wrapTag: guessOpenTag(snippet) };
}

function guessOpenTag(snippet: string): string {
    const m = snippet.trim().match(/^<(\w+)/i);
    return m?.[1]?.toLowerCase() || '';
}

function guessCssHints(snippet: string): string[] {
    const hints = new Set<string>();
    if (/video-js|vjs-/i.test(snippet)) {
        hints.add('.video-js');
        hints.add('.vjs-tech');
    }
    if (/embedpvideo|hermes|lv-wrapper|lv-overlay/i.test(snippet)) {
        hints.add('.embedpvideo');
        hints.add('.lv-wrapper');
        hints.add('.lv-overlay');
        hints.add('.section-video');
    }
    const classRe = /class\s*=\s*["']([^"']+)["']/gi;
    let m: RegExpExecArray | null;
    while ((m = classRe.exec(snippet)) !== null) {
        for (const c of m[1].split(/\s+/)) {
            if (
                /video|player|hermes|vjs|embed|lv-|plyr|jwplayer/i.test(c) &&
                !/^container_video$/i.test(c)
            ) {
                hints.add('.' + c);
            }
        }
    }
    return [...hints].slice(0, 16);
}

function extractJsonObject(text: string): unknown {
    const trimmed = text.trim();
    try {
        return JSON.parse(trimmed);
    } catch {
        const start = trimmed.indexOf('{');
        const end = trimmed.lastIndexOf('}');
        if (start >= 0 && end > start) {
            return JSON.parse(trimmed.slice(start, end + 1));
        }
        throw new Error('Ответ ИИ не JSON');
    }
}

export function shrinkHtmlForAi(html: string, maxLen = 14000): string {
    if (html.length <= maxLen) {
        return html;
    }
    // приоритет: целые section с маркерами
    const chunks: string[] = [];
    for (const el of findBalancedElements(html, 'section')) {
        const s = sliceEl(html, el);
        if (hasPlayerMarker(s)) {
            chunks.push(s);
        }
        if (chunks.join('\n').length > maxLen) {
            break;
        }
    }
    if (chunks.length === 0) {
        const re =
            /<(?:section|div|video|iframe)\b[^>]{0,300}(?:video|player|hermes|embed|vjs|plyr|jwplayer)[^>]*>[\s\S]{0,8000}?<\/(?:section|div|video|iframe)>/gi;
        let m: RegExpExecArray | null;
        while ((m = re.exec(html)) !== null) {
            chunks.push(m[0]);
            if (chunks.join('\n\n').length > maxLen) {
                break;
            }
        }
    }
    if (chunks.length === 0) {
        return html.slice(0, maxLen);
    }
    let out = chunks.join('\n\n<!-- chunk -->\n\n');
    if (out.length > maxLen) {
        out = out.slice(0, maxLen);
    }
    return out;
}

export async function detectPlayerWithAi(html: string): Promise<PlayerDetectResult> {
    const status = await checkOllamaAvailable();
    if (!status.ok) {
        throw new Error(status.message);
    }

    const config = getOllamaConfig();
    const payload = shrinkHtmlForAi(html);
    // Эталоны пользователя: бесплатный плеер (+ при наличии кусок «плохого» из платного — как anti-example не обязательно)
    const freeHints = loadTemplateHints('freePlayer', 2, 3000);
    const paidHints = loadTemplateHints('paidPlayer', 1, 2000);
    const hintBlock =
        formatTemplateHintsForPrompt(freeHints) +
        (paidHints.length
            ? formatTemplateHintsForPrompt(
                  paidHints.map(h => ({ ...h, category: 'paidPlayer (OLD — remove this style)' }))
              )
            : '');

    const system = SYSTEM + hintBlock;
    const raw = await ollamaChat(
        `HTML document fragment:\n\n${payload}` +
            (freeHints.length
                ? `\n\n(Note: ${freeHints.length} user free-player template(s) loaded: ${freeHints
                      .map(h => h.file)
                      .join(', ')})`
                : ''),
        system,
        config
    );
    const parsed = extractJsonObject(raw) as {
        snippet?: string;
        reason?: string;
        cssHints?: string[];
    };
    const snippetRaw = (parsed.snippet || '').trim();
    if (!snippetRaw) {
        return {
            snippet: '',
            source: 'ai',
            reason: parsed.reason || 'ИИ не нашёл блок плеера',
            cssHints: Array.isArray(parsed.cssHints) ? parsed.cssHints : [],
            expanded: false,
            wrapTag: ''
        };
    }

    let exact = snippetRaw;
    if (!html.includes(exact)) {
        const head = snippetRaw.slice(0, Math.min(100, snippetRaw.length));
        const idx = html.indexOf(head);
        if (idx >= 0) {
            // если AI вернул начало section — добрать балансом
            const openSec = html.slice(idx).match(/^<section\b[^>]*>/i);
            if (openSec) {
                const bal = findMatchingCloseTag(html, idx, 'section');
                if (bal) {
                    exact = html.slice(idx, bal);
                }
            } else {
                const openDiv = html.slice(idx).match(/^<div\b[^>]*>/i);
                if (openDiv) {
                    const bal = findMatchingCloseTag(html, idx, 'div');
                    if (bal) {
                        exact = html.slice(idx, bal);
                    }
                }
            }
        }
        if (!html.includes(exact)) {
            throw new Error(
                'ИИ вернул фрагмент, которого нет в HTML (галлюцинация). Попробуйте ещё раз или удалите блок вручную.'
            );
        }
    }

    if (isAdwayBlock(exact) && /js\/video\.js/i.test(html)) {
        return {
            snippet: '',
            source: 'ai',
            reason: 'Похоже на уже установленный Adway #container_video — пропуск',
            cssHints: [],
            expanded: false,
            wrapTag: ''
        };
    }

    const expanded = expandToEnclosingSection(html, exact);
    const hints = [
        ...(Array.isArray(parsed.cssHints) ? parsed.cssHints : []),
        ...guessCssHints(expanded.snippet)
    ];

    return {
        snippet: expanded.snippet,
        source: 'ai',
        reason: expanded.expanded
            ? `${parsed.reason || 'AI'} → целая <${expanded.wrapTag}>`
            : parsed.reason || 'AI detect',
        cssHints: [...new Set(hints)].slice(0, 16),
        expanded: expanded.expanded,
        wrapTag: expanded.wrapTag
    };
}

export function removeSnippet(html: string, snippet: string): string {
    if (!snippet || !html.includes(snippet)) {
        return html;
    }
    let next = html.split(snippet).join('\n');
    next = next.replace(/\n{3,}/g, '\n\n');
    return next;
}

export function replaceSnippet(html: string, snippet: string, replacement: string): string {
    if (!snippet || !html.includes(snippet)) {
        return html;
    }
    let next = html.split(snippet).join(replacement);
    next = next.replace(/\n{3,}/g, '\n\n');
    return next;
}

export function buildPlayerReplacePlan(
    html: string,
    detect: PlayerDetectResult,
    htmlDir?: string,
    mediaSrc = 'media/video.mp4'
): PlayerReplacePlan {
    const preserved = extractVideoBlockTexts(detect.snippet);
    const block = buildVideoHtmlBlock(mediaSrc, preserved) + '\n';
    const htmlAfterReplace = replaceSnippet(html, detect.snippet, block);
    const htmlAfterDelete = removeSnippet(html, detect.snippet);

    const cssCleanups =
        htmlDir && detect.snippet
            ? scanAndCleanPlayerCss(html, htmlDir, detect.cssHints)
            : [];

    const summaryLines: string[] = [];
    summaryLines.push(
        `Блок: ${detect.wrapTag || 'fragment'} · ${detect.source} · ${detect.reason}`
    );
    if (detect.expanded) {
        summaryLines.push('Расширено до окружающей секции/обёртки');
    }
    summaryLines.push(`Размер фрагмента: ~${detect.snippet.length} символов`);
    const textLines = describePreservedTexts(preserved);
    if (textLines.length) {
        summaryLines.push(`Надписи сохранены: ${textLines.join('; ')}`);
    } else {
        summaryLines.push('Надписи: в старом блоке не найдены → дефолт Adway');
    }
    if (cssCleanups.length) {
        const nRules = cssCleanups.reduce((s, c) => s + c.removedSelectors.length, 0);
        summaryLines.push(
            `CSS: ${cssCleanups.length} файл(ов), ~${nRules} селектор(ов) старого плеера`
        );
        for (const c of cssCleanups.slice(0, 4)) {
            summaryLines.push(`  · ${c.fileRel}: ${c.removedSelectors.slice(0, 4).join(', ')}`);
        }
    } else {
        summaryLines.push('CSS: правил старого плеера не найдено (или нет локальных css)');
    }

    return {
        detect,
        htmlAfterReplace,
        htmlAfterDelete,
        cssCleanups,
        summaryLines
    };
}

/** Сначала rules, иначе AI (ошибка AI → понятный пустой результат). */
export async function detectOldPlayer(html: string): Promise<PlayerDetectResult> {
    const byRules = detectPlayerByRules(html);
    if (byRules) {
        return byRules;
    }
    try {
        return await detectPlayerWithAi(html);
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
            snippet: '',
            source: 'ai',
            reason: `Правила не нашли секцию; ИИ: ${msg}`,
            cssHints: [],
            expanded: false,
            wrapTag: ''
        };
    }
}
