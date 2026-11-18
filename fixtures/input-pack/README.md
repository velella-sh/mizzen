# Input package fixture

A small site with four data collections, used by `test/input-pack-*.test.ts`:

- `products` references `suppliers`, so a package for `products` also carries `suppliers`.
- `products-copy.yml` has exactly the bytes of `products.yml`, so both references share one stored content.
- `unused` is a collection no other one references; a package for `products` leaves it out.
