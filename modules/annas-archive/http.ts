/** Bound response memory as well as fetch time. Callers decide which errors are public. */
export async function responseText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) throw new Error("empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("response too large");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function responseJson(response: Response, maxBytes = 64 * 1024): Promise<unknown> {
  return JSON.parse(await responseText(response, maxBytes)) as unknown;
}
