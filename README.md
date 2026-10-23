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

Decaid's shot sequencer tares and starts separately, so `startTimer()` maps to
`04`; the protocol's combined `07` (tare-and-start) is left unused.

Capabilities: `battery`, `flow`, `timerTelemetry`, `tare`, `timerControl`,
`disconnectToSleep`. Display sleep disconnects rather than sending a power
command, so machine wake can reconnect the scale.

### Timer call chain

Decaid calls the driver automatically as a shot runs:

| Shot phase | Driver call |
| --- | --- |
| `preparingForShot` | `resetTimer()` |
| `preinfusion` / `pouring` | `startTimer()` |
| `stopping` | `stopTimer()` |

The calls are skipped in Gateway Mode `full`, and a scale that has been silent
for two seconds is treated as lost for that shot. The plugin's own two-second
silence watchdog reports protocol failure to host recovery. The threshold is
provisional until hardware cadence is recorded.

### Ultra mode limit

The Ultra accepts start/stop/reset timer commands only in timing-mode and
ratio-mode. Bookoo publishes no command to select or read that mode, so a scale
left in weight-mode ignores the frames even though Decaid sends them. On Mini
there is no such restriction. Do not invent a mode-setting frame.

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
- Bookoo Ultra hardware: not yet tested.
- Bookoo Mini hardware: not yet tested.

For an Ultra run, switch the scale to **timing mode** (or ratio mode) first.
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
