import { SagemcomXmoClient } from "./client.ts";
import type { RequestOptions } from "./client.ts";
import { Fast3896ClaroModel } from "./model.ts";
import { assertCompatibleDevice } from "./device.ts";
import { supportedDevice } from "./device.generated.ts";
import type { SupportedDevice } from "./device.generated.ts";
import { callbackValue, singleCallback, record, ProtocolError } from "./protocol.ts";
import type { Json, JsonObject, Reply } from "./protocol.ts";

export interface SagemcomDeviceIdentity {
  manufacturer: string;
  model: string;
  productClass: string;
  hardwareVersion: string;
  softwareVersion: string;
  guiApiVersion: string | undefined;
}
/** Pure snapshot adapter. Supplied DeviceInfo data never causes a second network read. */
export function identityFromDeviceInfo(value: Json): SagemcomDeviceIdentity {
  if (!record(value)) throw new ProtocolError("DeviceInfo must be an object");
  const info = record(value.DeviceInfo) ? value.DeviceInfo : value;
  const text = (name: string) => {
    const v = info[name];
    if (typeof v !== "string") throw new ProtocolError("DeviceInfo field missing/non-string");
    return v;
  };
  return {
    manufacturer: text("Manufacturer"),
    model: text("ModelName"),
    productClass: text("ProductClass"),
    hardwareVersion: text("HardwareVersion"),
    softwareVersion: text("SoftwareVersion"),
    guiApiVersion: typeof info.GUIAPIVersion === "string" ? info.GUIAPIVersion : undefined,
  };
}
export interface WifiNetwork {
  ssid: string;
  enabled: boolean;
}
export interface WifiAliases {
  ssidAlias: string;
  accessPointAlias: string;
}
export type PasswordRotation =
  | { status: "ssid-mismatch"; actualSsid: string }
  | { status: "accepted"; reply: Reply }
  | { status: "verified"; reply: Reply }
  | { status: "verification-mismatch"; reply: Reply };
/** Pure presentation adapter: usable with caller-owned fixtures/snapshots and no SDK/client. */
export function wifiNetworkFromValues(ssid: Json, enabled: Json): WifiNetwork {
  if (typeof ssid !== "string" || typeof enabled !== "boolean")
    throw new ProtocolError("unexpected Wi-Fi SSID/enable wire types");
  return { ssid, enabled };
}
const alias = (value: string) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]+$/.test(value))
    throw new TypeError("alias must be a simple identifier; use raw XPaths for other selectors");
  return value;
};
function wifiNetwork(client: SagemcomXmoClient, aliases: WifiAliases) {
  const ssidPath = `Device/WiFi/SSIDs/SSID[Alias='${alias(aliases.ssidAlias)}']`;
  const keyPath = `Device/WiFi/AccessPoints/AccessPoint[Alias='${alias(aliases.accessPointAlias)}']/Security/KeyPassphrase`;
  const get = async (options?: RequestOptions): Promise<WifiNetwork> => {
    const reply = await client.execute(
      [
        { method: "getValue", xpath: ssidPath + "/SSID" },
        { method: "getValue", xpath: ssidPath + "/Enable" },
      ],
      options,
    );
    const one = (id: number) => {
      const action = reply.actions.find((a) => a.id === id);
      if (!action) throw new ProtocolError("missing Wi-Fi action reply");
      return callbackValue(singleCallback({ ...reply, actions: [action] }));
    };
    return wifiNetworkFromValues(one(0), one(1));
  };
  return {
    get,
    /** Writes ONLY the access-point key. Confirmation is API readback, not a client association test.
     * The precondition is best-effort: XMO offers no compare-and-set/transaction contract.
     */
    rotatePassword: async (
      input: { password: string; expectedSsid: string; verify?: boolean },
      options?: RequestOptions,
    ): Promise<PasswordRotation> => {
      if (
        !record(input) ||
        typeof input.password !== "string" ||
        Buffer.byteLength(input.password) < 8 ||
        Buffer.byteLength(input.password) > 63 ||
        typeof input.expectedSsid !== "string" ||
        !input.expectedSsid ||
        (input.verify !== undefined && typeof input.verify !== "boolean")
      )
        throw new TypeError("rotation requires an expected SSID and an 8–63 byte password");
      if (!client.allowMutations)
        throw new Error("mutations disabled; construct with allowMutations: true");
      const current = await get(options);
      if (current.ssid !== input.expectedSsid)
        return { status: "ssid-mismatch", actualSsid: current.ssid };
      const reply = await client.set(keyPath, input.password, options);
      if (input.verify === false) return { status: "accepted", reply };
      const actual = await client.get(keyPath, options);
      return { status: actual === input.password ? "verified" : "verification-mismatch", reply };
    },
  };
}
/** Defaults are assembled from the same low-level calls available to advanced callers. */
export class SagemcomFast3896Claro extends SagemcomXmoClient {
  readonly supportedDevice = supportedDevice;
  readonly model = new Fast3896ClaroModel(this);
  readonly wifi = {
    network: (aliases: WifiAliases) => wifiNetwork(this, aliases),
    guest: wifiNetwork(this, { ssidAlias: "WL_GUEST", accessPointAlias: "GUEST1" }),
  };
  async identify(options?: RequestOptions): Promise<SagemcomDeviceIdentity> {
    return identityFromDeviceInfo(await this.get("Device/DeviceInfo", options));
  }
  /** explicit verification, not an implicit preflight on every call; reuse supplied identity without fetching. */
  async assertCompatible(
    identity?: SagemcomDeviceIdentity,
    options?: RequestOptions,
  ): Promise<SupportedDevice> {
    const actual = identity === undefined ? await this.identify(options) : identity;
    assertCompatibleDevice(actual);
    return actual;
  }
  readonly files = {
    /** Frontend wrapper contract; URI may embed credentials. Never log it. No browser navigation. */
    getDownloadUri: async (
      xpath: string,
      parameters: { FileName?: string; Type?: string } = {},
      options?: RequestOptions,
    ): Promise<string> => {
      const reply = await this.call(xpath, "getDownloadURI", parameters, options);
      const uri = singleCallback(reply).parameters?.uri;
      if (typeof uri !== "string" || !uri)
        throw new ProtocolError("download command returned no URI");
      let url: URL;
      try {
        url = new URL(uri, this.baseUrl);
      } catch {
        throw new ProtocolError("download command returned an invalid URI");
      }
      if (url.origin !== this.baseUrl || url.username || url.password)
        throw new ProtocolError("download command returned a non-router URI");
      return url.href;
    },
    restore: (
      xpath: string,
      file: { field: string; filename: string; data: Blob },
      parameters: { Type?: string; EncryptedFileName?: string; cryptKey?: string } = {},
      options?: RequestOptions,
    ): Promise<Reply> => {
      const command: JsonObject = { Source: "FILE", FileName: file.field, ...parameters };
      return this.upload([{ method: "restoreFrom", xpath, parameters: command }], [file], options);
    },
    firmwareUpgrade: (
      xpath: string,
      file: { field: string; filename: string; data: Blob },
      kind: "firmware" | "gui" | "mesh" = "firmware",
      options?: RequestOptions,
    ): Promise<Reply> => {
      const fileTypes = {
        firmware: "1 Firmware Upgrade Image",
        gui: "2 Web Content",
        mesh: "X SAGEMCOM MESH",
      };
      if (!Object.hasOwn(fileTypes, kind)) throw new TypeError("unsupported firmware upload kind");
      return this.upload(
        [
          {
            method: "download",
            xpath,
            parameters: { id: "0", fileType: fileTypes[kind], url: "file://" + file.field },
          },
        ],
        [file],
        options,
      );
    },
    docsisFirmwareUpgrade: (
      xpath: string,
      file: { field: string; filename: string; data: Blob },
      version: "3.0" | "3.1" = "3.0",
      options?: RequestOptions,
    ): Promise<Reply> => {
      if (!["3.0", "3.1"].includes(version))
        throw new TypeError("unsupported DOCSIS firmware version");
      return this.upload(
        [
          {
            method: "DownloadDocsisFirmware",
            xpath,
            parameters: {
              id: "0",
              fileType:
                version === "3.0"
                  ? "1 Docsis30 Firmware Upgrade Image"
                  : "2 Docsis31 Firmware Upgrade Image",
              url: "file://" + file.field,
              currentTime: Math.round(Date.now() / 1000),
            },
          },
        ],
        [file],
        options,
      );
    },
  };
}
