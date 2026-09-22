import { Model } from 'mongoose';
import type * as t from '~/types';
import productSearchCacheSchema from '~/schema/productSearch';

/**
 * Shopping search results, cached by query and market. Documents expire via TTL,
 * so the collection stays bounded without a sweep job.
 */
export function createProductSearchCacheModel(
  mongoose: typeof import('mongoose'),
): Model<t.IProductSearchCache> {
  return (
    mongoose.models.ProductSearchCache ||
    mongoose.model<t.IProductSearchCache>('ProductSearchCache', productSearchCacheSchema)
  );
}
