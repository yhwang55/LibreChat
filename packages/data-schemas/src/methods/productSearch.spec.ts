import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type * as t from '~/types';
import { createProductSearchMethods, PRODUCT_SEARCH_CACHE_TTL_MS } from './productSearch';
import productSearchCacheSchema from '~/schema/productSearch';

let mongoServer: MongoMemoryServer;
let ProductSearchCache: mongoose.Model<t.IProductSearchCache>;
let methods: ReturnType<typeof createProductSearchMethods>;

const RESULTS: t.IProductSearchResult[] = [
  { title: '젠틀 요가 매트 5mm', price: '₩44,900', source: '데카트론' },
  { title: '룰루레몬 더 매트 5mm', price: '₩125,000', source: 'lululemon' },
];

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  ProductSearchCache =
    mongoose.models.ProductSearchCache ||
    mongoose.model('ProductSearchCache', productSearchCacheSchema);
  methods = createProductSearchMethods(mongoose);
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
});

describe('product search cache', () => {
  it('returns null when nothing has been cached', async () => {
    expect(await methods.getCachedProductSearch('요가 매트', 'kr')).toBeNull();
  });

  it('round-trips a stored result', async () => {
    await methods.setCachedProductSearch('요가 매트', 'kr', RESULTS);

    const cached = await methods.getCachedProductSearch('요가 매트', 'kr');
    expect(cached?.results).toEqual(RESULTS);
    expect(cached?.fetchedAt).toBeInstanceOf(Date);
  });

  /** 같은 검색어라도 시장이 다르면 결과가 다르다 — 섞이면 원화와 달러가 뒤바뀐다. */
  it('keeps markets apart', async () => {
    await methods.setCachedProductSearch('yoga mat', 'kr', RESULTS);

    expect(await methods.getCachedProductSearch('yoga mat', 'us')).toBeNull();
    expect((await methods.getCachedProductSearch('yoga mat', 'kr'))?.results).toEqual(RESULTS);
  });

  /** 공백과 대소문자 차이로 같은 검색이 따로 저장되면 캐시가 있으나 마나 해진다. */
  it.each([
    ['  요가 매트  ', 'kr'],
    ['요가  매트', 'kr'],
    ['YOGA MAT', 'us'],
  ])('normalizes %p before matching', async (variant, market) => {
    const canonical = market === 'kr' ? '요가 매트' : 'yoga mat';
    await methods.setCachedProductSearch(canonical, market, RESULTS);

    expect((await methods.getCachedProductSearch(variant, market))?.results).toEqual(RESULTS);
  });

  /** 0건은 실패가 아니라 사실이다. 저장해야 같은 검색어로 할당량을 반복해 쓰지 않는다. */
  it('caches an empty result so the query is not paid for again', async () => {
    await methods.setCachedProductSearch('Manduka PRO 요가 매트', 'kr', []);

    const cached = await methods.getCachedProductSearch('Manduka PRO 요가 매트', 'kr');
    expect(cached).not.toBeNull();
    expect(cached?.results).toEqual([]);
  });

  it('overwrites an existing entry rather than duplicating it', async () => {
    await methods.setCachedProductSearch('요가 매트', 'kr', RESULTS);
    await methods.setCachedProductSearch('요가 매트', 'kr', [RESULTS[0]]);

    expect((await methods.getCachedProductSearch('요가 매트', 'kr'))?.results).toEqual([
      RESULTS[0],
    ]);
    expect(await ProductSearchCache.countDocuments({})).toBe(1);
  });

  /**
   * TTL 인덱스는 60초 주기로 도는 백그라운드 작업이라 만료 즉시 지워지지 않는다.
   * 읽는 쪽에서 막지 않으면 만료된 결과가 그대로 나간다.
   */
  it('does not return an entry whose expiry has passed', async () => {
    await methods.setCachedProductSearch('요가 매트', 'kr', RESULTS, -1000);

    expect(await methods.getCachedProductSearch('요가 매트', 'kr')).toBeNull();
    /** TTL이 아직 지우지 않았어도 읽히지 않아야 한다. */
    expect(await ProductSearchCache.countDocuments({})).toBe(1);
  });

  it('defaults to a 24 hour lifetime', async () => {
    const before = Date.now();
    await methods.setCachedProductSearch('요가 매트', 'kr', RESULTS);

    const doc = await ProductSearchCache.findOne({ query: '요가 매트' }).lean();
    const lifetime = new Date(doc!.expiresAt).getTime() - before;
    expect(PRODUCT_SEARCH_CACHE_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(lifetime).toBeGreaterThan(PRODUCT_SEARCH_CACHE_TTL_MS - 5000);
    expect(lifetime).toBeLessThanOrEqual(PRODUCT_SEARCH_CACHE_TTL_MS + 5000);
  });

  it.each(['', '   '])('ignores a blank query (%p)', async (query) => {
    await methods.setCachedProductSearch(query, 'kr', RESULTS);

    expect(await ProductSearchCache.countDocuments({})).toBe(0);
    expect(await methods.getCachedProductSearch(query, 'kr')).toBeNull();
  });
});
