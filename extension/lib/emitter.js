// Minimal event emitter; the shell's misc/signals.js is not importable outside the shell.

export class Emitter {
    constructor() {
        this._handlers = new Map();
        this._nextId = 1;
    }

    connect(name, callback) {
        const id = this._nextId++;
        this._handlers.set(id, {name, callback});
        return id;
    }

    disconnect(id) {
        this._handlers.delete(id);
    }

    disconnectAll() {
        this._handlers.clear();
    }

    emit(name, ...args) {
        for (const {name: n, callback} of [...this._handlers.values()]) {
            if (n !== name)
                continue;
            try {
                callback(this, ...args);
            } catch (e) {
                console.error(`benq-monitor-control: ${name} handler failed: ${e}\n${e.stack}`);
            }
        }
    }
}
