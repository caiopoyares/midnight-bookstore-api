import {
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
} from '@nestjs/common';
import { Database } from './db';
import { shipping, country, currency } from './config';

@Injectable()
class Catalog {
  constructor(private db: Database) {}
  async books(slug?: string) {
    const { rows } = await this.db.pool.query(
      `SELECT b.slug,b.title,b.author,b.genre,b.synopsis,b.note,
      jsonb_agg(jsonb_build_object('sku',e.sku,'format',e.format,'price',e.price,
        'available',e.on_hand-e.reserved) ORDER BY e.price,e.sku) AS editions
      FROM books b JOIN editions e ON e.book_slug=b.slug WHERE ($1::text IS NULL OR b.slug=$1)
      GROUP BY b.slug ORDER BY b.position`,
      [slug ?? null],
    );
    return rows;
  }
}
@Controller('v1')
class CatalogController {
  constructor(private catalog: Catalog) {}
  @Get('books') list() {
    return this.catalog.books();
  }
  @Get('books/:slug') async book(@Param('slug') slug: string) {
    const [book] = await this.catalog.books(slug);
    if (!book) throw new NotFoundException('Livro não encontrado.');
    return book;
  }
  @Get('shop') shop() {
    return { shipping, country, currency };
  }
}
@Module({ providers: [Catalog], controllers: [CatalogController] })
export class CatalogModule {}
