const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');
const { logger } = require('@librechat/data-schemas');
const requireJwtAuth = require('~/server/middleware/requireJwtAuth');
const {
  isPlausiblyShopping,
  buildIntentRequest,
  parseIntentResponse,
  signQuery,
  isValidQueryToken,
  SearchStatus,
  describeSearchResult,
  resolveMarket,
  marketSearchParams,
  filterByProductTerm,
  dedupeProducts,
} = require('./intent');

const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
const router = express.Router();

/**
 * TODO(workspace-boundary): PR 전에 처리할 것.
 * CLAUDE.md 규칙상 `/api`는 wiring만 담고 로직은 `/packages/api`(TypeScript)에
 * 있어야 하는데, 이 디렉터리는 의도 판별·검색·응답 매핑을 전부 들고 있다.
 * 옮길 때 같이 정리할 것:
 *   1. `intent.js`와 아래 두 검색 함수를 `/packages/api`로 옮기고(TS로 변환),
 *      이 파일은 require + 라우트 등록 + 호출만 남긴다.
 *   2. 상수와 env 스위치(OPENAI_KEYWORD_MODEL, PRODUCT_SEARCH_MARKET,
 *      RESULT_LIMIT, 각 타임아웃, 프리필터 임계값)를 `packages/data-provider`의
 *      `configSchema` 필드로 노출해 librechat.yaml에서 설정 가능하게 한다.
 *      기본값은 현재 동작 유지.
 *   3. SerpApi/네이버 클라이언트를 호출자가 주입하도록 바꿔 두 번째 구현이
 *      공유 코드의 분기 추가가 아니라 인자 교체로 끝나게 한다.
 */

const RESULT_LIMIT = 4;

/**
 * gpt-4o-mini structured output 실측: 0.6~1.3초. 15초는 10배 이상의 여유라
 * 정상 호출이 잘릴 일이 없고, 값을 줄여서 얻을 이득도 없어 그대로 둔다.
 *
 * 다만 SDK 기본 재시도가 2회라 타임아웃이 겹치면 최악 45초까지 늘어진다.
 * 1회로 낮춰 최악을 30초로 묶는다 — 일시적 5xx는 한 번 더 시도할 값어치가 있지만,
 * 그 이상은 카드 하나 때문에 커넥션을 오래 잡고 있을 이유가 없다.
 */
const INTENT_TIMEOUT = 15000;
const INTENT_MAX_RETRIES = 1;

/** 모듈 로드 시점에 키가 없을 수 있으므로 첫 사용 시 만들고 이후 재사용한다. */
let openaiClient = null;
function getOpenAIClient(apiKey) {
  if (openaiClient === null) {
    openaiClient = new OpenAI({
      apiKey,
      timeout: INTENT_TIMEOUT,
      maxRetries: INTENT_MAX_RETRIES,
    });
  }
  return openaiClient;
}

/**
 * 의도가 없으면 유료 쇼핑 API를 아예 호출하지 않는다. 판별에 실패하면 검색을
 * 건너뛴다(fail-closed) — 의도를 모르는 채로 과금되는 검색을 날리는 것보다
 * 카드를 안 띄우는 쪽이 안전하다.
 */
async function analyzeShoppingIntent(text, question, market) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn('[products] OPENAI_API_KEY not set, skipping product search');
    return { query: '', categories: [], reason: 'intent-unavailable' };
  }

  try {
    const completion = await getOpenAIClient(apiKey).chat.completions.create(
      buildIntentRequest(text, question, market),
    );
    return parseIntentResponse(completion);
  } catch (error) {
    if (error?.status === 429) {
      logger.warn('[products] OpenAI rate limit or quota hit, skipping product search');
    } else {
      logger.error(
        '[products] OpenAI intent analysis failed: ' +
          JSON.stringify(error?.error ?? error?.message ?? error),
      );
    }
    return { query: '', categories: [], reason: 'intent-unavailable' };
  }
}

/**
 * Google Shopping (SerpApi) 검색
 *
 * SerpApi는 캐시에 없는 검색어를 실시간으로 긁어오기 때문에 첫 호출이 오래 걸린다.
 * 한번 조회된 검색어는 이후 수십~수백 ms로 떨어지므로, 느린 쪽은 언제나 "처음 보는
 * 검색어"다. 같은 질문을 반복 테스트하는 개발 환경은 캐시가 더워져 빨라 보이고,
 * 실사용은 매번 새 검색어라 느린 쪽에 몰린다.
 *
 * 제한값의 이력: 15초 → 35초 → 60초. 15초와 35초 모두 로컬에서 타임아웃이 났고
 * (2026-09-17 하루에 18건), 그때마다 빈 결과가 되어 카드가 사라졌다. 타임아웃은
 * 실패로 기록되므로 `reason: search-failed`로 구분된다.
 *
 * 카드는 응답 본문과 별개로 비동기 로드되므로 대기가 채팅을 막지는 않지만, 60초는
 * 사용자가 스켈레톤을 그만큼 오래 본다는 뜻이기도 하다. 더 늘리는 대신 결과를
 * 캐시하거나 미리 조회하는 쪽이 다음 수순이다.
 */
const SEARCH_TIMEOUT = 60000;
async function searchGoogleShopping(query, market) {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    return { status: SearchStatus.NotConfigured, products: [] };
  }

  try {
    const response = await axios.get('https://serpapi.com/search.json', {
      params: {
        engine: 'google_shopping',
        q: query,
        api_key: apiKey,
        ...marketSearchParams(market),
      },
      timeout: SEARCH_TIMEOUT,
    });

    const results = response.data?.shopping_results ?? [];
    const products = results.map((item) => ({
      title: item.title,
      price: item.price,
      image: item.thumbnail,
      link: item.link ?? item.product_link,
      source: item.source,
    }));
    /** 자르는 것은 맨 마지막이다. 먼저 잘라 버리면 이미 값을 치르고 받아온 뒤쪽
     *  결과를 못 쓰고, 걸러낸 만큼 카드가 비어 보인다. 남는 게 네 장보다 적으면
     *  그대로 적게 보여준다 — 억지로 채우지 않는다. */
    const relevant = dedupeProducts(filterByProductTerm(products, query));
    return { status: SearchStatus.Ok, products: relevant.slice(0, RESULT_LIMIT) };
  } catch (error) {
    logger.error(
      '[products] SerpApi search failed: ' + JSON.stringify(error?.response?.data ?? error.message),
    );
    /** 실패와 "결과 0건"은 다르다. 둘 다 빈 배열로 뭉개면 타임아웃이 검색 결과 없음으로
     *  보고돼, 카드가 안 뜨는 원인을 응답만 보고는 구분할 수 없다. */
    return { status: SearchStatus.Failed, products: [] };
  }
}

/**
 * 네이버 쇼핑 검색 — 한국(ko) 시장용
 */
async function searchNaverShopping(query) {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return { status: SearchStatus.NotConfigured, products: [] };
  }

  try {
    const response = await axios.get('https://openapi.naver.com/v1/search/shop.json', {
      params: { query, display: RESULT_LIMIT },
      headers: {
        'X-Naver-Client-Id': clientId,
        'X-Naver-Client-Secret': clientSecret,
      },
      timeout: 8000,
    });

    const results = response.data?.items ?? [];
    const products = results.map((item) => ({
      title: item.title.replace(/<\/?b>/g, ''), // 네이버는 굵은글씨 태그가 섞여서 옴
      price: item.lprice ? `₩${Number(item.lprice).toLocaleString()}` : undefined,
      image: item.image,
      link: item.link,
      source: item.mallName,
    }));
    const relevant = dedupeProducts(filterByProductTerm(products, query));
    return { status: SearchStatus.Ok, products: relevant.slice(0, RESULT_LIMIT) };
  } catch (error) {
    logger.error(
      '[products] Naver search failed: ' + JSON.stringify(error?.response?.data ?? error.message),
    );
    return { status: SearchStatus.Failed, products: [] };
  }
}

router.post('/search', requireJwtAuth, async (req, res) => {
  try {
    const { text, market, question } = req.body;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ message: 'text is required' });
    }

    /** 질문 언어로 시장을 정한다. env 값은 판단할 질문이 없을 때의 기본값이다. */
    const resolvedMarket = resolveMarket({
      requestedMarket: market,
      question,
      fallback: process.env.PRODUCT_SEARCH_MARKET,
    });

    /** `reason`은 프론트에서 쓰지 않지만, 빈 결과의 원인이 "상품 얘기가 아님"인지
     *  "분류기를 못 썼음"인지 "검색 결과가 없음"인지 구분해준다. 이 구분이 없으면
     *  모든 실패가 똑같은 빈 배열로 보여 디버깅이 불가능해진다. */
    if (!isPlausiblyShopping(text)) {
      return res
        .status(200)
        .json({ products: [], keywords: null, market: resolvedMarket, reason: 'prefiltered' });
    }

    const { query, categories, reason } = await analyzeShoppingIntent(
      text,
      typeof question === 'string' ? question : undefined,
      resolvedMarket,
    );
    if (reason !== null) {
      return res.status(200).json({ products: [], keywords: null, market: resolvedMarket, reason });
    }

    /** 카테고리 답변은 여기서 검색하지 않는다. 펼친 카테고리만 `/category`로
     *  검색되므로, 읽히지도 않을 카테고리에 검색 예산을 쓰지 않는다. */
    if (categories.length > 0) {
      const signed = categories.map((entry) => ({ ...entry, token: signQuery(entry.query) }));
      return res.status(200).json({
        products: [],
        categories: signed,
        keywords: null,
        market: resolvedMarket,
        reason: null,
      });
    }

    const found =
      resolvedMarket === 'naver'
        ? await searchNaverShopping(query)
        : await searchGoogleShopping(query, resolvedMarket);

    res.status(200).json({
      ...describeSearchResult(found),
      keywords: query,
      market: resolvedMarket,
    });
  } catch (error) {
    logger.error('[products/search] Error fetching products', error);
    res.status(500).json({ message: 'Error fetching products', products: [] });
  }
});

/**
 * 아코디언에서 카테고리를 펼쳤을 때만 호출된다. 분류는 이미 `/search`에서 끝났으므로
 * 검색어를 그대로 받아 쇼핑 검색만 수행하되, `/search`가 발급한 서명이 있어야 한다.
 */
router.post('/category', requireJwtAuth, async (req, res) => {
  try {
    const { query, token, market } = req.body;
    if (!query || typeof query !== 'string') {
      return res.status(400).json({ message: 'query is required' });
    }
    if (!isValidQueryToken(query, token)) {
      logger.warn('[products/category] Rejected a query that this server did not issue');
      return res.status(400).json({ message: 'invalid query token', products: [] });
    }

    const resolvedMarket = resolveMarket({
      requestedMarket: market,
      question: query,
      fallback: process.env.PRODUCT_SEARCH_MARKET,
    });
    const found =
      resolvedMarket === 'naver'
        ? await searchNaverShopping(query)
        : await searchGoogleShopping(query, resolvedMarket);

    res.status(200).json({
      ...describeSearchResult(found),
      keywords: query,
      market: resolvedMarket,
    });
  } catch (error) {
    logger.error('[products/category] Error fetching products', error);
    res.status(500).json({ message: 'Error fetching products', products: [] });
  }
});

module.exports = router;
