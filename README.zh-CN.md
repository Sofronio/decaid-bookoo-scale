# Bookoo Scale for Decaid（中文说明）

[Decaid](https://github.com/decentespresso/decaid) 插件，支持 Bookoo Mini
（Themis Mini）和 Bookoo Ultra 两款 BLE 电子秤。插件负责设备协议，Decaid
负责发现、BLE 连接生命周期和 Scale 界面。

Decaid 自带的 Bookoo 驱动已经会在萃取过程中去皮并发送计时开始/停止/复位命令。
本插件保留这套计时控制，并补上原生驱动丢弃的秤端计时和流量遥测。

使用或修改驱动都不需要发布新的 Decaid 版本。

English README: [README.md](README.md)

## 安装

通过 Decaid REST API 安装本仓库的最新 release：

```bash
curl -X POST http://localhost:8080/api/v1/plugins/install/github-release \
  -H 'content-type: application/json' \
  -d '{"repo": "Sofronio/decaid-bookoo-scale"}'
```

也可以在 Decaid 的 Plugins 设置页里从仓库安装。

设备 ID 为
`plugin:bookoo-scale.reaplugin:bookoo-scale:<physical id>`。启用插件后，同名
广告会优先由插件接管；禁用或卸载后恢复原生发现。原生和插件的设备 ID 不同，
已保存的偏好不会被悄悄改写。

## 匹配规则

广告名称包含 `bookoo`（不区分大小写），并且广告 service `0ffe`。要求 service
可以把 Bookoo MT80 研磨机排除在外：它广告的是 `FFFF` 和自己的私有 service。

Mini 和 Ultra 都使用 service `0FFE`、测量特征 `FF11`、命令特征 `FF12`，XOR
校验，20 字节测量帧相同。

## 协议

协议来自 Bookoo 官方仓库的
[Mini](https://github.com/BooKooCode/OpenSource/blob/main/bookoo_mini_scale/protocols.md)
和 [Ultra](https://github.com/BooKooCode/OpenSource/blob/main/bookoo_ultra_scale/protocols.md)
文档。

### 测量帧（`FF11`，20 字节）

| 字节（从 1 开始） | 字段 |
| --- | --- |
| 3-5 | 计时，无符号 24 位毫秒 |
| 6 | 单位（`01` 克，`02` 盎司） |
| 7 | 重量符号（`+`/`-`） |
| 8-10 | 重量，1/100 克 |
| 11 | 流量符号（`+`/`-`） |
| 12-13 | 流量，1/100 |
| 14 | 电量百分比 |
| 20 | 前 19 字节的 XOR 校验 |

Ultra 官方文档注明返回重量始终为克；单位字节只表示显示单位，因此驱动不做换算。
Ultra 的 `03 0D` 自动模式事件和 `03 0F` 粉重帧会作为有效流量接受，避免触发静默
断连，但当前不发布。

### 命令帧（`FF12`，6 字节，需要响应）

| 操作 | 帧 |
| --- | --- |
| 去皮 | `03 0A 01 00 00 08` |
| 开始计时 | `03 0A 04 00 00 0D` |
| 停止计时 | `03 0A 05 00 00 0C` |
| 复位计时 | `03 0A 06 00 00 0F` |

Decaid 会先单独去皮再开始计时，所以 `startTimer()` 用 `04`；协议里合并的
`07`（去皮并开始计时）暂不使用。

能力声明：`battery`、`flow`、`timerTelemetry`、`tare`、`timerControl`、
`disconnectToSleep`。显示休眠走断开连接，而不是发关机命令，这样机器唤醒后可以
自动重连。

### 计时调用链

Decaid 会在萃取过程中自动调用：

| 萃取阶段 | 驱动调用 |
| --- | --- |
| `preparingForShot` | `resetTimer()` |
| `preinfusion` / `pouring` | `startTimer()` |
| `stopping` | `stopTimer()` |

Gateway Mode 为 `full` 时会跳过；连续 2 秒没有重量样本的秤会被当成掉线。插件
自己的 2 秒静默看门狗会把协议失败上报给宿主恢复流程；该阈值在实机记录节奏前
属于暂定值。

### Ultra 模式限制

Ultra 只在 timing-mode 和 ratio-mode 下接受开始/停止/复位计时命令。Bookoo
没有公开“设置/读取模式”的命令，所以秤停在 weight-mode 时，即使 Decaid 发了帧，
固件也会忽略。Mini 没有这个限制。不要猜一个设置模式的帧。

## 测试

Node 协议测试不需要 Decaid 检出：

```bash
node --test test/plugin_test.mjs
```

Decaid 集成测试通过真实的插件加载器、JavaScript 运行时、`PluginManager`、
`ScaleController` 和 BLE fixture 运行。把文件复制到同级的 Decaid 检出后执行：

```bash
cp test/decaid/helpers/bookoo_scale_plugin_fixture.dart <decaid>/test/helpers/
cp test/decaid/plugins/bookoo_scale_plugin_test.dart    <decaid>/test/plugins/
cd <decaid> && flutter test test/plugins/bookoo_scale_plugin_test.dart
```

## 验证状态

- Node 协议测试：7 项通过。
- Decaid 集成测试：6 项通过（`decaid` `b9f9d05`）。
- Bookoo Ultra 实机：尚未验证。
- Bookoo Mini 实机：尚未验证。

Ultra 实测前先把秤切到 **timing mode**（或 ratio mode）。步骤见
[`doc/ultra-hardware-checklist.md`](doc/ultra-hardware-checklist.md)。

## 发布

`scripts/package.sh` 生成 `dist/bookoo-scale.reaplugin-<version>.zip`。推送
`vX.Y.Z` tag 后 CI 会执行同一脚本并发布 release。

Decaid 在安装时强制校验：

- release tag 为 `X.Y.Z` 或 `vX.Y.Z`，且与 `manifest.version` 完全一致
- release 只带一个 `.zip` 资产
- 压缩包内是单一顶层 `bookoo-scale.reaplugin/` 目录，包含 `manifest.json`
  和 `plugin.js`

所以修改版本时同时 bump `manifest.version` 并打同名 tag。tag 和 manifest 不一致
的 release 会在安装时被拒绝。

## 相关链接

- [Decaid 官方仓库](https://github.com/decentespresso/decaid)
- [Bookoo 官方开源协议仓库](https://github.com/BooKooCode/OpenSource)
- [Bookoo Mini 协议（英文）](https://github.com/BooKooCode/OpenSource/blob/main/bookoo_mini_scale/protocols.md)
- [Bookoo Ultra 协议（英文）](https://github.com/BooKooCode/OpenSource/blob/main/bookoo_ultra_scale/protocols.md)
- [Decaid 原生计时调用链调查](doc/decaid-timer-control-investigation.md)
- [Bookoo Ultra 实机验证清单](doc/ultra-hardware-checklist.md)

## 许可证

尚未选择。在添加许可证前，本仓库保留所有权利。外链的 Bookoo 协议文档采用 MIT
许可证。
