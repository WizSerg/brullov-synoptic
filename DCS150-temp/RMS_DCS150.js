//
//  Конференц-система RMS DCS150
//  UDP 18092 -> 18093
//
//  (c) Sergei Bagriantsev, 2025, 
//  sergei.bagriantsev@gmail.com
//

const EventEmitter = require('events')
const udp = require('dgram');

const PORT_TX = 18092;
const PORT_RX = 18093;

const STX = 0xEE;
const ETX = 0xFE;

const FUNC_MIC_ON    = 0x01;
const FUNC_MIC_OFF   = 0x02;
const FUNC_NOTIFY    = 0x87;
const FUNC_KEEPALIVE = 0x98;
const FUNC_SYNC      = 0x0D;

const BROADCAST_ADDR = 0x00;

// Полезные утилиты
const toHex = (buf) => [...buf].map(b => b.toString(16).padStart(2, '0')).join(' ').toUpperCase();

module.exports = class DCS150 extends EventEmitter {
    /**
       * @param {string} dcs_ip_addr
       * @param {string} ctrl_ip_addr
       * @param {object} [opts]
       * @param {boolean} [opts.debug=true]
       * @param {boolean} [opts.autoRestart=true] - авто-переподнятие при ошибках/закрытии
       * @param {number}  [opts.restartDelayMs=1000] - задержка перед переподнятием
       */
    constructor(dcs_ip_addr, ctrl_ip_addr, opts = {}) {
        super();

        this.IP = dcs_ip_addr;
        this.bindAddress = ctrl_ip_addr 
        this.debug = opts.debug ?? true;

        this.autoRestart = opts.autoRestart ?? true;
        this.restartDelayMs = opts.restartDelayMs ?? 1000;

        this._socket = null;
        this._listening = false;
        this._sendingQueue = []; // буфер на время до listening
        this._closed = false;    // для destroy()

        // бинды
        this._onMessage = this._onMessage.bind(this);
        this._onError = this._onError.bind(this);
        this._onListening = this._onListening.bind(this);
        this._onClose = this._onClose.bind(this);

        // open mics
        this.openMics = [];

        // авто-старт сразу
        this._bindSocket();
        this.log("Starting...");
    }

    log = function (mess) {
        if (this.debug) {
            let d = new Date();
            let time = d.getHours().toString().padStart(2, '0') + ":" + d.getMinutes().toString().padStart(2, '0') + ":" +
                d.getSeconds().toString().padStart(2, '0') + "." + d.getMilliseconds().toString().padStart(3, '0');
            console.log(`${time} DCS150 [${this.IP}] ${mess}`);
        }
    }

    // --- Публичные методы управления -----------------------------------------
    micOn = (micNumber) => { this.send(micNumber, FUNC_MIC_ON, []); }
    micOff = (micNumber) => { this.send(micNumber, FUNC_MIC_OFF, []); }
    toggle = (mic) => {
        if (this.openMics.includes(mic)) {
            this.micOff(mic);
        } else {
            this.micOn(mic);
        }
    }
    sync = () => {
        const octets = this._ipToOctets(this.bindAddress);
        this.send(BROADCAST_ADDR, FUNC_SYNC, octets)
    }
    
    send(address, func, payload = []) {
        this._sendFrameQueued(address, func, payload);
    }

    destroy() {
        this.autoRestart = false;
        this._closed = true;
        this._sendingQueue.length = 0;
        if (this._socket) {
            this._socket.close(); // вызовет _onClose
        }
    }

    // --- Внутренняя сеть/UDP --------------------------------------------------
    _bindSocket() {
        if (this._closed) return;
        this._listening = false;

        this._socket = udp.createSocket('udp4');
        this._socket.on('error', this._onError);
        this._socket.on('message', this._onMessage);
        this._socket.on('listening', this._onListening);
        this._socket.on('close', this._onClose);

        try {
            this._socket.bind(PORT_RX, this.bindAddress);
            this.log(`Binding UDP ${this.bindAddress}:${PORT_RX} (device ${this.IP}:${PORT_TX})`);
        } catch (e) {
            this.emit('error', e);
            this.log(`Bind failed: ${e.message}`);
            this._scheduleRestart();
        }
    }

    _scheduleRestart() {
        if (!this.autoRestart || this._closed) return;
        this.log(`Restarting in ${this.restartDelayMs} ms...`);
        setTimeout(() => this._bindSocket(), this.restartDelayMs);
    }

    _onListening() {
        this._listening = true;
        const a = this._socket.address();
        this.log(`Listening on ${a.address}:${a.port}`);
        this.emit('ready');          // событие готовности
        this.emit('listening', a);   // совместимость со старым именем

        this.sync();

        // флэш очереди
        if (this._sendingQueue.length) {
            const queue = this._sendingQueue.slice();
            this._sendingQueue.length = 0;
            for (const [address, func, data] of queue) {
                this._sendFrameNow(address, func, data);
            }
        }
    }

    _onClose() {
        this._listening = false;
        this.log('Socket closed');
        if (!this._closed) this._scheduleRestart();
    }

    _onError(err) {
        this.emit('error', err);
        this.log(`Socket error: ${err.message}`);
        try { this._socket && this._socket.close(); } catch (_) { }
    }

    _onMessage(msg, rinfo) {
        this.log(`RX: ${toHex(msg)} from ${rinfo.address}:${rinfo.port}`);

        // keep-alive: EE 00 98 00 FE -> ответить тем же
        if (msg.length === 5 &&
            msg[0] === STX &&
            msg[1] === 0x00 &&
            msg[2] === FUNC_KEEPALIVE &&
            msg[3] === 0x00 &&
            msg[4] === ETX) {
            this._sendFrameQueued(0x00, FUNC_KEEPALIVE, []);
            return;
        }

        // базовая валидация
        if (msg.length < 5 || msg[0] !== STX || msg[msg.length - 1] !== ETX) {
            this.emit('error', new Error(`Bad frame: ${toHex(msg)}`));
            return;
        }

        const address = msg[1];
        const func = msg[2];
        const len = msg[3];

        if (msg.length !== 5 + len) {
            this.emit('error', new Error(`Length mismatch: declared ${len}, actual ${msg.length - 5}. Raw: ${toHex(msg)}`));
            return;
        }

        const data = msg.slice(4, 4 + len);
        this.emit('frame', { raw: msg, address, func, data: Buffer.from(data) });

        if (func === FUNC_NOTIFY) {
            // ожидаем EE <addr> 87 01 <state>
            if (len === 1) {
                const state = data[0] === 0x01;
                const mic = address;
                this.emit('mic', { mic, on: state });
                this.log(`Notify: mic #${mic} -> ${state ? 'ON' : 'OFF'}`);
            }
            return;
        }

        // простая передача наверх как ACK/эко
        this.emit('ack', { address, func, data: Buffer.from(data) });
    }

    // --- Отправка -------------------------------------------------------------
    _frame(address, func, payload = []) {
        const arr = Array.isArray(payload) ? payload : [...payload];
        const len = arr.length & 0xFF;
        return Buffer.from([STX, address & 0xFF, func & 0xFF, len, ...arr, ETX]);
    }

    _sendFrameQueued(address, func, payload = []) {
        if (!this._socket || !this._listening) {
            // сокет ещё не готов — буферизуем
            this._sendingQueue.push([address, func, payload]);
            return;
        }
        this._sendFrameNow(address, func, payload);
    }    

    _sendFrameNow(address, func, payload = []) {
        if (!this._socket) return;
        const buf = this._frame(address, func, payload);
        this._socket.send(buf, PORT_TX, this.IP, (err) => {
            if (err) {
                this.emit('error', err);
            } else {
                this.log(`TX: ${toHex(buf)}`);
            }
        });
    }

    _ipToOctets(ip) {
        const parts = String(ip).split('.').map(x => Number(x) & 0xFF);
        // защита от мусора
        while (parts.length < 4) parts.push(0);
        return parts.slice(0, 4);
    }    
};

