"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __await = (this && this.__await) || function (v) { return this instanceof __await ? (this.v = v, this) : new __await(v); }
var __asyncGenerator = (this && this.__asyncGenerator) || function (thisArg, _arguments, generator) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var g = generator.apply(thisArg, _arguments || []), i, q = [];
    return i = Object.create((typeof AsyncIterator === "function" ? AsyncIterator : Object).prototype), verb("next"), verb("throw"), verb("return", awaitReturn), i[Symbol.asyncIterator] = function () { return this; }, i;
    function awaitReturn(f) { return function (v) { return Promise.resolve(v).then(f, reject); }; }
    function verb(n, f) { if (g[n]) { i[n] = function (v) { return new Promise(function (a, b) { q.push([n, v, a, b]) > 1 || resume(n, v); }); }; if (f) i[n] = f(i[n]); } }
    function resume(n, v) { try { step(g[n](v)); } catch (e) { settle(q[0][3], e); } }
    function step(r) { r.value instanceof __await ? Promise.resolve(r.value.v).then(fulfill, reject) : settle(q[0][2], r); }
    function fulfill(value) { resume("next", value); }
    function reject(value) { resume("throw", value); }
    function settle(f, v) { if (f(v), q.shift(), q.length) resume(q[0][0], q[0][1]); }
};
var __asyncValues = (this && this.__asyncValues) || function (o) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var m = o[Symbol.asyncIterator], i;
    return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function () { return this; }, i);
    function verb(n) { i[n] = o[n] && function (v) { return new Promise(function (resolve, reject) { v = o[n](v), settle(resolve, reject, v.done, v.value); }); }; }
    function settle(resolve, reject, d, v) { Promise.resolve(v).then(function(v) { resolve({ value: v, done: d }); }, reject); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.store = exports.Session = exports.THINKING = exports.PERMISSION_MODES = void 0;
var fs_1 = require("fs");
var claude_agent_sdk_1 = require("@anthropic-ai/claude-agent-sdk");
exports.PERMISSION_MODES = [
    "default",
    "acceptEdits",
    "plan",
    "bypassPermissions",
];
exports.THINKING = [
    { label: "auto", tokens: null },
    { label: "off", tokens: 0 },
    { label: "high", tokens: 32000 },
];
function detail(input) {
    var _a, _b;
    var keys = ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt"];
    var found = keys.map(function (k) { return input[k]; }).find(function (v) { return typeof v === "string"; });
    var text = (_b = (_a = found) !== null && _a !== void 0 ? _a : JSON.stringify(input)) !== null && _b !== void 0 ? _b : "";
    var flat = text.replace(/\s+/g, " ");
    return flat.length > 64 ? "".concat(flat.slice(0, 61), "\u2026") : flat;
}
var Session = /** @class */ (function () {
    function Session(notify) {
        var _this = this;
        this.notify = notify;
        this.items = [];
        this.working = false;
        this.activity = "";
        this.model = "";
        this.mode = "default";
        this.thinking = 0;
        this.cost = 0;
        this.ask = null;
        this.models = [];
        this.queue = [];
        this.wake = null;
        this.tools = new Map();
        this.draftFrom = null;
        this.q = (0, claude_agent_sdk_1.query)({
            prompt: this.outgoing(),
            options: {
                systemPrompt: { type: "preset", preset: "claude_code" },
                permissionMode: this.mode,
                includePartialMessages: true,
                canUseTool: function (tool, input) {
                    return new Promise(function (resolve) {
                        _this.ask = {
                            tool: tool,
                            detail: detail(input),
                            resolve: function (allow) {
                                _this.ask = null;
                                _this.notify();
                                resolve(allow
                                    ? { behavior: "allow", updatedInput: input }
                                    : { behavior: "deny", message: "The user declined this tool use." });
                            },
                        };
                        _this.notify();
                    });
                },
            },
        });
        void this.run();
        void this.q.supportedModels().then(function (models) { return (_this.models = models); });
    }
    Session.prototype.title = function () {
        var first = this.items.find(function (item) { return item.kind === "user"; });
        if ((first === null || first === void 0 ? void 0 : first.kind) !== "user")
            return "new session";
        return first.text.length > 22 ? "".concat(first.text.slice(0, 21), "\u2026") : first.text;
    };
    Session.prototype.send = function (text) {
        var _a;
        this.items.push({ kind: "user", text: text });
        this.working = true;
        this.queue.push({
            type: "user",
            session_id: "",
            parent_tool_use_id: null,
            message: { role: "user", content: text },
        });
        (_a = this.wake) === null || _a === void 0 ? void 0 : _a.call(this);
        this.notify();
    };
    Session.prototype.interrupt = function () {
        var _this = this;
        if (this.ask) {
            this.ask.resolve(false);
            return;
        }
        if (!this.working)
            return;
        void this.q.interrupt().then(function () {
            _this.working = false;
            _this.activity = "";
            _this.notify();
        });
    };
    Session.prototype.cycleModel = function () {
        var _this = this;
        if (this.models.length === 0)
            return;
        var at = this.models.findIndex(function (m) { return m.value === _this.model; });
        var next = this.models[(at + 1) % this.models.length];
        this.model = next.value;
        void this.q.setModel(next.value);
        this.notify();
    };
    Session.prototype.cycleMode = function () {
        var at = exports.PERMISSION_MODES.indexOf(this.mode);
        this.mode = exports.PERMISSION_MODES[(at + 1) % exports.PERMISSION_MODES.length];
        void this.q.setPermissionMode(this.mode);
        this.notify();
    };
    Session.prototype.cycleThinking = function () {
        this.thinking = (this.thinking + 1) % exports.THINKING.length;
        void this.q.setMaxThinkingTokens(exports.THINKING[this.thinking].tokens);
        this.notify();
    };
    Session.prototype.outgoing = function () {
        return __asyncGenerator(this, arguments, function outgoing_1() {
            var _this = this;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!true) return [3 /*break*/, 6];
                        _a.label = 1;
                    case 1:
                        if (!(this.queue.length > 0)) return [3 /*break*/, 4];
                        return [4 /*yield*/, __await(this.queue.shift())];
                    case 2: return [4 /*yield*/, _a.sent()];
                    case 3:
                        _a.sent();
                        return [3 /*break*/, 1];
                    case 4: return [4 /*yield*/, __await(new Promise(function (resolve) { return (_this.wake = resolve); }))];
                    case 5:
                        _a.sent();
                        this.wake = null;
                        return [3 /*break*/, 0];
                    case 6: return [2 /*return*/];
                }
            });
        });
    };
    Session.prototype.run = function () {
        return __awaiter(this, void 0, void 0, function () {
            var _a, _b, _c, message, e_1_1, error_1;
            var _d, e_1, _e, _f;
            return __generator(this, function (_g) {
                switch (_g.label) {
                    case 0:
                        _g.trys.push([0, 13, , 14]);
                        _g.label = 1;
                    case 1:
                        _g.trys.push([1, 6, 7, 12]);
                        _a = true, _b = __asyncValues(this.q);
                        _g.label = 2;
                    case 2: return [4 /*yield*/, _b.next()];
                    case 3:
                        if (!(_c = _g.sent(), _d = _c.done, !_d)) return [3 /*break*/, 5];
                        _f = _c.value;
                        _a = false;
                        message = _f;
                        if (process.env.AGENT_LOG) {
                            (0, fs_1.appendFileSync)(process.env.AGENT_LOG, "".concat(JSON.stringify(message), "\n"));
                        }
                        this.handle(message);
                        _g.label = 4;
                    case 4:
                        _a = true;
                        return [3 /*break*/, 2];
                    case 5: return [3 /*break*/, 12];
                    case 6:
                        e_1_1 = _g.sent();
                        e_1 = { error: e_1_1 };
                        return [3 /*break*/, 12];
                    case 7:
                        _g.trys.push([7, , 10, 11]);
                        if (!(!_a && !_d && (_e = _b.return))) return [3 /*break*/, 9];
                        return [4 /*yield*/, _e.call(_b)];
                    case 8:
                        _g.sent();
                        _g.label = 9;
                    case 9: return [3 /*break*/, 11];
                    case 10:
                        if (e_1) throw e_1.error;
                        return [7 /*endfinally*/];
                    case 11: return [7 /*endfinally*/];
                    case 12: return [3 /*break*/, 14];
                    case 13:
                        error_1 = _g.sent();
                        this.items.push({ kind: "assistant", text: "error: ".concat(String(error_1)) });
                        this.working = false;
                        this.notify();
                        return [3 /*break*/, 14];
                    case 14: return [2 /*return*/];
                }
            });
        });
    };
    Session.prototype.handle = function (message) {
        var _a, _b, _c, _d, _e, _f;
        switch (message.type) {
            case "system":
                if (message.subtype === "init") {
                    this.model = message.model;
                    this.mode = message.permissionMode;
                }
                break;
            case "stream_event": {
                if (message.parent_tool_use_id !== null)
                    break;
                var event_1 = message.event;
                if (event_1.type === "content_block_start") {
                    if (((_a = event_1.content_block) === null || _a === void 0 ? void 0 : _a.type) === "thinking")
                        this.activity = "thinking";
                    if (((_b = event_1.content_block) === null || _b === void 0 ? void 0 : _b.type) === "text") {
                        this.activity = "";
                        (_c = this.draftFrom) !== null && _c !== void 0 ? _c : (this.draftFrom = this.items.length);
                        this.items.push({ kind: "assistant", text: "" });
                    }
                }
                if (event_1.type === "content_block_delta" && ((_d = event_1.delta) === null || _d === void 0 ? void 0 : _d.type) === "text_delta") {
                    var last = this.items[this.items.length - 1];
                    if ((last === null || last === void 0 ? void 0 : last.kind) === "assistant")
                        last.text += (_e = event_1.delta.text) !== null && _e !== void 0 ? _e : "";
                }
                break;
            }
            case "assistant": {
                var inSubagent = message.parent_tool_use_id !== null;
                // Replace streamed drafts with the authoritative message.
                if (!inSubagent && this.draftFrom !== null) {
                    this.items.splice(this.draftFrom);
                    this.draftFrom = null;
                }
                for (var _i = 0, _g = message.message.content; _i < _g.length; _i++) {
                    var block = _g[_i];
                    if (block.type === "text" && block.text && !inSubagent) {
                        this.items.push({ kind: "assistant", text: block.text });
                    }
                    if (block.type === "tool_use" && block.id && block.name) {
                        var call = {
                            id: block.id,
                            name: block.name,
                            detail: detail((_f = block.input) !== null && _f !== void 0 ? _f : {}),
                            status: "running",
                            kids: [],
                        };
                        this.tools.set(call.id, call);
                        var parent_1 = message.parent_tool_use_id
                            ? this.tools.get(message.parent_tool_use_id)
                            : undefined;
                        if (parent_1)
                            parent_1.kids.push(call);
                        else
                            this.items.push({ kind: "tool", call: call });
                        this.activity = block.name;
                    }
                }
                break;
            }
            case "user": {
                var content = message.message.content;
                if (!Array.isArray(content))
                    break;
                for (var _h = 0, _j = content; _h < _j.length; _h++) {
                    var block = _j[_h];
                    if (block.type !== "tool_result" || !block.tool_use_id)
                        continue;
                    var call = this.tools.get(block.tool_use_id);
                    if (call)
                        call.status = block.is_error ? "error" : "ok";
                    if (message.parent_tool_use_id === null)
                        this.activity = "";
                }
                break;
            }
            case "result":
                this.working = false;
                this.activity = "";
                this.cost = message.total_cost_usd;
                if (message.subtype !== "success") {
                    this.items.push({ kind: "assistant", text: "error: ".concat(message.subtype) });
                }
                break;
        }
        this.notify();
    };
    return Session;
}());
exports.Session = Session;
var Store = /** @class */ (function () {
    function Store() {
        var _this = this;
        this.sessions = [];
        this.at = 0;
        this.sidebar = false;
        this.version = 0;
        this.listeners = new Set();
        this.notify = function () {
            _this.version += 1;
            for (var _i = 0, _a = _this.listeners; _i < _a.length; _i++) {
                var listener = _a[_i];
                listener();
            }
        };
        this.subscribe = function (listener) {
            _this.listeners.add(listener);
            return function () { return _this.listeners.delete(listener); };
        };
        this.snapshot = function () { return _this.version; };
        this.sessions.push(new Session(this.notify));
    }
    Store.prototype.active = function () {
        return this.sessions[this.at];
    };
    Store.prototype.add = function () {
        this.sessions.push(new Session(this.notify));
        this.at = this.sessions.length - 1;
        this.notify();
    };
    Store.prototype.select = function (at) {
        this.at = at;
        this.notify();
    };
    Store.prototype.toggleSidebar = function () {
        this.sidebar = !this.sidebar;
        this.notify();
    };
    return Store;
}());
exports.store = new Store();
