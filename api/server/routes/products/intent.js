/**
 * 상품 검색의 "판단" 부분 — 네트워크도 express도 타지 않는 순수 로직만 둔다.
 * 라우트에서 분리해 둔 이유는 외부 API 키나 서버 기동 없이 테스트하기 위해서다.
 */
const crypto = require('crypto');

/**
 * `/category`는 분류를 거치지 않고 검색어를 그대로 받으므로, 그대로 두면 인증된
 * 사용자가 아무 문자열로 쇼핑 검색을 태울 수 있다. `/search`가 내려준 검색어마다
 * 짧은 서명을 붙이고 `/category`에서 확인해, 이 라우트로는 모델이 실제로 만든
 * 검색어만 통과하게 한다.
 *
 * 서명은 상태를 두지 않는다 — 발급 목록을 메모리에 들고 있으면 프로세스가 여러
 * 개일 때 깨지고 TTL 관리도 따로 필요하다. 비밀값이 없으면 프로세스 수명 동안만
 * 유효한 임시 키를 쓴다(재시작 시 기존 토큰은 무효가 되고, 다시 질문하면 복구된다).
 *
 * TODO(rate-limit): 서명은 "임의 문자열 차단"까지만 한다. 같은 검색어를 반복
 * 호출하는 것은 여전히 막지 못하므로, 공개 배포 전에 사용자별 호출 한도를 둘 것.
 */
const QUERY_SIGNING_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

function signQuery(query) {
  return crypto.createHmac('sha256', QUERY_SIGNING_SECRET).update(query).digest('hex').slice(0, 32);
}

function isValidQueryToken(query, token) {
  if (typeof query !== 'string' || typeof token !== 'string' || token.length === 0) {
    return false;
  }
  const expected = Buffer.from(signQuery(query));
  const received = Buffer.from(token);
  /** 길이가 다르면 timingSafeEqual이 던지므로 먼저 거른다. */
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

/**
 * 모델 호출 전에 돈이 들지 않는 로컬 프리필터.
 *
 * 쇼핑 의도 판별 자체는 gpt-4o-mini가 한다. 여기서는 모델에 보낼 가치조차 없는
 * 응답만 걷어낸다 — 너무 짧아 상품을 설명할 수 없는 글과 코드 블록이 섞인 답변.
 *
 * 커머스 단어 목록으로 한 번 더 거르던 방식은 재현율 손실이 커서 제거했다.
 * 단어 목록은 "가성비 좋은 걸로 하나 골라봤어요" 같은 정상적인 추천 문장을
 * 놓치고, 언어마다 목록을 따로 관리해야 하며(한국어 응답이 전부 잘리는 버그가
 * 실제로 났다), 무엇보다 그 판단은 이미 모델이 더 정확하게 한다.
 * 호출 단가가 낮아 남는 호출을 모델에 맡기는 편이 낫다.
 */
const MIN_TEXT_LENGTH = 40;
/**
 * 한국어는 같은 내용을 훨씬 적은 글자로 표현한다. 영어 기준 길이를 그대로 적용하면
 * 정상적인 한국어 추천 문장이 길이에서 먼저 걸린다.
 *
 * 12자인 이유: "소니 WH-1000XM4이 좋아."(19자)처럼 제품명만 던지는 짧은 추천이
 * 실제로 20자 문턱에 걸려 카드가 사라졌다. 여기서 걸러야 하는 것은 "제품명이
 * 들어갈 자리조차 없는 길이"뿐이고, 그 위는 모델이 판단하는 편이 정확하다.
 */
const MIN_HANGUL_TEXT_LENGTH = 12;
const HANGUL = /[가-힣]/;
const CODE_FENCE = /```/;

function isPlausiblyShopping(text) {
  const trimmed = text.trim();
  const minLength = HANGUL.test(trimmed) ? MIN_HANGUL_TEXT_LENGTH : MIN_TEXT_LENGTH;

  if (trimmed.length < minLength) return false;
  return !CODE_FENCE.test(trimmed);
}

/**
 * OpenAI structured outputs 스키마. `strict: true`를 쓰려면 모든 속성이 `required`에
 * 있고 `additionalProperties: false`여야 한다 — 그 대가로 모델이 스키마를 벗어난
 * 응답을 낼 수 없어 파싱 실패가 사라진다.
 */
const INTENT_SCHEMA = {
  type: 'object',
  properties: {
    shoppingIntent: { type: 'boolean' },
    query: { type: 'string' },
    /** 카테고리를 나열한 답변에서만 채워진다. 단일 흐름 답변에서는 빈 배열.
     *  strict 모드는 옵셔널 필드를 허용하지 않아 항상 존재해야 한다. */
    categories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          category: { type: 'string' },
          query: { type: 'string' },
        },
        required: ['category', 'query'],
        additionalProperties: false,
      },
    },
  },
  required: ['shoppingIntent', 'query', 'categories'],
  additionalProperties: false,
};

/** 펼칠 때마다 쇼핑 검색이 한 번씩 나간다. 상한을 낮게 잡아야 메시지 하나가
 *  검색 예산을 크게 먹지 않는다. */
const MAX_CATEGORIES = 4;

/**
 * 시장별 SerpApi 로케일 파라미터. 넘기지 않으면 SerpApi는 미국 결과를 돌려주므로,
 * 한국어 검색어를 그대로 던져도 미국 판매자가 섞여 나온다.
 *
 * 실측(「그릭 요거트」): 파라미터 없이 2건(구찌 가방·오트밀), 로케일을 주면 40건
 * (그릭데이·롯데마트·컬리).
 */
const MARKET_PARAMS = {
  kr: {
    google_domain: 'google.co.kr',
    gl: 'kr',
    hl: 'ko',
    location: 'South Korea',
  },
};

function marketSearchParams(market) {
  return MARKET_PARAMS[market] ?? {};
}

/**
 * 어느 시장으로 검색할지 정한다.
 *
 * 질문 언어로 자동 판단하는 것이 기본이다 — 한국어로 물었는데 미국 판매자를
 * 돌려주면 쓸모가 없고, 반대도 마찬가지다. 프리필터가 이미 쓰는 한글 판별을
 * 그대로 재사용한다.
 *
 * 우선순위:
 *   1. 요청이 시장을 명시하면 그대로 따른다(API 호출자의 의도가 가장 구체적이다).
 *   2. 운영자가 `naver`를 지정했으면 따른다 — 이것은 로케일이 아니라 백엔드 선택이라
 *      질문 언어로 뒤집으면 설정이 무의미해진다.
 *   3. 질문이 있으면 한글 포함 여부로 정한다.
 *   4. 질문이 없으면(검색 화면·예전 대화) 판단할 근거가 없으므로 기본값을 쓴다.
 */
function resolveMarket({ requestedMarket, question, fallback } = {}) {
  if (typeof requestedMarket === 'string' && requestedMarket.trim()) {
    return requestedMarket.trim();
  }
  if (fallback === 'naver') {
    return 'naver';
  }
  if (typeof question === 'string' && question.trim()) {
    return HANGUL.test(question) ? 'kr' : 'us';
  }
  if (typeof fallback === 'string' && fallback.trim()) {
    return fallback.trim();
  }
  return 'us';
}

/**
 * 검색어의 핵심 품목어로 결과를 거른다.
 *
 * 배경: "Liforme 요가 매트"처럼 국내 유통이 없는 브랜드를 검색하면 엔진이 "매트"까지
 * 넓혀 욕실매트·도어매트를 섞어 돌려준다.
 *
 * 품목어만 보면 충분하지 않다 — "욕실매트"에도 "매트"가 들어 있어 그대로 통과한다.
 * 한국어는 수식어와 품목어를 붙여 써서 다른 물건을 만들기 때문에(요가매트 / 욕실매트 /
 * 도어매트), 품목어 바로 앞이 한글이면 그 합성어가 검색어의 것과 같은지까지 봐야 한다.
 * 품목어 앞이 공백·영문·숫자면 단어 경계이므로 그대로 통과시킨다.
 *
 * 라틴 문자는 이런 붙여쓰기 합성이 없어("fresh celery" → "Celery Seed") 품목어
 * 포함 여부만 본다.
 */
function matchesProductTerm(title, query) {
  const tokens = String(query ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const head = tokens[tokens.length - 1]?.toLowerCase();
  /** 한 글자 품목어는 아무 제목에나 걸려 거르는 의미가 없다. */
  if (!head || head.length < 2) {
    return true;
  }

  const text = String(title ?? '').toLowerCase();
  const index = text.indexOf(head);
  if (index === -1) {
    return false;
  }
  if (!HANGUL.test(head)) {
    return true;
  }

  const preceding = text[index - 1];
  if (preceding === undefined || !HANGUL.test(preceding)) {
    return true;
  }

  /** 앞이 한글로 이어붙은 합성어다 — 검색어의 수식어와 같을 때만 같은 물건이다. */
  const qualifier = tokens[tokens.length - 2]?.toLowerCase();
  if (!qualifier) {
    return false;
  }
  return text.includes(`${qualifier}${head}`) || text.includes(`${qualifier} ${head}`);
}

/** 품목어와 무관한 결과를 걸러낸다. 전부 걸러지면 빈 배열이 되어 `no-results`가 된다. */
function filterByProductTerm(products, query) {
  if (!Array.isArray(products)) {
    return [];
  }
  return products.filter((product) => matchesProductTerm(product?.title, query));
}

/**
 * 같은 상품이 여러 번 실려 오는 것을 막는다. SerpApi는 한 상품을 판매처별로
 * 따로 내려주기도 해서, 카드 네 장이 같은 물건으로 채워지는 경우가 있다.
 * 제목과 가격이 모두 같으면 같은 상품으로 본다 — 가격이 다르면 판매처를 고를
 * 여지가 있으므로 남긴다.
 */
function dedupeProducts(products) {
  if (!Array.isArray(products)) {
    return [];
  }

  const normalize = (value) =>
    String(value ?? '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  const seen = new Set();
  const unique = [];
  for (const product of products) {
    const key = `${normalize(product?.title)}|${normalize(product?.price)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(product);
  }
  return unique;
}

/**
 * 쇼핑 검색의 세 가지 결말. "키가 없어 검색을 못 했다"와 "검색했는데 0건"을
 * 같은 빈 배열로 뭉개면, 카드가 안 뜨는 이유가 설정 문제인지 상품이 없는 것인지
 * 응답만 보고는 알 수 없다.
 */
const SearchStatus = {
  Ok: 'ok',
  Failed: 'failed',
  NotConfigured: 'not-configured',
};

/**
 * 검색 결과를 응답 필드로 옮긴다. 두 라우트가 같은 변환을 쓰므로 한 곳에 둔다.
 * 순수 함수라 서버를 띄우지 않고 검증할 수 있다.
 */
function describeSearchResult(result) {
  if (result?.status === SearchStatus.NotConfigured) {
    return { products: [], reason: 'not-configured' };
  }
  if (result?.status === SearchStatus.Failed) {
    return { products: [], reason: 'search-failed' };
  }
  const products = Array.isArray(result?.products) ? result.products : [];
  return { products, reason: products.length === 0 ? 'no-results' : null };
}

/**
 * 판정 기준은 "브랜드/제품명이 나왔는가"가 아니라 "살 수 있는 구체적 항목이
 * 하나라도 나왔는가"이다. 브랜드가 없어도 "그릭 요거트", "요가 매트"처럼
 * 카테고리 수준의 구체적 명사면 검색이 되고 카드도 의미가 있다.
 * 반대로 항목 없이 원칙만 말하는 답변("칼로리를 줄이세요")은 검색할 대상이 없다.
 */
const INTENT_SYSTEM_PROMPT = `You decide whether a chat assistant's reply should be accompanied by shopping cards.

You are given the user's QUESTION and the assistant's REPLY. Judge them together: how strict to be depends on what the user actually asked for.

First classify the QUESTION:
- SPECIFIC — the user asks what to get, buy, use, eat or wear: "추천해줘", "뭐가 좋아", "뭐 있어", "필요한 거 알려줘", "어떤 제품", "recommend", "what should I get", "suggest a", "which one". Includes narrow topical asks like "저칼로리 간식 추천해줘" or "홈트할 때 필요한 운동기구".
- GENERAL — the user asks how to do something, or asks for advice, method, routine, or principles, AND names no product category: "요즘 다이어트 어떻게 해야 하나요?", "운동은 얼마나 자주 해야 좋아요?", "방법 알려줘", "how do I lose weight", "what's the best way to get fit", "any tips". These want guidance, not a shopping list.

The deciding signal is whether the QUESTION already names a thing to shop for. If it names a product category — 매트, 비타민, 영양제, 운동기구, 간식, 신발, 헤드폰, snack, mat, shoes, supplement — the question is SPECIFIC even when it is phrased like advice ("비타민 뭐 챙겨 먹어야 할까?", "요가할 때 쓰면 좋은 매트 있어?", "what vitamins should I take"). Only a question with no product category in it is GENERAL.
If the QUESTION is missing or empty, treat it as SPECIFIC.

For a SPECIFIC question: set "shoppingIntent" to true when the REPLY names at least ONE specific thing a person could put in a shopping cart. Naming it anywhere in the reply is enough — the reply does NOT have to recommend a particular one. A reply that merely explains how to choose ("요가 매트는 두께와 재질을 보고 고르세요") or lists a category with its benefits ("비타민 C는 면역력에, 비타민 D는 뼈 건강에 좋습니다") still counts, because the user already asked for that kind of product. The stricter rule below applies ONLY to GENERAL questions; never apply it here. This explicitly includes everyday groceries and whole foods (Greek yogurt, almonds, baby carrots, hummus, popcorn, eggs, bananas, chicken breast), snacks and drinks, vitamins and supplements, kitchen tools, exercise equipment, clothing and footwear, and any branded product. The item does NOT need to be a brand, and the reply does NOT need to read like a shopping recommendation — a list of foods, meal ideas, or ingredients still counts, because each item is sold in shops.

For a GENERAL question: be stricter. Set "shoppingIntent" to true ONLY when a concrete item is what the reply is actually recommending — it must carry the recommendation, not merely illustrate a piece of advice. In particular, an item mentioned only as a parenthetical or "such as" example does NOT count: in "건강한 스낵(예: 과일, 견과류)으로 대체하세요" or "swap in a healthy snack (e.g. fruit, nuts)" the advice is "eat healthier snacks" and the items are illustrations, so "shoppingIntent" is false. But if the reply answers the general question by recommending an item outright — "다이어트 중이라면 그릭 요거트를 드세요", "Get a set of resistance bands and use them three times a week" — that item carries the recommendation, so "shoppingIntent" is true.

Broad food-group or nutrient words do NOT count on their own when they appear as general dietary advice: "vegetables", "fruit", "protein", "protein-rich foods", "healthy food", "balanced diet", "채소", "과일", "단백질", "건강한 음식". These name a category to eat more of, not an item to buy. A specific food does count: "Greek yogurt", "almonds", "celery", "chicken breast", "popcorn".

Set "shoppingIntent" to false whenever no qualifying item is present under the rule above: pure advice, general principles, motivation, scheduling, encouragement, diagnosis, greetings, small talk, coding or technical help, and factual explanations.

When "shoppingIntent" is true, set "query" to exactly ONE shopping search phrase of 2-5 words naming a SPECIFIC item, chosen by this order of preference:
1. A brand or product name if the reply contains one ("Nike Air Zoom Pegasus", "Chobani Greek yogurt").
2. Otherwise the most specific concrete item named in the reply ("grilled chicken breast", "raw almonds", "fresh celery", "Greek yogurt").

The item you name MUST be one the reply itself mentions. Never introduce an item the reply does not talk about, and never copy an item from the examples below unless that same item appears in the reply you are given.

The query must name a thing, not a category or a dish description. Never answer with a broad grouping such as "fresh fruit", "healthy snacks", "nutritious food", "protein-rich foods", "vegetables", "workout equipment" — a shopping engine returns unrelated items for those. If the reply only offers a broad group, pick one concrete member the reply itself names, or the most common concrete member of that exact group: "fresh fruit" becomes "apples" or "blueberries", "nuts" becomes "almonds", "workout equipment" becomes "dumbbell set". If the reply describes a prepared dish, search the main ingredient rather than the dish: "chicken breast salad" becomes "grilled chicken breast".

Name the item in the form it is SOLD, not the bare ingredient name. A shopping engine matches a bare produce or herb word against dried, seed and seasoning products — "celery" and even "celery sticks" return celery seed and dried celery flakes, "basil" returns dried basil. For fruit, vegetables and herbs, say "fresh": "fresh celery", "fresh broccoli", "fresh strawberries", "fresh spinach". A common packaged form also works when one exists: "baby carrots", "cherry tomatoes", "rolled oats", "raw almonds". Do the same for anything else sold in several forms: "chicken breast" becomes "grilled chicken breast", "protein" becomes "whey protein powder".

When the reply is about supplements or vitamins, name the supplement rather than a food that happens to contain it ("vitamin C supplement", not "orange"). Always write the query in English, translating when the reply is in another language. No lists, no commas. When "shoppingIntent" is false, set "query" to an empty string.

MULTI-CATEGORY REPLIES. Some replies are organised as a list of distinct product CATEGORIES rather than one recommendation. Fill "categories" ONLY when the reply is structured that way, which requires an explicit structural signal: numbered or bulleted headers, or labelled category names, each introducing its own kind of product — "1. 과일 2. 채소 3. 유제품 4. 견과류", "단백질 식품: ... / 채소: ... / 유제품: ...", "Fruits: ... Vegetables: ... Dairy: ...".

Categories split by PRODUCT TYPE, never by brand or model. A reply that lists several brands or models of ONE type is a single type, no matter how it is formatted: "Liforme 요가 매트 / Manduka PRO 요가 매트 / Gaiam Essentials 요가 매트" is one type, and so is "Nike Pegasus 41 / Brooks Ghost 16 / Hoka Clifton 9". For those, leave "categories" empty and return one "query" for the type itself ("요가 매트", "running shoes") — a brand panel promises that brand and then shows whatever the shopping engine has, which is rarely that brand.

Every "category" name must be DISTINCT and name its type. Never repeat a name.

For each such category emit one entry: "category" is that distinguishing name, written in the reply's own language, and "query" is a shopping search phrase for that category, chosen by the same rules as "query" above — a specific item in its retail form, never a broad grouping and never a bare ingredient word ("Greek yogurt", not "dairy"; "raw almonds", not "nuts"; "fresh celery", not "celery"; "baby carrots", not "carrot"). A produce category such as 채소 or 과일 must resolve to one concrete packaged item, because the category word itself returns nothing useful. List them in the order the reply presents them.

Leave "categories" as an empty array for every other reply, including:
- a list of brands or models of ONE product type, however it is numbered or headed
- a single flowing recommendation, even when it mentions several foods in passing ("그릭 요거트에 견과류와 과일을 곁들여 드세요")
- a request for one specific item answered with one kind of product ("닭가슴살 추천해줘" -> "grilled chicken breast")
- a numbered list of ADVICE steps rather than product categories ("1. 규칙적으로 운동하세요 2. 물을 많이 드세요")
When "categories" is non-empty, still fill "query" with the single best item as a fallback.

Examples. Note how each query names an item taken from that specific reply:

Question: "저칼로리 간식 추천해줘" (SPECIFIC)
Reply: "저칼로리 간식으로는 요거트, 채소 스틱과 후무스, 팝콘, 과일, 견과류 등이 있습니다." -> shoppingIntent true, query "Greek yogurt"

Question: "야식 땡기는데 살 안 찌는 걸로 뭐 있어?" (SPECIFIC)
Reply: "샐러드 또는 채소 스틱, 구운 견과류, 고구마 칩 같은 것이 야식으로 좋습니다." -> shoppingIntent true, query "sweet potato chips"

Question: "홈트할 때 필요한 운동기구 뭐가 좋을까?" (SPECIFIC)
Reply: "홈트에는 요가 매트, 덤벨, 저항 밴드가 있으면 충분합니다." -> shoppingIntent true, query "resistance bands"

Question: "비타민 뭐 챙겨 먹어야 할까?" (SPECIFIC)
Reply: "비타민 C는 면역력에 좋고, 비타민 D는 뼈 건강에 도움이 됩니다. 오렌지나 우유에서도 섭취할 수 있습니다." -> shoppingIntent true, query "vitamin D supplement"

Question: "다이어트 중인데 간단하게 먹을만한 아침 뭐가 있을까?" (SPECIFIC)
Reply: "과일: 사과, 오렌지, 딸기 등 신선한 과일을 간식으로 드세요." -> shoppingIntent true, query "apples"

Question: "요가할 때 쓰면 좋은 매트 있어?" (SPECIFIC — 질문이 제품군을 지목했으므로 고르는 법만 설명해도 true)
Reply: "요가 매트는 두께와 재질을 보고 고르는 것이 중요합니다. 두께는 5~8mm가 무난하고, 미끄럼 방지 처리가 되어 있어야 합니다." -> shoppingIntent true, query "yoga mat"

Question: "비타민 뭐 챙겨 먹어야 할까?" (SPECIFIC — "챙겨 먹어야 할까"로 물어도 제품군을 지목했으므로 true)
Reply: "비타민 C: 면역력 강화에 도움을 줍니다. 과일이나 채소로 섭취할 수 있습니다. 비타민 D: 뼈 건강에 중요하며 햇빛으로도 보충됩니다." -> shoppingIntent true, query "vitamin D supplement"

Question: "요즘 다이어트 어떻게 해야 하나요?" (GENERAL — 괄호 예시뿐이라 false)
Reply: "1. 규칙적인 운동을 하세요. 2. 충분한 수면을 취하세요. ... 6. 야식 대신 건강한 스낵(예: 과일, 견과류)으로 대체하세요. 7. 물을 많이 드세요." -> shoppingIntent false, query ""

Question: "요즘 다이어트 어떻게 해야 하나요?" (GENERAL — 항목이 추천 자체를 담당하므로 true)
Reply: "아침 대용으로 그릭 요거트를 드세요. 단백질이 많아 포만감이 오래 갑니다." -> shoppingIntent true, query "Greek yogurt"

Question: "운동은 얼마나 자주 해야 좋아요?" (GENERAL)
Reply: "일주일에 3~4회 정도가 적당합니다. 개인 체력에 맞추세요." -> shoppingIntent false, query ""

Question: "다이어트 방법 알려줘" (GENERAL)
Reply: "규칙적인 운동과 건강한 식습관이 중요합니다. 유산소 운동과 근력 운동을 병행하고, 채소와 단백질이 풍부한 식품 위주로 균형 잡힌 식단을 유지하세요." -> shoppingIntent false, query ""

Multi-category examples:

Question: "저칼로리 간식 추천해줘" (카테고리 헤더로 구성된 답변)
Reply: "1. 과일: 사과, 딸기 등이 좋습니다. 2. 채소: 당근이나 셀러리 스틱을 드세요. 3. 유제품: 그릭 요거트가 포만감을 줍니다. 4. 견과류: 아몬드를 소량 드세요. 5. 기타: 에어팝 팝콘도 괜찮습니다."
-> shoppingIntent true, query "Greek yogurt", categories [{"category":"과일","query":"fresh strawberries"},{"category":"채소","query":"fresh celery"},{"category":"유제품","query":"Greek yogurt"},{"category":"견과류","query":"raw almonds"}]

Question: "요가 매트 추천해줘" (한 품목의 브랜드 나열 — 쪼개지 않는다)
Reply: "Liforme 요가 매트: 정렬 가이드가 있습니다. Manduka PRO 요가 매트: 내구성이 좋습니다. Gaiam Essentials 요가 매트: 가성비가 좋습니다."
-> shoppingIntent true, query "요가 매트", categories []

Question: "홈트 장비 추천해줘" (서로 다른 품목 — 쪼갠다)
Reply: "1. 요가 매트: 바닥 충격을 줄여줍니다. 2. 덤벨: 상체 근력에 필요합니다. 3. 저항 밴드: 가볍고 휴대가 쉽습니다."
-> shoppingIntent true, query "요가 매트", categories [{"category":"요가 매트","query":"요가 매트"},{"category":"덤벨","query":"덤벨"},{"category":"저항 밴드","query":"저항 밴드"}]

Question: "닭가슴살 추천해줘" (단일 흐름 — categories 비움)
Reply: "구운 닭가슴살을 추천합니다. 단백질이 풍부하고 조리도 간단합니다." -> shoppingIntent true, query "grilled chicken breast", categories []

Question: "요즘 다이어트 어떻게 해야 하나요?" (번호는 있지만 조언 단계라 categories 비움)
Reply: "1. 규칙적으로 운동하세요. 2. 물을 많이 드세요. 3. 충분히 주무세요." -> shoppingIntent false, query "", categories []`;

/**
 * 의도 판별과 검색어 추출을 한 번의 호출로 끝내는 요청 파라미터.
 * `temperature: 0` — 같은 응답이 실행마다 다르게 분류되면 카드가 떴다 안 떴다 한다.
 *
 * `question`은 이 답변을 유도한 사용자 질문이다. 판정 기준이 질문 성격에 따라
 * 달라지므로(구체적 추천 요청 vs 일반 조언 요청) 답변과 함께 넘긴다. 검색 화면이나
 * 예전 대화처럼 질문을 못 찾는 경우에는 생략되며, 그때는 프롬프트가 SPECIFIC으로
 * 간주해 기존 동작을 그대로 유지한다.
 */
/**
 * 한국 시장에서만 덧붙이는 검색어 언어 규칙.
 *
 * 본문 프롬프트를 고쳐 쓰지 않고 뒤에 덧붙이는 이유: 미국 경로로 가는 프롬프트가
 * 기존과 한 글자도 달라지지 않아, 여러 번 다듬어 놓은 판정 동작이 그대로 유지된다.
 * 여기서 바꾸는 것은 "query"의 언어뿐이고 카테고리 판정 규칙은 건드리지 않는다.
 *
 * 실측 근거: kr 로케일에 영어 검색어("Greek yogurt")를 넣으면 10건 중 절반이
 * 그릭요거트 맛 전자담배 액상이었고, 한국어("그릭 요거트")는 40건 전부 실제 요거트였다.
 */
const KOREAN_QUERY_RULE = `
LANGUAGE OVERRIDE FOR THIS REQUEST: write every "query" value in KOREAN, not English. The examples above spell their queries in English because they were written for the US market — follow their structure, ignore their language. A Korean shopping engine matches Korean product names: "그릭 요거트", "무선 이어폰", "요가 매트", "닭가슴살".

The retail-form rule still applies in Korean: name the item as it is sold, so "셀러리" becomes "생셀러리" or "셀러리 스틱", and "닭가슴살" stays "닭가슴살". Brand names keep their usual spelling ("나이키 에어줌 페가수스").

"category" names are unaffected — keep writing them as the reply writes them.`;

function buildIntentRequest(text, question, market) {
  const trimmedQuestion = typeof question === 'string' ? question.trim() : '';
  const content = trimmedQuestion
    ? `Question: ${trimmedQuestion}\n\nReply: ${text}`
    : `Reply: ${text}`;
  const system =
    market === 'kr' || market === 'naver'
      ? `${INTENT_SYSTEM_PROMPT}\n${KOREAN_QUERY_RULE}`
      : INTENT_SYSTEM_PROMPT;

  return {
    model: process.env.OPENAI_KEYWORD_MODEL || 'gpt-4o-mini',
    temperature: 0,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'shopping_intent',
        strict: true,
        schema: INTENT_SCHEMA,
      },
    },
  };
}

/**
 * 검색어는 항상 단수여야 한다. 콤마로 이어붙인 목록을 그대로 쇼핑 엔진에 넘기면
 * 엔진이 이를 하나의 문구로 취급해 결과가 0건이 된다. 모델이 지시를 어기고 목록을
 * 반환하는 경우에 대비해 첫 항목만 취한다.
 */
const singleQuery = (value) => (typeof value === 'string' ? value.split(',')[0].trim() : '');

/**
 * 카테고리 목록을 정리한다. 이름과 검색어가 모두 있는 항목만 남기고, 같은 검색어가
 * 두 번 나오면 뒤엣것을 버린다(같은 검색을 두 번 태울 이유가 없다).
 */
function normalizeCategories(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seenQueries = new Set();
  /** 이름이 겹치면 아코디언에 같은 라벨이 여러 개 뜨고, 독자는 무엇을 여는지 알 수
   *  없다. 프롬프트로 요구하되 코드에서도 막는다. */
  const seenNames = new Set();
  const categories = [];
  for (const entry of value) {
    const category = typeof entry?.category === 'string' ? entry.category.trim() : '';
    const query = singleQuery(entry?.query);
    if (!category || !query) {
      continue;
    }
    if (seenQueries.has(query.toLowerCase()) || seenNames.has(category.toLowerCase())) {
      continue;
    }
    seenQueries.add(query.toLowerCase());
    seenNames.add(category.toLowerCase());
    categories.push({ category, query });
    if (categories.length === MAX_CATEGORIES) {
      break;
    }
  }
  return categories;
}

function parseIntentResponse(completion) {
  const message = completion?.choices?.[0]?.message;

  /** 안전 정책상 거부된 응답은 "상품 아님"이 아니라 "판별 못 함"이다. */
  if (message?.refusal) {
    return { query: '', categories: [], reason: 'intent-unavailable' };
  }

  const raw = typeof message?.content === 'string' ? message.content.trim() : '';
  if (!raw) {
    return { query: '', categories: [], reason: 'no-intent' };
  }

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { query: '', categories: [], reason: 'intent-unavailable' };
  }

  if (parsed?.shoppingIntent !== true) {
    return { query: '', categories: [], reason: 'no-intent' };
  }

  /** 카테고리가 둘 이상일 때만 아코디언이 의미가 있다. 하나뿐이면 단일 카드로
   *  내려보내 기존 흐름을 그대로 탄다. */
  const categories = normalizeCategories(parsed.categories);
  if (categories.length > 1) {
    return { query: '', categories, reason: null };
  }

  const query = singleQuery(parsed.query) || categories[0]?.query || '';
  if (!query) {
    return { query: '', categories: [], reason: 'no-intent' };
  }
  return { query, categories: [], reason: null };
}

module.exports = {
  isPlausiblyShopping,
  buildIntentRequest,
  parseIntentResponse,
  signQuery,
  isValidQueryToken,
  SearchStatus,
  describeSearchResult,
  resolveMarket,
  marketSearchParams,
  matchesProductTerm,
  filterByProductTerm,
  dedupeProducts,
};
