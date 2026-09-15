"use strict";

var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var test = require("node:test");
var vm = require("node:vm");

var pluginSource = fs.readFileSync(
  process.env.IINA_PLUGIN_MAIN || path.join(__dirname, "main.js"),
  "utf8",
);

function deferred() {
  var resolve;
  var reject;
  var promise = new Promise(function (resolvePromise, rejectPromise) {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise: promise, resolve: resolve, reject: reject };
}

function loadPlugin(options) {
  var state = {
    args: null,
    errors: [],
    osd: [],
    pauseCount: 0,
    resumeCount: 0,
  };
  var child = options.child || deferred();
  var properties = Object.assign(
    {
      mute: false,
      path: "/tmp/video.mp4",
      pause: false,
      speed: 1,
      "time-pos": 12.5,
      volume: 75,
    },
    options.properties || {},
  );

  var iina = {
    console: {
      error: function (message) {
        state.errors.push(message);
      },
    },
    core: {
      osd: function (message) {
        state.osd.push(message);
      },
      pause: function () {
        state.pauseCount += 1;
        properties.pause = true;
      },
      resume: function () {
        state.resumeCount += 1;
        properties.pause = false;
      },
    },
    menu: {
      addItem: function () {},
      item: function (_title, action) {
        state.action = action;
        return {};
      },
    },
    mpv: {
      getFlag: function (name) {
        return Boolean(properties[name]);
      },
      getNumber: function (name) {
        return Number(properties[name]);
      },
      getString: function (name) {
        return properties[name] || null;
      },
    },
    utils: {
      exec: function (_executable, args) {
        state.args = args;
        return child.promise;
      },
    },
  };

  vm.runInNewContext(pluginSource, {
    Number: Number,
    Promise: Promise,
    String: String,
    iina: iina,
  });

  state.child = child;
  state.properties = properties;
  return state;
}

async function flushPromises() {
  await new Promise(function (resolve) {
    setImmediate(resolve);
  });
}

test("launches mpv with transparency and restores active playback", async function () {
  var state = loadPlugin({});

  state.action();

  assert.equal(state.pauseCount, 1);
  assert.equal(state.resumeCount, 0);
  assert.deepEqual(Array.from(state.args), [
    "--no-terminal",
    "--vo=gpu-next",
    "--background=none",
    "--border=no",
    "--hwdec=no",
    "--keep-open=yes",
    "--vf=lavfi=[chromakey=0x00ff00:0.12:0.08,format=rgba,despill=type=green:mix=0.5:expand=0.15]",
    "--start=12.5",
    "--speed=1",
    "--volume=75",
    "--",
    "/tmp/video.mp4",
  ]);

  state.child.resolve({ status: 0 });
  await flushPromises();

  assert.equal(state.resumeCount, 1);
});

test("preserves an already paused player", async function () {
  var state = loadPlugin({
    properties: {
      pause: true,
    },
  });

  state.action();
  state.child.resolve({ status: 0 });
  await flushPromises();

  assert.equal(state.pauseCount, 0);
  assert.equal(state.resumeCount, 0);
  assert.ok(state.args.includes("--pause=yes"));
});

test("restores playback when mpv cannot start", async function () {
  var state = loadPlugin({});

  state.action();
  state.child.reject(new Error("spawn failed"));
  await flushPromises();

  assert.equal(state.resumeCount, 1);
  assert.equal(state.osd.at(-1), "Transparent Player could not start");
  assert.equal(state.errors.length, 1);
});

test("does not resume a different video", async function () {
  var state = loadPlugin({});

  state.action();
  state.properties.path = "/tmp/other-video.mp4";
  state.child.resolve({ status: 0 });
  await flushPromises();

  assert.equal(state.resumeCount, 0);
});

test("does not launch without a loaded video", function () {
  var state = loadPlugin({
    properties: {
      path: null,
      "stream-open-filename": null,
    },
  });

  state.action();

  assert.equal(state.args, null);
  assert.equal(state.pauseCount, 0);
  assert.equal(state.osd.at(-1), "Transparent Player: no video is loaded");
});
