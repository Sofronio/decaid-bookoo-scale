# Does Decaid start the Bookoo timer when extraction starts?

Investigated against Decaid `b9f9d05` (2026-10-16).

## Short answer

Yes. Decaid's built-in Bookoo driver sends the official start-timer command when
the machine enters preinfusion/pouring, and sends reset/stop at the surrounding
shot transitions. This is automatic; no user action is needed.

It is one-way control only. Decaid does **not** read the scale's timer (or flow)
back from the weight notifications, and it does not subscribe to the auto-timer
events that the scale emits on the command characteristic.

## Call chain

| Shot phase | Decaid action | Code |
| --- | --- | --- |
| `preparingForShot` | tare + **reset timer** | `lib/src/controllers/shot_sequencer.dart:382-392` |
| `preinfusion` / `pouring` | tare again + **start timer** | `lib/src/controllers/shot_sequencer.dart:409-423` |
| `stopping` | **stop timer** | `lib/src/controllers/shot_sequencer.dart:508-514` |

The native driver maps those calls to the official Bookoo Mini commands
(`lib/src/models/device/impl/bookoo/miniscale.dart:154-173`):

| Operation | Frame |
| --- | --- |
| Tare | `03 0A 01 00 00 08` |
| Start timer | `03 0A 04 00 00 0D` |
| Stop timer | `03 0A 05 00 00 0C` |
| Reset timer | `03 0A 06 00 00 0F` |

Frames are written to `FF12` with response (`BLETransport.write` defaults to
`withResponse: true`).

## Conditions that gate the call

`startTimer()` is only reached when all of these hold:

- Gateway mode is not `full` (`bypassSAW == false`). Default is `disabled`,
  which still runs the shot sequencer (`lib/src/controllers/de1_state_manager.dart:703-712`,
  `lib/src/settings/settings_service.dart:107-114`).
- A scale is connected and not lost during the shot.
- A scale weight sample exists and is younger than 2 seconds
  (`shot_sequencer.dart:205`, `:256-269`). A Bookoo that is silent for 2 seconds
  is treated as scaleless and the timer command is not sent.

The same path applies to plugin scales that declare `timerControl`
(`lib/src/plugins/plugin_scale.dart:207-219`).

## What is missing

### 1. Timer and flow telemetry are discarded

The official `03 0B` notification carries, per 20-byte frame:

| Bytes (1-based) | Field |
| --- | --- |
| 3-5 | timer, unsigned 24-bit milliseconds |
| 7-9 | weight sign + magnitude in 1/100 g |
| 11-12 | flow sign + magnitude in 1/100 |
| 14 | battery percent |

The native parser reads only the weight sign/magnitude and battery
(`miniscale.dart:121-141`). Bytes 3-5 (timer) and 11-12 (flow) are ignored, so
Decaid has no idea what the scale's own timer is showing.

Decaid's plugin surface could expose them as `timerMs` (capability
`timerTelemetry`) and `flow` (capability `flow`); the native driver does not.

### 2. Scale-originated events are ignored

The native driver subscribes only to `FF11`. It never subscribes to `FF12`,
where the scale may send `03 0D` auto-timer start/stop events. Those events
cannot influence Decaid.

### 3. Ultra mode restriction

The Bookoo Mini and Bookoo Ultra share service `0FFE`, characteristics
`FF11`/`FF12`, and the same 20-byte `03 0B` measurement frame. Decaid's matcher
claims any scale advertisement whose name contains `bookoo` and that passes the
scale scan filter on `0ffe` (`lib/src/services/device_matcher.dart:24-35`,
`:102`, `:173`), so an Ultra is driven by the same native `BookooScale` class.

The official Ultra protocol says start/stop/reset timer are:

> "Only effective in timing-mode and ratio-mode."

Decaid has no code that selects or reads the Ultra's mode. If the scale is in
weight-mode, Decaid still writes `03 0A 04 ...`, but the firmware ignores it:
the shot starts in Decaid while the scale's display timer stays still.

The public protocol also adds packet types Decaid's parser rejects because it
requires `data[1] == 0x0B`:

- `03 0D` automatic-mode event and settlement data
- `03 0F` powder weight

So even when the timer works, the Ultra-specific surface is invisible to
Decaid.

## What the plugin in this repository does

The plugin improves on the native driver without host changes:

- Publishes `{weight, battery, timerMs, flow}` from the full `03 0B` frame,
  declaring `battery`, `flow`, and `timerTelemetry`.
- Declares `timerControl` and sends `03 0A 04/05/06` for
  `startTimer`/`stopTimer`/`resetTimer`, so Decaid's shot sequencer drives the
  scale exactly as it drives the native driver.
- Accepts the Ultra's `03 0D` and `03 0F` frames as valid traffic (so they do
  not trip the silence watchdog) but does not publish them; automatic-mode
  events and powder weight are outside the current telemetry scope.
- Keeps the 2-second silence watchdog and first-valid-packet readiness pattern
  used by the Bookoo Mini reference plugin
  (`decaid/examples/plugins/bookoo-mini.reaplugin/plugin.js`).

It does not subscribe to `FF12`. Scale-originated auto-timer events that arrive
only on that characteristic remain invisible.

What a plugin **cannot** fix from the public protocol: there is no documented
command to put an Ultra into timing/ratio mode. Until Bookoo publishes one, the
timer command remains firmware-mode dependent on Ultra hardware. Do not guess a
mode-setting frame.

## Sources

- Official Mini protocol:
  https://github.com/BooKooCode/OpenSource/blob/main/bookoo_mini_scale/protocols.md
- Official Ultra protocol:
  https://github.com/BooKooCode/OpenSource/blob/main/bookoo_ultra_scale/protocols.md
- Decaid Bookoo driver:
  `lib/src/models/device/impl/bookoo/miniscale.dart`
- Decaid shot sequencing:
  `lib/src/controllers/shot_sequencer.dart`
- Existing Bookoo Mini plugin reference:
  `examples/plugins/bookoo-mini.reaplugin/plugin.js`
