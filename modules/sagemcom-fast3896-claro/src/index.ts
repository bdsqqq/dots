export { SagemcomXmoClient, sessionFromCookie, validateSession, readCallbacks } from "./client.ts";
export type {
  Authentication,
  ClientOptions,
  HashAlgorithm,
  ReadResult,
  RequestOptions,
  Session,
  Subscription,
  UploadFile,
} from "./client.ts";
export { SagemcomFast3896Claro, identityFromDeviceInfo, wifiNetworkFromValues } from "./sdk.ts";
export type { SagemcomDeviceIdentity, WifiNetwork, WifiAliases, PasswordRotation } from "./sdk.ts";
export { Fast3896ClaroModel } from "./model.ts";
export { assertCompatibleDevice, UnsupportedDeviceError } from "./device.ts";
export { supportedDevice } from "./device.generated.ts";
export type { SupportedDevice } from "./device.generated.ts";
export type { CommandResult } from "./model.ts";
export { discoverCapabilities, schemaPath, catalogDigest } from "./discovery.ts";
export type { SchemaCatalog, SchemaNode, FieldSchema, CommandSchema } from "./discovery.ts";
export {
  XmoError,
  ProtocolError,
  TransportError,
  REQUEST_OK,
  ACTION_OK,
  callbacks,
  callbackValue,
  firstCallback,
  singleCallback,
} from "./protocol.ts";
export type {
  Action,
  ActionReply,
  Capability,
  Json,
  JsonObject,
  Notification,
  Reply,
  XmoCallback,
  XmoCommand,
  XmoInterface,
  XmoStatus,
} from "./protocol.ts";
export { catalog } from "./catalog.generated.ts";
export { errorCodes, frontendCommands, endpoints, wireMethods } from "./protocol.generated.ts";
export type { XmoErrorCode, XmoErrorName, FrontendCommand } from "./protocol.generated.ts";
export type {
  Selector,
  CanonicalPath,
  ModelPath,
  WritablePath,
  CommandPath,
  ModelValues,
  WritableValues,
  CommandInputs,
  CommandOutputs,
} from "./model.generated.ts";
