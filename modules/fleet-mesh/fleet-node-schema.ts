import { type } from "arktype";

export const NodeIdentityV1Schema = type({
  "+": "reject",
  id: "string",
  signingPublicKey: "string",
  encryptionPublicKey: "string",
  signingPrivateKey: "string",
  encryptionPrivateKey: "string",
});

export type NodeIdentityV1 = typeof NodeIdentityV1Schema.infer;
