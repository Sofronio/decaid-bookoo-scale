# Bookoo Ultra hardware checklist

Only the Ultra is available for testing; Mini behaviour is inferred from the
shared protocol and has not been run.

## Before connecting

1. Put the Ultra in **timing mode** (or ratio mode). The official protocol says
   start/stop/reset timer commands are ignored in weight mode and automatic
   running.
2. Confirm Decaid's Gateway Mode is **not** `full` (Settings > Advanced). Shot
   timer commands are skipped in full gateway mode.
3. Install the plugin and let it claim the advertisement. The device ID should
   be `plugin:bookoo-scale.reaplugin:bookoo-scale:<id>`.

## Telemetry

Watch the scale tile / shot data while the scale is idle:

- [ ] Weight follows the platform, including negative values when tared.
- [ ] Battery appears once and is retained.
- [ ] Timer increases while the scale's own timer runs and reads 0 when reset.
- [ ] Flow changes while weight changes; it is 0 at rest.

If weight is off by about 28.35x, the unit byte was `02` (ounce) and the
firmware is returning ounces despite the protocol note. Record that; the driver
currently treats the value as grams.

## Extraction

Start a shot and capture the FF12 writes (nRF Connect, a second BLE sniffer, or
Decaid's logs):

- [ ] At `preparingForShot`: `03 0A 06 00 00 0F` (reset timer).
- [ ] At preinfusion/pouring: `03 0A 01 00 00 08` (tare) and
      `03 0A 04 00 00 0D` (start timer).
- [ ] At stopping: `03 0A 05 00 00 0C` (stop timer).
- [ ] The scale's display timer starts with the pour, not with the button press.

If the frames are written but the display timer does not move, the scale is not
in timing/ratio mode. If no frames are written, check gateway mode and whether
Decaid has a fresh weight sample (the shot sequencer drops a scale that has been
silent for two seconds).

## Recovery

- [ ] Put Decaid in the background and return; the scale reconnects.
- [ ] Display sleep disconnects the scale instead of powering it off.
- [ ] At least two seconds of scale silence marks the device disconnected.

## Record

Model, firmware version, host platform, notification cadence, first-packet
latency, the four command frames, timer/flow values, mode used, and any
difference between the public protocol and observed packets.
