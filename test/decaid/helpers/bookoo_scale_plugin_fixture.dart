import 'dart:convert';
import 'dart:io';

import 'package:reaprime/src/plugins/plugin_manifest.dart';
import 'package:reaprime/src/plugins/plugin_manager.dart';

/// Sibling checkout, relative to the Decaid repository root the tests run from.
const bookooScalePluginPath =
    '../decaid-bookoo-scale/bookoo-scale.reaplugin';

PluginManifest bookooScaleManifest() => PluginManifest.fromJson(
  jsonDecode(File('$bookooScalePluginPath/manifest.json').readAsStringSync()),
);

Future<void> loadBookooScalePlugin(PluginManager manager) =>
    manager.loadPlugin(
      id: bookooScaleManifest().id,
      manifest: bookooScaleManifest(),
      settings: {},
      jsCode: File('$bookooScalePluginPath/plugin.js').readAsStringSync(),
    );

/// A 20-byte 03 0B measurement frame with timer, flow and battery fields.
List<int> bookooScalePacket(
  double grams, {
  int timerMs = 0,
  double flow = 0,
  int? battery = 50,
}) {
  final magnitude = (grams.abs() * 100).round();
  final flowMagnitude = (flow.abs() * 100).round();
  final packet = List<int>.filled(20, 0);
  packet[0] = 0x03;
  packet[1] = 0x0B;
  packet[2] = (timerMs >> 16) & 0xFF;
  packet[3] = (timerMs >> 8) & 0xFF;
  packet[4] = timerMs & 0xFF;
  packet[5] = 0x01;
  packet[6] = grams < 0 ? 0x2D : 0x2B;
  packet[7] = (magnitude >> 16) & 0xFF;
  packet[8] = (magnitude >> 8) & 0xFF;
  packet[9] = magnitude & 0xFF;
  packet[10] = flow < 0 ? 0x2D : 0x2B;
  packet[11] = (flowMagnitude >> 8) & 0xFF;
  packet[12] = flowMagnitude & 0xFF;
  if (battery != null) packet[13] = battery;
  packet[19] = packet.take(19).fold(0, (checksum, byte) => checksum ^ byte);
  return packet;
}

/// An Ultra automatic-mode event. The plugin accepts it as live traffic but
/// does not publish it.
List<int> bookooEventPacket(int event) {
  final packet = List<int>.filled(20, 0);
  packet[0] = 0x03;
  packet[1] = 0x0D;
  packet[2] = event;
  packet[19] = packet.take(19).fold(0, (checksum, byte) => checksum ^ byte);
  return packet;
}

const bookooScaleCommands = <List<int>>[
  [0x03, 0x0A, 0x01, 0, 0, 0x08],
  [0x03, 0x0A, 0x04, 0, 0, 0x0D],
  [0x03, 0x0A, 0x05, 0, 0, 0x0C],
  [0x03, 0x0A, 0x06, 0, 0, 0x0F],
];
