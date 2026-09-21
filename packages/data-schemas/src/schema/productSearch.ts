import { Schema } from 'mongoose';
import type { IProductSearchCache } from '~/types';

/**
 * 쇼핑 검색 결과 캐시.
 *
 * 검색 제공자는 처음 보는 검색어를 실시간으로 긁어오기 때문에 첫 호출이 40초를
 * 넘기기도 하고, 호출마다 유료 할당량을 소모한다. 같은 검색어를 다시 묻는 것은
 * 느리고 비쌀 뿐 결과도 거의 같으므로 저장해 둔다.
 */
const productSearchCacheSchema: Schema<IProductSearchCache> = new Schema<IProductSearchCache>({
  query: {
    type: String,
    required: true,
  },
  /** 같은 검색어라도 시장이 다르면 결과가 다르다 — 키의 일부다. */
  market: {
    type: String,
    required: true,
  },
  results: {
    type: [
      new Schema(
        {
          title: String,
          price: String,
          image: String,
          link: String,
          source: String,
        },
        { _id: false },
      ),
    ],
    default: [],
  },
  fetchedAt: {
    type: Date,
    required: true,
    default: Date.now,
  },
  expiresAt: {
    type: Date,
    required: true,
  },
});

/** 조회와 upsert가 모두 이 쌍을 쓴다. */
productSearchCacheSchema.index({ query: 1, market: 1 }, { unique: true });

/**
 * 만료된 문서는 Mongo가 지운다. 다만 TTL 모니터는 60초 주기로 돌아 삭제가 즉시가
 * 아니므로, 읽는 쪽에서도 `expiresAt`을 함께 확인해야 만료본을 돌려주지 않는다.
 */
productSearchCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default productSearchCacheSchema;
