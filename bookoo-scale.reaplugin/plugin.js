function createPlugin(host) {
  const service = "00000ffe-0000-1000-8000-00805f9b34fb";
  const dataCharacteristic = "0000ff11-0000-1000-8000-00805f9b34fb";
  const commandCharacteristic = "0000ff12-0000-1000-8000-00805f9b34fb";
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  // Official Bookoo Mini and Ultra protocols share the 20-byte 03 0B
  // measurement frame: timer ms at 2-4, unit at 5, weight at 6-9, flow at
  // 10-12, battery at 13, XOR checksum at 19 (zero-based).
  function decodeBase64(data) {
    if (typeof data !== "string" || data.length !== 28 || data[27] !== "=") return null;
    const bytes = [];
    for (let i = 0; i < data.length; i += 4) {
      const a = alphabet.indexOf(data[i]);
      const b = alphabet.indexOf(data[i + 1]);
      const c = alphabet.indexOf(data[i + 2]);
      const d = data[i + 3] === "=" ? 0 : alphabet.indexOf(data[i + 3]);
      if (a < 0 || b < 0 || c < 0 || d < 0) return null;
      bytes.push((a << 2) | (b >> 4), ((b & 15) << 4) | (c >> 2));
      if (data[i + 3] !== "=") bytes.push(((c & 3) << 6) | d);
    }
    return bytes.length === 20 ? bytes : null;
  }

  function decodeFrame(data) {
    const bytes = decodeBase64(data);
    if (!bytes || bytes[0] !== 3) return null;
    let checksum = 0;
    for (let i = 0; i < 19; i++) checksum ^= bytes[i];
    if (checksum !== bytes[19]) return null;
    // 0x0B is the measurement frame. The Ultra also sends 0x0D automatic
    // mode events and 0x0F powder weight here; they keep the session alive
    // but carry no field this driver publishes.
    if (bytes[1] !== 0x0b) return {type: bytes[1]};
    if (bytes[6] !== 0x2b && bytes[6] !== 0x2d) return null;
    const magnitude = (bytes[7] << 16) | (bytes[8] << 8) | bytes[9];
    const flowMagnitude = (bytes[11] << 8) | bytes[12];
    const flowSign = bytes[10] === 0x2d ? -1 : bytes[10] === 0x2b ? 1 : 0;
    return {
      type: 0x0b,
      weight: (bytes[6] === 0x2d ? -magnitude : magnitude) / 100,
      timerMs: (bytes[2] << 16) | (bytes[3] << 8) | bytes[4],
      flow: (flowSign * flowMagnitude) / 100,
      battery: bytes[13] <= 100 ? bytes[13] : null
    };
  }

  return {
    id: "bookoo-scale.reaplugin",
    onLoad() {
      return host.devices.bindDriver("bookoo-scale", {
        create() {
          let active = null;
          let preparing = false;

          function stop(state) {
            if (!state || state.stopped) return;
            state.stopped = true;
            clearTimeout(state.timer);
          }

          function command(opcode, data1 = 0, data2 = 0) {
            const state = active;
            if (!state || state.stopped) {
              return Promise.reject(new Error("Bookoo session is not connected"));
            }
            const bytes = [0x03, 0x0a, opcode, data1, data2];
            bytes.push(bytes.reduce((checksum, byte) => checksum ^ byte, 0));
            // FF12 acknowledges commands; writeWithResponse is the path the
            // reference client and the native driver both use.
            return state.session.gatt.writeWithResponse(
              service,
              commandCharacteristic,
              btoa(String.fromCharCode(...bytes))
            );
          }

          function watchPackets(state, fail) {
            clearTimeout(state.timer);
            state.timer = setTimeout(() => {
              stop(state);
              fail(new Error("Bookoo protocol silence"));
              state.session.reportDisconnected().catch(() => {});
            }, 2000);
          }

          return {
            async connect(session) {
              const state = {session, stopped: false, timer: null};
              active = state;
              preparing = false;
              let battery = null;
              let ready;
              let failed;
              let settled = false;
              const firstMeasurement = new Promise((resolve, reject) => {
                ready = resolve;
                failed = reject;
              });
              firstMeasurement.catch(() => {});
              function succeed() {
                if (!settled) {
                  settled = true;
                  ready();
                }
              }
              function fail(error) {
                if (!settled) {
                  settled = true;
                  failed(error);
                }
              }
              try {
                const services = await session.gatt.discoverServices();
                if (!services.includes(service)) throw new Error("Bookoo service unavailable");
                session.gatt.onDisconnect(() => {
                  stop(state);
                  fail(new Error("Bookoo disconnected before readiness"));
                });
                await session.gatt.subscribe(service, dataCharacteristic, async (data, sample) => {
                  if (state.stopped) return;
                  const frame = decodeFrame(data);
                  if (!frame) return;
                  // Any checksummed Bookoo frame proves the link is alive,
                  // including Ultra events that are not published.
                  watchPackets(state, fail);
                  if (frame.type !== 0x0b) return;
                  if (frame.battery !== null) battery = frame.battery;
                  const snapshot = {
                    weight: frame.weight,
                    flow: frame.flow,
                    timerMs: frame.timerMs
                  };
                  if (battery !== null) snapshot.battery = battery;
                  try {
                    await session.publish(snapshot, sample);
                  } catch (error) {
                    return;
                  }
                  if (!state.stopped) succeed();
                });
                if (!state.stopped && state.timer === null) watchPackets(state, fail);
                await firstMeasurement;
              } catch (error) {
                stop(state);
                fail(error);
                throw error;
              }
            },
            disconnect() {
              preparing = false;
              stop(active);
            },
            tare() {
              // The shot sequencer calls tare() again right before
              // startTimer(); 07 already tares, so skip the duplicate.
              if (preparing) return Promise.resolve();
              return command(0x01);
            },
            startTimer() {
              preparing = false;
              // Enter flow mode, then tare and start in one frame. This is
              // the sequence the Bookoo N app uses for a flow-mode shot.
              return command(0x0c, 0x01, 0x01).then(() => command(0x07));
            },
            stopTimer() {
              preparing = false;
              return command(0x05);
            },
            resetTimer() {
              // Called at preparingForShot. 07 in startTimer() handles the
              // tare/start, so only arm the duplicate-tare skip; do not send
              // the old 06 reset frame.
              preparing = true;
              return Promise.resolve();
            }
          };
        }
      });
    }
  };
}
