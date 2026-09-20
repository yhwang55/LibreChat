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
  matchesProductTerm,
  filterByProductTerm,
  dedupeProducts,
} = require('../intent');

const completionOf = (payload) => ({
  choices: [{ message: { role: 'assistant', content: JSON.stringify(payload), refusal: null } }],
});

/**
 * 프리필터는 의미 판단을 하지 않는다 — 그건 gpt-4o-mini의 일이다.
 * 여기서 거르는 것은 모델에 보낼 가치조차 없는 두 가지뿐이다:
 * 상품을 설명하기엔 너무 짧은 글, 그리고 코드 블록이 섞인 답변.
 */
describe('shopping prefilter', () => {
  it.each([
    ['a greeting', 'Hi! How can I help you today?'],
    ['a short acknowledgement', 'Sure, done.'],
    ['a product mention too short to be a recommendation', 'Buy shoes.'],
    ['a bare Korean greeting', '안녕하세요!'],
  ])('skips %s as too short to describe a product', (_label, text) => {
    expect(isPlausiblyShopping(text)).toBe(false);
  });

  /** 짧은 한국어 추천이 길이 문턱에 걸려 카드가 사라지던 회귀. 제품명만 던지는
   *  한 줄 답변도 모델까지는 도달해야 한다. */
  it('lets a terse Korean product recommendation through', () => {
    expect(isPlausiblyShopping('소니 WH-1000XM4이 좋아.')).toBe(true);
  });

  it.each([
    ['a fenced code block', 'Here is the fix:\n```js\nconst x = 1;\n```\nThat resolves it.'],
    [
      'a Korean reply with a fenced code block',
      '아래처럼 고치시면 됩니다.\n```js\nconst x = 1;\n```\n이러면 해결됩니다.',
    ],
  ])('skips %s', (_label, text) => {
    expect(isPlausiblyShopping(text)).toBe(false);
  });

  /** 커머스 단어 목록을 쓰던 시절에는 아래 문장들이 단서가 없다는 이유로 잘려
   *  모델까지 가지 못했다. 판단은 모델에 맡기고 프리필터는 통과시켜야 한다. */
  it.each([
    [
      'a named product recommendation',
      'I recommend the Lodge Cast Iron Skillet as it is affordable, durable, and retains heat well.',
    ],
    [
      'a recommendation with no commerce keyword at all',
      'The Hario V60 is the one I reach for every morning; it pulls a cleaner cup than anything else.',
    ],
    [
      'a Korean product recommendation',
      '비행기에서 쓸 거라면 노이즈 캔슬링 무선 헤드폰이 가격 값을 합니다. 소니 제품을 추천해요.',
    ],
    [
      'a Korean recommendation with no commerce keyword',
      '아침마다 하리오 V60으로 내려 마시는데, 이만한 게 없더라고요. 한번 써보세요.',
    ],
    [
      'technical help the model should judge, not the regex',
      'You can memoize that selector with useMemo to avoid the extra re-render in your reducer.',
    ],
    [
      'a category-level food list',
      '저칼로리 간식으로는 요거트, 채소 스틱과 후무스, 팝콘, 과일, 견과류 등이 있습니다.',
    ],
    [
      'abstract advice the model must judge, not the prefilter',
      '요즘 다이어트는 꾸준함이 가장 중요합니다. 무리하지 말고 천천히 습관을 바꿔보세요.',
    ],
  ])('lets %s through to the classifier', (_label, text) => {
    expect(isPlausiblyShopping(text)).toBe(true);
  });
});

describe('intent request', () => {
  it('pins temperature to 0 so classification does not flip between runs', () => {
    expect(buildIntentRequest('some reply').temperature).toBe(0);
  });

  it('defaults to gpt-4o-mini', () => {
    expect(buildIntentRequest('some reply').model).toBe('gpt-4o-mini');
  });

  it('honours an operator-supplied model override', () => {
    process.env.OPENAI_KEYWORD_MODEL = 'gpt-4.1-mini';
    try {
      expect(buildIntentRequest('some reply').model).toBe('gpt-4.1-mini');
    } finally {
      delete process.env.OPENAI_KEYWORD_MODEL;
    }
  });

  /** strict 모드는 모든 속성이 required이고 additionalProperties가 false여야
   *  동작한다. 이 조건이 깨지면 OpenAI가 400을 반환한다. */
  it('requests a strict json_schema so the model cannot answer off-schema', () => {
    const { response_format } = buildIntentRequest('some reply');
    expect(response_format.type).toBe('json_schema');
    expect(response_format.json_schema.strict).toBe(true);
    expect(response_format.json_schema.schema.required).toEqual([
      'shoppingIntent',
      'query',
      'categories',
    ]);
    expect(response_format.json_schema.schema.additionalProperties).toBe(false);
  });

  it('sends the reply as the user turn and the rules as the system turn', () => {
    const { messages } = buildIntentRequest('a cast iron skillet');
    expect(messages[0].role).toBe('system');
    expect(messages[1]).toEqual({ role: 'user', content: 'Reply: a cast iron skillet' });
  });

  it('labels both turns when the question is known', () => {
    const { messages } = buildIntentRequest('그릭 요거트를 드세요', '다이어트 어떻게 해야 하나요?');
    expect(messages[1].content).toBe(
      'Question: 다이어트 어떻게 해야 하나요?\n\nReply: 그릭 요거트를 드세요',
    );
  });

  /** 검색 화면·예전 대화처럼 질문을 못 찾는 경우가 있다. 그때 판정이 엄격해지면
   *  기존에 뜨던 카드가 사라지므로, 질문 없는 입력은 기존 동작을 유지해야 한다. */
  it.each([undefined, '', '   '])('omits the question label when it is %p', (question) => {
    const { messages } = buildIntentRequest('some reply', question);
    expect(messages[1].content).toBe('Reply: some reply');
  });

  it('instructs the model to translate non-English replies into an English query', () => {
    const [system] = buildIntentRequest('러닝화 추천해주세요').messages;
    expect(system.content).toMatch(/write the query in English, translating/i);
  });

  /** 판정 기준이 "브랜드가 나왔는가"로 좁아지면 "요거트, 후무스, 견과류" 같은
   *  카테고리 수준 추천이 다시 no-intent로 떨어진다. 프롬프트가 조용히 좁아지는
   *  것을 막기 위해 계약을 고정한다. */
  it('tells the model a concrete item need not be a brand', () => {
    const [system] = buildIntentRequest('some reply').messages;
    expect(system.content).toMatch(/does NOT need to be a brand/i);
    expect(system.content).toMatch(/Greek yogurt/i);
  });

  it('tells the model that item-free advice is not shopping intent', () => {
    const [system] = buildIntentRequest('some reply').messages;
    expect(system.content).toMatch(/false whenever no qualifying item is present/i);
  });

  /** 식료품이 "상품이 아니다"라고 판단되면서 간식·식단 답변이 통째로
   *  no-intent로 떨어졌던 회귀. 프롬프트가 장바구니 범위를 명시해야 한다. */
  it('tells the model that everyday groceries count as purchasable', () => {
    const [system] = buildIntentRequest('some reply').messages;
    expect(system.content).toMatch(/everyday groceries and whole foods/i);
    expect(system.content).toMatch(/list of foods, meal ideas, or ingredients still counts/i);
  });

  /** 몇 가지 예시가 없으면 같은 성격의 답변이 실행마다 다르게 분류됐다. */
  it('anchors the boundary with worked examples on both sides', () => {
    const [system] = buildIntentRequest('some reply').messages;
    expect(system.content).toMatch(/shoppingIntent true, query "Greek yogurt"/);
    expect(system.content).toMatch(/shoppingIntent false, query ""/);
  });

  /** "채소와 단백질 위주로 드세요" 같은 일반 조언이 식품군 단어 때문에 상품으로
   *  분류돼 다이어트 조언에 카드가 붙던 회귀. */
  it('tells the model that broad food-group words are not shoppable items', () => {
    const [system] = buildIntentRequest('some reply').messages;
    expect(system.content).toMatch(/Broad food-group or nutrient words do NOT count/i);
    expect(system.content).toMatch(/not an item to buy/i);
  });

  /** "비타민 C: 오렌지..." 답변에서 query가 "orange"로 잡혀 오렌지 사탕 카드가
   *  뜨던 문제. 영양제 질문에는 영양제를 검색해야 한다. */
  it('tells the model to search the supplement, not a food containing it', () => {
    const [system] = buildIntentRequest('some reply').messages;
    expect(system.content).toMatch(/name the supplement rather than a food/i);
    expect(system.content).toMatch(/"vitamin C supplement", not "orange"/);
  });

  it('tells the model to pick exactly one item, chosen for what the reader would buy', () => {
    const [system] = buildIntentRequest('some reply').messages;
    expect(system.content).toMatch(/exactly ONE shopping search phrase/i);
    expect(system.content).toMatch(/naming a SPECIFIC item/i);
  });

  /** "fresh fruit"이 파프리카·쪽파를, "chicken breast salad"가 샐러드드레싱을
   *  불러오던 문제. 검색어가 포괄적이면 카드가 맥락과 어긋난다. */
  it('forbids broad grouping words as the query', () => {
    const [system] = buildIntentRequest('some reply').messages;
    expect(system.content).toMatch(/must name a thing, not a category/i);
    expect(system.content).toMatch(/"fresh fruit" becomes "apples"/);
  });

  it('tells the model to search a dish by its main ingredient', () => {
    const [system] = buildIntentRequest('some reply').messages;
    expect(system.content).toMatch(/"chicken breast salad" becomes "grilled chicken breast"/);
  });
});

/**
 * 카테고리 아코디언. 펼침 한 번이 쇼핑 검색 한 번이므로 개수 상한과
 * "단일 흐름 답변은 기존대로" 두 가지가 핵심이다.
 */
describe('multi-category replies', () => {
  const withCategories = (categories, query = 'Greek yogurt') =>
    parseIntentResponse(completionOf({ shoppingIntent: true, query, categories }));

  it('returns the category list when the reply is organised by category', () => {
    expect(
      withCategories([
        { category: '과일', query: 'apples' },
        { category: '유제품', query: 'Greek yogurt' },
      ]),
    ).toEqual({
      query: '',
      categories: [
        { category: '과일', query: 'apples' },
        { category: '유제품', query: 'Greek yogurt' },
      ],
      reason: null,
    });
  });

  /** 펼칠 때마다 검색이 나가므로 상한이 곧 메시지당 검색 비용의 천장이다. */
  it('caps the list at four categories', () => {
    const result = withCategories([
      { category: '과일', query: 'apples' },
      { category: '채소', query: 'celery sticks' },
      { category: '유제품', query: 'Greek yogurt' },
      { category: '견과류', query: 'almonds' },
      { category: '기타', query: 'popcorn' },
      { category: '더', query: 'rice cakes' },
    ]);

    expect(result.categories).toHaveLength(4);
    expect(result.categories.map((entry) => entry.query)).toEqual([
      'apples',
      'celery sticks',
      'Greek yogurt',
      'almonds',
    ]);
  });

  it('drops duplicate queries so the same search is not paid for twice', () => {
    const result = withCategories([
      { category: '유제품', query: 'Greek yogurt' },
      { category: '간식', query: 'greek YOGURT' },
      { category: '견과류', query: 'almonds' },
    ]);

    expect(result.categories.map((entry) => entry.category)).toEqual(['유제품', '견과류']);
  });

  it('drops entries missing a name or a query', () => {
    const result = withCategories([
      { category: '과일', query: 'apples' },
      { category: '', query: 'celery sticks' },
      { category: '유제품', query: '   ' },
      { category: '견과류', query: 'almonds' },
    ]);

    expect(result.categories).toEqual([
      { category: '과일', query: 'apples' },
      { category: '견과류', query: 'almonds' },
    ]);
  });

  /** 걸러내고 나서 하나만 남으면 아코디언을 세울 이유가 없다 — 단일 카드로 간다. */
  it('falls back to the single-card path when filtering leaves one category', () => {
    expect(
      withCategories(
        [
          { category: '과일', query: 'apples' },
          { category: '', query: 'celery sticks' },
        ],
        '',
      ),
    ).toEqual({ query: 'apples', categories: [], reason: null });
  });

  /** 단일 흐름 답변은 아코디언이 아니라 기존 카드 세트로 가야 한다. */
  it('keeps a single category on the single-card path', () => {
    expect(withCategories([{ category: '닭가슴살', query: 'grilled chicken breast' }], '')).toEqual(
      {
        query: 'grilled chicken breast',
        categories: [],
        reason: null,
      },
    );
  });

  it('keeps an ordinary reply on the single-card path', () => {
    expect(withCategories([], 'grilled chicken breast')).toEqual({
      query: 'grilled chicken breast',
      categories: [],
      reason: null,
    });
  });

  it('requires an explicit structural signal, not any mention of several foods', () => {
    const [system] = buildIntentRequest('some reply').messages;
    expect(system.content).toMatch(/requires an explicit structural signal/i);
    expect(system.content).toMatch(/numbered list of ADVICE steps rather than product categories/i);
  });

  it('tells the model each category query must be a specific item', () => {
    const [system] = buildIntentRequest('some reply').messages;
    expect(system.content).toMatch(/"Greek yogurt", not "dairy"/);
  });
});

/**
 * 이중 기준: 질문이 구체적 추천 요청이면 기존처럼 느슨하게, 일반 조언 요청이면
 * 엄격하게 본다. 프롬프트가 한쪽으로 조용히 무너지면 여기서 잡힌다.
 */
describe('question-aware criteria', () => {
  const systemPrompt = () => buildIntentRequest('some reply').messages[0].content;

  it('defines both question types with concrete trigger phrases', () => {
    const system = systemPrompt();
    expect(system).toMatch(/SPECIFIC — the user asks what to get/i);
    expect(system).toMatch(/GENERAL — the user asks how to do something/i);
    expect(system).toMatch(/추천해줘/);
    expect(system).toMatch(/어떻게 해야 하나요/);
  });

  it('treats a missing question as the looser SPECIFIC case', () => {
    expect(systemPrompt()).toMatch(/If the QUESTION is missing or empty, treat it as SPECIFIC/i);
  });

  /**
   * "비타민 뭐 챙겨 먹어야 할까?"와 "요가할 때 쓰면 좋은 매트 있어?"가 조언형 어미
   * 때문에 GENERAL로 분류돼 카드가 통째로 사라졌던 회귀. 질문이 제품군을 지목하면
   * 어미와 무관하게 SPECIFIC이어야 한다.
   */
  it('classifies a question naming a product category as SPECIFIC regardless of phrasing', () => {
    const system = systemPrompt();
    expect(system).toMatch(
      /deciding signal is whether the QUESTION already names a thing to shop for/i,
    );
    expect(system).toMatch(/비타민 뭐 챙겨 먹어야 할까\?/);
    expect(system).toMatch(/요가할 때 쓰면 좋은 매트 있어\?/);
  });

  /** 엄격한 규칙이 SPECIFIC 쪽으로 번지면 "고르는 법" 답변이 전부 no-intent가 된다. */
  it('confines the strict rule to general questions', () => {
    const system = systemPrompt();
    expect(system).toMatch(/applies ONLY to GENERAL questions; never apply it here/i);
    expect(system).toMatch(/reply that merely explains how to choose/i);
  });

  /** "건강한 스낵(예: 과일, 견과류)으로 대체하세요"가 카드를 띄우던 회귀. */
  it('excludes parenthetical examples from triggering a general-question card', () => {
    const system = systemPrompt();
    expect(system).toMatch(/parenthetical or "such as" example does NOT count/i);
    expect(system).toMatch(/건강한 스낵\(예: 과일, 견과류\)/);
  });

  /** 반대 방향도 고정한다 — 일반 질문이어도 항목이 추천을 담당하면 카드가 떠야 한다. */
  it('still allows a general question when the item carries the recommendation', () => {
    const system = systemPrompt();
    expect(system).toMatch(/item carries the recommendation, so "shoppingIntent" is true/i);
    expect(system).toMatch(/그릭 요거트를 드세요/);
  });

  it('shows worked examples for both sides of the general-question rule', () => {
    const system = systemPrompt();
    expect(system).toMatch(/GENERAL — 괄호 예시뿐이라 false/);
    expect(system).toMatch(/GENERAL — 항목이 추천 자체를 담당하므로 true/);
  });
});

describe('intent response parsing', () => {
  it('returns the query when the model reports shopping intent', () => {
    expect(
      parseIntentResponse(completionOf({ shoppingIntent: true, query: 'cast iron skillet' })),
    ).toEqual({ query: 'cast iron skillet', categories: [], reason: null });
  });

  it('reports no-intent when the model declines', () => {
    expect(parseIntentResponse(completionOf({ shoppingIntent: false, query: '' }))).toEqual({
      query: '',
      categories: [],
      reason: 'no-intent',
    });
  });

  it('reports no-intent when intent is claimed but no query comes back', () => {
    expect(parseIntentResponse(completionOf({ shoppingIntent: true, query: '   ' }))).toEqual({
      query: '',
      categories: [],
      reason: 'no-intent',
    });
  });

  /** 콤마로 이어붙인 목록을 그대로 넘기면 쇼핑 엔진이 0건을 반환하던 원래 버그. */
  it('keeps only the first keyword when the model returns a comma-separated list', () => {
    expect(
      parseIntentResponse(
        completionOf({ shoppingIntent: true, query: 'running shoes, marathon shoes, trail shoes' }),
      ),
    ).toEqual({ query: 'running shoes', categories: [], reason: null });
  });

  it('distinguishes an unusable response from a negative verdict', () => {
    const malformed = { choices: [{ message: { content: 'not json', refusal: null } }] };
    expect(parseIntentResponse(malformed)).toEqual({
      query: '',
      categories: [],
      reason: 'intent-unavailable',
    });
  });

  /** 거부는 "상품 얘기가 아님"이 아니라 "판별을 못 함"이다. 둘을 같은 값으로
   *  뭉개면 빈 카드의 원인을 다시 구분할 수 없게 된다. */
  it('treats a safety refusal as unavailable rather than a negative verdict', () => {
    const refused = {
      choices: [{ message: { content: null, refusal: 'I cannot help with that' } }],
    };
    expect(parseIntentResponse(refused)).toEqual({
      query: '',
      categories: [],
      reason: 'intent-unavailable',
    });
  });

  it('reports no-intent on an empty choices list', () => {
    expect(parseIntentResponse({ choices: [] })).toEqual({
      query: '',
      categories: [],
      reason: 'no-intent',
    });
  });
});

/**
 * `/category`는 분류를 거치지 않으므로 서명이 유일한 방어선이다. 이게 느슨해지면
 * 인증된 사용자가 아무 문자열로 쇼핑 검색을 태울 수 있다.
 */
describe('category query signing', () => {
  it('accepts a query with the token this server issued', () => {
    const query = 'celery sticks';
    expect(isValidQueryToken(query, signQuery(query))).toBe(true);
  });

  it('rejects an arbitrary query that was never issued', () => {
    expect(isValidQueryToken('anything the caller invented', signQuery('celery sticks'))).toBe(
      false,
    );
  });

  it('rejects a token issued for a different query', () => {
    expect(isValidQueryToken('Greek yogurt', signQuery('raw almonds'))).toBe(false);
  });

  it.each([undefined, null, '', 123, {}])('rejects %p as a token', (token) => {
    expect(isValidQueryToken('celery sticks', token)).toBe(false);
  });

  it('rejects a token of the wrong length without throwing', () => {
    expect(() => isValidQueryToken('celery sticks', 'short')).not.toThrow();
    expect(isValidQueryToken('celery sticks', 'short')).toBe(false);
  });

  it('is deterministic for the same query', () => {
    expect(signQuery('baby carrots')).toBe(signQuery('baby carrots'));
  });
});

/**
 * "키가 없어 검색을 못 했다"와 "검색했는데 0건"이 같은 빈 배열로 나가면, 카드가
 * 안 뜨는 이유가 설정 문제인지 상품이 없는 것인지 응답만 보고 구분할 수 없다.
 */
describe('search result reasons', () => {
  it('reports a missing API key as not-configured, not an empty result', () => {
    expect(describeSearchResult({ status: SearchStatus.NotConfigured, products: [] })).toEqual({
      products: [],
      reason: 'not-configured',
    });
  });

  it('reports a genuine empty result as no-results', () => {
    expect(describeSearchResult({ status: SearchStatus.Ok, products: [] })).toEqual({
      products: [],
      reason: 'no-results',
    });
  });

  it('reports a failed search as search-failed', () => {
    expect(describeSearchResult({ status: SearchStatus.Failed, products: [] })).toEqual({
      products: [],
      reason: 'search-failed',
    });
  });

  it('passes products through with no reason when the search succeeds', () => {
    const products = [{ title: 'Fresh Celery' }];
    expect(describeSearchResult({ status: SearchStatus.Ok, products })).toEqual({
      products,
      reason: null,
    });
  });

  /** 세 상태가 서로 다른 값이어야 응답만 보고 구분이 된다. */
  it('keeps the three outcomes distinct', () => {
    const reasons = [
      describeSearchResult({ status: SearchStatus.NotConfigured, products: [] }).reason,
      describeSearchResult({ status: SearchStatus.Ok, products: [] }).reason,
      describeSearchResult({ status: SearchStatus.Failed, products: [] }).reason,
    ];
    expect(new Set(reasons).size).toBe(3);
  });

  it.each([undefined, null, {}, { products: null }])(
    'treats a malformed result (%p) as an empty search rather than throwing',
    (result) => {
      expect(() => describeSearchResult(result)).not.toThrow();
      expect(describeSearchResult(result)).toEqual({ products: [], reason: 'no-results' });
    },
  );
});

/**
 * 시장 결정. 화요일 데모가 한국어 질문으로 돌아가므로, 여기가 틀리면 한국어로 물었는데
 * 미국 판매자가 나온다. 자동 판단은 프리필터가 쓰는 한글 판별을 그대로 재사용한다.
 */
describe('market resolution', () => {
  it.each([
    ['그릭 요거트 추천해줘', 'kr'],
    ['무선 이어폰 뭐가 좋아?', 'kr'],
    ['다이어트 중인데 간단한 아침 뭐가 있을까?', 'kr'],
    ['recommend a good cast iron skillet', 'us'],
    ["what's a good low calorie snack?", 'us'],
    ['Suggest running shoes for marathon training', 'us'],
  ])('routes %p to the %s market', (question, expected) => {
    expect(resolveMarket({ question })).toBe(expected);
  });

  /** 영어 문장에 한글이 한 글자라도 섞이면 한국어 사용자로 본다. */
  it('treats a mixed-script question as Korean', () => {
    expect(resolveMarket({ question: 'recommend 무선 이어폰 please' })).toBe('kr');
  });

  it('prefers an explicitly requested market over the detected one', () => {
    expect(resolveMarket({ requestedMarket: 'us', question: '그릭 요거트 추천해줘' })).toBe('us');
    expect(resolveMarket({ requestedMarket: 'kr', question: 'greek yogurt please' })).toBe('kr');
  });

  /** `naver`는 로케일이 아니라 백엔드 선택이라, 질문 언어로 뒤집으면 설정이 무의미해진다. */
  it('keeps an operator-pinned naver backend regardless of question language', () => {
    expect(resolveMarket({ question: 'greek yogurt please', fallback: 'naver' })).toBe('naver');
    expect(resolveMarket({ question: '그릭 요거트 추천해줘', fallback: 'naver' })).toBe('naver');
  });

  /** 검색 화면·예전 대화처럼 질문을 못 찾는 경우에만 env 기본값이 쓰인다. */
  it.each([undefined, '', '   '])(
    'falls back to the configured default when question is %p',
    (question) => {
      expect(resolveMarket({ question, fallback: 'kr' })).toBe('kr');
      expect(resolveMarket({ question, fallback: 'us' })).toBe('us');
    },
  );

  it('defaults to us when there is nothing to go on', () => {
    expect(resolveMarket()).toBe('us');
    expect(resolveMarket({})).toBe('us');
    expect(resolveMarket({ question: '', fallback: '' })).toBe('us');
  });
});

/**
 * SerpApi 로케일 파라미터. 빠지면 한국어 검색어에도 미국 판매자가 돌아온다.
 */
describe('market search params', () => {
  it('sends Korean locale parameters for the kr market', () => {
    expect(marketSearchParams('kr')).toEqual({
      google_domain: 'google.co.kr',
      gl: 'kr',
      hl: 'ko',
      location: 'South Korea',
    });
  });

  /** US 경로는 파라미터를 붙이지 않아 기존 동작 그대로여야 한다. */
  it.each(['us', 'naver', undefined, 'unknown'])('sends no extra parameters for %p', (market) => {
    expect(marketSearchParams(market)).toEqual({});
  });
});

/**
 * 검색어 언어. kr 로케일에 영어 검색어를 넣으면 엉뚱한 상품이 섞여 나온다.
 */
describe('query language by market', () => {
  const systemFor = (market) =>
    buildIntentRequest('some reply', 'some question', market).messages[0].content;

  it.each(['kr', 'naver'])(
    'tells the model to write Korean queries for the %s market',
    (market) => {
      expect(systemFor(market)).toMatch(/write every "query" value in KOREAN/i);
    },
  );

  /** 미국 경로 프롬프트는 한 글자도 달라지면 안 된다 — 판정 동작이 여기 묶여 있다. */
  it.each(['us', undefined, 'unknown'])('leaves the prompt untouched for %p', (market) => {
    expect(systemFor(market)).toBe(systemFor('us'));
    expect(systemFor(market)).not.toMatch(/LANGUAGE OVERRIDE/);
  });

  it('keeps the classification rules identical in both languages', () => {
    const kr = systemFor('kr');
    for (const rule of [
      'deciding signal is whether the QUESTION already names a thing to shop for',
      'MULTI-CATEGORY REPLIES',
      'Broad food-group or nutrient words do NOT count',
    ]) {
      expect(kr).toContain(rule);
    }
  });

  it('leaves category names in the reply language', () => {
    expect(systemFor('kr')).toMatch(/"category" names are unaffected/i);
  });
});

/**
 * 아코디언 라벨은 펼치기 전 독자가 보는 유일한 단서다. 같은 이름이 여러 개면
 * 무엇을 여는지 알 수 없다 — "요가 매트 추천해줘"에서 실제로 났던 문제.
 */
describe('category names stay distinguishable', () => {
  const withCategories = (categories) =>
    parseIntentResponse(completionOf({ shoppingIntent: true, query: '', categories }));

  it('drops entries that repeat a category name', () => {
    const result = withCategories([
      { category: '요가 매트', query: 'Liforme 요가 매트' },
      { category: '요가 매트', query: 'Manduka PRO 요가 매트' },
      { category: '요가 매트', query: 'Gaiam Essentials 요가 매트' },
    ]);

    /** 하나만 남으면 아코디언 대신 단일 카드 경로로 간다. */
    expect(result.categories).toEqual([]);
    expect(result.query).toBe('Liforme 요가 매트');
  });

  it('keeps entries whose names actually differ', () => {
    const result = withCategories([
      { category: 'Liforme', query: 'Liforme 요가 매트' },
      { category: 'Manduka PRO', query: 'Manduka PRO 요가 매트' },
      { category: 'Gaiam Essentials', query: 'Gaiam Essentials 요가 매트' },
    ]);

    expect(result.categories.map((entry) => entry.category)).toEqual([
      'Liforme',
      'Manduka PRO',
      'Gaiam Essentials',
    ]);
  });

  it('treats names differing only by case as the same name', () => {
    const result = withCategories([
      { category: 'Manduka', query: 'Manduka PRO 요가 매트' },
      { category: 'MANDUKA', query: 'Manduka X 요가 매트' },
      { category: 'Gaiam', query: 'Gaiam 요가 매트' },
    ]);

    expect(result.categories.map((entry) => entry.category)).toEqual(['Manduka', 'Gaiam']);
  });

  it('tells the model that names must stay distinct', () => {
    const [system] = buildIntentRequest('some reply').messages;
    expect(system.content).toMatch(/Every "category" name must be DISTINCT/i);
  });
});

/**
 * 품목어 필터. "Liforme 요가 매트"가 욕실매트·도어매트를 끌어오던 문제를 막는다.
 * 한국어는 수식어를 붙여 써서 다른 물건을 만들기 때문에(요가매트/욕실매트),
 * 품목어 포함 여부만으로는 부족하다.
 */
describe('product term filter', () => {
  const YOGA = 'Liforme 요가 매트';

  it.each([['파드마 요가매트'], ['요가 매트 6mm 논슬립'], ['Manduka PRO 요가매트 블랙']])(
    'keeps %s for a yoga mat query',
    (title) => {
      expect(matchesProductTerm(title, YOGA)).toBe(true);
    },
  );

  /** 실제로 카드에 떴던 오탐들. */
  it.each([
    ['IKEA TOFTBO 토프트보 욕실매트'],
    ['IKEA TIOKRONA 티오크로나 도어매트'],
    ['현관매트 대형'],
  ])('drops %s for a yoga mat query', (title) => {
    expect(matchesProductTerm(title, YOGA)).toBe(false);
  });

  it('drops a title that lacks the product term entirely', () => {
    expect(matchesProductTerm('Apple AirPods Pro 3', '무선 이어폰')).toBe(false);
  });

  it('keeps a title where the term stands as its own word', () => {
    expect(matchesProductTerm('QCY HT19 멜로버즈 무선 이어폰', '무선 이어폰')).toBe(true);
  });

  /** 라틴 문자는 붙여쓰기 합성이 없으므로 품목어 포함 여부만 본다. */
  it.each([
    ['Ocean Mist Case Celery', 'fresh celery', true],
    ['Blue Diamond Whole Natural Almonds', 'raw almonds', true],
    ['Lodge Cast Iron Skillet', 'fresh celery', false],
  ])('%s vs %s -> %s', (title, query, expected) => {
    expect(matchesProductTerm(title, query)).toBe(expected);
  });

  /** 거를 근거가 없을 때는 통과시킨다 — 필터가 결과를 몰살하면 안 된다. */
  it.each([undefined, null, '', '   '])('keeps everything for a %p query', (query) => {
    expect(matchesProductTerm('아무 상품', query)).toBe(true);
  });

  it('filters a product list and leaves the rest untouched', () => {
    const products = [
      { title: '파드마 요가매트' },
      { title: 'IKEA 토프트보 욕실매트' },
      { title: '요가 매트 논슬립' },
    ];
    expect(filterByProductTerm(products, YOGA)).toEqual([
      { title: '파드마 요가매트' },
      { title: '요가 매트 논슬립' },
    ]);
  });

  /** 전부 걸러지면 빈 배열 → 기존 reason 체계가 no-results로 처리한다. */
  it('reports an all-filtered result as no-results', () => {
    const filtered = filterByProductTerm([{ title: 'IKEA 욕실매트' }], YOGA);
    expect(filtered).toEqual([]);
    expect(describeSearchResult({ status: SearchStatus.Ok, products: filtered })).toEqual({
      products: [],
      reason: 'no-results',
    });
  });

  it.each([undefined, null, 'not an array'])('treats %p as an empty product list', (products) => {
    expect(filterByProductTerm(products, YOGA)).toEqual([]);
  });
});

/**
 * SerpApi가 같은 상품을 판매처별로 따로 내려주는 경우가 있어, 카드 네 장이
 * 같은 물건으로 채워지곤 했다("파드마 요가매트"가 두 번).
 */
describe('duplicate products', () => {
  it('drops a product repeated with the same title and price', () => {
    const products = [
      { title: '파드마 요가매트', price: '₩98,000', source: 'happyyoga.co.kr' },
      { title: '파드마 요가매트', price: '₩98,000', source: 'happyyoga.co.kr' },
      { title: '요가 매트 논슬립', price: '₩25,000' },
    ];
    expect(dedupeProducts(products)).toEqual([products[0], products[2]]);
  });

  /** 가격이 다르면 판매처를 고를 여지가 있으므로 남긴다. */
  it('keeps the same title at a different price', () => {
    const products = [
      { title: '파드마 요가매트', price: '₩98,000' },
      { title: '파드마 요가매트', price: '₩89,000' },
    ];
    expect(dedupeProducts(products)).toHaveLength(2);
  });

  it('ignores case and spacing when comparing', () => {
    const products = [
      { title: 'Manduka  PRO Yoga Mat', price: '$120.00' },
      { title: 'manduka pro yoga mat', price: '$120.00' },
    ];
    expect(dedupeProducts(products)).toHaveLength(1);
  });

  it('treats products missing a price as comparable', () => {
    const products = [{ title: '요가 매트' }, { title: '요가 매트' }];
    expect(dedupeProducts(products)).toHaveLength(1);
  });

  it('preserves the original order of the first occurrences', () => {
    const products = [
      { title: 'B', price: '1' },
      { title: 'A', price: '1' },
      { title: 'B', price: '1' },
    ];
    expect(dedupeProducts(products).map((p) => p.title)).toEqual(['B', 'A']);
  });

  it.each([undefined, null, 'not an array'])('treats %p as an empty list', (products) => {
    expect(dedupeProducts(products)).toEqual([]);
  });

  /** 필터 → 중복 제거 순서로 동작해야 한다. */
  it('runs after the product term filter', () => {
    const products = [
      { title: 'IKEA 욕실매트', price: '₩4,900' },
      { title: '파드마 요가매트', price: '₩98,000' },
      { title: '파드마 요가매트', price: '₩98,000' },
    ];
    const result = dedupeProducts(filterByProductTerm(products, 'Liforme 요가 매트'));
    expect(result).toEqual([{ title: '파드마 요가매트', price: '₩98,000' }]);
  });
});

/**
 * kr 시장은 브랜드가 아니라 품목으로 묶는다. 한국 구글 쇼핑에는 수입 브랜드
 * 리스팅이 거의 없어("Manduka PRO 요가 매트" 0건), 브랜드 라벨을 열면 남의
 * 상품이 나와 라벨과 내용이 어긋난다.
 */
describe('category grouping is the same in every market', () => {
  const systemFor = (market) =>
    buildIntentRequest('some reply', 'some question', market).messages[0].content;

  /** 브랜드 패널은 그 브랜드를 약속하고 남의 상품을 보여준다 — 시장과 무관한 문제라
   *  한쪽 시장에만 거는 규칙이 아니라 공통 규칙이어야 한다. */
  it.each(['us', 'kr', 'naver', undefined])('splits by product type for %p', (market) => {
    const system = systemFor(market);
    expect(system).toMatch(/Categories split by PRODUCT TYPE, never by brand or model/i);
    expect(system).toMatch(/leave "categories" empty and return one "query" for the type itself/i);
  });

  it('lists a brand or model run among the cases that stay a single query', () => {
    expect(systemFor('us')).toMatch(/a list of brands or models of ONE product type/i);
  });

  it('shows both sides as worked examples', () => {
    const system = systemFor('kr');
    expect(system).toMatch(/한 품목의 브랜드 나열 — 쪼개지 않는다/);
    expect(system).toMatch(/서로 다른 품목 — 쪼갠다/);
  });

  /** 시장별로 남는 차이는 검색어 언어뿐이다. */
  it('keeps the market difference limited to query language', () => {
    const kr = systemFor('kr');
    const us = systemFor('us');
    expect(kr).toBe(us + '\n' + kr.slice(us.length + 1));
    expect(kr.slice(us.length)).toMatch(/LANGUAGE OVERRIDE/);
    expect(kr.slice(us.length)).not.toMatch(/PRODUCT TYPE/);
  });
});
