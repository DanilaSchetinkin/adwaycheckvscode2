import * as fs from 'fs';
import * as path from 'path';
import {
    buildVideoHtmlBlock,
    buildVideoJs,
    JQUERY_CDN,
    VIDEO_CSS,
    VIDEO_CSS_LINK,
    VIDEO_JS_SCRIPT
} from './videoTemplates';

const VIDEO_EXT = new Set(['.mp4', '.webm', '.ogg', '.mov', '.m4v', '.avi', '.mkv']);
const CANONICAL_MP4 = 'media/video.mp4';

export type SetupVideoResult = {
    html: string;
    moved: string[];
    created: string[];
    notes: string[];
    /** true если в HTML уже был / стал video-блок */
    hasPlayer: boolean;
};

function isVideoFile(name: string): boolean {
    return VIDEO_EXT.has(path.extname(name).toLowerCase());
}

function ensureDir(dir: string, created: string[], label: string): void {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        created.push(label);
    }
}

function uniquePath(dir: string, name: string): string {
    let dest = path.join(dir, name);
    if (!fs.existsSync(dest)) {
        return dest;
    }
    const ext = path.extname(name);
    const base = ext ? name.slice(0, -ext.length) : name;
    let i = 1;
    while (fs.existsSync(dest)) {
        dest = path.join(dir, `${base}_${i}${ext}`);
        i += 1;
    }
    return dest;
}

/**
 * Если есть видео-файлы рядом с HTML (корень) — создать media/ и перенести.
 * Основной mp4 нормализует в media/video.mp4.
 */
export function moveVideosToMedia(
    html: string,
    htmlDir: string
): { html: string; moved: string[]; created: string[]; mediaSrc: string } {
    const moved: string[] = [];
    const created: string[] = [];
    const mediaDir = path.join(htmlDir, 'media');
    let current = html;
    let mediaSrc = CANONICAL_MP4;

    let entries: string[] = [];
    try {
        entries = fs.readdirSync(htmlDir);
    } catch {
        return { html, moved, created, mediaSrc };
    }

    const rootVideos = entries.filter(n => {
        try {
            return isVideoFile(n) && fs.statSync(path.join(htmlDir, n)).isFile();
        } catch {
            return false;
        }
    });

    // уже лежащие в media/
    let mediaVideos: string[] = [];
    if (fs.existsSync(mediaDir)) {
        try {
            mediaVideos = fs
                .readdirSync(mediaDir)
                .filter(n => isVideoFile(n) && fs.statSync(path.join(mediaDir, n)).isFile());
        } catch {
            mediaVideos = [];
        }
    }

    if (rootVideos.length === 0 && mediaVideos.length === 0) {
        return { html, moved, created, mediaSrc };
    }

    ensureDir(mediaDir, created, 'media/');

    // перенос из корня
    for (const name of rootVideos) {
        const from = path.join(htmlDir, name);
        const preferred =
            rootVideos.length === 1 && path.extname(name).toLowerCase() === '.mp4'
                ? path.join(mediaDir, 'video.mp4')
                : uniquePath(mediaDir, name.toLowerCase() === 'video.mp4' ? 'video.mp4' : name);
        const dest =
            preferred.endsWith(`${path.sep}video.mp4`) && !fs.existsSync(preferred)
                ? preferred
                : name.toLowerCase() === 'video.mp4' ||
                    (rootVideos.length === 1 && path.extname(name).toLowerCase() === '.mp4')
                  ? fs.existsSync(path.join(mediaDir, 'video.mp4'))
                      ? uniquePath(mediaDir, 'video.mp4')
                      : path.join(mediaDir, 'video.mp4')
                  : uniquePath(mediaDir, name);

        try {
            fs.renameSync(from, dest);
        } catch {
            try {
                fs.copyFileSync(from, dest);
                fs.unlinkSync(from);
            } catch {
                continue;
            }
        }
        const destName = path.basename(dest);
        const destRel = `media/${destName}`.replace(/\\/g, '/');
        moved.push(`${name} → ${destRel}`);
        // переписать пути в HTML
        const variants = [name, `./${name}`, name.replace(/\\/g, '/')];
        for (const fromPath of variants) {
            if (current.includes(fromPath)) {
                current = current.split(fromPath).join(destRel);
            }
        }
    }

    // нормализовать существующий media/*.mp4 → media/video.mp4 если один mp4
    try {
        mediaVideos = fs
            .readdirSync(mediaDir)
            .filter(n => isVideoFile(n) && fs.statSync(path.join(mediaDir, n)).isFile());
    } catch {
        mediaVideos = [];
    }

    const mp4s = mediaVideos.filter(n => path.extname(n).toLowerCase() === '.mp4');
    const canonicalFull = path.join(mediaDir, 'video.mp4');
    if (mp4s.length === 1 && mp4s[0].toLowerCase() !== 'video.mp4') {
        const oldName = mp4s[0];
        const oldFull = path.join(mediaDir, oldName);
        try {
            if (fs.existsSync(canonicalFull)) {
                // уже есть video.mp4 — оставить оба, src на существующий
            } else {
                fs.renameSync(oldFull, canonicalFull);
                const oldRel = `media/${oldName}`.replace(/\\/g, '/');
                moved.push(`${oldRel} → ${CANONICAL_MP4}`);
                if (current.includes(oldRel)) {
                    current = current.split(oldRel).join(CANONICAL_MP4);
                }
                if (current.includes(`./${oldRel}`)) {
                    current = current.split(`./${oldRel}`).join(CANONICAL_MP4);
                }
                // case: media/Video.mp4
                const caseRel = `media/${oldName}`;
                if (caseRel !== oldRel && current.toLowerCase().includes(oldRel.toLowerCase())) {
                    current = current.replace(new RegExp(escapeRegExp(oldRel), 'gi'), CANONICAL_MP4);
                }
            }
        } catch {
            // ignore
        }
    } else if (mp4s.some(n => n.toLowerCase() === 'video.mp4') && !fs.existsSync(canonicalFull)) {
        // Windows case: Video.mp4 → video.mp4
        const found = mp4s.find(n => n.toLowerCase() === 'video.mp4')!;
        if (found !== 'video.mp4') {
            try {
                const tmp = path.join(mediaDir, '__adway_video_tmp.mp4');
                fs.renameSync(path.join(mediaDir, found), tmp);
                fs.renameSync(tmp, canonicalFull);
                moved.push(`media/${found} → ${CANONICAL_MP4}`);
                current = current.replace(new RegExp(`media/${escapeRegExp(found)}`, 'gi'), CANONICAL_MP4);
            } catch {
                // ignore
            }
        }
    }

    if (fs.existsSync(canonicalFull)) {
        mediaSrc = CANONICAL_MP4;
        // любые media/*.mp4 / Video.mp4 в HTML → media/video.mp4
        current = current.replace(
            /media\/[^"'>\s]+\.mp4/gi,
            m => (m.toLowerCase() === CANONICAL_MP4 ? CANONICAL_MP4 : CANONICAL_MP4)
        );
    } else if (mp4s.length > 0) {
        mediaSrc = `media/${mp4s[0]}`.replace(/\\/g, '/');
    }

    return { html: current, moved, created, mediaSrc };
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ensureHeadLinks(html: string): string {
    let next = html;

    const insertInHead = (tag: string): void => {
        const chunk = `  ${tag.trim()}\n`;
        if (/<\/head>/i.test(next)) {
            next = next.replace(/<\/head>/i, (m) => {
                // не прилипать к предыдущему тегу в одной строке
                return `\n${chunk}${m}`;
            });
            return;
        }
        if (/<head\b[^>]*>/i.test(next)) {
            next = next.replace(/<head\b[^>]*>/i, (m) => `${m}\n${chunk}`);
            return;
        }
        if (/<html\b[^>]*>/i.test(next)) {
            next = next.replace(/<html\b[^>]*>/i, (m) => `${m}\n<head>\n${chunk}</head>\n`);
            return;
        }
        next = `<head>\n${chunk}</head>\n` + next;
    };

    if (!/jquery[.\-/].*3\.6\.0/i.test(next) && !/cdnjs\.cloudflare\.com\/ajax\/libs\/jquery\/3\.6\.0/i.test(next)) {
        insertInHead(JQUERY_CDN);
    }
    if (!/href\s*=\s*["']css\/video\.css["']/i.test(next)) {
        insertInHead(VIDEO_CSS_LINK);
    }
    if (!/src\s*=\s*["']js\/video\.js["']/i.test(next)) {
        if (/<\/body>/i.test(next)) {
            const needNl = !/\n\s*$/.test(next.slice(0, next.toLowerCase().lastIndexOf('</body>')));
            next = next.replace(/<\/body>/i, `${needNl ? '\n' : ''}  ${VIDEO_JS_SCRIPT.trim()}\n</body>`);
        } else if (/<\/head>/i.test(next)) {
            insertInHead(VIDEO_JS_SCRIPT);
        } else {
            next = next + '\n' + VIDEO_JS_SCRIPT.trim() + '\n';
        }
    }
    return next;
}

function writeAssetFiles(htmlDir: string, created: string[], showForm: number): void {
    const cssDir = path.join(htmlDir, 'css');
    const jsDir = path.join(htmlDir, 'js');
    ensureDir(cssDir, created, 'css/');
    ensureDir(jsDir, created, 'js/');

    const cssPath = path.join(cssDir, 'video.css');
    const jsPath = path.join(jsDir, 'video.js');
    if (!fs.existsSync(cssPath)) {
        fs.writeFileSync(cssPath, VIDEO_CSS, 'utf8');
        created.push('css/video.css');
    }
    // video.js всегда обновляем к шаблону при setup
    fs.writeFileSync(jsPath, buildVideoJs(showForm), 'utf8');
    if (!created.includes('js/video.js')) {
        created.push('js/video.js');
    }
}

/** Hermes / VideoJS / голый video → Adway #container_video */
function replacePlayerBlocks(html: string, mediaSrc: string): { html: string; replaced: boolean } {
    let next = html;
    let replaced = false;

    // VideoJS wrapper: <div ... class="...video-js..." id="video"...>...</div>
    const vjsRe =
        /<div\b[^>]*(?:class\s*=\s*["'][^"']*video-js[^"']*["'][^>]*id\s*=\s*["']video["']|id\s*=\s*["']video["'][^>]*class\s*=\s*["'][^"']*video-js[^"']*["'])[^>]*>[\s\S]*?<\/div>\s*(?:<\/div>\s*)?/i;
    if (vjsRe.test(next)) {
        next = next.replace(vjsRe, () => {
            replaced = true;
            return buildVideoHtmlBlock(mediaSrc) + '\n';
        });
    }

    // Hermes
    if (!replaced && /embedpvideo|data-hermes-video|lv-wrapper/i.test(next)) {
        const sectionRe = /<section\b[^>]*class\s*=\s*["'][^"']*section-video[^"']*["'][^>]*>[\s\S]*?<\/section>/i;
        if (sectionRe.test(next)) {
            next = next.replace(sectionRe, () => {
                replaced = true;
                return buildVideoHtmlBlock(mediaSrc) + '\n';
            });
        } else {
            const embedRe = /<div\b[^>]*(?:embedpvideo|data-hermes-video)[^>]*>[\s\S]*?<\/div>/i;
            if (embedRe.test(next)) {
                next = next.replace(embedRe, () => {
                    replaced = true;
                    return buildVideoHtmlBlock(mediaSrc) + '\n';
                });
            }
        }
    }

    // уже есть container_video — только поправить source
    if (/id\s*=\s*["']container_video["']/i.test(next)) {
        next = next.replace(
            /(<source\b[^>]*\bsrc\s*=\s*["'])([^"']+)(["'][^>]*>)/gi,
            (full, a, src, c) => {
                if (/\.mp4($|\?)/i.test(src) || /media\//i.test(src)) {
                    replaced = true;
                    return `${a}${mediaSrc}${c}`;
                }
                return full;
            }
        );
        next = next.replace(
            /(<video\b[^>]*\bsrc\s*=\s*["'])([^"']+)(["'])/gi,
            (full, a, src, c) => {
                if (/\.mp4($|\?)/i.test(src)) {
                    replaced = true;
                    return `${a}${mediaSrc}${c}`;
                }
                return full;
            }
        );
        // убрать controls, добавить id=video если нет
        next = next.replace(/<video\b([^>]*)>/gi, (full, attrs: string) => {
            let a = attrs.replace(/\scontrols\b(=["'][^"']*["'])?/gi, '');
            if (!/\bid\s*=/i.test(a)) {
                a = ` id="video"${a}`;
            } else if (!/\bid\s*=\s*["']video["']/i.test(a)) {
                a = a.replace(/\bid\s*=\s*(["'])[^"']*\1/i, 'id="video"');
            }
            if (!/\bmuted\b/i.test(a)) {
                a += ' muted';
            }
            if (!/\bplaysinline\b/i.test(a)) {
                a += ' playsinline';
            }
            if (!/\bautoplay\b/i.test(a)) {
                a += ' autoplay';
            }
            replaced = true;
            return `<video${a}>`;
        });
        return { html: next, replaced: true };
    }

    // голый <video>...</video>
    const bareVideoRe = /<video\b[^>]*>[\s\S]*?<\/video>/i;
    if (!replaced && bareVideoRe.test(next)) {
        next = next.replace(bareVideoRe, () => {
            replaced = true;
            return buildVideoHtmlBlock(mediaSrc);
        });
    }

    // нет video вообще, но есть media файл — вставить перед формой или перед </body>
    if (!replaced && !/<video\b/i.test(next)) {
        const block = buildVideoHtmlBlock(mediaSrc) + '\n';
        if (/<form\b/i.test(next)) {
            next = next.replace(/<form\b/i, `${block}\n<form`);
            replaced = true;
        } else if (/<\/body>/i.test(next)) {
            next = next.replace(/<\/body>/i, `${block}\n</body>`);
            replaced = true;
        }
    }

    return { html: next, replaced };
}

/** Форма внутри #container_video → вынести после контейнера; добавить id=order. */
function extractFormFromVideoContainer(html: string): string {
    const start = html.search(/<div\b[^>]*id\s*=\s*["']container_video["']/i);
    if (start < 0) {
        return html;
    }
    // найти конец container_video по балансу div (упрощённо: до следующего sibling form или по video close)
    const formInside = html.slice(start).match(/<form\b[\s\S]*?<\/form>/i);
    if (!formInside || formInside.index === undefined) {
        // только id=order на существующей форме вне контейнера
        return ensureOrderId(html);
    }
    const formAbs = start + formInside.index;
    // форма должна быть внутри container — проверить что до формы есть <video
    const beforeForm = html.slice(start, formAbs);
    if (!/<video\b/i.test(beforeForm)) {
        return ensureOrderId(html);
    }
    const formHtml = formInside[0];
    let next = html.slice(0, formAbs) + html.slice(formAbs + formHtml.length);
    // вставить форму сразу после закрытия container — найдём </div> после video
    const videoEnd = next.indexOf('</video>', start);
    if (videoEnd < 0) {
        return ensureOrderId(html.slice(0, formAbs) + formHtml + html.slice(formAbs + formHtml.length));
    }
    // после </video> может быть </div> container
    const afterVideo = next.indexOf('</div>', videoEnd);
    if (afterVideo < 0) {
        return ensureOrderId(next);
    }
    const insertAt = afterVideo + '</div>'.length;
    next = next.slice(0, insertAt) + '\n\n' + formHtml + '\n' + next.slice(insertAt);
    return ensureOrderId(next);
}

function ensureOrderId(html: string): string {
    if (/id\s*=\s*["']order["']/i.test(html)) {
        return html;
    }
    // первая order-форма
    return html.replace(/<form\b([^>]*)>/i, (full, attrs: string) => {
        if (/\bid\s*=/i.test(attrs)) {
            return `<form${attrs.replace(/\bid\s*=\s*(["'])[^"']*\1/i, 'id="order"')}>`;
        }
        return `<form id="order"${attrs}>`;
    });
}

function cleanupJunk(htmlDir: string, notes: string[]): void {
    const names = fs.readdirSync(htmlDir);
    for (const name of names) {
        const full = path.join(htmlDir, name);
        try {
            const st = fs.statSync(full);
            if (st.isFile() && /\.bin\.(html|js)$/i.test(name)) {
                fs.unlinkSync(full);
                notes.push(`удалён junk: ${name}`);
            }
            if (st.isDirectory() && name === 'frames') {
                const inner = fs.readdirSync(full);
                // удалить если пусто или только пустой index
                if (
                    inner.length === 0 ||
                    (inner.length === 1 &&
                        inner[0] === '0' &&
                        fs.readdirSync(path.join(full, '0')).length <= 1)
                ) {
                    fs.rmSync(full, { recursive: true, force: true });
                    notes.push('удалена пустая frames/');
                }
            }
        } catch {
            // ignore
        }
    }
}

/**
 * Полная установка Adway video player:
 * 1) media/ + перенос видео
 * 2) шаблоны css/js
 * 3) замена Hermes/VideoJS/bare video
 * 4) вынести форму, подключить jQuery
 */
export function setupAdwayVideoPlayer(
    html: string,
    htmlDir: string,
    options?: { showFormSeconds?: number; writeAssets?: boolean; cleanup?: boolean }
): SetupVideoResult {
    const showForm = options?.showFormSeconds ?? 150;
    const writeAssets = options?.writeAssets !== false;
    const doCleanup = options?.cleanup !== false;
    const notes: string[] = [];
    const created: string[] = [];

    const movedResult = moveVideosToMedia(html, htmlDir);
    let current = movedResult.html;
    const moved = [...movedResult.moved];
    created.push(...movedResult.created);

    if (moved.length === 0 && movedResult.created.length === 0) {
        // нет файлов — всё равно можно поставить плеер на media/video.mp4
        notes.push('Локальный видеофайл не найден — укажите media/video.mp4 вручную');
    }

    if (writeAssets) {
        writeAssetFiles(htmlDir, created, showForm);
    }

    const { html: withPlayer, replaced } = replacePlayerBlocks(current, movedResult.mediaSrc);
    current = withPlayer;
    if (replaced) {
        notes.push('Видео-блок приведён к #container_video');
    }

    current = extractFormFromVideoContainer(current);
    current = ensureHeadLinks(current);

    // убрать scrapbook / blob posters в source по возможности — только warning в notes
    if (/urn:scrapbook|blob:https?:/i.test(current)) {
        notes.push('В HTML остались blob:/scrapbook-ссылки — проверьте вручную');
    }
    if (/embedpvideo|video-js|data-hermes-video/i.test(current)) {
        notes.push('Возможно, остатки Hermes/VideoJS — проверьте разметку');
    }

    if (doCleanup) {
        cleanupJunk(htmlDir, notes);
    }

    return {
        html: current,
        moved,
        created,
        notes,
        hasPlayer: /id\s*=\s*["']container_video["']/i.test(current) || /<video\b/i.test(current)
    };
}

/** Есть ли признаки видео-лендинга (для checker). */
export function detectVideoLandingIssues(
    html: string,
    htmlDir?: string
): Array<{ code: string; message: string; severity: 'error' | 'warning' }> {
    const issues: Array<{ code: string; message: string; severity: 'error' | 'warning' }> = [];
    const hasVideoTag = /<video\b/i.test(html);
    const hasContainer = /id\s*=\s*["']container_video["']/i.test(html);
    const hasHermes = /embedpvideo|data-hermes-video|lv-wrapper/i.test(html);
    const hasVjs = /video-js|vjs-tech/i.test(html);
    const isVideoLanding = hasVideoTag || hasContainer || hasHermes || hasVjs;

    if (!isVideoLanding) {
        return issues;
    }

    if (hasHermes) {
        issues.push({
            code: 'adway.video.hermes',
            message: '❌ Остался Hermes-плеер — замените на бесплатный Adway video (Установить видео-плеер)',
            severity: 'error'
        });
    }
    if (hasVjs) {
        issues.push({
            code: 'adway.video.videojs',
            message: '❌ Остался VideoJS — замените на бесплатный Adway video (Установить видео-плеер)',
            severity: 'error'
        });
    }
    if (/blob:|urn:scrapbook/i.test(html)) {
        issues.push({
            code: 'adway.video.blob',
            message: '❌ В разметке blob: или urn:scrapbook — мёртвые ссылки',
            severity: 'error'
        });
    }
    if (hasVideoTag || hasContainer) {
        if (!/href\s*=\s*["'][^"']*css\/video\.css["']/i.test(html) && htmlDir) {
            const cssPath = path.join(htmlDir, 'css', 'video.css');
            if (!fs.existsSync(cssPath)) {
                issues.push({
                    code: 'adway.video.css',
                    message: '⚠️ Нет css/video.css для видео-плеера',
                    severity: 'warning'
                });
            }
        } else if (!/css\/video\.css/i.test(html)) {
            issues.push({
                code: 'adway.video.css',
                message: '⚠️ css/video.css не подключён в HTML',
                severity: 'warning'
            });
        }
        if (!/js\/video\.js/i.test(html)) {
            issues.push({
                code: 'adway.video.js',
                message: '⚠️ js/video.js не подключён',
                severity: 'warning'
            });
        }
    }

    // mp4 не в media/
    const srcMatch = html.match(/(?:src|source)\s*=\s*["']([^"']+\.mp4)["']/i);
    if (srcMatch) {
        const src = srcMatch[1].replace(/^\.\//, '');
        if (!/^media\//i.test(src)) {
            issues.push({
                code: 'adway.video.mediaPath',
                message: `⚠️ Видео не в media/: "${src}" — создайте media/ и перенесите файл`,
                severity: 'warning'
            });
        }
    }

    // форма внутри container — грубая эвристика
    const cStart = html.search(/id\s*=\s*["']container_video["']/i);
    if (cStart >= 0) {
        const slice = html.slice(cStart, cStart + 8000);
        if (/<form\b/i.test(slice) && /<video\b/i.test(slice)) {
            const formPos = slice.search(/<form\b/i);
            const videoPos = slice.search(/<video\b/i);
            if (formPos > videoPos) {
                issues.push({
                    code: 'adway.video.formInside',
                    message: '⚠️ Форма внутри #container_video — вынесите после видео-блока',
                    severity: 'warning'
                });
            }
        }
    }

    // файл в корне htmlDir
    if (htmlDir && fs.existsSync(htmlDir)) {
        try {
            for (const n of fs.readdirSync(htmlDir)) {
                if (isVideoFile(n) && fs.statSync(path.join(htmlDir, n)).isFile()) {
                    issues.push({
                        code: 'adway.video.mediaPath',
                        message: `⚠️ Видеофайл в корне: "${n}" — перенесите в media/`,
                        severity: 'warning'
                    });
                    break;
                }
            }
        } catch {
            // ignore
        }
    }

    return issues;
}
