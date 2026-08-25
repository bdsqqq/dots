import type { CartData } from "./cart.js";
export class Inventory {
  static reserve(cart: CartData): boolean {
    for (const item of cart.items) {
      const locked = lockSku(item.sku, item.qty);
      if (!locked) return false;
    }
    return true;
  }
  static releaseHolds(cart: CartData) {
    for (const item of cart.items) unlockSku(item.sku, item.qty);
  }
}
function lockSku(_sku: string, _qty: number): boolean {
  return true;
}
function unlockSku(_sku: string, _qty: number) {}
