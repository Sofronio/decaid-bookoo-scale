import 'package:flutter_test/flutter_test.dart';
import 'package:reaprime/src/controllers/scale_controller.dart';
import 'package:reaprime/src/models/device/device.dart';
import 'package:reaprime/src/models/device/scale.dart';
import 'package:reaprime/src/plugins/plugin_ble_registry.dart';
import 'package:reaprime/src/plugins/plugin_manifest.dart';
import 'package:reaprime/src/plugins/plugin_manager.dart';

import '../helpers/bookoo_plugin_fixture.dart';
import '../helpers/bookoo_scale_plugin_fixture.dart';
import 'plugin_test_helpers.dart';

BleAdvertisementEvidence ultraEvidence() => BleAdvertisementEvidence(
  name: 'BOOKOO ULTRA',
  serviceUuids: const ['0ffe'],
);

Future<Scale> createScale(
  PluginManager manager,
  BookooPluginTransport transport,
  BleAdvertisementEvidence evidence,
) async {
  return await manager.bleService.createCandidate(
        driver: manager.bleService.registry.decide(evidence).drivers.single,
        physicalId: 'AA:BB',
        evidence: evidence,
        admit: () => true,
        createTransport: () => transport,
      )
      as Scale;
}

void main() {
  test('manifest declares the Bookoo scale driver and its capabilities', () {
    final driver = bookooScaleManifest().drivers.single;
    expect(driver.id, 'bookoo-scale');
    expect(driver.type, PluginDriverType.scale);
    expect(driver.ble, isNotNull);
    expect(driver.capabilities.map((capability) => capability.name).toSet(), {
      'battery',
      'flow',
      'timerTelemetry',
      'tare',
      'timerControl',
      'disconnectToSleep',
    });
  });

  test('connects, publishes timer and flow, and retains battery', () async {
    final manager = PluginManager(kvStore: FakeKeyValueStoreService());
    final controller = ScaleController();
    addTearDown(() async {
      controller.dispose();
      await manager.dispose();
    });
    await loadBookooScalePlugin(manager);
    final transport = BookooPluginTransport('AA:BB');
    final scale = await createScale(manager, transport, ultraEvidence());
    final samples = <WeightSnapshot>[];
    final subscription = controller.weightSnapshot.listen(samples.add);
    addTearDown(subscription.cancel);

    final connect = controller.connectToScale(scale);
    await transport.subscribed.future;
    transport.emit(
      bookooScalePacket(12.34, timerMs: 7000, flow: 1.5, battery: 88),
    );
    await connect;

    final first = await controller.weightSnapshot.first;
    expect(first.weight, 12.34);
    expect(first.battery, 88);
    expect(first.timerValue, const Duration(milliseconds: 7000));
    expect(first.weightFlow, closeTo(1.5, 1e-9));

    final negative = controller.weightSnapshot.firstWhere(
      (sample) => sample.weight == -4.5,
    );
    transport.emit(
      bookooScalePacket(-4.5, timerMs: 0, flow: -2.25, battery: 101),
    );
    final last = await negative;
    expect(last.battery, 88, reason: 'an implausible battery is ignored');
    expect(last.timerValue, Duration.zero);
    expect(last.weightFlow, closeTo(-2.25, 1e-9));
    expect(samples.length, 2);
    await scale.disconnect();
  });

  test('maps tare and timer controls to the flow-mode shot frames', () async {
    final manager = PluginManager(kvStore: FakeKeyValueStoreService());
    final controller = ScaleController();
    addTearDown(() async {
      controller.dispose();
      await manager.dispose();
    });
    await loadBookooScalePlugin(manager);
    final transport = BookooPluginTransport('AA:BB');
    final scale = await createScale(manager, transport, ultraEvidence());
    final connect = controller.connectToScale(scale);
    await transport.subscribed.future;
    transport.emit(bookooScalePacket(1));
    await connect;
    transport.writes.clear();

    await scale.tare();
    await scale.startTimer();
    await scale.stopTimer();
    await scale.resetTimer();

    expect(
      transport.writes.map((write) => write.data.toList()),
      bookooScaleCommands,
    );
    expect(transport.writes.every((write) => write.withResponse), isTrue);
    expect(
      transport.writes.every(
        (write) =>
            write.characteristicUUID == bookooCommandCharacteristicUuid,
      ),
      isTrue,
    );
    await scale.disconnect();
  });

  test('Ultra automatic-mode events keep the session alive', () async {
    final manager = PluginManager(kvStore: FakeKeyValueStoreService());
    final controller = ScaleController();
    addTearDown(() async {
      controller.dispose();
      await manager.dispose();
    });
    await loadBookooScalePlugin(manager);
    final transport = BookooPluginTransport('AA:BB');
    final scale = await createScale(manager, transport, ultraEvidence());
    final samples = <WeightSnapshot>[];
    final subscription = controller.weightSnapshot.listen(samples.add);
    addTearDown(subscription.cancel);
    final connect = controller.connectToScale(scale);
    await transport.subscribed.future;
    transport.emit(bookooScalePacket(1));
    await connect;

    transport.emit(bookooEventPacket(1));
    await pumpEventQueue();
    expect(samples.length, 1, reason: 'an event has no scale snapshot');
    expect(await scale.connectionState.first, ConnectionState.connected);

    final next = controller.weightSnapshot.firstWhere(
      (sample) => sample.weight == 2,
    );
    transport.emit(bookooScalePacket(2));
    await next;
    await scale.disconnect();
  });

  test('matching excludes the MT80 grinder and unrelated names', () async {
    final manager = PluginManager(kvStore: FakeKeyValueStoreService());
    addTearDown(manager.dispose);
    await loadBookooScalePlugin(manager);

    for (final evidence in [
      BleAdvertisementEvidence(
        name: 'BOOKOO MT80 12345678',
        serviceUuids: const ['ffff'],
      ),
      BleAdvertisementEvidence(
        name: 'Acme Scale',
        serviceUuids: const ['0ffe'],
      ),
    ]) {
      expect(
        manager.bleService.registry.decide(evidence).drivers,
        isEmpty,
        reason: 'unexpected claim for ${evidence.name}',
      );
    }
  });

  test('display sleep disconnects instead of powering the scale off', () async {
    final manager = PluginManager(kvStore: FakeKeyValueStoreService());
    final controller = ScaleController();
    addTearDown(() async {
      controller.dispose();
      await manager.dispose();
    });
    await loadBookooScalePlugin(manager);
    final transport = BookooPluginTransport('AA:BB');
    final scale = await createScale(manager, transport, ultraEvidence());
    final connect = controller.connectToScale(scale);
    await transport.subscribed.future;
    transport.emit(bookooScalePacket(1));
    await connect;
    await scale.sleepDisplay();
    expect(transport.disconnectCalls, greaterThan(0));
  });
}
