/** Общие сниппеты — и для команд вставки, и для Quick Fix */

export const JQUERY_SNIPPET =
    '<script src="https://cdnjs.cloudflare.com/ajax/libs/jquery/3.6.0/jquery.min.js" referrerpolicy="no-referrer"></script>';

export const LAZY_SCRIPT = `<script async>
  const LAZY = document.querySelectorAll('img');
  for (let i = 0; i < LAZY.length; i++) {
    LAZY[i].setAttribute('loading', 'lazy');
  }
</script>`;

export const SCROLL_SCRIPT = `<script>
  $("a").on("touchend, click", function (e) {
    e.preventDefault();
    $('body,html').animate({
      scrollTop: $('#oneform').offset().top
    }, 400);
  });
</script>`;

export const VALIDATION_SCRIPT = `<script>
  $('[name="name"]').on("input", function () {
    var val = $(this).val();
    var cleaned = val
      .replace(/[^\\p{L}\\s]/gu, "")
      .replace(/^\\s+/, "")
      .replace(/\\s\\s+/, " ");
    var parts = cleaned.split(" ");
    if (parts.length > 2) {
      cleaned = parts[0] + " " + parts[1];
    }
    $(this).val(cleaned);
  });
  $('[name="name"]').on("change blur", function () {
    $(this).val($(this).val().trim());
  });
  $('[name="phone"]').on("input change", function (e) {
    var val = $(this).val();
    $(this).val(val.replace(/\\D/g, ""));
    $(e.currentTarget).attr("pattern", "[0-9]{6,}");
  });
</script>`;

export const REQUIRED_SCRIPTS = `${LAZY_SCRIPT}

${SCROLL_SCRIPT}

${VALIDATION_SCRIPT}`;

export const HIDDEN_INPUTS = `<input type="hidden" name="fbpx" value="{fbpx}">
<input type="hidden" name="utm_code" value="{subid}">
<input type="hidden" name="cid" value="{campaign_id}">
<input type="hidden" name="sid" value="">
<input type="hidden" name="hash" value="{hash}">
<input type="hidden" name="country" value="">`;

export const FORM_SNIPPET = `<form action="/order.php" method="post" style="margin: 0 auto; display: flex; align-items: center; flex-direction: column;">
  <input type="hidden" name="fbpx" value="{fbpx}">
  <input type="hidden" name="utm_code" value="{subid}">
  <input type="hidden" name="cid" value="{campaign_id}">
  <input type="hidden" name="sid" value="">
  <input type="hidden" name="hash" value="{hash}">
  <input type="hidden" name="country" value="">

  <img src="images/product.png" style="width: 100%; max-width: 300px; margin: 30px 0;" alt="">

  <div style="margin-bottom: 10px; display: flex; flex-direction: column; align-items: center;">
    <div style="text-decoration: line-through; color: gray;">PRICE</div>
    <div style="color: red; font-size: 24px;">PRICE</div>
  </div>

  <input type="text" placeholder="Név" name="name" required autocomplete="name" style="padding: 10px 30px;">

  <input name="phone" type="tel" placeholder="Telefonszám" required autocomplete="tel" style="padding: 10px 30px; margin-top: 20px;">

  <button type="submit" style="background-color: red; color: white; padding: 20px 50px; margin-top: 20px; font-size: 20px;">Megrendelés</button>
</form>`;

export const DATE_SNIPPET = `<script>
  d = new Date();
  p = new Date(d.getTime() - 10 * 86400000);
  monthA = 'január,február,március,aprilis,május,június,július,augusztusа,szeptember,október,november,december'.split(',');
  document.write(p.getDate() - 0 + ' ' + monthA[p.getMonth()] + ' ' + p.getFullYear());
</script>`;

export const VIDEO_SNIPPET = `<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
<script>
  var video = document.getElementById('video');
  if (Hls.isSupported()) {
    var hls = new Hls();
    hls.loadSource("https://preview.ink/free//playlist.m3u8");
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, function() {
      video.play();
    });
  }
</script>`;

export const VIEWPORT_VIETNAM =
    '<meta id="viewport" name="viewport" content="width=420,user-scalable=no,initial-scale=0.780952380952381,minimum-scale=0.780952380952381,maximum-scale=0.780952380952381">';

export const TIMER_SNIPPET = `<div>
  <span id="min" style="font-weight: 600;color: red;">10</span>
  <span style="font-weight: 600;color: red;">:</span>
  <span id="sec" style="font-weight: 600;color: red;">00</span>
</div>

<script>
  var start = 1200;
  var duration = 30;
</script>`;

export const ONEFORM_ATTR = ' id="oneform"';

/** Якорь для скрипта прокрутки (часто рядом с формой) */
export const ONEFORM_SPAN = '<span id="oneform"></span>';
