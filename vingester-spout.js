/*
**  Vingester ~ Ingest Web Contents as Video Streams
**  Copyright (c) 2021-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard requirements  */
const EventEmitter = require("events")

/*  electron-spout ships no index.js -- its own README has you require()
    the compiled native addon directly instead of the package name  */
const addon = "electron-spout/build/Release/electron-spout.node"

/*  the exported API  */
module.exports = class Spout extends EventEmitter {
    /*  check whether the Spout sink is available on this platform  */
    static available () {
        if (process.platform !== "win32")
            return false
        try {
            require(addon)
            return true
        }
        catch (err) {
            return false
        }
    }

    constructor (options = {}) {
        super()

        /*  determine default option values  */
        this.options = Object.assign({}, {
            name: "Vingester",
            log:  (level, msg) => {}
        }, options)

        /*  initialize state  */
        this.sender = null
    }

    async start () {
        /*  cleanup if necessary  */
        if (this.sender !== null)
            await this.stop()

        /*  lazily and safely load the (optional) native addon  */
        try {
            const { SpoutOutput } = require(addon)
            this.sender = new SpoutOutput(this.options.name)
            this.options.log("info", `Spout: sender "${this.options.name}" started`)
        }
        catch (err) {
            this.sender = null
            this.options.log("error", `Spout: sender failed to start: ${err.message}`)
            this.emit("fatal", `Spout sink failed to start: ${err.message}`)
        }
    }

    video (buffer, size) {
        if (this.sender === null)
            return
        try {
            /*  electron-spout recreates its internal staging texture
                whenever the size changes, so no manual resize handling
                is required here  */
            this.sender.updateFrame(buffer, size)
        }
        catch (err) {
            this.options.log("error", `Spout: sender failed to send frame: ${err.message}`)
            this.emit("fatal", `Spout sink failed to send frame: ${err.message}`)
        }
    }

    async stop () {
        if (this.sender !== null) {
            /*  electron-spout exposes no explicit release()/dispose() call --
                its D3D11 device and Spout sender are torn down in the C++
                destructor, which N-API invokes once this wrapper object is
                garbage collected. Dropping the last reference is therefore
                the only teardown available.  */
            this.sender = null
            this.options.log("info", `Spout: sender "${this.options.name}" stopped`)
        }
    }
}

