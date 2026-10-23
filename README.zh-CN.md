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
| 归零并开始 / 退出（App 实测） | `03 0A 07 00 00 0E` |
| 读取序列号（Ultra） | `03 0A 0A 00 00 03` → `03 0C ...` |
| 设置模式（Ultra，App 实测） | `03 0A 0C MM MM CS`（`00` 称重 / `01` 流速 / `02` 比例） |
| 读取设备信息（Ultra） | `03 0A 0F 00 00 06` → `03 0E ...` |
| 读取设置（Ultra） | `03 0A 14 00 00 1D` → `03 10 ...` |
| 进入 Ready（Ultra，App 实测） | `03 0A 18 00 00 11` |

插件按 Bookoo N 的流速模式流程控制计时：

- `preparingForShot`：Decaid 先调用 `tare()`（发送 `01`），再调用 `resetTimer()`。
  `resetTimer()` 不再发送 `06`，只把本次萃取标记为“准备中”，用来跳过下一次重复
  去皮。
- `preinfusion` / `pouring`：Decaid 会再调用一次 `tare()`；插件跳过它，随后
  `startTimer()` 先发送 `0C 01 01` 进入流速模式，再发送 `07`（去皮并开始）。
- `stopping`：`stopTimer()` 发送 `05`。
- 下一次萃取重复同样流程，流速模式会在每次开始时重新确认。

因此每次萃取的 BLE 命令是：

```
01（准备阶段去皮）→ 0C 01 01（进入流速模式）→ 07（去皮并开始）→ 05（停止）
```

能力声明：`battery`、`flow`、`timerTelemetry`、`tare`、`timerControl`、
`disconnectToSleep`。显示休眠走断开连接，而不是发关机命令，这样机器唤醒后可以
自动重连。

### 计时调用链

Decaid 会在萃取过程中自动调用：

| 萃取阶段 | 驱动调用与帧 |
| --- | --- |
| `preparingForShot` | `tare()` → `01`；`resetTimer()` → 无帧，仅准备状态 |
| `preinfusion` / `pouring` | `tare()` 被跳过；`startTimer()` → `0C 01 01` 然后 `07` |
| `stopping` | `stopTimer()` → `05` |

Gateway Mode 为 `full` 时会跳过；连续 2 秒没有重量样本的秤会被当成掉线。插件
自己的 2 秒静默看门狗会把协议失败上报给宿主恢复流程；该阈值在实机记录节奏前
属于暂定值。

### Ultra 模式限制

Ultra 的模式在 Bookoo N App 里显示为 `00` 纯称重 / `01` 流速 / `02` 比例
（公开文档把 `01`/`02` 称为 timing/ratio）。行为区别：

- **纯称重 `00`**：计时/ready 命令无效，只保留称重与去皮。
- **流速 `01`**：`04/05/06` 可直接控制计时，不需要先 ready；`0x0D` 状态事件
  不一定出现，应以 FF11 计时字段为准。
- **比例 `02`**：必须先发 `18` 进入 ready，再发 `04/05`；状态机不允许的命令
  会被忽略（例如 exit-done 后重复 `07`）。

公开文档没有列出“设置/读取模式”的命令，但 Bookoo N App 实测会在长按清零时发送
`03 0A 0C MM MM CS`，并用 `0x0E` 响应回读当前模式。该命令不在公开协议里，使用
需谨慎。Mini 没有这个限制。

### Ultra 实机抓包（2026-10-24）

通过 Android 11 的 HCI snoop 抓到 Bookoo N（`com.bookootech.bookoocoffee`）
连接 Bookoo Ultra 的完整 GATT 流量。设备广播名 `BOOKOO_SC_U 246641`，序列号
`SN25001aac0951`。

- App 连接后同时订阅 **FF11** 和 **FF12** 通知。
- App 写入三条握手命令，响应从 FF12 通知返回（见上面的命令表）。
- Ultra 的 `0x0D` 自动状态事件从 **FF12** 通知返回，不是 FF11。实测状态顺序为
  `02` ready → `01` started → `00` stopped → `04` exit-done。
- 用 App 屏幕操作时，抓到完整的左键序列（约 6 秒间隔）：
  `01` tare → `18` ready → `04` start → `05` stop → `07` exit-done → `01` tare。
  - `18` 未见于官方文档，作用是把 Ultra 置于 automatic-ready（`0x0D` state 2）。
  - App 的“计时归零”按钮发送的是 `07`，不是 `06`；秤在 `07` 后进入 exit-done，
    去皮但不重新开始计时。FF11 计时已在 `05` 停止时归零。
  - `07` 在 stopped 状态下表现为“退出/去皮”，与官方“归零并开始”的描述在
    该上下文中并不完全一致。
- App 长按“清零”切换模式，抓到：
  - `03 0A 0C 02 02 05` → 比例模式
  - `03 0A 0C 00 00 05` → 纯称重模式
  - `03 0A 0C 01 01 05` → 流速模式（App 界面确认）
- `0x0E` 响应的第一个数据字节是当前模式（`00` 纯称重 / `01` 流速 /
  `02` 比例）。后 3 字节是附加信息，可能是版本；实测会从 `07 02 02` 变为
  `07 01 02`，尚未完全解码。
- 模式行为实测：
  - 流速模式下 `04/05/06` 直接生效，日志里不一定有 `0x0D` 状态事件。
  - 比例模式必须先 `18` ready；`04/05` 在 ready 前会被忽略，`07` 在 ready
    时开始、stopped 时退出，exit-done 后重复 `07` 无响应。
  - 纯称重模式下 `04/18/05/07/06` 均无 `0x0D` 响应，计时控制无效。
- 进入比例模式后，FF11 收到一条 `0x0F` 粉重帧：
  `03 0F 2B 00 05 DC ...` = **+15.00 g**。
- 秤上的实体按键直接驱动这套自动状态，**不产生任何 BLE 写入**；App 只是订阅并
  显示。因此不能通过抓 App 的流量来反推实体键的“命令”，它就是秤本地状态机。
- FF11 收到 `0x0B` 测量（约 10 Hz）和 `0x0F` 粉重。
- 当前插件只订阅 FF11，因此不会收到 FF12 上的 `0x0D` 事件。重量/流量/电量遥测
  不受影响；如需自动状态事件，需要再订阅 FF12。

| 特征 | 收到的帧 |
| --- | --- |
| FF11 | `03 0B` 测量、`03 0F` 粉重 |
| FF12 | `03 0C` 序列号、`03 0D` 自动状态、`03 0E` 模式+附加信息、`03 10` 设置 |

`03 0F` 粉重帧在进入比例模式时触发（+15.00 g），不是每次连接都会出现。

## 网页版测试/控制工具（Chrome Web Bluetooth）

网页工具已独立到
[bookoo-scale-tools](https://github.com/Sofronio/bookoo-scale-tools)。它支持
Mini / Ultra 的实时读数、模式切换、设备信息读取和 FF12 控制命令；运行方式、
功能列表和模式说明见该仓库的 README。

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
- 网页工具（独立仓库）：命令帧、解码、`0x0D / 0x0C / 0x0E / 0x10`、模拟 GATT 连接/重连
  均通过 headless Chrome 自动化检查。
- Bookoo Ultra BLE 协议：已通过 Android HCI snoop 实机抓包（2026-10-24），
  包括 App 左键流程和模式切换（`0C / 0E / 0F`）。
- Bookoo Ultra 驱动集成：尚未验证。
- Bookoo Mini 实机：尚未验证。

Ultra 实测前先把秤切到 **流速模式**（公开文档称 timing mode）或比例模式；
比例模式先发 `18` 进入 ready。步骤见
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
