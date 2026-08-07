/** Шаблоны Adway video player (эталон: video/проект3/норм видео) */

export const VIDEO_CSS = `#container_video {
  position: relative;
  z-index: 2;
}

#container_video.fullscreen {
  background: #000;
  width: 100vw;
  height: 100vh;
  position: fixed !important;
  top: 0;
  left: 0;
  z-index: 999;
  display: flex;
  align-items: center;
  justify-content: center;
}

#container_video.fullscreen #video {
  max-width: none;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

body.noscroll {
  overflow: hidden;
}

#video {
  display: block;
  width: 100%;
  max-width: 900px;
  height: auto;
  margin: 0 auto;
  pointer-events: none;
}

#open-video,
#popup,
#play {
  display: none;
  position: absolute;
  margin: auto;
  left: 0;
  right: 0;
  top: 0;
  bottom: 0;
  text-align: center;
  z-index: 2;
  height: 150px;
}

@media screen and (max-width: 500px) {
  #open-video {
    height: 75px;
  }
}

#play {
  display: block;
}

#play h4:first-child {
  margin-bottom: 60px;
}

#open-video > div,
#popup > div,
#play > div {
  position: relative;
  background-color: rgba(0, 207, 47, 0.75);
  padding: 5px 20px;
  margin: 0 auto;
  width: 30%;
  color: #fff;
  border: 2px solid #fff;
  border-radius: 8px;
  cursor: pointer;
}

#popup > div {
  width: 40%;
  background-color: rgba(255, 0, 0, 0.75);
}

@media (max-width: 600px) {
  #popup > div,
  #play > div {
    width: 80%;
  }
  #open-video > div {
    width: 50%;
  }
}

#close {
  display: none;
  position: absolute;
  top: 10px;
  right: 10px;
  width: 30px;
  height: 30px;
  cursor: pointer;
  z-index: 2;
}

#close img {
  width: 100%;
  height: 100%;
  display: block;
}

#video-overlay {
  display: none;
  position: absolute;
  inset: 0;
  z-index: 1;
  cursor: pointer;
}

#container_video.fullscreen #video-overlay {
  display: block;
}
`;

export function buildVideoJs(showFormSeconds = 150): string {
    return `$(document).ready(function() {
    var showPlay = true;
    var showForm = ${showFormSeconds};
    var formFlag = false;

    document.getElementById('play').addEventListener('click', function () {
        window.scrollTo(0, 0);
        $('#play').fadeOut('fast', function () {
            $('#video').prop('muted', false).prop('currentTime', 0).trigger('play');
            $('#container_video').addClass('fullscreen');
            $('body').addClass('noscroll');
            $('#close').fadeIn();
            showPlay = false;
        });
    });

    document.getElementById('open-video').addEventListener('click', function () {
        window.scrollTo(0, 0);
        $('#open-video').fadeOut('fast', function () {
            $('#container_video').addClass('fullscreen');
            $('body').addClass('noscroll');
            $('#close').fadeIn();
            showPlay = false;
        });
    });

    $('#video').on('timeupdate', function () {
        if (this.currentTime >= showForm) {
            $('#order').fadeIn('fast');
            formFlag = true;
        }
    }).on('ended', showOrder);

    $('#popup').on('click', showOrder);

    $('#close').on('click', function () {
        $(this).hide();
        $('#container_video').removeClass('fullscreen');
        $('body').removeClass('noscroll');
        $('#open-video').fadeIn('fast');
        $('#popup').fadeOut('fast');
    });

    function showOrder() {
        $('#container_video').removeClass('fullscreen');
        $('#open-video').css('display', 'none');
        $('#play').css('display', 'none');
        $('body').removeClass('noscroll');
        $('#popup').fadeOut();
        $('#close').fadeOut();
        $('#video').fadeOut('fast', function () {
            $(this).trigger('pause');
            $('#order').fadeIn('fast', function () {
                $('html, body').animate({ scrollTop: $('#order').offset().top - 20 }, 200);
                if (typeof start_timer === 'function') {
                    start_timer();
                }
            });
        });
    }
});

var time = 600;
var intr;

function start_timer() {
    if (intr) {
        clearInterval(intr);
    }
    intr = setInterval(tick, 1000);
}

function tick() {
    time = time - 1;
    var mins = Math.floor(time / 60);
    var secs = time - mins * 60;
    if (mins === 0 && secs === 0) {
        clearInterval(intr);
    }
    secs = secs >= 10 ? secs : '0' + secs;
    mins = mins >= 10 ? mins : '0' + mins;
    $('#min').html(mins);
    $('#sec').html(secs);
}
`;
}

export type VideoBlockTexts = {
    openContinue: string;
    playLine1: string;
    playLine2: string;
    popupLine1: string;
    popupLine2: string;
    closeImg?: string;
};

const DEFAULT_TEXTS: VideoBlockTexts = {
    openContinue: 'Click to continue',
    playLine1: 'The video has already started.',
    playLine2: 'Click to unmute!',
    popupLine1: 'Limited stock left.',
    popupLine2: 'Order now!',
    closeImg: 'images/2.svg'
};

function escapeHtmlText(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function decodeBasicEntities(s: string): string {
    return s
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/g, "'");
}

function stripTagsToText(html: string): string {
    return decodeBasicEntities(
        html
            .replace(/<br\s*\/?>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
    );
}

/** Тексты внутри блока с id=… (h2–h4 и p — как в notification#play). */
function headingsInId(html: string, id: string, tags = 'h2|h3|h4|p'): string[] {
    const idRe = new RegExp(`id\\s*=\\s*["']${id}["']`, 'i');
    const idMatch = idRe.exec(html);
    if (!idMatch || idMatch.index === undefined) {
        return [];
    }
    // назад к началу тега
    const openStart = html.lastIndexOf('<', idMatch.index);
    if (openStart < 0) {
        return [];
    }
    const tagNameMatch = html.slice(openStart).match(/^<(\w+)/);
    if (!tagNameMatch) {
        return [];
    }
    const tag = tagNameMatch[1];
    // упрощённый баланс для div/section
    const openRe = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
    const closeRe = new RegExp(`</${tag}\\s*>`, 'gi');
    openRe.lastIndex = openStart;
    const first = openRe.exec(html);
    if (!first || first.index !== openStart) {
        return [];
    }
    let depth = 1;
    let pos = openStart + first[0].length;
    let end = -1;
    while (depth > 0 && pos < html.length) {
        openRe.lastIndex = pos;
        closeRe.lastIndex = pos;
        const nextOpen = openRe.exec(html);
        const nextClose = closeRe.exec(html);
        if (!nextClose) {
            break;
        }
        if (nextOpen && nextOpen.index < nextClose.index) {
            depth += 1;
            pos = nextOpen.index + nextOpen[0].length;
        } else {
            depth -= 1;
            pos = nextClose.index + nextClose[0].length;
            if (depth === 0) {
                end = nextClose.index;
            }
        }
    }
    if (end < 0) {
        return [];
    }
    const inner = html.slice(openStart + first[0].length, end);
    const headingRe = new RegExp(`<(${tags})\\b[^>]*>([\\s\\S]*?)</\\1>`, 'gi');
    const out: string[] = [];
    let hm: RegExpExecArray | null;
    while ((hm = headingRe.exec(inner)) !== null) {
        const t = stripTagsToText(hm[2]);
        if (t && t.length >= 2 && !isPlayerUiNoise(t)) {
            out.push(t);
        }
    }
    return out;
}

function allHeadings(html: string): string[] {
    const headingRe = /<(h[1-4]|p)\b[^>]*>([\s\S]*?)<\/\1>/gi;
    const out: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = headingRe.exec(html)) !== null) {
        const t = stripTagsToText(m[2]);
        if (t && t.length >= 2 && t.length < 200 && !isPlayerUiNoise(t)) {
            out.push(t);
        }
    }
    return out;
}

/** Служебные подписи VideoJS / aria — не CTA лендинга. */
function isPlayerUiNoise(t: string): boolean {
    return /^(play\s*video|pause|unmute|mute|fullscreen|skip\b|stream\s*type|current\s*time|duration|remaining|loaded|live|chapters|subtitles|descriptions|picture-in-picture|modal|reset|done|white|black|opaque|transparent|semi-transparent|video\s*player\s*is\s*loading|seek\s*to\s*live|close\s*modal|this\s*is\s*a\s*modal|beginning\s*of\s*dialog|end\s*of\s*dialog|captions|opacity|color|font\s*size|text\s*edge|font\s*family|proportional|monospace|restore\s*all|opens\s*subtitles|selected)\b/i.test(
        t.trim()
    );
}

function pickByHint(texts: string[], hints: RegExp[]): string | undefined {
    for (const h of hints) {
        const found = texts.find(t => h.test(t));
        if (found) {
            return found;
        }
    }
    return undefined;
}

/**
 * Достаёт надписи из старого/похожего видео-блока, чтобы сохранить при замене на Adway-плеер.
 * Сначала #open-video / #play / #popup (бесплатный шаблон), иначе эвристика по заголовкам.
 */
export function extractVideoBlockTexts(html: string): Partial<VideoBlockTexts> {
    const out: Partial<VideoBlockTexts> = {};

    const openHs = headingsInId(html, 'open-video');
    if (openHs[0]) {
        out.openContinue = openHs[0];
    }

    const playHs = headingsInId(html, 'play');
    if (playHs[0]) {
        out.playLine1 = playHs[0];
    }
    if (playHs[1]) {
        out.playLine2 = playHs[1];
    }

    const popupHs = [...headingsInId(html, 'popup')];
    if (popupHs[0]) {
        out.popupLine1 = popupHs[0];
    }
    if (popupHs[1]) {
        out.popupLine2 = popupHs[1];
    }

    // notification без id=play, но class=notification
    if (!out.playLine1) {
        const notif = html.match(
            /class\s*=\s*["'][^"']*notification[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
        );
        if (notif) {
            const ps = allHeadings(notif[0]);
            if (ps[0]) {
                out.playLine1 = ps[0];
            }
            if (ps[1]) {
                out.playLine2 = ps[1];
            }
        }
    }

    const closeBlock = headingsInId(html, 'close'); // may be empty — still find img via regex near id=close
    void closeBlock;
    const closeImg = html.match(
        /id\s*=\s*["']close["'][\s\S]{0,400}?src\s*=\s*["']([^"']+)["']/i
    );
    if (closeImg?.[1] && !/^https?:/i.test(closeImg[1]) && !closeImg[1].startsWith('data:')) {
        out.closeImg = closeImg[1].replace(/^\.\//, '');
    }

    // эвристика, если id-блоков нет (Hermes / кастом)
    if (!out.openContinue || !out.playLine1 || !out.popupLine1) {
        const all = allHeadings(html);
        if (!out.openContinue) {
            out.openContinue = pickByHint(all, [
                /continu/i,
                /продолж|nastavi|nastav/i,
                /click\s+to/i,
                /нажм|kliknite|klikni/i,
                /далее|dalje/i
            ]);
        }
        if (!out.playLine2) {
            out.playLine2 = pickByHint(all, [
                /unmute|sound|звук|slušaj|slušajte|slušati|vključ.*zvok|bez\s*zvuk/i
            ]);
        }
        if (!out.playLine1) {
            out.playLine1 = pickByHint(all, [
                /already\s+started|начал|počeo|poceo|zacel|воспроизв|playing|video\s+has|film\s+je/i
            ]);
        }
        if (!out.popupLine1) {
            out.popupLine1 = pickByHint(all, [
                /stock|остал|limited|осталось|left\b|спеш/i
            ]);
        }
        if (!out.popupLine2) {
            out.popupLine2 = pickByHint(all, [/order|заказ|купить|buy\s*now|order\s*now/i]);
        }
        // если всё ещё пусто — первые осмысленные заголовки по порядку
        const unused = all.filter(
            t =>
                t !== out.openContinue &&
                t !== out.playLine1 &&
                t !== out.playLine2 &&
                t !== out.popupLine1 &&
                t !== out.popupLine2
        );
        if (!out.playLine1 && unused[0]) {
            out.playLine1 = unused.shift();
        }
        if (!out.playLine2 && unused[0]) {
            out.playLine2 = unused.shift();
        }
        if (!out.popupLine1 && unused[0]) {
            out.popupLine1 = unused.shift();
        }
        if (!out.popupLine2 && unused[0]) {
            out.popupLine2 = unused.shift();
        }
        if (!out.openContinue && unused[0]) {
            out.openContinue = unused.shift();
        }
    }

    // убрать undefined / пустые
    const clean: Partial<VideoBlockTexts> = {};
    for (const key of Object.keys(out) as Array<keyof VideoBlockTexts>) {
        const v = out[key];
        if (typeof v === 'string' && v.trim()) {
            (clean as Record<string, string>)[key] = v.trim();
        }
    }
    return clean;
}

export function describePreservedTexts(texts: Partial<VideoBlockTexts>): string[] {
    const lines: string[] = [];
    if (texts.openContinue) {
        lines.push(`open: «${texts.openContinue}»`);
    }
    if (texts.playLine1 || texts.playLine2) {
        lines.push(`play: «${[texts.playLine1, texts.playLine2].filter(Boolean).join(' / ')}»`);
    }
    if (texts.popupLine1 || texts.popupLine2) {
        lines.push(`popup: «${[texts.popupLine1, texts.popupLine2].filter(Boolean).join(' / ')}»`);
    }
    if (texts.closeImg) {
        lines.push(`close: ${texts.closeImg}`);
    }
    return lines;
}

/** HTML-блок #container_video (тексты CTA — из старого плеера или дефолт). */
export function buildVideoHtmlBlock(
    mediaSrc = 'media/video.mp4',
    texts: Partial<VideoBlockTexts> = {}
): string {
    const t = { ...DEFAULT_TEXTS, ...texts };
    const e = {
        openContinue: escapeHtmlText(t.openContinue),
        playLine1: escapeHtmlText(t.playLine1),
        playLine2: escapeHtmlText(t.playLine2),
        popupLine1: escapeHtmlText(t.popupLine1),
        popupLine2: escapeHtmlText(t.popupLine2)
    };
    const closeInner = t.closeImg
        ? `\n    <img src="${escapeHtmlText(t.closeImg)}" alt="" loading="lazy">`
        : '';
    return `<div id="container_video">
  <div id="video-overlay"></div>
  <div id="close">${closeInner}
  </div>
  <div id="open-video">
    <div>
      <h4>${e.openContinue}</h4>
    </div>
  </div>
  <div id="popup">
    <div>
      <h2>${e.popupLine1}</h2>
      <h2>${e.popupLine2}</h2>
    </div>
  </div>
  <div id="play">
    <div>
      <h4>${e.playLine1}</h4>
      <h4>${e.playLine2}</h4>
    </div>
  </div>
  <video id="video" autoplay muted playsinline preload="metadata">
    <source src="${mediaSrc}" type="video/mp4">
  </video>
</div>`;
}

export const VIDEO_CSS_LINK = '<link rel="stylesheet" type="text/css" href="css/video.css">';
export const VIDEO_JS_SCRIPT = '<script src="js/video.js"></script>';
export const JQUERY_CDN =
    '<script src="https://cdnjs.cloudflare.com/ajax/libs/jquery/3.6.0/jquery.min.js" referrerpolicy="no-referrer"></script>';
