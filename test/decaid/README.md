# Decaid integration tests

These tests exercise the plugin through Decaid's real `PluginManager`,
`ScaleController`, plugin loader and JavaScript runtime. They are not
standalone: the imports resolve against a Decaid checkout, and the fixture
loads the plugin from `../decaid-bookoo-scale/bookoo-scale.reaplugin`, so both
repositories must sit side by side.

Run them from a Decaid checkout:

```bash
cp test/decaid/helpers/bookoo_scale_plugin_fixture.dart <decaid>/test/helpers/
cp test/decaid/plugins/bookoo_scale_plugin_test.dart    <decaid>/test/plugins/
cd <decaid> && flutter test test/plugins/bookoo_scale_plugin_test.dart
```

The copies are temporary; keep the source of truth in this repository.

## What they cover

- Manifest parsing and the declared Scale capabilities.
- Discovery matching: `bookoo` + `0ffe` claims; the MT80 (`FFFF`) and unrelated
  names do not.
- Connect readiness after the first accepted `03 0B` publication.
- `timerMs` and `flow` reaching `WeightSnapshot`, including negative weight,
  a zero timer, and battery retention when a frame reports an implausible
  percentage.
- The four command frames byte-for-byte, on `FF12`, with response.
- Ultra `03 0D` events keeping the session alive without publishing a sample.
- Display sleep going through `disconnectToSleep`.
