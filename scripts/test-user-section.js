const Module = require('module');
const orig = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
    if (request === 'vscode') {
        return 'vscode-mock';
    }
    return orig.call(this, request, parent, isMain, options);
};
require.cache['vscode-mock'] = {
    id: 'vscode-mock',
    filename: 'vscode-mock',
    loaded: true,
    exports: {
        workspace: { getConfiguration: () => ({ get: (_k, d) => d }) }
    }
};

const { detectPlayerByRules, buildPlayerReplacePlan } = require('../out/ai/aiPlayer');
const { extractVideoBlockTexts } = require('../out/videoTemplates');

const sample = `<html><body>
<section class="section-video" id="container_video">
  <div class="div-video relative" id="form-wrap">
    <div class="notification" id="play">
      <div style="text-align:center">
        <p> Film je već počeo </p>
        <img alt="#" src="images/16d53a4d3107_26f79a96.webp" />
        <p> Kliknite na dugme i slušajte! </p>
      </div>
    </div>
    <div class="vjs-control-bar" dir="ltr">
      <button class="vjs-play-control" title="Pause" type="button">
        <span class="vjs-control-text">Pause</span>
      </button>
      <button class="vjs-mute-control" title="Unmute" type="button">
        <span class="vjs-control-text">Unmute</span>
      </button>
    </div>
    <div class="close none"><div>X</div></div>
  </div>
  <div class="video__bottom" style="display:none">
    <div class="video__bottom-left"><span> NAŽIVO: </span></div>
  </div>
</section>
</body></html>`;

const detect = detectPlayerByRules(sample);
console.log('detect:', detect && {
    reason: detect.reason,
    wrap: detect.wrapTag,
    fullSection: /^<section/i.test(detect.snippet) && /<\/section>\s*$/i.test(detect.snippet.trim()),
    hasVjs: /vjs-/.test(detect.snippet),
    len: detect.snippet.length
});

const texts = extractVideoBlockTexts(detect.snippet);
console.log('texts:', texts);

const plan = buildPlayerReplacePlan(sample, detect);
console.log('preserved note:', plan.summaryLines.find(l => l.includes('Надписи')));
console.log('after has container_video div:', /<div id="container_video">/.test(plan.htmlAfterReplace));
console.log('after no vjs:', !/vjs-/.test(plan.htmlAfterReplace));
console.log('after has play texts:', /Film je već počeo/.test(plan.htmlAfterReplace) && /Kliknite na dugme/.test(plan.htmlAfterReplace));

let fail = false;
if (!detect || !/^<section/i.test(detect.snippet)) {
    fail = true;
    console.log('FAIL detect');
}
if (texts.playLine1 !== 'Film je već počeo' || !/Kliknite na dugme/.test(texts.playLine2 || '')) {
    fail = true;
    console.log('FAIL texts', texts);
}
if (/vjs-/.test(plan.htmlAfterReplace)) {
    fail = true;
    console.log('FAIL still has vjs');
}
process.exit(fail ? 1 : 0);
