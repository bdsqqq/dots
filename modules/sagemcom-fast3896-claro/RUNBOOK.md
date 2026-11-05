# rotate the bike shop’s customer wi-fi password

**target:** `Bike-IoT`, the guest network used by customers making payments.

**keep unchanged:** `Bike`, administrator credentials, band steering, WAN settings, and whether either network is enabled.

this procedure targets the Sagemcom `FAST3896_CLARO` / `FAST3896-15`. the command checks the exact [supported hardware and firmware](src/device.generated.ts) before writing. SDK rotation is fixture-tested; live verification covered authentication, compatibility, and reads—not a password change. plan for a customer wi-fi interruption.

## prepare

1. connect this computer to **`Bike`** or, preferably, the router’s ethernet. do not administer it through `Bike-IoT` while rotating that network’s key.
2. have the router administrator credentials available. these are not the customer wi-fi credentials.
3. choose the new guest password: **8–63 UTF-8 bytes**. put the administrator password and new guest password in separate files **outside the repository**, using a trusted editor or password manager. each file contains only its password; one final newline is ignored, other whitespace is preserved. restrict the directory to its owner and the files to mode `600`. do not put either password in shell arguments, chat, logs, or git.
4. from the repository root, install dependencies and configure the file paths:

```sh
cd "modules/sagemcom-fast3896-claro"
pnpm install --frozen-lockfile

export FAST3896_CLARO_USERNAME='router-administrator-name'
export FAST3896_CLARO_PASSWORD_FILE="$HOME/.config/bike-router/admin-password"
export FAST3896_CLARO_NEW_PASSWORD_FILE="$HOME/.config/bike-router/new-guest-password"
chmod 600 "$FAST3896_CLARO_PASSWORD_FILE" "$FAST3896_CLARO_NEW_PASSWORD_FILE"
```

`http://192.168.0.1` is the default router address. use `FAST3896_CLARO_URL` only when deliberately targeting another address; it must be an origin, not the GUI page URL. do not use an old HAR/session as routine credentials.

## rotate through the SDK

### 1. check without changing configuration

```sh
pnpm run bike-iot:rotate
```

proceed only after exit code `0` and `{"status":"ready"}`. this checks administrator login, the exact hardware/firmware profile, the `Bike-IoT` SSID, and its enabled state. it does not test the new password file or internet connectivity. no password or native router reply is printed.

### 2. apply once

```sh
pnpm run bike-iot:rotate --apply
```

this invokes the existing SDK rotation operation with the expected SSID `Bike-IoT`. it writes **only** `GUEST1/Security/KeyPassphrase`, then reads it back. it does not rewrite the SSID or run the setup wizard. exit code `0` with `{"status":"verified"}` means API readback matched the new key—not that customers can connect yet.

**do not blindly rerun after a failure or disconnect.** a write can succeed before its response is lost. `{"status":"failed","outcome":"unknown"}` explicitly means the command could not determine the write outcome. no automatic retry occurs. a logout warning does not undo an already verified rotation.

### 3. verify a customer connection

1. on a phone, forget `Bike-IoT` and reconnect using the new password.
2. turn off mobile data for the test, so cellular connectivity cannot hide a wi-fi failure. confirm a public HTTPS page loads. restore the phone’s previous mobile-data setting afterward.
3. confirm `Bike` still works with its existing password.
4. update the customer-facing password sign or wi-fi QR code. scan the updated QR code on a phone to verify it. do not include router administrator credentials, and do not commit password signs, QR codes, or secret files.

rotation is complete only after the customer connection and sign/QR are checked.

## browser alternative

use this instead of the SDK apply command, not as an automatic retry after an uncertain result.

1. while on `Bike` or ethernet, open **http://192.168.0.1/2.0/gui/** and sign in with the router administrator credentials.
2. under **`CONFIGURAÇÃO RÁPIDA`**, locate **`REDE CONVIDADOS / IoT`** and confirm the displayed network is `Bike-IoT`.
3. enter the new guest password in both fields:
   - **`Nova senha da “REDE CONVIDADOS / IoT”`**
   - **`Repetir senha da “REDE CONVIDADOS / IoT”`**
4. leave all other fields and switches unchanged. click **`Aplicar Ajustes`** once.
5. perform the phone, main-network, and sign/QR checks above.

if menus differ, locate the guest/IoT settings before proceeding. do not change the main network’s password.

## if something goes wrong

| observation | next action |
| --- | --- |
| router unreachable | confirm the computer is on `Bike` or ethernet, not disconnected `Bike-IoT`. restore access before trying to apply anything. |
| login fails | check administrator credentials. do not factory-reset the router. |
| compatibility check fails | stop. identify the actual hardware/firmware and review the SDK profile before using typed writes. do not bypass the check just to continue. |
| preflight says `not-ready`, or rotation says `ssid-mismatch` | stop and inspect the guest SSID/enabled state. the command must not rename or enable a network to make its precondition pass. |
| `verification-mismatch`, disconnect, or unknown outcome | stop automatic attempts. test the phone with the new password first; check actual guest settings through a fresh administrator session before deciding whether another write is needed. read-only preflight alone cannot determine which password is installed. |
| phone joins but internet fails | investigate connectivity/WAN separately. do not change the main password or repeat rotation as an internet fix. |
| first-time/setup wizard appears | do not assume a factory reset or accept defaults. stop routine rotation and inspect the current configuration. completing the wizard is a separate recovery action requiring the known main SSID/key, administrator credentials, and band-steering setting. |

in the captured earlier attempt, the wizard submitted writes for the main SSID/key, administrator password, password-change flag, and band steering. a router reboot was not established by the capture. this is why wizard completion is **not** part of routine guest-password rotation.
