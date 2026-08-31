/*
**  Vingester ~ Ingest Web Contents as Video Streams
**  Copyright (c) 2021-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  build the optional native Spout addon (Windows only) as part of "npm install" --
    this never fails the overall install: any missing prerequisite or build error
    is logged and swallowed, simply leaving the Spout sink unavailable at runtime
    (see vingester-spout.js: Spout.available())  */

const path = require("path")
const fs   = require("fs")
const os   = require("os")
const cp   = require("child_process")

const log = (msg) => console.log(`vingester-spout-build: ${msg}`)

const run = (cmd, args, opts = {}) =>
    cp.execFileSync(cmd, args, { stdio: "inherit", ...opts })

const runNode = (script, args, opts = {}) =>
    cp.execFileSync(process.execPath, [ script, ...args ], { stdio: "inherit", ...opts })

const main = () => {
    if (process.platform !== "win32") {
        log("skipping: Spout is Windows-only")
        return
    }

    const addonDir = path.join(__dirname, "node_modules", "electron-spout")
    if (!fs.existsSync(addonDir)) {
        log("skipping: node_modules/electron-spout not present (optional dependency did not install)")
        return
    }

    const pkg = require("./package.json")
    const electronVersion = pkg.devDependencies.electron

    /*  reuse an existing vcpkg checkout (VCPKG_ROOT) or bootstrap a local one  */
    const vcpkgRoot = process.env.VCPKG_ROOT || path.join(os.homedir(), "repos", "vcpkg")
    const vcpkgExe  = path.join(vcpkgRoot, "vcpkg.exe")
    if (!fs.existsSync(vcpkgExe)) {
        log(`bootstrapping vcpkg into ${vcpkgRoot} (this fetches and builds Spout2 from source -- can take a few minutes)`)
        run("git", [ "clone", "--depth", "1", "https://github.com/microsoft/vcpkg.git", vcpkgRoot ])
        run(path.join(vcpkgRoot, "bootstrap-vcpkg.bat"), [], { shell: true })
    }
    /*  electron-spout's own PreLoad.cmake (auto-loaded by CMake before anything
        else, including before any -D flag) sets CMAKE_TOOLCHAIN_FILE itself from
        $ENV{VCPKG_ROOT} via CACHE INTERNAL ... FORCE -- which overrides any -D we
        could pass here. So the only thing this needs is VCPKG_ROOT in the child
        process environment; vcpkg then auto-detects the "x64-windows" triplet from
        the "Visual Studio 17 2022" generator on its own  */
    const cmakeJs = path.join(__dirname, "node_modules", "cmake-js", "bin", "cmake-js")
    log(`building electron-spout against Electron ${electronVersion}`)
    runNode(cmakeJs, [
        "build",
        "--runtime=electron", `--runtime-version=${electronVersion}`, "--arch=x64"
    ], { cwd: addonDir, env: { ...process.env, VCPKG_ROOT: vcpkgRoot } })

    log("Spout addon build complete")
}

try {
    main()
}
catch (err) {
    log(`WARNING: Spout addon build failed, the Spout sink will be unavailable: ${err.message}`)
}
