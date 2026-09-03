# heterogeneous ESP32 fleet

status: accepted direction

the fleet is intentionally heterogeneous. “ESP32 node” names a protocol role,
not a single product or form factor. wall displays, handheld remotes, sensors,
relays, and actuators should share one protocol core while selecting hardware
that fits their physical job.

## platform direction

ESP32-S3 is the initial hardware and emulation target. it provides enough flash
and PSRAM for cryptography, networking, durable state, and richer device
behavior while remaining available in many integrated form factors. Espressif
maintains ESP32-S3 support in QEMU, including flash, eFuse, PSRAM, OpenEth,
debugging, and a virtual framebuffer.

the firmware is one codebase with board-specific builds:

```text
fleet protocol core
  crypto · gossip · revisions · persistence · receipts
    ├── capability behavior: display · voice · sensor · light · relay
    └── board support: QEMU · StickS3 · TRMNL · Waveshare · Zectrix
```

QEMU must execute the real ESP-IDF firmware. its supervisor may allocate flash
images, identities, ports, virtual networks, failures, and process lifecycles,
but must not reimplement fleet protocol behavior. hardware and QEMU builds may
use different network, display, and power drivers; everything above those
interfaces remains shared.

## candidate form factors

| role | candidate | relevant properties |
|---|---|---|
| handheld remote, voice node, or room controller | M5Stack StickS3 | ESP32-S3 N8R8, 1.14-inch LCD, microphone, speaker, IMU, IR, buttons, battery, magnetic back |
| wall portrait or dashboard | TRMNL 7.5-inch OG kit | XIAO ESP32-S3 Plus, 800 × 480 monochrome e-paper, battery, documented ecosystem |
| low-power label or status node | Waveshare ESP32-S3 e-paper 1.54 V2 | 200 × 200 e-paper, 8 MB flash, 8 MB PSRAM, RTC, battery support, partial refresh |
| grayscale control panel | Zectrix Note4 | ESP32-S3 N16R8, 4.2-inch 400 × 300 e-paper, partial refresh, 16-level grayscale, buttons, audio, NFC |
| hidden sensor, relay, or actuator | headless ESP32-S3 module | smallest suitable enclosure and only the peripherals required by its role |

Steve Ruiz’s concrete recommendation is the M5Stack StickS3, and his broader
recommendation identifies ESP32-S3 as the current sweet spot. StickS3
complements rather than replaces e-paper nodes: it is a compact interactive
mesh participant for controls, voice, sensing, and infrared automation.

## capability model

clients address node resources rather than assuming hardware shape. nodes may
publish signed capabilities such as `display.image`, `audio.capture`,
`light.switch`, or `sensor.temperature`. capability discovery guides clients;
it does not weaken command signature, recipient, revision, or receipt checks.

desired-state resources and one-shot physical effects remain distinct.
revision ordering gives desired state deterministic convergence. one-shot
effects additionally require transactional device-local idempotency because a
receipt alone cannot prevent replay after a crash between physical execution
and durable outcome storage.

## fidelity ladder

1. native simulation exercises large fleets, topology changes, and fuzzing;
2. QEMU pools execute dozens of real firmware instances with independent flash
   and eFuse state;
3. physical boards verify Wi-Fi, BLE, sleep, power loss, batteries, displays,
   and radio behavior that QEMU cannot faithfully emulate.

the initial hardware pair should cover both development speed and intended
experience: one inexpensive Waveshare V2 board for bring-up and one TRMNL kit
for the full-size portrait. StickS3 is the preferred compact general-purpose
node.

## sources

- [Steve Ruiz: buy the ESP32 development board](https://x.com/steveruizok/status/2084703034144112858)
- [Steve Ruiz: request for hardware](https://x.com/steveruizok/article/2085480605278515656)
- [M5Stack StickS3 specification](https://docs.m5stack.com/en/core/StickS3)
- [Espressif ESP32-S3 QEMU guide](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-guides/tools/qemu.html)
- [TRMNL 7.5-inch OG kit](https://www.seeedstudio.com/TRMNL-7-5-Inch-OG-DIY-Kit-p-6481.html)
- [Waveshare ESP32-S3 e-paper 1.54 documentation](https://docs.waveshare.com/ESP32-S3-ePaper-1.54)
- [Zectrix Note4 developer kit](https://zectrix.com/en/note4-developer-kit.html)

## session receipt

- recorded: 2026-09-02 21:04:42 -03:00
- session: [Amp thread](https://ampcode.com/threads/T-01a058e9-cf3f-720a-a26b-f35146e4ed7a)
- repository base: `d0f56293325fd33adf8bf5cc17d7173e92fe6b93`
- request: persist the accepted heterogeneous ESP32 fleet direction and link it
  to the session that produced it
