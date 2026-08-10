import type { CartData } from "./cart.js";
export type ChargeResult = { ok: boolean };
export class PaymentGateway {
  static charge(userId: string, cart: CartData): ChargeResult {
    const amount = total(cart);
    const intent = createPaymentIntent(userId, amount);
    return capture(intent);
  }
}
function total(cart: CartData): number {
  return cart.items.reduce((sum, item) => sum + item.price * item.qty, 0);
}
function createPaymentIntent(_userId: string, _amount: number): string {
  return "pi_demo";
}
function capture(_intentId: string): ChargeResult {
  return { ok: true };
}
