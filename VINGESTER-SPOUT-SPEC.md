# Implementation brief: add a Spout output sink to Vingester (Windows)

Paste this as the opening prompt in Claude Code, with the working directory set to a
clean checkout of `https://github.com/rse/vingester`.

---

## Goal

Add a third video output sink to Vingester, alongside the existing NDI and FFmpeg
sinks: a **Spout sender** (Windows only), so that Vingester's headless browser output
can be consumed directly by TouchDesigner's `Spout In` TOP without going through NDI.

Scope for this pass: **Windows / Spout only.** No Syphon, no macOS, no Electron upgrade.
Keep the change additive — the NDI and FFmpeg paths must behave exactly as before when
the new sink is disabled.

---

## Ground truth about the codebase

These were verified by reading the repository at commit `a22d6d5` (version 2.8.0).
Trust them as a starting map, but re-check line numbers before editing — they will
have shifted if the tree has moved on.

**Architecture.** Each browser instance spawns a hidden offscreen `BrowserWindow`
("the worker") created in `vingester-browser.js` (`start()`, ~line 168). That worker
runs `vingester-browser-worker.js` with `nodeIntegration: true`,
`nodeIntegrationInWorker: true`, `contextIsolation: false` — so native addons can be
`require()`d there directly. This is already how `grandiose` (NDI) is loaded. **No
sandbox or preload plumbing is needed for a new native module.**

**Frame path.** The content window's `paint` (offscreen) or `frame` subscriber in
`vingester-browser.js` (~lines 465-500) calls `image.getBitmap()` and ships the result
over IPC as `"video-capture"`. The worker receives it in
`processVideo(buffer, size, ratio, dirty)` (`vingester-browser-worker.js`, ~line 186).

`buffer` is a **top-down, premultiplied BGRA** byte buffer on little-endian hosts
(Chromium's native bitmap order), `size` is `{ width, height }`.

**Sink model.** Sinks are single-letter boolean flags on the config object:
`n` = NDI, `m` = FFmpeg. They are declared in one table in `vingester-main.js`
(~lines 361-367), which maps internal short names (`iname`) to the external YAML
names (`ename`):

```js
{ iname: "n", itype: "boolean", def: true,  etype: "boolean", ename: "Output2SinkNDIEnabled" },
{ iname: "m", itype: "boolean", def: false, etype: "boolean", ename: "Output2SinkFFmpegEnabled" },
```

**Free config letters.** Of the 46 keys in use, only `b`, `e` and `s` are unclaimed in
the entire alphabet. Use:

- `s` → `Output2SinkSpoutEnabled` (boolean, default `false`)
- `b` → `Output2SinkSpoutName` (string, default `""`, falls back to the browser title)

**The "at least one sink" guard exists in exactly two places**, and both must learn
about `s` or the START button stays disabled:

- `vingester-browser.js:154` — `&& (!this.cfg.N || (this.cfg.N && (this.cfg.n || this.cfg.m)))`
- `vingester-control.js:336` — `&& (!browser.N || (browser.N && (browser.n || browser.m)))`

**`vingester-ffmpeg.js` is the model to copy.** It is a self-contained
`EventEmitter` subclass with `start()` / `video(data)` / `stop()` and a `log` callback
injected by the worker. Mirror that shape exactly.

---

## Step 0 — De-risk before writing any feature code

Do these two checks first and **report back before proceeding**. If either fails, stop
and describe the options rather than improvising a fix.

1. **Does the tree install at all?** `npm install` on this 2022-era dependency set
   (Electron 18.0.4, a pinned `rse/grandiose` fork, `@discordjs/opus`) may need work
   before anything else is possible. The `postinstall` runs
   `patch-package --patch-dir package.d && electron-builder install-app-deps`.

2. **Does `electron-spout` build against Electron 18.0.4?**
   `https://github.com/reitowo/electron-spout` is the candidate module. Inspect its
   `package.json` and `CMakeLists.txt`. The decisive question: **is it N-API
   (`node-addon-api`) or raw V8/NAN?** If N-API, the ABI is stable and it should build
   against Electron 18 headers via cmake-js. If it is not N-API, its examples target
   Electron 25/30 and it will not load in Electron 18.

   If it will not build against Electron 18, the fallback options, in order of
   preference:

   - a. Patch electron-spout to build against Electron 18 headers.
   - b. Write a minimal N-API addon directly against the Spout2 SDK
     (`https://github.com/leadedge/Spout2`), using `SpoutSender::SendImage`. This is
     roughly 150 lines of C++ and is a very contained piece of work.
   - c. Bind the prebuilt `SpoutLibrary.dll` from a Spout2 release using `koffi`,
     avoiding a C++ toolchain entirely. Slower per frame and clumsier, but no compiler.
   - d. **Do NOT bump Electron to get a newer addon working.** Vingester uses
     `ipcRenderer.sendTo()` in 7 places in `vingester-browser-worker.js`, and that API
     was removed in Electron 28. That upgrade is a separate project.

### API surface to confirm

`electron-spout`'s README describes a `SpoutOutput` class constructed with a channel
name, exposing `updateFrame(bitmap, size)` (CPU buffer) and `updateTexture(texture)`
(D3D11 shared handle). **This was read from documentation, not from the built module —
verify the real export shape, constructor signature and teardown method** (`release()`?
`dispose()`?) from the source or type definitions before coding against it.

Use only the `updateFrame` CPU path. The `updateTexture` path requires
`webPreferences.offscreen.useSharedTexture`, which does not exist in Electron 18.

---

## Design

Create **`vingester-spout.js`**, modelled on `vingester-ffmpeg.js`:

```js
class Spout extends EventEmitter {
    static available ()            //  true only on win32 with the addon loadable
    constructor (options)          //  { name, width, height, log }
    async start ()                 //  construct the Spout sender
    video (buffer, size)           //  publish one BGRA frame
    async stop ()                  //  release the sender
}
```

Requirements:

- **Lazy, guarded module load.** `require("electron-spout")` inside a `try/catch` at
  first use, never at file top level. The module must be an *optional* dependency:
  Vingester has to keep starting normally on macOS/Linux, and on a Windows box where
  the addon failed to build. A missing addon is a logged warning plus a disabled sink,
  never a crash.
- **Emit `fatal`** on unrecoverable errors, the way `FFmpeg` does, so the worker can
  surface a message to the control UI.
- **Handle resolution changes.** If `size` differs from the size the sender was created
  with, recreate the sender rather than sending a mismatched buffer.

---

## File-by-file changes

### 1. `vingester-spout.js` (new, ~150 lines)

As above.

### 2. `vingester-browser-worker.js`

Three edits, mirroring the FFmpeg sink:

- **Require** the module near the other own-module requires (~line 19).
- **Create** in `start()`, inside the existing `if (this.cfg.N) { ... }` block,
  after the `if (this.cfg.m)` FFmpeg block (~line 125). Name the sender
  `this.cfg.b || title`, where `title` is the already-computed browser title (~line 68).
- **Destroy** in `stop()`, after the FFmpeg teardown (~line 179).
- **Send** in `processVideo()`.

> **Send the Spout frame BEFORE the `if (this.cfg.n)` NDI block.**
>
> This is not cosmetic. `util.ImageBufferAdjustment.BGRAtoBGRX(buffer)` (called at
> `vingester-browser-worker.js:238` when NDI alpha is disabled) **mutates the buffer in
> place** — verified in `vingester-util.js`. Any sink that reads the buffer after that
> point gets its alpha channel destroyed. The existing FFmpeg sink already inherits
> this. Put the Spout send immediately after the preview block and before the NDI
> block, so Spout always receives intact alpha.

### 3. `vingester-browser.js`

One line: extend the guard at line 154 to `(this.cfg.n || this.cfg.m || this.cfg.s)`.

### 4. `vingester-control.js`

One line: the matching guard at line 336 → `(browser.n || browser.m || browser.s)`.

### 5. `vingester-main.js`

Two entries in the config table after the FFmpeg block (~line 367):

```js
{ iname: "s", itype: "boolean", def: false, etype: "boolean", ename: "Output2SinkSpoutEnabled" },
{ iname: "b", itype: "string",  def: "",    etype: "string",  ename: "Output2SinkSpoutName" },
```

### 6. `vingester-control.html`

Add a sink row after the FFmpeg rows (~line 838-880). Copy the FFmpeg row's structure
exactly — `div.row > div.group + div.sub-group + div.label.label-kind + div.field` with
a `toggle` bound to `toggle(browser, 's', [ true, false ])`, plus a `div.cluster`
`v-show="browser.s"` holding a text input bound to `browser.b` for the sender name.
Follow the existing `v-tippy` tooltip convention.

On non-Windows, hide the row rather than showing a dead control — the control renderer
can read `process.platform`, or `vingester-main.js` can pass a `support.spout` flag the
same way `support.srt` is already passed for FFmpeg.

Add matching CSS classes (`label-spout-name`, `field-spout-name`) to
`vingester-control.css` alongside the existing `label-ffmpeg-*` rules.

### 7. `package.json`

- `optionalDependencies`: `"electron-spout": "<pinned commit or version>"`.
- Add `node_modules/electron-spout/**` to `build.asarUnpack` — native `.node` binaries
  cannot load from inside an asar archive. The existing entry for `grandiose` is the
  precedent.

### 8. Docs

A line in `CHANGES.md`, and `Output2SinkSpoutEnabled` / `Output2SinkSpoutName` added to
`cfg-sample-expert.yaml`.

---

## Known pitfalls

- **Vertical flip.** Chromium's bitmap is top-down; Spout/OpenGL convention is
  bottom-up. `SendImage` in the Spout2 SDK takes a `bInvert` flag — make sure whatever
  path is used sets it, or the output arrives upside down in TouchDesigner. Make it a
  config toggle if the correct value isn't obvious.
- **Premultiplied alpha.** Chromium delivers premultiplied BGRA. TouchDesigner's
  `Spout In` TOP may expect straight alpha. If edges look dark against a light
  background, that's this. It is fixable downstream in TD, so don't over-engineer it —
  just document the behaviour.
- **Buffer lifetime.** `processVideo` is `async` and awaits the NDI send. The Spout call
  should be synchronous and complete before any `await`, so the buffer can't be
  invalidated underneath it.
- **Per-instance sender names.** Vingester runs many browsers at once. Each must publish
  under a distinct Spout name or they will fight over the same channel. Default to the
  browser title and let `b` override it.
- **Frame rate.** The sink inherits Vingester's existing capture-rate machinery
  (`recalcFramerate`). Don't add a separate rate control.
- **Licensing.** Vingester is GPL-3.0-only. Confirm `electron-spout`'s license (it was
  not stated in its README) and Spout2's (BSD-2-Clause, worth verifying) before
  vendoring anything.

---

## Build and run

```
npm install
npx cmake-js rebuild --runtime=electron --runtime-version=18.0.4 --arch=x64
  # (in node_modules/electron-spout, or via its own build script — check its README)
npm start        # DEBUG=1, nodemon + electron
```

Lint before finishing — the project has its own config:

```
npm run lint     # eslint + stylelint + htmllint
```

The eslint config is `etc-eslint.yaml`; match the existing code style, which is
distinctive: 4-space indent, no semicolons, aligned trailing comments, and
`/*  block comments with two spaces  */`.

---

## Test plan

1. Start Vingester, create a browser, set mode to **headless** (`N`), point it at
   `https://vingester.app/test/`.
2. Enable the Spout sink, disable NDI, press START.
3. In TouchDesigner, add a **Spout In TOP** and confirm the sender appears by name and
   shows moving video the right way up.
4. Check alpha: load a page with a transparent background and confirm the alpha channel
   survives into TD.
5. Enable NDI *and* Spout simultaneously and confirm both outputs are correct — this is
   the regression test for the in-place buffer mutation described above.
6. Stop and restart the browser several times; confirm the Spout sender disappears and
   reappears cleanly with no leak or duplicate-name growth.
7. Run two browsers with different sender names at once.

---

## Out of scope — do not do these

- Do not upgrade Electron.
- Do not touch the audio path; Spout is video-only.
- Do not refactor the NDI or FFmpeg sinks.
- Do not add the shared-texture / zero-copy GPU path. It needs a modern Electron and is
  a separate project.
