import type { Model } from 'mongoose';
import type { IProductSearchCache, IProductSearchResult, ProductSearchCacheEntry } from '~/types';
import logger from '~/config/winston';

/** 기본 보관 기간. 상품 가격은 하루 단위로는 거의 움직이지 않는다. */
export const PRODUCT_SEARCH_CACHE_TTL_MS: number = 24 * 60 * 60 * 1000;

/**
 * 캐시 키 정규화. 앞뒤 공백과 중복 공백, 대소문자 차이로 같은 검색이 따로 저장되면
 * 캐시가 있으나 마나 해진다. 한글은 대소문자가 없어 영향이 없다.
 */
function normalizeKey(value: string): string {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export interface ProductSearchMethods {
  getCachedProductSearch: (
    query: string,
    market: string,
  ) => Promise<ProductSearchCacheEntry | null>;
  setCachedProductSearch: (
    query: string,
    market: string,
    results: IProductSearchResult[],
    ttlMs?: number,
  ) => Promise<void>;
}

export function createProductSearchMethods(
  mongoose: typeof import('mongoose'),
): ProductSearchMethods {
  const getModel = (): Model<IProductSearchCache> =>
    mongoose.models.ProductSearchCache as Model<IProductSearchCache>;

  /**
   * 살아 있는 캐시를 찾는다. 없으면 `null`이고, 호출자는 검색을 수행하면 된다.
   *
   * TTL 인덱스만으로는 만료 직후의 문서가 잠시 남아 있을 수 있어 `expiresAt`을
   * 쿼리 조건에 넣는다. 캐시 조회가 실패해도 기능 자체는 살아 있어야 하므로,
   * 오류는 기록만 하고 캐시 미스로 처리한다.
   */
  async function getCachedProductSearch(
    query: string,
    market: string,
  ): Promise<ProductSearchCacheEntry | null> {
    const normalizedQuery = normalizeKey(query);
    if (!normalizedQuery) {
      return null;
    }

    try {
      const doc = await getModel()
        .findOne({
          query: normalizedQuery,
          market: normalizeKey(market),
          expiresAt: { $gt: new Date() },
        })
        .lean();

      if (!doc) {
        return null;
      }

      return {
        query: doc.query,
        market: doc.market,
        results: (doc.results ?? []) as IProductSearchResult[],
        fetchedAt: doc.fetchedAt,
      };
    } catch (error) {
      logger.error('[productSearch] cache read failed', error);
      return null;
    }
  }

  /**
   * 검색 결과를 저장한다. 같은 키가 있으면 덮어써 보관 기간이 새로 시작된다.
   *
   * 호출자는 성공한 검색만 넘겨야 한다 — 타임아웃 같은 실패를 저장하면 일시적인
   * 장애가 보관 기간 내내 고착된다. 결과가 0건인 것은 실패가 아니라 "이 검색어에는
   * 상품이 없다"는 사실이므로 저장한다.
   */
  async function setCachedProductSearch(
    query: string,
    market: string,
    results: IProductSearchResult[],
    ttlMs: number = PRODUCT_SEARCH_CACHE_TTL_MS,
  ): Promise<void> {
    const normalizedQuery = normalizeKey(query);
    if (!normalizedQuery) {
      return;
    }

    const now = new Date();
    try {
      await getModel().updateOne(
        { query: normalizedQuery, market: normalizeKey(market) },
        {
          $set: {
            results: Array.isArray(results) ? results : [],
            fetchedAt: now,
            expiresAt: new Date(now.getTime() + ttlMs),
          },
        },
        { upsert: true },
      );
    } catch (error) {
      /** 캐시에 못 써도 사용자는 이미 결과를 받았다. 다음 호출이 다시 시도한다. */
      logger.error('[productSearch] cache write failed', error);
    }
  }

  return { getCachedProductSearch, setCachedProductSearch };
}
