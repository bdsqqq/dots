import { readFile, rename, writeFile } from "node:fs/promises";

/** Circuit-break only this publisher's owned backends; never inspect or signal foreign listeners. */
export class BackendRecoveryBudget {
  readonly #file: string;
  readonly #now: () => number;
  #healthySince: number | null = null;
  #pending: Promise<unknown> = Promise.resolve();
  #serialize<T>(action: () => Promise<T>): Promise<T> {
    const result=this.#pending.then(action);
    this.#pending=result.catch(()=>{});
    return result;
  }
  constructor(file: string, now = Date.now) { this.#file = file; this.#now = now; }
  async #read(): Promise<{ failures: number; windowAt: number; nextAt: number }> {
    try {
      const value = JSON.parse(await readFile(this.#file,"utf8"));
      if (!Number.isInteger(value.failures) || value.failures < 0 || value.failures > 3
        || !Number.isFinite(value.windowAt) || value.windowAt < 0 || value.windowAt > this.#now()+60_000
        || !Number.isFinite(value.nextAt) || value.nextAt < 0) throw new Error("invalid backend recovery budget");
      return this.#now() - value.windowAt >= 30 * 60_000 ? { failures: 0, windowAt: this.#now(), nextAt: 0 } : value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { failures:0,windowAt:this.#now(),nextAt:0 }; throw error; }
  }
  async #write(value: object): Promise<void> {
    await writeFile(`${this.#file}.tmp`,JSON.stringify(value),{mode:0o600});
    await rename(`${this.#file}.tmp`,this.#file);
  }
  async permit(): Promise<{ allowed: boolean; reasonCode: string; retryInMs: number }> {
    await this.#pending;
    const value=await this.#read();
    if(value.failures>=3) return {allowed:false,reasonCode:"recovery_exhausted",retryInMs:Math.max(0,value.windowAt+30*60_000-this.#now())};
    return {allowed:this.#now()>=value.nextAt,reasonCode:"recovery_backoff",retryInMs:Math.max(0,value.nextAt-this.#now())};
  }
  failed(): Promise<void> {
    return this.#serialize(async()=>{
      this.#healthySince=null;
      const value=await this.#read();value.failures=Math.min(3,value.failures+1);
      value.nextAt=this.#now()+1000*2**(value.failures-1);
      await this.#write(value);
    });
  }
  healthy(): Promise<void> {
    return this.#serialize(async()=>{
      this.#healthySince ??= this.#now();
      if(this.#now()-this.#healthySince>=10*60_000) {
        await this.#write({failures:0,windowAt:this.#now(),nextAt:0});
        this.#healthySince=this.#now();
      }
    });
  }
}
