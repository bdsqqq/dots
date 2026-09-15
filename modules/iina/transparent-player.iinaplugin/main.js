(function () {
  "use strict";

  var core = iina.core;
  var menu = iina.menu;
  var mpv = iina.mpv;
  var utils = iina.utils;

  var mpvExecutable = "@mpv@";
  // colorkey's second and third values control green tolerance and edge softness.
  // rgba gives the filter an alpha channel that mpv can pass to WindowServer.
  var chromaKeyFilter =
    "lavfi=[format=rgba,colorkey=0x00ff00:0.20:0.08]";

  function addNumericOption(args, property, option, predicate) {
    var value = mpv.getNumber(property);
    if (Number.isFinite(value) && predicate(value)) {
      args.push("--" + option + "=" + value);
    }
  }

  function openTransparentPlayer() {
    var source =
      mpv.getString("path") || mpv.getString("stream-open-filename");

    if (!source) {
      core.osd("Transparent Player: no video is loaded");
      return;
    }

    var wasPaused = mpv.getFlag("pause");
    // The software filter needs CPU-backed frames. background=none then keeps its
    // alpha instead of flattening the keyed pixels onto an mpv background.
    var args = [
      "--no-config",
      "--no-terminal",
      "--vo=gpu-next",
      "--background=none",
      "--border=no",
      "--hwdec=no",
      "--keep-open=yes",
      "--vf=" + chromaKeyFilter,
    ];

    addNumericOption(args, "time-pos", "start", function (value) {
      return value > 0;
    });
    addNumericOption(args, "speed", "speed", function (value) {
      return value > 0;
    });
    addNumericOption(args, "volume", "volume", function (value) {
      return value >= 0;
    });

    if (mpv.getFlag("mute")) {
      args.push("--mute=yes");
    }
    if (wasPaused) {
      args.push("--pause=yes");
    }

    args.push("--", source);

    var process = utils.exec(mpvExecutable, args);
    if (!wasPaused) {
      core.pause();
    }
    core.osd("Opening transparent player");

    function restorePlayback() {
      var currentSource =
        mpv.getString("path") || mpv.getString("stream-open-filename");
      if (!wasPaused && currentSource === source && mpv.getFlag("pause")) {
        core.resume();
      }
    }

    process
      .then(function (result) {
        restorePlayback();
        if (result.status !== 0) {
          core.osd("Transparent Player exited with status " + result.status);
        }
      })
      .catch(function (error) {
        restorePlayback();
        core.osd("Transparent Player could not start");
        iina.console.error(String(error));
      });
  }

  menu.addItem(
    menu.item("Open Current Video Transparently", openTransparentPlayer)
  );
})();
