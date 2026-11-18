CREATE TABLE products (
  sku TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price REAL NOT NULL,
  released TEXT
);

INSERT INTO products (sku, name, price, released) VALUES
  ('widget', 'Widget', 12.5, '2026-01-15'),
  ('gadget', 'Gadget', 7, NULL);
