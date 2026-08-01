/**
 * The deterministic shopping-cart page. The item price is always `$19`. After
 * the single `Add to cart` click the cart total becomes `$19` in `normal` mode
 * and the buggy `$29` in `fault` mode — the intentional defect LS-04's Finding
 * scenario reaches through one action. Only these code oracles live in tests;
 * the product still derives its result from the model interfaces.
 */

export type CartMode = "normal" | "fault";

export const CART_ORACLE = {
  itemPrice: "$19",
  totalBefore: "Cart total: $0",
  totalAfter: { normal: "Cart total: $19", fault: "Cart total: $29" },
} as const;

const TOTAL_AMOUNT_AFTER: Record<CartMode, string> = {
  normal: "$19",
  fault: "$29",
};

export function renderCartPage(mode: CartMode): string {
  const totalAfter = TOTAL_AMOUNT_AFTER[mode];
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Qualigence Demo Store</title>
  </head>
  <body>
    <h1>Demo Store</h1>
    <section>
      <p>Wireless Mouse</p>
      <p id="price" data-qualigence-observe>${CART_ORACLE.itemPrice}</p>
      <button id="add" type="button">Add to cart</button>
    </section>
    <p id="cart-total" data-qualigence-observe>${CART_ORACLE.totalBefore}</p>
    <script>
      (function () {
        var totalAfter = ${JSON.stringify(totalAfter)};
        document.getElementById("add").addEventListener("click", function () {
          document.getElementById("cart-total").textContent = "Cart total: " + totalAfter;
        });
      })();
    </script>
  </body>
</html>`;
}
