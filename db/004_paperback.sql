UPDATE editions SET format='Paperback' WHERE lower(format)='brochura';
UPDATE order_lines SET format='Paperback' WHERE lower(format)='brochura';
