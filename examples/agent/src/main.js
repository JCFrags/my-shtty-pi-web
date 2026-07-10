"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var pixel_react_1 = require("pixel-react");
var App_1 = require("./App");
var session_1 = require("./session");
var root = (0, pixel_react_1.createRoot)({
    onKey: function (event) {
        if (event.mods.ctrl && event.key === "q") {
            root.stop();
            process.exit(0);
        }
        if (event.mods.super && event.key === "b") {
            session_1.store.toggleSidebar();
            return;
        }
        var session = session_1.store.active();
        if (session.ask) {
            if (event.key === "enter" || event.key === "y")
                session.ask.resolve(true);
            if (event.key === "escape" || event.key === "n")
                session.ask.resolve(false);
            return;
        }
        if (event.key === "escape")
            session.interrupt();
        if (event.mods.ctrl && event.key === "o")
            session.cycleModel();
        if (event.mods.ctrl && event.key === "p")
            session.cycleMode();
        if (event.mods.ctrl && event.key === "t")
            session.cycleThinking();
    },
});
root.render(<App_1.App info={root.info}/>);
