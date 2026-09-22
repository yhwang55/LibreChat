import type { Document } from 'mongoose';

/** 카드 한 장에 필요한 값만 담는다. 쇼핑 API 응답 원본은 보관하지 않는다. */
export interface IProductSearchResult {
  title?: string;
  price?: string;
  image?: string;
  link?: string;
  source?: string;
}

export interface IProductSearchCache extends Document {
  /** 정규화된 검색어. 시장과 함께 캐시 키를 이룬다. */
  query: string;
  market: string;
  results: IProductSearchResult[];
  fetchedAt: Date;
  expiresAt: Date;
}

/** 메서드가 주고받는 평문 형태 — 호출자가 mongoose 타입에 묶이지 않도록 한다. */
export interface ProductSearchCacheEntry {
  query: string;
  market: string;
  results: IProductSearchResult[];
  fetchedAt: Date;
}
