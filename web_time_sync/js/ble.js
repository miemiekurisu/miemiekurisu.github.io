import { u16beToBytes, u32beToBytes } from './utils.js';

// Services/characteristics used by the existing web_tools controller.
const RXTX_SERVICE_UUID = '00001f10-0000-1000-8000-00805f9b34fb';
const RXTX_CHAR_UUID = '00001f1f-0000-1000-8000-00805f9b34fb';

export class BleTag {
  /** @type {BluetoothDevice|null} */
  device = null;
  /** @type {BluetoothRemoteGATTServer|null} */
  server = null;
  /** @type {BluetoothRemoteGATTCharacteristic|null} */
  rxtxChar = null;

  constructor(onDisconnect) {
    this._onDisconnect = onDisconnect;
  }

  get isConnected() {
    return !!(this.device && this.device.gatt && this.device.gatt.connected);
  }

  async requestAndConnect() {
    // Web Bluetooth requires a user gesture.
    this.device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [RXTX_SERVICE_UUID],
    });

    this.device.addEventListener('gattserverdisconnected', () => {
      this.server = null;
      this.rxtxChar = null;
      if (this._onDisconnect) this._onDisconnect();
    });

    this.server = await this.device.gatt.connect();
    const service = await this.server.getPrimaryService(RXTX_SERVICE_UUID);
    this.rxtxChar = await service.getCharacteristic(RXTX_CHAR_UUID);

    return this.device;
  }

  disconnect() {
    try {
      if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    } finally {
      this.server = null;
      this.rxtxChar = null;
      this.device = null;
    }
  }

  async writeCommand(bytes) {
    if (!this.rxtxChar) throw new Error('RxTx characteristic not available');
    // Use writeValueWithResponse for reliability.
    await this.rxtxChar.writeValueWithResponse(bytes);
  }

  /**
   * Firmware protocol (see Firmware/src/cmd_parser.c):
   * 0xDD + u32be(epoch_local_seconds) + u16be(year) + u8(month) + u8(day) + u8(week)
   * then 0xE2 to trigger refresh.
   */
  async setTime({ deviceEpochSec, year, month, day, week }) {
    const payload = new Uint8Array(1 + 4 + 2 + 1 + 1 + 1);
    payload[0] = 0xdd;
    payload.set(u32beToBytes(deviceEpochSec), 1);
    payload.set(u16beToBytes(year), 5);
    payload[7] = month & 0xff;
    payload[8] = day & 0xff;
    payload[9] = week & 0xff;

    await this.writeCommand(payload);
    await this.writeCommand(new Uint8Array([0xe2]));
  }
}
