import { QueryKeys } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, act, waitFor, renderHook } from '@testing-library/react';
import type { TMessage } from 'librechat-data-provider';
import ProductCards, { ProductQuestionProvider, useProductQuestionResolver } from '../ProductCards';

/** `getTokenHeader`만 바꾸고 나머지(QueryKeys 등)는 실제 구현을 쓴다. */
jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  getTokenHeader: () => 'Bearer test-token',
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('@librechat/client', () => ({
  Skeleton: ({ className }: { className?: string }) => (
    <div data-testid="skeleton" className={className} />
  ),
}));

const TEXT = 'I recommend the Lodge Cast Iron Skillet for searing steaks at home.';
const PRODUCT = {
  title: 'Lodge Cast Iron Skillet',
  price: '$24.90',
  image: 'https://example.test/skillet.jpg',
  link: 'https://example.test/p/1',
  source: 'Walmart',
};

/** 컴포넌트 내부 상수와 맞춘 값 — 디바운스 350ms, 스켈레톤 지연 1500ms */
const DEBOUNCE = 350;
const SKELETON_DELAY = 1500;

/** 분류(/search)와 카테고리 검색(/category)을 따로 제어한다. */
function routedFetch(searchBody: Record<string, unknown>) {
  const categoryResolvers: Array<(products: unknown[]) => void> = [];
  const fetchMock = jest.fn((url: string, init?: RequestInit) => {
    void init;
    if (String(url).endsWith('/api/products/category')) {
      return new Promise((resolve) => {
        categoryResolvers.push((products) =>
          resolve({ ok: true, json: () => Promise.resolve({ products }) }),
        );
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(searchBody) });
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  return {
    fetchMock,
    categoryCalls: () =>
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/products/category')),
    resolveCategory: async (products: unknown[]) => {
      await act(async () => {
        categoryResolvers.shift()?.(products);
      });
    },
  };
}

/** 응답을 테스트가 원하는 시점에 풀 수 있도록 fetch를 수동 제어한다. */
function deferredFetch() {
  let resolveWith: (products: unknown[]) => void = () => {};
  const fetchMock = jest.fn(
    () =>
      new Promise((resolve) => {
        resolveWith = (products) =>
          resolve({ ok: true, json: () => Promise.resolve({ products }) });
      }),
  );
  global.fetch = fetchMock as unknown as typeof fetch;
  return { fetchMock, resolve: (products: unknown[]) => resolveWith(products) };
}

const advance = async (ms: number) => {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
};

const CONVO_ID = 'convo-1';
const USER_MSG_ID = 'user-1';
const ASSISTANT_MSG_ID = 'assistant-1';
const QUESTION = '저칼로리 간식 추천해줘';

const message = (over: Partial<TMessage>): TMessage => ({ ...over }) as TMessage;

/** `null`은 "호스트가 질문을 주지 않았다"는 뜻. `undefined`는 기본값으로 대체된다. */
function renderCards(text = TEXT, question: string | null = QUESTION) {
  return render(
    <ProductQuestionProvider value={question === null ? undefined : () => question}>
      <ProductCards text={text} />
    </ProductQuestionProvider>,
  );
}

/** 질문 해석은 호스트(메시지 행)의 훅이므로 따로 검증한다. */
function renderQuestionHook(messages: TMessage[] | null, msg: Partial<TMessage>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (messages) {
    queryClient.setQueryData([QueryKeys.messages, CONVO_ID], messages);
  }
  return renderHook(() => useProductQuestionResolver(message(msg)), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}

const CONVO_MESSAGES = [
  message({ messageId: USER_MSG_ID, parentMessageId: null, text: QUESTION, isCreatedByUser: true }),
  message({
    messageId: ASSISTANT_MSG_ID,
    parentMessageId: USER_MSG_ID,
    text: TEXT,
    isCreatedByUser: false,
  }),
];

/** 호스트(메시지 행)와 카드를 실제로 이어 붙인 형태. 질문 해석 시점을 검증하려면
 *  훅과 컴포넌트가 같이 있어야 한다. */
function Host({ text }: { text: string }) {
  const resolve = useProductQuestionResolver(
    message({ messageId: ASSISTANT_MSG_ID, conversationId: CONVO_ID }),
  );
  return (
    <ProductQuestionProvider value={resolve}>
      <ProductCards text={text} />
    </ProductQuestionProvider>
  );
}

const sentBody = (fetchMock: jest.Mock) =>
  JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit)?.body as string);

describe('ProductCards loading state', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('shows nothing before the request is even sent', async () => {
    deferredFetch();
    renderCards();

    await advance(DEBOUNCE - 1);

    expect(screen.queryByTestId('skeleton')).not.toBeInTheDocument();
  });

  /** 상품이 아닌 응답은 대부분 1.2~1.4초에 돌아온다. 그 구간에서 스켈레톤이
   *  떴다 사라지면 모든 일반 대화에서 깜빡임이 생긴다. */
  it('never shows a skeleton when the response arrives before the delay', async () => {
    const { resolve } = deferredFetch();
    renderCards();

    await advance(DEBOUNCE);
    await advance(SKELETON_DELAY - 100);
    expect(screen.queryByTestId('skeleton')).not.toBeInTheDocument();

    await act(async () => {
      resolve([]);
    });
    await advance(SKELETON_DELAY);

    expect(screen.queryByTestId('skeleton')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  /**
   * 실측한 no-intent 응답 시간(649~1397ms)을 그대로 고정한다. 디바운스를 줄여도
   * 스켈레톤 타이머는 fetch 시작 시점부터 재므로 이 구간은 계속 안전해야 한다.
   * 지연값을 낮추거나 타이머 기준점을 바꾸면 여기서 깨진다.
   */
  it.each([649, 825, 916, 1242, 1397])(
    'shows no skeleton for a %ims no-intent response',
    async (latency) => {
      const { resolve } = deferredFetch();
      renderCards();

      await advance(DEBOUNCE);
      await advance(latency);
      expect(screen.queryByTestId('skeleton')).not.toBeInTheDocument();

      await act(async () => {
        resolve([]);
      });
      await advance(SKELETON_DELAY);

      expect(screen.queryByTestId('skeleton')).not.toBeInTheDocument();
    },
  );

  it('shows four card-shaped placeholders once the response is slow', async () => {
    deferredFetch();
    renderCards();

    await advance(DEBOUNCE);
    await advance(SKELETON_DELAY);

    const cards = screen.getAllByTestId('skeleton');
    /** 카드 한 장당 이미지 1 + 텍스트 4 = 5개 */
    expect(cards).toHaveLength(4 * 5);
    expect(screen.getByText('com_ui_loading')).toBeInTheDocument();
  });

  it('replaces the skeleton with real cards when products arrive', async () => {
    const { resolve } = deferredFetch();
    renderCards();

    await advance(DEBOUNCE);
    await advance(SKELETON_DELAY);
    expect(screen.getAllByTestId('skeleton').length).toBeGreaterThan(0);

    await act(async () => {
      resolve([PRODUCT]);
    });

    await waitFor(() => {
      expect(screen.getByText('Lodge Cast Iron Skillet')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('skeleton')).not.toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute('href', PRODUCT.link);
  });

  /** no-intent라 결과가 비어 있으면 스켈레톤도 카드도 남으면 안 된다. */
  it('clears the skeleton and renders nothing when the result is empty', async () => {
    const { resolve } = deferredFetch();
    renderCards();

    await advance(DEBOUNCE);
    await advance(SKELETON_DELAY);
    expect(screen.getAllByTestId('skeleton').length).toBeGreaterThan(0);

    await act(async () => {
      resolve([]);
    });

    await waitFor(() => {
      expect(screen.queryByTestId('skeleton')).not.toBeInTheDocument();
    });
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('clears the skeleton when the request fails', async () => {
    global.fetch = jest.fn(() => Promise.reject(new Error('network'))) as unknown as typeof fetch;
    renderCards();

    await advance(DEBOUNCE);
    await advance(SKELETON_DELAY);

    expect(screen.queryByTestId('skeleton')).not.toBeInTheDocument();
  });

  it('never requests anything for text too short to describe a product', async () => {
    const { fetchMock } = deferredFetch();
    renderCards('hi');

    await advance(DEBOUNCE + SKELETON_DELAY);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('skeleton')).not.toBeInTheDocument();
  });

  /** 언마운트 후 타이머가 살아 있으면 스켈레톤 상태를 갱신하려다 경고가 난다. */
  it('does not show a skeleton after unmount', async () => {
    deferredFetch();
    const { unmount } = renderCards();

    await advance(DEBOUNCE);
    unmount();
    await advance(SKELETON_DELAY * 2);

    expect(screen.queryByTestId('skeleton')).not.toBeInTheDocument();
  });
});

/**
 * 판정 기준이 질문 성격에 따라 갈리므로, 질문이 실제로 실려 나가는지가
 * 기능 전체의 전제다. 질문이 빠지면 백엔드는 조용히 예전 기준으로 동작한다.
 */
describe('ProductCards question payload', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('sends the host-supplied question alongside the reply', async () => {
    const { fetchMock } = deferredFetch();
    renderCards();

    await advance(DEBOUNCE);

    expect(sentBody(fetchMock)).toEqual({ text: TEXT, question: QUESTION });
  });

  /** 검색 화면·서브에이전트 패널처럼 질문 개념이 없는 곳에서도 요청은 나가야 한다. */
  it('still requests cards when no question is supplied', async () => {
    const { fetchMock } = deferredFetch();
    renderCards(TEXT, null);

    await advance(DEBOUNCE);

    const body = sentBody(fetchMock);
    expect(body.text).toBe(TEXT);
    expect(body.question).toBeUndefined();
  });

  /** 질문이 없어도 QueryClient를 요구하면 안 된다 — `ContentParts`를 렌더하는
   *  모든 화면이 provider를 강제로 갖춰야 하는 결합이 생긴다. */
  it('renders without a QueryClientProvider', () => {
    deferredFetch();
    expect(() => render(<ProductCards text={TEXT} />)).not.toThrow();
  });
});

/**
 * 렌더 시점에 질문을 값으로 확정하면, 그때 메시지 캐시가 비어 있던 경우 undefined로
 * 굳는다. 의존성(messageId, conversationId)이 그대로라 캐시가 나중에 채워져도
 * 재계산되지 않고, 질문이 빠진 채 백엔드가 조용히 예전 기준으로 판정한다.
 * 호출 직전에 읽어야 이 창이 닫힌다.
 */
describe('question resolved at request time, not render time', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('picks up a message tree that only lands after the first render', async () => {
    const { fetchMock } = deferredFetch();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <Host text={TEXT} />
      </QueryClientProvider>,
    );

    /** 첫 렌더 시점에는 캐시가 비어 있다 — 값으로 굳히는 구현이라면 여기서 끝난다. */
    expect(queryClient.getQueryData([QueryKeys.messages, CONVO_ID])).toBeUndefined();

    await act(async () => {
      queryClient.setQueryData([QueryKeys.messages, CONVO_ID], CONVO_MESSAGES);
    });

    await advance(DEBOUNCE);

    expect(sentBody(fetchMock).question).toBe(QUESTION);
  });
});

describe('useProductQuestionResolver', () => {
  it('finds the parent user message', () => {
    const { result } = renderQuestionHook(
      [
        message({
          messageId: USER_MSG_ID,
          parentMessageId: null,
          text: QUESTION,
          isCreatedByUser: true,
        }),
        message({
          messageId: ASSISTANT_MSG_ID,
          parentMessageId: USER_MSG_ID,
          text: TEXT,
          isCreatedByUser: false,
        }),
      ],
      { messageId: ASSISTANT_MSG_ID, conversationId: CONVO_ID },
    );

    expect(result.current()).toBe(QUESTION);
  });

  /** 도구 호출 등으로 어시스턴트 메시지가 연달아 나오면 한 단계 위는 사용자 메시지가 아니다. */
  it('walks past intermediate assistant messages', () => {
    const { result } = renderQuestionHook(
      [
        message({ messageId: 'u', parentMessageId: null, text: QUESTION, isCreatedByUser: true }),
        message({ messageId: 'a0', parentMessageId: 'u', text: 'step', isCreatedByUser: false }),
        message({
          messageId: ASSISTANT_MSG_ID,
          parentMessageId: 'a0',
          text: TEXT,
          isCreatedByUser: false,
        }),
      ],
      { messageId: ASSISTANT_MSG_ID, conversationId: CONVO_ID },
    );

    expect(result.current()).toBe(QUESTION);
  });

  it('returns undefined when the message tree is unavailable', () => {
    const { result } = renderQuestionHook(null, {
      messageId: ASSISTANT_MSG_ID,
      conversationId: CONVO_ID,
    });

    expect(result.current()).toBeUndefined();
  });

  it('returns undefined when no user message precedes the reply', () => {
    const { result } = renderQuestionHook(
      [
        message({
          messageId: ASSISTANT_MSG_ID,
          parentMessageId: null,
          text: TEXT,
          isCreatedByUser: false,
        }),
      ],
      { messageId: ASSISTANT_MSG_ID, conversationId: CONVO_ID },
    );

    expect(result.current()).toBeUndefined();
  });
});

/**
 * 카테고리 아코디언. 펼침 한 번이 쇼핑 검색 한 번이므로, "펼치기 전에는 검색하지
 * 않는다"와 "한 번 받은 결과는 다시 받지 않는다"가 곧 검색 예산 보호다.
 */
describe('ProductCards category accordion', () => {
  const CATEGORIES = [
    { category: '과일', query: 'fresh strawberries', token: 'tok-fruit' },
    { category: '유제품', query: 'Greek yogurt', token: 'tok-dairy' },
  ];

  const renderAccordion = () => {
    const routed = routedFetch({ products: [], categories: CATEGORIES });
    render(
      <ProductQuestionProvider value={() => QUESTION}>
        <ProductCards text={TEXT} />
      </ProductQuestionProvider>,
    );
    return routed;
  };

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('lists every category collapsed, and searches none of them', async () => {
    const { categoryCalls } = renderAccordion();

    await advance(DEBOUNCE);

    expect(screen.getByRole('button', { name: /과일/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: /유제품/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(categoryCalls()).toHaveLength(0);
  });

  it('searches only the category that is expanded', async () => {
    const { categoryCalls, resolveCategory } = renderAccordion();
    await advance(DEBOUNCE);

    await act(async () => {
      screen.getByRole('button', { name: /유제품/ }).click();
    });
    await resolveCategory([PRODUCT]);

    expect(categoryCalls()).toHaveLength(1);
    expect(JSON.parse(String(categoryCalls()[0]?.[1]?.body))).toEqual({
      query: 'Greek yogurt',
      token: 'tok-dairy',
    });
    expect(screen.getByText('Lodge Cast Iron Skillet')).toBeInTheDocument();
  });

  /** 접었다 펴도 다시 검색하면 예산이 두 배로 나간다. */
  it('reuses the cached result when a category is collapsed and reopened', async () => {
    const { categoryCalls, resolveCategory } = renderAccordion();
    await advance(DEBOUNCE);

    const button = screen.getByRole('button', { name: /유제품/ });
    await act(async () => button.click());
    await resolveCategory([PRODUCT]);
    await act(async () => button.click());
    await act(async () => button.click());

    expect(categoryCalls()).toHaveLength(1);
    expect(screen.getByText('Lodge Cast Iron Skillet')).toBeInTheDocument();
  });

  it('shows the skeleton only once an expanded search is slow', async () => {
    const { resolveCategory } = renderAccordion();
    await advance(DEBOUNCE);

    await act(async () => {
      screen.getByRole('button', { name: /과일/ }).click();
    });
    expect(screen.queryByTestId('skeleton')).not.toBeInTheDocument();

    await advance(SKELETON_DELAY);
    expect(screen.getAllByTestId('skeleton')).toHaveLength(4 * 5);

    await resolveCategory([PRODUCT]);
    expect(screen.queryByTestId('skeleton')).not.toBeInTheDocument();
  });

  it('reports an empty category instead of leaving it blank', async () => {
    const { resolveCategory } = renderAccordion();
    await advance(DEBOUNCE);

    await act(async () => {
      screen.getByRole('button', { name: /과일/ }).click();
    });
    await resolveCategory([]);

    expect(screen.getByText('com_ui_no_results_found')).toBeInTheDocument();
  });

  /** 단일 카테고리 응답은 아코디언이 아니라 기존 카드 세트로 가야 한다. */
  it('keeps a category-free response on the single card row', async () => {
    routedFetch({ products: [PRODUCT], categories: [] });
    render(
      <ProductQuestionProvider value={() => QUESTION}>
        <ProductCards text={TEXT} />
      </ProductQuestionProvider>,
    );

    await advance(DEBOUNCE);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute('href', PRODUCT.link);
  });
});
