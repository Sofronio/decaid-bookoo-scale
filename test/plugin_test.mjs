import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pluginSource = readFileSync(
  join(root, "bookoo-scale.reaplugin/plugin.js"),
  "utf8"
);
const manifest = JSON.parse(
  readFileSync(join(root, "bookoo-scale.reaplugin/manifest.json"), "utf8")
);

const SERVICE = "00000ffe-0000-1000-8000-00805f9b34fb";
const DATA_CHARACTERISTIC = "0000ff11-0000-1000-8000-00805f9b34fb";
const COMMAND_CHARACTERISTIC = "0000ff12-0000-1000-8000-00805f9b34fb";

const commands = {
  tare: [0x03, 0x0a, 0x01, 0x00, 0x00, 0x08],
  flowMode: [0x03, 0x0a, 0x0c, 0x01, 0x01, 0x05],
  tareStart: [0x03, 0x0a, 0x07, 0x00, 0x00, 0x0e],
  stopTimer: [0x03, 0x0a, 0x05, 0x00, 0x00, 0x0c]
};

function loadPlugin() {
  const context = vm.createContext({ btoa, setTimeout, clearTimeout, console });
  vm.runInContext(pluginSource, context, { filename: "plugin.js" });
  assert.equal(typeof context.createPlugin, "function");
  return context.createPlugin;
}

class FakeSession {
  constructor() {
    this.subscribers = new Map();
    this.writes = [];
    this.published = [];
    this.disconnectHandlers = [];
    this.reportDisconnectedCalls = 0;
    this.subscribed = new Promise((resolve) => {
      this.markSubscribed = resolve;
    });
    this.gatt = {
      discoverServices: async () => [SERVICE],
      onDisconnect: (callback) => this.disconnectHandlers.push(callback),
      subscribe: async (service, characteristic, callback) => {
        assert.equal(service, SERVICE);
        assert.equal(characteristic, DATA_CHARACTERISTIC);
        this.subscribers.set(characteristic, callback);
        this.markSubscribed();
      },
      writeWithResponse: async (service, characteristic, data) => {
        assert.equal(service, SERVICE);
        assert.equal(characteristic, COMMAND_CHARACTERISTIC);
        this.writes.push([...Buffer.from(data, "base64")]);
      },
      writeWithoutResponse: async () => {
        throw new Error("Bookoo commands must use writeWithResponse");
      }
    };
  }

  async emit(frame, sample = "sample") {
    await this.subscribed;
    const callback = this.subscribers.get(DATA_CHARACTERISTIC);
    assert.ok(callback, "the driver has not subscribed to FF11");
    await callback(frame.toString("base64"), sample);
  }

  publish(snapshot, sample) {
    this.published.push({ snapshot, sample });
    return Promise.resolve();
  }

  reportDisconnected() {
    this.reportDisconnectedCalls++;
    return Promise.resolve();
  }
}

function setup() {
  let binding = null;
  const host = {
    devices: {
      bindDriver(id, driver) {
        binding = { id, driver };
        return Promise.resolve();
      }
    }
  };
  const plugin = loadPlugin()(host);
  assert.equal(plugin.id, "bookoo-scale.reaplugin");
  plugin.onLoad();
  assert.equal(binding.id, "bookoo-scale");
  return { driver: binding.driver.create(), session: new FakeSession() };
}

function measurement({
  weight = 0,
  timerMs = 0,
  flow = 0,
  battery = 50,
  unit = 1,
  type = 0x0b
} = {}) {
  const bytes = Buffer.alloc(20);
  bytes[0] = 0x03;
  bytes[1] = type;
  if (type === 0x0b) {
    bytes[2] = (timerMs >> 16) & 0xff;
    bytes[3] = (timerMs >> 8) & 0xff;
    bytes[4] = timerMs & 0xff;
    bytes[5] = unit;
    bytes[6] = weight < 0 ? 0x2d : 0x2b;
    const magnitude = Math.round(Math.abs(weight) * 100);
    bytes[7] = (magnitude >> 16) & 0xff;
    bytes[8] = (magnitude >> 8) & 0xff;
    bytes[9] = magnitude & 0xff;
    bytes[10] = flow < 0 ? 0x2d : 0x2b;
    const flowMagnitude = Math.round(Math.abs(flow) * 100);
    bytes[11] = (flowMagnitude >> 8) & 0xff;
    bytes[12] = flowMagnitude & 0xff;
    bytes[13] = battery;
  } else {
    bytes[2] = 0x01;
  }
  bytes[19] = bytes.subarray(0, 19).reduce((checksum, byte) => checksum ^ byte, 0);
  return bytes;
}

test("manifest declares the Bookoo scale driver and its capabilities", () => {
  assert.equal(manifest.id, "bookoo-scale.reaplugin");
  const driver = manifest.drivers[0];
  assert.equal(driver.id, "bookoo-scale");
  assert.equal(driver.type, "scale");
  assert.deepEqual(new Set(driver.capabilities), new Set([
    "battery",
    "flow",
    "timerTelemetry",
    "tare",
    "timerControl",
    "disconnectToSleep"
  ]));
  assert.deepEqual(driver.ble.match, {
    name: { contains: "bookoo" },
    serviceUuids: ["0ffe"]
  });
});

test("publishes weight, timer, flow, and battery from 03 0B", async () => {
  const { driver, session } = setup();
  const connecting = driver.connect(session);
  await session.emit(
    measurement({ weight: 12.34, timerMs: 7000, flow: 1.5, battery: 88 }),
    "first"
  );
  await connecting;
  assert.deepEqual(JSON.parse(JSON.stringify(session.published)), [{
    snapshot: { weight: 12.34, flow: 1.5, timerMs: 7000, battery: 88 },
    sample: "first"
  }]);

  await session.emit(
    measurement({ weight: -4.5, timerMs: 0, flow: -2.25, battery: 99 })
  );
  assert.deepEqual(JSON.parse(JSON.stringify(session.published.at(-1).snapshot)), {
    weight: -4.5,
    flow: -2.25,
    timerMs: 0,
    battery: 99
  });
  driver.disconnect();
});

test("retains the last valid battery when a frame reports no percentage", async () => {
  const { driver, session } = setup();
  const connecting = driver.connect(session);
  await session.emit(measurement({ weight: 1, battery: 77 }));
  await connecting;
  await session.emit(measurement({ weight: 2, battery: 255 }));
  assert.equal(session.published.at(-1).snapshot.battery, 77);
  driver.disconnect();
});

test("a shot prepares with a tare, enters flow mode, then tares and starts", async () => {
  const { driver, session } = setup();
  const connecting = driver.connect(session);
  await session.emit(measurement({ weight: 1 }));
  await connecting;
  session.writes.length = 0;

  await driver.tare();       // preparingForShot tare
  await driver.resetTimer(); // arms the shot, sends no frame
  await driver.tare();       // pour tare: 07 covers it, so skipped
  await driver.startTimer(); // flow mode, then tare+start
  await driver.stopTimer();  // stopping
  await driver.resetTimer(); // next preparing, sends no frame

  assert.deepEqual(session.writes, [
    commands.tare,
    commands.flowMode,
    commands.tareStart,
    commands.stopTimer
  ]);
  driver.disconnect();
});

test("a bad checksum is ignored and does not satisfy readiness", async () => {
  const { driver, session } = setup();
  const connecting = driver.connect(session);
  const corrupted = measurement({ weight: 9 });
  corrupted[19] ^= 0xff;
  await session.emit(corrupted);
  assert.equal(session.published.length, 0);
  await session.emit(measurement({ weight: 3.2 }));
  await connecting;
  assert.equal(session.published.at(-1).snapshot.weight, 3.2);
  driver.disconnect();
});

test("Ultra 03 0D and 03 0F frames keep the session alive but publish nothing", async () => {
  const { driver, session } = setup();
  const connecting = driver.connect(session);
  await session.emit(measurement({ type: 0x0d }));
  await session.emit(measurement({ type: 0x0f }));
  assert.equal(session.published.length, 0);
  await session.emit(measurement({ weight: 18, timerMs: 1000 }));
  await connecting;
  assert.equal(session.published.length, 1);
  assert.equal(session.published[0].snapshot.weight, 18);
  driver.disconnect();
});

test("a disconnected session publishes nothing further", async () => {
  const { driver, session } = setup();
  const connecting = driver.connect(session);
  await session.emit(measurement({ weight: 1 }));
  await connecting;
  driver.disconnect();
  await session.emit(measurement({ weight: 2 }));
  assert.equal(session.published.length, 1);
});
