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

/** HTML-блок #container_video (тексты CTA — плейсхолдеры). */
export function buildVideoHtmlBlock(
    mediaSrc = 'media/video.mp4',
    texts: Partial<VideoBlockTexts> = {}
): string {
    const t = { ...DEFAULT_TEXTS, ...texts };
    const closeInner = t.closeImg
        ? `\n    <img src="${t.closeImg}" alt="" loading="lazy">`
        : '';
    return `<div id="container_video">
  <div id="video-overlay"></div>
  <div id="close">${closeInner}
  </div>
  <div id="open-video">
    <div>
      <h4>${t.openContinue}</h4>
    </div>
  </div>
  <div id="popup">
    <div>
      <h2>${t.popupLine1}</h2>
      <h2>${t.popupLine2}</h2>
    </div>
  </div>
  <div id="play">
    <div>
      <h4>${t.playLine1}</h4>
      <h4>${t.playLine2}</h4>
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
