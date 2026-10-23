# Bookoo Scale for Decaid

A [Decaid](https://github.com/decentespresso/decaid) plugin that adds the Bookoo
Mini (Themis Mini) and Bookoo Ultra BLE scales. The plugin owns the device
protocol; Decaid owns discovery, the BLE connection lifecycle, and the Scale
surface.

Decaid's native Bookoo driver already tares and sends start/stop/reset timer
commands as the shot runs. This plugin keeps that timer control and adds the
scale's own timer and flow telemetry, which the native driver discards.

No Decaid release is needed to use this, and none is needed to change the driver.

中文说明见 [README.zh-CN.md](README.zh-CN.md)。

## Install

From the Decaid REST API, which installs the repository's latest release:

```bash
curl -X POST http://localhost:8080/api/v1/plugins/install/github-release \
  -H 'content-type: application/json' \
  -d '{"repo": "Sofronio/decaid-bookoo-scale"}'
```

Or open the Plugins settings screen in Decaid and install from the repository.

The public device ID is
`plugin:bookoo-scale.reaplugin:bookoo-scale:<physical id>`. An enabled matching
runtime binding overrides the native Bookoo driver on subsequent discovery;
disabling or unloading it permits native discovery again. Native and plugin IDs
are different, and stored preferences are never silently rewritten.

## What the driver matches

An advertisement whose name contains `bookoo` (case-insensitive) that also
advertises service `0ffe`. Requiring the service keeps the Bookoo MT80 grinder
out: it advertises `FFFF` and its own custom service.

Both Mini and Ultra use service `0FFE`, measurement characteristic `FF11`, and
command characteristic `FF12`, with XOR checksums and the same 20-byte
measurement frame.

## Protocol

The plugin follows Bookoo's published protocols for the
[Mini](https://github.com/BooKooCode/OpenSource/blob/main/bookoo_mini_scale/protocols.md)
and [Ultra](https://github.com/BooKooCode/OpenSource/blob/main/bookoo_ultra_scale/protocols.md).

### Measurement (`FF11`, 20 bytes)

| Bytes (1-based) | Field |
| --- | --- |
| 3-5 | timer, unsigned 24-bit milliseconds |
| 6 | unit (`01` gram, `02` ounce) |
| 7 | weight sign (`+`/`-`) |
| 8-10 | weight magnitude in 1/100 g |
| 11 | flow sign (`+`/`-`) |
| 12-13 | flow magnitude in 1/100 |
| 14 | battery percent |
| 20 | XOR checksum over bytes 1-19 |

The official Ultra note says the returned weight is always grams; the unit byte
describes the display unit, so the driver does not convert. The Ultra's `03 0D`
automatic-mode events and `03 0F` powder weight are accepted as valid traffic so
they do not trip the silence watchdog, but they are not published.

### Commands (`FF12`, six bytes, write with response)

| Operation | Frame |
| --- | --- |
| Tare | `03 0A 01 00 00 08` |
| Start timer | `03 0A 04 00 00 0D` |
| Stop timer | `03 0A 05 00 00 0C` |
| Reset timer | `03 0A 06 00 00 0F` |
| Tare + start / exit (app-observed) | `03 0A 07 00 00 0E` |
| Read serial (Ultra) | `03 0A 0A 00 00 03` → `03 0C ...` |
| Set mode (Ultra, app-observed) | `03 0A 0C MM MM CS` (`00` weight / `01` flow / `02` ratio) |
| Read device info (Ultra) | `03 0A 0F 00 00 06` → `03 0E ...` |
| Read settings (Ultra) | `03 0A 14 00 00 1D` → `03 10 ...` |
| Enter Ready (Ultra, app-observed) | `03 0A 18 00 00 11` |

The plugin follows the Bookoo N flow-mode shot sequence:

- `preparingForShot`: Decaid calls `tare()` (sends `01`) and then
  `resetTimer()`. `resetTimer()` no longer sends `06`; it only marks the shot as
  preparing so the next duplicate tare is skipped.
- `preinfusion` / `pouring`: Decaid calls `tare()` again; the plugin skips it.
  `startTimer()` then sends `0C 01 01` to enter flow mode, followed by `07`
  (tare-and-start).
- `stopping`: `stopTimer()` sends `05`.
- The next shot repeats the same sequence and re-confirms flow mode.

Each shot therefore sends:

```
01 (preparing tare) → 0C 01 01 (flow mode) → 07 (tare and start) → 05 (stop)
```

Capabilities: `battery`, `flow`, `timerTelemetry`, `tare`, `timerControl`,
`disconnectToSleep`. Display sleep disconnects rather than sending a power
command, so machine wake can reconnect the scale.

### Timer call chain

Decaid calls the driver automatically as a shot runs:

| Shot phase | Driver call and frames |
| --- | --- |
| `preparingForShot` | `tare()` → `01`; `resetTimer()` → no frame, arms the shot |
| `preinfusion` / `pouring` | `tare()` is skipped; `startTimer()` → `0C 01 01`, then `07` |
| `stopping` | `stopTimer()` → `05` |

The calls are skipped in Gateway Mode `full`, and a scale that has been silent
for two seconds is treated as lost for that shot. The plugin's own two-second
silence watchdog reports protocol failure to host recovery. The threshold is
provisional until hardware cadence is recorded.

### Ultra mode limit

The Ultra's modes are labeled `00` weight, `01` flow, and `02` ratio in the
Bookoo N app; the public docs call the last two timing-mode and ratio-mode.
Behavior differs:

- **`00` weight**: timer/ready commands are ignored; weighing and tare still
  work.
- **`01` flow**: `04/05/06` control the timer directly without first entering
  ready. `0x0D` state events may not appear, so use the FF11 timer as the source
  of truth.
- **`02` ratio**: send `18` to enter ready before `04/05`; commands outside the
  allowed state are ignored (for example, repeated `07` after exit-done).

The public docs list no command to select or read the mode, but the Bookoo N app
was observed sending `03 0A 0C MM MM CS` on a long-press of its clear/tare
button, with the mode read back in the first byte of the `0x0E` response. This
is not public protocol; use it cautiously. On Mini there is no such
restriction.

### Ultra HCI capture (2026-10-24)

An Android 11 HCI snoop of the Bookoo N app (`com.bookootech.bookoocoffee`)
talking to an Ultra recorded the full GATT flow. Advertisement name
`BOOKOO_SC_U 246641`, serial `SN25001aac0951`.

- The app subscribes to both **FF11** and **FF12** notifications.
- It writes the three handshake commands above; the replies arrive as FF12
  notifications.
- Ultra `0x0D` automatic-mode events arrive on **FF12**, not FF11. Observed
  sequence: `02` ready → `01` started → `00` stopped → `04` exit-done.
- Driving the scale from the app's on-screen left button produced:
  `01` tare → `18` ready → `04` start → `05` stop → `07` exit-done → `01` tare.
  - `18` is not in Bookoo's public protocol. It puts the Ultra into
    automatic-ready (`0x0D` state 2).
  - The app's timer-reset button sends `07`, not `06`. After `07` the scale
    enters exit-done, taring without starting a new timer; the FF11 timer had
    already reset to zero on `05`.
  - In this stopped-state context, `07` behaves as exit/tare rather than the
    documented tare-and-start.
- A long-press of the app's clear/tare button switches modes:
  - `03 0A 0C 02 02 05` → ratio mode
  - `03 0A 0C 00 00 05` → weight-only mode
  - `03 0A 0C 01 01 05` → flow mode (confirmed in the app UI)
- The first data byte of the `0x0E` response is the current mode (`00` weight /
  `01` flow / `02` ratio). The next three bytes are additional info, possibly a
  version; they changed from `07 02 02` to `07 01 02` and are not fully decoded.
- Mode behavior observed:
  - Flow mode accepts `04/05/06` directly; `0x0D` state events do not always
    appear.
  - Ratio mode needs `18` ready first; `04/05` before ready are ignored. `07`
    starts when ready and exits when stopped; repeated `07` after exit-done is
    ignored.
  - Weight mode returns no `0x0D` responses to `04/18/05/07/06`; timer control
    is inactive.
- On entering ratio mode, FF11 emits a `0x0F` powder-weight frame:
  `03 0F 2B 00 05 DC ...` = **+15.00 g**.
- The scale's physical buttons drive the same state machine locally and produce
  **no BLE writes**. The app only subscribes and displays it.
- FF11 carried `0x0B` measurements (about 10 Hz) and `0x0F` powder weight.
- The plugin subscribes only to FF11, so it does not receive the FF12 `0x0D`
  events. Weight/flow/battery telemetry is unaffected; automatic-state events
  would need a second FF12 subscription.

| Characteristic | Frames observed |
| --- | --- |
| FF11 | `03 0B` measurement, `03 0F` powder weight |
| FF12 | `03 0C` serial, `03 0D` auto state, `03 0E` mode + info, `03 10` settings |

The `03 0F` frame appeared when entering ratio mode (15.00 g); it is not sent
on every connection.

## Browser test and control page (Chrome Web Bluetooth)

The browser tool has its own repository:
[bookoo-scale-tools](https://github.com/Sofronio/bookoo-scale-tools). It supports
live telemetry, mode switching, device info, and FF12 controls for the
Mini/Ultra; see that repository for usage, features, and mode notes.

## Testing

The protocol tests run standalone with Node and do not need a Decaid checkout:

```bash
node --test test/plugin_test.mjs
```

The Decaid integration suite runs the plugin through Decaid's real plugin
loader, JavaScript runtime, `PluginManager`, `ScaleController` and BLE fixture.
Copy it into a sibling Decaid checkout and run:

```bash
cp test/decaid/helpers/bookoo_scale_plugin_fixture.dart <decaid>/test/helpers/
cp test/decaid/plugins/bookoo_scale_plugin_test.dart    <decaid>/test/plugins/
cd <decaid> && flutter test test/plugins/bookoo_scale_plugin_test.dart
```

## Verification

- Node protocol tests: 7 passing.
- Decaid integration tests: 6 passing against `decaid` `b9f9d05`.
- Browser tool (separate repository): command frames, decoding,
  `0x0D / 0x0C / 0x0E / 0x10`,
  and mock-GATT connect/reconnect pass headless Chrome checks.
- Bookoo Ultra BLE protocol: captured on hardware via Android HCI snoop
  (2026-10-24), including the app button flow and mode switching
  (`0C / 0E / 0F`).
- Bookoo Ultra driver integration: not yet tested.
- Bookoo Mini hardware: not yet tested.

For an Ultra run, switch the scale to **flow mode** (called timing mode in the
public docs) or ratio mode; in ratio mode enter Ready (`18`) first.
The step-by-step checklist is in
[`doc/ultra-hardware-checklist.md`](doc/ultra-hardware-checklist.md).

## Releasing

`scripts/package.sh` builds `dist/bookoo-scale.reaplugin-<version>.zip`.
Pushing a `vX.Y.Z` tag runs the same script in CI and publishes the release.

Decaid enforces three things the script keeps in sync:

- the release tag is `X.Y.Z` or `vX.Y.Z` and equals `manifest.version` exactly
- the release carries exactly one `.zip` asset
- the archive holds a single top-level `bookoo-scale.reaplugin/` directory
  containing `manifest.json` and `plugin.js`

So bump `manifest.version` and tag the same version. A release whose tag and
manifest disagree is rejected at install time.

## 相关链接

- [Decaid 官方仓库](https://github.com/decentespresso/decaid)
- [Bookoo 官方开源协议仓库](https://github.com/BooKooCode/OpenSource)
- [Bookoo Mini 协议（英文）](https://github.com/BooKooCode/OpenSource/blob/main/bookoo_mini_scale/protocols.md)
- [Bookoo Ultra 协议（英文）](https://github.com/BooKooCode/OpenSource/blob/main/bookoo_ultra_scale/protocols.md)
- [Decaid 里的原生计时调用链调查](doc/decaid-timer-control-investigation.md)
- [Bookoo Ultra 实机验证清单](doc/ultra-hardware-checklist.md)

## License

Not yet chosen. Until one is added, this repository is all rights reserved by
default. The linked Bookoo protocol documentation is MIT-licensed.
