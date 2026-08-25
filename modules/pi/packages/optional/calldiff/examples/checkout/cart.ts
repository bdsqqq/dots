export type CartData = {
  id: string;
  items: Array<{ sku: string; qty: number; price: number }>;
};

export class Cart {
  static load(cartId: string): CartData {
    return readCart(cartId);
  }

  static validate(cart: CartData) {
    assertNonEmpty(cart);
    assertPrices(cart);
  }

  static markPaid(cart: CartData) {
    writeCartStatus(cart.id, "paid");
  }
}

function readCart(cartId: string): CartData {
  return { id: cartId, items: [] };
}

function assertNonEmpty(cart: CartData) {
  if (cart.items.length === 0) throw new Error("empty cart");
}

function assertPrices(cart: CartData) {
  for (const item of cart.items) {
    if (item.price < 0) throw new Error("bad price");
  }
}

function writeCartStatus(_id: string, _status: string) {}
